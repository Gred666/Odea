import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type ChangeSet, type EditorState, StateField, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, type WidgetType } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { calloutsVersion, parseCalloutHead } from "./callout";
import {
  ABBREVIATION_RE,
  CLOSING_FENCE_RE,
  type DecorationRange,
  FENCE_LINE_RE,
  FOOTNOTE_DEF_RE,
  HEADING_RE,
  HTML_TABLE_RE,
  SETEXT_UNDERLINE_RE,
  TOC_RE,
  freshness,
  markFreshness,
  selectionTouches,
  toDecorationSet,
} from "./decorationKit";
import { DiagramWidget } from "./diagram";
import { type FrontMatterRange, frontMatterRange } from "./frontMatter";
import { FoldedSectionWidget, foldsOnlyMoved, outermostSections } from "./headingFold";
import { parseHtmlTable } from "./htmlTable";
import { inlinePlainText } from "./inlineDom";
import { normalizeLabel } from "./links";
import { selectionTouchesRange, widgetByNode } from "./markdownStyleRegistry";
import { type MarkdownTableModel, parseDelimitedTable, parseMarkdownTable } from "./markdownTable";
import { MathWidget } from "./math";
import { revealRanges } from "./reveal";
import { TableWidget } from "./tableWidget";
import {
  CalloutFoldWidget,
  CodeFenceWidget,
  CommentWidget,
  FrontMatterFenceWidget,
  HorizontalRuleWidget,
  HtmlBlockWidget,
  type TocEntry,
  TocWidget,
} from "./widgets";

/* 块级装饰层（从 MarkdownEditor.tsx 挪出来，docs/1110审查与研究.md §6.2） */

/* ============================================================
   装饰分成两层，因为两层的成本量级完全不同。

   块级层（StateField）：折叠围栏行、Setext 下划线行、分隔线行、front matter
   的围栏行、[TOC] 行，以及把表格 / 图表 / 公式块 / HTML 块换成 widget ——
   这些会改变行结构，CodeMirror 要求必须来自 StateField（视口是在插件更新
   之前算出来的）。它遍历全文，但只下探可能藏着块级构造的容器，Paragraph 及
   其下所有行内节点整棵剪掉。

   行内层（ViewPlugin）：标记隐藏、加粗斜体、任务勾选框、列表符号、callout、
   脚注、双链、Emoji、行内 HTML、行内公式、缩写、智能标点等等。这些不改变
   行结构，因此只需要处理当前视口，成本与文档长度无关。

   拆分前是一个 StateField 对全文做深度遍历，每次按键、每次移动光标都要
   重来一遍，53KB 文档上单次 5.3ms；拆分后同一文档 0.57ms。
   ============================================================ */

/** 块级层的产物。 */
export interface TyporaBlockState {
  decorations: DecorationSet;
  atomic: DecorationSet;
  /** 整行被折叠掉的行首偏移；行内层据此跳过这些行。 */
  foldedLines: Set<number>;
  /**
   * 文档里定义过的引用标签（CommonMark 规范化后）。
   * 行内层据此区分 `[文字]` 到底是引用式链接还是普通的方括号文本。
   */
  referenceLabels: Set<string>;
  /** 文档开头的 YAML front matter；两层都要绕开它，不然 `title: x` 会被当成 H2。 */
  frontMatter: FrontMatterRange | null;
  /** `*[缩写]: 全称`；行内层给正文里的缩写加悬停提示。 */
  abbreviations: Map<string, string>;
  /** 缩写定义行的行首；正文里的缩写高亮要跳过它们自己。 */
  abbreviationLines: Set<number>;
  /** `[^id]: …` 的正文（纯文本，截断），给引用端的悬停预览。 */
  footnotes: Map<string, string>;
  /**
   * 构建时问过的每一句「光标碰没碰到这一段」：三个一组，起点、终点、答案（1 / 0）。
   * 块级层只通过这些问题依赖选区 —— 只动了光标时拿新选区再问一遍，答案全都一样，
   * 重建出来也是同一份，直接沿用（见 typoraBlockDecorations）。
   */
  probes: number[];
  /** 文档里有 `[TOC]`：标题的文字变了它也得跟着变（见 mapBlockState） */
  toc: boolean;
  /** 构建时插件登记的提示块是哪一版（callout.ts 的 calloutsVersion）：换了就整篇重建 */
  callouts: number;
}

