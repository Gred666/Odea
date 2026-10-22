import { openDocument } from "@/app/navigate";
import { useApp } from "@/app/store";
import { base64Of, fallbackName } from "@/data/attachments";
import { backend } from "@/data/backend";
import { folderOf } from "@/data/folders";
import { useData } from "@/data/store";
import type { ImageResolver } from "@/editor/html";
import { flushAllEditors } from "@/editor/saveBus";
import type {
  Attachment,
  CollabCallback,
  CollabIdentity,
  CollabResume,
  Control,
  EndReason,
  MemberInfo,
  NearbyHost,
  Permission,
  Reach,
  Scope,
  Status,
  TrustedPeer,
} from "@/lib/bindings";
import { windowKind } from "@/lib/tauri";
import { holdTeamDoc } from "@/team/store";
import { create } from "zustand";
import { GuestImages, copyImages, dataUrlBase64, imageRefs, vaultPathOf } from "./attachments";
import { peerColor } from "./colors";
import type { SavedSnapshot } from "./external";
import type { SessionLink } from "./link";
import { type CollabNet, type FetchedAttachment, type Frame, collabNet, errorText } from "./net";
import type { CollabSession } from "./session";

/** Loro（wasm）和会话只在真要协作时才加载，不进主包；用之前等 wasm 编好（collab/loro.ts） */
const heavy = () =>
  Promise.all([
    import("./link"),
    import("./external"),
    import("./loro").then((loro) => loro.ensureLoro()),
  ]);

/* ============================================================
   协作的状态（docs/协同编辑.md §3、§8）：主持一篇，或者在别人那里做客，同一时刻只有一个。

   主持人：
   - 拿这篇现在的正文（先把编辑器里没存的存下去）建会话，Rust 起端点、给邀请链接
   - 有人来了先问（requests），允许 / 只读 / 拒绝
   - 会话的正文一变就存（400ms 防抖，和编辑器自己的保存一样；编辑器挂着时两边写的是同一份，
     data store 判重只落一次盘）。切到别的笔记时别人还在改，照收照存
   - 文件被别的程序改了：合进会话（external.ts，从上次保存处分叉），不出冲突副本
   - 分享前自检（P10.2）：谁能加入（reach），端口映射到了、中继连上了、换了网络都会再报一次，
     邀请链接跟着变（link）
   - 访客发来的回连链接（odea://back/）：往访客那边拨（dialBack），拨通了照样是加入请求
   - 正文里引用的附件交给 Rust（attachments.ts）：访客来要的不在里面就不给
   访客：
   - 粘链接 / 点 odea:// 链接 → 对话框里确认名字 → 加入；进来以后正文区显示共享的那一篇
   - 或者从「附近」列表里点一个（同一个网络里正在分享的人），不用链接
   - 链接带着主持人的中继：加入前说一声，可以选「只直连」（directOnly）
   - 连不上：3 秒内给结论（status 的 unreachable），后台接着试；可以生成回连链接发给主持人
   - 正文里相对路径的图片向主持人要（images）；粘贴的图片交给主持人存
   - 主持人停止、被移出：那一篇留着、不再更新，可以「存一份到我的笔记」
   落盘（设计 §3）：双方每隔两秒（主持人还有每次存盘时）把每一篇的状态交给 Rust。崩溃、强退以后
   重启，resume 里是上次的：主持人「继续协作」用同一个会话 id 和端口重新起来，访客自己接上；
   访客「重新加入」用落盘的状态建会话，断线期间各自的改动同步时补齐
   一条连接里好几篇（设计 §22.5）：邀请的范围是一篇、一个文件夹或整个仓库。一篇一个会话（docs）：
   - 主持人：访客要开哪篇（docOpen），看它在不在范围里，在的话建这一篇的会话（照存、照合外部改动）再回话；
     没人开着了就收掉。范围里的树（笔记的标题、在哪个文件夹）变了就给 Rust 一份
   - 访客：要哪篇开哪篇（openShared），正文区显示开着的那一篇（current）；一篇的范围进来就是那一篇
   ============================================================ */

/** 范围里的一篇（主持人给访客的树里，设计 §22.5） */
export interface CollabTreeDoc {
  id: string;
  title: string;
  /** 在范围里的哪个文件夹（相对范围的根，空串是根上） */
  folder: string;
}

/** 范围里的树：主持人给的 JSON */
export interface CollabTree {
  docs: CollabTreeDoc[];
}

/** 主持什么：一篇，或者一个文件夹（树上的路径）、整个仓库 */
export type HostTarget =
  | { kind: "doc"; noteId: string; title: string }
  | { kind: "folder"; folder: string; name: string }
  | { kind: "vault"; name: string };

export interface JoinRequest {
  request: number;
  id: string;
  name: string;
  invited: boolean;
  /** 经哪位访客转发来的（他的名字，设计 §20.9） */
  via: string | null;
}

type Phase =
  /** 没在协作 */
  | "idle"
  /** 点了「邀请协作」，端点还在起（两三秒） */
  | "preparing"
  | "hosting"
  /** 访客：已经点了加入，还没进去 */
  | "joining"
  /** 访客：进去了（或者进去过、现在结束了，status 里看） */
  | "guest";

