import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { footprintOf } from "@/lib/edgeShape";
import { describe, expect, it } from "vitest";

/*
 * 弧线的硬规定（docs/技术方案.md §9.6）：圆角只取档位（xs 4 / sm 6 / md 8 / lg 10 / xl 14 / 2xl 18），
 * 画成曲率连续的那一种（border-radius 1.4907R + corner-shape: superellipse(1.58)）。
 *
 * 2026-11-19 收的时候，源码里有二十来处 rounded-[5px] 之类的任意值、十几处裸的 rounded，
 * globals.css 里七十多处手写的像素值（2px、3px、5px、7px……），同一类控件各写各的。
 * 这里扫一遍，新写的不在档位里、或者写了圆角没配 corner-shape 就挂。
 */

const SRC = join(__dirname, "..");
const TOKENS = ["xs", "sm", "md", "lg", "xl", "2xl"];
/** 工具类：档位、只圆一边的那几个（globals.css 里一个个定义的）、正圆、胶囊 */
const CLASSES = new Set([
  ...TOKENS.map((token) => `rounded-${token}`),
  "rounded-t-lg",
  "rounded-tl-lg",
  "rounded-r-sm",
  "rounded-full",
  "rounded-capsule",
  "rounded-none",
]);

function sources(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !file.includes(".test."))
    .map((file) => file.replaceAll("\\", "/"));
}

const css = (file: string) => readFileSync(join(SRC, file), "utf8");

/** 一条条规则：选择器和里面的声明（不管嵌套，够用了：圆角都写在最里层） */
function rules(source: string): { selector: string; body: string; line: number }[] {
  const out: { selector: string; body: string; line: number }[] = [];
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of text.matchAll(pattern)) {
    out.push({
      selector: match[1]!.trim(),
      body: match[2]!,
      line: text.slice(0, match.index).split("\n").length,
    });
  }
  return out;
}

/** 允许的 border-radius 值：档位（可以只圆几个角）、胶囊、正圆（50%，或 rounded-full 那个无穷大）、0 */
const CORNER = String.raw`var\(--corner-(?:${TOKENS.join("|")})\)|0`;
const ALLOWED_VALUE = new RegExp(
  String.raw`^(?:(?:${CORNER})(?:\s+(?:${CORNER})){0,3}|999px|50%|calc\(infinity \* 1px\))$`,
);

/**
 * 白名单：有理由不取档位的那几处（文件:选择器 → 允许的值）。理由在 CSS 里那条规则上面的注释里，这里只记一句；
 * 加新的之前先想想能不能归到档位上
 */
const TABLE_INNER = "calc(var(--corner-lg) - 1px)";
const EXEMPT: Record<string, string> = {
  // 表格四个角上那一格的选区描边：贴着外框（rounded-lg、1px 边框）的内沿，值照抄浏览器裁剪内边距盒用的那个
  "styles/globals.css:.odea-editor .cm-odea-table-frame:is(.is-markdown, .is-html:not(.has-caption)) .at-tl::after":
    TABLE_INNER,
  "styles/globals.css:.odea-editor .cm-odea-table-frame:is(.is-markdown, .is-html:not(.has-caption)) .at-tr::after":
    TABLE_INNER,
  "styles/globals.css:.odea-editor .cm-odea-table-widget .at-bl::after": TABLE_INNER,
  "styles/globals.css:.odea-editor .cm-odea-table-widget .at-br::after": TABLE_INNER,
  // 图片拖柄那个 ⌟：1.5px 笔画拐弯处的圆头，是图标不是盒子
  "styles/globals.css:.odea-editor .cm-odea-image-handle::after": "2px",
};

/**
 * 一个 CSS 文件里的圆角：border-radius 只写档位（var(--corner-*)，可以只圆几个角）、999px 的胶囊、50% 的正圆、0；
 * 写了档位、胶囊的那条规则要配曲率连续的角 —— globals.css 里是 @apply corner-continuous（或者整条
 * @apply rounded-*），static.css 不经过 Tailwind，是文件末尾那一条集中写的 corner-shape
 */
