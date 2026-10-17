import { commonmarkLanguage } from "@codemirror/lang-markdown";
import type { MarkdownParser } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { markdownExtensions } from "./markdownParser";
import {
  markdownSourceStyleRules,
  rulesByNode,
  selectionTouchesRange,
  widgetByNode,
} from "./markdownStyleRegistry";

const parser = (commonmarkLanguage.parser as MarkdownParser).configure(markdownExtensions);
const syntaxNames = (markdown: string) => {
  const names = new Set<string>();
  parser.parse(markdown).iterate({ enter: (node) => void names.add(node.name) });
  return names;
};

describe("Markdown style registry", () => {
  it.each([
    ["~~删除~~", "Strikethrough"],
    ["```ts\nconst value = 1\n```", "FencedCode"],
    ["| A | B |\n|---|---|\n| 1 | 2 |", "Table"],
    ["<kbd>Ctrl</kbd>", "HTMLTag"],
    ["[引用][id]\n\n[id]: https://example.com", "LinkReference"],
    ["~单个波浪线~", "Strikethrough"],
    ["x^2^", "Superscript"],
    ["<div>\nx\n</div>", "HTMLBlock"],
  ])("registers styles for %s", (markdown, node) => {
    expect(syntaxNames(markdown).has(node)).toBe(true);
    expect(rulesByNode.has(node)).toBe(true);
  });

  it.each([
    ["- [x] 完成", "TaskMarker"],
    ["---", "HorizontalRule"],
    ["![图片](https://example.com/a.png)", "Image"],
    [":smile:", "Emoji"],
    ["&amp;", "Entity"],
    ["a  \nb", "HardBreak"],
    ["$x$", "InlineMath"],
    ["<b>x</b>", "HTMLTag"],
    ["a <!-- x --> b", "Comment"],
  ])("registers widgets for %s", (markdown, node) => {
    expect(syntaxNames(markdown).has(node)).toBe(true);
    expect(widgetByNode.has(node)).toBe(true);
  });

  it("registers ==highlight== as an extensible source rule", () => {
    expect(markdownSourceStyleRules).toContainEqual({
      open: "==",
      close: "==",
      className: "cm-odea-highlight",
    });
  });

  it("reveals markers only when the selection touches that styled span", () => {
    const cursor = (head: number) => [{ from: head, to: head, head, empty: true }];
    expect(selectionTouchesRange(cursor(2), 8, 16)).toBe(false);
    expect(selectionTouchesRange(cursor(10), 8, 16)).toBe(true);
    expect(selectionTouchesRange([{ from: 0, to: 5, head: 5, empty: false }], 8, 16)).toBe(false);
  });
});
