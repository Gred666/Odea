import type { TableAlignment } from "./markdownTable";

/* ============================================================
   表格的网格：合并单元格解出来的样子，和网格上的各种操作（docs/表格.md §4、§5.4）。

   合并的写法是 GFM 表格里的两个记号：一格只有 `<` = 并进左边那一格，只有 `^` = 并进
   上面那一格（和 Obsidian 的 Structural Tables / Sheets 插件一样）。别处看到的还是一张
   普通的 GFM 表格，多几个 `<` `^`。

   这里全是纯数据：输入每一格的源码（`[0]` 是表头），输出网格；操作输入旧的格子、
   输出新的格子，写回源码的事在 tableSource.ts。没有 DOM。
   ============================================================ */

export const MERGE_LEFT = "<";
export const MERGE_UP = "^";

export interface CellPos {
  row: number;
  col: number;
}

/** 一块矩形的格子，四条边都含（行、列号和 CellPos 一样，0 行是表头） */
export interface CellRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** 一个看得见的格子（合并块的左上角）：占几行几列 */
export interface GridCell extends CellPos {
  rowSpan: number;
  colSpan: number;
}

/** 表格的内容：每一格的源码原文（合并记号也在里面）和每一列的对齐 */
export interface TableData {
  cells: string[][];
  alignments: TableAlignment[];
}

const isMarker = (source: string, marker: string) => source.trim() === marker;

export class TableGrid {
  /** 每一个位置归哪个看得见的格子（按行展开的下标） */
  private readonly owners: Int32Array;
  private readonly byIndex = new Map<number, GridCell>();
  /** 看得见的格子，先行后列 */
  readonly cells: GridCell[] = [];

  constructor(
    readonly rows: number,
    readonly cols: number,
    owners: Int32Array,
    /** 认不认合并记号（CSV 不认） */
    readonly merges = true,
  ) {
    this.owners = owners;
    for (let index = 0; index < owners.length; index += 1) {
      if (owners[index] !== index) continue;
      const cell: GridCell = {
        row: Math.floor(index / cols),
        col: index % cols,
        rowSpan: 1,
        colSpan: 1,
      };
      this.byIndex.set(index, cell);
      this.cells.push(cell);
    }
    for (let index = 0; index < owners.length; index += 1) {
      const cell = this.byIndex.get(owners[index]!)!;
      cell.rowSpan = Math.max(cell.rowSpan, Math.floor(index / cols) - cell.row + 1);
      cell.colSpan = Math.max(cell.colSpan, (index % cols) - cell.col + 1);
    }
  }

  /** 这个位置归哪个格子（出界返回 null） */
  ownerOf(row: number, col: number): GridCell | null {
    if (row < 0 || col < 0 || row >= this.rows || col >= this.cols) return null;
    return this.byIndex.get(this.owners[row * this.cols + col]!) ?? null;
  }

  isAnchor(row: number, col: number): boolean {
    const owner = this.ownerOf(row, col);
    return !!owner && owner.row === row && owner.col === col;
  }

  get hasMerges(): boolean {
    return this.cells.length < this.rows * this.cols;
  }

  /** 这一行开头的看得见的格子（按列排） */
  cellsInRow(row: number): GridCell[] {
    return this.cells.filter((cell) => cell.row === row);
  }

  /** 把矩形撑到不切开任何合并块 */
  expand(rect: CellRect): CellRect {
    const out = normalize(rect);
    for (let changed = true; changed; ) {
      changed = false;
      for (const cell of this.cells) {
        const bottom = cell.row + cell.rowSpan - 1;
        const right = cell.col + cell.colSpan - 1;
        const touches =
          cell.row <= out.bottom && bottom >= out.top && cell.col <= out.right && right >= out.left;
        if (!touches) continue;
        if (cell.row < out.top || bottom > out.bottom || cell.col < out.left || right > out.right) {
          out.top = Math.min(out.top, cell.row);
          out.bottom = Math.max(out.bottom, bottom);
          out.left = Math.min(out.left, cell.col);
          out.right = Math.max(out.right, right);
          changed = true;
        }
      }
    }
    return out;
  }

