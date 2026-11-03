import type { HtmlTableLayout } from "./htmlTable";

export type TableAlignment = "left" | "center" | "right" | null;

/** 一段源码在表格源码里的起止（相对传给解析函数的那段源码的开头） */
export type SourceRange = [from: number, to: number];

/**
 * 表格在源码里的布局：表格替身在格子里直接编辑时，靠它把改动写回对应的那一小段源码。
 * 行号和 header / rows 对齐：[0] 是表头，[1] 起是各数据行（分隔行单独给）。
 */
export interface TableLayout {
  /** 每一行源码的范围（不含换行符） */
  lines: SourceRange[];
  /**
   * 每个格子的源码范围。GFM 是去掉两边空白的内容（转义原样保留）；CSV 是两个分隔符
   * 之间的整个字段（连同引号）。短行缺的格子没有。
   */
  cells: SourceRange[][];
  /** GFM 的分隔行（`| --- |`）；CSV 没有 */
  delimiter: SourceRange | null;
  /** 分隔行每一格（`:--:` 这些）的范围，改对齐用；CSV 是空的 */
  delimiterCells: SourceRange[];
}

export interface MarkdownTableModel {
  header: string[];
  rows: string[][];
  alignments: TableAlignment[];
  layout?: TableLayout;
  /** HTML 表格的标签、属性、行组（htmlTable.ts），写回时要 */
  html?: HtmlTableLayout;
}

interface RawLine {
  text: string;
  from: number;
}

/**
 * 续行前面的缩进和引用符号：引用里的表格每一行都以 `> ` 开头（第一行的在表格源码前面，
 * 不在这里）。表格行本身不可能以 `>` 开头 —— 那样就是另起一个引用，不在表格里了
 */
const LINE_PREFIX_RE = /^[ \t]*(?:>[ \t]?)*[ \t]*/;

/** 按行切开，记下每行（去掉缩进、引用符号之后）的起点；两头的空行去掉（和以前的 trim() 一样） */
function sourceLines(source: string): RawLine[] {
  const lines: RawLine[] = [];
  let from = 0;
  for (const raw of source.split("\n")) {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const prefix = LINE_PREFIX_RE.exec(text)![0].length;
    lines.push({ text: text.slice(prefix), from: from + prefix });
    from += raw.length + 1;
  }
  while (lines.length && !lines[0]!.text.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.text.trim()) lines.pop();
  return lines;
}

/** 解析 GFM 表格供预览 Widget 使用；始终用 textContent 渲染，避免 HTML 注入。 */
export function parseMarkdownTable(source: string): MarkdownTableModel | null {
  const lines = sourceLines(source);
  if (lines.length < 2) return null;
  const header = splitRow(lines[0]!);
  const delimiters = splitRow(lines[1]!);
  // GFM 只要求分隔格里至少一个 `-`：`:-:`、`:--:` 都是合法的居中列。
  // 以前要求三个以上，格式化工具按列宽对齐后写出来的 `:--:` 让整张表退回源码。
  if (
    header.length === 0 ||
    header.length !== delimiters.length ||
    !delimiters.every((cell) => /^:?-+:?$/.test(cell.text))
  ) {
    return null;
  }

  const alignments = delimiters.map<TableAlignment>(({ text: value }) => {
    if (value.startsWith(":") && value.endsWith(":")) return "center";
    if (value.endsWith(":")) return "right";
    if (value.startsWith(":")) return "left";
    return null;
  });
  const body = lines.slice(2).map(splitRow);
  const columns = header.length;
  const rangesOf = (cells: Cell[]) => cells.slice(0, columns).map((cell) => cell.range);
  const lineRange = (line: RawLine): SourceRange => [line.from, line.from + line.text.length];
  return {
    header: header.map((cell) => cell.text),
    rows: body.map((cells) =>
      Array.from({ length: columns }, (_, index) => cells[index]?.text ?? ""),
    ),
    alignments,
    layout: {
      lines: [lines[0]!, ...lines.slice(2)].map(lineRange),
      cells: [header, ...body].map(rangesOf),
      delimiter: lineRange(lines[1]!),
      delimiterCells: delimiters.map((cell) => cell.range),
    },
  };
}

/** 金额、百分比、带千分位的数：`12`、`-3.5`、`1,024`、`¥98`、`90%`。 */
const NUMERIC_CELL_RE = /^[-+]?[$¥€£]?\d[\d,]*(?:\.\d+)?%?$/;

/**
 * 每一列是不是「数字列」：非空的格子全是数字（至少一个）。
 * 数字列右对齐、等宽数字，一列数的个位能竖着对齐；表格里写明了对齐方式的照写的来。
 */
