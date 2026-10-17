// @vitest-environment happy-dom

import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { typoraBlockDecorations, typoraDecorations } from "./MarkdownEditor";
import {
  foldAllHeadings,
  foldMarks,
  foldSectionAtCursor,
  foldableSections,
  foldedHeads,
  restoreFolds,
  setFoldedHeadings,
  toggleHeadingFold,
  unfoldAllHeadings,
  unfoldSectionAtCursor,
} from "./headingFold";
import { markdownSupport } from "./markdownParser";

const extensions = [markdownSupport(), typoraDecorations];
const create = (doc: string, anchor = 0) =>
  EditorState.create({ doc, selection: { anchor }, extensions });

/** 文档里某一行（一基）的行首 */
const lineStart = (state: EditorState, number: number) => state.doc.line(number).from;
const headOf = (state: EditorState, text: string) => state.doc.toString().indexOf(text);

/** 收起这几个标题（按标题行的字找），光标不动 */
function folded(doc: string, headings: string[], anchor = 0) {
  const state = create(doc, anchor);
  return state.update({
    effects: setFoldedHeadings.of(headings.map((text) => headOf(state, text))),
  }).state;
}

/** 收起的每一节：标题那一行的字 → 藏起来的第一行、最后一行（行号） */
function sections(state: EditorState) {
  return foldableSections(state).map((section) => [
    state.doc.lineAt(section.head).text,
    state.doc.lineAt(section.from).number,
    state.doc.lineAt(section.to).number,
  ]);
}

const headings = (state: EditorState) =>
  foldedHeads(state).map((head) => state.doc.lineAt(head).text);

const views: EditorView[] = [];
function mount(state: EditorState) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state });
  views.push(view);
  return { parent, view };
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

const DOC = [
  "# A", // 1
  "", // 2
  "a 段", // 3
  "", // 4
  "## B", // 5
  "", // 6
  "b 段", // 7
  "", // 8
  "## C", // 9
  "", // 10
  "# D", // 11
  "", // 12
  "d 段", // 13
].join("\n");

describe("哪些标题能收、收到哪", () => {
  it("runs a section up to the next heading of the same or a higher level", () => {
    expect(sections(create(DOC))).toEqual([
      // A 管到 D 之前，B、C 一起收；最后一个块（## C）和 # D 之间的空行留着
      ["# A", 2, 9],
      ["## B", 6, 7],
      ["# D", 12, 13],
    ]);
  });

  it("skips a heading with nothing under it", () => {
    // ## C 后面紧跟 # D：一个块都没有
    expect(sections(create(DOC)).map(([text]) => text)).not.toContain("## C");
    expect(sections(create("# 只有标题\n\n\n"))).toEqual([]);
  });

  it("starts a Setext heading's section below its underline", () => {
    expect(sections(create("标题\n===\n\n内容\n\n第二\n---\n\n更多"))).toEqual([
      ["标题", 3, 9],
      ["第二", 8, 9],
    ]);
  });

  it("ignores the front matter and headings inside lists or quotes", () => {
    const doc =
      "---\ntitle: x\n---\n\n- ## 列表里\n  内容\n\n> ## 引用里\n> 内容\n\n# 正文\n\n内容";
    expect(sections(create(doc))).toEqual([["# 正文", 12, 13]]);
  });

  it("does not let code inside a fence end a section", () => {
    const doc = "# A\n\n```sh\n# 注释\n```\n\n结尾";
    expect(sections(create(doc))).toEqual([["# A", 2, 7]]);
  });
});

