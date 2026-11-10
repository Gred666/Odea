// @vitest-environment happy-dom

import type { Backend } from "@/data/backend";
import type { Note, VaultChange } from "@/data/types";
import { fingerprint } from "@/lib/fingerprint";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JournalApi } from "./api";
import { DAY, type DayDoc, GOAL, JOURNAL } from "./types";

/* 日程插件接在数据层上：data/store 的 saveDocument / saveTitle / applyVaultChange / resolveConflict
   碰到某一天、目标时交给日程的 DocumentType，缓存在日程自己的 store 里 */

const api = {
  noteGet: vi.fn(),
  noteDelete: vi.fn(),
};

const journal = {
  calendarDay: vi.fn(),
  calendarDaySave: vi.fn(),
  calendarMarks: vi.fn(),
  goalGet: vi.fn(),
  goalSave: vi.fn(),
  taskToggle: vi.fn(),
};

vi.mock("@/data/backend", () => ({
  backend: async () => api as unknown as Backend,
}));
vi.mock("./api", () => ({
  journalApi: async () => journal as unknown as JournalApi,
}));

await import("@/plugins");
const { useData } = await import("@/data/store");
const { useJournal } = await import("./store");

const day = (noteMd: string, extra: Partial<DayDoc> = {}): DayDoc => ({
  date: "2026-08-29",
  title: "",
  tasks: [],
  noteMd,
  updatedAt: 1,
  carriedFrom: null,
  relPath: "日记/2026/2026-08-29.md",
  notUtf8: false,
  ...extra,
});

const note = (contentMd: string): Note => ({
  id: "n-1",
  title: "笔记",
  contentMd,
  excerpt: "",
  wordCount: 1,
  isPinned: false,
  isArchived: false,
  archiveCategory: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  relPath: "笔记/笔记.md",
  conflictOf: null,
  idInFile: true,
  notUtf8: false,
});

const today = { type: DAY, key: "2026-08-29" };
const week = { type: GOAL, key: "week:2026-08-24" };

const initialData = useData.getState();
const initialJournal = useJournal.getState();

beforeEach(() => {
  for (const fn of [...Object.values(api), ...Object.values(journal)]) fn.mockReset();
  useData.setState({
    ...initialData,
    notes: [],
    archived: [],
    bodies: {},
    savingDocs: new Set(),
    saveError: null,
    error: null,
    drafts: {},
    externalRevisions: {},
    undoable: null,
    // 日程开着（这个仓库的摆法）
    layout: { ...initialData.layout, plugins: [JOURNAL] },
  });
  useJournal.setState({ ...initialJournal });
  useJournal.getState().reset();
});

const change = (extra: Partial<VaultChange>): VaultChange => ({
  notes: [],
  docs: [],
  plugins: [],
  conflicts: [],
  foundCopies: [],
  folders: false,
  layout: false,
  ...extra,
});

describe("落在盘上、发给别的设备的 id 和老版本一字不差（docs/插件与跨端.md §6.1）", () => {
  it("索引里的 id：冲突副本的 conflictOf、记住看到哪的键", async () => {
    const { refOfId } = await import("@/plugins/registry");
    const { saveKeyOf } = await import("@/data/store");
    expect(refOfId("day:2026-10-07")).toEqual({ type: DAY, key: "2026-10-07" });
    expect(refOfId("goal:week:2026-09-21")).toEqual({ type: GOAL, key: "week:2026-09-21" });
    expect(refOfId("goal:year:2026-01-01")).toEqual({ type: GOAL, key: "year:2026-01-01" });
    // 长得不像的就当笔记 id
    expect(refOfId("day:昨天")).toEqual({ type: "note", key: "day:昨天" });
    expect(refOfId("goal:week:下周")).toEqual({ type: "note", key: "goal:week:下周" });
    expect(saveKeyOf(today)).toBe("day:2026-08-29");
    expect(saveKeyOf(week)).toBe("goal:week:2026-08-24");
  });

  it("团队里认同一篇的 id（0.7.0 和这一版在同一个团队仓库里要认出是同一篇）", async () => {
    const { teamDocId } = await import("@/team/store");
    const model = (target: { type: string; key: string }) => ({
      key: "k",
      title: "",
      bodyMd: "",
      statusParts: [],
      editor: { target, titleEditable: false },
    });
    expect(teamDocId(model({ type: DAY, key: "2026-10-22" }))).toBe("day-2026-10-22");
    expect(teamDocId(model({ type: GOAL, key: "week:2026-10-19" }))).toBe("goal-week-2026-10-19");
    expect(teamDocId(model({ type: GOAL, key: "month:2026-10-01" }))).toBe("goal-month-2026-10-01");
    expect(teamDocId(model({ type: GOAL, key: "year:2026-01-01" }))).toBe("goal-year-2026-01-01");
    // 文件不是 UTF-8 的只能看，不进团队的会话（docs/1110审查与研究.md §5.1）
    expect(teamDocId({ ...model({ type: DAY, key: "2026-10-23" }), notUtf8: true })).toBeNull();
  });

  it("冲突横幅里原文的名字：某一天按日期，目标按周期（和反向链接的出处一样）", async () => {
    const { conflictOriginalTitle, conflictOriginalContent } = await import("@/data/conflicts");
    const lists = { notes: [], archived: [] };
    expect(conflictOriginalTitle({ type: DAY, key: "2026-08-29" }, lists)).toBe("8月29日");
    expect(conflictOriginalTitle({ type: GOAL, key: "week:2026-09-21" }, lists)).toBe(
      "第 39 周目标",
    );
    useJournal.setState({ dayDocs: [day("- [x] 买菜")] });
    const docs = { ...lists, bodies: {} };
    expect(conflictOriginalContent(today, docs)).toBe("- [x] 买菜");
    expect(conflictOriginalContent({ type: DAY, key: "2026-08-30" }, docs)).toBeUndefined();
    expect(conflictOriginalContent(week, docs)).toBeUndefined();
  });
});

