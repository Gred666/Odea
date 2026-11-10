import type { OutlineItem } from "@/data/types";

/* ============================================================
   目录树跟着正文走：读到哪一节，高亮跟到哪一节（技术方案 §12.9，docs/1110审查与研究.md §5.2）。
   这里是不碰 DOM 的那一半，量位置的在 MarkdownEditor 的目录句柄（readingAt）里，
   什么时候算在 Outline.tsx 里。
   ============================================================ */

/** 第 line 行（从 1 开始）属于目录里的哪一条：在它前面（含这一行）最近的那一条；都在后面就是第一条（概览） */
export function sectionAt(items: readonly OutlineItem[], line: number): OutlineItem | undefined {
  let found: OutlineItem | undefined;
  for (const item of items) if (item.line <= line) found = item;
  return found ?? items[0];
}

/** 读到哪了看可视区从上往下这么多的那条线（下面 readingLine） */
export const READING_LINE = 0.25;

/**
 * 跟着滚动时，目录树的高亮按哪一行算：
 * - 光标在屏幕上：光标那一行。正在那儿写 —— 打字到屏幕底下时编辑器把光标滚进来，
 *   不能跟着这次滚动把高亮拉回上一节。点了目录滑过去之后光标就在那个标题上，也听它的
 * - 滚到底了：屏幕上最后一行。最后几节短的话，标题永远到不了上面那条线
 * - 否则：可视区从上往下四分之一那条线上的那一行（读到的地方）
 * 坐标都是窗口坐标。caret 是 null：光标不在画出来的范围里（滚远了）
 */
export function readingLine(at: {
  caret: { line: number; top: number; bottom: number } | null;
  band: { top: number; bottom: number };
  atEnd: boolean;
  lineAtY: (y: number) => number;
}): number {
  const { caret, band } = at;
  if (caret && caret.bottom > band.top && caret.top < band.bottom) return caret.line;
  if (at.atEnd) return at.lineAtY(band.bottom - 1);
  return at.lineAtY(band.top + (band.bottom - band.top) * READING_LINE);
}