export function numericColumns(table: MarkdownTableModel): boolean[] {
  return table.header.map((_, index) => {
    let numbers = 0;
    for (const row of table.rows) {
      const value = row[index]?.trim() ?? "";
      // 空格子、合并记号（被并掉的格子）不算
      if (!value || value === "<" || value === "^") continue;
      if (!NUMERIC_CELL_RE.test(value)) return false;
      numbers += 1;
    }
    return numbers > 0;
  });
}

interface Cell {
  /** 显示用的内容：`\|` 已经还原成 `|`，别的转义留给行内渲染 */
  text: string;
  range: SourceRange;
}

const isBlank = (char: string | undefined) => char === " " || char === "\t";

function splitRow(line: RawLine): Cell[] {
  const { text: source, from: base } = line;
  let start = 0;
  let end = source.length;
  while (start < end && isBlank(source[start])) start += 1;
  while (end > start && isBlank(source[end - 1])) end -= 1;
  if (source[start] === "|") start += 1;
  // 末尾的 `|` 是外框，但 `\|` 是内容
  if (end > start && source[end - 1] === "|" && source[end - 2] !== "\\") end -= 1;

  const cells: Cell[] = [];
  const push = (from: number, to: number) => {
    let contentFrom = from;
    let contentTo = to;
    while (contentFrom < contentTo && isBlank(source[contentFrom])) contentFrom += 1;
    while (contentTo > contentFrom && isBlank(source[contentTo - 1])) contentTo -= 1;
    let text = "";
    for (let i = contentFrom; i < contentTo; i += 1) {
      // 只有 `\|` 是表格这一层的转义；`\*` 之类原样留给单元格里的行内语法去处理，
      // 不然 `\*不是斜体\*` 进了表格反而变成斜体。
      if (source[i] === "\\" && source[i + 1] === "|") {
        text += "|";
        i += 1;
      } else text += source[i];
    }
    // 空格子：两边各留一个空格，中间多出来的空格归它 —— 写进「新」得到 `| 新 |`
    if (contentFrom === contentTo) {
      contentFrom = Math.min(from + 1, to);
      contentTo = Math.max(contentFrom, to - 1);
    }
    cells.push({ text, range: [base + contentFrom, base + contentTo] });
  };

  let cellFrom = start;
  let inCode = false;
  for (let i = start; i < end; i += 1) {
    const char = source[i];
    if (char === "\\") {
      i += 1;
    } else if (char === "`") {
      inCode = !inCode;
    } else if (char === "|" && !inCode) {
      push(cellFrom, i);
      cellFrom = i + 1;
    }
  }
  push(cellFrom, end);
  return cells;
}

/**
 * ```csv / ```tsv 围栏里的表格。第一行是表头。
 * 按 RFC 4180 的规矩处理引号：`"a, b"` 是一个格，`""` 是一个引号；
 * 空行跳过（只有分隔符的行 `,,` 不算空行，是一行空格子），短行用空格补齐。
 */
export function parseDelimitedTable(
  source: string,
  delimiter: "," | "\t",
): MarkdownTableModel | null {
  const text = source.replace(/\r\n?/g, "\n");
  // 换行符被规范化过的话，位置对不上原文，这张表只能看、不能在格子里改
  const exact = text === source;
  const rows: string[][] = [];
  const lines: SourceRange[] = [];
  const cells: SourceRange[][] = [];
  let row: string[] = [];
  let ranges: SourceRange[] = [];
  let cell = "";
  let quoted = false;
  let cellFrom = 0;
  let rowFrom = 0;

  const endCell = (to: number) => {
    row.push(cell);
    ranges.push([cellFrom, to]);
    cell = "";
    cellFrom = to + 1;
  };
  const endRow = (to: number) => {
    endCell(to);
    if (text.slice(rowFrom, to).trim()) {
      rows.push(row);
      lines.push([rowFrom, to]);
      cells.push(ranges);
    }
    row = [];
    ranges = [];
    rowFrom = to + 1;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === delimiter) {
      endCell(i);
    } else if (char === "\n") {
      endRow(i);
    } else {
      cell += char;
    }
  }
  if (rowFrom < text.length) endRow(text.length);

  const [header, ...body] = rows;
  if (!header || header.length === 0) return null;
  return {
    header: header.map((value) => value.trim()),
    rows: body.map((line) =>
      Array.from({ length: header.length }, (_, index) => (line[index] ?? "").trim()),
    ),
    alignments: header.map(() => null),
    layout: exact
      ? {
          lines,
          cells: cells.map((line) => line.slice(0, header.length)),
          delimiter: null,
          delimiterCells: [],
        }
      : undefined,
  };
}

