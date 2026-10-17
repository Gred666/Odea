import { snapToDevicePixels } from "@/lib/devicePixels";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  type Extension,
  type SelectionRange,
  StateEffect,
  StateField,
  type Text,
  type Transaction,
} from "@codemirror/state";
import { type EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { frontMatterRange } from "./frontMatter";

/* ============================================================
   标题收起（技术方案 §11.4.5）。

   只收顶层标题（语法树里 Document 的直接子节点）。一节是标题后面的兄弟块，到下一个
   同级或更高级的标题为止；藏起来的是标题下一行的行首到这一节最后一个块所在行的行尾 ——
   标题和第一个块之间的空行一起藏，最后一个块和下一个标题之间的空行留着。

   这里只管「哪些标题收起了、每一节藏哪几行」，画出来交给块级层（MarkdownEditor 的
   buildBlockDecorations）：整段一个块级替换，标题行尾一个「… N 行」。箭头和层级提示
   在行内层（HeadingGutterWidget）。

   收起状态不进撤销历史、不写进文件；每篇收起了哪些记在本机（lib/viewMemory.ts）。
   ============================================================ */

/** 收起的一节（位置都是当前文档里的） */
export interface FoldedSection {
  /** 标题行首 */
  head: number;
  /** 标题第一行的行尾：光标跨过收起的一节时落在这里，「… N 行」也放在这里 */
  headingEnd: number;
  /** 藏起来的第一行行首 */
  from: number;
  /** 藏起来的最后一行行尾 */
  to: number;
  /** 藏了几行 */
  lines: number;
}

export interface HeadingFoldState {
  /** 收起的标题的行首，升序 */
  heads: readonly number[];
  /** 按语法树算出来的每一节，升序；语法树还没解析到的标题暂时没有 */
  sections: readonly FoldedSection[];
}

/** 每篇收起了哪些，存在本机：第几行（一基）、这一行的原文 */
export interface FoldMark {
  line: number;
  text: string;
}

const EMPTY: HeadingFoldState = { heads: [], sections: [] };

const HEADING_RE = /^(?:ATX|Setext)Heading([1-6])$/;
/** 看着像标题的一行：ATX 的 `#`，或者下一行是 Setext 的下划线 */
const ATX_LINE_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const SETEXT_UNDERLINE_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;

const levelOf = (name: string) => {
  const match = HEADING_RE.exec(name);
  return match ? Number(match[1]) : 0;
};

/** 和块级层（MarkdownEditor 的 blockTree）一样：尽量拿全文的语法树，80ms 解析不完就用现有的 */
function fullTree(state: EditorState): Tree {
  return ensureSyntaxTree(state, state.doc.length, 80) ?? syntaxTree(state);
}

/** 块的终点正好落在下一行行首时（个别块把换行也算进去），往回退到上一行 */
function blockEnd(doc: Text, from: number, to: number) {
  return to > from && doc.lineAt(to).from === to ? to - 1 : to;
}

/**
 * 一遍走完顶层的块，算出每个能收的标题那一节：`want` 给了就只要这些标题的。
 * 顶层一般几百到一两千个块，每个块只和还没结束的那几级标题比一下，打字时也花不了多少。
 */
function sectionsOf(
  state: EditorState,
  tree: Tree,
  want: ReadonlySet<number> | null,
): FoldedSection[] {
  const { doc } = state;
  const front = frontMatterRange(doc);
  const out: FoldedSection[] = [];
  /** 还没结束的标题：级别、标题节点的头尾、目前为止最后一个块的终点 */
  const open: Array<{ level: number; from: number; to: number; last: number }> = [];
  const close = (entry: (typeof open)[number]) => {
    if (entry.last < 0) return;
    const head = doc.lineAt(entry.from);
    if (want && !want.has(head.from)) return;
    const headingLast = doc.lineAt(blockEnd(doc, entry.from, entry.to));
    if (headingLast.number >= doc.lines) return;
    const from = doc.line(headingLast.number + 1).from;
    const end = doc.lineAt(entry.last);
    if (end.to < from) return;
    out.push({
      head: head.from,
      headingEnd: head.to,
      from,
      to: end.to,
      lines: end.number - headingLast.number,
    });
  };

  const cursor = tree.topNode.cursor();
  if (cursor.firstChild()) {
    do {
      // front matter 里的 `---` / `title: x` 会被解析成分隔线和 Setext 标题，整段绕开
      if (front && cursor.from < front.to) continue;
      const level = levelOf(cursor.name);
      if (level) {
        while (open.length && open.at(-1)!.level >= level) close(open.pop()!);
      }
      const end = blockEnd(doc, cursor.from, cursor.to);
      for (const entry of open) entry.last = end;
      if (level) open.push({ level, from: cursor.from, to: cursor.to, last: -1 });
    } while (cursor.nextSibling());
  }
  while (open.length) close(open.pop()!);
  return out.sort((a, b) => a.head - b.head);
}

/** 文档里所有能收的顶层标题那一节 */
export function foldableSections(state: EditorState): FoldedSection[] {
  return sectionsOf(state, fullTree(state), null);
}

/**
 * 行内层问的：这个标题能不能收（顶层、后面至少有一个块不是同级或更高级的标题）。
 * 只看紧挨着的下一个兄弟，不用算整节
 */
export function isFoldableHeading(node: SyntaxNode): boolean {
  if (node.parent?.name !== "Document") return false;
  const level = levelOf(node.name);
  const next = node.nextSibling;
  if (!level || !next) return false;
  const nextLevel = levelOf(next.name);
  return !nextLevel || nextLevel > level;
}

/** 这一行看着还像不像标题（改动之后先用这个粗筛，不等语法树） */
function looksLikeHeading(doc: Text, position: number): boolean {
  const line = doc.lineAt(position);
  if (line.from !== position) return false;
  if (ATX_LINE_RE.test(line.text)) return true;
  return (
    !!line.text.trim() &&
    line.number < doc.lines &&
    SETEXT_UNDERLINE_RE.test(doc.line(line.number + 1).text)
  );
}

/** 收起 / 展开某个标题（标题行首）、整个换掉（收起所有、展开所有、打开时恢复） */
export const foldHeading = StateEffect.define<number>({
  map: (value, mapping) => mapping.mapPos(value, -1),
});
export const unfoldHeading = StateEffect.define<number>({
  map: (value, mapping) => mapping.mapPos(value, -1),
});
export const setFoldedHeadings = StateEffect.define<readonly number[]>({
  map: (value, mapping) => value.map((head) => mapping.mapPos(head, -1)),
});

/**
 * 删除 / 替换碰到了收起的内容：跨进了藏着的那几行，或者删掉了它前后的换行（藏着的第一行
 * 会并到标题上、下一行会并进藏着的最后一行）—— 被并的是空行的不算，藏着的字一个没变。
 * 往藏着的范围里插东西（只有程序会这么做）也算。位置都是改动前的
 */
function touches(doc: Text, section: FoldedSection, fromA: number, toA: number, inserted: number) {
  const { from, to } = section;
  if (toA > fromA) {
    if (fromA < to && toA > from) return true;
    if (fromA < from && toA >= from) {
      const blank = !doc.lineAt(from).text.trim();
      if (!(blank && toA <= from)) return true;
    }
    if (fromA <= to && toA > to) {
      const next = to + 1 <= doc.length ? doc.lineAt(to + 1) : null;
      const blank = !!next && !next.text.trim();
      if (!(blank && fromA >= to && toA <= to + 1)) return true;
    }
    return false;
  }
  return inserted > 0 && fromA >= from && fromA <= to;
}

/** 这个选区是不是停在了收起的范围里：空选区含两头，非空选区要严格在里面（全选的终点是文末） */
function inside(range: SelectionRange, section: FoldedSection) {
  return range.empty
    ? range.head >= section.from && range.head <= section.to
    : range.head > section.from && range.head < section.to;
}

/**
 * 整篇被换掉时（外部改动回填）按「第几行 + 这一行的字」重新认：那一行的字没变就是它，
 * 变了找字一样的行里离得最近的
 */
function relocate(doc: Text, mark: FoldMark): number | null {
  if (!mark.text.trim()) return null;
  if (mark.line >= 1 && mark.line <= doc.lines && doc.line(mark.line).text === mark.text) {
    return doc.line(mark.line).from;
  }
  let best: number | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (let number = 1; number <= doc.lines; number += 1) {
    const line = doc.line(number);
    if (line.text !== mark.text) continue;
    const away = Math.abs(number - mark.line);
    if (away < distance) {
      best = line.from;
      distance = away;
    }
  }
  return best;
}

const markOf = (doc: Text, head: number): FoldMark => {
  const line = doc.lineAt(head);
  return { line: line.number, text: line.text };
};

/** 一次改动之后，标题行首跟到哪：先按 assoc -1（行首加了 `#`），不是标题行再试 assoc 1（行首回车） */
function follow(transaction: Transaction, head: number): number | null {
  const { changes, state } = transaction;
  const left = changes.mapPos(head, -1);
  if (looksLikeHeading(state.doc, left)) return left;
  const right = changes.mapPos(head, 1);
  if (right !== left && looksLikeHeading(state.doc, right)) return right;
  return null;
}

const wholeDocument = (transaction: Transaction) => {
  let whole = false;
  transaction.changes.iterChangedRanges((fromA, toA) => {
    if (fromA === 0 && toA === transaction.startState.doc.length && toA > 0) whole = true;
  });
  return whole;
};

const sortedUnique = (values: Iterable<number>) => [...new Set(values)].sort((a, b) => a - b);

function resolve(state: EditorState, heads: readonly number[]): HeadingFoldState {
  if (!heads.length) return EMPTY;
  const tree = fullTree(state);
  const sections = sectionsOf(state, tree, new Set(heads));
  const found = new Set(sections.map((section) => section.head));
  // 语法树已经解析到了、却不是能收的顶层标题（缩进进了列表、下面没东西了）：不再算收起。
  // 还没解析到的先留着，解析到了再说
  const kept = heads.filter((head) => found.has(head) || head >= tree.length);
  return { heads: kept, sections };
}

function withoutSelection(value: HeadingFoldState, state: EditorState): HeadingFoldState {
  const ranges = state.selection.ranges;
  const opened = value.sections.filter((section) => ranges.some((range) => inside(range, section)));
  if (!opened.length) return value;
  const gone = new Set(opened.map((section) => section.head));
  return {
    heads: value.heads.filter((head) => !gone.has(head)),
    sections: value.sections.filter((section) => !gone.has(section.head)),
  };
}

export const headingFolds = StateField.define<HeadingFoldState>({
  create: () => EMPTY,
  update(value, transaction) {
    const effects = transaction.effects.filter(
      (effect) =>
        effect.is(foldHeading) || effect.is(unfoldHeading) || effect.is(setFoldedHeadings),
    );
    if (!value.heads.length && !effects.length) return value;

    let heads = value.heads;
    let changed = effects.length > 0;
    if (transaction.docChanged) {
      changed = true;
      const before = transaction.startState.doc;
      if (wholeDocument(transaction)) {
        heads = heads
          .map((head) => relocate(transaction.state.doc, markOf(before, head)))
          .filter((head): head is number => head !== null);
      } else {
        const touched = new Set<number>();
        transaction.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
          for (const section of value.sections) {
            if (touches(before, section, fromA, toA, text.length)) touched.add(section.head);
          }
        });
        heads = heads
          .filter((head) => !touched.has(head))
          .map((head) => follow(transaction, head))
          .filter((head): head is number => head !== null);
      }
    }
    for (const effect of effects) {
      if (effect.is(setFoldedHeadings)) heads = effect.value;
      if (effect.is(foldHeading)) heads = [...heads, effect.value];
      if (effect.is(unfoldHeading)) {
        const unfolded = effect.value;
        heads = heads.filter((head) => head !== unfolded);
      }
    }

    // 后台解析往前推进了（语法树换了一棵）：还没算出来的那几节可能有了
    const reparsed = syntaxTree(transaction.startState) !== syntaxTree(transaction.state);
    let next = value;
    if (changed || reparsed) {
      next = resolve(transaction.state, sortedUnique(heads));
    }
    if (changed || transaction.selection) next = withoutSelection(next, transaction.state);
    if (
      next !== value &&
      next.heads.length === value.heads.length &&
      next.heads.every((head, index) => head === value.heads[index]) &&
      next.sections.length === value.sections.length &&
      next.sections.every((section, index) => sameSection(section, value.sections[index]!))
    ) {
      return value;
    }
    return next;
  },
});

