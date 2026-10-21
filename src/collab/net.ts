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
     帧 = 1 字节类型 + 2 字节成员号（小端）+ 内容

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
  member: number;
  payload: Uint8Array;
}

/** 访客向主持人要来的一个附件 */
export interface FetchedAttachment {
  /** <img> 能用的地址 */
  url: string;
  /** 本机缓存的那个文件，文件名是正文里写的那个（「存一份到我的笔记」按它存）；浏览器预览里没有 */
  file: string | null;
}

export interface CollabNet {
  identity(): Promise<CollabIdentity>;
  setName(name: string): Promise<void>;
  /**
   * 开始协作：起端点（要两三秒，iroh 初始化网络监视），返回邀请链接。note 是主持的那篇的 id；
   * resume = 继续上次没正常结束的那一次（同一个会话 id、邀请密钥、端口，允许过的人不再问）
   */
  host(
    title: string,
    permission: Permission,
    note: string,
    resume: boolean,
  ): Promise<CollabHosting>;
  resetInvite(): Promise<string>;
  /** 链接认不认得出、带没带中继：认不出是一句话 */
  checkLink(link: string): Promise<{ relay: string | null } | string>;
  /** 加入：马上返回，进展从 onControl 的 status 里出来。directOnly：不经主持人的中继 */
  join(link: string, directOnly: boolean): Promise<void>;
  /** 访客连不上时：生成回连链接（要等端口映射、中继，最多五秒） */
  callback(): Promise<CollabCallback>;
  /** 访客：转发链接（设计 §20.9）。和回连链接一样要先看能不能被连进来 */
  forwardLink(): Promise<CollabCallback>;
  /** 主持人打开了回连链接：往访客那边拨，结果从 onControl 的 dialBack 里出来 */
  dialBack(link: string): Promise<void>;
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
  joinNearby(id: string): Promise<void>;
  /* 落盘（设计 §3） */
  /** 文档的状态交给 Rust 存（不等回话） */
  saveState(state: Uint8Array): void;
  /** 上次没正常结束的协作 */
  resumeInfo(): Promise<CollabResume>;
  /** 落盘的文档状态 */
  resumeState(host: boolean): Promise<Uint8Array>;
  /** 访客：继续上次的做客（会话已经用落盘的状态建好了） */
  rejoin(): Promise<void>;
  discardResume(host: boolean): Promise<void>;
  /* 附件（设计 §7.2） */
  /** 主持人：这篇正文里引用的附件（只有这些访客要得到） */
  setAttachmentRefs(refs: AttachmentRef[]): Promise<void>;
  /** 访客：向主持人要一个，缓存在本机 */
  fetchAttachment(path: string): Promise<FetchedAttachment>;
  /** 访客：粘贴的文件交给主持人存，返回从那篇引用它的路径 */
  putAttachment(name: string, dataBase64: string): Promise<Attachment>;
  putAttachmentPath(path: string): Promise<Attachment>;
  answer(request: number, allow: Permission | null): Promise<boolean>;
  setPermission(member: number, permission: Permission): Promise<void>;
  kick(member: number): Promise<void>;
  /* 记住的人（设计 §8.2）：下次拿着链接或者从「附近」进来不问。都返回改完的整张表 */
  trusted(): Promise<TrustedPeer[]>;
  remember(id: string, name: string, permission: Permission): Promise<TrustedPeer[]>;
  forget(id: string): Promise<TrustedPeer[]>;
  setTitle(title: string): Promise<void>;
  /** 停止协作（主持人）/ 离开（访客） */
  stop(): Promise<void>;
  /** 开始收字节。返回的函数是停 */
  openPipe(onFrame: (frame: Frame) => void): Promise<() => void>;
  send(kind: number, member: number, payload: Uint8Array): void;
  onControl(listener: (control: Control) => void): Promise<() => void>;
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

export function encodeFrame(kind: number, member: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.length + 3);
  frame[0] = kind;
  frame[1] = member & 0xff;
  frame[2] = (member >> 8) & 0xff;
  frame.set(payload, 3);
  return frame;
}

export function decodeFrame(data: ArrayBuffer | Uint8Array | number[]): Frame | null {
  const bytes =
    data instanceof Uint8Array
      ? data
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : Uint8Array.from(data);
  if (bytes.length < 3) return null;
  return { kind: bytes[0]!, member: bytes[1]! | (bytes[2]! << 8), payload: bytes.subarray(3) };
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
  host: (title, permission, note, resume) =>
    unwrap(commands.collabHost(title, permission, note, resume)),
  resetInvite: () => unwrap(commands.collabResetInvite()),
  checkLink: async (link) => {
    const result = await commands.collabCheckLink(link);
    return result.status === "ok" ? result.data : errorText(result.error);
  },
  join: async (link, directOnly) => {
    await unwrap(commands.collabJoin(link, directOnly));
  },
  callback: () => unwrap(commands.collabCallback()),
  forwardLink: () => unwrap(commands.collabForwardLink()),
  dialBack: async (link) => {
    await unwrap(commands.collabDialBack(link));
  },
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
  joinNearby: async (id) => {
    await unwrap(commands.collabJoinNearby(id));
  },
  saveState: (state) => tauriNet.send(PIPE.save, 0, state),
  resumeInfo: () => unwrap(commands.collabResumeInfo()),
  resumeState: async (host) => {
    // 原始字节（不经 tauri-specta）
    const data = await invoke<ArrayBuffer>("collab_resume_state", { host });
    return new Uint8Array(data);
  },
  rejoin: async () => {
    await unwrap(commands.collabRejoin());
  },
  discardResume: async (host) => {
    await unwrap(commands.collabDiscardResume(host));
  },
  setAttachmentRefs: async (refs) => {
    await unwrap(commands.collabSetAttachmentRefs(refs));
  },
  fetchAttachment: async (path) => {
    const file = await unwrap(commands.collabFetchAttachment(path));
    return { url: convertFileSrc(file), file };
  },
  putAttachment: (name, dataBase64) => unwrap(commands.collabPutAttachment(name, dataBase64)),
  putAttachmentPath: (path) => unwrap(commands.collabPutAttachmentPath(path)),
  answer: (request, allow) => unwrap(commands.collabAnswer(request, allow)),
  setPermission: async (member, permission) => {
    await unwrap(commands.collabSetPermission(member, permission));
  },
  kick: async (member) => {
    await unwrap(commands.collabKick(member));
  },
  trusted: () => unwrap(commands.collabTrusted()),
  remember: (id, name, permission) => unwrap(commands.collabRemember(id, name, permission)),
  forget: (id) => unwrap(commands.collabForget(id)),
  setTitle: async (title) => {
    await unwrap(commands.collabSetTitle(title));
  },
  stop: async () => {
    await unwrap(commands.collabStop());
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
  send: (kind, member, payload) => {
    // 原始请求体：Uint8Array 直接当 body，不会被拆成数字数组
    invoke("collab_send", encodeFrame(kind, member, payload)).catch((error) => {
      console.error("协作：发不出去", error);
    });
  },
  onControl: (listener) =>
    events.collabEvent(thisWindow()).listen((event) => listener(event.payload)),
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
