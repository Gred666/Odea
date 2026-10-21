import { commonEnds } from "@/lib/lineDiff";
import { MOD_KEY } from "@/lib/platform";
import { redo, undo } from "@codemirror/commands";
import type { ChangeSpec } from "@codemirror/state";
import type { EditorView, WidgetType } from "@codemirror/view";
import { renderInline } from "./inlineDom";
import { openExternal } from "./links";
import {
  type MarkdownTableModel,
  type TableAlignment,
  type TableFormat,
  alignmentMarker,
  csvCellSource,
  delimiterOf,
  emptyRowSource,
  formatGfmTable,
  gfmCellSource,
  numericColumns,
} from "./markdownTable";
import { flushAllEditors } from "./saveBus";
import { OtwWidget, copyButton, jumpToSource, positionOf } from "./widgets";

/* ============================================================
   表格替身：GFM 表格和 ```csv / ```tsv 围栏。

   格子里可以直接改（以前点一下整张表退回源码）。做法和正文一样是 Typora 式的：
   点进一个格子，这个格子露出它自己的 Markdown 源码（`**粗**` 就显示 `**粗**`），
   离开时再渲染回去 —— 没有「富文本 ↔ Markdown」的互转。每敲一个字就把这个格子
   写回它在源码里的那一小段，撤销、自动保存都和在正文里打字一样。

   - Tab / Shift+Tab：下一格 / 上一格；最后一格再按 Tab 在下面加一行
   - Enter：下一行同一列；最后一行按 Enter 离开表格；Shift+Enter 在格子里换行（`<br>`）
   - Mod+Enter：在下面插入一行
   - ↑ ↓：上一行 / 下一行；← → 在格子两头时换到相邻的格子；走出表格就回到正文
   - Esc：回到正文（表格后面那一行）
   - 编辑时表格右上角浮出一条小工具栏：行（插入、删除）｜列（左插、右插、删除）｜
     对齐（左、中、右，GFM 才有）｜源码。插列 / 删列时 GFM 整张表按列宽重新排版源码

   CodeMirror 对替身里的事件、DOM 变动、选区一概不管（WidgetType.ignoreEvent 默认 true），
   格子是一个独立的可编辑区，和正文的编辑互不打架。写回源码之后装饰层会换上一个
   新的 TableWidget，updateDOM 就地更新旧的 DOM —— 正在编辑的那个格子不动，
   光标、输入法都不受影响。
   ============================================================ */

interface TableState {
  view: EditorView;
  widget: TableWidget;
  /** 正在编辑（露出源码）的格子 */
  editing: HTMLTableCellElement | null;
}

const states = new WeakMap<HTMLElement, TableState>();
/** 每个格子上次渲染的内容：updateDOM 时只重画变了的格子 */
const renderedValues = new WeakMap<HTMLTableCellElement, string>();
/** 正在把这个格子里的输入写回源码：这一轮 updateDOM 别去动它 */
let writingFrom: HTMLTableCellElement | null = null;
/** 正在用输入法组字的格子：别人（协同）这时改了表，这一格先不动，免得打断组字 */
let composingIn: HTMLTableCellElement | null = null;

export class TableWidget extends OtwWidget {
  private readonly key: string;

  constructor(
    readonly table: MarkdownTableModel,
    readonly format: TableFormat = "markdown",
    /** 表格源码：CSV / TSV 的复制按钮用；GFM 格子编辑时从这里取源码 */
    readonly source = "",
    /** 表格源码的开头离替身开头多远（GFM 表格可能缩进；CSV 从围栏下一行开始） */
    readonly offset = 0,
  ) {
    super();
    this.key = JSON.stringify(table);
  }

  eq(other: TableWidget) {
    return (
      other.key === this.key &&
      other.format === this.format &&
      other.source === this.source &&
      other.offset === this.offset
    );
  }

  protected override heightKey() {
    return `table:${this.format}:${this.key}`;
  }

  /** 上下留白 + 边框 + 表头约 63px，每行 19px 加每个文字行 22.4px */
  protected override guessHeight() {
    let height = 63 + (this.format === "markdown" ? 0 : 31);
    for (const row of this.table.rows) {
      const breaks = Math.max(0, ...row.map((value) => value.match(/<br\s*\/?>/gi)?.length ?? 0));
      height += 19 + 22.4 * (1 + breaks);
    }
    return Math.round(height);
  }

  /** 第 row 行（0 是表头）第 col 列显示的内容 */
  valueAt(row: number, col: number): string {
    return (row === 0 ? this.table.header[col] : this.table.rows[row - 1]?.[col]) ?? "";
  }

  /** 编辑时格子里露出来的文字：GFM 是这一格的源码原文，CSV 是去掉引号的值 */
  sourceAt(row: number, col: number): string {
    if (this.format !== "markdown") return this.valueAt(row, col);
    const range = this.table.layout?.cells[row]?.[col];
    return range ? this.source.slice(range[0], range[1]) : "";
  }

  get rowCount() {
    return this.table.rows.length + 1;
  }

  get columnCount() {
    return this.table.header.length;
  }