const sameSection = (a: FoldedSection, b: FoldedSection) =>
  a.head === b.head &&
  a.headingEnd === b.headingEnd &&
  a.from === b.from &&
  a.to === b.to &&
  a.lines === b.lines;

/** 一次改动前后，收起的那几节是不是只跟着平移了（块级层据此决定要不要整篇重建） */
export function foldsOnlyMoved(transaction: Transaction): boolean {
  const before = transaction.startState.field(headingFolds, false) ?? EMPTY;
  const after = transaction.state.field(headingFolds, false) ?? EMPTY;
  if (before === after) return true;
  if (before.sections.length !== after.sections.length) return false;
  const { changes } = transaction;
  return before.sections.every((section, index) =>
    sameSection(
      {
        head: changes.mapPos(section.head, -1),
        headingEnd: changes.mapPos(section.headingEnd, 1),
        from: changes.mapPos(section.from, 1),
        to: changes.mapPos(section.to, 1),
        lines: section.lines,
      },
      after.sections[index]!,
    ),
  );
}

/** 只要最外层的：套在别的收起范围里的那几节看不见，不用画 */
export function outermostSections(state: EditorState): FoldedSection[] {
  const { sections } = state.field(headingFolds, false) ?? EMPTY;
  const out: FoldedSection[] = [];
  for (const section of sections) {
    const last = out.at(-1);
    if (last && section.head <= last.to) continue;
    out.push(section);
  }
  return out;
}

