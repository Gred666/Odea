import { snapToDevicePixels } from "@/lib/devicePixels";
import { docOf, winOf } from "@/lib/paneWindow";
import { MOD_KEY } from "@/lib/platform";
import { redo, undo } from "@codemirror/commands";
import type { EditorView, KeyBinding, WidgetType } from "@codemirror/view";
import { CellEditor, cellFromEditor, cellToEditor } from "./cellEditor";
import { sanitizeHtml } from "./html";
import { htmlCellAt, htmlCellSource } from "./htmlTable";
import { renderInline } from "./inlineDom";
import { openExternal } from "./links";
import {
  type MarkdownTableModel,
  type TableAlignment,
  type TableFormat,
  gfmCellSource,
  numericColumns,
} from "./markdownTable";
import { flushAllEditors } from "./saveBus";
import {
  cellPlainText,
  clipboardCells,
  gfmTableSource,
  htmlCellMarkdown,
  insertTableBlock,
  rectSources,
  writeCopy,
} from "./tableClipboard";
import {
  type CellPos,
  type CellRect,
  type GridCell,
  type TableData,
  type TableGrid,
  canMerge,
  canMoveColumns,
  canMoveRows,
  cellRect,
  clearCells,
  deleteColumns,
  deleteRows,
  hasMergeIn,
  insertColumns,
  insertRows,
  mergeCells,
  moveColumns,
  moveRows,
  pasteCells,
  rectOf,
  resolveGrid,
  sortRows,
  splitCells,
} from "./tableGrid";
import { type MenuEntry, closeTableMenu, showTableMenu, tableIcon } from "./tableMenu";
import { planEdits, tableData } from "./tableSource";
import { OtwWidget, copyButton, jumpToSource, positionOf } from "./widgets";

/* ============================================================
   表格替身：GFM 表格和 ```csv / ```tsv 围栏（docs/表格.md）。

   平时是一张渲染好的表，什么控件都不露。三种状态：

   - 改一格：单击格子，这一格换成一个子编辑器（cellEditor.ts），装着正文的行内装饰层：
     光标碰到的 `**` 才露出来（Typora 式，没有富文本互转），`<br>` 是真的换行。
     每敲一个字写回它在源码里的那一小段，撤销、自动保存和正文一样
   - 选一片格子：在格子里按下拖到别的格子、Shift+点、改一格时按 Esc、点行 / 列抓手。
     复制、剪切、粘贴、清空、合并都对着这一片；直接打字是清空这一格重写（Excel 的习惯）
   - 进了表格（上面两种）列宽就锁住，离开时滑到新的自动列宽：点格子、打字时整张表一像素不动

   鼠标到哪一行 / 哪一列，表格左边 / 上沿出一个抓手：点 = 选中整行 / 整列并弹菜单，拖 = 换位置。
   下边、右边悬停出「+」；抓手那一栏里靠近两行（列）的分界时出一个小「+」，点了在那里插。
   右键格子出菜单。合并单元格写成 `<`（并进左边）、`^`（并进上面），见 tableGrid.ts。

   CodeMirror 对替身里的事件、DOM 变动、选区一概不管（WidgetType.ignoreEvent 默认 true），
   格子里的子编辑器、选区用的隐藏输入框都是独立的可编辑区，和正文的编辑互不打架。写回源码之后
   装饰层换上一个新的 TableWidget，updateDOM 就地更新旧的 DOM —— 正在编辑的那个格子不动，
   光标、输入法都不受影响。

   正文只读（协作时只能看）：能选格子、复制，不能改、不出抓手和「+」。
   ============================================================ */

interface Selection {
  /** 起点（Shift+方向键时不动的那一头，也是「打字即改」改的那一格） */
  anchor: CellPos;
  head: CellPos;
}

interface TableState {
  view: EditorView;
  widget: TableWidget;
  /** 正在编辑（露出源码）的格子 */
  editing: HTMLTableCellElement | null;
  /** 正在编辑的格子里的子编辑器 */
  field: CellEditor | null;
  /** 选中的一片格子（和 editing 不同时有） */
  selection: Selection | null;
  /** 锁住的列宽（进了表格才有） */
  frozen: number[] | null;
  /** 正在播的列宽过渡 */
  animation: number | null;
  /** 看得见的格子：`行:列` → 格子 */
  cells: Map<string, HTMLTableCellElement>;
  /** 菜单开着（焦点在菜单上，不算离开表格） */
  menu: boolean;
  /** 按住鼠标拖着选格子 / 拖抓手 */
  pointer: "select" | "grip" | null;
  /** 结束按住拖选的跟踪（松手的事件没送到时，下一次按下先把上一次的收掉） */
  stopTracking: (() => void) | null;
  /**
   * 自己插删列时，锁住的列宽对到新的列上是什么样（插进来的列是 0 宽）：下一次 fill 从它滑到新的宽度。
   * 别人改的、撤销的没有这个，按 shiftDom 猜（只认插 / 删一列）
   */
  columnsFrom: number[] | null;
  /** 鼠标最后停在哪（在表格上时才有）：表格变了之后按它重摆抓手、「+」 */
  hoverAt: { x: number; y: number } | null;
  /** 这一帧已经排了一次重摆 */
  refreshQueued: boolean;
}

const states = new WeakMap<HTMLElement, TableState>();
/** 鼠标正停在上面的那张表（一次只有一张）：页面滚动时它底下换了一行，要跟着重摆 */
let hoveredBlock: HTMLElement | null = null;
/** 已经挂了滚动监听的文档（主窗口、弹出窗口各一份） */
const scrollWatched = new WeakSet<Document>();
/** 每个格子上次渲染的内容：updateDOM 时只重画变了的格子 */
const renderedValues = new WeakMap<HTMLTableCellElement, string>();

const key = (row: number, col: number) => `${row}:${col}`;
/** 能不能改（正文只读时只能选、复制） */
const editable = (state: TableState) => !state.view.state.readOnly;
/** 选区用的隐藏输入框里放一个零宽字符并全选：Ctrl+C 才会发 copy 事件，打的字会替换掉它 */
const SINK_TEXT = "​";

export class TableWidget extends OtwWidget {
  private readonly key: string;
  private cachedData: TableData | null = null;
  private cachedGrid: TableGrid | null = null;

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

  /** 上下留白 + 边框 + 表头约 63px，每行 19px 加每个文字行 22.4px；标签栏、HTML 表格的标题各一行 */
  protected override guessHeight() {
    let height = 63 + (this.format === "csv" || this.format === "tsv" ? 31 : 0);
    if (this.table.html?.caption) height += 30;
    for (const row of this.table.rows) {
      const breaks = Math.max(0, ...row.map((value) => value.match(/<br\s*\/?>/gi)?.length ?? 0));
      height += 19 + 22.4 * (1 + breaks);
    }
    return Math.round(height);
  }

  /** 每一格的内容（GFM 是源码原文）和对齐 */
  get data(): TableData {
    this.cachedData ??= tableData(this.table, this.source, this.format);
    return this.cachedData;
  }

  /** 合并单元格解出来的网格（CSV 不认合并） */
  get grid(): TableGrid {
    this.cachedGrid ??= resolveGrid(
      this.data.cells,
      this.format === "markdown" || this.format === "html",
    );
    return this.cachedGrid;
  }

  /** 第 row 行（0 是表头）第 col 列显示的内容 */
  valueAt(row: number, col: number): string {
    return (row === 0 ? this.table.header[col] : this.table.rows[row - 1]?.[col]) ?? "";
  }

  /** 编辑时格子里露出来的文字：GFM 是这一格的源码原文，CSV 是去掉引号的值 */
  sourceAt(row: number, col: number): string {
    return this.data.cells[row]?.[col] ?? "";
  }

  get rowCount() {
    return this.table.rows.length + 1;
  }

  get columnCount() {
    return this.table.header.length;
  }

  toDOM(view: EditorView) {
    const doc = docOf(view.dom);
    // 外层只负责留白（padding，见 widgets.ts 文件头）；抓手、「+」、胶囊绝对定位浮在它上面
    const block = doc.createElement("div");
    block.className = "cm-odea-table-block";
    const frame = doc.createElement("div");
    frame.className = `cm-odea-table-frame is-${this.format}`;
    if (this.format === "csv" || this.format === "tsv") frame.append(this.bar(view, doc));
    if (this.format === "html") frame.append(caption(doc));
    const scroller = doc.createElement("div");
    scroller.className = "cm-odea-table-scroll";
    const table = doc.createElement("table");
    table.className = "cm-odea-table-widget";
    const head = doc.createElement("thead");
    head.append(doc.createElement("tr"));
    table.append(doc.createElement("colgroup"), head, doc.createElement("tbody"));
    scroller.append(table);
    frame.append(scroller);
    block.append(frame);
    if (this.table.layout) block.append(...chrome(doc));

    states.set(block, {
      view,
      widget: this,
      editing: null,
      field: null,
      selection: null,
      frozen: null,
      animation: null,
      cells: new Map(),
      menu: false,
      pointer: null,
      stopTracking: null,
      columnsFrom: null,
      hoverAt: null,
      refreshQueued: false,
    });
    if (this.format === "html") paintCaption(block, this);
    fill(block, this, null);
    listen(view, block, frame, scroller, table);
    overflowObserver?.observe(scroller);
    return this.settle(block);
  }

  updateDOM(dom: HTMLElement, _view: EditorView, from?: WidgetType): boolean {
    const state = states.get(dom);
    // 只接同一张表（同一个替身换了内容）：别的表格碰巧落在这个位置，不能把编辑状态带过去
    if (!state || (from && from !== state.widget) || state.widget.format !== this.format) {
      return false;
    }
    if (!!state.widget.table.layout !== !!this.table.layout) return false;
    const previous = state.widget;
    state.widget = this;
    fill(dom, this, previous);
    const meta = dom.querySelector(".cm-odea-table-meta");
    if (meta) meta.textContent = metaText(this);
    if (this.format === "html") paintCaption(dom, this);
    this.trackHeight(dom);
    return true;
  }

  override destroy(dom: HTMLElement) {
    super.destroy(dom);
    const state = states.get(dom);
    if (state?.animation !== null && state?.animation !== undefined) {
      winOf(dom).cancelAnimationFrame(state.animation);
    }
    const scroller = dom.querySelector(".cm-odea-table-scroll");
    if (scroller) overflowObserver?.unobserve(scroller);
    // 先摘掉状态：这是在正文的 update 里，收子编辑器时不能再往正文写（commit 找不到状态就不写）
    states.delete(dom);
    // 表格整个换掉了（滚出视口、别的改动重建了它）：子编辑器跟着收掉
    state?.field?.destroy();
  }

  /** CSV / TSV 顶上的标签栏：格式名、行列数、复制原文 */
  private bar(view: EditorView, doc: Document): HTMLElement {
    const bar = doc.createElement("div");
    bar.className = "cm-odea-table-bar";
    const label = doc.createElement("span");
    label.className = "cm-odea-table-format";
    label.textContent = this.format.toUpperCase();
    const meta = doc.createElement("span");
    meta.className = "cm-odea-table-meta";
    meta.textContent = metaText(this);
    const spacer = doc.createElement("span");
    spacer.className = "cm-odea-table-spacer";
    bar.append(
      label,
      meta,
      spacer,
      copyButton(view, () => this.source, "复制原文"),
    );
    return bar;
  }
}

const metaText = (widget: TableWidget) =>
  `${widget.table.rows.length} 行 · ${widget.columnCount} 列`;

/** HTML 表格的 <caption>：画在表格上面（改它回源码），没有就不占地方 */
function caption(doc: Document): HTMLElement {
  const node = doc.createElement("div");
  node.className = "cm-odea-table-caption";
  return node;
}

function paintCaption(block: HTMLElement, widget: TableWidget) {
  const node = block.querySelector<HTMLElement>(".cm-odea-table-caption");
  const html = widget.table.html?.caption ?? "";
  if (!node || node.dataset.source === html) return;
  node.dataset.source = html;
  node.replaceChildren(sanitizeHtml(html));
  node.hidden = !html;
  node.closest(".cm-odea-table-frame")?.classList.toggle("has-caption", !!html);
}

