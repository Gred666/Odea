// @vitest-environment happy-dom

import { history } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { typoraDecorations } from "./MarkdownEditor";
import { markdownSupport } from "./markdownParser";
import { EMPTY_TABLE, insertEmptyTable, mapOffset, shiftedAt } from "./tableWidget";

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
/** 正在编辑的格子里的子编辑器（cellEditor.ts） */
const fieldOf = (cell: HTMLElement) => {
  const dom = cell.querySelector<HTMLElement>(".cm-editor");
  return dom ? EditorView.findFromDOM(dom) : null;
};
/** 格子里的字：在编辑的看子编辑器里的文字，没在编辑的看画出来的字 */
const textOf = (cell: HTMLElement) => fieldOf(cell)?.state.doc.toString() ?? cell.textContent;
/** 模拟在格子里打字：子编辑器里的字整段换成 text，光标在最后 */
const typeIn = (cell: HTMLElement, text: string) => {
  const field = fieldOf(cell)!;
  field.dispatch({
    changes: { from: 0, to: field.state.doc.length, insert: text },
    selection: { anchor: text.length },
    userEvent: "input.type",
  });
};
/** 按键：正在编辑的格子发给子编辑器（它的按键表接着表格的） */
const press = (node: Element, init: KeyboardEventInit) =>
  (node.querySelector(".cm-content") ?? node).dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
  );
const editing = (parent: HTMLElement) =>
  parent.querySelector<HTMLTableCellElement>(".cm-odea-table-widget .is-editing");
/** 选中的格子（`行:列`） */
const selected = (parent: HTMLElement) =>
  [...parent.querySelectorAll<HTMLElement>(".cm-odea-table-widget .is-selected")].map(
    (node) => `${node.dataset.row}:${node.dataset.col}`,
  );
const sink = (parent: HTMLElement) =>
  parent.querySelector<HTMLTextAreaElement>(".cm-odea-table-sink")!;
/** 右键一格，点菜单里的一项（正在编辑的格子先按 Esc 选中：编辑中右键的菜单顶上多了剪切、复制、粘贴，操作对着这一格） */
const fromMenu = (parent: HTMLElement, cell: HTMLElement, label: string) => {
  if (editing(parent) === cell) press(cell, { key: "Escape" });
  cell.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
  const item = menuItem(label);
  if (!item) throw new Error(`菜单里没有「${label}」`);
  item.click();
};
const menuItem = (label: string) =>
  [
    ...document.querySelectorAll<HTMLButtonElement>(
      '.cm-odea-table-menu[data-state="open"] button',
    ),
  ].find((button) => button.textContent === label || button.getAttribute("aria-label") === label);
