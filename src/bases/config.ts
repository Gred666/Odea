/* ============================================================
   `.base` 文件读成配置、改了写回（docs/视图文件.md §3.2）。

   读：`yaml` 的 Document（不是 toJS 完就扔）：写回时只在 Document 上换掉改了的那一个键，
   没碰的键、注释、键的顺序、引号都留着；认不得的键（summaries、columnSize、map 视图的经纬度、插件加的）原样在。
   写的样子跟着 Obsidian：sort 一条条 property / direction（大写）；表达式能不加引号就不加，有双引号的用单引号括
   ============================================================ */

import { type Document, Scalar, YAMLMap, YAMLSeq, isMap, isSeq, parseDocument } from "yaml";

/** 筛选：一条表达式，或者 and / or / not 套着的一组 */
export type FilterNode = { expr: string } | { op: "and" | "or" | "not"; items: FilterNode[] };

export type Direction = "ASC" | "DESC";

export interface SortSpec {
  property: string;
  direction: Direction;
}

export interface ViewConfig {
  type: string;
  name: string;
  filters: FilterNode | null;
  /** 显示哪几列 / 卡片上哪几项；没写是 null（表格默认几列，见 query.ts） */
  order: string[] | null;
  sort: SortSpec[];
  groupBy: { property: string; direction: Direction } | null;
  /** 只显示这几组、按这个顺序（null 是没写这个属性的那一组）；没写是 null（全显示） */
  groupOrder: (string | null)[] | null;
  limit: number | null;
  /** 卡片的封面是哪个属性 */
  image: string | null;
  /** 表格的列宽（Obsidian 写的） */
  columnSize: Record<string, number>;
}

export interface BaseConfig {
  filters: FilterNode | null;
  formulas: Record<string, string>;
  /** properties 里的 displayName：键照文件里写的（`note.status`、`formula.x`、`file.ext`） */
  displayNames: Record<string, string>;
  views: ViewConfig[];
}

export interface BaseFile {
  config: BaseConfig;
  /** 读不出来（YAML 写坏了、views 不是列表）：为什么。这时 config 是空的，界面给「源码」 */
  error: string | null;
}

export const EMPTY_CONFIG: BaseConfig = {
  filters: null,
  formulas: {},
  displayNames: {},
  views: [],
};

const parse = (text: string): Document =>
  parseDocument(text, { prettyErrors: true, uniqueKeys: false });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 组的值、groupOrder 里的一项：都当字（`2` 和 `"2"` 一组），null 是「没有」 */
export function groupText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function readFilter(raw: unknown): FilterNode | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return { expr: raw };
  if (typeof raw === "number" || typeof raw === "boolean") return { expr: String(raw) };
  if (isRecord(raw)) {
    const keys = Object.keys(raw);
    const op = keys[0];
    if (keys.length === 1 && (op === "and" || op === "or" || op === "not")) {
      const list = raw[op];
      const items = (Array.isArray(list) ? list : list === null || list === undefined ? [] : [list])
        .map(readFilter)
        .filter((item): item is FilterNode => item !== null);
      return { op, items };
    }
  }
  throw new Error("筛选要么是一行表达式，要么是 and / or / not 下面一组");
}

const direction = (raw: unknown): Direction | null =>
  raw === "ASC" || raw === "DESC" ? raw : raw === undefined || raw === null ? "ASC" : null;

function readView(raw: unknown, index: number): ViewConfig {
  const view = isRecord(raw) ? raw : {};
  const sort: SortSpec[] = [];
  // 照 Obsidian：direction 不是大写的 ASC / DESC、写成字符串的那一条不算
  for (const item of Array.isArray(view.sort) ? view.sort : []) {
    if (!isRecord(item) || typeof item.property !== "string") continue;
    const dir = item.direction === "ASC" || item.direction === "DESC" ? item.direction : null;
    if (dir) sort.push({ property: item.property, direction: dir });
  }
  const group = isRecord(view.groupBy) ? view.groupBy : null;
  const groupDirection = group ? direction(group.direction) : null;
  const columnSize: Record<string, number> = {};
  if (isRecord(view.columnSize)) {
    for (const [key, value] of Object.entries(view.columnSize)) {
      if (typeof value === "number" && value > 0) columnSize[key] = value;
    }
  }
  return {
    type: typeof view.type === "string" ? view.type : "table",
    name: typeof view.name === "string" && view.name.trim() ? view.name : `视图 ${index + 1}`,
    filters: readFilter(view.filters),
    order: Array.isArray(view.order)
      ? view.order.filter((item): item is string => typeof item === "string")
      : null,
    sort,
    groupBy:
      group && typeof group.property === "string" && groupDirection
        ? { property: group.property, direction: groupDirection }
        : null,
    groupOrder: Array.isArray(view.groupOrder) ? view.groupOrder.map(groupText) : null,
    limit: typeof view.limit === "number" && view.limit > 0 ? Math.floor(view.limit) : null,
    image: typeof view.image === "string" ? view.image : null,
    columnSize,
  };
}

