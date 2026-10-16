import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { attachmentInsert, attachmentMarkdown } from "./attachments";
import { markdownSupport } from "./markdownParser";

describe("附件插进正文的写法", () => {
  it("images become ![name](link), other files plain links", () => {
    expect(
      attachmentMarkdown([
        { link: "../附件/屏幕-截图.png", name: "屏幕-截图.png", isImage: true },
        { link: "../附件/报价单.pdf", name: "报价单.pdf", isImage: false },
      ]),
    ).toBe("![屏幕-截图](../附件/屏幕-截图.png)\n[报价单](../附件/报价单.pdf)");
  });

  it("drops brackets from the label so the link stays intact", () => {
    expect(attachmentMarkdown([{ link: "a.png", name: "图[1].png", isImage: true }])).toBe(
      "![图1](a.png)",
    );
  });
});

describe("在列表项里插图片", () => {
  const png = [{ link: "a.png", name: "图.png", isImage: true }];
  const insertAt = (doc: string, pos: number) => {
    const state = EditorState.create({ doc, extensions: markdownSupport() });
    ensureSyntaxTree(state, doc.length, 1000);
    const insert = attachmentInsert(state, pos, png);
    return doc.slice(0, pos) + insert + doc.slice(pos);
  };

  it("keeps the image and the caret line inside the item, at its text column", () => {
    expect(insertAt("1. 文字", 5)).toBe("1. 文字\n   ![图](a.png)\n   ");
    expect(insertAt("- [ ] 待办", 8)).toBe("- [ ] 待办\n      ![图](a.png)\n      ");
    expect(insertAt("- 甲\n  - 乙", 9)).toBe("- 甲\n  - 乙\n    ![图](a.png)\n    ");
  });

  it("goes on from the indented line the last image left the caret on", () => {
    const first = insertAt("1. 文字", 5);
    expect(insertAt(first, first.length)).toBe(`${first}![图](a.png)\n   `);
  });

  it("splits the line in the middle and keeps the rest in the item", () => {
    expect(insertAt("1. 前后", 4)).toBe("1. 前\n   ![图](a.png)\n   后");
  });

  it("stays flush left outside lists", () => {
    expect(insertAt("文字", 2)).toBe("文字\n![图](a.png)\n");
    expect(insertAt("", 0)).toBe("![图](a.png)\n");
  });
});
