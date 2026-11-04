import { useApp } from "@/app/store";
import { markExternal, messageOf, useData } from "@/data/store";
import type { VaultChange } from "@/data/types";
import { type ISODate, today } from "@/lib/date";
import { create } from "zustand";
import { journalApi } from "./api";
import {
  type CalendarMarks,
  type CalendarScope,
  DAY,
  type DayDoc,
  GOAL,
  type Goal,
  type GoalHorizon,
  JOURNAL,
  type Task,
  goalKey,
  parseGoalKey,
} from "./types";

/* ============================================================
   日程的状态：今天、日历选中的那一天和分段、目标看哪个尺度（以前在 app/store），
   某一天 / 目标 / 带日期的任务 / 日历记号的缓存（以前在 data/store）。
   存正文的那条队、保存中、保存失败留下的草稿、外部改动的计数照旧在 data/store：
   它按 DocumentType 调这里的 saveDay / saveGoal（plugins/journal/index.ts）
   ============================================================ */

interface JournalState {
  /* ---- 界面 ---- */
  /**
   * 「今天」。放进 store 而不是每次 today() 现算：应用开着跨过零点时，
   * 今日TODO、日历上的今天标记都要跟着翻页，得有一个能触发重渲染的信号。
   * 由 startTodayTicker() 在每个零点刷新。
   */
  todayDate: ISODate;
  /** 日历选中的那一天。打开日历就是今天，不用每次手动定位 */
  selectedDate: ISODate;
  /** 日历右侧的分段：日TODO / 周·月·年 GOAL */
  calendarScope: CalendarScope;
  /** /GOAL 页看哪个尺度 */
  goalHorizon: GoalHorizon;
  selectDate: (date: ISODate) => void;
  setCalendarScope: (scope: CalendarScope) => void;
  setGoalHorizon: (horizon: GoalHorizon) => void;

  /* ---- 数据 ---- */
  /** 当日安排里的任务，按 id */
  tasks: Record<string, Task>;
  /** 按 `horizon:periodStart` 缓存的目标（见 goalKey）。没写过的周期也会缓存一篇空文档。 */
  goals: Record<string, Goal>;
  /**
   * 按日期缓存的某天文档。「今日TODO」就是今天这一篇 ——
   * 今天还没写过时后端会把之前最近一天延续过来（carriedFrom），用户一编辑才落库。
   */
  dayDocs: DayDoc[];
  /** 日历月网格上的记号：写过记录 / 做过事的日子，还有待办的日子 */
  marks: CalendarMarks;
  /** 重新取一次日历记号（勾了任务、别处改了带日期的任务） */
  refreshMarks: () => Promise<void>;
  /**
   * 取某一天的文档。`asToday` 为 true 时（这一天就是今天）允许延续之前最近的一天。
   * 已缓存的日期不重复取；今天的缓存如果还是延续来的、且又过了一天，会由 loadDay
   * 的调用方通过 todayDate 变化自然刷新。
   */
  loadDay: (date: ISODate, asToday?: boolean) => Promise<void>;
  /** 取某个周期的目标（没写过就是空文档）。已缓存的不重复取。 */
  loadGoal: (horizon: GoalHorizon, periodStart: ISODate) => Promise<void>;
  /**
   * 丢掉缓存里所有「延续来的」某天文档。跨过零点时调：昨天那份延续来的内容
   * 从来不是昨天自己的记录，留着的话翻回昨天会把它当成昨天写的。
   *
   * 新的今天如果缓存着一篇空白文档也一并丢掉：它是还没成为「今天」时取的
   * （比如前一晚在日历里点开过明天），当时没有尝试延续；留着的话 loadDay
   * 命中缓存，今日TODO 就一直是空白，不会延续前一天。
   */
  forgetCarriedDays: (today: ISODate) => void;
  toggleTask: (id: string) => Promise<void>;
  /** 存某一天的正文（DocumentType.save）。还没取回来返回 false */
  saveDay: (
    date: ISODate,
    contentMd: string,
    base: (current: string) => string | null,
  ) => Promise<boolean>;
  /** 改某一天的标题：标题和正文在一个文件里，和正文排在同一条队里（data/store 的 saveTitle） */
  renameDay: (
    date: ISODate,
    title: string,
    base: (current: string) => string | null,
  ) => Promise<void>;
  /** 存某个周期的目标 */
  saveGoal: (
    key: string,
    contentMd: string,
    base: (current: string) => string | null,
  ) => Promise<boolean>;
  /** 仓库里别处变了：某一天、目标、带日期的任务 */
  applyChange: (change: VaultChange) => Promise<void>;
  /** 开关了日程（摆法换了）：缓存都作废 */
  reset: () => void;
}