describe("存某一天、目标", () => {
  it("refuses to write a calendar day that has not loaded yet", async () => {
    // 这一天还没取回来时编辑器是空的。以前守卫写成 `source?.noteMd === contentMd`，
    // source 为 undefined 就直接放行，一输入就把当天原有的备注整篇覆盖。
    await useData.getState().saveDocument(today, "随手写一句");
    expect(journal.calendarDaySave).not.toHaveBeenCalled();
  });

  it("writes a calendar day once it is loaded", async () => {
    useJournal.setState({ dayDocs: [day("原有备注")] });
    journal.calendarDaySave.mockResolvedValue(day("新的备注"));

    await useData.getState().saveDocument(today, "新的备注");
    expect(journal.calendarDaySave).toHaveBeenCalledWith(
      "2026-08-29",
      "",
      "新的备注",
      fingerprint("原有备注"),
    );
    expect(useJournal.getState().dayDocs[0]?.noteMd).toBe("新的备注");
    // 保存中、草稿这些照旧按以前的键（day:日期）记在数据层
    expect(useData.getState().savingDocs.size).toBe(0);
  });

  it("saves a carried-over today under its own date, keeping the carried title", async () => {
    // 今天还没写过，内容是从 8/27 延续来的；第一次编辑就以今天的身份落库，
    // 标题跟着一起带过去，昨天那篇不动。
    useJournal.setState({
      dayDocs: [day("- [ ] 跑步", { title: "周四的 TODO", carriedFrom: "2026-08-27" })],
    });
    journal.calendarDaySave.mockResolvedValue(day("- [x] 跑步", { title: "周四的 TODO" }));

    await useData.getState().saveDocument(today, "- [x] 跑步");
    expect(journal.calendarDaySave).toHaveBeenCalledWith(
      "2026-08-29",
      "周四的 TODO",
      "- [x] 跑步",
      fingerprint("- [ ] 跑步"),
    );
    expect(useJournal.getState().dayDocs[0]?.carriedFrom).toBeNull();
    expect(useJournal.getState().marks.written.has("2026-08-29")).toBe(true);
  });

  it("refuses to write a goal period that has not loaded yet", async () => {
    await useData.getState().saveDocument(week, "本周");
    expect(journal.goalSave).not.toHaveBeenCalled();
  });

  it("writes a goal by its period and caches it under that key", async () => {
    const empty = {
      id: "",
      horizon: "week" as const,
      title: "",
      periodStart: "2026-08-24",
      contentMd: "",
      createdAt: 0,
      updatedAt: 0,
      relPath: "目标/2026/2026-W35.md",
      notUtf8: false,
    };
    useJournal.setState({ goals: { "week:2026-08-24": empty } });
    journal.goalSave.mockResolvedValue({ ...empty, id: "g1", contentMd: "本周", updatedAt: 5 });

    await useData.getState().saveDocument(week, "本周");
    expect(journal.goalSave).toHaveBeenCalledWith("week", "2026-08-24", "本周", fingerprint(""));
    expect(useJournal.getState().goals["week:2026-08-24"]?.id).toBe("g1");
  });

  it("keeps a day's new title when its body is saved right after", async () => {
    // 某一天的标题和正文在一个文件里一起写：两样排在同一条队里，后一个拿到的是前一个存完的那一版
    let open = () => {};
    const firstSave = new Promise<void>((resolve) => {
      open = resolve;
    });
    const saved = { title: "旧", noteMd: "旧正文" };
    useJournal.setState({ dayDocs: [day("旧正文", { title: "旧" })] });
    journal.calendarDaySave
      .mockImplementationOnce(async (_date: string, title: string, noteMd: string) => {
        await firstSave;
        Object.assign(saved, { title, noteMd });
        return day(noteMd, { title });
      })
      .mockImplementation(async (_date: string, title: string, noteMd: string) => {
        Object.assign(saved, { title, noteMd });
        return day(noteMd, { title });
      });

    const title = useData.getState().saveTitle(today, "新");
    const body = useData.getState().saveDocument(today, "新正文");
    open();
    await Promise.all([title, body]);
    expect(saved).toEqual({ title: "新", noteMd: "新正文" });
  });

  it("first-saves a carried-over today when only the title changes", async () => {
    useJournal.setState({
      dayDocs: [day("延续来的正文", { title: "旧标题", carriedFrom: "2026-08-27" })],
    });
    journal.calendarDaySave.mockResolvedValue(day("延续来的正文", { title: "新标题" }));

    await useData.getState().saveTitle(today, "  新标题 ");
    expect(journal.calendarDaySave).toHaveBeenCalledWith(
      "2026-08-29",
      "新标题",
      "延续来的正文",
      fingerprint("延续来的正文"),
    );
    expect(useJournal.getState().dayDocs[0]?.title).toBe("新标题");
  });

  it("ignores empty titles and goal targets", async () => {
    useJournal.setState({ dayDocs: [day("正文", { title: "标题" })] });
    await useData.getState().saveTitle(today, "   ");
    await useData.getState().saveTitle(week, "改不了");
    expect(journal.calendarDaySave).not.toHaveBeenCalled();
    expect(journal.goalSave).not.toHaveBeenCalled();
  });
});

