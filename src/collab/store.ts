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
import { keepGuestCopy } from "./keep";
import type { FrameSender, SessionLink } from "./link";
import {
  type CollabNet,
  type FetchedAttachment,
  type Frame,
  PIPE,
  collabNet,
  errorText,
} from "./net";
import type { CollabSession } from "./session";

/** Loro（wasm）和会话只在真要协作时才加载，不进主包；用之前等 wasm 编好（collab/loro.ts） */
const heavy = () =>
  Promise.all([
    import("./link"),
    import("./external"),
    import("./loro").then((loro) => loro.ensureLoro()),
  ]);

/* ============================================================
   协作的状态（docs/协同编辑.md §3、§8、§25）：同时好几个会话，主持的、做客的随便搭。
   每个会话一个会话号（这个窗口里起的，不重复），命令、事件、帧都带着它（collab/net.ts）。

   一篇只在一个会话里（§25）：主持一篇 / 一个文件夹 / 整个仓库之前先看范围和正在主持的有没有重叠
   （overlapOf），重叠就打开那一次。主持人这边一篇一份会话，hostedDocs 是「笔记 id → 会话」一张平的表，
   编辑器打开这篇时绑上它；访客那边按（会话号、文档 id）认（两个主持人的文档 id 可能撞）。

   主持人：
   - 拿这篇现在的正文（先把编辑器里没存的存下去）建会话，Rust 那边挂到端点上、给邀请链接
   - 有人来了先问（requests），允许 / 只读 / 拒绝
   - 会话的正文一变就存（400ms 防抖，和编辑器自己的保存一样；编辑器挂着时两边写的是同一份，
     data store 判重只落一次盘）。切到别的笔记时别人还在改，照收照存
   - 文件被别的程序改了：合进会话（external.ts，从上次保存处分叉），不出冲突副本
   - 分享前自检（P10.2）：谁能加入（reach），端口映射到了、中继连上了、换了网络都会再报一次，
     邀请链接跟着变（link）
   - 访客发来的回连链接（odea://back/）：往访客那边拨（dialBack），拨通了照样是加入请求。链接里带着
     会话 id，Rust 说是哪一次的
   - 「附近」进来一位、我主持着好几个：问挑哪一个（knocks）
   - 正文里引用的附件交给 Rust（attachments.ts）：访客来要的不在里面就不给
   访客：
   - 粘链接 / 点 odea:// 链接 → 对话框里确认名字 → 加入；进来以后正文区显示共享的那一篇
   - 或者从「附近」列表里点一个（同一个网络里正在分享的人），不用链接
   - 链接带着主持人的中继：加入前说一声，可以选「只直连」（directOnly）
   - 连不上：3 秒内给结论（status 的 unreachable），后台接着试；可以生成回连链接发给主持人
   - 正文里相对路径的图片向主持人要（images）；粘贴的图片交给主持人存
   - 主持人停止、被移出：那一篇留着、不再更新，可以「存一份到我的笔记」
   正文区只有一个：做客的那几篇里显示哪一篇看 shownSession / 那个会话的 current
   落盘（设计 §3）：双方每隔两秒（主持人还有每次存盘时）把每一篇的状态交给 Rust。崩溃、强退以后
   重启，resume 里是上次的几次：主持人「继续协作」用同一个会话 id 和端口重新起来，访客自己接上；
   访客「重新加入」用落盘的状态建会话，断线期间各自的改动同步时补齐
   一条连接里好几篇（设计 §22.5）：邀请的范围是一篇、一个文件夹或整个仓库。
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

/** 「附近」点进来一位，我主持着好几个：等主持人挑进哪一个（设计 §25.1） */
export interface NearbyKnock {
  request: number;
  id: string;
  name: string;
}

export type SessionPhase =
  /** 主持人：点了「邀请协作」，Rust 那边还在挂（第一次要起端点，两三秒） */
  | "preparing"
  | "hosting"
  /** 访客：已经点了加入，还没进去 */
  | "joining"
  /** 访客：进去了（或者进去过、现在结束了，status 里看） */
  | "guest";

/** 一个会话 */
export interface CollabSessionState {
  /** 会话号 */
  id: number;
  role: "host" | "guest";
  phase: SessionPhase;
  /** 主持人：会话 id（十六进制，落盘文件夹的名字） */
  key: string;
  /** 主持的是哪篇（一篇的范围；文件夹、整个仓库是 null） */
  noteId: string | null;
  /** 邀请的范围（主持人：自己选的；访客：进来时主持人说的） */
  scope: Scope | null;
  /** 访客：范围里的树（主持人给的） */
  tree: CollabTree | null;
  /** 访客：开着的那几篇 */
  openDocs: string[];
  /** 访客：这个会话里正文区显示的那一篇（文档 id） */
  current: string | null;
  link: string | null;
  members: MemberInfo[];
  requests: JoinRequest[];
  /** 访客的连接状态 */
  status: Status | null;
  /** 访客：正文区那一篇的标题 */
  title: string;
  permission: Permission;
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
  /** 访客：怎么进来的（链接；「附近」、继续上次的是空的） */
  joinLink: string;
  /** 访客：链接里带的中继 */
  joinRelay: string | null;
}

export interface CollabState {
  sessions: Record<number, CollabSessionState>;
  /** 会话号，按开始的先后 */
  order: number[];
  /** 对话框里在看的那一个；null 是「加入协作」那一页 */
  focus: number | null;
  dialogOpen: boolean;
  /** 对话框顶上的一句话（「这一篇已经在这次协作里了」），换一个会话看就没了 */
  notice: string | null;
  identity: CollabIdentity | null;
  /** 主持人：协作里的每一篇（笔记 id，一篇只在一个会话里）→ 会话。编辑器打开这篇时绑上它 */
  hostedDocs: Record<string, CollabSession>;
  /** 主持人：每篇在哪个会话里 */
  hostedIn: Record<string, number>;
  /** 访客：正文区显示的是哪个会话的（那个会话的 current） */
  shownSession: number | null;
  /** 访客：正文区显示共享的那篇（点了自己的笔记就收起，点协作标签回来） */
  showShared: boolean;
  /** 编辑器接的会话：正文区那一篇（访客） */
  session: CollabSession | null;
  /** 做客那一篇的文档 key 用它：每次加入、每换一篇都是新的 */
  sessionKey: string;
  /** 访客：正文区那一篇的图片解析器（图片从主持人那里要来、缓存在本机） */
  images: ImageResolver | null;
  /** 加入框里的链接（点进来的、粘进来的） */
  joinLink: string;
  /** 加入框：链接里带的中继（加入前说一声；null = 没带） */
  joinRelay: string | null;
  /** 加入框：不经主持人的中继（只直连） */
  directOnly: boolean;
  error: string | null;
  /** 「附近」：同一个网络里正在分享的人。null = 没在看 */
  nearby: NearbyHost[] | null;
  /** 开始看「附近」的时刻：刚开始的几秒里空着是「正在找」，不是「没有人」 */
  nearbySince: number | null;
  nearbyError: string | null;
  /** 「附近」进来、我主持着好几个：等着挑 */
  knocks: NearbyKnock[];
  /** 上次没正常结束的几次协作（崩溃、强退）：重启后问一句 */
  resume: CollabResume | null;
  /** 主持人「记住」的人（设计 §8.2）：下次进来不问。开始主持时读一次，记住、忘掉、移出后换成新的 */
  trusted: TrustedPeer[];

