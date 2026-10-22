import { diffLines } from "./lineDiff";

/* ============================================================
   逐行三方合并（docs/协同编辑.md §22.2 规矩 2）：团队仓库里加入别人的会话时，本机这一篇有没提交的改动
   （ours，相对 git 里最近一次提交的 base），会话里是主持人那份（theirs，也是从某一版 base 改过来的）。
   把 ours 的改动打到 theirs 上：

   - 两边各自 base → ours、base → theirs 逐行比，得到一段段改动（按 base 的行号）
   - ours 的一段和 theirs 的任何一段挨着、叠着，就不打（宁可少合：git 下一轮同步时会再三方合一次，
     合不上另存冲突副本，不丢东西）；其余的按 base 的位置打上去
   - 文档太大逐行比不动：返回 null，调用方不合
   ============================================================ */

interface Change {
  /** base 里被换掉的行：[start, end) */
  start: number;
  end: number;
  lines: string[];
}

function changesOf(base: string, other: string): Change[] | null {
  const lines = diffLines(base, other);
  if (!lines) return null;
  const changes: Change[] = [];
  let at = 0;
  let index = 0;
  while (index < lines.length) {
    if (lines[index]!.kind === "same") {
      at += 1;
      index += 1;
      continue;
    }
    const change: Change = { start: at, end: at, lines: [] };
    while (index < lines.length && lines[index]!.kind !== "same") {
      const line = lines[index]!;
      if (line.kind === "removed") change.end += 1;
      else change.lines.push(line.text);
      index += 1;
    }
    at = change.end;
    changes.push(change);
  }
  return changes;
}

/** 挨着、叠着都算（两边在同一处插入也算）：这样的地方让 git 去合 */
const touches = (a: Change, b: Change) => a.start <= b.end && b.start <= a.end;

export interface Merged {
  text: string;
  /** ours 里没打上去的几段（和 theirs 撞了） */
  skipped: number;
}

export function merge3(base: string, ours: string, theirs: string): Merged | null {
  if (ours === base) return { text: theirs, skipped: 0 };
  if (theirs === base) return { text: ours, skipped: 0 };
  const mine = changesOf(base, ours);
  const others = changesOf(base, theirs);
  if (!mine || !others) return null;
  const kept = mine.filter((change) => !others.some((other) => touches(change, other)));
  const all = [...others, ...kept].sort((a, b) => a.start - b.start || a.end - b.end);
  const baseLines = base.split("\n");
  const out: string[] = [];
  let at = 0;
  for (const change of all) {
    out.push(...baseLines.slice(at, change.start));
    out.push(...change.lines);
    at = change.end;
  }
  out.push(...baseLines.slice(at));
  return { text: out.join("\n"), skipped: mine.length - kept.length };
}
