import {
  ChangeSet,
  type ChangeSpec,
  EditorSelection,
  EditorState,
  type Extension,
  Facet,
  Prec,
  type SelectionRange,
  type Text,
  Transaction,
} from "@codemirror/state";
import { type Command, EditorView, keymap } from "@codemirror/view";

/* ============================================================
   插件藏起来的整行（docs/白板.md §13.10）。

   插件经 hiddenLine 认领一些独占一行、从行首写起的 HTML 注释（白板的标记 `<!-- @card k3f9a2 40,80 320 -->`）：
   文档视图里这一行连同后面紧跟的那个空行整段藏掉，不画「注释」小标记 —— 不然段落之间多出一个空行。
   认哪些行是插件的事；怎么藏、怎么护着在这里。插件关着时没人认领，块级层照旧画「注释」，这里的东西一样都不跑。

   藏法：块级层（blockDecorations.ts）把认领的那几行和后面的空行折成一个没有替身的块级替换（和 Setext 的下划线一样），
   连着的几段并成一段（一张空卡片后面紧跟着下一张）。替换是 atomic 的，这里补三样：
   - 光标不停在藏起来的范围上（两头也不行：一头是藏着的行首，一头是藏着的行尾，在那里打字就改到了标记）：
     往后走的落到下一行行首，往前走的落到上一行行尾
   - 打字、粘贴、删除改不坏认领的那一行：整行删掉可以（选中一大段删，标记跟着走），改一半、和别的行连成一行不行。
     落在藏起来的范围上的插入挪到下一行行首；改坏标记的那几处改动扔掉，别的照做
   - 退格、删除在藏起来的范围边上：不把标记吃掉、不把两张卡片连成一段。先吃掉隔着的空行（看上去和普通段落一样，
     空行没了），没有空行就跳过去
   复制的时候藏着的那几行不进剪贴板：看到什么复制什么
   ============================================================ */

/** 插件认领一行：这一行的原文（不含换行）是它的就返回 true */
export type LineClaim = (text: string) => boolean;

/** 插件认领哪些行（白板：标记行）。没有插件认领时是空的 */
export const hiddenLine = Facet.define<LineClaim>();

/** 这一行有没有插件认领 */
export function claimedLine(claims: readonly LineClaim[], text: string): boolean {
  for (const claim of claims) if (claim(text)) return true;
  return false;
}

/** 藏起来的一段：一个或几个认领的行，各自连同后面紧跟的那个空行。都是整行 */
export interface HiddenRange {
  /** 第一行的行首 */
  from: number;
  /** 最后一行的行尾 */
  to: number;
  /** 认领的那几行，两个一组：行首、行尾 */
  lines: readonly number[];
}

const blankLine = (text: string) => text.trim() === "";

/**
 * 认领的行（按先后）→ 藏起来的几段。每一行后面紧跟的空行一起藏；首尾相接的并成一段
 */
export function hiddenRanges(doc: Text, claimed: readonly number[]): HiddenRange[] {
  const ranges: { from: number; to: number; lines: number[] }[] = [];
  for (const at of claimed) {
    const line = doc.lineAt(at);
    let to = line.to;
    if (line.number < doc.lines) {
      const next = doc.line(line.number + 1);
      if (blankLine(next.text)) to = next.to;
    }
    const last = ranges[ranges.length - 1];
    if (last && last.to + 1 >= line.from) {
      last.to = Math.max(last.to, to);
      last.lines.push(line.from, line.to);
    } else {
      ranges.push({ from: line.from, to, lines: [line.from, line.to] });
    }
  }
  return ranges;
}

/** 跟着改动挪（只在改动碰不到它们的时候用：块级层打字的快路，blockDecorations.ts 的 mapBlockState） */
export function mapHiddenRanges(
  ranges: readonly HiddenRange[],
  changes: ChangeSet,
): readonly HiddenRange[] {
  if (!ranges.length) return ranges;
  return ranges.map((range) => ({
    from: changes.mapPos(range.from, 1),
    to: changes.mapPos(range.to, -1),
    lines: range.lines.map((position, index) => changes.mapPos(position, index % 2 ? -1 : 1)),
  }));
}

