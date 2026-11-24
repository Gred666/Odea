import { animatedEmojiFor } from "@/editor/animatedEmoji";
import { type CalloutKind, calloutIcon, parseCalloutHead } from "@/editor/callout";
import { codeHighlightStyle } from "@/editor/codeHighlight";
import { emojiFor } from "@/editor/emoji";
import { decodeEntity } from "@/editor/entities";
import { isFrontMatterKey } from "@/editor/frontMatter";
import {
  INLINE_HTML_TAGS,
  hasRenderableHtml,
  inlineStyleOf,
  parseTag,
  safeHref,
  sanitizeHtml,
} from "@/editor/html";
import { parseImage } from "@/editor/images";
import { normalizeLabel, splitWikiTarget } from "@/editor/links";
import { markdownExtensions } from "@/editor/markdownParser";
import {
  type MarkdownTableModel,
  numericColumns,
  parseDelimitedTable,
  parseMarkdownTable,
} from "@/editor/markdownTable";
import { resolveGrid } from "@/editor/tableGrid";
import {
  BULLET_GLYPHS,
  COPY_ICON,
  LIST_BULLET_WIDTH,
  LIST_DIGIT_WIDTH,
  LIST_ORDERED_WIDTH,
  LIST_TASK_WIDTH,
  TASK_CHECK_ICON,
  listUnits,
} from "@/editor/widgetShapes";
import { type EmbedTarget, noteEmbedTarget } from "@/lib/embeds";
import { ANIMATED_EMOJI_FALLBACK } from "@/lib/emojiText";
import { MIN_RUN, NOT_CJK } from "@/lib/longRun";
import { attachmentLabel, wikiFileTarget, wikiImageTarget } from "@/lib/wikiFiles";
import type { SyntaxNode, Tree } from "@lezer/common";
import { parser as baseParser } from "@lezer/markdown";

/* ============================================================
   静态渲染：一篇 Markdown → 一段 HTML。导出 HTML / PDF（export/document.ts）和 `![[笔记]]` 的嵌入卡片
   （editor/embed.ts）用它。样式在 render/static.css，外层套一个带 `odea-static` 类的元素。

   认语法和编辑器是同一套：同一个 Lezer 解析器配置（editor/markdownParser.ts）；装饰层里按正则认的
   （callout、脚注、双链、==高亮==、定义列表、缩写、[TOC]、合并单元格 `<` `^`、智能标点）照着
   编辑器装饰层（blockDecorations.ts、inlineDecorations.ts）的规矩来；行内 HTML、块级 HTML 走同一份白名单（editor/html.ts）。编辑器里
   看到什么，导出来就是什么：

   - 段落里的换行就是换行（编辑器里一行源码就是一行），不并成空格
   - 收起的 callout（`[!x]-`）是能点开的 <details>；打印时（expandFolds）一律展开
   - 脚注收到最后，按第一次引用的先后编号
   - 开头的属性块不出现

   用户写的字一律转义；块级 HTML 先经 sanitizeHtml 按白名单重建。图片、公式、图表、代码高亮、嵌入
   是异步的：先放一个占位记号（slot），最后一起换上。
   ============================================================ */

export interface StaticOptions {
  /**
   * 正文里写的图片地址（相对这一篇、本机路径、网址、data:）→ <img src>。null = 画不出来，显示 alt。
   * 导出时读文件、嵌成 data:；嵌入卡片里转成 asset 协议
   */
  image: (source: string) => string | null | Promise<string | null>;
  /** Obsidian 的 `![[图.png]]`：写的名字 → <img src>；找不到 null */
  wikiImage: (name: string) => string | null | Promise<string | null>;
  /**
   * 单独一行的 `![[笔记]]`、`![[笔记#小节]]`：嵌进来的那一篇（已经渲染好的 HTML）。
   * 没给、或者返回 null（没有这一篇）就画成一个双链
   */
  embed?: (target: EmbedTarget) => Promise<string | null>;
  /**
   * `[[双链]]` 链到哪：返回地址就画成真的链接（导出整个文件夹成网页时，链到同一批里的那一页）；
   * 没给、或者返回 null 照旧是一个不能点的双链样子
   */
  wikiHref?: (title: string, heading: string | undefined) => string | null;
  /** 画公式（KaTeX）。不画就显示 TeX 原文 */
  math: boolean;
  /** 画图表（mermaid）。不画就是一段代码 */
  diagrams: boolean;
  /** 代码块按语言上色 */
  highlight: boolean;
  /** 收起的 callout 也展开（打印） */
  expandFolds?: boolean;
  /** 标题、脚注的 id 前缀：同一页里有好几段（嵌进来的那一篇）不撞 */
  idPrefix?: string;
  /**
   * 照编辑器的排法（白板的卡片，docs/白板.md §13.7）：空行就是一行高的空白（编辑器里一个空行就是一行），块之间
   * 不另加段距；列表符号、勾选框、代码块的封口、分隔线、表格画成编辑器里那几个替身的样子（同样的类名，样子都在
   * globals.css 的 .odea-editor 里，外面那一层要同时带着 odea-static 和 odea-editor）。点进卡片编辑，字不挪、
   * 卡片不变高。勾选框带着 data-task（`[` 在这一段里的位置），白板上点它就勾上
   */
  layout?: "document" | "editor";
}

const parser = baseParser.configure(markdownExtensions);

/* ---------------- 正则（和编辑器装饰层的一样，editor/decorationKit.ts） ---------------- */

const TOC_RE = /^\s*\[\[?toc\]?\]\s*$/i;
const HTML_COMMENT_RE = /^\s*<!--[\s\S]*-->\s*$/;
const FOOTNOTE_RE = /^\[\^([^\]\s]+)\]$/;
const FOOTNOTE_DEF_RE = /^\s{0,3}\[\^([^\]\s]+)\]:[ \t]*/;
const ABBREVIATION_RE = /^\s{0,3}\*\[([^\]\n]+)\]:[ \t]+(\S.*?)\s*$/;
const DEFINITION_RE = /^\s{0,3}:[ \t]+(?=\S)/;
const DEFINITION_HINT_RE = /(?:^|\n)[^\S\n]{0,3}(?:\[\^|\*\[|:[ \t])/;
const SMART_RE = /---|--|\.\.\.|\((?:c|r|tm)\)/gi;
const SMART_GLYPHS: Readonly<Record<string, string>> = {
  "---": "—",
  "--": "–",
  "...": "…",
  "(c)": "©",
  "(r)": "®",
  "(tm)": "™",
};
const HEADING_RE = /^(?:ATX|Setext)Heading([1-6])$/;
const FRONT_MATTER_RE = /^---[ \t]*\n(?:[\s\S]*?\n)?---[ \t]*(?:\n|$)/;
/** 引用、列表里续行前面的缩进和 `>`（代码、公式、HTML 块的源码里要去掉） */
const CONTAINER_PREFIX_RE = /^[ \t]*(?:>[ \t]?)*/;

/* ---------------- 转义 ---------------- */

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** 正文、属性值里的字。NUL 换掉（HTML 里不合法） */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]!).replace(/\0/g, "\uFFFD");
}

/** 开头的 YAML 属性块（和编辑器的 frontMatter.ts 一个规矩：里面至少有一个 `键:`）去掉 */
export function stripFrontMatter(markdown: string): string {
  const match = FRONT_MATTER_RE.exec(markdown);
  if (!match?.[0].split("\n").some(isFrontMatterKey)) return markdown;
  return markdown.slice(match[0].length);
}

/* ---------------- 渲染上下文 ---------------- */

interface Heading {
  level: number;
  text: string;
  id: string;
}

interface Context {
  options: StaticOptions;
  prefix: string;
  /** 引用式链接、图片的定义：规范化的标签 → 地址、标题 */
  refs: Map<string, { url: string; title: string }>;
  /** 脚注：id → 定义那一行的 Markdown */
  footnotes: Map<string, string>;
  /** 引用过的脚注，按第一次出现的先后 */
  cited: string[];
  abbreviations: Map<string, string>;
  /** 按缩写找的正则（长的在前）；没有缩写是 null */
  abbreviationRe: RegExp | null;
  headings: Heading[];
  /** 每个标题节点（起点）的 id */
  headingIds: Map<number, string>;
  /** 异步的部分 */
  slots: Promise<string>[];
  nonce: string;
  /** 照编辑器的排法（options.layout） */
  editor: boolean;
  /** 整篇的源码：位置（勾选框的 data-task）只对它算，callout 里另排的那一段不算 */
  source: string;
}

