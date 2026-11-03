import { commonEnds } from "@/lib/lineDiff";
import { INLINE_HTML_TAGS, VOID_HTML_TAGS, sanitizeStyle } from "./html";
import type { MarkdownTableModel, SourceRange, TableAlignment } from "./markdownTable";
import { MERGE_LEFT, MERGE_UP, type TableData, type TableGrid, resolveGrid } from "./tableGrid";

/* ============================================================
   HTML 表格也用表格编辑器改（docs/表格.md §8、P13.4）。

   只认「简单」的：整块就是一张 <table>；第一行是表头（在 <thead> 里，或者整行都是 <th>），
   只有一行表头、表头不竖着并进表身；格子里只有行内内容（文字、<b>、<a>、<br>、<img> 这些），
   <td> / <th> / <tr> 都写了闭标签。别的（格子里有列表、段落，表格套表格，没有表头的表）
   照旧画成只读的 HTML 块，点一下回到源码。

   网格和 GFM 表格是同一套（tableGrid.ts）：rowspan / colspan 解成合并记号，盖住的位置写 `<` `^`，
   格子的内容是 HTML 源码原文。写回还是 HTML：
   - 只改了字（合并块没变）：只换那几格里变了的字，标签、属性、排版一个不动
   - 插删行列、搬行列、排序、合并拆分：整张表的行重新拼。没动过的行照抄原文；动过的行，
     <tr> 和每一格原来的属性（style、align、class…）跟着它走 —— 新旧的行、列按内容对上，
     对不上的按位置。<table>、<caption>、<colgroup>、行组的标签、缩进都照原样
   ============================================================ */

/** 一格：td 还是 th、属性、内容在源码里的位置 */
export interface HtmlCell {
  tag: "td" | "th";
  /** 开标签里 rowspan / colspan 以外的属性原文（带前面的空格），重写这一格时照抄 */
  attrs: string;
  /** 内容（去掉两头空白）在表格源码里的范围；空格子是标签中间的整段 */
  content: SourceRange;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  /** 显示用：align 属性 / style 里的 text-align，和清洗过的 style */
  align: TableAlignment;
  style: string | null;
}

/** 两个标签之间原来的空白：开标签和第一个孩子之间、孩子之间、最后一个孩子和闭标签之间 */
interface Gaps {
  open: string;
  between: string;
  close: string;
}

export interface HtmlRow {
  /** `<tr` 到 `</tr>` */
  range: SourceRange;
  /** `<tr …>` 原文 */
  open: string;
  section: number;
  gaps: Gaps;
  cells: HtmlCell[];
}

export interface HtmlSection {
  /** null：行直接写在 <table> 里 */
  kind: "thead" | "tbody" | "tfoot" | null;
  open: SourceRange | null;
  close: SourceRange | null;
  gaps: Gaps;
}

export interface HtmlTableLayout {
  sections: HtmlSection[];
  rows: HtmlRow[];
  /** 第一个行组（行）开头到最后一个结尾：重排时只换这一段，前后（<table>、caption、</table>）原样 */
  body: SourceRange;
  /** 行组之间原来的空白 */
  sectionGap: string;
  /** <caption> 的内容（HTML） */
  caption: string | null;
}

/* ---------------- 解析 ---------------- */

interface Tag {
  name: string;
  closing: boolean;
  from: number;
  to: number;
  /** 标签名后面到 `>` 之前的原文 */
  attrs: string;
}

const TAG_RE =
  /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const COMMENT_RE = /<!--[\s\S]*?-->/y;
