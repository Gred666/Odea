import { type Frame, decodeFrame, encodeFrame, errorText } from "@/collab/net";
import type { DocumentSaveTarget } from "@/data/types";
import type {
  AppError,
  Result as IpcResult,
  PresenceDoc,
  SyncStatus,
  TeamControl,
  TeamSelf,
} from "@/lib/bindings";
import { events, commands } from "@/lib/bindings";
import { thisWindow } from "@/lib/tauri";
import { Channel, invoke } from "@tauri-apps/api/core";

/* ============================================================
   团队仓库里成员之间（docs/协同编辑.md §22.4）：前端和团队端点之间。

   端点在 Rust（src-tauri/src/team）：网状连接、名单认人、Presence、每篇一条文档流、星形转发。
   这里只有命令、事件和字节；字节的帧和协作一样（collab/net.ts 的 PIPE），成员号是那台设备在
   团队里的编号 —— 会话、链路（collab/link.ts）一行不用改。
   谁当主持人、什么时候开哪一篇在 controller.ts
   ============================================================ */

export interface TeamNet {
  /** 起端点、登记这个团队仓库。不是团队仓库是 null */
  start(): Promise<TeamSelf | null>;
  /** 我开着哪几篇、主持着哪几篇 */
  presence(docs: PresenceDoc[]): Promise<void>;
  /** 开始 / 不再主持一篇（不再主持时访客那边是 docClosed） */
  host(doc: string, on: boolean): Promise<void>;
  /** 连这一篇的主持人：连上了从管道上来 syncVector，不给、断了是 docClosed */
  open(doc: string, member: number): Promise<void>;
  close(doc: string): Promise<void>;
  /** 这一篇在 git 里最近一次提交的正文（加入时算本机没提交的改动用） */
  base(target: DocumentSaveTarget): Promise<string | null>;
  /** git 同步一轮，等它做完（最多 wait 毫秒）。没开同步的马上回来 */
  syncNow(wait: number): Promise<void>;
  send(kind: number, member: number, doc: string, payload: Uint8Array): void;
  openPipe(onFrame: (frame: Frame) => void): Promise<() => void>;
  onControl(listener: (control: TeamControl) => void): Promise<() => void>;
}

async function unwrap<T>(request: Promise<IpcResult<T, AppError>>): Promise<T> {
  const result = await request;
  if (result.status === "error") throw new Error(errorText(result.error));
  return result.data;
}

/** 等同步状态从「同步中」回到别的（做完了、连不上、出错都算完） */
async function syncRound(wait: number): Promise<void> {
  let stop: (() => void) | null = null;
  const done = new Promise<void>((resolve) => {
    let started = false;
    void events
      .syncStatusChanged(thisWindow())
      .listen((event) => {
        const state = (event.payload as SyncStatus).state;
        if (state === "syncing") started = true;
        else if (started) resolve();
      })
      .then((unlisten) => {
        stop = unlisten;
      });
  });
  const kicked = await unwrap(commands.syncNow()).catch(() => false);
  if (kicked) await Promise.race([done, new Promise((resolve) => setTimeout(resolve, wait))]);
  (stop as (() => void) | null)?.();
}

export const tauriTeamNet: TeamNet = {
  start: () => unwrap(commands.teamStart()),
  presence: async (docs) => {
    await unwrap(commands.teamPresence(docs));
  },
  host: async (doc, on) => {
    await unwrap(commands.teamHost(doc, on));
  },
  open: async (doc, member) => {
    await unwrap(commands.teamOpen(doc, member));
  },
  close: async (doc) => {
    await unwrap(commands.teamClose(doc));
  },
  base: (target) => unwrap(commands.teamBase(target)),
  syncNow: syncRound,
  send: (kind, member, doc, payload) => {
    invoke("team_send", encodeFrame(kind, member, doc, payload)).catch((error) => {
      console.error("团队：发不出去", error);
    });
  },
  openPipe: async (onFrame) => {
    let open = true;
    const channel = new Channel<ArrayBuffer>((data) => {
      if (!open) return;
      const frame = decodeFrame(data);
      if (frame) onFrame(frame);
    });
    await invoke("team_pipe", { channel });
    return () => {
      open = false;
    };
  },
  onControl: (listener) =>
    events.teamChanged(thisWindow()).listen((event) => listener(event.payload)),
};