  /** 打开对话框。带着链接的（哪怕是空串）打开「加入协作」那一页 */
  openDialog(link?: string): void;
  /** 打开对话框看这一个 */
  openSession(id: number): void;
  /** 对话框里换一个看（null 是「加入协作」那一页） */
  setFocus(id: number | null): void;
  /** 点开 / 粘进来的 odea:// 链接：邀请链接、回连链接、中继码分别去该去的地方 */
  openLink(link: string): void;
  closeDialog(): void;
  setJoinLink(link: string): void;
  setDirectOnly(directOnly: boolean): void;
  /** 访客：生成回连链接 */
  makeCallback(id: number): Promise<void>;
  /** 访客：生成转发链接 */
  makeForwardLink(id: number): Promise<void>;
  /** 主持人：打开访客发来的回连链接 */
  dialBackTo(link: string): Promise<void>;
  /** 开始主持一篇。resume：继续上次没正常结束的那一次（落盘文件夹的名字、这一篇落盘的状态） */
  startHosting(
    noteId: string,
    title: string,
    resume?: { key: string; state: Uint8Array },
  ): Promise<void>;
  /** 开始主持一个文件夹、整个仓库（设计 §22.5）。resumeKey：继续上次的（每篇的状态访客来开时再读） */
  startHostingScope(
    target: Exclude<HostTarget, { kind: "doc" }>,
    resumeKey?: string,
  ): Promise<void>;
  /** 访客：开范围里的一篇，正文区换成它 */
  openShared(id: number, doc: string): Promise<void>;
  /** 访客：关掉一篇 */
  closeShared(id: number, doc: string): Promise<void>;
  /** 访客：在范围里新建一篇（主持人那边建），建好了打开它 */
  createShared(id: number, folder: string, title: string): Promise<void>;
  join(link: string): Promise<void>;
  /** 加入对话框开着时看「附近」 */
  startNearby(): void;
  stopNearby(): void;
  joinNearby(nearbyId: string): Promise<void>;
  /** 「附近」进来的那位进哪一个（null = 拒绝） */
  answerKnock(request: number, session: number | null, permission: Permission): Promise<void>;
  resumeHost(key: string): Promise<void>;
  resumeGuest(key: string): Promise<void>;
  discardResume(host: boolean, key: string): Promise<void>;
  /** 主持人停止这一次 / 访客离开（已经结束的话只是收起） */
  stop(id: number): Promise<void>;
  answer(id: number, request: number, allow: Permission | null): Promise<void>;
  setPermission(id: number, member: number, permission: Permission): Promise<void>;
  kick(id: number, member: number): Promise<void>;
  /** 记住这个人：下次拿着链接或者从「附近」进来不问，按他现在的权限 */
  remember(member: MemberInfo): Promise<void>;
  forget(peerId: string): Promise<void>;
  resetInvite(id: number): Promise<void>;
  setName(name: string): Promise<void>;
  /** 访客：正文区显示 / 收起共享的那篇。带着会话号的换成那个会话开着的那一篇 */
  setShowShared(show: boolean, id?: number): void;
  /** 访客：把共享的那篇（id 这个会话开着的，默认正文区那一篇）存一份到自己的笔记，返回新笔记的 id */
  saveCopy(id?: number): Promise<string | null>;
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
  /** 主持人：附件引用、状态再交一遍（Rust 那边会话刚挂上：之前交的没地方放） */
  announce?: () => void;
}

/** 一个会话在前端这边的家当 */
interface Runtime {
  /** 主持人：笔记 id → 这一篇；访客：文档 id → 这一篇 */
  docs: Map<string, DocLink>;
  /** 主持人：范围里的树的订阅 */
  treeCleanup: (() => void) | null;
  /** 访客「重新加入」：落盘的每一篇的状态（开那篇的时候用） */
  resumeStates: Map<string, Uint8Array>;
  /** 主持人「继续协作」：落盘的那一次（每篇的状态访客来开时再读） */
  resumeKey: string | null;
  /** 访客：结束了（不再收发、不再落盘，那几篇留着看） */
  ended: boolean;
}

const runtimes = new Map<number, Runtime>();
/** 所有会话共用一条字节管道（帧里带着会话号）：第一个会话开始时开，一个都不剩了关 */
let stopPipe: (() => void) | null = null;
let opening: Promise<void> | null = null;
/** 双方：会话、绑定的模块（Loro 在里面，不进主包）。加入、主持的时候载好，之后同步地建会话 */
let heavyModules: Awaited<ReturnType<typeof heavy>> | null = null;
/** 会话号：一个窗口里不重复（Rust 那边按（窗口，会话号）认） */
let nextSession = 1;
let sessionCounter = 0;
/** 加入框里的链接每变一次加一：预览（带没带中继）晚到的不覆盖新的 */
let previewCounter = 0;
/** 正在看「附近」：晚到的列表在关了以后不收 */
let scanning = false;

/** 文档的状态多久落一次盘（停下来以后）：崩了最多丢这么久，对方那里有的同步时还会补回来 */
const PERSIST_MS = 2000;

function freshSession(
  id: number,
  role: "host" | "guest",
  phase: SessionPhase,
  extra: Partial<CollabSessionState> = {},
): CollabSessionState {
  return {
    id,
    role,
    phase,
    key: "",
    noteId: null,
    scope: null,
    tree: null,
    openDocs: [],
    current: null,
    link: null,
    members: [],
    requests: [],
    status: null,
    title: "",
    permission: "edit",
    reach: null,
    relayed: null,
    callback: null,
    callbackBusy: false,
    forward: null,
    forwardBusy: false,
    outdated: null,
    dialBack: null,
    joinLink: "",
    joinRelay: null,
    ...extra,
  };
}

function sessionOf(id: number): CollabSessionState | undefined {
  return useCollab.getState().sessions[id];
}

/** 改一个会话（已经没了就算了） */
function patch(
  id: number,
  change:
    | Partial<CollabSessionState>
    | ((session: CollabSessionState) => Partial<CollabSessionState>),
) {
  useCollab.setState((state) => {
    const session = state.sessions[id];
    if (!session) return {};
    const next = typeof change === "function" ? change(session) : change;
    return { sessions: { ...state.sessions, [id]: { ...session, ...next } } };
  });
}

/** 加一个会话，对话框看它 */
function addSession(session: CollabSessionState) {
  useCollab.setState((state) => ({
    sessions: { ...state.sessions, [session.id]: session },
    order: [...state.order, session.id],
    focus: session.id,
    notice: null,
    error: null,
  }));
}

function runtimeOf(id: number): Runtime {
  let runtime = runtimes.get(id);
  if (!runtime) {
    runtime = {
      docs: new Map(),
      treeCleanup: null,
      resumeStates: new Map(),
      resumeKey: null,
      ended: false,
    };
    runtimes.set(id, runtime);
  }
  return runtime;
}