export interface CollabState {
  phase: Phase;
  dialogOpen: boolean;
  identity: CollabIdentity | null;
  /** 主持的是哪篇（一篇的范围；文件夹、整个仓库是 null） */
  noteId: string | null;
  /** 邀请的范围（主持人：自己选的；访客：进来时主持人说的） */
  scope: Scope | null;
  /** 主持人：协作里的每一篇（文档 id 就是笔记 id）→ 会话。编辑器打开这篇时绑上它 */
  hostedDocs: Record<string, CollabSession>;
  /** 访客：范围里的树（主持人给的） */
  tree: CollabTree | null;
  /** 访客：开着的那几篇 */
  openDocs: string[];
  /** 访客：正文区显示的那一篇（文档 id） */
  current: string | null;
  link: string | null;
  members: MemberInfo[];
  requests: JoinRequest[];
  /** 访客的连接状态 */
  status: Status | null;
  /** 访客：正文区那一篇的标题 */
  title: string;
  permission: Permission;
  /** 访客：正文区显示共享的那篇（点了自己的笔记就收起，点协作标签回来） */
  showShared: boolean;
  /** 访客：对话框里的链接（点进来的、粘进来的） */
  joinLink: string;
  /** 访客：链接里带的中继（加入前说一声；null = 没带） */
  joinRelay: string | null;
  /** 访客：不经主持人的中继（只直连） */
  directOnly: boolean;
  /** 主持人：谁能加入（分享前自检）。访客生成回连链接时也查一遍，在 callback 里 */
  reach: Reach | null;
  /** 访客：现在走的是直连还是中继 */
  relayed: boolean | null;
  /** 访客：生成的回连链接 */
  callback: CollabCallback | null;
  callbackBusy: boolean;
  /** 访客：转发链接（设计 §20.9），发给连不上主持人、却连得上我的人 */
  forward: CollabCallback | null;
  forwardBusy: boolean;
  /** 主持人：有人想加入，可两边的 Odea 版本对不上，直接拒了（最近的一位） */
  outdated: { name: string; guestOlder: boolean } | null;
  /** 主持人：按回连链接往访客那边拨的进展 */
  dialBack: { state: "dialing" | "ok" | "failed"; detail: string | null } | null;
  /** 访客：做客那一篇的图片解析器（图片从主持人那里要来、缓存在本机） */
  images: ImageResolver | null;
  /** 会话（编辑器接它）：访客是正文区那一篇的，主持人是主持的那一篇的（一篇的范围） */
  session: CollabSession | null;
  /** 做客那一篇的文档 key 用它：每次加入、每换一篇都是新的 */
  sessionKey: string;
  error: string | null;
  /** 「附近」：同一个网络里正在分享的人。null = 没在看 */
  nearby: NearbyHost[] | null;
  /** 开始看「附近」的时刻：刚开始的几秒里空着是「正在找」，不是「没有人」 */
  nearbySince: number | null;
  nearbyError: string | null;
  /** 上次没正常结束的协作（崩溃、强退）：重启后问一句 */
  resume: CollabResume | null;
  /** 主持人「记住」的人（设计 §8.2）：下次进来不问。开始主持时读一次，记住、忘掉、移出后换成新的 */
  trusted: TrustedPeer[];

  openDialog(link?: string): void;
  /** 点开 / 粘进来的 odea:// 链接：邀请链接、回连链接、中继码分别去该去的地方 */
  openLink(link: string): void;
  closeDialog(): void;
  setJoinLink(link: string): void;
  setDirectOnly(directOnly: boolean): void;
  /** 访客：生成回连链接 */
  makeCallback(): Promise<void>;
  /** 访客：生成转发链接 */
  makeForwardLink(): Promise<void>;
  /** 主持人：打开访客发来的回连链接 */
  dialBackTo(link: string): Promise<void>;
  /** 开始主持一篇。resumeState：继续上次没正常结束的那一次（落盘的文档状态） */
  startHosting(noteId: string, title: string, resumeState?: Uint8Array): Promise<void>;
  /** 开始主持一个文件夹、整个仓库（设计 §22.5）。resume：继续上次的（每篇的状态访客来开时再读） */
  startHostingScope(target: Exclude<HostTarget, { kind: "doc" }>, resume?: boolean): Promise<void>;
  /** 访客：开范围里的一篇，正文区换成它 */
  openShared(doc: string): Promise<void>;
  /** 访客：关掉一篇 */
  closeShared(doc: string): Promise<void>;
  /** 访客：在范围里新建一篇（主持人那边建），建好了打开它 */
  createShared(folder: string, title: string): Promise<void>;
  join(link: string): Promise<void>;
  /** 加入对话框开着时看「附近」 */
  startNearby(): void;
  stopNearby(): void;
  joinNearby(id: string): Promise<void>;
  resumeHost(): Promise<void>;
  resumeGuest(): Promise<void>;
  discardResume(host: boolean): Promise<void>;
  /** 主持人停止 / 访客离开（已经结束的话只是收起） */
  stop(): Promise<void>;
  answer(request: number, allow: Permission | null): Promise<void>;
  setPermission(member: number, permission: Permission): Promise<void>;
  kick(member: number): Promise<void>;
  /** 记住这个人：下次拿着链接或者从「附近」进来不问，按他现在的权限 */
  remember(member: MemberInfo): Promise<void>;
  forget(id: string): Promise<void>;
  resetInvite(): Promise<void>;
  setName(name: string): Promise<void>;
  setShowShared(show: boolean): void;
  /** 访客：把共享的那篇存一份到自己的笔记，返回新笔记的 id */
  saveCopy(): Promise<string | null>;
  /** 访客：粘贴 / 拖进来的文件交给主持人存进他的「附件」，回从那篇引用它的路径 */
  attachFiles(files: File[]): Promise<Attachment[]>;
  attachPaths(paths: string[]): Promise<Attachment[]>;
}

/* ---------------- 会话之外的东西（不进 React 的状态） ---------------- */

let net: CollabNet | null = null;
/**
 * 协作里的每一篇：会话接着网络，加上这一篇自己的订阅（主持人：存盘、外部改动、附件引用；
 * 访客：要图片；双方：落盘）
 */
interface DocLink {
  link: SessionLink;
  cleanup: () => void;
  /** 访客：这一篇正文里的图片 */
  images: GuestImages | null;
}
const docs = new Map<string, DocLink>();
let stopPipe: (() => void) | null = null;
/** 主持人：范围里的树的订阅 */
let treeCleanup: (() => void) | null = null;
/** 双方：会话、绑定的模块（Loro 在里面，不进主包）。加入、主持的时候载好，之后同步地建会话 */
let heavyModules: Awaited<ReturnType<typeof heavy>> | null = null;
/** 访客「重新加入」：落盘的每一篇的状态（开那篇的时候用） */
let resumeStates = new Map<string, Uint8Array>();
/** 主持人「继续协作」：每篇落盘的状态访客来开时再读 */
let hostResuming = false;
let sessionCounter = 0;
/** 加入框里的链接每变一次加一：预览（带没带中继）晚到的不覆盖新的 */
let previewCounter = 0;
/** 正在看「附近」：晚到的列表在关了以后不收 */
let scanning = false;

/** 文档的状态多久落一次盘（停下来以后）：崩了最多丢这么久，对方那里有的同步时还会补回来 */
const PERSIST_MS = 2000;

const initial = {
  phase: "idle" as Phase,
  noteId: null,
  scope: null as Scope | null,
  hostedDocs: {} as Record<string, CollabSession>,
  tree: null as CollabTree | null,
  openDocs: [] as string[],
  current: null as string | null,
  link: null,
  members: [] as MemberInfo[],
  requests: [] as JoinRequest[],
  status: null,
  title: "",
  permission: "edit" as Permission,
  showShared: false,
  session: null,
  sessionKey: "",
  error: null,
  reach: null,
  relayed: null,
  callback: null,
  callbackBusy: false,
  forward: null,
  forwardBusy: false,
  dialBack: null,
  outdated: null,
  images: null,
};