/** 异步的一段先占位：最后换成它的结果（已经转义好的 HTML） */
function slot(cx: Context, work: Promise<string>): string {
  cx.slots.push(work.catch(() => ""));
  return `@@odea${cx.nonce}#${cx.slots.length - 1}@@`;
}

let diagramSeq = 1;

/**
 * 一整篇 → HTML（不带外面的 <html>、样式：export/document.ts 包；嵌入卡片直接放进去）
 */
export async function renderStaticHtml(markdown: string, options: StaticOptions): Promise<string> {
  const source = stripFrontMatter(markdown.replace(/\r\n?/g, "\n"));
  const tree = parser.parse(source);
  const cx: Context = {
    options,
    prefix: options.idPrefix ?? "",
    refs: new Map(),
    footnotes: new Map(),
    cited: [],
    abbreviations: new Map(),
    abbreviationRe: null,
    headings: [],
    headingIds: new Map(),
    slots: [],
    nonce: Math.random().toString(36).slice(2, 10),
    editor: options.layout === "editor",
    source,
  };
  collect(cx, source, tree);
  if (cx.abbreviations.size) {
    const words = [...cx.abbreviations.keys()]
      .sort((a, b) => b.length - a.length)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    cx.abbreviationRe = new RegExp(
      `(?<![\\p{L}\\p{N}_])(?:${words.join("|")})(?![\\p{L}\\p{N}_])`,
      "gu",
    );
  }
  let html = blocks(cx, source, tree.topNode);
  html += footnoteSection(cx);
  const results = await Promise.all(cx.slots);
  html = html.replace(
    new RegExp(`@@odea${cx.nonce}#(\\d+)@@`, "g"),
    (_, index: string) => results[Number(index)] ?? "",
  );
  if (cx.editor) {
    html = markLongRuns(html);
    // 编辑器里空的一篇也有一行（光标那一行）：空卡片点进去不变高
    if (!html) html = '<div class="odea-blank"></div>';
  }
  // 地址到最后也没有的图片：画成一个带字的框
  return html
    .replace(
      /<img src=""[^>]*? data-missing="([^"]*)">/g,
      (_, label: string) => `<span class="image-missing">${label}</span>`,
    )
    .replace(/ data-missing="[^"]*">/g, ">");
}

/* ---------------- 照编辑器排：长串 ---------------- */