/** 包着 position 的那一段（两头也算）；ranges 按先后排、互不相交，二分找 */
function rangeAt(ranges: readonly HiddenRange[], position: number): HiddenRange | null {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = ranges[middle]!;
    if (position < range.from) high = middle - 1;
    else if (position > range.to) low = middle + 1;
    else return range;
  }
  return null;
}

/** 和 [from, to] 挨着或相交的那几段（前后各宽一个字：碰到它前后的换行也算） */
function rangesNear(ranges: readonly HiddenRange[], from: number, to: number): HiddenRange[] {
  let low = 0;
  let high = ranges.length;
  // 第一段 to + 1 >= from 的
  while (low < high) {
    const middle = (low + high) >> 1;
    if (ranges[middle]!.to + 1 < from) low = middle + 1;
    else high = middle;
  }
  const near: HiddenRange[] = [];
  for (let index = low; index < ranges.length && ranges[index]!.from - 1 <= to; index += 1) {
    near.push(ranges[index]!);
  }
  return near;
}

/**
 * 这组改动有没有改坏认领的哪一行：整行（连同两头的换行）原样留着、或者整行被删掉都不算；
 * 改了里面的字、在行首行尾插了字、和上一行下一行连成了一行算
 */
function damages(
  changes: ChangeSet,
  doc: Text,
  newDoc: Text,
  ranges: readonly HiddenRange[],
): boolean {
  let damaged = false;
  changes.iterChangedRanges((fromA, toA) => {
    if (damaged) return;
    for (const range of rangesNear(ranges, fromA, toA)) {
      for (let index = 0; index < range.lines.length; index += 2) {
        const from = range.lines[index]!;
        const to = range.lines[index + 1]!;
        if (toA < from - 1 || fromA > to + 1) continue;
        // 整行都在这一处改动里（选中一大段删掉、粘贴盖掉）：标记跟着走。不用 touchesRange 的 "cover"：
        // 它要改动严格地包住这一行，打头的标记和从 0 开始的全选就算不上
        if (fromA <= from && toA >= to && toA > fromA) continue;
        // 碰到了但还在：换行删的是旁边的空行、插的是整行
        const start = changes.mapPos(from, 1);
        const end = changes.mapPos(to, -1);
        const survived =
          end >= start &&
          newDoc.lineAt(start).from === start &&
          newDoc.lineAt(end).to === end &&
          newDoc.sliceString(start, end) === doc.sliceString(from, to);
        if (!survived) {
          damaged = true;
          return;
        }
      }
    }
  });
  return damaged;
}

/** 要护着的用户改动：打字、粘贴、拖放、删除、挪行。组字不拦（拦了输入法就断）；撤销、别处来的不拦 */
function guarded(transaction: Transaction): boolean {
  if (!transaction.docChanged || transaction.isUserEvent("input.type.compose")) return false;
  return (
    transaction.isUserEvent("input") ||
    transaction.isUserEvent("delete") ||
    transaction.isUserEvent("move")
  );
}

/**
 * 落在藏起来的这一段上的插入挪到哪：下一行行首；后面没有了，上一行行尾；整篇都藏着，接在文末（先空一行，
 * 不然字接在标记那一行后面）
 */