  toDOM(view: EditorView) {
    // 外层只负责留白（padding，见 widgets.ts 文件头）；工具栏绝对定位浮在表格右上角
    const block = document.createElement("div");
    block.className = "cm-odea-table-block";
    const frame = document.createElement("div");
    frame.className = `cm-odea-table-frame is-${this.format}`;
    if (this.format !== "markdown") frame.append(this.bar(view, block));
    const scroller = document.createElement("div");
    scroller.className = "cm-odea-table-scroll";
    const table = document.createElement("table");
    table.className = "cm-odea-table-widget";
    const head = document.createElement("thead");
    head.append(document.createElement("tr"));
    table.append(head, document.createElement("tbody"));
    scroller.append(table);
    frame.append(scroller);
    if (this.layout) block.append(toolbar(view, block, this.format));
    block.append(frame);

    states.set(block, { view, widget: this, editing: null });
    fill(block, this);
    listen(view, block, frame, table);
    return this.settle(block);
  }

  updateDOM(dom: HTMLElement, _view: EditorView, from?: WidgetType): boolean {
    const state = states.get(dom);
    // 只接同一张表：格式、列数一样，行数最多差一行（插入 / 删除一行）
    if (
      !state ||
      (from && from !== state.widget) ||
      state.widget.format !== this.format ||
      Math.abs(state.widget.columnCount - this.columnCount) > 1 ||
      Math.abs(state.widget.rowCount - this.rowCount) > 1
    ) {
      return false;
    }
    const previous = state.widget;
    state.widget = this;
    alignTo(dom, previous, this);
    fill(dom, this);
    syncToolbar(dom);
    const meta = dom.querySelector(".cm-odea-table-meta");
    if (meta) meta.textContent = metaText(this);
    this.trackHeight(dom);
    return true;
  }

  override destroy(dom: HTMLElement) {
    super.destroy(dom);
    states.delete(dom);
  }

  private get layout() {
    return this.table.layout;
  }

  private bar(view: EditorView, block: HTMLElement): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "cm-odea-table-bar";
    const label = document.createElement("span");
    label.className = "cm-odea-table-format";
    label.textContent = this.format.toUpperCase();
    const meta = document.createElement("span");
    meta.className = "cm-odea-table-meta";
    meta.textContent = metaText(this);
    const spacer = document.createElement("span");
    spacer.className = "cm-odea-table-spacer";
    const source = document.createElement("button");
    source.type = "button";
    source.className = "cm-odea-code-copy";
    source.textContent = "源码";
    source.title = "编辑源码";
    source.addEventListener("mousedown", (event) => event.preventDefault());
    source.addEventListener("click", () => showSource(view, block));
    bar.append(
      label,
      meta,
      spacer,
      source,
      copyButton(view, () => this.source, "复制原文"),
    );
    return bar;
  }
}

const metaText = (widget: TableWidget) =>
  `${widget.table.rows.length} 行 · ${widget.columnCount} 列`;

/* ---------------- DOM：建 / 同步格子 ---------------- */

/**
 * 别处插了 / 删了一行或一列（协同时别人改的、撤销）：DOM 里在同一个位置插 / 删，后面的跟着挪。
 * fill 按位置复用格子，不先挪的话，正在编辑的那一格会变成别的行、别的列的内容（docs/协同编辑.md §15.1）
 */
function alignTo(block: HTMLElement, before: TableWidget, after: TableWidget) {
  const editing = states.get(block)?.editing;
  const at = editing ? cellIndex(editing) : null;
  const body = block.querySelector("tbody")!;
  const rowKey = (row: string[]) => row.join("\u0000");
  const row = shiftedAt(
    before.table.rows.map(rowKey),
    after.table.rows.map(rowKey),
    at && at.row > 0 ? at.row - 1 : null,
  );
  if (row !== null) {
    if (after.table.rows.length > before.table.rows.length) {
      body.insertBefore(document.createElement("tr"), body.children[row] ?? null);
    } else body.children[row]?.remove();
  }
  const columns = (widget: TableWidget) =>
    widget.table.header.map((head, col) =>
      [head, ...widget.table.rows.map((cells) => cells[col] ?? "")].join("\u0000"),
    );
  const col = shiftedAt(columns(before), columns(after), at?.col ?? null);
  if (col === null) return;
  const head = block.querySelector("thead")!.firstElementChild!;
  for (const tr of [head, ...body.children]) {
    if (after.columnCount < before.columnCount) {
      tr.children[col]?.remove();
      continue;
    }
    const cell = document.createElement(tr === head ? "th" : "td");
    if (tr === head) cell.scope = "col";
    tr.insertBefore(cell, tr.children[col] ?? null);
  }
}

/**
 * 前后两份只差插进 / 删掉一个（行或列）时，那一个在哪；不是这种改法（同时还改了别处）返回 null，
 * 照旧按位置对。插 / 删的落在一串一模一样的里面时哪一处都对，挑一处不挪 keep（正在编辑的那个）
 */