/** 断开长串的标签：块、换行（串只连着跨过加粗、代码上色这些行内的标签） */
const RUN_BREAKS = new Set([
  "br",
  "p",
  "div",
  "li",
  "ul",
  "ol",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "hr",
  "img",
  "table",
  "tr",
  "td",
  "th",
  "details",
  "summary",
  "dl",
  "dt",
  "dd",
  "button",
]);
const VOID_TAGS = new Set(["br", "hr", "img", "input", "col", "wbr", "source", "path"]);
/** 编辑器里不归正文的装饰层管的：公式、表格、嵌入、块级 HTML 是替身，图标是图标 */
const RUN_SKIP_RE =
  /^<svg\b|^<[a-z]+[^>]*\bclass="(?:[^"]*\s)?(?:katex|math-display|math-inline|cm-odea-math|cm-odea-math-block|cm-odea-table-block|embed|html-block)[\s"]/;
const RUN_CHAR_RE = new RegExp(`^${NOT_CJK}$`);

/**
 * 很长、中间没有断点的西文串（网址、哈希）在串里任意处断行，和编辑器的 .cm-odea-long-run 一样（editor/longRuns.ts，
 * 那边按源码找，这边按排出来的字找；差别只在串跨过了藏起来的记号时）。一串跨过几段字就包几段
 */
function markLongRuns(html: string): string {
  const tokens = html.split(/(<[^>]*>)/);
  const wraps = new Map<number, [number, number][]>();
  let run: [number, number, number][] = [];
  let length = 0;
  const flush = () => {
    if (length >= MIN_RUN) {
      for (const [index, from, to] of run) {
        const list = wraps.get(index) ?? [];
        list.push([from, to]);
        wraps.set(index, list);
      }
    }
    run = [];
    length = 0;
  };
  let skip = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (index % 2 === 1) {
      const name = /^<\/?([a-zA-Z0-9-]+)/.exec(token)?.[1]?.toLowerCase() ?? "";
      const closing = token.startsWith("</");
      const single = token.endsWith("/>") || VOID_TAGS.has(name);
      if (skip) {
        if (!single) skip += closing ? -1 : 1;
        continue;
      }
      if (!closing && !single && RUN_SKIP_RE.test(token)) {
        flush();
        skip = 1;
      } else if (RUN_BREAKS.has(name)) flush();
      continue;
    }
    if (skip || !token) continue;
    for (const match of token.matchAll(/&[#a-zA-Z0-9]+;|[\s\S]/g)) {
      const char = match[0].length > 1 ? "&" : match[0];
      const at = match.index;
      if (!RUN_CHAR_RE.test(char)) {
        flush();
        continue;
      }
      const last = run[run.length - 1];
      if (last && last[0] === index && last[2] === at) last[2] = at + match[0].length;
      else run.push([index, at, at + match[0].length]);
      length += 1;
    }
  }
  flush();
  if (!wraps.size) return html;
  for (const [index, ranges] of wraps) {
    const text = tokens[index]!;
    let out = "";
    let pos = 0;
    for (const [from, to] of ranges) {
      out += `${text.slice(pos, from)}<span class="cm-odea-long-run">${text.slice(from, to)}</span>`;
      pos = to;
    }
    tokens[index] = out + text.slice(pos);
  }
  return tokens.join("");
}

/* ---------------- 先走一遍：定义、标题 ---------------- */

function collect(cx: Context, src: string, tree: Tree): void {
  const used = new Map<string, number>();
  tree.iterate({
    enter: (node) => {
      const name = node.name;
      if (name === "LinkReference") {
        scanDefinitions(cx, src.slice(node.from, node.to));
        const label = node.node.getChild("LinkLabel");
        const url = node.node.getChild("URL");
        const title = node.node.getChild("LinkTitle");
        if (label && url) {
          const raw = src.slice(label.from, label.to);
          const key = normalizeLabel(raw);
          if (!FOOTNOTE_RE.test(raw) && !cx.refs.has(key)) {
            cx.refs.set(key, {
              url: src.slice(url.from, url.to).replace(/^<|>$/g, ""),
              title: title ? src.slice(title.from + 1, title.to - 1) : "",
            });
          }
        }
        return false;
      }
      if (name === "Paragraph") {
        scanDefinitions(cx, src.slice(node.from, node.to));
        return false;
      }
      const heading = HEADING_RE.exec(name);
      if (heading) {
        const text = plainOf(src, node.node).replace(/\s+/g, " ").trim();
        const base = slug(text) || "section";
        const count = used.get(base) ?? 0;
        used.set(base, count + 1);
        const id = `${cx.prefix}${count ? `${base}-${count}` : base}`;
        cx.headingIds.set(node.from, id);
        if (text) cx.headings.push({ level: Number(heading[1]), text, id });
        return false;
      }
      return true;
    },
  });
}

/** 一段里的脚注定义、缩写定义 */
function scanDefinitions(cx: Context, text: string): void {
  if (!DEFINITION_HINT_RE.test(text)) return;
  for (const line of text.split("\n")) {
    const footnote = FOOTNOTE_DEF_RE.exec(line);
    if (footnote) {
      if (!cx.footnotes.has(footnote[1]!)) {
        cx.footnotes.set(footnote[1]!, line.slice(footnote[0].length));
      }
      continue;
    }
    const abbreviation = ABBREVIATION_RE.exec(line);
    if (abbreviation) cx.abbreviations.set(abbreviation[1]!.trim(), abbreviation[2]!.trim());
  }
}

/** 标题的锚点：小写，空白换成 `-`，去掉标点（中文照留）。导出成网页时链到别的页的某一节也照它算 */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** 一个节点里的纯文本（去掉标记），给标题的锚点、目录用 */
function plainOf(src: string, node: SyntaxNode): string {
  if (!node.firstChild) {
    const text = src.slice(node.from, node.to);
    if (node.name === "Escape") return text.slice(1);
    if (node.name === "Entity") return decodeEntity(text) ?? text;
    if (node.name === "Emoji") return emojiFor(text) ?? text;
    return text;
  }
  let out = "";
  let pos = node.from;
  for (let child: SyntaxNode | null = node.firstChild; child; child = child.nextSibling) {
    if (child.from > pos) out += src.slice(pos, child.from);
    pos = child.to;
    if (/Mark$/.test(child.name) || /^(?:URL|LinkTitle|LinkLabel)$/.test(child.name)) continue;
    out += plainOf(src, child);
  }
  if (node.to > pos) out += src.slice(pos, node.to);
  return out;
}

/* ---------------- 块 ---------------- */

/**
 * 一个容器（文档、引用、列表项）里的块，一个接一个。tight：紧凑列表里，段落不包 <p>。
 * leadInline：照编辑器排时列表项的第一段不包 <p>（和符号、勾选框在同一行，后面的段落照常）
 */
function blocks(
  cx: Context,
  src: string,
  parent: SyntaxNode,
  tight = false,
  leadInline = false,
): string {
  const out: string[] = [];
  /** 上一块是单独一行的段落：它后面空一行的 `: 释义` 能把它变成定义列表的术语 */
  let lonely: { index: number; text: string } | null = null;
  let previous: SyntaxNode | null = null;
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (/Mark$/.test(node.name)) continue;
    // 照编辑器排：两块之间空了几行就是几行高的空白
    if (cx.editor && previous) out.push(blankLines(src, previous.to, node.from));
    const first = !previous;
    previous = node;
    if (node.name === "Paragraph") {
      const text = src.slice(node.from, node.to);
      const lines = text.split("\n");
      if (lonely && lines.every((line) => DEFINITION_RE.test(line))) {
        out[lonely.index] = definitionList(cx, [lonely.text, ...lines]);
        lonely = null;
        continue;
      }
      const html = paragraph(cx, src, node, tight || (leadInline && first));
      lonely =
        lines.length === 1 && (html.startsWith("<p>") || tight)
          ? { index: out.length, text }
          : null;
      out.push(html);
      continue;
    }
    lonely = null;
    out.push(block(cx, src, node));
  }
  // 照编辑器排时字按 break-spaces 排（和编辑器一样折行）：块和块之间不能留换行，不然多出一行
  return out.filter(Boolean).join(cx.editor ? "" : "\n");
}

function block(cx: Context, src: string, node: SyntaxNode): string {
  const name = node.name;
  const heading = HEADING_RE.exec(name);
  if (heading) {
    const level = heading[1];
    const id = cx.headingIds.get(node.from);
    const body = inline(cx, src, node)
      .replace(/(?:<br>\n?)+$/, "")
      .trim();
    return `<h${level}${id ? ` id="${escapeHtml(id)}"` : ""}>${body}</h${level}>`;
  }
  switch (name) {
    case "Task": {
      // 任务项的第一段：勾选框在 list() 里画，这里从 `[ ]` 后面起
      const marker = node.getChild("TaskMarker");
      return inline(cx, src, node, { from: marker ? marker.to : node.from }).trim();
    }
    case "Blockquote":
      return blockquote(cx, src, node);
    case "BulletList":
    case "OrderedList":
      return list(cx, src, node);
    case "FencedCode":
      return fencedCode(cx, src, node);
    case "CodeBlock":
      return codeBlock(
        cx,
        sourceLines(src, node)
          .map((line) => line.replace(/^(?: {1,4}|\t)/, ""))
          .join("\n"),
        "",
      );
    case "MathBlock":
      return math(
        cx,
        sourceLines(src, node)
          .join("\n")
          .replace(/^\s*\$\$/, "")
          .replace(/\$\$\s*$/, "")
          .trim(),
        true,
      );
    case "HTMLBlock":
      return htmlBlock(cx, sourceLines(src, node).join("\n"));
    case "CommentBlock":
      // 照编辑器排：编辑器里一块注释收成一个「注释」小标记（widgets.ts 的 CommentWidget）。白板的标记行插件认领了、
      // 藏着，但它们不会在一张卡片的内容里（标记就是卡片的边）
      return cx.editor
        ? '<div class="cm-odea-comment-block is-settled"><span class="cm-odea-comment">注释</span></div>'
        : "";
    case "Table":
      return table(cx, parseMarkdownTable(src.slice(node.from, node.to)), true);
    case "HorizontalRule":
      // 照编辑器排：编辑器里分隔线的替身（1px 线、上下各 0.9em）
      return cx.editor ? '<div class="cm-odea-hr is-settled"></div>' : "<hr>";
    case "LinkReference":
      return cx.editor ? editorReference(cx, src.slice(node.from, node.to)) : "";
    case "ProcessingInstructionBlock":
      return "";
    default:
      return `<p>${escapeHtml(src.slice(node.from, node.to))}</p>`;
  }
}

/** 照编辑器排：from 到 to 之间空了几行，就是几个一行高的空白（编辑器里一个空行就是一行） */
function blankLines(src: string, from: number, to: number): string {
  let lines = -1;
  for (let at = src.indexOf("\n", from); at >= 0 && at < to; at = src.indexOf("\n", at + 1)) {
    lines += 1;
  }
  return lines > 0 ? '<div class="odea-blank"></div>'.repeat(lines) : "";
}

/** 一块的源码，续行前面引用、列表的前缀去掉（第一行从节点起点开始，本来就没有） */
function sourceLines(src: string, node: SyntaxNode): string[] {
  return src
    .slice(node.from, node.to)
    .split("\n")
    .map((line, index) => (index === 0 ? line : line.replace(CONTAINER_PREFIX_RE, "")));
}

function paragraph(cx: Context, src: string, node: SyntaxNode, tight: boolean): string {
  const text = src.slice(node.from, node.to);
  if (TOC_RE.test(text)) return toc(cx);
  // 单独一行的 `![[笔记]]`：嵌那一篇
  const only = node.firstChild;
  if (only?.name === "Image" && only.from === node.from && only.to === node.to) {
    const inner = /^!\[\[([^\]]+)\]\]$/.exec(text)?.[1];
    const target = inner === undefined ? null : noteEmbedTarget(inner);
    if (target) return embed(cx, target, inner!);
  }
  if (DEFINITION_HINT_RE.test(text)) {
    const lines = text.split("\n");
    const definition = (line: string) => FOOTNOTE_DEF_RE.test(line) || ABBREVIATION_RE.test(line);
    // 照编辑器排：定义行留在原地（编辑器里它们就是这一段里的一行），不收到最后
    if (cx.editor && lines.some(definition)) return editorDefinitions(cx, lines, tight);
    const kept = lines.filter((line) => !definition(line));
    // 脚注、缩写的定义行拿掉（脚注收到最后），剩下的另起一段重新排
    if (kept.length < lines.length) return kept.length ? fragment(cx, kept.join("\n"), tight) : "";
    if (lines.slice(1).some((line) => DEFINITION_RE.test(line))) return definitionList(cx, lines);
  }
  const body = inline(cx, src, node);
  if (tight) return body;
  // 照编辑器排：只有一张图的那一行，编辑器里这一行的字号是 0（.cm-odea-image-line），只剩图片那一块
  if (cx.editor && only?.name === "Image" && only.from === node.from && only.to === node.to) {
    return `<p class="odea-image-line">${body}</p>`;
  }
  return `<p>${body}</p>`;
}

/**
 * 照编辑器排：一段里夹着脚注、缩写的定义行。编辑器里它们是这一段里的一行（inlineDecorations.ts 的
 * cm-odea-footnote-def：开头 `[^1]: ` 换成徽章、后面照常排；blockDecorations.ts 的 cm-odea-abbr-def：源码原样，淡一点），
 * 别的行照常排。行和行之间不留空（段里的软换行就是挨着的下一行）
 */
function editorDefinitions(cx: Context, lines: string[], tight: boolean): string {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) out.push(fragment(cx, run.join("\n"), tight));
    run = [];
  };
  for (const line of lines) {
    const footnote = FOOTNOTE_DEF_RE.exec(line);
    if (footnote) {
      flush();
      const badge = `<span class="cm-odea-footnote is-def is-settled">${escapeHtml(footnote[1]!)}</span>`;
      out.push(
        `<p class="cm-odea-footnote-def">${badge}${inlineText(cx, line.slice(footnote[0].length))}</p>`,
      );
    } else if (ABBREVIATION_RE.test(line)) {
      flush();
      out.push(`<p class="cm-odea-abbr-def">${escapeHtml(line)}</p>`);
    } else run.push(line);
  }
  flush();
  return out.join("");
}

