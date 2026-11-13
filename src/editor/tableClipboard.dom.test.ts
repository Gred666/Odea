// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { clipboardCells, gfmTableSource, htmlCells, tsvCells } from "./tableClipboard";

describe("剪贴板里的表格", () => {
  it("reads Excel's TSV, quoted cells included", () => {
    expect(tsvCells('名字\t备注\n苹果\t"一行\n两行"\n', "markdown")).toEqual([
      ["名字", "备注"],
      ["苹果", "一行<br>两行"],
    ]);
    expect(tsvCells("a|b\tc\n", "markdown")).toEqual([["a\\|b", "c"]]);
  });

  it("turns rowspan / colspan into merge markers and keeps light formatting", () => {
    const html = `<table>
      <tr><th colspan="2">2026 <b>预算</b></th><th>负责人</th></tr>
      <tr><td rowspan="2"><a href="https://example.com">编辑器</a></td><td>6,000</td><td>张三</td></tr>
      <tr><td>a | b</td><td><code>x</code></td></tr>
    </table>`;
    expect(htmlCells(html, "markdown")).toEqual([
      ["2026 **预算**", "<", "负责人"],
      ["[编辑器](https://example.com)", "6,000", "张三"],
      ["^", "a \\| b", "`x`"],
    ]);
    // CSV 没有合并：盖住的位置空着
    expect(htmlCells(html, "csv")?.[2]).toEqual(["", "a | b", "x"]);
  });

  it("only takes a pasted page as a table when the table is all there is", () => {
    const sheet =
      "<meta charset='utf-8'><style>td{}</style><table><tr><td>1</td><td>2</td></tr></table>";
    const page = "<p>正文</p><table><tr><td>1</td><td>2</td></tr></table>";
    const data = (html: string) => {
      const transfer = new DataTransfer();
      transfer.setData("text/html", html);
      transfer.setData("text/plain", "1\t2");
      return transfer;
    };
    expect(clipboardCells(data(sheet), "markdown", true)).toEqual([["1", "2"]]);
    expect(clipboardCells(data(page), "markdown", true)).toBeNull();
    // 贴进表格里的时候不挑：认出来的就是一块格子
    expect(clipboardCells(data(page), "markdown")).toEqual([["1", "2"]]);
  });

  it("writes a block of cells as an aligned GFM table", () => {
    expect(
      gfmTableSource([
        ["名字", "数"],
        ["苹果", "3"],
      ]),
    ).toBe("| 名字 | 数  |\n| ---- | --- |\n| 苹果 | 3   |");
  });
});