describe("forgetCarriedDays", () => {
  it("drops carried-over docs but keeps real ones", () => {
    useJournal.setState({
      dayDocs: [
        day("真的", { date: "2026-08-27" }),
        day("延续的", { date: "2026-08-29", carriedFrom: "2026-08-27" }),
      ],
    });
    useJournal.getState().forgetCarriedDays("2026-08-29");
    expect(useJournal.getState().dayDocs.map((d) => d.date)).toEqual(["2026-08-27"]);
  });

  it("refetches the new today with carry-over when it was peeked at the day before", async () => {
    // 前一晚在日历里点开过明天：那时它不是今天，取回来的是一篇不延续的空白文档。
    // 过了零点它成了今天，得重新取一次才能延续前一天的内容。
    useJournal.setState({ dayDocs: [day("", { date: "2026-08-29" })] });
    journal.calendarDay.mockResolvedValue(
      day("- [ ] 跑步", { date: "2026-08-29", carriedFrom: "2026-08-28" }),
    );

    useJournal.getState().forgetCarriedDays("2026-08-29");
    await useJournal.getState().loadDay("2026-08-29", true);
    expect(journal.calendarDay).toHaveBeenCalledWith("2026-08-29", true);
    expect(useJournal.getState().dayDocs[0]?.carriedFrom).toBe("2026-08-28");
  });

  it("keeps the new today when it already has its own content", () => {
    useJournal.setState({ dayDocs: [day("自己写的", { date: "2026-08-29" })] });
    useJournal.getState().forgetCarriedDays("2026-08-29");
    expect(useJournal.getState().dayDocs).toHaveLength(1);
  });
});