/**
 * 照编辑器排：一块引用定义。单独一行的 `[^1]: 脚注` 也被解析成引用定义（`^1` 是个合法的标签），编辑器里照段落那样
 * 一行一行排（inlineDecorations.ts 的 LinkReference）；真的引用定义（`[a]: https://…`）是淡淡的源码（cm-odea-reference）
 */
function editorReference(cx: Context, text: string): string {
  const lines = text.split("\n");
  if (lines.some((line) => FOOTNOTE_DEF_RE.test(line) || ABBREVIATION_RE.test(line))) {
    return editorDefinitions(cx, lines, false);
  }
  // 编辑器里 `[a]: https://…` 的冒号藏掉（一个空的替身），地址画成链接的样子
  const shown = lines.map((line) => {
    const match = /^(\s{0,3}\[[^\]]+\]):(\s*)(\S+)(.*)$/.exec(line);
    if (!match) return escapeHtml(line);
    const [, label, gap, url, rest] = match;
    return `${escapeHtml(label!)}${gap}<span class="cm-odea-link">${escapeHtml(url!)}</span>${escapeHtml(rest!)}`;
  });
  return `<p><span class="cm-odea-reference">${shown.join("<br>")}</span></p>`;
}

/** 定义列表：`术语` 下面一行或几行 `: 释义` */
function definitionList(cx: Context, lines: string[]): string {
  const items = lines
    .filter((line) => line.trim())
    .map((line) => {
      const definition = DEFINITION_RE.exec(line);
      return definition
        ? `<dd>${inlineText(cx, line.slice(definition[0].length))}</dd>`
        : `<dt>${inlineText(cx, line.trim())}</dt>`;
    });
  return `<dl>${items.join("")}</dl>`;
}

/** 一段 Markdown 当成独立的一篇再排一遍（callout 的正文、拿掉定义行以后剩下的段落） */
function fragment(cx: Context, text: string, tight = false): string {
  return blocks(cx, text, parser.parse(text).topNode, tight);
}

/**
 * 一行字只当行内的排（表格格子、callout 标题、定义列表、脚注）：`# x`、`- x`、`> x` 都只是字。
 * 前面垫一个全角空格再解析 —— 它不是 ASCII 空格，块的开头都认不出来；又算空白，`_斜体_` 照样能开头
 */
function inlineText(cx: Context, text: string, smart = true): string {
  if (!text.trim()) return "";
  const padded = `\u3000${text.replace(/\n/g, " ")}`;
  const node = parser.parse(padded).topNode.firstChild;
  if (node?.name !== "Paragraph") return escapeHtml(text);
  return inline(cx, padded, node, { from: node.from + 1, smart });
}

function list(cx: Context, src: string, node: SyntaxNode): string {
  const ordered = node.name === "OrderedList";
  const items: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "ListItem") items.push(child);
  }
  // 松散列表（项之间、项里的几块之间空了行）：项里的段落包 <p>；紧凑的直接是字
  const blank = (from: number, to: number) => /\n[ \t>]*\n/.test(src.slice(from, to));
  const loose = items.some((item, index) => {
    const next = items[index + 1];
    if (next && blank(item.to, next.from)) return true;
    for (let child = item.firstChild; child; child = child.nextSibling) {
      const after = child.nextSibling;
      if (child.name !== "ListMark" && after && blank(child.to, after.from)) return true;
    }
    return false;
  });
  let start = "";
  let first = 1;
  if (ordered) {
    const mark = items[0]?.getChild("ListMark");
    const written = mark ? Number.parseInt(src.slice(mark.from, mark.to), 10) : 1;
    if (Number.isFinite(written)) first = written;
    if (first !== 1) start = ` start="${first}"`;
  }
  if (cx.editor) return editorList(cx, src, node, items, loose, first);
  let tasks = false;
  const body = items
    .map((item) => {
      const marker = item.getChild("Task")?.getChild("TaskMarker");
      const content = blocks(cx, src, item, !loose);
      if (!marker) return `<li>${content}</li>`;
      tasks = true;
      const done = /x/i.test(src.slice(marker.from, marker.to));
      const box = `<input type="checkbox" disabled${done ? " checked" : ""}>`;
      return `<li class="task${done ? " is-done" : ""}">${box}<div class="task-body">${content}</div></li>`;
    })
    .join("");
  const tag = ordered ? "ol" : "ul";
  return `<${tag}${start}${tasks ? ' class="tasks"' : ""}>${body}</${tag}>`;
}

/**
 * 照编辑器排的列表（inlineDecorations.ts 的 decorateListItem）：每一项的第一行是符号格（圆点、编号、勾选框）
 * 加正文，折行悬挂到正文那一栏；子项的符号格接在上一级的正文那一栏后面。项和项之间空了几行就是几行空白
 */
function editorList(
  cx: Context,
  src: string,
  node: SyntaxNode,
  items: SyntaxNode[],
  loose: boolean,
  first: number,
): string {
  const ordered = node.name === "OrderedList";
  let depth = 0;
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.name === "BulletList" || ancestor.name === "OrderedList") depth += 1;
  }
  // 同一个列表按最大的那个编号定宽，9 和 10 的点对得齐
  const width = ordered
    ? LIST_ORDERED_WIDTH + String(first + items.length - 1).length * LIST_DIGIT_WIDTH
    : LIST_BULLET_WIDTH;
  const body = items
    .map((item, index) => {
      const mark = item.getChild("ListMark");
      const task = item.getChild("Task")?.getChild("TaskMarker");
      const own = task ? LIST_TASK_WIDTH : width;
      let box: string;
      if (task) {
        const done = /x/i.test(src.slice(task.from, task.to));
        // 白板上点它就勾上：`[` 在这一段里的位置（callout 里另排的那一段对不上，不给）
        const at = src === cx.source ? ` data-task="${task.from}"` : "";
        box = `<span class="cm-odea-task${done ? " is-checked" : ""} is-settled" role="checkbox" aria-checked="${done}"${at}>${svgIcon("0 0 16 16", TASK_CHECK_ICON, "cm-odea-task-check")}</span>`;
      } else {
        const written = mark ? src.slice(mark.from, mark.to) : "";
        const text = ordered
          ? `${first + index}${written.endsWith(")") ? ")" : "."}`
          : BULLET_GLYPHS[depth % BULLET_GLYPHS.length]!;
        box = `<span class="cm-odea-list-marker is-settled" style="width: ${listUnits(width)}">${text}</span>`;
      }
      const content = blocks(cx, src, item, !loose, true);
      const next = items[index + 1];
      const gap = next ? blankLines(src, item.to, next.from) : "";
      const style = `padding-left: ${listUnits(own)}; text-indent: ${listUnits(-own)}`;
      return `<li style="${style}">${box}${content}${gap}</li>`;
    })
    .join("");
  const tag = ordered ? "ol" : "ul";
  return `<${tag} class="odea-list">${body}</${tag}>`;
}

/** 编辑器里替身用的那种线条图标（widgets.ts 的 svg）：pathLength 1，描出来的动画按它算 */
function svgIcon(viewBox: string, d: string, className: string): string {
  return `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${className}"><path d="${d}" pathLength="1"></path></svg>`;
}

/* ---------------- 引用、callout ---------------- */

function blockquote(cx: Context, src: string, node: SyntaxNode): string {
  const lineStart = src.lastIndexOf("\n", node.from - 1) + 1;
  const lineEnd = src.indexOf("\n", node.from);
  const firstLine = src.slice(lineStart, lineEnd < 0 || lineEnd > node.to ? node.to : lineEnd);
  const head = parseCalloutHead(firstLine);
  if (!head) return `<blockquote>${blocks(cx, src, node)}</blockquote>`;
  // callout：标签行下面每一行去掉到这一层为止的 `>`，当成一篇再排
  const depth = (firstLine.slice(0, head.labelOffset).match(/>/g) ?? []).length;
  const prefix = new RegExp(`^(?:[ \\t]*>[ \\t]?){1,${Math.max(1, depth)}}`);
  const rest = lineEnd < 0 || lineEnd >= node.to ? "" : src.slice(lineEnd + 1, node.to);
  const body = rest
    .split("\n")
    .map((line) => line.replace(prefix, ""))
    .join("\n");
  const kind: CalloutKind = head.kind;
  const icon = calloutIcon(kind, head.icon).outerHTML;
  const badge = `<span class="callout-badge">${icon}<span>${escapeHtml(head.label)}</span></span>`;
  const title = head.title
    ? `<span class="callout-title">${inlineText(cx, head.title)}</span>`
    : "";
  const inner = body.trim() ? `<div class="callout-body">${fragment(cx, body)}</div>` : "";
  const classes = `callout is-${kind}`;
  if (head.fold && !cx.options.expandFolds) {
    const open = head.fold === "+" ? " open" : "";
    return `<details class="${classes}"${open}><summary class="callout-head">${badge}${title}</summary>${inner}</details>`;
  }
  // 照编辑器排：徽章后面是源码里 `]` 后面那个空格（编辑器里标签行就是一行字）
  const gap = cx.editor && title ? " " : "";
  return `<div class="${classes}"><div class="callout-head">${badge}${gap}${title}</div>${inner}</div>`;
}

