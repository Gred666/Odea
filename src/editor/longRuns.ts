import { MIN_RUN, NOT_CJK } from "@/lib/longRun";
import { EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

/* ============================================================
   很长、中间没有断点的西文串（网址、哈希、一直按着的 kkkk……）：允许在串里任意处断行。

   浏览器遇到这种串，会先在它前面（汉字和西文之间）折行、把整串挪到下一行，串太长再在
   里面断 —— 前一行只剩几个字，后半截空出一大块（2026-10-18 协作实测时在一句话后面一直按 k
   撞上的；那时正文两端对齐，是把这几个字撑满整行、字和字之间拉开一大截，docs/排版规范.md §2）。
   串里能断以后，行尾就地断开，前一行照常排满。普通单词到不了这个长度，照旧整词折行。
   ============================================================ */

const LONG_RUN = new RegExp(`${NOT_CJK}{${MIN_RUN},}`, "g");

const mark = Decoration.mark({ class: "cm-odea-long-run" });
const matcher = new MatchDecorator({ regexp: LONG_RUN, decoration: () => mark });

/** 只算视口里的（MatchDecorator 自己管增量） */
const longRunMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = matcher.createDeco(view);
    }

    update(update: ViewUpdate) {
      this.decorations = matcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/* ============================================================
   输入法组字时，光标那一行的西文也能在任意处断行。

   组字时的拼音（zhongwen）是一串西文，同样不能断：拼音一打到行尾放不下，整串挪到下一行；
   上屏变回汉字又排得下了，再挪回来。每打一个词来回一次（2026-10-28，那时正文还两端对齐，
   这一行剩下的字跟着被撑开、缩回，最右边那个一下挪 39px —— 用户说的「打字跨行的话左边的字
   一直在抖」；2026-10-29 改成左对齐，见 docs/排版规范.md §2）。组字期间这一行
   word-break: break-all，拼音就地折行，这一行照常排满。

   只能加在整行上：正在组字的那段字，外面包的标记 CodeMirror 不会再动（动了输入法就断了）。
   整行 break-all 会让这一行前面已经折好的地方重排：前面某个视觉行是在一个西文词、数字
   跟前折的，break-all 之后它会被拆开、挤上去一截。所以开始组字时先量一眼，光标前面有这样的
   折行就不加（这时还是老样子），没有才加。

   什么时候加：compositionstart 时只记下「这一行可以」（不动 DOM，输入法刚开始组字），
   等第一笔组字的改动进来时顺带把行装饰加上 —— 这条路上 CodeMirror 会保住组字的那个文本节点，
   只改行的 class。组字结束、上屏之后再摘掉。
   ============================================================ */

/** 光标前面的一串西文 / 数字（不含空白） */
const LATIN_RUN = new RegExp(`${NOT_CJK}+`, "g");

/** 光标所在的这一行，前面每一处折行都不在西文 / 数字跟前：整行 break-all 不会改动它们 */
function breaksStayPut(view: EditorView, head: number): boolean {
  const line = view.state.doc.lineAt(head);
  const before = line.text.slice(0, head - line.from);
  for (const match of before.matchAll(LATIN_RUN)) {
    const at = line.from + match.index;
    if (at === line.from) continue;
    const end = view.coordsAtPos(at, -1);
    const start = view.coordsAtPos(at, 1);
    // 这一串的头和前一个字不在同一条视觉行上：是在它跟前折的行
    if (end && start && start.top - end.top > 2) return false;
  }
  return true;
}

interface Composing {
  /** 组字的那一行的行首；null 是没在组字，或者这一行不能加 */
  line: number | null;
  /** 行装饰已经加上了 */
  active: boolean;
}

const armComposing = StateEffect.define<number | null>();
const activateComposing = StateEffect.define<null>();

const composingLine = Decoration.line({ class: "cm-odea-composing" });

const composingField = StateField.define<Composing>({
  create: () => ({ line: null, active: false }),
  update(value, transaction) {
    let next = value;
    if (next.line !== null && transaction.docChanged) {
      next = {
        ...next,
        line: transaction.state.doc.lineAt(transaction.changes.mapPos(next.line)).from,
      };
    }
    for (const effect of transaction.effects) {
      if (effect.is(armComposing)) next = { line: effect.value, active: false };
      else if (effect.is(activateComposing) && next.line !== null) next = { ...next, active: true };
    }
    return next;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) =>
      value.active && value.line !== null
        ? Decoration.set(composingLine.range(value.line))
        : Decoration.none,
    ),
});

const composingLines: Extension = [
  composingField,
  // 第一笔组字的改动：顺带加上行装饰
  EditorState.transactionExtender.of((transaction) => {
    const value = transaction.startState.field(composingField);
    return value.line !== null && !value.active && transaction.isUserEvent("input.type.compose")
      ? { effects: activateComposing.of(null) }
      : null;
  }),
  EditorView.domEventHandlers({
    compositionstart(_event, view) {
      const { head } = view.state.selection.main;
      const line = breaksStayPut(view, head) ? view.state.doc.lineAt(head).from : null;
      if (line !== view.state.field(composingField).line) {
        view.dispatch({ effects: armComposing.of(line) });
      }
      return false;
    },
    compositionend(_event, view) {
      // 上屏的那笔改动可能在 compositionend 之后才读进来：等它进来再摘；接着又开始组字就不摘
      setTimeout(() => {
        if (!view.composing && view.state.field(composingField, false)?.line != null) {
          view.dispatch({ effects: armComposing.of(null) });
        }
      }, 0);
      return false;
    },
  }),
];

/** 长西文串任意处断行，加上组字那一行的同一招 */
export const longRuns: Extension = [longRunMarks, composingLines];