export function foldedHeads(state: EditorState): readonly number[] {
  return (state.field(headingFolds, false) ?? EMPTY).heads;
}

/** 记进本机的样子 */
export function foldMarks(state: EditorState): FoldMark[] {
  return foldedHeads(state).map((head) => markOf(state.doc, head));
}

/** 打开一篇时，把记下的认回来 */
export function restoreFolds(state: EditorState, marks: readonly FoldMark[] | undefined) {
  if (!marks?.length) return [];
  const heads: number[] = [];
  for (const mark of marks) {
    if (typeof mark?.line !== "number" || typeof mark.text !== "string") continue;
    const head = relocate(state.doc, mark);
    if (head !== null) heads.push(head);
  }
  return heads.length ? [setFoldedHeadings.of(sortedUnique(heads))] : [];
}

/* ---------------- 光标跨过收起的一节 ---------------- */

/**
 * 块级层的替换都是 atomic，方向键、拖选不会停在收起的范围里面；但范围的两头（藏起来的
 * 第一行行首、最后一行行尾）是两个看不见的落点。用户移动选区停在这两处时挪开：往后走的
 * 挪到这一节后面那一行的行首（这一节在文末就回到标题行尾），往前走的挪到标题行尾。
 * 查找（select.search）不管：匹配就在里面，交给 headingFolds 展开
 */
