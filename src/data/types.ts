import type { CollabSession } from "@/collab/session";
import type { ISODate } from "@/lib/date";

/* ============================================================
   领域类型
   文档都是仓库文件夹里的 Markdown 文件（技术方案 §5）。
   Rust IPC 的宽类型由 tauri-specta 生成到 lib/bindings.ts；这里保留
   视图层需要的窄联合类型，由 data/backend.ts 在边界统一转换。
   命名保持 camelCase（Rust 侧用 #[serde(rename_all = "camelCase")]）。
   ============================================================ */

/** 导航区。「一切皆文档」——每个区最终都渲染成 DocumentView。扩展页还没有运行时，先不进导航 */
export type WorkspaceId = "notes" | "today" | "goal" | "calendar" | "archive" | "extensions";

/* ---------------- 笔记 ---------------- */

/**
 * 列表里的一篇：不带正文。对应 Rust 的 domain::model::NoteSummary。
 * store 里两个列表放的都是它 —— 仓库里有多少篇放多少篇，正文只留最近打开的几篇
 * （store 的 bodies），搜正文走 Rust（searchText）。几万篇也只多一点摘要的内存
 */
export interface NoteSummary {
  id: string;
  title: string;
  excerpt: string;
  wordCount: number;
  isPinned: boolean;
  isArchived: boolean;
  archiveCategory: string | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** 在仓库里的相对路径（正斜杠）。正文里的相对图片路径以它所在的文件夹为基准 */
  relPath: string;
  /**
   * 这篇是另一篇的冲突副本（同步撞车、或本应用另存的）：原文的 id。原文也可以是
   * 某一天（`day:2026-10-07`）或某个周期的目标（`goal:week:2026-09-21`），见 data/conflicts.ts
   */
  conflictOf: string | null;
}

/** 完整笔记（含正文）。对应 Rust 的 domain::model::Note：noteGet 取一篇时才有 */
export interface Note extends NoteSummary {
  /** 正文，Markdown 源码 */
  contentMd: string;
}

export interface NoteInput {
  /** null 是新建 */
  id: string | null;
  title: string;
  contentMd: string;
}

/* ---------------- 任务 ----------------
   日历「当日安排」里的一条。它就是某篇文档正文里带日期的 `- [ ]`：
   `- [ ] 力量训练 @2026-08-29 18:30 #健康`（见 src-tauri/src/vault/tasks.rs）。
   在日历里勾选，改的是原文件里的那一行。
*/

export type TaskStatus = "todo" | "done";

export interface Task {
  /** 所在文档的 id # 行号。只在勾选的那一下用 */
  id: string;
  title: string;
  status: TaskStatus;
  /** 任务下方的灰色小字：「健康 · 18:30 · 本周目标」（分类 · 时间 · 出处） */
  meta: string | null;
  dueDate: ISODate | null;
  /** 「上午」「16:00」「18:30」这类展示用时间 */
  timeLabel: string | null;
  /** 分类：任务里的第一个 #标签 */
  category: string | null;
  /** 写着这条任务的那篇文档（日历里点「出处」跳过去）；浏览器预览里的演示任务没有 */
  source?: DocumentSaveTarget | null;
  /** 在那篇正文里的行号（从 0 开始） */
  line?: number | null;
}

/** 日历月网格上的两种记号 */
export interface CalendarMarks {
  /** 留下过东西的日子：这一天的记录写过，或者有做完了的任务 */
  written: Set<ISODate>;
  /** 还有没做完的任务的日子 */
  open: Set<ISODate>;
}

/** 写过的某一天 / 某个周期的目标（不带正文）：命令面板按标题搜它们，正文走 searchText */
export interface JournalDoc {
  target: DocumentSaveTarget;
  kind: "day" | "goal";
  /** 「10月6日 · 完成专注模式原型」「第 41 周目标」 */
  title: string;
  updatedAt: number;
}

/* ---------------- 目标 ---------------- */

export type GoalHorizon = "week" | "month" | "year";

/**
 * 某个周期（某一周 / 某个月 / 某一年）的目标，一个周期一篇。
 * 键是 horizon + periodStart；还没写过的周期是一篇空文档（id 为空、updatedAt 为 0），
 * 第一次保存时才落库。
 */
