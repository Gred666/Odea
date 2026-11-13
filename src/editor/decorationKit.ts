import { type ChangeSet, type EditorState, Facet } from "@codemirror/state";
import { Decoration, type WidgetType } from "@codemirror/view";
import { selectionTouchesRange } from "./markdownStyleRegistry";
import { revealRanges } from "./reveal";
import { OtwWidget } from "./widgets";

/* 两层装饰共用的小件（从 MarkdownEditor.tsx 挪出来，docs/1110审查与研究.md §6.2） */

/**
 * 所有笔记的标题（trim + 小写，和 lib/wikilinks 的 sameTitle 同一个口径）。
 * 链到不存在的笔记的 `[[双链]]` 画成虚线，提示 Ctrl+点击新建。null 是不知道，都当存在。
 */
export const knownWikiTitles = Facet.define<ReadonlySet<string> | null, ReadonlySet<string> | null>(
  { combine: (values) => values[0] ?? null },
);

export const wikiKey = (title: string) => title.trim().toLowerCase();
/** 一个都不认识：双链全按「不存在」画（做客的那一篇） */
export const NO_TITLES: ReadonlySet<string> = new Set();

/** 光标碰没碰到这一段（碰到了就露出源码）。选区不在编辑、鼠标按着时另算，见 reveal.ts */
export function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return selectionTouchesRange(revealRanges(state), from, to);
}

export type DecorationRange = { from: number; to: number; value: Decoration };

/**
 * 替身该不该播入场动画（见 widgets.ts 的 OtwWidget）：它盖住的源码是不是这一次才
 * 出现 / 改动的。changes 为 null 表示整篇初次构建（刚打开笔记），全都算新的；
 * 只动了光标、只滚了视口时 changes 是空的，谁都不算新。
 * 边界相接也算碰到：刚打完 `:smile:` 最后那个冒号，改动正好落在短码末尾。
 */
export function freshness(changes: ChangeSet | null): (from: number, to: number) => boolean {
  if (!changes) return () => true;
  const touched: number[] = [];
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => touched.push(fromB, toB));
  if (!touched.length) return () => false;
  return (from, to) => {
    for (let index = 0; index < touched.length; index += 2) {
      if (touched[index]! <= to && touched[index + 1]! >= from) return true;
    }
    return false;
  };
}

/** 把替身放进文档前，按它盖住的范围定下要不要播入场动画。 */
export function markFreshness(
  widget: WidgetType | undefined,
  from: number,
  to: number,
  fresh: (from: number, to: number) => boolean,
) {
  if (widget instanceof OtwWidget) widget.fresh = fresh(from, to);
}

export const toDecorationSet = (items: DecorationRange[]) =>
  Decoration.set(
    items.map(({ from, to, value }) => value.range(from, to)),
    true,
  );

/** 这些节点内部的文本是字面量，源码级规则不能进去改动显示。 */
export const literalNodes = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "HTMLBlock",
  "CommentBlock",
  "ProcessingInstructionBlock",
  "InlineMath",
  "MathBlock",
  "HTMLTag",
  "Comment",
  "URL",
  "Autolink",
]);

export const FENCE_LINE_RE = /^\s{0,3}(?:`{3,}|~{3,})/;
export const CLOSING_FENCE_RE = /^\s{0,3}(?:`{3,}|~{3,})\s*$/;
export const SETEXT_UNDERLINE_RE = /^\s{0,3}(?:=+|-+)\s*$/;
export const TOC_RE = /^\s*\[\[?toc\]?\]\s*$/i;
/** HTML 块开头是一张表：交给 parseHtmlTable 看是不是能编辑的简单表格 */
export const HTML_TABLE_RE = /^\s*<table[\s>]/i;
export const FOOTNOTE_RE = /^\[\^([^\]\s]+)\]$/;
/** 行首的脚注定义：`[^id]:` 加后面的空白 */
export const FOOTNOTE_DEF_RE = /^\[\^([^\]\s]+)\]:[ \t]*/;
export const CALLOUT_LABEL_RE = /^\[!([^\]\n]+)\]$/;
export const HEADING_RE = /^(?:ATX|Setext)Heading([1-6])$/;
/** 缩写定义：`*[HTML]: HyperText Markup Language` */
export const ABBREVIATION_RE = /^\s{0,3}\*\[([^\]\n]+)\]:[ \t]+(\S.*?)\s*$/;
/** 定义列表里的定义行：`: 释义` */
export const DEFINITION_RE = /^\s{0,3}:[ \t]+(?=\S)/;
/** 长得像块级语法开头的行，不能当定义列表的术语 */
export const BLOCK_START_RE = /^\s{0,3}(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s|`{3,}|~{3,}|\||\$\$|<|\[\^)/;
/** 整行都是分隔符：分隔线、Setext 下划线 —— 智能标点不能碰 */
export const RULE_LINE_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,}|={3,})\s*$/;
/** 智能标点：显示层替换，源码不动 */
export const SMART_RE = /---|--|\.\.\.|\((?:c|r|tm)\)/gi;
export const SMART_GLYPHS: Readonly<Record<string, string>> = {
  "---": "—",
  "--": "–",
  "...": "…",
  "(c)": "©",
  "(r)": "®",
  "(tm)": "™",
};
export const BULLET_GLYPHS = ["•", "◦", "▪"];
/* 列表符号格的宽度，单位是正文字号（globals.css「列表的几何」）。任务项的宽度和
   .cm-odea-task 左右的空加起来要相等；有序列表按最大编号的位数加宽 */
export const LIST_BULLET_WIDTH = 1.55;
export const LIST_TASK_WIDTH = 1.8;
export const LIST_ORDERED_WIDTH = 1;
export const LIST_DIGIT_WIDTH = 0.56;
export const listUnits = (value: number) =>
  `calc(var(--odea-body-size) * ${Math.round(value * 1000) / 1000})`;
