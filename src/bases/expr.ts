/* ============================================================
   视图文件的表达式（docs/视图文件.md §3.4）：Obsidian Bases 的筛选和公式是同一种表达式，照 JavaScript 的行为。

       status != "完成" && priority > 1
       file.inFolder("项目") || file.hasTag("book")
       (date(截止) - today()).days
       if(done, "✅", "⏳")

   词法 → 语法树 → 求值。值有 null、布尔、数字、字符串、日期、时长、列表、双链、文件、对象、正则。
   认不得的函数抛 Unsupported（界面上说「Odea 还算不了 xxx」），写错了抛 ExprError
   ============================================================ */

import { formatRelativeTime } from "@/lib/date";

/* ---------------- 值 ---------------- */

/** 一个时刻。dateOnly：只写了日期（`2026-11-20`），显示时不带时间 */
export class BDate {
  constructor(
    readonly ms: number,
    readonly dateOnly = false,
  ) {}
}

/** 一段时长（两个日期相减、`duration("1d")`） */
export class BDuration {
  constructor(readonly ms: number) {}
}

/** 双链：`[[标题]]`、`link("标题")` */
export class BLink {
  constructor(
    readonly target: string,
    readonly display: string | null = null,
  ) {}
}

/** 一个文件（视图里的一行、`this` 的那个视图文件）：属性从 FileSource 来 */
export class BFile {
  constructor(readonly source: FileSource) {}
}

export class BObject {
  constructor(readonly entries: Map<string, Value>) {}
}

export type Value =
  | null
  | boolean
  | number
  | string
  | BDate
  | BDuration
  | BLink
  | BFile
  | BObject
  | RegExp
  | Value[];

/** 求值时要知道的一个文件：视图的一行，或者视图文件自己 */
export interface FileSource {
  /** 仓库里的相对路径 */
  path: string;
  /** 文件名（带扩展名） */
  name: string;
  /** 文件名（不带扩展名） */
  basename: string;
  ext: string;
  /** 所在的文件夹，仓库根是 `/`（同 Obsidian） */
  folder: string;
  size: number;
  ctime: number;
  mtime: number;
  /** 小写、不带 # */
  tags: string[];
  /** 双链目标（标题）；没取正文时是 null */
  links: string[] | null;
  /** 属性块里的属性 */
  props: Map<string, Value>;
  /** 给人看的标题（笔记的标题） */
  title: string;
}

/* ---------------- 错误 ---------------- */

export class ExprError extends Error {}

/** 语法没错，但用到了 Odea 还不会算的东西 */
export class Unsupported extends ExprError {}

/* ---------------- 词法 ---------------- */

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "re"; v: RegExp }
  | { t: "end" };

const OPS = [
  "===",
  "!==",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "<",
  ">",
  "!",
  "+",
  "-",
  "*",
  "/",
  "%",
  "(",
  ")",
  "[",
  "]",
  ",",
  ".",
];
const ID_START = /[\p{L}\p{Nl}_$]/u;
const ID_PART = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}_$]/u;

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const last = () => tokens[tokens.length - 1];
  // `/` 是除号还是正则的开头：前面是值（数字、字符串、名字、右括号）就是除号
  const afterValue = () => {
    const prev = last();
    return !!prev && (prev.t !== "op" || prev.v === ")" || prev.v === "]");
  };
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      const match = /^(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?/.exec(source.slice(i))!;
      tokens.push({ t: "num", v: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let value = "";
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        if (source[j] === "\\" && j + 1 < source.length) {
          const next = source[j + 1]!;
          value += next === "n" ? "\n" : next === "t" ? "\t" : next;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new ExprError("引号没有收尾");
      tokens.push({ t: "str", v: value });
      i = j + 1;
      continue;
    }
    if (c === "/" && !afterValue()) {
      const match = /^\/((?:\\.|\[(?:\\.|[^\]])*\]|[^/\\\n])+)\/([a-z]*)/.exec(source.slice(i));
      if (match) {
        try {
          tokens.push({ t: "re", v: new RegExp(match[1]!, match[2]) });
        } catch {
          throw new ExprError("正则表达式写错了");
        }
        i += match[0].length;
        continue;
      }
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < source.length && ID_PART.test(source[j]!)) j += 1;
      tokens.push({ t: "id", v: source.slice(i, j) });
      i = j;
      continue;
    }
    const op = OPS.find((candidate) => source.startsWith(candidate, i));
    if (!op) throw new ExprError(`认不得「${c}」`);
    tokens.push({ t: "op", v: op === "===" ? "==" : op === "!==" ? "!=" : op });
    i += op.length;
  }
  tokens.push({ t: "end" });
  return tokens;
}