export interface Goal {
  /** 还没落库时为空串 */
  id: string;
  horizon: GoalHorizon;
  /** 库里的原始标题；界面展示用 goalTitle() 按周期算，不用它 */
  title: string;
  /** 该周期的起点：周一 / 1 号 / 1 月 1 日 */
  periodStart: ISODate;
  contentMd: string;
  createdAt: number;
  updatedAt: number;
  /** 在仓库里的相对路径；还没写过的周期是它将来的位置 */
  relPath: string;
}

/** goals 缓存的键 */
export const goalKey = (horizon: GoalHorizon, periodStart: ISODate) => `${horizon}:${periodStart}`;

/* ---------------- 日历 ---------------- */

/**
 * 某一天的文档：「今日TODO」就是今天这一篇，日历里点到哪天就是哪一篇。
 * 和笔记一样有可编辑的标题。
 */
export interface DayDoc {
  date: ISODate;
  /** 空串表示还没起标题，界面上显示占位「无标题笔记」 */
  title: string;
  /** 当天的待办 / 事件 */
  tasks: Task[];
  noteMd: string;
  updatedAt: number;
  /**
   * 这一天还没写过、内容是从之前最近一天延续来的：那一天的日期。
   * 只有「今天」会延续；用户一编辑就以这一天自己的身份落库。
   */
  carriedFrom: ISODate | null;
  /** 在仓库里的相对路径；还没写过的日子是它将来的位置 */
  relPath: string;
}

/* ---------------- 搜索 ---------------- */

/** searchText 的一条：正文里出现了要找的字的文档 */
export interface TextHit {
  target: DocumentSaveTarget;
  /** 笔记是它的标题；某一天 / 目标是给人看的标题（同 JournalDoc） */
  title: string;
  updatedAt: number;
  /** 第一次出现的那一行（很长的截一段）：面板在里面截出要显示的一小段（snippetAround） */
  line: string;
}

/** 搜正文：笔记（含归档，顺序同两个列表接起来）和日记、目标，各自最多 limit 条 */
export interface TextSearch {
  notes: TextHit[];
  journal: TextHit[];
}

/** 全局搜索（findInVault）的条件：和编辑器里查找面板的三个开关一样 */
export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** 全局搜索里的一处命中 */
export interface FindMatch {
  /** 第几行，从 1 开始 */
  line: number;
  /** 在这一行里从第几个 UTF-16 码元开始、占几个（和编辑器里的位置同一个单位）：跳进文档后选中它 */
  column: number;
  length: number;
  /** 给人看的一段：命中处前面一小截（截掉了的以「…」开头）、命中的字、后面一截 */
  before: string;
  text: string;
  after: string;
}

/** 全局搜索里命中了的一篇 */
export interface FindFile {
  target: DocumentSaveTarget;
  /** 笔记是它的标题；某一天 / 目标是给人看的标题（同 JournalDoc） */
  title: string;
  updatedAt: number;
  /** 这一篇里给出的命中（总数到了上限，后面的就不给了） */
  matches: FindMatch[];
  /** 这一篇里一共几处 */
  count: number;
}

/**
 * 从全局搜索的结果跳进一篇：在那一行（app/navigate 的行号锚点）里选中这一处命中，
 * 篇内查找（Mod-F、F3）接着用同一个条件
 */
export interface MatchAnchor extends FindOptions {
  query: string;
  /** 同 FindMatch：这一行里的 UTF-16 位置 */
  column: number;
  length: number;
}

/** 打开一篇时要去的位置（app/navigate 的 openDocument）：某个小节，或者某一行（从 1 开始） */
export interface DocumentAnchor {
  heading?: string;
  line?: number;
  /** 只和 line 一起用 */
  match?: MatchAnchor;
}

/** 全局搜索的结果：笔记（含归档，顺序同两个列表接起来）在前，日记、目标（最近改过的在前）在后 */
export interface FindResult {
  files: FindFile[];
  /** 一共几处（没给出来的也数了） */
  total: number;
  /** 命中太多，只给了前面一部分 */
  truncated: boolean;
  /** 正则写错了：给人看的原因（这时 files 是空的） */
  error: string | null;
}

/* ---------------- 仓库文件夹 ---------------- */

/**
 * 仓库里别处发生的变化：文件被外部程序改了，或者一次操作连带改了别的文档。
 * 由 Rust 的 vault-changed 事件送来，store 据此刷新缓存（applyVaultChange）。
 */