/**
 * 表格的大小变了（加了行、格子里打字撑高了一行、格子里的图片载进来、正文栏变宽变窄）：
 * 第一列要不要钉住、右边缘要不要渐隐（docs/表格.md §10.4），抓手、「+」、胶囊跟着重摆。
 * 在布局之后、画出来之前调，这一帧就摆好
 */
const overflowObserver =
  typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver((entries) => {
        for (const entry of entries) {
          const block = (entry.target as HTMLElement).closest<HTMLElement>(".cm-odea-table-block");
          if (!block) continue;
          syncOverflow(block);
          refresh(block);
        }
      });

function syncOverflow(block: HTMLElement) {
  const frame = block.querySelector<HTMLElement>(".cm-odea-table-frame");
  const scroller = block.querySelector<HTMLElement>(".cm-odea-table-scroll");
  if (!frame || !scroller) return;
  const overflowing = scroller.scrollWidth > scroller.clientWidth + 1;
  frame.classList.toggle("is-overflowing", overflowing);
  frame.classList.toggle("is-scrolled", overflowing && scroller.scrollLeft > 0);
  frame.classList.toggle(
    "at-end",
    !overflowing || scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 1,
  );
}

/* ---------------- 浮在表格上的东西：抓手、「+」、合并胶囊、隐藏输入框 ---------------- */

function chrome(doc: Document): HTMLElement[] {
  const make = (className: string, label: string, icon: Parameters<typeof tableIcon>[1]) => {
    const node = doc.createElement("button");
    node.type = "button";
    node.className = className;
    node.title = label;
    node.setAttribute("aria-label", label);
    node.tabIndex = -1;
    node.append(tableIcon(doc, icon));
    return node;
  };
  const rowGrip = make("cm-odea-table-grip is-row", "点一下选中这一行，拖动换位置", "grip-row");
  const colGrip = make("cm-odea-table-grip is-col", "点一下选中这一列，拖动换位置", "grip-col");
  const addRow = make("cm-odea-table-add is-row", "在最后加一行", "plus");
  const addCol = make("cm-odea-table-add is-col", "在最后加一列", "plus");
  const insert = make("cm-odea-table-insert", "在这里插入", "plus");
  const line = doc.createElement("div");
  line.className = "cm-odea-table-line";
  const pill = doc.createElement("button");
  pill.type = "button";
  pill.className = "cm-odea-table-pill";
  pill.tabIndex = -1;
  const sink = doc.createElement("textarea");
  sink.className = "cm-odea-table-sink";
  sink.setAttribute("aria-label", "表格选区");
  sink.spellcheck = false;
  sink.autocapitalize = "off";
  sink.rows = 1;
  return [rowGrip, colGrip, addRow, addCol, insert, line, pill, sink];
}

const part = <T extends HTMLElement = HTMLElement>(block: HTMLElement, selector: string) =>
  block.querySelector<T>(selector);

/**
 * 淡入淡出的小控件：动之前对齐到整物理像素（docs/PITFALLS/动效.md「先对齐再动」）。
 * 已经显示着、只是挪了位置（换了一行、表格长高了）也重新对齐：零头跟着新位置变
 */
function reveal(node: HTMLElement | null, shown: boolean) {
  if (!node) return;
  const showing = node.classList.contains("is-shown");
  if (showing === shown) {
    if (shown) snapToDevicePixels(node);
    return;
  }
  snapToDevicePixels(node);
  node.classList.toggle("is-shown", shown);
}

/**
 * 表格变了以后重摆浮在上面的东西：抓手、「+」按鼠标最后停的位置重新算（鼠标不动，底下可能已经
 * 换了一行、表格的底边挪了），合并胶囊、隐藏输入框跟着选区。
 * 以前只在鼠标移动时摆：加了一行，下边的「+」压在新的一行上，抓手还记着旧的行号
 */
function refresh(block: HTMLElement) {
  const state = states.get(block);
  if (!state || !block.isConnected) return;
  if (state.hoverAt) hover(block, state.hoverAt.x, state.hoverAt.y);
  placePill(block, state, selectionRect(state));
  placeSink(block, state);
}

/** 下一帧画之前重摆（同一帧里变了好几次只摆一次） */
function refreshSoon(block: HTMLElement) {
  const state = states.get(block);
  if (!state || state.refreshQueued) return;
  state.refreshQueued = true;
  winOf(block).requestAnimationFrame(() => {
    state.refreshQueued = false;
    refresh(block);
  });
}

/** 页面滚动时鼠标停着不动，底下换了一行：鼠标停着的那张表重摆。每个文档挂一次 */
function watchScroll(doc: Document) {
  if (scrollWatched.has(doc)) return;
  scrollWatched.add(doc);
  doc.addEventListener(
    "scroll",
    () => {
      if (hoveredBlock?.isConnected) refreshSoon(hoveredBlock);
    },
    { capture: true, passive: true },
  );
}

/* ---------------- DOM：建 / 同步格子 ---------------- */

/**
 * 按 widget 的内容建出 / 更新表格的每一格。合并块只画左上角那一格（带 rowSpan / colSpan）。
 *
 * 别处插了 / 删了一行或一列（协同时别人改的、撤销）：先在 DOM 里同一个位置插 / 删，后面的跟着挪，
 * 再按「行 + 列」认格子 —— 不然正在编辑的那一格会变成别的行、别的列的内容（docs/协同编辑.md §15.1）。
 * 正在编辑的格子只在内容是别处改的（撤销、别人改了）时才动
 */
function fill(block: HTMLElement, widget: TableWidget, previous: TableWidget | null) {
  const state = states.get(block)!;
  const doc = docOf(block);
  const table = block.querySelector("table")!;
  const grid = widget.grid;
  const body = table.querySelector("tbody")!;
  const headRow = table.querySelector("thead")!.firstElementChild as HTMLTableRowElement;
  const columnShift = previous ? shiftDom(block, previous, widget) : null;

  // 行：表身的 tr 和表身的行一一对应（被合并块整行盖住的行也有一个空的 tr）
  // 用 children 而不是 rows / cells：测试用的 happy-dom 没有那几个表格集合
  while (body.children.length > grid.rows - 1) body.lastElementChild!.remove();
  while (body.children.length < grid.rows - 1) body.append(doc.createElement("tr"));
  const rows = [headRow, ...(body.children as unknown as HTMLTableRowElement[])];

  const colgroup = table.querySelector("colgroup")!;
  while (colgroup.children.length > grid.cols) colgroup.lastElementChild!.remove();
  while (colgroup.children.length < grid.cols) colgroup.append(doc.createElement("col"));

  const numeric = numericColumns(widget.table);
  state.cells = new Map();
  rows.forEach((tr, row) => {
    const tag = row === 0 ? "TH" : "TD";
    const wanted = grid.cellsInRow(row);
    const existing = new Map<number, HTMLTableCellElement>();
    for (const node of [...tr.children] as HTMLTableCellElement[]) {
      const col = Number(node.dataset.col);
      if (node.tagName !== tag || Number.isNaN(col) || existing.has(col)) node.remove();
      else existing.set(col, node);
    }
    const keep = new Set(wanted.map((cell) => cell.col));
    for (const [col, node] of existing) {
      if (!keep.has(col)) {
        node.remove();
        existing.delete(col);
      }
    }
    let ref = tr.firstElementChild;
    for (const cell of wanted) {
      let node = existing.get(cell.col);
      if (!node) {
        node = doc.createElement(row === 0 ? "th" : "td");
        if (row === 0) node.scope = "col";
      }
      if (node === ref) ref = ref.nextElementSibling;
      else tr.insertBefore(node, ref);
      paintCell(state, widget, grid, node, cell, numeric);
    }
  });
  // 编辑中的格子被删掉了（撤销了一次插入行，别人删了这一列）
  if (state.editing && !state.editing.isConnected) {
    const field = state.field;
    state.editing = null;
    state.field = null;
    field?.destroy();
    if (!state.selection) deactivate(block, false);
  }
  if (state.selection) clampSelection(state, grid);
  const columnsFrom = state.columnsFrom;
  state.columnsFrom = null;
  if (state.frozen) {
    if (state.frozen.length !== grid.cols) {
      // 列数变了（自己插删列、别人改的）：新列从 0 宽长出来，别的列滑到新的宽度
      const from =
        columnsFrom?.length === grid.cols
          ? columnsFrom
          : mapWidths(state.frozen, grid.cols, columnShift);
      relayout(block, from);
    } else applyWidths(table, state.frozen);
  }
  paintSelection(block);
  syncOverflow(block);
  // 行列变了表格不一定变大小（搬行、合并）：抓手、「+」也要按新的行列重摆
  if (previous) refreshSoon(block);
}

/** 一格的属性和内容 */
function paintCell(
  state: TableState,
  widget: TableWidget,
  grid: TableGrid,
  node: HTMLTableCellElement,
  cell: GridCell,
  numeric: boolean[],
) {
  const { row, col, rowSpan, colSpan } = cell;
  node.dataset.row = String(row);
  node.dataset.col = String(col);
  if (node.rowSpan !== rowSpan) node.rowSpan = rowSpan;
  if (node.colSpan !== colSpan) node.colSpan = colSpan;
  const bottom = row + rowSpan === grid.rows;
  const right = col + colSpan === grid.cols;
  const flags: [string, boolean][] = [
    ["is-num", colSpan === 1 && !!numeric[col]],
    ["is-col0", col === 0],
    ["at-bottom", bottom],
    ["at-tl", row === 0 && col === 0],
    ["at-tr", row === 0 && right],
    ["at-bl", bottom && col === 0],
    ["at-br", bottom && right],
  ];
  for (const [name, on] of flags) node.classList.toggle(name, on);
  // HTML 表格：格子自己的颜色、对齐照着源码里的 style / align 画
  const html = widget.format === "html" ? htmlCellAt(widget.table, row, col) : null;
  if (widget.format === "html") node.setAttribute("style", html?.style ?? "");
  node.style.textAlign =
    html?.align ?? widget.table.alignments[col] ?? (numeric[col] ? "right" : "left");
  state.cells.set(key(row, col), node);
  if (node === state.editing) {
    // 源码被别处改了（撤销、协同时别人改了这张表、另一个窗格）：子编辑器跟过来，光标按改动挪，
    // 不丢焦点。子编辑器里的字写回去就是这一格的源码（`|` 补了转义、两头的空白去掉）的，算没变 ——
    // 不然正打着空格、竖线，字就被换成源码的样子。正在组字时先不动（cellEditor.ts）。
    // 这是在正文的 update 里：子编辑器要写回正文的话它自己挪到这一轮之后
    state.field?.pull(true);
    return;
  }
  const value = widget.valueAt(row, col);
  if (renderedValues.get(node) === value) return;
  node.replaceChildren(...renderCell(widget.format, value));
  renderedValues.set(node, value);
}

/** 一格显示出来的样子：GFM、CSV 按 Markdown 行内语法画；HTML 表格的格子是 HTML（去掉不安全的） */
function renderCell(format: TableFormat, value: string): Node[] {
  if (format !== "html") return renderInline(value);
  return [...sanitizeHtml(value).childNodes];
}

/**
 * 别处插了 / 删了一行或一列：DOM 里在同一个位置插 / 删（行插删 tr；列给后面的格子改列号），
 * 返回列是在哪里插 / 删的（列宽跟着挪）
 */