export function shiftedAt(before: string[], after: string[], keep: number | null): number | null {
  const delta = after.length - before.length;
  if (Math.abs(delta) !== 1) return null;
  const [short, long] = delta > 0 ? [before, after] : [after, before];
  // 前面相同的有几个、后面相同的有几个（各算各的，可以重叠：重叠的那一段就是「哪一处都行」）
  let start = 0;
  while (start < short.length && short[start] === long[start]) start += 1;
  let end = 0;
  while (end < short.length && short[short.length - 1 - end] === long[long.length - 1 - end])
    end += 1;
  if (start + end < short.length) return null;
  // 插 / 删的那一个在 [low, start] 里哪一处都行
  const low = short.length - end;
  if (keep === null || keep < low || keep > start) return start;
  if (delta > 0) return keep < start ? keep + 1 : start;
  return keep < start ? start : start > low ? start - 1 : start;
}

/** 按 widget 的内容建出 / 更新表格的每一格。正在编辑的格子只在内容是别处改的（撤销）时才动 */
function fill(block: HTMLElement, widget: TableWidget) {
  const state = states.get(block)!;
  const table = block.querySelector("table")!;
  const numeric = numericColumns(widget.table);
  // 用 children 而不是 rows / cells：测试用的 happy-dom 没有那几个表格集合
  const body = table.querySelector("tbody")!;
  const rows = [table.querySelector("thead")!.firstElementChild as HTMLTableRowElement];
  while (body.children.length > widget.table.rows.length) body.lastElementChild!.remove();
  for (let index = 0; index < widget.table.rows.length; index += 1) {
    let tr = body.children[index] as HTMLTableRowElement | undefined;
    if (!tr) {
      tr = document.createElement("tr");
      body.append(tr);
    }
    rows.push(tr);
  }
  rows.forEach((tr, row) => {
    while (tr.children.length > widget.columnCount) tr.lastElementChild!.remove();
    for (let col = 0; col < widget.columnCount; col += 1) {
      let cell = tr.children[col] as HTMLTableCellElement | undefined;
      if (!cell) {
        cell = document.createElement(row === 0 ? "th" : "td");
        if (row === 0) cell.scope = "col";
        tr.append(cell);
      }
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      cell.classList.toggle("is-num", numeric[col]!);
      cell.style.textAlign = widget.table.alignments[col] ?? (numeric[col] ? "right" : "left");
      if (cell === state.editing) {
        // 源码被别处改了（撤销、协同时别人改了这张表）：格子跟着换，光标按改动挪，不丢焦点。
        // 别处的格子变了、这一格的源码没变：一个字都不动（正在组字的话更不能动）
        const source = widget.sourceAt(row, col);
        if (writingFrom !== cell && composingIn !== cell && cell.textContent !== source) {
          const before = cell.textContent ?? "";
          const offset = caretOffset(cell);
          cell.textContent = source;
          placeCaret(cell, offset === null ? source.length : mapThrough(before, source, offset));
        }
        continue;
      }
      const value = widget.valueAt(row, col);
      if (renderedValues.get(cell) === value) continue;
      cell.replaceChildren(...renderInline(value));
      renderedValues.set(cell, value);
    }
  });
  // 编辑中的格子被删掉了（撤销了一次插入行）
  if (state.editing && !state.editing.isConnected) {
    state.editing = null;
    block.classList.remove("is-editing");
  }
}

/* ---------------- 工具栏 ---------------- */

const SVG_NS = "http://www.w3.org/2000/svg";
/** 行 / 列是一个圆角框，旁边 + 是插入、− 是删除；对齐是三条长短不一的线 */
const ROW_BOX = "M4 4h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z";
const COL_BOX_LEFT = "M5 3h5a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z";
const COL_BOX_RIGHT = "M14 3h5a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z";
const TOOL_ICONS = {
  "row-insert": [ROW_BOX, "M12 15v6", "M9 18h6"],
  "row-delete": [ROW_BOX, "M9 18h6"],
  "col-left": [COL_BOX_RIGHT, "M6 9v6", "M3 12h6"],
  "col-right": [COL_BOX_LEFT, "M18 9v6", "M15 12h6"],
  "col-delete": [COL_BOX_LEFT, "M15 12h6"],
  "align-left": ["M21 6H3", "M15 12H3", "M17 18H3"],
  "align-center": ["M21 6H3", "M17 12H7", "M19 18H5"],
  "align-right": ["M21 6H3", "M21 12H9", "M21 18H7"],
  source: ["m16 18 6-6-6-6", "m8 6-6 6 6 6"],
} as const;
type ToolAction = keyof typeof TOOL_ICONS;

function toolIcon(action: ToolAction): SVGSVGElement {
  const node = document.createElementNS(SVG_NS, "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "1.8");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  for (const d of TOOL_ICONS[action]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    node.append(path);
  }
  return node;
}

/**
 * 编辑时浮在表格右上角的工具栏：行（下方插入、删除）｜列（左插、右插、删除）｜
 * 对齐（左、中、右，再点一次恢复默认；CSV 没有对齐语法，不显示）｜源码。
 */
