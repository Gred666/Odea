// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { longRuns } from "./longRuns";

/* 很长、中间没有断点的西文串允许任意处断行（longRuns.ts）：两端对齐时前一行才不会被撑开 */

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

function marked(doc: string): string[] {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [longRuns] }),
  });
  views.push(view);
  return [...parent.querySelectorAll(".cm-odea-long-run")].map((el) => el.textContent ?? "");
}

describe("很长的西文串", () => {
  it("一直按着的字母、网址、哈希标出来；普通单词、汉字不动", () => {
    const k = "k".repeat(60);
    expect(marked(`但是你的很${k}`)).toEqual([k]);
    expect(marked("看 https://example.com/a/very/long/path?x=1 这里")).toEqual([
      "https://example.com/a/very/long/path?x=1",
    ]);
    expect(marked("internationalization and localization are words")).toEqual([]);
    expect(marked("汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字")).toEqual([]);
    // 汉字把长串隔开：两段都不够长就都不算
    expect(marked(`${"a".repeat(20)}中${"b".repeat(20)}`)).toEqual([]);
  });
});

describe("组字的那一行", () => {
  const composingLines = (parent: HTMLElement) =>
    [...parent.querySelectorAll(".cm-odea-composing")].map((el) => el.textContent ?? "");

  it("lets the line being composed break anywhere, from the first composed change until it ends", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const doc = "第一行\n两端对齐的正文里打字";
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [longRuns] }),
    });
    views.push(view);

    // 刚开始组字时不动 DOM（输入法这时刚起头），第一笔组字的改动进来才加
    view.contentDOM.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    expect(composingLines(parent)).toEqual([]);
    view.dispatch({
      changes: { from: doc.length, insert: "zh" },
      selection: { anchor: doc.length + 2 },
      userEvent: "input.type.compose",
    });
    expect(composingLines(parent)).toEqual(["两端对齐的正文里打字zh"]);
    // 别的改动（不是组字）不加也不摘
    view.dispatch({ changes: { from: 0, insert: "前" } });
    expect(composingLines(parent)).toEqual(["两端对齐的正文里打字zh"]);

    view.contentDOM.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(composingLines(parent)).toEqual([]);
  });
});