const closeMenus = () =>
  document
    .querySelector<HTMLElement>('.cm-odea-table-menu[data-state="open"]')
    ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

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
    expect(textOf(cell)).toBe("**粗体**");

    typeIn(cell, "**粗体** 改");
    expect(view.state.doc.toString()).toBe(
      "| 语法 | 状态 |\n| :-- | :--: |\n| **粗体** 改 | ok |\n\n后",
    );
    // 表格没有被重建，正在编辑的格子还是那个、还在编辑
    expect(parent.querySelector(".cm-odea-table-block")).toBe(block);
    expect(editing(parent)).toBe(cell);
    expect(textOf(cell)).toBe("**粗体** 改");

    // Esc：先选中这一格（格子渲染回去），再按一次回到正文（表格下面那一行）
    press(cell, { key: "Escape" });
    expect(editing(parent)).toBeNull();
    expect(selected(parent)).toEqual(["1:0"]);
    expect(cellAt(parent, 1, 0).querySelector("strong")?.textContent).toBe("粗体");
    press(sink(parent), { key: "Escape" });
    expect(selected(parent)).toEqual([]);
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

  it("moves down with Enter, inserts with Mod+Enter and deletes from the menu", () => {
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

    fromMenu(parent, editing(parent)!, "删除这一行");
    expect(view.state.doc.toString()).toBe("| a |\n|---|\n| 1 |\n| 2 |\n|   |\n\n后");
    expect(editing(parent)).toBe(cellAt(parent, 1, 0));
  });

  it("opens the table menu with cut / copy / paste when right-clicking the cell being edited", () => {
    // 以前编辑中的格子里右键放给系统菜单：只有点到格子边上（落在旁边那一格）才出表格的菜单
    const { parent, view } = mount("| 名字 | 备注 |\n| --- | --- |\n| 甲 | 你好世界 |\n\n后");
    click(cellAt(parent, 1, 1));
    const cell = editing(parent)!;
    // happy-dom 写 DOM 选区时同步发 selectionchange（见下面 Mod+B 那一条），选字、剪切这两步先挡掉
    const mute = (event: Event) => event.stopImmediatePropagation();
    document.addEventListener("selectionchange", mute, true);
    try {
      fieldOf(cell)!.dispatch({ selection: { anchor: 2, head: 4 } });
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
      cell.querySelector(".cm-content")!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      const labels = [
        ...document.querySelectorAll(
          '.cm-odea-table-menu[data-state="open"] .cm-odea-table-menu-text',
        ),
      ].map((node) => node.textContent);
      expect(labels.slice(0, 3)).toEqual(["剪切", "复制", "粘贴"]);
      expect(labels).toContain("删除这一行");

      // 剪切：选中的字没了、写回正文，还在改这一格（没转成选格子）
      [...document.querySelectorAll<HTMLButtonElement>(".cm-odea-table-menu-item")]
        .find((button) => button.textContent?.startsWith("剪切"))!
        .click();
    } finally {
      document.removeEventListener("selectionchange", mute, true);
    }
    expect(view.state.doc.line(3).text).toBe("| 甲 | 你好 |");
    expect(editing(parent)).toBe(cell);
    expect(selected(parent)).toEqual([]);

    // 「清空内容」对着正在改的这一格，清完接着改它
    cell.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
    );
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        '.cm-odea-table-menu[data-state="open"] .cm-odea-table-menu-item',
      ),
    ]
      .find((button) => button.textContent?.startsWith("清空内容"))!
      .click();
    expect(view.state.doc.line(3).text).toBe("| 甲 |  |");
    expect(editing(parent)).toBe(cellAt(parent, 1, 1));
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
    expect(textOf(cell)).toBe("甜");
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
    expect(textOf(cell)).toBe("1");
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
    expect(textOf(cell)).toBe("1");
  });

  it("keeps the column widths locked while moving between cells", () => {
    const { parent } = mount("| a | b |\n|---|---|\n| 1 | 2 |\n\n后");
    const block = parent.querySelector<HTMLElement>(".cm-odea-table-block")!;
    click(cellAt(parent, 1, 0));
    expect(block.classList.contains("is-active")).toBe(true);
    expect(parent.querySelector("table")!.style.tableLayout).toBe("fixed");
    const observer = new MutationObserver(() => {});
    observer.observe(block, {
      attributes: true,
      attributeFilter: ["class"],
      attributeOldValue: true,
    });
    click(cellAt(parent, 1, 1));
    press(editing(parent)!, { key: "Tab", shiftKey: true });
    press(editing(parent)!, { key: "Enter", ctrlKey: true });
    press(editing(parent)!, { key: "Escape" });
    const records = observer.takeRecords();
    observer.disconnect();
    // 每次改 class 之前它都还带着 is-active：换格子、插行、转去选格子，中途一次都没离开过表格
    const dropped = records.filter((record) => !(record.oldValue ?? "").includes("is-active"));
    expect(dropped).toEqual([]);
    expect(parent.querySelector("table")!.style.tableLayout).toBe("fixed");
  });

  it("inserts and deletes columns from the menu, reformatting the GFM source", () => {
    const { parent, view } = mount("| 名字 | 数量 |\n| :-- | --: |\n| 苹果 | 3 |\n\n后");
    click(cellAt(parent, 1, 0));
    fromMenu(parent, cellAt(parent, 1, 0), "在右侧插入列");
    expect(view.state.doc.toString()).toBe(
      "| 名字 |     | 数量 |\n| :--- | --- | ---: |\n| 苹果 |     |    3 |\n\n后",
    );
    // 光标进了新的那一列，直接打字
    expect(editing(parent)).toBe(cellAt(parent, 1, 1));
    typeIn(editing(parent)!, "红");
    expect(view.state.doc.line(3).text).toBe("| 苹果 | 红 |    3 |");

    fromMenu(parent, cellAt(parent, 1, 1), "在左侧插入列");
    expect(view.state.doc.line(1).text).toBe("| 名字 |     |     | 数量 |");
    expect(editing(parent)).toBe(cellAt(parent, 1, 1));

    fromMenu(parent, cellAt(parent, 1, 1), "删除这一列");
    fromMenu(parent, cellAt(parent, 1, 1), "删除这一列");
    expect(view.state.doc.toString()).toBe(
      "| 名字 | 数量 |\n| :--- | ---: |\n| 苹果 |    3 |\n\n后",
    );
    expect(parent.querySelectorAll(".cm-odea-table-widget th")).toHaveLength(2);
  });

  it("won't delete the last column or the header row", () => {
    const { parent } = mount("| a |\n|---|\n| 1 |\n\n后");
    const header = cellAt(parent, 0, 0);
    header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(menuItem("删除这一列")?.getAttribute("aria-disabled")).toBe("true");
    expect(menuItem("删除这一行")?.getAttribute("aria-disabled")).toBe("true");
    closeMenus();
    cellAt(parent, 1, 0).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    expect(menuItem("删除这一行")?.getAttribute("aria-disabled")).toBeNull();
    closeMenus();
  });

  it("sets and clears a column's alignment from the menu, keeping the selection", () => {
    const { parent, view } = mount("| a | b |\n| --- | --- |\n| 1 | 2 |\n\n后");
    click(cellAt(parent, 1, 1));
    fromMenu(parent, cellAt(parent, 1, 1), "居中");
    expect(view.state.doc.line(2).text).toBe("| --- | :-: |");
    expect(cellAt(parent, 1, 1).style.textAlign).toBe("center");
    expect(selected(parent)).toEqual(["1:1"]);
    // 再点一次：恢复默认
    cellAt(parent, 1, 1).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    expect(menuItem("居中")?.classList.contains("is-on")).toBe(true);
    menuItem("居中")!.click();
    expect(view.state.doc.line(2).text).toBe("| --- | --- |");
  });

  it("adds and removes csv columns line by line and has no alignment", () => {
    const { parent, view } = mount('```csv\n名字,备注\n苹果,"红的, 甜的"\n```\n\n后');
    cellAt(parent, 1, 0).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    expect(menuItem("居中")).toBeUndefined();
    menuItem("在右侧插入列")!.click();
    expect(view.state.doc.toString()).toBe('```csv\n名字,,备注\n苹果,,"红的, 甜的"\n```\n\n后');
    typeIn(editing(parent)!, "3");
    expect(view.state.doc.line(3).text).toBe('苹果,3,"红的, 甜的"');
    fromMenu(parent, editing(parent)!, "删除这一列");
    expect(view.state.doc.toString()).toBe('```csv\n名字,备注\n苹果,"红的, 甜的"\n```\n\n后');
  });

  it("goes back to the source from the menu, and clicking the frame doesn't", () => {
    const { parent, view } = mount("| a |\n|---|\n| 1 |\n\n后");
    // 点到外框、格子之间的缝：不再整张表退回源码
    click(parent.querySelector(".cm-odea-table-frame")!);
    expect(parent.querySelector(".cm-odea-table-widget")).not.toBeNull();
    fromMenu(parent, cellAt(parent, 1, 0), "编辑源码");
    expect(parent.querySelector(".cm-odea-table-widget")).toBeNull();
    expect(view.state.selection.main.head).toBe(0);
  });
});

