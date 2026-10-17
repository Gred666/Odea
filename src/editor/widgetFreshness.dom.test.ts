// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { typoraDecorations } from "./MarkdownEditor";
import { markdownSupport } from "./markdownParser";

/*
 * 替身的身份和入场动画。
 *
 * - 小替身的 eq 里不放文档位置：在它们上方打字，DOM 原样复用（以前整批重建、一起闪）；
 *   点击时位置现算，照样落在对的源码上。
 * - 入场动画只给新内容：刚打开、刚打出来的替身照常播；光标移开换回来的替身带
 *   is-settled，CSS 里不再重放淡入。
 */

const views: EditorView[] = [];

function mount(doc: string, anchor = 0) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdownSupport(), typoraDecorations],
    }),
  });
  views.push(view);
  return { parent, view };
}

const press = (node: Element | null) => {
  expect(node).not.toBeNull();
  node!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
};

const settled = (node: Element | null) => !!node?.classList.contains("is-settled");

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

const SMALL_WIDGETS = ".cm-odea-list-marker, .cm-odea-task, .cm-odea-glyph, .cm-odea-footnote";

describe("小替身的身份不含位置", () => {
  it("reuses the same DOM for markers, task boxes, glyphs and footnotes while text above changes", () => {
    const doc = "开头\n\n- 甲 :smile:\n- [ ] 乙 &copy;\n- 丙[^1]\n\n[^1]: 注";
    const { parent, view } = mount(doc);
    const before = [...parent.querySelectorAll(SMALL_WIDGETS)];
    expect(before.length).toBeGreaterThanOrEqual(6);

    // 在最上面那行打字：下面所有替身的位置都往后挪了
    view.dispatch({ changes: { from: 2, insert: "再多几个字" }, selection: { anchor: 7 } });

    const after = [...parent.querySelectorAll(SMALL_WIDGETS)];
    expect(after).toHaveLength(before.length);
    expect(after.every((node, index) => node === before[index])).toBe(true);
  });

  it("still lands clicks on the right source after the text above moved", () => {
    const doc = "开头\n\n- [ ] 任务\n- 普通\n\n> [!NOTE]- 标题\n> 正文\n\n文字 :smile: 完";
    const { parent, view } = mount(doc);
    view.dispatch({ changes: { from: 0, insert: "插入一行\n" } });

    // 勾选框勾的是自己那一项
    press(parent.querySelector(".cm-odea-task"));
    expect(view.state.doc.toString()).toContain("- [x] 任务");

    // 列表符号：光标回到这一项的 `-` 上
    press(parent.querySelectorAll(".cm-odea-list-marker")[0] ?? null);
    const text = view.state.doc.toString();
    expect(view.state.selection.main.head).toBe(text.indexOf("- 普通"));

    // 短码：光标放进 `:` 后面
    view.dispatch({ selection: { anchor: 0 } });
    press(parent.querySelector(".cm-odea-glyph.is-emoji"));
    expect(view.state.selection.main.head).toBe(text.indexOf(":smile:") + 1);

    // callout 徽章：翻的是自己的折叠符
    view.dispatch({ selection: { anchor: 0 } });
    press(parent.querySelector(".cm-odea-callout-badge"));
    expect(view.state.doc.toString()).toContain("> [!NOTE]+ 标题");
  });

  it("toggles a folded callout from its 「展开」 bar after the text above moved", () => {
    const { parent, view } = mount("开头\n\n> [!TIP]- 收起的\n> 第一行\n> 第二行");
    view.dispatch({ changes: { from: 0, insert: "上面多了一段\n\n" } });
    press(parent.querySelector(".cm-odea-callout-fold-button"));
    expect(view.state.doc.toString()).toContain("> [!TIP]+ 收起的");
  });
});

describe("入场动画只给新内容", () => {
  it("plays on first render and skips it when the caret merely leaves", () => {
    const doc = "开头\n\n- 甲\n- 乙\n\n结尾 :smile:";
    const { parent, view } = mount(doc);
    // 刚打开：全都是新出现的
    expect([...parent.querySelectorAll(SMALL_WIDGETS)].some(settled)).toBe(false);

    // 光标到第一项的符号上再出来：换回来的圆点直接是最终状态
    view.dispatch({ selection: { anchor: doc.indexOf("- 甲") } });
    view.dispatch({ selection: { anchor: 0 } });
    expect(settled(parent.querySelector(".cm-odea-list-marker"))).toBe(true);

    // 短码同理
    view.dispatch({ selection: { anchor: doc.indexOf(":smile:") + 2 } });
    view.dispatch({ selection: { anchor: 0 } });
    expect(settled(parent.querySelector(".cm-odea-glyph.is-emoji"))).toBe(true);
  });

  it("plays for syntax that was just typed, even while older widgets stay settled", () => {
    const { parent, view } = mount("开头\n\n- 甲\n\n结尾");
    view.dispatch({ selection: { anchor: 4 } });
    view.dispatch({ selection: { anchor: 0 } });
    expect(settled(parent.querySelector(".cm-odea-list-marker"))).toBe(true);

    // 在文末打出一个短码（光标不在它上面，所以直接显示成表情）
    const end = view.state.doc.length;
    view.dispatch({ changes: { from: end, insert: " :tada:" } });
    expect(settled(parent.querySelector(".cm-odea-glyph.is-emoji"))).toBe(false);
    // 别处的圆点没有被这次输入碰到，仍然是安静的那一份
    expect(settled(parent.querySelector(".cm-odea-list-marker"))).toBe(true);
  });

  it("still plays the check animation when a task is ticked", () => {
    const doc = "开头\n\n- [ ] 任务";
    const { parent, view } = mount(doc);
    view.dispatch({ selection: { anchor: doc.indexOf("- [ ]") } });
    view.dispatch({ selection: { anchor: 0 } });
    expect(settled(parent.querySelector(".cm-odea-task"))).toBe(true);

    press(parent.querySelector(".cm-odea-task"));
    const box = parent.querySelector(".cm-odea-task");
    expect(box?.classList.contains("is-checked")).toBe(true);
    expect(settled(box)).toBe(false);
  });

  it("keeps block widgets quiet when the caret leaves them", () => {
    const doc = "开头\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n结尾";
    const { parent, view } = mount(doc);
    expect(settled(parent.querySelector(".cm-odea-table-block"))).toBe(false);

    view.dispatch({ selection: { anchor: doc.indexOf("1 |") } });
    expect(parent.querySelector(".cm-odea-table-block")).toBeNull();
    view.dispatch({ selection: { anchor: 0 } });
    expect(settled(parent.querySelector(".cm-odea-table-block"))).toBe(true);
  });
});