/** 链接是哪一种（聊天软件里加的尖括号、引号、大小写都不管）。只粘了票据那一截的当邀请链接 */
/** 0.3.0 的共享仓库邀请链接（odea://share/）打开时说的话 */
const SHARE_RETIRED =
  "这是共享仓库的邀请链接。共享仓库这个功能已经去掉了：请对方改用「邀请协作…」发一个协作链接";

export function linkKind(text: string): "join" | "back" | "relay" | "share" | "vault" | null {
  const clean = text.trim().replace(/^[<"']+|[>"']+$/g, "");
  const match = /^odea:(?:\/\/)?(join|back|relay|share|vault)\//i.exec(clean);
  if (match) return match[1]!.toLowerCase() as "join" | "back" | "relay" | "share" | "vault";
  return /^[a-z2-7]{16,}$/i.test(clean) ? "join" : null;
}

async function ensureNet(): Promise<CollabNet> {
  net ??= await collabNet();
  return net;
}

async function identityOf(current: CollabNet) {
  const known = useCollab.getState().identity;
  if (known) return known;
  const identity = await current.identity();
  useCollab.setState({ identity });
  return identity;
}

function teardown() {
  treeCleanup?.();
  treeCleanup = null;
  for (const entry of docs.values()) {
    entry.cleanup();
    entry.link.destroy();
  }
  docs.clear();
  stopPipe?.();
  stopPipe = null;
  resumeStates = new Map();
  hostResuming = false;
}

/** 管道上来的一帧：交给那一篇的会话。访客那边没见过的那篇（主持人那边刚接上的）现建 */
function receiveFrame(frame: Frame) {
  const entry =
    docs.get(frame.doc) ??
    (useCollab.getState().phase === "guest" || useCollab.getState().phase === "joining"
      ? guestDoc(frame.doc)
      : undefined);
  entry?.link.receive(frame);
}

/** 双方：正文一变，停下两秒后把这一篇的状态落盘；开始时先落一次 */
function watchPersist(doc: string, session: CollabSession, current: CollabNet): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    timer = null;
    current.saveState(doc, session.encodeState());
  };
  const onUpdate = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, PERSIST_MS);
  };
  save();
  const stop = session.onChange(onUpdate);
  // 正常结束时不再写：Rust 那边刚删掉，再写一份就成了「上次没正常结束」
  return () => {
    stop();
    if (timer) clearTimeout(timer);
  };
}

/** 访客：这一篇正文一变，看看有没有新的相对路径图片要向主持人要 */
function watchGuestImages(
  doc: string,
  session: CollabSession,
  current: CollabNet,
): { images: GuestImages; stop: () => void } {
  const images = new GuestImages(
    (path) => current.fetchAttachment(doc, path),
    (resolver) => {
      if (useCollab.getState().current === doc) useCollab.setState({ images: resolver });
    },
  );
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onUpdate = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      images.scan(session.toString());
    }, 300);
  };
  const stop = session.onChange(onUpdate);
  return {
    images,
    stop: () => {
      stop();
      if (timer) clearTimeout(timer);
      images.destroy();
    },
  };
}

/** 自己（会话里的光标、名字） */
function selfPeer() {
  const identity = useCollab.getState().identity;
  const id = identity?.id ?? "me";
  return { id, name: identity?.name ?? "我", color: peerColor(id) };
}

/**
 * 访客：这一篇的会话（没有就建）。从空的开始：正文由主持人同步过来（两边各自用同一段文字建的话会重复一遍）。
 * 继续上次的：用落盘的状态，断线期间各自的改动同步时补齐
 */
function guestDoc(doc: string): DocLink | undefined {
  const known = docs.get(doc);
  if (known || !heavyModules || !net) return known;
  const current = net;
  const [{ linkSession }] = heavyModules;
  const link = linkSession(current, {
    doc,
    self: selfPeer(),
    initialState: resumeStates.get(doc),
  });
  link.setMembers(useCollab.getState().members);
  const { images, stop } = watchGuestImages(doc, link.session, current);
  const stopPersist = watchPersist(doc, link.session, current);
  const entry: DocLink = {
    link,
    images,
    cleanup: () => {
      stop();
      stopPersist();
    },
  };
  docs.set(doc, entry);
  const state = useCollab.getState();
  if (!state.openDocs.includes(doc)) useCollab.setState({ openDocs: [...state.openDocs, doc] });
  if (state.current === doc) showGuestDoc(doc);
  return entry;
}

/** 访客：正文区换成这一篇 */
function showGuestDoc(doc: string) {
  const entry = docs.get(doc);
  const state = useCollab.getState();
  const title =
    state.tree?.docs.find((item) => item.id === doc)?.title ??
    (state.scope?.kind === "doc" ? state.scope.name : "") ??
    "";
  sessionCounter += 1;
  useCollab.setState({
    current: doc,
    session: entry?.link.session ?? null,
    images: entry?.images?.resolver ?? null,
    sessionKey: `guest-${sessionCounter}`,
    ...(title || state.status?.state !== "connected" ? { title: title || state.title } : {}),
  });
  if (entry) entry.images?.scan(entry.link.session.toString());
}

/** 访客：一篇不要了（关掉、主持人不给） */
function dropGuestDoc(doc: string) {
  const entry = docs.get(doc);
  if (entry) {
    entry.cleanup();
    entry.link.destroy();
    docs.delete(doc);
  }
  const state = useCollab.getState();
  const openDocs = state.openDocs.filter((open) => open !== doc);
  useCollab.setState({ openDocs });
  if (state.current === doc) {
    const next = openDocs[0];
    if (next) showGuestDoc(next);
    else useCollab.setState({ current: null, session: null, images: null, showShared: false });
  }
}

/** 访客：载好会话的模块、接上帧，再让 Rust 去连（链接的、附近的、继续上次的都走这里） */
async function beginGuest(
  current: CollabNet,
  options: {
    joinLink: string;
    joinRelay: string | null;
    directOnly: boolean;
    /** 继续上次的：每一篇落盘的状态 */
    resumed?: Map<string, Uint8Array>;
    start: () => Promise<void>;
  },
): Promise<void> {
  const set = useCollab.setState;
  await useCollab.getState().stop();
  try {
    await identityOf(current);
    heavyModules = await heavy();
    resumeStates = options.resumed ?? new Map();
    stopPipe = await current.openPipe(receiveFrame);
    set({
      ...initial,
      phase: "joining",
      status: { state: "connecting" },
      joinLink: options.joinLink,
      joinRelay: options.joinRelay,
      directOnly: options.directOnly,
    });
    // 继续上次的：落盘的那几篇先建好（还没连上主持人也看得到上次写的），正文区是第一篇
    const first = [...resumeStates.keys()][0];
    for (const doc of resumeStates.keys()) guestDoc(doc);
    if (first) showGuestDoc(first);
    await options.start();
    // 继续上次的：断之前开着的那几篇照样开（连上以后 Rust 那边一篇一条流）
    for (const doc of resumeStates.keys()) await current.openDoc(doc).catch(() => {});
  } catch (error) {
    teardown();
    set({ ...initial, joinLink: options.joinLink, error: `加入不了：${errorText(error)}` });
  }
}

