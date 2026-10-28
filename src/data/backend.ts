import { events, type Result as IpcResult, commands } from "@/lib/bindings";
import { isTauri, thisWindow } from "@/lib/tauri";
import type {
  AppUpgrade,
  Attachment,
  Backlink,
  CalendarMarks,
  ChangeRootMode,
  DayDoc,
  DocHistory,
  DocumentSaveTarget,
  FindOptions,
  FindResult,
  FolderDeletion,
  Goal,
  GoalHorizon,
  GuideName,
  GuideUpdate,
  ImportReport,
  IndexProgress,
  JournalDoc,
  JournalPage,
  JournalVault,
  LinkRewrite,
  Note,
  NoteSummary,
  Relink,
  SyncAccount,
  SyncDeviceCode,
  SyncPlan,
  SyncProviderKey,
  SyncProxy,
  SyncRemoteRepo,
  SyncStatus,
  Task,
  TeamInfo,
  TeamInvite,
  TextSearch,
  TrashedNote,
  TreeFile,
  TreeNode,
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
  /** 一个列表（笔记 / 归档）的全部笔记，不带正文。正文打开哪篇取哪篇（noteGet） */
  noteList(archived: boolean): Promise<NoteSummary[]>;
  noteGet(id: string): Promise<Note>;
  /**
   * 存正文，返回存完的那一篇。base 是编辑器照着改的那一版正文的指纹（lib/fingerprint.ts）：
   * 磁盘上已经不是那一版了，后端先把磁盘上的另存成冲突副本再写。null = 不知道（只比索引）
   */
  noteSave(id: string, contentMd: string, base: string | null): Promise<Note>;
  /** 改标题：文件跟着改名，正文不动。返回改完的那一篇 */
  noteRename(id: string, title: string): Promise<Note>;
  noteSetPinned(id: string, pinned: boolean): Promise<void>;
  noteArchive(id: string, category?: string): Promise<void>;
  noteRestore(id: string): Promise<void>;
  noteDelete(id: string): Promise<void>;
  /** 撤销删除、回收站里的「恢复」（删除是挪进回收站） */
  noteUndelete(id: string): Promise<void>;
  /** 回收站里的笔记，最近删的在前 */
  trashList(): Promise<TrashedNote[]>;
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
  /** 文件树上列的图片、PDF（本地目录；逻辑目录是空的） */
  treeFiles(): Promise<TreeFile[]>;
  /** 树上的一个文件：用系统的默认程序打开，reveal 时在文件管理器里定位它 */
  treeFileOpen(relPath: string, reveal: boolean): Promise<void>;
  /* ---- 逻辑目录（docs/仓库与启动器.md §7）：树在清单里，文件夹不在硬盘上 ---- */
  /** 树上的节点：文件夹、智能文件夹、放在树上的笔记（不是逻辑目录报错） */
  treeView(): Promise<TreeNode[]>;
  /** 把一篇放进 folder（`/` 是「未整理」），排在 after 那一篇后面，null 是最前面。只改清单 */
  treePlace(id: string, folder: string, after: string | null): Promise<void>;
  /** 在 folder 里放一个指着笔记 id 的快捷方式，返回它的节点 id（已经有就是那一个） */
  treeAddShortcut(id: string, folder: string): Promise<string>;
  /** 删一个快捷方式（节点 id）：笔记不动 */
  treeRemoveShortcut(node: string): Promise<void>;
  /** 导入：弹选文件夹的对话框，把仓库外的一个文件夹复制进来放在 folder 里。取消了返回 null */
  vaultImport(folder: string): Promise<ImportReport | null>;
  /** 挪文件夹：放进 parent，排在 after（同一层的路径）后面，null 是最前面。返回新路径 */
  treeMoveFolder(folder: string, parent: string, after: string | null): Promise<string>;
  /** 新建智能文件夹，返回它的路径 */
  treeAddQuery(parent: string, name: string, query: string): Promise<string>;
  /** 改智能文件夹的名字和条件，返回新路径 */
  treeSetQuery(folder: string, name: string, query: string): Promise<string>;
  /** 按几个条件各筛一遍，每个给出命中的笔记 id（置顶在前、最近改过的在前） */
  treeQueries(queries: string[]): Promise<string[][]>;
  /** 本地目录转成逻辑目录（先问一句，一个文件都不动）。取消了返回 null；转好了整页重载 */
  vaultMakeLogical(): Promise<VaultInfo | null>;
  /** 导出成真实文件夹：弹选位置的对话框、拷完在文件管理器里打开。取消了返回 null */
  treeExport(): Promise<string | null>;
  /**
   * 搜正文：大小写不敏感的子串，笔记和日记、目标各自最多 limit 条；archivedOnly 只搜归档里的笔记
   * （归档的搜索框）。被同一处后来的一次顶掉的会返回空结果，调用方只认最后一次的
   */
  searchText(query: string, limit: number, archivedOnly: boolean): Promise<TextSearch>;
  /**
   * 全局搜索（Ctrl+Shift+F）：笔记（含归档）、日记、目标的正文里每一处命中，可以区分大小写、全词匹配、
   * 用正则（含义同编辑器里的查找面板）。正则写错了放在结果的 error 里。被后来的一次顶掉的会返回空结果
   */
  findInVault(query: string, options: FindOptions): Promise<FindResult>;
  taskToggle(id: string): Promise<Task>;
  /** 某个周期的目标；没写过的周期返回空文档（id 为空） */
  goalGet(horizon: GoalHorizon, periodStart: string): Promise<Goal>;
  /** base 同 noteSave */
  goalSave(
    horizon: GoalHorizon,
    periodStart: string,
    contentMd: string,
    base: string | null,
  ): Promise<Goal>;
  /** carryOver 只在请求「今天」时传 true：今天还没写过就延续之前最近的一天 */
  calendarDay(date: string, carryOver: boolean): Promise<DayDoc>;
  /** base 同 noteSave */
  calendarDaySave(
    date: string,
    title: string,
    noteMd: string,
    base: string | null,
  ): Promise<DayDoc>;
  /** 月网格上的记号：写过记录 / 做过事的日子，和还有待办的日子 */
  calendarMarks(from: string, to: string): Promise<CalendarMarks>;
  /** 所有写过的某一天、某个周期的目标（不带正文，命令面板按标题搜它们），最近改过的在前 */
  journalList(): Promise<JournalDoc[]>;
  /** 用户改过、而这个版本带着新版的使用指南（在那一篇上问换不换） */
  guidePending(): Promise<GuideUpdate[]>;
  /** 用户看过新版了（换上了，或者留着自己的）：到下一次升级前不再问 */
  guideSettle(id: string): Promise<void>;
  /** 命令面板「使用指南」：那一篇的 id，删掉了就照这个版本重新放一篇 */
  guideOpen(name: GuideName): Promise<string>;
  vaultInfo(): Promise<VaultInfo>;
  /** 开 / 关日程：改仓库标记、每个文件按新的摆法重新认一遍（文件不动）。之后整页重载 */
  vaultSetJournal(on: boolean): Promise<VaultInfo>;
  /** 开 / 关归档（和日程分开）：改仓库标记、重新认一遍文件。之后整页重载 */
  vaultSetArchive(on: boolean): Promise<VaultInfo>;
  /** 别的设备开关了日程、转成了逻辑目录（VaultChange.layout）：按磁盘上的仓库标记重新摆 */
  vaultRelayout(): Promise<VaultInfo>;
  /** 在系统的文件管理器里定位这篇文档的文件 */
  vaultReveal(target: DocumentSaveTarget): Promise<void>;
  /** 打开整个笔记文件夹 */
  vaultOpenFolder(): Promise<void>;
  /**
   * 弹选择文件夹对话框换仓库；取消了返回 null。`ask`：新文件夹里没有笔记就问搬过去 / 复制过去 /
   * 只换文件夹；`move`：直接搬过去
   */
  vaultChangeRoot(mode: ChangeRootMode): Promise<VaultInfo | null>;
  /** 弹启动器（docs/仓库与启动器.md §3）：打开别的仓库、新建、加入协同编辑 */
  showLauncher(): Promise<void>;
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
  /* ---- 团队仓库（docs/协同编辑.md §22.3） ---- */
  /** 这个仓库的成员：名单里的设备按账号合起来，对上托管方那边谁有权限（要联网，慢一点） */
  teamInfo(): Promise<TeamInfo>;
  /** 邀请成员：托管方那边拉他当协作者，标成团队仓库，返回发给他的链接 */
  teamInvite(login: string): Promise<TeamInvite>;
  /** 移出成员：托管方那边去掉权限（没接受的邀请撤回），名单里他的设备也去掉 */
  teamRemove(login: string): Promise<void>;
  /** 点开的团队仓库链接（odea://vault/）交给启动器：在那里拉一份 */
  openVaultLink(link: string): Promise<void>;
  /* ---- 日程切换器（§22.6） ---- */
  /** 这台电脑上开着日程的仓库：个人的在前 */
  journalVaults(): Promise<JournalVault[]>;
  /** 跳到那个仓库的日程：它的窗口摆在这个窗口的位置上、停在同一页同一天 */
  journalSwitch(path: string, page: JournalPage, date: string): Promise<void>;
  /** 订阅「跳过来了，翻到这一页」（日程切换器从别的窗口跳过来时） */
  onJournalGoto(listener: (page: JournalPage, date: string) => void): Promise<() => void>;
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
  noteList: (archived) => unwrap(commands.noteList(archived)),
  noteGet: (id) => unwrap(commands.noteGet(id)) as Promise<Note>,
  noteSave: (id, contentMd, base) => unwrap(commands.noteSave(id, contentMd, base)),
  noteRename: (id, title) => unwrap(commands.noteRename(id, title)),
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
  trashList: () => unwrap(commands.trashList()),
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
  treeFiles: () => unwrap(commands.treeFiles()),
  treeFileOpen: async (relPath, reveal) => {
    await unwrap(commands.treeFileOpen(relPath, reveal));
  },
  treeView: () => unwrap(commands.treeView()),
  treeAddShortcut: (id, folder) => unwrap(commands.treeAddShortcut(id, folder)),
  treeRemoveShortcut: async (node) => {
    await unwrap(commands.treeRemoveShortcut(node));
  },
  vaultImport: (folder) => unwrap(commands.vaultImport(folder)),
  treePlace: async (id, folder, after) => {
    await unwrap(commands.treePlace(id, folder, after));
  },
  treeMoveFolder: (folder, parent, after) => unwrap(commands.treeMoveFolder(folder, parent, after)),
  treeAddQuery: (parent, name, query) => unwrap(commands.treeAddQuery(parent, name, query)),
  treeSetQuery: (folder, name, query) => unwrap(commands.treeSetQuery(folder, name, query)),
  treeQueries: (queries) => unwrap(commands.treeQueries(queries)),
  vaultMakeLogical: () => unwrap(commands.vaultMakeLogical()),
  treeExport: () => unwrap(commands.treeExport()),
  searchText: (query, limit, archivedOnly) =>
    unwrap(commands.searchText(query, limit, archivedOnly)) as Promise<TextSearch>,
  findInVault: (query, options) =>
    unwrap(commands.findInVault(query, options)) as Promise<FindResult>,
  taskToggle: (id) => unwrap(commands.taskToggle(id)) as Promise<Task>,
  goalGet: (horizon, periodStart) =>
    unwrap(commands.goalGet(horizon, periodStart)) as Promise<Goal>,
  goalSave: (horizon, periodStart, contentMd, base) =>
    unwrap(commands.goalSave(horizon, periodStart, contentMd, base)) as Promise<Goal>,
  calendarDay: (date, carryOver) =>
    unwrap(commands.calendarDay(date, carryOver)) as Promise<DayDoc>,
  calendarDaySave: (date, title, noteMd, base) =>
    unwrap(commands.calendarDaySave(date, title, noteMd, base)) as Promise<DayDoc>,
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
  vaultSetJournal: (on) => unwrap(commands.vaultSetJournal(on)),
  vaultSetArchive: (on) => unwrap(commands.vaultSetArchive(on)),
  vaultRelayout: () => unwrap(commands.vaultRelayout()),
  vaultReveal: async (target) => {
    await unwrap(commands.vaultReveal(target));
  },
  vaultOpenFolder: async () => {
    await unwrap(commands.vaultOpenFolder());
  },
  vaultChangeRoot: (mode) => unwrap(commands.vaultChangeRoot(mode)),
  showLauncher: async () => {
    await unwrap(commands.launcherShow());
  },
  vaultAttach: (target, name, dataBase64) => unwrap(commands.vaultAttach(target, name, dataBase64)),
  vaultAttachPath: (target, path) => unwrap(commands.vaultAttachPath(target, path)),
  onVaultChanged: (listener) =>
    events.vaultChanged(thisWindow()).listen((event) => listener(event.payload as VaultChange)),
  indexProgress: () => unwrap(commands.indexProgress()),
  onIndexProgress: (listener) =>
    events.indexProgress(thisWindow()).listen((event) => listener(event.payload)),
  syncStatus: () => unwrap(commands.syncStatus()) as Promise<SyncStatus>,
  syncNow: () => unwrap(commands.syncNow()),
  onSyncStatus: (listener) =>
    events.syncStatusChanged(thisWindow()).listen((event) => listener(event.payload as SyncStatus)),
  onSyncNotice: (listener) =>
    events.syncNotice(thisWindow()).listen((event) => listener(event.payload)),
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
  teamInfo: () => unwrap(commands.teamInfo()) as Promise<TeamInfo>,
  teamInvite: (login) => unwrap(commands.teamInvite(login)),
  teamRemove: async (login) => {
    await unwrap(commands.teamRemove(login));
  },
  openVaultLink: async (link) => {
    await unwrap(commands.launcherOpenLink(link));
  },
  journalVaults: () => unwrap(commands.journalVaults()),
  journalSwitch: async (path, page, date) => {
    await unwrap(commands.journalSwitch(path, page, date));
  },
  onJournalGoto: (listener) =>
    events
      .journalGoto(thisWindow())
      .listen((event) => listener(event.payload.page as JournalPage, event.payload.date)),
  updateStatus: () => unwrap(commands.updateStatus()),
  updateCheck: () => unwrap(commands.updateCheck()),
  updateInstall: async () => {
    await unwrap(commands.updateInstall());
  },
  onUpdateReady: (listener) =>
    events.updateReady(thisWindow()).listen((event) => listener(event.payload)),
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
