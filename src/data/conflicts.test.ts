import { registerPlugin } from "@/plugins/registry";
import { FileText } from "lucide-react";
import { describe, expect, it } from "vitest";
import { conflictOriginalContent, conflictOriginalTitle, conflictTarget } from "./conflicts";
import { type Note, noteRef } from "./types";

/* 冲突副本的原文：笔记核心自己认，插件的文档交给插件声明的类型认（DocumentType.keyOf / title / body）。
   这里装一个假的插件测这套机制；日程那两种（day:… / goal:…）在 plugins/journal/store.test.ts */

const note = (id: string, title: string, contentMd: string): Note => ({
  id,
  title,
  contentMd,
  excerpt: "",
  wordCount: 1,
  isPinned: false,
  isArchived: false,
  archiveCategory: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  relPath: `笔记/${title}.md`,
  conflictOf: null,
  idInFile: true,
});

const pages: Record<string, string> = { "7": "第七页的正文" };

registerPlugin({
  id: "test.pages",
  name: "测试用的页",
  onByDefault: false,
  defaultDirs: [],
  nav: [],
  documentTypes: [
    {
      id: "test.page",
      plugin: "test.pages",
      icon: FileText,
      group: "页",
      idOf: (key) => `page:${key}`,
      keyOf: (id) => /^page:(\d+)$/.exec(id)?.[1] ?? null,
      teamId: (key) => `page-${key}`,
      title: (key) => `第 ${key} 页`,
      body: (key) => pages[key],
      load: async () => {},
      save: async () => true,
      open: (key) => key,
    },
  ],
  useDocument: () => null,
});

const page = (key: string) => ({ type: "test.page", key });

describe("conflictTarget", () => {
  it("reads note ids and ids of plugin documents", () => {
    expect(conflictTarget("0199f3c2-aaaa")).toEqual(noteRef("0199f3c2-aaaa"));
    expect(conflictTarget("page:7")).toEqual(page("7"));
    // 长得不像的就当笔记 id
    expect(conflictTarget("page:七")).toEqual(noteRef("page:七"));
  });
});

describe("原文的标题和正文", () => {
  const lists = { notes: [note("n-1", "周报", "本机的")], archived: [] };
  const docs = { ...lists, bodies: { "n-1": "本机的" } };

  it("names a plugin document the way its type does, a note by its title", () => {
    expect(conflictOriginalTitle(page("7"), lists)).toBe("第 7 页");
    expect(conflictOriginalTitle(noteRef("n-1"), lists)).toBe("周报");
    // 原文是笔记、已经不在了
    expect(conflictOriginalTitle(noteRef("gone"), lists)).toBeUndefined();
    // 装着的插件里没有这一种（插件被卸掉了）：没法认
    expect(conflictOriginalTitle({ type: "test.gone", key: "1" }, lists)).toBeUndefined();
  });

  it("reads the original's body, undefined while it is not loaded yet", () => {
    expect(conflictOriginalContent(page("7"), docs)).toBe("第七页的正文");
    expect(conflictOriginalContent(page("8"), docs)).toBeUndefined();
    expect(conflictOriginalContent(noteRef("n-1"), docs)).toBe("本机的");
    // 笔记的正文也是按需取的（store 的 bodies 里没有就是还没取）
    expect(conflictOriginalContent(noteRef("n-1"), { ...docs, bodies: {} })).toBeUndefined();
  });
});
