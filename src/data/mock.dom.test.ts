// @vitest-environment happy-dom

import { GUIDES, guideFingerprint } from "@/content/guide";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileStemFor, folderOf } from "./folders";

/*
 * 浏览器预览用的 mock 后端：规矩要和 Rust 一样。
 * - 文件名（layout::file_stem_for_title）：以前改标题直接拿标题当文件名，标题里有 `/` 的那篇
 *   就进了一层不存在的文件夹 —— 列表栏里看不见它了，正文上面的路径也多出一段
 * - 新仓库里只有使用指南，升级时没改过的换新、改过的留给用户（vault/guide.rs）
 */

const LS_KEY = "odea.mock.v5";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

/** 重新加载 mock：相当于重新打开浏览器预览（升级后的第一次启动） */
const reopen = async () => (await import("./mock")).mockBackend;

describe("fileStemFor", () => {
  it("keeps path separators and other illegal characters out of file names", () => {
    expect(fileStemFor("测试/斜杠:标题")).toBe("测试／斜杠：标题");
    expect(fileStemFor('a\\b*c?"<>|')).toBe("a＼b＊c？＂＜＞｜");
  });

  it("falls back to the placeholder title and dodges device names", () => {
    expect(fileStemFor("  ")).toBe("无标题笔记");
    expect(fileStemFor("...")).toBe("无标题笔记");
    expect(fileStemFor("CON")).toBe("CON_");
  });
});

describe("mock backend", () => {
  it("does not turn a slash in a renamed title into a folder", async () => {
    const mockBackend = await reopen();
    const id = await mockBackend.noteCreate("", "无标题笔记");
    await mockBackend.noteRename(id, "测试/斜杠:标题");
    const note = await mockBackend.noteGet(id);
    expect(note.title).toBe("测试/斜杠:标题");
    expect(note.relPath).toBe("笔记/测试／斜杠：标题.md");
    expect(folderOf(note)).toBe("");
  });
});

describe("mock backend：使用指南", () => {
  it("a new vault holds only the guides, the welcome one pinned on top", async () => {
    const api = await reopen();
    const notes = await api.noteList(false);
    expect(notes.map((note) => note.title)).toEqual(["欢迎使用 Odea", "语法全览"]);
    expect(notes[0]!.isPinned).toBe(true);
    expect(await api.noteList(true)).toEqual([]);
    expect(await api.journalList()).toEqual([]);
    expect(await api.guidePending()).toEqual([]);
    // 给前端的笔记里没有 mock 自己的记号；列表里不带正文（和 Rust 的 note_list 一样）
    expect(Object.keys(notes[0]!)).not.toContain("guide");
    expect(Object.keys(notes[0]!)).not.toContain("contentMd");
  });

  it("after an upgrade: untouched guides follow, edited ones wait for the user", async () => {
    await reopen();
    // 把存档改成「旧版应用写的」：欢迎那篇没改过（只勾了一项），语法全览被用户改过
    const saved = JSON.parse(localStorage.getItem(LS_KEY)!);
    const firstTask = /- \[ \] (.+)/.exec(GUIDES[0]!.body)![1]!;
    for (const note of saved.notes) {
      if (note.guide.name === "welcome") {
        note.contentMd = `旧版的欢迎\n\n- [x] ${firstTask}\n`;
        note.guide = { name: "welcome", version: "0.0.1", hash: guideFingerprint(note.contentMd) };
      } else {
        note.guide = { name: "syntax", version: "0.0.1", hash: guideFingerprint("旧版的语法") };
        note.contentMd = "旧版的语法\n\n我自己加的一段";
      }
    }
    localStorage.setItem(LS_KEY, JSON.stringify(saved));
    vi.resetModules();

    const api = await reopen();
    const [welcome, syntax] = await Promise.all(
      (await api.noteList(false)).map((note) => api.noteGet(note.id)),
    );
    expect(welcome!.contentMd).toContain(`- [x] ${firstTask}`);
    expect(welcome!.contentMd).not.toContain("旧版的欢迎");
    expect(syntax!.contentMd).toBe("旧版的语法\n\n我自己加的一段");

    const pending = await api.guidePending();
    expect(pending).toEqual([{ id: syntax!.id, name: "syntax", body: GUIDES[1]!.body }]);
    await api.guideSettle(syntax!.id);
    expect(await api.guidePending()).toEqual([]);
  });

  it("a deleted guide comes back only when asked for", async () => {
    const api = await reopen();
    const id = await api.guideOpen("welcome");
    await api.noteDelete(id);
    vi.resetModules();

    const again = await reopen();
    expect((await again.noteList(false)).map((note) => note.title)).toEqual(["语法全览"]);
    const recreated = await again.guideOpen("welcome");
    expect(recreated).not.toBe(id);
    expect((await again.noteGet(recreated)).contentMd).toBe(GUIDES[0]!.body);
  });
});
