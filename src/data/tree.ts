import { cleanFolderName, uniqueChild } from "./folders";
import type { TreeNode } from "./types";

/* ============================================================
   逻辑目录的树（docs/仓库与启动器.md §7，Rust 的 vault/tree.rs）在前端的样子。

   后端给的是一个个节点（tree_view）：文件夹、智能文件夹、放在树上的笔记、快捷方式，各带父节点和排序键。
   这里把它摊成界面认的样子 —— 文件夹路径（`交易/学习`，和本地目录一样用路径称呼）、每篇在哪个
   文件夹、手动排序的顺序 —— 还有乐观更新：挪一下先在这边改，算法和后端一样（keyBetween 和
   Rust 的 key_between 一模一样），后端做完再把它给的那一份整个换上来。
   ============================================================ */

/** 根节点 */
export const ROOT = ".";
/** 「未整理」在界面上的路径：真的文件夹路径不会以 / 开头（Rust 的 tree::UNSORTED） */
export const UNSORTED = "/";

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const digit = (c: string | undefined) => (c === undefined ? 0 : Math.max(0, DIGITS.indexOf(c)));

/**
 * 严格夹在 a、b 中间的排序键（null：最前面之前 / 最后面之后）。36 进制的小数 0.k1k2k3…，按字符串
 * 比大小，结尾不会是 0（任何一个键前面总还插得进东西）。和 Rust 的 key_between 是同一个算法
 */
export function keyBetween(a: string | null, b: string | null): string {
  return midpoint(a ?? "", b);
}

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // 公共前缀（a 不够长时当后面补了 0）原样留着，在后面那一截里找中点
    let n = 0;
    while (n < b.length && (a[n] ?? "0") === b[n]) n++;
    if (n > 0 && n < b.length) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a.length ? digit(a[0]) : 0;
  const db = b?.length ? digit(b[0]) : DIGITS.length;
  if (db > da + 1) return DIGITS[Math.floor((da + db) / 2)] as string;
  // b 后面还有不是 0 的位：只取它的第一位，比 b 小、比 a 大
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return (DIGITS[da] as string) + midpoint(a.slice(1), null);
}

/** 同一层的显示顺序：排序键，一样时按 id（和 Rust 的 children 一样） */
const byKey = (a: TreeNode, b: TreeNode) =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** 文件夹那一栏里的（有名字、有路径）：文件夹、智能文件夹。笔记和快捷方式是另一组 */
const isBranch = (node: TreeNode) => node.kind === "folder" || node.kind === "query";

/** 一篇放在树上哪儿 */
export interface Placement {
  /** 所在文件夹的路径，根是空串 */
  folder: string;
  key: string;
  node: string;
}

/** 树上的一个快捷方式 */
export interface Shortcut {
  /** 快捷方式自己的节点 id（删它用） */
  node: string;
  /** 指着的笔记 */
  note: string;
  key: string;
}

/** 摊开以后界面要的东西 */
export interface TreeShape {
  /** 文件夹和智能文件夹的路径，按显示顺序：父在前、子在后，同一层按排序键 */
  folders: string[];
  /** 智能文件夹：路径 → 条件 */
  smart: Map<string, string>;
  /** 笔记 id → 它放在哪。不在里面的在「未整理」 */
  placement: Map<string, Placement>;
  /**
   * 快捷方式（docs/仓库与启动器.md §7.5）：文件夹路径 → 放在这里的快捷方式（按排序键），
   * 每个指着一篇放在别处的笔记。删快捷方式不删笔记
   */
  shortcuts: Map<string, Shortcut[]>;
  /** 路径 → 节点 id（根是空串 → "."） */
  nodeOf: Map<string, string>;
}

