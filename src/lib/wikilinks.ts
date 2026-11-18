/* ============================================================
   正文里的 `[[双链]]`。

   和 Rust 侧 src-tauri/src/vault/links.rs 同一套规则（桌面版的反向链接、改标题时改写别处的
   链接在那边算；这里给浏览器 mock 和反向链接面板画行内小块用）：
     [[标题]]  [[标题|别名]]  [[标题#小节]]  [[标题^块id]]
   目标按标题匹配，去掉首尾空白、不分大小写。围栏代码块和行内代码里的不算。
   ============================================================ */

export interface WikiLinkHit {
  /** 正文里的行号（从 0 开始） */
  line: number;
  /** 目标标题（去掉了 `|别名`、`#小节`、`^块`） */
  title: string;
}

/** 双链的目标标题：`标题|别名` → 标题，`标题#小节` / `标题^块` → 标题 */
export function wikiTargetTitle(inner: string): string {
  const [start, end] = titleRange(inner);
  return inner.slice(start, end);
}

/** 目标标题在 `[[` `]]` 之间那段原文里的位置（去掉两头空白） */
function titleRange(inner: string): [number, number] {
  const target = inner.split("|")[0] ?? "";
  const cuts = [target.indexOf("#"), target.indexOf("^")].filter((index) => index > 0);
  const segment = target.slice(0, cuts.length ? Math.min(...cuts) : target.length);
  const start = segment.length - segment.trimStart().length;
  return [start, start + segment.trim().length];
}

/** 标题能不能原样写进 `[[…]]`：`[` `]` 会把链接拆断，`|` `#` `^` 会被当成别名、小节、块 */
export function linkableTitle(title: string): boolean {
  const clean = title.trim();
  return !!clean && !/[[\]|#^\r\n]/.test(clean);
}

/** `[[目标|别名]]` 显示成什么：有别名显示别名，没有就是目标原文 */
export function wikiDisplayText(inner: string): string {
  const pipe = inner.indexOf("|");
  return (pipe >= 0 ? inner.slice(pipe + 1) : inner).trim();
}

/** 两篇标题是不是同一篇（和 Mod+点击跳转的规则一样） */
export function sameTitle(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * `[[标题]]` 指向的那一篇：没归档的在前，同名的几篇取最近改过的。`[[` 的提示里同名的只列这一篇
 * （editor/suggest 的 wikiItems，审查 2026-11-13 §5.11），点开、嵌进来的也得是它
 */
export function linkedNote<T extends { title: string; updatedAt: number }>(
  title: string,
  notes: readonly T[],
  archived: readonly T[],
): T | undefined {
  const latest = (list: readonly T[]) => {
    let best: T | undefined;
    for (const note of list) {
      if (sameTitle(note.title, title) && (!best || note.updatedAt > best.updatedAt)) best = note;
    }
    return best;
  };
  return latest(notes) ?? latest(archived);
}

/** 一篇正文里所有的双链，按出现顺序 */
export function findWikiLinks(body: string): WikiLinkHit[] {
  return spans(body).map((span) => ({ line: span.line, title: body.slice(span.start, span.end) }));
}

/**
 * 把正文里链到 `from` 的双链改成链到 `to`：只换标题那一段，`|别名`、`#小节`、`^块` 和两头的空白
 * 原样留着；代码里的、转义的不动。一处都没有返回 null
 */
export function retargetWikiLinks(
  body: string,
  from: string,
  to: string,
): { body: string; count: number } | null {
  const hits = spans(body).filter((span) => sameTitle(body.slice(span.start, span.end), from));
  if (!hits.length) return null;
  let out = "";
  let at = 0;
  for (const span of hits) {
    out += body.slice(at, span.start) + to.trim();
    at = span.end;
  }
  return { body: out + body.slice(at), count: hits.length };
}

/** 每处双链里标题那一段在正文里的位置 */
function spans(body: string): { line: number; start: number; end: number }[] {
  const out: { line: number; start: number; end: number }[] = [];
  let fence: { ch: string; len: number } | null = null;
  let offset = 0;
  body.split("\n").forEach((line, index) => {
    const lineStart = offset;
    offset += line.length + 1;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      const run = marker[1]!;
      if (!fence) {
        fence = { ch: run[0]!, len: run.length };
        return;
      }
      if (run[0] === fence.ch && run.length >= fence.len && !marker[2]!.trim()) {
        fence = null;
        return;
      }
    }
    if (fence || !line.includes("[[")) return;
    // 行内代码换成了等长的空格，位置和原来那一行一一对应
    for (const [start, end] of linkRanges(withoutCodeSpans(line))) {
      out.push({ line: index, start: lineStart + start, end: lineStart + end });
    }
  });
  return out;
}

/** 一行里每处双链的标题在这一行里的位置 */
function linkRanges(line: string): [number, number][] {
  const out: [number, number][] = [];
  let base = 0;
  for (;;) {
    const open = line.indexOf("[[", base);
    if (open < 0) break;
    const close = line.indexOf("]]", open + 2);
    if (close < 0) break;
    const inner = line.slice(open + 2, close);
    // `[[a [b] c]]` 这类嵌套不是双链；`\[[` 是转义
    const escaped = open > 0 && line[open - 1] === "\\";
    if (!inner.includes("[") && !inner.includes("]") && !escaped) {
      const [from, to] = titleRange(inner);
      if (from < to) out.push([open + 2 + from, open + 2 + to]);
    }
    base = close + 2;
  }
  return out;
}

/** 一行里的双链片段：`[[` 和 `]]` 之间的原文（含别名），按出现顺序 */
export function splitWikiSegments(
  line: string,
): ({ kind: "text"; text: string } | { kind: "link"; inner: string })[] {
  const out: ({ kind: "text"; text: string } | { kind: "link"; inner: string })[] = [];
  let rest = line;
  while (rest) {
    const start = rest.indexOf("[[");
    const end = start >= 0 ? rest.indexOf("]]", start + 2) : -1;
    if (start < 0 || end < 0) {
      out.push({ kind: "text", text: rest });
      break;
    }
    const inner = rest.slice(start + 2, end);
    if (inner.includes("[") || inner.includes("]") || !wikiTargetTitle(inner)) {
      out.push({ kind: "text", text: rest.slice(0, end + 2) });
    } else {
      if (start > 0) out.push({ kind: "text", text: rest.slice(0, start) });
      out.push({ kind: "link", inner });
    }
    rest = rest.slice(end + 2);
  }
  return out;
}

/** 去掉行内代码（成对的反引号串之间的内容），换成空格，位置不变 */
function withoutCodeSpans(line: string): string {
  return line.replace(/(`+)([\s\S]*?)\1/g, (match) => " ".repeat(match.length));
}

/** 反向链接里给人看的那一行：去掉列表符号、任务框、引用和标题的井号 */
export function contextLine(line: string): string {
  let text = line.trim();
  for (;;) {
    const before = text;
    text = text
      .replace(/^>\s*/, "")
      .replace(/^[-*+]\s+\[[ xX]\]\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^#+\s*/, "")
      .replace(/^\d+\.\s+/, "");
    if (text === before) return text;
  }
}