/* ---------------- 代码、图表、公式 ---------------- */

function fencedCode(cx: Context, src: string, node: SyntaxNode): string {
  const info = node.getChild("CodeInfo");
  const language = info
    ? (src.slice(info.from, info.to).trim().split(/\s+/)[0] ?? "").toLowerCase()
    : "";
  // 一行一个 CodeText（引用、列表里中间夹着它们的前缀）
  const code = node
    .getChildren("CodeText")
    .map((text) => src.slice(text.from, text.to))
    .join("")
    .replace(/\n$/, "");
  if (language === "mermaid" && cx.options.diagrams && code.trim()) return diagram(cx, code);
  if (language === "csv" || language === "tsv") {
    const parsed = parseDelimitedTable(code, language === "csv" ? "," : "\t");
    if (parsed) return table(cx, parsed, false);
  }
  return codeBlock(cx, code, language);
}

function codeBlock(cx: Context, code: string, language: string): string {
  const body =
    cx.options.highlight && language ? slot(cx, highlight(code, language)) : escapeHtml(code);
  if (cx.editor) return editorCodeBlock(language, body);
  const label = language ? ` data-lang="${escapeHtml(language)}"` : "";
  return `<pre class="code"${label}><code>${body}</code></pre>`;
}

/**
 * 照编辑器排的代码块（光标不在里面时的样子，widgets.ts 的 CodeFenceWidget）：上下两道封口，开头那道是语言名和
 * 「复制」；中间和编辑器的代码行一个样子（.cm-odea-code-block）。复制按钮带着 data-copy，白板上点它复制
 */
function editorCodeBlock(language: string, body: string): string {
  const label = language ? `<span class="cm-odea-code-lang">${escapeHtml(language)}</span>` : "";
  const copy = `<button type="button" class="cm-odea-code-copy" data-copy aria-label="复制代码">${svgIcon("0 0 20 20", COPY_ICON, "cm-odea-code-copy-icon")}<span>复制</span></button>`;
  const open = `<div class="cm-odea-fence-block is-open is-settled"><div class="cm-odea-code-fence is-open">${label}${copy}</div></div>`;
  const close =
    '<div class="cm-odea-fence-block is-close is-settled"><div class="cm-odea-code-fence is-close"></div></div>';
  return `${open}<div class="cm-odea-code-block odea-code-lines">${body}</div>${close}`;
}

/** 按语言上色：和编辑器同一套语言包、同一套类名（editor/codeHighlight.ts 的 tok-*） */
async function highlight(code: string, language: string): Promise<string> {
  const [{ languages }, { LanguageDescription }, { highlightCode }] = await Promise.all([
    import("@codemirror/language-data"),
    import("@codemirror/language"),
    import("@lezer/highlight"),
  ]);
  const description = LanguageDescription.matchLanguageName(languages, language, true);
  if (!description) return escapeHtml(code);
  const support = await description.load();
  const tree = support.language.parser.parse(code);
  let out = "";
  highlightCode(
    code,
    tree,
    codeHighlightStyle,
    (text, classes) => {
      out += classes ? `<span class="${classes}">${escapeHtml(text)}</span>` : escapeHtml(text);
    },
    () => {
      out += "\n";
    },
  );
  return out;
}

function diagram(cx: Context, code: string): string {
  const id = `odea-static-diagram-${diagramSeq++}`;
  const work = (async () => {
    const { diagramEngine } = await import("@/editor/diagram");
    const mermaid = await diagramEngine.get();
    try {
      const { svg } = await mermaid.render(id, code);
      // securityLevel 是 strict：mermaid 自己净化过标签。这里只收 <svg> 那一块
      const parsed = new DOMParser().parseFromString(svg, "text/html").body.querySelector("svg");
      if (!parsed) throw new Error("没有生成 SVG");
      parsed.removeAttribute("height");
      return parsed.outerHTML;
    } catch (error) {
      // 出错时 mermaid 留下的那块（画错误的）也收掉
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
      const message = (error instanceof Error ? error.message : String(error)).split("\n")[0];
      return `<pre class="code"><code>${escapeHtml(code)}</code></pre><div class="diagram-error">图表画不出来：${escapeHtml(message ?? "")}</div>`;
    }
  })();
  return `<div class="diagram">${slot(cx, work)}</div>`;
}

function math(cx: Context, tex: string, display: boolean): string {
  const tag = display ? "div" : "span";
  const className = display ? "math-display" : "math-inline";
  if (!cx.options.math || !tex) {
    const source = display ? `$$${tex}$$` : `$${tex}$`;
    return `<${tag} class="${className} is-source">${escapeHtml(source)}</${tag}>`;
  }
  const work = (async () => {
    const { loadKatex, prepareBreaks } = await import("@/editor/math");
    const katex = await loadKatex();
    // KaTeX 的输出是它自己生成的标记，用户原文都转义过（editor/math.ts 的 render 也是这么用的）
    const html = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
    });
    if (!cx.editor || !display) return html;
    // 照编辑器排：块级公式按 `\\` 分好行（和编辑器的替身一样的结构）
    const holder = document.createElement("div");
    holder.innerHTML = html;
    prepareBreaks(holder);
    return holder.innerHTML;
  })();
  if (cx.editor) {
    // 照编辑器排：编辑器里公式的替身（editor/math.ts 的 MathWidget），块级的外面一层上下留 0.5em
    return display
      ? `<div class="cm-odea-math-block is-settled"><div class="cm-odea-math is-block">${slot(cx, work)}</div></div>`
      : `<span class="cm-odea-math is-inline is-settled">${slot(cx, work)}</span>`;
  }
  return `<${tag} class="${className}">${slot(cx, work)}</${tag}>`;
}

/* ---------------- 块级 HTML ---------------- */

function htmlBlock(cx: Context, source: string): string {
  if (HTML_COMMENT_RE.test(source)) return "";
  // 照编辑器排：编辑器里每一块是一个替身（widgets.ts 的 HtmlBlockWidget），连没有标签可画的那一块（单独一行
  // `</details>`）也是一个、里面是源码原文
  const wrap = (html: string) =>
    cx.editor
      ? `<div class="cm-odea-html-widget-block is-settled"><div class="cm-odea-html-widget">${html}</div></div>`
      : `<div class="html-block">${html}</div>`;
  if (cx.editor && !hasRenderableHtml(source)) return wrap(escapeHtml(source));
  const holder = document.createElement("div");
  holder.append(sanitizeHtml(source));
  if (!holder.childNodes.length) return cx.editor ? wrap("") : "";
  // 块级 HTML 里的 <img>：先记下地址换成记号，序列化以后再换成解析好的（导出时嵌成 data:）
  const images = [...holder.querySelectorAll("img")];
  const sources = images.map((image) => rawSourceOf(image.getAttribute("src") ?? ""));
  // 记号带着这一次渲染的随机数：正文里写不出一样的（写了 `@@IMG0@@` 也只是字）
  const mark = (index: number) => `@@img${cx.nonce}#${index}@@`;
  images.forEach((image, index) => {
    image.setAttribute("src", mark(index));
    // 净化时给的懒加载去掉：屏幕外的图不加载，打印成 PDF 时就缺了
    image.removeAttribute("loading");
  });
  // 换的时候给函数、不给字符串：字符串里的 `$&`、`` $` ``、`$'` 会被 replace 展开成记号本身、记号前后的那一段，
  // 图片地址里写上它们就能把周围的 HTML 塞进 src 的引号里，净化过的属性值跑出来成了 <img> 的属性（onerror）
  const html = holder.innerHTML.replace(
    new RegExp(`@@img${cx.nonce}#(\\d+)@@`, "g"),
    (_, index: string) => imageSrc(cx, sources[Number(index)] ?? ""),
  );
  return wrap(html);
}

