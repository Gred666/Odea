import { formatMonthDayCN, goalTitle } from "@/lib/date";
import {
  type DayDoc,
  type DocumentSaveTarget,
  type Goal,
  type GoalHorizon,
  type NoteSummary,
  goalKey,
} from "./types";

/* ============================================================
   冲突副本的原文（技术方案 §5.5、§5.9.5）。

   Note.conflictOf 是原文的 id：一般是另一篇笔记的 id；也可能是某一天（`day:2026-10-07`）
   或某个周期的目标（`goal:week:2026-09-21`）—— 两台设备都改了今日TODO 是同步里
   最常见的冲突，副本「2026-10-07 (冲突 …).md」的名字不是日期，落在「日记」里当一篇笔记。
   列表标题、冲突横幅、「用这一版替换原文」都从这里认原文。
   ============================================================ */

/** conflictOf → 原文是哪篇：打开它、往里保存都用这个 */
export function conflictTarget(conflictOf: string): DocumentSaveTarget {
  const day = /^day:(\d{4}-\d{2}-\d{2})$/.exec(conflictOf);
  if (day) return { kind: "day", id: day[1]! };
  const goal = /^goal:(week|month|year):(\d{4}-\d{2}-\d{2})$/.exec(conflictOf);
  if (goal) return { kind: "goal", horizon: goal[1] as GoalHorizon, periodStart: goal[2]! };
  return { kind: "note", id: conflictOf };
}

interface NoteLists {
  notes: NoteSummary[];
  archived: NoteSummary[];
}

interface Documents extends NoteLists {
  dayDocs: DayDoc[];
  goals: Record<string, Goal>;
  /** 留着的笔记正文（store 的 bodies） */
  bodies: Record<string, string>;
}

function findNote(lists: NoteLists, id: string): NoteSummary | undefined {
  return (
    lists.notes.find((note) => note.id === id) ?? lists.archived.find((note) => note.id === id)
  );
}

/**
 * 原文叫什么：笔记是它的标题，某一天「10月7日」，目标「第 39 周目标」（和反向链接的出处一样）。
 * 原文是笔记、但已经不在了：undefined
 */
export function conflictOriginalTitle(
  target: DocumentSaveTarget,
  lists: NoteLists,
): string | undefined {
  if (target.kind === "day") return formatMonthDayCN(target.id);
  if (target.kind === "goal") return goalTitle(target.horizon, target.periodStart);
  return findNote(lists, target.id)?.title;
}

/** 原文现在的正文。笔记的正文、某一天、目标都是按需取的（loadBody / loadDay / loadGoal），还没取回来时 undefined */
export function conflictOriginalContent(
  target: DocumentSaveTarget,
  docs: Documents,
): string | undefined {
  if (target.kind === "day") return docs.dayDocs.find((day) => day.date === target.id)?.noteMd;
  if (target.kind === "goal")
    return docs.goals[goalKey(target.horizon, target.periodStart)]?.contentMd;
  return findNote(docs, target.id) ? docs.bodies[target.id] : undefined;
}
