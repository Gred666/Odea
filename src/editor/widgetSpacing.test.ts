import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CodeMirror 用 getBoundingClientRect()（边框盒）测量 widget 的高度，
 * margin 不在边框盒里。所以 widget 上的 margin 会让高度图比真实布局短，
 * 点击坐标就会映射到错误的行 —— 表现为「点这一行，光标跳到下一行」。
 *
 * 实测：.cm-otw-table-widget 的 margin: 0.9em 0（font-size 14px）每个表格
 * 少算 25.2px，一篇有三个表格的文档累计偏 76px，标题行点下去落到下一行。
 *
 * 规则：widget 的间距一律用 padding（或外层容器的 padding），不许用 margin。
 */
const CSS = readFileSync(path.join(process.cwd(), "src/styles/globals.css"), "utf8");

/** 这些类会成为 widget 的最外层元素，它们的 margin 不会被计入高度图。 */
const WIDGET_ROOT_CLASSES = [
  "cm-otw-table-block",
  "cm-otw-fence-block",
  "cm-otw-hr",
  "cm-otw-image-frame",
  "cm-otw-image",
];

function declarationsFor(className: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(^|\n)([^\n{]*\.${className}[^\n{]*)\{([^}]*)\}`, "g");
  let match = re.exec(CSS);
  while (match) {
    out.push(
      ...match[3]!
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean),
    );
    match = re.exec(CSS);
  }
  return out;
}

describe("widget 间距不能用 margin", () => {
  for (const className of WIDGET_ROOT_CLASSES) {
    it(`.${className} 没有 margin 声明`, () => {
      const declarations = declarationsFor(className);
      expect(declarations.length).toBeGreaterThan(0);
      const margins = declarations.filter((d) => /^margin(-top|-bottom|-block)?\s*:/.test(d));
      // margin: 0 是允许的（显式清零）
      const nonZero = margins.filter((d) => !/:\s*0(px|em|rem)?\s*$/.test(d));
      expect(nonZero).toEqual([]);
    });
  }
});

/**
 * 代码块 / 属性块的围栏：光标不在里面时是封口 widget，进去以后是源码行。两种
 * 状态这一行必须一样高，否则一点进代码块，上面的围栏行一变高矮，整块代码连同
 * 刚点的那一行一起跳。两边都从同一组变量取数，这里守着别有人只改一边。
 */
describe("围栏的封口和源码行同高", () => {
  const uses = (className: string, variable: string) =>
    declarationsFor(className).some((d) => d.includes(`var(${variable})`));

  it("code fence caps and revealed fence lines share the fence geometry", () => {
    expect(uses("cm-otw-code-fence.is-open", "--fence-open")).toBe(true);
    expect(uses("cm-otw-code-fence", "--fence-close")).toBe(true);
    expect(uses("cm-otw-fence-block.is-open", "--fence-gap")).toBe(true);
    expect(uses("cm-otw-fence-block.is-close", "--fence-gap")).toBe(true);
    for (const variable of ["--fence-gap", "--fence-open", "--fence-line"]) {
      expect(uses("cm-otw-fence-source.is-open", variable), variable).toBe(true);
    }
    for (const variable of ["--fence-gap", "--fence-close"]) {
      expect(uses("cm-otw-fence-source.is-close", variable), variable).toBe(true);
    }
  });

  it("front matter caps and revealed fence lines share the front matter geometry", () => {
    expect(uses("cm-otw-frontmatter-fence.is-open", "--frontmatter-open")).toBe(true);
    expect(uses("cm-otw-frontmatter-fence", "--frontmatter-close")).toBe(true);
    expect(uses("cm-otw-frontmatter-block.is-close", "--frontmatter-gap")).toBe(true);
    expect(uses("cm-otw-frontmatter-fence-line.is-open", "--frontmatter-open")).toBe(true);
    for (const variable of ["--frontmatter-gap", "--frontmatter-close"]) {
      expect(uses("cm-otw-frontmatter-fence-line.is-close", variable), variable).toBe(true);
    }
  });
});

/**
 * 标题行里隐藏的 `## ` 两侧，CodeMirror 各放一个光标占位图片（img.cm-widgetBuffer，
 * 1em 高、text-top 对齐）。标题行高偏紧，它会把这一行撑高 5–7px；光标一放上去 `##`
 * 露出来、占位图片消失，整行缩回去，下面整篇跟着跳。实测贴行顶对齐后不再跳，
 * 这里守着别让这条规则被删掉或改回去。
 */
describe("标题行的光标占位图片不撑高行", () => {
  it("aligns widget buffers to the top of heading lines", () => {
    const rule =
      /:is\([^)]*\.cm-otw-h1[^)]*\.cm-otw-h6[^)]*\)\s*\.cm-widgetBuffer\s*\{([^}]*)\}/.exec(CSS);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/vertical-align:\s*top/);
  });
});

/**
 * 行内带底色的样式（双链小块之类）不能上下加 padding：编辑器的行只有 1.4 倍高（23.8px），
 * 字体框已经 22px，底色再往上冒就会盖住上一行的下划线 —— 每一行是 position: relative，
 * 后面的行整个画在前面的行上面。
 */
describe("行内底色不越出这一行", () => {
  it("the wikilink chip has no vertical padding in the editor", () => {
    const padding = declarationsFor("cm-otw-wikilink").find((d) => d.startsWith("padding"));
    expect(padding).toBe("padding: 0 0.32em");
  });
});
