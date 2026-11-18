/* ============================================================
   按一个视图把行算出来（docs/视图文件.md §3.3、§3.4）：筛选 → 排序 → limit → 分组；每一格的值。

   行是 Rust 给的每一篇 Markdown 文档（bases/docs.ts）。属性原文用属性面板那一套认（properties/yaml.ts），
   按原文缓存：几千篇只在第一次、和改了的那几篇认一遍。值的类型：types.json 记着的优先，再按值像什么
   ============================================================ */

import type { BaseDoc } from "@/lib/bindings";
import {
  type Entry,
  type Kind,
  type Parsed,
  isListKind,
  kindOf,
  parse,
  singleValue,
} from "@/properties/yaml";
import type { BaseConfig, FilterNode, ViewConfig } from "./config";
import {
  BLink,
  type FileSource,
  type Node,
  type Scope,
  Unsupported,
  type Value,
  evaluate,
  namesIn,
  parseDate,
  parseExpr,
  sortCompare,
  toText,
  truthy,
} from "./expr";

/* ---------------- 行 ---------------- */

export interface Row {
  /** 相对路径：一行的身份 */
  key: string;
  doc: BaseDoc;
  /** 属性块认成的一条条（改一格时用） */
  parsed: Parsed;
  source: FileSource;
}

/** 认值的类型要看的：types.json 记着的、整个仓库里这个键多半是什么 */
export interface KindHints {
  recorded: Record<string, string | undefined>;
  usual: Map<string, string>;
}

const stem = (name: string) => name.replace(/\.[^.]+$/, "");

/** 一条属性的值 */
export function entryValue(entry: Entry, kind: Kind | "complex"): Value {
  if (kind === "complex" || entry.shape === "complex") return null;
  const scalar = (text: string, as: Kind): Value => {
    if (text === "") return null;
    const wiki = /^\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]*))?\]\]$/.exec(text);
    if (wiki) return new BLink(wiki[1]!.trim(), wiki[2]?.trim() || null);
    switch (as) {
      case "checkbox":
        return text === "true" ? true : text === "false" ? false : text;
      case "number": {
        const n = Number(text);
        return /^-?\d+(\.\d+)?$/.test(text) && Number.isFinite(n) ? n : text;
      }
      case "date":
      case "datetime":
        return parseDate(text) ?? text;
      default:
        return text;
    }
  };
  if (isListKind(kind) || entry.shape === "list") {
    const items = entry.shape === "list" ? entry.items : entry.value ? [entry.value] : [];
    // 列表里的每一项：标签、别名就是字，别的照值像什么
    return items.map((item) => scalar(item, isListKind(kind) ? "text" : itemKind(item)));
  }
  return scalar(entry.value, kind);
}

function itemKind(text: string): Kind {
  if (text === "true" || text === "false") return "checkbox";
  if (/^-?\d+(\.\d+)?$/.test(text)) return "number";
  if (parseDate(text)) return "date";
  return "text";
}

/** 这一条是什么类型（同属性面板：记着的 → 专用的键 → 值像什么 → 仓库里多半的） */
export function kindOfEntry(entry: Entry, hints: KindHints): Kind | "complex" {
  if (entry.shape === "complex") return "complex";
  return kindOf(entry, hints.recorded, hints.usual.get(entry.key));
}

const parseCache = new Map<string, { parsed: Parsed; props: Map<string, Value> }>();
/**
 * 值的类型只看记着的类型（types.json）和值本身：「仓库里多半的」只管空着的值，空的值是 null，
 * 和类型无关。所以缓存只在记着的类型变了时清 —— 一览晚一拍取回来（新的对象、同样的内容）不用全部重认
 */
let cacheTypes = "";

/** 同一份属性原文（加上同一份记着的类型）只认一次 */
function parsedProps(text: string, hints: KindHints, types: string) {
  if (cacheTypes !== types) {
    parseCache.clear();
    cacheTypes = types;
  }
  let hit = parseCache.get(text);
  if (!hit) {
    const parsed = parse(text);
    const props = new Map<string, Value>();
    for (const entry of parsed.entries) {
      if (props.has(entry.key)) continue;
      const kind = entry.shape === "complex" ? "complex" : kindOf(entry, hints.recorded);
      props.set(entry.key, entryValue(entry, kind));
    }
    hit = { parsed, props };
    // 不让它无限长：几千篇的仓库也就几千份
    if (parseCache.size > 20_000) parseCache.clear();
    parseCache.set(text, hit);
  }
  return hit;
}

/** 文件名、所在文件夹（同 Obsidian：仓库根是 `/`） */
function pathParts(relPath: string) {
  const slash = relPath.lastIndexOf("/");
  const name = relPath.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return {
    name,
    basename: dot > 0 ? name.slice(0, dot) : name,
    ext: dot > 0 ? name.slice(dot + 1) : "",
    folder: slash > 0 ? relPath.slice(0, slash) : "/",
  };
}

