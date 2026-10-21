import { describe, expect, it } from "vitest";
import {
  ROOT,
  UNSORTED,
  addBranch,
  addShortcut,
  keyBetween,
  moveBranch,
  placeNote,
  removeBranch,
  removeShortcut,
  renameBranch,
  shapeOf,
} from "./tree";
import type { TreeNode } from "./types";

const folder = (id: string, parent: string, key: string, name: string): TreeNode => ({
  id,
  parent,
  key,
  kind: "folder",
  name,
  note: null,
  query: null,
});
const note = (id: string, parent: string, key: string, noteId: string): TreeNode => ({
  id,
  parent,
  key,
  kind: "note",
  name: null,
  note: noteId,
  query: null,
});

describe("排序键（和 Rust 的 key_between 同一个算法）", () => {
  it("和 Rust 单测里的几个值一样", () => {
    expect(keyBetween(null, null)).toBe("i");
    expect(keyBetween("i", null)).toBe("r");
    expect(keyBetween(null, "i")).toBe("9");
    expect(keyBetween("a", "b")).toBe("ai");
    expect(keyBetween("a", "ab")).toBe("a5");
    expect(keyBetween("az", "b")).toBe("azi");
    expect(keyBetween("a", "b5")).toBe("b");
  });

  it("一直往同一处插也插得进、顺序对", () => {
    let low = "a";
    for (let i = 0; i < 200; i++) {
      const mid = keyBetween(low, "b");
      expect(low < mid && mid < "b").toBe(true);
      expect(mid.endsWith("0")).toBe(false);
      low = mid;
    }
    let high = "b";
    for (let i = 0; i < 200; i++) {
      const mid = keyBetween(null, high);
      expect(mid < high && mid.length > 0 && !mid.endsWith("0")).toBe(true);
      high = mid;
    }
  });
});

describe("树摊开成路径", () => {
  const nodes: TreeNode[] = [
    folder("a", ROOT, "r", "交易"),
    folder("b", "a", "i", "学习"),
    folder("c", ROOT, "i", "读书"),
    {
      id: "q",
      parent: ROOT,
      key: "v",
      kind: "query",
      name: "近期",
      note: null,
      query: "updated:7d",
    },
    note("n1", "b", "i", "note-1"),
    note("n2", ROOT, "i", "note-2"),
    // 同一篇两处：只认前一处（后端理顺过，这里不该出现，出现了也不乱）
    note("n3", "c", "i", "note-1"),
  ];

  it("父在前、子在后，同一层按排序键；智能文件夹也在里面", () => {
    const shape = shapeOf(nodes);
    expect(shape.folders).toEqual(["读书", "交易", "交易/学习", "近期"]);
    expect(shape.smart.get("近期")).toBe("updated:7d");
    expect(shape.placement.get("note-2")?.folder).toBe("");
    expect(["读书", "交易/学习"]).toContain(shape.placement.get("note-1")?.folder);
    expect(shape.nodeOf.get("")).toBe(ROOT);
    expect(shape.nodeOf.get("交易/学习")).toBe("b");
  });

  it("新建、改名、挪动、删除都按路径，和后端一样的规矩", () => {
    const added = addBranch(nodes, "交易", "学习");
    expect(added?.path).toBe("交易/学习 2");
    expect(shapeOf(added!.nodes).folders.indexOf("交易/学习 2")).toBeLessThan(
      shapeOf(added!.nodes).folders.indexOf("交易/学习"),
    );
    expect(addBranch(nodes, "近期", "x")).toBeNull();
    expect(addBranch(nodes, "没有", "x")).toBeNull();

    const renamed = renameBranch(nodes, "交易", "读书");
    expect(renamed?.path).toBe("读书 2");
    expect(shapeOf(renamed!.nodes).folders).toContain("读书 2/学习");

    const moved = moveBranch(nodes, "交易/学习", "", "读书");
    expect(moved?.path).toBe("学习");
    expect(shapeOf(moved!.nodes).folders.slice(0, 2)).toEqual(["读书", "学习"]);
    expect(moveBranch(nodes, "交易", "交易/学习", null)).toBeNull();

    const removed = removeBranch(nodes, "交易");
    expect(shapeOf(removed).folders).toEqual(["读书", "近期"]);
    expect(removed.some((node) => node.id === "n1")).toBe(false);
  });

  it("笔记放进文件夹、排顺序、移到未整理", () => {
    let next = placeNote(nodes, "note-9", "交易", null);
    next = placeNote(next, "note-8", "交易", null);
    const order = (list: TreeNode[]) =>
      [...shapeOf(list).placement.entries()]
        .filter(([, place]) => place.folder === "交易")
        .sort(([, a], [, b]) => (a.key < b.key ? -1 : 1))
        .map(([id]) => id);
    expect(order(next)).toEqual(["note-8", "note-9"]);
    next = placeNote(next, "note-8", "交易", "note-9");
    expect(order(next)).toEqual(["note-9", "note-8"]);
    next = placeNote(next, "note-9", UNSORTED, null);
    expect(shapeOf(next).placement.has("note-9")).toBe(false);
    // 智能文件夹里放不了：放到根上
    next = placeNote(next, "note-7", "近期", null);
    expect(shapeOf(next).placement.get("note-7")?.folder).toBe("");
  });
});

describe("快捷方式（docs/仓库与启动器.md §7.5）", () => {
  const link = (id: string, parent: string, key: string, noteId: string): TreeNode => ({
    ...note(id, parent, key, noteId),
    kind: "shortcut",
  });
  const nodes = [
    folder("a", ROOT, "i", "交易"),
    folder("b", ROOT, "r", "复盘"),
    note("n1", "a", "i", "周复盘"),
  ];

  it("不算笔记放在哪，也不是文件夹", () => {
    const shape = shapeOf([...nodes, link("s1", "b", "i", "周复盘")]);
    expect(shape.placement.get("周复盘")?.folder).toBe("交易");
    expect(shape.folders).toEqual(["交易", "复盘"]);
    expect(shape.shortcuts.get("复盘")).toEqual([{ node: "s1", note: "周复盘", key: "i" }]);
  });

  it("加在这一层笔记的最前面，同一个文件夹里不加两个；未整理、不在了的不加", () => {
    const added = addShortcut(nodes, "周复盘", "复盘");
    expect(
      shapeOf(added)
        .shortcuts.get("复盘")
        ?.map((s) => s.note),
    ).toEqual(["周复盘"]);
    expect(addShortcut(added, "周复盘", "复盘")).toBe(added);
    expect(addShortcut(nodes, "周复盘", UNSORTED)).toBe(nodes);
    expect(addShortcut(nodes, "周复盘", "没有")).toBe(nodes);
    const id = shapeOf(added).shortcuts.get("复盘")?.[0]?.node as string;
    expect(shapeOf(removeShortcut(added, id)).shortcuts.size).toBe(0);
    // 不是快捷方式的不动
    expect(removeShortcut(added, "n1")).toEqual(added);
  });
});
