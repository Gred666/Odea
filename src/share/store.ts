import { peerColor } from "@/collab/colors";
import type { CollabSession, Peer } from "@/collab/session";
import { setBodyOwner } from "@/data/store";
import type { DocumentSaveTarget } from "@/data/types";
import type { Role, ShareInfo, SharePreview } from "@/lib/bindings";
import { create } from "zustand";
import { SHARE_PIPE, type ShareFrame, type ShareNet, errorText, shareNet } from "./net";

/* ============================================================
   共享仓库（docs/协同编辑.md §20）在前端这边。

   - info：这个仓库的共享状态（不是共享仓库是 null）。ShareChanged 事件来了就重新取
   - 对话框：共享这个仓库、邀请链接、加入请求、成员和角色、不再共享
   - 加入：粘贴 / 点开 odea://share/ 链接 → 看一眼是哪个仓库 → 选放在哪 → 新窗口里打开
   - 编辑器挂着的那一篇（current）：打开时向 Rust 要快照建一个 Loro 副本（和会话式协作同一个
     CollabSession，网络换成 Rust 那份），编辑器绑上它；切走就扔。正文由 Rust 写盘，
     这一篇的自动保存不再写正文（data/store 的 setBodyOwner）
   CollabSession 连着 loro 的 wasm：打开第一篇共享的笔记时才加载。
   ============================================================ */

export interface ShareJoin {
  open: boolean;
  link: string;
  preview: SharePreview | null;
  error: string | null;
  busy: boolean;
}

export interface ShareStore {
  info: ShareInfo | null;
  dialogOpen: boolean;
  inviteLink: string | null;
  busy: boolean;
  error: string | null;
  join: ShareJoin;
  /** 编辑器挂着的那一篇（共享里的文档 id）和它的 Loro 副本（还在打开时是 null） */
  current: { doc: string; session: CollabSession | null } | null;

  refresh(): Promise<void>;
  openDialog(): void;
  closeDialog(): void;
  create(): Promise<void>;
  loadInvite(): Promise<void>;
  resetInvite(role: Role): Promise<void>;
  answer(request: number, role: Role | null): Promise<void>;
  setRole(member: string, role: Role | null): Promise<void>;
  leave(): Promise<void>;
  openJoin(link?: string): void;
  closeJoin(): void;
  setJoinLink(link: string): void;
  joinNow(): Promise<void>;
  /** 编辑器要显示这一篇（共享里的 id；null 是没有要绑的） */
  focus(doc: string | null): void;
}

const closedJoin: ShareJoin = { open: false, link: "", preview: null, error: null, busy: false };

let net: ShareNet | null = null;

async function ensureNet(): Promise<ShareNet> {
  net ??= await shareNet();
  return net;
}

/** 编辑器的目标 → 共享里的文档 id（和 Rust 的 vault/shared.rs 一样） */
export function shareDocId(target: DocumentSaveTarget): string {
  switch (target.kind) {
    case "note":
      return target.id;
    case "day":
      return `day-${target.id}`;
    case "goal":
      return `goal-${target.horizon}-${target.periodStart}`;
  }
}

