import { type EditorView, EditorView as View } from "@codemirror/view";
import { sanitizeHtml } from "./html";
import { htmlCellSource } from "./htmlTable";
import { inlinePlainText, renderInline } from "./inlineDom";
import {
  type TableAlignment,
  type TableFormat,
  formatGfmTable,
  gfmCellSource,
} from "./markdownTable";
import { type CellRect, MERGE_LEFT, MERGE_UP, type TableGrid } from "./tableGrid";

/* ============================================================
   表格和剪贴板（docs/表格.md §5.3、§5.5）。

   复制一片格子同时放三份：
   - text/plain：TSV，Excel、Numbers、飞书表格都认；格子里有换行、Tab、引号的按 Excel 的规矩加引号
   - text/html：带 rowspan / colspan 的 <table>，Word、飞书文档、邮件认
   - ODEA_TABLE：格子的源码原文（`**粗**`、合并记号都在），贴回 Odea 时一个字不变

   粘贴认这三样（加上 Excel、网页给的 HTML 表格）：贴进表格里从选中的那一格铺开，
   贴在正文里变成一张新的 Markdown 表格。
   ============================================================ */

export const ODEA_TABLE = "application/x-odea-table";

interface OdeaPayload {
  format: TableFormat;
  cells: string[][];
}

/* ---------------- 复制 ---------------- */

/** 一格的纯文字：行内语法（HTML 表格是标签）去掉，`<br>` 换成换行 */
export function cellPlainText(source: string, format: TableFormat): string {
  if (format === "html") return htmlPlainText(source);
  if (format !== "markdown") return source;
  return source
    .split(/<br\s*\/?>/i)
    .map((part) => inlinePlainText(part.replace(/\\\|/g, "|")))
    .join("\n");
}

/** Excel 的 TSV：含 Tab、换行、引号的格子整个加引号，引号写两个 */
const tsvField = (text: string) =>
  /[\t\n\r"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;

/** 矩形里每一格的源码，被盖住的位置照抄记号（复制出去还是一张合法的表） */
export function rectSources(cells: string[][], rect: CellRect): string[][] {
  return cells.slice(rect.top, rect.bottom + 1).map((row) => row.slice(rect.left, rect.right + 1));
}

export function writeCopy(
  data: DataTransfer,
  cells: string[][],
  grid: TableGrid,
  rect: CellRect,
  format: TableFormat,
  doc: Document,
) {
  const sources = rectSources(cells, rect);
  const plain = (row: number, col: number) => {
    const owner = grid.ownerOf(row, col);
    return owner && owner.row === row && owner.col === col
      ? cellPlainText(cells[row]![col]!, format)
      : "";
  };
  const tsv: string[] = [];
  for (let row = rect.top; row <= rect.bottom; row += 1) {
    const line: string[] = [];
    for (let col = rect.left; col <= rect.right; col += 1) line.push(tsvField(plain(row, col)));
    tsv.push(line.join("\t"));
  }
  data.setData("text/plain", tsv.join("\n"));
  data.setData("text/html", htmlTable(cells, grid, rect, format, doc));
  data.setData(ODEA_TABLE, JSON.stringify({ format, cells: sources } satisfies OdeaPayload));
}

function htmlTable(
  cells: string[][],
  grid: TableGrid,
  rect: CellRect,
  format: TableFormat,
  doc: Document,
): string {
  const table = doc.createElement("table");
  for (let row = rect.top; row <= rect.bottom; row += 1) {
    const tr = doc.createElement("tr");
    for (const cell of grid.cellsIn(rect).filter((item) => item.row === row)) {
      const td = doc.createElement(row === 0 ? "th" : "td");
      if (cell.rowSpan > 1) td.rowSpan = cell.rowSpan;
      if (cell.colSpan > 1) td.colSpan = cell.colSpan;
      const source = cells[cell.row]![cell.col]!;
      if (format === "markdown") td.append(...renderInline(source));
      else if (format === "html") td.append(sanitizeHtml(htmlCellSource(source)));
      else td.textContent = source;
      tr.append(td);
    }
    table.append(tr);
  }
  // 编辑器自己的样式类名（cm-odea-strong 这些）到了 Word、邮件里没有意义
  for (const node of table.querySelectorAll("[class]")) node.removeAttribute("class");
  return table.outerHTML;
}

/* ---------------- 粘贴：剪贴板 → 一块格子 ---------------- */

/**
 * 剪贴板里的一块格子（target 格式的源码）。不是表格（一段普通文字）返回 null。
 * strict：贴在正文里时只认「整个剪贴板就是一张表」，网页上连着正文一起复制的不算
 */
export function clipboardCells(
  data: DataTransfer | null,
  target: TableFormat,
  strict = false,
): string[][] | null {
  if (!data) return null;
  const odea = data.getData(ODEA_TABLE);
  if (odea) {
    try {
      const payload = JSON.parse(odea) as OdeaPayload;
      if (Array.isArray(payload.cells) && payload.cells.length) {
        return payload.cells.map((row) => row.map((cell) => convert(cell, payload.format, target)));
      }
    } catch {
      /* 坏的就当没有 */
    }
  }
  const html = data.getData("text/html");
  if (html && /<table[\s>]/i.test(html)) {
    const cells = htmlCells(html, target, strict);
    if (cells) return cells;
  }
  const text = data.getData("text/plain");
  if (!strict && text.includes("\t")) return tsvCells(text, target);
  return null;
}

/** 一格源码从一种写法换成另一种 */
function convert(source: string, from: TableFormat, to: TableFormat): string {
  if (from === to) return source;
  if (from === "html") {
    if (to === "markdown") return htmlCellMarkdown(htmlCellSource(source));
    return htmlPlainText(source);
  }
  if (to === "html") {
    return from === "markdown" ? markdownCellHtml(source) : plainToCell(source, "html");
  }
  if (from !== "markdown" && to !== "markdown") return source;
  if (to === "markdown") return gfmCellSource(source);
  return cellPlainText(source, "markdown");
}

const plainToCell = (text: string, target: TableFormat) =>
  target === "markdown"
    ? gfmCellSource(text)
    : target === "html"
      ? escapeHtml(text.trim()).replace(/\r?\n/g, "<br>")
      : text.trim();

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** HTML 格子的纯文字：标签去掉、实体换成字，`<br>` 换成换行 */
function htmlPlainText(source: string): string {
  const parsed = new DOMParser().parseFromString(
    htmlCellSource(source).replace(/<br\s*\/?>/gi, "\n"),
    "text/html",
  );
  return (parsed.body.textContent ?? "").trim();
}

/** 一格 HTML → GFM 源码（粗斜体、代码、链接、换行留成 Markdown，别的只留字） */
export function htmlCellMarkdown(html: string): string {
  const parsed = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  return cellMarkdown(parsed.body.firstElementChild ?? parsed.body);
}

/** 一格 GFM 源码 → HTML（贴进 HTML 表格时）：照着渲染出来的样子，去掉编辑器自己的样式类 */
function markdownCellHtml(source: string): string {
  const holder = document.createElement("div");
  holder.append(...renderInline(source));
  for (const node of holder.querySelectorAll("[class]")) node.removeAttribute("class");
  return holder.innerHTML;
}

/** TSV（Excel 的写法：带引号的格子里可以有 Tab、换行，引号写两个） */
export function tsvCells(text: string, target: TableFormat): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === "\t") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  row.push(cell);
  rows.push(row);
  const width = Math.max(...rows.map((line) => line.length));
  return rows.map((line) =>
    Array.from({ length: width }, (_, col) => plainToCell(line[col] ?? "", target)),
  );
}

