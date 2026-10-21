import { openDocument } from "@/app/navigate";
import { useApp } from "@/app/store";
import { base64Of, fallbackName } from "@/data/attachments";
import { backend } from "@/data/backend";
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
  Status,
  TrustedPeer,
} from "@/lib/bindings";
import { windowKind } from "@/lib/tauri";
import { create } from "zustand";
import { GuestImages, copyImages, dataUrlBase64, imageRefs, vaultPathOf } from "./attachments";
import { peerColor } from "./colors";
import type { SavedSnapshot } from "./external";
import type { SessionLink } from "./link";
import { type CollabNet, type FetchedAttachment, collabNet, errorText } from "./net";
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
   落盘（设计 §3）：双方每隔两秒（主持人还有每次存盘时）把文档的状态交给 Rust。崩溃、强退以后
   重启，resume 里是上次的：主持人「继续协作」用同一个会话 id 和端口重新起来，访客自己接上；
   访客「重新加入」用落盘的状态建会话，断线期间各自的改动同步时补齐
   ============================================================ */

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
  /** 主持的是哪篇 */
  noteId: string | null;
  link: string | null;
  members: MemberInfo[];
  requests: JoinRequest[];
  /** 访客的连接状态 */
  status: Status | null;
  /** 访客：主持人那篇的标题 */
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
  /** 会话（编辑器接它） */
  session: CollabSession | null;
  /** 这次会话的键（做客那一篇的文档 key 用它：每次加入都是新的一篇） */
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
  /** 开始主持。resumeState：继续上次没正常结束的那一次（落盘的文档状态） */
  startHosting(noteId: string, title: string, resumeState?: Uint8Array): Promise<void>;
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
let link: SessionLink | null = null;
let stopPipe: (() => void) | null = null;
/** 主持人：存盘、外部改动、标题、附件引用的订阅；停止时一起拆 */
let hostCleanup: (() => void) | null = null;
/** 访客：要图片的 */
let guestImages: GuestImages | null = null;
let guestCleanup: (() => void) | null = null;
/** 双方：定时落盘 */
let persistCleanup: (() => void) | null = null;
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
export function linkKind(text: string): "join" | "back" | "relay" | "share" | null {
  const clean = text.trim().replace(/^[<"']+|[>"']+$/g, "");
  const match = /^odea:(?:\/\/)?(join|back|relay|share)\//i.exec(clean);
  if (match) return match[1]!.toLowerCase() as "join" | "back" | "relay" | "share";
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
  hostCleanup?.();
  hostCleanup = null;
  guestCleanup?.();
  guestCleanup = null;
  guestImages = null;
  persistCleanup?.();
  persistCleanup = null;
  stopPipe?.();
  stopPipe = null;
  link?.destroy();
  link = null;
}

/** 双方：正文一变，停下两秒后把文档的状态落盘；开始时先落一次 */
function watchPersist(session: CollabSession, current: CollabNet): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    timer = null;
    current.saveState(session.encodeState());
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

/** 访客：正文一变，看看有没有新的相对路径图片要向主持人要 */
function watchGuestImages(session: CollabSession, current: CollabNet): () => void {
  const images = new GuestImages(
    (path) => current.fetchAttachment(path),
    (resolver) => useCollab.setState({ images: resolver }),
  );
  guestImages = images;
  useCollab.setState({ images: images.resolver });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onUpdate = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      images.scan(session.toString());
    }, 300);
  };
  const stop = session.onChange(onUpdate);
  return () => {
    stop();
    if (timer) clearTimeout(timer);
    images.destroy();
  };
}