function toolbar(view: EditorView, block: HTMLElement, format: TableFormat): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "cm-odea-table-tools";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "表格");
  // 点工具栏（包括按钮之间的空隙）不抢格子的焦点
  bar.addEventListener("mousedown", (event) => event.preventDefault());
  const current = () => {
    const cell = states.get(block)?.editing;
    return cell ? cellIndex(cell) : null;
  };
  const tool = (
    action: ToolAction,
    title: string,
    run: (at: { row: number; col: number }) => void,
  ) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = action;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.append(toolIcon(action));
    button.addEventListener("click", () => {
      const at = current();
      if (at && !button.disabled) run(at);
    });
    return button;
  };
  const group = (...buttons: HTMLElement[]) => {
    const node = document.createElement("div");
    node.className = "cm-odea-table-tools-group";
    node.append(...buttons);
    return node;
  };
  const align = (action: ToolAction, alignment: TableAlignment, label: string) =>
    tool(action, label, ({ row, col }) => setAlignment(view, block, row, col, alignment));

  bar.append(
    group(
      tool("row-insert", `在下方插入一行（${MOD_KEY}+Enter）`, ({ row, col }) =>
        insertRow(view, block, row, col),
      ),
      tool("row-delete", "删除这一行", ({ row, col }) => deleteRow(view, block, row, col)),
    ),
    group(
      tool("col-left", "在左侧插入一列", ({ row, col }) => insertColumn(view, block, col, row)),
      tool("col-right", "在右侧插入一列", ({ row, col }) =>
        insertColumn(view, block, col + 1, row),
      ),
      tool("col-delete", "删除这一列", ({ row, col }) => deleteColumn(view, block, row, col)),
    ),
  );
  if (format === "markdown") {
    bar.append(
      group(
        align("align-left", "left", "这一列左对齐"),
        align("align-center", "center", "这一列居中"),
        align("align-right", "right", "这一列右对齐"),
      ),
    );
  }
  bar.append(group(tool("source", "编辑这张表的源码", () => showSource(view, block))));
  return bar;
}

/** 按正在编辑的格子刷新工具栏：表头行不能删、只剩一列不能删列、当前列的对齐亮起来 */
function syncToolbar(block: HTMLElement) {
  const state = states.get(block);
  const cell = state?.editing;
  const bar = block.querySelector(".cm-odea-table-tools");
  if (!state || !cell || !bar) return;
  const { row, col } = cellIndex(cell);
  const button = (action: ToolAction) =>
    bar.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
  const rowDelete = button("row-delete");
  if (rowDelete) rowDelete.disabled = row === 0;
  const colDelete = button("col-delete");
  if (colDelete) colDelete.disabled = state.widget.columnCount <= 1;
  const alignment = state.widget.table.alignments[col] ?? null;
  for (const value of ["left", "center", "right"] as const) {
    const node = button(`align-${value}`);
    node?.classList.toggle("is-on", alignment === value);
    node?.setAttribute("aria-pressed", String(alignment === value));
  }
}

/* ---------------- 进出编辑 ---------------- */

const cellIndex = (cell: HTMLTableCellElement) => ({
  row: Number(cell.dataset.row),
  col: Number(cell.dataset.col),
});

function cellAt(block: HTMLElement, row: number, col: number): HTMLTableCellElement | null {
  const table = block.querySelector("table");
  const tr =
    row === 0
      ? table?.querySelector("thead")?.firstElementChild
      : table?.querySelector("tbody")?.children[row - 1];
  return (tr?.children[col] as HTMLTableCellElement | undefined) ?? null;
}

function makeEditable(cell: HTMLElement) {
  // plaintext-only：粘贴、拖进来的都是纯文本，不会混进别处的样式标签
  try {
    cell.contentEditable = "plaintext-only";
  } catch {
    /* 不认 plaintext-only 的引擎 */
  }
  if (cell.contentEditable !== "plaintext-only") cell.contentEditable = "true";
}

type Caret = "start" | "end" | { rendered: number };

/**
 * 把正文的光标停到表格紧下面一行（表格是最后一块就停在紧上面一行）。
 *
 * 格子里的编辑记在正文的历史里。撤销时 CodeMirror 会把光标恢复到改动前的位置并滚过去 ——
 * 正文光标要是还停在老远的地方（比如一打开就在的文档开头），一撤销整页就滚走了，
 * 表格滚出视口被回收，正在编辑的格子跟着丢了焦点。停在表格边上，撤销时就不会滚远。
 */
function parkSelection(view: EditorView, block: HTMLElement) {
  const info = view.lineBlockAt(positionOf(view, block));
  const { doc, selection } = view.state;
  const target = info.to < doc.length ? info.to + 1 : info.from > 0 ? info.from - 1 : null;
  if (target === null) return;
  const { main } = selection;
  if (selection.ranges.length === 1 && main.empty && main.head === target) return;
  view.dispatch({ selection: { anchor: target } });
}

