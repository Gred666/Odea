// @vitest-environment happy-dom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../data/backend";
import type { FindOptions, FindResult, NoteSummary } from "../data/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 全局搜索（FindDialog）：快捷键打开、三个开关交给后端、回车打开那一篇并选中那一处。
 */

const result: FindResult = {
  files: [
    {
      target: { kind: "note", id: "a" },
      title: "周报",
      updatedAt: 1,
      count: 2,
      matches: [
        { line: 2, column: 3, length: 2, before: "今天的", text: "进度", after: "还可以" },
        { line: 5, column: 0, length: 2, before: "", text: "进度", after: "不错" },
      ],
    },
    {
      target: { kind: "day", id: "2026-10-16" },
      title: "10月16日",
      updatedAt: 1,
      count: 1,
      matches: [{ line: 1, column: 1, length: 2, before: "把", text: "进度", after: "推完" }],
    },
  ],
  total: 3,
  truncated: false,
  error: null,
};

const api = {
  findInVault: vi.fn(async (_query: string, _options: FindOptions) => result),
};
vi.mock("../data/backend", () => ({ backend: async () => api as unknown as Backend }));

const { useApp } = await import("@/app/store");
const { useData } = await import("../data/store");
const { FindDialog } = await import("./FindDialog");

const noteA: NoteSummary = {
  id: "a",
  title: "周报",
  excerpt: "",
  wordCount: 1,
  isPinned: false,
  isArchived: false,
  archiveCategory: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  relPath: "笔记/工作/周报.md",
  conflictOf: null,
  idInFile: true,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  api.findInVault.mockClear();
  useApp.setState({ findOpen: false, findSeed: null, paletteOpen: false, pendingAnchor: null });
  useData.setState({ notes: [noteA], archived: [], bodies: { a: "正文" } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<FindDialog />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const flush = () => act(async () => {});
const key = (init: KeyboardEventInit, target: EventTarget = window) =>
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
const input = () => document.querySelector<HTMLInputElement>('input[role="combobox"]');
const options = () => [...document.querySelectorAll('[role="option"]')];

describe("FindDialog", () => {
  it("opens with Ctrl+Shift+F and closes the command palette", async () => {
    useApp.setState({ paletteOpen: true });
    await key({ key: "F", ctrlKey: true, shiftKey: true });
    await flush();
    expect(useApp.getState().findOpen).toBe(true);
    expect(useApp.getState().paletteOpen).toBe(false);
    expect(input()).not.toBeNull();
    await key({ key: "Escape" });
    expect(useApp.getState().findOpen).toBe(false);
  });

  it("lists every match grouped by document and searches with the toggles", async () => {
    act(() => useApp.getState().setFindOpen(true, "进度"));
    await flush();
    expect(api.findInVault).toHaveBeenLastCalledWith("进度", PLAIN);
    expect(options()).toHaveLength(3);
    expect(document.body.textContent).toContain("2 篇 · 3 处");
    // 笔记的出处
    expect(document.body.textContent).toContain("工作");

    const regex = document.querySelector<HTMLButtonElement>('button[aria-label^="正则表达式"]');
    act(() => regex?.click());
    await flush();
    expect(api.findInVault).toHaveBeenLastCalledWith("进度", { ...PLAIN, regex: true });
    expect(regex?.getAttribute("aria-pressed")).toBe("true");
    // Alt+C 切换区分大小写（按物理键认）
    await key({ key: "c", code: "KeyC", altKey: true }, input() ?? window);
    await flush();
    expect(api.findInVault).toHaveBeenLastCalledWith("进度", {
      ...PLAIN,
      regex: true,
      caseSensitive: true,
    });
  });

  it("opens the document at the match on Enter", async () => {
    act(() => useApp.getState().setFindOpen(true, "进度"));
    await flush();
    const field = input() ?? window;
    await key({ key: "ArrowDown" }, field);
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    await key({ key: "Enter" }, field);
    const app = useApp.getState();
    expect(app.findOpen).toBe(false);
    expect(app.workspace).toBe("notes");
    expect(app.selectedNoteId).toBe("a");
    expect(app.noteFolder).toBe("工作");
    expect(app.pendingAnchor).toEqual({
      docKey: "note-a",
      line: 5,
      match: { query: "进度", ...PLAIN, column: 0, length: 2 },
    });
  });

  it("shows why a regex is wrong", async () => {
    api.findInVault.mockResolvedValueOnce({
      files: [],
      total: 0,
      truncated: false,
      error: "unclosed group",
    });
    act(() => useApp.getState().setFindOpen(true, "(进度"));
    await flush();
    expect(options()).toHaveLength(0);
    expect(document.body.textContent).toContain("正则有误：unclosed group");
  });
});

const PLAIN: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };
