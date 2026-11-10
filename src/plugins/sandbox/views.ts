import { CALLOUT_ICONS } from "@/editor/callout";

/* ============================================================
   插件交来的声明式视图（docs/插件与跨端.md §5.6「不是文档的，交声明」）。

   插件不碰 DOM：它交一棵组件树（纯数据），宿主用 Odea 自己的组件画出来（SlotView.tsx）。
   动效、描边、像素对齐都在宿主的组件里，插件碰不到；样式也只有几档可选（tone、primary），
   写不进任意的 CSS、HTML。第一批组件是设计稿里列的那几样：列表、树、表单、空状态、按钮条，
   外加排版用的 stack、text、heading、stats、divider。

   树是不可信的输入：每个节点只认登记过的字段，字数、个数、层数都有上限，写错了报出是哪个字段
   （「views：children[2].items[0].title 要是字符串」），整棵不换上，还显示上一棵。
   更新可以整棵换，也可以交一份 JSON Patch（RFC 6902 里的 add / remove / replace），改完再校验一遍。
   ============================================================ */

export type Tone = "default" | "muted" | "success" | "warning" | "danger";
export type IconName = keyof typeof CALLOUT_ICONS;
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 一个按钮：点了宿主发 slots.action（action、value）给插件 */
export interface ViewButton {
  action: string;
  label: string;
  value?: JsonValue;
  primary?: boolean;
  tone?: "danger";
  disabled?: boolean;
}

export interface ListItem {
  id: string;
  title: string;
  description?: string;
  icon?: IconName;
  tone?: Tone;
  actions?: ViewButton[];
}

export interface TreeItem {
  id: string;
  title: string;
  description?: string;
  children?: TreeItem[];
}

export type FormField =
  | { type: "text"; name: string; label: string; value?: string; placeholder?: string }
  | { type: "checkbox"; name: string; label: string; value?: boolean }
  | {
      type: "select";
      name: string;
      label: string;
      value?: string;
      options: { value: string; label: string }[];
    };

export type ViewNode =
  | { type: "stack"; children: ViewNode[] }
  | { type: "heading"; text: string }
  | { type: "text"; text: string; tone?: Tone }
  | { type: "stats"; items: { label: string; value: string; tone?: Tone }[] }
  | { type: "list"; items: ListItem[] }
  | { type: "tree"; items: TreeItem[] }
  | { type: "buttons"; buttons: ViewButton[] }
  | { type: "empty"; title: string; hint?: string }
  | { type: "form"; id: string; fields: FormField[]; submit: ViewButton }
  | { type: "divider" };

const TONES: readonly Tone[] = ["default", "muted", "success", "warning", "danger"];

const LIMIT = {
  /** 整棵树的 JSON 多大 */
  bytes: 256 * 1024,
  /** 一共多少个节点（列表的每一项、每个按钮都算） */
  nodes: 2000,
  /** stack、树最多套几层 */
  depth: 8,
  text: 2000,
  label: 60,
  items: 300,
  buttons: 8,
  fields: 20,
  options: 50,
  /** 按钮带的 value 的 JSON 多大 */
  value: 2048,
};

export class ViewError extends Error {
  constructor(
    readonly path: string,
    problem: string,
  ) {
    super(path ? `${path} ${problem}` : problem);
    this.name = "ViewError";
  }
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);
const at = (path: string, key: string | number) =>
  typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key;

/** 校验一棵树：交回整理过的（只留认识的字段）；不对就抛 ViewError */
export function validateView(value: unknown): ViewNode {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new ViewError("", "不是纯数据（有循环引用或者函数）");
  }
  if (json === undefined) throw new ViewError("", "是空的");
  if (json.length > LIMIT.bytes) throw new ViewError("", `太大了（最多 ${LIMIT.bytes / 1024} KB）`);
  const counter = { nodes: 0 };
  return node(value, "", 0, counter);
}

function count(counter: { nodes: number }, path: string) {
  counter.nodes += 1;
  if (counter.nodes > LIMIT.nodes)
    throw new ViewError(path, `节点太多了（最多 ${LIMIT.nodes} 个）`);
}

function keys(object: Json, allowed: string[], path: string) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw new ViewError(at(path, key), "不认识这个字段");
  }
}

function str(object: Json, key: string, path: string, max: number, required: true): string;
function str(
  object: Json,
  key: string,
  path: string,
  max: number,
  required: false,
): string | undefined;
function str(object: Json, key: string, path: string, max: number, required: boolean) {
  const value = object[key];
  if (value === undefined || value === null) {
    if (required) throw new ViewError(at(path, key), "缺了");
    return undefined;
  }
  if (typeof value !== "string") throw new ViewError(at(path, key), "要是字符串");
  if (value.length > max) throw new ViewError(at(path, key), `太长了（最多 ${max} 个字）`);
  return value;
}

function bool(object: Json, key: string, path: string): boolean | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ViewError(at(path, key), "要是 true 或 false");
  return value;
}

function tone(object: Json, path: string): Tone | undefined {
  const value = object.tone;
  if (value === undefined || value === null) return undefined;
  if (!TONES.includes(value as Tone)) {
    throw new ViewError(at(path, "tone"), `只能是 ${TONES.join("、")}`);
  }
  return value as Tone;
}

function array(object: Json, key: string, path: string, max: number, required = true): unknown[] {
  const value = object[key];
  if (value === undefined || value === null) {
    if (required) throw new ViewError(at(path, key), "缺了");
    return [];
  }
  if (!Array.isArray(value)) throw new ViewError(at(path, key), "要是数组");
  if (value.length > max) throw new ViewError(at(path, key), `太多了（最多 ${max} 项）`);
  return value;
}

/** action、id、表单项的 name：短的标识 */
function ident(object: Json, key: string, path: string): string {
  const value = str(object, key, path, 64, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new ViewError(at(path, key), "只能用字母、数字和 . _ : -");
  }
  return value;
}

function button(value: unknown, path: string, counter: { nodes: number }): ViewButton {
  count(counter, path);
  if (!isObject(value)) throw new ViewError(path, "要是一个对象");
  keys(value, ["action", "label", "value", "primary", "tone", "disabled"], path);
  const result: ViewButton = {
    action: ident(value, "action", path),
    label: str(value, "label", path, LIMIT.label, true),
  };
  if (value.value !== undefined) {
    const json = JSON.stringify(value.value);
    if (json === undefined || json.length > LIMIT.value) {
      throw new ViewError(at(path, "value"), `要是纯数据，最多 ${LIMIT.value} 个字节`);
    }
    result.value = JSON.parse(json) as JsonValue;
  }
  const primary = bool(value, "primary", path);
  if (primary) result.primary = true;
  if (value.tone !== undefined) {
    if (value.tone !== "danger") throw new ViewError(at(path, "tone"), "只能是 danger");
    result.tone = "danger";
  }
  const disabled = bool(value, "disabled", path);
  if (disabled) result.disabled = true;
  return result;
}

function buttons(list: unknown[], path: string, counter: { nodes: number }) {
  return list.map((item, index) => button(item, at(path, index), counter));
}

function icon(object: Json, path: string): IconName | undefined {
  const value = object.icon;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !Object.hasOwn(CALLOUT_ICONS, value)) {
    throw new ViewError(at(path, "icon"), "没有这个图标");
  }
  return value as IconName;
}

function treeItems(
  list: unknown[],
  path: string,
  depth: number,
  counter: { nodes: number },
): TreeItem[] {
  if (depth > LIMIT.depth) throw new ViewError(path, `套得太深了（最多 ${LIMIT.depth} 层）`);
  return list.map((raw, index) => {
    const here = at(path, index);
    count(counter, here);
    if (!isObject(raw)) throw new ViewError(here, "要是一个对象");
    keys(raw, ["id", "title", "description", "children"], here);
    const item: TreeItem = {
      id: ident(raw, "id", here),
      title: str(raw, "title", here, LIMIT.text, true),
    };
    const description = str(raw, "description", here, LIMIT.text, false);
    if (description !== undefined) item.description = description;
    const children = array(raw, "children", here, LIMIT.items, false);
    if (children.length) {
      item.children = treeItems(children, at(here, "children"), depth + 1, counter);
    }
    return item;
  });
}

function field(raw: unknown, path: string, counter: { nodes: number }): FormField {
  count(counter, path);
  if (!isObject(raw)) throw new ViewError(path, "要是一个对象");
  const name = ident(raw, "name", path);
  const label = str(raw, "label", path, LIMIT.label, true);
  switch (raw.type) {
    case "text": {
      keys(raw, ["type", "name", "label", "value", "placeholder"], path);
      const value = str(raw, "value", path, LIMIT.text, false);
      const placeholder = str(raw, "placeholder", path, LIMIT.label, false);
      return {
        type: "text",
        name,
        label,
        ...(value !== undefined ? { value } : {}),
        ...(placeholder !== undefined ? { placeholder } : {}),
      };
    }
    case "checkbox": {
      keys(raw, ["type", "name", "label", "value"], path);
      const value = bool(raw, "value", path);
      return { type: "checkbox", name, label, ...(value !== undefined ? { value } : {}) };
    }
    case "select": {
      keys(raw, ["type", "name", "label", "value", "options"], path);
      const options = array(raw, "options", path, LIMIT.options).map((option, index) => {
        const here = at(at(path, "options"), index);
        if (!isObject(option)) throw new ViewError(here, "要是一个对象");
        keys(option, ["value", "label"], here);
        return {
          value: str(option, "value", here, LIMIT.label, true),
          label: str(option, "label", here, LIMIT.label, true),
        };
      });
      if (!options.length) throw new ViewError(at(path, "options"), "不能是空的");
      const value = str(raw, "value", path, LIMIT.label, false);
      return { type: "select", name, label, options, ...(value !== undefined ? { value } : {}) };
    }
    default:
      throw new ViewError(at(path, "type"), "只能是 text、checkbox、select");
  }
}

const NODE_TYPES = [
  "stack",
  "heading",
  "text",
  "stats",
  "list",
  "tree",
  "buttons",
  "empty",
  "form",
  "divider",
];

function node(raw: unknown, path: string, depth: number, counter: { nodes: number }): ViewNode {
  count(counter, path);
  if (!isObject(raw)) throw new ViewError(path, "要是一个对象（{ type, … }）");
  if (depth > LIMIT.depth) throw new ViewError(path, `套得太深了（最多 ${LIMIT.depth} 层）`);
  const type = raw.type;
  switch (type) {
    case "stack": {
      keys(raw, ["type", "children"], path);
      const children = array(raw, "children", path, LIMIT.items).map((child, index) =>
        node(child, at(at(path, "children"), index), depth + 1, counter),
      );
      return { type, children };
    }
    case "heading":
      keys(raw, ["type", "text"], path);
      return { type, text: str(raw, "text", path, LIMIT.label, true) };
    case "text": {
      keys(raw, ["type", "text", "tone"], path);
      const text = str(raw, "text", path, LIMIT.text, true);
      const t = tone(raw, path);
      return { type, text, ...(t ? { tone: t } : {}) };
    }
    case "stats": {
      keys(raw, ["type", "items"], path);
      const items = array(raw, "items", path, 8).map((item, index) => {
        const here = at(at(path, "items"), index);
        count(counter, here);
        if (!isObject(item)) throw new ViewError(here, "要是一个对象");
        keys(item, ["label", "value", "tone"], here);
        const t = tone(item, here);
        return {
          label: str(item, "label", here, LIMIT.label, true),
          value: str(item, "value", here, LIMIT.label, true),
          ...(t ? { tone: t } : {}),
        };
      });
      return { type, items };
    }
    case "list": {
      keys(raw, ["type", "items"], path);
      const ids = new Set<string>();
      const items = array(raw, "items", path, LIMIT.items).map((item, index) => {
        const here = at(at(path, "items"), index);
        count(counter, here);
        if (!isObject(item)) throw new ViewError(here, "要是一个对象");
        keys(item, ["id", "title", "description", "icon", "tone", "actions"], here);
        const id = ident(item, "id", here);
        if (ids.has(id)) throw new ViewError(at(here, "id"), `「${id}」重复了`);
        ids.add(id);
        const result: ListItem = { id, title: str(item, "title", here, LIMIT.text, true) };
        const description = str(item, "description", here, LIMIT.text, false);
        if (description !== undefined) result.description = description;
        const i = icon(item, here);
        if (i) result.icon = i;
        const t = tone(item, here);
        if (t) result.tone = t;
        const actions = array(item, "actions", here, 3, false);
        if (actions.length) result.actions = buttons(actions, at(here, "actions"), counter);
        return result;
      });
      return { type, items };
    }
    case "tree":
      keys(raw, ["type", "items"], path);
      return {
        type,
        items: treeItems(array(raw, "items", path, LIMIT.items), at(path, "items"), depth, counter),
      };
    case "buttons":
      keys(raw, ["type", "buttons"], path);
      return {
        type,
        buttons: buttons(array(raw, "buttons", path, LIMIT.buttons), at(path, "buttons"), counter),
      };
    case "empty": {
      keys(raw, ["type", "title", "hint"], path);
      const hint = str(raw, "hint", path, LIMIT.text, false);
      return {
        type,
        title: str(raw, "title", path, LIMIT.label, true),
        ...(hint !== undefined ? { hint } : {}),
      };
    }
    case "form": {
      keys(raw, ["type", "id", "fields", "submit"], path);
      const names = new Set<string>();
      const fields = array(raw, "fields", path, LIMIT.fields).map((item, index) => {
        const result = field(item, at(at(path, "fields"), index), counter);
        if (names.has(result.name)) {
          throw new ViewError(at(at(at(path, "fields"), index), "name"), "重复了");
        }
        names.add(result.name);
        return result;
      });
      if (raw.submit === undefined) throw new ViewError(at(path, "submit"), "缺了");
      return {
        type,
        id: ident(raw, "id", path),
        fields,
        submit: button(raw.submit, at(path, "submit"), counter),
      };
    }
    case "divider":
      keys(raw, ["type"], path);
      return { type };
    default:
      throw new ViewError(at(path, "type"), `只能是 ${NODE_TYPES.join("、")}`);
  }
}