export function shapeOf(nodes: TreeNode[]): TreeShape {
  const children = new Map<string, TreeNode[]>();
  for (const node of nodes) {
    const list = children.get(node.parent);
    if (list) list.push(node);
    else children.set(node.parent, [node]);
  }
  for (const list of children.values()) list.sort(byKey);
  const shape: TreeShape = {
    folders: [],
    smart: new Map(),
    placement: new Map(),
    shortcuts: new Map(),
    nodeOf: new Map([["", ROOT]]),
  };
  const walk = (parent: string, prefix: string, seen: Set<string>) => {
    for (const node of children.get(parent) ?? []) {
      if (node.kind === "note") {
        if (node.note && !shape.placement.has(node.note))
          shape.placement.set(node.note, { folder: prefix, key: node.key, node: node.id });
        continue;
      }
      if (node.kind === "shortcut") {
        if (node.note) {
          const list = shape.shortcuts.get(prefix) ?? [];
          list.push({ node: node.id, note: node.note, key: node.key });
          shape.shortcuts.set(prefix, list);
        }
        continue;
      }
      if (!isBranch(node)) continue;
      const path = prefix ? `${prefix}/${node.name}` : (node.name ?? "");
      shape.folders.push(path);
      shape.nodeOf.set(path, node.id);
      if (node.kind === "query") shape.smart.set(path, node.query ?? "");
      // 后端理顺过，不会成环；万一有，也不会在这里转不出来
      else if (!seen.has(node.id)) walk(node.id, path, new Set(seen).add(node.id));
    }
  };
  walk(ROOT, "", new Set());
  return shape;
}

/* ---------------- 乐观更新：和后端的 tree.rs 同一套规矩 ---------------- */

let tempCounter = 0;
/** 乐观更新时新节点的 id：后端回来的那一份换上来时就没了 */
const tempId = () => `~${++tempCounter}`;

/** parent 这一层、同一组（文件夹那一栏 / 笔记）里，id 排在 after 后面（null 是最前面）的排序键 */
function keyAfter(
  nodes: TreeNode[],
  id: string,
  parent: string,
  branch: boolean,
  after: string | null,
): { key: string; nodes: TreeNode[] } {
  const siblings = nodes
    .filter((node) => node.parent === parent && isBranch(node) === branch && node.id !== id)
    .sort(byKey);
  const found = after === null ? -1 : siblings.findIndex((node) => node.id === after);
  const index = after === null ? 0 : found < 0 ? siblings.length : found + 1;
  const prev = index > 0 ? (siblings[index - 1]?.key ?? null) : null;
  const next = siblings[index]?.key ?? null;
  if (prev === null || next === null || prev < next) return { key: keyBetween(prev, next), nodes };
  // 两个键撞了（两台设备在同一处各插了一个）：这一组重排一遍
  const order = [
    ...siblings.slice(0, index).map((node) => node.id),
    id,
    ...siblings.slice(index).map((node) => node.id),
  ];
  const keys = new Map<string, string>();
  let last: string | null = null;
  for (const sibling of order) {
    last = keyBetween(last, null);
    keys.set(sibling, last);
  }
  return {
    key: keys.get(id) as string,
    nodes: nodes.map((node) =>
      keys.has(node.id) && node.id !== id ? { ...node, key: keys.get(node.id) as string } : node,
    ),
  };
}

/** 同一层的名字（不分大小写，和 uniqueChild 一样）：撞了加「 2」「 3」 */
function freeName(nodes: TreeNode[], parent: string, name: string, except?: string): string {
  const taken = nodes
    .filter((node) => node.parent === parent && isBranch(node) && node.id !== except)
    .map((node) => node.name ?? "");
  return uniqueChild(taken, "", name);
}

/** 新建文件夹 / 智能文件夹：排在这一层最前面（就地起名的输入框也在最前面）。parent 不在了返回 null */
export function addBranch(
  nodes: TreeNode[],
  parent: string,
  name: string,
  query?: string,
): { nodes: TreeNode[]; path: string } | null {
  const shape = shapeOf(nodes);
  const parentId = shape.nodeOf.get(parent);
  const clean = cleanFolderName(name);
  if (parentId === undefined || !clean || shape.smart.has(parent)) return null;
  const id = tempId();
  const finalName = freeName(nodes, parentId, clean);
  const { key, nodes: rest } = keyAfter(nodes, id, parentId, true, null);
  const node: TreeNode = {
    id,
    parent: parentId,
    key,
    kind: query === undefined ? "folder" : "query",
    name: finalName,
    note: null,
    query: query === undefined ? null : query.trim(),
  };
  return { nodes: [...rest, node], path: parent ? `${parent}/${finalName}` : finalName };
}