/* ---------------- 语法 ---------------- */

export type Node =
  | { k: "lit"; v: Value }
  | { k: "id"; name: string }
  | { k: "member"; obj: Node; name: string }
  | { k: "index"; obj: Node; index: Node }
  | { k: "call"; callee: Node; args: Node[] }
  | { k: "unary"; op: string; arg: Node }
  | { k: "binary"; op: string; left: Node; right: Node }
  | { k: "list"; items: Node[] };

const PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  ">": 4,
  "<=": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

/** 把一条表达式读成语法树。写错了抛 ExprError */
export function parseExpr(source: string): Node {
  const tokens = lex(source);
  let at = 0;
  const peek = () => tokens[at]!;
  const isOp = (value: string) => {
    const token = peek();
    return token.t === "op" && token.v === value;
  };
  const expect = (value: string) => {
    if (!isOp(value)) throw new ExprError(`这里少了「${value}」`);
    at += 1;
  };

  const primary = (): Node => {
    const token = peek();
    at += 1;
    switch (token.t) {
      case "num":
        return { k: "lit", v: token.v };
      case "str":
        return { k: "lit", v: token.v };
      case "re":
        return { k: "lit", v: token.v };
      case "id":
        if (token.v === "true") return { k: "lit", v: true };
        if (token.v === "false") return { k: "lit", v: false };
        if (token.v === "null" || token.v === "undefined") return { k: "lit", v: null };
        return { k: "id", name: token.v };
      case "op":
        if (token.v === "(") {
          const inner = expression(0);
          expect(")");
          return inner;
        }
        if (token.v === "[") {
          const items: Node[] = [];
          while (!isOp("]")) {
            items.push(expression(0));
            if (!isOp("]")) expect(",");
          }
          at += 1;
          return { k: "list", items };
        }
        throw new ExprError(`「${token.v}」放错了地方`);
      default:
        throw new ExprError("表达式没写完");
    }
  };

  const postfix = (): Node => {
    let node = primary();
    for (;;) {
      if (isOp(".")) {
        at += 1;
        const name = peek();
        if (name.t !== "id") throw new ExprError("「.」后面要跟名字");
        at += 1;
        node = { k: "member", obj: node, name: name.v };
      } else if (isOp("[")) {
        at += 1;
        const index = expression(0);
        expect("]");
        node = { k: "index", obj: node, index };
      } else if (isOp("(")) {
        at += 1;
        const args: Node[] = [];
        while (!isOp(")")) {
          args.push(expression(0));
          if (!isOp(")")) expect(",");
        }
        at += 1;
        node = { k: "call", callee: node, args };
      } else return node;
    }
  };

  const unary = (): Node => {
    if (isOp("!") || isOp("-") || isOp("+")) {
      const op = (peek() as { v: string }).v;
      at += 1;
      return { k: "unary", op, arg: unary() };
    }
    return postfix();
  };

  const expression = (min: number): Node => {
    let left = unary();
    for (;;) {
      const token = peek();
      if (token.t !== "op") break;
      const precedence = PRECEDENCE[token.v];
      if (precedence === undefined || precedence <= min) break;
      at += 1;
      const right = expression(precedence);
      left = { k: "binary", op: token.v, left, right };
    }
    return left;
  };

  const node = expression(0);
  if (peek().t !== "end") throw new ExprError("后面多了东西");
  return node;
}

/** 语法树里用到的成员名（`file.tags` 的 tags、`file.hasLink()` 的 hasLink）：看要不要取正文 */
export function namesIn(node: Node, out = new Set<string>()): Set<string> {
  switch (node.k) {
    case "id":
      break;
    case "member":
      out.add(node.name);
      namesIn(node.obj, out);
      break;
    case "index":
      namesIn(node.obj, out);
      namesIn(node.index, out);
      break;
    case "call":
      namesIn(node.callee, out);
      for (const arg of node.args) namesIn(arg, out);
      break;
    case "unary":
      namesIn(node.arg, out);
      break;
    case "binary":
      namesIn(node.left, out);
      namesIn(node.right, out);
      break;
    case "list":
      for (const item of node.items) namesIn(item, out);
      break;
  }
  return out;
}

