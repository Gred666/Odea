import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * 界面字号、图标尺寸只用档位里的值（docs/排版规范.md §7、§10）。
 *
 * 2026-10-16 收过一轮，到 2026-10-28 又长回来六十多处 12.5px、11.5px 和 10.5、13.5 的图标：
 * 半像素的字在 Windows 100% 缩放下笔画发虚，档位一多，相邻的两块差半个像素，看着「说不上哪里不齐」。
 * 这里扫一遍组件源码，新写的不在档位里就挂。
 */

/** 字号档位。11 只给纯英文、数字（计数、周数、键帽） */
const TEXT_SIZES = new Set([11, 12, 13, 14, 15, 17, 19, 24, 30, 38]);
/** 图标档位：12 是最小的（Fluent 2：12px 的图标太小，不该用来点）；28 以上是空状态的插画 */
const ICON_SIZES = new Set([12, 14, 16, 18, 20, 24, 28, 32]);
/** 不是字的「字号」：表情选择器里一格一个 emoji 的大小。键是相对 src/ 的路径 */
const TEXT_EXEMPT: Record<string, number[]> = { "editor/EmojiPicker.tsx": [23] };

const SRC = join(__dirname, "..");

function sources(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".tsx") && !file.includes(".test."))
    .map((file) => file.replaceAll("\\", "/"));
}

function offScale(file: string, pattern: RegExp, allowed: Set<number>, exempt: number[] = []) {
  const source = readFileSync(join(SRC, file), "utf8");
  const hits: string[] = [];
  for (const [line, text] of source.split("\n").entries()) {
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1]);
      if (!allowed.has(value) && !exempt.includes(value))
        hits.push(`${file}:${line + 1} ${match[0]}`);
    }
  }
  return hits;
}

describe("界面尺寸档位", () => {
  const files = sources();

  it("finds the component sources", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("uses only font sizes on the scale", () => {
    const hits = files.flatMap((file) =>
      offScale(file, /text-\[(\d+(?:\.\d+)?)px\]/g, TEXT_SIZES, TEXT_EXEMPT[file]),
    );
    expect(hits).toEqual([]);
  });

  it("uses only icon sizes on the scale", () => {
    const hits = files.flatMap((file) => offScale(file, /\bsize=\{(\d+(?:\.\d+)?)\}/g, ICON_SIZES));
    expect(hits).toEqual([]);
  });
});
