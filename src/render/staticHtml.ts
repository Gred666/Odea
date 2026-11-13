import { animatedEmojiFor } from "@/editor/animatedEmoji";
import { type CalloutKind, calloutIcon, parseCalloutHead } from "@/editor/callout";
import { codeHighlightStyle } from "@/editor/codeHighlight";
import { emojiFor } from "@/editor/emoji";
import { decodeEntity } from "@/editor/entities";
import { INLINE_HTML_TAGS, inlineStyleOf, parseTag, safeHref, sanitizeHtml } from "@/editor/html";
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
import { type EmbedTarget, noteEmbedTarget } from "@/lib/embeds";
import { ANIMATED_EMOJI_FALLBACK } from "@/lib/emojiText";
import { attachmentLabel, wikiFileTarget, wikiImageTarget } from "@/lib/wikiFiles";
import type { SyntaxNode, Tree } from "@lezer/common";
import { parser as baseParser } from "@lezer/markdown";

/* ============================================================
   静态渲染：一篇 Markdown → 一段 HTML。导出 HTML / PDF（export/document.ts）和 `![[笔记]]` 的嵌入卡片
   （editor/embed.ts）用它。样式在 render/static.css，外层套一个带 `odea-static` 类的元素。

   认语法和编辑器是同一套：同一个 Lezer 解析器配置（editor/markdownParser.ts）；装饰层里按正则认的
   （callout、脚注、双链、==高亮==、定义列表、缩写、[TOC]、合并单元格 `<` `^`、智能标点）照着
   MarkdownEditor.tsx 的规矩来；行内 HTML、块级 HTML 走同一份白名单（editor/html.ts）。编辑器里
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
}

const parser = baseParser.configure(markdownExtensions);

/* ---------------- 正则（和 MarkdownEditor.tsx 的一样） ---------------- */

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
  if (!match || !/^[A-Za-z_][\w-]*\s*:/m.test(match[0])) return markdown;
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
  // 地址到最后也没有的图片：画成一个带字的框
  return html
    .replace(
      /<img src=""[^>]*? data-missing="([^"]*)">/g,
      (_, label: string) => `<span class="image-missing">${label}</span>`,
    )
    .replace(/ data-missing="[^"]*">/g, ">");
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

/** 一个容器（文档、引用、列表项）里的块，一个接一个。tight：紧凑列表里，段落不包 <p> */
function blocks(cx: Context, src: string, parent: SyntaxNode, tight = false): string {
  const out: string[] = [];
  /** 上一块是单独一行的段落：它后面空一行的 `: 释义` 能把它变成定义列表的术语 */
  let lonely: { index: number; text: string } | null = null;
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (/Mark$/.test(node.name)) continue;
    if (node.name === "Paragraph") {
      const text = src.slice(node.from, node.to);
      const lines = text.split("\n");
      if (lonely && lines.every((line) => DEFINITION_RE.test(line))) {
        out[lonely.index] = definitionList(cx, [lonely.text, ...lines]);
        lonely = null;
        continue;
      }
      const html = paragraph(cx, src, node, tight);
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
  return out.filter(Boolean).join("\n");
}

function block(cx: Context, src: string, node: SyntaxNode): string {
  const name = node.name;
  const heading = HEADING_RE.exec(name);
  if (heading) {
    const level = heading[1];
    const id = cx.headingIds.get(node.from);
    const body = inline(cx, src, node)
      .replace(/(?:<br>\n)+$/, "")
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
    case "Table":
      return table(cx, parseMarkdownTable(src.slice(node.from, node.to)), true);
    case "HorizontalRule":
      return "<hr>";
    case "CommentBlock":
    case "ProcessingInstructionBlock":
    case "LinkReference":
      return "";
    default:
      return `<p>${escapeHtml(src.slice(node.from, node.to))}</p>`;
  }
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
    const kept = lines.filter((line) => !FOOTNOTE_DEF_RE.test(line) && !ABBREVIATION_RE.test(line));
    // 脚注、缩写的定义行拿掉（脚注收到最后），剩下的另起一段重新排
    if (kept.length < lines.length) return kept.length ? fragment(cx, kept.join("\n"), tight) : "";
    if (lines.slice(1).some((line) => DEFINITION_RE.test(line))) return definitionList(cx, lines);
  }
  const body = inline(cx, src, node);
  return tight ? body : `<p>${body}</p>`;
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
  if (ordered) {
    const mark = items[0]?.getChild("ListMark");
    const first = mark ? Number.parseInt(src.slice(mark.from, mark.to), 10) : 1;
    if (Number.isFinite(first) && first !== 1) start = ` start="${first}"`;
  }
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
  return `<div class="${classes}"><div class="callout-head">${badge}${title}</div>${inner}</div>`;
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
  const label = language ? ` data-lang="${escapeHtml(language)}"` : "";
  const body =
    cx.options.highlight && language ? slot(cx, highlight(code, language)) : escapeHtml(code);
  return `<pre class="code"${label}><code>${body}</code></pre>`;
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
    const { loadKatex } = await import("@/editor/math");
    const katex = await loadKatex();
    // KaTeX 的输出是它自己生成的标记，用户原文都转义过（editor/math.ts 的 render 也是这么用的）
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
    });
  })();
  return `<${tag} class="${className}">${slot(cx, work)}</${tag}>`;
}

