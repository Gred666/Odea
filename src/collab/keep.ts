import type { DocumentSaveTarget } from "@/data/types";
import { type GuestCopy, commands } from "@/lib/bindings";
import { isTauri } from "@/lib/tauri";
import { create } from "zustand";
import type { SessionLink } from "./link";
import type { CollabSession } from "./session";

/* ============================================================
   做客时本机留的一份（docs/协同编辑.md §24）。

   一篇在会话里时只有主持人写盘（§22.2 规矩 1），访客的编辑器不存。访客打的字在主持人收下之前只在内存里，
   断线、切走、关窗口、崩溃都可能丢掉最后一份。所以：

   - 主持人每次存盘以后，把那一刻的版本向量发给访客（复用 Sync1 帧，不改协议；访客照常回一个 Sync2，
     一般是空的）。访客收到上游的版本向量、它盖住了这边有的全部改动 = 这边的字主持人都存下了
   - 没盖住（这边有主持人还没存的字）：整篇正文存一份到应用数据目录（Rust 的 keep.rs，不在仓库里、不进 git），
     防抖着写；盖住了就删掉
   - 会话结束时还没盖住：那一份留着，回收站对话框里列出来（存成一篇笔记，或者丢掉）。团队仓库里的那篇，
     等 git 拉来主持人存的那一版、和留的这份一样了，对话框打开时自己删掉

   状态栏据此分两种说法：「本机已保留」（有主持人还没存的字，这台电脑上留着一份）和「已同步给主持人」。

   这个文件不引 Loro（会话的方法都在 session.ts 里）：回收站对话框在主包里，只要列出来、删掉
   ============================================================ */

export type { GuestCopy };

/** 做客的一篇现在怎样：kept = 有主持人还没存的字，本机留着一份；synced = 主持人都存下了 */
export type GuestCopyState = "kept" | "synced";

/** 每份会话现在怎样（状态栏按编辑器绑着的那份会话取） */
export const useGuestCopies = create<{ states: ReadonlyMap<CollabSession, GuestCopyState> }>(
  () => ({ states: new Map() }),
);

function setState(session: CollabSession, state: GuestCopyState | null) {
  const states = useGuestCopies.getState().states;
  if ((states.get(session) ?? null) === state) return;
  const next = new Map(states);
  if (state) next.set(session, state);
  else next.delete(session);
  useGuestCopies.setState({ states: next });
}

/* ---------------- 存取：桌面端在应用数据目录，浏览器预览在 localStorage ---------------- */

const MOCK_KEY = "odea.mock.guestCopies";

async function unwrap<T>(
  request: Promise<{ status: "ok"; data: T } | { status: "error"; error: unknown }>,
): Promise<T> {
  const result = await request;
  if (result.status === "error") throw result.error;
  return result.data;
}

function mockCopies(): GuestCopy[] {
  try {
    return JSON.parse(localStorage.getItem(MOCK_KEY) ?? "[]") as GuestCopy[];
  } catch {
    return [];
  }
}

function saveMockCopies(copies: GuestCopy[]) {
  try {
    localStorage.setItem(MOCK_KEY, JSON.stringify(copies));
  } catch {
    /* 存不下就只在这一次里 */
  }
}

/** 留着的几份，最近写的在前 */
export async function listGuestCopies(): Promise<GuestCopy[]> {
  if (isTauri) return unwrap(commands.guestCopyList());
  return mockCopies().sort((a, b) => b.savedAt - a.savedAt);
}

export async function dropGuestCopy(key: string): Promise<void> {
  if (isTauri) {
    await unwrap(commands.guestCopyDrop(key));
    return;
  }
  saveMockCopies(mockCopies().filter((copy) => copy.key !== key));
}

async function putGuestCopy(copy: GuestCopy): Promise<void> {
  if (isTauri) {
    await unwrap(commands.guestCopyPut(copy));
    return;
  }
  saveMockCopies([...mockCopies().filter((other) => other.key !== copy.key), copy]);
}

/* ---------------- 守着一份做客的会话 ---------------- */

export interface KeepOptions {
  /** 哪一篇（团队：仓库 + 团队文档 id；邀请做客：主持人 + 文档 id） */
  key: string;
  /** 给人看的，写的时候才取（标题可能后来才知道） */
  title: () => string;
  host: () => string;
  /** 团队仓库里的一篇：仓库路径和是哪一篇。邀请做客的是 null */
  vault: string | null;
  target: DocumentSaveTarget | null;
  /** 有没盖住的字以后多久写一次（节流）。测试里改小 */
  delay?: number;
}

export interface KeepGuard {
  /** 做客：上游（主持人，或者替我转的那位）的成员号。只认他发来的版本向量 */
  guest(upstream: number): void;
  /** 自己写盘了（接手当了主持人、回到一个人编辑）：这边的字在自己磁盘上，留的那份删掉，不再管 */
  owner(): void;
  /** 会话收掉了：没盖住的话把最后的样子写下来、留着；盖住了就删掉 */
  stop(): void;
}

/** 写一次的节流 */
const KEEP_DELAY = 800;

export function keepGuestCopy(link: SessionLink, options: KeepOptions): KeepGuard {
  const session = link.session;
  /** 各成员最近发来的版本向量：做客之前（握手时）就可能到了 */
  const vectors = new Map<number, Uint8Array>();
  let upstream: number | null = null;
  let written = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const covered = () => {
    const vector = upstream === null ? undefined : vectors.get(upstream);
    return !!vector && session.coveredBy(vector);
  };

  const write = async () => {
    timer = null;
    if (stopped || upstream === null || covered()) return;
    try {
      await putGuestCopy({
        key: options.key,
        title: options.title(),
        vault: options.vault,
        target: options.target,
        host: options.host(),
        text: session.toString(),
        savedAt: Date.now(),
      });
      written = true;
      if (!stopped && upstream !== null && !covered()) setState(session, "kept");
    } catch (error) {
      console.error("协作：本机留一份没写进去", error);
    }
  };

  const drop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!written) return;
    written = false;
    void dropGuestCopy(options.key).catch(() => {});
  };

  const check = () => {
    if (stopped || upstream === null) return;
    if (covered()) {
      drop();
      setState(session, "synced");
      return;
    }
    timer ??= setTimeout(() => void write(), options.delay ?? KEEP_DELAY);
  };

  const stopVectors = link.onVector((member, vector) => {
    vectors.set(member, vector);
    if (member === upstream) check();
  });
  const stopChanges = session.onChange(check);

  return {
    guest(member) {
      if (stopped) return;
      upstream = member;
      check();
    },
    owner() {
      upstream = null;
      drop();
      setState(session, null);
    },
    stop() {
      if (stopped) return;
      const unsaved = upstream !== null && !covered();
      if (unsaved) {
        // 最后几下可能还在节流里：现在就写
        if (timer) clearTimeout(timer);
        timer = null;
        void write();
      } else {
        drop();
      }
      stopped = true;
      stopVectors();
      stopChanges();
      setState(session, null);
    },
  };
}