function shiftDom(
  block: HTMLElement,
  before: TableWidget,
  after: TableWidget,
): { at: number; delta: number } | null {
  const state = states.get(block)!;
  const doc = docOf(block);
  const at = state.editing ? cellIndex(state.editing) : null;
  const body = block.querySelector("tbody")!;
  const rowKey = (row: string[]) => row.join("\u0000");
  const row = shiftedAt(
    before.data.cells.slice(1).map(rowKey),
    after.data.cells.slice(1).map(rowKey),
    at && at.row > 0 ? at.row - 1 : null,
  );
  if (row !== null) {
    if (after.rowCount > before.rowCount) {
      body.insertBefore(doc.createElement("tr"), body.children[row] ?? null);
    } else body.children[row]?.remove();
  }
  const columns = (widget: TableWidget) =>
    widget.data.cells[0]!.map((_, col) =>
      widget.data.cells.map((cells) => cells[col] ?? "").join("\u0000"),
    );
  const col = shiftedAt(columns(before), columns(after), at?.col ?? null);
  if (col === null) return null;
  const delta = after.columnCount - before.columnCount;
  for (const node of block.querySelectorAll<HTMLTableCellElement>("th[data-col], td[data-col]")) {
    const index = Number(node.dataset.col);
    if (delta < 0 && index === col) node.remove();
    else if (index >= col + (delta < 0 ? 1 : 0)) node.dataset.col = String(index + delta);
  }
  return { at: col, delta };
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

/* ---------------- 列宽：进了表格锁住，离开时滑过去（docs/表格.md §10.3） ---------------- */

const reducedMotion = (doc: Document) =>
  doc.documentElement.dataset.reduceMotion === "true" ||
  (doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

/** 现在每一列有多宽（量格子：每格的左右边就是列的分界，合并块跨过的分界从别的行补） */
function measureColumns(block: HTMLElement): number[] {
  const state = states.get(block)!;
  const cols = state.widget.grid.cols;
  const edges: (number | null)[] = Array(cols + 1).fill(null);
  const cells = [...state.cells.values()].sort((a, b) => a.colSpan - b.colSpan);
  for (const node of cells) {
    const col = Number(node.dataset.col);
    const box = node.getBoundingClientRect();
    edges[col] ??= box.left;
    edges[col + node.colSpan] ??= box.right;
  }
  // 量不到的分界（每一行都被合并块跨过）：两边量到的之间平分
  for (let index = 0; index <= cols; index += 1) {
    if (edges[index] !== null) continue;
    let left = index - 1;
    while (left >= 0 && edges[left] === null) left -= 1;
    let right = index + 1;
    while (right <= cols && edges[right] === null) right += 1;
    const from = edges[left] ?? 0;
    const to = edges[right] ?? from;
    edges[index] = from + ((to - from) * (index - left)) / (right - left);
  }
  return Array.from({ length: cols }, (_, col) => Math.max(0, edges[col + 1]! - edges[col]!));
}

function applyWidths(table: HTMLTableElement, widths: number[]) {
  const cols = table.querySelector("colgroup")!.children as HTMLCollectionOf<HTMLElement>;
  table.style.tableLayout = "fixed";
  table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
  widths.forEach((width, index) => {
    if (cols[index]) cols[index].style.width = `${width}px`;
  });
}

function clearWidths(table: HTMLTableElement) {
  table.style.tableLayout = "";
  table.style.width = "";
  for (const col of table.querySelector("colgroup")!.children as HTMLCollectionOf<HTMLElement>) {
    col.style.width = "";
  }
}

function stopAnimation(block: HTMLElement, state: TableState) {
  if (state.animation === null) return;
  winOf(block).cancelAnimationFrame(state.animation);
  state.animation = null;
}

/** 进表格：列宽锁住 */
function freeze(block: HTMLElement) {
  const state = states.get(block);
  if (!state || state.frozen) return;
  stopAnimation(block, state);
  state.frozen = measureColumns(block);
  applyWidths(block.querySelector("table")!, state.frozen);
}

/**
 * 从 from 的列宽滑到 to（ease-out cubic，200ms：起步就走、收尾短，每一帧挪的像素均匀 ——
 * docs/PITFALLS/动效.md 规矩 7）。done 在最后一帧之后调
 */
function animateWidths(block: HTMLElement, from: number[], to: number[], done: () => void) {
  const state = states.get(block)!;
  const table = block.querySelector("table")!;
  const win = winOf(block);
  stopAnimation(block, state);
  const same =
    from.length === to.length && from.every((width, i) => Math.abs(width - to[i]!) < 0.5);
  if (same || reducedMotion(docOf(block))) {
    done();
    return;
  }
  const start = win.performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / 200);
    const eased = 1 - (1 - t) ** 3;
    applyWidths(
      table,
      to.map((width, i) => (from[i] ?? 0) + (width - (from[i] ?? 0)) * eased),
    );
    if (t < 1) state.animation = win.requestAnimationFrame(step);
    else {
      state.animation = null;
      done();
    }
    // 列宽在滑：总宽常常不变（ResizeObserver 不报），列抓手、胶囊每一帧跟着列的分界走
    refresh(block);
  };
  applyWidths(table, from);
  state.animation = win.requestAnimationFrame(step);
}

/** 离开表格：放开列宽，从锁住的宽度滑到新的自动列宽 */
function release(block: HTMLElement) {
  const state = states.get(block);
  if (!state?.frozen) return;
  const from = state.frozen;
  state.frozen = null;
  const table = block.querySelector("table")!;
  clearWidths(table);
  const to = measureColumns(block);
  animateWidths(block, from, to, () => clearWidths(table));
}

/** 表格里列变了：量出新的自动列宽，从 from 滑过去，之后锁在新的宽度上 */
function relayout(block: HTMLElement, from: number[]) {
  const state = states.get(block)!;
  const table = block.querySelector("table")!;
  stopAnimation(block, state);
  clearWidths(table);
  const to = measureColumns(block);
  state.frozen = to;
  animateWidths(block, from, to, () => {
    if (state.frozen) applyWidths(table, state.frozen);
  });
}

/** 列数变了，旧的列宽对到新的列上：插进来的列从 0 宽开始，删掉的去掉 */
function mapWidths(widths: number[], cols: number, shift: { at: number; delta: number } | null) {
  const out = [...widths];
  const delta = cols - widths.length;
  const at = shift && shift.delta === delta ? shift.at : delta > 0 ? widths.length : cols;
  if (delta > 0) out.splice(at, 0, ...Array(delta).fill(0));
  else out.splice(at, -delta);
  return out;
}

/* ---------------- 进出表格 ---------------- */

const cellIndex = (cell: HTMLTableCellElement) => ({
  row: Number(cell.dataset.row),
  col: Number(cell.dataset.col),
});

function cellAt(block: HTMLElement, row: number, col: number): HTMLTableCellElement | null {
  const state = states.get(block);
  const owner = state?.widget.grid.ownerOf(row, col);
  return owner ? (state!.cells.get(key(owner.row, owner.col)) ?? null) : null;
}

/**
 * 进了表格（改格子或选格子）：列宽锁住，行悬停高亮停掉；正文光标停到表格边上
 * （撤销时恢复的是它，停在表格里的话整张表会退回源码，停得远的话一撤销就滚走）
 */
function activate(block: HTMLElement) {
  const state = states.get(block);
  if (!state) return;
  freeze(block);
  block.classList.add("is-active");
  parkSelection(state.view, block);
}

