import { describe, expect, it } from "vitest";
import { parseDelimitedTable, parseMarkdownTable } from "./markdownTable";
import { insertRows, mergeCells, moveRows, resolveGrid } from "./tableGrid";
import { type SourceEdit, planEdits, tableData } from "./tableSource";

/** 把改动套到源码上（从后往前） */
const applyEdits = (source: string, edits: SourceEdit[]) =>
  [...edits]
    .sort((a, b) => b.from - a.from)
    .reduce((text, edit) => text.slice(0, edit.from) + edit.insert + text.slice(edit.to), source);

describe("写回源码", () => {
  it("only touches the cells that changed", () => {
    const source = "| 名字   | 状态 |\n| :----- | ---- |\n| 苹果   | 好   |";
    const table = parseMarkdownTable(source)!;
    const next = tableData(table, source, "markdown");
    next.cells[1]![1] = "很好";
    const edits = planEdits(table, source, "markdown", next);
    expect(edits).toEqual([{ from: source.indexOf("好"), to: source.indexOf("好"), insert: "很" }]);
    expect(applyEdits(source, edits)).toBe(
      "| 名字   | 状态 |\n| :----- | ---- |\n| 苹果   | 很好   |",
    );
  });

  it("writes a merge as markers, cell by cell", () => {
    const source = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |";
    const table = parseMarkdownTable(source)!;
    const data = tableData(table, source, "markdown");
    const next = mergeCells(data, resolveGrid(data.cells), {
      top: 1,
      left: 0,
      bottom: 2,
      right: 1,
    });
    expect(applyEdits(source, planEdits(table, source, "markdown", next))).toBe(
      "| a | b |\n|---|---|\n| 1<br>2<br>3<br>4 | < |\n| ^ | < |",
    );
  });

  it("inserts and moves rows without reformatting the lines it didn't touch", () => {
    const source = "| 名字 | 数 |\n|:-----|---:|\n| 苹果 |  3 |\n| 梨   | 12 |";
    const table = parseMarkdownTable(source)!;
    const data = tableData(table, source, "markdown");
    const inserted = insertRows(data, resolveGrid(data.cells), 2);
    const edits = planEdits(table, source, "markdown", inserted);
    // 只插了一行：一处改动，前后的行原样
    expect(edits).toHaveLength(1);
    expect(applyEdits(source, edits)).toBe(
      "| 名字 | 数 |\n|:-----|---:|\n| 苹果 |  3 |\n|   |   |\n| 梨   | 12 |",
    );
    const moved = moveRows(data, 2, 2, 1);
    expect(applyEdits(source, planEdits(table, source, "markdown", moved, "", true))).toBe(
      "| 名字 | 数 |\n|:-----|---:|\n| 梨   | 12 |\n| 苹果 |  3 |",
    );
  });

  it("keeps the quote markers of a table inside a blockquote", () => {
    // 表格源码从第一行的 `> ` 之后开始，后面几行自己带着 `> `
    const source = "| a | b |\n> |---|---|\n> | 1 | 2 |";
    const table = parseMarkdownTable(source)!;
    expect(table.rows).toEqual([["1", "2"]]);
    const data = tableData(table, source, "markdown");
    const next = insertRows(data, resolveGrid(data.cells), 2);
    next.cells[1]![0] = "一";
    expect(applyEdits(source, planEdits(table, source, "markdown", next, "> "))).toBe(
      "| a | b |\n> |---|---|\n> | 一 | 2 |\n> |   |   |",
    );
  });

  it("reformats the whole table when the columns change", () => {
    const source = "| a | b |\n|---|--:|\n| 1 | 2 |";
    const table = parseMarkdownTable(source)!;
    const data = tableData(table, source, "markdown");
    const next = {
      cells: data.cells.map((row) => [row[0]!, "", row[1]!]),
      alignments: [null, null, "right" as const],
    };
    expect(applyEdits(source, planEdits(table, source, "markdown", next))).toBe(
      "| a   |     |   b |\n| --- | --- | --: |\n| 1   |     |   2 |",
    );
  });

  it("changes only the delimiter cell for an alignment", () => {
    const source = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const table = parseMarkdownTable(source)!;
    const next = tableData(table, source, "markdown");
    next.alignments[1] = "center";
    expect(applyEdits(source, planEdits(table, source, "markdown", next))).toBe(
      "| a | b |\n| --- | :-: |\n| 1 | 2 |",
    );
  });

  it("quotes csv fields and adds csv rows", () => {
    const source = "名字,备注\n苹果,甜";
    const table = parseDelimitedTable(source, ",")!;
    const data = tableData(table, source, "csv");
    expect(data.cells[1]).toEqual(["苹果", "甜"]);
    const next = insertRows(data, resolveGrid(data.cells, false), 2);
    next.cells[2] = ["梨", "脆, 甜"];
    expect(applyEdits(source, planEdits(table, source, "csv", next))).toBe(
      '名字,备注\n苹果,甜\n梨,"脆, 甜"',
    );
  });
});
