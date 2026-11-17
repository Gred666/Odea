/* ============================================================
   摘要和字数用的纯文本。
   桌面端由 Rust 算（src-tauri/src/domain/search.rs 的 strip_markdown），这里是
   同一套规则的 TS 版，给浏览器 mock 用 —— 两边看到的摘要和字数要一致。

   整行跳过：front matter、围栏行、分隔线 / Setext 下划线、表格分隔行、
   链接和缩写定义、`[TOC]`、callout 标签行、HTML 注释。
   行首剥掉：引用、标题、列表符号、任务勾选框、脚注定义的 `[^id]:`。
   行内：图片留 alt，链接留文字，双链留别名（没有别名就是目标），行内代码留原文，
   脚注引用、HTML 标签去掉，强调 / 删除线 / 高亮的符号去掉。
   ============================================================ */

import { isFrontMatterKey } from "@/editor/frontMatter";

/** 正文摘要：纯文本前 n 个字符，截断了加省略号。 */
export function makeExcerpt(markdown: string, n = 60): string {
  const chars = [...plainText(markdown)];
  return chars.length > n ? `${chars.slice(0, n).join("")}…` : chars.join("");
}

/** 字数：中文按字算，英文按词算；裸网址算一个词。 */
export function countWords(markdown: string): number {
  const plain = plainText(markdown);
  const cjk = (plain.match(/[㐀-䶿一-鿿]/g) ?? []).length;
  let words = 0;
  for (const token of plain.split(/\s+/)) {
    if (!token) continue;
    words += token.includes("://") ? 1 : (token.match(/[A-Za-z0-9]+/g) ?? []).length;
  }
  return cjk + words;
}

export function plainText(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const words: string[] = [];
  let inComment = false;

  for (const raw of lines.slice(frontMatterLength(lines))) {
    let line = raw.trim();
    if (inComment) {
      const end = line.indexOf("-->");
      if (end < 0) continue;
      inComment = false;
      line = line.slice(end + 3).trim();
    }
    const start = line.indexOf("<!--");
    if (start >= 0 && !line.slice(start).includes("-->")) {
      inComment = true;
      line = line.slice(0, start).trim();
    }
    if (isMarkupOnlyLine(line)) continue;

    let text = stripInline(stripLinePrefix(line));
    if (line.startsWith("|")) text = text.replaceAll("|", " ");
    words.push(...text.split(/\s+/).filter(Boolean));
  }
  return words.join(" ");
}

/** 和编辑器的 editor/frontMatter.ts 同一规则：第一行 `---`，60 行内收尾，中间有 `key:`。 */
function frontMatterLength(lines: string[]): number {
  const isFence = (line: string) => line.trimEnd() === "---";
  if (lines.length < 3 || !isFence(lines[0]!)) return 0;
  let sawKey = false;
  for (let index = 1; index < Math.min(lines.length, 60); index += 1) {
    if (isFence(lines[index]!)) return sawKey ? index + 1 : 0;
    if (isFrontMatterKey(lines[index]!)) sawKey = true;
  }
  return 0;
}

