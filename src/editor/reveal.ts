import {
  type EditorState,
  type Extension,
  Facet,
  type SelectionRange,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";

/* ============================================================
   哪一段露出 Markdown 源码：装饰层不直接看选区，看这里给的「算数的选区」。

   两种时候选区不算数：
   - 不在编辑：焦点在文档标题、侧栏、别的输入框里，或者刚打开这篇还没点进正文。
     以前新挂上的编辑器光标停在 0，第一行是标题时没点进来 `#` 就露着；光标在标题里，
     正文里上次点过的那张图还是一行源码。查找面板也在编辑器里，焦点在它的输入框时照常算
   - 鼠标正按着：拖到图片上，图片变回一行源码、一下矮了一大截，鼠标底下换成了别的字，
     选区跟着退出去，图片又画回来 —— 鼠标不松，整页在图片和源码之间来回闪。按下到松开
     之间沿用按下之前的样子，松开再按最后的选区展开。单击也是松开时才露出 `#`，按着的
     时候字不会在鼠标底下挪开

   编辑器挂了 trackEditing 才按焦点算；只用了装饰层（单测）时照旧，选区在哪就展开哪。
   ============================================================ */

const followsFocus = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

const setEditing = StateEffect.define<boolean>();
const setPointer = StateEffect.define<boolean>();

interface RevealState {
  /** 焦点在编辑器里（正文、查找面板、表格格子） */
  editing: boolean;
  /** 鼠标在正文里按下了，还没松开 */
  pointer: boolean;
  ranges: readonly SelectionRange[];
}

const NONE: readonly SelectionRange[] = [];

const revealState = StateField.define<RevealState>({
  create(state) {
    const editing = !state.facet(followsFocus);
    return { editing, pointer: false, ranges: editing ? state.selection.ranges : NONE };
  },
  update(value, transaction) {
    let { editing, pointer } = value;
    for (const effect of transaction.effects) {
      if (effect.is(setEditing)) editing = effect.value;
      else if (effect.is(setPointer)) pointer = effect.value;
    }
    // 改了正文（拖放、按着鼠标打字）、键盘挪了光标：鼠标那一下已经结束了
    if (
      pointer &&
      (transaction.docChanged ||
        (transaction.selection && !transaction.isUserEvent("select.pointer")))
    ) {
      pointer = false;
    }
    const ranges = !editing ? NONE : pointer ? value.ranges : transaction.state.selection.ranges;
    if (editing === value.editing && pointer === value.pointer && ranges === value.ranges) {
      return value;
    }
    return { editing, pointer, ranges };
  },
});

/**
 * 装饰层判断「光标碰没碰到」时用的选区。不在编辑时是空的；鼠标按着时是按下之前的那一份。
 * 选区或者这两样状态变了，它才换一个新数组 —— 装饰层拿 `!==` 判断要不要重算。
 */
export function revealRanges(state: EditorState): readonly SelectionRange[] {
  return state.field(revealState, false)?.ranges ?? state.selection.ranges;
}

/** 装饰层自己带上：没有 trackEditing 时它就是选区本身 */
export const revealField: Extension = revealState;

/**
 * 复用缓存的状态挂到新编辑器上时带上：切走那一刻焦点可能还在正文里（Ctrl+点击双链），
 * 鼠标可能还按着，新挂上的编辑器两样都不是
 */
export function revealIdle(): StateEffect<boolean>[] {
  return [setEditing.of(false), setPointer.of(false)];
}

/**
 * 自己要把焦点放进正文时（点了替身跳回源码）带上：不等焦点事件那一轮，这一次的选区就展开。
 * 不然先按「没在编辑」画一帧 —— 光标落在收起的源码旁边，下一帧源码才露出来、光标跳过去
 */
export function revealNow(): StateEffect<boolean> {
  return setEditing.of(true);
}

class EditingTracker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pressed = false;

  constructor(readonly view: EditorView) {
    const doc = view.dom.ownerDocument;
    doc.addEventListener("focusin", this.schedule, true);
    doc.addEventListener("focusout", this.schedule, true);
    this.schedule();
  }

  /**
   * 焦点从一处挪到另一处是 focusout、focusin 两下，中间那一刻焦点在 body 上：
   * 等这一轮事件都过去再看，不然从正文点进查找框，中间会把源码收起来又展开一次。
   * 整个窗口失焦（切到别的程序）时 activeElement 还是正文，不算离开
   */
  private schedule = () => {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(this.sync, 0);
  };

  private sync = () => {
    this.timer = null;
    const { view } = this;
    const active = view.root.activeElement;
    const editing = !!active && view.dom.contains(active);
    if (editing !== view.state.field(revealState).editing) {
      view.dispatch({ effects: setEditing.of(editing) });
    }
  };

  press(event: MouseEvent) {
    if (event.button !== 0) return;
    if (!this.view.state.field(revealState).pointer) {
      this.view.dispatch({ effects: setPointer.of(true) });
    }
    if (this.pressed) return;
    this.pressed = true;
    // 挂在 window 上、冒泡阶段：CodeMirror 的 mouseup 挂在 document 上，它先放好最后的选区。
    // 拖选中的文字（原生拖放）松手时没有 mouseup，只有 dragend；鼠标在窗口外松开的话，
    // 回来时第一下 mousemove 的 buttons 是 0
    const win = this.window;
    win.addEventListener("mouseup", this.release);
    win.addEventListener("dragend", this.release);
    win.addEventListener("blur", this.release);
    win.addEventListener("mousemove", this.moved);
  }

  private moved = (event: MouseEvent) => {
    if (event.buttons === 0) this.release();
  };

  private release = () => {
    this.stopListening();
    if (this.view.state.field(revealState).pointer) {
      this.view.dispatch({ effects: setPointer.of(false) });
    }
  };

  private stopListening() {
    if (!this.pressed) return;
    this.pressed = false;
    const win = this.window;
    win.removeEventListener("mouseup", this.release);
    win.removeEventListener("dragend", this.release);
    win.removeEventListener("blur", this.release);
    win.removeEventListener("mousemove", this.moved);
  }

  private get window(): Window {
    return this.view.dom.ownerDocument.defaultView ?? window;
  }

  destroy() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.stopListening();
    const doc = this.view.dom.ownerDocument;
    doc.removeEventListener("focusin", this.schedule, true);
    doc.removeEventListener("focusout", this.schedule, true);
  }
}

/** 按焦点和鼠标算「算数的选区」（见文件开头） */
export const trackEditing: Extension = [
  followsFocus.of(true),
  ViewPlugin.fromClass(EditingTracker, {
    eventHandlers: {
      mousedown(event) {
        this.press(event);
        return false;
      },
    },
  }),
];
