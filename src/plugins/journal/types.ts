import type { DocumentRef } from "@/data/types";
import {
  type ISODate,
  type PeriodHorizon,
  formatMonthCN,
  formatMonthDayCN,
  formatYear,
  isoWeekNumber,
} from "@/lib/date";

/* ============================================================
   日程插件（odea.journal）的类型：今日TODO、目标、日历（docs/仓库与启动器.md §6）。
   Rust 那一半在 src-tauri/src/plugins/journal/，IPC 的类型由 tauri-specta 生成到 lib/bindings.ts，
   这里是界面要的窄类型
   ============================================================ */

/** 插件 id：仓库标记 plugins 里的键 */
export const JOURNAL = "odea.journal";
/** 某一天（key 是日期 `2026-11-03`） */
export const DAY = "journal.day";
/** 某个周期的目标（key 是 `week:2026-11-02`，同 goalKey） */
export const GOAL = "journal.goal";

/** 日程的三页（导航项的 id）。本机记的「上次停在哪」（odea.session）里存的就是它们，不能改 */
export type JournalPage = "today" | "goal" | "calendar";
export const PAGES: readonly JournalPage[] = ["today", "goal", "calendar"];

/* ---------------- 任务 ----------------
   日历「当日安排」里的一条。它就是某篇文档正文里带日期的 `- [ ]`：
   `- [ ] 力量训练 @2026-08-29 18:30 #健康`（见 src-tauri/src/plugins/journal/tasks.rs）。
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
  source?: DocumentRef | null;
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

/* ---------------- 目标 ---------------- */

export type GoalHorizon = PeriodHorizon;

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
  /** 文件不是 UTF-8：只能看（同 NoteSummary.notUtf8） */
  notUtf8: boolean;
}

/** 目标的 key：`week:2026-09-21`。goals 缓存的键、DocumentRef 的 key 都是它 */
export const goalKey = (horizon: GoalHorizon, periodStart: ISODate) => `${horizon}:${periodStart}`;

/** `week:2026-09-21` → 尺度和周期起点；不是目标的 key 返回 null */
export function parseGoalKey(key: string): { horizon: GoalHorizon; periodStart: ISODate } | null {
  const match = /^(week|month|year):(\d{4}-\d{2}-\d{2})$/.exec(key);
  return match ? { horizon: match[1] as GoalHorizon, periodStart: match[2]! } : null;
}

/**
 * GOAL 文档的标题，按周期算而不是存在库里 ——
 * 「本周目标」这种相对说法过了这周就不对了。
 * 「第 37 周目标」「九月目标」「2026 年目标」（和 Rust 的 plugins/journal 的 goal_title 一样）
 */
export function goalTitle(horizon: GoalHorizon, periodStart: ISODate): string {
  if (horizon === "week") return `第 ${isoWeekNumber(periodStart)} 周目标`;
  if (horizon === "month") return `${formatMonthCN(periodStart)}目标`;
  return `${formatYear(periodStart)} 年目标`;
}

/** 某一天给人看的标题（命令面板、反向链接、冲突横幅）：「10月6日」 */
export const dayTitle = (date: ISODate) => formatMonthDayCN(date);

/* ---------------- 某一天 ---------------- */

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
  /** 文件不是 UTF-8：只能看（同 NoteSummary.notUtf8） */
  notUtf8: boolean;
}

/** 日历右侧的分段：日TODO / 周·月·年 GOAL */
export type CalendarScope = "day" | GoalHorizon;
