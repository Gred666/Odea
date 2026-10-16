// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "./backend";
import type { DayDoc, IndexProgress, Note, NoteSummary, VaultChange } from "./types";

const api = {
  calendarDay: vi.fn(),
  calendarDaySave: vi.fn(),
  calendarMarks: vi.fn(),
  goalGet: vi.fn(),
  goalSave: vi.fn(),
  noteUpsert: vi.fn(),
  noteGet: vi.fn(),
  noteList: vi.fn(),
  noteDelete: vi.fn(),
  noteUndelete: vi.fn(),
  noteArchive: vi.fn(),
  noteRestore: vi.fn(),
  noteCreate: vi.fn(),
  taskToggle: vi.fn(),
  noteMove: vi.fn(),
  folderList: vi.fn(),
  folderCreate: vi.fn(),
  folderRename: vi.fn(),
  folderDelete: vi.fn(),
  folderUndelete: vi.fn(),
  onVaultChanged: vi.fn(),
  onSyncStatus: vi.fn(),
  onSyncNotice: vi.fn(),
  syncStatus: vi.fn(),
  vaultKeepConflictCopy: vi.fn(),
  vaultReveal: vi.fn(),
  guidePending: vi.fn(),
  guideSettle: vi.fn(),
  guideOpen: vi.fn(),
  onUpdateReady: vi.fn(),
  updateStatus: vi.fn(),
  appUpgrade: vi.fn(),
  indexProgress: vi.fn(),
  onIndexProgress: vi.fn(),
};

vi.mock("./backend", () => ({
  backend: async () => api as unknown as Backend,
}));

const { useData } = await import("./store");

const day = (noteMd: string, extra: Partial<DayDoc> = {}): DayDoc => ({
  date: "2026-08-29",
  title: "",
  tasks: [],
  noteMd,
  updatedAt: 1,
  carriedFrom: null,
  relPath: "日记/2026/2026-08-29.md",
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
});

const initial = useData.getState();

const summary = ({ contentMd: _body, ...rest }: Note): NoteSummary => rest;

/**
 * 放进 store，和 initialize / loadBody 之后一样：列表里是摘要，正文在 bodies。
 * 测试里的笔记写成整篇（带 contentMd）好读
 */
function put(
  state: { notes?: Note[]; archived?: Note[] } & Omit<
    Partial<ReturnType<typeof useData.getState>>,
    "notes" | "archived"
  >,
) {
  const { notes, archived, ...rest } = state;
  const all = [...(notes ?? []), ...(archived ?? [])];
  useData.setState({
    ...rest,
    ...(notes ? { notes: notes.map(summary) } : {}),
    ...(archived ? { archived: archived.map(summary) } : {}),
    bodies: {
      ...useData.getState().bodies,
      ...Object.fromEntries(all.map((n) => [n.id, n.contentMd])),
    },
  });
}

/** store 订阅的后台读文件进度（只订阅一次，哪个测试先 initialize 就在那时记下） */
let progress: ((progress: IndexProgress) => void) | null = null;

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.onIndexProgress.mockImplementation(async (listener: (progress: IndexProgress) => void) => {
    progress = listener;
    return () => {};
  });
  useData.setState({
    ...initial,
    notes: [],
    archived: [],
    bodies: {},
    dayDocs: [],
    goals: {},
    savingDocs: new Set(),
    saveError: null,
    error: null,
    notice: null,
    drafts: {},
    externalRevisions: {},
    conflicts: new Set(),
    marks: { written: new Set(), open: new Set() },
    guideUpdates: [],
    undoable: null,
  });
});

const change = (extra: Partial<VaultChange>): VaultChange => ({
  notes: [],
  days: [],
  goals: [],
  tasks: false,
  conflicts: [],
  foundCopies: [],
  folders: false,
  ...extra,
});

