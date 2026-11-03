import { describe, expect, it } from "vitest";
import {
  canMerge,
  canMoveRows,
  deleteColumns,
  deleteRows,
  insertColumns,
  insertRows,
  mergeCells,
  moveColumns,
  moveRows,
  pasteCells,
  resolveGrid,
  sortRows,
  splitCells,
} from "./tableGrid";

/** 一张表的格子：每行用 | 分开（只为写测试方便，格子里不带 |） */
const cells = (...rows: string[]) => rows.map((row) => row.split("|").map((cell) => cell.trim()));
const data = (...rows: string[]) => {
  const grid = cells(...rows);
  return { cells: grid, alignments: grid[0]!.map(() => null) };
};
const spans = (rows: string[][]) =>
  resolveGrid(rows).cells.map((cell) => `${cell.row}:${cell.col} ${cell.rowSpan}x${cell.colSpan}`);

describe("合并记号解出网格", () => {
  it("merges `<` into the left and `^` into the cell above", () => {
    const grid = cells("a|b|c", "1|<|x", "^|<|y");
    expect(spans(grid)).toEqual(["0:0 1x1", "0:1 1x1", "0:2 1x1", "1:0 2x2", "1:2 1x1", "2:2 1x1"]);
    expect(resolveGrid(grid).ownerOf(2, 1)).toMatchObject({ row: 1, col: 0 });
  });

  it("accepts `^` for every lower cell of a block too", () => {
    expect(spans(cells("a|b", "1|<", "^|^"))).toEqual(["0:0 1x1", "0:1 1x1", "1:0 2x2"]);
  });

  it("merges header cells sideways, never the header with the body", () => {
    expect(spans(cells("组|<", "^|x"))).toEqual(["0:0 1x2", "1:0 1x1", "1:1 1x1"]);
    // 第一列的 `<`、表头的 `^`：当字
    expect(spans(cells("^|b", "<|x"))).toEqual(["0:0 1x1", "0:1 1x1", "1:0 1x1", "1:1 1x1"]);
  });

  it("treats escaped markers and markers with text as plain text", () => {
    expect(resolveGrid(cells("a|b", "1|\\<", "2|<b")).hasMerges).toBe(false);
  });

  it("drops the markers of a block that isn't a rectangle", () => {
    // L 形：(1,0) 往下并一格，(2,1) 又并进 (2,0)，缺了 (1,1)
    expect(spans(cells("a|b", "1|2", "^|<"))).toEqual([
      "0:0 1x1",
      "0:1 1x1",
      "1:0 1x1",
      "1:1 1x1",
      "2:0 1x1",
      "2:1 1x1",
    ]);
  });

  it("ignores markers when merges are off (csv)", () => {
    expect(resolveGrid(cells("a|b", "1|<"), false).hasMerges).toBe(false);
  });

  it("steps across merged cells by what you see", () => {
    const grid = resolveGrid(cells("a|b|c", "1|<|x", "^|<|y", "3|4|5"));
    expect(grid.step({ row: 1, col: 0 }, "down")).toMatchObject({ row: 3, col: 0 });
    expect(grid.step({ row: 2, col: 2 }, "left")).toMatchObject({ row: 1, col: 0 });
    expect(grid.step({ row: 1, col: 1 }, "right")).toMatchObject({ row: 1, col: 2 });
    expect(grid.next({ row: 1, col: 0 })).toMatchObject({ row: 1, col: 2 });
    expect(grid.next({ row: 1, col: 2 })).toMatchObject({ row: 2, col: 2 });
  });

  it("expands a selection until it cuts no merged cell", () => {
    const grid = resolveGrid(cells("a|b|c", "1|<|x", "^|<|y"));
    expect(grid.expand({ top: 2, left: 1, bottom: 2, right: 2 })).toEqual({
      top: 1,
      left: 0,
      bottom: 2,
      right: 2,
    });
  });
});

