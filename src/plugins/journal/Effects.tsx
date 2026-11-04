import { useApp } from "@/app/store";
import { backend } from "@/data/backend";
import { periodStartOf } from "@/lib/date";
import { useEffect } from "react";
import { journalSwitchNext } from "./JournalSwitcher";
import { startTodayTicker, useJournal } from "./store";
import { PAGES } from "./types";

/**
 * 日程开着时跟着主窗口挂着的那几件事（以前在 app/Shell.tsx 里）：零点翻页、按需取某一天和目标、
 * 日历记号、从别的仓库的窗口跳过来（日程切换器）、Ctrl+Alt+J
 */
export function JournalEffects() {
  const workspace = useApp((s) => s.workspace);
  const todayDate = useJournal((s) => s.todayDate);
  const selectedDate = useJournal((s) => s.selectedDate);
  const calendarScope = useJournal((s) => s.calendarScope);
  const goalHorizon = useJournal((s) => s.goalHorizon);

  // 零点翻页
  useEffect(() => startTodayTicker(), []);

  // 日历上的记号：开着日程就取一次（之后勾任务、别处改了带日期的任务时再取）
  useEffect(() => {
    void useJournal.getState().refreshMarks();
  }, []);

  // 今天这一篇一进应用就取：今日TODO 页渲染的就是它，而下面那个 effect 只管
  // 日历和 /GOAL，不给今日TODO 单独取。
  // /GOAL 这一期的目标也先取着：第一次点过去是现成的，不先空着一页「载入中…」、再换上正文。
  // 跨过零点后，昨天那份「延续来的」缓存不再作数（它从来不是昨天自己的内容）。
  useEffect(() => {
    const journal = useJournal.getState();
    journal.forgetCarriedDays(todayDate);
    void journal.loadDay(todayDate, true);
    const horizon = journal.goalHorizon;
    void journal.loadGoal(horizon, periodStartOf(horizon, todayDate));
  }, [todayDate]);

  // 日历：选中的那一天 / 那一天所在周期的目标；/GOAL：今天所在周期的目标
  useEffect(() => {
    const journal = useJournal.getState();
    if (workspace === "calendar") {
      if (calendarScope === "day") void journal.loadDay(selectedDate, selectedDate === todayDate);
      else void journal.loadGoal(calendarScope, periodStartOf(calendarScope, selectedDate));
    } else if (workspace === "goal") {
      void journal.loadGoal(goalHorizon, periodStartOf(goalHorizon, todayDate));
    }
  }, [calendarScope, goalHorizon, selectedDate, todayDate, workspace]);

  // 日程切换器（docs/协同编辑.md §22.6）：从别的仓库的窗口跳过来，翻到那一页那一天；Ctrl+Alt+J 轮着切。
  // 按 code 认 J：macOS 上按着 Option 时 key 是别的字
  useEffect(() => {
    const unlisten = backend().then((api) =>
      api.onVaultGoto((page, date) => {
        if (!(PAGES as string[]).includes(page)) return;
        useApp.getState().setWorkspace(page);
        if (page === "calendar") useJournal.getState().selectDate(date);
      }),
    );
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.code !== "KeyJ" || !e.altKey || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      void journalSwitchNext();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      void unlisten.then((stop) => stop());
    };
  }, []);

  return null;
}