/** 离开表格：收起编辑、选区，列宽滑到新的自动列宽 */
function deactivate(block: HTMLElement, animate = true) {
  const state = states.get(block);
  if (!state) return;
  if (state.editing) endEdit(block, state.editing, true);
  state.selection = null;
  block.classList.remove("is-active", "is-editing");
  paintSelection(block);
  if (animate) release(block);
  else if (state.frozen) {
    state.frozen = null;
    clearWidths(block.querySelector("table")!);
  }
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
  if (!editable(state)) {
    // 只读：点格子就是选中它（还能复制）
    select(block, cellIndex(cell));
    return;
  }
  if (state.editing === cell && state.field) {
    state.field.focus();
    if (caret !== "end" && caret !== "start") return;
    state.field.caret = caret === "start" ? 0 : Number.POSITIVE_INFINITY;
    return;
  }
  // 格子换格子：表格一直处在编辑中，不收起来再进来
  if (state.editing) endEdit(block, state.editing, true);
  activate(block);
  state.selection = null;
  const { row, col } = cellIndex(cell);
  const { format } = state.widget;
  const text = cellToEditor(state.widget.sourceAt(row, col), format);
  const offset =
    caret === "start"
      ? 0
      : caret === "end"
        ? "end"
        : mapOffset(cell.textContent ?? "", text, caret.rendered);
  state.editing = cell;
  renderedValues.delete(cell);
  cell.classList.add("is-editing");
  block.classList.add("is-editing");
  const field = new CellEditor({
    parent: cell,
    main: state.view,
    format,
    // 每次都按格子现在的位置读：别处插删了行列，格子跟着自己那一行（列）走（shiftDom）
    read: () => {
      const live = states.get(block);
      const at = cellIndex(cell);
      return live ? live.widget.sourceAt(at.row, at.col) : "";
    },
    write: (next) => commit(block, cell, next),
    caret: offset,
    keys: editKeys(block, cell),
    paste: (event) => pasteIntoCell(block, cell, event),
    readOnly: !editable(state),
  });
  state.field = field;
  paintSelection(block);
  field.focus();
  cell.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

/** 退出这一格的编辑。switching：马上要编辑同一张表的另一格、或者转去选格子，表格保持在里面 */
function endEdit(block: HTMLElement, cell: HTMLTableCellElement, switching = false) {
  const state = states.get(block);
  if (!state || state.editing !== cell) return;
  const field = state.field;
  // 先放开再收子编辑器：收的时候焦点没了（focusout）不算离开表格；还没写回的（组字到一半）这时写回
  state.editing = null;
  state.field = null;
  field?.destroy();
  cell.classList.remove("is-editing");
  block.classList.remove("is-editing");
  if (!switching) deactivate(block);
  if (!cell.isConnected) return;
  const { row, col } = cellIndex(cell);
  const value = state.widget.valueAt(row, col);
  cell.replaceChildren(...renderCell(state.widget.format, value));
  renderedValues.set(cell, value);
}

/** 换到另一格（不存在就返回 false） */
function focusCell(block: HTMLElement, row: number, col: number, caret: Caret): boolean {
  const cell = cellAt(block, row, col);
  if (!cell) return false;
  beginEdit(block, cell, caret);
  return true;
}

/** 整张表退回源码（菜单里的「编辑源码」） */
function showSource(view: EditorView, block: HTMLElement) {
  deactivate(block, false);
  jumpToSource(view, positionOf(view, block));
}

/**
 * 离开表格回到正文：after 放到表格下一行开头，before 放到上一行末尾。
 * 表格是文档的最后（最前）一块时先补一个空行，不然光标只能落在表格里 ——
 * 那样整张表会退回源码。
 */
function leave(view: EditorView, block: HTMLElement, side: "before" | "after") {
  deactivate(block);
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

/* ---------------- 选格子 ---------------- */

/** 选区撑到不切开合并块之后的矩形 */
function selectionRect(state: TableState): CellRect | null {
  if (!state.selection) return null;
  return state.widget.grid.expand(rectOf(state.selection.anchor, state.selection.head));
}

/** 表格变了（别人删了行），选区别落到表格外面 */
function clampSelection(state: TableState, grid: TableGrid) {
  const clamp = (pos: CellPos) => ({
    row: Math.max(0, Math.min(pos.row, grid.rows - 1)),
    col: Math.max(0, Math.min(pos.col, grid.cols - 1)),
  });
  state.selection = {
    anchor: clamp(state.selection!.anchor),
    head: clamp(state.selection!.head),
  };
}

/** 选中一片格子：焦点交给隐藏输入框（接键盘、剪贴板、输入法） */
function select(block: HTMLElement, anchor: CellPos, head: CellPos = anchor) {
  const state = states.get(block);
  if (!state) return;
  if (state.editing) endEdit(block, state.editing, true);
  activate(block);
  state.selection = { anchor, head };
  paintSelection(block);
  const sink = part<HTMLTextAreaElement>(block, ".cm-odea-table-sink");
  if (sink) {
    resetSink(sink);
    if (docOf(block).activeElement !== sink) sink.focus({ preventScroll: true });
  }
  cellAt(block, head.row, head.col)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

function resetSink(sink: HTMLTextAreaElement) {
  sink.classList.remove("is-composing");
  sink.value = SINK_TEXT;
  sink.select();
}

/** 选区、编辑中的格子画出来：选中的铺浅主色，外圈 2px 主色框（画在格子的 ::after 上，见 globals.css） */
function paintSelection(block: HTMLElement) {
  const state = states.get(block);
  if (!state) return;
  const rect = selectionRect(state);
  const grid = state.widget.grid;
  for (const node of state.cells.values()) {
    const { row, col } = cellIndex(node);
    const owner = grid.ownerOf(row, col);
    const inside =
      !!rect &&
      !!owner &&
      row >= rect.top &&
      row <= rect.bottom &&
      col >= rect.left &&
      col <= rect.right;
    node.classList.toggle("is-selected", inside);
    node.classList.toggle("sel-t", inside && row === rect!.top);
    node.classList.toggle("sel-l", inside && col === rect!.left);
    node.classList.toggle("sel-b", inside && row + owner!.rowSpan - 1 === rect!.bottom);
    node.classList.toggle("sel-r", inside && col + owner!.colSpan - 1 === rect!.right);
  }
  block.classList.toggle("has-selection", !!rect);
  placePill(block, state, rect);
  placeSink(block, state);
}

/** 选了两格以上：右上角浮一个「合并」；选的是一个合并块：「拆分」 */
function placePill(block: HTMLElement, state: TableState, rect: CellRect | null) {
  const pill = part<HTMLButtonElement>(block, ".cm-odea-table-pill");
  if (!pill) return;
  const grid = state.widget.grid;
  const mode =
    !rect || state.menu || state.pointer || !grid.merges
      ? null
      : hasMergeIn(grid, rect) && grid.cellsIn(rect).length === 1
        ? "split"
        : canMerge(grid, rect)
          ? "merge"
          : null;
  if (!mode || !rect) {
    reveal(pill, false);
    return;
  }
  pill.dataset.mode = mode;
  pill.replaceChildren(
    tableIcon(docOf(block), mode),
    mode === "merge" ? "合并单元格" : "拆分单元格",
  );
  const corner = cellAt(block, rect.top, rect.right);
  if (!corner) return;
  const base = block.getBoundingClientRect();
  const box = corner.getBoundingClientRect();
  const frame = part(block, ".cm-odea-table-scroll")!.getBoundingClientRect();
  const right = Math.min(box.right, frame.right);
  pill.style.left = `${Math.round(right - base.left - pill.offsetWidth)}px`;
  pill.style.top = `${Math.round(box.top - base.top - pill.offsetHeight - 6)}px`;
  reveal(pill, true);
}

/** 隐藏输入框盖在「打字即改」那一格上：输入法的候选框出在格子旁边，组字时它就是那一格的样子 */
function placeSink(block: HTMLElement, state: TableState) {
  const sink = part<HTMLTextAreaElement>(block, ".cm-odea-table-sink");
  if (!sink || !state.selection) return;
  const cell = cellAt(block, state.selection.anchor.row, state.selection.anchor.col);
  if (!cell) return;
  const base = block.getBoundingClientRect();
  const box = cell.getBoundingClientRect();
  sink.style.left = `${box.left - base.left}px`;
  sink.style.top = `${box.top - base.top}px`;
  sink.style.width = `${box.width}px`;
  sink.style.height = `${box.height}px`;
  sink.classList.toggle("is-header", cell.tagName === "TH");
}

/** 选中格子时打的字：清空「打字即改」那一格，写进去，接着改这一格 */
function typeIntoSelection(block: HTMLElement, text: string) {
  const state = states.get(block);
  if (!state?.selection || !text || !editable(state)) return;
  const { row, col } = state.selection.anchor;
  const owner = state.widget.grid.ownerOf(row, col);
  if (!owner) return;
  const next = structuredClone(state.widget.data);
  next.cells[owner.row]![owner.col] = cellFromEditor(text, state.widget.format);
  apply(block, next, "input.type", (target) => focusCell(target, owner.row, owner.col, "end"));
}

/* ---------------- 写回源码 ---------------- */

/** 表格源码在文档里的起点 */
const sourceStart = (view: EditorView, block: HTMLElement, widget: TableWidget) =>
  positionOf(view, block) + widget.offset;

/**
 * 把子编辑器里的这一格写回源码（只换这一格变了的那几个字，协同靠它）。
 * 不看这一格还在不在编辑：收起子编辑器时最后那一下（组字到一半就点走了）也要写回
 */
function commit(block: HTMLElement, cell: HTMLTableCellElement, value: string) {
  const state = states.get(block);
  if (!state || !cell.isConnected || !editable(state)) return;
  const { view, widget } = state;
  const { row, col } = cellIndex(cell);
  if (value === widget.sourceAt(row, col)) return;
  const next = structuredClone(widget.data);
  next.cells[row]![col] = value;
  const edits = planEdits(
    widget.table,
    widget.source,
    widget.format,
    next,
    indentOf(view, block, widget),
  );
  if (!edits.length) return;
  const base = sourceStart(view, block, widget);
  view.dispatch({
    changes: edits.map((edit) => ({
      from: base + edit.from,
      to: base + edit.to,
      insert: edit.insert,
    })),
    userEvent: "input.type",
  });
}

/** 表格第一行前面的东西（缩进、引用的 `> `）：整张重排时续行照着写 */
const indentOf = (view: EditorView, block: HTMLElement, widget: TableWidget) =>
  // CSV 的替身从围栏那一行开始，表格源码前面是「```csv」那一整行，不是缩进
  widget.format === "markdown"
    ? view.state.sliceDoc(positionOf(view, block), sourceStart(view, block, widget))
    : "";

/**
 * 表格换成 next 的样子：算出最少的源码改动（tableSource.ts）一次写回，撤销一下回来。
 * 正在编辑的格子先收起（表格保持在里面）；after 拿到改完之后的表格（通常还是同一个 DOM）
 */
function apply(
  block: HTMLElement,
  next: TableData,
  userEvent: string,
  after?: (target: HTMLElement) => void,
  reorder = false,
) {
  const state = states.get(block);
  if (!state || !editable(state)) return;
  const { view, widget } = state;
  const edits = planEdits(
    widget.table,
    widget.source,
    widget.format,
    next,
    indentOf(view, block, widget),
    reorder,
  );
  if (!edits.length) {
    state.columnsFrom = null;
    after?.(block);
    return;
  }
  if (state.editing) endEdit(block, state.editing, true);
  const start = positionOf(view, block);
  const base = sourceStart(view, block, widget);
  view.dispatch({
    changes: edits.map((edit) => ({
      from: base + edit.from,
      to: base + edit.to,
      insert: edit.insert,
    })),
    userEvent,
  });
  const target = liveBlock(view, block, start);
  if (target) after?.(target);
}

/**
 * 改完之后表格的 DOM：通常 updateDOM 就地更新，还是原来那个；万一被整个重建了
 * （比如同时还有别的改动），按位置找新的那一个。
 */
function liveBlock(view: EditorView, block: HTMLElement, start: number): HTMLElement | null {
  if (block.isConnected) return block;
  for (const candidate of view.contentDOM.querySelectorAll<HTMLElement>(".cm-odea-table-block")) {
    if (states.has(candidate) && positionOf(view, candidate) === start) return candidate;
  }
  return null;
}

/* ---------------- 操作 ---------------- */

const data = (block: HTMLElement) => states.get(block)!.widget.data;
const grid = (block: HTMLElement) => states.get(block)!.widget.grid;

/** 在第 at 行前面插 count 行；光标放进新的第一行的第 col 列 */
function insertRowsAt(block: HTMLElement, at: number, col = 0, count = 1) {
  const next = insertRows(data(block), grid(block), Math.max(1, at), count);
  apply(block, next, "input", (target) => focusCell(target, Math.max(1, at), col, "start"));
}

function deleteRowsIn(block: HTMLElement, rect: CellRect) {
  if (rect.top === 0) return;
  const next = deleteRows(data(block), grid(block), rect.top, rect.bottom);
  apply(block, next, "delete", (target) => {
    const rows = grid(target).rows;
    if (!focusCell(target, Math.min(rect.top, rows - 1), rect.left, "end")) deactivate(target);
  });
}

/**
 * 插删列之前：列宽先锁住（没进表格时也锁：新列才是从 0 宽长出来、别的列滑过去，不是一下子跳成新的宽度），
 * 告诉 fill 旧的列宽怎么对到新的列上
 */
function prepareColumns(block: HTMLElement, align: (widths: number[]) => number[]) {
  const state = states.get(block);
  if (!state || !editable(state) || !state.widget.table.layout) return;
  freeze(block);
  if (state.frozen) state.columnsFrom = align([...state.frozen]);
}

function insertColumnsAt(block: HTMLElement, at: number, row = 0, count = 1) {
  const next = insertColumns(data(block), grid(block), at, count);
  prepareColumns(block, (widths) => {
    widths.splice(at, 0, ...Array<number>(count).fill(0));
    return widths;
  });
  apply(block, next, "input", (target) => focusCell(target, row, at, "start"));
}

function deleteColumnsIn(block: HTMLElement, rect: CellRect) {
  if (rect.right - rect.left + 1 >= grid(block).cols) return;
  const next = deleteColumns(data(block), grid(block), rect.left, rect.right);
  prepareColumns(block, (widths) => {
    widths.splice(rect.left, rect.right - rect.left + 1);
    return widths;
  });
  apply(block, next, "delete", (target) => {
    const cols = grid(target).cols;
    if (!focusCell(target, rect.top, Math.min(rect.left, cols - 1), "end")) deactivate(target);
  });
}

function mergeIn(block: HTMLElement, rect: CellRect) {
  if (!canMerge(grid(block), rect)) return;
  const area = grid(block).expand(rect);
  apply(block, mergeCells(data(block), grid(block), area), "input", (target) =>
    select(target, { row: area.top, col: area.left }),
  );
}

function splitIn(block: HTMLElement, rect: CellRect) {
  const area = grid(block).expand(rect);
  apply(block, splitCells(data(block), grid(block), area), "input", (target) =>
    select(target, { row: area.top, col: area.left }, { row: area.bottom, col: area.right }),
  );
}

function clearIn(block: HTMLElement, rect: CellRect) {
  const state = states.get(block)!;
  const selection = state.selection;
  // 在正在改的那一格里右键「清空内容」：清完接着改这一格
  const editing = state.editing ? cellIndex(state.editing) : null;
  apply(block, clearCells(data(block), grid(block), rect), "delete", (target) => {
    if (selection) select(target, selection.anchor, selection.head);
    else if (editing) focusCell(target, editing.row, editing.col, "end");
  });
}

function setAlignment(block: HTMLElement, rect: CellRect, alignment: TableAlignment) {
  const state = states.get(block)!;
  const next = structuredClone(data(block));
  const all = next.alignments
    .slice(rect.left, rect.right + 1)
    .every((value) => value === alignment);
  for (let col = rect.left; col <= rect.right; col += 1)
    next.alignments[col] = all ? null : alignment;
  const selection = state.selection;
  const editing = state.editing ? cellIndex(state.editing) : null;
  const offset = state.field?.caret ?? null;
  apply(block, next, "input", (target) => {
    if (editing) {
      focusCell(target, editing.row, editing.col, "end");
      const field = states.get(target)?.field;
      if (field && offset !== null) field.caret = offset;
    } else if (selection) select(target, selection.anchor, selection.head);
  });
}

function sortBy(block: HTMLElement, col: number, direction: "asc" | "desc") {
  const state = states.get(block)!;
  if (grid(block).hasRowSpans) return;
  const format = state.widget.format;
  const next = sortRows(data(block), grid(block), col, direction, (source) =>
    cellPlainText(source, format),
  );
  apply(
    block,
    next,
    "input",
    (target) => select(target, { row: 0, col }, { row: grid(target).rows - 1, col }),
    true,
  );
}

function moveRowsTo(block: HTMLElement, from: number, to: number, before: number) {
  if (!canMoveRows(grid(block), from, to, before)) return;
  const at = before > to ? before - (to - from + 1) : before;
  const cols = grid(block).cols;
  apply(
    block,
    moveRows(data(block), from, to, before),
    "input",
    (target) => select(target, { row: at, col: 0 }, { row: at + to - from, col: cols - 1 }),
    true,
  );
}

function moveColumnsTo(block: HTMLElement, from: number, to: number, before: number) {
  if (!canMoveColumns(grid(block), from, to, before)) return;
  const at = before > to ? before - (to - from + 1) : before;
  const rows = grid(block).rows;
  const state = states.get(block)!;
  // 锁住的列宽跟着列一起搬：不然长内容挪进了窄的那一列，一直挤到离开表格
  if (state.frozen) {
    const widths = [...state.frozen];
    widths.splice(at, 0, ...widths.splice(from, to - from + 1));
    state.frozen = widths;
  }
  // HTML 表格搬列要整张重拼，格子的属性跟着列走（GFM 的列数没变，按格子换字就行）
  const html = state.widget.format === "html";
  apply(
    block,
    moveColumns(data(block), from, to, before),
    "input",
    (target) => select(target, { row: 0, col: at }, { row: rows - 1, col: at + to - from }),
    html,
  );
}

function pasteInto(block: HTMLElement, rect: CellRect, cells: string[][]) {
  const result = pasteCells(data(block), grid(block), rect, cells);
  apply(block, result.data, "input.paste", (target) =>
    select(
      target,
      { row: result.rect.top, col: result.rect.left },
      { row: result.rect.bottom, col: result.rect.right },
    ),
  );
}

function deleteTable(view: EditorView, block: HTMLElement) {
  const state = states.get(block);
  if (!state || !editable(state)) return;
  deactivate(block, false);
  const from = positionOf(view, block);
  const end = sourceStart(view, block, state.widget) + state.widget.source.length;
  const { doc } = view.state;
  const to = Math.min(doc.length, end + (doc.sliceString(end, end + 1) === "\n" ? 1 : 0));
  view.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent: "delete" });
  view.focus();
}

/** 一片格子复制成 GFM 表格的源码（菜单里的「复制为 Markdown」） */
function copyAsMarkdown(block: HTMLElement, rect: CellRect) {
  const state = states.get(block)!;
  const text = gfmTableSource(
    markdownCells(state.widget, rect),
    state.widget.data.alignments.slice(rect.left, rect.right + 1),
  );
  void winOf(block).navigator.clipboard?.writeText(text);
}

/** 一片格子写成 GFM 的格子：CSV 的值补转义，HTML 的格子换成 Markdown（合并记号照抄） */
function markdownCells(widget: TableWidget, rect: CellRect): string[][] {
  return rectSources(widget.data.cells, rect).map((row, r) =>
    row.map((value, c) => {
      if (widget.format === "markdown") return value;
      if (widget.format !== "html") return gfmCellSource(value);
      return widget.grid.isAnchor(rect.top + r, rect.left + c)
        ? htmlCellMarkdown(htmlCellSource(value))
        : value;
    }),
  );
}

/**
 * HTML 表格整张换成 GFM 表格（菜单里的「转成 Markdown 表格」）：合并写成 `<` `^`，粗斜体、链接、
 * 换行留成 Markdown，列的对齐取表头那一格的 align；<caption> 变成表格上面的一段。别的属性（颜色）没了
 */
function convertToMarkdown(view: EditorView, block: HTMLElement) {
  const state = states.get(block);
  if (!state || !editable(state) || state.widget.format !== "html") return;
  const { widget } = state;
  const all = { top: 0, left: 0, bottom: widget.grid.rows - 1, right: widget.grid.cols - 1 };
  const alignments = Array.from({ length: widget.grid.cols }, (_, col) => {
    const head = htmlCellAt(widget.table, 0, col);
    return head && head.colSpan === 1 ? head.align : null;
  });
  const title = widget.table.html?.caption ? htmlCellMarkdown(widget.table.html.caption) : "";
  const text = `${title ? `${title}\n\n` : ""}${gfmTableSource(markdownCells(widget, all), alignments)}`;
  deactivate(block, false);
  const from = sourceStart(view, block, widget);
  view.dispatch({
    changes: { from, to: from + widget.source.length, insert: text },
    userEvent: "input",
  });
  view.focus();
}

/* ---------------- 菜单 ---------------- */

const plural = (count: number, unit: string, one: string) =>
  count > 1 ? `删除 ${count} ${unit}` : one;

function alignmentEntry(block: HTMLElement, rect: CellRect): MenuEntry[] {
  const state = states.get(block)!;
  if (state.widget.format !== "markdown") return [];
  const alignments = state.widget.data.alignments.slice(rect.left, rect.right + 1);
  const same = alignments.every((value) => value === alignments[0]) ? alignments[0] : undefined;
  const segment = (alignment: "left" | "center" | "right", label: string) => ({
    icon: `align-${alignment}` as const,
    label,
    active: same === alignment,
    run: () => setAlignment(block, rect, alignment),
  });
  return [
    {
      label: "对齐",
      segments: [segment("left", "左对齐"), segment("center", "居中"), segment("right", "右对齐")],
    },
  ];
}

/** 只选了一列时：按这一列排序（表身里有竖着合并的不能排） */
function sortEntries(block: HTMLElement, rect: CellRect): MenuEntry[] {
  if (rect.left !== rect.right) return [];
  const blocked = grid(block).hasRowSpans ? "有竖着合并的格子，不能排序" : false;
  return [
    {
      label: "升序排列",
      icon: "sort-asc",
      disabled: blocked,
      run: () => sortBy(block, rect.left, "asc"),
    },
    {
      label: "降序排列",
      icon: "sort-desc",
      disabled: blocked,
      run: () => sortBy(block, rect.left, "desc"),
    },
  ];
}

function rowMenu(block: HTMLElement, rect: CellRect): MenuEntry[] {
  const count = rect.bottom - rect.top + 1;
  const header = rect.top === 0;
  return [
    {
      label: "在上方插入行",
      icon: "insert-above",
      disabled: header && "表头上面不能插行",
      run: () => insertRowsAt(block, rect.top, 0),
    },
    {
      label: "在下方插入行",
      icon: "insert-below",
      hint: `${MOD_KEY}+Enter`,
      run: () => insertRowsAt(block, rect.bottom + 1, 0),
    },
    "separator",
    { label: "清空内容", icon: "clear", hint: "Delete", run: () => clearIn(block, rect) },
    {
      label: plural(count, "行", "删除这一行"),
      icon: "delete",
      danger: true,
      disabled: header && "表头不能删",
      run: () => deleteRowsIn(block, rect),
    },
  ];
}

function columnMenu(block: HTMLElement, rect: CellRect): MenuEntry[] {
  const state = states.get(block)!;
  const count = rect.right - rect.left + 1;
  const g = state.widget.grid;
  return [
    {
      label: "在左侧插入列",
      icon: "insert-left",
      run: () => insertColumnsAt(block, rect.left, 0),
    },
    {
      label: "在右侧插入列",
      icon: "insert-right",
      run: () => insertColumnsAt(block, rect.right + 1, 0),
    },
    "separator",
    ...alignmentEntry(block, rect),
    ...sortEntries(block, rect),
    "separator",
    { label: "清空内容", icon: "clear", hint: "Delete", run: () => clearIn(block, rect) },
    {
      label: plural(count, "列", "删除这一列"),
      icon: "delete",
      danger: true,
      disabled: count >= g.cols && "至少要留一列",
      run: () => deleteColumnsIn(block, rect),
    },
  ];
}

/**
 * 正在改的那一格里右键：这一格文字的剪切、复制、粘贴（和子编辑器里按 Ctrl+X / C / V 一样）。
 * 读剪贴板要权限：桌面端的窗口开了读剪贴板（src-tauri 里 enable_clipboard_access），浏览器里会问一下
 */
function textMenu(block: HTMLElement, field: CellEditor): MenuEntry[] {
  const clipboard = winOf(block).navigator.clipboard as Clipboard | undefined;
  const selected = field.selectedText;
  const nothing = !selected && "没有选中文字";
  return [
    {
      label: "剪切",
      icon: "cut",
      hint: `${MOD_KEY}+X`,
      disabled: (!clipboard && "读写不了剪贴板，用快捷键") || nothing,
      run: () => {
        void clipboard?.writeText(selected);
        field.insert("", "delete.cut");
      },
    },
    {
      label: "复制",
      icon: "copy",
      hint: `${MOD_KEY}+C`,
      disabled: (!clipboard && "读写不了剪贴板，用快捷键") || nothing,
      run: () => void clipboard?.writeText(selected),
    },
    {
      label: "粘贴",
      icon: "paste",
      hint: `${MOD_KEY}+V`,
      disabled: !clipboard?.readText && "读不了剪贴板，用快捷键",
      run: () => void pasteText(block, field),
    },
  ];
}

/** 菜单里的「粘贴」：一块格子（Excel、网页上的表）从这一格起铺开，一段字插在光标处（和 Ctrl+V 一样） */
async function pasteText(block: HTMLElement, field: CellEditor) {
  let text = "";
  try {
    text = await winOf(block).navigator.clipboard.readText();
  } catch {
    // 没给读剪贴板的权限：焦点已经回到格子里，按 Ctrl+V 照样能贴
    return;
  }
  const state = states.get(block);
  if (!text || !state?.editing || state.field !== field) return;
  const plain = { getData: (type: string) => (type === "text/plain" ? text : "") };
  const cells = clipboardCells(plain as DataTransfer, state.widget.format);
  if (cells && (cells.length > 1 || (cells[0]?.length ?? 0) > 1)) {
    const { row, col } = cellIndex(state.editing);
    pasteInto(block, cellRect(state.widget.grid.ownerOf(row, col)!), cells);
    return;
  }
  field.insert(text, "input.paste");
}

/** editing：在正在改的那一格里右键（Delete 在格子里是删一个字，「清空内容」不标这个快捷键） */
function cellMenu(
  view: EditorView,
  block: HTMLElement,
  rect: CellRect,
  editing = false,
): MenuEntry[] {
  const state = states.get(block)!;
  const g = state.widget.grid;
  if (!editable(state)) {
    return [
      { label: "复制为 Markdown", icon: "copy", run: () => copyAsMarkdown(block, rect) },
      { label: "查看源码", icon: "source", run: () => showSource(view, block) },
    ];
  }
  const rows = rect.bottom - rect.top + 1;
  const cols = rect.right - rect.left + 1;
  const merge: MenuEntry[] = !g.merges
    ? []
    : hasMergeIn(g, rect) && g.cellsIn(rect).length === 1
      ? [{ label: "拆分单元格", icon: "split", run: () => splitIn(block, rect) }, "separator"]
      : canMerge(g, rect)
        ? [{ label: "合并单元格", icon: "merge", run: () => mergeIn(block, rect) }, "separator"]
        : [];
  return [
    ...merge,
    {
      label: "在上方插入行",
      icon: "insert-above",
      disabled: rect.top === 0 && "表头上面不能插行",
      run: () => insertRowsAt(block, rect.top, rect.left),
    },
    {
      label: "在下方插入行",
      icon: "insert-below",
      hint: `${MOD_KEY}+Enter`,
      run: () => insertRowsAt(block, rect.bottom + 1, rect.left),
    },
    {
      label: "在左侧插入列",
      icon: "insert-left",
      run: () => insertColumnsAt(block, rect.left, rect.top),
    },
    {
      label: "在右侧插入列",
      icon: "insert-right",
      run: () => insertColumnsAt(block, rect.right + 1, rect.top),
    },
    "separator",
    ...alignmentEntry(block, rect),
    ...sortEntries(block, rect),
    {
      label: "清空内容",
      icon: "clear",
      hint: editing ? undefined : "Delete",
      run: () => clearIn(block, rect),
    },
    { label: "复制为 Markdown", icon: "copy", run: () => copyAsMarkdown(block, rect) },
    "separator",
    {
      label: plural(rows, "行", "删除这一行"),
      icon: "delete",
      danger: true,
      disabled: rect.top === 0 && "表头不能删",
      run: () => deleteRowsIn(block, rect),
    },
    {
      label: plural(cols, "列", "删除这一列"),
      icon: "delete",
      danger: true,
      disabled: cols >= g.cols && "至少要留一列",
      run: () => deleteColumnsIn(block, rect),
    },
    "separator",
    ...(state.widget.format === "html"
      ? [
          {
            label: "转成 Markdown 表格",
            icon: "convert",
            run: () => convertToMarkdown(view, block),
          } satisfies MenuEntry,
        ]
      : []),
    { label: "编辑源码", icon: "source", run: () => showSource(view, block) },
    { label: "删除表格", icon: "delete", danger: true, run: () => deleteTable(view, block) },
  ];
}

/** 弹菜单：开着时不算离开表格；关的时候焦点交还给选区 */
function openMenu(block: HTMLElement, at: { x: number; y: number }, entries: MenuEntry[]) {
  const state = states.get(block);
  if (!state) return;
  state.menu = true;
  hideHover(block);
  placePill(block, state, null);
  showTableMenu(block, at, entries, () => {
    state.menu = false;
    if (!block.isConnected) return;
    const sink = part<HTMLTextAreaElement>(block, ".cm-odea-table-sink");
    // 菜单里的操作会自己放焦点（进格子、选格子）；没放的回到选区 / 正在改的那一格
    queueMicrotask(() => {
      if (!block.isConnected || state.menu) return;
      // 开菜单时浮着的控件都收了：鼠标还停在表格上的话按它摆回来
      refreshSoon(block);
      const active = docOf(block).activeElement;
      if (block.contains(active)) {
        paintSelection(block);
        return;
      }
      if (state.selection && sink) {
        resetSink(sink);
        sink.focus({ preventScroll: true });
        paintSelection(block);
      } else if (state.editing) {
        // 在正在改的那一格里右键（复制、复制为 Markdown 之类不挪焦点的）：回到格子里接着打字
        state.field?.focus();
      } else deactivate(block);
    });
  });
}

/* ---------------- 悬停：抓手、「+」 ---------------- */

interface Geometry {
  base: DOMRect;
  frame: DOMRect;
  table: DOMRect;
  /** 可见的那一截（横向滑动时） */
  view: DOMRect;
  /** 每一行的上下沿（表头是第 0 行） */
  rows: { top: number; bottom: number }[];
  /** 每一列的左右沿 */
  cols: { left: number; right: number }[];
}

function geometry(block: HTMLElement): Geometry {
  const table = block.querySelector("table")!;
  const rows = [
    table.querySelector("thead")!.firstElementChild!,
    ...table.querySelector("tbody")!.children,
  ].map((tr) => {
    const box = tr.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom };
  });
  const widths = measureColumns(block);
  const tableBox = table.getBoundingClientRect();
  let left = tableBox.left;
  const cols = widths.map((width) => {
    const col = { left, right: left + width };
    left += width;
    return col;
  });
  return {
    base: block.getBoundingClientRect(),
    frame: part(block, ".cm-odea-table-frame")!.getBoundingClientRect(),
    table: tableBox,
    view: part(block, ".cm-odea-table-scroll")!.getBoundingClientRect(),
    rows,
    cols,
  };
}

