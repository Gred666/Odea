import { type Result as IpcResult, commands } from "@/lib/bindings";
import { isTauri } from "@/lib/tauri";
import type { CalendarMarks, DayDoc, Goal, GoalHorizon, Task } from "./types";

/* ============================================================
   日程的后端：Rust 那一半的 6 个命令（src-tauri/src/plugins/journal/commands.rs）。
   浏览器预览里是 mock.ts（和核心的 data/mock.ts 共用一份假仓库）
   ============================================================ */

export interface JournalApi {
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
}

async function unwrap<T>(request: Promise<IpcResult<T, unknown>>): Promise<T> {
  const result = await request;
  if (result.status === "error") throw result.error;
  return result.data;
}

const tauriJournal: JournalApi = {
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
};

let resolved: JournalApi | null = null;

export async function journalApi(): Promise<JournalApi> {
  if (resolved) return resolved;
  // 动态引入：打包进桌面版时预览的那一份会被 tree-shake 掉
  resolved = isTauri ? tauriJournal : (await import("./mock")).journalMock;
  return resolved;
}
