import type {
  AppError,
  Attachment,
  AttachmentRef,
  CollabCallback,
  CollabHosting,
  CollabIdentity,
  CollabResume,
  Control,
  Result as IpcResult,
  Permission,
  RelayCheck,
  RelayInfo,
  Scope,
  SharedCopy,
  TrustedPeer,
} from "@/lib/bindings";
import { events, commands } from "@/lib/bindings";
import { isTauri, thisWindow } from "@/lib/tauri";
import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";

/* ============================================================
   前端和网络之间（docs/协同编辑.md §5.5）。

   网络在 Rust（src-tauri/src/collab）：iroh 端点、握手、成员、星形转发。前端这边只有两样：
   - 控制：开始 / 加入 / 回答加入请求 / 踢人……走 tauri-specta 的命令；成员、加入请求、
     连接状态从 CollabEvent 事件里来
   - 数据：文档更新、光标、同步请求是不透明的字节。不走 JSON（一字节一个数字）：
     前端 → Rust 是原始请求体（collab_send），Rust → 前端是二进制 Channel（collab_pipe）。
     帧 = 1 字节类型 + 2 字节会话号 + 2 字节成员号（都是小端）+ 1 字节文档 id 长度 + 文档 id + 内容。
     一条连接里好几篇（设计 §22.5）：每一帧都带着是哪篇
   同时好几个会话（设计 §25）：会话号是前端起的（一个窗口里不重复），每个命令、每个事件、每一帧都带着它。
   团队（team/net.ts）用同一套帧，会话号填 0

   浏览器预览里没有 Rust：换成 mockNet.ts（同一套帧，模拟一位访客来敲门、打字），
   界面在浏览器里也能走通、也能写测试。
   ============================================================ */

/** 帧类型（和 commands.rs 的 PIPE_* 一致） */
export const PIPE = {
  /** 文档更新（别人的 Update / Sync2；自己发出去的 Update） */
  update: 1,
  cursor: 2,
  /** 收：某人发来了状态向量，回他缺的；发：回给某人的 Sync2 */
  syncReply: 3,
  /** 收：刚连上某人，把自己的状态向量发给他；发：发给某人的 Sync1 */
  syncVector: 4,
  /** 发：文档的状态，落盘（崩溃后接得上） */
  save: 5,
} as const;

/** 添加中继：粘中继码，或者手填 */
export type RelayInput =
  | { code: string }
  | { url: string; token?: string; fingerprint?: string; name?: string };

export interface Frame {
  kind: number;
  /** 哪个会话（会话号；团队的是 0） */
  session: number;
  member: number;
  /** 哪一篇（文档 id） */
  doc: string;
  payload: Uint8Array;
}

/** 访客向主持人要来的一个附件 */
export interface FetchedAttachment {
  /** <img> 能用的地址 */
  url: string;
  /** 本机缓存的那个文件，文件名是正文里写的那个（「存一份到我的笔记」按它存）；浏览器预览里没有 */
  file: string | null;
}

/** 不属于哪个会话的控制消息（「附近」的列表、「附近」进来要挑）session 是 null */
export type ControlListener = (session: number | null, control: Control) => void;