/**
 * HTML 里的第一张表 → 一块格子。rowspan / colspan 换成合并记号（CSV 没有合并，盖住的位置空着）。
 * 格子里的粗体、斜体、行内代码、链接、换行保留成 Markdown，别的只留字
 */
export function htmlCells(html: string, target: TableFormat, strict = false): string[][] | null {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const table = parsed.querySelector("table");
  if (!table) return null;
  if (strict && !onlyTable(parsed.body, table)) return null;
  const grid: (string | null)[][] = [];
  const rows = [...table.querySelectorAll("tr")].filter((tr) => tr.closest("table") === table);
  rows.forEach((tr, rowIndex) => {
    grid[rowIndex] ??= [];
    let col = 0;
    for (const cell of [...tr.children].filter((node) => /^T[DH]$/.test(node.tagName))) {
      while (grid[rowIndex]![col] !== undefined) col += 1;
      // 跨出表格的 rowspan（网页上常见的 rowspan="100"）按剩下的行数算
      const rowSpan = Math.max(
        1,
        Math.min(Number(cell.getAttribute("rowspan")) || 1, rows.length - rowIndex),
      );
      const colSpan = Math.max(1, Math.min(Number(cell.getAttribute("colspan")) || 1, 1000));
      const content =
        target === "markdown"
          ? cellMarkdown(cell)
          : target === "html"
            ? markdownCellHtml(cellMarkdown(cell))
            : (cell.textContent ?? "").trim();
      for (let r = 0; r < rowSpan; r += 1) {
        grid[rowIndex + r] ??= [];
        const line = grid[rowIndex + r]!;
        for (let c = 0; c < colSpan; c += 1) {
          line[col + c] =
            r === 0 && c === 0
              ? content
              : target === "csv" || target === "tsv"
                ? ""
                : r > 0 && c === 0
                  ? MERGE_UP
                  : MERGE_LEFT;
        }
      }
      col += colSpan;
    }
  });
  const width = Math.max(0, ...grid.map((line) => line?.length ?? 0));
  if (!grid.length || !width) return null;
  const cells = grid.map((line) => Array.from({ length: width }, (_, col) => line?.[col] ?? ""));
  // 表头和表身之间不能竖着并：表身第一行的 `^` 当字
  if (cells[1]) cells[1] = cells[1].map((cell) => (cell === MERGE_UP ? "" : cell));
  return cells;
}