/* ---------------- 主持人：一篇一个会话 ---------------- */

/** 主持人：这一篇在不在范围里。在的话返回 null，不在的话是给访客看的一句话 */
function refusalOf(doc: string): string | null {
  const { scope, noteId } = useCollab.getState();
  const note = useData.getState().notes.find((item) => item.id === doc);
  if (!scope) return "协作已经停了";
  if (scope.kind === "doc") return doc === noteId ? null : "这一篇不在共享的范围里";
  if (!note) return "这一篇不在了（删掉了，或者归档了）";
  if (scope.kind === "vault") return null;
  const folder = folderOf(note);
  return folder === scope.doc || folder.startsWith(`${scope.doc}/`)
    ? null
    : "这一篇不在共享的文件夹里";
}

/**
 * 主持人：建这一篇的会话（正文从磁盘上的这一版开始；继续上次的话用落盘的状态，磁盘上后来的改动合进来）。
 * 团队仓库里的一篇（设计 §22.5 最后一段）：借团队那份会话，外人这条链路接在同一份上 —— 存盘、外部改动
 * 都归团队那边（团队里别人主持的话是他存）
 */
async function hostDoc(doc: string, resumeState?: Uint8Array): Promise<DocLink> {
  const known = docs.get(doc);
  if (known) return known;
  const current = await ensureNet();
  const note = useData.getState().notes.find((item) => item.id === doc);
  const borrowed = await holdTeamDoc({ kind: "note", id: doc }, note?.relPath);
  if (borrowed) {
    heavyModules ??= await heavy();
    const again = docs.get(doc);
    if (again) {
      borrowed.release();
      return again;
    }
    const link = heavyModules[0].attachSession(current, { doc, session: borrowed.session });
    link.setMembers(useCollab.getState().members);
    const stopHosted = watchHosted(link.session, doc, current, heavyModules[1], false);
    const entry: DocLink = {
      link,
      images: null,
      cleanup: () => {
        stopHosted();
        borrowed.release();
      },
    };
    docs.set(doc, entry);
    useCollab.setState((state) => ({ hostedDocs: { ...state.hostedDocs, [doc]: link.session } }));
    return entry;
  }
  // 编辑器里还没存的先存下去：会话从磁盘上的这一版开始，外部改动才有准确的分叉点
  await flushAllEditors();
  const disk = await useData.getState().loadBody(doc);
  if (disk === undefined) throw new Error("这篇笔记已经不在了");
  heavyModules ??= await heavy();
  const [{ linkSession }, external] = heavyModules;
  const again = docs.get(doc);
  if (again) return again;
  const self = selfPeer();
  const link = resumeState
    ? linkSession(current, { doc, self, initialState: resumeState })
    : linkSession(current, { doc, self, initialText: disk });
  // 继续上次的：落盘的状态是最后一次存盘时的（两者同时取），之后磁盘上又变了（别的程序改的、
  // 崩溃前最后那几百毫秒存下去的）就当外部改动合进来
  if (resumeState && disk !== link.session.toString()) {
    external.mergeExternal(link.session, external.snapshot(link.session), disk);
  }
  link.setMembers(useCollab.getState().members);
  const stopHosted = watchHosted(link.session, doc, current, external);
  const stopPersist = watchPersist(doc, link.session, current);
  const entry: DocLink = {
    link,
    images: null,
    cleanup: () => {
      stopHosted();
      stopPersist();
    },
  };
  docs.set(doc, entry);
  useCollab.setState((state) => ({ hostedDocs: { ...state.hostedDocs, [doc]: link.session } }));
  return entry;
}

/** 主持人：这一篇没人开着了，收掉（先存下去） */
function dropHostedDoc(doc: string) {
  const entry = docs.get(doc);
  if (!entry) return;
  entry.cleanup();
  entry.link.destroy();
  docs.delete(doc);
  void net?.setAttachmentRefs(doc, null).catch(() => {});
  useCollab.setState((state) => {
    const { [doc]: _gone, ...rest } = state.hostedDocs;
    return { hostedDocs: rest };
  });
}

/** 主持人：访客要开一篇 */
async function answerDocOpen(request: number, doc: string) {
  const current = net;
  if (!current || useCollab.getState().phase !== "hosting") return;
  const refusal = refusalOf(doc);
  if (refusal) {
    await current.answerDoc(request, refusal).catch(() => {});
    return;
  }
  try {
    const state = hostResuming
      ? await current.resumeState(true, doc).catch(() => undefined)
      : undefined;
    await hostDoc(doc, state);
    await current.answerDoc(request, null);
  } catch (error) {
    await current.answerDoc(request, errorText(error)).catch(() => {});
  }
}

/** 主持人：有人关掉了一篇。主持的那一篇（一篇的范围）留着；别的没人开着了就收掉 */
function onDocClosed(member: number, doc: string) {
  const state = useCollab.getState();
  if (state.phase !== "hosting" || doc === state.noteId) return;
  const watching = state.members.some(
    (info) => !info.host && info.member !== member && info.docs.includes(doc),
  );
  if (!watching) dropHostedDoc(doc);
}

/** 主持人：访客要在范围里新建一篇 */
async function answerCreate(request: number, folder: string, title: string) {
  const current = net;
  const { scope } = useCollab.getState();
  if (!current || !scope || scope.kind === "doc") {
    await current?.answerCreate(request, null, "这次协作只共享了一篇").catch(() => {});
    return;
  }
  const clean = folder.replace(/^\/+|\/+$/g, "");
  const place = scope.kind === "folder" ? [scope.doc, clean].filter(Boolean).join("/") : clean;
  try {
    const data = useData.getState();
    const id = await data.createNote(place || undefined);
    if (!id) throw new Error("建不了新的笔记");
    if (title.trim()) await data.saveTitle({ kind: "note", id }, title.trim());
    await current.answerCreate(request, id, null);
  } catch (error) {
    await current.answerCreate(request, null, errorText(error)).catch(() => {});
  }
}