/** 鼠标在哪一行 / 哪一列（按位置，不按格子：合并块跨着的也分得出是哪一行） */
const indexAt = (spans: { start: number; end: number }[], value: number) =>
  spans.findIndex((span) => value >= span.start && value < span.end);

/** 离分界线多近算「要在这里插」 */
const INSERT_REACH = 6;

function hideHover(block: HTMLElement) {
  for (const selector of [
    ".cm-odea-table-grip.is-row",
    ".cm-odea-table-grip.is-col",
    ".cm-odea-table-add.is-row",
    ".cm-odea-table-add.is-col",
    ".cm-odea-table-insert",
    ".cm-odea-table-line",
  ]) {
    reveal(part(block, selector), false);
  }
}

/** 可见的那一截表格的左右边（横向滑动时） */
const visibleSpan = (g: Geometry) => ({
  left: Math.max(g.table.left, g.view.left),
  right: Math.min(g.table.right, g.view.right),
});

/** 行抓手摆到第 row 行的左边、竖着居中 */
function placeRowGrip(block: HTMLElement, g: Geometry, row: number) {
  const grip = part(block, ".cm-odea-table-grip.is-row")!;
  const span = g.rows[row]!;
  grip.dataset.index = String(row);
  grip.style.left = `${Math.round(g.frame.left - g.base.left - 20)}px`;
  grip.style.top = `${Math.round((span.top + span.bottom) / 2 - g.base.top - 11)}px`;
}

