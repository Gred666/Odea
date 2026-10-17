import { buildOutline } from "@/lib/markdown";
import { describe, expect, it } from "vitest";
import { foldableUnder, outlineTree, visibleId } from "./outlineTree";

const DOC = [
  "# 文档标题",
  "",
  "## 第一节",
  "",
  "### 小节 1.1",
  "",
  "> [!NOTE] 提醒",
  "> 内容",
  "",
  "## 第二节",
  "",
  "### 小节",
  "",
  "## 第三节",
  "",
  "### 小节",
].join("\n");

/** 树摊成「缩进 + 标题」，好比 */
function shape(markdown: string) {
  const tree = outlineTree(buildOutline(markdown));
  const out: string[] = [];
  const walk = (nodes: typeof tree.roots, indent: string) => {
    for (const node of nodes) {
      out.push(`${indent}${node.item.text}`);
      walk(node.children, `${indent}  `);
    }
  };
  walk(tree.roots, "");
  return out;
}

describe("目录树的层级", () => {
  it("nests by the real heading levels, callouts under their section", () => {
    expect(shape(DOC)).toEqual([
      "文档标题",
      "  第一节",
      "    小节 1.1",
      "      提醒",
      "  第二节",
      "    小节",
      "  第三节",
      "    小节",
    ]);
  });

  it("starts from the shallowest heading in the document and indents at most three steps", () => {
    const items = buildOutline("## 甲\n\n### 乙\n\n#### 丙\n\n##### 丁\n\n## 戊");
    expect(items.map((item) => [item.text, item.depth, item.level])).toEqual([
      ["概览", 0, 1],
      ["甲", 1, 1],
      ["乙", 2, 2],
      ["丙", 3, 3],
      ["丁", 4, 3],
      ["戊", 1, 1],
    ]);
  });

  it("gives Setext headings their own levels", () => {
    const items = buildOutline("一级\n===\n\n二级\n---\n\n### 三级");
    expect(items.map((item) => [item.text, item.depth])).toEqual([
      ["概览", 0],
      ["一级", 1],
      ["二级", 2],
      ["三级", 3],
    ]);
  });

  it("skips comments inside code fences and the front matter", () => {
    const markdown = [
      "---",
      "title: 不是标题",
      "---",
      "",
      "## 真标题",
      "",
      "```sh",
      "# 这是注释",
      "```",
      "",
      "~~~",
      "## 也不是",
      "~~~",
    ].join("\n");
    expect(buildOutline(markdown).map((item) => item.text)).toEqual(["概览", "真标题"]);
  });

  it("keeps the overview out of the tree and lists what can fold", () => {
    const tree = outlineTree(buildOutline(DOC));
    expect(tree.overview?.text).toBe("概览");
    expect(tree.foldable).toEqual([
      "1:文档标题#0",
      "2:第一节#0",
      "3:小节 1.1#0",
      "2:第二节#0",
      "2:第三节#0",
    ]);
  });

  it("keys headings by text, so adding a section above does not shift what is folded", () => {
    const before = outlineTree(buildOutline(DOC));
    const after = outlineTree(buildOutline(`## 新加的一节\n\n${DOC}`));
    const keyOf = (tree: typeof before, text: string) =>
      [...tree.byId.values()].find((node) => node.item.text === text)?.key;
    expect(keyOf(after, "第二节")).toBe(keyOf(before, "第二节"));
    // 同名的按第几个区分
    const small = [...before.byId.values()]
      .filter((node) => node.item.text === "小节")
      .map((node) => node.key);
    expect(small).toEqual(["3:小节#0", "3:小节#1"]);
  });
});

describe("收起时高亮落在哪", () => {
  const tree = outlineTree(buildOutline(DOC));
  const idOf = (text: string) =>
    [...tree.byId.values()].find((node) => node.item.text === text)!.item.id;

  it("moves the highlight to the outermost folded ancestor", () => {
    const active = idOf("提醒");
    expect(visibleId(tree, active, new Set())).toBe(active);
    expect(visibleId(tree, active, new Set(["3:小节 1.1#0"]))).toBe(idOf("小节 1.1"));
    expect(visibleId(tree, active, new Set(["3:小节 1.1#0", "2:第一节#0"]))).toBe(idOf("第一节"));
    // 收起的是它自己：它自己看得见
    expect(visibleId(tree, idOf("第一节"), new Set(["2:第一节#0"]))).toBe(idOf("第一节"));
  });

  it("collects every foldable level under a node for Alt + click", () => {
    const first = tree.byId.get(idOf("第一节"))!;
    expect(foldableUnder(first)).toEqual(["2:第一节#0", "3:小节 1.1#0"]);
  });
});
