// @vitest-environment happy-dom

import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { MotionGlobalConfig } from "motion/react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarkdownEditor, clearEditorStateCache } from "./MarkdownEditor";
import type { TemplateContext } from "./templates";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom 里 Motion 取消原生动画会留下没人接的 AbortError；这里测的是逻辑，不是动效
MotionGlobalConfig.skipAnimations = true;

/*
 * 在一行里只写 `/模板`：编辑器弹出这篇文档能用的模板，焦点留在正文里，
 * 方向键 / 回车 / Esc 由编辑器转给选择器。
 */

const DAY: TemplateContext = { scope: "day", date: "2026-09-27", today: "2026-09-27" };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  clearEditorStateCache();
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function openEditor(markdown: string, templateContext: TemplateContext | null = DAY) {
  await act(async () => {
    root = createRoot(host);
    root.render(
      <MarkdownEditor
        initialMarkdown={markdown}
        onSave={async () => {}}
        outlineItems={[]}
        onOutlineHandle={() => {}}
        templateContext={templateContext ?? undefined}
      />,
    );
  });
  const content = host.querySelector<HTMLElement>(".cm-content")!;
  const view = EditorView.findFromDOM(content)!;
  view.focus();
  return { content, view };
}

/** CodeMirror 在 requestAnimationFrame 里跑测量，选择器从那里打开 */
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 40)));

async function type(view: EditorView, text: string, userEvent = "input.type") {
  await act(async () => {
    const head = view.state.selection.main.head;
    view.dispatch({
      changes: { from: head, insert: text },
      selection: { anchor: head + text.length },
      userEvent,
    });
  });
  await settle();
}

async function press(content: HTMLElement, init: KeyboardEventInit) {
  await act(async () => {
    content.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
  await settle();
}

const picker = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="插入模板"]');
const options = () => [...(picker()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
const activeName = () =>
  options()
    .find((option) => option.getAttribute("aria-selected") === "true")
    ?.querySelector("span > span")?.textContent;

describe("模板选择器", () => {
  it("opens under /模板 with this document's templates and inserts the chosen one", async () => {
    const { content, view } = await openEditor("");
    await type(view, "/模板");
    expect(picker()).not.toBeNull();
    expect(options().map((option) => option.dataset.template)).toEqual([
      "day-plan",
      "day-timeblock",
      "day-review",
      "day-journal",
    ]);
    // 焦点还在正文里
    expect(view.hasFocus).toBe(true);
    expect(activeName()).toBe("今日计划");

    await press(content, { key: "ArrowDown" });
    await press(content, { key: "ArrowDown" });
    expect(activeName()).toBe("晚间复盘");
    await press(content, { key: "Enter" });

    expect(picker()).toBeNull();
    const doc = view.state.doc.toString();
    expect(doc.startsWith("## :odea_moon: 晚间复盘\n")).toBe(true);
    expect(doc).not.toContain("/模板");
    // 光标停在「做成了」后面
    const head = view.state.selection.main.head;
    expect(doc.slice(0, head).endsWith("- **做成了**：")).toBe(true);
  });

  it("also answers to 、模板 (what / types under a Chinese IME)", async () => {
    const { view } = await openEditor("");
    await type(view, "、模板");
    expect(picker()).not.toBeNull();
  });

  it("closes on Escape and leaves the text alone", async () => {
    const { content, view } = await openEditor("");
    await type(view, "/model");
    expect(picker()).not.toBeNull();
    await press(content, { key: "Escape" });
    expect(picker()).toBeNull();
    expect(view.state.doc.toString()).toBe("/model");
  });

  it("closes when typing carries on past the trigger", async () => {
    const { view } = await openEditor("");
    await type(view, "/mb");
    expect(picker()).not.toBeNull();
    await type(view, "x");
    expect(picker()).toBeNull();
  });

  it("does not reopen when undo brings the trigger back", async () => {
    const { content, view } = await openEditor("");
    await type(view, "/模板");
    await press(content, { key: "Enter" });
    expect(view.state.doc.toString()).toContain("最重要的三件事");
    await act(async () => {
      undo(view);
    });
    await settle();
    expect(view.state.doc.toString()).toBe("/模板");
    expect(picker()).toBeNull();
  });

  it("replaces the whole document with Shift+Enter, carrying unfinished tasks", async () => {
    const { content, view } = await openEditor("## 昨天\n\n- [x] 做完了\n- [ ] 没做完\n");
    await act(async () => {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    });
    await type(view, "/模板");
    expect(picker()?.textContent).toContain("Shift+替换全文，带上 1 项未完成");
    await press(content, { key: "Enter", shiftKey: true });
    const doc = view.state.doc.toString();
    expect(doc.startsWith("> [!今日主线]\n> \n")).toBe(true);
    expect(doc).not.toContain("昨天");
    expect(doc.endsWith("## 待续\n\n- [ ] 没做完")).toBe(true);
  });

  it("offers only week templates in a week goal", async () => {
    const { view } = await openEditor("", {
      scope: "week",
      date: "2026-09-28",
      today: "2026-09-27",
    });
    await type(view, "/模板");
    expect(options().map((option) => option.dataset.template)).toEqual([
      "week-plan",
      "week-review",
      "week-habits",
    ]);
    expect(picker()?.textContent).toContain("第 40 周");
    // 空文档没有「替换全文」
    expect(picker()?.textContent).not.toContain("替换全文");
  });

  it("stays out of notes", async () => {
    const { view } = await openEditor("", null);
    await type(view, "/模板");
    expect(picker()).toBeNull();
    expect(host.querySelector(".cm-placeholder")).toBeNull();
  });

  it("hints at templates in an empty document", async () => {
    await openEditor("");
    expect(host.querySelector(".cm-placeholder")?.textContent).toBe(
      "写下今天要做的事，或输入 /模板 从模板开始",
    );
  });
});
