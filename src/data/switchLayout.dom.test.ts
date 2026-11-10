// @vitest-environment happy-dom

import { useApp } from "@/app/store";
import { registerPlugin } from "@/plugins/registry";
import { FileText } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "./backend";
import { type NoteSummary, ODEA_LAYOUT, type VaultInfo, type VaultLayout } from "./types";

/*
 * 开关插件 / 归档就地换上（data/store 的 switchLayout），不整页重载：
 * 停在哪一页不动（那一页没了才回到文件），列表整个重取，选中的那一篇按路径找回来
 * （后端重新认文件时，属性块里没记 id 的笔记 id 会换），开关了的插件缓存作废、一直开着的重取。
 * 这里装一个假的插件（一个导航项「页」，把 Daily 里的文件认成它的文档）测这套机制
 */

const api = {
  vaultSetPlugin: vi.fn(),
  vaultSetArchive: vi.fn(),
  noteList: vi.fn(),
  noteGet: vi.fn(),
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

const PAGES = "test.pages";
const reset = vi.fn();
const reindexed = vi.fn(async () => {});
registerPlugin({
  id: PAGES,
  name: "测试用的页",
  onByDefault: false,
  defaultDirs: [],
  documentTypes: [],
  nav: [
    {
      id: "pages",
      plugin: PAGES,
      label: "页",
      icon: FileText,
      order: 10,
      keywords: "",
      motion: { to: {}, origin: "50% 50%" },
    },
  ],
  useDocument: () => null,
  reset,
  reindexed,
});

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
  notUtf8: false,
});

const OPENED: VaultLayout = {
  ...ODEA_LAYOUT,
  plugins: [],
  archive: false,
  notesDir: "",
  hiddenDirs: [],
};
const PAGES_ON: VaultLayout = { ...OPENED, plugins: [PAGES], hiddenDirs: ["Daily"] };
const info = (layout: VaultLayout): VaultInfo => ({
  root: "D:/库",
  notes: 2,
  archived: 0,
  docs: 0,
  layout,
  team: false,
});

const reload = vi.fn();

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  reset.mockClear();
  reindexed.mockClear();
  hosted.hostedDocs = {};
  reload.mockReset();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload },
  });
  api.indexProgress.mockResolvedValue(null);
  api.folderList.mockResolvedValue(["读书"]);
  api.treeFiles.mockResolvedValue([]);
  api.treeQueries.mockResolvedValue([]);
});

afterEach(() => {
  useApp.setState({ workspace: "notes", selectedNoteId: "", selectedArchiveId: "" });
});