describe("选格子", () => {
  const shiftClick = (node: Element) =>
    node.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }),
    );

  it("selects a range with Shift+click, moves it with arrows and clears it with Delete", () => {
    const { parent, view } = mount(
      "| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n\n后",
    );
    click(cellAt(parent, 1, 0));
    shiftClick(cellAt(parent, 2, 1));
    expect(editing(parent)).toBeNull();
    expect(selected(parent)).toEqual(["1:0", "1:1", "2:0", "2:1"]);
    expect(document.activeElement).toBe(sink(parent));

    press(sink(parent), { key: "ArrowRight", shiftKey: true });
    expect(selected(parent)).toHaveLength(6);
    press(sink(parent), { key: "Delete" });
    expect(view.state.doc.toString()).toBe(
      "| a | b | c |\n|---|---|---|\n|  |  |  |\n|  |  |  |\n\n后",
    );
    // 方向键：选区收成一格，从活动的那一头（右下角）往上走
    press(sink(parent), { key: "ArrowUp" });
    expect(selected(parent)).toEqual(["1:2"]);
  });

  it("starts editing with Enter, and typing replaces the cell like a spreadsheet", () => {
    const { parent, view } = mount("| a | b |\n|---|---|\n| 1 | 2 |\n\n后");
    click(cellAt(parent, 1, 1));
    press(editing(parent)!, { key: "Escape" });
    expect(selected(parent)).toEqual(["1:1"]);
    // 打字：清空这一格、写进去，接着改这一格
    sink(parent).value = "新";
    sink(parent).dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(view.state.doc.line(3).text).toBe("| 1 | 新 |");
    expect(editing(parent)).toBe(cellAt(parent, 1, 1));
    expect(textOf(editing(parent)!)).toBe("新");

    press(editing(parent)!, { key: "Escape" });
    press(sink(parent), { key: "Enter" });
    expect(editing(parent)).toBe(cellAt(parent, 1, 1));
  });

  it("selects the whole table with Mod+A from an empty cell", () => {
    const { parent } = mount("| a | b |\n|---|---|\n|  | 2 |\n\n后");
    click(cellAt(parent, 1, 0));
    press(editing(parent)!, { key: "a", ctrlKey: true });
    expect(selected(parent)).toHaveLength(4);
  });

  it("copies the range as TSV, HTML and its own markdown, and pastes a block that grows the table", () => {
    const { parent, view } = mount("| a | b |\n|---|---|\n| **粗** | 2 |\n\n后");
    click(cellAt(parent, 0, 0));
    shiftClick(cellAt(parent, 1, 1));
    const data = new DataTransfer();
    sink(parent).dispatchEvent(
      new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: data }),
    );
    expect(data.getData("text/plain")).toBe("a\tb\n粗\t2");
    expect(data.getData("text/html")).toContain("<strong>粗</strong>");
    expect(JSON.parse(data.getData("application/x-odea-table")).cells).toEqual([
      ["a", "b"],
      ["**粗**", "2"],
    ]);

    // 选中右下角那一格，贴一块 2×2：右边、下边都不够，表格跟着长
    click(cellAt(parent, 1, 1));
    press(editing(parent)!, { key: "Escape" });
    const paste = new DataTransfer();
    paste.setData("text/plain", "x\ty\nz\tw");
    sink(parent).dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: paste }),
    );
    expect(view.state.doc.toString()).toBe(
      "| a      | b   |     |\n| ------ | --- | --- |\n| **粗** | x   | y   |\n|        | z   | w   |\n\n后",
    );
    expect(selected(parent)).toEqual(["1:1", "1:2", "2:1", "2:2"]);
  });

  it("pastes a spreadsheet block into the cell being edited", () => {
    const { parent, view } = mount("| a | b |\n|---|---|\n| 1 | 2 |\n\n后");
    click(cellAt(parent, 1, 0));
    const paste = new DataTransfer();
    paste.setData("text/plain", "x\ty");
    editing(parent)!
      .querySelector(".cm-content")!
      .dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: paste }),
      );
    expect(view.state.doc.line(3).text).toBe("| x | y |");
  });

  it("sorts a column from its menu, numbers by value", () => {
    const { parent, view } = mount(
      "| 名 | 数 |\n|---|---|\n| 乙 | 10 |\n| 甲 | 9 |\n| 丙 |  |\n\n后",
    );
    fromMenu(parent, cellAt(parent, 0, 1), "升序排列");
    expect(view.state.doc.toString()).toBe(
      "| 名 | 数 |\n|---|---|\n| 甲 | 9 |\n| 乙 | 10 |\n| 丙 |  |\n\n后",
    );
  });
});