describe("收起以后画出来的样子", () => {
  it("hides the section and puts a line count at the end of the heading", () => {
    const { parent } = mount(folded(DOC, ["## B"]));
    const texts = [...parent.querySelectorAll(".cm-line")].map((line) => line.textContent);
    expect(texts).not.toContain("b 段");
    // 光标不在上面的标题藏掉了 `##`
    expect(texts).toContain("C");
    expect(parent.querySelector(".cm-odea-heading-folded")?.textContent).toBe("… 2 行");
  });

  it("draws nothing else inside a hidden section", () => {
    const doc = "# A\n\n```js\nconst a = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n# B\n\nb";
    const state = folded(doc, ["# A"], doc.length);
    const block = state.field(typoraBlockDecorations);
    const covered: string[] = [];
    block.decorations.between(0, doc.length, (from, to, decoration) => {
      covered.push(
        `${state.doc.lineAt(from).number}-${state.doc.lineAt(to).number} ${decoration.spec.widget?.constructor.name ?? (decoration.spec.block ? "hidden" : "line")}`,
      );
    });
    // 只有一整段藏起来的和标题行尾的「… N 行」，没有代码块封口、表格替身
    expect(covered).toEqual(["1-1 FoldedSectionWidget", "2-9 hidden"]);
    expect([...block.foldedLines].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 8 }, (_, index) => lineStart(state, index + 2)),
    );
  });

  it("only draws the outermost of nested folds", () => {
    const { parent } = mount(folded(DOC, ["# A", "## B"]));
    expect(parent.querySelectorAll(".cm-odea-heading-folded")).toHaveLength(1);
    expect(parent.querySelector(".cm-odea-heading-folded")?.textContent).toBe("… 8 行");
  });

  it("puts the level and a chevron in front of every foldable top-level heading", () => {
    const { parent } = mount(folded(DOC, ["## B"]));
    const gutters = [...parent.querySelectorAll<HTMLElement>(".cm-odea-heading-gutter")];
    const describe = gutters.map((gutter) => [
      gutter.querySelector<HTMLElement>(".cm-odea-heading-level")?.dataset.level,
      !!gutter.querySelector(".cm-odea-heading-fold"),
      gutter.classList.contains("is-folded"),
    ]);
    expect(describe).toEqual([
      ["H1", true, false],
      ["H2", true, true],
      ["H2", false, false],
      ["H1", true, false],
    ]);
    // 层级提示是 ::before 画的，不进这一行的字
    expect(gutters[3]!.closest(".cm-line")?.textContent).toBe("D");
  });

  it("folds and unfolds from the chevron without moving the caret", () => {
    const { parent, view } = mount(create(DOC, DOC.length));
    const chevron = () =>
      parent.querySelectorAll<HTMLElement>(".cm-odea-heading-gutter")[1]!.querySelector("button")!;
    chevron().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(headings(view.state)).toEqual(["## B"]);
    expect(view.state.selection.main.head).toBe(DOC.length);
    chevron().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(headings(view.state)).toEqual([]);
  });

  it("unfolds from the line count", () => {
    const { parent, view } = mount(folded(DOC, ["## B"], DOC.length));
    parent
      .querySelector(".cm-odea-heading-folded")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(headings(view.state)).toEqual([]);
  });
});

