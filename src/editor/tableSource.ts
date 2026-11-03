import { commonEnds } from "@/lib/lineDiff";
import { htmlTableData, planHtmlEdits } from "./htmlTable";
import {
  type MarkdownTableModel,
  type SourceRange,
  type TableFormat,
  alignmentMarker,
  csvCellSource,
  delimiterOf,
  formatGfmTable,
} from "./markdownTable";
import type { TableData } from "./tableGrid";

/* ============================================================
   表格上的操作写回源码：旧的格子 + 新的格子 → 最少的几处源码改动。

   改得越少越好：协同时两个人同时改一张表，CRDT 按字合并，整张表换掉等于「删光重插」，
   对方同时打的字会落到莫名其妙的地方（docs/协同编辑.md §4.3）；团队仓库里 git diff
   也只该出现真正改了的那几行。所以分三档：

   HTML 表格另有一套（htmlTable.ts 的 planHtmlEdits），分档的意思一样。

   1. 行列都没变（改字、合并、拆分、清空、粘贴、改对齐）：只换变了的那几格
   2. 列没变、行变了（插删行、搬行、排序）：一行一行拼，没变的行照抄原文，再和原文掐头去尾
   3. 列变了（插删列、搬列）：GFM 整张表按显示宽度重新排版（`formatGfmTable`），CSV 逐行重写

   位置都是相对表格源码开头的（调用方加上表格在文档里的起点）。
   ============================================================ */

export interface SourceEdit {
  from: number;
  to: number;
  insert: string;
}

/** 只换掉真正变了的那一段（掐掉两头相同的部分）；没变返回 null */
export function minimalEdit(from: number, before: string, after: string): SourceEdit | null {
  if (before === after) return null;
  const [head, tail] = commonEnds(before, after);
  return {
    from: from + head,
    to: from + before.length - tail,
    insert: after.slice(head, after.length - tail),
  };
}

/**
 * 现在每一格的内容：GFM 是源码原文（转义、行内语法、合并记号都原样），CSV 是去掉引号的值。
 * 短行缺的格子、空格子是空串（空格子在源码里的范围是中间那几个空格，见 markdownTable.ts 的 splitRow：
 * 以前把空格当成了内容，点进空格子光标停在一个空格后面，收起时还把它当成改动写回去）
 */
export function tableData(
  table: MarkdownTableModel,
  source: string,
  format: TableFormat,
): TableData {
  if (format === "html") return htmlTableData(table, source);
  const rows = [table.header, ...table.rows];
  const cells = rows.map((values, row) =>
    values.map((value, col) => {
      if (format !== "markdown") return value;
      const range = table.layout?.cells[row]?.[col];
      const text = range ? source.slice(range[0], range[1]) : "";
      return text.trim() ? text : "";
    }),
  );
  return { cells, alignments: [...table.alignments] };
}

/** 一格写进源码的样子 */
const encode = (format: TableFormat, value: string) =>
  format === "markdown" || format === "html" ? value : csvCellSource(value, delimiterOf(format));

/** 新起的一行源码（不带缩进 / 引用前缀）：GFM 是 `| a | b |`，空格子留三个空格好往里写 */
export function rowSource(format: TableFormat, cells: string[]): string {
  if (format === "markdown" || format === "html")
    return `| ${cells.map((cell) => cell || " ").join(" | ")} |`;
  // 只剩一格又是空的：写成 ""，不然这一行成了空行会被当成不存在
  if (cells.length === 1 && !cells[0]) return '""';
  return cells.map((cell) => encode(format, cell)).join(delimiterOf(format));
}

/** 这一行的前缀（续行的缩进、引用的 `> `）：从这一行的行首到表格内容开头 */
function prefixOf(source: string, range: SourceRange): string {
  const start = source.lastIndexOf("\n", range[0] - 1) + 1;
  return source.slice(start, range[0]);
}

/**
 * 旧的 → 新的要改哪几处源码。
 * indent：表格第一行前面的东西（缩进、`> `），整张重排时续行照着它写。
 * reorder：行换了顺序（搬行、排序）—— 行数没变也一行一行搬，每一行的排版跟着它走，
 * 不然按格子换字，`| 苹果 |  3 |` 的空格留在原地、字换成了梨
 */
