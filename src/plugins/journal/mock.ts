import {
  type MockDoc,
  mockData,
  mockRecordVersion,
  mockSave,
  mockTick,
  registerMockDocs,
} from "@/data/mock";
import { periodStartOf } from "@/lib/date";
import type { JournalApi } from "./api";
import {
  DAY,
  GOAL,
  type Goal,
  type GoalHorizon,
  JOURNAL,
  type Task,
  dayTitle,
  goalKey,
  goalTitle,
} from "./types";

/* ============================================================
   日程在浏览器预览里的那一份（data/mock.ts 是核心的那一份，状态存在同一个 localStorage 里）。
   语义尽量贴近 Rust 实现；带日期的任务在这里是一份独立的列表，不从正文里解析
   ============================================================ */

interface JournalMock {
  tasks: Record<string, Task>;
  /** 按日期索引的某天文档（不含任务） */
  days: Record<string, { title: string; noteMd: string; updatedAt: number }>;
  /** 按 `horizon:periodStart` 索引的目标 */
  goals: Record<string, Goal>;
}

// 以前（P14.1 之前）这三样直接放在预览仓库的最外层：认过来
const data = mockData<JournalMock>(JOURNAL, (legacy) => ({
  tasks: (legacy.tasks as JournalMock["tasks"]) ?? {},
  days: (legacy.days as JournalMock["days"]) ?? {},
  goals: (legacy.goals as JournalMock["goals"]) ?? {},
}));

const dayRelPath = (date: string) => `日记/${date.slice(0, 4)}/${date}.md`;
const goalRelPath = (periodStart: string) => `目标/${periodStart.slice(0, 4)}/${periodStart}.md`;

const emptyGoal = (horizon: GoalHorizon, periodStart: string): Goal => ({
  id: "",
  horizon,
  title: "",
  periodStart,
  contentMd: "",
  createdAt: 0,
  updatedAt: 0,
  relPath: goalRelPath(periodStart),
});

/** 写过的某一天和目标，交给核心的预览仓库（搜索、反链、历史版本、改写双链都看它们） */
function docs(): MockDoc[] {
  const days = Object.entries(data.days).map(([date, day]) => ({
    ref: { type: DAY, key: date },
    relPath: dayRelPath(date),
    title: day.title ? `${dayTitle(date)} · ${day.title}` : dayTitle(date),
    updatedAt: day.updatedAt,
    written: !!(day.noteMd || day.title),
    historyKey: `day:${date}`,
    get: () => day.noteMd,
    set: (body: string) => {
      day.noteMd = body;
      day.updatedAt = Date.now();
      mockRecordVersion(`day:${date}`, body);
    },
  }));
  const goals = Object.entries(data.goals).map(([key, goal]) => ({
    ref: { type: GOAL, key },
    relPath: goalRelPath(goal.periodStart),
    title: goalTitle(goal.horizon, goal.periodStart),
    updatedAt: goal.updatedAt,
    written: !!goal.contentMd,
    historyKey: `goal:${key}`,
    get: () => goal.contentMd,
    set: (body: string) => {
      goal.contentMd = body;
      goal.updatedAt = Date.now();
      mockRecordVersion(`goal:${key}`, body);
    },
  }));
  return [...days, ...goals];
}

/** 插件装上时调（plugins/journal 的 loadMock） */
export function installJournalMock(): void {
  registerMockDocs({ plugin: JOURNAL, dirs: ["日记", "目标"], list: docs });
}

export const journalMock: JournalApi = {
  async taskToggle(id) {
    await mockTick();
    const task = data.tasks[id];
    if (!task) throw { kind: "NotFound", message: `task ${id}` };
    task.status = task.status === "done" ? "todo" : "done";
    mockSave();
    return { ...task };
  },

  /** 某个周期的目标；没写过就是一篇空文档，和 Rust 侧一样不落库 */
  async goalGet(horizon, periodStart): Promise<Goal> {
    await mockTick();
    if (periodStartOf(horizon, periodStart) !== periodStart) {
      throw { kind: "Invalid", message: `${periodStart} 不是 ${horizon} 周期的起点` };
    }
    const goal = data.goals[goalKey(horizon, periodStart)];
    return goal ? { ...goal, relPath: goalRelPath(periodStart) } : emptyGoal(horizon, periodStart);
  },

  async goalSave(horizon, periodStart, contentMd, _base): Promise<Goal> {
    await mockTick();
    const key = goalKey(horizon, periodStart);
    const now = Date.now();
    const current = data.goals[key];
    data.goals[key] = current
      ? { ...current, contentMd, updatedAt: now }
      : {
          ...emptyGoal(horizon, periodStart),
          id: crypto.randomUUID(),
          contentMd,
          createdAt: now,
          updatedAt: now,
        };
    mockRecordVersion(`goal:${key}`, contentMd);
    mockSave();
    return this.goalGet(horizon, periodStart);
  },

  /** carryOver：这一天没写过时延续之前最近写过的一天，不落库（和 Rust 侧一致） */
  async calendarDay(date, carryOver) {
    await mockTick();
    const tasks = Object.values(data.tasks).filter((task) => task.dueDate === date);
    const own = data.days[date];
    const relPath = dayRelPath(date);
    if (own) return { date, tasks, ...own, carriedFrom: null, relPath };

    const previous = carryOver
      ? Object.keys(data.days)
          .filter((d) => d < date && (data.days[d]!.noteMd || data.days[d]!.title))
          .sort()
          .pop()
      : undefined;
    if (previous) {
      return { date, tasks, ...data.days[previous]!, carriedFrom: previous, relPath };
    }
    return {
      date,
      title: "",
      tasks,
      noteMd: "",
      updatedAt: Date.now(),
      carriedFrom: null,
      relPath,
    };
  },

  async calendarDaySave(date, title, noteMd, _base) {
    await mockTick();
    data.days[date] = { title, noteMd, updatedAt: Date.now() };
    mockRecordVersion(`day:${date}`, noteMd);
    mockSave();
    return this.calendarDay(date, false);
  },

  async calendarMarks(from, to) {
    await mockTick();
    const inRange = (date: string) => date >= from && date <= to;
    const written = new Set<string>();
    const open = new Set<string>();
    for (const task of Object.values(data.tasks)) {
      if (!task.dueDate || !inRange(task.dueDate)) continue;
      (task.status === "done" ? written : open).add(task.dueDate);
    }
    for (const [date, day] of Object.entries(data.days))
      if ((day.noteMd || day.title) && inRange(date)) written.add(date);
    return { written, open };
  },
};
