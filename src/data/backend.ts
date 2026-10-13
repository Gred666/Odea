import { events, type Result as IpcResult, commands } from "@/lib/bindings";
import { isTauri } from "@/lib/tauri";
import type {
  AppUpgrade,
  Attachment,
  Backlink,
  CalendarMarks,
  DayDoc,
  DocHistory,
  DocumentSaveTarget,
  FolderDeletion,
  Goal,
  GoalHorizon,
  GuideName,
  GuideUpdate,
  IndexProgress,
  JournalDoc,
  LinkRewrite,
  Note,
  NoteInput,
  Relink,
  SearchResult,
  SyncAccount,
  SyncDeviceCode,
  SyncPlan,
  SyncProviderKey,
  SyncProxy,
  SyncRemoteRepo,
  SyncStatus,
  Task,
  UpdateInfo,
  VaultChange,
  VaultInfo,
} from "./types";

/* ============================================================
   后端访问层。
   ★ 视图和 store 只认这里的接口，不关心数据从哪来。

   在 Tauri 里 → 走 IPC 打 Rust：文档是仓库文件夹里的 .md 文件，SQLite 只是索引
   在浏览器里 → 走 mock（`pnpm dev` 直开 1420 端口时调 UI 用）

   Rust 侧的类型由 tauri-specta 生成到 lib/bindings.ts，
   这里的签名与之对齐；两边不一致时 tsc 会报错。
   ============================================================ */