/** 列抓手摆到第 col 列露出来的那一截的正上方 */
function placeColGrip(block: HTMLElement, g: Geometry, col: number) {
  const grip = part(block, ".cm-odea-table-grip.is-col")!;
  const span = g.cols[col]!;
  const visible = visibleSpan(g);
  const center = (Math.max(span.left, visible.left) + Math.min(span.right, visible.right)) / 2;
  grip.dataset.index = String(col);
  grip.style.left = `${Math.round(center - g.base.left - 11)}px`;
  grip.style.top = `${Math.round(g.table.top - g.base.top - 8)}px`;
}

/** 下边、右边的「+」贴着表格的底边、右边 */
function placeAdds(block: HTMLElement, g: Geometry) {
  const addRow = part(block, ".cm-odea-table-add.is-row")!;
  const addCol = part(block, ".cm-odea-table-add.is-col")!;
  addRow.style.left = `${Math.round(g.frame.left - g.base.left)}px`;
  addRow.style.top = `${Math.round(g.frame.bottom - g.base.top + 4)}px`;
  addRow.style.width = `${Math.round(g.frame.width)}px`;
  addCol.style.left = `${Math.round(g.frame.right - g.base.left + 4)}px`;
  addCol.style.top = `${Math.round(g.table.top - g.base.top)}px`;
  addCol.style.height = `${Math.round(Math.min(g.table.height, g.frame.bottom - g.table.top))}px`;
}

/**
 * 按着鼠标（拖选格子、拖抓手）时表格变了：哪些控件露着不变，露着的跟着表格挪。
 * 按下就是点进格子 —— 点进空格子、拖选时收起子编辑器，那一行的高度跟着变；以前这时 hover 整个不管，
 * 松手也不补，下边的「+」停在旧的底边上，直到鼠标再动一下（2026-11-04）
 */
function follow(block: HTMLElement, g: Geometry) {
  placeAdds(block, g);
  for (const selector of [".cm-odea-table-add.is-row", ".cm-odea-table-add.is-col"]) {
    const node = part(block, selector);
    if (node?.classList.contains("is-shown")) reveal(node, true);
  }
  const rowGrip = part(block, ".cm-odea-table-grip.is-row")!;
  if (rowGrip.classList.contains("is-shown")) {
    const row = Number(rowGrip.dataset.index);
    if (row < g.rows.length) {
      placeRowGrip(block, g, row);
      reveal(rowGrip, true);
    } else reveal(rowGrip, false);
  }
  const colGrip = part(block, ".cm-odea-table-grip.is-col")!;
  if (colGrip.classList.contains("is-shown")) {
    const col = Number(colGrip.dataset.index);
    if (col < g.cols.length) {
      placeColGrip(block, g, col);
      reveal(colGrip, true);
    } else reveal(colGrip, false);
  }
}

function hover(block: HTMLElement, x: number, y: number) {
  const state = states.get(block);
  // 菜单开着：浮着的控件开菜单时都收起来了
  if (!state || state.menu || !state.widget.table.layout) return;
  if (!editable(state)) {
    hideHover(block);
    return;
  }
  const g = geometry(block);
  if (state.pointer) {
    follow(block, g);
    return;
  }
  const rowGrip = part(block, ".cm-odea-table-grip.is-row")!;
  const colGrip = part(block, ".cm-odea-table-grip.is-col")!;
  const insert = part(block, ".cm-odea-table-insert")!;
  const line = part(block, ".cm-odea-table-line")!;
  const rowSpans = g.rows.map((row) => ({ start: row.top, end: row.bottom }));
  const colSpans = g.cols.map((col) => ({ start: col.left, end: col.right }));
  const { left: visibleLeft, right: visibleRight } = visibleSpan(g);
  const row = x >= g.frame.left - 30 && x <= g.frame.right ? indexAt(rowSpans, y) : -1;
  const col =
    x >= visibleLeft && x < visibleRight && y >= g.table.top - 24 && y <= g.table.bottom
      ? indexAt(colSpans, x)
      : -1;

  // 抓手那一栏里靠近两行 / 两列的分界：出一个小「+」，点了插在那里
  let insertAt: { kind: "row" | "col"; index: number } | null = null;
  if (x < g.frame.left && y >= g.table.top && y <= g.table.bottom + INSERT_REACH) {
    g.rows.forEach((span, index) => {
      if (index > 0 && Math.abs(y - span.top) <= INSERT_REACH) insertAt = { kind: "row", index };
    });
    const last = g.rows[g.rows.length - 1]!;
    if (Math.abs(y - last.bottom) <= INSERT_REACH) insertAt = { kind: "row", index: g.rows.length };
  } else if (
    y < g.table.top &&
    x >= visibleLeft - INSERT_REACH &&
    x <= visibleRight + INSERT_REACH
  ) {
    g.cols.forEach((span, index) => {
      if (Math.abs(x - span.left) <= INSERT_REACH) insertAt = { kind: "col", index };
    });
    const last = g.cols[g.cols.length - 1]!;
    if (Math.abs(x - last.right) <= INSERT_REACH) insertAt = { kind: "col", index: g.cols.length };
  }
  const target = insertAt as { kind: "row" | "col"; index: number } | null;
  if (target) {
    const isRow = target.kind === "row";
    const at = isRow
      ? target.index < g.rows.length
        ? g.rows[target.index]!.top
        : g.rows[g.rows.length - 1]!.bottom
      : target.index < g.cols.length
        ? g.cols[target.index]!.left
        : g.cols[g.cols.length - 1]!.right;
    insert.dataset.kind = target.kind;
    insert.dataset.index = String(target.index);
    insert.title = isRow ? "在这里插入一行" : "在这里插入一列";
    insert.setAttribute("aria-label", insert.title);
    const size = 18;
    insert.style.left = `${Math.round((isRow ? g.frame.left - 22 : at) - g.base.left - (isRow ? 0 : size / 2))}px`;
    insert.style.top = `${Math.round((isRow ? at : g.table.top - 22) - g.base.top - (isRow ? size / 2 : 0))}px`;
    line.dataset.kind = target.kind;
    if (isRow) {
      line.style.left = `${Math.round(visibleLeft - g.base.left)}px`;
      line.style.top = `${Math.round(at - g.base.top - 1)}px`;
      line.style.width = `${Math.round(visibleRight - visibleLeft)}px`;
      line.style.height = "2px";
    } else {
      line.style.left = `${Math.round(at - g.base.left - 1)}px`;
      line.style.top = `${Math.round(g.table.top - g.base.top)}px`;
      line.style.width = "2px";
      line.style.height = `${Math.round(g.table.height)}px`;
    }
    reveal(insert, true);
    reveal(line, true);
    reveal(isRow ? rowGrip : colGrip, false);
  } else {
    reveal(insert, false);
    reveal(line, false);
  }

  if (row >= 0 && !(target && target.kind === "row")) {
    placeRowGrip(block, g, row);
    reveal(rowGrip, true);
  } else if (!target || target.kind !== "row") reveal(rowGrip, false);

  if (col >= 0 && !(target && target.kind === "col")) {
    placeColGrip(block, g, col);
    reveal(colGrip, true);
  } else if (!target || target.kind !== "col") reveal(colGrip, false);

  // 下边、右边的「+」：鼠标在表格上就出
  const over =
    y >= g.frame.top - 24 &&
    y <= g.frame.bottom + 24 &&
    x >= g.frame.left - 30 &&
    x <= g.frame.right + 24;
  placeAdds(block, g);
  reveal(part(block, ".cm-odea-table-add.is-row"), over);
  reveal(part(block, ".cm-odea-table-add.is-col"), over);
}

/* ---------------- 拖抓手：点 = 选中 + 菜单，拖 = 换位置 ---------------- */

