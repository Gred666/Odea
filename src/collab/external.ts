import { commonEnds, diffLines } from "@/lib/lineDiff";
import type { Frontiers, LoroDoc } from "loro-crdt";
import { type CollabSession, TEXT_NAME } from "./session";

/* ============================================================
   外部改动进协作会话（docs/协同编辑.md §4.4、§20.5）。

   会话中，主持人那台的文件被别的程序改了（另一个编辑器、git 同步拉下来的、网盘）。
   不能拿磁盘上的新版和会话的正文直接比：主持人这边可能有防抖期间还没存下去的会话改动，
   直接比会把它们当成「外部删掉了」；整篇替换更糟 —— 在 CRDT 里删光再插一遍，所有人的
   光标塌到一处，那一刻别人正在打的字落到莫名其妙的地方。

   做法：把外部程序当成一个从「上次保存」处分叉出去的协作者。
   - 每次保存时连同正文记下那一刻文档的版本（frontiers，几十个字节）
   - 外部改动到了：从那一版 forkAt 出一份（Loro 给它一个新的 peer），把「上次保存的正文 →
     磁盘上的新正文」的差异作为编辑打在它上面（先逐行，改了的那几段里再逐字），导出它的
     增量合进会话。和会话里的改动按 CRDT 规则合并，大家都看到；不出冲突副本
   - git 同步合并下来的改动也走这条
   ============================================================ */

/** 一次保存：写下去的正文，和写的那一刻会话的版本（两者必须同时取，见 snapshot） */
export interface SavedSnapshot {
  text: string;
  frontiers: Frontiers;
}

/**
 * 保存时调：正文和版本在同一刻取。写盘用这里的 text（别用更早排进防抖里的那一份：
 * 版本对不上正文的话，外部改动的差异会把自己的改动再插一遍）
 */
export function snapshot(session: CollabSession): SavedSnapshot {
  return { text: session.toString(), frontiers: session.doc.frontiers() };
}

/**
 * 磁盘上变成了 disk：作为一个从 base 分叉出去的协作者的编辑，合进会话。
 * 返回有没有合进去（磁盘和上次保存的一样、或者 base 坏了就是 false）
 */
export function mergeExternal(session: CollabSession, base: SavedSnapshot, disk: string): boolean {
  if (disk === base.text) return false;
  let fork: LoroDoc;
  try {
    fork = session.doc.forkAt(base.frontiers);
  } catch {
    return false;
  }
  const text = fork.getText(TEXT_NAME);
  // 记的版本和正文对不上（不该发生）：宁可不合，也别把半篇插重
  if (text.toString() !== base.text) return false;
  const before = fork.oplogVersion();
  // 从后往前改，前面的位置不受影响
  for (const edit of textEdits(base.text, disk).reverse()) {
    if (edit.to > edit.from) text.delete(edit.from, edit.to - edit.from);
    if (edit.insert) text.insert(edit.from, edit.insert);
  }
  fork.commit();
  session.applyExternal(fork.export({ mode: "update", from: before }));
  return true;
}

export interface TextEdit {
  /** 在改动前的正文里的位置 */
  from: number;
  to: number;
  insert: string;
}

/**
 * before → after 的改动：先逐行找出改了的几段（隔得远的改动分开，中间没动的行一个字都不碰 ——
 * 别人这时正在那里打的字才不会被卷进去），每一段里再掐头去尾细到字。
 * 文档大到逐行比不动（几千行 × 几千行）就退回整篇掐头去尾
 */
export function textEdits(before: string, after: string): TextEdit[] {
  const lines = diffLines(before, after);
  if (!lines) return [refine(before, after, 0, before.length, 0, after.length)].filter(changed);
  // 两边都当成末尾多一个换行来算：每一行都带着自己的换行，增删整行不用分「是不是最后一行」
  const a = `${before}\n`;
  const b = `${after}\n`;
  const edits: TextEdit[] = [];
  let posA = 0;
  let posB = 0;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.kind === "same") {
      posA += line.text.length + 1;
      posB += line.text.length + 1;
      index += 1;
      continue;
    }
    const startA = posA;
    const startB = posB;
    while (index < lines.length && lines[index]!.kind !== "same") {
      const each = lines[index]!;
      if (each.kind === "removed") posA += each.text.length + 1;
      else posB += each.text.length + 1;
      index += 1;
    }
    const edit = refine(a, b, startA, posA, startB, posB);
    if (changed(edit)) edits.push(edit);
  }
  return edits.map((edit) => (edit.to > before.length ? atEnd(edit, before.length) : edit));
}

/**
 * 碰到了补上去的那个换行：只有末尾整行的增删会这样（两边都有字的话，掐头去尾时那个换行
 * 已经当成相同的去掉了）。删掉最后几行 = 删掉它们前面那个真换行；在末尾加几行 = 换行挪到
 * 插入内容的前面。整篇都换掉时没有前面的换行，去掉插入内容末尾那个就是
 */
function atEnd(edit: TextEdit, length: number): TextEdit {
  const insert = edit.insert.endsWith("\n") ? edit.insert.slice(0, -1) : edit.insert;
  if (edit.from === 0) return { from: 0, to: length, insert };
  return {
    from: edit.from - 1,
    to: edit.to - 1,
    insert: edit.insert ? `\n${insert}` : "",
  };
}

/** 一段改动：a 的 [fromA, toA) 换成 b 的 [fromB, toB)，掐掉两头相同的字 */
function refine(a: string, b: string, fromA: number, toA: number, fromB: number, toB: number) {
  const removed = a.slice(fromA, toA);
  const added = b.slice(fromB, toB);
  const [head, tail] = commonEnds(removed, added);
  return {
    from: fromA + head,
    to: toA - tail,
    insert: added.slice(head, added.length - tail),
  };
}

const changed = (edit: TextEdit) => edit.to > edit.from || edit.insert.length > 0;