describe("别处改了（applyVaultChange 交给日程）", () => {
  it("only refreshes the tasks of cached days when just the tasks changed", async () => {
    // 那一天的编辑器可能正有没存的修改：只是任务变了的话正文不能动
    useJournal.setState({ dayDocs: [day("编辑器里的正文")] });
    const task = {
      id: "n-1#2",
      title: "交稿",
      status: "todo" as const,
      meta: null,
      dueDate: "2026-08-29",
      timeLabel: null,
      category: null,
    };
    journal.calendarDay.mockResolvedValue(day("磁盘上的正文", { tasks: [task] }));
    journal.calendarMarks.mockResolvedValue({
      written: new Set(["2026-09-04"]),
      open: new Set(["2026-08-29"]),
    });

    await useData.getState().applyVaultChange(change({ plugins: [JOURNAL] }));
    const state = useJournal.getState();
    expect(state.dayDocs[0]?.noteMd).toBe("编辑器里的正文");
    expect(state.dayDocs[0]?.tasks).toEqual([task]);
    expect(state.tasks["n-1#2"]).toEqual(task);
    expect([...state.marks.open]).toEqual(["2026-08-29"]);
    expect([...state.marks.written]).toEqual(["2026-09-04"]);
  });

  it("leaves days and goals that were never opened alone", async () => {
    await useData.getState().applyVaultChange(change({ docs: [today, week] }));
    expect(journal.calendarDay).not.toHaveBeenCalled();
    expect(journal.goalGet).not.toHaveBeenCalled();
  });

  it("does nothing while the journal is off", async () => {
    useData.setState({ layout: { ...useData.getState().layout, plugins: [] } });
    useJournal.setState({ dayDocs: [day("本机的")] });
    await useData.getState().applyVaultChange(change({ docs: [today], plugins: [JOURNAL] }));
    expect(journal.calendarDay).not.toHaveBeenCalled();
  });

  it("a changed day replaces the editor's text and keeps the version from before", async () => {
    // 编辑器有没存的修改（markConflict）：下一次保存带的是外部改动之前那一版，后端留两份
    useJournal.setState({ dayDocs: [day("本机的")] });
    journal.calendarDay.mockResolvedValue(day("另一台的"));
    await useData.getState().applyVaultChange(change({ docs: [today] }));
    expect(useJournal.getState().dayDocs[0]?.noteMd).toBe("另一台的");
    // 外部改动的计数按以前的键记（编辑器、记住看到哪都认它）
    expect(useData.getState().externalRevisions["day:2026-08-29"]).toBe(1);

    journal.calendarDaySave.mockResolvedValue(day("编辑器里的"));
    useData.getState().markConflict(today);
    await useData.getState().saveDocument(today, "编辑器里的");
    expect(journal.calendarDaySave).toHaveBeenCalledWith(
      "2026-08-29",
      "",
      "编辑器里的",
      fingerprint("本机的"),
    );
  });
});

describe("resolveConflict（冲突副本的原文是某一天 / 目标）", () => {
  // 两台设备都改了今日TODO：副本「2026-08-29 (冲突 …)」落在「日记」里当一篇笔记
  const copyOf = (conflictOf: string, contentMd: string): Note => ({
    ...note(contentMd),
    id: "copy",
    title: "2026-08-29 (冲突 2026-08-29 1030)",
    relPath: "日记/2026/2026-08-29 (冲突 2026-08-29 1030).md",
    conflictOf,
  });
  const put = (copy: Note) => {
    const { contentMd, ...summary } = copy;
    useData.setState({ notes: [summary], bodies: { [copy.id]: contentMd } });
  };

  it("loads the day first, writes the copy's version into it, then deletes the copy", async () => {
    put(copyOf("day:2026-08-29", "- [x] 另一台的"));
    journal.calendarDay.mockResolvedValue(day("- [ ] 本机的", { title: "周六" }));
    journal.calendarDaySave.mockResolvedValue(day("- [x] 另一台的", { title: "周六" }));
    api.noteDelete.mockResolvedValue(undefined);

    const opened = await useData.getState().resolveConflict("copy", "copy");

    expect(opened).toEqual(today);
    // 当天的标题不动，只换正文
    expect(journal.calendarDaySave).toHaveBeenCalledWith(
      "2026-08-29",
      "周六",
      "- [x] 另一台的",
      fingerprint("- [ ] 本机的"),
    );
    expect(api.noteDelete).toHaveBeenCalledWith("copy");
    expect(useData.getState().notes).toEqual([]);
    expect(useData.getState().externalRevisions["day:2026-08-29"]).toBe(1);
  });

  it("keeping the original only deletes the copy", async () => {
    put(copyOf("goal:week:2026-09-21", "另一台的目标"));
    api.noteDelete.mockResolvedValue(undefined);

    const opened = await useData.getState().resolveConflict("copy", "original");

    expect(opened).toEqual({ type: GOAL, key: "week:2026-09-21" });
    expect(journal.goalGet).not.toHaveBeenCalled();
    expect(journal.goalSave).not.toHaveBeenCalled();
    expect(api.noteDelete).toHaveBeenCalledWith("copy");
  });
});

describe("勾当日安排里的一条", () => {
  it("rolls the check back when the file could not be written", async () => {
    const task = {
      id: "n-1#0",
      title: "交稿",
      status: "todo" as const,
      meta: null,
      dueDate: "2026-08-29",
      timeLabel: null,
      category: null,
    };
    useJournal.setState({ dayDocs: [day("", { tasks: [task] })], tasks: { [task.id]: task } });
    journal.taskToggle.mockRejectedValue({ kind: "Io", message: "磁盘只读" });

    await useJournal.getState().toggleTask(task.id);
    expect(useJournal.getState().dayDocs[0]?.tasks[0]?.status).toBe("todo");
    expect(useData.getState().error).toBe("磁盘只读");
  });
});
