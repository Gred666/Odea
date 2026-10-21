/* ============================================================
   两版正文的逐行对比（冲突副本横幅里的「查看差异」）。

   最长公共子序列：O(行数 × 行数)。冲突副本两边大多只差几行，但整篇都要比；
   两边乘起来超过 MAX_CELLS 就不比了（几千行的文档才会到），由调用方说「太长」。
   ============================================================ */

export type DiffLine =
  | { kind: "same"; text: string }
  /** 只在原文里有 */
  | { kind: "removed"; text: string }
  /** 只在副本里有 */
  | { kind: "added"; text: string };

/** 一段改动：前后各带一行没变的作上下文；中间隔得远的改动分成两段 */
export interface DiffHunk {
  lines: DiffLine[];
}

const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  // 两头一样的先剥掉，中间那一截才需要算
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length * midB.length > MAX_CELLS) return null;

  // lcs[i][j] = midA[i..] 和 midB[j..] 的最长公共子序列长度
  const width = midB.length + 1;
  const lcs = new Uint32Array((midA.length + 1) * width);
  for (let i = midA.length - 1; i >= 0; i -= 1) {
    for (let j = midB.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        midA[i] === midB[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }

  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: "same", text }));
  let i = 0;
  let j = 0;
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      out.push({ kind: "same", text: midA[i]! });
      i += 1;
      j += 1;
    } else if (
      i < midA.length &&
      (j >= midB.length || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)
    ) {
      // 删掉的排在加上的前面，和常见的 diff 读法一样
      out.push({ kind: "removed", text: midA[i]! });
      i += 1;
    } else {
      out.push({ kind: "added", text: midB[j]! });
      j += 1;
    }
  }
  for (const text of a.slice(a.length - tail)) out.push({ kind: "same", text });
  return out;
}

/** 只留改动的地方，前后各带 context 行没变的 */
export function diffHunks(lines: DiffLine[], context = 1): DiffHunk[] {
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = index - context; k <= index + context; k += 1) {
      if (k >= 0 && k < lines.length) keep.add(k);
    }
  });
  const hunks: DiffHunk[] = [];
  let current: DiffLine[] | null = null;
  let previous = -2;
  for (const index of [...keep].sort((x, y) => x - y)) {
    if (!current || index !== previous + 1) {
      current = [];
      hunks.push({ lines: current });
    }
    current.push(lines[index]!);
    previous = index;
  }
  return hunks;
}

/** 增删了几行 */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") added += 1;
    else if (line.kind === "removed") removed += 1;
  }
  return { added, removed };
}

/**
 * 两段文字开头、结尾各有多少一样：中间那一截才是改了的。不切开代理对，两头不重叠。
 * 表格格子写回源码只换这一截、外部改动进协作会话按它细化到字（collab/external.ts）
 */
export function commonEnds(before: string, after: string): [number, number] {
  const limit = Math.min(before.length, after.length);
  let head = 0;
  while (head < limit && before.charCodeAt(head) === after.charCodeAt(head)) head += 1;
  if (head > 0 && head < limit && isHighSurrogate(before.charCodeAt(head - 1))) head -= 1;
  let tail = 0;
  while (
    tail < limit - head &&
    before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
  ) {
    tail += 1;
  }
  if (tail > 0 && isLowSurrogate(before.charCodeAt(before.length - tail))) tail -= 1;
  return [head, tail];
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