export interface VaultChange {
  /** 变了（或没了）的笔记 id */
  notes: string[];
  /** 变了的某一天 */
  days: ISODate[];
  /** 变了的目标，`week:2026-09-21`（同 goalKey） */
  goals: string[];
  /** 带日期的任务有变化：当日安排和日历上的小圆点要刷新 */
  tasks: boolean;
  /** 这次产生的冲突副本的标题（编辑器里有没存的修改时外部改动到了，另存的那一份） */
  conflicts: string[];
  /** 新出现的冲突副本（同步时两边都改过，网盘或另一台设备另存的那一份）的标题 */
  foundCopies: string[];
  /** 「笔记」下面的文件夹变了（在资源管理器里建了、删了、改了名） */
  folders: boolean;
  /**
   * 仓库的摆法在别处变了（另一台设备开关了日程、转成了逻辑目录，同步过来）：问一句「切换过去」，
   * 点了才按新的摆法重新认文件、整页重载（vaultRelayout）
   */
  layout: boolean;
}

/* ---------------- 同步（技术方案 §5.9） ---------------- */

/**
 * off：这个仓库没开同步；idle：同步好了；offline：连不上云端，改动都在本机；
 * auth：登录失效；error：别的错，原因在 message 里
 */
export type SyncState = "off" | "idle" | "syncing" | "offline" | "auth" | "error";

/** 太大、没有同步的文件 */
export interface SyncOversized {
  rel: string;
  bytes: number;
}

/** 由 Rust 的 sync-status-changed 事件送来 */
export interface SyncStatus {
  state: SyncState;
  /** 给人看的云端仓库：`github.com/xxx/odea-notes` */
  remote: string | null;
  /** 上一次同步成功的时间（UTC 毫秒） */
  lastSyncedAt: number | null;
  /** 本机还有几个提交没推上去 */
  unpushed: number;
  message: string | null;
  oversized: SyncOversized[];
}

/** 同步托管方（技术方案 §5.9.4） */
export type SyncProviderKey = "github" | "gitee";

/** 一个登录过的同步账号 */
export interface SyncAccount {
  provider: SyncProviderKey;
  login: string;
}

/** GitHub 设备码登录：给用户看的码，和去哪输入 */
export interface SyncDeviceCode {
  userCode: string;
  verificationUri: string;
  /** 码多久过期（秒） */
  expiresIn: number;
}

/** 云端的一个仓库 */
export interface SyncRemoteRepo {
  /** `owner/name` */
  fullName: string;
  cloneUrl: string;
  private: boolean;
  updatedAt: string | null;
  /** 主人的账号：不是我的话，这是别人拉我进来的团队仓库 */
  owner: string;
}

/** 别人发给我、还没接受的仓库邀请（GitHub） */
export interface SyncInvitation {
  id: string;
  repo: SyncRemoteRepo;
  /** 谁邀请的 */
  inviter: string;
}

/* ---------------- 团队仓库（docs/协同编辑.md §22.3） ----------------
   开了 git 同步、几个账号都有权限的仓库。成员 = 仓库里设备名单（.odea/devices）上的设备，按账号合起来
*/

export interface TeamInfo {
  /** 是团队仓库（仓库标记里写着 team） */
  team: boolean;
  /** 同步的托管方和仓库（`owner/name`）；没开同步是 null —— 那就还邀请不了人 */
  provider: string | null;
  repo: string | null;
  /** 我同步用的账号 */
  me: string | null;
  people: TeamPerson[];
  /** 托管方那边问不到（没网、登录失效、Gitee）：为什么。这时 people 只有名单里的 */
  remoteError: string | null;
}

export interface TeamPerson {
  login: string;
  me: boolean;
  /** 名单里他的设备，最近更新的在前 */
  devices: TeamDevice[];
  access: TeamAccess;
}

export interface TeamDevice {
  name: string;
  updated: number;
  /** 就是这台设备 */
  this: boolean;
}

/** 托管方那边：能推这个仓库 / 邀请了还没接受 / 名单里还有设备可已经没权限了 / 问不到 */
export type TeamAccess = "member" | "invited" | "gone" | "unknown";

export interface TeamInvite {
  /** 发给他的链接：`odea://vault/github/owner/name`，点开在启动器里拉一份 */
  link: string;
  /** 他本来就有这个仓库的权限（不用等他接受邀请） */
  already: boolean;
}