/* ---------------- 日期、时长 ---------------- */

const DAY = 86_400_000;

/** `2026-11-20`、`2026-11-20 15:30`、`2026-11-20T15:30:00` → 本地时间；认不出是 null */
export function parseDate(text: string): BDate | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      text.trim(),
    );
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  if (match[8]) {
    const ms = Date.parse(text.trim().replace(" ", "T"));
    return Number.isNaN(ms) ? null : new BDate(ms, false);
  }
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h ?? 0),
    Number(mi ?? 0),
    Number(s ?? 0),
  );
  if (date.getMonth() !== Number(mo) - 1) return null;
  return new BDate(date.getTime(), h === undefined);
}

const UNITS: [RegExp, string][] = [
  [/^(y|yr|yrs|year|years|年)$/, "y"],
  [/^(M|mo|month|months|个月|月)$/, "M"],
  [/^(w|wk|wks|week|weeks|周|星期)$/, "w"],
  [/^(d|day|days|天|日)$/, "d"],
  [/^(h|hr|hrs|hour|hours|小时)$/, "h"],
  [/^(m|min|mins|minute|minutes|分钟|分)$/, "m"],
  [/^(s|sec|secs|second|seconds|秒)$/, "s"],
];

/** `"1 week"` `"7d"` `"-2h"` `"1M"` → [[数, 单位]…]；认不出是 null */
function durationParts(text: string): [number, string][] | null {
  const parts: [number, string][] = [];
  const re = /\s*([-+]?\d+(?:\.\d+)?)\s*([A-Za-z一-鿿]+)\s*/gy;
  let rest = text.trim();
  if (!rest) return null;
  re.lastIndex = 0;
  let match: RegExpExecArray | null = re.exec(rest);
  let used = 0;
  while (match) {
    const raw = match[2]!;
    // 大写 M 是月、小写 m 是分（照 Moment）；整个词的不分大小写
    const word = raw.length === 1 ? raw : raw.toLowerCase();
    const unit = UNITS.find(([pattern]) => pattern.test(word))?.[1];
    if (!unit) return null;
    parts.push([Number(match[1]), unit]);
    used = re.lastIndex;
    match = re.exec(rest);
  }
  rest = rest.slice(used).trim();
  return parts.length > 0 && rest === "" ? parts : null;
}

const UNIT_MS: Record<string, number> = { w: 7 * DAY, d: DAY, h: 3_600_000, m: 60_000, s: 1000 };

/** 日期加一段时长：年、月按日历加（1 月 31 日加一个月是 2 月最后一天，同 Moment） */
function shift(date: BDate, parts: [number, string][], sign: number): BDate {
  let ms = date.ms;
  let dateOnly = date.dateOnly;
  for (const [count, unit] of parts) {
    if (unit === "y" || unit === "M") {
      const d = new Date(ms);
      const months = (unit === "y" ? 12 : 1) * count * sign;
      const day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + months);
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, last));
      ms = d.getTime();
    } else {
      ms += UNIT_MS[unit]! * count * sign;
      if (unit !== "d" && unit !== "w") dateOnly = false;
    }
  }
  return new BDate(ms, dateOnly);
}

function durationOf(value: Value): BDuration | null {
  if (value instanceof BDuration) return value;
  if (typeof value === "number") return new BDuration(value);
  if (typeof value !== "string") return null;
  const parts = durationParts(value);
  if (!parts) return null;
  let ms = 0;
  for (const [count, unit] of parts) {
    ms += count * (unit === "y" ? 365 * DAY : unit === "M" ? 30 * DAY : UNIT_MS[unit]!);
  }
  return new BDuration(ms);
}

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Moment 的格式（常用的那几个记号；`[字]` 原样） */
export function formatDate(date: BDate, pattern: string): string {
  const d = new Date(date.ms);
  const tokens: Record<string, () => string> = {
    YYYY: () => String(d.getFullYear()),
    YY: () => pad(d.getFullYear() % 100),
    MMMM: () => `${d.getMonth() + 1}月`,
    MMM: () => `${d.getMonth() + 1}月`,
    MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    DD: () => pad(d.getDate()),
    Do: () => `${d.getDate()}日`,
    D: () => String(d.getDate()),
    dddd: () => `星期${WEEK[d.getDay()]}`,
    ddd: () => `周${WEEK[d.getDay()]}`,
    d: () => String(d.getDay()),
    HH: () => pad(d.getHours()),
    H: () => String(d.getHours()),
    hh: () => pad(d.getHours() % 12 || 12),
    h: () => String(d.getHours() % 12 || 12),
    mm: () => pad(d.getMinutes()),
    m: () => String(d.getMinutes()),
    ss: () => pad(d.getSeconds()),
    s: () => String(d.getSeconds()),
    A: () => (d.getHours() < 12 ? "上午" : "下午"),
    a: () => (d.getHours() < 12 ? "上午" : "下午"),
  };
  return pattern.replace(
    /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|Do|D|dddd|ddd|d|HH|H|hh|h|mm|m|ss|s|A|a/g,
    (token, literal: string | undefined) =>
      literal !== undefined ? literal : (tokens[token]?.() ?? token),
  );
}