/** 日历记号取多大的范围：两个 Set 而已，一次取完比按月分页省事 */
const MARKS_FROM = "2000-01-01";
const MARKS_TO = "2100-12-31";

const isDone = (task: Task) => task.status === "done";

/** 某一天写没写过记录变了：只动 written，待办那一种等 refreshMarks */
function withWritten(marks: CalendarMarks, date: string, written: boolean): CalendarMarks {
  if (marks.written.has(date) === written) return marks;
  const next = new Set(marks.written);
  if (written) next.add(date);
  else next.delete(date);
  return { ...marks, written: next };
}

const withGoal = (goals: Record<string, Goal>, goal: Goal): Record<string, Goal> => ({
  ...goals,
  [goalKey(goal.horizon, goal.periodStart)]: goal,
});

const withDay = (days: DayDoc[], day: DayDoc): DayDoc[] => [
  ...days.filter((item) => item.date !== day.date),
  day,
];

/** 任务只出现在某一天的「当日安排」里 */
function patchTask(state: JournalState, id: string, task: Task): Partial<JournalState> {
  return {
    tasks: { ...state.tasks, [id]: task },
    dayDocs: state.dayDocs.map((day) => ({
      ...day,
      tasks: day.tasks.map((item) => (item.id === id ? task : item)),
    })),
  };
}

const showError = (error: unknown) => useData.setState({ error: messageOf(error) });

const empty = () => ({
  tasks: {},
  goals: {},
  dayDocs: [],
  marks: { written: new Set<ISODate>(), open: new Set<ISODate>() },
});