function beginEdit(block: HTMLElement, cell: HTMLTableCellElement, caret: Caret) {
  const state = states.get(block);
  if (!state) return;
  // 格子换格子：表格一直处在编辑中，工具栏不收起来再弹出来（以前每点一格它闪一次）
  if (state.editing && state.editing !== cell) endEdit(block, state.editing, true);
  parkSelection(state.view, block);
  const { row, col } = cellIndex(cell);
  const source = state.widget.sourceAt(row, col);
  const offset =
    caret === "start"
      ? 0
      : caret === "end"
        ? source.length
        : mapOffset(cell.textContent ?? "", source, caret.rendered);
  state.editing = cell;
  renderedValues.delete(cell);
  cell.textContent = source;
  makeEditable(cell);
  cell.classList.add("is-editing");
  block.classList.add("is-editing");
  syncToolbar(block);
  cell.focus({ preventScroll: true });
  placeCaret(cell, offset);
  cell.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

/** 退出这一格的编辑。switching：马上要编辑同一张表的另一格（或刚改完结构要重新聚焦），表格保持编辑态 */
function endEdit(block: HTMLElement, cell: HTMLTableCellElement, switching = false) {
  const state = states.get(block);
  if (!state || state.editing !== cell) return;
  state.editing = null;
  cell.removeAttribute("contenteditable");
  cell.classList.remove("is-editing");
  if (!switching) block.classList.remove("is-editing");
  const { row, col } = cellIndex(cell);
  const value = state.widget.valueAt(row, col);
  cell.replaceChildren(...renderInline(value));
  renderedValues.set(cell, value);
}

/** 换到另一格（不存在就返回 false） */
function focusCell(block: HTMLElement, row: number, col: number, caret: Caret): boolean {
  const cell = cellAt(block, row, col);
  if (!cell) return false;
  beginEdit(block, cell, caret);
  return true;
}

/** 整张表退回源码（工具栏、CSV 标签栏的「源码」） */
function showSource(view: EditorView, block: HTMLElement) {
  const state = states.get(block);
  if (state?.editing) endEdit(block, state.editing);
  jumpToSource(view, positionOf(view, block));
}

/**
 * 离开表格回到正文：after 放到表格下一行开头，before 放到上一行末尾。
 * 表格是文档的最后（最前）一块时先补一个空行，不然光标只能落在表格里 ——
 * 那样整张表会退回源码。
 */
function leave(view: EditorView, block: HTMLElement, side: "before" | "after") {
  const state = states.get(block);
  if (state?.editing) endEdit(block, state.editing);
  const info = view.lineBlockAt(positionOf(view, block));
  const { doc } = view.state;
  if (side === "after") {
    if (info.to < doc.length) view.dispatch({ selection: { anchor: info.to + 1 } });
    else
      view.dispatch({
        changes: { from: doc.length, insert: "\n" },
        selection: { anchor: doc.length + 1 },
      });
  } else if (info.from > 0) {
    view.dispatch({ selection: { anchor: info.from - 1 } });
  } else {
    view.dispatch({ changes: { from: 0, insert: "\n" }, selection: { anchor: 0 } });
  }
  view.focus();
}

/* ---------------- 写回源码 ---------------- */

/** 表格源码在文档里的起点 */
const sourceStart = (view: EditorView, block: HTMLElement, widget: TableWidget) =>
  positionOf(view, block) + widget.offset;

function cellChange(
  view: EditorView,
  block: HTMLElement,
  widget: TableWidget,
  row: number,
  col: number,
  insert: string,
): ChangeSpec | null {
  const layout = widget.table.layout;
  if (!layout) return null;
  const base = sourceStart(view, block, widget);
  const range = layout.cells[row]?.[col];
  if (range) {
    const from = base + range[0];
    const current = view.state.sliceDoc(from, base + range[1]);
    return current === insert ? null : minimalChange(from, current, insert);
  }
  // 短行里缺的格子：在行尾把中间空着的格子也补上
  const line = layout.lines[row];
  if (!line || !insert) return null;
  const missing = col - (layout.cells[row]?.length ?? 0);
  if (widget.format !== "markdown") {
    return {
      from: base + line[1],
      insert: delimiterOf(widget.format).repeat(missing + 1) + insert,
    };
  }
  const text = view.state.sliceDoc(base + line[0], base + line[1]).trimEnd();
  const at = base + line[0] + text.length;
  return text.endsWith("|") && !text.endsWith("\\|")
    ? { from: at, insert: `${"   |".repeat(missing)} ${insert} |` }
    : { from: at, insert: `${" |".repeat(missing)} | ${insert}` };
}

/**
 * 只换掉真正变了的那一段（掐掉两头相同的部分）。整格替换在协同时等于「删光再插一遍」：
 * 别人同时在这一格里打的字会落到莫名其妙的地方、光标也塌到一处（docs/协同编辑.md §4.3）
 */
function minimalChange(from: number, before: string, after: string): ChangeSpec {
  const [head, tail] = commonEnds(before, after);
  return {
    from: from + head,
    to: from + before.length - tail,
    insert: after.slice(head, after.length - tail),
  };
}

/** 格子里的文字从 before 换成 after，原来在 offset 的光标该到哪：改动前面的不动，后面的跟着挪 */
export function mapThrough(before: string, after: string, offset: number): number {
  const [head, tail] = commonEnds(before, after);
  if (offset <= head) return offset;
  if (offset >= before.length - tail) return offset + after.length - before.length;
  return after.length - tail;
}

/** 把正在编辑的格子里的文字写回源码 */
function commit(view: EditorView, block: HTMLElement, cell: HTMLTableCellElement) {
  const state = states.get(block);
  if (!state || state.editing !== cell) return;
  const { widget } = state;
  const { row, col } = cellIndex(cell);
  const text = cell.textContent ?? "";
  const insert =
    widget.format === "markdown"
      ? gfmCellSource(text)
      : csvCellSource(text.trim(), delimiterOf(widget.format));
  const changes = cellChange(view, block, widget, row, col, insert);
  if (!changes) return;
  writingFrom = cell;
  try {
    view.dispatch({ changes, userEvent: "input.type" });
  } finally {
    writingFrom = null;
  }
}

/**
 * 改表格的结构（行、列）：先退出当前格子的编辑（表格保持编辑态，工具栏不闪），写回源码，
 * 再把光标放进 focus 算出来的那一格。
 */
function restructure(
  view: EditorView,
  block: HTMLElement,
  changes: ChangeSpec,
  userEvent: string,
  focus: (widget: TableWidget) => { row: number; col: number; caret: Caret },
) {
  const state = states.get(block);
  if (!state) return;
  if (state.editing) endEdit(block, state.editing, true);
  const start = positionOf(view, block);
  view.dispatch({ changes, userEvent });
  const target = liveBlock(view, block, start);
  const widget = target && states.get(target)?.widget;
  if (target && widget) {
    const { row, col, caret } = focus(widget);
    const clampedRow = Math.max(0, Math.min(row, widget.rowCount - 1));
    const clampedCol = Math.max(0, Math.min(col, widget.columnCount - 1));
    if (focusCell(target, clampedRow, clampedCol, caret)) return;
  }
  block.classList.remove("is-editing");
}

/** 在第 after 行下面插一行空格子，光标放进新行的第 col 列 */
function insertRow(view: EditorView, block: HTMLElement, after: number, col: number) {
  const widget = states.get(block)?.widget;
  const layout = widget?.table.layout;
  if (!widget || !layout) return;
  // 表头下面是分隔行，新行要插在分隔行后面
  const line = after === 0 && layout.delimiter ? layout.delimiter : layout.lines[after];
  if (!line) return;
  const from = positionOf(view, block) + widget.offset + line[1];
  const insert = `
${emptyRowSource(widget.columnCount, widget.format)}`;
  restructure(view, block, { from, insert }, "input", () => ({
    row: after + 1,
    col,
    caret: "start",
  }));
}

function deleteRow(view: EditorView, block: HTMLElement, row: number, col: number) {
  const widget = states.get(block)?.widget;
  const layout = widget?.table.layout;
  if (!widget || !layout || row < 1) return;
  const line = layout.lines[row];
  const previous = row === 1 && layout.delimiter ? layout.delimiter : layout.lines[row - 1];
  if (!line || !previous) return;
  const base = positionOf(view, block) + widget.offset;
  // 连同前面那个换行一起删，最后一行也适用
  restructure(view, block, { from: base + previous[1], to: base + line[1] }, "delete", () => ({
    row,
    col,
    caret: "end",
  }));
}

/** 每一行每一格的源码原文（短行缺的格子是空串）；[0] 是表头 */
function rawCells(widget: TableWidget): string[][] {
  const layout = widget.table.layout!;
  return Array.from({ length: widget.rowCount }, (_, row) =>
    Array.from({ length: widget.columnCount }, (_, col) => {
      const range = layout.cells[row]?.[col];
      return range ? widget.source.slice(range[0], range[1]) : "";
    }),
  );
}

/**
 * 按列改表（插列、删列）之后的源码改动。
 * GFM：整张表按列宽重新排版（续行前面的缩进 / 引用符号照抄第一行的）；
 * CSV：逐行换掉，别的（空行、引号写法）不动。
 */
function columnChanges(
  view: EditorView,
  block: HTMLElement,
  widget: TableWidget,
  edit: (cells: string[], alignments: TableAlignment[] | null) => void,
): ChangeSpec {
  const layout = widget.table.layout!;
  const start = positionOf(view, block);
  const base = start + widget.offset;
  const cells = rawCells(widget);
  if (widget.format === "markdown") {
    const alignments = [...widget.table.alignments];
    cells.forEach((row, index) => edit(row, index === 0 ? alignments : null));
    const [header, ...rows] = cells;
    const indent = view.state.sliceDoc(start, base);
    const insert = formatGfmTable(header!, alignments, rows).join(`
${indent}`);
    return { from: base, to: base + widget.source.length, insert };
  }
  const delimiter = delimiterOf(widget.format);
  return layout.lines.map((line, row) => {
    const fields = cells[row]!;
    edit(fields, null);
    // 只剩一格又是空的：写成 ""，不然这一行成了空行会被当成不存在
    const insert = fields.length === 1 && !fields[0] ? '""' : fields.join(delimiter);
    return { from: base + line[0], to: base + line[1], insert };
  });
}

/** 在第 at 列前面插一列空格子（at 等于列数就是加在最右边），光标放进新列 */
function insertColumn(view: EditorView, block: HTMLElement, at: number, row: number) {
  const widget = states.get(block)?.widget;
  if (!widget?.table.layout) return;
  const changes = columnChanges(view, block, widget, (cells, alignments) => {
    cells.splice(at, 0, "");
    alignments?.splice(at, 0, null);
  });
  restructure(view, block, changes, "input", () => ({ row, col: at, caret: "end" }));
}

function deleteColumn(view: EditorView, block: HTMLElement, row: number, col: number) {
  const widget = states.get(block)?.widget;
  if (!widget?.table.layout || widget.columnCount <= 1) return;
  const changes = columnChanges(view, block, widget, (cells, alignments) => {
    cells.splice(col, 1);
    alignments?.splice(col, 1);
  });
  restructure(view, block, changes, "delete", () => ({ row, col, caret: "end" }));
}

/**
 * 改一列的对齐（只有 GFM 有）：只换分隔行里这一格（`:--` / `:-:` / `--:`），宽度不变，
 * 别处的排版不动。点已经亮着的那个再点一次，恢复成不写对齐（默认）。
 * 正在编辑的格子接着编辑，光标不动。
 */
function setAlignment(
  view: EditorView,
  block: HTMLElement,
  row: number,
  col: number,
  alignment: TableAlignment,
) {
  const state = states.get(block);
  const widget = state?.widget;
  const range = widget?.table.layout?.delimiterCells[col];
  if (!state || !widget || !range) return;
  const next = widget.table.alignments[col] === alignment ? null : alignment;
  const current = widget.source.slice(range[0], range[1]);
  const marker = alignmentMarker(current.length, next);
  if (marker === current) return;
  const base = positionOf(view, block) + widget.offset;
  writingFrom = state.editing;
  try {
    view.dispatch({
      changes: { from: base + range[0], to: base + range[1], insert: marker },
      userEvent: "input",
    });
  } finally {
    writingFrom = null;
  }
  syncToolbar(block);
  if (!state.editing) focusCell(block, row, col, "end");
}

/**
 * 改完结构之后表格的 DOM：通常 updateDOM 就地更新，还是原来那个；万一被整个重建了
 * （比如同时还有别的改动），按位置找新的那一个。
 */
function liveBlock(view: EditorView, block: HTMLElement, start: number): HTMLElement | null {
  if (block.isConnected) return block;
  for (const candidate of view.contentDOM.querySelectorAll<HTMLElement>(".cm-odea-table-block")) {
    if (states.has(candidate) && positionOf(view, candidate) === start) return candidate;
  }
  return null;
}

/* ---------------- 事件 ---------------- */

function listen(view: EditorView, block: HTMLElement, frame: HTMLElement, table: HTMLElement) {
  const editingCell = (target: EventTarget | null) => {
    const cell = (target as HTMLElement | null)?.closest?.<HTMLTableCellElement>("td, th");
    return cell && states.get(block)?.editing === cell ? cell : null;
  };

  frame.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button")) return;
    const cell = target.closest<HTMLTableCellElement>("td, th");
    const state = states.get(block);
    if (!cell || !state) {
      // 边框、标签栏：整张表回到源码
      event.preventDefault();
      showSource(view, block);
      return;
    }
    if (state.editing === cell) return; // 已经在编辑：交给浏览器放光标、拖选
    const link = target.closest<HTMLElement>("[data-href]");
    if ((event.ctrlKey || event.metaKey) && link?.dataset.href) {
      event.preventDefault();
      void openExternal(link.dataset.href);
      return;
    }
    if (!state.widget.table.layout) {
      // 位置对不上原文的表（CSV 里有 \r）：只能回源码改
      event.preventDefault();
      showSource(view, block);
      return;
    }
    event.preventDefault();
    const rendered = renderedOffsetAt(cell, event.clientX, event.clientY);
    beginEdit(block, cell, rendered === null ? "end" : { rendered });
  });

  table.addEventListener("input", (event) => {
    const cell = editingCell(event.target);
    if (cell && !(event as InputEvent).isComposing) commit(view, block, cell);
  });
  table.addEventListener("compositionstart", (event) => {
    composingIn = editingCell(event.target);
  });
  table.addEventListener("compositionend", (event) => {
    composingIn = null;
    const cell = editingCell(event.target);
    if (cell) commit(view, block, cell);
  });

  table.addEventListener("focusout", (event) => {
    const cell = editingCell(event.target);
    if (!cell) return;
    // 切到别的窗口：回来时接着编辑
    if (!cell.ownerDocument.hasFocus()) return;
    const next = (event as FocusEvent).relatedTarget as Node | null;
    if (next && cell.contains(next)) return;
    endEdit(block, cell);
  });

  table.addEventListener("paste", (event) => {
    const cell = editingCell(event.target);
    if (!cell) return;
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    const markdown = states.get(block)?.widget.format === "markdown";
    insertText(cell, markdown ? text.replace(/\r?\n/g, "<br>") : text);
    commit(view, block, cell);
  });

  table.addEventListener("keydown", (event) => {
    const cell = editingCell(event.target);
    const state = states.get(block);
    if (!cell || !state || event.isComposing || event.keyCode === 229) return;
    if (handleKey(view, block, state.widget, cell, event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
}

function handleKey(
  view: EditorView,
  block: HTMLElement,
  widget: TableWidget,
  cell: HTMLTableCellElement,
  event: KeyboardEvent,
): boolean {
  const { row, col } = cellIndex(cell);
  const cols = widget.columnCount;
  const mod = event.ctrlKey || event.metaKey;
  const plain = !mod && !event.altKey && !event.shiftKey;
  // Tab 过去光标落在末尾（接着打是补在后面）；→ 跨过去落在开头，← 跨过去落在末尾
  const next = (caret: Caret = "end") =>
    col < cols - 1 ? focusCell(block, row, col + 1, caret) : focusCell(block, row + 1, 0, caret);
  const previous = () =>
    col > 0 ? focusCell(block, row, col - 1, "end") : focusCell(block, row - 1, cols - 1, "end");

  switch (event.key) {
    case "Escape":
      leave(view, block, "after");
      return true;
    case "Tab":
      if (mod || event.altKey) return false;
      if (event.shiftKey) previous();
      else if (!next()) insertRow(view, block, row, 0);
      return true;
    case "Enter":
      if (event.altKey) return false;
      if (event.shiftKey) {
        insertText(cell, widget.format === "markdown" ? "<br>" : "\n");
        commit(view, block, cell);
      } else if (mod) insertRow(view, block, row, col);
      else if (!focusCell(block, row + 1, col, "end")) leave(view, block, "after");
      return true;
    case "ArrowUp":
      if (!plain) return false;
      if (!focusCell(block, row - 1, col, "end")) leave(view, block, "before");
      return true;
    case "ArrowDown":
      if (!plain) return false;
      if (!focusCell(block, row + 1, col, "end")) leave(view, block, "after");
      return true;
    case "ArrowLeft":
      if (!plain || !caretAtEdge(cell, "start")) return false;
      if (!previous()) leave(view, block, "before");
      return true;
    case "ArrowRight":
      if (!plain || !caretAtEdge(cell, "end")) return false;
      if (!next("start")) leave(view, block, "after");
      return true;
  }
  if (mod && !event.altKey) {
    const key = event.key.toLowerCase();
    // 格子里按 Mod+S：立刻存（别弹浏览器的「另存网页」）
    if (key === "s") {
      void flushAllEditors();
      return true;
    }
    // 撤销 / 重做走正文的历史：格子里打的字本来就记在那里
    if (key === "z") {
      (event.shiftKey ? redo : undo)(view);
      return true;
    }
    if (key === "y" && !event.shiftKey) {
      redo(view);
      return true;
    }
  }
  return false;
}

/* ---------------- 光标 ---------------- */

function placeCaret(cell: HTMLElement, offset: number) {
  const selection = cell.ownerDocument.getSelection();
  if (!selection) return;
  const range = cell.ownerDocument.createRange();
  const text = cell.firstChild;
  if (text && text.nodeType === Node.TEXT_NODE) {
    range.setStart(text, Math.min(offset, text.textContent?.length ?? 0));
    range.collapse(true);
  } else {
    // 空格子（或者里面不是单独一段文字）：放在开头 / 结尾
    range.selectNodeContents(cell);
    range.collapse(offset <= 0);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

/** 光标在格子文字里的偏移（没有选区在这格里时返回 null） */
function caretOffset(cell: HTMLElement): number | null {
  const selection = cell.ownerDocument.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!cell.contains(range.startContainer)) return null;
  const before = cell.ownerDocument.createRange();
  before.selectNodeContents(cell);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

function caretAtEdge(cell: HTMLElement, edge: "start" | "end"): boolean {
  const selection = cell.ownerDocument.getSelection();
  if (!selection?.isCollapsed) return false;
  const offset = caretOffset(cell);
  if (offset === null) return false;
  return edge === "start" ? offset === 0 : offset >= (cell.textContent?.length ?? 0);
}

/** 在光标处插入纯文本（替换选中的部分），光标落在插入的文字后面 */
function insertText(cell: HTMLElement, text: string) {
  const selection = cell.ownerDocument.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!selection || !range || !cell.contains(range.startContainer)) {
    cell.append(text);
    placeCaret(cell, cell.textContent?.length ?? 0);
    return;
  }
  range.deleteContents();
  range.insertNode(cell.ownerDocument.createTextNode(text));
  const end = (caretOffset(cell) ?? 0) + text.length;
  cell.normalize();
  placeCaret(cell, end);
}

/** 鼠标点在渲染后的格子里第几个字上（量不出来返回 null） */
function renderedOffsetAt(cell: HTMLElement, x: number, y: number): number | null {
  const doc = cell.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) {
    node = position.offsetNode;
    offset = position.offset;
  } else {
    const range = doc.caretRangeFromPoint?.(x, y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (!node || !cell.contains(node)) return null;
  const before = doc.createRange();
  before.selectNodeContents(cell);
  before.setEnd(node, offset);
  return before.toString().length;
}

/**
 * 渲染后的第 offset 个字，对应源码里的第几个字：两边逐字往前对，源码里多出来的
 * 标记（`**`、反引号、链接地址）跳过去。对不上（短码换成了 Emoji 之类）就放到最后。
 */
export function mapOffset(rendered: string, source: string, offset: number): number {
  let at = 0;
  for (let index = 0; index < Math.min(offset, rendered.length); index += 1) {
    const found = source.indexOf(rendered[index]!, at);
    if (found < 0) return source.length;
    at = found + 1;
  }
  return at;
}