/* ---------------- 转换 ---------------- */

export const isList = (value: Value): value is Value[] => Array.isArray(value);

/** 给人看的字（拼字符串、`toString()`、比较字符串时） */
export function toText(value: Value): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number")
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(10)));
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof BDate)
    return formatDate(value, value.dateOnly ? "YYYY-MM-DD" : "YYYY-MM-DD HH:mm");
  if (value instanceof BDuration) return `${Math.round(value.ms / DAY)} 天`;
  if (value instanceof BLink) return value.display ?? value.target;
  if (value instanceof BFile) return value.source.basename;
  if (value instanceof RegExp) return String(value);
  if (value instanceof BObject) return `{${[...value.entries.keys()].join(", ")}}`;
  return value.map(toText).join(", ");
}

export function truthy(value: Value): boolean {
  if (value === null || value === false || value === 0 || value === "") return false;
  if (typeof value === "number") return !Number.isNaN(value);
  if (isList(value)) return value.length > 0;
  return true;
}

function toNumber(value: Value): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null) return 0;
  if (value instanceof BDate) return value.ms;
  if (value instanceof BDuration) return value.ms;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

/** 当日期读：日期本身、像日期的字符串、毫秒数 */
export function asDate(value: Value): BDate | null {
  if (value instanceof BDate) return value;
  if (typeof value === "string") return parseDate(value);
  if (isList(value) && value.length === 1) return asDate(value[0]!);
  return null;
}

