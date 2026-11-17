import { commonEnds } from "@/lib/lineDiff";
import {
  Annotation,
  ChangeSet,
  type ChangeSpec,
  type Extension,
  Transaction,
} from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { LoroEventBatch } from "loro-crdt";
import { type RemoteCaret, remoteCarets, remoteCursorLayers, setRemoteCarets } from "./cursors";
import { fineEdits } from "./external";
import { BINDING_ORIGIN, CURSOR_TIMEOUT_MS, type CollabSession } from "./session";

/* ============================================================
   CodeMirror ⇄ Loro 的正文（docs/协同编辑.md §4.3、§20）。

   没用现成的绑定（y-codemirror.next、loro-codemirror）：它们不管输入法组字，也要换掉 CodeMirror
   自己的撤销。

   出站：本地改动 → 正文
   - 每个本地事务逐段写进正文、commit 一次（origin 是 binding），出一个更新包，交给会话发出去
   - 组字期间照常写（正文和 CodeMirror 文档必须时刻一致），会话先攒着不发

   入站：正文的变化（import 进来的远端改动、外部程序合进来的）→ 一次 CodeMirror 事务
   - 带 collabSync（认出这不是用户输入）、Transaction.remote、addToHistory: false；
     不带 userEvent：模板、`[[` 补全这些只认用户输入的逻辑不会被别人的字触发
   - 组字期间（§20.10）：远端改动到了，先让 CodeMirror 把 DOM 里还没读进来的组字改动读完
     （readPendingInput），再 import。不碰组字那一行的当场派发 —— CodeMirror 在改动不碰组字时
     保得住它；碰到的先攒成 deferred，之后本地的组字改动映射过它再写进正文，组字结束一起派发。
     读不了（有挂起的按键）就照旧排队，连文档都不碰
   - 组字结束的判断：组字结束后第一次改动之后，或者 compositionend 之后 50ms 都没有新改动。
     不能一听到 compositionend 就算完：最后那次组字改动常常在它之后才读进来（CodeMirror 在微任务里
     补读），而派发事务时 EditorView.update 会先清掉还没读进来的 DOM 改动 —— 那就是吞字

   撤销：留着 CodeMirror 自己的 history()。远端事务标了 addToHistory: false，history 把已有的
   撤销记录映射过去，Ctrl+Z 只撤自己的。撤销出来的是一次普通的本地改动，照常发出去

   挂上来时编辑器和会话不一样（§27）：编辑器早就开着、会话是照本机某一版（session 的 origin）建的，
   中间打的字映射过会话那边的改动写进正文，编辑器收另一半（align）；没有 origin 的以会话为准
   ============================================================ */

/** CodeMirror 内部的 DOM 观察者（view.observer，没有公开类型）里用到的几样 */
interface DomObserver {
  flush(): boolean;
  /** 有挂起的按键（≥ 0）时 flush 什么都不读 */
  delayedFlush?: number;
  delayedAndroidKey?: unknown;
}

/** 远端（以及外部程序合进会话）的改动：不是用户输入，不往回写正文 */
export const collabSync = Annotation.define<boolean>();

/** 这个事务是不是别人的改动（平滑光标直接落位、收起的标题不替你展开…） */
export function isCollabSync(transaction: Transaction): boolean {
  return transaction.annotation(collabSync) === true;
}

/** 组字结束后最多等多久，等 CodeMirror 把最后一次组字改动读进来 */
const COMPOSITION_SETTLE_MS = 50;
/** 名字标签在对方动了以后亮多久 */
export const LABEL_MS = 2500;
/** 超时的光标淡出要多久，过了才真正拿掉 */
const LEAVE_MS = 400;