describe("改动之后", () => {
  const edit = (state: EditorState, spec: TransactionSpec) => state.update(spec).state;

  it("keeps the fold while the heading text is edited", () => {
    let state = folded(DOC, ["## B"]);
    const end = state.doc.line(5).to;
    state = edit(state, { changes: { from: end, insert: "改" }, selection: { anchor: end + 1 } });
    expect(headings(state)).toEqual(["## B改"]);
  });

  it("follows the heading when a # is added in front or a line is opened above it", () => {
    let state = folded(DOC, ["## B"]);
    state = edit(state, { changes: { from: lineStart(state, 5), insert: "#" } });
    expect(headings(state)).toEqual(["### B"]);
    state = edit(state, { changes: { from: lineStart(state, 5), insert: "\n" } });
    expect(headings(state)).toEqual(["### B"]);
    expect(state.doc.lineAt(foldedHeads(state)[0]!).number).toBe(6);
  });

  it("recomputes the range when the level changes", () => {
    let state = folded(DOC, ["## B"]);
    // ## B → # B：一节一直管到 # D 之前，## C 也收进去
    state = edit(state, { changes: { from: lineStart(state, 5), to: lineStart(state, 5) + 1 } });
    expect(headings(state)).toEqual(["# B"]);
    const section = state.field(typoraBlockDecorations);
    const hidden: number[] = [];
    section.decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.block && !decoration.spec.widget) {
        hidden.push(state.doc.lineAt(from).number, state.doc.lineAt(to).number);
      }
    });
    expect(hidden).toEqual([6, 9]);
  });

  it("drops the fold once the line is no longer a heading", () => {
    let state = folded(DOC, ["## B"]);
    state = edit(state, { changes: { from: lineStart(state, 5), to: lineStart(state, 5) + 3 } });
    expect(headings(state)).toEqual([]);
  });

  it("unfolds when a deletion reaches into the hidden lines", () => {
    let state = folded(DOC, ["## B"], 0);
    // 从标题行尾删到藏着的「b 段」里
    const end = state.doc.line(5).to;
    state = edit(state, { changes: { from: end - 1, to: headOf(state, "b 段") + 1 } });
    expect(headings(state)).toEqual([]);
  });

  it("unfolds when the next line is pulled into the last hidden line", () => {
    let state = folded("## B\n\nb 段\n\n## C\n\nc", ["## B"], 0);
    const end = state.doc.line(3).to;
    // 删掉 b 段后面的换行：并进来的是空行，藏着的字没变，不展开
    state = edit(state, { changes: { from: end, to: end + 1 } });
    expect(headings(state)).toEqual(["## B"]);
    // 再删一次：这回并进来的是「## C」，展开
    state = edit(state, { changes: { from: end, to: end + 1 } });
    expect(headings(state)).toEqual([]);
  });

  it("keeps the fold when the blank line right under the heading is merged into it", () => {
    let state = folded(DOC, ["## B"], 0);
    const end = state.doc.line(5).to;
    state = edit(state, { changes: { from: end, to: end + 1 } });
    expect(headings(state)).toEqual(["## B"]);
  });

  it("opens the section when Enter is pressed at the end of a folded heading", () => {
    let state = folded(DOC, ["## B"], 0);
    const end = state.doc.line(5).to;
    state = edit(state, { changes: { from: end, insert: "\n" }, selection: { anchor: end + 1 } });
    expect(headings(state)).toEqual([]);
  });

  it("finds the headings again when the whole document is replaced", () => {
    let state = folded(DOC, ["## B", "# D"], 0);
    const next = `前面多了一段\n\n${DOC.replace("d 段", "d 段改过")}`;
    state = edit(state, { changes: { from: 0, to: state.doc.length, insert: next } });
    expect(headings(state)).toEqual(["## B", "# D"]);
  });
});

