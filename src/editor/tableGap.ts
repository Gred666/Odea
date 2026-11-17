import { syntaxTree } from "@codemirror/language";
import {
  type ChangeSpec,
  EditorState,
  type Extension,
  type Line,
  StateEffect,
  StateField,
  type Text,
  type Transaction,
} from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

/* ============================================================
   表格下面紧贴的那一行（docs/表格.md §13）

   GFM 的表格要到空行才结束：紧贴着表格的那个空行一放进内容，这一行就成了表格的一行
   （下面紧跟着的那段字也一起被带进去），整张表当场变回源码。文件里表格和下面的字之间必须
   有一个空行（别的工具也这么认），所以在「真的放进内容」的那一刻把空行补上 —— 在这一行前面
   放一份它自己（空行里引用的 `> `、列表的缩进照抄，隔开以后还在同一个引用、列表项里）。
   光是路过（点一下、方向键经过）不改正文。

   - 不是组字的输入（打字、粘贴、拖进来、补全）：同一个事务里补（tableGapFilter），撤销一次连空行一起回去
   - 组字：组字期间不改正文 —— 改了组字那一行前面的字，CodeMirror 保不住组字的文本节点，输入法就断了
     （PITFALLS/CodeMirror.md）。先记下这一行（pendingGaps），表格的装饰不把它算进去（tableCut：
     表格照样画着、不塌成源码，这一行照普通的一行画）；组字彻底结束以后补上空行（gapSettler），
     和上屏的字记在同一步撤销里
   回车走出表格那一层在 tableClipboard.ts 的 spotBelowTable（"enter"）
   ============================================================ */

/** 只有空白和引用符号的一行（引用、列表里的空行带着 `> `、缩进） */
const BLANK_RE = /^[\s>]*$/;

/** 行首引用符号的层数 */
function quoteDepth(text: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 62 /* > */) depth++;
    else if (code !== 32 && code !== 9) break;
  }
  return depth;
}

/**
 * pos 所在的这一行是不是紧贴在一张 GFM 表格下面的空行：是就返回这一行。每次输入都会问一下：
 * 这一行有字、上一行没有 `|`（表格的行几乎都有）就当场返回，不查语法树
 */
export function stickyLineBelowTable(state: EditorState, pos: number): Line | null {
  const line = state.doc.lineAt(pos);
  if (line.number === 1 || !BLANK_RE.test(line.text)) return null;
  const above = state.doc.line(line.number - 1);
  // 表格的最后一行。表头、分隔行一定有 `|`，表身行可以不写 —— 那多半是以前打进表格的字，不管
  if (!above.text.includes("|")) return null;
  // `>` 比表格那一行多：这一行是新开的一层引用，本来就打断表格
  if (quoteDepth(line.text) > quoteDepth(above.text)) return null;
  const tree = syntaxTree(state);
  if (tree.length < above.to) return null;
  for (let node: SyntaxNode | null = tree.resolveInner(above.to, -1); node; node = node.parent) {
    if (node.name === "Table") return line;
  }
  return null;
}

/** 在这一行前面放一份它自己 */
const gapBefore = (line: { from: number; text: string }): ChangeSpec => ({
  from: line.from,
  insert: `${line.text}\n`,
});

/**
 * 算「放进内容」的输入：打字、粘贴、拖进来（含正文里拖着挪一段字）、补全、模板这些。
 * 组字另算（见文件头）；别人的改动、外部改动、撤销都不带这些 userEvent
 */
const isInput = (tr: Transaction) =>
  (tr.isUserEvent("input") && !tr.isUserEvent("input.type.compose")) || tr.isUserEvent("move.drop");

/** 插进来的东西第一行就有字（回车、自己带着换行的表格不算：这一行还是空行） */
const startsWithText = (inserted: Text) =>
  inserted.length > 0 && !BLANK_RE.test(inserted.line(1).text);

/** 第 2 层：不是组字的输入落在表格下面紧贴的空行上，同一个事务里先补一个空行 */
const tableGapFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !isInput(tr)) return tr;
  const gaps: ChangeSpec[] = [];
  let seen: number | null = null;
  tr.changes.iterChanges((fromA, _toA, _fromB, _toB, inserted) => {
    if (!startsWithText(inserted)) return;
    const line = stickyLineBelowTable(tr.startState, fromA);
    // 多光标落在同一行（这一行有几个空格）只补一次
    if (!line || line.from === seen) return;
    seen = line.from;
    gaps.push(gapBefore(line));
  });
  // 补的那份排在前面：合并时后一份映射过前一份，同一处的插入后一份落在后面 —— 打的字在空行之后
  return gaps.length ? [{ changes: gaps }, tr] : tr;
});