class CollabBinding {
  private readonly detach: () => void;
  private readonly stopCursors: () => void;
  private readonly stopApplied: () => void;
  private readonly stopText: () => void;
  /** compositionend 之后、最后一次组字改动读进来之前 */
  private ending = false;
  /**
   * 组字期间 import 进来、碰到了组字那一行、还没派发给编辑器的远端改动（相对编辑器现在的文档）。
   * 这期间正文 = 编辑器的文档 ∘ deferred：本地的组字改动先映射过它再写进正文（OT 的那一步），
   * 后来的远端改动接在它后面，组字结束一起派发（docs/协同编辑.md §20.10）
   */
  private deferred: ChangeSet | null = null;
  private endTimer: unknown = null;
  private caretTimer: unknown = null;
  private caretsScheduled = false;
  private destroyed = false;
  /** 等这次组字结束（攒着的派发进编辑器以后）要做的：换下这个绑定（whenCollabComposed） */
  private afterComposing: (() => void)[] = [];

  constructor(
    private readonly view: EditorView,
    private readonly session: CollabSession,
  ) {
    bindings.set(view, this);
    this.stopText = session.text.subscribe(this.onText);
    this.detach = session.attach({
      composing: () => this.composing,
      readPendingInput: () => this.readPendingInput(),
    });
    this.stopCursors = session.onCursors(() => this.scheduleCarets());
    // 远端的字到了：之前认不出位置的光标（指着的字还在路上）可能认得出了
    this.stopApplied = session.onApplied(() => {
      if (session.remoteCursors().size) this.scheduleCarets();
    });
    this.align(session.takeOrigin());
    if (session.remoteCursors().size) this.scheduleCarets();
    const { main } = view.state.selection;
    const toText = (position: number) => this.deferred?.mapPos(position, 1) ?? position;
    session.setLocalCursor(toText(main.anchor), toText(main.head));
  }

  /**
   * 挂上来时编辑器和会话不一样（docs/协同编辑.md §27）。构造函数在一次更新里跑，不能当场派发：
   * 编辑器还差的那一半先记成 deferred（从这里起 正文 = 编辑器 ∘ deferred，派发之前的本地改动照 write 映射过去），
   * 微任务里派发（settleAttach）。
   * - 会话照本机的 origin 建的、编辑器又多打（删）了字：origin → 编辑器、origin → 会话两份改动，
   *   本机那份映射过会话那份写进正文、发出去，编辑器收另一半。CodeMirror 保证
   *   local ∘ remote.map(local) = remote ∘ local.map(remote, true)：两边对到同一个结果，同一处都插了字本机的在前
   * - 没有 origin（之后再挂上来的编辑器）、编辑器就是 origin：以会话为准，只换不一样的那几处
   */
  private align(origin: string | null) {
    const have = this.view.state.doc.toString();
    const want = this.session.toString();
    if (have === want) return;
    let editorSide: ChangeSet;
    if (origin !== null && origin !== have) {
      const local = changesOf(origin, have);
      const remote = changesOf(origin, want);
      if (!this.writeChanges(local.map(remote, true))) return;
      editorSide = remote.map(local);
    } else {
      editorSide = changesOf(have, want);
    }
    if (editorSide.empty) return;
    this.deferred = editorSide;
    queueMicrotask(() => this.settleAttach());
  }

  /** 挂上时攒着的那一半派发进编辑器。正在组字：读得了 DOM、又不碰组字那一行才派发，不然等组字结束（finishComposition） */
  private settleAttach() {
    if (this.destroyed || !this.deferred) return;
    if (this.composing) {
      if (!this.readPendingInput()) return;
      // 读进来的组字改动已经映射过 deferred（write）
      if (!this.deferred || this.touchesComposition(this.deferred)) return;
    }
    this.flushDeferred();
  }

  update(update: ViewUpdate) {
    let localSelection = false;
    for (const transaction of update.transactions) {
      if (isCollabSync(transaction)) continue;
      if (transaction.docChanged) this.write(transaction);
      if (transaction.docChanged || transaction.selection) localSelection = true;
    }
    if (localSelection) {
      const { main } = update.state.selection;
      // 正文比编辑器多着没派发的远端改动：位置要换到正文里
      const toText = (position: number) => this.deferred?.mapPos(position, 1) ?? position;
      this.session.setLocalCursor(toText(main.anchor), toText(main.head));
    }

    if (this.ending && update.docChanged && !update.view.compositionStarted) {
      // 最后一次组字改动读进来了。派发要等这次更新结束
      queueMicrotask(() => this.finishComposition());
    }
  }

