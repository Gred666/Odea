import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 所有选择器（逗号分开的一条一条），不管在不在 @media 里 */
const selectors = [...css.matchAll(/([^{}]+)\{/g)]
  .flatMap((match) => match[1]!.split(","))
  .map((selector) => selector.trim())
  .filter((selector) => selector && !selector.startsWith("@"));

describe("焦点一变就整棵子树重算样式的选择器", () => {
  // `:focus` 后面跟着后代（`:focus ::selection`、`:focus *`）：Chrome 只能在焦点每变一次时把那个元素的
  // 整棵子树作废样式。正文 .cm-content 每得一次、失一次焦点，画出来的整篇正文都重算一遍
  // （审查 2026-11-13 §4.59：长文 4 倍降速下 26–39ms，开关命令面板、Ctrl+Tab 换篇每次都付）
  // 后代带类名（`:focus .x`）只作废那几个 .x，不算；没有类名的（`*`、`::selection`、`:not(…)`）才是整棵
  it("never puts a bare descendant (*, ::pseudo, :pseudo) after :focus / :focus-visible", () => {
    const offending = selectors.filter((selector) => /:focus(-visible)?\s+(\*|:)/.test(selector));
    expect(
      [".odea-editor .cm-content :focus ::selection", ".a:focus-visible *"].every((selector) =>
        /:focus(-visible)?\s+(\*|:)/.test(selector),
      ),
    ).toBe(true);
    expect(offending).toEqual([]);
  });
});
