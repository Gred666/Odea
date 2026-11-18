/* ============================================================
   筛选面板里一行一个条件（docs/视图文件.md §3.6）：「属性 ⌄ 怎么比 ⌄ 值」。
   表达式长成这几种简单的样子才拆成三格，别的（嵌套的组、函数）原样当一行表达式给人改
   ============================================================ */

import { type Node, parseExpr } from "./expr";
import { propRef } from "./query";

export type SimpleOp =
  | "=="
  | "!="
  | ">"
  | "<"
  | ">="
  | "<="
  | "contains"
  | "!contains"
  | "empty"
  | "!empty"
  | "hasTag"
  | "inFolder";

export interface Simple {
  /** 属性：`status`、`note.status`、`file.folder`…… */
  prop: string;
  op: SimpleOp;
  value: string;
}

export const OP_LABELS: Record<SimpleOp, string> = {
  "==": "等于",
  "!=": "不等于",
  ">": "大于",
  "<": "小于",
  ">=": "大于等于",
  "<=": "小于等于",
  contains: "包含",
  "!contains": "不包含",
  empty: "为空",
  "!empty": "不为空",
  hasTag: "有标签",
  inFolder: "在文件夹里",
};

/** 这个属性能怎么比 */
export function opsFor(prop: string): SimpleOp[] {
  if (prop === "file.tags") return ["hasTag", "contains", "!contains", "empty", "!empty"];
  if (prop === "file.folder") return ["inFolder", "==", "!="];
  return ["==", "!=", "contains", "!contains", ">", "<", ">=", "<=", "empty", "!empty"];
}

export const needsValue = (op: SimpleOp) => op !== "empty" && op !== "!empty";

const RESERVED = new Set(["file", "note", "formula", "this", "true", "false", "null", "undefined"]);
const IDENT = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

/** 属性写成表达式里的样子：能直接写名字的写名字，带空格、横线的写 `note["…"]` */
export function propExpr(raw: string): string {
  const ref = propRef(raw);
  if (ref.ns === "note")
    return IDENT.test(ref.name) && !RESERVED.has(ref.name)
      ? ref.name
      : `note[${JSON.stringify(ref.name)}]`;
  return IDENT.test(ref.name) ? `${ref.ns}.${ref.name}` : `${ref.ns}[${JSON.stringify(ref.name)}]`;
}

/** 值写成字面量：数字、true / false、日期（`date("2026-11-20")`）照它的样子，别的加引号 */
function literal(value: string, kind: string | undefined): string {
  const trimmed = value.trim();
  if ((kind === "number" || kind === undefined) && /^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  if (trimmed === "true" || trimmed === "false") return trimmed;
  if ((kind === "date" || kind === "datetime") && /^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return `date(${JSON.stringify(trimmed)})`;
  }
  return JSON.stringify(value);
}

/** 一个条件写成表达式。kind：这个属性多半是什么类型（数字不加引号、日期包 date()） */
export function buildExpr(simple: Simple, kind?: string): string {
  const p = propExpr(simple.prop);
  const text = JSON.stringify(simple.value);
  switch (simple.op) {
    case "contains":
      return `${p}.contains(${text})`;
    case "!contains":
      return `!${p}.contains(${text})`;
    case "empty":
      return `${p}.isEmpty()`;
    case "!empty":
      return `!${p}.isEmpty()`;
    case "hasTag":
      return `file.hasTag(${JSON.stringify(simple.value.replace(/^#/, ""))})`;
    case "inFolder":
      return `file.inFolder(${text})`;
    default:
      return `${p} ${simple.op} ${literal(simple.value, kind)}`;
  }
}

/** 一个节点是不是在说某个属性：`status`、`note.status`、`note["x"]`、`file.name`、`formula.x` */
function propOf(node: Node): string | null {
  if (node.k === "id") return RESERVED.has(node.name) ? null : node.name;
  if (
    node.k === "member" &&
    node.obj.k === "id" &&
    ["note", "file", "formula"].includes(node.obj.name)
  ) {
    return node.obj.name === "note" ? node.name : `${node.obj.name}.${node.name}`;
  }
  if (
    node.k === "index" &&
    node.obj.k === "id" &&
    node.obj.name === "note" &&
    node.index.k === "lit"
  ) {
    return typeof node.index.v === "string" ? node.index.v : null;
  }
  return null;
}

function literalOf(node: Node): string | null {
  if (node.k === "lit") {
    const v = node.v;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
    return null;
  }
  // date("2026-11-20")
  if (
    node.k === "call" &&
    node.callee.k === "id" &&
    node.callee.name === "date" &&
    node.args.length === 1
  ) {
    return literalOf(node.args[0]!);
  }
  return null;
}

/** 表达式是不是简单的那几种样子：是的话拆成三格 */
export function toSimple(expr: string): Simple | null {
  let node: Node;
  try {
    node = parseExpr(expr);
  } catch {
    return null;
  }
  let negate = false;
  if (node.k === "unary" && node.op === "!") {
    negate = true;
    node = node.arg;
  }
  if (!negate && node.k === "binary" && ["==", "!=", ">", "<", ">=", "<="].includes(node.op)) {
    const prop = propOf(node.left);
    const value = literalOf(node.right);
    if (prop !== null && value !== null) return { prop, op: node.op as SimpleOp, value };
    return null;
  }
  if (node.k !== "call" || node.callee.k !== "member") return null;
  const method = node.callee.name;
  const target = node.callee.obj;
  if (target.k === "id" && target.name === "file" && !negate && node.args.length === 1) {
    const value = literalOf(node.args[0]!);
    if (value === null) return null;
    if (method === "hasTag") return { prop: "file.tags", op: "hasTag", value };
    if (method === "inFolder") return { prop: "file.folder", op: "inFolder", value };
    return null;
  }
  const prop = propOf(target);
  if (prop === null) return null;
  if (method === "contains" && node.args.length === 1) {
    const value = literalOf(node.args[0]!);
    return value === null ? null : { prop, op: negate ? "!contains" : "contains", value };
  }
  if (method === "isEmpty" && node.args.length === 0)
    return { prop, op: negate ? "!empty" : "empty", value: "" };
  return null;
}