describe("光标", () => {
  it("unfolds when the selection lands inside (search, jumps, undo)", () => {
    let state = folded(DOC, ["# A", "## B"], 0);
    state = state.update({ selection: { anchor: headOf(state, "b 段") + 1 } }).state;
    // 外层、里层都展开，光标才看得见
    expect(headings(state)).toEqual([]);
  });

  it("keeps the fold for select-all", () => {
    let state = folded(DOC, ["# D"], 0);
    state = state.update({
      selection: EditorSelection.range(0, state.doc.length),
      userEvent: "select",
    }).state;
    expect(headings(state)).toEqual(["# D"]);
  });

  it("steps over a folded section instead of stopping at its invisible edges", () => {
    const state = folded(DOC, ["## B"], 0);
    const headingEnd = state.doc.line(5).to;
    const hiddenFrom = lineStart(state, 6);
    const hiddenTo = state.doc.line(7).to;
    const move = (from: number, to: number) =>
      state
        .update({ selection: { anchor: from } })
        .state.update({ selection: { anchor: to }, userEvent: "select" }).state;
    // → / ↓ 从标题走到藏着的第一行行首：挪到这一节后面那一行
    let next = move(headingEnd, hiddenFrom);
    expect(next.selection.main.head).toBe(hiddenTo + 1);
    expect(headings(next)).toEqual(["## B"]);
    // ← / ↑ 从后面那一行退到藏着的最后一行行尾：回到标题行尾
    next = move(hiddenTo + 1, hiddenTo);
    expect(next.selection.main.head).toBe(headingEnd);
    expect(headings(next)).toEqual(["## B"]);
  });

  it("lands Ctrl+End on the last heading when the document ends folded", () => {
    const state = folded(DOC, ["# D"], 0);
    const next = state.update({
      selection: { anchor: state.doc.length },
      userEvent: "select",
    }).state;
    expect(next.selection.main.head).toBe(state.doc.line(11).to);
    expect(headings(next)).toEqual(["# D"]);
  });

  it("lets a search match open the section", () => {
    const state = folded(DOC, ["## B"], 0);
    const at = headOf(state, "b 段");
    const next = state.update({
      selection: EditorSelection.range(at, at + 1),
      userEvent: "select.search",
    }).state;
    expect(next.selection.main.head).toBe(at + 1);
    expect(headings(next)).toEqual([]);
  });
});

describe("命令", () => {
  it("folds the section around the caret and moves the caret to its heading", () => {
    const { view } = mount(create(DOC, DOC.indexOf("b 段") + 1));
    expect(foldSectionAtCursor(view)).toBe(true);
    expect(headings(view.state)).toEqual(["## B"]);
    expect(view.state.selection.main.head).toBe(view.state.doc.line(5).to);
    // 光标在收起的标题上：Ctrl+Alt+] 展开
    expect(unfoldSectionAtCursor(view)).toBe(true);
    expect(headings(view.state)).toEqual([]);
  });

  it("folds the heading the caret is on", () => {
    const { view } = mount(create(DOC, 1));
    foldSectionAtCursor(view);
    expect(headings(view.state)).toEqual(["# A"]);
    expect(view.state.selection.main.head).toBe(1);
  });

  it("folds and unfolds everything", () => {
    const { view } = mount(create(DOC, DOC.indexOf("b 段")));
    expect(foldAllHeadings(view)).toBe(true);
    expect(headings(view.state)).toEqual(["# A", "## B", "# D"]);
    // 光标落到包着它的最外面那个标题行尾
    expect(view.state.selection.main.head).toBe(view.state.doc.line(1).to);
    expect(unfoldAllHeadings(view)).toBe(true);
    expect(headings(view.state)).toEqual([]);
    expect(unfoldAllHeadings(view)).toBe(false);
  });

  it("refuses to fold a heading with nothing under it", () => {
    const { view } = mount(create(DOC, 0));
    expect(toggleHeadingFold(view, lineStart(view.state, 9))).toBe(false);
    expect(headings(view.state)).toEqual([]);
  });
});

describe("记住收起了哪些", () => {
  it("restores by line number, or by the nearest heading with the same text", () => {
    const state = folded(DOC, ["## B", "# D"]);
    const marks = foldMarks(state);
    expect(marks).toEqual([
      { line: 5, text: "## B" },
      { line: 11, text: "# D" },
    ]);
    // 文件在别处改过：前面多了两行
    const moved = create(`新的一行\n\n${DOC}`);
    const restored = moved.update({ effects: restoreFolds(moved, marks) }).state;
    expect(headings(restored)).toEqual(["## B", "# D"]);
  });

  it("forgets marks that match nothing and ignores junk", () => {
    const state = create(DOC);
    expect(
      restoreFolds(state, [{ line: 3, text: "## 没有这个标题" }, { line: "x", text: 1 } as never]),
    ).toEqual([]);
    expect(restoreFolds(state, undefined)).toEqual([]);
  });
});