  /** 矩形里看得见的格子 */
  cellsIn(rect: CellRect): GridCell[] {
    return this.cells.filter(
      (cell) =>
        cell.row >= rect.top &&
        cell.row <= rect.bottom &&
        cell.col >= rect.left &&
        cell.col <= rect.right,
    );
  }

  /**
   * 第 row 行和第 row-1 行之间那条线有没有被合并块跨过（跨过的地方不能插整行、
   * 不能把一段行搬开）。row 等于 0 或行数时是表格的上下边，不算
   */
  crossesRowLine(row: number): boolean {
    if (row <= 0 || row >= this.rows) return false;
    return this.cells.some((cell) => cell.row < row && cell.row + cell.rowSpan > row);
  }

  crossesColumnLine(col: number): boolean {
    if (col <= 0 || col >= this.cols) return false;
    return this.cells.some((cell) => cell.col < col && cell.col + cell.colSpan > col);
  }

  /** 表身里有没有竖着合并的（有的话不能排序） */
  get hasRowSpans(): boolean {
    return this.cells.some((cell) => cell.rowSpan > 1);
  }

  /**
   * 从一个格子往某个方向走一格，落在哪个格子上（走出表格返回 null）。
   * 跨过合并块按看到的位置走：往下走从合并块的下沿出去，往右从右沿出去
   */
  step(from: CellPos, direction: "up" | "down" | "left" | "right"): GridCell | null {
    const cell = this.ownerOf(from.row, from.col);
    if (!cell) return null;
    switch (direction) {
      case "up":
        return this.ownerOf(cell.row - 1, from.col);
      case "down":
        return this.ownerOf(cell.row + cell.rowSpan, from.col);
      case "left":
        return this.ownerOf(from.row, cell.col - 1);
      case "right":
        return this.ownerOf(from.row, cell.col + cell.colSpan);
    }
  }

  /** Tab 的顺序：先行后列，跳过被盖住的位置 */
  next(from: CellPos, backward = false): GridCell | null {
    const owner = this.ownerOf(from.row, from.col);
    const index = owner ? this.cells.indexOf(owner) : -1;
    if (index < 0) return null;
    return this.cells[index + (backward ? -1 : 1)] ?? null;
  }
}

export const normalize = (rect: CellRect): CellRect => ({
  top: Math.min(rect.top, rect.bottom),
  bottom: Math.max(rect.top, rect.bottom),
  left: Math.min(rect.left, rect.right),
  right: Math.max(rect.left, rect.right),
});

export const rectOf = (a: CellPos, b: CellPos = a): CellRect =>
  normalize({ top: a.row, left: a.col, bottom: b.row, right: b.col });

export const cellRect = (cell: GridCell): CellRect => ({
  top: cell.row,
  left: cell.col,
  bottom: cell.row + cell.rowSpan - 1,
  right: cell.col + cell.colSpan - 1,
});

/**
 * 按每一格的源码解出网格。merges 是 false（CSV）时一格就是一格。
 *
 * - `<` 在第一列、`^` 在表头或表身第一行（表头和表身之间不能竖着并）当普通字
 * - 并出来不是矩形的（L 形、和别的合并块交错），这一块的记号全当普通字 —— 宁可多显示
 *   几个 `<` `^`，也不画一张对不上的表
 */
