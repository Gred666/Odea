// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { typoraDecorations } from "./MarkdownEditor";
import { markdownSupport } from "./markdownParser";
import { revealIdle, trackEditing } from "./reveal";

const views: EditorView[] = [];

const DOC = "# 标题\n\n正文 **加粗** 完";
const COLLAPSED = "标题正文 加粗 完";
const HEADING_OPEN = "# 标题正文 加粗 完";

function mount(doc: string, anchor: number, tracked = true, state?: EditorState) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state:
      state ??
      EditorState.create({
        doc,
        selection: { anchor },
        extensions: [markdownSupport(), typoraDecorations, ...(tracked ? [trackEditing] : [])],
      }),
  });
  views.push(view);
  return { parent, view };
}

const text = (parent: HTMLElement) => parent.querySelector(".cm-content")?.textContent;
/** 焦点变化等这一轮事件过去才算（reveal.ts 的 schedule） */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * 在正文里按下鼠标。CodeMirror 自己的鼠标选择在 happy-dom 里会同步收到 selectionchange、
 * 套着 dispatch 报错，先发一下 touchstart 让它把这一下当触屏忽略掉 —— reveal.ts 的
 * mousedown 照样收到，选区由测试自己 dispatch
 */
function pressMouse(view: EditorView) {
  view.contentDOM.dispatchEvent(
    Object.assign(new Event("touchstart", { bubbles: true }), { targetTouches: [] }),
  );
  view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
}

function outsideInput() {
  const input = document.createElement("input");
  document.body.append(input);
  return input;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe("不在编辑时不露源码", () => {
  it("keeps the heading under a fresh cursor folded until the editor is focused", async () => {
    const { parent, view } = mount(DOC, 3);
    await settle();
    expect(text(parent)).toBe(COLLAPSED);

    view.focus();
    await settle();
    expect(text(parent)).toBe(HEADING_OPEN);
  });

  it("folds the source back when focus moves to the title, keeping the cursor where it was", async () => {
    const { parent, view } = mount(DOC, 3);
    view.focus();
    await settle();
    expect(text(parent)).toBe(HEADING_OPEN);

    outsideInput().focus();
    await settle();
    expect(text(parent)).toBe(COLLAPSED);
    expect(view.state.selection.main.head).toBe(3);
  });

  it("still opens the source by the cursor without trackEditing (decorations alone)", () => {
    const { parent } = mount(DOC, 3, false);
    expect(text(parent)).toBe(HEADING_OPEN);
  });

  it("starts folded when a cached state that was being edited is reused", async () => {
    const first = mount(DOC, 3);
    first.view.focus();
    await settle();
    expect(text(first.parent)).toBe(HEADING_OPEN);
    const cached = first.view.state;

    const { parent } = mount("", 0, true, cached.update({ effects: revealIdle() }).state);
    expect(text(parent)).toBe(COLLAPSED);
  });
});

describe("鼠标按着时不跟着选区展开", () => {
  it("keeps what was open while the button is down and opens the new spot on release", async () => {
    const bold = DOC.indexOf("加") + 1;
    const { parent, view } = mount(DOC, bold);
    view.focus();
    await settle();
    expect(text(parent)).toBe("标题正文 **加粗** 完");

    // 按在标题上：`#` 先不露，正文的 `**` 也先不收（按下之前的样子）。
    // 用光标不用拖出来的范围：happy-dom 给有焦点的编辑器写范围选区时会同步派发
    // selectionchange，CodeMirror 套着 dispatch 报错（浏览器里是异步的）
    pressMouse(view);
    view.dispatch({ selection: { anchor: 3 }, userEvent: "select.pointer" });
    expect(text(parent)).toBe("标题正文 **加粗** 完");

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    expect(text(parent)).toBe(HEADING_OPEN);
  });

  it("lets go as soon as the keyboard moves the cursor", async () => {
    const { parent, view } = mount(DOC, DOC.length);
    view.focus();
    await settle();
    pressMouse(view);
    view.dispatch({ selection: { anchor: 3 }, userEvent: "select" });
    expect(text(parent)).toBe(HEADING_OPEN);
  });
});