/** 这台电脑上开着日程的一个仓库（日程切换器，§22.6） */
export interface JournalVault {
  path: string;
  name: string;
  team: boolean;
  /** 就是这个窗口的仓库 */
  current: boolean;
}

/** 日程切换器跳过去以后停在哪一页 */
export type JournalPage = "today" | "goal" | "calendar";

/** 同步用的代理：用户填的，和实际在用的（填的 > 环境变量 > 系统代理） */
export interface SyncProxy {
  configured: string | null;
  effective: string | null;
}

/** 开启同步前看一眼云端：接下来会发生什么 */
export interface SyncPlan {
  /** true：云端是空的（或这个仓库以前连过），把这里的推上去；false：clone 到 cloneTarget、换过去 */
  connectHere: boolean;
  cloneTarget: string | null;
  /** 现在的仓库里有笔记：问要不要「也合并进来」 */
  localNotes: boolean;
}

export const SYNC_OFF: SyncStatus = {
  state: "off",
  remote: null,
  lastSyncedAt: null,
  unpushed: 0,
  message: null,
  oversized: [],
};

/* ---------------- 新版本（src-tauri/src/update.rs，技术方案 §14.4） ---------------- */

/** 下好了、验过签，等着装的新版本 */
export interface UpdateInfo {
  version: string;
  /** 现在这一版 */
  current: string;
  /** 更新说明（Markdown，发版时写的） */
  notes: string | null;
  /** 发布日期 YYYY-MM-DD */
  date: string | null;
  /** 在应用里装不了（Linux 的 deb / rpm）时是下载页的地址；能装的是 null */
  manual: string | null;
}

/** 这一次启动是升级上来的：从哪一版到哪一版。from 为 null = 记版本号之前的老版本 */
export interface AppUpgrade {
  from: string | null;
  to: string;
}

/* ---------------- 文件夹 ----------------
   笔记的文件夹就是仓库里「笔记」下面的子目录（src-tauri/src/vault/folders.rs）。
   路径相对「笔记」、正斜杠分隔：`工作/周报`；空串是「笔记」本身（全部笔记）。
*/

/** 删掉一个文件夹的结果，原样交回 folderUndelete 就能撤销 */
export interface FolderDeletion {
  folder: string;
  /** 进了回收站的笔记 id */
  notes: string[];
  /** 删掉的文件夹和它底下的子文件夹 */
  folders: string[];
  /** 文件夹里还有别的文件（图片、PDF），目录留着没删 */
  kept: boolean;
  /** 逻辑目录：从清单里拿掉的那几行（文件夹、智能文件夹、笔记的位置），撤销时放回去 */
  nodes: string | null;
}

/**
 * 逻辑目录的树上的一个节点（Rust 的 vault/tree.rs，docs/仓库与启动器.md §7）：文件夹、智能文件夹、
 * 放在树上的笔记。data/tree.ts 把它摊成界面认的样子
 */
export interface TreeNode {
  id: string;
  /** 父节点的 id，根是 `.` */
  parent: string;
  /** 排序键：同一层按它排，一样时按 id */
  key: string;
  kind: string;
  /** 文件夹、智能文件夹的名字 */
  name: string | null;
  /** 笔记的 id */
  note: string | null;
  /** 智能文件夹的条件 */
  query: string | null;
}

/**
 * 文件树上一个不是笔记的文件：图片、PDF（docs/仓库与启动器.md §11）。整个仓库当树根时
 * （打开的文件夹、Obsidian 的库）和 Obsidian 一样列出来；Odea 建的仓库的「附件」不在树上
 */
export interface TreeFile {
  /** 仓库里的相对路径 */
  relPath: string;
  /** 在树上哪个文件夹（相对树根，空串是根） */
  folder: string;
  name: string;
  kind: "image" | "pdf" | (string & {});
  size: number;
  updatedAt: number;
}

/** 导入一个文件夹的结果（docs/仓库与启动器.md §7.6） */
export interface ImportReport {
  /** 树上新文件夹的路径 */
  folder: string;
  notes: number;
  /** 别的文件（图片、PDF …） */
  files: number;
}

/* ---------------- 反向链接 ---------------- */

/** 一篇正文里写了 `[[这篇的标题]]` 的文档（笔记、某一天、目标都算） */
export interface Backlink {
  /** 链过来的那篇，点一下跳过去 */
  target: DocumentSaveTarget;
  kind: "note" | "day" | "goal";
  /** 给人看的标题：笔记标题、「10月6日 · 周一」、「第 41 周目标」 */
  title: string;
  archived: boolean;
  updatedAt: number;
  /** 写着链接的那几行（最多 3 行），双链原样保留 */
  lines: { line: number; text: string }[];
  /** 这篇里一共链了几次 */
  count: number;
}

