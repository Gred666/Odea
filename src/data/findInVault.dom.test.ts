// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FindOptions, FindResult } from "./types";

/*
 * 浏览器预览用的 mock 后端的全局搜索（findInVault）：结果要和 Rust 的 vault::find_text 一样
 * （同样的例子见 src-tauri/src/vault/tests.rs 的 find_*）。
 */

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

const PLAIN: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };

async function vaultWith(...notes: [string, string][]) {
  const { mockBackend } = await import("./mock");
  // 新仓库里放着使用指南，里面什么字都有：先删掉，只搜这里建的几篇
  for (const note of await mockBackend.noteList(false)) await mockBackend.noteDelete(note.id);
  const ids: string[] = [];
  for (const [title, contentMd] of notes) {
    const id = await mockBackend.noteCreate("", title);
    await mockBackend.noteRename(id, title);
    await mockBackend.noteSave(id, contentMd, null);
    ids.push(id);
  }
  const find = (query: string, options: Partial<FindOptions> = {}) =>
    mockBackend.findInVault(query, { ...PLAIN, ...options });
  return { ids, find };
}

const texts = (found: FindResult) =>
  found.files.flatMap((file) => file.matches.map((match) => match.text));

describe("mock findInVault", () => {
  it("lists every match with its line and UTF-16 column", async () => {
    const { ids, find } = await vaultWith([
      "周报",
      "第一行\n今天的进度还可以，进度不错\n🙂进度\n没有",
    ]);
    const found = await find("进度");
    expect(found.total).toBe(3);
    expect(found.files).toHaveLength(1);
    const [file] = found.files;
    expect(file?.target).toEqual({ kind: "note", id: ids[0] });
    expect(file?.count).toBe(3);
    expect(file?.matches.map((m) => [m.line, m.column, m.length])).toEqual([
      [2, 3, 2],
      [2, 9, 2],
      [3, 2, 2],
    ]);
    expect(file?.matches[0]).toMatchObject({
      before: "今天的",
      text: "进度",
      after: "还可以，进度不错",
    });
    expect((await find("")).files).toEqual([]);
  });

  it("follows the three toggles like the editor search panel", async () => {
    const { find } = await vaultWith(
      ["英文", "Cat concat CAT cat_food\n日期 2026-10-16 和 2026-1-2"],
      ["中文", "写笔记本\n「笔记」\n笔记 很多"],
    );
    expect((await find("cat")).total).toBe(4);
    expect(texts(await find("cat", { caseSensitive: true }))).toEqual(["cat", "cat"]);
    expect(texts(await find("cat", { wholeWord: true }))).toEqual(["Cat", "CAT"]);
    const words = await find("笔记", { wholeWord: true });
    expect(words.files[0]?.matches.map((m) => m.line)).toEqual([2, 3]);
    expect(texts(await find("\\d{4}-\\d{2}-\\d{2}", { regex: true }))).toEqual(["2026-10-16"]);
    expect((await find("2026-1.-16")).total).toBe(0);
    expect((await find("2026-1.-16", { regex: true })).total).toBe(1);
    const bad = await find("(进度", { regex: true });
    expect(bad.files).toEqual([]);
    expect(bad.error).toBeTruthy();
  });

  it("clips long lines around the match", async () => {
    const line = `  ${"前".repeat(100)}目标${"后".repeat(300)}`;
    const { find } = await vaultWith(["长", `${line}\n下一行`]);
    const hit = (await find("目标")).files[0]?.matches[0];
    expect(hit?.before).toBe(`…${"前".repeat(32)}`);
    expect(hit?.after).toBe(`${"后".repeat(160)}…`);
    expect([hit?.line, hit?.column]).toEqual([1, 102]);
  });
});