/** sanitizeHtml 在桌面端把本机路径转成了 asset 地址：还原成原来写的，交给 options.image 统一解析 */
function rawSourceOf(src: string): string {
  const asset = /^(?:https?:\/\/asset\.localhost\/|asset:\/\/localhost\/)(.+)$/.exec(src);
  if (!asset) return src;
  try {
    return decodeURIComponent(asset[1]!);
  } catch {
    return asset[1]!;
  }
}

/** 图片地址：同步的直接写（转义好），异步的占位 */
function imageSrc(cx: Context, source: string): string {
  const resolved = cx.options.image(source);
  if (typeof resolved === "string" || resolved === null) return escapeHtml(resolved ?? "");
  return slot(
    cx,
    resolved.then((value) => escapeHtml(value ?? "")),
  );
}

/* ---------------- 表格 ---------------- */

function table(cx: Context, model: MarkdownTableModel | null, markdown: boolean): string {
  if (!model) return "";
  const cells = [model.header, ...model.rows];
  // 合并单元格：`<` 并进左边、`^` 并进上面（CSV 不认，editor/tableGrid.ts）
  const grid = resolveGrid(cells, markdown);
  const numeric = numericColumns(model);
  const row = (index: number) =>
    grid
      .cellsInRow(index)
      .map((cell) => {
        const tag = index === 0 ? "th" : "td";
        const span =
          (cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : "") +
          (cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : "");
        // 没写对齐的数字列整列右对齐（表头也是），数字等宽
        const written = model.alignments[cell.col];
        const align = written ?? (numeric[cell.col] ? "right" : null);
        const style = align ? ` style="text-align: ${align}"` : "";
        const num = numeric[cell.col] && !written && index > 0 ? ' class="num"' : "";
        const raw = cells[cell.row]?.[cell.col] ?? "";
        // 格子里和编辑器一样：智能标点不换（分隔行全是 `---`）
        const content = markdown ? inlineText(cx, raw, false) : escapeHtml(raw);
        return `<${tag}${span}${style}${num}>${content}</${tag}>`;
      })
      .join("");
  if (cx.editor) return editorTable(cx, model, markdown, grid, numeric);
  const head = `<thead><tr>${row(0)}</tr></thead>`;
  const body = model.rows.length
    ? `<tbody>${model.rows.map((_, index) => `<tr>${row(index + 1)}</tr>`).join("")}</tbody>`
    : "";
  return `<div class="table-wrap"><table>${head}${body}</table></div>`;
}

/**
 * 照编辑器排的表格（tableWidget.ts 的 toDOM、paintCell）：外层留白、圆角的框、表格，格子上标着第一列、最后一行、
 * 数字列（样子都在 globals.css 的 .cm-odea-table-*）。CSV / TSV 顶上那条标签栏没画
 */
function editorTable(
  cx: Context,
  model: MarkdownTableModel,
  markdown: boolean,
  grid: ReturnType<typeof resolveGrid>,
  numeric: boolean[],
): string {
  const cells = [model.header, ...model.rows];
  const row = (index: number) =>
    grid
      .cellsInRow(index)
      .map((cell) => {
        const tag = index === 0 ? "th" : "td";
        const bottom = cell.row + cell.rowSpan === grid.rows;
        const right = cell.col + cell.colSpan === grid.cols;
        const flags: [string, boolean][] = [
          ["is-num", cell.colSpan === 1 && !!numeric[cell.col]],
          ["is-col0", cell.col === 0],
          ["at-bottom", bottom],
          ["at-tl", cell.row === 0 && cell.col === 0],
          ["at-tr", cell.row === 0 && right],
          ["at-bl", bottom && cell.col === 0],
          ["at-br", bottom && right],
        ];
        const classes = flags.filter(([, on]) => on).map(([name]) => name);
        const span =
          (cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : "") +
          (cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : "");
        const align = model.alignments[cell.col] ?? (numeric[cell.col] ? "right" : "left");
        const raw = cells[cell.row]?.[cell.col] ?? "";
        const content = markdown ? inlineText(cx, raw, false) : escapeHtml(raw);
        const attrs = `${span}${classes.length ? ` class="${classes.join(" ")}"` : ""}`;
        return `<${tag}${attrs} style="text-align: ${align}">${content}</${tag}>`;
      })
      .join("");
  const head = `<thead><tr>${row(0)}</tr></thead>`;
  const body = `<tbody>${model.rows.map((_, index) => `<tr>${row(index + 1)}</tr>`).join("")}</tbody>`;
  const format = markdown ? "markdown" : "csv";
  return `<div class="cm-odea-table-block is-settled"><div class="cm-odea-table-frame is-${format}"><div class="cm-odea-table-scroll"><table class="cm-odea-table-widget">${head}${body}</table></div></div></div>`;
}

/* ---------------- 目录、嵌入、脚注 ---------------- */

function toc(cx: Context): string {
  const title = '<div class="toc-title">目录</div>';
  if (!cx.headings.length)
    return `<nav class="toc">${title}<div class="toc-empty">还没有标题</div></nav>`;
  const base = Math.min(...cx.headings.map((heading) => heading.level));
  const items = cx.headings
    .map(
      (heading) =>
        `<li style="--depth: ${heading.level - base}"><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`,
    )
    .join("");
  return `<nav class="toc">${title}<ol>${items}</ol></nav>`;
}

function embed(cx: Context, target: EmbedTarget, inner: string): string {
  const fallback = `<p>${wikilink(cx, inner)}</p>`;
  if (!cx.options.embed) return fallback;
  const section = target.heading
    ? `<span class="embed-section"> › ${escapeHtml(target.heading)}</span>`
    : "";
  const head = `<div class="embed-head">${escapeHtml(target.title)}${section}</div>`;
  return slot(
    cx,
    cx.options
      .embed(target)
      .then((body) =>
        body === null
          ? fallback
          : `<div class="embed">${head}<div class="embed-body">${body}</div></div>`,
      ),
  );
}

function wikilink(cx: Context, inner: string): string {
  const pipe = inner.indexOf("|");
  const target = splitWikiTarget((pipe >= 0 ? inner.slice(0, pipe) : inner).trim());
  const shown = (pipe >= 0 ? inner.slice(pipe + 1) : inner).trim();
  const tip = target.heading ? `${target.title} › ${target.heading}` : target.title;
  const href = cx.options.wikiHref?.(target.title, target.heading);
  return href
    ? `<a class="wikilink" href="${escapeHtml(href)}" title="${escapeHtml(tip)}">${escapeHtml(shown)}</a>`
    : `<span class="wikilink" title="${escapeHtml(tip)}">${escapeHtml(shown)}</span>`;
}

const footnoteAnchor = (cx: Context, id: string, index: number) =>
  `${cx.prefix}fn-${slug(id) || index + 1}`;

function footnoteSection(cx: Context): string {
  if (!cx.cited.length) return "";
  const items: string[] = [];
  // 脚注里又引用了别的脚注：cited 在循环里变长，一并排上
  for (let index = 0; index < cx.cited.length; index += 1) {
    const id = cx.cited[index]!;
    const body = inlineText(cx, cx.footnotes.get(id) ?? "");
    const anchor = footnoteAnchor(cx, id, index);
    const back = `<a class="footnote-back" href="#${escapeHtml(anchor)}-ref" aria-label="回到正文">↩</a>`;
    items.push(`<li id="${escapeHtml(anchor)}">${body} ${back}</li>`);
  }
  return `<section class="footnotes"><ol>${items.join("")}</ol></section>`;
}

function footnoteRef(cx: Context, id: string): string {
  // 照编辑器排：编辑器里每一处 `[^id]` 都换成写着 id 的上标徽章（widgets.ts 的 FootnoteWidget），有没有定义都一样；
  // 定义留在原地（editorDefinitions），最后不另列
  if (cx.editor) return `<sup class="cm-odea-footnote is-ref is-settled">${escapeHtml(id)}</sup>`;
  if (!cx.footnotes.has(id)) return escapeHtml(`[^${id}]`);
  let index = cx.cited.indexOf(id);
  const first = index < 0;
  if (first) {
    cx.cited.push(id);
    index = cx.cited.length - 1;
  }
  const anchor = footnoteAnchor(cx, id, index);
  const refId = first ? ` id="${escapeHtml(anchor)}-ref"` : "";
  return `<sup class="footnote-ref"><a href="#${escapeHtml(anchor)}"${refId}>${index + 1}</a></sup>`;
}