describe("合并单元格", () => {
  it("renders `<` and `^` as spans and skips the covered cells", () => {
    const { parent } = mount(
      "| 阶段 | 内容 | 负责人 |\n|---|---|---|\n| 一 | 编辑 | 张 |\n| ^ | 选区 | ^ |\n| 备注 | 后面 | < |\n\n后",
    );
    const first = cellAt(parent, 1, 0);
    expect(first.rowSpan).toBe(2);
    expect(cellAt(parent, 1, 2).rowSpan).toBe(2);
    expect(cellAt(parent, 3, 1).colSpan).toBe(2);
    expect(parent.querySelectorAll('[data-row="2"]')).toHaveLength(1);
    expect(parent.querySelector('[data-row="3"][data-col="2"]')).toBeNull();
    expect(parent.textContent).not.toContain("^");
  });

  it("merges a selection from the pill, joining the text, and splits it back", () => {
    const { parent, view } = mount("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\n后");
    click(cellAt(parent, 1, 0));
    cellAt(parent, 2, 1).dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }),
    );
    const pill = parent.querySelector<HTMLButtonElement>(".cm-odea-table-pill")!;
    expect(pill.classList.contains("is-shown")).toBe(true);
    expect(pill.textContent).toBe("合并单元格");
    pill.click();
    expect(view.state.doc.toString()).toBe(
      "| a | b |\n|---|---|\n| 1<br>2<br>3<br>4 | < |\n| ^ | < |\n\n后",
    );
    expect(cellAt(parent, 1, 0).rowSpan).toBe(2);
    expect(cellAt(parent, 1, 0).colSpan).toBe(2);
    expect(pill.textContent).toBe("拆分单元格");
    pill.click();
    expect(view.state.doc.toString()).toBe(
      "| a | b |\n|---|---|\n| 1<br>2<br>3<br>4 |  |\n|  |  |\n\n后",
    );
  });

  it("won't merge the header with the body, and escapes a typed `<`", () => {
    const { parent, view } = mount("| a | b |\n|---|---|\n| 1 | 2 |\n\n后");
    click(cellAt(parent, 0, 0));
    cellAt(parent, 1, 0).dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }),
    );
    expect(parent.querySelector(".cm-odea-table-pill")!.classList.contains("is-shown")).toBe(false);
    click(cellAt(parent, 1, 1));
    typeIn(editing(parent)!, "<");
    expect(view.state.doc.line(3).text).toBe("| 1 | \\< |");
    // 正在打的字不被换成源码的样子
    expect(textOf(editing(parent)!)).toBe("<");
  });

  it("grows a vertical merge when a row is inserted inside it", () => {
    const { parent, view } = mount("| a | b |\n|---|---|\n| 1 | x |\n| ^ | y |\n\n后");
    click(cellAt(parent, 1, 1));
    press(editing(parent)!, { key: "Enter", ctrlKey: true });
    expect(view.state.doc.toString()).toBe(
      "| a | b |\n|---|---|\n| 1 | x |\n| ^ |   |\n| ^ | y |\n\n后",
    );
    expect(cellAt(parent, 1, 0).rowSpan).toBe(3);
  });
});

