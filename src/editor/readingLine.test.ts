import { buildOutline } from "@/lib/markdown";
import { describe, expect, it } from "vitest";
import { READING_LINE, readingLine, sectionAt } from "./readingLine";

/* 目录树跟着滚动时按哪一行算（docs/1110审查与研究.md §5.2） */

const band = { top: 100, bottom: 900 };
/** 一行 20px，从窗口坐标 0 开始（第 1 行在 0–20） */
const lineAtY = (y: number) => Math.floor(y / 20) + 1;

describe("readingLine", () => {
  it("reads at a quarter of the way down when the caret is off screen", () => {
    const y = band.top + (band.bottom - band.top) * READING_LINE;
    expect(readingLine({ caret: null, band, atEnd: false, lineAtY })).toBe(lineAtY(y));
    // 光标在屏幕上面（滚过去了）
    const above = { line: 2, top: 20, bottom: 40 };
    expect(readingLine({ caret: above, band, atEnd: false, lineAtY })).toBe(lineAtY(y));
  });

  it("follows the caret while it is on screen, even partly", () => {
    const caret = { line: 44, top: 880, bottom: 900 };
    expect(readingLine({ caret, band, atEnd: false, lineAtY })).toBe(44);
    expect(
      readingLine({ caret: { ...caret, top: 890, bottom: 910 }, band, atEnd: false, lineAtY }),
    ).toBe(44);
    expect(
      readingLine({ caret: { ...caret, top: 900, bottom: 920 }, band, atEnd: false, lineAtY }),
    ).not.toBe(44);
  });

  it("takes the last line on screen once scrolled to the end", () => {
    expect(readingLine({ caret: null, band, atEnd: true, lineAtY })).toBe(lineAtY(band.bottom - 1));
  });
});

describe("sectionAt", () => {
  const items = buildOutline(["开头", "", "## 一", "", "正文", "", "## 二", "", "正文"].join("\n"));

  it("is the nearest entry at or above the line, and the first one before any heading", () => {
    const text = (line: number) => sectionAt(items, line)?.text;
    expect(text(1)).toBe(items[0]?.text);
    expect(text(3)).toBe("一");
    expect(text(6)).toBe("一");
    expect(text(7)).toBe("二");
    expect(text(99)).toBe("二");
    expect(sectionAt([], 3)).toBeUndefined();
  });
});