/** 链路发帧用的：带上会话号 */
function senderOf(current: CollabNet, id: number): FrameSender {
  return { send: (kind, member, doc, payload) => current.send(id, kind, member, doc, payload) };
}

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

/** 字节管道开着（第一个会话开始时开） */
async function ensurePipe(current: CollabNet) {
  if (stopPipe) return;
  opening ??= current
    .openPipe(receiveFrame)
    .then((stop) => {
      stopPipe = stop;
    })
    .finally(() => {
      opening = null;
    });
  await opening;
}

/** 收掉这个会话在前端的家当（会话还开着的那几篇、树的订阅）；一个都不剩了关管道 */
function teardownSession(id: number) {
  const runtime = runtimes.get(id);
  if (runtime) {
    runtime.treeCleanup?.();
    for (const entry of runtime.docs.values()) {
      entry.cleanup();
      entry.link.destroy();
    }
    runtimes.delete(id);
  }
  useCollab.setState((state) => {
    const gone = Object.keys(state.hostedIn).filter((note) => state.hostedIn[note] === id);
    if (!gone.length) return {};
    const hostedDocs = { ...state.hostedDocs };
    const hostedIn = { ...state.hostedIn };
    for (const note of gone) {
      delete hostedDocs[note];
      delete hostedIn[note];
    }
    return { hostedDocs, hostedIn };
  });
  if (!runtimes.size) {
    stopPipe?.();
    stopPipe = null;
  }
}

/** 从状态里拿掉这个会话：对话框看着它的换成剩下的（一个都不剩了收起对话框），正文区显示它的收起 */
function dropSession(id: number) {
  useCollab.setState((state) => {
    const { [id]: _gone, ...sessions } = state.sessions;
    const order = state.order.filter((other) => other !== id);
    const watched = state.focus === id;
    return {
      sessions,
      order,
      focus: watched ? (order[order.length - 1] ?? null) : state.focus,
      // 对话框一起关：开着的话回到空闲就成了「加入协作」那一页，刚点完「停止协作」看到一个加入框
      dialogOpen: watched && !order.length ? false : state.dialogOpen,
      notice: watched ? null : state.notice,
      ...(state.shownSession === id
        ? { shownSession: null, session: null, images: null, showShared: false }
        : {}),
    };
  });
}

/** 管道上来的一帧：交给那个会话的那一篇。访客那边没见过的那篇（主持人那边刚接上的）现建 */
function receiveFrame(frame: Frame) {
  const runtime = runtimes.get(frame.session);
  if (!runtime || runtime.ended) return;
  const session = sessionOf(frame.session);
  const entry =
    runtime.docs.get(frame.doc) ??
    (session?.role === "guest" ? guestDoc(frame.session, frame.doc) : undefined);
  entry?.link.receive(frame);
}

