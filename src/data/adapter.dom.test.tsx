// @vitest-environment happy-dom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "./backend";
import type { DocumentModel, Note, NoteSummary } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 笔记的正文按需取（store 的 loadBody）：选中一篇、它的正文还在路上时，正文区接着显示
 * 上一篇，取回来再换 —— 不能闪一帧没有正文（也没有编辑器）的文档。
 */

let release: (() => void) | null = null;
const api = {
  noteGet: vi.fn(async (id: string) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return note(id, `${id} 的正文`);
  }),
};
vi.mock("./backend", () => ({ backend: async () => api as unknown as Backend }));

const { useApp } = await import("@/app/store");
const { useData } = await import("./store");
const { useCurrentDocument } = await import("./adapter");

function note(id: string, contentMd: string): Note {
  return {
    id,
    title: id.toUpperCase(),
    contentMd,
    excerpt: "",
    wordCount: 1,
    isPinned: false,
    isArchived: false,
    archiveCategory: null,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    relPath: `笔记/${id}.md`,
    conflictOf: null,
    idInFile: true,
    notUtf8: false,
  };
}
const summary = ({ contentMd: _body, ...rest }: Note): NoteSummary => rest;

let shown: DocumentModel[] = [];
function Probe() {
  shown.push(useCurrentDocument());
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  shown = [];
  release = null;
  useApp.setState({ workspace: "notes", selectedNoteId: "a" });
  useData.setState({
    notes: [summary(note("a", "")), summary(note("b", ""))],
    archived: [],
    bodies: { a: "a 的正文" },
    drafts: {},
  });
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("useCurrentDocument：正文还没取回来", () => {
  it("keeps showing the previous note until the new body arrives", async () => {
    act(() => root.render(<Probe />));
    expect(shown.at(-1)).toMatchObject({ key: "note-a", bodyMd: "a 的正文" });

    act(() => useApp.setState({ selectedNoteId: "b" }));
    await act(() => vi.waitFor(() => expect(api.noteGet).toHaveBeenCalledWith("b")));
    // 正文在路上：还是 a，而且一直有编辑器
    expect(shown.at(-1)).toMatchObject({ key: "note-a", bodyMd: "a 的正文" });

    await act(async () => {
      release?.();
      await vi.waitFor(() => expect(useData.getState().bodies.b).toBe("b 的正文"));
    });
    expect(shown.at(-1)).toMatchObject({ key: "note-b", bodyMd: "b 的正文" });
    // 中间每一帧都有编辑器、有正文：没有闪过空白的那一篇
    expect(shown.every((doc) => doc.editor && doc.bodyMd)).toBe(true);
  });
});

describe("useCurrentDocument：文件不是 UTF-8（docs/1110审查与研究.md §5.1）", () => {
  it("opens it read-only and offers no rename or delete", () => {
    const old = { ...summary(note("a", "")), notUtf8: true };
    useData.setState({
      notes: [old],
      archived: [{ ...old, id: "z", isArchived: true }],
      bodies: { a: "x", z: "y" },
    });
    act(() => root.render(<Probe />));
    const doc = shown.at(-1)!;
    expect(doc.notUtf8).toBe(true);
    expect(doc.deletable).toBe(false);
    expect(doc.editor?.titleEditable).toBe(false);

    act(() => useApp.setState({ workspace: "archive", selectedArchiveId: "z" }));
    const archived = shown.at(-1)!;
    expect(archived.key).toBe("archive-z");
    expect(archived.notUtf8).toBe(true);
    expect(archived.deletable).toBe(false);
    expect(archived.editor?.titleEditable).toBe(false);
  });

  it("leaves ordinary notes editable", () => {
    act(() => root.render(<Probe />));
    const doc = shown.at(-1)!;
    expect(doc.notUtf8).toBe(false);
    expect(doc.deletable).toBe(true);
    expect(doc.editor?.titleEditable).toBe(true);
  });
});