export function resolveGrid(cells: string[][], merges = true): TableGrid {
  const rows = cells.length;
  const cols = cells[0]?.length ?? 0;
  const literal = new Set<number>();
  for (;;) {
    const owners = new Int32Array(rows * cols);
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const index = row * cols + col;
        const source = cells[row]?.[col] ?? "";
        if (merges && !literal.has(index)) {
          if (col > 0 && isMarker(source, MERGE_LEFT)) {
            owners[index] = owners[index - 1]!;
            continue;
          }
          if (row > 1 && isMarker(source, MERGE_UP)) {
            owners[index] = owners[index - cols]!;
            continue;
          }
        }
        owners[index] = index;
      }
    }
    const broken = brokenMerges(owners, cols);
    if (!broken.length) return new TableGrid(rows, cols, owners, merges);
    for (const anchor of broken) {
      owners.forEach((owner, index) => {
        if (owner === anchor && index !== anchor) literal.add(index);
      });
    }
  }
}

/** 并出来不是矩形的那些合并块（左上角的下标） */
function brokenMerges(owners: Int32Array, cols: number): number[] {
  const boxes = new Map<number, CellRect & { count: number }>();
  owners.forEach((owner, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const box = boxes.get(owner);
    if (!box) boxes.set(owner, { top: row, left: col, bottom: row, right: col, count: 1 });
    else {
      box.top = Math.min(box.top, row);
      box.left = Math.min(box.left, col);
      box.bottom = Math.max(box.bottom, row);
      box.right = Math.max(box.right, col);
      box.count += 1;
    }
  });
  const broken: number[] = [];
  for (const [anchor, box] of boxes) {
    if (box.count === 1) continue;
    const area = (box.bottom - box.top + 1) * (box.right - box.left + 1);
    const corner = box.top * cols + box.left;
    if (area !== box.count || corner !== anchor) broken.push(anchor);
  }
  return broken;
}

/* ---------------- 操作：旧的格子 → 新的格子 ---------------- */

const copyData = (data: TableData): TableData => ({
  cells: data.cells.map((row) => [...row]),
  alignments: [...data.alignments],
});

/** 一块合并区按约定的写法填记号：第一行其余写 `<`，下面几行第一格 `^`、其余 `<` */
function markRegion(cells: string[][], rect: CellRect, content: string) {
  for (let row = rect.top; row <= rect.bottom; row += 1) {
    for (let col = rect.left; col <= rect.right; col += 1) {
      cells[row]![col] =
        row === rect.top && col === rect.left
          ? content
          : row > rect.top && col === rect.left
            ? MERGE_UP
            : MERGE_LEFT;
    }
  }
}

/**
 * 在第 at 行前面插 count 行空行（at 等于行数就是加在最后）。插在一个竖着的合并块中间时，
 * 新行在这一块里的格子写成记号，合并块跟着变高
 */
export function insertRows(data: TableData, grid: TableGrid, at: number, count = 1): TableData {
  const next = copyData(data);
  const cols = grid.cols;
  const fresh = Array.from({ length: count }, () => Array<string>(cols).fill(""));
  if (grid.crossesRowLine(at)) {
    for (const cell of grid.cells) {
      if (!(cell.row < at && cell.row + cell.rowSpan > at)) continue;
      for (const row of fresh) {
        for (let col = cell.col; col < cell.col + cell.colSpan; col += 1) {
          row[col] = col === cell.col ? MERGE_UP : MERGE_LEFT;
        }
      }
    }
  }
  next.cells.splice(at, 0, ...fresh);
  return next;
}

/**
 * 删掉 [from, to] 这几行（表头不能删）。被删的行里有合并块的左上角、而这一块还往下延伸：
 * 留下来的第一行接手它的内容
 */
export function deleteRows(data: TableData, grid: TableGrid, from: number, to: number): TableData {
  const next = copyData(data);
  const top = Math.max(1, from);
  if (top > to) return next;
  for (const cell of grid.cells) {
    const bottom = cell.row + cell.rowSpan - 1;
    if (cell.row < top || cell.row > to || bottom <= to) continue;
    const heir = to + 1;
    for (let col = cell.col; col < cell.col + cell.colSpan; col += 1) {
      next.cells[heir]![col] = col === cell.col ? data.cells[cell.row]![cell.col]! : MERGE_LEFT;
    }
  }
  next.cells.splice(top, to - top + 1);
  return next;
}