function insertionSpot(doc: Text, range: HiddenRange): { at: number; lead: string } {
  if (range.to < doc.length) return { at: range.to + 1, lead: "" };
  if (range.from > 0) return { at: range.from - 1, lead: "" };
  const text = doc.sliceString(Math.max(0, doc.length - 2));
  return { at: doc.length, lead: text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n" };
}

/** 光标停在藏起来的这一段上，往哪挪：往后走的落到下一行行首，往前走的落到上一行行尾；只有一边能去就去那边 */
function exitOf(doc: Text, range: HiddenRange, forward: boolean): number | null {
  const after = range.to < doc.length ? range.to + 1 : null;
  const before = range.from > 0 ? range.from - 1 : null;
  return forward ? (after ?? before) : (before ?? after);
}

function guardFilter(rangesOf: (state: EditorState) => readonly HiddenRange[]): Extension {
  return EditorState.transactionFilter.of((transaction) => {
    const before = transaction.startState;
    const ranges = rangesOf(before);
    if (!ranges.length) return transaction;
    const { doc } = before;

    if (guarded(transaction) && !before.readOnly) {
      const userEvent = transaction.annotation(Transaction.userEvent);
      // 只有一处插入、一个光标，落在藏起来的范围上（光标停在了不该停的地方：比如刚挂上的编辑器，光标在 0）：挪过去
      const parts: { from: number; to: number; text: string }[] = [];
      transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        parts.push({ from: fromA, to: toA, text: inserted.toString() });
      });
      const one = parts.length === 1 ? parts[0]! : null;
      if (one && one.from === one.to && one.text && before.selection.ranges.length === 1) {
        const range = rangeAt(ranges, one.from);
        if (range) {
          const spot = insertionSpot(doc, range);
          const insert = spot.lead + one.text;
          return {
            changes: { from: spot.at, insert },
            selection: EditorSelection.cursor(spot.at + insert.length),
            userEvent,
            scrollIntoView: true,
          };
        }
      }
      if (damages(transaction.changes, doc, transaction.newDoc, ranges)) {
        // 改坏标记的那几处扔掉，别的照做（全部替换时只跳过标记里的那几处）
        const kept: ChangeSpec[] = [];
        transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          const change = { from: fromA, to: toA, insert: inserted };
          const alone = ChangeSet.of(change, doc.length);
          if (!damages(alone, doc, alone.apply(doc), ranges)) kept.push(change);
        });
        if (!kept.length) return [];
        return { changes: kept, userEvent, scrollIntoView: transaction.scrollIntoView };
      }
    }

    // 光标、选区的一头停在藏起来的范围上：挪开。查找选中的是匹配本身（可能就在标记里），不动
    const selection = transaction.selection;
    if (!selection || transaction.isUserEvent("select.search")) return transaction;
    const changed = transaction.docChanged;
    const now = changed ? mapHiddenRanges(ranges, transaction.changes) : ranges;
    const newDoc = transaction.newDoc;
    const previous = before.selection;
    let moved = false;
    const next = selection.ranges.map((range: SelectionRange, index) => {
      const hit = rangeAt(now, range.head);
      if (!hit) return range;
      // 选到了头、选到了尾（全选）：盖住藏着的那几行，删的时候一起删
      if (!range.empty && (range.head === 0 || range.head === newDoc.length)) return range;
      const was = (
        previous.ranges.length === selection.ranges.length ? previous.ranges[index]! : previous.main
      ).head;
      const from = changed ? transaction.changes.mapPos(was, -1) : was;
      const target = exitOf(newDoc, hit, range.head > from);
      if (target === null) return range;
      moved = true;
      return range.empty
        ? EditorSelection.cursor(target)
        : EditorSelection.range(range.anchor, target);
    });
    if (!moved) return transaction;
    return [
      transaction,
      { selection: EditorSelection.create(next, selection.mainIndex), sequential: true },
    ];
  });
}

/**
 * 退格：光标在藏起来的那一段紧下面那一行的行首。上面隔着一个空行就删掉它（和普通段落之间按退格一样，空行没了），
 * 没隔空行就跳到上一行行尾，什么都不删 —— 不吃掉标记、不把这一张并进上一张
 */