/** 笔记改了标题之后，别处的 `[[旧标题]]` 改成了新标题 */
export interface Relink {
  /** 改了几处链接；没改（skipped）时是本来要改的处数 */
  links: number;
  /** 改了的那几篇，给人看的标题 */
  docs: string[];
  /** 没改的原因（新标题写不进双链、和别的笔记重名……）。改了是 null */
  skipped: string | null;
  /** 每篇改之前、之后的全文，原样交给 noteRelinkUndo 就能撤销 */
  rewrites: LinkRewrite[];
}

export interface LinkRewrite {
  relPath: string;
  before: string;
  after: string;
}

/* ---------------- 使用指南 ----------------
   新仓库里放的「欢迎使用 Odea」「语法全览」，之后由应用管着新旧（src-tauri/src/vault/guide.rs）。
   用户没改过的，升级时直接换成新版；改过的不动，在那一篇上问换不换。
*/

/** 内置的几份指南 */
export type GuideName = "welcome" | "syntax";

/** 用户改过、而这个版本带着新版的指南 */
export interface GuideUpdate {
  /** 那一篇笔记的 id */
  id: string;
  name: string;
  /** 这个版本带的正文 */
  body: string;
}

/* ---------------- 历史版本 ----------------
   同步用的 git 仓库里，每次改过这篇的提交就是一版（技术方案 §5.9.11）。
*/

export interface DocHistory {
  /** 为什么没有历史（还没开启同步）。有历史时是 null */
  unavailable: string | null;
  /** 新的在前 */
  versions: DocVersion[];
  /** 更早的还有，没列出来 */
  more: boolean;
}

export interface DocVersion {
  /** 这一版内容的 id，交给 docVersionText 取正文 */
  blob: string;
  /** 什么时候改的（同步提交的时间） */
  time: number;
  /** 哪台设备改的 */
  device: string;
  /** 谁改的：团队仓库里别人的账号；自己的、以前没带账号的是 null */
  person: string | null;
  /** 这台设备自己改的 */
  mine: boolean;
  /** 这一版时的标题（笔记改过标题才和现在不一样；某一天、目标是空串） */
  title: string;
}

/* ---------------- 附件 ---------------- */

/** 存进仓库「附件」文件夹的一个文件 */
export interface Attachment {
  /** 从文档引用它的路径，直接写进 `![](…)`（浏览器预览里是 data: 地址） */
  link: string;
  name: string;
  isImage: boolean;
}

/**
 * 后台把文件读进索引的进度（第一次打开一个大文件夹、索引结构升级要重建时，Rust 的
 * Vault::open_quick）。读完的那一次 done === total
 */
export interface IndexProgress {
  done: number;
  total: number;
}

export interface VaultInfo {
  /** 仓库文件夹的绝对路径 */
  root: string;
  notes: number;
  archived: number;
  days: number;
  goals: number;
  tasks: number;
  layout: VaultLayout;
  /** 团队仓库（docs/协同编辑.md §22.3） */
  team: boolean;
}

/**
 * 这个仓库怎么摆（docs/仓库与启动器.md §6，Rust 的 vault/layout.rs）：开没开日程、文件树的根在哪。
 * 窄栏上有哪几项、一篇笔记在树上哪个文件夹（data/folders.ts）都看它
 */
export interface VaultLayout {
  /** 逻辑目录（§7）：文件树是清单里摆的那一棵（treeView），文件夹不在硬盘上 */
  logical: boolean;
  /** 开没开日程（今日TODO、目标、日历、归档） */
  journal: boolean;
  /** 文件树的根：「笔记」，或者整个仓库（空串） */
  notesDir: string;
  daysDir: string;
  goalsDir: string;
  archiveDir: string;
  /** 不在树上的文件夹（日程开着时的日记、目标、归档）：里面的笔记算在树根这一层 */
  hiddenDirs: string[];
}

/** Odea 自己建的仓库：日程开着，树根是「笔记」。取到仓库的真实摆法之前先当它是这样 */
export const ODEA_LAYOUT: VaultLayout = {
  logical: false,
  journal: true,
  notesDir: "笔记",
  daysDir: "日记",
  goalsDir: "目标",
  archiveDir: "归档",
  hiddenDirs: ["日记", "目标", "归档"],
};