/* ---------------- 写回源码：格子里编辑的内容 → 这个格子的源码 ---------------- */

/**
 * GFM 格子：换行写成 `<br>`，没转义的 `|` 补上反斜杠（不然会把格子劈成两个）。
 * 两边的空白去掉 —— GFM 本来就不认格子两边的空白。
 */
export function gfmCellSource(text: string): string {
  const flat = text.replace(/\r?\n/g, "<br>").trim();
  // 整格只有 `<`、`^` 是合并记号（tableGrid.ts）：真要写这个字，转义成 `\<`、`\^`
  if (flat === "<" || flat === "^") return `\\${flat}`;
  let out = "";
  for (let i = 0; i < flat.length; i += 1) {
    const char = flat[i]!;
    if (char === "\\") {
      out += char + (flat[i + 1] ?? "");
      i += 1;
    } else out += char === "|" ? "\\|" : char;
  }
  return out;
}

/** CSV / TSV 字段：含分隔符、引号、换行或两头有空白时加引号，引号写成两个。 */
export function csvCellSource(value: string, delimiter: "," | "\t"): string {
  const needsQuotes = value.includes(delimiter) || /["\r\n]/.test(value) || value !== value.trim();
  return needsQuotes ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 表格源码的四种写法：GFM 表格、```csv、```tsv、HTML 的 <table>（htmlTable.ts） */
export type TableFormat = "markdown" | "csv" | "tsv" | "html";

export const delimiterOf = (format: "csv" | "tsv"): "," | "\t" => (format === "csv" ? "," : "\t");

/** 一行空格子：GFM 是 `|   |   |`，CSV 是 `,,`（一列的 CSV 写成 `""`，空行会被跳过） */
export function emptyRowSource(columns: number, format: TableFormat): string {
  if (format === "markdown" || format === "html") return `|${"   |".repeat(columns)}`;
  return columns > 1 ? delimiterOf(format).repeat(columns - 1) : '""';
}

/* ---------------- 整张 GFM 表格重新排版（加列 / 删列时用） ---------------- */

/**
 * 等宽字体里占几格：中日韩文字、全角符号、Emoji 算两格，其余一格。
 * 排版源码时按它补空格，中文表格的竖线也能对齐。
 */
const EMOJI_PRESENTATION_RE = /\p{Emoji_Presentation}/u;

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd) ||
      // ✅ ⭐ ⚡ 这类「默认显示成 Emoji」的符号也占两格
      EMOJI_PRESENTATION_RE.test(char);
    width += wide ? 2 : 1;
  }
  return width;
}

/** 分隔格：`---`、`:--`、`--:`、`:-:`，撑到 width 宽 */
export function alignmentMarker(width: number, alignment: TableAlignment): string {
  const size = Math.max(width, 3);
  if (alignment === "center") return `:${"-".repeat(size - 2)}:`;
  if (alignment === "right") return `${"-".repeat(size - 1)}:`;
  if (alignment === "left") return `:${"-".repeat(size - 1)}`;
  return "-".repeat(size);
}

/**
 * 按列宽重新排一张 GFM 表：每列补空格对齐（右对齐的列在左边补，居中两边补），
 * 分隔行的横线撑满列宽。格子内容是源码原文（转义、行内语法都原样保留）。
 */
export function formatGfmTable(
  header: string[],
  alignments: TableAlignment[],
  rows: string[][],
): string[] {
  const columns = header.length;
  const widths = Array.from({ length: columns }, (_, col) =>
    Math.max(
      3,
      displayWidth(header[col] ?? ""),
      ...rows.map((row) => displayWidth(row[col] ?? "")),
    ),
  );
  const pad = (text: string, col: number) => {
    const gap = widths[col]! - displayWidth(text);
    const alignment = alignments[col];
    if (alignment === "right") return " ".repeat(gap) + text;
    if (alignment === "center") {
      const left = Math.floor(gap / 2);
      return " ".repeat(left) + text + " ".repeat(gap - left);
    }
    return text + " ".repeat(gap);
  };
  const line = (cells: string[]) =>
    `| ${Array.from({ length: columns }, (_, col) => pad(cells[col] ?? "", col)).join(" | ")} |`;
  return [
    line(header),
    `| ${widths.map((width, col) => alignmentMarker(width, alignments[col] ?? null)).join(" | ")} |`,
    ...rows.map(line),
  ];
}