describe("saveDocument", () => {
  it("refuses to write a calendar day that has not loaded yet", async () => {
    // 这一天还没取回来时编辑器是空的。以前守卫写成 `source?.noteMd === contentMd`，
    // source 为 undefined 就直接放行，一输入就把当天原有的备注整篇覆盖。
    await useData.getState().saveDocument({ kind: "day", id: "2026-08-29" }, "随手写一句");
    expect(api.calendarDaySave).not.toHaveBeenCalled();
  });

  it("writes a calendar day once it is loaded", async () => {
    put({ dayDocs: [day("原有备注")] });
    api.calendarDaySave.mockResolvedValue(day("新的备注"));

    await useData.getState().saveDocument({ kind: "day", id: "2026-08-29" }, "新的备注");
    expect(api.calendarDaySave).toHaveBeenCalledWith("2026-08-29", "", "新的备注");
    expect(useData.getState().dayDocs[0]?.noteMd).toBe("新的备注");
  });

  it("saves a carried-over today under its own date, keeping the carried title", async () => {
    // 今天还没写过，内容是从 8/27 延续来的；第一次编辑就以今天的身份落库，
    // 标题跟着一起带过去，昨天那篇不动。
    put({
      dayDocs: [day("- [ ] 跑步", { title: "周四的 TODO", carriedFrom: "2026-08-27" })],
    });
    api.calendarDaySave.mockResolvedValue(day("- [x] 跑步", { title: "周四的 TODO" }));

    await useData.getState().saveDocument({ kind: "day", id: "2026-08-29" }, "- [x] 跑步");
    expect(api.calendarDaySave).toHaveBeenCalledWith("2026-08-29", "周四的 TODO", "- [x] 跑步");
    expect(useData.getState().dayDocs[0]?.carriedFrom).toBeNull();
    expect(useData.getState().marks.written.has("2026-08-29")).toBe(true);
  });

  it("refuses to write a goal period that has not loaded yet", async () => {
    await useData
      .getState()
      .saveDocument({ kind: "goal", horizon: "week", periodStart: "2026-08-24" }, "本周");
    expect(api.goalSave).not.toHaveBeenCalled();
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
    };
    put({ goals: { "week:2026-08-24": empty } });
    api.goalSave.mockResolvedValue({ ...empty, id: "g1", contentMd: "本周", updatedAt: 5 });

    await useData
      .getState()
      .saveDocument({ kind: "goal", horizon: "week", periodStart: "2026-08-24" }, "本周");
    expect(api.goalSave).toHaveBeenCalledWith("week", "2026-08-24", "本周");
    expect(useData.getState().goals["week:2026-08-24"]?.id).toBe("g1");
  });

  it("keeps the note list order stable while typing", async () => {
    // 自动保存每 400ms 刷新一次 updatedAt；按它重排会让正在编辑的笔记
    // 在侧栏里当着用户的面往上跳。
    const older = { ...note("甲"), id: "n-old", updatedAt: 1 };
    const newer = { ...note("乙"), id: "n-new", updatedAt: 9 };
    put({ notes: [newer, older] });
    api.noteUpsert.mockResolvedValue("n-old");
    api.noteGet.mockResolvedValue({ ...older, contentMd: "甲甲", updatedAt: 99 });

    await useData.getState().saveDocument({ kind: "note", id: "n-old" }, "甲甲");
    expect(useData.getState().notes.map((item) => item.id)).toEqual(["n-new", "n-old"]);
  });

  it("surfaces a failed save instead of swallowing it", async () => {
    put({ notes: [note("原文")] });
    api.noteUpsert.mockRejectedValue(new Error("磁盘只读"));

    await expect(
      useData.getState().saveDocument({ kind: "note", id: "n-1" }, "新文"),
    ).rejects.toThrow("磁盘只读");
    expect(useData.getState().saveError).toEqual({ key: "note:n-1", message: "磁盘只读" });
    // 失败也要把「保存中」清掉，否则状态栏会一直卡在保存中。
    expect(useData.getState().savingDocs.size).toBe(0);
  });

  it("clears a stale error after the next successful save", async () => {
    put({
      notes: [note("原文")],
      saveError: { key: "note:n-1", message: "磁盘只读" },
    });
    api.noteUpsert.mockResolvedValue("n-1");
    api.noteGet.mockResolvedValue(note("新文"));

    await useData.getState().saveDocument({ kind: "note", id: "n-1" }, "新文");
    expect(useData.getState().saveError).toBeNull();
  });
});

describe("saveDocument / saveTitle 排队", () => {
  /** 可以手动放行的 promise */
  const gate = <T>() => {
    let open: (value: T) => void = () => {};
    const promise = new Promise<T>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  };

  it("does not let a body save overwrite a title saved just before it", async () => {
    // 标题改完失焦就存，正文 400ms 后自动保存；两次都写整篇。以前两次同时在路上时，
    // 正文那次带的是旧标题，后落库就把新标题覆盖回去了。
    const saved = { title: "旧标题", contentMd: "旧正文" };
    put({ notes: [{ ...note("旧正文"), title: "旧标题" }] });
    const firstUpsert = gate<string>();
    api.noteUpsert
      .mockImplementationOnce(async (input: { title: string; contentMd: string }) => {
        await firstUpsert.promise;
        Object.assign(saved, input);
        return "n-1";
      })
      .mockImplementation(async (input: { title: string; contentMd: string }) => {
        Object.assign(saved, input);
        return "n-1";
      });
    api.noteGet.mockImplementation(async () => ({ ...note(saved.contentMd), title: saved.title }));

    const title = useData.getState().saveTitle({ kind: "note", id: "n-1" }, "新标题");
    const body = useData.getState().saveDocument({ kind: "note", id: "n-1" }, "新正文");
    firstUpsert.open("n-1");
    await Promise.all([title, body]);

    expect(saved).toMatchObject({ title: "新标题", contentMd: "新正文" });
    expect(api.noteUpsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "新标题", contentMd: "新正文" }),
    );
    expect(useData.getState().notes[0]?.title).toBe("新标题");
    expect(useData.getState().bodies["n-1"]).toBe("新正文");
  });

  it("keeps a day's new title when its body is saved right after", async () => {
    const saved = { title: "旧", noteMd: "旧正文" };
    put({ dayDocs: [day("旧正文", { title: "旧" })] });
    const firstSave = gate<void>();
    api.calendarDaySave
      .mockImplementationOnce(async (_date: string, title: string, noteMd: string) => {
        await firstSave.promise;
        Object.assign(saved, { title, noteMd });
        return day(noteMd, { title });
      })
      .mockImplementation(async (_date: string, title: string, noteMd: string) => {
        Object.assign(saved, { title, noteMd });
        return day(noteMd, { title });
      });

    const title = useData.getState().saveTitle({ kind: "day", id: "2026-08-29" }, "新");
    const body = useData.getState().saveDocument({ kind: "day", id: "2026-08-29" }, "新正文");
    firstSave.open();
    await Promise.all([title, body]);
    expect(saved).toEqual({ title: "新", noteMd: "新正文" });
  });

  it("keeps going after a failed write", async () => {
    put({ notes: [note("原文")] });
    api.noteUpsert.mockRejectedValueOnce(new Error("磁盘只读")).mockResolvedValue("n-1");
    api.noteGet.mockResolvedValue(note("第二版"));

    const first = useData.getState().saveDocument({ kind: "note", id: "n-1" }, "第一版");
    const second = useData.getState().saveDocument({ kind: "note", id: "n-1" }, "第二版");
    await expect(first).rejects.toThrow("磁盘只读");
    await second;
    expect(useData.getState().bodies["n-1"]).toBe("第二版");
    expect(useData.getState().saveError).toBeNull();
  });
});