/** 组字落在表格下面紧贴的空行上：这一行的行首和它原来的样子（补空行时照抄） */
interface PendingGap {
  from: number;
  text: string;
}

/** 补上了（或者不用补了）：记号收掉 */
const settled = StateEffect.define<null>();

const NONE: readonly PendingGap[] = [];

/** 第 3 层：正在组字、还没和表格隔开的那几行 */
export const pendingGaps = StateField.define<readonly PendingGap[]>({
  create: () => NONE,
  update(gaps, tr) {
    if (tr.effects.some((effect) => effect.is(settled))) return NONE;
    if (!tr.docChanged) return gaps;
    let next = gaps;
    if (gaps.length) {
      const kept: PendingGap[] = [];
      for (const gap of gaps) {
        const from = tr.changes.mapPos(gap.from, -1);
        const line = tr.state.doc.lineAt(from);
        // 这一行又空了（组字取消了）、并进了上一行：不用再隔
        if (line.from === from && !BLANK_RE.test(line.text)) kept.push({ from, text: gap.text });
      }
      next = kept;
    }
    if (tr.isUserEvent("input.type.compose")) {
      tr.changes.iterChanges((fromA, _toA, _fromB, _toB, inserted) => {
        if (!inserted.length) return;
        const line = stickyLineBelowTable(tr.startState, fromA);
        if (!line) return;
        const from = tr.changes.mapPos(line.from, -1);
        if (next.some((gap) => gap.from === from)) return;
        if (BLANK_RE.test(tr.state.doc.lineAt(from).text)) return;
        next = [...next, { from, text: line.text }];
      });
    }
    return next.length || gaps.length ? next : gaps;
  },
});

/**
 * 表格 [from, to] 里有正在组字、还没和它隔开的那一行：表格只到它上一行的行尾（块级层画替身、
 * 判断光标在不在表格里，行内层画源码行的样子都按这个）。没有就是 to
 */
export function tableCut(state: EditorState, from: number, to: number): number {
  const gaps = state.field(pendingGaps, false);
  if (!gaps?.length) return to;
  let cut = to;
  for (const gap of gaps) if (gap.from > from && gap.from <= cut) cut = gap.from - 1;
  return cut;
}

/** 两个状态之间正在组字的那几行变没变（装饰层据此重建） */
export const gapsChanged = (before: EditorState, after: EditorState) =>
  before.field(pendingGaps, false) !== after.field(pendingGaps, false);

/** 组字彻底结束以后补空行 */
const gapSettler = ViewPlugin.fromClass(
  class {
    private queued = false;
    private destroyed = false;
    /** 上一次补的时候的正文：补的事务被拦下了（只读）就别一直重试 */
    private tried: Text | null = null;

    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate) {
      // compositionStarted：从 compositionstart 到 compositionend 一直是真（推迟存盘也看它，
      // debouncedSave.ts 的 hold）
      if (update.state.field(pendingGaps).length && !update.view.compositionStarted)
        this.schedule();
    }

    /** 在一次更新里不能派发：排到这之后 */
    schedule() {
      if (this.queued) return;
      this.queued = true;
      queueMicrotask(() => {
        this.queued = false;
        this.settle();
      });
    }

    private settle() {
      const { view } = this;
      if (this.destroyed || view.compositionStarted) return;
      const gaps = view.state.field(pendingGaps, false);
      if (!gaps?.length) return;
      if (view.state.readOnly || this.tried === view.state.doc) {
        view.dispatch({ effects: settled.of(null) });
        return;
      }
      this.tried = view.state.doc;
      view.dispatch({
        changes: gaps.map(gapBefore),
        effects: settled.of(null),
        // 组字的改动 history 一律并进上一步：补的空行和刚上屏的字是同一步撤销，撤销不会把字留在表格里
        userEvent: "input.type.compose",
      });
    }

    destroy() {
      this.destroyed = true;
    }
  },
  {
    eventObservers: {
      // 组字结束。CodeMirror 自己的观察者在插件的后面跑，DOM 里还有没读进来的组字改动时它排一个
      // 微任务去读；派发事务会把没读进来的 DOM 改动丢掉（吞字），所以这里再晚一拍，排在它后面
      compositionend() {
        queueMicrotask(() => this.schedule());
      },
    },
  },
);

/** 表格下面紧贴的那一行：放进内容时先和表格隔开（第 2、3 层；第 1 层在 spotBelowTable） */
export const tableGap: Extension = [pendingGaps, tableGapFilter, gapSettler];