describe("格子里的子编辑器", () => {
  it("only reveals the markers the caret touches, like the body text", () => {
    const { parent } = mount("| a |\n|---|\n| **粗** 字 |\n\n后");
    const cell = cellAt(parent, 1, 0);
    click(cell);
    // 光标在最后（没碰到粗体）：`**` 收着，粗体照样画
    const content = cell.querySelector(".cm-content")!;
    expect(content.textContent).toBe("粗 字");
    expect(content.querySelector(".cm-odea-strong")?.textContent).toBe("粗");
    fieldOf(cell)!.dispatch({ selection: { anchor: 3 } });
    expect(content.textContent).toBe("**粗** 字");
  });

  it("shows <br> as a real line break and walks its lines before leaving the cell", () => {
    const { parent, view } = mount("| a |\n|---|\n| 一<br>二 |\n| 三 |\n\n后");
    const cell = cellAt(parent, 1, 0);
    click(cell);
    expect(textOf(cell)).toBe("一\n二");
    expect(cell.querySelectorAll(".cm-line")).toHaveLength(2);
    // 第一行按 ↓：还在这一格里（子编辑器自己往下走）
    fieldOf(cell)!.dispatch({ selection: { anchor: 1 } });
    press(cell, { key: "ArrowDown" });
    expect(editing(parent)).toBe(cell);
    // 最后一行按 ↓：到下一行
    fieldOf(cell)!.dispatch({ selection: { anchor: 3 } });
    press(cell, { key: "ArrowDown" });
    expect(editing(parent)).toBe(cellAt(parent, 2, 0));
    expect(view.state.doc.line(3).text).toBe("| 一<br>二 |");
  });

  it("treats block syntax as plain text and wraps with Mod+B", () => {
    const { parent, view } = mount("| a |\n|---|\n| # 不是标题 |\n\n后");
    const cell = cellAt(parent, 1, 0);
    click(cell);
    expect(cell.querySelector("[class*='heading']")).toBeNull();
    // happy-dom 在写 DOM 选区时同步发 selectionchange（浏览器是排到后面的），子编辑器会在自己的
    // update 里再读一次 DOM。这一条只看按键，先把它挡掉
    const mute = (event: Event) => event.stopImmediatePropagation();
    document.addEventListener("selectionchange", mute, true);
    try {
      fieldOf(cell)!.dispatch({ selection: { anchor: 2, head: 6 } });
      press(cell, { key: "b", ctrlKey: true });
    } finally {
      document.removeEventListener("selectionchange", mute, true);
    }
    expect(view.state.doc.line(3).text).toBe("| # **不是标题** |");
  });

  it("doesn't rewrite a cell it only looked at", () => {
    const source = "| a |\n|---|\n| 一<br/>二 \\| 三 |\n|     |\n\n后";
    const { parent, view } = mount(source);
    click(cellAt(parent, 1, 0));
    expect(textOf(editing(parent)!)).toBe("一\n二 | 三");
    press(editing(parent)!, { key: "Tab" });
    // 空格子：子编辑器里是空的，不是那几个空格
    expect(textOf(editing(parent)!)).toBe("");
    press(editing(parent)!, { key: "Escape" });
    press(sink(parent), { key: "Escape" });
    expect(view.state.doc.toString()).toBe(source);
  });

  it("only lets a read-only reader select and copy", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const doc = "| a | b |\n|---|---|\n| 1 | 2 |\n\n后";
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [
          markdownSupport(),
          typoraDecorations,
          history(),
          EditorState.readOnly.of(true),
        ],
      }),
    });
    views.push(view);
    click(cellAt(parent, 1, 0));
    expect(editing(parent)).toBeNull();
    expect(selected(parent)).toEqual(["1:0"]);
    press(sink(parent), { key: "Delete" });
    sink(parent).value = "改";
    sink(parent).dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(view.state.doc.toString()).toBe(doc);
    cellAt(parent, 1, 0).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
    );
    expect(menuItem("删除这一行")).toBeUndefined();
    expect(menuItem("复制为 Markdown")).toBeDefined();
    closeMenus();
  });
});