/**
 * 换笔记文件夹时现在的笔记怎么办：`ask` 新文件夹里没有笔记就问（搬过去 / 复制过去 / 只换文件夹），
 * `move` 直接搬过去（第一次打开时的「换个位置…」）
 */
export type ChangeRootMode = "ask" | "move";

/* ---------------- 目录树 ---------------- */

export interface OutlineItem {
  id: string;
  text: string;
  /**
   * 树里的层级：标题级别 - 全文最浅的那一级 + 1；callout 是它所在那一节的下一层；
   * 「概览」是 0（技术方案 §12.9）
   */
  depth: number;
  /** 缩进几档：跟着 depth，最多三档 */
  level: 1 | 2 | 3;
  /** Markdown 源文中的一基行号，用于编辑器精确跳转。 */
  line: number;
}

/* ============================================================
   统一文档模型
   ★ 整个应用最重要的抽象。
   笔记 / 今日TODO / GOAL / 日历某天 / 归档项 —— 全部归一到这里，
   由同一个 DocumentView 渲染。新增一种内容类型 = 多一个 adapter 映射，
   不需要写新的视图组件。
   ============================================================ */

export interface DocumentModel {
  /** 用于 React key 和滚动位置记忆 */
  key: string;
  title: string;
  /** 标题上方的横幅，如归档视图的「已归档 · 2026年8月18日」 */
  banner?: { icon: "archive"; text: string };
  /** 这篇是另一篇的冲突副本：标题上方换成冲突横幅（打开原文 / 留这一版 / 删掉这份） */
  /** 这篇是冲突副本：原文是哪篇（笔记、某一天或某个周期的目标，见 data/conflicts.ts） */
  conflict?: { copyId: string; original: DocumentSaveTarget; originalTitle: string };
  /**
   * 没有内容可显示（一篇笔记都没有、归档是空的）：正文区换成插画 + 一句话，
   * 不再假装是一篇标题叫「还没有笔记」的文档
   */
  empty?: { art: "notes" | "archive"; title: string; hint: string; action?: "createNote" };
  /** 在仓库里的相对路径：正文里的相对图片路径（附件）以它所在的文件夹为基准 */
  relPath?: string;
  /** 标题上方的分段控件。short：正文区窄的时候每一项换成的短字（日历那四段） */
  segments?: { group: string; options: string[]; short?: string[]; active: string };
  /** 统一的 Markdown 正文 */
  bodyMd: string;
  /** 日历某一天的「当日安排」：别的文档里写着这一天的任务，列在正文后面 */
  dayTasks?: Task[];
  /** 标题上方的一行小字，如日历某天的「9月15日 · 周二」 */
  eyebrow?: string;
  /** 笔记所在的文件夹（相对「笔记」，空串是最上层）：标题上方显示成一行路径。只有笔记有 */
  folder?: string;
  /** 底部状态栏的分段文字 */
  statusParts: string[];
  /** 是否显示删除按钮（原型里笔记视图右下角有个红色垃圾桶） */
  deletable?: boolean;
  /**
   * 正在协作（docs/协同编辑.md）：编辑器接到这个会话上，正文以会话为准。
   * 主持人那篇是普通的笔记带上它；访客那篇的保存目标是 shared
   */
  collab?: { session: CollabSession; readOnly: boolean };
  /** 所有持久化文档都由同一个 Markdown 编辑器编辑。 */
  editor?: {
    target: EditorTarget;
    /** 标题也能直接改（笔记、某一天）。GOAL 的标题由周期决定，不能改。 */
    titleEditable?: boolean;
  };
}

export type DocumentSaveTarget =
  | { kind: "note"; id: string }
  | { kind: "goal"; horizon: GoalHorizon; periodStart: ISODate }
  | { kind: "day"; id: ISODate };

/**
 * 在别人那里做客的那一篇（docs/协同编辑.md §3）：真相在主持人那台，访客这边不落盘，
 * 保存、改标题都没有。id 是这次会话的键。只出现在文档模型的编辑器目标上
 */
export interface SharedTarget {
  kind: "shared";
  id: string;
}

/** 编辑器在编辑什么：仓库里的一篇，或者做客的那一篇 */
export type EditorTarget = DocumentSaveTarget | SharedTarget;