/**
 * 每一篇一行。live：笔记列表里最新的标题、修改时间（编辑器存了以后不用为这个重取，§3.3）
 */
export function buildRows(
  docs: BaseDoc[],
  hints: KindHints,
  live: Map<string, { title: string; updatedAt: number }>,
): Row[] {
  const types = JSON.stringify(hints.recorded);
  const next = new Map<string, { sign: string; row: Row }>();
  const rows = docs.map((doc) => {
    const fresh = doc.target.type === "note" ? live.get(doc.target.key) : undefined;
    const title = fresh?.title ?? doc.title;
    const mtime = fresh?.updatedAt ?? doc.updatedAt;
    // 和上一次一样的那一篇用上一次的那一行（同一个对象）：表格的行是 memo 的，重取一遍数据只重画变了的
    const sign = `${types}\u0000${doc.props}\u0000${title}\u0000${mtime}\u0000${doc.size}\u0000${doc.tags.join("\n")}\u0000${doc.links?.join("\n") ?? "\u0001"}\u0000${doc.notUtf8}`;
    const known = lastRows.get(doc.relPath);
    if (known?.sign === sign) {
      next.set(doc.relPath, known);
      return known.row;
    }
    const { parsed, props } = parsedProps(doc.props, hints, types);
    const parts = pathParts(doc.relPath);
    const row: Row = {
      key: doc.relPath,
      doc,
      parsed,
      source: {
        path: doc.relPath,
        ...parts,
        size: doc.size,
        ctime: doc.createdAt,
        mtime,
        tags: doc.tags,
        links: doc.links,
        props,
        title: title || stem(parts.name),
      },
    };
    next.set(doc.relPath, { sign, row });
    return row;
  });
  lastRows = next;
  return rows;
}

/** 上一次建的那些行（按相对路径） */
let lastRows = new Map<string, { sign: string; row: Row }>();

/** 视图文件自己（`this`） */
export function baseSource(relPath: string): FileSource {
  const parts = pathParts(relPath);
  return {
    path: relPath,
    ...parts,
    size: 0,
    ctime: 0,
    mtime: 0,
    tags: [],
    links: [],
    props: new Map(),
    title: stem(parts.name),
  };
}

/* ---------------- 属性（列） ---------------- */

export interface PropRef {
  ns: "note" | "file" | "formula";
  name: string;
  /** 带前缀的写法：`note.status`、`file.name`、`formula.x` */
  id: string;
}

const refs = new Map<string, PropRef>();

/** `status`、`note.status`、`note["带 空格"]`、`file.name`、`formula.x` → 哪个属性（每一格都要问，记住答案） */
export function propRef(raw: string): PropRef {
  let ref = refs.get(raw);
  if (!ref) {
    ref = readRef(raw);
    if (refs.size > 5000) refs.clear();
    refs.set(raw, ref);
  }
  return ref;
}

