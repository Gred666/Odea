import { useApp } from "@/app/store";
import { isMac } from "@/lib/platform";
import { type DocumentType, type Plugin, registerTemplates } from "@/plugins/registry";
import {
  Bell,
  CalendarCheck,
  CalendarDays,
  CalendarOff,
  Repeat,
  SquareCheckBig,
  Target,
} from "lucide-react";
import { CalendarPanel } from "./CalendarView";
import { JournalEffects } from "./Effects";
import { journalSwitchNext } from "./JournalSwitcher";
import { openReminderSettings } from "./ReminderSettings";
import { captureToToday } from "./capture";
import { useJournalDocument } from "./documents";
import { useJournal } from "./store";
import { TEMPLATES } from "./templates";
import { DAY, GOAL, JOURNAL, dayTitle, goalTitle, parseGoalKey } from "./types";

/* ============================================================
   日程（odea.journal）：今日TODO、目标、日历，第一个走公开贡献点的内置插件（docs/插件与跨端.md §10 的 P14.1）。
   Rust 那一半在 src-tauri/src/plugins/journal/：路径规则、带日期的任务、6 个命令。

   落在盘上、发给别的设备的字符串照老版本的写（§6.1）：团队里认同一篇用 `day-2026-11-03`、
   `goal-week-2026-11-02`，索引里的 id（冲突副本的 conflictOf、记住看到哪的键）是 `day:…`、`goal:…`，
   导航项的 id（本机记的「上次停在哪」）是 today / goal / calendar
   ============================================================ */

const GROUP = "日记与目标";

/** 某一天：key 是日期 `2026-11-03` */
const dayType: DocumentType = {
  id: DAY,
  plugin: JOURNAL,
  icon: CalendarDays,
  group: GROUP,
  idOf: (key) => `day:${key}`,
  keyOf: (id) => /^day:(\d{4}-\d{2}-\d{2})$/.exec(id)?.[1] ?? null,
  teamId: (key) => `day-${key}`,
  title: dayTitle,
  body: (key) => useJournal.getState().dayDocs.find((day) => day.date === key)?.noteMd,
  load: (key) => useJournal.getState().loadDay(key, key === useJournal.getState().todayDate),
  save: (key, contentMd, base) => useJournal.getState().saveDay(key, contentMd, base),
  rename: (key, title, base) => useJournal.getState().renameDay(key, title, base),
  // 今天的在「今日TODO」，别的在日历里
  open: (key) => {
    const app = useApp.getState();
    const journal = useJournal.getState();
    if (key === journal.todayDate) {
      app.setWorkspace("today");
    } else {
      journal.setCalendarScope("day");
      journal.selectDate(key);
      app.setWorkspace("calendar");
    }
    return `day-${key}`;
  },
};

/** 某个周期的目标：key 是 `week:2026-11-02` */
const goalType: DocumentType = {
  id: GOAL,
  plugin: JOURNAL,
  icon: Target,
  group: GROUP,
  idOf: (key) => `goal:${key}`,
  keyOf: (id) => /^goal:((?:week|month|year):\d{4}-\d{2}-\d{2})$/.exec(id)?.[1] ?? null,
  teamId: (key) => `goal-${key.replace(":", "-")}`,
  title: (key) => {
    const period = parseGoalKey(key);
    return period ? goalTitle(period.horizon, period.periodStart) : key;
  },
  body: (key) => useJournal.getState().goals[key]?.contentMd,
  load: async (key) => {
    const period = parseGoalKey(key);
    if (period) await useJournal.getState().loadGoal(period.horizon, period.periodStart);
  },
  save: (key, contentMd, base) => useJournal.getState().saveGoal(key, contentMd, base),
  // 在日历里：分段切到那个尺度，选中周期的第一天
  open: (key) => {
    const period = parseGoalKey(key);
    if (period) {
      const journal = useJournal.getState();
      journal.setCalendarScope(period.horizon);
      journal.selectDate(period.periodStart);
      useApp.getState().setWorkspace("calendar");
    }
    return `goal-${key}`;
  },
};