export function planEdits(
  table: MarkdownTableModel,
  source: string,
  format: TableFormat,
  next: TableData,
  indent = "",
  reorder = false,
): SourceEdit[] {
  const layout = table.layout;
  if (!layout) return [];
  // HTML 表格写回还是 HTML（htmlTable.ts）
  if (format === "html") return planHtmlEdits(table, source, next, reorder);
  const current = tableData(table, source, format);
  const columns = current.cells[0]?.length ?? 0;
  const nextColumns = next.cells[0]?.length ?? 0;
  const first = layout.lines[0]![0];
  const last = layout.lines[layout.lines.length - 1]![1];

  // 3. 列变了：整张重写
  if (columns !== nextColumns) {
    const lines =
      format === "markdown"
        ? formatGfmTable(next.cells[0]!, next.alignments, next.cells.slice(1))
        : next.cells.map((row) => rowSource(format, row));
    const edit = minimalEdit(first, source.slice(first, last), lines.join(`\n${indent}`));
    return edit ? [edit] : [];
  }

  const edits: SourceEdit[] = [];
  const alignmentChanged = next.alignments.some((value, col) => value !== current.alignments[col]);

  // 2. 行变了：一行一行拼，原样的行照抄
  if (reorder || current.cells.length !== next.cells.length) {
    const key = (row: string[]) => row.join("\u0000");
    const unused = new Map<string, number[]>();
    current.cells.forEach((row, index) => {
      const list = unused.get(key(row)) ?? [];
      list.push(index);
      unused.set(key(row), list);
    });
    const continuation =
      layout.delimiter !== null
        ? prefixOf(source, layout.delimiter)
        : layout.lines[1]
          ? prefixOf(source, layout.lines[1])
          : indent;
    const lineText = (row: string[], index: number) => {
      const reuse = unused.get(key(row))?.shift();
      if (reuse === undefined) return { prefix: continuation, text: rowSource(format, row) };
      const range = layout.lines[reuse]!;
      return {
        prefix: index === 0 ? "" : reuse === 0 ? continuation : prefixOf(source, range),
        text: source.slice(range[0], range[1]),
      };
    };
    const out: string[] = [];
    next.cells.forEach((row, index) => {
      const { prefix, text } = lineText(row, index);
      out.push(index === 0 ? text : `\n${prefix}${text}`);
      if (index === 0 && layout.delimiter) {
        const delimiter = alignmentChanged
          ? `| ${next.alignments.map((value) => alignmentMarker(3, value)).join(" | ")} |`
          : source.slice(layout.delimiter[0], layout.delimiter[1]);
        out.push(`\n${prefixOf(source, layout.delimiter)}${delimiter}`);
      }
    });
    const edit = minimalEdit(first, source.slice(first, last), out.join(""));
    return edit ? [edit] : [];
  }

  // 1. 行列都没变：只换变了的格子；短行里缺的格子要写字时整行重写
  next.cells.forEach((row, index) => {
    const before = current.cells[index]!;
    const changed = row.some((value, col) => value !== before[col]);
    if (!changed) return;
    const ranges = layout.cells[index] ?? [];
    const missing = row.some((value, col) => value !== before[col] && !ranges[col]);
    if (missing) {
      const line = layout.lines[index]!;
      const edit = minimalEdit(line[0], source.slice(line[0], line[1]), rowSource(format, row));
      if (edit) edits.push(edit);
      return;
    }
    row.forEach((value, col) => {
      if (value === before[col]) return;
      const range = ranges[col]!;
      const edit = minimalEdit(range[0], source.slice(range[0], range[1]), encode(format, value));
      if (edit) edits.push(edit);
    });
  });
  if (alignmentChanged) {
    layout.delimiterCells.forEach((range, col) => {
      if (next.alignments[col] === current.alignments[col]) return;
      const marker = alignmentMarker(range[1] - range[0], next.alignments[col] ?? null);
      const edit = minimalEdit(range[0], source.slice(range[0], range[1]), marker);
      if (edit) edits.push(edit);
    });
  }
  return edits.sort((a, b) => a.from - b.from);
}