function readRef(raw: string): PropRef {
  const text = raw.trim();
  const bracket = /^(note|file|formula)\[\s*(["'])(.*)\2\s*\]$/.exec(text);
  if (bracket) {
    const ns = bracket[1] as PropRef["ns"];
    return { ns, name: bracket[3]!, id: `${ns}.${bracket[3]}` };
  }
  const dot = text.indexOf(".");
  const head = dot > 0 ? text.slice(0, dot) : "";
  if (head === "note" || head === "file" || head === "formula") {
    const name = text.slice(dot + 1);
    return { ns: head, name, id: `${head}.${name}` };
  }
  return { ns: "note", name: text, id: `note.${text}` };
}

const FILE_LABELS: Record<string, string> = {
  name: "名称",
  basename: "文件名",
  path: "路径",
  folder: "文件夹",
  ext: "扩展名",
  size: "大小",
  ctime: "创建时间",
  mtime: "修改时间",
  tags: "标签",
  links: "链接",
};

/** 文件的几项：筛选、列的候选 */
export const FILE_PROPS = [
  "file.name",
  "file.folder",
  "file.path",
  "file.mtime",
  "file.ctime",
  "file.tags",
  "file.links",
  "file.size",
  "file.ext",
];

/** 列头写什么：properties 的 displayName（带前缀的键；不带的也认），文件的给中文名 */
export function propLabel(config: BaseConfig, raw: string): string {
  const ref = propRef(raw);
  const named = config.displayNames[ref.id] ?? config.displayNames[raw];
  if (named) return named;
  if (ref.ns === "file") return FILE_LABELS[ref.name] ?? raw;
  return ref.name;
}

/* ---------------- 编译 ---------------- */

/** 一条筛选编译好：叶子是语法树，写错了的叶子是错 */
type Compiled =
  | { leaf: Node; source: string }
  | { bad: string; source: string }
  | { op: "and" | "or" | "not"; items: Compiled[] };

function compileFilter(node: FilterNode): Compiled {
  if ("expr" in node) {
    try {
      return { leaf: parseExpr(node.expr), source: node.expr };
    } catch (error) {
      return { bad: messageOf(error), source: node.expr };
    }
  }
  return { op: node.op, items: node.items.map(compileFilter) };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 一个视图要的东西都编译好 */
export interface CompiledView {
  filters: Compiled[];
  formulas: Map<string, Node | { bad: string }>;
  /** 要不要取正文（file.tags、hasTag、file.links、hasLink 用到了） */
  needsBody: boolean;
}

const BODY_NAMES = ["tags", "links", "hasTag", "hasLink"];

function leaves(node: Compiled, out: Node[] = []): Node[] {
  if ("leaf" in node) out.push(node.leaf);
  else if ("op" in node) for (const item of node.items) leaves(item, out);
  return out;
}

export function compileView(config: BaseConfig, view: ViewConfig): CompiledView {
  const filters = [config.filters, view.filters]
    .filter((node): node is FilterNode => node !== null)
    .map(compileFilter);
  const formulas = new Map<string, Node | { bad: string }>();
  for (const [name, source] of Object.entries(config.formulas)) {
    try {
      formulas.set(name, parseExpr(source));
    } catch (error) {
      formulas.set(name, { bad: messageOf(error) });
    }
  }
  const names = new Set<string>();
  for (const node of filters.flatMap((filter) => leaves(filter))) namesIn(node, names);
  for (const formula of formulas.values()) if (!("bad" in formula)) namesIn(formula, names);
  const used = [
    ...(view.order ?? []),
    ...view.sort.map((spec) => spec.property),
    ...(view.groupBy ? [view.groupBy.property] : []),
  ].map(propRef);
  const needsBody =
    BODY_NAMES.some((name) => names.has(name)) ||
    used.some((ref) => ref.ns === "file" && (ref.name === "tags" || ref.name === "links"));
  return { filters, formulas, needsBody };
}

/* ---------------- 求值 ---------------- */

export interface Cell {
  value: Value;
  /** 算不了：为什么（「Odea 还算不了 file.backlinks」「公式写错了」） */
  error: string | null;
}

export interface Group {
  /** 组的键（同一个值的字）；null 是没写这个属性的那一组 */
  key: string | null;
  /** 组头上画的值（第一行的值，空组是 null） */
  value: Value;
  rows: Row[];
}

export interface ViewResult {
  rows: Row[];
  /** 筛完一共几篇（limit 之前） */
  total: number;
  groups: Group[] | null;
  /** 筛选里算不了的那几条（没算，结果里没因为它少东西） */
  problems: string[];
  cell: (row: Row, raw: string) => Cell;
}

const unsupportedText = (error: unknown) =>
  error instanceof Unsupported ? `Odea 还算不了 ${error.message}` : `算不了：${messageOf(error)}`;

/**
 * 跑一个视图。now：现在（`now()`、`today()`），测试里给定
 */
export function runView(
  compiled: CompiledView,
  view: ViewConfig,
  rows: Row[],
  self: FileSource,
  now: number,
): ViewResult {
  const problems = new Set<string>();
  const formulaCache = new Map<Row, Map<string, Cell>>();

  const scopeOf = (row: Row | null): Scope => ({
    file: row?.source ?? null,
    self,
    now,
    formula: (name) => {
      if (!row) return null;
      const cell = formulaCell(row, name);
      if (cell.error) throw new Unsupported(`formula.${name}`);
      return cell.value;
    },
  });

  const formulaCell = (row: Row, name: string): Cell => {
    let cache = formulaCache.get(row);
    if (!cache) {
      cache = new Map();
      formulaCache.set(row, cache);
    }
    const known = cache.get(name);
    if (known) return known;
    const node = compiled.formulas.get(name);
    if (!node) return { value: null, error: `没有叫「${name}」的公式` };
    if ("bad" in node) return { value: null, error: `公式写错了：${node.bad}` };
    // 先占个位：公式绕回自己时读到这一格就是「循环了」
    cache.set(name, { value: null, error: "公式绕回了自己" });
    let cell: Cell;
    try {
      cell = { value: evaluate(node, scopeOf(row)), error: null };
    } catch (error) {
      cell = { value: null, error: unsupportedText(error) };
    }
    cache.set(name, cell);
    return cell;
  };

  const fileNodes = new Map<string, Node>();
  const cell = (row: Row, raw: string): Cell => {
    const ref = propRef(raw);
    if (ref.ns === "note") return { value: row.source.props.get(ref.name) ?? null, error: null };
    if (ref.ns === "formula") return formulaCell(row, ref.name);
    let node = fileNodes.get(ref.name);
    if (!node) {
      node = { k: "member", obj: { k: "id", name: "file" }, name: ref.name };
      fileNodes.set(ref.name, node);
    }
    try {
      return { value: evaluate(node, scopeOf(row)), error: null };
    } catch (error) {
      return { value: null, error: unsupportedText(error) };
    }
  };

  // 筛选：算不了的那一条当它是「是」（不因为它少东西），记下来在顶上说
  const test = (node: Compiled, row: Row): boolean => {
    if ("bad" in node) {
      problems.add(`「${node.source}」写错了：${node.bad}`);
      return true;
    }
    if ("leaf" in node) {
      try {
        return truthy(evaluate(node.leaf, scopeOf(row)));
      } catch (error) {
        problems.add(`「${node.source}」${unsupportedText(error)}`);
        return true;
      }
    }
    if (node.op === "and") return node.items.every((item) => test(item, row));
    if (node.op === "or")
      return node.items.length === 0 || node.items.some((item) => test(item, row));
    return !node.items.some((item) => test(item, row));
  };
  const matched = rows.filter((row) => compiled.filters.every((filter) => test(filter, row)));

  // 排序：没写就按名称；空的永远在最后（方向不翻它）
  const specs =
    view.sort.length > 0 ? view.sort : [{ property: "file.name", direction: "ASC" as const }];
  const keys = new Map<Row, Value[]>();
  for (const row of matched)
    keys.set(
      row,
      specs.map((spec) => cell(row, spec.property).value),
    );
  const empty = (value: Value) =>
    value === null || value === "" || (Array.isArray(value) && value.length === 0);
  const sorted = [...matched].sort((a, b) => {
    const left = keys.get(a)!;
    const right = keys.get(b)!;
    for (let i = 0; i < specs.length; i += 1) {
      const x = left[i]!;
      const y = right[i]!;
      let order = sortCompare(x, y);
      if (order !== 0 && specs[i]!.direction === "DESC" && !empty(x) && !empty(y)) order = -order;
      if (order !== 0) return order;
    }
    return sortCompare(a.source.name, b.source.name);
  });
  const limited = view.limit ? sorted.slice(0, view.limit) : sorted;

  return {
    rows: limited,
    total: matched.length,
    groups: view.groupBy ? group(limited, view, cell) : null,
    problems: [...problems],
    cell,
  };
}

/** 分组用的字：笔记的属性用文件里写的字（`2` 和 `"2"` 一组，日期就是 2026-11-20），别的用值的字 */
export function groupKeyOf(
  row: Row,
  raw: string,
  cell: (row: Row, raw: string) => Cell,
): string | null {
  const ref = propRef(raw);
  if (ref.ns === "note") {
    const entry = row.parsed.entries.find((item) => item.key === ref.name);
    if (!entry || entry.shape === "complex") return null;
    const one = singleValue(entry);
    const text = one ?? entry.items.join(", ");
    return text === "" ? null : text;
  }
  const value = cell(row, raw).value;
  if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) return null;
  return toText(value);
}

function group(rows: Row[], view: ViewConfig, cell: (row: Row, raw: string) => Cell): Group[] {
  const by = view.groupBy!;
  const map = new Map<string | null, Group>();
  for (const row of rows) {
    const key = groupKeyOf(row, by.property, cell);
    let found = map.get(key);
    if (!found) {
      found = { key, value: cell(row, by.property).value, rows: [] };
      map.set(key, found);
    }
    found.rows.push(row);
  }
  if (view.groupOrder) {
    // 照 Obsidian：只显示写了的那几组、按写的顺序；写了但没有篇的组是空的一组（看板上的空列）
    return view.groupOrder.map(
      (key) => map.get(key) ?? { key, value: key === null ? null : key, rows: [] },
    );
  }
  const groups = [...map.values()];
  groups.sort((a, b) => {
    if (a.key === null || b.key === null) return a.key === b.key ? 0 : a.key === null ? 1 : -1;
    const order = sortCompare(a.value, b.value) || sortCompare(a.key, b.key);
    return by.direction === "DESC" ? -order : order;
  });
  return groups;
}

/** 表格没写 order 时显示哪几列：名称，再加上这些篇里用得最多的几个属性 */
export function defaultOrder(rows: Row[], max = 5): string[] {
  // Map 记着第一次见到的顺序：一样多的照笔记里写的先后
  const counts = new Map<string, number>();
  for (const row of rows.slice(0, 2000)) {
    for (const key of row.source.props.keys()) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([key]) => key);
  return ["file.name", ...top];
}