/** 双链、文件、字符串的目标标题（比 hasLink、链接相等时用） */
function linkTitle(value: Value): string | null {
  if (value instanceof BLink) return value.target;
  if (value instanceof BFile) return value.source.basename;
  if (typeof value === "string") {
    const wiki = /^\[\[([^\]|#^]+)/.exec(value);
    return (wiki ? wiki[1]! : value).trim();
  }
  return null;
}

const sameTitle = (a: string, b: string) => {
  const strip = (s: string) => s.trim().replace(/\.md$/i, "").toLowerCase();
  const left = strip(a);
  const right = strip(b);
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
};

export function equals(a: Value, b: Value): boolean {
  if (a === null || b === null) return a === null && b === null;
  if (isList(a) || isList(b)) {
    if (isList(a) && isList(b))
      return a.length === b.length && a.every((item, i) => equals(item, b[i]!));
    // 一项的列表和那一项相等（属性里 `status: [完成]` 和 `status: 完成` 一个样）
    if (isList(a) && a.length === 1) return equals(a[0]!, b);
    if (isList(b) && b.length === 1) return equals(a, b[0]!);
    return false;
  }
  if (a instanceof BDate || b instanceof BDate) {
    const left = asDate(a);
    const right = asDate(b);
    return !!left && !!right && left.ms === right.ms;
  }
  if (a instanceof BLink || b instanceof BLink || a instanceof BFile || b instanceof BFile) {
    const left = linkTitle(a);
    const right = linkTitle(b);
    return left !== null && right !== null && sameTitle(left, right);
  }
  if (a instanceof BDuration && b instanceof BDuration) return a.ms === b.ms;
  if (typeof a === "number" && typeof b === "string") return b.trim() !== "" && a === Number(b);
  if (typeof b === "number" && typeof a === "string") return a.trim() !== "" && b === Number(a);
  if (typeof a === "boolean" && typeof b === "string") return String(a) === b;
  if (typeof b === "boolean" && typeof a === "string") return String(b) === a;
  return a === b;
}

/** 比大小（`<`、排序）：负数是 a 在前。比不了的（类型对不上）返回 NaN */
export function compare(a: Value, b: Value): number {
  const left = asDate(a);
  const right = asDate(b);
  if (left && right && (a instanceof BDate || b instanceof BDate)) return left.ms - right.ms;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  const x = toNumber(a);
  const y = toNumber(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  return x - y;
}

/* ---------------- 求值 ---------------- */

export interface Scope {
  /** 这一行（筛选、公式算的是哪一篇） */
  file: FileSource | null;
  /** `this`：主区打开时是这个视图文件自己 */
  self: FileSource | null;
  /** formula.x：按名字算（带缓存、查循环，在 query.ts） */
  formula: (name: string) => Value;
  /** 列表的 filter / map 里的 value、index、acc */
  locals?: Map<string, Value>;
  now: number;
}

const fileValue = (source: FileSource | null): Value => (source ? new BFile(source) : null);

function propsObject(source: FileSource): BObject {
  return new BObject(source.props);
}

/** 求一条表达式的值 */
export function evaluate(node: Node, scope: Scope): Value {
  switch (node.k) {
    case "lit":
      return node.v;
    case "list":
      return node.items.map((item) => evaluate(item, scope));
    case "id":
      return identifier(node.name, scope);
    case "member":
      return member(evaluate(node.obj, scope), node.name, node.obj, scope);
    case "index": {
      const obj = evaluate(node.obj, scope);
      const index = evaluate(node.index, scope);
      if (isList(obj)) {
        const i = toNumber(index);
        return obj[i < 0 ? obj.length + i : i] ?? null;
      }
      if (typeof obj === "string") return obj[toNumber(index)] ?? null;
      return member(obj, toText(index), node.obj, scope);
    }
    case "call":
      return call(node, scope);
    case "unary": {
      const value = evaluate(node.arg, scope);
      if (node.op === "!") return !truthy(value);
      if (node.op === "-")
        return value instanceof BDuration ? new BDuration(-value.ms) : -toNumber(value);
      return toNumber(value);
    }
    case "binary":
      return binary(node.op, node.left, node.right, scope);
  }
}

function identifier(name: string, scope: Scope): Value {
  const local = scope.locals?.get(name);
  if (local !== undefined) return local;
  switch (name) {
    case "file":
      return fileValue(scope.file);
    case "note":
      return scope.file ? propsObject(scope.file) : null;
    case "this":
      return scope.self
        ? new BObject(
            new Map<string, Value>([["file", new BFile(scope.self)], ...scope.self.props]),
          )
        : null;
    case "formula":
      return new BObject(new Map());
    default:
      return scope.file?.props.get(name) ?? null;
  }
}

function fileMember(source: FileSource, name: string): Value {
  switch (name) {
    case "name":
      return source.name;
    case "basename":
      return source.basename;
    case "path":
      return source.path;
    case "folder":
      return source.folder;
    case "ext":
      return source.ext;
    case "size":
      return source.size;
    case "ctime":
      return new BDate(source.ctime);
    case "mtime":
      return new BDate(source.mtime);
    case "tags":
      return source.tags.map((tag) => `#${tag}`);
    case "links":
      if (source.links === null) throw new Unsupported("file.links");
      return source.links.map((title) => new BLink(title));
    case "properties":
      return propsObject(source);
    case "file":
      return new BFile(source);
    case "backlinks":
    case "embeds":
      throw new Unsupported(`file.${name}`);
    default:
      return null;
  }
}

function member(obj: Value, name: string, objNode: Node, scope: Scope): Value {
  // formula.x
  if (objNode.k === "id" && objNode.name === "formula" && !scope.locals?.has("formula"))
    return scope.formula(name);
  if (obj === null) return null;
  if (obj instanceof BFile) return fileMember(obj.source, name);
  if (obj instanceof BObject) return obj.entries.get(name) ?? null;
  if (obj instanceof BDate) {
    const d = new Date(obj.ms);
    switch (name) {
      case "year":
        return d.getFullYear();
      case "month":
        return d.getMonth() + 1;
      case "day":
        return d.getDate();
      case "hour":
        return d.getHours();
      case "minute":
        return d.getMinutes();
      case "second":
        return d.getSeconds();
      case "millisecond":
        return d.getMilliseconds();
      default:
        return null;
    }
  }
  if (obj instanceof BDuration) {
    const units: Record<string, number> = {
      days: DAY,
      hours: 3_600_000,
      minutes: 60_000,
      seconds: 1000,
      milliseconds: 1,
    };
    const unit = units[name];
    // 照 Obsidian：`.days` 是整天数（往零取整），要小数自己除
    return unit === undefined ? null : Math.trunc(obj.ms / unit);
  }
  if (obj instanceof BLink) return name === "display" ? obj.display : null;
  if (name === "length" && (typeof obj === "string" || isList(obj))) return obj.length;
  return null;
}

function binary(op: string, leftNode: Node, rightNode: Node, scope: Scope): Value {
  if (op === "&&") {
    const left = evaluate(leftNode, scope);
    return truthy(left) ? evaluate(rightNode, scope) : left;
  }
  if (op === "||") {
    const left = evaluate(leftNode, scope);
    return truthy(left) ? left : evaluate(rightNode, scope);
  }
  const left = evaluate(leftNode, scope);
  const right = evaluate(rightNode, scope);
  switch (op) {
    case "==":
      return equals(left, right);
    case "!=":
      return !equals(left, right);
    case "<":
      return compare(left, right) < 0;
    case ">":
      return compare(left, right) > 0;
    case "<=":
      return compare(left, right) <= 0;
    case ">=":
      return compare(left, right) >= 0;
    case "+":
    case "-": {
      const sign = op === "+" ? 1 : -1;
      const date = left instanceof BDate ? left : null;
      if (date) {
        if (op === "-") {
          const other = asDate(right);
          if (other && !(typeof right === "string" && durationParts(right)))
            return new BDuration(date.ms - other.ms);
        }
        if (right instanceof BDuration) return new BDate(date.ms + sign * right.ms, false);
        const parts = typeof right === "string" ? durationParts(right) : null;
        if (parts) return shift(date, parts, sign);
        if (typeof right === "number") return new BDate(date.ms + sign * right, false);
        throw new ExprError(`日期${op === "+" ? "加" : "减"}的不是一段时长`);
      }
      if (left instanceof BDuration) {
        const other = durationOf(right);
        if (other) return new BDuration(left.ms + sign * other.ms);
      }
      if (
        op === "+" &&
        (typeof left === "string" || typeof right === "string" || isList(left) || isList(right))
      ) {
        if (isList(left) && isList(right)) return [...left, ...right];
        return toText(left) + toText(right);
      }
      return toNumber(left) + sign * toNumber(right);
    }
    case "*":
      if (left instanceof BDuration) return new BDuration(left.ms * toNumber(right));
      return toNumber(left) * toNumber(right);
    case "/":
      if (left instanceof BDuration) return new BDuration(left.ms / toNumber(right));
      return toNumber(left) / toNumber(right);
    case "%":
      return toNumber(left) % toNumber(right);
    default:
      throw new ExprError(`认不得「${op}」`);
  }
}

/* ---------------- 函数、方法 ---------------- */

function call(node: Extract<Node, { k: "call" }>, scope: Scope): Value {
  const { callee } = node;
  if (callee.k === "id") return globalCall(callee.name, node.args, scope);
  if (callee.k === "member") {
    const target = evaluate(callee.obj, scope);
    // list.filter(value > 1)、list.map(value * 2)：参数按每一项算，不是先算好
    if (
      isList(target) &&
      (callee.name === "filter" || callee.name === "map" || callee.name === "reduce")
    ) {
      return listLambda(target, callee.name, node.args, scope);
    }
    const args = node.args.map((arg) => evaluate(arg, scope));
    return method(target, callee.name, args);
  }
  throw new ExprError("这里不能调用");
}

function listLambda(list: Value[], name: string, args: Node[], scope: Scope): Value {
  const body = args[0];
  if (!body) throw new ExprError(`${name}() 要一个表达式`);
  const run = (value: Value, index: number, acc?: Value) => {
    const locals = new Map(scope.locals);
    locals.set("value", value);
    locals.set("index", index);
    if (acc !== undefined) locals.set("acc", acc);
    return evaluate(body, { ...scope, locals });
  };
  if (name === "filter") return list.filter((value, index) => truthy(run(value, index)));
  if (name === "map") return list.map((value, index) => run(value, index));
  let acc: Value = args[1] ? evaluate(args[1], scope) : null;
  list.forEach((value, index) => {
    acc = run(value, index, acc);
  });
  return acc;
}

function globalCall(name: string, argNodes: Node[], scope: Scope): Value {
  // if 只算走到的那一支
  if (name === "if") {
    const [condition, then, otherwise] = argNodes;
    if (!condition) throw new ExprError("if() 要一个条件");
    if (truthy(evaluate(condition, scope))) return then ? evaluate(then, scope) : null;
    return otherwise ? evaluate(otherwise, scope) : null;
  }
  const args = argNodes.map((arg) => evaluate(arg, scope));
  switch (name) {
    case "now":
      return new BDate(scope.now);
    case "today": {
      const d = new Date(scope.now);
      return new BDate(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), true);
    }
    case "date": {
      const value = args[0] ?? null;
      if (value instanceof BDate) return value;
      if (typeof value === "number") return new BDate(value);
      return asDate(value);
    }
    case "duration":
      return durationOf(args[0] ?? null);
    case "list":
      return args[0] === undefined || args[0] === null ? [] : isList(args[0]) ? args[0] : [args[0]];
    case "number": {
      const value = args[0] ?? null;
      const n = value instanceof BDate ? value.ms : toNumber(value);
      return Number.isNaN(n) ? null : n;
    }
    case "link": {
      const target = args[0] ?? null;
      const display = args[1] === undefined || args[1] === null ? null : toText(args[1]);
      if (target instanceof BFile) return new BLink(target.source.basename, display);
      return new BLink(linkTitle(target) ?? "", display);
    }
    case "min":
    case "max": {
      const numbers = args
        .flat()
        .map(toNumber)
        .filter((n) => !Number.isNaN(n));
      if (numbers.length === 0) return null;
      return name === "min" ? Math.min(...numbers) : Math.max(...numbers);
    }
    case "escapeHTML":
      return toText(args[0] ?? null).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    default:
      throw new Unsupported(`${name}()`);
  }
}

const TAG_STRIP = (tag: string) => tag.replace(/^#/, "").toLowerCase();

/** 所在文件夹（`/` 是仓库根）是不是 folder，或者在它底下 */
export function inFolder(source: FileSource, folder: string): boolean {
  const want = folder.replace(/^\/+|\/+$/g, "");
  if (want === "") return true;
  const dir = source.folder === "/" ? "" : source.folder;
  return dir === want || dir.startsWith(`${want}/`);
}

function method(target: Value, name: string, args: Value[]): Value {
  const arg = (i: number) => args[i] ?? null;
  // 任何值都有的
  switch (name) {
    case "isTruthy":
      return truthy(target);
    case "toString":
      return toText(target);
    case "isType": {
      const type = toText(arg(0)).toLowerCase();
      const actual =
        target === null
          ? "null"
          : typeof target === "string"
            ? "string"
            : typeof target === "number"
              ? "number"
              : typeof target === "boolean"
                ? "boolean"
                : target instanceof BDate
                  ? "date"
                  : target instanceof BDuration
                    ? "duration"
                    : target instanceof BLink
                      ? "link"
                      : target instanceof BFile
                        ? "file"
                        : isList(target)
                          ? "list"
                          : "object";
      return actual === type;
    }
    case "isEmpty":
      if (target === null || target === "") return true;
      if (isList(target)) return target.length === 0;
      if (target instanceof BObject) return target.entries.size === 0;
      return false;
  }
  if (target === null) return null;

  if (target instanceof BFile) {
    const source = target.source;
    switch (name) {
      case "hasTag":
        return args.some((want) => {
          const tag = TAG_STRIP(toText(want));
          return source.tags.some((has) => has === tag || has.startsWith(`${tag}/`));
        });
      case "hasLink": {
        if (source.links === null) throw new Unsupported("file.hasLink()");
        const title = linkTitle(arg(0));
        return title !== null && source.links.some((link) => sameTitle(link, title));
      }
      case "hasProperty":
        return source.props.has(toText(arg(0)));
      case "inFolder":
        return inFolder(source, toText(arg(0)));
      case "asLink":
        return new BLink(source.basename, arg(0) === null ? null : toText(arg(0)));
      default:
        throw new Unsupported(`file.${name}()`);
    }
  }

  if (target instanceof BLink) {
    switch (name) {
      case "linksTo":
        return equals(target, arg(0));
      default:
        throw new Unsupported(`link.${name}()`);
    }
  }

  if (target instanceof RegExp) {
    if (name === "matches") return target.test(toText(arg(0)));
    throw new Unsupported(`regexp.${name}()`);
  }

  if (target instanceof BDate) {
    switch (name) {
      case "format":
        return formatDate(target, toText(arg(0)) || "YYYY-MM-DD");
      case "date": {
        const d = new Date(target.ms);
        return new BDate(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), true);
      }
      case "time":
        return formatDate(target, "HH:mm:ss");
      case "relative":
        return formatRelativeTime(target.ms);
      default:
        throw new Unsupported(`date.${name}()`);
    }
  }

  if (typeof target === "number") {
    switch (name) {
      case "abs":
        return Math.abs(target);
      case "ceil":
        return Math.ceil(target);
      case "floor":
        return Math.floor(target);
      case "round": {
        const digits = toNumber(arg(0)) || 0;
        const factor = 10 ** digits;
        return Math.round(target * factor) / factor;
      }
      case "toFixed":
        return target.toFixed(Math.max(0, Math.min(20, toNumber(arg(0)) || 0)));
      default:
        throw new Unsupported(`number.${name}()`);
    }
  }

  if (typeof target === "string") {
    const text = target;
    switch (name) {
      case "contains":
        return text.includes(toText(arg(0)));
      case "containsAll":
        return args.every((value) => text.includes(toText(value)));
      case "containsAny":
        return args.some((value) => text.includes(toText(value)));
      case "startsWith":
        return text.startsWith(toText(arg(0)));
      case "endsWith":
        return text.endsWith(toText(arg(0)));
      case "lower":
        return text.toLowerCase();
      case "upper":
        return text.toUpperCase();
      case "title":
        return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
      case "trim":
        return text.trim();
      case "repeat":
        return text.repeat(Math.max(0, Math.min(1000, toNumber(arg(0)) || 0)));
      case "reverse":
        return [...text].reverse().join("");
      case "slice":
        return text.slice(toNumber(arg(0)) || 0, arg(1) === null ? undefined : toNumber(arg(1)));
      case "split": {
        const separator = arg(0);
        const parts =
          separator instanceof RegExp ? text.split(separator) : text.split(toText(separator));
        return arg(1) === null ? parts : parts.slice(0, toNumber(arg(1)));
      }
      case "replace": {
        const pattern = arg(0);
        const replacement = toText(arg(1));
        return pattern instanceof RegExp
          ? text.replace(pattern, replacement)
          : text.replaceAll(toText(pattern), replacement);
      }
      default:
        throw new Unsupported(`string.${name}()`);
    }
  }

  if (isList(target)) {
    const has = (want: Value) => target.some((item) => equals(item, want));
    switch (name) {
      case "contains":
        return has(arg(0));
      case "containsAll":
        return args.every(has);
      case "containsAny":
        return args.some(has);
      case "join":
        return target.map(toText).join(arg(0) === null ? ", " : toText(arg(0)));
      case "reverse":
        return [...target].reverse();
      case "slice":
        return target.slice(toNumber(arg(0)) || 0, arg(1) === null ? undefined : toNumber(arg(1)));
      case "sort":
        return [...target].sort(sortCompare);
      case "unique":
        return target.filter(
          (item, index) => target.findIndex((other) => equals(other, item)) === index,
        );
      case "flat":
        return target.flat() as Value[];
      default:
        throw new Unsupported(`list.${name}()`);
    }
  }

  throw new Unsupported(`${name}()`);
}

/* ---------------- 排序 ---------------- */

const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });

/** 排序用：空的永远在最后（调用方按方向翻转时别翻它）；字照中文的习惯排（拼音、数字按大小） */
export function sortCompare(a: Value, b: Value): number {
  const emptyA = a === null || a === "" || (isList(a) && a.length === 0);
  const emptyB = b === null || b === "" || (isList(b) && b.length === 0);
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  if (isList(a) || isList(b)) return sortCompare(isList(a) ? a[0]! : a, isList(b) ? b[0]! : b);
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const left = a instanceof BDate || b instanceof BDate ? asDate(a) : null;
  const right = left ? asDate(b) : null;
  if (left && right) return left.ms - right.ms;
  if (a instanceof BDuration && b instanceof BDuration) return a.ms - b.ms;
  return collator.compare(toText(a), toText(b));
}
