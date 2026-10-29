// @vitest-environment happy-dom

import { useApp } from "@/app/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "./backend";
import { type NoteSummary, ODEA_LAYOUT, type VaultInfo, type VaultLayout } from "./types";

/*
 * 开关日程 / 归档就地换上（data/store 的 switchLayout），不整页重载：
 * 停在哪一页不动（那一页没了才回到文件），列表整个重取，选中的那一篇按路径找回来
 * （后端重新认文件时，属性块里没记 id 的笔记 id 会换），日程开关变了的话某一天 / 目标的缓存作废。
 */

const api = {
  vaultSetJournal: vi.fn(),
  vaultSetArchive: vi.fn(),
  noteList: vi.fn(),
  noteGet: vi.fn(),
  calendarMarks: vi.fn(),
  indexProgress: vi.fn(),
  treeView: vi.fn(),
  folderList: vi.fn(),
  treeFiles: vi.fn(),
  treeQueries: vi.fn(),
};

const hosted: { hostedDocs: Record<string, unknown> } = { hostedDocs: {} };

vi.mock("./backend", () => ({ backend: async () => api as unknown as Backend }));
vi.mock("@/editor/saveBus", () => ({ flushAllEditors: async () => {} }));
vi.mock("@/collab/store", () => ({ useCollab: { getState: () => hosted } }));

const { useData } = await import("./store");

const summary = (id: string, relPath: string): NoteSummary => ({
  id,
  title: relPath.split("/").pop()!.replace(/\.md$/, ""),
  excerpt: "",
  wordCount: 1,
  isPinned: false,
  isArchived: false,
  archiveCategory: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  relPath,
  conflictOf: null,
  idInFile: false,
});

const OPENED: VaultLayout = {
  ...ODEA_LAYOUT,
  journal: false,
  archive: false,
  notesDir: "",
  hiddenDirs: [],
};
const info = (layout: VaultLayout): VaultInfo => ({
  root: "D:/库",
  notes: 2,
  archived: 0,
  days: 0,
  goals: 0,
  tasks: 0,
  layout,
  team: false,
});

const reload = vi.fn();

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  hosted.hostedDocs = {};
  reload.mockReset();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload },
  });
  api.calendarMarks.mockResolvedValue({ written: new Set(), open: new Set() });
  api.indexProgress.mockResolvedValue(null);
  api.folderList.mockResolvedValue(["读书"]);
  api.treeFiles.mockResolvedValue([]);
  api.treeQueries.mockResolvedValue([]);
});

afterEach(() => {
  useApp.setState({ workspace: "notes", selectedNoteId: "", selectedArchiveId: "" });
});