/* ---------------- JSON Patch ---------------- */

export interface PatchOp {
  op: "add" | "remove" | "replace";
  path: string;
  value?: unknown;
}

/** `/children/0/text` → ["children", "0", "text"]（~1 是 /，~0 是 ~） */
function pointer(path: unknown): string[] {
  if (typeof path !== "string" || (path !== "" && !path.startsWith("/"))) {
    throw new ViewError("patch", `path 要以 / 开头，写的是 ${JSON.stringify(path)}`);
  }
  return path === ""
    ? []
    : path
        .slice(1)
        .split("/")
        .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/**
 * 在一棵树上改几处（RFC 6902 的 add / remove / replace）。不动原来那棵，交回改好的新一棵
 * （还要再 validateView 一遍）。最多 200 处
 */
export function applyPatch(tree: ViewNode, ops: unknown): unknown {
  if (!Array.isArray(ops)) throw new ViewError("patch", "要是数组");
  if (ops.length > 200) throw new ViewError("patch", "一次最多改 200 处");
  let root: unknown = structuredClone(tree);
  ops.forEach((raw, index) => {
    const here = `patch[${index}]`;
    if (!isObject(raw)) throw new ViewError(here, "要是一个对象");
    const { op, value } = raw;
    if (op !== "add" && op !== "remove" && op !== "replace") {
      throw new ViewError(`${here}.op`, "只能是 add、remove、replace");
    }
    if (op !== "remove" && value === undefined) throw new ViewError(`${here}.value`, "缺了");
    const parts = pointer(raw.path);
    if (!parts.length) {
      if (op === "remove") throw new ViewError(here, "不能删掉整棵树");
      root = structuredClone(value);
      return;
    }
    let parent: unknown = root;
    for (const part of parts.slice(0, -1)) {
      if (Array.isArray(parent)) parent = parent[Number(part)];
      else if (isObject(parent) && Object.hasOwn(parent, part)) parent = parent[part];
      else throw new ViewError(here, `找不到 ${raw.path}`);
    }
    const last = parts.at(-1)!;
    if (Array.isArray(parent)) {
      const position = last === "-" ? parent.length : Number(last);
      const max = op === "add" ? parent.length : parent.length - 1;
      if (!Number.isInteger(position) || position < 0 || position > max) {
        throw new ViewError(here, `${raw.path} 超出了数组的范围`);
      }
      if (op === "add") parent.splice(position, 0, structuredClone(value));
      else if (op === "remove") parent.splice(position, 1);
      else parent[position] = structuredClone(value);
    } else if (isObject(parent)) {
      if (op !== "add" && !Object.hasOwn(parent, last)) {
        throw new ViewError(here, `找不到 ${raw.path}`);
      }
      if (op === "remove") delete parent[last];
      else parent[last] = structuredClone(value);
    } else {
      throw new ViewError(here, `找不到 ${raw.path}`);
    }
  });
  return root;
}