/** 读一个 `.base` 文件。空文件是一个没有视图的视图文件（界面上给一个默认的表格） */
export function readBase(text: string): BaseFile {
  const doc = parse(text);
  const fail = (error: string): BaseFile => ({ config: EMPTY_CONFIG, error });
  if (doc.errors.length > 0) {
    const first = doc.errors[0]!;
    const line = first.linePos?.[0]?.line;
    return fail(`YAML 写坏了${line ? `（第 ${line} 行）` : ""}：${first.message.split("\n")[0]}`);
  }
  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: 50 });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (raw === null || raw === undefined) raw = {};
  if (!isRecord(raw)) return fail("最外层要是「键: 值」的样子");
  if (raw.views !== undefined && raw.views !== null && !Array.isArray(raw.views)) {
    return fail("views 要是一个列表（每一项是一个视图）");
  }
  try {
    const formulas: Record<string, string> = {};
    if (isRecord(raw.formulas)) {
      for (const [name, value] of Object.entries(raw.formulas)) {
        if (value !== null && value !== undefined) formulas[name] = String(value);
      }
    }
    const displayNames: Record<string, string> = {};
    if (isRecord(raw.properties)) {
      for (const [key, value] of Object.entries(raw.properties)) {
        if (isRecord(value) && typeof value.displayName === "string" && value.displayName) {
          displayNames[key] = value.displayName;
        }
      }
    }
    const views = Array.isArray(raw.views) ? raw.views.map(readView) : [];
    return {
      config: { filters: readFilter(raw.filters), formulas, displayNames, views },
      error: null,
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/* ---------------- 写回 ---------------- */

function filterNode(node: FilterNode): Scalar | YAMLMap {
  // 表达式能不加引号就不加，有双引号的 yaml 自己用单引号括（Obsidian 两种都认）
  if ("expr" in node) return new Scalar(node.expr);
  const seq = new YAMLSeq();
  for (const item of node.items) seq.add(filterNode(item));
  const map = new YAMLMap();
  map.set(node.op, seq);
  return map;
}

/**
 * 写回的样子：不折行（表达式一行写完）；一行的列表不在括号里面加空格（`[a, b]`，Obsidian 和手写的都这样，
 * yaml 默认加成 `[ a, b ]`，没碰的键也会被改掉）；列表项缩进两格（Obsidian 写的样子）
 */
const STRINGIFY = { lineWidth: 0, indentSeq: true, flowCollectionPadding: false } as const;

/** 一处改动：在 Document 上改，没碰的都留着 */
export type BaseEdit = (doc: Document) => void;

/** 在全文上做一处改动，给出新的全文。原文读不出来就抛（不往坏文件上改） */
export function editBase(text: string, edit: BaseEdit): string {
  const doc = parse(text);
  if (doc.errors.length > 0) throw new Error("视图文件写坏了，先在源码里改好");
  if (doc.contents === null) doc.contents = new YAMLMap() as Document["contents"];
  if (!isMap(doc.contents)) throw new Error("最外层要是「键: 值」的样子");
  edit(doc);
  return doc.toString(STRINGIFY);
}

/** views 列表（没有就建一个） */
function viewsOf(doc: Document) {
  let views = doc.get("views", true);
  if (!isSeq(views)) {
    views = doc.createNode([]);
    doc.set("views", views);
  }
  return views as { items: unknown[]; add(value: unknown): void; delete(index: number): boolean };
}

/** 第 index 个视图的一个键：value 是 undefined 时删掉这个键 */
export const setViewKey =
  (index: number, key: string, value: unknown): BaseEdit =>
  (doc) => {
    if (value === undefined) {
      doc.deleteIn(["views", index, key]);
      return;
    }
    doc.setIn(["views", index, key], doc.createNode(value));
  };

/** 排序：一条条 property / direction；空了删掉这个键 */
export const setSort = (index: number, sort: SortSpec[]): BaseEdit =>
  setViewKey(
    index,
    "sort",
    sort.length > 0 ? sort.map(({ property, direction }) => ({ property, direction })) : undefined,
  );

/** 筛选：scope 是 null 改整个文件的，是数字改那个视图的。空的组删掉这个键 */
export const setFilters =
  (scope: number | null, node: FilterNode | null): BaseEdit =>
  (doc) => {
    const path = scope === null ? ["filters"] : ["views", scope, "filters"];
    const empty = !node || ("items" in node && node.items.length === 0);
    if (empty) {
      doc.deleteIn(path);
      return;
    }
    doc.setIn(path, filterNode(node));
  };

/** 加一个视图（放在最后） */
export const addView =
  (view: Record<string, unknown>): BaseEdit =>
  (doc) => {
    viewsOf(doc).add(doc.createNode(view));
  };

export const removeView =
  (index: number): BaseEdit =>
  (doc) => {
    viewsOf(doc).delete(index);
  };

/** 复制一个视图，放在它后面 */
export const duplicateView =
  (index: number, name: string): BaseEdit =>
  (doc) => {
    const views = viewsOf(doc);
    const source = views.items[index] as { clone?: () => unknown } | undefined;
    if (!source?.clone) return;
    const copy = source.clone() as { set?: (key: string, value: unknown) => void };
    copy.set?.("name", name);
    views.items.splice(index + 1, 0, copy);
  };

/** 新建的视图文件（§3.2）：在某个文件夹里建的，筛选默认是「在这个文件夹里」 */
export function newBaseText(folderPath: string | null): string {
  const doc = parse("");
  doc.contents = new YAMLMap() as Document["contents"];
  if (folderPath) {
    setFilters(null, {
      op: "and",
      items: [{ expr: `file.inFolder(${JSON.stringify(folderPath)})` }],
    })(doc);
  }
  addView({ type: "table", name: "表格", order: ["file.name", "file.mtime"] })(doc);
  return doc.toString(STRINGIFY);
}
