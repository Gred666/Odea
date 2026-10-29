// @vitest-environment happy-dom

import katex from "katex";
import { describe, expect, it } from "vitest";
import { type MathSize, chooseFit, prepareBreaks } from "./math";

/*
 * 太宽的块级公式怎么放（editor/math.ts 文件头）：缩一点 / 折行 / 滑动。
 * 量尺寸要真的排版，happy-dom 做不到，这里测两件不用排版的事：按尺寸选放法，
 * 和渲染完以后给折行做的准备（分行、粘括号）。真排出来的样子用 1.5 倍屏无头 Chrome
 * 在 1280 / 1000 / 820 / 700 宽下逐条查过（docs/TODO.md 2026-10-29）
 */

const size = (over: Partial<MathSize>): MathSize => ({
  available: 600,
  width: 500,
  widest: 100,
  count: 10,
  tag: 0,
  em: 18,
  ...over,
});

describe("太宽的块级公式选哪种放法", () => {
  it("放得下就原样居中", () => {
    expect(chooseFit(size({ width: 600 }))).toEqual({ scale: 1, wrap: false, scroll: false });
  });

  it("只宽一点（缩到 92% 就放得下）：整体缩一点，不折行", () => {
    expect(chooseFit(size({ width: 640 }))).toEqual({ scale: 0.93, wrap: false, scroll: false });
  });

  it("再宽就原字号折行，不再一路缩到看不清", () => {
    expect(chooseFit(size({ width: 1600 }))).toEqual({ scale: 1, wrap: true, scroll: false });
  });

  it("折开以后最宽的那一段放不下：缩到 90% 能放下就缩，不能就滑", () => {
    // 那一段要放在续行上（缩进 2em = 36px）
    expect(chooseFit(size({ width: 1600, widest: 600 }))).toEqual({
      scale: 0.94,
      wrap: true,
      scroll: false,
    });
    expect(chooseFit(size({ width: 1600, widest: 900 }))).toEqual({
      scale: 1,
      wrap: true,
      scroll: true,
    });
  });

  it("没有能断的地方（一整块矩阵）：缩一点或者滑，不折", () => {
    expect(chooseFit(size({ width: 660, count: 1 }))).toEqual({
      scale: 0.9,
      wrap: false,
      scroll: false,
    });
    expect(chooseFit(size({ width: 900, count: 1 }))).toEqual({
      scale: 1,
      wrap: false,
      scroll: true,
    });
  });

  it("有编号：公式两边都得让出编号的宽度，不然右端压在编号上", () => {
    // 500 + 2 × (40 + 18) = 616 > 600：不能原样放
    expect(chooseFit(size({ width: 500, tag: 40 })).scale).toBeLessThan(1);
    expect(chooseFit(size({ width: 480, tag: 40 }))).toEqual({
      scale: 1,
      wrap: false,
      scroll: false,
    });
  });

  it("还没渲染出来、列宽是 0（藏着）：不动", () => {
    expect(chooseFit(size({ width: 0 }))).toEqual({ scale: 1, wrap: false, scroll: false });
    expect(chooseFit(size({ available: 0, width: 900 }))).toEqual({
      scale: 1,
      wrap: false,
      scroll: false,
    });
  });
});

/** 渲染一条块级公式、做好折行准备，返回能断开的各段（每一行一组）的文字 */
function prepared(tex: string) {
  const node = document.createElement("div");
  node.innerHTML = katex.renderToString(tex, {
    displayMode: true,
    throwOnError: false,
    strict: "ignore",
  });
  prepareBreaks(node);
  const html = node.querySelector(".katex-html")!;
  const rows = [...html.querySelectorAll(":scope > .cm-odea-math-row")];
  return {
    html,
    rows,
    pieces: rows.map((row) =>
      [...row.children]
        .filter((part) => !part.classList.contains("katex-tag"))
        .map((part) => part.textContent?.replace(/​/g, "") ?? ""),
    ),
  };
}

const balanced = (text: string) => {
  let depth = 0;
  for (const char of text) {
    if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) depth--;
  }
  return depth === 0;
};

describe("折行之前的准备", () => {
  it("括号里的减号后面 KaTeX 也切了：粘回去，每一段括号都是配平的", () => {
    const { pieces } = prepared(String.raw`f(x)=f(x_0)+f'(x_0)(x-x_0)+O((x-x_0)^n)`);
    expect(pieces).toHaveLength(1);
    for (const piece of pieces[0]!) expect(balanced(piece), piece).toBe(true);
    expect(pieces[0]!.some((piece) => piece.includes("(x−x0​)") || piece.includes("(x−x0)"))).toBe(
      true,
    );
  });

  it("绝对值的两条竖线之间不断；括号里的竖线（条件概率）不当成一对", () => {
    const abs = prepared(String.raw`|x_1-y_1|+|x_2-y_2|+|x_3-y_3|`).pieces[0]!;
    expect(abs.length).toBeGreaterThanOrEqual(3);
    for (const piece of abs) expect(piece.split("|").length % 2, piece).toBe(1);
    // P(A|B) 后面的 = 照样能断：竖线没有把后面全粘起来
    const bayes = prepared(String.raw`P(A|B)=\frac{P(B|A)P(A)}{P(B)}=x+y`).pieces[0]!;
    expect(bayes.length).toBeGreaterThanOrEqual(3);
  });

  it("手写的 \\\\ 分出来的每一行各是一块；括号不跨行粘", () => {
    const { rows, html } = prepared(String.raw`a+b+(c \\ d)+e`);
    expect(rows).toHaveLength(2);
    // 换行还在两块中间，别的都进了行里
    expect(
      [...html.children].map((child) =>
        child.classList.contains("katex-newline") ? "newline" : child.className,
      ),
    ).toEqual(["cm-odea-math-row", "newline", "cm-odea-math-row"]);
  });

  it("编号放进最后一行，前面垫一个空格（折行时靠它把编号推到右边）", () => {
    const { rows } = prepared(String.raw`a+b+c \tag{1}`);
    const last = rows.at(-1)!;
    const tag = last.querySelector(":scope > .katex-tag")!;
    expect(tag).not.toBeNull();
    expect(tag.previousSibling?.nodeType).toBe(Node.TEXT_NODE);
    expect(tag.previousSibling?.textContent).toBe(" ");
  });

  it("只有半个括号（\\text 里的）：后面粘成一段，不出错", () => {
    const { pieces } = prepared(String.raw`\text{(注}+a+b+c`);
    expect(pieces[0]).toHaveLength(1);
  });

  it("渲染出错的公式没有 .katex-html：什么都不做", () => {
    const node = document.createElement("div");
    node.textContent = "\\frac{";
    expect(() => prepareBreaks(node)).not.toThrow();
  });
});