function startGripDrag(block: HTMLElement, grip: HTMLElement, event: PointerEvent) {
  const state = states.get(block);
  if (!state) return;
  const isRow = grip.classList.contains("is-row");
  const index = Number(grip.dataset.index);
  if (Number.isNaN(index)) return;
  event.preventDefault();
  const g0 = state.widget.grid;
  // 这一行 / 列已经在一个整行 / 整列的选区里：拖的是整个选区
  const current = selectionRect(state);
  const whole =
    current &&
    (isRow
      ? current.left === 0 && current.right === g0.cols - 1
      : current.top === 0 && current.bottom === g0.rows - 1);
  const span =
    whole &&
    current &&
    (isRow
      ? index >= current.top && index <= current.bottom
      : index >= current.left && index <= current.right)
      ? isRow
        ? { from: current.top, to: current.bottom }
        : { from: current.left, to: current.right }
      : { from: index, to: index };
  const rect: CellRect = g0.expand(
    isRow
      ? { top: span.from, bottom: span.to, left: 0, right: g0.cols - 1 }
      : { top: 0, bottom: g0.rows - 1, left: span.from, right: span.to },
  );
  const from = isRow ? rect.top : rect.left;
  const to = isRow ? rect.bottom : rect.right;
  const win = winOf(block);
  const startX = event.clientX;
  const startY = event.clientY;
  let dragging = false;
  let before: number | null = null;
  const line = part(block, ".cm-odea-table-line")!;
  state.pointer = "grip";
  grip.setPointerCapture?.(event.pointerId);

  const move = (moveEvent: PointerEvent) => {
    if (!dragging && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 4) return;
    if (!dragging) {
      dragging = true;
      select(
        block,
        isRow ? { row: rect.top, col: 0 } : { row: 0, col: rect.left },
        isRow ? { row: rect.bottom, col: g0.cols - 1 } : { row: g0.rows - 1, col: rect.right },
      );
      block.classList.add("is-dragging");
      for (const node of states.get(block)!.cells.values()) {
        const { row, col } = cellIndex(node);
        node.classList.toggle(
          "is-dragged",
          isRow ? row >= from && row <= to : col >= from && col <= to,
        );
      }
      reveal(part(block, ".cm-odea-table-grip.is-row"), false);
      reveal(part(block, ".cm-odea-table-grip.is-col"), false);
    }
    const g = geometry(block);
    const spans = isRow
      ? g.rows.map((r) => [r.top, r.bottom])
      : g.cols.map((c) => [c.left, c.right]);
    const position = isRow ? moveEvent.clientY : moveEvent.clientX;
    // 落点：离鼠标最近的分界线
    let best = 0;
    let distance = Number.POSITIVE_INFINITY;
    for (let edge = 0; edge <= spans.length; edge += 1) {
      const at = edge < spans.length ? spans[edge]![0]! : spans[spans.length - 1]![1]!;
      if (Math.abs(position - at) < distance) {
        distance = Math.abs(position - at);
        best = edge;
      }
    }
    const allowed = isRow
      ? canMoveRows(grid(block), from, to, best)
      : canMoveColumns(grid(block), from, to, best);
    before = allowed ? best : null;
    block.classList.toggle("is-drop-blocked", !allowed && !(best >= from && best <= to + 1));
    if (before === null) {
      reveal(line, false);
      return;
    }
    const at = before < spans.length ? spans[before]![0]! : spans[spans.length - 1]![1]!;
    line.dataset.kind = isRow ? "row" : "col";
    if (isRow) {
      line.style.left = `${Math.round(g.view.left - g.base.left)}px`;
      line.style.top = `${Math.round(at - g.base.top - 1)}px`;
      line.style.width = `${Math.round(Math.min(g.table.right, g.view.right) - g.view.left)}px`;
      line.style.height = "2px";
    } else {
      line.style.left = `${Math.round(at - g.base.left - 1)}px`;
      line.style.top = `${Math.round(g.table.top - g.base.top)}px`;
      line.style.width = "2px";
      line.style.height = `${Math.round(g.table.height)}px`;
    }
    reveal(line, true);
  };
  const up = () => {
    win.removeEventListener("pointermove", move);
    win.removeEventListener("pointerup", up);
    win.removeEventListener("pointercancel", up);
    state.pointer = null;
    block.classList.remove("is-dragging", "is-drop-blocked");
    for (const node of states.get(block)?.cells.values() ?? []) node.classList.remove("is-dragged");
    reveal(line, false);
    if (!dragging) {
      // 点了一下：选中整行 / 整列，菜单从抓手旁边出来
      select(
        block,
        isRow ? { row: rect.top, col: 0 } : { row: 0, col: rect.left },
        isRow ? { row: rect.bottom, col: g0.cols - 1 } : { row: g0.rows - 1, col: rect.right },
      );
      const box = grip.getBoundingClientRect();
      const live = grid(block).expand(rect);
      openMenu(
        block,
        isRow ? { x: box.left, y: box.bottom + 4 } : { x: box.left, y: box.bottom + 4 },
        isRow ? rowMenu(block, live) : columnMenu(block, live),
      );
      return;
    }
    if (before !== null) {
      if (isRow) moveRowsTo(block, from, to, before);
      else moveColumnsTo(block, from, to, before);
    }
    // 拖的时候抓手都藏了：松手按鼠标停的那一行（列）再出来
    refresh(block);
  };
  win.addEventListener("pointermove", move);
  win.addEventListener("pointerup", up);
  win.addEventListener("pointercancel", up);
}

/* ---------------- 事件 ---------------- */

function cellFromEvent(table: HTMLElement, target: EventTarget | null) {
  const cell = (target as HTMLElement | null)?.closest?.<HTMLTableCellElement>("td, th");
  return cell && table.contains(cell) && cell.dataset.col !== undefined ? cell : null;
}

/** 按下格子拖到别的格子：从改字变成选格子 */
function trackCellDrag(block: HTMLElement, table: HTMLElement, start: HTMLTableCellElement) {
  const state = states.get(block);
  if (!state) return;
  const win = winOf(block);
  const doc = docOf(block);
  const origin = cellIndex(start);
  state.stopTracking?.();
  state.pointer = "select";
  const move = (event: MouseEvent) => {
    // 在窗口外面松的手（mouseup 没送到）：当作已经松开
    if ((event.buttons & 1) === 0) {
      up();
      return;
    }
    const over = cellFromEvent(table, doc.elementFromPoint(event.clientX, event.clientY));
    if (!over) return;
    const at = cellIndex(over);
    if (!state.selection && over === start) return;
    if (!state.selection) {
      doc.getSelection()?.removeAllRanges();
      block.classList.add("is-selecting");
    }
    if (
      state.selection &&
      state.selection.head.row === at.row &&
      state.selection.head.col === at.col
    )
      return;
    select(block, origin, at);
  };
  const up = () => {
    win.removeEventListener("mousemove", move);
    win.removeEventListener("mouseup", up);
    if (state.stopTracking === up) state.stopTracking = null;
    state.pointer = null;
    block.classList.remove("is-selecting");
    paintSelection(block);
    // 按着的时候抓手、「+」只跟着表格挪、不换（hover 里的 follow）：松手按鼠标现在停的地方重新摆一次
    refresh(block);
  };
  state.stopTracking = up;
  win.addEventListener("mousemove", move);
  win.addEventListener("mouseup", up);
}

function listen(
  view: EditorView,
  block: HTMLElement,
  frame: HTMLElement,
  scroller: HTMLElement,
  table: HTMLElement,
) {
  const editingCell = (target: EventTarget | null) => {
    const cell = cellFromEvent(table, target);
    return cell && states.get(block)?.editing === cell ? cell : null;
  };
  const sink = part<HTMLTextAreaElement>(block, ".cm-odea-table-sink");

  frame.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      // 右键按下时浏览器会把光标挪到点的地方 —— 挪进表格，CodeMirror 就当光标进了表格，
      // 整张表退回源码（菜单还没弹出来）。正在改的那一格里照常：光标挪到点的地方，菜单里的「粘贴」贴在那里
      if (event.button === 2 && !editingCell(event.target)) event.preventDefault();
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest("button")) return;
    const cell = cellFromEvent(table, target);
    const state = states.get(block);
    if (!state) return;
    state.stopTracking?.();
    if (!cell) {
      // 格子之间的缝、外框、标签栏：什么都不做（以前整张表退回源码，一不小心就是满屏竖线）
      event.preventDefault();
      return;
    }
    if (!state.widget.table.layout) {
      // 位置对不上原文的表（CSV 里有 \r）：只能回源码改
      event.preventDefault();
      showSource(view, block);
      return;
    }
    const at = cellIndex(cell);
    if (event.shiftKey && (state.editing || state.selection)) {
      event.preventDefault();
      const anchor = state.selection?.anchor ?? cellIndex(state.editing!);
      select(block, anchor, at);
      return;
    }
    if (state.editing === cell) {
      // 已经在编辑：交给浏览器放光标、拖选；拖出这一格就变成选格子
      trackCellDrag(block, table, cell);
      return;
    }
    const link = target.closest<HTMLElement>("[data-href]");
    if ((event.ctrlKey || event.metaKey) && link?.dataset.href) {
      event.preventDefault();
      void openExternal(link.dataset.href);
      return;
    }
    event.preventDefault();
    const rendered = renderedOffsetAt(cell, event.clientX, event.clientY);
    beginEdit(block, cell, rendered === null ? "end" : { rendered });
    trackCellDrag(block, table, cell);
  });

  frame.addEventListener("dblclick", (event) => {
    const cell = cellFromEvent(table, event.target);
    const state = states.get(block);
    if (!cell || !state?.selection) return;
    beginEdit(block, cell, "end");
  });

  frame.addEventListener("contextmenu", (event) => {
    const cell = cellFromEvent(table, event.target);
    const state = states.get(block);
    if (!cell || !state?.widget.table.layout) return;
    event.preventDefault();
    // 正在改的那一格里右键：还是表格的菜单，顶上加这一格文字的剪切、复制、粘贴（不转成选格子，
    // 选中的字、光标都留着）。以前这里放给系统菜单：点进一格再右键，只有点到格子边上（落在旁边那一格）
    // 才出表格的菜单（2026-11-04）。右键按下时浏览器照常把光标挪到点的地方（点在选中的字上不挪）
    if (state.editing === cell && state.field) {
      const { row, col } = cellIndex(cell);
      const owner = state.widget.grid.ownerOf(row, col)!;
      openMenu(block, { x: event.clientX, y: event.clientY }, [
        ...textMenu(block, state.field),
        "separator",
        ...cellMenu(view, block, cellRect(owner), true),
      ]);
      return;
    }
    const at = cellIndex(cell);
    const rect = selectionRect(state);
    const inside =
      rect &&
      at.row >= rect.top &&
      at.row <= rect.bottom &&
      at.col >= rect.left &&
      at.col <= rect.right;
    if (!inside) select(block, at);
    const live = selectionRect(states.get(block)!)!;
    openMenu(block, { x: event.clientX, y: event.clientY }, cellMenu(view, block, live));
  });

  block.addEventListener("focusout", (event) => {
    const state = states.get(block);
    if (!state || state.menu) return;
    // 只看「拿着焦点的那个」失焦：收起子编辑器时（换格子、转去选格子）它也会失焦，那不算离开 ——
    // 收之前 state.editing 已经放开了
    const target = event.target as Node | null;
    const owner =
      target === sink ? !!state.selection : !!target && !!state.editing?.contains(target);
    if (!owner) return;
    // 切到别的窗口：回来时接着编辑
    if (!docOf(block).hasFocus()) return;
    const next = (event as FocusEvent).relatedTarget as Node | null;
    if (next && block.contains(next)) return;
    deactivate(block);
  });

  if (sink) listenSink(view, block, sink);

  // 悬停：抓手、「+」。一帧量一次；鼠标最后停在哪记下来，表格变了、页面滚了按它重摆（refresh）
  let pending: { x: number; y: number } | null = null;
  watchScroll(docOf(block));
  block.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    const state = states.get(block);
    if (state) state.hoverAt = { x: event.clientX, y: event.clientY };
    hoveredBlock = block;
    const first = pending === null;
    pending = { x: event.clientX, y: event.clientY };
    if (!first) return;
    winOf(block).requestAnimationFrame(() => {
      const at = pending;
      pending = null;
      if (at && block.isConnected) hover(block, at.x, at.y);
    });
  });
  block.addEventListener("pointerleave", () => {
    pending = null;
    const state = states.get(block);
    if (state) state.hoverAt = null;
    if (hoveredBlock === block) hoveredBlock = null;
    if (!state?.pointer) hideHover(block);
  });
  // 横着滑宽表：鼠标底下换了一列，抓手、「+」跟过去（以前直接藏掉，鼠标不动就不回来）
  scroller.addEventListener("scroll", () => {
    syncOverflow(block);
    refreshSoon(block);
  });

  for (const grip of block.querySelectorAll<HTMLElement>(".cm-odea-table-grip")) {
    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      startGripDrag(block, grip, event);
    });
  }
  const addRow = part(block, ".cm-odea-table-add.is-row");
  addRow?.addEventListener("mousedown", (event) => event.preventDefault());
  addRow?.addEventListener("click", () => insertRowsAt(block, grid(block).rows, 0));
  const addCol = part(block, ".cm-odea-table-add.is-col");
  addCol?.addEventListener("mousedown", (event) => event.preventDefault());
  addCol?.addEventListener("click", () => insertColumnsAt(block, grid(block).cols, 0));
  const insert = part(block, ".cm-odea-table-insert");
  insert?.addEventListener("mousedown", (event) => event.preventDefault());
  insert?.addEventListener("click", () => {
    const index = Number(insert.dataset.index);
    if (Number.isNaN(index)) return;
    hideHover(block);
    if (insert.dataset.kind === "row") insertRowsAt(block, index, 0);
    else insertColumnsAt(block, index, 0);
  });
  const pill = part(block, ".cm-odea-table-pill");
  pill?.addEventListener("mousedown", (event) => event.preventDefault());
  pill?.addEventListener("click", () => {
    const state = states.get(block);
    const rect = state && selectionRect(state);
    if (!rect) return;
    if (pill.dataset.mode === "split") splitIn(block, rect);
    else mergeIn(block, rect);
  });
}