/* ---------------- 块级 HTML ---------------- */

function htmlBlock(cx: Context, source: string): string {
  if (HTML_COMMENT_RE.test(source)) return "";
  const holder = document.createElement("div");
  holder.append(sanitizeHtml(source));
  if (!holder.childNodes.length) return "";
  // 块级 HTML 里的 <img>：先记下地址换成记号，序列化以后再换成解析好的（导出时嵌成 data:）
  const images = [...holder.querySelectorAll("img")];
  const sources = images.map((image) => rawSourceOf(image.getAttribute("src") ?? ""));
  images.forEach((image, index) => {
    image.setAttribute("src", `@@IMG${index}@@`);
    // 净化时给的懒加载去掉：屏幕外的图不加载，打印成 PDF 时就缺了
    image.removeAttribute("loading");
  });
  let html = holder.innerHTML;
  sources.forEach((raw, index) => {
    html = html.replace(`@@IMG${index}@@`, imageSrc(cx, raw));
  });
  return `<div class="html-block">${html}</div>`;
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
  const head = `<thead><tr>${row(0)}</tr></thead>`;
  const body = model.rows.length
    ? `<tbody>${model.rows.map((_, index) => `<tr>${row(index + 1)}</tr>`).join("")}</tbody>`
    : "";
  return `<div class="table-wrap"><table>${head}${body}</table></div>`;
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
 * `==高亮==`：只在同一层的字里配对（MarkdownEditor.tsx 的 markdownSourceStyleRules 的规矩）——
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
    .join("<br>\n");
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
      return "<br>\n";
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
    return imgTag(source, target.alt, "", target.width, target.height, missing);
  }
  // 引用式的图片：定义可能不在这一段里（callout 的正文是单独排的），再到整篇的定义里找
  const reference = /^!\[([^\]]*)\]\[([^\]]*)\]$/.exec(raw);
  const defined = reference && cx.refs.get(normalizeLabel(reference[2] || reference[1]!));
  const spec =
    parseImage(src, raw) ??
    (defined ? parseImage(src, `![${reference![1]}](${defined.url})`) : null);
  if (!spec) return escapeHtml(raw);
  return imgTag(imageSrc(cx, spec.source), spec.alt, spec.title, spec.width, spec.height);
}

/**
 * source 是转义好的地址或者占位记号。空的（或者换上以后是空的）：renderStaticHtml 最后换成一个带字的框
 */
function imgTag(
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