/** 双方：正文一变，停下两秒后把这一篇的状态落盘；开始时先落一次 */
function watchPersist(
  id: number,
  doc: string,
  session: CollabSession,
  current: CollabNet,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    timer = null;
    current.saveState(id, doc, session.encodeState());
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
  id: number,
  doc: string,
  session: CollabSession,
  current: CollabNet,
): { images: GuestImages; stop: () => void } {
  const images = new GuestImages(
    (path) => current.fetchAttachment(id, doc, path),
    (resolver) => {
      const state = useCollab.getState();
      if (state.shownSession === id && state.sessions[id]?.current === doc)
        useCollab.setState({ images: resolver });
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
  const peerId = identity?.id ?? "me";
  return { id: peerId, name: identity?.name ?? "我", color: peerColor(peerId) };
}

/**
 * 访客：这个会话里这一篇的会话（没有就建）。从空的开始：正文由主持人同步过来（两边各自用同一段文字建的话
 * 会重复一遍）。继续上次的：用落盘的状态，断线期间各自的改动同步时补齐
 */
function guestDoc(id: number, doc: string): DocLink | undefined {
  const runtime = runtimes.get(id);
  const known = runtime?.docs.get(doc);
  if (known || !runtime || !heavyModules || !net) return known;
  const current = net;
  const [{ linkSession }] = heavyModules;
  const link = linkSession(senderOf(current, id), {
    doc,
    self: selfPeer(),
    initialState: runtime.resumeStates.get(doc),
  });
  link.setMembers(sessionOf(id)?.members ?? []);
  const { images, stop } = watchGuestImages(id, doc, link.session, current);
  const stopPersist = watchPersist(id, doc, link.session, current);
  // 主持人还没存下的字本机另留一份（keep.ts，docs/协同编辑.md §24）。主持人是 0 号
  const host = () => sessionOf(id)?.members.find((member) => member.member === 0);
  const keep = keepGuestCopy(link, {
    key: `guest:${host()?.id ?? ""}:${doc}`,
    title: () =>
      sessionOf(id)?.tree?.docs.find((item) => item.id === doc)?.title ||
      sessionOf(id)?.title ||
      "协作的那一篇",
    host: () => host()?.name ?? "主持人",
    vault: null,
    target: null,
  });
  keep.guest(0);
  const entry: DocLink = {
    link,
    images,
    cleanup: () => {
      stop();
      stopPersist();
      keep.stop();
    },
  };
  runtime.docs.set(doc, entry);
  patch(id, (session) =>
    session.openDocs.includes(doc) ? {} : { openDocs: [...session.openDocs, doc] },
  );
  const state = useCollab.getState();
  if (state.shownSession === id && state.sessions[id]?.current === doc) showGuestDoc(id, doc);
  return entry;
}

/** 访客：正文区换成这个会话的这一篇 */
function showGuestDoc(id: number, doc: string) {
  const session = sessionOf(id);
  if (!session) return;
  const entry = runtimes.get(id)?.docs.get(doc);
  const title =
    session.tree?.docs.find((item) => item.id === doc)?.title ??
    (session.scope?.kind === "doc" ? session.scope.name : "") ??
    "";
  sessionCounter += 1;
  patch(id, {
    current: doc,
    ...(title || session.status?.state !== "connected" ? { title: title || session.title } : {}),
  });
  useCollab.setState({
    shownSession: id,
    session: entry?.link.session ?? null,
    images: entry?.images?.resolver ?? null,
    sessionKey: `guest-${sessionCounter}`,
  });
  if (entry) entry.images?.scan(entry.link.session.toString());
}

/** 访客：一篇不要了（关掉、主持人不给） */
function dropGuestDoc(id: number, doc: string) {
  const runtime = runtimes.get(id);
  const entry = runtime?.docs.get(doc);
  if (runtime && entry) {
    entry.cleanup();
    entry.link.destroy();
    runtime.docs.delete(doc);
  }
  const session = sessionOf(id);
  if (!session) return;
  const openDocs = session.openDocs.filter((open) => open !== doc);
  patch(id, { openDocs });
  if (session.current !== doc) return;
  const next = openDocs[0];
  if (next) {
    if (useCollab.getState().shownSession === id) showGuestDoc(id, next);
    else patch(id, { current: next });
    return;
  }
  patch(id, { current: null });
  if (useCollab.getState().shownSession === id)
    useCollab.setState({ session: null, images: null, showShared: false });
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
    start: (id: number) => Promise<void>;
  },
): Promise<void> {
  const id = nextSession++;
  try {
    await identityOf(current);
    heavyModules ??= await heavy();
    await ensurePipe(current);
    const runtime = runtimeOf(id);
    runtime.resumeStates = options.resumed ?? new Map();
    addSession(
      freshSession(id, "guest", "joining", {
        status: { state: "connecting" },
        joinLink: options.joinLink,
        joinRelay: options.joinRelay,
      }),
    );
    // 继续上次的：落盘的那几篇先建好（还没连上主持人也看得到上次写的），正文区是第一篇
    const first = [...runtime.resumeStates.keys()][0];
    for (const doc of runtime.resumeStates.keys()) guestDoc(id, doc);
    if (first) showGuestDoc(id, first);
    await options.start(id);
    // 继续上次的：断之前开着的那几篇照样开（连上以后 Rust 那边一篇一条流）
    for (const doc of runtime.resumeStates.keys()) await current.openDoc(id, doc).catch(() => {});
  } catch (error) {
    teardownSession(id);
    dropSession(id);
    useCollab.setState({
      focus: null,
      dialogOpen: true,
      joinLink: options.joinLink,
      error: `加入不了：${errorText(error)}`,
    });
  }
}

/* ---------------- 主持人：一篇一个会话 ---------------- */

/** 文件夹 folder 在不在 root 里（root 自己也算） */
function within(folder: string, root: string): boolean {
  return folder === root || folder.startsWith(`${root}/`);
}

/** 这篇笔记在哪个文件夹（不在了是 null） */
function folderOfNote(noteId: string): string | null {
  const note = useData.getState().notes.find((item) => item.id === noteId);
  return note ? folderOf(note) : null;
}

/**
 * 要主持的这个范围和哪一个正在主持的会话重叠（同一篇不能在两个会话里，docs/协同编辑.md §25）：
 * 返回那个会话号，不重叠是 null
 */
export function overlapOf(target: HostTarget): number | null {
  const { sessions, order } = useCollab.getState();
  for (const id of order) {
    const session = sessions[id];
    const scope = session?.scope;
    if (!session || session.role !== "host" || !scope) continue;
    if (scope.kind === "vault" || target.kind === "vault") return id;
    if (target.kind === "doc") {
      if (scope.kind === "doc" ? scope.doc === target.noteId : false) return id;
      const folder = folderOfNote(target.noteId);
      if (scope.kind === "folder" && folder !== null && within(folder, scope.doc)) return id;
      continue;
    }
    // 一个文件夹：里面有单独请过的一篇，或者两个文件夹一个套着一个
    if (scope.kind === "doc") {
      const folder = folderOfNote(scope.doc);
      if (folder !== null && within(folder, target.folder)) return id;
    } else if (within(scope.doc, target.folder) || within(target.folder, scope.doc)) {
      return id;
    }
  }
  return null;
}

/** 已经在协作里：对话框打开那一次，顶上说一句（按要请的是什么、撞上的是什么说） */
function showOverlap(id: number, target: HostTarget) {
  const scope = sessionOf(id)?.scope;
  const asked = target.kind === "folder" ? "这个文件夹" : "整个仓库";
  const notice =
    target.kind === "doc"
      ? "这一篇已经在这次协作里了：一篇只能在一次协作里"
      : scope?.kind === "doc"
        ? `「${noteTitleOf(scope.doc) || scope.name}」已经在这次协作里了：一篇只能在一次协作里，先停掉它再请${asked}`
        : `${asked}和这次协作的范围重叠了：一篇只能在一次协作里`;
  useCollab.setState({ dialogOpen: true, focus: id, notice });
}

/** 笔记现在的标题（改过名的话和开始协作时不一样） */
function noteTitleOf(noteId: string): string {
  return useData.getState().notes.find((note) => note.id === noteId)?.title ?? "";
}

/** 主持人：这一篇在不在这个会话的范围里。在的话返回 null，不在的话是给访客看的一句话 */
function refusalOf(id: number, doc: string): string | null {
  const session = sessionOf(id);
  const scope = session?.scope;
  if (!session || !scope) return "协作已经停了";
  const elsewhere = useCollab.getState().hostedIn[doc];
  if (elsewhere !== undefined && elsewhere !== id) return "这一篇正在另一个协作里";
  if (scope.kind === "doc") return doc === session.noteId ? null : "这一篇不在共享的范围里";
  const folder = folderOfNote(doc);
  if (folder === null) return "这一篇不在了（删掉了，或者归档了）";
  if (scope.kind === "vault") return null;
  return within(folder, scope.doc) ? null : "这一篇不在共享的文件夹里";
}

/** 主持人：这一篇登记进平的那张表（编辑器按它绑） */
function registerHosted(id: number, doc: string, session: CollabSession) {
  useCollab.setState((state) => ({
    hostedDocs: { ...state.hostedDocs, [doc]: session },
    hostedIn: { ...state.hostedIn, [doc]: id },
  }));
}

/**
 * 主持人：建这一篇的会话（正文从磁盘上的这一版开始；继续上次的话用落盘的状态，磁盘上后来的改动合进来）。
 * 团队仓库里的一篇（设计 §22.5 最后一段）：借团队那份会话，外人这条链路接在同一份上 —— 存盘、外部改动
 * 都归团队那边（团队里别人主持的话是他存）
 */
async function hostDoc(id: number, doc: string, resumeState?: Uint8Array): Promise<DocLink> {
  const runtime = runtimeOf(id);
  const known = runtime.docs.get(doc);
  if (known) return known;
  const current = await ensureNet();
  const sender = senderOf(current, id);
  const note = useData.getState().notes.find((item) => item.id === doc);
  const borrowed = await holdTeamDoc({ kind: "note", id: doc }, note);
  if (borrowed) {
    heavyModules ??= await heavy();
    const again = runtime.docs.get(doc);
    if (again) {
      borrowed.release();
      return again;
    }
    const link = heavyModules[0].attachSession(sender, { doc, session: borrowed.session });
    link.setMembers(sessionOf(id)?.members ?? []);
    const hosted = watchHosted(id, link.session, doc, current, heavyModules[1], false);
    const entry: DocLink = {
      link,
      images: null,
      cleanup: () => {
        hosted.stop();
        borrowed.release();
      },
      announce: hosted.resend,
    };
    runtime.docs.set(doc, entry);
    registerHosted(id, doc, link.session);
    return entry;
  }
  // 编辑器里还没存的先存下去：会话从磁盘上的这一版开始，外部改动才有准确的分叉点
  await flushAllEditors();
  const disk = await useData.getState().loadBody(doc);
  if (disk === undefined) throw new Error("这篇笔记已经不在了");
  heavyModules ??= await heavy();
  const [{ linkSession }, external] = heavyModules;
  const again = runtime.docs.get(doc);
  if (again) return again;
  const self = selfPeer();
  const link = resumeState
    ? linkSession(sender, { doc, self, initialState: resumeState })
    : linkSession(sender, { doc, self, initialText: disk });
  // 继续上次的：落盘的状态是最后一次存盘时的（两者同时取），之后磁盘上又变了（别的程序改的、
  // 崩溃前最后那几百毫秒存下去的）就当外部改动合进来
  if (resumeState && disk !== link.session.toString()) {
    external.mergeExternal(link.session, external.snapshot(link.session), disk);
  }
  link.setMembers(sessionOf(id)?.members ?? []);
  const hosted = watchHosted(id, link.session, doc, current, external);
  const stopPersist = watchPersist(id, doc, link.session, current);
  const entry: DocLink = {
    link,
    images: null,
    cleanup: () => {
      hosted.stop();
      stopPersist();
    },
    announce: () => {
      hosted.resend();
      current.saveState(id, doc, link.session.encodeState());
    },
  };
  runtime.docs.set(doc, entry);
  registerHosted(id, doc, link.session);
  return entry;
}

/** 主持人：这一篇没人开着了，收掉（先存下去） */
function dropHostedDoc(id: number, doc: string) {
  const runtime = runtimes.get(id);
  const entry = runtime?.docs.get(doc);
  if (!runtime || !entry) return;
  entry.cleanup();
  entry.link.destroy();
  runtime.docs.delete(doc);
  void net?.setAttachmentRefs(id, doc, null).catch(() => {});
  useCollab.setState((state) => {
    if (state.hostedIn[doc] !== id) return {};
    const { [doc]: _session, ...hostedDocs } = state.hostedDocs;
    const { [doc]: _id, ...hostedIn } = state.hostedIn;
    return { hostedDocs, hostedIn };
  });
}

/** 主持人：访客要开一篇 */
async function answerDocOpen(id: number, request: number, doc: string) {
  const current = net;
  if (!current || sessionOf(id)?.phase !== "hosting") return;
  const refusal = refusalOf(id, doc);
  if (refusal) {
    await current.answerDoc(id, request, refusal).catch(() => {});
    return;
  }
  try {
    const key = runtimes.get(id)?.resumeKey;
    const state = key
      ? await current.resumeState(true, key, doc).catch(() => undefined)
      : undefined;
    await hostDoc(id, doc, state);
    await current.answerDoc(id, request, null);
  } catch (error) {
    await current.answerDoc(id, request, errorText(error)).catch(() => {});
  }
}

/** 主持人：有人关掉了一篇。主持的那一篇（一篇的范围）留着；别的没人开着了就收掉 */
function onDocClosed(id: number, member: number, doc: string) {
  const session = sessionOf(id);
  if (session?.phase !== "hosting" || doc === session.noteId) return;
  const watching = session.members.some(
    (info) => !info.host && info.member !== member && info.docs.includes(doc),
  );
  if (!watching) dropHostedDoc(id, doc);
}

/** 主持人：访客要在范围里新建一篇 */
async function answerCreate(id: number, request: number, folder: string, title: string) {
  const current = net;
  const scope = sessionOf(id)?.scope;
  if (!current || !scope || scope.kind === "doc") {
    await current?.answerCreate(id, request, null, "这次协作只共享了一篇").catch(() => {});
    return;
  }
  const clean = folder.replace(/^\/+|\/+$/g, "");
  const place = scope.kind === "folder" ? [scope.doc, clean].filter(Boolean).join("/") : clean;
  try {
    const data = useData.getState();
    const noteId = await data.createNote(place || undefined);
    if (!noteId) throw new Error("建不了新的笔记");
    if (title.trim()) await data.saveTitle({ kind: "note", id: noteId }, title.trim());
    await current.answerCreate(id, request, noteId, null);
  } catch (error) {
    await current.answerCreate(id, request, null, errorText(error)).catch(() => {});
  }
}

/** 主持人：范围里的树（笔记的标题、在范围里的哪个文件夹），笔记一变就再给一份 */
/** 树里按文件夹、标题排（比 localeCompare 快一倍） */
const collator = new Intl.Collator();

function watchTree(id: number, scope: Scope, current: CollabNet): () => void {
  let last = "";
  /** 上一次的 id → 标题、文件夹：笔记列表一变（打字存盘也变）先比这个，标题、文件夹都没变就不重排。
   * 5000 篇时整棵排一遍、转 JSON 要 10ms 上下（两万篇 40ms），比一遍不到 1ms（docs/协同编辑.md §23.5） */
  let seen = new Map<string, string>();
  const changed = () => {
    const notes = useData.getState().notes;
    if (notes.length !== seen.size) return true;
    return notes.some((note) => seen.get(note.id) !== `${note.title}\u0000${folderOf(note)}`);
  };
  const push = () => {
    const notes = useData.getState().notes;
    seen = new Map(notes.map((note) => [note.id, `${note.title}\u0000${folderOf(note)}`]));
    const docs: CollabTreeDoc[] = [];
    for (const note of notes) {
      const folder = folderOf(note);
      if (scope.kind === "folder") {
        if (!within(folder, scope.doc)) continue;
        docs.push({
          id: note.id,
          title: note.title,
          folder: folder.slice(scope.doc.length).replace(/^\//, ""),
        });
      } else {
        docs.push({ id: note.id, title: note.title, folder });
      }
    }
    docs.sort((a, b) => collator.compare(a.folder, b.folder) || collator.compare(a.title, b.title));
    const tree = JSON.stringify({ docs } satisfies CollabTree);
    if (tree === last) return;
    last = tree;
    void current.setTree(id, tree).catch(() => {});
  };
  push();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = useData.subscribe((state, previous) => {
    if (state.notes === previous.notes || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (changed()) push();
    }, 300);
  });
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}

/** 刚开始主持：记住的人读一份 */
function refreshTrusted(current: CollabNet) {
  void current
    .trusted()
    .then((trusted) => useCollab.setState({ trusted }))
    .catch(() => {});
}

const globalInitial = {
  sessions: {} as Record<number, CollabSessionState>,
  order: [] as number[],
  focus: null as number | null,
  dialogOpen: false,
  notice: null as string | null,
  identity: null as CollabIdentity | null,
  hostedDocs: {} as Record<string, CollabSession>,
  hostedIn: {} as Record<string, number>,
  shownSession: null as number | null,
  showShared: false,
  session: null as CollabSession | null,
  sessionKey: "",
  images: null as ImageResolver | null,
  joinLink: "",
  joinRelay: null as string | null,
  directOnly: false,
  error: null as string | null,
  nearby: null as NearbyHost[] | null,
  nearbySince: null as number | null,
  nearbyError: null as string | null,
  knocks: [] as NearbyKnock[],
  resume: null as CollabResume | null,
  trusted: [] as TrustedPeer[],
};

export const useCollab = create<CollabState>((set, get) => ({
  ...globalInitial,

  openDialog: (joinLink) => {
    if (joinLink !== undefined) {
      set({ dialogOpen: true, focus: null, notice: null });
      get().setJoinLink(joinLink);
    } else {
      // 没说看哪个：接着看上次看的；那一个没了就看最后开始的那个
      const { focus, sessions, order } = get();
      set({
        dialogOpen: true,
        focus: focus !== null && sessions[focus] ? focus : (order[order.length - 1] ?? null),
      });
    }
    void ensureNet()
      .then(identityOf)
      .catch(() => {});
  },
  openSession: (id) => {
    if (!get().sessions[id]) return;
    set({ dialogOpen: true, focus: id, notice: null });
  },
  setFocus: (id) => set({ focus: id, notice: null }),
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
      const hosting = Object.values(get().sessions).some((session) => session.role === "host");
      if (hosting) {
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
  closeDialog: () => set({ dialogOpen: false, notice: null }),
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

  startHosting: async (noteId, title, resume) => {
    const target: HostTarget = { kind: "doc", noteId, title };
    const overlap = overlapOf(target);
    if (overlap !== null) {
      showOverlap(overlap, target);
      return;
    }
    const id = nextSession++;
    const scope: Scope = { kind: "doc", doc: noteId, name: title };
    runtimeOf(id);
    addSession(freshSession(id, "host", "preparing", { noteId, scope }));
    set({ dialogOpen: true });
    try {
      const current = await ensureNet();
      await identityOf(current);
      await ensurePipe(current);
      const entry = await hostDoc(id, noteId, resume?.state);
      const hosting = await current.host(id, title, "edit", noteId, scope, resume?.key ?? null);
      if (!get().sessions[id]) return;
      entry.link.setMembers(hosting.members);
      // 这一篇是在 Rust 那边挂上之前建的：附件引用、状态那时交过去没地方放，再交一遍
      entry.announce?.();
      refreshTrusted(current);
      patch(id, {
        phase: "hosting",
        key: hosting.key,
        link: hosting.link,
        members: hosting.members,
      });
    } catch (error) {
      teardownSession(id);
      dropSession(id);
      set({ dialogOpen: true, focus: null, error: `开始不了协作：${errorText(error)}` });
    }
  },

  startHostingScope: async (target, resumeKey) => {
    const overlap = overlapOf(target);
    if (overlap !== null) {
      showOverlap(overlap, target);
      return;
    }
    const id = nextSession++;
    const scope: Scope =
      target.kind === "folder"
        ? { kind: "folder", doc: target.folder, name: target.name }
        : { kind: "vault", doc: "", name: target.name };
    const runtime = runtimeOf(id);
    runtime.resumeKey = resumeKey ?? null;
    addSession(freshSession(id, "host", "preparing", { scope }));
    set({ dialogOpen: true });
    try {
      const current = await ensureNet();
      await identityOf(current);
      heavyModules ??= await heavy();
      await ensurePipe(current);
      const hosting = await current.host(id, scope.name, "edit", "", scope, resumeKey ?? null);
      if (!get().sessions[id]) return;
      runtime.treeCleanup = watchTree(id, scope, current);
      refreshTrusted(current);
      patch(id, {
        phase: "hosting",
        key: hosting.key,
        link: hosting.link,
        members: hosting.members,
      });
    } catch (error) {
      teardownSession(id);
      dropSession(id);
      set({ dialogOpen: true, focus: null, error: `开始不了协作：${errorText(error)}` });
    }
  },

  openShared: async (id, doc) => {
    const current = net;
    if (!current || get().sessions[id]?.phase !== "guest") return;
    guestDoc(id, doc);
    showGuestDoc(id, doc);
    set({ showShared: true, dialogOpen: false });
    await current.openDoc(id, doc).catch((error) => set({ error: errorText(error) }));
  },
  closeShared: async (id, doc) => {
    dropGuestDoc(id, doc);
    await net?.closeDoc(id, doc).catch(() => {});
  },
  createShared: async (id, folder, title) => {
    const current = net;
    if (!current || get().sessions[id]?.phase !== "guest") return;
    try {
      const doc = await current.createDoc(id, folder, title);
      await get().openShared(id, doc);
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
    set({ joinLink: "", joinRelay: null });
    await beginGuest(current, {
      joinLink: linkText,
      joinRelay: preview.relay,
      directOnly,
      start: (id) => current.join(id, linkText, directOnly),
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
  joinNearby: async (nearbyId) => {
    const current = await ensureNet();
    // Rust 那边加入时顺手把「附近」收掉了
    scanning = false;
    set({ nearby: null, nearbySince: null });
    await beginGuest(current, {
      joinLink: "",
      joinRelay: null,
      directOnly: false,
      start: (id) => current.joinNearby(id, nearbyId),
    });
  },
  answerKnock: async (request, session, permission) => {
    set((state) => ({ knocks: state.knocks.filter((knock) => knock.request !== request) }));
    await net?.answerNearby(request, session, permission).catch(() => {});
  },

  resumeHost: async (key) => {
    const info = get().resume?.hosts.find((item) => item.key === key);
    if (!info) return;
    set((state) => ({ resume: withoutResume(state.resume, true, key) }));
    // 文件夹、整个仓库：每篇的状态访客来开时再读
    if (info.scope && info.scope.kind !== "doc") {
      const target =
        info.scope.kind === "folder"
          ? { kind: "folder" as const, folder: info.scope.doc, name: info.scope.name }
          : { kind: "vault" as const, name: info.scope.name };
      await get().startHostingScope(target, key);
      return;
    }
    const current = await ensureNet();
    const state = await current.resumeState(true, key, info.note).catch(() => null);
    if (!state) {
      set({ error: "上次协作的状态已经没了", dialogOpen: true, focus: null });
      return;
    }
    const note = useData.getState().notes.find((item) => item.id === info.note);
    await get().startHosting(info.note, note?.title ?? info.title, { key, state });
  },
  resumeGuest: async (key) => {
    if (!get().resume?.guests.some((item) => item.key === key)) return;
    set((state) => ({ resume: withoutResume(state.resume, false, key) }));
    const current = await ensureNet();
    const resumed = new Map<string, Uint8Array>();
    for (const doc of await current.resumeDocs(key).catch(() => [] as string[])) {
      const state = await current.resumeState(false, key, doc).catch(() => null);
      if (state) resumed.set(doc, state);
    }
    if (!resumed.size) {
      set({ error: "上次做客的状态已经没了", dialogOpen: true, focus: null });
      return;
    }
    set({ dialogOpen: true });
    await beginGuest(current, {
      joinLink: "",
      joinRelay: null,
      directOnly: false,
      resumed,
      start: (id) => current.rejoin(id, key),
    });
  },
  discardResume: async (host, key) => {
    set((state) => ({ resume: withoutResume(state.resume, host, key) }));
    await net?.discardResume(host, key).catch(() => {});
  },

  stop: async (id) => {
    if (!get().sessions[id]) return;
    teardownSession(id);
    dropSession(id);
    await net?.stop(id).catch(() => {});
  },

  answer: async (id, request, allow) => {
    patch(id, (session) => ({
      requests: session.requests.filter((item) => item.request !== request),
    }));
    await net?.answer(id, request, allow);
  },
  setPermission: async (id, member, permission) => {
    if (!net) return;
    await net.setPermission(id, member, permission);
    // 记住过的人以后也按改过的权限进来（Rust 那边改了 config.json）
    const peer = get().sessions[id]?.members.find((item) => item.member === member)?.id;
    if (get().trusted.some((known) => known.id === peer)) set({ trusted: await net.trusted() });
  },
  kick: async (id, member) => {
    if (!net) return;
    await net.kick(id, member);
    // 移出了就不再记住
    set({ trusted: await net.trusted() });
  },
  remember: async (member) => {
    if (!net || member.host) return;
    set({ trusted: await net.remember(member.id, member.name, member.permission) });
  },
  forget: async (peerId) => {
    if (!net) return;
    set({ trusted: await net.forget(peerId) });
  },
  resetInvite: async (id) => {
    if (!net || get().sessions[id]?.phase !== "hosting") return;
    const fresh = await net.resetInvite(id);
    patch(id, { link: fresh });
  },
  makeCallback: async (id) => {
    if (!net || get().sessions[id]?.callbackBusy) return;
    patch(id, { callbackBusy: true });
    try {
      const callback = await net.callback(id);
      // 等的这几秒里已经进去了、或者走了：不用了
      if (get().sessions[id]?.phase === "joining") patch(id, { callback });
    } catch (error) {
      set({ error: `生成不了回连链接：${errorText(error)}` });
    } finally {
      patch(id, { callbackBusy: false });
    }
  },
  makeForwardLink: async (id) => {
    if (!net || get().sessions[id]?.forwardBusy) return;
    patch(id, { forwardBusy: true });
    try {
      const forward = await net.forwardLink(id);
      if (get().sessions[id]?.phase === "guest") patch(id, { forward });
    } catch (error) {
      set({ error: `生成不了转发链接：${errorText(error)}` });
    } finally {
      patch(id, { forwardBusy: false });
    }
  },
  dialBackTo: async (linkText) => {
    const current = await ensureNet();
    try {
      // 链接里带着会话 id：Rust 说是哪一次的
      const id = await current.dialBack(linkText.trim());
      patch(id, (session) =>
        session.dialBack?.state === "ok" ? {} : { dialBack: { state: "dialing", detail: null } },
      );
      set({ dialogOpen: true, focus: id, notice: null });
    } catch (error) {
      const { focus, sessions } = get();
      const host = focus !== null && sessions[focus]?.role === "host" ? focus : null;
      if (host !== null) {
        patch(host, { dialBack: { state: "failed", detail: errorText(error) } });
        set({ dialogOpen: true });
      } else {
        set({ dialogOpen: true, focus: null, error: errorText(error) });
      }
    }
  },
  setName: async (name) => {
    const current = await ensureNet();
    await current.setName(name);
    const identity = await current.identity();
    set({ identity });
  },
  setShowShared: (showShared, id) => {
    if (showShared && id !== undefined) {
      const doc = get().sessions[id]?.current;
      if (doc) showGuestDoc(id, doc);
    }
    set({ showShared });
  },

  saveCopy: async (target) => {
    const state = get();
    const id = target ?? state.shownSession;
    const shared = id === null ? undefined : state.sessions[id];
    const doc = shared?.current;
    const entry = id === null || !doc ? undefined : runtimes.get(id)?.docs.get(doc);
    if (!shared || !entry) return null;
    const markdown = entry.link.session.toString();
    const images = entry.images;
    const title = shared.title;
    // 访客窗口没开仓库：正文连同要来的图片（本机缓存的文件，或者 base64）交给最近用过的仓库窗口去存
    if (windowKind === "guest") {
      try {
        const copied = imageRefs(markdown).map((source) => {
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
          images: copied,
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
    const target = shownGuestDoc();
    if (!current || !target) return [];
    const out: Attachment[] = [];
    for (const file of files) {
      try {
        const data = await base64Of(file);
        out.push(
          await current.putAttachment(
            target.id,
            target.doc,
            file.name || fallbackName(file.type),
            data,
          ),
        );
      } catch (error) {
        reportAttachError(error);
      }
    }
    return out;
  },
  attachPaths: async (paths) => {
    const current = net;
    const target = shownGuestDoc();
    if (!current || !target) return [];
    const out: Attachment[] = [];
    for (const path of paths) {
      try {
        out.push(await current.putAttachmentPath(target.id, target.doc, path));
      } catch (error) {
        reportAttachError(error);
      }
    }
    return out;
  },
}));

/** 正文区那一篇（访客）：会话号、文档 id */
function shownGuestDoc(): { id: number; doc: string } | null {
  const { shownSession, sessions } = useCollab.getState();
  const session = shownSession === null ? undefined : sessions[shownSession];
  if (!session || session.phase !== "guest" || !session.current) return null;
  return { id: session.id, doc: session.current };
}

/** 继续上次的那一条处理过了（接着来了、不用了）：从卡片里拿掉 */
function withoutResume(
  resume: CollabResume | null,
  host: boolean,
  key: string,
): CollabResume | null {
  if (!resume) return null;
  const next = host
    ? { ...resume, hosts: resume.hosts.filter((item) => item.key !== key) }
    : { ...resume, guests: resume.guests.filter((item) => item.key !== key) };
  return next.hosts.length || next.guests.length ? next : null;
}

function reportAttachError(error: unknown) {
  useData.setState({ error: `附件没交给主持人：${errorText(error)}` });
}

/** 控制消息（成员、加入请求、连接状态）。session 是会话号，不属于哪个会话的是 null */
export function handleControl(sessionId: number | null, control: Control): void {
  if (sessionId === null) {
    switch (control.type) {
      case "nearby":
        if (scanning) useCollab.setState({ nearby: control.hosts });
        return;
      case "nearbyKnock":
        useCollab.setState((state) => ({
          knocks: [
            ...state.knocks.filter((knock) => knock.request !== control.request),
            { request: control.request, id: control.id, name: control.name },
          ],
        }));
        return;
      case "nearbyKnockDone":
        useCollab.setState((state) => ({
          knocks: state.knocks.filter((knock) => knock.request !== control.request),
        }));
        return;
      default:
        return;
    }
  }
  const id = sessionId;
  const session = sessionOf(id);
  if (!session) return;
  switch (control.type) {
    case "joinRequest":
      if (session.phase !== "hosting") return;
      patch(id, {
        requests: [
          ...session.requests.filter((item) => item.request !== control.request),
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
      if (session.phase !== "hosting") return;
      patch(id, { outdated: { name: control.name, guestOlder: control.guestOlder } });
      return;
    case "joinCancelled":
      patch(id, {
        requests: session.requests.filter((item) => item.request !== control.request),
      });
      return;
    case "members":
      for (const entry of runtimes.get(id)?.docs.values() ?? [])
        entry.link.setMembers(control.members);
      patch(id, { members: control.members });
      return;
    case "permission":
      patch(id, { permission: control.permission });
      return;
    case "status":
      handleStatus(id, control.status);
      return;
    case "reach":
      if (session.role !== "host") return;
      patch(id, {
        reach: control.reach,
        ...(control.link && session.phase === "hosting" ? { link: control.link } : {}),
      });
      return;
    case "route":
      patch(id, { relayed: control.relayed });
      return;
    case "dialBack":
      if (session.phase !== "hosting") return;
      patch(id, {
        dialBack: control.ok
          ? { state: "ok", detail: null }
          : { state: "failed", detail: control.detail },
      });
      return;
    case "docOpen":
      void answerDocOpen(id, control.request, control.doc);
      return;
    case "docClosed":
      onDocClosed(id, control.member, control.doc);
      return;
    case "createDoc":
      void answerCreate(id, control.request, control.folder, control.title);
      return;
    case "tree":
      try {
        patch(id, { tree: JSON.parse(control.tree) as CollabTree });
        const current = sessionOf(id)?.current;
        if (current && useCollab.getState().shownSession === id) showGuestDoc(id, current);
      } catch {
        // 主持人那边的版本说的不是这种树：当没有
      }
      return;
    case "docRefused":
      dropGuestDoc(id, control.doc);
      useCollab.setState({ error: `打不开：${control.reason}` });
      return;
    default:
      return;
  }
}

function handleStatus(id: number, status: Status) {
  const session = sessionOf(id);
  // 主持人自己停的、或者早就不在会话里了
  if (!session || session.role !== "guest") return;
  const runtime = runtimes.get(id);
  if (status.state === "connected") {
    // 连上了（第一次、或者断了又连上）：之前没要到的图片再要一遍
    for (const entry of runtime?.docs.values() ?? []) {
      entry.images?.retryFailed();
      entry.images?.scan(entry.link.session.toString());
    }
    const single = status.scope.kind === "doc";
    const first = session.phase === "joining";
    patch(id, {
      phase: "guest",
      status,
      scope: status.scope,
      title: single ? status.title : session.title,
      permission: status.permission,
      ...(first && single ? { current: status.scope.doc } : {}),
    });
    // 第一次进来：一篇的范围对话框收起，正文区换成共享的那篇；文件夹、整个仓库的对话框留着，挑一篇开
    if (first && single) {
      useCollab.setState({ shownSession: id, showShared: true, dialogOpen: false });
      if (runtime?.docs.has(status.scope.doc)) showGuestDoc(id, status.scope.doc);
    }
    return;
  }
  if (status.state === "ended" && status.reason.kind === "left") return;
  patch(id, { status });
  if (status.state === "ended" && session.phase === "joining") {
    useCollab.setState({ error: endText(status.reason) });
  }
  if (status.state === "ended" && runtime) {
    // 结束了：网络那头已经收掉，会话留着（共享的那几篇还能看、能存一份），不再收发、不再落盘
    for (const entry of runtime.docs.values()) entry.cleanup();
    for (const entry of runtime.docs.values()) entry.cleanup = () => {};
    runtime.ended = true;
  }
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

/** 这个会话的主持人叫什么（访客那边是 0 号成员；主持人是自己） */
export function hostNameOf(session: CollabSessionState): string {
  return session.members.find((member) => member.host)?.name ?? "主持人";
}

/**
 * 会话叫什么（会话条、提示卡里）：主持的是标题 / 文件夹「x」/ 仓库「x」；做客的是那一篇的标题或者范围。
 * noteTitle：主持一篇时那篇笔记现在的标题（改了名跟着变）
 */
export function sessionName(session: CollabSessionState, noteTitle?: string): string {
  const scope = session.scope;
  if (scope?.kind === "folder") return `文件夹「${scope.name}」`;
  if (scope?.kind === "vault") return `仓库「${scope.name}」`;
  if (session.role === "host") return noteTitle || scope?.name || "这一篇";
  return session.title || scope?.name || (session.phase === "joining" ? "正在加入…" : "协作的笔记");
}

/**
 * 主持人：会话的正文一变就存；文件被别的程序改了就合进会话；笔记改了名告诉 Rust（之后进来的人看到新标题）；
 * 正文里引用的附件告诉 Rust（访客只要得到这些）。resend：Rust 那边会话刚挂上，附件引用再交一遍
 */
function watchHosted(
  id: number,
  session: CollabSession,
  noteId: string,
  current: CollabNet,
  { snapshot, mergeExternal }: typeof import("./external"),
  /** false：会话是借团队的，存盘、外部改动归团队那边，这里只管附件引用和标题 */
  writes = true,
): { stop: () => void; resend: () => void } {
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
      current.saveState(id, noteId, state);
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
    void current.setAttachmentRefs(id, noteId, refs).catch(() => {});
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
    // 存下去了（这一篇在数据层里的正文换成了会话里的这一版；借团队的会话时是团队那边存的）：
    // 告诉访客存到了哪一版，他们本机留的那份就可以删了（keep.ts）
    const body = state.bodies[noteId];
    if (body !== previous.bodies[noteId] && body === session.toString()) {
      const guests = (sessionOf(id)?.members ?? [])
        .map((member) => member.member)
        .filter((member) => member !== 0);
      for (const member of guests)
        current.send(id, PIPE.syncVector, member, noteId, session.stateVector());
    }
    if (writes && state.externalRevisions[key] !== previous.externalRevisions[key]) {
      const disk = state.bodies[noteId];
      if (disk !== undefined && disk !== session.toString()) mergeExternal(session, saved, disk);
    }
    const next = state.notes.find((note) => note.id === noteId)?.title;
    // 标题给访客：一篇的范围才有（文件夹、整个仓库的标题在树里）
    if (next && next !== title) {
      title = next;
      if (sessionOf(id)?.noteId === noteId) void current.setTitle(id, next).catch(() => {});
    }
  });

  return {
    stop: () => {
      stopChanges();
      if (refsTimer) clearTimeout(refsTimer);
      if (timer) {
        clearTimeout(timer);
        void save();
      }
      unsubscribe();
    },
    // 附件引用再交一遍（没变也交）
    resend: () => {
      lastRefs = "";
      pushRefs();
    },
  };
}

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
  const noteId = await data.createNote("");
  if (!noteId) return null;
  const target = { kind: "note", id: noteId } as const;
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
  return noteId;
}

/** 仓库窗口：访客窗口交过来一份要存的（「存一份到我的笔记」）：存下来、打开它 */
async function receiveCopy(current: CollabNet): Promise<void> {
  const copy = await current.takeCopy().catch(() => null);
  if (!copy) return;
  const images = new Map(copy.images.map((image) => [image.source, image]));
  const noteId = await storeCopy(copy.title, copy.markdown, (ref) => {
    const image = images.get(ref);
    if (!image) return undefined;
    return { url: image.data ? `data:;base64,${image.data}` : "", file: image.file };
  });
  if (!noteId) return;
  openDocument({ kind: "note", id: noteId });
  useData.setState({ notice: `「${copy.title}」存了一份到笔记` });
}

/** 应用起来时调一次：订阅控制消息、接住 odea:// 链接（冷启动带进来的、开着时点的）、看看有没有上次没正常结束的协作 */
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
  if (resume && (resume.hosts.length || resume.guests.length)) {
    useCollab.setState({ resume });
  }
}

/** 测试：换网络层、清状态 */
export function resetCollabForTest(next: CollabNet | null): void {
  for (const id of [...runtimes.keys()]) teardownSession(id);
  stopPipe?.();
  stopPipe = null;
  opening = null;
  scanning = false;
  net = next;
  useCollab.setState({ ...globalInitial });
}