describe("saveError 按文档区分", () => {
  it("a success on another document does not clear this one's error", async () => {
    const other = { ...note("乙"), id: "n-2" };
    put({
      notes: [note("甲"), other],
      saveError: { key: "note:n-1", message: "磁盘只读" },
    });
    api.noteUpsert.mockResolvedValue("n-2");
    api.noteGet.mockResolvedValue({ ...other, contentMd: "乙乙" });

    await useData.getState().saveDocument({ kind: "note", id: "n-2" }, "乙乙");
    expect(useData.getState().saveError).toEqual({ key: "note:n-1", message: "磁盘只读" });
  });

  it("a failed title save is reported on that document, not as a global error", async () => {
    put({ notes: [note("甲")] });
    api.noteUpsert.mockRejectedValue(new Error("磁盘只读"));

    await expect(
      useData.getState().saveTitle({ kind: "note", id: "n-1" }, "新标题"),
    ).rejects.toThrow("磁盘只读");
    expect(useData.getState().saveError).toEqual({ key: "note:n-1", message: "磁盘只读" });
    expect(useData.getState().error).toBeNull();
  });
});

describe("saveTitle", () => {
  it("first-saves a carried-over today when only the title changes", async () => {
    put({
      dayDocs: [day("延续来的正文", { title: "旧标题", carriedFrom: "2026-08-27" })],
    });
    api.calendarDaySave.mockResolvedValue(day("延续来的正文", { title: "新标题" }));

    await useData.getState().saveTitle({ kind: "day", id: "2026-08-29" }, "  新标题 ");
    expect(api.calendarDaySave).toHaveBeenCalledWith("2026-08-29", "新标题", "延续来的正文");
    expect(useData.getState().dayDocs[0]?.title).toBe("新标题");
  });

  it("ignores empty titles and goal targets", async () => {
    put({ dayDocs: [day("正文", { title: "标题" })] });
    await useData.getState().saveTitle({ kind: "day", id: "2026-08-29" }, "   ");
    await useData
      .getState()
      .saveTitle({ kind: "goal", horizon: "week", periodStart: "2026-08-24" }, "改不了");
    expect(api.calendarDaySave).not.toHaveBeenCalled();
    expect(api.goalSave).not.toHaveBeenCalled();
  });
});

describe("forgetCarriedDays", () => {
  it("drops carried-over docs but keeps real ones", () => {
    put({
      dayDocs: [
        day("真的", { date: "2026-08-27" }),
        day("延续的", { date: "2026-08-29", carriedFrom: "2026-08-27" }),
      ],
    });
    useData.getState().forgetCarriedDays("2026-08-29");
    expect(useData.getState().dayDocs.map((d) => d.date)).toEqual(["2026-08-27"]);
  });

  it("refetches the new today with carry-over when it was peeked at the day before", async () => {
    // 前一晚在日历里点开过明天：那时它不是今天，取回来的是一篇不延续的空白文档。
    // 过了零点它成了今天，得重新取一次才能延续前一天的内容。
    put({ dayDocs: [day("", { date: "2026-08-29" })] });
    api.calendarDay.mockResolvedValue(
      day("- [ ] 跑步", { date: "2026-08-29", carriedFrom: "2026-08-28" }),
    );

    useData.getState().forgetCarriedDays("2026-08-29");
    await useData.getState().loadDay("2026-08-29", true);
    expect(api.calendarDay).toHaveBeenCalledWith("2026-08-29", true);
    expect(useData.getState().dayDocs[0]?.carriedFrom).toBe("2026-08-28");
  });

  it("keeps the new today when it already has its own content", () => {
    put({ dayDocs: [day("自己写的", { date: "2026-08-29" })] });
    useData.getState().forgetCarriedDays("2026-08-29");
    expect(useData.getState().dayDocs).toHaveLength(1);
  });
});

