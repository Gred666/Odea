import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * 弹出层里的按键提示画成图标（lucide 的 CornerDownLeft、ArrowUp…），不写 ↵ ⇧ ↑ ↓ ⌫ 这类字。
 *
 * 正文字体（Inter + 雅黑 / 苹方）里没有这些字，浏览器第一次画它们时要把系统字体挨个
 * 找一遍来兜底，装的字体越多越慢。它们偏偏都在选择器的底栏里 —— 于是按下 Ctrl+E，
 * 主线程先卡在找字体上（4 倍降速时约 100ms，只有 ↵ 一个字）。命令面板一直用的是图标。
 */

const POPUPS = [
  "EmojiPicker.tsx",
  "TemplatePicker.tsx",
  "SuggestMenu.tsx",
  "../components/CommandPalette.tsx",
  "../components/FindDialog.tsx",
];

/** 箭头（U+2190–21FF）、杂项技术符号（U+2300–23FF，⌘ ⌫ ⏎） */
const RARE_GLYPH = /[←-⇿⌀-⏿]/u;

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("弹出层的按键提示", () => {
  for (const file of POPUPS) {
    it(`${file} draws key hints as icons, not glyphs the UI font lacks`, () => {
      const source = withoutComments(readFileSync(join(__dirname, file), "utf8"));
      const hit = source.split("\n").find((line) => RARE_GLYPH.test(line));
      expect(hit).toBeUndefined();
    });
  }
});