  /** 一个本地事务写进正文：commit 一次，出一个更新包 */
  private write(transaction: Transaction) {
    let changes = transaction.changes;
    if (this.deferred) {
      // 正文 = 编辑器 ∘ deferred：本地改动映射到正文上再写；deferred 跟着映射过本地改动。
      // CodeMirror 保证 local ∘ deferred.map(local) = deferred ∘ local.map(deferred, true)
      const local = changes;
      changes = local.map(this.deferred, true);
      this.deferred = this.deferred.map(local);
    }
    this.writeChanges(changes);
  }

  /** 一份相对正文的改动写进正文、commit 一次（出一个更新包）。写不进去返回 false，编辑器对齐到正文 */
  private writeChanges(changes: ChangeSet): boolean {
    const text = this.session.text;
    let shift = 0;
    let written = true;
    try {
      changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const insert = inserted.sliceString(0, inserted.length, "\n");
        const at = fromA + shift;
        if (toA > fromA) text.delete(at, toA - fromA);
        if (insert) text.insert(at, insert);
        shift += insert.length - (toA - fromA);
      });
    } catch (error) {
      // Loro 不收半个字（位置落在代理对中间）之类：不能让插件抛出去 —— CodeMirror 会把崩了的插件
      // 停掉，协作就悄无声息地断了（Yjs 收这种位置，换 Loro 以后才有）。写进去了的照常提交，
      // 编辑器整篇对齐到正文
      console.error("协作：本地改动写不进正文，编辑器对齐到正文", error);
      this.deferred = null;
      written = false;
      queueMicrotask(() => this.realign());
    }
    this.session.doc.commit({ origin: BINDING_ORIGIN });
    return written;
  }

  /** 编辑器对齐到正文（写不进正文以后）：只换不一样的那一段 */
  private realign() {
    if (this.destroyed) return;
    const want = this.session.toString();
    const have = this.view.state.doc.toString();
    if (want === have) return;
    const [head, tail] = commonEnds(have, want);
    this.dispatchRemote([
      { from: head, to: have.length - tail, insert: want.slice(head, want.length - tail) },
    ]);
  }

  /** 正文变了（远端、外部程序）：变成一次 CodeMirror 事务 */
  private readonly onText = (batch: LoroEventBatch) => {
    if (batch.origin === BINDING_ORIGIN || this.destroyed) return;
    const changes: ChangeSpec[] = [];
    for (const event of batch.events) {
      if (event.diff.type !== "text") continue;
      let position = 0;
      for (const op of event.diff.diff) {
        if (op.retain != null) {
          position += op.retain;
        } else if (op.insert != null) {
          changes.push({ from: position, insert: op.insert });
        } else if (op.delete != null) {
          changes.push({ from: position, to: position + op.delete });
          position += op.delete;
        }
      }
    }
    if (!changes.length) return;
    // 已经有没派发的：接在后面（相对的是正文，也就是编辑器 ∘ deferred）
    if (this.deferred) {
      this.deferred = this.deferred.compose(ChangeSet.of(changes, this.deferred.newLength));
      return;
    }
    // 组字期间：碰到组字那一行的先不派发（CodeMirror 只在改动不碰组字时保得住它），别的当场派发
    if (this.composing) {
      const set = ChangeSet.of(changes, this.view.state.doc.length);
      if (this.touchesComposition(set)) {
        this.deferred = set;
        return;
      }
    }
    this.dispatchRemote(changes);
  };

  private dispatchRemote(changes: ChangeSpec[] | ChangeSet) {
    this.view.dispatch({
      changes,
      annotations: [
        collabSync.of(true),
        Transaction.remote.of(true),
        Transaction.addToHistory.of(false),
      ],
    });
  }

  /* ---------------- 组字 ---------------- */

  private get composing(): boolean {
    return this.view.compositionStarted || this.ending;
  }

  /** 改动碰没碰到组字所在的那一行（组字就在光标处；行首、行尾插字也算碰到） */
  private touchesComposition(changes: ChangeSet): boolean {
    const line = this.view.state.doc.lineAt(this.view.state.selection.main.head);
    let touches = false;
    changes.iterChangedRanges((fromA, toA) => {
      if (fromA <= line.to && toA >= line.from) touches = true;
    });
    return touches;
  }

  /**
   * 组字期间远端改动要进来之前（会话问的）：把 DOM 里还没读进来的组字改动先读完 —— 之后派发事务时
   * CodeMirror 会清掉没读的，那就是吞字。用的是 CodeMirror 的内部接口（view.observer.flush，
   * 它自己在组字期间也是这样一点点读的）；认不出来、有挂起的按键（delayedFlush）时返回 false，
   * 这一次照旧排队等组字结束
   */
  private readPendingInput(): boolean {
    if (this.destroyed) return false;
    const observer = (this.view as unknown as { observer?: DomObserver }).observer;
    if (!observer || typeof observer.flush !== "function") return false;
    if ((observer.delayedFlush ?? -1) >= 0 || observer.delayedAndroidKey) return false;
    observer.flush();
    return !this.destroyed;
  }

  /** 攒着的远端改动派发出去（组字结束了）：编辑器的文档又和正文一样了 */
  private flushDeferred() {
    const changes = this.deferred;
    if (!changes) return;
    this.deferred = null;
    if (!changes.empty) this.dispatchRemote(changes);
    if (this.session.remoteCursors().size) this.scheduleCarets();
  }

  compositionStart() {
    this.ending = false;
    this.session.timers.clearTimeout(this.endTimer);
  }

  compositionEnd() {
    this.ending = true;
    this.session.timers.clearTimeout(this.endTimer);
    this.endTimer = this.session.timers.setTimeout(
      () => this.finishComposition(),
      COMPOSITION_SETTLE_MS,
    );
  }

  private finishComposition() {
    if (this.destroyed || !this.ending) return;
    // 又开始组下一个词了：接着攒
    if (this.view.compositionStarted) return;
    this.ending = false;
    this.session.timers.clearTimeout(this.endTimer);
    this.flushDeferred();
    this.session.flushHeld();
    for (const run of this.afterComposing.splice(0)) run();
  }

  /** 正在组字（含 compositionend 之后、最后一次组字改动读进来之前） */
  isComposing(): boolean {
    return !this.destroyed && this.composing;
  }

  /** 这次组字结束、攒着的远端改动派发进编辑器以后 run。返回取消 */
  afterComposition(run: () => void): () => void {
    this.afterComposing.push(run);
    return () => {
      this.afterComposing = this.afterComposing.filter((pending) => pending !== run);
    };
  }

  /* ---------------- 远端光标 ---------------- */

  /** 光标消息同一帧里来好几条只换算一次 */
  private scheduleCarets() {
    if (this.caretsScheduled || this.destroyed) return;
    this.caretsScheduled = true;
    queueMicrotask(() => {
      this.caretsScheduled = false;
      this.refreshCarets();
    });
  }

  /** 按会话里的光标重新算一遍：位置、标签亮不亮、超时了没有；下一次变化时再来 */
  private refreshCarets() {
    // 有没派发的远端改动时，正文里的位置和编辑器的对不上：等组字结束派发了再算（flushDeferred）
    if (this.destroyed || this.deferred) return;
    const { session, view } = this;
    const now = session.now;
    const previous = new Map(view.state.field(remoteCarets).map((caret) => [caret.id, caret]));
    const carets: RemoteCaret[] = [];
    let next = Number.POSITIVE_INFINITY;
    const length = view.state.doc.length;
    for (const cursor of session.remoteCursors().values()) {
      const silent = now - cursor.seenAt;
      if (silent >= CURSOR_TIMEOUT_MS + LEAVE_MS) {
        session.removePeer(cursor.peer.id);
        continue;
      }
      if (!cursor.head) continue;
      const before = previous.get(cursor.peer.id);
      // 指着的字还没到：先留在映射过来的老位置上
      const head = session.resolve(cursor.head) ?? before?.head;
      if (head === undefined) continue;
      const anchor = session.resolve(cursor.anchor) ?? before?.anchor ?? head;
      const leaving = silent >= CURSOR_TIMEOUT_MS;
      const labeled = now - cursor.movedAt < LABEL_MS;
      carets.push({
        id: cursor.peer.id,
        name: cursor.peer.name,
        color: cursor.peer.color,
        anchor: Math.min(anchor, length),
        head: Math.min(head, length),
        labeled,
        leaving,
      });
      if (labeled) next = Math.min(next, cursor.movedAt + LABEL_MS);
      next = Math.min(
        next,
        leaving ? cursor.seenAt + CURSOR_TIMEOUT_MS + LEAVE_MS : cursor.seenAt + CURSOR_TIMEOUT_MS,
      );
    }
    if (!sameCarets(view.state.field(remoteCarets), carets)) {
      view.dispatch({ effects: setRemoteCarets.of(carets) });
    }
    session.timers.clearTimeout(this.caretTimer);
    this.caretTimer = Number.isFinite(next)
      ? session.timers.setTimeout(() => this.refreshCarets(), Math.max(0, next - now) + 1)
      : null;
  }

  /**
   * 编辑器要拆了（MarkdownEditor 卸载、最后一次存盘之前）：DOM 里没读的组字改动读完，攒着的远端改动派发进编辑器。
   * 主持人的编辑器自己也存盘，拆的时候存的那一版要是缺了攒着的字，磁盘上就退回去了（审查 2026-11-13 §5.7）。
   * 编辑器马上就拆，输入法也跟着没了，不用再等组字结束
   */
  settle() {
    if (this.destroyed) return;
    if (this.composing) this.readPendingInput();
    this.flushDeferred();
  }

  destroy() {
    if (bindings.get(this.view) === this) bindings.delete(this.view);
    this.destroyed = true;
    this.stopText();
    this.session.timers.clearTimeout(this.endTimer);
    this.session.timers.clearTimeout(this.caretTimer);
    this.stopCursors();
    this.stopApplied();
    this.session.setLocalCursor(null);
    this.detach();
  }
}