/** body 里除了这张表没有别的字（Excel、Google 表格、飞书表格复制出来的都是这样） */
function onlyTable(body: HTMLElement, table: HTMLTableElement): boolean {
  const clone = body.cloneNode(true) as HTMLElement;
  for (const node of clone.querySelectorAll("table, style, script, meta, link, title")) {
    node.remove();
  }
  return !clone.textContent?.trim() && !!table;
}

/** HTML 格子里的内容 → 一格 GFM 源码 */
function cellMarkdown(cell: Element): string {
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeText((node.textContent ?? "").replace(/\s+/g, " "));
    }
    if (!(node instanceof Element)) return "";
    const inner = () => [...node.childNodes].map(walk).join("");
    switch (node.tagName) {
      case "BR":
        return "<br>";
      case "B":
      case "STRONG":
        return wrap(inner(), "**");
      case "I":
      case "EM":
        return wrap(inner(), "*");
      case "S":
      case "DEL":
      case "STRIKE":
        return wrap(inner(), "~~");
      case "CODE":
        return (node.textContent ?? "").trim() ? `\`${(node.textContent ?? "").trim()}\`` : "";
      case "A": {
        const href = node.getAttribute("href") ?? "";
        const text = inner().trim();
        return /^(https?:|mailto:)/i.test(href) && text ? `[${text}](${href})` : text;
      }
      case "P":
      case "DIV":
      case "LI":
        return `${inner()}<br>`;
      case "STYLE":
      case "SCRIPT":
        return "";
      default:
        return inner();
    }
  };
  const out = walk(cell)
    .replace(/(?:\s*<br>\s*)+$/g, "")
    .replace(/^(?:\s*<br>\s*)+/g, "")
    .trim();
  return out === MERGE_LEFT || out === MERGE_UP ? `\\${out}` : out;
}

/** 粗体、斜体这类包起来：两边的空格挪到外面（`** 字**` 不算粗体） */
function wrap(text: string, mark: string): string {
  const core = text.trim();
  if (!core) return text;
  const lead = text.slice(0, text.indexOf(core));
  const trail = text.slice(text.indexOf(core) + core.length);
  return `${lead}${mark}${core}${mark}${trail}`;
}

/** 普通文字里会被当成语法的：`|` 会劈开格子，`*` `_` `` ` `` `[` 会变成格式 */
const escapeText = (text: string) => text.replace(/([|*_`[\]\\])/g, "\\$1");

/* ---------------- 正文里粘贴一张表 ---------------- */

/** 一块格子写成一张 GFM 表（第一行是表头） */
export function gfmTableSource(cells: string[][], alignments?: TableAlignment[]): string {
  const width = Math.max(...cells.map((row) => row.length));
  const rows = cells.map((row) => Array.from({ length: width }, (_, col) => row[col] ?? ""));
  return formatGfmTable(rows[0]!, alignments ?? rows[0]!.map(() => null), rows.slice(1)).join("\n");
}

/**
 * 正文里粘贴：剪贴板整个就是一张表（Excel、Google 表格、飞书表格、从 Odea 复制的一片格子）时，
 * 变成一张 Markdown 表格，前后空一行。别的照常走（附件、纯文字）
 */
export const tablePasteHandler = View.domEventHandlers({
  paste(event, view) {
    const cells = clipboardCells(event.clipboardData, "markdown", true);
    if (!cells || (cells.length < 2 && (cells[0]?.length ?? 0) < 2)) return false;
    event.preventDefault();
    insertTableBlock(view, gfmTableSource(cells));
    return true;
  },
});

/**
 * 在光标处放一张表：这一行有字就放到下面，和上下文之间各空一行（不然会被当成上一段的续行）。
 * 返回表格源码在文档里的起点
 */
export function insertTableBlock(
  view: EditorView,
  table: string,
  range: { from: number; to: number } = view.state.selection.main,
  userEvent = "input.paste",
): number {
  const { state } = view;
  const line = state.doc.lineAt(range.from);
  const before = state.sliceDoc(line.from, range.from);
  const after = state.sliceDoc(range.to, state.doc.lineAt(range.to).to);
  const previous = line.number > 1 ? state.doc.line(line.number - 1).text : "";
  // 前面：这一行有字就另起一段；空行但上一行有字，先空一行
  const head = before.trim() ? "\n\n" : previous.trim() ? "\n" : "";
  // 后面至少换一行，光标停在表格下面那一行（停在表格里的话整张表显示成源码）
  const tail = after.trim() ? "\n\n" : "\n";
  const start = range.from + head.length;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: `${head}${table}${tail}` },
    selection: { anchor: start + table.length + 1 },
    userEvent,
    scrollIntoView: true,
  });
  return start;
}
