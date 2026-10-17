// @vitest-environment happy-dom

import { history } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { typoraDecorations } from "./MarkdownEditor";
import { markdownSupport } from "./markdownParser";
import { mapOffset } from "./tableWidget";

const views: EditorView[] = [];

/** 光标放在文档最后（表格外面），表格显示成替身 */
function mount(doc: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [markdownSupport(), typoraDecorations, history()],
    }),
  });
  views.push(view);
  return { parent, view };
}

const cellAt = (parent: HTMLElement, row: number, col: number) =>
  parent.querySelector<HTMLTableCellElement>(`[data-row="${row}"][data-col="${col}"]`)!;
const click = (node: Element) =>
  node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
/** 模拟在格子里打字：改掉内容，发一个 input */
const typeIn = (cell: HTMLElement, text: string) => {
  cell.textContent = text;
  cell.dispatchEvent(new InputEvent("input", { bubbles: true }));
};
const press = (node: Element, init: KeyboardEventInit) =>
  node.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
const editing = (parent: HTMLElement) =>
  parent.querySelector<HTMLTableCellElement>(".cm-odea-table-widget .is-editing");

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe("表格里直接编辑", () => {
  it("reveals the cell's own markdown and writes just that cell back", () => {
    const source = "| 语法 | 状态 |\n| :-- | :--: |\n| **粗体** | ok |\n\n后";
    const { parent, view } = mount(source);
    const block = parent.querySelector(".cm-odea-table-block")!;
    const cell = cellAt(parent, 1, 0);
    expect(cell.querySelector("strong")?.textContent).toBe("粗体");

    click(cell);
    expect(cell.classList.contains("is-editing")).toBe(true);
    expect(cell.textContent).toBe("**粗体**");

    typeIn(cell, "**粗体** 改");
    expect(view.state.doc.toString()).toBe(
      "| 语法 | 状态 |\n| :-- | :--: |\n| **粗体** 改 | ok |\n\n后",
    );
    // 表格没有被重建，正在编辑的格子还是那个、还在编辑
    expect(parent.querySelector(".cm-odea-table-block")).toBe(block);
    expect(editing(parent)).toBe(cell);
    expect(cell.textContent).toBe("**粗体** 改");

    // Esc：回到正文（表格下面那一行），格子渲染回去
    press(cell, { key: "Escape" });
    expect(editing(parent)).toBeNull();
    expect(cellAt(parent, 1, 0).querySelector("strong")?.textContent).toBe("粗体");
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(4);
  });

  it("escapes pipes and writes Shift+Enter as <br>", () => {
    const { parent, view } = mount("| a | b |\n|---|---|\n| 1 | 2 |\n\n后");
    const cell = cellAt(parent, 1, 1);
    click(cell);
    typeIn(cell, "x|y");
    expect(view.state.doc.line(3).text).toBe("| 1 | x\\|y |");
    press(cell, { key: "Enter", shiftKey: true });
    expect(view.state.doc.line(3).text).toBe("| 1 | x\\|y<br> |");
  });

  it("walks the cells with Tab and adds a row after the last one", () => {
    const { parent, view } = mount("| a | b |\n|---|---|\n| 1 | 2 |\n\n后");
    click(cellAt(parent, 0, 0));
    press(editing(parent)!, { key: "Tab" });
    expect(editing(parent)).toBe(cellAt(parent, 0, 1));
    press(editing(parent)!, { key: "Tab" });
    expect(editing(parent)).toBe(cellAt(parent, 1, 0));
    press(editing(parent)!, { key: "Tab", shiftKey: true });
    expect(editing(parent)).toBe(cellAt(parent, 0, 1));

    click(cellAt(parent, 1, 1));
    press(editing(parent)!, { key: "Tab" });
    // 最后一格再按 Tab：下面多了一行空格子，光标在它的第一格
    expect(view.state.doc.toString()).toBe("| a | b |\n|---|---|\n| 1 | 2 |\n|   |   |\n\n后");
    expect(editing(parent)).toBe(cellAt(parent, 2, 0));
    typeIn(editing(parent)!, "新");
    expect(view.state.doc.line(4).text).toBe("| 新 |   |");
  });

  it("moves down with Enter, inserts with Mod+Enter and deletes from the toolbar", () => {
    const { parent, view } = mount("| a |\n|---|\n| 1 |\n| 2 |\n\n后");
    click(cellAt(parent, 1, 0));
    press(editing(parent)!, { key: "Enter" });
    expect(editing(parent)).toBe(cellAt(parent, 2, 0));

    press(editing(parent)!, { key: "Enter", ctrlKey: true });
    expect(view.state.doc.toString()).toBe("| a |\n|---|\n| 1 |\n| 2 |\n|   |\n\n后");
    expect(editing(parent)).toBe(cellAt(parent, 3, 0));

    // 表头下面插一行：落在分隔行后面
    click(cellAt(parent, 0, 0));
    press(editing(parent)!, { key: "Enter", ctrlKey: true });
    expect(view.state.doc.toString()).toBe("| a |\n|---|\n|   |\n| 1 |\n| 2 |\n|   |\n\n后");

    const remove = parent.querySelector<HTMLButtonElement>('[data-action="row-delete"]')!;
    remove.click();
    expect(view.state.doc.toString()).toBe("| a |\n|---|\n| 1 |\n| 2 |\n|   |\n\n后");
    expect(editing(parent)).toBe(cellAt(parent, 1, 0));
  });

  it("fills in the missing cells of a short row", () => {
    const { parent, view } = mount("| a | b | c |\n|---|---|---|\n| 1 |\n\n后");
    const cell = cellAt(parent, 1, 2);
    click(cell);
    typeIn(cell, "x");
    expect(view.state.doc.line(3).text).toBe("| 1 |   | x |");
  });

  it("quotes csv fields that need it", () => {
    const { parent, view } = mount("```csv\n名字,备注\n苹果,甜\n```\n\n后");
    const cell = cellAt(parent, 1, 1);
    click(cell);
    expect(cell.textContent).toBe("甜");
    typeIn(cell, '红的, "脆"的');
    expect(view.state.doc.line(3).text).toBe('苹果,"红的, ""脆""的"');
    expect(parent.querySelector(".cm-odea-table-meta")?.textContent).toBe("1 行 · 2 列");
  });

  it("undoes typing through the editor history and shows it in the cell", () => {
    const { parent, view } = mount("| a |\n|---|\n| 1 |\n\n后");
    const cell = cellAt(parent, 1, 0);
    click(cell);
    typeIn(cell, "12");
    expect(view.state.doc.line(3).text).toBe("| 12 |");
    press(cell, { key: "z", ctrlKey: true });
    expect(view.state.doc.line(3).text).toBe("| 1 |");
    expect(cell.textContent).toBe("1");
  });

  // 撤销会把正文光标恢复到改动前的位置并滚过去：光标要是还在文档开头，一撤销整页滚走，
  // 表格被回收、格子丢焦点。所以点进格子时先把正文光标停到表格紧下面一行。
  it("parks the editor caret right below the table so undo doesn't scroll away", () => {
    const source = "开头一段\n\n| a |\n|---|\n| 1 |\n\n后";
    const { parent, view } = mount(source);
    view.dispatch({ selection: { anchor: 0 } });
    const cell = cellAt(parent, 1, 0);
    click(cell);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(6);
    typeIn(cell, "2");
    press(cell, { key: "z", ctrlKey: true });
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(6);
    expect(editing(parent)).toBe(cell);
    expect(cell.textContent).toBe("1");
  });

  it("keeps the toolbar up while moving between cells (no re-entrance flash)", () => {
    const { parent } = mount("| a | b |\n|---|---|\n| 1 | 2 |\n\n后");
    const block = parent.querySelector<HTMLElement>(".cm-odea-table-block")!;
    click(cellAt(parent, 1, 0));
    expect(block.classList.contains("is-editing")).toBe(true);
    const observer = new MutationObserver(() => {});
    observer.observe(block, {
      attributes: true,
      attributeFilter: ["class"],
      attributeOldValue: true,
    });
    click(cellAt(parent, 1, 1));
    press(editing(parent)!, { key: "Tab", shiftKey: true });
    press(editing(parent)!, { key: "Enter", ctrlKey: true });
    const records = observer.takeRecords();
    observer.disconnect();
    // 每次改 class 之前它都还带着 is-editing：中途一次都没摘掉过，工具栏没有收起再弹出
    const dropped = records.filter((record) => !(record.oldValue ?? "").includes("is-editing"));
    expect(dropped).toEqual([]);
    expect(block.classList.contains("is-editing")).toBe(true);
  });

  it("inserts and deletes columns, reformatting the GFM source", () => {
    const { parent, view } = mount("| 名字 | 数量 |\n| :-- | --: |\n| 苹果 | 3 |\n\n后");
    click(cellAt(parent, 1, 0));
    parent.querySelector<HTMLButtonElement>('[data-action="col-right"]')!.click();
    expect(view.state.doc.toString()).toBe(
      "| 名字 |     | 数量 |\n| :--- | --- | ---: |\n| 苹果 |     |    3 |\n\n后",
    );
    // 光标进了新的那一列，直接打字
    expect(editing(parent)).toBe(cellAt(parent, 1, 1));
    typeIn(editing(parent)!, "红");
    expect(view.state.doc.line(3).text).toBe("| 苹果 | 红 |    3 |");

    parent.querySelector<HTMLButtonElement>('[data-action="col-left"]')!.click();
    expect(view.state.doc.line(1).text).toBe("| 名字 |     |     | 数量 |");
    expect(editing(parent)).toBe(cellAt(parent, 1, 1));

    parent.querySelector<HTMLButtonElement>('[data-action="col-delete"]')!.click();
    parent.querySelector<HTMLButtonElement>('[data-action="col-delete"]')!.click();
    expect(view.state.doc.toString()).toBe(
      "| 名字 | 数量 |\n| :--- | ---: |\n| 苹果 |    3 |\n\n后",
    );
    expect(parent.querySelectorAll(".cm-odea-table-widget th")).toHaveLength(2);
  });

  it("won't delete the last column or the header row", () => {
    const { parent } = mount("| a |\n|---|\n| 1 |\n\n后");
    click(cellAt(parent, 0, 0));
    const button = (action: string) =>
      parent.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
    expect(button("col-delete").disabled).toBe(true);
    expect(button("row-delete").disabled).toBe(true);
    press(editing(parent)!, { key: "ArrowDown" });
    expect(button("row-delete").disabled).toBe(false);
  });

  it("sets and clears a column's alignment without leaving the cell", () => {
    const { parent, view } = mount("| a | b |\n| --- | --- |\n| 1 | 2 |\n\n后");
    const cell = cellAt(parent, 1, 1);
    click(cell);
    const center = parent.querySelector<HTMLButtonElement>('[data-action="align-center"]')!;
    center.click();
    expect(view.state.doc.line(2).text).toBe("| --- | :-: |");
    expect(center.classList.contains("is-on")).toBe(true);
    expect(cell.style.textAlign).toBe("center");
    expect(editing(parent)).toBe(cell);
    // 再点一次：恢复默认
    center.click();
    expect(view.state.doc.line(2).text).toBe("| --- | --- |");
    expect(center.classList.contains("is-on")).toBe(false);
  });

  it("adds and removes csv columns line by line and has no alignment buttons", () => {
    const { parent, view } = mount('```csv\n名字,备注\n苹果,"红的, 甜的"\n```\n\n后');
    click(cellAt(parent, 1, 0));
    expect(parent.querySelector('[data-action="align-left"]')).toBeNull();
    parent.querySelector<HTMLButtonElement>('[data-action="col-right"]')!.click();
    expect(view.state.doc.toString()).toBe('```csv\n名字,,备注\n苹果,,"红的, 甜的"\n```\n\n后');
    typeIn(editing(parent)!, "3");
    expect(view.state.doc.line(3).text).toBe('苹果,3,"红的, 甜的"');
    parent.querySelector<HTMLButtonElement>('[data-action="col-delete"]')!.click();
    expect(view.state.doc.toString()).toBe('```csv\n名字,备注\n苹果,"红的, 甜的"\n```\n\n后');
  });

  it("goes back to the source from the toolbar", () => {
    const { parent, view } = mount("| a |\n|---|\n| 1 |\n\n后");
    click(cellAt(parent, 1, 0));
    parent.querySelector<HTMLButtonElement>('[data-action="source"]')!.click();
    expect(parent.querySelector(".cm-odea-table-widget")).toBeNull();
    expect(view.state.selection.main.head).toBe(0);
  });
});

describe("点击位置对到源码", () => {
  it("skips markup the rendered text doesn't show", () => {
    expect(mapOffset("abc", "abc", 2)).toBe(2);
    expect(mapOffset("粗体", "**粗体**", 1)).toBe(3);
    expect(mapOffset("链接", "[链接](https://x)", 2)).toBe(3);
    expect(mapOffset("🚀", ":rocket:", 1)).toBe(":rocket:".length);
  });
});
