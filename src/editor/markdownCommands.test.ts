import type { Command, EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  changeHeadingLevel,
  clearMarkdownFormat,
  commandTarget,
  insertFencedBlock,
  insertLink,
  setHeading,
  toggleLinePrefix,
  wrapMarkdown,
} from "./markdownCommands";
import { markdownKeymap } from "./markdownKeymap";

function run(command: Command, doc: string, anchor = 0, head = doc.length) {
  const target = commandTarget(doc, { anchor, head });
  expect(command(target as unknown as EditorView)).toBe(true);
  return target.result();
}

describe("Typora-compatible Markdown commands", () => {
  it("wraps and unwraps inline formatting", () => {
    expect(run(wrapMarkdown("**"), "文字")).toBe("**文字**");
    expect(run(wrapMarkdown("**"), "**文字**", 2, 4)).toBe("文字");
    expect(run(wrapMarkdown("<u>", "</u>"), "下划线")).toBe("<u>下划线</u>");
    expect(run(wrapMarkdown("~~"), "第一行\n第二行")).toBe("~~第一行~~\n~~第二行~~");
  });

  it("nests italics inside bold instead of eating the bold markers", () => {
    // `**粗体**` 里选中「粗体」两侧看起来也像 `*…*`，
    // 不能因此判定为「已是斜体」而去掉一层星号。
    expect(run(wrapMarkdown("*"), "**粗体**", 2, 4)).toBe("***粗体***");
    expect(run(wrapMarkdown("*"), "*斜体*", 1, 3)).toBe("斜体");
  });

  it("inserts an empty marker pair when nothing is selected", () => {
    const target = commandTarget("abc", { anchor: 1 });
    wrapMarkdown("**")(target as unknown as EditorView);
    expect(target.result()).toBe("a****bc");
    expect(target.state.selection.main.head).toBe(3);
  });

  it("changes headings across selected lines without touching the next line", () => {
    expect(run(setHeading(3), "一\n二\n三", 0, 4)).toBe("### 一\n### 二\n三");
    expect(run(changeHeadingLevel(-1), "## 标题")).toBe("# 标题");
    expect(run(setHeading(0), "###### 标题")).toBe("标题");
    expect(run(setHeading(1), "- 列表项")).toBe("# 列表项");
    expect(run(changeHeadingLevel(1), "   ## 缩进标题")).toBe("   ### 缩进标题");
  });

  it("toggles quote and list prefixes", () => {
    const quote = toggleLinePrefix("> ", /^\s*>\s?/);
    expect(run(quote, "一\n二")).toBe("> 一\n> 二");
    expect(run(quote, "> 一\n> 二")).toBe("一\n二");
  });

  it("leaves blank lines out of list toggling", () => {
    const bullet = toggleLinePrefix("- ", /^\s*[-+*]\s+/);
    expect(run(bullet, "一\n\n三")).toBe("- 一\n\n- 三");
  });

  it("inserts links, images and code fences", () => {
    expect(run(insertLink(), "官网")).toBe("[官网](url)");
    expect(run(insertLink(true), "封面")).toBe("![封面](url)");
    expect(run(insertFencedBlock(), "const x = 1")).toBe("```\nconst x = 1\n```");
  });

  it("keeps a code fence on its own lines when inserted mid-line", () => {
    expect(run(insertFencedBlock(), "前面文字", 2, 2)).toBe("前面\n```\n代码\n```\n文字");
  });

  it("keeps repeated link shortcuts idempotent", () => {
    const target = commandTarget("官网", { anchor: 0, head: 2 });
    const link = insertLink();
    link(target as unknown as EditorView);
    link(target as unknown as EditorView);
    link(target as unknown as EditorView);
    expect(target.result()).toBe("[官网](url)");
  });

  it("clears common inline and block formatting", () => {
    expect(run(clearMarkdownFormat(), "## **标题**\n> ~~正文~~")).toBe("标题\n正文");
    expect(run(clearMarkdownFormat(), "**粗体**", 3, 3)).toBe("粗体");
    expect(run(clearMarkdownFormat(), "[官网](https://example.com)")).toBe("官网");
    expect(run(clearMarkdownFormat(), "- [x] 完成")).toBe("完成");
  });

  it("keeps paragraph breaks when clearing formatting", () => {
    // 清除格式只该去掉标记；把几段正文粘成一段是内容损坏。
    expect(run(clearMarkdownFormat(), "## 标题\n\n正文 **粗**\n\n- 项")).toBe(
      "标题\n\n正文 粗\n\n项",
    );
  });

  it("registers the documented Typora formatting shortcuts", () => {
    const keys = new Set(markdownKeymap.map((binding) => binding.key));
    for (const key of [
      "Mod-0",
      "Mod-1",
      "Mod-6",
      "Mod-b",
      "Mod-i",
      "Mod-u",
      "Mod-l",
      "Shift-Mod-k",
      "Mod-Alt-c",
      "Shift-Mod-q",
      "Shift-Mod-[",
      "Shift-Mod-]",
      "Mod-t",
      "Mod-[",
      "Mod-]",
      "Mod-\\",
    ]) {
      expect(keys.has(key), `${key} 未注册`).toBe(true);
    }
  });

  it("leaves Mod-K to the global command palette", () => {
    // 编辑器一旦绑定 Mod-K 就会 preventDefault，
    // 光标在正文里时命令面板永远打不开。
    const keys = new Set(markdownKeymap.map((binding) => binding.key));
    expect(keys.has("Mod-k")).toBe(false);
  });

  it("indents with Mod-] and outdents with Mod-[ like every other editor", () => {
    const bindings = new Map(markdownKeymap.map((binding) => [binding.key, binding]));
    const indent = commandTarget("- a", { anchor: 3 });
    bindings.get("Mod-]")!.run!(indent as unknown as EditorView);
    expect(indent.result()).toBe("  - a");

    const outdent = commandTarget("  - a", { anchor: 5 });
    bindings.get("Mod-[")!.run!(outdent as unknown as EditorView);
    expect(outdent.result()).toBe("- a");
  });
});
