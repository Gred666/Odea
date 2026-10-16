import type { MatchAnchor } from "@/data/types";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { matchOnLine, queryOfAnchor } from "./searchPanel";

/*
 * 从全局搜索的结果跳进一篇时选中的是哪一段（searchPanel.ts 的 matchOnLine）：
 * Rust 给的是「第几行、这一行里的 UTF-16 列」，编辑器里按同样的条件在那一行里再找一遍，
 * 正文和索引对不上的时候也不能选错、更不能抛错。
 */

const anchor = (query: string, column: number, extra: Partial<MatchAnchor> = {}): MatchAnchor => ({
  query,
  column,
  length: query.length,
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  ...extra,
});

const doc = "第一行\n今天的进度还可以，进度不错\n🙂进度";
const state = EditorState.create({ doc });
const slice = (range: { from: number; to: number } | null) =>
  range ? state.sliceDoc(range.from, range.to) : null;

describe("matchOnLine", () => {
  it("selects the match at the given column", () => {
    const second = matchOnLine(state, 2, anchor("进度", 9));
    const lineStart = state.doc.line(2).from;
    expect(second).toEqual({ from: lineStart + 9, to: lineStart + 11 });
    // 🙂 占两个 UTF-16 码元：列号和编辑器里的位置是同一个单位
    expect(matchOnLine(state, 3, anchor("进度", 2))).toEqual({
      from: state.doc.line(3).from + 2,
      to: state.doc.line(3).from + 4,
    });
  });

  it("falls back to the nearest match when the text moved a little", () => {
    // 打开后的正文前面多了两个字：列号偏了，还是选中最近的那个
    const range = matchOnLine(state, 2, anchor("进度", 5));
    expect(range?.from).toBe(state.doc.line(2).from + 3);
    expect(slice(range)).toBe("进度");
  });

  it("uses the same toggles, regex included", () => {
    const regex = matchOnLine(state, 2, anchor("进.", 9, { regex: true, length: 2 }));
    expect(slice(regex)).toBe("进度");
    const exact = EditorState.create({ doc: "Cat cat" });
    expect(matchOnLine(exact, 1, anchor("cat", 0, { caseSensitive: true }))).toEqual({
      from: 4,
      to: 7,
    });
  });

  it("selects by column, or just the line start, when the line no longer has it", () => {
    const changed = EditorState.create({ doc: "完全不一样的一行字" });
    expect(matchOnLine(changed, 1, anchor("进度", 2))).toEqual({ from: 2, to: 4 });
    expect(matchOnLine(changed, 1, anchor("进度", 40))).toEqual({ from: 0, to: 0 });
    expect(matchOnLine(changed, 2, anchor("进度", 0))).toBeNull();
    // 正则写错了（JS 不认的写法）也不抛错
    expect(matchOnLine(state, 2, anchor("(?<", 3, { regex: true, length: 2 }))).toEqual({
      from: state.doc.line(2).from + 3,
      to: state.doc.line(2).from + 5,
    });
  });

  it("keeps the query literal when it is not a regex", () => {
    const query = queryOfAnchor(anchor("a\\nb", 0));
    expect(query.literal).toBe(true);
    const literal = EditorState.create({ doc: "x a\\nb" });
    expect(matchOnLine(literal, 1, anchor("a\\nb", 2))).toEqual({ from: 2, to: 6 });
  });
});
