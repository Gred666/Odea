// @vitest-environment happy-dom

import { cursorCharLeft, deleteCharBackward } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MotionGlobalConfig } from "motion/react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor, insertAnimatedEmoji, typoraDecorations } from "./MarkdownEditor";
import { animatedEmojiFor, takeIntro } from "./animatedEmoji";
import { markdownSupport } from "./markdownParser";
import { selectionEntersRange } from "./markdownStyleRegistry";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom 里 Motion 取消原生动画会留下没人接的 AbortError；这里测的是逻辑，不是动效
MotionGlobalConfig.skipAnimations = true;

const views: EditorView[] = [];

function mount(doc: string, anchor: number, head = anchor) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: Math.min(anchor, doc.length), head: Math.min(head, doc.length) },
      extensions: [markdownSupport(), typoraDecorations],
    }),
  });
  views.push(view);
  return { parent, view };
}

const widgets = (parent: HTMLElement) =>
  [...parent.querySelectorAll<HTMLElement>(".cm-odea-ae")].map((node) => node.dataset.emoji);

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe("选区规则", () => {
  const range = (from: number, to = from) => ({ from, to, head: to, empty: from === to });

  it("only opens the source when the caret is strictly inside or the selection cuts it", () => {
    // 表情占 [4, 14)
    expect(selectionEntersRange([range(4)], 4, 14)).toBe(false);
    expect(selectionEntersRange([range(14)], 4, 14)).toBe(false);
    expect(selectionEntersRange([range(5)], 4, 14)).toBe(true);
    expect(selectionEntersRange([range(0, 20)], 4, 14)).toBe(false);
    expect(selectionEntersRange([range(4, 14)], 4, 14)).toBe(false);
    expect(selectionEntersRange([range(6, 20)], 4, 14)).toBe(true);
    expect(selectionEntersRange([range(0, 8)], 4, 14)).toBe(true);
    expect(selectionEntersRange([range(0, 4)], 4, 14)).toBe(false);
  });
});

describe("编辑器里的动态表情", () => {
  const doc = "今天 :odea_fire: 冲";
  /** 短码后面紧挨着的位置 */
  const end = doc.indexOf(" 冲");

  it("renders the short code as an animated emoji and keeps the source intact", () => {
    const { parent, view } = mount(doc, 0);
    expect(widgets(parent)).toEqual(["fire"]);
    expect(parent.querySelector(".cm-odea-ae svg.odea-ae-svg")).not.toBeNull();
    expect(parent.querySelector(".cm-odea-ae")?.getAttribute("aria-label")).toBe("冲");
    expect(parent.querySelector(".cm-content")?.textContent).not.toContain(":odea_fire:");
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("stays an emoji with the caret right after it — just like a character", () => {
    const { parent } = mount(doc, end);
    expect(widgets(parent)).toEqual(["fire"]);
  });

  it("shows the source while the caret is inside and hides it again after", () => {
    const { parent, view } = mount(doc, 6);
    expect(widgets(parent)).toEqual([]);
    expect(parent.querySelector(".cm-odea-glyph-source")?.textContent).toBe(":odea_fire:");
    view.dispatch({ selection: { anchor: 0 } });
    expect(widgets(parent)).toEqual(["fire"]);
  });

  it("stays an emoji inside a selection that covers it whole", () => {
    const { parent } = mount(doc, 0, doc.length);
    expect(widgets(parent)).toEqual(["fire"]);
  });

  it("deletes as one unit with Backspace and is stepped over by the arrow keys", () => {
    const { view } = mount(doc, end);
    cursorCharLeft(view);
    expect(view.state.selection.main.head).toBe(3);
    view.dispatch({ selection: { anchor: end } });
    deleteCharBackward(view);
    expect(view.state.doc.toString()).toBe("今天  冲");
  });

  it("reuses the DOM while you type in front of it (the animation does not restart)", () => {
    const { parent, view } = mount(doc, 0);
    const before = parent.querySelector(".cm-odea-ae");
    view.dispatch({ changes: { from: 0, insert: "早上" }, selection: { anchor: 2 } });
    view.dispatch({ changes: { from: 2, insert: "，" }, selection: { anchor: 3 } });
    expect(parent.querySelector(".cm-odea-ae")).toBe(before);
  });

  it("leaves standard emoji and unknown codes alone", () => {
    const { parent } = mount("好 :smile: :odea_nope: :ODEA_STAR: 完", 0);
    expect(parent.querySelector(".cm-odea-glyph.is-emoji")?.textContent).toBe("😄");
    expect(parent.querySelector(".cm-odea-emoji-unknown")?.textContent).toBe(":odea_nope:");
    expect(widgets(parent)).toEqual(["star"]);
  });

  it("still renders the :otw_ codes written before the rename", () => {
    const { parent } = mount("旧笔记 :otw_fire: 新的 :odea_party: 完", 0);
    expect(widgets(parent)).toEqual(["fire", "party"]);
  });

  it("renders the meme set too, including the all-digit :odea_666:", () => {
    const { parent } = mount("下班了 :odea_offwork: 太强了 :odea_666: 摸鱼 :odea_fish:", 0);
    expect(widgets(parent)).toEqual(["offwork", "666", "fish"]);
  });

  it("never renders inside code", () => {
    const { parent } = mount("`:odea_fire:`\n\n```\n:odea_fire:\n```\n\n末尾", 0);
    expect(widgets(parent)).toEqual([]);
  });

  it("draws a static copy inside table cells", () => {
    const { parent } = mount(
      "| 状态 | 心情 |\n| --- | --- |\n| 完成 | :odea_party: |\n\n末尾",
      999,
    );
    const cell = parent.querySelector(".cm-odea-table-widget .odea-ae, table .odea-ae");
    expect(cell).not.toBeNull();
    expect(cell?.textContent).toBe("🎉");
  });
});

describe("插入", () => {
  const fire = animatedEmojiFor(":odea_fire:")!;

  it("replaces the selection and parks the caret after the emoji", () => {
    const { parent, view } = mount("今天很累", 2, 4);
    insertAnimatedEmoji(view, fire);
    expect(view.state.doc.toString()).toBe("今天:odea_fire:");
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(widgets(parent)).toEqual(["fire"]);
    // 刚插入的那一个领走了「弹出来」的开场
    expect(takeIntro(fire)).toBe(false);
  });

  it("pads a space where Markdown would otherwise swallow the colon", () => {
    const time = mount("12:30", 5);
    insertAnimatedEmoji(time.view, fire);
    expect(time.view.state.doc.toString()).toBe("12:30 :odea_fire:");
    expect(widgets(time.parent)).toEqual(["fire"]);

    const bracket = mount("[标签]", 4);
    insertAnimatedEmoji(bracket.view, fire);
    expect(bracket.view.state.doc.toString()).toBe("[标签] :odea_fire:");
    expect(widgets(bracket.parent)).toEqual(["fire"]);

    const plain = mount("冲", 1);
    insertAnimatedEmoji(plain.view, fire);
    expect(plain.view.state.doc.toString()).toBe("冲:odea_fire:");
  });

  it("inserts at every cursor", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "a\nb",
        selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3)]),
        extensions: [EditorState.allowMultipleSelections.of(true), markdownSupport()],
      }),
    });
    views.push(view);
    insertAnimatedEmoji(view, fire);
    expect(view.state.doc.toString()).toBe("a:odea_fire:\nb:odea_fire:");
  });
});