function checkCss(file: string, continuous: (selector: string, body: string) => boolean): string[] {
  const hits: string[] = [];
  for (const { selector, body, line } of rules(css(file))) {
    for (const match of body.matchAll(/@apply\s+([^;]+);/g)) {
      for (const name of match[1]!.split(/\s+/)) {
        if (name.startsWith("rounded") && !CLASSES.has(name))
          hits.push(`${file}:${line} ${selector} → @apply ${name}`);
      }
    }
    // border-radius、border-top-left-radius、border-start-end-radius 都算（只圆一个角的长写法也要守）
    for (const match of body.matchAll(/border(?:-[a-z]+)*-radius\s*:\s*([^;]+);/g)) {
      const value = match[1]!.trim();
      const exempt = EXEMPT[`${file}:${selector}`] === value;
      if (!exempt && !ALLOWED_VALUE.test(value))
        hits.push(`${file}:${line} ${selector} → ${value}`);
      else if (/var\(--corner-|999px/.test(value) && !continuous(selector, body))
        hits.push(`${file}:${line} ${selector} → ${value}（角没配 corner-shape）`);
    }
  }
  return hits;
}

describe("弧线（技术方案 §9.6）", () => {
  const files = sources();

  it("finds the sources", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("uses only rounded-* classes on the scale (no rounded-[5px], no bare rounded)", () => {
    const hits: string[] = [];
    for (const file of files) {
      const lines = css(file).split("\n");
      for (const [i, line] of lines.entries()) {
        // 注释里提到的不算
        const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
        for (const match of code.matchAll(/(?<![\w-])rounded(?:-[\w[\].%/]+)?(?![\w-])/g)) {
          const name = match[0];
          // 「rounded」这个词出现在别的地方（变量名、字段）：只认长得像类名、挨着引号或空格的
          const before = code[match.index! - 1] ?? " ";
          const after = code[match.index! + name.length] ?? " ";
          if (!/[\s"'`]/.test(before) || !/[\s"'`]/.test(after)) continue;
          if (!CLASSES.has(name)) hits.push(`${file}:${i + 1} ${name}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("writes inline border radii through cornerRadius()", () => {
    const hits = files.flatMap((file) =>
      css(file)
        .split("\n")
        .flatMap((line, i) =>
          /borderRadius\s*:/.test(line) && !/cornerRadius\(/.test(line) ? [`${file}:${i + 1}`] : [],
        ),
    );
    expect(hits).toEqual([]);
  });

  it("globals.css only writes radii on the scale, each with continuous corners", () => {
    const hits = checkCss(
      "styles/globals.css",
      (_, body) => /@apply[^;]*\bcorner-continuous\b/.test(body) || body.includes("corner-shape:"),
    );
    expect(hits).toEqual([]);
    // corner-shape 只在两处写：连续曲率的 corner-continuous、正圆的 corner-round
    const literal = rules(css("styles/globals.css")).filter((rule) =>
      /corner-shape\s*:/.test(rule.body),
    );
    expect(literal.map((rule) => rule.selector)).toEqual([
      "@utility corner-continuous",
      "@utility corner-round",
    ]);
  });

  it("circles in globals.css say corner-shape: round (the global :focus-visible would square them off)", () => {
    // :focus-visible 在 base 层 @apply rounded-sm，连带 superellipse；正圆不自己写 round，聚焦时就变成方圆
    const hits = rules(css("styles/globals.css"))
      .filter(
        ({ body }) =>
          /border-radius\s*:\s*50%/.test(body) && !/@apply[^;]*\bcorner-round\b/.test(body),
      )
      .map(({ selector, line }) => `styles/globals.css:${line} ${selector}`);
    expect(hits).toEqual([]);
    const full = rules(css("styles/globals.css")).find(
      (rule) => rule.selector === "@utility rounded-full",
    );
    expect(full?.body).toMatch(/@apply\s+corner-round/);
  });

  it("the static render (embeds, exported pages) only writes radii on the scale, each with continuous corners", () => {
    const source = css("render/static.css");
    const group = source.match(/\.odea-static\s*:is\(([^{]*)\)\s*\{[^}]*corner-shape/)?.[1] ?? "";
    const covered = new Set(group.split(/,\s*(?![^()]*\))/).map((part) => part.trim()));
    const hits = checkCss("render/static.css", (selector) =>
      covered.has(selector.replace(/^\.odea-static\s+/, "").trim()),
    );
    expect(hits).toEqual([]);
  });

  it("the scale and the 1.4907 factor match lib/edgeShape.ts", () => {
    const source = css("styles/globals.css");
    const values = TOKENS.map((token) =>
      Number(source.match(new RegExp(String.raw`--radius-${token}:\s*(\d+)px`))?.[1]),
    );
    expect(values).toEqual([4, 6, 8, 10, 14, 18]);
    const scale = Number(source.match(/--corner-scale:\s*(1\.\d+)/)?.[1]);
    // 精确积分是 1.49064；文档和 CSS 写 1.4907，R = 18 时差 0.001px
    expect(scale).toBeCloseTo(footprintOf(100) / 100, 3);
    expect(css("export/document.ts")).toContain(`--corner-scale: ${scale}`);
  });
});