function isMarkupOnlyLine(line: string): boolean {
  return (
    line.startsWith("```") ||
    line.startsWith("~~~") ||
    /^[-*_=\s]+$/.test(line) ||
    /^\|[|:\-\s]*$/.test(line) ||
    /^>[>\s]*\[!/.test(line) ||
    /^\[\[?toc\]?\]$/i.test(line) ||
    /^\*?\[(?!\^)[^[\]]*\]:/.test(line)
  );
}

function stripLinePrefix(input: string): string {
  let line = input.trimStart().replace(/^(?:>\s*)+/, "");

  const heading = /^(#{1,6})(?:\s+|$)/.exec(line);
  if (heading) {
    const text = line.slice(heading[1]!.length).trim();
    const unclosed = text.replace(/#+$/, "");
    return unclosed === "" || /\s$/.test(unclosed) ? unclosed.trimEnd() : text;
  }

  line = line.replace(/^(?:[-*+]|\d{1,9}[.)])(?:\s+|$)/, "");
  line = line.replace(/^\[[ xX]\](?:\s+|$)/, "");
  return line.replace(/^\[\^[^\]]*\]:\s*/, "");
}

function stripInline(text: string): string {
  let out = "";
  let rest = text;
  while (rest) {
    const c = rest[0]!;
    let step: [string, string] | null = null;
    if (c === "\\") {
      const next = rest[1];
      if (next && /[!-/:-@[-`{-~]/.test(next)) step = [next, rest.slice(2)];
    } else if (c === "`") {
      step = codeSpan(rest);
    } else if (c === "!" && rest[1] === "[") {
      const link = linkLike(rest.slice(1));
      if (link) step = [imageAlt(link[0]), link[1]];
    } else if (c === "[") {
      step = wikiLink(rest) ?? footnoteRef(rest);
      if (!step) {
        const link = linkLike(rest);
        if (link) step = [stripInline(link[0]), link[1]];
      }
    } else if (c === "<") {
      step = html(rest);
    } else if (c === "*") {
      step = ["", rest.slice(1)];
    } else if ((c === "~" || c === "=" || c === "_") && rest[1] === c) {
      step = ["", rest.slice(2)];
    }

    if (step) {
      out += step[0];
      rest = step[1];
    } else {
      // 按码点前进：代理对（emoji）不能拆开
      const char = String.fromCodePoint(rest.codePointAt(0)!);
      out += char;
      rest = rest.slice(char.length);
    }
  }
  return out;
}

function codeSpan(rest: string): [string, string] {
  const ticks = /^`+/.exec(rest)![0];
  const body = rest.slice(ticks.length);
  const end = body.indexOf(ticks);
  return end < 0 ? ["", body] : [body.slice(0, end).trim(), body.slice(end + ticks.length)];
}

/** `[文字](地址)` / `[文字][标签]`。后面不跟 `(` / `[` 的方括号只是文字，返回 null。 */
function linkLike(rest: string): [string, string] | null {
  const close = matching(rest, "[", "]");
  if (close < 0) return null;
  const label = rest.slice(1, close);
  const after = rest.slice(close + 1);
  if (after.startsWith("(")) {
    const end = matching(after, "(", ")");
    return end < 0 ? null : [label, after.slice(end + 1)];
  }
  if (after.startsWith("[")) {
    const end = after.indexOf("]");
    return end < 0 ? null : [label, after.slice(end + 1)];
  }
  return null;
}

function matching(text: string, open: string, close: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === open) depth += 1;
    else if (text[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Obsidian 式尺寸 `![alt|300]` / `![alt|300x200]` 不算 alt。 */
function imageAlt(label: string): string {
  const bar = label.lastIndexOf("|");
  if (bar >= 0 && /^[\dx]+$/.test(label.slice(bar + 1))) return label.slice(0, bar).trim();
  return label.trim();
}

function wikiLink(rest: string): [string, string] | null {
  if (!rest.startsWith("[[")) return null;
  const end = rest.indexOf("]]", 2);
  if (end < 0) return null;
  const inner = rest.slice(2, end);
  const bar = inner.indexOf("|");
  return [(bar < 0 ? inner : inner.slice(bar + 1)).trim(), rest.slice(end + 2)];
}

function footnoteRef(rest: string): [string, string] | null {
  if (!rest.startsWith("[^")) return null;
  const end = rest.indexOf("]");
  return end < 0 ? null : ["", rest.slice(end + 1)];
}

/** HTML 注释和标签去掉（`<br>` 换成空格），`<https://…>` / `<a@b.c>` 留地址。 */
function html(rest: string): [string, string] | null {
  if (rest.startsWith("<!--")) {
    const end = rest.indexOf("-->", 4);
    return end < 0 ? null : ["", rest.slice(end + 3)];
  }
  const end = rest.indexOf(">");
  if (end < 0) return null;
  const inner = rest.slice(1, end);
  const after = rest.slice(end + 1);
  if (inner && !/\s/.test(inner) && (inner.includes("://") || inner.includes("@"))) {
    return [inner, after];
  }
  const tag = /^\/?([A-Za-z][A-Za-z0-9]*)/.exec(inner);
  if (!tag) return null;
  return [tag[1]!.toLowerCase() === "br" ? " " : "", after];
}