export const useJournal = create<JournalState>((set, get) => ({
  todayDate: today(),
  selectedDate: today(),
  calendarScope: "day",
  goalHorizon: "week",
  selectDate: (selectedDate) => {
    if (selectedDate === get().selectedDate) return;
    set({ selectedDate });
    // 日历里点到另一天：做客时共享的那一篇收起来（collab/store）
    useApp.getState().touchPage();
  },
  setCalendarScope: (calendarScope) => set({ calendarScope }),
  setGoalHorizon: (goalHorizon) => set({ goalHorizon }),

  ...empty(),

  refreshMarks: async () => {
    try {
      const marks = await (await journalApi()).calendarMarks(MARKS_FROM, MARKS_TO);
      set({ marks });
    } catch (error) {
      showError(error);
    }
  },

  loadDay: async (date, asToday = false) => {
    if (get().dayDocs.some((day) => day.date === date)) return;
    try {
      const day = await (await journalApi()).calendarDay(date, asToday);
      set((state) => ({
        dayDocs: withDay(state.dayDocs, day),
        tasks: {
          ...state.tasks,
          ...Object.fromEntries(day.tasks.map((task) => [task.id, task])),
        },
      }));
    } catch (error) {
      showError(error);
    }
  },

  loadGoal: async (horizon, periodStart) => {
    if (get().goals[goalKey(horizon, periodStart)]) return;
    try {
      const goal = await (await journalApi()).goalGet(horizon, periodStart);
      set((state) => ({ goals: withGoal(state.goals, goal) }));
    } catch (error) {
      showError(error);
    }
  },

  forgetCarriedDays: (today) =>
    set((state) => {
      const stale = (day: DayDoc) =>
        !!day.carriedFrom || (day.date === today && !day.title && !day.noteMd);
      return state.dayDocs.some(stale)
        ? { dayDocs: state.dayDocs.filter((day) => !stale(day)) }
        : {};
    }),

  toggleTask: async (id) => {
    const current = get().tasks[id];
    if (!current) return;
    const done = current.status === "done";
    const optimistic: Task = { ...current, status: done ? "todo" : "done" };
    set((state) => patchTask(state, id, optimistic));
    try {
      const saved = await (await journalApi()).taskToggle(id);
      set((state) => patchTask(state, id, saved));
      // 这一天还有没有没做完的：日历上的记号跟着变
      void get().refreshMarks();
    } catch (error) {
      set((state) => patchTask(state, id, current));
      showError(error);
    }
  },

  saveDay: async (date, contentMd, base) => {
    const source = get().dayDocs.find((day) => day.date === date);
    // 这一天还没加载完就别写。以前 `source?.noteMd === contentMd` 在
    // source 为 undefined 时不拦截，编辑器又是空的，
    // 于是一输入就把当天原有的备注整篇覆盖掉了。
    if (!source) return false;
    if (source.noteMd === contentMd) return true;
    // 延续来的今天：第一次编辑就带着延续来的标题一起，以今天的身份落库
    const updated = await (await journalApi()).calendarDaySave(
      date,
      source.title,
      contentMd,
      base(source.noteMd),
    );
    set((state) => ({
      dayDocs: withDay(state.dayDocs, updated),
      marks: withWritten(
        state.marks,
        date,
        !!(contentMd.trim() || updated.title || updated.tasks.some(isDone)),
      ),
    }));
    return true;
  },

  renameDay: async (date, title, base) => {
    const source = get().dayDocs.find((day) => day.date === date);
    if (!source || source.title === title) return;
    // 延续来的今天在这里第一次落库：正文照延续的存，标题换成新的
    const updated = await (await journalApi()).calendarDaySave(
      date,
      title,
      source.noteMd,
      base(source.noteMd),
    );
    set((state) => ({
      dayDocs: withDay(state.dayDocs, updated),
      marks: withWritten(state.marks, date, true),
    }));
  },

  saveGoal: async (key, contentMd, base) => {
    const period = parseGoalKey(key);
    const source = get().goals[key];
    // 这个周期还没取回来就别写：编辑器是空的，一输入会把已有的目标整篇覆盖
    if (!period || !source) return false;
    if (source.contentMd === contentMd) return true;
    const updated = await (await journalApi()).goalSave(
      period.horizon,
      period.periodStart,
      contentMd,
      base(source.contentMd),
    );
    set((state) => ({ goals: withGoal(state.goals, updated) }));
    return true;
  },

  applyChange: async (change) => {
    const api = await journalApi();
    const todayDate = today();
    const changedDays = change.docs.filter((doc) => doc.type === DAY).map((doc) => doc.key);
    const tasksChanged = change.plugins.includes(JOURNAL);
    // 只刷新缓存里有的：没打开过的那一天 / 周期，下次切过去时自然会取
    const days = new Set(
      changedDays.filter((date) => get().dayDocs.some((day) => day.date === date)),
    );
    if (tasksChanged) for (const day of get().dayDocs) days.add(day.date);
    for (const date of days) {
      try {
        const fresh = await api.calendarDay(date, date === todayDate);
        const contentChanged = changedDays.includes(date);
        const previous = get().dayDocs.find((day) => day.date === date);
        if (!previous) continue;
        // 只是任务变了：正文不动（编辑器那边可能正有没存的修改）
        const next = contentChanged ? fresh : { ...previous, tasks: fresh.tasks };
        set((state) => ({
          dayDocs: withDay(state.dayDocs, next),
          tasks: {
            ...state.tasks,
            ...Object.fromEntries(fresh.tasks.map((task) => [task.id, task])),
          },
        }));
        // 先换缓存、再告诉编辑器（data/store 的外部改动计数）：编辑器拿到的就是新正文
        if (contentChanged && previous.noteMd !== fresh.noteMd)
          markExternal({ type: DAY, key: date }, previous.noteMd);
      } catch (error) {
        showError(error);
      }
    }

    for (const doc of change.docs) {
      if (doc.type !== GOAL) continue;
      const period = parseGoalKey(doc.key);
      const previous = get().goals[doc.key];
      if (!period || !previous) continue;
      try {
        const fresh = await api.goalGet(period.horizon, period.periodStart);
        set((state) => ({ goals: withGoal(state.goals, fresh) }));
        if (previous.contentMd !== fresh.contentMd) markExternal(doc, previous.contentMd);
      } catch (error) {
        showError(error);
      }
    }

    if (tasksChanged) await get().refreshMarks();
  },

  reset: () => set(empty()),
}));

/**
 * 零点翻页：把 todayDate 刷成新的一天，并把日历上还停在昨天的选择带过去。
 * 用 setTimeout 对准下一个零点，而不是每分钟轮询；睡眠唤醒后 setTimeout
 * 可能晚点，所以醒来（visibilitychange）时再对一次表。
 */
export function startTodayTicker(): () => void {
  let timer = 0;

  const sync = () => {
    const now = today();
    const state = useJournal.getState();
    if (state.todayDate !== now) {
      const followed = state.selectedDate === state.todayDate;
      useJournal.setState({ todayDate: now, ...(followed ? { selectedDate: now } : {}) });
    }
    schedule();
  };

  const schedule = () => {
    window.clearTimeout(timer);
    const next = new Date();
    next.setHours(24, 0, 0, 500);
    timer = window.setTimeout(sync, Math.max(1000, next.getTime() - Date.now()));
  };

  const onVisible = () => {
    if (document.visibilityState === "visible") sync();
  };
  document.addEventListener("visibilitychange", onVisible);
  schedule();

  return () => {
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
