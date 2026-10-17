import { describe, expect, it } from "vitest";
import { buildOutline, parseBlocks } from "./markdown";

describe("Markdown outline", () => {
  it("maps H1-H6 to real source lines", () => {
    const outline = buildOutline(
      ["# 一级", "正文", "## 二级", "### 三级", "#### 四级", "##### 五级", "###### 六级"].join(
        "\n",
      ),
    );

    expect(outline.map(({ text, line }) => [text, line])).toEqual([
      ["概览", 1],
      ["一级", 1],
      ["二级", 3],
      ["三级", 4],
      ["四级", 5],
      ["五级", 6],
      ["六级", 7],
    ]);
  });

  it("includes Setext headings", () => {
    const outline = buildOutline("一级标题\n====\n\n二级标题\n----");
    expect(outline.map(({ text, line }) => [text, line])).toEqual([
      ["概览", 1],
      ["一级标题", 1],
      ["二级标题", 4],
    ]);
  });

  it("shows animated emoji short codes as Unicode in the outline", () => {
    const outline = buildOutline("## 冲刺 :odea_fire:\n\n> [!NOTE] 完成 :odea_done:\n> 内容");
    expect(outline.map((item) => item.text)).toContain("冲刺 🔥");
    expect(outline.map((item) => item.text)).toContain("完成 ✅");
  });
});

describe("占位渲染的列表", () => {
  it("keeps empty items and empty tasks as list items, not literal text", () => {
    const blocks = parseBlocks("- [ ] \n- [x] 做完了\n- [ ]\n\n- \n\n1. ");
    expect(blocks).toEqual([
      {
        kind: "ul",
        items: [
          { text: "", checked: false },
          { text: "做完了", checked: true },
          { text: "", checked: false },
        ],
      },
      { kind: "ul", items: [{ text: "", checked: null }] },
      { kind: "ol", items: [{ text: "", checked: null }] },
    ]);
  });

  it("still needs a space between the marker and the text", () => {
    expect(parseBlocks("-不是列表")).toEqual([{ kind: "p", text: "-不是列表" }]);
    expect(parseBlocks("- [ ]紧挨着")).toEqual([
      { kind: "ul", items: [{ text: "[ ]紧挨着", checked: null }] },
    ]);
  });
});