/** 在第 at 列前面插 count 列空列；插在横着的合并块中间时，新列在这一块里写 `<` */
export function insertColumns(data: TableData, grid: TableGrid, at: number, count = 1): TableData {
  const next = copyData(data);
  next.cells.forEach((row, index) => {
    const left = grid.ownerOf(index, at - 1);
    const inside = !!left && left === grid.ownerOf(index, at);
    row.splice(at, 0, ...Array<string>(count).fill(inside ? MERGE_LEFT : ""));
  });
  next.alignments.splice(at, 0, ...Array<TableAlignment>(count).fill(null));
  return next;
}

/** 删掉 [from, to] 这几列（至少留一列）。合并块的左上角被删、这一块还往右延伸：右边留下来的那一列接手 */
export function deleteColumns(
  data: TableData,
  grid: TableGrid,
  from: number,
  to: number,
): TableData {
  const next = copyData(data);
  if (to - from + 1 >= grid.cols) return next;
  for (const cell of grid.cells) {
    const right = cell.col + cell.colSpan - 1;
    if (cell.col < from || cell.col > to || right <= to) continue;
    for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
      next.cells[row]![to + 1] = row === cell.row ? data.cells[cell.row]![cell.col]! : MERGE_UP;
    }
  }
  for (const row of next.cells) row.splice(from, to - from + 1);
  next.alignments.splice(from, to - from + 1);
  return next;
}

/** [from, to] 这几行能不能整段搬到第 before 行前面：表身里、不切开合并块 */
export function canMoveRows(grid: TableGrid, from: number, to: number, before: number): boolean {
  if (from < 1 || before < 1 || (before >= from && before <= to + 1)) return false;
  return !grid.crossesRowLine(from) && !grid.crossesRowLine(to + 1) && !grid.crossesRowLine(before);
}

export function moveRows(data: TableData, from: number, to: number, before: number): TableData {
  const next = copyData(data);
  const block = next.cells.splice(from, to - from + 1);
  next.cells.splice(before > to ? before - block.length : before, 0, ...block);
  return next;
}

export function canMoveColumns(grid: TableGrid, from: number, to: number, before: number): boolean {
  if (before >= from && before <= to + 1) return false;
  return (
    !grid.crossesColumnLine(from) &&
    !grid.crossesColumnLine(to + 1) &&
    !grid.crossesColumnLine(before)
  );
}

export function moveColumns(data: TableData, from: number, to: number, before: number): TableData {
  const next = copyData(data);
  const at = before > to ? before - (to - from + 1) : before;
  for (const row of next.cells) row.splice(at, 0, ...row.splice(from, to - from + 1));
  next.alignments.splice(at, 0, ...next.alignments.splice(from, to - from + 1));
  return next;
}

/** 能不能合并：至少两个格子，不能把表头和表身并在一起 */
export function canMerge(grid: TableGrid, rect: CellRect): boolean {
  const area = grid.expand(rect);
  if (area.top === 0 && area.bottom > 0) return false;
  return grid.cellsIn(area).length > 1;
}

/**
 * 合并：有字的格子按先行后列用 `<br>` 接起来放进左上角（不丢字），其余写成记号
 */
export function mergeCells(data: TableData, grid: TableGrid, rect: CellRect): TableData {
  const next = copyData(data);
  const area = grid.expand(rect);
  const content = grid
    .cellsIn(area)
    .map((cell) => data.cells[cell.row]![cell.col]!.trim())
    .filter(Boolean)
    .join("<br>");
  markRegion(next.cells, area, content);
  return next;
}

/** 拆开矩形里的合并块：左上角留着内容，其余变空格子 */
export function splitCells(data: TableData, grid: TableGrid, rect: CellRect): TableData {
  const next = copyData(data);
  for (const cell of grid.cellsIn(grid.expand(rect))) {
    for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
      for (let col = cell.col; col < cell.col + cell.colSpan; col += 1) {
        if (row !== cell.row || col !== cell.col) next.cells[row]![col] = "";
      }
    }
  }
  return next;
}

