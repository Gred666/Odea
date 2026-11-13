import { useData } from "@/data/store";
import type { NoteSummary } from "@/data/types";
import { afterEach, describe, expect, it } from "vitest";
import { type FolderEntry, folderNotes, pagePaths, relativeHref } from "./document";

const note = (id: string, title: string, relPath: string): NoteSummary => ({
  id,
  title,
  excerpt: "",
  wordCount: 0,
  isPinned: false,
  isArchived: false,
  archiveCategory: null,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
  relPath,
  conflictOf: null,
  idInFile: true,
  notUtf8: false,
});

afterEach(() => {
  useData.setState({ notes: [], folders: [] });
});

describe("导出整个文件夹", () => {
  it("takes the notes of a folder and its subfolders, in tree order", () => {
    useData.setState({
      folders: ["工作", "工作/周报", "工作/会议", "生活"],
      notes: [
        note("a", "第 10 周", "笔记/工作/周报/第 10 周.md"),
        note("b", "第 9 周", "笔记/工作/周报/第 9 周.md"),
        note("c", "计划", "笔记/工作/计划.md"),
        note("d", "周会", "笔记/工作/会议/周会.md"),
        note("e", "旅行", "笔记/生活/旅行.md"),
      ],
    });
    const entries = folderNotes("工作");
    // 先是就在这个文件夹里的，再按树上的顺序一个个子文件夹；同一个文件夹里按标题（数字按大小）
    expect(entries.map((entry) => [entry.note.title, entry.sub])).toEqual([
      ["计划", ""],
      ["第 9 周", "周报"],
      ["第 10 周", "周报"],
      ["周会", "会议"],
    ]);
    expect(folderNotes("").map((entry) => entry.note.id)).toHaveLength(5);
  });

  it("names each page after its title and keeps the subfolders", () => {
    const entry = (title: string, sub: string): FolderEntry => ({
      note: note(title, title, ""),
      sub,
    });
    expect(
      pagePaths([
        entry("计划", ""),
        entry("周报", "周报"),
        entry("周报", "周报"),
        entry("index", ""),
        entry("a/b: c?", "会议"),
      ]),
    ).toEqual([
      "计划.html",
      "周报/周报.html",
      "周报/周报 (2).html",
      "index (2).html",
      "会议/a／b： c？.html",
    ]);
  });

  it("links one page to another with a relative, encoded address", () => {
    expect(relativeHref("计划.html", "周报/第 9 周.html")).toBe(
      `${encodeURIComponent("周报")}/${encodeURIComponent("第 9 周.html")}`,
    );
    expect(relativeHref("周报/第 9 周.html", "计划.html")).toBe(
      `../${encodeURIComponent("计划.html")}`,
    );
    expect(relativeHref("周报/第 9 周.html", "周报/第 10 周.html")).toBe(
      encodeURIComponent("第 10 周.html"),
    );
    expect(relativeHref("周报/十月/a.html", "会议/b.html")).toBe(
      `../../${encodeURIComponent("会议")}/b.html`,
    );
  });
});