/* ---------------- 行内 ---------------- */

/** 一个块里排行内内容时共用的：要跳过的字（双链的外层方括号）、==高亮== 的开合、配上对的 HTML 闭标签 */
interface InlineState {
  smart: boolean;
  skip: Array<[number, number]>;
  marks: Map<number, string>;
  closes: Set<number>;
}

/** 一个块（段落、标题、格子）里的行内内容。from：从这里起（跳过开头垫的东西） */
function inline(
  cx: Context,
  src: string,
  node: SyntaxNode,
  scope: { from?: number; smart?: boolean } = {},
): string {
  const state: InlineState = {
    smart: scope.smart ?? true,
    skip: [],
    marks: new Map(),
    closes: new Set(),
  };
  return inlineRange(cx, src, node, scope.from ?? node.from, node.to, state);
}

type Piece = { text: [number, number] } | { node: SyntaxNode };

function inlineRange(
  cx: Context,
  src: string,
  parent: SyntaxNode,
  from: number,
  to: number,
  state: InlineState,
): string {
  // 子节点和它们之间的字排成一串
  const pieces: Piece[] = [];
  let pos = from;
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.to <= from || child.from >= to) continue;
    if (child.from > pos) pieces.push({ text: [pos, child.from] });
    pieces.push({ node: child });
    pos = Math.max(pos, child.to);
  }
  if (to > pos) pieces.push({ text: [pos, to] });

  // 双链：Link 节点是里面那一层 `[x]`，外面那一对方括号在两边的字里
  for (const piece of pieces) {
    if (!("node" in piece) || piece.node.name !== "Link") continue;
    const link = piece.node;
    if (src[link.from - 1] === "[" && src[link.to] === "]" && isShortcut(link)) {
      state.skip.push([link.from - 1, link.from], [link.to, link.to + 1]);
    }
  }
  pairHighlights(src, pieces, state);

  let out = "";
  for (const piece of pieces) {
    out +=
      "text" in piece
        ? textRun(cx, src, piece.text[0], piece.text[1], state)
        : inlineNode(cx, src, piece.node, state);
  }
  return out;
}

const isShortcut = (link: SyntaxNode) => !link.getChild("URL") && !link.getChild("LinkLabel");

/**
 * `==高亮==`：只在同一层的字里配对（editor/markdownStyleRegistry.ts 的 markdownSourceStyleRules 的规矩）——
 * 里面不能是空的、头尾不能是空白、不能隔空行。跨过的子节点（粗体、代码）整个包在里面，标签一定成对
 */
function pairHighlights(src: string, pieces: Piece[], state: InlineState): void {
  const candidates: number[] = [];
  for (const piece of pieces) {
    if (!("text" in piece)) continue;
    const [start, end] = piece.text;
    let index = src.indexOf("==", start);
    while (index >= 0 && index + 2 <= end) {
      if (!state.skip.some(([a, b]) => index < b && index + 2 > a)) candidates.push(index);
      index = src.indexOf("==", index + 2);
    }
  }
  for (let i = 0; i + 1 < candidates.length; i += 1) {
    const open = candidates[i]!;
    const close = candidates[i + 1]!;
    const content = src.slice(open + 2, close);
    if (!content || /^\s|\s$/.test(content) || /\n[ \t]*\n/.test(content)) continue;
    state.marks.set(open, "<mark>");
    state.marks.set(close, "</mark>");
    i += 1;
  }
}

/** 一段普通的字：跳过双链的方括号、插高亮的标签，其余交给 plainText */
function textRun(cx: Context, src: string, from: number, to: number, state: InlineState): string {
  let out = "";
  let start = from;
  // 紧跟在续行的 `>`（QuoteMark 节点）后面：开头那个空格也是前缀
  const lineStart = src.lastIndexOf("\n", from - 1) + 1;
  let prefixed = from > lineStart && /^[ \t>]*$/.test(src.slice(lineStart, from));
  const flush = (end: number) => {
    if (end <= start) return;
    out += plainText(cx, src.slice(start, end), state.smart, prefixed);
    prefixed = false;
  };
  for (let pos = from; pos < to; pos += 1) {
    const mark = state.marks.get(pos);
    const skipped = mark ? undefined : state.skip.find(([a]) => a === pos);
    if (!mark && !skipped) continue;
    flush(pos);
    if (mark) {
      out += mark;
      pos += 1;
    } else if (skipped) {
      pos = skipped[1] - 1;
    }
    start = pos + 1;
    prefixed = false;
  }
  flush(to);
  return out;
}

/**
 * 转义好的字。软换行是 <br>（编辑器里一行就是一行）；续行开头的缩进、引用的 `>` 去掉。
 * prefixed：第一行也是从行首的前缀里开始的
 */
function plainText(cx: Context, text: string, smart: boolean, prefixed = false): string {
  return text
    .split("\n")
    .map((line, index) =>
      decorateText(cx, index > 0 || prefixed ? line.replace(CONTAINER_PREFIX_RE, "") : line, smart),
    )
    .join(lineBreak(cx));
}

/** 段落里的换行。照编辑器排时后面不跟换行符（break-spaces 下它也是一个换行） */
function lineBreak(cx: Context): string {
  return cx.editor ? "<br>" : "<br>\n";
}

/** 智能标点、缩写（在原文上找，找到的部分包 <abbr>，其余转义） */
function decorateText(cx: Context, text: string, smart: boolean): string {
  const value = smart
    ? text.replace(SMART_RE, (match) => SMART_GLYPHS[match.toLowerCase()] ?? match)
    : text;
  const pattern = cx.abbreviationRe;
  if (!pattern) return escapeHtml(value);
  let out = "";
  let last = 0;
  for (const match of value.matchAll(pattern)) {
    out += escapeHtml(value.slice(last, match.index));
    const expansion = cx.abbreviations.get(match[0]) ?? "";
    out += `<abbr title="${escapeHtml(expansion)}">${escapeHtml(match[0])}</abbr>`;
    last = match.index + match[0].length;
  }
  return out + escapeHtml(value.slice(last));
}

function inlineNode(cx: Context, src: string, node: SyntaxNode, state: InlineState): string {
  /** 去掉两头的标记（`**`、`~~`）以后里面那一段 */
  const inner = () => {
    const first = node.firstChild;
    const last = node.lastChild;
    const start =
      first && /Mark$/.test(first.name) && first.from === node.from ? first.to : node.from;
    const end =
      last && last !== first && /Mark$/.test(last.name) && last.to === node.to
        ? last.from
        : node.to;
    return inlineRange(cx, src, node, start, end, state);
  };
  switch (node.name) {
    case "Emphasis":
      return `<em>${inner()}</em>`;
    case "StrongEmphasis":
      return `<strong>${inner()}</strong>`;
    case "Strikethrough":
      return `<del>${inner()}</del>`;
    case "Superscript":
      return `<sup>${inner()}</sup>`;
    case "InlineCode": {
      const marks = node.getChildren("CodeMark");
      const start = marks[0]?.to ?? node.from;
      const end = marks.length > 1 ? marks[marks.length - 1]!.from : node.to;
      let code = src.slice(start, end).replace(/\n/g, " ");
      if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
      return `<code>${escapeHtml(code)}</code>`;
    }
    case "InlineMath": {
      const text = src.slice(node.from, node.to);
      const display = text.startsWith("$$");
      return math(cx, text.slice(display ? 2 : 1, display ? -2 : -1).trim(), false);
    }
    case "Escape":
      return escapeHtml(src.slice(node.from + 1, node.to));
    case "Entity": {
      const text = src.slice(node.from, node.to);
      return escapeHtml(decodeEntity(text) ?? text);
    }
    case "HardBreak":
      return lineBreak(cx);
    case "Emoji": {
      const code = src.slice(node.from, node.to);
      // 动态表情：静态的页面里用它的 Unicode 替身
      if (animatedEmojiFor(code)) {
        const name = code
          .replace(/^:|:$/g, "")
          .toLowerCase()
          .replace(/^(?:odea|otw)_/, "");
        return escapeHtml(ANIMATED_EMOJI_FALLBACK[name] ?? code);
      }
      return escapeHtml(emojiFor(code) ?? code);
    }
    case "Comment":
      return "";
    case "HTMLTag":
      return htmlTag(cx, src, node, state);
    case "Autolink": {
      const url = src.slice(node.from + 1, node.to - 1);
      return anchor(/^[^@\s:/]+@[^@\s]+$/.test(url) ? `mailto:${url}` : url, escapeHtml(url));
    }
    case "URL": {
      const url = src.slice(node.from, node.to);
      return anchor(/^www\./i.test(url) ? `http://${url}` : url, escapeHtml(url));
    }
    case "Link":
      return link(cx, src, node, state);
    case "Image":
      return image(cx, src, node);
    default:
      if (/Mark$/.test(node.name)) return "";
      return node.firstChild ? inner() : plainText(cx, src.slice(node.from, node.to), state.smart);
  }
}

