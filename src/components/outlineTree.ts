import type { OutlineItem } from "@/data/types";

/* ============================================================
   目录树的树形结构和收起（技术方案 §12.9）。纯函数，Outline.tsx 用。

   buildOutline 给的是一列带 depth 的条目；一条的下级是它后面 depth 更深的那些，
   到下一条 depth 不比它深的为止。「概览」（depth 0）不当谁的父亲，单独放。
   ============================================================ */

export interface OutlineNode {
  item: OutlineItem;
  /**
   * 收起状态按它记：层级 + 标题字 + 第几个同名的。条目的 id 带着序号（前面加一节就全变了），
   * 不能拿来记
   */
  key: string;
  parent: OutlineNode | null;
  children: OutlineNode[];
}

export interface OutlineTree {
  /** 「概览」；没有标题时整个目录都是空的 */
  overview: OutlineItem | null;
  roots: OutlineNode[];
  /** 按 id 找节点 */
  byId: Map<string, OutlineNode>;
  /** 有下级、能收起的那些节点的键 */
  foldable: string[];
}

export function outlineTree(items: readonly OutlineItem[]): OutlineTree {
  const roots: OutlineNode[] = [];
  const byId = new Map<string, OutlineNode>();
  const seen = new Map<string, number>();
  const stack: OutlineNode[] = [];
  let overview: OutlineItem | null = null;
  for (const item of items) {
    if (item.depth <= 0) {
      overview = item;
      continue;
    }
    const base = `${item.depth}:${item.text}`;
    const nth = seen.get(base) ?? 0;
    seen.set(base, nth + 1);
    while (stack.length && stack.at(-1)!.item.depth >= item.depth) stack.pop();
    const parent = stack.at(-1) ?? null;
    const node: OutlineNode = { item, key: `${base}#${nth}`, parent, children: [] };
    (parent ? parent.children : roots).push(node);
    byId.set(item.id, node);
    stack.push(node);
  }
  const foldable = [...byId.values()]
    .filter((node) => node.children.length > 0)
    .map((node) => node.key);
  return { overview, roots, byId, foldable };
}

/**
 * 高亮该落在哪一条：当前小节在收起的范围里时，落到最外面那一条收起的祖先上
 * （它下面的都看不见）；没被收起就是它自己
 */
export function visibleId(
  tree: OutlineTree,
  activeId: string | null,
  collapsed: ReadonlySet<string>,
): string | null {
  const node = activeId ? tree.byId.get(activeId) : undefined;
  if (!node) return activeId;
  const chain: OutlineNode[] = [];
  for (let up = node.parent; up; up = up.parent) chain.unshift(up);
  return chain.find((ancestor) => collapsed.has(ancestor.key))?.item.id ?? activeId;
}

/** 这一条连同下面各层里能收起的（Alt + 点箭头一起收 / 展开） */
export function foldableUnder(node: OutlineNode): string[] {
  const out: string[] = [];
  const walk = (current: OutlineNode) => {
    if (!current.children.length) return;
    out.push(current.key);
    current.children.forEach(walk);
  };
  walk(node);
  return out;
}
