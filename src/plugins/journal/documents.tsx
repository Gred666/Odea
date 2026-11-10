import { useDraftOr } from "@/data/adapter";
import { NEW_NOTE_TITLE } from "@/data/store";
import type { DocumentModel, TemplateContext } from "@/data/types";
import {
  type ISODate,
  formatDayEyebrowCN,
  formatMonthDayCN,
  formatPeriodCN,
  formatRelativeTime,
  periodStartOf,
} from "@/lib/date";
import { DayTasks } from "./DayTasks";
import { JournalSwitcher } from "./JournalSwitcher";
import { useJournal } from "./store";
import { scopeLabel, templatePlaceholder } from "./templates";
import {
  type CalendarScope,
  DAY,
  type DayDoc,
  GOAL,
  type Goal,
  type GoalHorizon,
  goalKey,
  goalTitle,
} from "./types";

/* ============================================================
   日程的三页显示哪一篇（文档槽位，docs/插件与跨端.md §5.6）。以前是 data/adapter.ts 里那个 switch 的三支。

   日历和今日TODO、GOAL 的关系：
   - 今日TODO = 今天这一天的文档；日历里点到今天看到的就是同一篇。
   - 今天还没写过时延续之前最近的一天（carriedFrom），一编辑就以今天落库；
     翻到昨天、前天，看到的是那一天自己的内容。
   - GOAL 一个周期一篇：/GOAL 页看今天所在的周 / 月 / 年，日历的
     周·月·年 看选中日期所在的周期；没写过就是空白。
   ============================================================ */

/** 正文区显示哪一篇：日程的三页之一，不是日程的页返回 null（每次渲染都要调，见 registry 的 useDocument） */
export function useJournalDocument(page: string): DocumentModel | null {
  const todayDate = useJournal((s) => s.todayDate);
  const selectedDate = useJournal((s) => s.selectedDate);
  const calendarScope = useJournal((s) => s.calendarScope);
  const goalHorizon = useJournal((s) => s.goalHorizon);
  const goals = useJournal((s) => s.goals);
  const dayDocs = useJournal((s) => s.dayDocs);
  // 保存失败、还没落盘的正文优先于库里的版本：切走再切回来，用户写的东西还在
  const draftOr = useDraftOr();

  switch (page) {
    /* ---------------- 今日 TODO：就是今天这一天 ---------------- */
    case "today": {
      const day = dayDocs.find((d) => d.date === todayDate);
      return dayDocument(todayDate, day, todayDate, undefined, draftOr);
    }

    /* ---------------- /GOAL：今天所在的周期 ---------------- */
    case "goal": {
      const periodStart = periodStartOf(goalHorizon, todayDate);
      const goal = goals[goalKey(goalHorizon, periodStart)];
      return goalDocument(
        goalHorizon,
        periodStart,
        goal,
        todayDate,
        {
          group: "goal",
          options: ["周", "月", "年"],
          active: horizonLabel(goalHorizon),
          onChange: (value) => useJournal.getState().setGoalHorizon(labelToHorizon(value)),
        },
        draftOr,
      );
    }

    /* ---------------- 日历 ---------------- */
    case "calendar": {
      const segments = {
        group: "calendar",
        options: ["日TODO", "周/GOAL", "月/GOAL", "年/GOAL"],
        short: ["日", "周", "月", "年"],
        active: scopeOptionLabel(calendarScope),
        onChange: (value: string) => useJournal.getState().setCalendarScope(labelToScope(value)),
      };

      // 分段切到周/月/年：选中日期所在周期的 GOAL
      if (calendarScope !== "day") {
        const periodStart = periodStartOf(calendarScope, selectedDate);
        const goal = goals[goalKey(calendarScope, periodStart)];
        return goalDocument(calendarScope, periodStart, goal, todayDate, segments, draftOr);
      }

      const day = dayDocs.find((d) => d.date === selectedDate);
      return dayDocument(selectedDate, day, todayDate, segments, draftOr);
    }

    default:
      return null;
  }
}

/** 有草稿就用草稿，没有就用库里的正文 */
type DraftOr = ReturnType<typeof useDraftOr>;

/**
 * 某一天的文档。`day` 还没取回来之前不给编辑器 —— 否则它会以空文档挂载，
 * 用户在空白页上一输入就把当天原有的内容覆盖掉。
 */