export interface Backend {
  /** 一个列表的全部笔记（含正文），一次取回。启动时用它，免得逐篇 noteGet。 */
  noteListFull(archived: boolean): Promise<Note[]>;
  noteGet(id: string): Promise<Note>;
  noteUpsert(input: NoteInput): Promise<string>;
  noteSetPinned(id: string, pinned: boolean): Promise<void>;
  noteArchive(id: string, category?: string): Promise<void>;
  noteRestore(id: string): Promise<void>;
  noteDelete(id: string): Promise<void>;
  /** 撤销删除（删除是软删除） */
  noteUndelete(id: string): Promise<void>;
  /** 正文里写了 `[[这篇的标题]]` 的文档，最近改过的在前 */
  noteBacklinks(id: string): Promise<Backlink[]>;
  /** 笔记改了标题之后：别处的 `[[旧标题]]` 改成现在的标题 */
  noteRelink(id: string, oldTitle: string): Promise<Relink>;
  /** 撤销 noteRelink：改完之后又被改过的那篇不动。返回换回了几篇 */
  noteRelinkUndo(rewrites: LinkRewrite[]): Promise<number>;
  /** 一篇文档的历史版本（同步用的 git 仓库里每次改过它的提交），新的在前 */
  docHistory(target: DocumentSaveTarget): Promise<DocHistory>;
  /** 某一版的正文 */
  docVersionText(blob: string): Promise<string>;
  /** 在文件夹里新建一篇空笔记（folder 相对「笔记」，空串是「笔记」本身），返回新 id */
  noteCreate(folder: string, title: string): Promise<string>;
  /** 挪到另一个文件夹，返回挪完的笔记（relPath 变了，正文里的相对链接可能也改了） */
  noteMove(id: string, folder: string): Promise<Note>;
  /** 「笔记」下面所有的子文件夹 */
  folderList(): Promise<string[]>;
  /** 返回新文件夹的路径（重名时加了序号） */
  folderCreate(parent: string, name: string): Promise<string>;
  /** 返回改名后的路径（重名时加了序号） */
  folderRename(folder: string, name: string): Promise<string>;
  /** 里面的笔记进回收站；返回值原样交给 folderUndelete 就能撤销 */
  folderDelete(folder: string): Promise<FolderDeletion>;
  folderUndelete(deletion: FolderDeletion): Promise<void>;
  /** 在系统的文件管理器里打开这个文件夹 */
  folderReveal(folder: string): Promise<void>;
  searchNotes(query: string, limit: number): Promise<SearchResult>;
  taskToggle(id: string): Promise<Task>;
  /** 某个周期的目标；没写过的周期返回空文档（id 为空） */
  goalGet(horizon: GoalHorizon, periodStart: string): Promise<Goal>;
  goalSave(horizon: GoalHorizon, periodStart: string, contentMd: string): Promise<Goal>;
  /** carryOver 只在请求「今天」时传 true：今天还没写过就延续之前最近的一天 */
  calendarDay(date: string, carryOver: boolean): Promise<DayDoc>;
  calendarDaySave(date: string, title: string, noteMd: string): Promise<DayDoc>;
  /** 月网格上的记号：写过记录 / 做过事的日子，和还有待办的日子 */
  calendarMarks(from: string, to: string): Promise<CalendarMarks>;
  /** 所有写过的某一天、某个周期的目标，连同正文（命令面板搜它们），最近改过的在前 */
  journalList(): Promise<JournalDoc[]>;
  /** 用户改过、而这个版本带着新版的使用指南（在那一篇上问换不换） */
  guidePending(): Promise<GuideUpdate[]>;
  /** 用户看过新版了（换上了，或者留着自己的）：到下一次升级前不再问 */
  guideSettle(id: string): Promise<void>;
  /** 命令面板「使用指南」：那一篇的 id，删掉了就照这个版本重新放一篇 */
  guideOpen(name: GuideName): Promise<string>;
  vaultInfo(): Promise<VaultInfo>;
  /** 在系统的文件管理器里定位这篇文档的文件 */
  vaultReveal(target: DocumentSaveTarget): Promise<void>;
  /** 打开整个笔记文件夹 */
  vaultOpenFolder(): Promise<void>;
  /** 把磁盘上的当前版本另存成冲突副本，返回它的标题（文件不存在时为 null） */
  vaultKeepConflictCopy(target: DocumentSaveTarget): Promise<string | null>;
  /** 弹选择文件夹对话框换仓库；取消了返回 null */
  vaultChangeRoot(): Promise<VaultInfo | null>;
  /** 粘贴进来的文件存进「附件」文件夹（内容是 base64），返回从这篇文档引用它的路径 */
  vaultAttach(target: DocumentSaveTarget, name: string, dataBase64: string): Promise<Attachment>;
  /** 拖进窗口的文件（桌面端拿到的是路径）存进「附件」文件夹 */
  vaultAttachPath(target: DocumentSaveTarget, path: string): Promise<Attachment>;
  /** 订阅仓库里别处发生的变化，返回取消订阅的函数 */
  onVaultChanged(listener: (change: VaultChange) => void): Promise<() => void>;
  /** 正在后台读文件进索引的话读到哪了，没在读是 null（先订阅 onIndexProgress 再问） */
  indexProgress(): Promise<IndexProgress | null>;
  /** 订阅后台读文件的进度；读完的那一次 done === total */
  onIndexProgress(listener: (progress: IndexProgress) => void): Promise<() => void>;
  /** 同步现在怎么样了（没开同步时 state 是 off） */
  syncStatus(): Promise<SyncStatus>;
  /** 立即同步一轮；没开同步返回 false */
  syncNow(): Promise<boolean>;
  /** 订阅同步状态的变化 */
  onSyncStatus(listener: (status: SyncStatus) => void): Promise<() => void>;
  /** 订阅同步要告诉用户的话（冲突副本、超限文件没同步、仓库快满了） */
  onSyncNotice(listener: (text: string) => void): Promise<() => void>;
  /** 登录过、钥匙串里还有令牌的同步账号 */
  syncAccounts(): Promise<SyncAccount[]>;
  /** GitHub 设备码登录：领一个码给用户看 */
  syncGithubLoginStart(): Promise<SyncDeviceCode>;
  /** 等用户在浏览器里确认（syncLoginCancel 能叫停） */
  syncGithubLoginWait(): Promise<SyncAccount>;
  syncLoginCancel(): Promise<void>;
  /** Gitee：用私人令牌登录 */
  syncGiteeLogin(token: string): Promise<SyncAccount>;
  syncLogout(provider: SyncProviderKey): Promise<void>;
  /** 这个账号自己的仓库，最近更新的在前 */
  syncRepos(provider: SyncProviderKey): Promise<SyncRemoteRepo[]>;
  /** 新建一个空的私有仓库 */
  syncCreateRepo(provider: SyncProviderKey, name: string): Promise<SyncRemoteRepo>;
  syncProxy(): Promise<SyncProxy>;
  syncSetProxy(proxy: string | null): Promise<SyncProxy>;
  /** 开启同步前看一眼云端 */
  syncInspect(provider: SyncProviderKey, cloneUrl: string): Promise<SyncPlan>;
  /** 开启同步。返回 true = clone 到了新文件夹、换了仓库（要整页重载） */
  syncEnable(provider: SyncProviderKey, cloneUrl: string, bringLocal: boolean): Promise<boolean>;
  /** 断开同步（.git 留着，账号不退出） */
  syncDisable(): Promise<SyncStatus>;
  /** 下好了、等着装的新版本；没有为 null */
  updateStatus(): Promise<UpdateInfo | null>;
  /** 现在就查一次；有新版的话下好再返回，已经是最新的返回 null */
  updateCheck(): Promise<UpdateInfo | null>;
  /**
   * 重启并更新。调之前先把编辑器里的内容存掉（store 的 installUpdate）。
   * 装上了就不会返回：Windows 上安装包接手后进程结束，macOS / Linux 换好文件后重启
   */
  updateInstall(): Promise<void>;
  /** 订阅「新版本下好了」 */
  onUpdateReady(listener: (update: UpdateInfo) => void): Promise<() => void>;
  /** 这一次启动是升级上来的话，从哪一版到哪一版（只给一次） */
  appUpgrade(): Promise<AppUpgrade | null>;
}