const SPAN_ATTR_RE = /\s+(?:rowspan|colspan)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi;

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`,
    "i",
  ).exec(attrs);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

/** 从 at 起的下一个标签（跳过注释），找不到返回 null；中间的文字放进 text */
function nextTag(source: string, at: number): { tag: Tag; text: string } | null {
  let cursor = at;
  let text = "";
  for (;;) {
    const open = source.indexOf("<", cursor);
    if (open < 0) return null;
    COMMENT_RE.lastIndex = open;
    const comment = COMMENT_RE.exec(source);
    if (comment) {
      text += source.slice(cursor, open);
      cursor = open + comment[0].length;
      continue;
    }
    TAG_RE.lastIndex = open;
    const match = TAG_RE.exec(source);
    if (!match) {
      // `<` 后面不是标签（`a < b`）：是字
      text += source.slice(cursor, open + 1);
      cursor = open + 1;
      continue;
    }
    text += source.slice(cursor, open);
    return {
      tag: {
        name: match[2]!.toLowerCase(),
        closing: match[1] === "/",
        from: open,
        to: open + match[0].length,
        attrs: match[3] ?? "",
      },
      text,
    };
  }
}

const INLINE_TAGS = new Set(
  [...Object.keys(INLINE_HTML_TAGS), ...VOID_HTML_TAGS].filter((name) => name !== "hr"),
);

/**
 * 格子里打出来的块级标签（`<p>`、`<div>`、`<td>`…）写成字（`&lt;p>`）：不然这张表当场不再是
 * 「简单的表」，整块退回只读的 HTML 块，正在改的格子跟着没了
 */
export function escapeBlockTags(html: string): string {
  return html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/g, (match, slash: string, name: string) =>
    INLINE_TAGS.has(name.toLowerCase()) ? match : `&lt;${slash}${name}`,
  );
}

const ALIGN_RE = /^(left|center|right)$/i;

function alignOf(attrs: string): TableAlignment {
  const align = attribute(attrs, "align");
  if (align && ALIGN_RE.test(align)) return align.toLowerCase() as TableAlignment;
  const style = attribute(attrs, "style");
  const match = style && /text-align\s*:\s*(left|center|right)/i.exec(style);
  return match ? (match[1]!.toLowerCase() as TableAlignment) : null;
}

/** 解析出错（不是简单的表）：照旧当 HTML 块 */
class NotSimple extends Error {}
const fail = (): never => {
  throw new NotSimple();
};

/** 一格的内容：一直读到它自己的闭标签，中间只能是行内标签 */
function readCell(source: string, open: Tag): { content: SourceRange; end: number } {
  let cursor = open.to;
  for (;;) {
    const next = nextTag(source, cursor);
    if (!next) fail();
    const { tag } = next!;
    if (tag.closing && tag.name === open.name) {
      let from = open.to;
      let to = tag.from;
      while (from < to && /\s/.test(source[from]!)) from += 1;
      while (to > from && /\s/.test(source[to - 1]!)) to -= 1;
      // 空格子：标签中间的整段（写字时连空白一起换掉）
      return { content: from === to ? [open.to, tag.from] : [from, to], end: tag.to };
    }
    if (!INLINE_TAGS.has(tag.name)) fail();
    cursor = tag.to;
  }
}

const isBlank = (text: string) => !text.trim();

/**
 * 整块 HTML 是一张简单的表：解析成和 GFM 表格一样的模型（header / rows 是每格的 HTML），
 * 外加 html 里的布局（写回用）。不是的话返回 null
 */
export function parseHtmlTable(source: string): MarkdownTableModel | null {
  try {
    return parse(source);
  } catch (error) {
    if (error instanceof NotSimple) return null;
    throw error;
  }
}

function parse(source: string): MarkdownTableModel {
  const first = nextTag(source, 0);
  if (!first || first.tag.name !== "table" || first.tag.closing || !isBlank(first.text)) fail();
  const sections: HtmlSection[] = [];
  const rows: HtmlRow[] = [];
  let caption: string | null = null;
  let section: HtmlSection | null = null;
  let bodyFrom = -1;
  let bodyTo = -1;
  let sectionGap: string | null = null;
  let lastSectionEnd = -1;
  let cursor = first!.tag.to;
  let ended = false;

  const ensureSection = (at: number): HtmlSection => {
    if (section) return section;
    // 行直接写在 <table> 里（浏览器会自己补一个 tbody）
    section = { kind: null, open: null, close: null, gaps: { open: "", between: "", close: "" } };
    sections.push(section);
    if (bodyFrom < 0) bodyFrom = at;
    return section;
  };

  while (!ended) {
    const next = nextTag(source, cursor);
    if (!next) fail();
    const { tag, text } = next!;
    if (!isBlank(text)) fail();
    if (tag.closing) {
      if (tag.name === "table") {
        if (section?.kind) fail();
        ended = true;
        if (section && !section.kind) bodyTo = rows[rows.length - 1]!.range[1];
        cursor = tag.to;
        continue;
      }
      if (!section?.kind || tag.name !== section.kind) fail();
      section!.close = [tag.from, tag.to];
      bodyTo = tag.to;
      lastSectionEnd = tag.to;
      section = null;
      cursor = tag.to;
      continue;
    }
    switch (tag.name) {
      case "caption": {
        if (bodyFrom >= 0 || caption !== null) fail();
        const close = source.indexOf("</caption>", tag.to);
        if (close < 0) fail();
        caption = source.slice(tag.to, close).trim();
        cursor = close + "</caption>".length;
        continue;
      }
      case "colgroup": {
        if (bodyFrom >= 0) fail();
        const close = source.indexOf("</colgroup>", tag.to);
        if (close < 0) fail();
        cursor = close + "</colgroup>".length;
        continue;
      }
      case "col":
        if (bodyFrom >= 0) fail();
        cursor = tag.to;
        continue;
      case "thead":
      case "tbody":
      case "tfoot": {
        // 行组里不能再套行组；直接写在 table 里的行后面不能再跟行组。
        // tfoot 写在 tbody 前面（HTML 4 的写法）时浏览器把它画在最下面，和源码的顺序对不上
        if (section || sections.some((other) => other.kind === "tfoot")) fail();
        if (sections.length && sectionGap === null && lastSectionEnd >= 0) {
          sectionGap = source.slice(lastSectionEnd, tag.from);
        }
        section = {
          kind: tag.name,
          open: [tag.from, tag.to],
          close: null,
          gaps: { open: "", between: "", close: "" },
        };
        sections.push(section);
        if (bodyFrom < 0) bodyFrom = tag.from;
        cursor = tag.to;
        continue;
      }
      case "tr": {
        if (!section && sections.some((other) => other.kind === "tfoot")) fail();
        const owner = ensureSection(tag.from);
        const row = readRow(source, tag, sections.indexOf(owner));
        const previous = rows[rows.length - 1];
        if (previous && previous.section === row.section) {
          if (!owner.gaps.between) owner.gaps.between = source.slice(previous.range[1], tag.from);
        } else if (owner.open) owner.gaps.open = source.slice(owner.open[1], tag.from);
        rows.push(row);
        cursor = row.range[1];
        // 行组的闭标签之前的空白
        const after = nextTag(source, cursor);
        if (owner.kind && after?.tag.closing && after.tag.name === owner.kind) {
          owner.gaps.close = after.text;
        }
        if (!owner.kind) bodyTo = cursor;
        continue;
      }
      default:
        fail();
    }
  }
  if (!isBlank(source.slice(cursor))) fail();
  if (!rows.length) fail();
  return build(source, {
    sections,
    rows,
    body: [bodyFrom, bodyTo],
    sectionGap: sectionGap ?? "\n",
    caption,
  });
}

function readRow(source: string, open: Tag, section: number): HtmlRow {
  const cells: HtmlCell[] = [];
  const gaps: Gaps = { open: "", between: "", close: "" };
  let cursor = open.to;
  for (;;) {
    const next = nextTag(source, cursor);
    if (!next) fail();
    const { tag, text } = next!;
    if (!isBlank(text)) fail();
    if (tag.closing && tag.name === "tr") {
      // 空的 <tr></tr> 也行：整行都被上面竖着的合并块盖住了（删掉一列之后常见）
      gaps.close = cells.length ? text : "";
      return {
        range: [open.from, tag.to],
        open: source.slice(open.from, open.to),
        section,
        gaps,
        cells,
      };
    }
    if (tag.closing || (tag.name !== "td" && tag.name !== "th")) fail();
    if (cells.length === 0) gaps.open = text;
    else if (cells.length === 1) gaps.between = text;
    const { content, end } = readCell(source, tag);
    const number = (name: string) => {
      const value = attribute(tag.attrs, name);
      return value === null ? 1 : Number.parseInt(value, 10);
    };
    cells.push({
      tag: tag.name as "td" | "th",
      attrs: tag.attrs.replace(SPAN_ATTR_RE, ""),
      content,
      row: -1,
      col: -1,
      rowSpan: number("rowspan"),
      colSpan: Math.max(1, Math.min(number("colspan") || 1, 1000)),
      align: alignOf(tag.attrs),
      style: sanitizeStyle(attribute(tag.attrs, "style") ?? undefined),
    });
    cursor = end;
  }
}

/** 按 HTML 的规矩把格子排进网格（rowspan 不出行组，0 = 到行组的最后一行），再检查是不是简单的表 */
function build(source: string, layout: HtmlTableLayout): MarkdownTableModel {
  const { rows, sections } = layout;
  // 表头：第一行在 thead 里，或者整行都是 th；只能有一行
  const head = rows[0]!;
  const headSection = sections[head.section]!;
  const isHead = headSection.kind === "thead" || head.cells.every((cell) => cell.tag === "th");
  if (!isHead) fail();
  if (headSection.kind === "thead" && rows.filter((row) => row.section === head.section).length > 1)
    fail();
  const slots: (HtmlCell | null | undefined)[][] = rows.map(() => []);
  rows.forEach((row, rowIndex) => {
    const lastInSection = rows.reduce(
      (last, other, index) => (other.section === row.section ? index : last),
      rowIndex,
    );
    let col = 0;
    for (const cell of row.cells) {
      while (slots[rowIndex]![col] !== undefined) col += 1;
      const room = lastInSection - rowIndex + 1;
      cell.rowSpan = cell.rowSpan <= 0 ? room : Math.min(cell.rowSpan, room);
      cell.row = rowIndex;
      cell.col = col;
      for (let r = 0; r < cell.rowSpan; r += 1) {
        for (let c = 0; c < cell.colSpan; c += 1) {
          // 两个格子叠在一起（rowspan 和后面的 colspan 撞了）：浏览器各画各的，这里不认
          if (slots[rowIndex + r]![col + c] !== undefined) fail();
          slots[rowIndex + r]![col + c] = r === 0 && c === 0 ? cell : null;
        }
      }
      col += cell.colSpan;
    }
  });
  // 表头不能竖着并进表身（GFM 的记号也不让）
  if (head.cells.some((cell) => cell.rowSpan > 1)) fail();
  const cols = Math.max(...slots.map((line) => line.length));
  const values = slots.map((line, row) =>
    Array.from({ length: cols }, (_, col) => {
      const cell = line[col];
      if (cell) return source.slice(cell.content[0], cell.content[1]);
      if (cell === undefined) return "";
      // 盖住的位置：和合并块左上角在同一列的（下面几行的第一格）是 `^`，别的是 `<`
      const owner = anchorOf(slots, row, col)!;
      return owner.col === col ? MERGE_UP : MERGE_LEFT;
    }),
  );
  const model: MarkdownTableModel = {
    header: values[0]!,
    rows: values.slice(1),
    alignments: Array<TableAlignment>(cols).fill(null),
    layout: {
      lines: rows.map((row) => row.range),
      cells: slots.map((line) =>
        Array.from({ length: cols }, (_, col) => line[col]?.content ?? ([-1, -1] as SourceRange)),
      ),
      delimiter: null,
      delimiterCells: [],
    },
    html: layout,
  };
  // 记号解出来的网格要和 HTML 的一模一样（不一样就是记号对不上：格子里正好只写了 `^` 之类）
  const grid = resolveGrid(htmlTableData(model, source).cells);
  for (const row of rows) {
    for (const cell of row.cells) {
      const owner = grid.ownerOf(cell.row, cell.col);
      if (
        !owner ||
        owner.row !== cell.row ||
        owner.col !== cell.col ||
        owner.rowSpan !== cell.rowSpan ||
        owner.colSpan !== cell.colSpan
      )
        fail();
    }
  }
  return model;
}

function anchorOf(slots: (HtmlCell | null | undefined)[][], row: number, col: number) {
  for (let r = row; r >= 0; r -= 1) {
    for (let c = col; c >= 0; c -= 1) {
      const cell = slots[r]?.[c];
      if (cell && cell.row + cell.rowSpan > row && cell.col + cell.colSpan > col) return cell;
    }
  }
  return null;
}

/* ---------------- 格子的内容 ↔ TableData ---------------- */

/** 格子里正好只写了 `<`、`^`（或者前面已经有反斜杠）：在 TableData 里多一个反斜杠，免得当成合并记号 */
const MARKER_LIKE_RE = /^\\*[<^]$/;

const toData = (content: string) => (MARKER_LIKE_RE.test(content) ? `\\${content}` : content);

/** TableData 里的一格 → 写进 HTML 的样子（toData 的反方向） */
export const htmlCellSource = (value: string) => (/^\\+[<^]$/.test(value) ? value.slice(1) : value);

/** 每一格的内容（HTML 原文）；盖住的位置是合并记号 */
export function htmlTableData(table: MarkdownTableModel, source: string): TableData {
  const layout = table.html!;
  const cells = [table.header, ...table.rows].map((values) => [...values]);
  for (const row of layout.rows) {
    for (const cell of row.cells) {
      cells[cell.row]![cell.col] = toData(source.slice(cell.content[0], cell.content[1]));
    }
  }
  return { cells, alignments: [...table.alignments] };
}

/** 这一格在源码里的样子（显示、对齐用）；盖住的位置、短行补出来的格子返回 null */
export function htmlCellAt(table: MarkdownTableModel, row: number, col: number): HtmlCell | null {
  for (const cell of table.html?.rows[row]?.cells ?? []) {
    if (cell.col === col) return cell;
  }
  return null;
}

/* ---------------- 写回 ---------------- */

interface Edit {
  from: number;
  to: number;
  insert: string;
}

function minimal(from: number, before: string, after: string): Edit | null {
  if (before === after) return null;
  const [head, tail] = commonEnds(before, after);
  return {
    from: from + head,
    to: from + before.length - tail,
    insert: after.slice(head, after.length - tail),
  };
}

/** 两张网格的合并块一模一样 */
function sameShape(a: TableGrid, b: TableGrid): boolean {
  if (a.rows !== b.rows || a.cols !== b.cols) return false;
  for (let row = 0; row < a.rows; row += 1) {
    for (let col = 0; col < a.cols; col += 1) {
      const x = a.ownerOf(row, col)!;
      const y = b.ownerOf(row, col)!;
      if (x.row !== y.row || x.col !== y.col) return false;
    }
  }
  return true;
}

/**
 * 新的每一行（列）是原来的第几行（列）：先认原地没变的，再按内容找没用过的，
 * 行列数没变时剩下的按位置；新插进来的是 null
 */
export function mapAxis(before: string[], after: string[]): (number | null)[] {
  const result = after.map((key, index) => (before[index] === key ? index : null));
  const used = new Set(result.filter((value): value is number => value !== null));
  after.forEach((key, index) => {
    if (result[index] !== null) return;
    const found = before.findIndex((other, at) => !used.has(at) && other === key);
    if (found < 0) return;
    result[index] = found;
    used.add(found);
  });
  if (before.length === after.length) {
    after.forEach((_, index) => {
      if (result[index] !== null || used.has(index)) return;
      result[index] = index;
      used.add(index);
    });
  }
  return result;
}

/**
 * 旧的 → 新的要改哪几处 HTML 源码（位置相对表格源码开头）。
 * reorder：行（列）换了顺序（搬行、搬列、排序）—— 形状没变也整张重拼，属性跟着格子走，
 * 不然按格子换字，`<td class="a">甲</td>` 的 class 留在原地、字换成了乙
 */
export function planHtmlEdits(
  table: MarkdownTableModel,
  source: string,
  next: TableData,
  reorder = false,
): Edit[] {
  const layout = table.html;
  if (!layout) return [];
  const current = htmlTableData(table, source);
  const before = resolveGrid(current.cells);
  const after = resolveGrid(next.cells);
  if (!reorder && sameShape(before, after)) {
    const edits: Edit[] = [];
    let missing = false;
    for (const cell of after.cells) {
      const value = next.cells[cell.row]![cell.col]!;
      if (value === current.cells[cell.row]![cell.col]) continue;
      const origin = htmlCellAt(table, cell.row, cell.col);
      // 短行里补出来的格子（源码里没有）：整张重排
      if (!origin) {
        missing = true;
        break;
      }
      const [from, to] = origin.content;
      const edit = minimal(from, source.slice(from, to), htmlCellSource(value));
      if (edit) edits.push(edit);
    }
    if (!missing) return edits.sort((a, b) => a.from - b.from);
  }
  const [from, to] = layout.body;
  const edit = minimal(from, source.slice(from, to), rebuildBody(table, source, current, next));
  return edit ? [edit] : [];
}

/** 整张表的行（连同行组）重新拼一遍 */
function rebuildBody(
  table: MarkdownTableModel,
  source: string,
  current: TableData,
  next: TableData,
): string {
  const layout = table.html!;
  const before = resolveGrid(current.cells);
  const after = resolveGrid(next.cells);
  const rowKey = (row: string[]) => row.join("\u0000");
  const colKeys = (data: TableData) =>
    data.cells[0]!.map((_, col) => data.cells.map((row) => row[col] ?? "").join("\u0000"));
  const rowMap = mapAxis(current.cells.map(rowKey), next.cells.map(rowKey));
  const colMap = mapAxis(colKeys(current), colKeys(next));

  const rowText = (row: number): string => {
    const origin = rowMap[row];
    const old = origin === null || origin === undefined ? null : layout.rows[origin]!;
    const cells = after.cellsInRow(row);
    const sources = cells.map((cell) => {
      const col = colMap[cell.col];
      const from =
        old && col !== null && col !== undefined && before.isAnchor(origin!, col)
          ? htmlCellAt(table, origin!, col)
          : null;
      return { cell, from, value: next.cells[row]![cell.col]! };
    });
    // 这一行一点没变（同样的格子、同样的合并、同样的字）：照抄原文，连排版
    if (
      old &&
      sources.length === old.cells.length &&
      sources.every(
        ({ cell, from, value }, index) =>
          from === old.cells[index] &&
          cell.rowSpan === from.rowSpan &&
          cell.colSpan === from.colSpan &&
          value === current.cells[from.row]![from.col],
      )
    ) {
      return source.slice(old.range[0], old.range[1]);
    }
    const template = old ?? layout.rows[Math.min(1, layout.rows.length - 1)]!;
    const text = sources.map(({ cell, from, value }) => {
      const tag = from?.tag ?? (row === 0 ? "th" : "td");
      const spans =
        (cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : "") +
        (cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : "");
      return `<${tag}${from?.attrs ?? ""}${spans}>${htmlCellSource(value)}</${tag}>`;
    });
    const { gaps } = template;
    const between = gaps.between || gaps.open;
    return `${old?.open ?? "<tr>"}${gaps.open}${text.join(between)}${gaps.close}</tr>`;
  };

  // 每一行落在哪个行组：表头在原来那一组；末尾一串原来是 tfoot 的（夹着、跟着新插的）还是 tfoot；
  // 别的跟着原来的那一组，新插的跟着上一行。行组的顺序不能往回走（tfoot 解析时就只能在最后）
  const sectionOf = (index: number | null | undefined) =>
    index === null || index === undefined ? null : layout.rows[index]!.section;
  const foot = layout.sections.findIndex((section) => section.kind === "tfoot");
  const rows = next.cells.length;
  const assigned: number[] = Array(rows).fill(-1);
  assigned[0] = layout.rows[0]!.section;
  const head = layout.sections[assigned[0]]!.kind === "thead" ? assigned[0] : -1;
  if (foot >= 0) {
    let start = rows;
    for (let row = rows - 1; row > 0; row -= 1) {
      const section = sectionOf(rowMap[row]);
      if (section !== null && section !== foot) break;
      start = row;
    }
    // 紧挨着表身插的新行算表身
    while (start < rows && sectionOf(rowMap[start]) === null) start += 1;
    for (let row = start; row < rows; row += 1) assigned[row] = foot;
  }
  for (let row = 1; row < rows; row += 1) {
    if (assigned[row]! >= 0) continue;
    const own = sectionOf(rowMap[row]);
    const previous = assigned[row - 1]!;
    let section =
      own !== null && own !== head && own !== foot
        ? own
        : previous !== head && previous !== foot
          ? previous
          : bodySection(layout, head, foot);
    if (previous !== head && previous !== foot && section < previous) section = previous;
    assigned[row] = section;
  }

  const parts: string[] = [];
  const emitted = new Set<number>();
  let rowIndex = 0;
  while (rowIndex < rows) {
    const index = assigned[rowIndex]!;
    const group: string[] = [];
    while (rowIndex < rows && assigned[rowIndex] === index) {
      group.push(rowText(rowIndex));
      rowIndex += 1;
    }
    const section = layout.sections[index] ?? syntheticBody(layout);
    emitted.add(index);
    const between = section.gaps.between || section.gaps.open || "\n";
    const inner = group.join(between);
    parts.push(
      section.kind
        ? `${section.open ? source.slice(section.open[0], section.open[1]) : `<${section.kind}>`}${
            section.gaps.open
          }${inner}${section.gaps.close}${section.close ? source.slice(section.close[0], section.close[1]) : `</${section.kind}>`}`
        : inner,
    );
  }
  return parts.join(layout.sectionGap);
}

/** 放表身行的那一组：原来的第一个 tbody / 直接写在 table 里的；都没有就新起一个 tbody */
function bodySection(layout: HtmlTableLayout, head: number, foot: number): number {
  const found = layout.sections.findIndex(
    (section, index) => index !== head && index !== foot && section.kind !== "tfoot",
  );
  return found >= 0 ? found : layout.sections.length;
}

function syntheticBody(layout: HtmlTableLayout): HtmlSection {
  const like = layout.sections.find((section) => section.kind) ?? layout.sections[0]!;
  return { kind: "tbody", open: null, close: null, gaps: like.gaps };
}