/** 块级构造只可能藏在这些容器里，浅层遍历仅下探它们。 */
const blockContainers = new Set([
  "Document",
  "BulletList",
  "OrderedList",
  "ListItem",
  "Blockquote",
]);

/**
 * 块级层用的语法树：尽量是全文的。
 *
 * CodeMirror 建状态时只同步解析开头约 3000 个字符，剩下的交给空闲时的后台解析。
 * 块级层以前直接拿 syntaxTree(state)，刚打开长文档时看到的是半棵树：[TOC] 只列出
 * 开头几节的标题，后面的表格、公式、代码块都还是源码 —— 要等点一下（选区变化触发
 * 重建）才「展开」。这里先同步把全文解析完（有时间预算，超大文档解析不完就退回
 * 现有的那半棵，后台解析推进时 update 里会再重建）。已经解析完的树直接返回，不花时间。
 */
const FULL_PARSE_BUDGET_MS = 80;

function blockTree(state: EditorState): Tree {
  return ensureSyntaxTree(state, state.doc.length, FULL_PARSE_BUDGET_MS) ?? syntaxTree(state);
}

/** [TOC] 需要的标题清单。只在文档里真的有 [TOC] 时才算。 */
function collectHeadings(
  state: EditorState,
  tree: Tree,
  frontMatter: FrontMatterRange | null,
): TocEntry[] {
  const entries: TocEntry[] = [];
  tree.iterate({
    enter(node) {
      // front matter 里的 `title: x` 会被解析成 Setext 标题，不能进目录
      if (frontMatter && node.type.name !== "Document" && node.from < frontMatter.to) return false;
      const match = HEADING_RE.exec(node.type.name);
      if (!match) return blockContainers.has(node.type.name);
      const line = state.doc.lineAt(node.from);
      const text = inlinePlainText(
        line.text
          .replace(/^\s{0,3}#{1,6}\s+/, "")
          .replace(/\s+#+\s*$/, "")
          .trim(),
      );
      if (text) entries.push({ level: Number(match[1]), text, from: node.from });
      return false;
    },
  });
  return entries;
}

/** 围栏的语言名：info 串的第一个词，小写。 */
const fenceLanguage = (info: string) => info.split(/\s+/)[0]?.toLowerCase() ?? "";

/**
 * 表格源码 → 解析结果。块级层每敲一个字都整篇重建一次，没改的表格不用每次再解析
 * （解析结果只读：表格替身改结构时先复制，见 tableWidget.ts 的 columnChanges）
 */
const parsedTables = new Map<string, MarkdownTableModel | null>();

function parsedTable(key: string, parse: () => MarkdownTableModel | null) {
  if (parsedTables.has(key)) {
    const table = parsedTables.get(key) ?? null;
    // 挪到最后：Map 按插入顺序，满了从最久没用的删
    parsedTables.delete(key);
    parsedTables.set(key, table);
    return table;
  }
  const table = parse();
  parsedTables.set(key, table);
  if (parsedTables.size > 200) parsedTables.delete(parsedTables.keys().next().value!);
  return table;
}

/** 段落里有没有可能是脚注定义（`[^id]:`）或缩写定义（`*[缩写]:`）的行 */
const DEFINITION_HINT_RE = /(?:^|\n)[^\S\n]{0,3}(?:\[\^|\*\[)/;

function buildBlockDecorations(state: EditorState, changes: ChangeSet | null): TyporaBlockState {
  const ranges: DecorationRange[] = [];
  const fresh = freshness(changes);
  const foldedLines = new Set<number>();
  const referenceLabels = new Set<string>();
  const abbreviations = new Map<string, string>();
  const abbreviationLines = new Set<number>();
  const footnotes = new Map<string, string>();
  const frontMatter = frontMatterRange(state.doc);
  const tree = blockTree(state);
  // 收起的标题下面那几节（headingFold.ts）：整段一个块级替换，里面不再生成别的块级装饰 ——
  // 替换套着替换时，和外层起点相同的那个可能先被画出来，也省得给看不见的东西建替身
  const hiddenSections = outermostSections(state);
  const hidden = (position: number) =>
    hiddenSections.some((section) => position >= section.from && position <= section.to);
  let headings: TocEntry[] | null = null;
  let toc = false;
  const probes: number[] = [];
  /** selectionTouches，顺便记下问了什么、答了什么（TyporaBlockState.probes） */
  const touches = (from: number, to: number) => {
    const hit = selectionTouches(state, from, to);
    probes.push(from, to, hit ? 1 : 0);
    return hit;
  };

  const foldLine = (from: number, to: number, widget?: WidgetType) => {
    if (to <= from || hidden(from)) return;
    markFreshness(widget, from, to, fresh);
    foldedLines.add(from);
    ranges.push({ from, to, value: Decoration.replace({ block: true, widget }) });
  };
  /** 整块折叠。范围一律撑到整行：块级替换不能只盖住半行。 */
  const foldRange = (from: number, to: number, widget?: WidgetType) => {
    if (to <= from || hidden(from)) return;
    const first = state.doc.lineAt(from);
    const last = state.doc.lineAt(to);
    markFreshness(widget, first.from, last.to, fresh);
    for (let number = first.number; number <= last.number; number += 1) {
      foldedLines.add(state.doc.line(number).from);
    }
    ranges.push({
      from: first.from,
      to: last.to,
      value: Decoration.replace({ block: true, widget }),
    });
  };
  const lineClass = (from: number, className: string) => {
    if (hidden(from)) return;
    ranges.push({ from, to: from, value: Decoration.line({ class: className }) });
  };
  const lineClasses = (from: number, to: number, className: string) => {
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;
    for (let number = first; number <= last; number += 1) {
      lineClass(state.doc.line(number).from, className);
    }
  };
  /** 一个段落 / 引用定义里的脚注定义行和缩写定义行。 */
  const scanDefinitionLines = (from: number, to: number) => {
    const start = state.doc.lineAt(from);
    // 绝大多数段落里根本没有定义：整段先看一眼，没有就不逐行取出来跑正则
    if (!DEFINITION_HINT_RE.test(state.sliceDoc(start.from, to))) return;
    const first = start.number;
    const last = state.doc.lineAt(to).number;
    for (let number = first; number <= last; number += 1) {
      const line = state.doc.line(number);
      const footnote = FOOTNOTE_DEF_RE.exec(line.text);
      if (footnote) {
        const body = inlinePlainText(line.text.slice(footnote[0].length));
        footnotes.set(footnote[1]!, body.replace(/\s+/g, " ").trim().slice(0, 240));
        continue;
      }
      const abbreviation = ABBREVIATION_RE.exec(line.text);
      if (abbreviation) {
        abbreviations.set(abbreviation[1]!.trim(), abbreviation[2]!.trim());
        abbreviationLines.add(line.from);
        lineClass(line.from, "cm-odea-abbr-def");
      }
    }
  };

  if (frontMatter) {
    const open = state.doc.line(frontMatter.openLine);
    const close = state.doc.line(frontMatter.closeLine);
    // 从 from + 1 起算：新挂载的编辑器光标停在 0，那不算「点进了属性块」，
    // 否则每篇带 front matter 的笔记一打开就是一坨展开的 YAML。
    const active = touches(frontMatter.from + 1, frontMatter.to);
    for (let number = open.number + 1; number < close.number; number += 1) {
      lineClass(state.doc.line(number).from, "cm-odea-frontmatter");
    }
    if (active) {
      // 和折叠时的封口一样高（globals.css「围栏的几何」），点进来时下面的正文不跳
      lineClass(open.from, "cm-odea-frontmatter cm-odea-frontmatter-fence-line is-open");
      lineClass(close.from, "cm-odea-frontmatter cm-odea-frontmatter-fence-line is-close");
    } else {
      foldLine(open.from, open.to, new FrontMatterFenceWidget("open"));
      foldLine(close.from, close.to, new FrontMatterFenceWidget("close"));
    }
  }

  tree.iterate({
    enter(node) {
      const { name } = node.type;
      // front matter 里的 `---` 会被解析成分隔线和 Setext 标题，整段绕开。
      if (frontMatter && name !== "Document" && node.from < frontMatter.to) return false;

      if (name === "FencedCode") {
        const open = state.doc.lineAt(node.from);
        const close = state.doc.lineAt(node.to);
        const opens = FENCE_LINE_RE.test(open.text);
        const closed = close.number > open.number && CLOSING_FENCE_RE.test(close.text);
        // 只有真的有代码内容时才折叠；空围栏折叠后就再也点不进去了。
        if (!touches(node.from, node.to) && close.number - open.number >= 2) {
          const info = open.text.replace(FENCE_LINE_RE, "").trim();
          const language = fenceLanguage(info);
          const code = state.sliceDoc(open.to + 1, Math.max(open.to + 1, close.from - 1));
          // 图表和 CSV 不是「代码」：整块换成图 / 表，点一下才回到源码
          if (closed && language === "mermaid") {
            foldRange(node.from, node.to, new DiagramWidget(code));
            return false;
          }
          if (closed && (language === "csv" || language === "tsv")) {
            const table = parsedTable(`${language}\u0000${code}`, () =>
              parseDelimitedTable(code, language === "csv" ? "," : "\t"),
            );
            if (table) {
              foldRange(
                node.from,
                node.to,
                new TableWidget(table, language, code, open.to + 1 - open.from),
              );
              return false;
            }
          }
          if (opens) foldLine(open.from, open.to, new CodeFenceWidget("open", info, code));
          if (closed) foldLine(close.from, close.to, new CodeFenceWidget("close", "", code));
          return false;
        }
        // 围栏露出源码时画成和封口同样大小的框（globals.css「围栏的几何」）。
        // 以前源码行比封口矮一截：一点进代码块，上面的围栏行缩下去，整块代码
        // 连同刚点的那一行一起往上跳。
        if (opens) lineClass(open.from, "cm-odea-fence-source is-open");
        if (closed) lineClass(close.from, "cm-odea-fence-source is-close");
        return false;
      }

      if (name === "MathBlock") {
        if (touches(node.from, node.to)) {
          lineClasses(node.from, node.to, "cm-odea-math-source");
        } else {
          const tex = state
            .sliceDoc(node.from, node.to)
            .replace(/^\$\$/, "")
            .replace(/\$\$$/, "")
            .trim();
          foldRange(node.from, node.to, new MathWidget(tex, true));
        }
        return false;
      }

      if (name === "HTMLBlock") {
        if (!touches(node.from, node.to)) {
          const source = state.sliceDoc(node.from, node.to);
          // 整块就是一张简单的 <table>：和 GFM 表格一样能点进格子改，写回还是 HTML（htmlTable.ts）
          const table = HTML_TABLE_RE.test(source)
            ? parsedTable(`html\u0000${source}`, () => parseHtmlTable(source))
            : null;
          const indent = node.from - state.doc.lineAt(node.from).from;
          foldRange(
            node.from,
            node.to,
            table ? new TableWidget(table, "html", source, indent) : new HtmlBlockWidget(source),
          );
        }
        return false;
      }

      if (name === "CommentBlock") {
        if (!touches(node.from, node.to)) {
          foldRange(node.from, node.to, new CommentWidget(true));
        }
        return false;
      }

      if (name === "LinkReference") {
        const label = node.node.getChild("LinkLabel");
        if (label) referenceLabels.add(normalizeLabel(state.sliceDoc(label.from, label.to)));
        scanDefinitionLines(node.from, node.to);
        return false;
      }

      if (name === "Paragraph") {
        const line = state.doc.lineAt(node.from);
        if (line.to >= node.to && TOC_RE.test(line.text)) {
          toc = true;
          if (touches(line.from, line.to)) {
            lineClass(line.from, "cm-odea-toc-source");
          } else {
            headings ??= collectHeadings(state, tree, frontMatter);
            foldLine(line.from, line.to, new TocWidget(headings));
          }
          return false;
        }
        scanDefinitionLines(node.from, node.to);
        return false;
      }

      if (widgetByNode.get(name) === "table") {
        if (!touches(node.from, node.to)) {
          const tableSource = state.sliceDoc(node.from, node.to);
          const table = parsedTable(`md\u0000${tableSource}`, () =>
            parseMarkdownTable(tableSource),
          );
          const indent = node.from - state.doc.lineAt(node.from).from;
          if (table)
            foldRange(node.from, node.to, new TableWidget(table, "markdown", tableSource, indent));
        }
        return false;
      }

      if (widgetByNode.get(name) === "horizontal-rule") {
        const line = state.doc.lineAt(node.from);
        // 分隔线独占一行时整行替换，别让源码行留成一条空行。
        if (line.from === node.from && line.to === node.to) {
          if (!touches(node.from, node.to)) {
            foldLine(line.from, line.to, new HorizontalRuleWidget());
          } else {
            // 露出来的 `---` 和分隔线一样高，光标进出时下面的正文不跳
            lineClass(line.from, "cm-odea-hr-source");
          }
        }
        return false;
      }

      if (/^SetextHeading[12]$/.test(name)) {
        if (!touches(node.from, node.to)) {
          const underline = state.doc.lineAt(node.to);
          // 只藏掉 `===` 三个字符等于留下一条空行，得整行折叠。
          if (SETEXT_UNDERLINE_RE.test(underline.text)) foldLine(underline.from, underline.to);
        }
        return false;
      }

      if (name === "Blockquote") {
        // `> [!标签]-`：默认收起的 callout，正文整块折成一行「展开」
        const line = state.doc.lineAt(node.from);
        const head = parseCalloutHead(line.text);
        const last = state.doc.lineAt(node.to);
        if (head?.fold === "-" && last.number > line.number && !touches(node.from, node.to)) {
          const bodyFrom = state.doc.line(line.number + 1).from;
          foldRange(
            bodyFrom,
            node.to,
            new CalloutFoldWidget(last.number - line.number, head.kind, head.foldOffset),
          );
          return false;
        }
        return true;
      }

      return blockContainers.has(name);
    },
  });

  for (const section of hiddenSections) {
    const first = state.doc.lineAt(section.from).number;
    const last = state.doc.lineAt(section.to).number;
    for (let number = first; number <= last; number += 1) {
      foldedLines.add(state.doc.line(number).from);
    }
    ranges.push({ from: section.from, to: section.to, value: Decoration.replace({ block: true }) });
    ranges.push({
      from: section.headingEnd,
      to: section.headingEnd,
      value: Decoration.widget({ widget: new FoldedSectionWidget(section.lines), side: 1 }),
    });
  }

  const decorations = toDecorationSet(ranges);
  return {
    decorations,
    atomic: decorations,
    foldedLines,
    referenceLabels,
    frontMatter,
    abbreviations,
    abbreviationLines,
    footnotes,
    probes,
    toc,
    callouts: calloutsVersion(),
  };
}

/** 换成新选区，构建时问过的那些「光标碰没碰到」是不是还是同样的答案 */
function sameTouches(probes: readonly number[], state: EditorState): boolean {
  const ranges = revealRanges(state);
  for (let index = 0; index < probes.length; index += 3) {
    const hit = selectionTouchesRange(ranges, probes[index]!, probes[index + 1]!);
    if (hit !== (probes[index + 2] === 1)) return false;
  }
  return true;
}

/** 一段里有没有哪一行是 `[TOC]`（块级层把单独一行的它换成目录） */
const TOC_LINE_RE = /^\s*\[\[?toc\]?\]\s*$/im;

/**
 * 改动落在哪个普通段落里（标题也算，文档里没有 `[TOC]` 的时候）：从改动处最里层的节点往外找，
 * 找到的那一块要把 [from, to] 整个包住，外面只隔着列表、引用。引用的第一行不算（那是 callout
 * 的标签行，`-` 结尾时正文整块折叠）；代码块、表格这些块级层要管的东西里的改动也不算。
 */
function plainBlockAround(
  state: EditorState,
  tree: Tree,
  from: number,
  to: number,
  headings: boolean,
): SyntaxNode | null {
  if (tree.length < to) return null;
  for (const side of [1, -1] as const) {
    let found: SyntaxNode | null = null;
    for (let node: SyntaxNode | null = tree.resolveInner(from, side); node; node = node.parent) {
      const { name } = node.type;
      if (!found) {
        if (name === "Paragraph" || (headings && /^ATXHeading[1-6]$/.test(name))) {
          if (node.from > from || node.to < to) break;
          found = node;
        }
        continue;
      }
      if (name === "Document") return found;
      if (name === "Blockquote" && state.doc.lineAt(node.from).to < from) continue;
      if (name !== "BulletList" && name !== "OrderedList" && name !== "ListItem") break;
    }
  }
  return null;
}

/** 这一块里没有块级层要收集的东西：脚注 / 缩写定义、单独一行的 `[TOC]` */
function plainText(state: EditorState, node: SyntaxNode): boolean {
  const text = state.sliceDoc(state.doc.lineAt(node.from).from, node.to);
  return !DEFINITION_HINT_RE.test(text) && !TOC_LINE_RE.test(text);
}

/**
 * 打字时多半不用整篇重建块级层：改动全落在普通段落里，段落的头尾正好跟着平移（没有合并、
 * 拆开，也没变成标题、表格、代码块），段落里外都没有块级层管的东西 —— 这时重建出来的
 * 和旧的一模一样，只是改动后面的位置挪了，把旧的映射过去就行。70KB 的长文 4 倍降速下
 * 每敲一个字省下约 10ms 的整篇遍历。不满足就返回 null，照旧整篇重建。
 * `markdownSyntax.dom.test.ts` 拿各处随手改的结果和整篇重建的比对着。
 */
function mapBlockState(value: TyporaBlockState, transaction: Transaction): TyporaBlockState | null {
  const { changes, startState, state } = transaction;
  const before = syntaxTree(startState);
  const after = syntaxTree(state);
  const frontMatter = frontMatterRange(state.doc);
  if (
    (frontMatter === null) !== (value.frontMatter === null) ||
    (frontMatter && value.frontMatter && frontMatter.to !== value.frontMatter.to)
  ) {
    return null;
  }
  let local = true;
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (!local) return;
    if (value.frontMatter && fromA <= value.frontMatter.to) {
      local = false;
      return;
    }
    const was = plainBlockAround(startState, before, fromA, toA, !value.toc);
    const now = plainBlockAround(state, after, fromB, toB, !value.toc);
    local =
      !!was &&
      !!now &&
      was.type === now.type &&
      changes.mapPos(was.from, -1) === now.from &&
      changes.mapPos(was.to, 1) === now.to &&
      plainText(startState, was) &&
      plainText(state, now);
    // 旧的装饰碰到了改动（比如一段折叠正文的边上）：不冒这个险
    if (local) {
      value.decorations.between(fromA, toA, () => {
        local = false;
        return false;
      });
    }
  });
  if (!local) return null;

  // 问过的那些块要么整个在改动前后（怎么映射都一样），要么就是包着这一段的列表、引用 ——
  // 在它最后一段的末尾打字，它跟着变长，所以终点取插入的右边
  const probes = value.probes.slice();
  for (let index = 0; index < probes.length; index += 3) {
    probes[index] = changes.mapPos(probes[index]!, -1);
    probes[index + 1] = changes.mapPos(probes[index + 1]!, 1);
  }
  // 光标进出了哪个块（选中一大段再打字把它替换掉）：得按新选区重建
  if (!sameTouches(probes, state)) return null;
  const mapLines = (lines: Set<number>) =>
    new Set([...lines].map((position) => changes.mapPos(position, 1)));
  const decorations = value.decorations.map(changes);
  return {
    ...value,
    decorations,
    atomic: decorations,
    foldedLines: mapLines(value.foldedLines),
    abbreviationLines: mapLines(value.abbreviationLines),
    probes,
  };
}

export const typoraBlockDecorations = StateField.define<TyporaBlockState>({
  // 初次构建（刚打开这篇）没有 changes：替身全都算新出现，照常播入场动画
  create: (state) => buildBlockDecorations(state, null),
  update(value, transaction) {
    // 收起 / 展开了标题（不只是跟着改动平移）、插件登记的提示块换了（开关了插件）：整篇重建
    if (!foldsOnlyMoved(transaction) || value.callouts !== calloutsVersion()) {
      return buildBlockDecorations(transaction.state, transaction.changes);
    }
    // 折叠与否取决于光标在不在块里，所以选区变化也要重算；
    // 后台解析往前推进了（语法树换了一棵）也要重算，不然解析得晚的那一段里的
    // 表格、公式、[TOC] 的标题要等下一次点击才出来。
    // 三样都没变时旧值里的位置依然有效，直接沿用。
    if (transaction.docChanged) {
      return (
        mapBlockState(value, transaction) ??
        buildBlockDecorations(transaction.state, transaction.changes)
      );
    }
    if (syntaxTree(transaction.startState) !== syntaxTree(transaction.state)) {
      return buildBlockDecorations(transaction.state, transaction.changes);
    }
    // 只动了光标：大多数时候光标还在原来那些块的里面 / 外面（在正文里上下走、
    // 在一段里左右挪），重建出来和现在一模一样。长文里每按一下方向键以前都要把
    // 整棵树走一遍（70KB 的文档 4 倍降速下约 10ms）。
    // 看的是 revealRanges 不是选区：鼠标拖选时选区在变、它不变；点进 / 点出正文时选区没变、它变了
    if (
      revealRanges(transaction.startState) !== revealRanges(transaction.state) &&
      !sameTouches(value.probes, transaction.state)
    ) {
      return buildBlockDecorations(transaction.state, transaction.changes);
    }
    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.from(field, (value) => () => value.atomic),
  ],
});