/** 访客：建会话、接上帧，再让 Rust 去连（链接的、附近的、继续上次的都走这里） */
async function beginGuest(
  current: CollabNet,
  options: {
    joinLink: string;
    joinRelay: string | null;
    directOnly: boolean;
    initialState?: Uint8Array;
    start: () => Promise<void>;
  },
): Promise<void> {
  const set = useCollab.setState;
  await useCollab.getState().stop();
  try {
    const identity = await identityOf(current);
    const self = { id: identity.id, name: identity.name, color: peerColor(identity.id) };
    // 访客的会话从空的开始：正文由主持人同步过来（两边各自用同一段文字建的话会重复一遍）。
    // 继续上次的：用落盘的状态，断线期间各自的改动同步时补齐
    const [{ linkSession }] = await heavy();
    link = linkSession(current, { self, initialState: options.initialState });
    stopPipe = await current.openPipe((frame) => link?.receive(frame));
    sessionCounter += 1;
    set({
      ...initial,
      phase: "joining",
      status: { state: "connecting" },
      joinLink: options.joinLink,
      joinRelay: options.joinRelay,
      directOnly: options.directOnly,
      session: link.session,
      sessionKey: `guest-${sessionCounter}`,
    });
    guestCleanup = watchGuestImages(link.session, current);
    await options.start();
    persistCleanup = watchPersist(link.session, current);
  } catch (error) {
    teardown();
    set({ ...initial, joinLink: options.joinLink, error: `加入不了：${errorText(error)}` });
  }
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
    // 共享仓库的邀请（docs/协同编辑.md §20.8）：加入共享仓库的对话框
    if (kind === "share") {
      void import("@/share/store").then(({ useShare }) => useShare.getState().openJoin(link));
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
    set({ ...initial, phase: "preparing", noteId, dialogOpen: true });
    try {
      const current = await ensureNet();
      const identity = await identityOf(current);
      // 编辑器里还没存的先存下去：会话从磁盘上的这一版开始，外部改动才有准确的分叉点
      await flushAllEditors();
      const disk = await useData.getState().loadBody(noteId);
      if (disk === undefined) throw new Error("这篇笔记已经不在了");
      const self = { id: identity.id, name: identity.name, color: peerColor(identity.id) };
      const [{ linkSession }, external] = await heavy();
      link = resumeState
        ? linkSession(current, { self, initialState: resumeState })
        : linkSession(current, { self, initialText: disk });
      // 继续上次的：落盘的状态是最后一次存盘时的（两者同时取），之后磁盘上又变了（别的程序改的、
      // 崩溃前最后那几百毫秒存下去的）就当外部改动合进来
      if (resumeState && disk !== link.session.toString()) {
        external.mergeExternal(link.session, external.snapshot(link.session), disk);
      }
      stopPipe = await current.openPipe((frame) => link?.receive(frame));
      const hosting = await current.host(title, "edit", noteId, !!resumeState);
      if (get().phase !== "preparing" || get().noteId !== noteId) return;
      hostCleanup = watchHosted(link.session, noteId, current, external);
      persistCleanup = watchPersist(link.session, current);
      link.setMembers(hosting.members);
      void current
        .trusted()
        .then((trusted) => set({ trusted }))
        .catch(() => {});
      sessionCounter += 1;
      set({
        phase: "hosting",
        link: hosting.link,
        members: hosting.members,
        session: link.session,
        sessionKey: `host-${sessionCounter}`,
      });
    } catch (error) {
      teardown();
      set({ ...initial, error: `开始不了协作：${errorText(error)}` });
    }
  },

  join: async (raw) => {
    const linkText = raw.trim();
    const kind = linkKind(linkText);
    // 粘的是共享仓库的邀请：换到加入共享仓库
    if (kind === "share") {
      get().closeDialog();
      void import("@/share/store").then(({ useShare }) => useShare.getState().openJoin(linkText));
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
    const current = await ensureNet();
    const state = await current.resumeState(true).catch(() => null);
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
    const state = await current.resumeState(false).catch(() => null);
    if (!state) {
      set({ error: "上次做客的状态已经没了", dialogOpen: true });
      return;
    }
    set({ dialogOpen: true });
    await beginGuest(current, {
      joinLink: "",
      joinRelay: null,
      directOnly: false,
      initialState: state,
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
    const { session, title } = get();
    if (!session) return null;
    const markdown = session.toString();
    const images = guestImages;
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
    if (!current || get().phase !== "guest") return [];
    const out: Attachment[] = [];
    for (const file of files) {
      try {
        const data = await base64Of(file);
        out.push(await current.putAttachment(file.name || fallbackName(file.type), data));
      } catch (error) {
        reportAttachError(error);
      }
    }
    return out;
  },
  attachPaths: async (paths) => {
    const current = net;
    if (!current || get().phase !== "guest") return [];
    const out: Attachment[] = [];
    for (const path of paths) {
      try {
        out.push(await current.putAttachmentPath(path));
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
      link?.setMembers(control.members);
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
  }
}

function handleStatus(status: Status) {
  const state = useCollab.getState();
  // 主持人自己停的、或者早就不在会话里了
  if (state.phase === "idle" || state.phase === "preparing" || state.phase === "hosting") return;
  if (status.state === "connected") {
    // 连上了（第一次、或者断了又连上）：之前没要到的图片再要一遍
    guestImages?.retryFailed();
    if (link) guestImages?.scan(link.session.toString());
    useCollab.setState({
      phase: "guest",
      status,
      title: status.title,
      permission: status.permission,
      // 第一次进来：对话框收起，正文区换成共享的那篇
      ...(state.phase === "joining" ? { showShared: true, dialogOpen: false } : {}),
    });
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
    // 结束了：网络那头已经收掉，会话留着（共享的那篇还能看、能存一份），不再收发、不再落盘
    persistCleanup?.();
    persistCleanup = null;
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
      current.saveState(state);
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
    void current.setAttachmentRefs(refs).catch(() => {});
  };
  pushRefs();

  const onUpdate = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void save(), 400);
    refsTimer ??= setTimeout(pushRefs, 200);
  };
  const stopChanges = session.onChange(onUpdate);

  const key = `note:${noteId}`;
  let title = useData.getState().notes.find((note) => note.id === noteId)?.title;
  const unsubscribe = useData.subscribe((state, previous) => {
    if (state.externalRevisions[key] !== previous.externalRevisions[key]) {
      const disk = state.bodies[noteId];
      if (disk !== undefined && disk !== session.toString()) mergeExternal(session, saved, disk);
    }
    const next = state.notes.find((note) => note.id === noteId)?.title;
    if (next && next !== title) {
      title = next;
      void current.setTitle(next).catch(() => {});
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