export function isShareLink(text: string): boolean {
  return /^\s*<?["']?odea:(\/\/)?share\//i.test(text);
}

/** 共享仓库已经加入了、能编辑（还在加入中、被移出了都不算） */
export function shareReady(info: ShareInfo | null): boolean {
  return info?.state.state === "ready";
}

/** 打开一篇时，Rust 那边的增量可能比快照先到：先攒着 */
const early = new Map<string, Uint8Array[]>();
/** 每次换一篇加一：晚到的打开结果认得出是过时的 */
let opening = 0;

function peerOf(id: string, info: ShareInfo | null): Peer {
  const name = info?.members.find((member) => member.id === id)?.name ?? "成员";
  return { id, name, color: peerColor(id) };
}

function onFrame(frame: ShareFrame) {
  const { current, info } = useShare.getState();
  if (current?.doc !== frame.doc) return;
  if (frame.kind === SHARE_PIPE.update) {
    if (current.session) current.session.receiveUpdate(frame.payload);
    else early.set(frame.doc, [...(early.get(frame.doc) ?? []), frame.payload]);
    return;
  }
  if (frame.kind === SHARE_PIPE.cursor && frame.from && current.session) {
    current.session.receiveCursor(peerOf(frame.from, info), frame.payload);
  }
}

export const useShare = create<ShareStore>((set, get) => ({
  info: null,
  dialogOpen: false,
  inviteLink: null,
  busy: false,
  error: null,
  join: closedJoin,
  current: null,

  refresh: async () => {
    const info = await (await ensureNet()).info().catch(() => null);
    const before = get().info;
    set({ info });
    // 加入中（等对方同意）、被拒、被移出：窗口里本来什么都没有，对话框自己弹出来说清楚
    if (info && !shareReady(info) && info.state.state !== before?.state.state) {
      set({ dialogOpen: true });
    }
    // 不再是共享仓库、还没加入好、被移出了：编辑器上的副本摘掉
    if (!shareReady(info) && get().current) get().focus(null);
    // 身份变了（只读 ↔ 可编辑不用换副本；刚加入好要重新挂）
    if (shareReady(info) && !shareReady(before)) {
      const doc = get().current?.doc ?? null;
      set({ current: null });
      get().focus(doc);
    }
  },
  openDialog: () => {
    set({ dialogOpen: true, error: null });
    void get().refresh();
    if (get().info?.canInvite) void get().loadInvite();
  },
  closeDialog: () => set({ dialogOpen: false, error: null }),

  create: async () => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      const info = await (await ensureNet()).create();
      set({ info });
      await get().loadInvite();
    } catch (error) {
      set({ error: errorText(error) });
    } finally {
      set({ busy: false });
    }
  },
  loadInvite: async () => {
    try {
      set({ inviteLink: await (await ensureNet()).inviteLink() });
    } catch {
      set({ inviteLink: null });
    }
  },
  resetInvite: async (role) => {
    try {
      set({ inviteLink: await (await ensureNet()).resetInvite(role), error: null });
    } catch (error) {
      set({ error: errorText(error) });
    }
  },
  answer: async (request, role) => {
    try {
      await (await ensureNet()).answer(request, role);
      await get().refresh();
    } catch (error) {
      set({ error: errorText(error) });
    }
  },
  setRole: async (member, role) => {
    try {
      await (await ensureNet()).setRole(member, role);
      await get().refresh();
    } catch (error) {
      set({ error: errorText(error) });
    }
  },
  leave: async () => {
    get().focus(null);
    try {
      await (await ensureNet()).leave();
      set({ info: null, inviteLink: null, dialogOpen: false });
    } catch (error) {
      set({ error: errorText(error) });
    }
  },

  openJoin: (link) => {
    set({ join: { ...closedJoin, open: true } });
    if (link) get().setJoinLink(link);
  },
  closeJoin: () => set({ join: closedJoin }),
  setJoinLink: (link) => {
    set((state) => ({ join: { ...state.join, link, preview: null, error: null } }));
    if (!link.trim()) return;
    if (!isShareLink(link)) {
      set((state) => ({
        join: { ...state.join, error: "这不是共享仓库的链接（odea://share/…）" },
      }));
      return;
    }
    void ensureNet()
      .then((current) => current.checkLink(link.trim()))
      .then((preview) => {
        if (get().join.link === link) set((state) => ({ join: { ...state.join, preview } }));
      })
      .catch((error) => {
        if (get().join.link === link)
          set((state) => ({ join: { ...state.join, error: errorText(error) } }));
      });
  },
  joinNow: async () => {
    const { link, busy } = get().join;
    if (busy || !link.trim()) return;
    set((state) => ({ join: { ...state.join, busy: true, error: null } }));
    try {
      const window = await (await ensureNet()).join(link.trim());
      // 取消了选文件夹：对话框留着
      if (window) set({ join: closedJoin });
      else set((state) => ({ join: { ...state.join, busy: false } }));
    } catch (error) {
      set((state) => ({ join: { ...state.join, busy: false, error: errorText(error) } }));
    }
  },

  focus: (doc) => {
    const current = get().current;
    if (current?.doc === doc) return;
    if (current) {
      current.session?.destroy();
      early.delete(current.doc);
      void ensureNet().then((net) => net.closeDoc(current.doc));
    }
    const ticket = ++opening;
    if (!doc || !shareReady(get().info)) {
      set({ current: null });
      return;
    }
    set({ current: { doc, session: null } });
    void (async () => {
      const [{ CollabSession }, { ensureLoro }, net] = await Promise.all([
        import("@/collab/session"),
        import("@/collab/loro"),
        ensureNet(),
      ]);
      await ensureLoro();
      const { peer, snapshot } = await net.openDoc(doc);
      if (ticket !== opening) {
        void net.closeDoc(doc);
        return;
      }
      const info = get().info;
      const me = info?.me ?? "me";
      const session = new CollabSession({
        self: { id: me, name: peerOf(me, info).name, color: peerColor(me) },
        transport: {
          sendUpdate: (update) => net.send(SHARE_PIPE.update, doc, update),
          sendCursor: (payload) => net.send(SHARE_PIPE.cursor, doc, payload),
        },
        initialState: snapshot,
      });
      // Rust 给的 peer（记在仓库文档的 peers 表里，历史版本按它认人）；改动带时间、
      // 连续的并成一个（和 Rust 那份一样，share/replica.rs 的 MERGE_INTERVAL）
      session.doc.setPeerId(peer as `${number}`);
      session.doc.setRecordTimestamp(true);
      session.doc.setChangeMergeInterval(60);
      for (const update of early.get(doc) ?? []) session.receiveUpdate(update);
      early.delete(doc);
      set({ current: { doc, session } });
    })().catch((error) => {
      if (ticket !== opening) return;
      // 共享仓库刚起来、还在对第一遍账（share/service.rs 的 NOT_READY）：过一秒再开，编辑器先是只读预览
      if (errorText(error).includes("还在准备")) {
        setTimeout(() => {
          if (ticket !== opening) return;
          set({ current: null });
          get().focus(doc);
        }, 1000);
        return;
      }
      console.error("共享仓库：打不开这一篇", error);
      set({ current: null, error: errorText(error) });
    });
  },
}));

/** 仓库窗口起来时：订阅变化、登记收字节的管道、取一次状态 */
export async function initShare(): Promise<void> {
  const current = await ensureNet();
  // 共享仓库加入好了以后：自动保存一律不写正文（Rust 写；Rust 那边也不收编辑器交来的正文）
  setBodyOwner(() => shareReady(useShare.getState().info));
  await current.openPipe(onFrame);
  await current.onChanged(() => void useShare.getState().refresh());
  await useShare.getState().refresh();
}

/** 测试：换网络层、清状态 */
export function resetShareForTest(next: ShareNet | null): void {
  useShare.getState().current?.session?.destroy();
  net = next;
  early.clear();
  opening += 1;
  useShare.setState({
    info: null,
    dialogOpen: false,
    inviteLink: null,
    busy: false,
    error: null,
    join: closedJoin,
    current: null,
  });
}