function dayDocument(
  date: ISODate,
  day: DayDoc | undefined,
  todayDate: ISODate,
  segments: DocumentModel["segments"],
  draftOr: DraftOr,
): DocumentModel {
  const tasks = day?.tasks ?? [];
  const isToday = date === todayDate;
  const target = { type: DAY, key: date };

  const statusParts: string[] = [];
  if (!day) statusParts.push("载入中…");
  else {
    if (tasks.length) statusParts.push(`${tasks.length} 项安排`);
    if (day.carriedFrom) {
      statusParts.push(`延续自 ${formatMonthDayCN(day.carriedFrom)}，还没有今天自己的记录`);
    } else if (!day.title && !day.noteMd) {
      statusParts.push("这一天还没有记录");
    } else {
      statusParts.push(`上次更新 ${formatRelativeTime(day.updatedAt)}`);
    }
    if (isToday && !day.carriedFrom) statusParts.push("今天的内容会延续到明天，直到你改动它");
  }

  return {
    key: `day-${date}`,
    // 空标题显示占位；标题栏是可编辑的，和笔记一样
    title: day?.title || NEW_NOTE_TITLE,
    eyebrow: isToday ? `今天 · ${formatDayEyebrowCN(date)}` : formatDayEyebrowCN(date),
    // 日程切换器（docs/协同编辑.md §22.6）：开着日程的仓库有两个以上时才露出来
    eyebrowAccessory: <JournalSwitcher />,
    segments,
    bodyMd: day ? draftOr(target, day.noteMd) : "",
    relPath: day?.relPath,
    // 当日安排：别的文档里写着这一天的任务，列在正文后面
    afterBody: tasks.length ? <DayTasks tasks={tasks} /> : undefined,
    templates: templatesOf("day", date, todayDate),
    statusParts,
    // 文件不是 UTF-8：只能看，横幅里能转（EncodingBanner）
    notUtf8: day?.notUtf8,
    editor: day ? { target, titleEditable: !day.notUtf8 } : undefined,
  };
}

/** 某个周期的目标。标题由周期算出来，不可编辑；没写过就是空白编辑器。 */
function goalDocument(
  horizon: GoalHorizon,
  periodStart: ISODate,
  goal: Goal | undefined,
  todayDate: ISODate,
  segments: DocumentModel["segments"],
  draftOr: DraftOr,
): DocumentModel {
  const target = { type: GOAL, key: goalKey(horizon, periodStart) };
  const statusParts: string[] = [formatPeriodCN(horizon, periodStart)];
  if (!goal) statusParts.push("载入中…");
  else if (goal.updatedAt === 0) statusParts.push("这个周期还没写过目标");
  else
    statusParts.push(
      `${countGoalWords(goal.contentMd)} 字`,
      `上次更新 ${formatRelativeTime(goal.updatedAt)}`,
    );

  return {
    key: `goal-${goalKey(horizon, periodStart)}`,
    title: goalTitle(horizon, periodStart),
    segments,
    bodyMd: goal ? draftOr(target, goal.contentMd) : "",
    relPath: goal?.relPath,
    templates: templatesOf(horizon, periodStart, todayDate),
    statusParts,
    notUtf8: goal?.notUtf8,
    editor: goal ? { target } : undefined,
  };
}

/** 某一天 / 某个周期的文档能用 `/模板`（plugins/journal/templates.ts） */
function templatesOf(scope: CalendarScope, date: ISODate, today: ISODate): TemplateContext {
  const context = { scope, date, today, label: "", placeholder: templatePlaceholder(scope) };
  return { ...context, label: scopeLabel(context) };
}

function horizonLabel(h: GoalHorizon): string {
  return h === "week" ? "周" : h === "month" ? "月" : "年";
}

export function labelToHorizon(l: string): GoalHorizon {
  return l === "月" ? "month" : l === "年" ? "year" : "week";
}

function scopeOptionLabel(s: CalendarScope): string {
  return s === "day" ? "日TODO" : s === "week" ? "周/GOAL" : s === "month" ? "月/GOAL" : "年/GOAL";
}

export function labelToScope(l: string): CalendarScope {
  return l === "周/GOAL" ? "week" : l === "月/GOAL" ? "month" : l === "年/GOAL" ? "year" : "day";
}

/** GOAL 文档没有预存字数，实时算一下 */
function countGoalWords(md: string): number {
  const cjk = (md.match(/[一-龥]/g) ?? []).length;
  const en = (md.match(/[a-zA-Z0-9]+/g) ?? []).length;
  return cjk + en;
}