function backspaceAtEdge(rangesOf: (state: EditorState) => readonly HiddenRange[]): Command {
  return (view) => {
    const { state } = view;
    const main = state.selection.main;
    if (!main.empty || state.selection.ranges.length > 1 || main.head === 0) return false;
    const range = rangeAt(rangesOf(state), main.head - 1);
    if (!range || range.to !== main.head - 1) return false;
    if (state.readOnly || range.from === 0) return true;
    const above = state.doc.lineAt(range.from - 1);
    if (blankLine(above.text)) {
      view.dispatch({
        changes:
          above.from > 0
            ? { from: above.from - 1, to: above.to }
            : { from: above.from, to: above.to + 1 },
        userEvent: "delete.backward",
        scrollIntoView: true,
      });
    } else {
      view.dispatch({
        selection: EditorSelection.cursor(above.to),
        userEvent: "select",
        scrollIntoView: true,
      });
    }
    return true;
  };
}

/** 删除（往后）：光标在藏起来的那一段紧上面那一行的行尾。和退格对称：下面隔着一个空行就删掉它，没隔就跳到下一行行首 */
function deleteAtEdge(rangesOf: (state: EditorState) => readonly HiddenRange[]): Command {
  return (view) => {
    const { state } = view;
    const main = state.selection.main;
    const { doc } = state;
    if (!main.empty || state.selection.ranges.length > 1 || main.head === doc.length) return false;
    const range = rangeAt(rangesOf(state), main.head + 1);
    if (!range || range.from !== main.head + 1) return false;
    if (state.readOnly || range.to === doc.length) return true;
    const below = doc.lineAt(range.to + 1);
    if (blankLine(below.text)) {
      view.dispatch({
        changes:
          below.to < doc.length
            ? { from: below.from, to: below.to + 1 }
            : { from: below.from - 1, to: below.to },
        userEvent: "delete.forward",
        scrollIntoView: true,
      });
    } else {
      view.dispatch({
        selection: EditorSelection.cursor(below.from),
        userEvent: "select",
        scrollIntoView: true,
      });
    }
    return true;
  };
}

/**
 * 复制、剪切：藏着的那几行（连同它后面的换行）不进剪贴板。光标没选东西时 CodeMirror 复制整行，那一行是看得见的，不用管
 */
function copyFilter(rangesOf: (state: EditorState) => readonly HiddenRange[]): Extension {
  return EditorView.clipboardOutputFilter.of((text, state) => {
    const ranges = rangesOf(state);
    const selected = state.selection.ranges.filter((range) => !range.empty);
    if (!ranges.length || !selected.length) return text;
    // 别的过滤器改过了、或者不是这几段拼起来的：不动
    if (
      text !== selected.map((range) => state.sliceDoc(range.from, range.to)).join(state.lineBreak)
    )
      return text;
    return selected
      .map((range) => {
        let out = "";
        let at = range.from;
        for (const hidden of rangesNear(ranges, range.from, range.to)) {
          const from = Math.max(hidden.from, range.from);
          const to = Math.min(hidden.to + 1, range.to);
          if (to <= from) continue;
          out += state.sliceDoc(at, from);
          at = to;
        }
        return out + state.sliceDoc(at, range.to);
      })
      .join(state.lineBreak);
  });
}

/**
 * 装进编辑器的那几样（编辑器一直装着；没有插件认领时 rangesOf 给空的，什么都不做）。
 * rangesOf：这个状态里藏起来的几段（块级层算的，typoraDecorations.ts 交过来）
 */
export function hiddenLineGuards(
  rangesOf: (state: EditorState) => readonly HiddenRange[],
): Extension {
  const backspace = backspaceAtEdge(rangesOf);
  const forward = deleteAtEdge(rangesOf);
  return [
    guardFilter(rangesOf),
    copyFilter(rangesOf),
    // 比 Markdown 的退格（删列表符号）、默认的删字都先拿到；不在边上返回 false，照常删
    Prec.highest(
      keymap.of([
        { key: "Backspace", run: backspace, shift: backspace },
        { key: "Mod-Backspace", mac: "Alt-Backspace", run: backspace },
        { mac: "Mod-Backspace", run: backspace },
        { key: "Delete", run: forward, shift: forward },
        { key: "Mod-Delete", mac: "Alt-Delete", run: forward },
        { mac: "Mod-Delete", run: forward },
      ]),
    ),
  ];
}
