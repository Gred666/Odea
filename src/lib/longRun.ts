/* 很长、中间没有断点的西文串（网址、哈希、一直按着的 1111……）可以在串里任意处断行
   （editor/longRuns.ts 说了为什么）。正文和文档标题用同一条规矩 */

/** 多长算「很长」：比正常的英文单词都长（internationalization 是 20 个字母） */
export const MIN_RUN = 24;

/** 不是空白、不是汉字 / 假名 / 谚文 / 全角符号的字（中日韩文字之间本来就能断） */
export const NOT_CJK =
  "[^\\s\\u2E80-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFFEF]";

const LONG_RUN = new RegExp(`${NOT_CJK}{${MIN_RUN},}`);

/** 有没有这样一串 */
export function hasLongRun(text: string): boolean {
  return LONG_RUN.test(text);
}