/** 矩形里有没有合并块 */
export const hasMergeIn = (grid: TableGrid, rect: CellRect) =>
  grid.cellsIn(grid.expand(rect)).some((cell) => cell.rowSpan > 1 || cell.colSpan > 1);

/** 清空矩形里看得见的格子（合并块留着） */
export function clearCells(data: TableData, grid: TableGrid, rect: CellRect): TableData {
  const next = copyData(data);
  for (const cell of grid.cellsIn(grid.expand(rect))) next.cells[cell.row]![cell.col] = "";
  return next;
}

/**
 * 按第 col 列给表身排序。数字按大小、别的按拼音（`Intl.Collator` 的 zh 排序），
 * 空格子总在最后。表身里有竖着合并的不排（调用方先问 grid.hasRowSpans）
 */
export function sortRows(
  data: TableData,
  grid: TableGrid,
  col: number,
  direction: "asc" | "desc",
  plain: (source: string) => string,
): TableData {
  const next = copyData(data);
  const collator = new Intl.Collator(["zh-Hans-CN-u-co-pinyin", "zh"], {
    numeric: true,
    sensitivity: "base",
  });
  const keyOf = (row: number) => {
    const owner = grid.ownerOf(row, col)!;
    return plain(data.cells[owner.row]![owner.col]!).trim();
  };
  const numberOf = (text: string) => {
    const value = Number(text.replace(/[,$¥€£%\s]/g, ""));
    return text && Number.isFinite(value) ? value : null;
  };
  const body = Array.from({ length: grid.rows - 1 }, (_, index) => index + 1);
  const sign = direction === "asc" ? 1 : -1;
  body.sort((a, b) => {
    const left = keyOf(a);
    const right = keyOf(b);
    if (!left || !right) return left ? -1 : right ? 1 : a - b;
    const x = numberOf(left);
    const y = numberOf(right);
    const order = x !== null && y !== null ? x - y : collator.compare(left, right);
    return order ? order * sign : a - b;
  });
  next.cells = [next.cells[0]!, ...body.map((row) => [...data.cells[row]!])];
  return next;
}

/**
 * 把一块格子（复制来的）从 at 开始铺开：不够就在下面加行、右边加列。铺到的地方原来有合并块的先拆开；
 * 只有一格时铺满整个选区（和 Excel 一样）
 */
export function pasteCells(
  data: TableData,
  grid: TableGrid,
  target: CellRect,
  block: string[][],
): { data: TableData; rect: CellRect } {
  const single = block.length === 1 && block[0]!.length === 1;
  const rows = single ? target.bottom - target.top + 1 : block.length;
  const cols = single ? target.right - target.left + 1 : Math.max(...block.map((r) => r.length));
  let next = copyData(data);
  const needRows = target.top + rows - grid.rows;
  const needCols = target.left + cols - grid.cols;
  if (needCols > 0) next = insertColumns(next, grid, grid.cols, needCols);
  const widened = needCols > 0 ? resolveGrid(next.cells, grid.merges) : grid;
  if (needRows > 0) next = insertRows(next, widened, widened.rows, needRows);
  const rect: CellRect = {
    top: target.top,
    left: target.left,
    bottom: target.top + rows - 1,
    right: target.left + cols - 1,
  };
  next = splitCells(next, resolveGrid(next.cells, grid.merges), rect);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const value = single ? block[0]![0]! : (block[row]?.[col] ?? "");
      // 这一块最上面一行的 `^`、最左边一列的 `<` 会并进外面的格子：当字
      const outward =
        grid.merges &&
        ((row === 0 && isMarker(value, MERGE_UP)) || (col === 0 && isMarker(value, MERGE_LEFT)));
      next.cells[rect.top + row]![rect.left + col] = outward ? `\\${value.trim()}` : value;
    }
  }
  return { data: next, rect };
}