/** 选中格子时的隐藏输入框：键盘、剪贴板、输入法 */
function listenSink(view: EditorView, block: HTMLElement, sink: HTMLTextAreaElement) {
  sink.addEventListener("keydown", (event) => {
    const state = states.get(block);
    if (!state?.selection || event.isComposing || event.keyCode === 229) return;
    if (handleSelectionKey(view, block, state, event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  sink.addEventListener("input", (event) => {
    if ((event as InputEvent).isComposing) return;
    const text = sink.value.replace(/​/g, "");
    resetSink(sink);
    typeIntoSelection(block, text);
  });
  sink.addEventListener("compositionstart", () => {
    const state = states.get(block);
    if (!state) return;
    // 组字一开始，输入框就盖在那一格上、长成正在编辑的样子：拼音打在格子里
    placeSink(block, state);
    sink.value = "";
    sink.classList.add("is-composing");
  });
  sink.addEventListener("compositionend", () => {
    const text = sink.value.replace(/​/g, "");
    sink.classList.remove("is-composing");
    if (text) typeIntoSelection(block, text);
    else resetSink(sink);
  });
  sink.addEventListener("copy", (event) => {
    const state = states.get(block);
    const rect = state && selectionRect(state);
    if (!state || !rect || !event.clipboardData) return;
    event.preventDefault();
    writeCopy(
      event.clipboardData,
      state.widget.data.cells,
      state.widget.grid,
      rect,
      state.widget.format,
      docOf(block),
    );
  });
  sink.addEventListener("cut", (event) => {
    const state = states.get(block);
    const rect = state && selectionRect(state);
    if (!state || !rect || !event.clipboardData) return;
    event.preventDefault();
    writeCopy(
      event.clipboardData,
      state.widget.data.cells,
      state.widget.grid,
      rect,
      state.widget.format,
      docOf(block),
    );
    clearIn(block, rect);
  });
  sink.addEventListener("paste", (event) => {
    const state = states.get(block);
    const rect = state && selectionRect(state);
    if (!state || !rect) return;
    event.preventDefault();
    const cells =
      clipboardCells(event.clipboardData, state.widget.format) ??
      (() => {
        const text = event.clipboardData?.getData("text/plain") ?? "";
        return text ? [[cellFromEditor(text, state.widget.format)]] : null;
      })();
    if (cells) pasteInto(block, rect, cells);
  });
}

/**
 * 改一格时表格要的按键（装在子编辑器里，比它自己的先拿到；返回 false 的交给子编辑器）：
 * Tab / Enter / 方向键在格子之间走，Esc 选中这一格，撤销走正文的历史
 */
function editKeys(block: HTMLElement, cell: HTMLTableCellElement): KeyBinding[] {
  type Handler = (state: TableState, field: CellEditor) => boolean;
  const run = (handler: Handler) => (): boolean => {
    const state = states.get(block);
    if (!state || state.editing !== cell || !state.field) return false;
    return handler(state, state.field);
  };
  const at = () => cellIndex(cell);
  const owner = (state: TableState) => state.widget.grid.ownerOf(at().row, at().col)!;
  const go = (target: GridCell | null, caret: Caret = "end") =>
    !!target && focusCell(block, target.row, target.col, caret);
  const move = (key: string) =>
    run((state) => moveByKey(block, state, key, cellRect(owner(state))));
  const redoIn = () => run((state) => redo(state.view) || true);
  return [
    // 先选中这一格，再按一次回正文（Notion 的做法）
    {
      key: "Escape",
      run: run(() => {
        select(block, at());
        return true;
      }),
    },
    {
      key: "Tab",
      run: run((state) => {
        if (!go(state.widget.grid.next(at()))) insertRowsAt(block, state.widget.grid.rows, 0);
        return true;
      }),
      shift: run((state) => {
        go(state.widget.grid.next(at(), true));
        return true;
      }),
    },
    {
      key: "Enter",
      run: run((state) => {
        if (!go(state.widget.grid.step(at(), "down"))) leave(state.view, block, "after");
        return true;
      }),
    },
    // 格子里换行：子编辑器里是真的换行，写回 GFM 时是 `<br>`
    {
      key: "Shift-Enter",
      run: run((_state, field) => {
        field.insert("\n");
        return true;
      }),
    },
    {
      key: "Mod-Enter",
      run: run((state) => {
        const cell = owner(state);
        insertRowsAt(block, cell.row + cell.rowSpan, at().col);
        return true;
      }),
    },
    {
      key: "ArrowUp",
      run: run((state, field) => {
        if (!field.atVerticalEdge(false)) return false;
        if (!go(state.widget.grid.step(at(), "up"))) leave(state.view, block, "before");
        return true;
      }),
    },
    {
      key: "ArrowDown",
      run: run((state, field) => {
        if (!field.atVerticalEdge(true)) return false;
        if (!go(state.widget.grid.step(at(), "down"))) leave(state.view, block, "after");
        return true;
      }),
    },
    {
      key: "ArrowLeft",
      run: run((state, field) => {
        if (!field.atEdge(false)) return false;
        if (!go(state.widget.grid.next(at(), true))) leave(state.view, block, "before");
        return true;
      }),
    },
    {
      key: "ArrowRight",
      run: run((state, field) => {
        if (!field.atEdge(true)) return false;
        if (!go(state.widget.grid.next(at()), "start")) leave(state.view, block, "after");
        return true;
      }),
    },
    { key: "Alt-Shift-ArrowUp", run: move("ArrowUp") },
    { key: "Alt-Shift-ArrowDown", run: move("ArrowDown") },
    { key: "Alt-Shift-ArrowLeft", run: move("ArrowLeft") },
    { key: "Alt-Shift-ArrowRight", run: move("ArrowRight") },
    // 撤销 / 重做走正文的历史：格子里打的字本来就记在那里
    { key: "Mod-z", run: run((state) => undo(state.view) || true), shift: redoIn() },
    { key: "Mod-y", run: redoIn() },
    // 格子里按 Mod+S：立刻存（别弹浏览器的「另存网页」）
    {
      key: "Mod-s",
      run: () => {
        void flushAllEditors();
        return true;
      },
    },
    // 第一下全选这一格的字，已经全选了（或者是空格子）再按一下选整张表
    {
      key: "Mod-a",
      run: run((state, field) => {
        if (!field.allSelected) return false;
        const g = state.widget.grid;
        select(block, { row: 0, col: 0 }, { row: g.rows - 1, col: g.cols - 1 });
        return true;
      }),
    },
  ];
}

/** 改一格时粘贴：贴进来的是一块格子（Excel、网页上的表）就从这一格起铺开；一段字交给子编辑器 */
function pasteIntoCell(block: HTMLElement, cell: HTMLTableCellElement, event: ClipboardEvent) {
  const state = states.get(block);
  if (!state || !editable(state)) return false;
  const cells = clipboardCells(event.clipboardData, state.widget.format);
  if (!cells || (cells.length < 2 && (cells[0]?.length ?? 0) < 2)) return false;
  const { row, col } = cellIndex(cell);
  pasteInto(block, cellRect(state.widget.grid.ownerOf(row, col)!), cells);
  return true;
}

/** 选了一片格子时的键盘 */
function handleSelectionKey(
  view: EditorView,
  block: HTMLElement,
  state: TableState,
  event: KeyboardEvent,
): boolean {
  const selection = state.selection!;
  const g = state.widget.grid;
  const mod = event.ctrlKey || event.metaKey;
  const rect = selectionRect(state)!;
  const direction = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
  }[event.key] as "up" | "down" | "left" | "right" | undefined;

  if (direction && event.altKey && event.shiftKey && !mod) {
    return moveByKey(block, state, event.key, rect);
  }
  if (direction && !mod && !event.altKey) {
    if (event.shiftKey) {
      const head = g.step(selection.head, direction);
      if (head) select(block, selection.anchor, { row: head.row, col: head.col });
    } else {
      const next = g.step(selection.head, direction);
      if (next) select(block, next);
      else if (direction === "up" || direction === "down")
        leave(view, block, direction === "up" ? "before" : "after");
    }
    return true;
  }
  switch (event.key) {
    case "Escape":
      leave(view, block, "after");
      return true;
    case "Tab": {
      if (mod || event.altKey) return false;
      const next = g.next(selection.head, event.shiftKey);
      if (next) beginEdit(block, cellAt(block, next.row, next.col)!, "end");
      return true;
    }
    case "Enter":
    case "F2": {
      if (event.altKey) return false;
      if (mod && event.key === "Enter") {
        insertRowsAt(block, rect.bottom + 1, selection.head.col);
        return true;
      }
      const cell = cellAt(block, selection.anchor.row, selection.anchor.col);
      if (cell) beginEdit(block, cell, "end");
      return true;
    }
    case "Delete":
    case "Backspace":
      if (mod || event.altKey) return false;
      clearIn(block, rect);
      return true;
  }
  if (mod && !event.altKey) {
    const key = event.key.toLowerCase();
    if (key === "a") {
      select(block, { row: 0, col: 0 }, { row: g.rows - 1, col: g.cols - 1 });
      return true;
    }
    if (key === "s") {
      void flushAllEditors();
      return true;
    }
    if (key === "z" || (key === "y" && !event.shiftKey)) {
      const redoing = key === "y" || event.shiftKey;
      const keep = { ...selection };
      (redoing ? redo : undo)(view);
      const target = liveBlock(view, block, positionOf(view, block));
      if (target && states.get(target)) select(target, keep.anchor, keep.head);
      return true;
    }
  }
  return false;
}

/** Alt+Shift+方向键：整行 / 整列换位置 */
function moveByKey(block: HTMLElement, state: TableState, key: string, rect: CellRect): boolean {
  const g = state.widget.grid;
  if (key === "ArrowUp" && rect.top > 1) moveRowsTo(block, rect.top, rect.bottom, rect.top - 1);
  else if (key === "ArrowDown" && rect.top >= 1 && rect.bottom < g.rows - 1)
    moveRowsTo(block, rect.top, rect.bottom, rect.bottom + 2);
  else if (key === "ArrowLeft" && rect.left > 0)
    moveColumnsTo(block, rect.left, rect.right, rect.left - 1);
  else if (key === "ArrowRight" && rect.right < g.cols - 1)
    moveColumnsTo(block, rect.left, rect.right, rect.right + 2);
  return true;
}

/* ---------------- 新建表格 ---------------- */

/** 一张空表：表头 + 两行，三列；空格子留几个空格，往里写字时源码是 `| 字 |` */
export const EMPTY_TABLE =
  "|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |";

/**
 * 插一张渲染好的空表（`/表格`、Ctrl+T），光标放进第一格。range 默认是当前选区；
 * `/` 菜单传进来的是 `/筛选词` 那一段
 */
export function insertEmptyTable(
  view: EditorView,
  range: { from: number; to: number } = view.state.selection.main,
): boolean {
  const start = insertTableBlock(view, EMPTY_TABLE, range, "input.complete");
  if (!focusTableAt(view, start, 0, 0)) {
    // 插在视口外面、替身还没画出来：等这一帧画完再进
    winOf(view.dom).requestAnimationFrame(() => focusTableAt(view, start, 0, 0));
  }
  return true;
}

/** 把光标放进 pos 处那张表的某一格 */
export function focusTableAt(view: EditorView, pos: number, row: number, col: number): boolean {
  const line = view.state.doc.lineAt(Math.min(pos, view.state.doc.length)).from;
  for (const block of view.contentDOM.querySelectorAll<HTMLElement>(".cm-odea-table-block")) {
    if (!states.has(block) || positionOf(view, block) !== line) continue;
    return focusCell(block, row, col, "end");
  }
  return false;
}

/* ---------------- 光标 ---------------- */

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

export { closeTableMenu };