/** 编辑器 → 挂着的绑定（settleCollab 找它） */
const bindings = new WeakMap<EditorView, CollabBinding>();

/** 编辑器要拆了：协作中攒着的远端改动先派发进来（见 CollabBinding.settle）。没挂协作的什么都不做 */
export function settleCollab(view: EditorView): void {
  bindings.get(view)?.settle();
}

/**
 * 要换下编辑器上的绑定（会话收掉、换一份会话）。正在组字的话等组完字、攒着的远端改动派发进编辑器以后再换（run）：
 * 当场换下，攒着的那几个字这边编辑器里就没了（会话里、主持人那里有）；当场派发又会打断输入法
 * （docs/协同编辑.md §27.5）。没在组字、没挂协作就当场 run。返回取消（又换了一次、编辑器卸了）
 */
export function whenCollabComposed(view: EditorView, run: () => void): () => void {
  const binding = bindings.get(view);
  if (!binding?.isComposing()) {
    run();
    return () => {};
  }
  return binding.afterComposition(run);
}

/** before → after 的改动（细到字，external.ts 的 fineEdits），相对 before */
function changesOf(before: string, after: string): ChangeSet {
  return ChangeSet.of(fineEdits(before, after), before.length);
}

function sameCarets(a: readonly RemoteCaret[], b: readonly RemoteCaret[]) {
  if (a.length !== b.length) return false;
  return a.every((caret, index) => {
    const other = b[index]!;
    return (
      caret.id === other.id &&
      caret.name === other.name &&
      caret.color === other.color &&
      caret.anchor === other.anchor &&
      caret.head === other.head &&
      caret.labeled === other.labeled &&
      caret.leaving === other.leaving
    );
  });
}

/**
 * 把一个编辑器接到协作会话上。编辑器用 session.toString() 的正文建；早就开着的编辑器换上它时，
 * 和会话不一样的地方按会话的 origin 对齐（align）。撤销用编辑器自己的 history()
 */
export function collab(session: CollabSession): Extension {
  const plugin = ViewPlugin.define((view) => new CollabBinding(view, session));
  return [
    plugin,
    remoteCursorLayers,
    EditorView.domEventObservers({
      compositionstart: (_event, view) => view.plugin(plugin)?.compositionStart(),
      compositionend: (_event, view) => view.plugin(plugin)?.compositionEnd(),
    }),
  ];
}
