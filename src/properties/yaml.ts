/* ============================================================
   属性块里用户自己的那几行（docs/提醒与属性.md §3）：认成一条条属性，改一条只换它自己那几行。

   不是完整的 YAML，只认属性块里常见的写法（和 Obsidian 写出来的一样）：

       status: 进行中               文字
       优先级: 2                    数字
       公开: false                  勾选
       截止: 2026-11-20             日期（2026-11-20T15:30 是日期时间）
       tags: [项目, 发版]            列表（一行写完）
       aliases:                     列表（一行一条）
         - 发版
       摘要: |                      多行字符串、嵌套的：面板里只读，去源码改
         …

   认不出的行（注释、空行、乱写的）不属于哪一条，原样留着；改别的属性时一个字节都不动它们。
   Rust 那边是同一套认法的简化版（src-tauri/src/vault/properties.rs，只拿来数用得多的键和值）
   ============================================================ */

export type Kind =
  | "text"
  | "multitext"
  | "number"
  | "checkbox"
  | "date"
  | "datetime"
  | "tags"
  | "aliases";

export const KINDS: Kind[] = [
  "text",
  "multitext",
  "number",
  "checkbox",
  "date",
  "datetime",
  "tags",
  "aliases",
];

/** 应用自己的键：面板里不出现、不许用（frontmatter.rs 管它们） */
export const MANAGED = [
  "id",
  "title",
  "created",
  "pinned",
  "archived",
  "category",
  "archived-from",
  "trashed-from",
];

export interface Entry {
  key: string;
  /** 在 lines 里的第几行起、到第几行之前 */
  start: number;
  end: number;
  shape: "scalar" | "list" | "complex";
  /** scalar 的值（去了引号；空的是 ""） */
  value: string;
  /** list 的几项 */
  items: string[];
  /** list 写成一行 `[a, b]` 的：改了也照这样写 */
  flow: boolean;
}

export interface Parsed {
  lines: string[];
  entries: Entry[];
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** `[a, "b, c"]` 里面那一段拆开（引号里的逗号不算） */
function flowItems(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const c of inner) {
    if (quote === null && (c === '"' || c === "'")) quote = c;
    else if (c === quote) quote = null;
    if (quote === null && c === ",") {
      items.push(current);
      current = "";
    } else current += c;
  }
  items.push(current);
  return items.map(unquote).filter((item) => item !== "");
}

const INDENTED = /^[ \t]/;