export interface CollabNet {
  identity(): Promise<CollabIdentity>;
  setName(name: string): Promise<void>;
  /**
   * 开始一个主持的会话（session 是前端起的会话号）：端点没起的话起一个（要两三秒，iroh 初始化网络监视），
   * 返回邀请链接。note 是主持的那篇的 id（一篇的范围；文件夹、整个仓库是空串），scope 是邀请的范围
   * （设计 §22.5）；resume = 继续上次没正常结束的那一次（落盘文件夹的名字：同一个会话 id、邀请密钥、端口）
   */
  host(
    session: number,
    title: string,
    permission: Permission,
    note: string,
    scope: Scope,
    resume: string | null,
  ): Promise<CollabHosting>;
  resetInvite(session: number): Promise<string>;
  /** 链接认不认得出、带没带中继：认不出是一句话 */
  checkLink(link: string): Promise<{ relay: string | null } | string>;
  /** 加入：马上返回，进展从 onControl 的 status 里出来。directOnly：不经主持人的中继 */
  join(session: number, link: string, directOnly: boolean): Promise<void>;
  /** 访客连不上时：生成回连链接（要等端口映射、中继，最多五秒） */
  callback(session: number): Promise<CollabCallback>;
  /** 访客：转发链接（设计 §20.9）。和回连链接一样要先看能不能被连进来 */
  forwardLink(session: number): Promise<CollabCallback>;
  /** 主持人打开了回连链接：往访客那边拨，返回是哪个会话的；结果从那个会话的 onControl 的 dialBack 里出来 */
  dialBack(link: string): Promise<number>;
  /* 自己配的中继（设计 §6.4）：令牌不出 Rust，这边只看得到「带没带令牌」 */
  relays(): Promise<RelayInfo[]>;
  /** 中继码里是哪一台（添加前给用户确认） */
  relayInspect(code: string): Promise<RelayInfo>;
  relayAdd(input: RelayInput): Promise<RelayInfo[]>;
  relayRemove(url: string): Promise<RelayInfo[]>;
  /** 这台中继的中继码（带令牌）：发给团队里的其他人 */
  relayCode(url: string): Promise<string>;
  relayTest(url: string): Promise<RelayCheck>;
  /* 「附近」（设计 §8.3）：加入对话框开着时看同一个网络里谁在分享，列表从 onControl 的 nearby 里出来 */
  nearbyStart(): Promise<void>;
  nearbyStop(): Promise<void>;
  /** 点了列表里的一位：不用链接请求加入，进展和 join 一样 */
  joinNearby(session: number, id: string): Promise<void>;
  /** 「附近」进来一位、我主持着好几个（nearbyKnock）：让他进哪一个（null = 拒绝） */
  answerNearby(request: number, session: number | null, permission: Permission): Promise<boolean>;
  /* 落盘（设计 §3、§25.2）：一个会话一份，每篇一个快照 */
  /** 这一篇的状态交给 Rust 存（不等回话） */
  saveState(session: number, doc: string, state: Uint8Array): void;
  /** 上次没正常结束的几次协作 */
  resumeInfo(): Promise<CollabResume>;
  /** 落盘的那一次（key）里这一篇的状态 */
  resumeState(host: boolean, key: string, doc: string): Promise<Uint8Array>;
  /** 访客：上次那一次做客时开着的那几篇 */
  resumeDocs(key: string): Promise<string[]>;
  /** 访客：继续上次的那一次做客（会话已经用落盘的状态建好了） */
  rejoin(session: number, key: string): Promise<void>;
  discardResume(host: boolean, key: string): Promise<void>;
  /* 附件（设计 §7.2）：都按篇 */
  /** 主持人：这一篇正文里引用的附件（只有这些访客要得到）。null = 这一篇不在协作里了 */
  setAttachmentRefs(session: number, doc: string, refs: AttachmentRef[] | null): Promise<void>;
  /** 访客：向主持人要这一篇里引用的一个，缓存在本机 */
  fetchAttachment(session: number, doc: string, path: string): Promise<FetchedAttachment>;
  /** 访客：粘贴的文件交给主持人存进这一篇的附件位置，返回从那篇引用它的路径 */
  putAttachment(
    session: number,
    doc: string,
    name: string,
    dataBase64: string,
  ): Promise<Attachment>;
  putAttachmentPath(session: number, doc: string, path: string): Promise<Attachment>;
  /* 一条连接里好几篇（设计 §22.5） */
  /** 主持人：对「访客要开这一篇」（docOpen）的回话。error 为 null = 给 */
  answerDoc(session: number, request: number, error: string | null): Promise<boolean>;
  /** 主持人：范围里的树（JSON）。变了再给一次整棵 */
  setTree(session: number, tree: string): Promise<void>;
  /** 主持人：访客要的那篇建好了（doc）或者建不了（error） */
  answerCreate(
    session: number,
    request: number,
    doc: string | null,
    error: string | null,
  ): Promise<boolean>;
  /** 访客：开一篇（开好了从管道上来 syncVector；不给是 onControl 的 docRefused） */
  openDoc(session: number, doc: string): Promise<void>;
  closeDoc(session: number, doc: string): Promise<void>;
  /** 访客：在范围里新建一篇（主持人那边建），返回它的文档 id */
  createDoc(session: number, folder: string, title: string): Promise<string>;
  answer(session: number, request: number, allow: Permission | null): Promise<boolean>;
  setPermission(session: number, member: number, permission: Permission): Promise<void>;
  kick(session: number, member: number): Promise<void>;
  /* 记住的人（设计 §8.2）：下次拿着链接或者从「附近」进来不问。都返回改完的整张表 */
  trusted(): Promise<TrustedPeer[]>;
  remember(id: string, name: string, permission: Permission): Promise<TrustedPeer[]>;
  forget(id: string): Promise<TrustedPeer[]>;
  setTitle(session: number, title: string): Promise<void>;
  /** 停止这一次协作（主持人）/ 离开（访客） */
  stop(session: number): Promise<void>;
  /** 开始收字节（所有会话的都从这里来，帧里带着会话号）。返回的函数是停 */
  openPipe(onFrame: (frame: Frame) => void): Promise<() => void>;
  send(session: number, kind: number, member: number, doc: string, payload: Uint8Array): void;
  onControl(listener: ControlListener): Promise<() => void>;
  /** 冷启动时点进来的 odea:// 链接 */
  pendingLink(): Promise<string | null>;
  /** 应用开着时点了 odea:// 链接 */
  onLink(listener: (link: string) => void): Promise<() => void>;
  /* 访客窗口（没开仓库）的「存一份到我的笔记」（docs/仓库与启动器.md §13） */
  /** 访客窗口：交给最近用过的仓库窗口去存（一个都没开着就先打开最近的仓库） */
  copyToVault(copy: SharedCopy): Promise<void>;
  /** 仓库窗口：访客窗口交过来、等着存的那一份（取一次就清掉） */
  takeCopy(): Promise<SharedCopy | null>;
  /** 仓库窗口：有一份等着存了 */
  onCopyReady(listener: () => void): Promise<() => void>;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

export function encodeFrame(
  kind: number,
  session: number,
  member: number,
  doc: string,
  payload: Uint8Array,
): Uint8Array {
  const id = utf8.encode(doc).subarray(0, 255);
  const frame = new Uint8Array(payload.length + id.length + 6);
  frame[0] = kind;
  frame[1] = session & 0xff;
  frame[2] = (session >> 8) & 0xff;
  frame[3] = member & 0xff;
  frame[4] = (member >> 8) & 0xff;
  frame[5] = id.length;
  frame.set(id, 6);
  frame.set(payload, 6 + id.length);
  return frame;
}

export function decodeFrame(data: ArrayBuffer | Uint8Array | number[]): Frame | null {
  const bytes =
    data instanceof Uint8Array
      ? data
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : Uint8Array.from(data);
  if (bytes.length < 6) return null;
  const length = bytes[5]!;
  if (bytes.length < 6 + length) return null;
  return {
    kind: bytes[0]!,
    session: bytes[1]! | (bytes[2]! << 8),
    member: bytes[3]! | (bytes[4]! << 8),
    doc: fromUtf8.decode(bytes.subarray(6, 6 + length)),
    payload: bytes.subarray(6 + length),
  };
}

/** AppError → 一句话 */
export function errorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

async function unwrap<T>(request: Promise<IpcResult<T, AppError>>): Promise<T> {
  const result = await request;
  if (result.status === "error") throw new Error(errorText(result.error));
  return result.data;
}

const tauriNet: CollabNet = {
  identity: () => unwrap(commands.collabIdentity()),
  setName: async (name) => {
    await unwrap(commands.collabSetName(name));
  },
  host: (session, title, permission, note, scope, resume) =>
    unwrap(commands.collabHost(session, title, permission, note, scope, resume)),
  resetInvite: (session) => unwrap(commands.collabResetInvite(session)),
  checkLink: async (link) => {
    const result = await commands.collabCheckLink(link);
    return result.status === "ok" ? result.data : errorText(result.error);
  },
  join: async (session, link, directOnly) => {
    await unwrap(commands.collabJoin(session, link, directOnly));
  },
  callback: (session) => unwrap(commands.collabCallback(session)),
  forwardLink: (session) => unwrap(commands.collabForwardLink(session)),
  dialBack: (link) => unwrap(commands.collabDialBack(link)),
  relays: () => unwrap(commands.collabRelays()),
  relayInspect: (code) => unwrap(commands.collabRelayInspect(code)),
  relayAdd: (input) =>
    unwrap(
      "code" in input
        ? commands.collabRelayAdd(input.code, null, null, null, null)
        : commands.collabRelayAdd(
            null,
            input.url,
            input.token || null,
            input.fingerprint || null,
            input.name || null,
          ),
    ),
  relayRemove: (url) => unwrap(commands.collabRelayRemove(url)),
  relayCode: (url) => unwrap(commands.collabRelayCode(url)),
  relayTest: (url) => unwrap(commands.collabRelayTest(url)),
  nearbyStart: async () => {
    await unwrap(commands.collabNearbyStart());
  },
  nearbyStop: async () => {
    await unwrap(commands.collabNearbyStop());
  },
  joinNearby: async (session, id) => {
    await unwrap(commands.collabJoinNearby(session, id));
  },
  answerNearby: (request, session, permission) =>
    unwrap(commands.collabAnswerNearby(request, session, permission)),
  saveState: (session, doc, state) => tauriNet.send(session, PIPE.save, 0, doc, state),
  resumeInfo: () => unwrap(commands.collabResumeInfo()),
  resumeState: async (host, key, doc) => {
    // 原始字节（不经 tauri-specta）
    const data = await invoke<ArrayBuffer>("collab_resume_state", { host, key, doc });
    return new Uint8Array(data);
  },
  resumeDocs: (key) => unwrap(commands.collabResumeDocs(key)),
  rejoin: async (session, key) => {
    await unwrap(commands.collabRejoin(session, key));
  },
  discardResume: async (host, key) => {
    await unwrap(commands.collabDiscardResume(host, key));
  },
  setAttachmentRefs: async (session, doc, refs) => {
    await unwrap(commands.collabSetAttachmentRefs(session, doc, refs));
  },
  fetchAttachment: async (session, doc, path) => {
    const file = await unwrap(commands.collabFetchAttachment(session, doc, path));
    return { url: convertFileSrc(file), file };
  },
  putAttachment: (session, doc, name, dataBase64) =>
    unwrap(commands.collabPutAttachment(session, doc, name, dataBase64)),
  putAttachmentPath: (session, doc, path) =>
    unwrap(commands.collabPutAttachmentPath(session, doc, path)),
  answerDoc: (session, request, error) => unwrap(commands.collabDocAnswer(session, request, error)),
  setTree: async (session, tree) => {
    await unwrap(commands.collabSetTree(session, tree));
  },
  answerCreate: (session, request, doc, error) =>
    unwrap(commands.collabCreateAnswer(session, request, doc, error)),
  openDoc: async (session, doc) => {
    await unwrap(commands.collabOpenDoc(session, doc));
  },
  closeDoc: async (session, doc) => {
    await unwrap(commands.collabCloseDoc(session, doc));
  },
  createDoc: (session, folder, title) => unwrap(commands.collabCreateDoc(session, folder, title)),
  answer: (session, request, allow) => unwrap(commands.collabAnswer(session, request, allow)),
  setPermission: async (session, member, permission) => {
    await unwrap(commands.collabSetPermission(session, member, permission));
  },
  kick: async (session, member) => {
    await unwrap(commands.collabKick(session, member));
  },
  trusted: () => unwrap(commands.collabTrusted()),
  remember: (id, name, permission) => unwrap(commands.collabRemember(id, name, permission)),
  forget: (id) => unwrap(commands.collabForget(id)),
  setTitle: async (session, title) => {
    await unwrap(commands.collabSetTitle(session, title));
  },
  stop: async (session) => {
    await unwrap(commands.collabStop(session));
  },
  openPipe: async (onFrame) => {
    let open = true;
    const channel = new Channel<ArrayBuffer>((data) => {
      if (!open) return;
      const frame = decodeFrame(data);
      if (frame) onFrame(frame);
    });
    await invoke("collab_pipe", { channel });
    return () => {
      open = false;
    };
  },
  send: (session, kind, member, doc, payload) => {
    // 原始请求体：Uint8Array 直接当 body，不会被拆成数字数组
    invoke("collab_send", encodeFrame(kind, session, member, doc, payload)).catch((error) => {
      console.error("协作：发不出去", error);
    });
  },
  onControl: (listener) =>
    events
      .collabEvent(thisWindow())
      .listen((event) => listener(event.payload.session, event.payload.control)),
  pendingLink: () => unwrap(commands.collabPendingLink()),
  onLink: (listener) => events.collabLink(thisWindow()).listen((event) => listener(event.payload)),
  copyToVault: async (copy) => {
    await unwrap(commands.collabCopyToVault(copy));
  },
  takeCopy: () => unwrap(commands.collabTakeCopy()),
  onCopyReady: (listener) => events.collabCopyReady(thisWindow()).listen(() => listener()),
};

let resolved: CollabNet | null = null;

export async function collabNet(): Promise<CollabNet> {
  if (resolved) return resolved;
  resolved = isTauri ? tauriNet : (await import("./mockNet")).createMockNet();
  return resolved;
}

/** 测试：换一个网络层 */
export function setCollabNet(net: CollabNet | null): void {
  resolved = net;
}