describe("网格上的操作", () => {
  it("grows a vertical merge when a row goes inside it", () => {
    const before = data("a|b", "1|x", "^|y");
    const next = insertRows(before, resolveGrid(before.cells), 2);
    expect(next.cells).toEqual(cells("a|b", "1|x", "^|", "^|y"));
    // 插在合并块下沿：普通的一行
    expect(insertRows(before, resolveGrid(before.cells), 3).cells[3]).toEqual(["", ""]);
  });

  it("hands the content down when the first row of a merge is deleted", () => {
    const before = data("a|b|c", "1|<|x", "^|<|y", "3|4|5");
    expect(deleteRows(before, resolveGrid(before.cells), 1, 1).cells).toEqual(
      cells("a|b|c", "1|<|y", "3|4|5"),
    );
  });

  it("widens a horizontal merge when a column goes inside it, hands it right when deleted", () => {
    const before = data("a|b|c", "1|<|x");
    const widened = insertColumns(before, resolveGrid(before.cells), 1);
    expect(widened.cells).toEqual(cells("a||b|c", "1|<|<|x"));
    expect(widened.alignments).toHaveLength(4);
    const tall = data("a|b|c", "1|<|x", "^|<|y");
    expect(deleteColumns(tall, resolveGrid(tall.cells), 0, 0).cells).toEqual(
      cells("b|c", "1|x", "^|y"),
    );
  });

  it("merges a block keeping every bit of text, and splits it back", () => {
    const before = data("a|b", "1|2", "3|");
    const grid = resolveGrid(before.cells);
    expect(canMerge(grid, { top: 0, left: 0, bottom: 1, right: 0 })).toBe(false);
    const merged = mergeCells(before, grid, { top: 1, left: 0, bottom: 2, right: 1 });
    expect(merged.cells).toEqual(cells("a|b", "1<br>2<br>3|<", "^|<"));
    const split = splitCells(merged, resolveGrid(merged.cells), {
      top: 1,
      left: 0,
      bottom: 1,
      right: 0,
    });
    expect(split.cells).toEqual(cells("a|b", "1<br>2<br>3|", "|"));
  });

  it("moves rows and columns, but won't cut through a merge", () => {
    const plain = data("a|b", "1|2", "3|4", "5|6");
    expect(moveRows(plain, 3, 3, 1).cells).toEqual(cells("a|b", "5|6", "1|2", "3|4"));
    expect(moveRows(plain, 1, 1, 4).cells).toEqual(cells("a|b", "3|4", "5|6", "1|2"));
    expect(moveColumns(plain, 1, 1, 0).cells[0]).toEqual(["b", "a"]);
    const merged = data("a|b", "1|2", "^|4", "5|6");
    const grid = resolveGrid(merged.cells);
    expect(canMoveRows(grid, 3, 3, 2)).toBe(false);
    expect(canMoveRows(grid, 3, 3, 1)).toBe(true);
    expect(canMoveRows(grid, 1, 2, 4)).toBe(true);
  });

  it("sorts numbers by value and Chinese by pinyin, empty cells last", () => {
    const before = data("名|数", "张三|10", "李四|9", "|1", "安娜|");
    const plain = (text: string) => text;
    const grid = resolveGrid(before.cells);
    expect(sortRows(before, grid, 1, "asc", plain).cells.map((row) => row[1])).toEqual([
      "数",
      "1",
      "9",
      "10",
      "",
    ]);
    expect(sortRows(before, grid, 0, "asc", plain).cells.map((row) => row[0])).toEqual([
      "名",
      "安娜",
      "李四",
      "张三",
      "",
    ]);
    expect(sortRows(before, grid, 0, "desc", plain).cells[1]![0]).toBe("张三");
  });

  it("pastes a block, growing the table and escaping markers that would reach outside", () => {
    const before = data("a|b", "1|2");
    const grid = resolveGrid(before.cells);
    const { data: next, rect } = pasteCells(
      before,
      grid,
      { top: 1, left: 1, bottom: 1, right: 1 },
      [
        ["^", "y"],
        ["<", "w"],
      ],
    );
    expect(next.cells).toEqual(cells("a|b|", "1|\\^|y", "|\\<|w"));
    expect(rect).toEqual({ top: 1, left: 1, bottom: 2, right: 2 });
    // 一格的东西铺满整个选区
    const filled = pasteCells(before, grid, { top: 0, left: 0, bottom: 1, right: 1 }, [["x"]]);
    expect(filled.data.cells).toEqual(cells("x|x", "x|x"));
  });
});