export function parse(text: string): Parsed {
  const lines = text === "" ? [] : text.split("\n");
  const entries: Entry[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const start = index;
    index += 1;
    if (INDENTED.test(line) || /^[#-]/.test(line) || line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = unquote(line.slice(0, colon));
    const rest = line.slice(colon + 1).trim();
    // 续行：缩进的、`- ` 开头的（YAML 允许列表项不缩进）
    const at = (i: number) => lines[i] ?? "";
    while (index < lines.length && (INDENTED.test(at(index)) || at(index).startsWith("- "))) {
      index += 1;
    }
    // 续行末尾的空行不算它的
    let end = index;
    while (end > start + 1 && at(end - 1).trim() === "") end -= 1;
    const more = lines
      .slice(start + 1, end)
      .map((l) => l.trim())
      .filter((l) => l !== "");
    const entry: Entry = { key, start, end, shape: "scalar", value: "", items: [], flow: false };
    if (rest === "") {
      if (more.length > 0 && more.every((l) => l.startsWith("-"))) {
        entry.shape = "list";
        entry.items = more.map((l) => unquote(l.replace(/^-\s*/, ""))).filter((v) => v !== "");
      } else if (more.length > 0) {
        entry.shape = "complex";
      }
    } else if (rest.startsWith("[") && rest.endsWith("]") && more.length === 0) {
      entry.shape = "list";
      entry.flow = true;
      entry.items = flowItems(rest.slice(1, -1));
    } else if (/^[|>{[&*!]/.test(rest) || more.length > 0) {
      entry.shape = "complex";
    } else {
      // 行尾的注释不算值（` #` 前面有空格才是注释，`C#` 不是）
      const quoted = /^["']/.test(rest);
      entry.value = unquote(quoted ? rest : (rest.split(/\s#/)[0] ?? ""));
    }
    entries.push(entry);
  }
  return { lines, entries };
}

/* ---------------- 类型 ---------------- */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

/** 一个值像什么类型 */
export function kindOfValue(value: string): Kind {
  if (value === "true" || value === "false") return "checkbox";
  if (/^-?\d+(\.\d+)?$/.test(value)) return "number";
  if (DATE.test(value) && !Number.isNaN(Date.parse(value))) return "date";
  if (DATETIME.test(value)) return "datetime";
  return "text";
}

const LIST_KINDS: Kind[] = ["multitext", "tags", "aliases"];
export const isListKind = (kind: Kind) => LIST_KINDS.includes(kind);

/**
 * 这一条是什么类型：仓库里记着的 → 专用的键（tags、aliases）→ 这个值像什么 → 整个仓库里这个键的值多半是什么。
 * 值是空的才看整个仓库（`截止:` 空着，别的笔记里都是日期，它就是日期）
 */
export function kindOf(
  entry: Entry,
  recorded: Record<string, string | undefined>,
  usual?: string,
): Kind {
  const known = recorded[entry.key];
  if (known && (KINDS as string[]).includes(known)) return known as Kind;
  const lower = entry.key.toLowerCase();
  if (lower === "tags" || lower === "tag") return "tags";
  if (lower === "aliases" || lower === "alias") return "aliases";
  if (entry.shape === "list") return "multitext";
  if (entry.value !== "") return kindOfValue(entry.value);
  if (usual && (KINDS as string[]).includes(usual)) return usual as Kind;
  return "text";
}

/* ---------------- 写回 ---------------- */

/** 值要不要加引号：会被认成别的东西的（数字、true、带冒号空格、以特殊符号开头的）加上 */
function needsQuote(value: string, kind: Kind, inFlow: boolean): boolean {
  if (value === "") return false;
  if (/^\s|\s$/.test(value)) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) return true;
  if (/:\s|\s#|: *$/.test(value)) return true;
  if (inFlow && /[,[\]{}]/.test(value)) return true;
  if (kind === "text" || isListKind(kind)) {
    // 文字照文字存：别让 `2` 读回来成了数字、`true` 成了勾选
    if (/^(true|false|null|~|yes|no|on|off)$/i.test(value)) return true;
    if (/^[-+]?(\d[\d_]*)?(\.\d+)?([eE][-+]?\d+)?$/.test(value)) return true;
    if (DATE.test(value) || DATETIME.test(value)) return true;
  }
  return false;
}

function scalar(value: string, kind: Kind, inFlow = false): string {
  return needsQuote(value, kind, inFlow) ? JSON.stringify(value) : value;
}

function keyText(key: string): string {
  return /^[\w\u0080-￿][\w\u0080-￿ .\-/]*$/.test(key) && !key.endsWith(" ")
    ? key
    : JSON.stringify(key);
}

/** 一条属性写成几行。列表照原来的写法（一行 `[a, b]` 还是一行一条），新的照 Obsidian 写成一行一条 */
export function entryLines(
  key: string,
  kind: Kind,
  value: string | string[],
  flow = false,
): string[] {
  const head = keyText(key);
  if (isListKind(kind)) {
    const items = (Array.isArray(value) ? value : value === "" ? [] : [value]).filter(
      (item) => item !== "",
    );
    if (items.length === 0) return [`${head}:`];
    if (flow) return [`${head}: [${items.map((item) => scalar(item, kind, true)).join(", ")}]`];
    return [`${head}:`, ...items.map((item) => `  - ${scalar(item, kind)}`)];
  }
  const one = Array.isArray(value) ? (value[0] ?? "") : value;
  if (one === "") return [`${head}:`];
  if (kind === "checkbox") return [`${head}: ${one === "true" ? "true" : "false"}`];
  if (kind === "number" || kind === "date" || kind === "datetime") return [`${head}: ${one}`];
  return [`${head}: ${scalar(one, kind)}`];
}

function splice(parsed: Parsed, start: number, end: number, insert: string[]): string {
  return [...parsed.lines.slice(0, start), ...insert, ...parsed.lines.slice(end)].join("\n");
}

/** 换掉一条（只动它自己那几行） */
export function replaceEntry(parsed: Parsed, entry: Entry, lines: string[]): string {
  return splice(parsed, entry.start, entry.end, lines);
}

export function removeEntry(parsed: Parsed, entry: Entry): string {
  return splice(parsed, entry.start, entry.end, []);
}

/** 加在最后一条属性后面（末尾的注释、空行留在后面） */
export function appendEntry(parsed: Parsed, lines: string[]): string {
  const last = parsed.entries[parsed.entries.length - 1];
  const at = last ? last.end : parsed.lines.length;
  return splice(parsed, at, at, lines);
}

/** 改键名：只换那一行开头的键，值和续行原样 */
export function renameEntry(parsed: Parsed, entry: Entry, key: string): string {
  const first = parsed.lines[entry.start] ?? "";
  const colon = first.indexOf(":");
  return splice(parsed, entry.start, entry.start + 1, [`${keyText(key)}${first.slice(colon)}`]);
}

/** 把一条的值转成另一种类型时，能留的留着（列表 ↔ 文字、日期 ↔ 日期时间） */
export function convertValue(entry: Entry, from: Kind, to: Kind): string | string[] {
  const values = entry.shape === "list" ? entry.items : entry.value === "" ? [] : [entry.value];
  if (isListKind(to)) return values;
  const first = values[0] ?? "";
  switch (to) {
    case "checkbox":
      return first === "true" ? "true" : "false";
    case "number":
      return /^-?\d+(\.\d+)?$/.test(first) ? first : "";
    case "date":
      return /^\d{4}-\d{2}-\d{2}/.test(first) ? first.slice(0, 10) : "";
    case "datetime":
      if (DATETIME.test(first)) return first.replace(" ", "T").slice(0, 16);
      return DATE.test(first) ? `${first}T09:00` : "";
    default:
      return from === "checkbox" && first === "" ? "" : values.join(", ");
  }
}
