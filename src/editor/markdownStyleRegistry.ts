/** Markdown 语法树节点的展示声明。新增纯样式语法时只需在这里注册。 */
export interface MarkdownStyleRule {
  nodes: readonly string[];
  className: string;
  kind: "mark" | "line";
}

export const markdownStyleRules: readonly MarkdownStyleRule[] = [
  { nodes: ["StrongEmphasis"], className: "cm-otw-strong", kind: "mark" },
  { nodes: ["Emphasis"], className: "cm-otw-emphasis", kind: "mark" },
  { nodes: ["Strikethrough"], className: "cm-otw-strike", kind: "mark" },
  { nodes: ["Superscript"], className: "cm-otw-sup", kind: "mark" },
  { nodes: ["InlineCode"], className: "cm-otw-code", kind: "mark" },
  { nodes: ["Link", "Autolink", "URL"], className: "cm-otw-link", kind: "mark" },
  { nodes: ["CodeText", "CodeInfo"], className: "cm-otw-code-text", kind: "mark" },
  { nodes: ["HTMLTag"], className: "cm-otw-html", kind: "mark" },
  { nodes: ["LinkReference"], className: "cm-otw-reference", kind: "mark" },
  { nodes: ["Blockquote"], className: "cm-otw-quote", kind: "line" },
  { nodes: ["FencedCode", "CodeBlock"], className: "cm-otw-code-block", kind: "line" },
  {
    nodes: ["HTMLBlock", "CommentBlock", "ProcessingInstructionBlock"],
    className: "cm-otw-html-block",
    kind: "line",
  },
  { nodes: ["Table", "TableHeader", "TableRow"], className: "cm-otw-table", kind: "line" },
  { nodes: ["ListItem"], className: "cm-otw-list-item", kind: "line" },
] as const;

export const hiddenMarkerNodes = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "SubscriptMark",
  "SuperscriptMark",
  "CodeMark",
  "QuoteMark",
  "LinkMark",
  "ImageMarker",
]);

export type MarkdownWidgetKind =
  | "task"
  | "horizontal-rule"
  | "image"
  | "table"
  | "emoji"
  | "entity"
  | "hard-break"
  | "math"
  | "html-tag"
  | "comment";

/** 需要 DOM 表现的语法同样集中注册，核心只分派通用 widget 类型。 */
export const widgetByNode = new Map<string, MarkdownWidgetKind>([
  ["TaskMarker", "task"],
  ["HorizontalRule", "horizontal-rule"],
  ["Image", "image"],
  ["Table", "table"],
  ["Emoji", "emoji"],
  ["Entity", "entity"],
  ["HardBreak", "hard-break"],
  ["InlineMath", "math"],
  ["HTMLTag", "html-tag"],
  ["Comment", "comment"],
]);

export const rulesByNode = new Map(
  markdownStyleRules.flatMap((rule) => rule.nodes.map((node) => [node, rule] as const)),
);

export interface MarkdownSourceStyleRule {
  open: string;
  close: string;
  className: string;
}

/**
 * 供 CommonMark AST 不会合并成单节点的自定义行内语法使用。
 * 配对必须落在同一个块里，且不能在代码字面量内。
 * （`<u>` 以前也在这里；现在所有行内 HTML 标签统一走语法树里的 HTMLTag 配对。）
 */
export const markdownSourceStyleRules: readonly MarkdownSourceStyleRule[] = [
  { open: "==", close: "==", className: "cm-otw-highlight" },
] as const;

export interface SelectionRangeLike {
  from: number;
  to: number;
  head: number;
  empty: boolean;
}

export function selectionTouchesRange(
  ranges: readonly SelectionRangeLike[],
  from: number,
  to: number,
): boolean {
  return ranges.some((range) =>
    range.empty ? range.head >= from && range.head <= to : range.from < to && range.to > from,
  );
}

/**
 * 选区是否要把图片换回源码：光标碰到它（贴在两边也算，点在图片旁边就能改地址），
 * 或者选区只切到它的一部分。选区把它整个包住时不算 —— 拖着选过一张图，图还是图，
 * 不会一松手缩成一行地址、下面整篇往上跳一大截。
 */
export function selectionOpensRange(
  ranges: readonly SelectionRangeLike[],
  from: number,
  to: number,
): boolean {
  return ranges.some((range) =>
    range.empty
      ? range.head >= from && range.head <= to
      : range.from < to && range.to > from && (range.from > from || range.to < to),
  );
}

/**
 * 选区是否「进到了」一个当字符用的替身里（动态表情）：光标严格落在内部，
 * 或者选区只切到它的一部分。光标贴在两边、选区整个把它包住都不算 ——
 * 这时它仍然显示成一个表情。
 */
export function selectionEntersRange(
  ranges: readonly SelectionRangeLike[],
  from: number,
  to: number,
): boolean {
  return ranges.some((range) =>
    range.empty
      ? range.head > from && range.head < to
      : range.from < to && range.to > from && (range.from > from || range.to < to),
  );
}
