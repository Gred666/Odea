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

/** 完整笔记（含正文）。对应 Rust 的 domain::model::Note。 */
export interface Note {
  id: string;
  title: string;
  /** 正文，Markdown 源码 */
  contentMd: string;
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

/** 某一天 / 某个周期的目标，连同正文：命令面板拿它搜日记和目标 */
export interface JournalDoc {
  target: DocumentSaveTarget;
  kind: "day" | "goal";
  /** 「10月6日 · 完成专注模式原型」「第 41 周目标」 */
  title: string;
  contentMd: string;
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

export interface SearchHit {
  id: string;
  title: string;
  excerpt: string;
  isArchived: boolean;
  updatedAt: number;
  /** bm25 分数，越小越相关 */
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  /**
   * 分词后的查询词。前端拿它在原始正文上做高亮 ——
   * 不能用 SQLite 的 snippet()，那是在分词串上取的，中文会显示成
   * 「今天 开会 讨论 季度 目标」。
   */
  tokens: string[];
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
  /** 给人看的云端仓库：`github.com/xxx/ontheway-notes` */
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
}

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
   新仓库里放的「欢迎使用 OnTheWay」「语法全览」，之后由应用管着新旧（src-tauri/src/vault/guide.rs）。
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
}

/* ---------------- 目录树 ---------------- */

export interface OutlineItem {
  id: string;
  text: string;
  level: 1 | 2;
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
  /** 所有持久化文档都由同一个 Markdown 编辑器编辑。 */
  editor?: {
    target: DocumentSaveTarget;
    /** 标题也能直接改（笔记、某一天）。GOAL 的标题由周期决定，不能改。 */
    titleEditable?: boolean;
  };
}

export type DocumentSaveTarget =
  | { kind: "note"; id: string }
  | { kind: "goal"; horizon: GoalHorizon; periodStart: ISODate }
  | { kind: "day"; id: ISODate };
