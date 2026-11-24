import {
  Annotation,
  type ChangeSet,
  type EditorState,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/* ============================================================
   同一篇同时开在好几处（docs/标签页与分屏.md §14、docs/白板.md §13.6）：分屏时同一篇可以开在两个窗格里，
   各是一个编辑器（各自的光标、滚动、撤销历史）；白板视图手里也是一份这一篇的 EditorState。
   这几处各叫一个 twin，认的只是「有 state、能 dispatch」：编辑器（EditorView）本来就是，白板的模型包一层也是。

   - 在一处改的字原样转给别的几处（CodeMirror 的 split 例子那样转事务），那边当成「别人改的」：
     不进它的撤销历史、不由它存盘（改的那一处存），也不算它和磁盘对上了 —— 对上没对上还是看存盘回来的
     那一版，不然存盘回来一版旧的会把转过来的新字盖掉
   - 后挂上的那一处用先挂着的那一处现在的正文建，不用 store 里的（那一版可能还差着没存的几个字）。
     编辑器能沿用另一个编辑器的状态（解析好的语法树、装饰）；白板的状态里没有编辑器那些扩展，不能沿用
   - 自己存盘的回音：交出去的每一版记下来，等 store 换成它（存盘回来了）。store 换成其中一版是自己的回音，
     正文不动。光比「现在的正文和上次对上的那一版一不一样」分不出来：存盘还在路上时把刚打的字删了（或者撤销了），
     正文正好又等于上次对上的那一版，回音一到就被当成别处来的新正文整篇换上 —— 删掉的字回来了，光标跳走
     （审查 2026-11-13 §4.32）。一处一份：一处交出去的也记进别的几处的（回音几处都会收到），后挂上的抄一份先挂着的。
     拆了就跟着没了：重新挂上的是照 store 那一版建的，那时再到的回音就该换上
   - 协作中的不转：协作的绑定一个编辑器一份，正文以会话为准（窗格那边也只让一个窗格编辑它）

   2026-11-19 从 MarkdownEditor.tsx 里拿出来（白板第 3 步），行为一点没改
   ============================================================ */

export interface LiveTwin {
  readonly state: EditorState;
  dispatch(spec: TransactionSpec): void;
  /** 是一个编辑器：后挂上的编辑器能沿用它的状态。白板的模型是 null */
  readonly view: EditorView | null;
}

/** 别处转过来的改动：不进撤销历史、不存盘、只读的也放进来 */
export const mirrorSync = Annotation.define<boolean>();

const twins = new Map<string, Set<LiveTwin>>();
const unconfirmed = new WeakMap<LiveTwin, string[]>();
const UNCONFIRMED_LIMIT = 16;

/**
 * 编辑器的那一份。在这里建、不在编辑器的 effect 里建：那个作用域里的闭包会跟着缓存的状态一直留着，
 * 闭包住 view 的话旧编辑器连同整棵 DOM 就都放不掉（MarkdownEditor 里 `live` 的注释）
 */
export function editorTwin(view: EditorView): LiveTwin {
  return {
    get state() {
      return view.state;
    },
    dispatch: (spec) => view.dispatch(spec),
    view,
  };
}

/** 挂上；返回拆掉。先挂着的那一处交出去还没回来的，这一处也会收到回音，抄一份 */
export function joinTwins(key: string, twin: LiveTwin): () => void {
  const set = twins.get(key) ?? new Set<LiveTwin>();
  const first = set.values().next().value;
  const sent = first && unconfirmed.get(first);
  if (sent?.length) unconfirmed.set(twin, [...sent]);
  set.add(twin);
  twins.set(key, set);
  return () => {
    set.delete(twin);
    if (!set.size && twins.get(key) === set) twins.delete(key);
  };
}

/** 这一篇开着的几处（先挂上的在前），不算 self */
export function twinsOf(key: string, self?: LiveTwin): LiveTwin[] {
  return [...(twins.get(key) ?? [])].filter((twin) => twin !== self);
}

/** 一处改了正文：原样转给别的几处 */
export function forwardChanges(key: string, from: LiveTwin, changes: ChangeSet): void {
  for (const twin of twinsOf(key, from)) {
    twin.dispatch({
      changes,
      annotations: [mirrorSync.of(true), Transaction.addToHistory.of(false)],
    });
  }
}

/** 交给 store 存了一版：记进这一篇开着的每一处（没有 key 的只记自己） */
export function noteSent(key: string | null, self: LiveTwin, markdown: string): void {
  const all = key ? (twins.get(key) ?? [self]) : [self];
  for (const twin of all) {
    let list = unconfirmed.get(twin);
    if (!list) {
      list = [];
      unconfirmed.set(twin, list);
    }
    list.push(markdown);
    if (list.length > UNCONFIRMED_LIMIT) list.shift();
  }
}

/** markdown 是不是这一处交出去还没回来的某一版；是的话它和它之前的都算回来了（同一篇的保存排着队，回音按先后到） */
export function confirmSent(twin: LiveTwin, markdown: string): boolean {
  const list = unconfirmed.get(twin);
  const at = list ? list.indexOf(markdown) : -1;
  if (!list || at < 0) return false;
  list.splice(0, at + 1);
  return true;
}
