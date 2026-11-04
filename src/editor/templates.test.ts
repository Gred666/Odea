import { registerTemplates } from "@/plugins/registry";
import { EditorSelection, EditorState } from "@codemirror/state";
import { FileText } from "lucide-react";
import { describe, expect, it } from "vitest";
import {
  CARET,
  applyTemplate,
  hasOtherContent,
  isTemplateTrigger,
  openTasksOf,
  templateTrigger,
  templatesFor,
} from "./templates";

/* 模板的触发和插入。模板本身由插件交来（日程那几套的测试在 plugins/journal/templates.test.ts） */

/** 光标放在 `|` 处（去掉它）的状态 */
function stateAt(markdown: string): EditorState {
  const head = markdown.indexOf("|");
  return EditorState.create({
    doc: markdown.replace("|", ""),
    selection: EditorSelection.cursor(head),
  });
}

/** 插入 / 替换之后的正文，光标处标 `|` */
function applied(markdown: string, source: string, mode: "insert" | "replace"): string {
  const state = stateAt(markdown);
  const trigger = templateTrigger(state);
  expect(trigger).not.toBeNull();
  const next = state.update(applyTemplate(state, trigger!, source, mode)).state;
  const head = next.selection.main.head;
  const doc = next.doc.toString();
  return `${doc.slice(0, head)}|${doc.slice(head)}`;
}

describe("触发词", () => {
  it("accepts /模板 and its aliases, including the IME's 、 for /", () => {
    for (const line of [
      "/模板",
      "/model",
      "/MODEL",
      "/Template",
      "/mb",
      "/tpl",
      "、模板",
      "、mb",
    ]) {
      expect(isTemplateTrigger(line), line).toBe(true);
    }
    expect(isTemplateTrigger("  /模板  ")).toBe(true);
  });

  it("only fires on a line that holds nothing but the trigger", () => {
    for (const line of [
      "/模板 周",
      "看 /模板",
      "/models",
      "模板",
      "//模板",
      "- /模板",
      "> /模板",
    ]) {
      expect(isTemplateTrigger(line), line).toBe(false);
    }
  });

  it("needs a single empty caret at the end of the trigger", () => {
    expect(templateTrigger(stateAt("前言\n/模板|\n后记"))).toEqual({ from: 3, to: 6 });
    expect(templateTrigger(stateAt("/模板 |"))).toEqual({ from: 0, to: 4 });
    expect(templateTrigger(stateAt("/模|板"))).toBeNull();
    const selected = EditorState.create({
      doc: "/模板",
      selection: EditorSelection.range(0, 3),
    });
    expect(templateTrigger(selected)).toBeNull();
  });
});

describe("模板的登记（贡献点 templates）", () => {
  it("lists a scope's templates in the order they were registered, once", () => {
    const template = (id: string, scope: string) => ({
      id,
      scope,
      name: id,
      description: "",
      icon: FileText,
      build: () => `# ${id}${CARET}`,
    });
    registerTemplates([template("test-a", "test.scope"), template("test-b", "test.scope")]);
    // 同一个 id 再交一次不重复
    registerTemplates([template("test-a", "test.scope"), template("test-c", "test.other")]);
    expect(templatesFor("test.scope").map((t) => t.id)).toEqual(["test-a", "test-b"]);
    expect(templatesFor("test.other").map((t) => t.id)).toEqual(["test-c"]);
    expect(templatesFor("test.none")).toEqual([]);
  });
});

describe("插入", () => {
  const source = `## 标题\n\n- ${CARET}`;

  it("turns an empty document into the template, caret where the template says", () => {
    expect(applied("/模板|", source, "insert")).toBe("## 标题\n\n- |");
  });

  it("keeps a blank line between the template and the text around it", () => {
    expect(applied("上面\n/模板|\n下面", source, "insert")).toBe("上面\n\n## 标题\n\n- |\n\n下面");
    expect(applied("上面\n\n/模板|\n\n下面", source, "insert")).toBe(
      "上面\n\n## 标题\n\n- |\n\n下面",
    );
  });

  it("puts the caret at the end when the template has no caret mark", () => {
    expect(applied("/模板|", "## 标题", "insert")).toBe("## 标题|");
  });

  it("tags the edit so it does not reopen the picker", () => {
    const state = stateAt("/模板|");
    const spec = applyTemplate(state, templateTrigger(state)!, source, "insert");
    expect(spec.userEvent).toBe("input.template");
  });
});

describe("替换全文", () => {
  const source = `## 今天\n\n- ${CARET}`;

  it("only offers to replace when there is something besides the trigger", () => {
    const empty = stateAt("\n/模板|\n");
    expect(hasOtherContent(empty, templateTrigger(empty)!)).toBe(false);
    const written = stateAt("昨天的事\n/模板|");
    expect(hasOtherContent(written, templateTrigger(written)!)).toBe(true);
  });

  it("carries unfinished tasks into 待续 and drops the rest", () => {
    const yesterday = [
      "## 最重要的三件事",
      "",
      "- [x] 做完了的",
      "- [ ] 没做完的",
      "  - [ ] 子任务",
      "1. [ ] 编号的",
      "- [ ] ",
      "",
      "/模板|",
    ].join("\n");
    expect(applied(yesterday, source, "replace")).toBe(
      "## 今天\n\n- |\n\n## 待续\n\n- [ ] 没做完的\n- [ ] 子任务\n- [ ] 编号的",
    );
  });

  it("keeps the front matter on top", () => {
    const doc = "---\ntags: 日记\n---\n\n旧内容\n/模板|";
    expect(applied(doc, source, "replace")).toBe("---\ntags: 日记\n---\n\n## 今天\n\n- |");
  });
});

describe("未完成任务", () => {
  it("normalises, dedupes and skips fenced code", () => {
    const markdown = [
      "- [ ] 写周报 @2026-09-28",
      "* [ ] 写周报 @2026-09-28",
      "   + [ ]   缩进的  ",
      "- [X] 勾上了",
      "- [ ]没有空格",
      "```md",
      "- [ ] 代码里的",
      "```",
      "- [ ] 代码后面的",
    ].join("\n");
    expect(openTasksOf(markdown)).toEqual([
      "- [ ] 写周报 @2026-09-28",
      "- [ ] 缩进的",
      "- [ ] 代码后面的",
    ]);
  });
});
