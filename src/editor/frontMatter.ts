import type { Text } from "@codemirror/state";

export interface FrontMatterRange {
  /** 第一行 `---` 的起点（永远是 0） */
  from: number;
  /** 结束行 `---` 的终点（不含其后的换行） */
  to: number;
  /** 起止两行的行号（一基） */
  openLine: number;
  closeLine: number;
}

const FENCE_RE = /^---\s*$/;
/**
 * `键: 值` 的键：第一个字是 Unicode 字母（中文、日文的字也算）或下划线，后面是字母、组合符号（拆开写的重音、
 * 印地文的半音符、泰文的声调号）、数字、`_`、`-`，再是半角的 `:`。全角冒号、带空格的键不算（YAML 本来就不认）。
 * 和 Rust 的 `domain/search.rs::is_yaml_key` 一字不差的同一条正则（docs/提醒与属性.md §3.3）。Unicode 表的版本不一样：
 * 那边的 `regex` 是 16.0，WebView2 151（ICU 78）是 17.0，跑测试的 Node 24（ICU 77）是 16.0 —— 只差 17.0 新加的字，见那一节的实现记录
 */
const KEY_RE = /^[\p{Alphabetic}_][\p{Alphabetic}\p{M}\p{N}_-]*\s*:/u;
/** 超过这么多行还没闭合就不当 front matter 了：真有人写 200 行 YAML 头也不合理。 */
const MAX_LINES = 60;

/** 这一行是不是 `键: 值` 的样子。属性块里至少要有一行这样的，不然是「开头一条分隔线」 */
export function isFrontMatterKey(line: string): boolean {
  return KEY_RE.test(line);
}

/**
 * 文档开头的 YAML front matter。
 *
 * CommonMark 会把它解析成「分隔线 + Setext 标题」，`title: x` 会变成一个 H2。
 * 这里在解析之外单独识别：必须从第 1 行开始、以单独一行 `---` 结束，
 * 且中间至少有一行长得像 `key: value` —— 否则一篇以分隔线开头的普通笔记
 * 会被误判。
 */
export function frontMatterRange(doc: Text): FrontMatterRange | null {
  if (doc.lines < 3) return null;
  const first = doc.line(1);
  if (!FENCE_RE.test(first.text)) return null;

  let sawKey = false;
  const last = Math.min(doc.lines, MAX_LINES);
  for (let number = 2; number <= last; number += 1) {
    const line = doc.line(number);
    if (FENCE_RE.test(line.text)) {
      if (!sawKey) return null;
      return { from: 0, to: line.to, openLine: 1, closeLine: number };
    }
    if (KEY_RE.test(line.text)) sawKey = true;
  }
  return null;
}