/* ---------------- Tauri IPC ---------------- */

async function unwrap<T>(request: Promise<IpcResult<T, unknown>>): Promise<T> {
  const result = await request;
  if (result.status === "error") throw result.error;
  return result.data;
}

const tauriBackend: Backend = {
  noteListFull: (archived) => unwrap(commands.noteListFull(archived)) as Promise<Note[]>,
  noteGet: (id) => unwrap(commands.noteGet(id)) as Promise<Note>,
  noteUpsert: (input) => unwrap(commands.noteUpsert(input)),
  noteSetPinned: async (id, pinned) => {
    await unwrap(commands.noteSetPinned(id, pinned));
  },
  noteArchive: async (id, category) => {
    await unwrap(commands.noteArchive(id, category ?? null));
  },
  noteRestore: async (id) => {
    await unwrap(commands.noteRestore(id));
  },
  noteDelete: async (id) => {
    await unwrap(commands.noteDelete(id));
  },
  noteUndelete: async (id) => {
    await unwrap(commands.noteUndelete(id));
  },
  noteBacklinks: (id) => unwrap(commands.noteBacklinks(id)) as Promise<Backlink[]>,
  noteRelink: (id, oldTitle) => unwrap(commands.noteRelink(id, oldTitle)),
  noteRelinkUndo: (rewrites) => unwrap(commands.noteRelinkUndo(rewrites)),
  docHistory: (target) => unwrap(commands.docHistory(target)),
  docVersionText: (blob) => unwrap(commands.docVersionText(blob)),
  noteCreate: (folder, title) => unwrap(commands.noteCreate(folder, title)),
  noteMove: (id, folder) => unwrap(commands.noteMove(id, folder)) as Promise<Note>,
  folderList: () => unwrap(commands.folderList()),
  folderCreate: (parent, name) => unwrap(commands.folderCreate(parent, name)),
  folderRename: (folder, name) => unwrap(commands.folderRename(folder, name)),
  folderDelete: (folder) => unwrap(commands.folderDelete(folder)),
  folderUndelete: async (deletion) => {
    await unwrap(commands.folderUndelete(deletion));
  },
  folderReveal: async (folder) => {
    await unwrap(commands.folderReveal(folder));
  },
  searchNotes: (query, limit) =>
    unwrap(commands.searchNotes(query, limit)) as Promise<SearchResult>,
  taskToggle: (id) => unwrap(commands.taskToggle(id)) as Promise<Task>,
  goalGet: (horizon, periodStart) =>
    unwrap(commands.goalGet(horizon, periodStart)) as Promise<Goal>,
  goalSave: (horizon, periodStart, contentMd) =>
    unwrap(commands.goalSave(horizon, periodStart, contentMd)) as Promise<Goal>,
  calendarDay: (date, carryOver) =>
    unwrap(commands.calendarDay(date, carryOver)) as Promise<DayDoc>,
  calendarDaySave: (date, title, noteMd) =>
    unwrap(commands.calendarDaySave(date, title, noteMd)) as Promise<DayDoc>,
  calendarMarks: async (from, to) => {
    const marks = await unwrap(commands.calendarMarks(from, to));
    return { written: new Set(marks.written), open: new Set(marks.open) };
  },
  journalList: () => unwrap(commands.journalList()) as Promise<JournalDoc[]>,
  guidePending: () => unwrap(commands.guidePending()),
  guideSettle: async (id) => {
    await unwrap(commands.guideSettle(id));
  },
  guideOpen: (name) => unwrap(commands.guideOpen(name)),
  vaultInfo: () => unwrap(commands.vaultInfo()),
  vaultReveal: async (target) => {
    await unwrap(commands.vaultReveal(target));
  },
  vaultOpenFolder: async () => {
    await unwrap(commands.vaultOpenFolder());
  },
  vaultKeepConflictCopy: (target) => unwrap(commands.vaultKeepConflictCopy(target)),
  vaultChangeRoot: () => unwrap(commands.vaultChangeRoot()),
  vaultAttach: (target, name, dataBase64) => unwrap(commands.vaultAttach(target, name, dataBase64)),
  vaultAttachPath: (target, path) => unwrap(commands.vaultAttachPath(target, path)),
  onVaultChanged: (listener) =>
    events.vaultChanged.listen((event) => listener(event.payload as VaultChange)),
  indexProgress: () => unwrap(commands.indexProgress()),
  onIndexProgress: (listener) => events.indexProgress.listen((event) => listener(event.payload)),
  syncStatus: () => unwrap(commands.syncStatus()) as Promise<SyncStatus>,
  syncNow: () => unwrap(commands.syncNow()),
  onSyncStatus: (listener) =>
    events.syncStatusChanged.listen((event) => listener(event.payload as SyncStatus)),
  onSyncNotice: (listener) => events.syncNotice.listen((event) => listener(event.payload)),
  syncAccounts: () => unwrap(commands.syncAccounts()) as Promise<SyncAccount[]>,
  syncGithubLoginStart: () => unwrap(commands.syncGithubLoginStart()),
  syncGithubLoginWait: () => unwrap(commands.syncGithubLoginWait()) as Promise<SyncAccount>,
  syncLoginCancel: async () => {
    await unwrap(commands.syncLoginCancel());
  },
  syncGiteeLogin: (token) => unwrap(commands.syncGiteeLogin(token)) as Promise<SyncAccount>,
  syncLogout: async (provider) => {
    await unwrap(commands.syncLogout(provider));
  },
  syncRepos: (provider) => unwrap(commands.syncRepos(provider)),
  syncCreateRepo: (provider, name) => unwrap(commands.syncCreateRepo(provider, name)),
  syncProxy: () => unwrap(commands.syncProxy()),
  syncSetProxy: (proxy) => unwrap(commands.syncSetProxy(proxy)),
  syncInspect: (provider, cloneUrl) => unwrap(commands.syncInspect(provider, cloneUrl)),
  syncEnable: (provider, cloneUrl, bringLocal) =>
    unwrap(commands.syncEnable(provider, cloneUrl, bringLocal)),
  syncDisable: () => unwrap(commands.syncDisable()) as Promise<SyncStatus>,
  updateStatus: () => unwrap(commands.updateStatus()),
  updateCheck: () => unwrap(commands.updateCheck()),
  updateInstall: async () => {
    await unwrap(commands.updateInstall());
  },
  onUpdateReady: (listener) => events.updateReady.listen((event) => listener(event.payload)),
  appUpgrade: () => unwrap(commands.appUpgrade()),
};

/* ---------------- 浏览器 mock ---------------- */

// 动态引入：打包进桌面版时这段会被 tree-shake 掉
async function mock(): Promise<Backend> {
  const { mockBackend } = await import("./mock");
  return mockBackend;
}

let resolved: Backend | null = null;

export async function backend(): Promise<Backend> {
  if (resolved) return resolved;
  resolved = isTauri ? tauriBackend : await mock();
  return resolved;
}

/** 同步取用。调用方需保证 `initBackend()` 已经 await 过。 */
export function backendSync(): Backend {
  if (!resolved) throw new Error("backend 未初始化，先 await initBackend()");
  return resolved;
}

export async function initBackend(): Promise<Backend> {
  return backend();
}
