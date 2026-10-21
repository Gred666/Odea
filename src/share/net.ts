import type {
  AppError,
  Result as IpcResult,
  Role,
  ShareInfo,
  SharePreview,
  ShareVersion,
} from "@/lib/bindings";
import { events, commands } from "@/lib/bindings";
import { isTauri, thisWindow } from "@/lib/tauri";
import { Channel, invoke } from "@tauri-apps/api/core";

/* ============================================================
   共享仓库：前端和 Rust 之间（docs/协同编辑.md §20）。

   - 控制：共享、邀请链接、回答加入请求、改角色、历史版本……走 tauri-specta 的命令；
     成员、连接、加入请求、状态变了是 ShareChanged 事件（没有内容），收到就重新取 ShareInfo
   - 数据：打开的那一篇的 Loro 增量、光标是不透明的字节，和协作一样不走 JSON：
     前端 → Rust 是原始请求体（share_send），Rust → 前端是二进制 Channel（share_pipe），
     打开一篇时的快照也是原始字节（share_doc_open：8 字节 peer + 快照）。
     帧 = 1 字节类型 + 1 字节文档 id 长度 + 文档 id + 内容；光标帧的内容前面还有 64 字节对方的公钥

   浏览器预览里没有 Rust：换成 mockShare.ts（一个只在内存里的共享仓库，过一会儿有人来敲门），
   界面在浏览器里也能走通。
   ============================================================ */

/** 帧类型（和 commands.rs 的 SHARE_PIPE_* 一致） */
export const SHARE_PIPE = { update: 1, cursor: 2 } as const;

export interface ShareFrame {
  kind: number;
  doc: string;
  /** 光标帧：谁的（设备公钥） */
  from: string | null;
  payload: Uint8Array;
}

export interface ShareNet {
  info(): Promise<ShareInfo | null>;
  create(): Promise<ShareInfo>;
  inviteLink(): Promise<string>;
  resetInvite(role: Role): Promise<string>;
  answer(request: number, role: Role | null): Promise<boolean>;
  setRole(member: string, role: Role | null): Promise<void>;
  checkLink(link: string): Promise<SharePreview>;
  /** 选文件夹、新建、在新窗口里打开。取消了是 null */
  join(link: string): Promise<string | null>;
  leave(): Promise<void>;
  history(doc: string): Promise<ShareVersion[]>;
  versionText(doc: string, version: string): Promise<string>;
  restore(doc: string, version: string): Promise<void>;
  /** 打开一篇：给前端用的 peer（十进制字符串）和快照 */
  openDoc(doc: string): Promise<{ peer: string; snapshot: Uint8Array }>;
  closeDoc(doc: string): Promise<void>;
  openPipe(onFrame: (frame: ShareFrame) => void): Promise<() => void>;
  send(kind: number, doc: string, payload: Uint8Array): void;
  onChanged(listener: () => void): Promise<() => void>;
}

export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}

async function unwrap<T>(result: Promise<IpcResult<T, AppError>>): Promise<T> {
  const value = await result;
  if (value.status === "error") throw value.error;
  return value.data;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeShareFrame(kind: number, doc: string, payload: Uint8Array): Uint8Array {
  const id = encoder.encode(doc);
  const frame = new Uint8Array(2 + id.length + payload.length);
  frame[0] = kind;
  frame[1] = id.length;
  frame.set(id, 2);
  frame.set(payload, 2 + id.length);
  return frame;
}

export function decodeShareFrame(data: ArrayBuffer | Uint8Array): ShareFrame | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 2) return null;
  const kind = bytes[0]!;
  const length = bytes[1]!;
  if (bytes.length < 2 + length) return null;
  const doc = decoder.decode(bytes.subarray(2, 2 + length));
  let rest = bytes.subarray(2 + length);
  let from: string | null = null;
  if (kind === SHARE_PIPE.cursor) {
    if (rest.length < 64) return null;
    from = decoder.decode(rest.subarray(0, 64));
    rest = rest.subarray(64);
  }
  return { kind, doc, from, payload: rest.slice() };
}

/** 8 字节小端 → 十进制字符串（u64 在 JS 的 number 里装不下） */
export function peerOf(bytes: Uint8Array): string {
  let value = 0n;
  for (let index = 7; index >= 0; index--) value = (value << 8n) | BigInt(bytes[index]!);
  return value.toString();
}

const tauriShare: ShareNet = {
  info: () => unwrap(commands.shareInfo()),
  create: () => unwrap(commands.shareCreate()),
  inviteLink: () => unwrap(commands.shareInviteLink()),
  resetInvite: (role) => unwrap(commands.shareResetInvite(role)),
  answer: (request, role) => unwrap(commands.shareAnswer(request, role)),
  setRole: async (member, role) => {
    await unwrap(commands.shareSetRole(member, role));
  },
  checkLink: (link) => unwrap(commands.shareCheckLink(link)),
  join: (link) => unwrap(commands.shareJoin(link)),
  leave: async () => {
    await unwrap(commands.shareLeave());
  },
  history: (doc) => unwrap(commands.shareHistory(doc)),
  versionText: (doc, version) => unwrap(commands.shareVersionText(doc, version)),
  restore: async (doc, version) => {
    await unwrap(commands.shareRestore(doc, version));
  },
  openDoc: async (doc) => {
    const data = new Uint8Array(await invoke<ArrayBuffer>("share_doc_open", { doc }));
    return { peer: peerOf(data.subarray(0, 8)), snapshot: data.slice(8) };
  },
  closeDoc: async (doc) => {
    await unwrap(commands.shareDocClose(doc));
  },
  openPipe: async (onFrame) => {
    let open = true;
    const channel = new Channel<ArrayBuffer>((data) => {
      if (!open) return;
      const frame = decodeShareFrame(data);
      if (frame) onFrame(frame);
    });
    await invoke("share_pipe", { channel });
    return () => {
      open = false;
    };
  },
  send: (kind, doc, payload) => {
    // 原始请求体：Uint8Array 直接当 body，不会被拆成数字数组
    invoke("share_send", encodeShareFrame(kind, doc, payload)).catch((error) => {
      console.error("共享仓库：发不出去", error);
    });
  },
  onChanged: (listener) => events.shareChanged(thisWindow()).listen(() => listener()),
};

let resolved: ShareNet | null = null;

export async function shareNet(): Promise<ShareNet> {
  if (resolved) return resolved;
  resolved = isTauri ? tauriShare : (await import("./mockShare")).createMockShare();
  return resolved;
}

/** 测试：换一个网络层 */
export function setShareNet(net: ShareNet | null): void {
  resolved = net;
}