describe("Ctrl/⌘ + E", () => {
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
  });

  async function openEditor(markdown: string) {
    const host = document.createElement("div");
    document.body.append(host);
    const onSave = vi.fn(async () => {});
    await act(async () => {
      root = createRoot(host);
      root.render(
        <MarkdownEditor
          initialMarkdown={markdown}
          onSave={onSave}
          outlineItems={[]}
          onOutlineHandle={() => {}}
        />,
      );
    });
    const content = host.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    return { host, content, view, onSave };
  }

  const press = async (target: EventTarget, init: KeyboardEventInit) => {
    await act(async () => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
      );
      // CodeMirror 在 requestAnimationFrame 里跑测量，选择器从那里打开
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  };
  const picker = () => document.querySelector('[role="dialog"][aria-label="插入动态表情"]');

  it("opens the picker at the caret and inserts the chosen emoji", async () => {
    const { content, view } = await openEditor("写点什么");
    view.focus();
    view.dispatch({ selection: { anchor: 4 } });
    await press(content, { key: "e", ctrlKey: true });
    expect(picker()).not.toBeNull();
    const input = picker()!.querySelector("input")!;
    expect(document.activeElement).toBe(input);

    await press(input, { key: "ArrowDown" });
    await press(input, { key: "Enter" });
    expect(view.state.doc.toString()).toBe("写点什么:odea_done:");
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(view.hasFocus).toBe(true);
  });

  it("restores the caret side when dismissed with Escape", async () => {
    const { content, view } = await openEditor("一段文字");
    view.focus();
    // 注意要包成 EditorSelection：单独一个 range 会被 dispatch 按 anchor/head 重建，丢掉 assoc
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(2, -1)]) });
    expect(view.state.selection.main.assoc).toBe(-1);
    await press(content, { key: "e", ctrlKey: true });
    // 打开前清掉了折行方向（否则 CodeMirror 会把焦点抢回正文）
    expect(view.state.selection.main.assoc).toBe(0);
    await press(picker()!.querySelector("input")!, { key: "Escape" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(picker()).toBeNull();
    expect(view.state.selection.main.head).toBe(2);
    expect(view.state.selection.main.assoc).toBe(-1);
    expect(view.hasFocus).toBe(true);
    expect(view.state.doc.toString()).toBe("一段文字");
  });
});
