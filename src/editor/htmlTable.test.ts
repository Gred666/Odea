// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  escapeBlockTags,
  htmlTableData,
  mapAxis,
  parseHtmlTable,
  planHtmlEdits,
} from "./htmlTable";
import {
  type TableData,
  deleteColumns,
  insertColumns,
  insertRows,
  mergeCells,
  moveRows,
  resolveGrid,
  splitCells,
} from "./tableGrid";

/** 语法全览（docs/语法全览.md）里的那张 */
const SOURCE = `<table>
  <caption>HTML 表格的标题</caption>
  <thead>
    <tr><th>HTML 表头</th><th align="right">数值</th></tr>
  </thead>
  <tbody>
    <tr><td style="color:green">合并</td><td rowspan="2">2</td></tr>
    <tr><td>第二行</td></tr>
  </tbody>
  <tfoot>
    <tr><td colspan="2" align="center">colspan 横跨两列</td></tr>
  </tfoot>
</table>`;

function edited(source: string, change: (data: TableData) => TableData, reorder = false): string {
  const table = parseHtmlTable(source)!;
  const data = htmlTableData(table, source);
  let out = source;
  for (const edit of [...planHtmlEdits(table, source, change(data), reorder)].reverse()) {
    out = out.slice(0, edit.from) + edit.insert + out.slice(edit.to);
  }
  return out;
}
const grid = (data: TableData) => resolveGrid(data.cells);

describe("解析 HTML 表格", () => {
  it("rowspan / colspan 解成合并记号，标题、格子的样式和对齐留着", () => {
    const table = parseHtmlTable(SOURCE)!;
    expect(table.header).toEqual(["HTML 表头", "数值"]);
    expect(table.rows).toEqual([
      ["合并", "2"],
      ["第二行", "^"],
      ["colspan 横跨两列", "<"],
    ]);
    expect(table.html!.caption).toBe("HTML 表格的标题");
    const cells = table.html!.rows.flatMap((row) => row.cells);
    expect(cells.find((cell) => cell.row === 0 && cell.col === 1)?.align).toBe("right");
    expect(cells.find((cell) => cell.row === 1 && cell.col === 0)?.style).toBe("color: green");
    const g = grid(htmlTableData(table, SOURCE));
    expect(g.ownerOf(2, 1)).toMatchObject({ row: 1, col: 1, rowSpan: 2 });
    expect(g.ownerOf(3, 1)).toMatchObject({ row: 3, col: 0, colSpan: 2 });
  });

  it("不是简单的表就不认：没有表头、格子里有块级内容、表外有别的、没写闭标签", () => {
    expect(parseHtmlTable("<table><tr><td>a</td></tr><tr><td>b</td></tr></table>")).toBeNull();
    expect(
      parseHtmlTable("<table><tr><th>a</th></tr><tr><td><p>x</p></td></tr></table>"),
    ).toBeNull();
    expect(parseHtmlTable("<table><tr><th>a</th></tr></table>\n<p>后面</p>")).toBeNull();
    expect(parseHtmlTable("<table><tr><th>a<tr><td>b</td></tr></table>")).toBeNull();
    // 两行表头、表头竖着并进表身
    expect(
      parseHtmlTable(
        "<table><thead><tr><th>a</th></tr><tr><th>b</th></tr></thead><tr><td>1</td></tr></table>",
      ),
    ).toBeNull();
    expect(
      parseHtmlTable("<table><tr><th rowspan='2'>a</th><th>b</th></tr><tr><td>1</td></tr></table>"),
    ).toBeNull();
    // tfoot 写在 tbody 前面（浏览器画在最下面，和源码顺序对不上）
    expect(
      parseHtmlTable(
        "<table><thead><tr><th>a</th></tr></thead><tfoot><tr><td>f</td></tr></tfoot><tbody><tr><td>1</td></tr></tbody></table>",
      ),
    ).toBeNull();
  });

  it("没写 thead 也行：第一行全是 th；格子里的 `a < b`、注释照常", () => {
    const source =
      "<table>\n<tr><th>a</th><th>b</th></tr>\n<!-- 注释 -->\n<tr><td>1 < 2</td><td><b>粗</b></td></tr>\n</table>";
    const table = parseHtmlTable(source)!;
    expect(table.rows).toEqual([["1 < 2", "<b>粗</b>"]]);
  });
});