/** 改名（同一层重名加序号）。返回新路径；不在了返回 null */
export function renameBranch(
  nodes: TreeNode[],
  path: string,
  name: string,
  query?: string,
): { nodes: TreeNode[]; path: string } | null {
  const id = shapeOf(nodes).nodeOf.get(path);
  const clean = cleanFolderName(name);
  const target = nodes.find((node) => node.id === id);
  if (!target || !clean) return null;
  const finalName = freeName(nodes, target.parent, clean, target.id);
  const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return {
    nodes: nodes.map((node) =>
      node.id === target.id
        ? { ...node, name: finalName, query: query === undefined ? node.query : query.trim() }
        : node,
    ),
    path: parentPath ? `${parentPath}/${finalName}` : finalName,
  };
}

/** 挪文件夹：放进 parent，排在 after（同一层的路径）后面，null 是最前面。挪进自己底下、不在了返回 null */
export function moveBranch(
  nodes: TreeNode[],
  path: string,
  parent: string,
  after: string | null,
): { nodes: TreeNode[]; path: string } | null {
  const shape = shapeOf(nodes);
  const id = shape.nodeOf.get(path);
  const parentId = shape.nodeOf.get(parent);
  const target = nodes.find((node) => node.id === id);
  if (!target || parentId === undefined || shape.smart.has(parent)) return null;
  if (parent === path || parent.startsWith(`${path}/`)) return null;
  const afterId = after === null ? null : (shape.nodeOf.get(after) ?? null);
  const name = freeName(nodes, parentId, target.name ?? "", target.id);
  const { key, nodes: rest } = keyAfter(nodes, target.id, parentId, true, afterId);
  return {
    nodes: rest.map((node) =>
      node.id === target.id ? { ...node, parent: parentId, key, name } : node,
    ),
    path: parent ? `${parent}/${name}` : name,
  };
}

/** 拿掉一个文件夹连同底下的所有节点 */
export function removeBranch(nodes: TreeNode[], path: string): TreeNode[] {
  const id = shapeOf(nodes).nodeOf.get(path);
  if (id === undefined || id === ROOT) return nodes;
  const gone = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of nodes) {
      if (!gone.has(node.id) && gone.has(node.parent)) {
        gone.add(node.id);
        grew = true;
      }
    }
  }
  return nodes.filter((node) => !gone.has(node.id));
}

/**
 * 把一篇放进 folder（UNSORTED 是「未整理」：拿掉它的节点；智能文件夹当根），排在 after 那一篇
 * 后面，null 是最前面
 */
export function placeNote(
  nodes: TreeNode[],
  note: string,
  folder: string,
  after: string | null,
): TreeNode[] {
  const shape = shapeOf(nodes);
  const current = nodes.find((node) => node.kind === "note" && node.note === note);
  if (folder === UNSORTED) return current ? nodes.filter((node) => node !== current) : nodes;
  const parentId = shape.smart.has(folder) ? ROOT : shape.nodeOf.get(folder);
  if (parentId === undefined) return nodes;
  const id = current?.id ?? tempId();
  const afterNode = after === null ? null : (shape.placement.get(after)?.node ?? null);
  const afterId =
    afterNode && nodes.some((node) => node.id === afterNode && node.parent === parentId)
      ? afterNode
      : null;
  const { key, nodes: rest } = keyAfter(nodes, id, parentId, false, afterId);
  const placed: TreeNode = {
    id,
    parent: parentId,
    key,
    kind: "note",
    name: null,
    note,
    query: null,
  };
  return current ? rest.map((node) => (node.id === id ? placed : node)) : [...rest, placed];
}

/**
 * 在 folder 里放一个指着 note 的快捷方式，排在这一层笔记的最前面（和后端的 add_link 一样）。
 * 这个文件夹里已经有指着它的、文件夹不在了、是智能文件夹或未整理：原样返回
 */
export function addShortcut(nodes: TreeNode[], note: string, folder: string): TreeNode[] {
  const shape = shapeOf(nodes);
  const parentId = shape.nodeOf.get(folder);
  if (parentId === undefined || shape.smart.has(folder) || folder === UNSORTED) return nodes;
  if (
    nodes.some((node) => node.kind === "shortcut" && node.parent === parentId && node.note === note)
  )
    return nodes;
  const id = tempId();
  const { key, nodes: rest } = keyAfter(nodes, id, parentId, false, null);
  return [...rest, { id, parent: parentId, key, kind: "shortcut", name: null, note, query: null }];
}

/** 拿掉一个快捷方式（不是快捷方式的不动） */
export function removeShortcut(nodes: TreeNode[], id: string): TreeNode[] {
  return nodes.filter((node) => node.id !== id || node.kind !== "shortcut");
}