const skipFolded = EditorState.transactionFilter.of((transaction) => {
  if (
    !transaction.selection ||
    transaction.docChanged ||
    !transaction.isUserEvent("select") ||
    transaction.isUserEvent("select.search")
  ) {
    return transaction;
  }
  const sections = outermostSections(transaction.startState);
  if (!sections.length) return transaction;
  const { doc } = transaction.startState;
  const before = transaction.startState.selection;
  const selection = transaction.selection;
  let moved = false;
  const ranges = selection.ranges.map((range, index) => {
    const section = sections.find((item) => range.head === item.from || range.head === item.to);
    if (!section) return range;
    const previous = (
      before.ranges.length === selection.ranges.length ? before.ranges[index]! : before.main
    ).head;
    const forward = range.head > previous;
    let head = section.headingEnd;
    if (forward) {
      if (section.to < doc.length) head = section.to + 1;
      // 选到文末：非空选区就停在文末（盖住藏着的内容，像全选），光标回到标题行尾
      else if (!range.empty) return range;
    }
    moved = true;
    return range.empty ? EditorSelection.cursor(head) : EditorSelection.range(range.anchor, head);
  });
  if (!moved) return transaction;
  return [
    transaction,
    { selection: EditorSelection.create(ranges, selection.mainIndex), sequential: true },
  ];
});

/* ---------------- 命令 ---------------- */

/** 收起：光标在这一节里的挪到标题行尾，不然一收起就因为「光标在里面」又展开了 */
function foldTransaction(view: EditorView, sections: readonly FoldedSection[], heads: number[]) {
  const { state } = view;
  const already = foldedHeads(state);
  const next = sortedUnique([...already, ...heads]);
  const main = state.selection.main;
  // 包着光标的那几节里最外面的那个：光标落到它的标题行尾
  const holding = sections
    .filter((section) => next.includes(section.head))
    .filter((section) => main.head >= section.from && main.head <= section.to)
    .sort((a, b) => a.head - b.head)[0];
  view.dispatch({
    effects: setFoldedHeadings.of(next),
    selection: holding ? EditorSelection.cursor(holding.headingEnd) : undefined,
  });
}

/** 点箭头：收起 / 展开这个标题（标题行首） */
export function toggleHeadingFold(view: EditorView, head: number): boolean {
  if (foldedHeads(view.state).includes(head)) {
    view.dispatch({ effects: unfoldHeading.of(head) });
    return true;
  }
  const sections = foldableSections(view.state);
  if (!sections.some((section) => section.head === head)) return false;
  foldTransaction(view, sections, [head]);
  return true;
}

/** Ctrl+Alt+[：光标在标题行上就收这个标题，否则收包着光标的最里面那个顶层标题 */
export function foldSectionAtCursor(view: EditorView): boolean {
  const { state } = view;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const sections = foldableSections(state);
  const folded = foldedHeads(state);
  const target =
    sections.find((section) => section.head === line.from) ??
    sections
      .filter((section) => head >= section.from && head <= section.to)
      .sort((a, b) => b.head - a.head)[0];
  if (!target || folded.includes(target.head)) return !!target;
  foldTransaction(view, sections, [target.head]);
  return true;
}