describe("switchLayout", () => {
  it("turns the journal on in place and keeps the open note by its path", async () => {
    // 一个 Obsidian 库：Daily 里的日记现在还是笔记，正在看「读书/摘抄」
    useData.setState({
      layout: OPENED,
      notes: [summary("old-a", "Daily/2026-10-27.md"), summary("old-b", "读书/摘抄.md")],
      archived: [],
      bodies: { "old-b": "摘抄的正文" },
      dayDocs: [],
      goals: {},
    });
    useApp.setState({ workspace: "notes", selectedNoteId: "old-b" });

    const journalOn = { ...OPENED, journal: true, daysDir: "Daily", hiddenDirs: ["Daily"] };
    api.vaultSetJournal.mockResolvedValue(info(journalOn));
    // 重新认过以后日记不再是笔记，「摘抄」没在属性块里记 id，换了一个
    api.noteList.mockImplementation(async (archived: boolean) =>
      archived ? [] : [summary("new-b", "读书/摘抄.md")],
    );
    api.noteGet.mockResolvedValue({ ...summary("new-b", "读书/摘抄.md"), contentMd: "摘抄的正文" });

    await useData.getState().setJournal(true);

    expect(reload).not.toHaveBeenCalled();
    expect(api.vaultSetJournal).toHaveBeenCalledWith(true);
    // 没跳到今日TODO：还在文件，还是那一篇（新 id），正文已经取回来，不先闪「载入中…」
    expect(useApp.getState().workspace).toBe("notes");
    expect(useApp.getState().selectedNoteId).toBe("new-b");
    expect(useData.getState().bodies["new-b"]).toBe("摘抄的正文");
    expect(useData.getState().layout.journal).toBe(true);
    expect(useData.getState().notes.map((note) => note.id)).toEqual(["new-b"]);
    expect(useData.getState().folders).toEqual(["读书"]);
    expect(useData.getState().error).toBeNull();
  });

  it("finds the open tabs again by their paths (docs/标签页与分屏.md §6)", async () => {
    useData.setState({
      layout: OPENED,
      notes: [
        summary("old-a", "Daily/2026-10-27.md"),
        summary("old-b", "读书/摘抄.md"),
        summary("old-c", "读书/书单.md"),
      ],
      archived: [],
      bodies: { "old-b": "摘抄的正文", "old-c": "书单" },
      dayDocs: [],
      goals: {},
    });
    const tab = (id: string, noteId: string) => ({ id, noteId, back: [], forward: [] });
    useApp.setState({
      workspace: "notes",
      notePanes: [
        {
          id: "p1",
          tabs: [tab("t1", "old-a"), tab("t2", "old-b"), tab("t3", "old-c")],
          activeTab: "t3",
          size: 1,
        },
      ],
      activePane: "p1",
      selectedNoteId: "old-c",
    });
    const journalOn = { ...OPENED, journal: true, daysDir: "Daily", hiddenDirs: ["Daily"] };
    api.vaultSetJournal.mockResolvedValue(info(journalOn));
    api.noteList.mockImplementation(async (archived: boolean) =>
      archived ? [] : [summary("new-b", "读书/摘抄.md"), summary("new-c", "读书/书单.md")],
    );
    api.noteGet.mockResolvedValue({ ...summary("new-c", "读书/书单.md"), contentMd: "书单" });

    await useData.getState().setJournal(true);

    // 日记不再是笔记：它的标签关掉；另外两个换成新 id，当前的还是「书单」
    const [pane] = useApp.getState().notePanes;
    expect(pane!.tabs.map((tab) => tab.noteId)).toEqual(["new-b", "new-c"]);
    expect(pane!.activeTab).toBe("t3");
    expect(useApp.getState().selectedNoteId).toBe("new-c");
  });

  it("leaves the journal pages and drops their caches when the journal is turned off", async () => {
    useData.setState({
      layout: ODEA_LAYOUT,
      notes: [summary("n", "笔记/一篇.md")],
      archived: [],
      bodies: { n: "正文" },
      dayDocs: [
        {
          date: "2026-10-28",
          title: "",
          tasks: [],
          noteMd: "今天",
          updatedAt: 1,
          carriedFrom: null,
          relPath: "日记/2026/2026-10-28.md",
        },
      ],
    });
    useApp.setState({ workspace: "today", selectedNoteId: "n" });
    api.vaultSetJournal.mockResolvedValue(info({ ...ODEA_LAYOUT, journal: false }));
    api.noteList.mockImplementation(async (archived: boolean) =>
      archived ? [] : [summary("n", "笔记/一篇.md"), summary("d", "日记/2026/2026-10-28.md")],
    );

    await useData.getState().setJournal(false);

    expect(reload).not.toHaveBeenCalled();
    // 今日TODO 没了：回到文件；那一篇 id 没变，不用重取正文
    expect(useApp.getState().workspace).toBe("notes");
    expect(useApp.getState().selectedNoteId).toBe("n");
    expect(api.noteGet).not.toHaveBeenCalled();
    expect(useData.getState().dayDocs).toEqual([]);
    expect(useData.getState().notes.map((note) => note.id)).toEqual(["n", "d"]);
  });

  it("still reloads the window while hosting a collaboration (sessions know notes by id)", async () => {
    useData.setState({ layout: OPENED, notes: [], archived: [], bodies: {} });
    hosted.hostedDocs = { n: {} };
    api.vaultSetJournal.mockResolvedValue(info({ ...OPENED, journal: true }));

    await useData.getState().setJournal(true);

    expect(reload).toHaveBeenCalledOnce();
    expect(api.noteList).not.toHaveBeenCalled();
  });
});