describe("initialize", () => {
  it("loads the lists without bodies, and only the body that is on screen", async () => {
    const notes = [1, 2, 3].map((n) => ({ ...note(`正文${n}`), id: `n-${n}` }));
    api.noteList.mockImplementation(async (archived: boolean) =>
      archived ? [] : notes.map(summary),
    );
    api.noteGet.mockImplementation(async (id: string) => notes.find((item) => item.id === id));
    api.calendarMarks.mockResolvedValue({ written: new Set(), open: new Set() });

    await useData.getState().initialize();
    expect(api.noteList).toHaveBeenCalledTimes(2);
    // 没有上次停在哪的记录：正文显示列表第一篇，只取它
    expect(api.noteGet).toHaveBeenCalledTimes(1);
    expect(useData.getState().notes.map((item) => item.id)).toEqual(["n-1", "n-2", "n-3"]);
    expect(useData.getState().bodies).toEqual({ "n-1": "正文1" });
  });
});

describe("loadBody", () => {
  it("fetches a body once, even when asked twice at the same time", async () => {
    put({ notes: [] });
    api.noteGet.mockResolvedValue({ ...note("正文"), id: "n-9" });
    const [a, b] = await Promise.all([
      useData.getState().loadBody("n-9"),
      useData.getState().loadBody("n-9"),
    ]);
    expect(a).toBe("正文");
    expect(b).toBe("正文");
    expect(api.noteGet).toHaveBeenCalledTimes(1);
    // 已经有了就不再取
    expect(await useData.getState().loadBody("n-9")).toBe("正文");
    expect(api.noteGet).toHaveBeenCalledTimes(1);
  });

  it("keeps only the most recent bodies", async () => {
    api.noteGet.mockImplementation(async (id: string) => ({ ...note(`正文${id}`), id }));
    for (let i = 0; i < 40; i++) await useData.getState().loadBody(`n-${i}`);
    const kept = Object.keys(useData.getState().bodies);
    expect(kept.length).toBeLessThanOrEqual(24);
    expect(kept).toContain("n-39");
    expect(kept).not.toContain("n-0");
  });

  it("returns undefined for a note that is gone, without an error", async () => {
    api.noteGet.mockRejectedValue({ kind: "NotFound", message: "note x" });
    expect(await useData.getState().loadBody("x")).toBeUndefined();
    expect(useData.getState().error).toBeNull();
  });
});

describe("后台读文件进索引", () => {
  const listed = (...ids: string[]) => ids.map((id) => ({ ...note(`正文${id}`), id }));

  it("shows how far it got and reloads the lists once everything is read", async () => {
    api.noteList.mockImplementation(async (archived: boolean) => (archived ? [] : listed("a")));
    api.calendarMarks.mockResolvedValue({ written: new Set(), open: new Set() });
    api.indexProgress.mockResolvedValue({ done: 40, total: 300 });
    await useData.getState().initialize();
    expect(useData.getState().indexing).toEqual({ done: 40, total: 300 });

    progress?.({ done: 120, total: 300 });
    expect(useData.getState().indexing).toEqual({ done: 120, total: 300 });

    api.noteList.mockImplementation(async (archived: boolean) =>
      archived ? [] : listed("a", "b"),
    );
    api.folderList.mockResolvedValue(["工作"]);
    api.guidePending.mockResolvedValue([]);
    progress?.({ done: 300, total: 300 });
    expect(useData.getState().indexing).toBeNull();
    await vi.waitFor(() => expect(useData.getState().notes).toHaveLength(2));
    await vi.waitFor(() => expect(useData.getState().folders).toEqual(["工作"]));
  });

  it("does not let the half-read list from initialize overwrite the full one", async () => {
    let release = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    api.noteList.mockImplementation(async (archived: boolean) => {
      if (archived) return [];
      calls += 1;
      if (calls === 1) {
        await slow;
        return listed("a");
      }
      return listed("a", "b", "c");
    });
    api.calendarMarks.mockResolvedValue({ written: new Set(), open: new Set() });
    api.indexProgress.mockResolvedValue(null);
    api.folderList.mockResolvedValue([]);
    api.guidePending.mockResolvedValue([]);

    const starting = useData.getState().initialize();
    // 列表还在路上，后台就读完了
    await vi.waitFor(() => expect(calls).toBe(1));
    progress?.({ done: 300, total: 300 });
    release();
    await starting;
    await vi.waitFor(() => expect(useData.getState().notes).toHaveLength(3));
  });
});