/** 主持人：范围里的树（笔记的标题、在范围里的哪个文件夹），笔记一变就再给一份 */
function watchTree(scope: Scope, current: CollabNet): () => void {
  let last = "";
  const push = () => {
    const notes = useData.getState().notes;
    const docs: CollabTreeDoc[] = [];
    for (const note of notes) {
      const folder = folderOf(note);
      if (scope.kind === "folder") {
        if (folder !== scope.doc && !folder.startsWith(`${scope.doc}/`)) continue;
        docs.push({
          id: note.id,
          title: note.title,
          folder: folder.slice(scope.doc.length).replace(/^\//, ""),
        });
      } else {
        docs.push({ id: note.id, title: note.title, folder });
      }
    }
    docs.sort((a, b) => a.folder.localeCompare(b.folder) || a.title.localeCompare(b.title));
    const tree = JSON.stringify({ docs } satisfies CollabTree);
    if (tree === last) return;
    last = tree;
    void current.setTree(tree).catch(() => {});
  };
  push();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = useData.subscribe((state, previous) => {
    if (state.notes === previous.notes || timer) return;
    timer = setTimeout(() => {
      timer = null;
      push();
    }, 300);
  });
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}

export const useCollab = create<CollabState>((set, get) => ({
  ...initial,
  dialogOpen: false,
  identity: null,
  joinLink: "",
  joinRelay: null,
  directOnly: false,
  nearby: null,
  nearbySince: null,
  nearbyError: null,
  resume: null,
  trusted: [],

  openDialog: (joinLink) => {
    set({ dialogOpen: true });
    if (joinLink !== undefined) get().setJoinLink(joinLink);
    void ensureNet()
      .then(identityOf)
      .catch(() => {});
  },
  openLink: (link) => {
    const kind = linkKind(link);
    if (kind === "relay") {
      void import("./relayStore").then(({ useRelays }) => useRelays.getState().openRelays(link));
      return;
    }
    // 团队仓库的链接（docs/协同编辑.md §22.3）：在启动器里拉一份
    if (kind === "vault") {
      void backend()
        .then((api) => api.openVaultLink(link))
        .catch((error) => useData.setState({ error: errorText(error) }));
      return;
    }
    // 0.3.0 共享仓库的邀请：共享仓库退役了（docs/协同编辑.md §22.7）
    if (kind === "share") {
      useData.setState({ error: SHARE_RETIRED });
      return;
    }
    if (kind === "back") {
      if (get().phase === "hosting") {
        get().openDialog();
        void get().dialBackTo(link);
      } else {
        get().openDialog("");
        set({
          error: "这是回连链接：要在主持协作时打开（先在那篇笔记上「邀请协作」，再点一次这个链接）",
        });
      }
      return;
    }
    get().openDialog(link);
  },
  closeDialog: () => set({ dialogOpen: false }),
  setJoinLink: (joinLink) => {
    set({ joinLink, error: null, joinRelay: null });
    previewCounter += 1;
    const ticket = previewCounter;
    if (!joinLink.trim() || linkKind(joinLink) !== "join") return;
    void ensureNet()
      .then((current) => current.checkLink(joinLink.trim()))
      .then((preview) => {
        if (ticket !== previewCounter || typeof preview === "string") return;
        set({ joinRelay: preview.relay });
      })
      .catch(() => {});
  },
  setDirectOnly: (directOnly) => set({ directOnly }),

  startHosting: async (noteId, title, resumeState) => {
    if (get().phase === "preparing") return;
    await get().stop();
    const scope: Scope = { kind: "doc", doc: noteId, name: title };
    set({ ...initial, phase: "preparing", noteId, scope, dialogOpen: true });
    try {
      const current = await ensureNet();
      await identityOf(current);
      const entry = await hostDoc(noteId, resumeState);
      stopPipe = await current.openPipe(receiveFrame);
      const hosting = await current.host(title, "edit", noteId, scope, !!resumeState);
      if (get().phase !== "preparing" || get().noteId !== noteId) return;
      entry.link.setMembers(hosting.members);
      void current
        .trusted()
        .then((trusted) => set({ trusted }))
        .catch(() => {});
      sessionCounter += 1;
      set({
        phase: "hosting",
        link: hosting.link,
        members: hosting.members,
        session: entry.link.session,
        sessionKey: `host-${sessionCounter}`,
      });
    } catch (error) {
      teardown();
      set({ ...initial, error: `开始不了协作：${errorText(error)}` });
    }
  },

  startHostingScope: async (target, resume) => {
    if (get().phase === "preparing") return;
    await get().stop();
    const scope: Scope =
      target.kind === "folder"
        ? { kind: "folder", doc: target.folder, name: target.name }
        : { kind: "vault", doc: "", name: target.name };
    set({ ...initial, phase: "preparing", scope, dialogOpen: true });
    try {
      const current = await ensureNet();
      await identityOf(current);
      heavyModules ??= await heavy();
      stopPipe = await current.openPipe(receiveFrame);
      const hosting = await current.host(scope.name, "edit", "", scope, !!resume);
      if (get().phase !== "preparing" || get().scope !== scope) return;
      hostResuming = !!resume;
      treeCleanup = watchTree(scope, current);
      void current
        .trusted()
        .then((trusted) => set({ trusted }))
        .catch(() => {});
      sessionCounter += 1;
      set({
        phase: "hosting",
        link: hosting.link,
        members: hosting.members,
        sessionKey: `host-${sessionCounter}`,
      });
    } catch (error) {
      teardown();
      set({ ...initial, error: `开始不了协作：${errorText(error)}` });
    }
  },

  openShared: async (doc) => {
    const current = net;
    if (!current || get().phase !== "guest") return;
    guestDoc(doc);
    showGuestDoc(doc);
    set({ showShared: true, dialogOpen: false });
    await current.openDoc(doc).catch((error) => set({ error: errorText(error) }));
  },
  closeShared: async (doc) => {
    dropGuestDoc(doc);
    await net?.closeDoc(doc).catch(() => {});
  },
  createShared: async (folder, title) => {
    const current = net;
    if (!current || get().phase !== "guest") return;
    try {
      const doc = await current.createDoc(folder, title);
      await get().openShared(doc);
    } catch (error) {
      set({ error: `建不了：${errorText(error)}` });
    }
  },

  join: async (raw) => {
    const linkText = raw.trim();
    const kind = linkKind(linkText);
    if (kind === "share") {
      set({ error: SHARE_RETIRED });
      return;
    }
    if (kind === "vault") {
      get().closeDialog();
      get().openLink(linkText);
      return;
    }
    if (kind === "back" || kind === "relay") {
      set({
        error:
          kind === "back"
            ? "这是回连链接，不是邀请链接：要主持人在主持协作时打开它"
            : "这是中继码，不是邀请链接：在命令面板「协作中继…」里添加",
      });
      return;
    }
    const current = await ensureNet();
    const preview = await current.checkLink(linkText);
    if (typeof preview === "string") {
      set({ error: preview });
      return;
    }
    const { directOnly } = get();
    await beginGuest(current, {
      joinLink: linkText,
      joinRelay: preview.relay,
      directOnly,
      start: () => current.join(linkText, directOnly),
    });
  },

  startNearby: () => {
    if (scanning) return;
    scanning = true;
    set({ nearby: [], nearbySince: Date.now(), nearbyError: null });
    void ensureNet()
      .then((current) => current.nearbyStart())
      .catch((error) => {
        if (scanning) set({ nearbyError: errorText(error) });
      });
  },
  stopNearby: () => {
    if (!scanning) return;
    scanning = false;
    set({ nearby: null, nearbySince: null });
    void net?.nearbyStop().catch(() => {});
  },
  joinNearby: async (id) => {
    const current = await ensureNet();
    // Rust 那边加入时顺手把「附近」收掉了
    scanning = false;
    set({ nearby: null, nearbySince: null });
    await beginGuest(current, {
      joinLink: "",
      joinRelay: null,
      directOnly: false,
      start: () => current.joinNearby(id),
    });
  },

  resumeHost: async () => {
    const resume = get().resume;
    const info = resume?.host;
    if (!info) return;
    set({ resume: resume.guest ? { ...resume, host: null } : null });
    // 文件夹、整个仓库：每篇的状态访客来开时再读
    if (info.scope && info.scope.kind !== "doc") {
      const target =
        info.scope.kind === "folder"
          ? { kind: "folder" as const, folder: info.scope.doc, name: info.scope.name }
          : { kind: "vault" as const, name: info.scope.name };
      await get().startHostingScope(target, true);
      return;
    }
    const current = await ensureNet();
    const state = await current.resumeState(true, info.note).catch(() => null);
    if (!state) {
      set({ error: "上次协作的状态已经没了", dialogOpen: true });
      return;
    }
    const note = useData.getState().notes.find((item) => item.id === info.note);
    await get().startHosting(info.note, note?.title ?? info.title, state);
  },
  resumeGuest: async () => {
    const resume = get().resume;
    if (!resume?.guest) return;
    set({ resume: resume.host ? { ...resume, guest: null } : null });
    const current = await ensureNet();
    const resumed = new Map<string, Uint8Array>();
    for (const doc of await current.resumeDocs().catch(() => [] as string[])) {
      const state = await current.resumeState(false, doc).catch(() => null);
      if (state) resumed.set(doc, state);
    }
    if (!resumed.size) {
      set({ error: "上次做客的状态已经没了", dialogOpen: true });
      return;
    }
    set({ dialogOpen: true });
    await beginGuest(current, {
      joinLink: "",
      joinRelay: null,
      directOnly: false,
      resumed,
      start: () => current.rejoin(),
    });
  },
  discardResume: async (host) => {
    const resume = get().resume;
    if (!resume) return;
    const next = host ? { ...resume, host: null } : { ...resume, guest: null };
    set({ resume: next.host || next.guest ? next : null });
    await net?.discardResume(host).catch(() => {});
  },

  stop: async () => {
    const { phase } = get();
    if (phase === "idle") return;
    teardown();
    // 对话框一起关：开着的话回到空闲就成了「加入协作」那一页，刚点完「停止协作」看到一个加入框
    set({ ...initial, dialogOpen: false });
    await net?.stop().catch(() => {});
  },

  answer: async (request, allow) => {
    set((state) => ({ requests: state.requests.filter((item) => item.request !== request) }));
    await net?.answer(request, allow);
  },
  setPermission: async (member, permission) => {
    if (!net) return;
    await net.setPermission(member, permission);
    // 记住过的人以后也按改过的权限进来（Rust 那边改了 config.json）
    if (get().trusted.some((peer) => peer.id === memberId(get().members, member)))
      set({ trusted: await net.trusted() });
  },
  kick: async (member) => {
    if (!net) return;
    await net.kick(member);
    // 移出了就不再记住
    set({ trusted: await net.trusted() });
  },
  remember: async (member) => {
    if (!net || member.host) return;
    set({ trusted: await net.remember(member.id, member.name, member.permission) });
  },
  forget: async (id) => {
    if (!net) return;
    set({ trusted: await net.forget(id) });
  },
  resetInvite: async () => {
    if (!net || get().phase !== "hosting") return;
    const fresh = await net.resetInvite();
    set({ link: fresh });
  },
  makeCallback: async () => {
    if (!net || get().callbackBusy) return;
    set({ callbackBusy: true });
    try {
      const callback = await net.callback();
      // 等的这几秒里已经进去了、或者走了：不用了
      if (get().phase === "joining") set({ callback });
    } catch (error) {
      set({ error: `生成不了回连链接：${errorText(error)}` });
    } finally {
      set({ callbackBusy: false });
    }
  },
  makeForwardLink: async () => {
    if (!net || get().forwardBusy) return;
    set({ forwardBusy: true });
    try {
      const forward = await net.forwardLink();
      if (get().phase === "guest") set({ forward });
    } catch (error) {
      set({ error: `生成不了转发链接：${errorText(error)}` });
    } finally {
      set({ forwardBusy: false });
    }
  },
  dialBackTo: async (linkText) => {
    if (!net || get().phase !== "hosting") return;
    set({ dialBack: { state: "dialing", detail: null } });
    try {
      await net.dialBack(linkText.trim());
    } catch (error) {
      set({ dialBack: { state: "failed", detail: errorText(error) } });
    }
  },
  setName: async (name) => {
    const current = await ensureNet();
    await current.setName(name);
    const identity = await current.identity();
    set({ identity });
  },
  setShowShared: (showShared) => set({ showShared }),

  saveCopy: async () => {
    const { session, title, current: doc } = get();
    if (!session) return null;
    const markdown = session.toString();
    const images = doc ? (docs.get(doc)?.images ?? null) : null;
    // 访客窗口没开仓库：正文连同要来的图片（本机缓存的文件，或者 base64）交给最近用过的仓库窗口去存
    if (windowKind === "guest") {
      try {
        const shared = imageRefs(markdown).map((source) => {
          const got = images?.fetched(source);
          return {
            source,
            file: got?.file ?? null,
            data: got && !got.file ? dataUrlBase64(got.url) : null,
          };
        });
        await (await ensureNet()).copyToVault({
          title: title || "协作的笔记",
          markdown,
          images: shared,
        });
        useData.setState({ notice: "存进了最近用的仓库，在那个窗口里打开了" });
      } catch (error) {
        useData.setState({ error: `没存上：${errorText(error)}` });
      }
      return null;
    }
    return storeCopy(title || "协作的笔记", markdown, (ref) => images?.fetched(ref));
  },

  attachFiles: async (files) => {
    const current = net;
    const doc = get().current;
    if (!current || !doc || get().phase !== "guest") return [];
    const out: Attachment[] = [];
    for (const file of files) {
      try {
        const data = await base64Of(file);
        out.push(await current.putAttachment(doc, file.name || fallbackName(file.type), data));
      } catch (error) {
        reportAttachError(error);
      }
    }
    return out;
  },
  attachPaths: async (paths) => {
    const current = net;
    const doc = get().current;
    if (!current || !doc || get().phase !== "guest") return [];
    const out: Attachment[] = [];
    for (const path of paths) {
      try {
        out.push(await current.putAttachmentPath(doc, path));
      } catch (error) {
        reportAttachError(error);
      }
    }
    return out;
  },
}));

function reportAttachError(error: unknown) {
  useData.setState({ error: `附件没交给主持人：${errorText(error)}` });
}

/** 控制消息（成员、加入请求、连接状态） */
export function handleControl(control: Control): void {
  const state = useCollab.getState();
  switch (control.type) {
    case "joinRequest":
      if (state.phase !== "hosting") return;
      useCollab.setState({
        requests: [
          ...state.requests.filter((item) => item.request !== control.request),
          {
            request: control.request,
            id: control.id,
            name: control.name,
            invited: control.invited,
            via: control.via,
          },
        ],
      });
      return;
    case "joinOutdated":
      if (state.phase !== "hosting") return;
      useCollab.setState({ outdated: { name: control.name, guestOlder: control.guestOlder } });
      return;
    case "joinCancelled":
      useCollab.setState({
        requests: state.requests.filter((item) => item.request !== control.request),
      });
      return;
    case "members":
      for (const entry of docs.values()) entry.link.setMembers(control.members);
      useCollab.setState({ members: control.members });
      return;
    case "permission":
      useCollab.setState({ permission: control.permission });
      return;
    case "status":
      handleStatus(control.status);
      return;
    case "reach":
      if (state.phase !== "hosting" && state.phase !== "preparing") return;
      useCollab.setState({
        reach: control.reach,
        ...(control.link && state.phase === "hosting" ? { link: control.link } : {}),
      });
      return;
    case "route":
      useCollab.setState({ relayed: control.relayed });
      return;
    case "dialBack":
      if (state.phase !== "hosting") return;
      useCollab.setState({
        dialBack: control.ok
          ? { state: "ok", detail: null }
          : { state: "failed", detail: control.detail },
      });
      return;
    case "nearby":
      if (scanning) useCollab.setState({ nearby: control.hosts });
      return;
    case "docOpen":
      void answerDocOpen(control.request, control.doc);
      return;
    case "docClosed":
      onDocClosed(control.member, control.doc);
      return;
    case "createDoc":
      void answerCreate(control.request, control.folder, control.title);
      return;
    case "tree":
      try {
        useCollab.setState({ tree: JSON.parse(control.tree) as CollabTree });
        const { current } = useCollab.getState();
        if (current) showGuestDoc(current);
      } catch {
        // 主持人那边的版本说的不是这种树：当没有
      }
      return;
    case "docRefused":
      dropGuestDoc(control.doc);
      useCollab.setState({ error: `打不开：${control.reason}` });
      return;
  }
}

function handleStatus(status: Status) {
  const state = useCollab.getState();
  // 主持人自己停的、或者早就不在会话里了
  if (state.phase === "idle" || state.phase === "preparing" || state.phase === "hosting") return;
  if (status.state === "connected") {
    // 连上了（第一次、或者断了又连上）：之前没要到的图片再要一遍
    for (const entry of docs.values()) {
      entry.images?.retryFailed();
      entry.images?.scan(entry.link.session.toString());
    }
    const single = status.scope.kind === "doc";
    useCollab.setState({
      phase: "guest",
      status,
      scope: status.scope,
      title: single ? status.title : state.title,
      permission: status.permission,
      // 第一次进来：一篇的范围对话框收起，正文区换成共享的那篇；文件夹、整个仓库的对话框留着，挑一篇开
      ...(state.phase === "joining" && single
        ? { showShared: true, dialogOpen: false, current: status.scope.doc }
        : {}),
    });
    if (single && state.phase === "joining") {
      if (docs.has(status.scope.doc)) showGuestDoc(status.scope.doc);
    }
    return;
  }
  if (status.state === "ended" && status.reason.kind === "left") return;
  useCollab.setState({
    status,
    ...(status.state === "ended" && state.phase === "joining"
      ? { error: endText(status.reason) }
      : {}),
  });
  if (status.state === "ended") {
    // 结束了：网络那头已经收掉，会话留着（共享的那几篇还能看、能存一份），不再收发、不再落盘
    for (const entry of docs.values()) entry.cleanup();
    for (const entry of docs.values()) entry.cleanup = () => {};
    stopPipe?.();
    stopPipe = null;
  }
}

function memberId(members: MemberInfo[], member: number): string | undefined {
  return members.find((item) => item.member === member)?.id;
}

/** 结束的原因，给人看的一句话 */
export function endText(reason: EndReason, host = "主持人"): string {
  switch (reason.kind) {
    case "rejected": {
      const why = reason.reason;
      if (why === "declined") return `${host}没有同意你加入`;
      if (why === "kicked") return `${host}把你移出了这次协作`;
      if (why === "badInvite")
        return "这个链接已经失效了（协作结束了，或者链接被换掉了），找主持人要一个新的";
      if (why === "ended") return `${host}已经停止了协作`;
      return "对方的 Odea 版本和你的不一样，两边都升到最新再试";
    }
    case "outdated":
      return reason.hostOlder
        ? `${host}的 Odea 比你的旧，连不上：让对方升级到最新再试`
        : `你的 Odea 比${host}的旧，连不上：升级到最新再试`;
    case "kicked":
      return `${host}把你移出了这次协作`;
    case "hostStopped":
      return `${host}停止了协作，这篇不会再更新`;
    case "dropped":
      return `还没进去，${host}那边就断开了（他可能关了 Odea，或者停止了协作）`;
    case "left":
      return "你离开了这次协作";
  }
}

/**
 * 主持人：会话的正文一变就存；文件被别的程序改了就合进会话；笔记改了名告诉 Rust（之后进来的人看到新标题）；
 * 正文里引用的附件告诉 Rust（访客只要得到这些）
 */
function watchHosted(
  session: CollabSession,
  noteId: string,
  current: CollabNet,
  { snapshot, mergeExternal }: typeof import("./external"),
  /** false：会话是借团队的，存盘、外部改动归团队那边，这里只管附件引用和标题 */
  writes = true,
): () => void {
  let saved: SavedSnapshot = snapshot(session);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = async () => {
    timer = null;
    const shot = snapshot(session);
    // 存盘的这一刻的状态也落盘：和磁盘上的正文是同一刻的（继续协作时据此认出外部改动）。
    // 要在 await 之前取：存盘的这一会儿里别人的字可能又到了
    const state = session.encodeState();
    try {
      await useData.getState().saveDocument({ kind: "note", id: noteId }, shot.text);
      saved = shot;
      current.saveState(noteId, state);
    } catch {
      // 存失败的提示由 data store 给；下次改动再存
    }
  };

  // 附件引用：正文一变（200ms 防抖）算一遍，变了才交给 Rust
  let refsTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRefs = "";
  const pushRefs = () => {
    refsTimer = null;
    const relPath = useData.getState().notes.find((note) => note.id === noteId)?.relPath;
    if (!relPath) return;
    const refs = imageRefs(session.toString()).flatMap((path) => {
      const vaultPath = vaultPathOf(relPath, path);
      return vaultPath ? [{ path, vaultPath }] : [];
    });
    const key = JSON.stringify(refs);
    if (key === lastRefs) return;
    lastRefs = key;
    void current.setAttachmentRefs(noteId, refs).catch(() => {});
  };
  pushRefs();

  const onUpdate = () => {
    if (writes) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void save(), 400);
    }
    refsTimer ??= setTimeout(pushRefs, 200);
  };
  const stopChanges = session.onChange(onUpdate);

  const key = `note:${noteId}`;
  let title = useData.getState().notes.find((note) => note.id === noteId)?.title;
  const unsubscribe = useData.subscribe((state, previous) => {
    if (writes && state.externalRevisions[key] !== previous.externalRevisions[key]) {
      const disk = state.bodies[noteId];
      if (disk !== undefined && disk !== session.toString()) mergeExternal(session, saved, disk);
    }
    const next = state.notes.find((note) => note.id === noteId)?.title;
    // 标题给访客：一篇的范围才有（文件夹、整个仓库的标题在树里）
    if (next && next !== title) {
      title = next;
      if (useCollab.getState().noteId === noteId) void current.setTitle(next).catch(() => {});
    }
  });

  return () => {
    stopChanges();
    if (refsTimer) clearTimeout(refsTimer);
    if (timer) {
      clearTimeout(timer);
      void save();
    }
    unsubscribe();
  };
}