/** Ctrl+Alt+]：展开光标所在的标题 */
export function unfoldSectionAtCursor(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  if (!foldedHeads(view.state).includes(line.from)) return false;
  view.dispatch({ effects: unfoldHeading.of(line.from) });
  return true;
}

export function foldAllHeadings(view: EditorView): boolean {
  const sections = foldableSections(view.state);
  if (!sections.length) return false;
  foldTransaction(
    view,
    sections,
    sections.map((section) => section.head),
  );
  return true;
}

export function unfoldAllHeadings(view: EditorView): boolean {
  if (!foldedHeads(view.state).length) return false;
  view.dispatch({ effects: setFoldedHeadings.of([]) });
  return true;
}

/* ---------------- 替身 ---------------- */

const CHEVRON_RIGHT =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
const CHEVRON_DOWN =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

/**
 * 标题行首、画在行左边留白里的那一块：层级提示（H2），能收的顶层标题再带一个箭头。
 * 平时透明，悬停这一行时淡入；收起的标题箭头常亮。只淡 opacity（CLAUDE.md「动效：先对齐
 * 再动」），对齐物理像素见 snapOnHover。H2 用 ::before 画（attr），不进这一行的 textContent
 */
export class HeadingGutterWidget extends WidgetType {
  constructor(
    private readonly level: number,
    private readonly foldable: boolean,
    private readonly folded: boolean,
  ) {
    super();
  }

  eq(other: HeadingGutterWidget) {
    return (
      other.level === this.level && other.foldable === this.foldable && other.folded === this.folded
    );
  }

  toDOM(view: EditorView) {
    const gutter = document.createElement("span");
    gutter.className = `cm-odea-heading-gutter${this.folded ? " is-folded" : ""}`;
    const level = document.createElement("span");
    level.className = "cm-odea-heading-level";
    level.dataset.level = `H${this.level}`;
    gutter.append(level);
    if (this.foldable) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cm-odea-heading-fold";
      button.tabIndex = -1;
      const label = this.folded ? "展开这一节" : "收起这一节";
      button.title = label;
      button.setAttribute("aria-label", label);
      button.innerHTML = this.folded ? CHEVRON_RIGHT : CHEVRON_DOWN;
      button.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        // 不抢焦点、不挪光标
        event.preventDefault();
        toggleHeadingFold(view, view.state.doc.lineAt(view.posAtDOM(gutter)).from);
      });
      gutter.append(button);
    }
    return gutter;
  }
}

/** 收起的标题行尾：「… N 行」，点一下展开 */
export class FoldedSectionWidget extends WidgetType {
  constructor(private readonly lines: number) {
    super();
  }

  eq(other: FoldedSectionWidget) {
    return other.lines === this.lines;
  }

  toDOM(view: EditorView) {
    const pill = document.createElement("span");
    pill.className = "cm-odea-heading-folded";
    pill.textContent = `… ${this.lines} 行`;
    pill.title = "展开这一节";
    pill.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const head = view.state.doc.lineAt(view.posAtDOM(pill)).from;
      view.dispatch({ effects: unfoldHeading.of(head) });
    });
    return pill;
  }
}

/**
 * 指针换了一行：离开的和进来的那一行，层级提示和箭头开始淡之前先对齐到整物理像素
 * （lib/devicePixels.ts）。它们一直在自己的图层上（will-change），落在半个像素上的话层里
 * 画出来是糊的，淡完退回原处还会闪一下
 */
const snapOnHover = ViewPlugin.fromClass(
  class {
    line: HTMLElement | null = null;

    hover(target: EventTarget | null) {
      const line =
        target instanceof Element ? (target.closest(".cm-line") as HTMLElement | null) : null;
      if (line === this.line) return;
      snap(this.line);
      snap(line);
      this.line = line;
    }
  },
  {
    eventHandlers: {
      mouseover(event) {
        this.hover(event.target);
      },
      mouseout(event) {
        this.hover(event.relatedTarget);
      },
    },
  },
);

function snap(line: HTMLElement | null) {
  const gutter = line?.querySelector<HTMLElement>(".cm-odea-heading-gutter");
  if (!gutter) return;
  for (const part of gutter.children) snapToDevicePixels(part as HTMLElement);
}

/** 装饰层带上的那一份：状态、光标规则、悬停对齐 */
export const headingFoldExtension: Extension = [headingFolds, skipFolded, snapOnHover];