/** 链接：只放行 http(s)、mailto、tel 和文档里的锚点；别的（相对路径）画成链接的样子、不能点 */
function anchor(href: string, html: string, title = ""): string {
  const safe = safeHref(href) ?? (/^#\S+$/.test(href) ? href : null);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  if (!safe) return `<span class="link"${titleAttr}>${html}</span>`;
  return `<a href="${escapeHtml(safe)}"${titleAttr}>${html}</a>`;
}

function link(cx: Context, src: string, node: SyntaxNode, state: InlineState): string {
  const text = src.slice(node.from, node.to);
  const marks = node.getChildren("LinkMark");
  // `[` 和 `]` 之间是链接文字
  const textFrom = marks[0]?.to ?? node.from + 1;
  const textTo = marks[1]?.from ?? node.to - 1;
  const label = () => inlineRange(cx, src, node, textFrom, textTo, state);
  if (isShortcut(node)) {
    const footnote = FOOTNOTE_RE.exec(text);
    if (footnote) return footnoteRef(cx, footnote[1]!);
    if (src[node.from - 1] === "[" && src[node.to] === "]") return wikilink(cx, text.slice(1, -1));
    const ref = cx.refs.get(normalizeLabel(src.slice(textFrom, textTo)));
    // 文档里没有对应的定义：就是一对方括号
    return ref ? anchor(ref.url, label(), ref.title) : `[${label()}]`;
  }
  const url = node.getChild("URL");
  if (url) {
    const title = node.getChild("LinkTitle");
    return anchor(
      src.slice(url.from, url.to).replace(/^<|>$/g, ""),
      label(),
      title ? src.slice(title.from + 1, title.to - 1) : "",
    );
  }
  const refLabel = node.getChild("LinkLabel");
  const key = refLabel ? src.slice(refLabel.from + 1, refLabel.to - 1) : "";
  const ref = cx.refs.get(normalizeLabel(key || src.slice(textFrom, textTo)));
  return ref ? anchor(ref.url, label(), ref.title) : escapeHtml(text);
}

function image(cx: Context, src: string, node: SyntaxNode): string {
  const raw = src.slice(node.from, node.to);
  const wiki = /^!\[\[([^\]]+)\]\]$/.exec(raw)?.[1];
  if (wiki !== undefined) {
    const target = wikiImageTarget(wiki);
    if (!target) {
      // `![[说明书.pdf]]`：导出的页面里打不开它，写上名字和类型
      const file = wikiFileTarget(wiki);
      if (file) {
        const name = file.label || file.name.slice(file.name.lastIndexOf("/") + 1);
        return `<span class="attachment" title="${escapeHtml(file.name)}">${escapeHtml(name)}<span class="attachment-kind">${escapeHtml(attachmentLabel(file.name))}</span></span>`;
      }
      // 夹在字里的 `![[笔记]]`：当双链
      return wikilink(cx, wiki);
    }
    const resolved = cx.options.wikiImage(target.name);
    const source =
      typeof resolved === "string" || resolved === null
        ? escapeHtml(resolved ?? "")
        : slot(
            cx,
            resolved.then((value) => escapeHtml(value ?? "")),
          );
    const missing = `仓库里找不到「${target.name}」`;
    return imgTag(cx, source, target.alt, "", target.width, target.height, missing);
  }
  // 引用式的图片：定义可能不在这一段里（callout 的正文是单独排的），再到整篇的定义里找
  const reference = /^!\[([^\]]*)\]\[([^\]]*)\]$/.exec(raw);
  const defined = reference && cx.refs.get(normalizeLabel(reference[2] || reference[1]!));
  const spec =
    parseImage(src, raw) ??
    (defined ? parseImage(src, `![${reference![1]}](${defined.url})`) : null);
  if (!spec) return escapeHtml(raw);
  return imgTag(cx, imageSrc(cx, spec.source), spec.alt, spec.title, spec.width, spec.height);
}

/**
 * source 是转义好的地址或者占位记号。空的（或者换上以后是空的）：renderStaticHtml 最后换成一个带字的框
 */
function imgTag(
  cx: Context,
  source: string,
  alt: string,
  title: string,
  width: number | null,
  height: number | null,
  missing = "",
): string {
  const size = (width ? ` width="${width}"` : "") + (height ? ` height="${height}"` : "");
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  const label = escapeHtml(missing || alt || "图片");
  if (cx.editor) {
    // 照编辑器排：编辑器里的图片替身（widgets.ts 的 ImageWidget）—— 一块，上下各留 14px，宽写了的按写的
    const style =
      (width ? `width: ${width}px;` : "") +
      (height ? `${width ? " " : ""}height: ${height}px;` : "");
    return `<span class="cm-odea-image-frame is-settled"><span class="cm-odea-image-box"><img src="${source}" class="cm-odea-image is-loaded${width ? " has-size" : ""}" alt="${escapeHtml(alt)}"${titleAttr}${style ? ` style="${style}"` : ""} data-missing="${label}"></span></span>`;
  }
  return `<img src="${source}" alt="${escapeHtml(alt)}"${titleAttr}${size} data-missing="${label}">`;
}

/* ---------------- 行内 HTML ---------------- */

/** 白名单里的标签配上对的照出（属性按白名单洗过），配不上对的、不认识的当字（和编辑器一样） */
function htmlTag(cx: Context, src: string, node: SyntaxNode, state: InlineState): string {
  const raw = src.slice(node.from, node.to);
  const tag = parseTag(raw);
  if (state.closes.has(node.from))
    return tag ? `</${tag.name === "font" ? "span" : tag.name}>` : "";
  if (!tag) return escapeHtml(raw);
  if (tag.name === "br" && !tag.closing) return "<br>";
  if (tag.name === "img" && !tag.closing) {
    const source = tag.attrs.src?.trim();
    if (!source || /^(?:javascript|vbscript):/i.test(source)) return "";
    return imgTag(
      cx,
      imageSrc(cx, source),
      tag.attrs.alt ?? "",
      tag.attrs.title ?? "",
      Number(tag.attrs.width) || null,
      Number(tag.attrs.height) || null,
    );
  }
  if (!(tag.name in INLINE_HTML_TAGS) || tag.closing || tag.selfClosing) return escapeHtml(raw);
  // 往后找同名闭标签（同一个父节点的兄弟里），中间再遇到同名开标签就要多配一个
  let depth = 0;
  let close: SyntaxNode | null = null;
  for (let sibling = node.nextSibling; sibling; sibling = sibling.nextSibling) {
    if (sibling.name !== "HTMLTag") continue;
    const other = parseTag(src.slice(sibling.from, sibling.to));
    if (!other || other.name !== tag.name || other.selfClosing) continue;
    if (!other.closing) {
      depth += 1;
      continue;
    }
    if (depth === 0) {
      close = sibling;
      break;
    }
    depth -= 1;
  }
  if (!close) return escapeHtml(raw);
  state.closes.add(close.from);
  const attributes: string[] = [];
  const style = inlineStyleOf(tag);
  if (style) attributes.push(`style="${escapeHtml(style)}"`);
  if (tag.name === "a") {
    const href = safeHref(tag.attrs.href);
    if (href) attributes.push(`href="${escapeHtml(href)}"`);
  }
  if ((tag.name === "abbr" || tag.name === "a") && tag.attrs.title) {
    attributes.push(`title="${escapeHtml(tag.attrs.title)}"`);
  }
  const name = tag.name === "font" ? "span" : tag.name;
  return `<${name}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
}