/** 应用起来时调一次：订阅控制消息、接住 odea:// 链接（冷启动带进来的、开着时点的）、看看有没有上次没正常结束的协作 */
/**
 * 存一份到这个仓库：新建一篇，要来的图片存进自己的「附件」，正文里的路径换成从这篇引用它们的（§3）。
 * 返回新笔记的 id
 */
async function storeCopy(
  title: string,
  body: string,
  fetched: (ref: string) => FetchedAttachment | undefined,
): Promise<string | null> {
  const data = useData.getState();
  const id = await data.createNote("");
  if (!id) return null;
  const target = { kind: "note", id } as const;
  const api = await backend();
  const { markdown, missing } = await copyImages(body, fetched, {
    attachPath: (file) => api.vaultAttachPath(target, file),
    attachData: (name, base64) => api.vaultAttach(target, name, base64),
  });
  await data.saveTitle(target, title);
  await data.saveDocument(target, markdown);
  if (missing)
    useData.setState({
      error: `有 ${missing} 张图片还没从主持人那里拿到，存下来的这篇里还是原来的路径`,
    });
  return id;
}

/** 仓库窗口：访客窗口交过来一份要存的（「存一份到我的笔记」）：存下来、打开它 */
async function receiveCopy(current: CollabNet): Promise<void> {
  const copy = await current.takeCopy().catch(() => null);
  if (!copy) return;
  const images = new Map(copy.images.map((image) => [image.source, image]));
  const id = await storeCopy(copy.title, copy.markdown, (ref) => {
    const image = images.get(ref);
    if (!image) return undefined;
    return { url: image.data ? `data:;base64,${image.data}` : "", file: image.file };
  });
  if (!id) return;
  openDocument({ kind: "note", id });
  useData.setState({ notice: `「${copy.title}」存了一份到笔记` });
}

