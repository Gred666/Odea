// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { typoraDecorations } from "./MarkdownEditor";
import { indentListItem, listItemHome } from "./markdownCommands";
import { markdownKeymap } from "./markdownKeymap";
import { markdownSupport } from "./markdownParser";

const views: EditorView[] = [];

function mount(doc: string, anchor: number) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: Math.min(anchor, doc.length) },
      extensions: [markdownSupport(), typoraDecorations, keymap.of(markdownKeymap)],
    }),
  });
  views.push(view);
  return { parent, view };
}

const lines = (parent: HTMLElement) =>
  [...parent.querySelectorAll(".cm-line")].map((line) => line.textContent);
const markers = (parent: HTMLElement) =>
  [...parent.querySelectorAll(".cm-otw-list-marker:not(.is-source)")].map(
    (node) => node.textContent,
  );

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe("Typora DOM decorations", () => {
  it("reveals strike markers only inside the styled span", () => {
    const { parent, view } = mount("开头 ~~删除~~ 结尾", 1);
    expect(parent.querySelectorAll(".cm-otw-syntax-marker")).toHaveLength(0);
    expect(parent.querySelector(".cm-content")?.textContent).toBe("开头 删除 结尾");

    view.dispatch({ selection: { anchor: 7 } });
    expect(parent.querySelectorAll(".cm-otw-syntax-marker")).toHaveLength(2);
    expect(parent.querySelector(".cm-content")?.textContent).toBe("开头 ~~删除~~ 结尾");
  });

  it("makes hidden markers atomic without making styled text unclickable", () => {
    const { view } = mount("前 **粗体** 后", 0);
    // 原子区间现在由两层共同提供（块级 StateField + 行内 ViewPlugin），
    // 从 facet 读才能看到用户实际感受到的那一份。
    const atomic: [number, number][] = [];
    for (const source of view.state.facet(EditorView.atomicRanges)) {
      source(view).between(0, view.state.doc.length, (from, to) => {
        atomic.push([from, to]);
      });
    }
    atomic.sort((a, b) => a[0] - b[0]);
    expect(atomic).toEqual([
      [2, 4],
      [6, 8],
    ]);
    expect(atomic).not.toContainEqual([4, 6]);
  });

  it("folds inactive heading marks without reserving progressively wider gaps", () => {
    const source = "# 一级\n## 二级\n### 三级";
    const { parent, view } = mount(source, source.length);
    expect(lines(parent)).toEqual(["一级", "二级", "### 三级"]);

    view.dispatch({ selection: { anchor: 0 } });
    expect(parent.querySelector(".cm-otw-syntax-marker")?.textContent).toBe("# ");
  });

  it("renders list markers and task markers without duplicate markdown bullets", () => {
    const source = "- 普通\n1. 有序\n- [x] 完成\n\n尾部";
    const { parent, view } = mount(source, source.length);
    expect(
      [...parent.querySelectorAll(".cm-otw-list-marker")].map((node) => node.textContent),
    ).toEqual(["•", "1."]);
    // 对勾现在是一条 SVG 路径，不再是 ✓ 字符
    expect(parent.querySelector(".cm-otw-task")?.getAttribute("aria-checked")).toBe("true");
    expect(parent.querySelector(".cm-otw-task.is-checked .cm-otw-task-check")).not.toBeNull();
    expect(parent.querySelectorAll(".cm-line")[2]?.textContent).not.toContain("-");

    parent
      .querySelector(".cm-otw-task")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(view.state.doc.toString()).toContain("- [ ] 完成");
  });

  it("does not leave an indent gap in front of a task checkbox", () => {
    // 勾选框盖住整段「- [x] 」，前后都不留源码里的空格，宽度只由符号格决定。
    const { parent } = mount("- [x] 完成\n\n尾部", 999);
    expect(parent.querySelectorAll(".cm-line")[0]?.textContent).toBe("完成");
    expect(parent.querySelectorAll(".cm-line")[0]?.querySelector(".cm-otw-task")).not.toBeNull();
  });

  it("keeps list markers rendered while the caret is in the item's text", () => {
    const source = "- 甲\n  - 乙\n- [ ] 丙\n\n尾部";
    const { parent, view } = mount(source, source.indexOf("乙") + 1);
    expect(markers(parent)).toEqual(["•", "◦"]);
    expect(parent.querySelector(".cm-otw-task")).not.toBeNull();

    // 光标到了符号上（行首）才换回源码；符号格还是同一个类，宽度不变
    view.dispatch({ selection: { anchor: source.indexOf("- 乙") } });
    const revealed = parent.querySelector<HTMLElement>(".cm-otw-list-marker.is-source");
    const rendered = parent.querySelector<HTMLElement>(".cm-otw-list-marker:not(.is-source)");
    expect(revealed?.textContent).toBe("- ");
    expect(revealed?.style.width).toBe("calc(var(--otw-body-size) * 1.55)");
    expect(rendered?.style.width).toBe(revealed?.style.width);
    view.dispatch({ selection: { anchor: source.indexOf("- [ ]") } });
    expect(parent.querySelector(".cm-otw-task")).toBeNull();
    expect(parent.querySelector(".cm-otw-list-marker.is-source.is-task")?.textContent).toBe(
      "- [ ] ",
    );
  });

  it("sends Home to the start of the item's text first", () => {
    const source = "  - [ ] 甲乙丙\n普通一行";
    const { view } = mount(source, source.indexOf("丙"));
    expect(listItemHome(false)(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(source.indexOf("甲"));
    // 已经在正文开头：交给自带的 Home
    expect(listItemHome(false)(view)).toBe(false);
    // Shift+Home 选到正文开头
    view.dispatch({ selection: { anchor: source.indexOf("丙") } });
    listItemHome(true)(view);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "甲乙",
    );
    // 不是列表项
    view.dispatch({ selection: { anchor: source.length } });
    expect(listItemHome(false)(view)).toBe(false);
  });

  it("nests a list item under the previous one with Tab and takes its children along", () => {
    const tab = (doc: string, at: string, direction: 1 | -1 = 1) => {
      const { view } = mount(doc, doc.indexOf(at));
      indentListItem(direction)(view);
      return view.state.doc.toString();
    };
    // 有序列表要缩进到 `1. ` 后面那一栏（三个空格）才是子项，以前一律加两个空格
    // 成了新子列表的第一项：编号从 1 起
    expect(tab("1. a\n2. b\n3. c", "b")).toBe("1. a\n   1. b\n3. c");
    // 上一项已经有子列表：接在后面，编号照旧（显示时按位置数）
    expect(tab("1. a\n   1. a1\n2. b", "b")).toBe("1. a\n   1. a1\n   2. b");
    // 光标在这一项末尾、整篇末尾（最常见的位置）
    const end = mount("1. a\n2. bc", 10);
    indentListItem(1)(end.view);
    expect(end.view.state.doc.toString()).toBe("1. a\n   1. bc");
    expect(tab("- a\n- b\n  - b1\n  续行\n- c", "b")).toBe("- a\n  - b\n    - b1\n    续行\n- c");
    expect(tab("- [ ] a\n- [ ] b", "b")).toBe("- [ ] a\n      - [ ] b");
    // 第一项没有可挂的：不动（也不让 Tab 把焦点带走）
    const { view } = mount("1. a\n2. b", 3);
    expect(indentListItem(1)(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("1. a\n2. b");

    // Shift+Tab 回到上一级的符号位置，后面的兄弟成了它的子项（Markdown 的结构就是这样）
    expect(tab("1. a\n   2. b\n   3. c", "b", -1)).toBe("1. a\n2. b\n   3. c");
    expect(tab("- a\n    - b", "b", -1)).toBe("- a\n- b");
    // 最外层：交给自带的
    expect(indentListItem(-1)(mount("- a", 2).view)).toBe(false);
  });

  it("hangs wrapped list lines and indents by nesting level, not by source spaces", () => {
    const source = "- 甲\n    - 四个空格的子项\n- 乙\n  - 两个空格的子项\n\n尾部";
    const { parent } = mount(source, source.length);
    const style = (index: number) => {
      const line = parent.querySelectorAll<HTMLElement>(".cm-line")[index];
      return [line?.style.paddingLeft, line?.style.textIndent];
    };
    expect(style(0)).toEqual([
      "calc(var(--otw-body-size) * 1.55)",
      "calc(var(--otw-body-size) * -1.55)",
    ]);
    expect(style(1)).toEqual([
      "calc(var(--otw-body-size) * 3.1)",
      "calc(var(--otw-body-size) * -3.1)",
    ]);
    expect(style(3)).toEqual(style(1));
  });

  it("folds both fence lines and keeps the language as a compact label", () => {
    // 以前只藏 ``` 三个字符，代码块上下各留一条莫名其妙的空行。
    const source = "```ts\nconst value = 1;\n```\n\n之后";
    const { parent } = mount(source, source.length);
    expect(lines(parent)).toEqual(["const value = 1;", "", "之后"]);
    expect(parent.querySelector(".cm-otw-code-lang")?.textContent).toBe("ts");
    expect(parent.querySelectorAll(".cm-otw-code-fence")).toHaveLength(2);
  });

  it("keeps an empty fence reachable instead of folding it out of existence", () => {
    const { parent } = mount("```\n```\n\n后", 999);
    expect(parent.querySelectorAll(".cm-otw-code-fence")).toHaveLength(0);
    // 没折叠的围栏行照样画成封口那样的框
    expect(parent.querySelectorAll(".cm-line.cm-otw-fence-source")).toHaveLength(2);
  });

  it("draws the revealed fence lines as caps of the same size, so the block never jumps", () => {
    // 光标一进代码块，封口换回源码行；源码行带上 is-open / is-close，
    // globals.css 按「围栏的几何」把它们排得和封口一样高
    const source = "前\n\n```ts\nconst value = 1;\n```\n\n后";
    const { parent, view } = mount(source, 0);
    expect(parent.querySelectorAll(".cm-line.cm-otw-fence-source")).toHaveLength(0);
    view.dispatch({ selection: { anchor: source.indexOf("value") } });
    expect(parent.querySelectorAll(".cm-otw-code-fence")).toHaveLength(0);
    const open = parent.querySelector(".cm-line.cm-otw-fence-source.is-open");
    const close = parent.querySelector(".cm-line.cm-otw-fence-source.is-close");
    expect(open?.textContent).toBe("```ts");
    expect(close?.textContent).toBe("```");
    view.dispatch({ selection: { anchor: 0 } });
    expect(parent.querySelectorAll(".cm-line.cm-otw-fence-source")).toHaveLength(0);
    expect(parent.querySelectorAll(".cm-otw-code-fence")).toHaveLength(2);
  });

  it("does not mark an unclosed fence's last line as a closing cap", () => {
    const { parent } = mount("```js\nlet a;\nlet b;", 8);
    expect(parent.querySelectorAll(".cm-line.cm-otw-fence-source.is-open")).toHaveLength(1);
    expect(parent.querySelectorAll(".cm-line.cm-otw-fence-source.is-close")).toHaveLength(0);
  });

  it("folds the Setext underline row instead of leaving a blank line", () => {
    const { parent } = mount("标题\n===\n\n正文", 999);
    expect(lines(parent)).toEqual(["标题", "", "正文"]);
    expect(parent.querySelectorAll(".cm-otw-h1")).toHaveLength(1);
  });

  it("replaces a horizontal rule row without leaving the source line behind", () => {
    const { parent, view } = mount("上\n\n---\n\n下", 0);
    expect(parent.querySelectorAll(".cm-otw-hr")).toHaveLength(1);
    expect(lines(parent)).toEqual(["上", "", "", "下"]);
    // 光标放上去：露出 `---`，这一行和分隔线一样高
    view.dispatch({ selection: { anchor: 4 } });
    expect(parent.querySelector(".cm-otw-hr")).toBeNull();
    expect(parent.querySelector(".cm-line.cm-otw-hr-source")?.textContent).toBe("---");
  });

  it("renders an inactive GFM table as a real table", () => {
    const source = "| 左 | 右 |\n| --- | ---: |\n| A | B |\n\n表格之后";
    const { parent } = mount(source, source.length);
    const table = parent.querySelector<HTMLTableElement>(".cm-otw-table-widget");
    expect(table).not.toBeNull();
    expect([...table!.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual([
      "左",
      "右",
    ]);
    expect(table!.querySelectorAll("tbody tr")).toHaveLength(1);

    table!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(parent.querySelector(".cm-otw-table-widget")).toBeNull();
    expect(parent.querySelector(".cm-content")?.textContent).toContain("| 左 | 右 |");
  });

  it("underlines <u> only inside one block", () => {
    const { parent } = mount("前 <u>下划线</u> 后", 0);
    expect(parent.querySelector(".cm-otw-underline")?.textContent).toBe("下划线");
    expect(lines(parent)).toEqual(["前 下划线 后"]);
  });

  it("never pairs <u> across a blank line", () => {
    // 以前是全文 indexOf，两个不相干段落里的 <u> 和 </u> 会被配成一对，
    // 两个标签双双消失，中间整段被画上下划线。
    const { parent } = mount("段落一 <u>下划线\n\n段落二 </u> 结束", 0);
    expect(parent.querySelectorAll(".cm-otw-underline")).toHaveLength(0);
    expect(lines(parent)).toEqual(["段落一 <u>下划线", "", "段落二 </u> 结束"]);
  });

  it("leaves <u> inside code untouched", () => {
    const fenced = mount("```html\n<u>x</u>\n```\n\n之后", 999);
    expect(fenced.parent.querySelectorAll(".cm-otw-underline")).toHaveLength(0);
    expect(lines(fenced.parent)).toEqual(["<u>x</u>", "", "之后"]);

    const inline = mount("看 `<u>x</u>` 结束", 0);
    expect(inline.parent.querySelectorAll(".cm-otw-underline")).toHaveLength(0);
    expect(lines(inline.parent)).toEqual(["看 <u>x</u> 结束"]);
  });

  it("runs clear-format and repeated-link shortcuts through the DOM keymap", () => {
    const formatted = mount("**粗体**", 3).view;
    formatted.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "\\", ctrlKey: true, bubbles: true }),
    );
    expect(formatted.state.doc.toString()).toBe("粗体");

    // 插入链接从 Mod-K 挪到了 Shift-Mod-K —— Mod-K 要留给全局命令面板。
    const link = mount("官网", 0).view;
    link.dispatch({ selection: { anchor: 0, head: 2 } });
    for (let index = 0; index < 3; index += 1) {
      link.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", ctrlKey: true, shiftKey: true, bubbles: true }),
      );
    }
    expect(link.state.doc.toString()).toBe("[官网](url)");
  });

  it("lets Mod-K through to the window so the command palette still opens", () => {
    const view = mount("正文", 1).view;
    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true });
    view.contentDOM.dispatchEvent(event);
    expect(view.state.doc.toString()).toBe("正文");
  });

  it("applies inline shortcuts safely across lines", () => {
    const { view } = mount("第一行\n第二行", 0);
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true }),
    );
    expect(view.state.doc.toString()).toBe("**第一行**\n**第二行**");
  });
});
