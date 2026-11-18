import { describe, expect, it } from "vitest";
import {
  contextLine,
  findWikiLinks,
  linkableTitle,
  linkedNote,
  retargetWikiLinks,
  sameTitle,
  splitWikiSegments,
  wikiDisplayText,
  wikiTargetTitle,
} from "./wikilinks";

/* 和 Rust 侧 src-tauri/src/vault/links.rs 的测试同一组用例：两边认的双链必须一样 */
describe("双链", () => {
  const titles = (body: string) => findWikiLinks(body).map((hit) => hit.title);

  it("finds every form of wikilink", () => {
    const body =
      "看 [[周报]] 和 [[周报|上周的]]，跳到 [[周报#结论]]、[[周报^abc]]\n第二行 [[ 京都书店清单 ]]";
    expect(titles(body)).toEqual(["周报", "周报", "周报", "周报", "京都书店清单"]);
    expect(findWikiLinks(body)[4]!.line).toBe(1);
  });

  it("skips code and escapes", () => {
    const body =
      "```\n[[代码里的]]\n```\n`[[行内代码]]` 真的 [[链接]]\n\\[[转义]]\n~~~md\n[[也是代码]]\n~~~";
    expect(titles(body)).toEqual(["链接"]);
  });

  it("retargets only links to the old title", () => {
    const body =
      "看 [[周报]] 和 [[周报|上周的]]，跳到 [[ 周报 #结论]]、[[Weekly^abc]]\n" +
      "`[[周报]]` 是代码，\\[[周报]] 是转义，[[周报 2]] 是别的\n```\n[[周报]]\n```\n末行 [[周报]]";
    expect(retargetWikiLinks(body, "周报", "月报")).toEqual({
      body:
        "看 [[月报]] 和 [[月报|上周的]]，跳到 [[ 月报 #结论]]、[[Weekly^abc]]\n" +
        "`[[周报]]` 是代码，\\[[周报]] 是转义，[[周报 2]] 是别的\n```\n[[周报]]\n```\n末行 [[月报]]",
      count: 4,
    });
    expect(retargetWikiLinks("见 [[weekly notes]]", " Weekly Notes ", "Monthly")).toEqual({
      body: "见 [[Monthly]]",
      count: 1,
    });
    expect(retargetWikiLinks("没有链接", "周报", "月报")).toBeNull();
    expect(retargetWikiLinks("[[月报]]", "周报", "月报")).toBeNull();
  });

  it("knows which titles cannot be written into a link", () => {
    expect(linkableTitle("月报 2026")).toBe(true);
    for (const title of ["", "  ", "C# 笔记", "a|b", "[草稿]", "x^y"]) {
      expect(linkableTitle(title)).toBe(false);
    }
  });

  it("ignores broken brackets", () => {
    expect(titles("[[没有结尾")).toEqual([]);
    expect(titles("[[a [b] c]]")).toEqual([]);
    expect(titles("[[]] [[|别名]]")).toEqual([]);
  });

  it("splits target, alias and display text", () => {
    expect(wikiTargetTitle("周报|上周的")).toBe("周报");
    expect(wikiTargetTitle("周报#结论")).toBe("周报");
    expect(wikiDisplayText("周报|上周的")).toBe("上周的");
    expect(wikiDisplayText("周报#结论")).toBe("周报#结论");
    expect(sameTitle(" Weekly Notes ", "weekly notes")).toBe(true);
    expect(sameTitle("周报", "周报 2")).toBe(false);
  });

  it("splits a line into text and links", () => {
    expect(splitWikiSegments("回看 [[周报|上周的]] 的结论")).toEqual([
      { kind: "text", text: "回看 " },
      { kind: "link", inner: "周报|上周的" },
      { kind: "text", text: " 的结论" },
    ]);
  });

  it("trims list markers, task boxes, quotes and headings from context lines", () => {
    expect(contextLine("- [ ] 回看 [[周报]] 的结论")).toBe("回看 [[周报]] 的结论");
    expect(contextLine("> ## 参考 [[周报]]")).toBe("参考 [[周报]]");
    expect(contextLine("3. 见 [[周报]]")).toBe("见 [[周报]]");
  });
});

// 同名的几篇：`[[` 的提示里只列一篇（审查 2026-11-13 §5.11），点开、嵌进来的得是同一篇
describe("linkedNote", () => {
  const note = (id: string, title: string, updatedAt: number) => ({ id, title, updatedAt });
  it("picks the most recently edited note, archived ones only when nothing else has the title", () => {
    // 置顶的排在列表前面，但不该因此被选上
    const notes = [note("pinned-old", "样张", 1), note("new", "样张 ", 5), note("x", "别的", 9)];
    const archived = [note("archived", "样张", 99), note("only", "旧的", 1)];
    expect(linkedNote(" 样张", notes, archived)?.id).toBe("new");
    expect(linkedNote("旧的", notes, archived)?.id).toBe("only");
    expect(linkedNote("没有", notes, archived)).toBeUndefined();
  });
});