export async function initCollab(): Promise<void> {
  // 做客时点了自己的笔记、换了工作区：共享的那篇收起来（协作标签能回去）
  useApp.subscribe((state, previous) => {
    if (!useCollab.getState().showShared) return;
    if (
      state.workspace !== previous.workspace ||
      state.selectedNoteId !== previous.selectedNoteId ||
      state.selectedArchiveId !== previous.selectedArchiveId ||
      state.selectedDate !== previous.selectedDate
    ) {
      useCollab.setState({ showShared: false });
    }
  });
  const current = await ensureNet();
  await current.onControl(handleControl);
  await current.onLink((linkText) => useCollab.getState().openLink(linkText));
  const pending = await current.pendingLink().catch(() => null);
  if (pending) useCollab.getState().openLink(pending);
  // 访客窗口就是为了加入这一次开的：不问「继续上次的协作」，也没有仓库可存
  if (windowKind === "guest") {
    if (!pending) useCollab.getState().openDialog();
    return;
  }
  // 访客窗口交过来要存的（窗口刚为它打开的话，那一份已经在等着了）
  await current.onCopyReady(() => void receiveCopy(current));
  void receiveCopy(current);
  const resume = await current.resumeInfo().catch(() => null);
  if (resume && (resume.host || resume.guest) && useCollab.getState().phase === "idle") {
    useCollab.setState({ resume });
  }
}

/** 测试：换网络层、清状态 */
export function resetCollabForTest(next: CollabNet | null): void {
  teardown();
  scanning = false;
  net = next;
  useCollab.setState({
    ...initial,
    dialogOpen: false,
    identity: null,
    joinLink: "",
    joinRelay: null,
    directOnly: false,
    nearby: null,
    nearbySince: null,
    nearbyError: null,
    resume: null,
    trusted: [],
  });
}