describe("HTML 表格", () => {
  const html = `<table>
  <caption>标题</caption>
  <thead>
    <tr><th>名</th><th align="right">数</th></tr>
  </thead>
  <tbody>
    <tr><td style="color:green">甲 &amp; <b>粗</b></td><td rowspan="2">2</td></tr>
    <tr><td>乙</td></tr>
  </tbody>
</table>`;

  it("renders with its caption, spans and cell styles, and edits a cell in place", () => {
    const { parent, view } = mount(`${html}\n\n后`);
    expect(parent.querySelector(".cm-odea-table-caption")?.textContent).toBe("标题");
    expect(cellAt(parent, 1, 1).rowSpan).toBe(2);
    expect(cellAt(parent, 1, 0).style.color).toBe("green");
    expect(cellAt(parent, 0, 1).style.textAlign).toBe("right");
    expect(cellAt(parent, 1, 0).querySelector("b")?.textContent).toBe("粗");

    click(cellAt(parent, 2, 0));
    typeIn(editing(parent)!, "乙丙");
    expect(view.state.doc.toString()).toBe(`${html.replace("<td>乙</td>", "<td>乙丙</td>")}\n\n后`);
    // 格子里是 HTML：`**` 是字
    press(editing(parent)!, { key: "Escape" });
    // 插在竖着的合并块中间：rowspan 跟着变大，别的行原样
    fromMenu(parent, cellAt(parent, 2, 0), "在上方插入行");
    expect(view.state.doc.toString()).toContain(
      '<td rowspan="3">2</td></tr>\n    <tr><td></td></tr>\n    <tr><td>乙丙</td></tr>\n  </tbody>',
    );
    expect(cellAt(parent, 1, 1).rowSpan).toBe(3);
  });

  it("turns into a Markdown table from the menu", () => {
    const { parent, view } = mount(`${html}\n\n后`);
    fromMenu(parent, cellAt(parent, 1, 0), "转成 Markdown 表格");
    expect(view.state.doc.toString()).toBe(
      "标题\n\n| 名          |  数 |\n| ----------- | --: |\n| 甲 & **粗** |   2 |\n| 乙          |   ^ |\n\n后",
    );
  });

  it("leaves tables it can't edit as a read-only HTML block", () => {
    const { parent } = mount("<table><tr><td><ul><li>x</li></ul></td></tr></table>\n\n后");
    expect(parent.querySelector(".cm-odea-table-widget")).toBeNull();
    expect(parent.querySelector("table")).not.toBeNull();
  });
});