describe("写回 HTML", () => {
  it("只改了字：只换那一格里的字，别的一个字不动", () => {
    expect(
      edited(SOURCE, (data) => {
        data.cells[2]![0] = "第2行";
        return data;
      }),
    ).toBe(SOURCE.replace("第二行", "第2行"));
  });

  it("插行：插在竖着的合并块中间，rowspan 跟着变大；没动的行照抄原文", () => {
    expect(edited(SOURCE, (data) => insertRows(data, grid(data), 2))).toBe(
      SOURCE.replace('rowspan="2"', 'rowspan="3"').replace(
        "    <tr><td>第二行</td></tr>",
        "    <tr><td></td></tr>\n    <tr><td>第二行</td></tr>",
      ),
    );
    // 加在最后：跟着最后一行进 tfoot（浏览器也把它画在最下面）
    expect(edited(SOURCE, (data) => insertRows(data, grid(data), 4))).toContain(
      '<tr><td colspan="2" align="center">colspan 横跨两列</td></tr>\n    <tr><td></td><td></td></tr>\n  </tfoot>',
    );
  });

  it("插列、删列：格子原来的属性跟着它走，合并块跟着变宽变窄", () => {
    const wider = edited(SOURCE, (data) => insertColumns(data, grid(data), 1));
    expect(wider).toContain('<tr><th>HTML 表头</th><th></th><th align="right">数值</th></tr>');
    expect(wider).toContain(
      '<tr><td style="color:green">合并</td><td></td><td rowspan="2">2</td></tr>',
    );
    expect(wider).toContain('<td align="center" colspan="3">colspan 横跨两列</td>');
    // 删掉第一列：被竖着的合并块整行盖住的那一行变成空的 <tr></tr>，还认得出来
    const narrower = edited(SOURCE, (data) => deleteColumns(data, grid(data), 0, 0));
    expect(narrower).toContain('<tr><td rowspan="2">2</td></tr>\n    <tr></tr>');
    expect(parseHtmlTable(narrower)).not.toBeNull();
  });

  it("合并、拆分、搬行", () => {
    expect(
      edited(SOURCE, (data) =>
        mergeCells(data, grid(data), { top: 0, left: 0, bottom: 0, right: 1 }),
      ),
    ).toContain('<tr><th colspan="2">HTML 表头<br>数值</th></tr>');
    const split = edited(SOURCE, (data) =>
      splitCells(data, grid(data), { top: 1, left: 1, bottom: 2, right: 1 }),
    );
    expect(split).toContain('<tr><td style="color:green">合并</td><td>2</td></tr>');
    expect(split).toContain("<tr><td>第二行</td><td></td></tr>");
    const source =
      '<table>\n<tr><th>名</th></tr>\n<tr><td class="a">甲</td></tr>\n<tr><td>乙</td></tr>\n</table>';
    expect(edited(source, (data) => moveRows(data, 2, 2, 1), true)).toBe(
      '<table>\n<tr><th>名</th></tr>\n<tr><td>乙</td></tr>\n<tr><td class="a">甲</td></tr>\n</table>',
    );
  });

  it("格子一行一个的排版：新行照着别的行排", () => {
    const source =
      "<table>\n  <tr>\n    <th>a</th>\n    <th>b</th>\n  </tr>\n  <tr>\n    <td>1</td>\n    <td>2</td>\n  </tr>\n</table>";
    expect(edited(source, (data) => insertRows(data, grid(data), 1))).toBe(
      "<table>\n  <tr>\n    <th>a</th>\n    <th>b</th>\n  </tr>\n  <tr>\n    <td></td>\n    <td></td>\n  </tr>\n  <tr>\n    <td>1</td>\n    <td>2</td>\n  </tr>\n</table>",
    );
  });
});

describe("新旧的行列对上", () => {
  it("先认原地没变的，再按内容找，行列数没变时剩下的按位置", () => {
    expect(mapAxis(["a", "b", "c"], ["b", "c"])).toEqual([1, 2]);
    expect(mapAxis(["a", "b"], ["x", "a", "b"])).toEqual([null, 0, 1]);
    expect(mapAxis(["a", "b", "c"], ["b", "a", "c"])).toEqual([1, 0, 2]);
    expect(mapAxis(["a", "b"], ["a", "改"])).toEqual([0, 1]);
    expect(mapAxis(["", "", "z"], ["", "", "", "z"])).toEqual([0, 1, null, 2]);
  });
});

describe("格子里打出来的块级标签", () => {
  it("写成字，表格还是简单的表；行内标签照常", () => {
    expect(escapeBlockTags("<b>粗</b> <p>段</p> <div>")).toBe("<b>粗</b> &lt;p>段&lt;/p> &lt;div>");
    const source = "<table><tr><th>a</th></tr><tr><td>x</td></tr></table>";
    expect(
      parseHtmlTable(
        edited(source, (data) => {
          data.cells[1]![0] = escapeBlockTags("<p>段</p>");
          return data;
        }),
      ),
    ).not.toBeNull();
  });
});