describe("switchLayout", () => {
  it("turns a plugin on in place and keeps the open note by its path", async () => {
    // 一个 Obsidian 库：Daily 里的文件现在还是笔记，正在看「读书/摘抄」
    useData.setState({
      layout: OPENED,
      notes: [summary("old-a", "Daily/2026-10-27.md"), summary("old-b", "读书/摘抄.md")],
      archived: [],
      bodies: { "old-b": "摘抄的正文" },
    });
    useApp.setState({ workspace: "notes", selectedNoteId: "old-b" });

    api.vaultSetPlugin.mockResolvedValue(info(PAGES_ON));
    // 重新认过以后 Daily 里的不再是笔记，「摘抄」没在属性块里记 id，换了一个
    api.noteList.mockImplementation(async (archived: boolean) =>
      archived ? [] : [summary("new-b", "读书/摘抄.md")],
    );
    api.noteGet.mockResolvedValue({ ...summary("new-b", "读书/摘抄.md"), contentMd: "摘抄的正文" });

    await useData.getState().setPlugin(PAGES, true);

    expect(reload).not.toHaveBeenCalled();
    expect(api.vaultSetPlugin).toHaveBeenCalledWith(PAGES, true);
    // 没跳到插件的页：还在文件，还是那一篇（新 id），正文已经取回来，不先闪「载入中…」
    expect(useApp.getState().workspace).toBe("notes");
    expect(useApp.getState().selectedNoteId).toBe("new-b");
    expect(useData.getState().bodies["new-b"]).toBe("摘抄的正文");
    expect(useData.getState().layout.plugins).toEqual([PAGES]);
    expect(useData.getState().notes.map((note) => note.id)).toEqual(["new-b"]);
    expect(useData.getState().folders).toEqual(["读书"]);
    expect(useData.getState().error).toBeNull();
    // 刚开的插件缓存作废（它挂上来的副作用会去取）
    expect(reset).toHaveBeenCalledOnce();
    expect(reindexed).not.toHaveBeenCalled();
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
    api.vaultSetPlugin.mockResolvedValue(info(PAGES_ON));
    api.noteList.mockImplementation(async (archived: boolean) =>
      archived ? [] : [summary("new-b", "读书/摘抄.md"), summary("new-c", "读书/书单.md")],
    );
    api.noteGet.mockResolvedValue({ ...summary("new-c", "读书/书单.md"), contentMd: "书单" });

    await useData.getState().setPlugin(PAGES, true);

    // Daily 里那篇不再是笔记：它的标签关掉；另外两个换成新 id，当前的还是「书单」
    const [pane] = useApp.getState().notePanes;
    expect(pane!.tabs.map((tab) => tab.noteId)).toEqual(["new-b", "new-c"]);
    expect(pane!.activeTab).toBe("t3");
    expect(useApp.getState().selectedNoteId).toBe("new-c");
  });

  it("leaves the plugin's page and drops its caches when it is turned off", async () => {
    useData.setState({
      layout: { ...ODEA_LAYOUT, plugins: [PAGES] },
      notes: [summary("n", "笔记/一篇.md")],
      archived: [],
      bodies: { n: "正文" },
    });
    useApp.setState({ workspace: "pages", selectedNoteId: "n" });
    api.vaultSetPlugin.mockResolvedValue(info(ODEA_LAYOUT));
    api.noteList.mockImplementation(async (archived: boolean) =>
      archived ? [] : [summary("n", "笔记/一篇.md"), summary("d", "Daily/2026-10-28.md")],
    );

    await useData.getState().setPlugin(PAGES, false);

    expect(reload).not.toHaveBeenCalled();
    // 插件的页没了：回到文件；那一篇 id 没变，不用重取正文
    expect(useApp.getState().workspace).toBe("notes");
    expect(useApp.getState().selectedNoteId).toBe("n");
    expect(api.noteGet).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledOnce();
    // 关掉以后它的文档就是普通笔记
    expect(useData.getState().notes.map((note) => note.id)).toEqual(["n", "d"]);
  });

  it("refetches what a plugin that stays on has cached when only the archive changes", async () => {
    useData.setState({
      layout: { ...ODEA_LAYOUT, plugins: [PAGES] },
      notes: [],
      archived: [],
      bodies: {},
    });
    useApp.setState({ workspace: "pages" });
    api.vaultSetArchive.mockResolvedValue(
      info({ ...ODEA_LAYOUT, plugins: [PAGES], archive: false, hiddenDirs: [] }),
    );
    api.noteList.mockResolvedValue([]);

    await useData.getState().setArchive(false);

    expect(useApp.getState().workspace).toBe("pages");
    expect(reset).not.toHaveBeenCalled();
    expect(reindexed).toHaveBeenCalledOnce();
  });

  it("stays on the extensions page", async () => {
    useData.setState({ layout: OPENED, notes: [], archived: [], bodies: {} });
    useApp.setState({ workspace: "extensions" });
    api.vaultSetPlugin.mockResolvedValue(info(PAGES_ON));
    api.noteList.mockResolvedValue([]);

    await useData.getState().setPlugin(PAGES, true);

    expect(useApp.getState().workspace).toBe("extensions");
  });

  it("still reloads the window while hosting a collaboration (sessions know notes by id)", async () => {
    useData.setState({ layout: OPENED, notes: [], archived: [], bodies: {} });
    hosted.hostedDocs = { n: {} };
    api.vaultSetPlugin.mockResolvedValue(info(PAGES_ON));

    await useData.getState().setPlugin(PAGES, true);

    expect(reload).toHaveBeenCalledOnce();
    expect(api.noteList).not.toHaveBeenCalled();
  });
});