describe("新建表格", () => {
  it("inserts a rendered empty table and puts the caret in its first cell", () => {
    const { parent, view } = mount("前面一段");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    insertEmptyTable(view);
    expect(view.state.doc.toString()).toBe(`前面一段\n\n${EMPTY_TABLE}\n`);
    expect(editing(parent)).toBe(cellAt(parent, 0, 0));
    typeIn(editing(parent)!, "名字");
    expect(view.state.doc.line(3).text).toBe("| 名字 |     |     |");
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

describe("别处插了 / 删了一行（列）：找出位置", () => {
  it("只差一个时给出位置；同时还改了别处就不认", () => {
    expect(shiftedAt(["甲", "乙"], ["丙", "甲", "乙"], null)).toBe(0);
    expect(shiftedAt(["甲", "乙"], ["甲", "丙", "乙"], null)).toBe(1);
    expect(shiftedAt(["甲", "乙"], ["甲", "乙", "丙"], null)).toBe(2);
    expect(shiftedAt(["甲", "乙", "丙"], ["甲", "丙"], null)).toBe(1);
    expect(shiftedAt(["甲", "乙"], ["丙", "甲", "改"], null)).toBeNull();
    expect(shiftedAt(["甲", "乙"], ["甲", "乙"], null)).toBeNull();
    expect(shiftedAt(["甲"], ["甲", "乙", "丙"], null)).toBeNull();
  });

  it("落在一串一样的里面：挑一处不挪正在编辑的那个", () => {
    // 三个空行里插了一个：正在编辑第 1 个（下标 1），插在它后面
    expect(shiftedAt(["甲", "", "", "乙"], ["甲", "", "", "", "乙"], 1)).toBe(2);
    // 正在编辑的是这串的最后一个：也插在它后面
    expect(shiftedAt(["甲", "", "", "乙"], ["甲", "", "", "", "乙"], 2)).toBe(3);
    // 删了一个空行：别删正在编辑的那个
    expect(shiftedAt(["甲", "", "", "乙"], ["甲", "", "乙"], 2)).toBe(1);
    expect(shiftedAt(["甲", "", "", "乙"], ["甲", "", "乙"], 1)).toBe(2);
    // 只剩它一个能删：就是它被删了
    expect(shiftedAt(["甲", "乙"], ["甲"], 1)).toBe(1);
  });
});