export const journalPlugin: Plugin = {
  id: JOURNAL,
  name: "日程",
  onByDefault: true,
  defaultDirs: ["日记", "目标"],
  documentTypes: [dayType, goalType],
  // 某一天、周 / 月 / 年的目标填的模板槽位（templates.ts）：L0 插件的模板能指定用在这几种上
  templateScopes: ["day", "week", "month", "year"],
  // 每个图标的「签名动作」跟图标画的那个物件对得上（components/Sidebar.tsx 的说明）
  nav: [
    {
      id: "today",
      plugin: JOURNAL,
      label: "今日TODO",
      icon: SquareCheckBig,
      order: 10,
      keywords: "today 今天 待办 todo",
      // 勾上一项：先按下去，再弹起来
      motion: {
        to: { scale: [1, 0.8, 1.14, 1], y: [0, 1.5, -1, 0], transition: { duration: 0.42 } },
        origin: "50% 60%",
      },
    },
    {
      id: "goal",
      plugin: JOURNAL,
      label: "/GOAL",
      icon: Target,
      order: 20,
      keywords: "goal 目标 周 月 年",
      // 命中靶心：先收后放
      motion: {
        to: { scale: [1, 0.78, 1.18, 1], transition: { duration: 0.44 } },
        origin: "50% 50%",
      },
    },
    {
      id: "calendar",
      plugin: JOURNAL,
      label: "日历",
      icon: CalendarDays,
      order: 30,
      keywords: "calendar 日期 某天",
      // 翻一页，轻轻跳一下
      motion: {
        to: { y: [0, -3.5, 0], scale: [1, 1.09, 1], transition: { duration: 0.4 } },
        origin: "50% 50%",
      },
      List: CalendarPanel,
    },
  ],
  useDocument: useJournalDocument,
  Effects: JournalEffects,
  // 日程切换器（docs/协同编辑.md §22.6）：团队的、个人的日程在不同的仓库里
  useCommands: () => [
    {
      id: "journal-switch",
      group: "跳转",
      icon: Repeat,
      label: "切换日程",
      hint: isMac ? "Ctrl+Option+J" : "Ctrl+Alt+J",
      keywords: "journal switch team personal 切换 日程 团队 个人 仓库 今日 todo 目标 日历",
      run: () => void journalSwitchNext(),
    },
    {
      id: "journal-reminders",
      group: "文件",
      icon: Bell,
      label: "提醒设置…",
      hint: "任务写了几点，到点弹通知、响一声；提前多久、用什么声音",
      keywords: "reminder notification alarm sound 提醒 通知 到点 闹钟 声音 提示音 提前 勿扰 ⏰",
      run: openReminderSettings,
    },
  ],
  toggle: {
    off: {
      label: "关闭日程",
      hint: "窄栏上不再有今日TODO、目标、日历，文件都留着",
      menuHint: "日记、目标的文件都留着",
      icon: CalendarOff,
    },
    on: {
      label: "启用日程",
      hint: "今日TODO、目标、日历；放在这个仓库的日记、目标文件夹里",
      menuHint: "今日TODO、目标、日历",
      icon: CalendarCheck,
    },
    keywords: "journal 日程 日记 今日 todo 目标 goal 日历 calendar 启用 开启 关闭 obsidian",
  },
  applyChange: (change) => useJournal.getState().applyChange(change),
  // 全局快捷键速记：记一行进今日TODO（capture.ts）
  capture: (text) => captureToToday(text),
  reset: () => useJournal.getState().reset(),
  // 后台把文件读完了：延续来的「今天」是按读了一半的索引找的「之前最近一天」，当日安排和记号也重取
  reindexed: () => {
    const journal = useJournal.getState();
    return journal.applyChange({
      notes: [],
      docs: journal.dayDocs
        .filter((day) => day.carriedFrom)
        .map((day) => ({ type: DAY, key: day.date })),
      plugins: [JOURNAL],
      conflicts: [],
      foundCopies: [],
      folders: false,
      layout: false,
    });
  },
  loadMock: async () => {
    (await import("./mock")).installJournalMock();
  },
};

// 日程那几套模板（某一天、周、月、年），按日期现算
registerTemplates(TEMPLATES);