describe("deleteNote / undoDelete", () => {
  const three = () => ["a", "b", "c"].map((id) => ({ ...note(id), id, title: id.toUpperCase() }));

  it("offers an undo that puts the note back where it was, with fresh content", async () => {
    put({ notes: three() });
    api.noteDelete.mockResolvedValue(undefined);
    api.noteUndelete.mockResolvedValue(undefined);
    // 删之前失焦触发的保存可能晚一步落库：撤销后用库里的版本
    api.noteGet.mockResolvedValue({ ...note("删之前刚存的"), id: "b", title: "B" });

    await useData.getState().deleteNote("b");
    expect(useData.getState().notes.map((item) => item.id)).toEqual(["a", "c"]);
    expect(useData.getState().lastDeleted?.note.id).toBe("b");

    expect(await useData.getState().undoDelete()).toBe("b");
    expect(api.noteUndelete).toHaveBeenCalledWith("b");
    expect(useData.getState().notes.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(useData.getState().bodies.b).toBe("删之前刚存的");
    expect(useData.getState().lastDeleted).toBeNull();
  });

  it("waits for an in-flight delete before undoing it", async () => {
    put({ notes: three() });
    let finishDelete = () => {};
    const order: string[] = [];
    api.noteDelete.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = () => {
            order.push("deleted");
            resolve();
          };
        }),
    );
    api.noteUndelete.mockImplementation(async () => {
      order.push("undeleted");
    });
    api.noteGet.mockResolvedValue({ ...note("b"), id: "b" });

    const deleting = useData.getState().deleteNote("b");
    const undoing = useData.getState().undoDelete();
    await Promise.resolve();
    finishDelete();
    await Promise.all([deleting, undoing]);
    expect(order).toEqual(["deleted", "undeleted"]);
    expect(useData.getState().notes.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("rolls a failed delete back into place and withdraws the undo", async () => {
    put({ notes: three() });
    api.noteDelete.mockRejectedValue(new Error("磁盘只读"));

    await useData.getState().deleteNote("b");
    expect(useData.getState().notes.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(useData.getState().lastDeleted).toBeNull();
    expect(useData.getState().error).toBe("磁盘只读");
  });

  it("does nothing once the undo was dismissed", async () => {
    put({ notes: three() });
    api.noteDelete.mockResolvedValue(undefined);
    await useData.getState().deleteNote("b");
    useData.getState().dismissUndo();

    expect(await useData.getState().undoDelete()).toBeNull();
    expect(api.noteUndelete).not.toHaveBeenCalled();
  });
});

describe("归档里的笔记", () => {
  const archivedNote = (id: string): Note => ({
    ...note(id),
    id,
    title: id.toUpperCase(),
    isArchived: true,
    archivedAt: 1,
    relPath: `归档/${id}.md`,
  });

  it("can be deleted without restoring first, and the undo puts it back into the archive", async () => {
    put({ notes: [], archived: [archivedNote("x"), archivedNote("y")] });
    api.noteDelete.mockResolvedValue(undefined);
    api.noteUndelete.mockResolvedValue(undefined);
    api.noteGet.mockResolvedValue(archivedNote("y"));

    await useData.getState().deleteNote("y");
    expect(api.noteDelete).toHaveBeenCalledWith("y");
    expect(useData.getState().archived.map((item) => item.id)).toEqual(["x"]);
    expect(useData.getState().lastDeleted).toMatchObject({ index: 1, archived: true });

    expect(await useData.getState().undoDelete()).toBe("y");
    expect(useData.getState().archived.map((item) => item.id)).toEqual(["x", "y"]);
    expect(useData.getState().notes).toEqual([]);
  });

  it("archiving and restoring both offer an undo that does not offer another one", async () => {
    put({ notes: [{ ...note("a"), id: "a", title: "A" }], archived: [], folders: [] });
    api.noteArchive.mockResolvedValue(undefined);
    api.noteRestore.mockResolvedValue(undefined);
    api.folderList.mockResolvedValue([]);
    api.noteGet.mockResolvedValue(archivedNote("a"));

    await useData.getState().archiveNote("a");
    const archived = useData.getState().undoable;
    expect(archived).toMatchObject({ kind: "archive", message: "已归档「A」", reopen: "a" });

    api.noteGet.mockResolvedValue({ ...note("a"), id: "a", title: "A" });
    useData.getState().dismissUndoable();
    await archived?.undo();
    expect(api.noteRestore).toHaveBeenCalledWith("a");
    expect(useData.getState().notes.map((item) => item.id)).toEqual(["a"]);
    // 撤销本身不再弹一条「已恢复 · 撤销」
    expect(useData.getState().undoable).toBeNull();
  });
});

describe("drafts（保存失败的正文）", () => {
  const target = { kind: "note", id: "n-1" } as const;

  it("keeps a failed version as a draft and clears it once a save succeeds", async () => {
    put({ notes: [note("原文")] });
    api.noteUpsert.mockRejectedValueOnce(new Error("database is locked"));
    await expect(useData.getState().saveDocument(target, "没存进去的字")).rejects.toThrow();
    // 编辑器卸载后它的保存队列就没了，这一版只剩 store 里这份
    expect(useData.getState().drafts["note:n-1"]?.contentMd).toBe("没存进去的字");

    api.noteUpsert.mockResolvedValue("n-1");
    api.noteGet.mockResolvedValue(note("没存进去的字，又写了一点"));
    await useData.getState().saveDocument(target, "没存进去的字，又写了一点");
    expect(useData.getState().drafts).toEqual({});
  });

  it("flushDrafts retries drafts left by editors that are gone", async () => {
    put({
      notes: [note("原文")],
      drafts: { "note:n-1": { target, contentMd: "草稿" } },
    });
    api.noteUpsert.mockResolvedValue("n-1");
    api.noteGet.mockResolvedValue(note("草稿"));

    await useData.getState().flushDrafts();
    expect(api.noteUpsert).toHaveBeenCalledWith(expect.objectContaining({ contentMd: "草稿" }));
    expect(useData.getState().drafts).toEqual({});
    expect(useData.getState().bodies["n-1"]).toBe("草稿");
  });

  it("flushDrafts rejects while the backend still fails, keeping the draft", async () => {
    put({
      notes: [note("原文")],
      drafts: { "note:n-1": { target, contentMd: "草稿" } },
    });
    api.noteUpsert.mockRejectedValue(new Error("database is locked"));
    await expect(useData.getState().flushDrafts()).rejects.toThrow("database is locked");
    expect(useData.getState().drafts["note:n-1"]?.contentMd).toBe("草稿");
  });
});

describe("applyVaultChange（别的程序改了仓库里的文件）", () => {
  it("refreshes a changed note and marks it as an external revision", async () => {
    put({ notes: [note("旧的")] });
    api.noteGet.mockResolvedValue(note("别处改的"));

    await useData.getState().applyVaultChange(change({ notes: ["n-1"] }));
    expect(useData.getState().bodies["n-1"]).toBe("别处改的");
    expect(useData.getState().externalRevisions["note:n-1"]).toBe(1);
  });

  it("does not count a refresh that changed nothing in the body", async () => {
    put({ notes: [note("一样")] });
    api.noteGet.mockResolvedValue({ ...note("一样"), isPinned: true });

    await useData.getState().applyVaultChange(change({ notes: ["n-1"] }));
    expect(useData.getState().notes[0]?.isPinned).toBe(true);
    expect(useData.getState().externalRevisions["note:n-1"]).toBeUndefined();
  });

  it("adds new files, moves archived ones and drops deleted ones", async () => {
    put({ notes: [note("x"), { ...note("y"), id: "n-2" }] });
    api.noteGet.mockImplementation(async (id: string) => {
      if (id === "n-new") return { ...note("新文件"), id: "n-new" };
      if (id === "n-2") return { ...note("y"), id: "n-2", isArchived: true };
      throw { kind: "NotFound", message: `note ${id}` };
    });

    await useData.getState().applyVaultChange(change({ notes: ["n-new", "n-2", "n-1"] }));
    const state = useData.getState();
    expect(state.notes.map((item) => item.id)).toEqual(["n-new"]);
    expect(state.archived.map((item) => item.id)).toEqual(["n-2"]);
    expect(state.error).toBeNull();
  });

  it("only refreshes the tasks of cached days when just the tasks changed", async () => {
    // 那一天的编辑器可能正有没存的修改：只是任务变了的话正文不能动
    put({ dayDocs: [day("编辑器里的正文")] });
    const task = {
      id: "n-1#2",
      title: "交稿",
      status: "todo" as const,
      meta: null,
      dueDate: "2026-08-29",
      timeLabel: null,
      category: null,
    };
    api.calendarDay.mockResolvedValue(day("磁盘上的正文", { tasks: [task] }));
    api.calendarMarks.mockResolvedValue({
      written: new Set(["2026-09-04"]),
      open: new Set(["2026-08-29"]),
    });

    await useData.getState().applyVaultChange(change({ tasks: true }));
    const state = useData.getState();
    expect(state.dayDocs[0]?.noteMd).toBe("编辑器里的正文");
    expect(state.dayDocs[0]?.tasks).toEqual([task]);
    expect(state.tasks["n-1#2"]).toEqual(task);
    expect([...state.marks.open]).toEqual(["2026-08-29"]);
    expect([...state.marks.written]).toEqual(["2026-09-04"]);
  });

  it("leaves days and goals that were never opened alone", async () => {
    await useData
      .getState()
      .applyVaultChange(change({ days: ["2026-08-29"], goals: ["week:2026-08-24"] }));
    expect(api.calendarDay).not.toHaveBeenCalled();
    expect(api.goalGet).not.toHaveBeenCalled();
  });

  it("tells the user where a conflicting external edit went", async () => {
    api.noteGet.mockResolvedValue({ ...note("磁盘上的"), id: "n-copy" });
    await useData
      .getState()
      .applyVaultChange(change({ notes: ["n-copy"], conflicts: ["周报 (冲突 2026-09-27 1030)"] }));
    expect(useData.getState().notice).toContain("周报 (冲突 2026-09-27 1030)");
    expect(useData.getState().notes[0]?.id).toBe("n-copy");
  });
});

describe("外部改动撞上没存的修改", () => {
  it("keeps the disk version as a conflict copy before saving the editor's", async () => {
    put({ notes: [note("别处改的")] });
    const order: string[] = [];
    api.vaultKeepConflictCopy.mockImplementation(async () => {
      order.push("copy");
      return "笔记 (冲突 2026-09-27 1030)";
    });
    api.noteUpsert.mockImplementation(async () => {
      order.push("save");
      return "n-1";
    });
    api.noteGet.mockResolvedValue(note("编辑器里的"));

    useData.getState().markConflict({ kind: "note", id: "n-1" });
    await useData.getState().saveDocument({ kind: "note", id: "n-1" }, "编辑器里的");
    expect(order).toEqual(["copy", "save"]);
    expect(api.vaultKeepConflictCopy).toHaveBeenCalledWith({ kind: "note", id: "n-1" });
    expect(useData.getState().conflicts.size).toBe(0);

    // 只另存一次：之后的保存照常
    await useData.getState().saveDocument({ kind: "note", id: "n-1" }, "编辑器里的，又改了");
    expect(api.vaultKeepConflictCopy).toHaveBeenCalledTimes(1);
  });
});

describe("revealDocument", () => {
  it("reports why the folder could not be opened", async () => {
    api.vaultReveal.mockRejectedValue({ kind: "Io", message: "打开文件夹失败: 没有这个文件" });
    await useData.getState().revealDocument({ kind: "note", id: "n-1" });
    expect(useData.getState().error).toBe("打开文件夹失败: 没有这个文件");
  });
});

describe("folders", () => {
  const inFolder = (id: string, relPath: string): Note => ({ ...note(id), id, title: id, relPath });

  beforeEach(() => {
    put({ folders: [], undoable: null, lastDeleted: null });
  });

  it("moves a note, refreshes the editor when its links were rewritten, and can undo", async () => {
    const before = { ...inFolder("周报", "笔记/周报.md"), contentMd: "![图](../附件/图.png)" };
    put({ notes: [before], folders: ["工作"] });
    const moved = {
      ...before,
      relPath: "笔记/工作/周报.md",
      contentMd: "![图](../../附件/图.png)",
    };
    api.noteMove.mockResolvedValueOnce(moved).mockResolvedValueOnce(before);

    await useData.getState().moveNote("周报", "工作");
    expect(api.noteMove).toHaveBeenCalledWith("周报", "工作");
    expect(useData.getState().notes[0]).toEqual(summary(moved));
    expect(useData.getState().bodies.周报).toBe(moved.contentMd);
    // 正文里的相对链接改了：编辑器要换上新正文，不然下一次自动保存会把旧链接写回去
    expect(useData.getState().externalRevisions["note:周报"]).toBe(1);
    const undoable = useData.getState().undoable;
    expect(undoable?.message).toBe("已移到「工作」");

    await undoable?.undo();
    expect(api.noteMove).toHaveBeenLastCalledWith("周报", "");
    expect(useData.getState().notes[0]?.relPath).toBe("笔记/周报.md");
    expect(useData.getState().undoable).toBeNull();
  });

  it("puts a note back when the move fails", async () => {
    const before = inFolder("周报", "笔记/周报.md");
    put({ notes: [before], folders: ["工作"] });
    api.noteMove.mockRejectedValue({ kind: "NotFound", message: "文件夹「工作」不在了" });

    await useData.getState().moveNote("周报", "工作");
    expect(useData.getState().notes[0]).toEqual(summary(before));
    expect(useData.getState().error).toBe("文件夹「工作」不在了");
    expect(useData.getState().undoable).toBeNull();
  });

  it("renames a folder and every path under it", async () => {
    put({
      folders: ["工作", "工作/周报", "生活"],
      notes: [inFolder("a", "笔记/工作/周报/a.md"), inFolder("b", "笔记/生活/b.md")],
    });
    api.folderRename.mockResolvedValue("项目");

    expect(await useData.getState().renameFolder("工作", "项目")).toBe("项目");
    expect(useData.getState().folders).toEqual(["生活", "项目", "项目/周报"]);
    expect(useData.getState().notes.map((n) => n.relPath)).toEqual([
      "笔记/项目/周报/a.md",
      "笔记/生活/b.md",
    ]);
  });

  it("deletes a folder with its notes and brings everything back on undo", async () => {
    const notes = [
      inFolder("a", "笔记/读书/a.md"),
      inFolder("b", "笔记/读书/小说/b.md"),
      inFolder("c", "笔记/c.md"),
    ];
    put({ notes, folders: ["读书", "读书/小说"] });
    const deletion = {
      folder: "读书",
      notes: ["a", "b"],
      folders: ["读书", "读书/小说"],
      kept: false,
    };
    api.folderDelete.mockResolvedValue(deletion);

    await useData.getState().deleteFolder("读书");
    expect(useData.getState().notes.map((n) => n.id)).toEqual(["c"]);
    expect(useData.getState().folders).toEqual([]);
    expect(useData.getState().undoable?.message).toBe("已删除「读书」和里面的 2 篇笔记");

    api.folderUndelete.mockResolvedValue(undefined);
    api.noteList.mockResolvedValue(notes);
    api.folderList.mockResolvedValue(["读书", "读书/小说"]);
    await useData.getState().undoable?.undo();
    expect(api.folderUndelete).toHaveBeenCalledWith(deletion);
    expect(useData.getState().notes).toHaveLength(3);
    expect(useData.getState().folders).toEqual(["读书", "读书/小说"]);
  });

  it("shows a new folder before the backend answers, then follows what it says", async () => {
    put({ folders: ["工作"] });
    let answer: (path: string) => void = () => {};
    api.folderCreate.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
    );

    // 名字按后端的规矩先算好：非法字符换成全角、重名加序号
    const created = useData.getState().createFolder("", "工作");
    expect(useData.getState().folders).toEqual(["工作", "工作 2"]);
    // 后端那边磁盘上还有个同名的文件，给的是「工作 3」：跟着改
    answer("工作 3");
    expect(await created).toBe("工作 3");
    expect(useData.getState().folders).toEqual(["工作", "工作 3"]);

    api.folderCreate.mockRejectedValueOnce({ kind: "Io", message: "没有权限" });
    expect(await useData.getState().createFolder("", "a/b")).toBeNull();
    expect(useData.getState().folders).toEqual(["工作", "工作 3"]);
    expect(useData.getState().error).toBe("没有权限");
  });

  it("refreshes the folder list when folders change outside the app", async () => {
    api.folderList.mockResolvedValue(["资源管理器里建的"]);
    await useData.getState().applyVaultChange(change({ folders: true }));
    expect(useData.getState().folders).toEqual(["资源管理器里建的"]);
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

  it("loads the day first, writes the copy's version into it, then deletes the copy", async () => {
    put({ notes: [copyOf("day:2026-08-29", "- [x] 另一台的")] });
    api.calendarDay.mockResolvedValue(day("- [ ] 本机的", { title: "周六" }));
    api.calendarDaySave.mockResolvedValue(day("- [x] 另一台的", { title: "周六" }));
    api.noteDelete.mockResolvedValue(undefined);

    const opened = await useData.getState().resolveConflict("copy", "copy");

    expect(opened).toEqual({ kind: "day", id: "2026-08-29" });
    // 当天的标题不动，只换正文
    expect(api.calendarDaySave).toHaveBeenCalledWith("2026-08-29", "周六", "- [x] 另一台的");
    expect(api.noteDelete).toHaveBeenCalledWith("copy");
    expect(useData.getState().notes).toEqual([]);
    expect(useData.getState().externalRevisions["day:2026-08-29"]).toBe(1);
  });

  it("keeping the original only deletes the copy", async () => {
    put({ notes: [copyOf("goal:week:2026-09-21", "另一台的目标")] });
    api.noteDelete.mockResolvedValue(undefined);

    const opened = await useData.getState().resolveConflict("copy", "original");

    expect(opened).toEqual({ kind: "goal", horizon: "week", periodStart: "2026-09-21" });
    expect(api.goalGet).not.toHaveBeenCalled();
    expect(api.goalSave).not.toHaveBeenCalled();
    expect(api.noteDelete).toHaveBeenCalledWith("copy");
  });
});

describe("使用指南有新版、用户改过那一篇", () => {
  const guide = (contentMd: string): Note => ({
    ...note(contentMd),
    id: "guide-welcome-1",
    title: "欢迎使用 OnTheWay",
  });
  const update = { id: "guide-welcome-1", name: "welcome", body: "新版的指南" };

  it("taking the new version saves it, settles, and can be undone", async () => {
    put({ notes: [guide("我改过的指南")], guideUpdates: [update] });
    api.noteUpsert.mockResolvedValue("guide-welcome-1");
    api.noteGet.mockImplementation(async () => guide(api.noteUpsert.mock.lastCall![0].contentMd));
    api.guideSettle.mockResolvedValue(undefined);

    await useData.getState().adoptGuideUpdate("guide-welcome-1");

    expect(api.noteUpsert).toHaveBeenLastCalledWith({
      id: "guide-welcome-1",
      title: "欢迎使用 OnTheWay",
      contentMd: "新版的指南",
    });
    // 正文存好了才记下这一版：记下的指纹和正文对得上
    expect(api.guideSettle.mock.invocationCallOrder[0]).toBeGreaterThan(
      api.noteUpsert.mock.invocationCallOrder[0]!,
    );
    expect(useData.getState().guideUpdates).toEqual([]);
    expect(useData.getState().externalRevisions["note:guide-welcome-1"]).toBe(1);
    expect(useData.getState().undoable?.message).toBe("已换成新版的使用指南");

    await useData.getState().undoable?.undo();
    expect(api.noteUpsert).toHaveBeenLastCalledWith({
      id: "guide-welcome-1",
      title: "欢迎使用 OnTheWay",
      contentMd: "我改过的指南",
    });
  });

  it("keeping mine only settles", async () => {
    put({ notes: [guide("我改过的指南")], guideUpdates: [update] });
    api.guideSettle.mockResolvedValue(undefined);

    await useData.getState().keepGuide("guide-welcome-1");

    expect(api.guideSettle).toHaveBeenCalledWith("guide-welcome-1");
    expect(api.noteUpsert).not.toHaveBeenCalled();
    expect(useData.getState().guideUpdates).toEqual([]);
  });

  it("opening a deleted guide puts the recreated one into the list", async () => {
    api.guideOpen.mockResolvedValue("guide-welcome-2");
    api.noteGet.mockResolvedValue({ ...guide("新放的一篇"), id: "guide-welcome-2" });

    expect(await useData.getState().openGuide("welcome")).toBe("guide-welcome-2");
    expect(useData.getState().notes.map((item) => item.id)).toEqual(["guide-welcome-2"]);

    // 已经在列表里的不再取一遍
    api.noteGet.mockClear();
    expect(await useData.getState().openGuide("welcome")).toBe("guide-welcome-2");
    expect(api.noteGet).not.toHaveBeenCalled();
  });
});
