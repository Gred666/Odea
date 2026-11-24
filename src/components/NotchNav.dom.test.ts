// @vitest-environment happy-dom

import { LIST_WIDTH, NOTCH_MAX_CELLS, notchWidth } from "@/app/store";
import { FolderTree } from "lucide-react";
import { describe, expect, it } from "vitest";
import { type NavCell, notchCells, playIconMotion } from "./NotchNav";

/*
 * 刘海按格子数收放、第 7 项起收进「⋯」（docs/边栏.md §4.3、§7 第 4 条）。
 * 现在最多 6 项（文件、今日TODO、/GOAL、日历、归档、扩展），第 7 项是「模拟多一项」
 */

const items = (n: number): NavCell[] =>
  Array.from({ length: n }, (_, i) => ({ id: `item-${i}`, label: `第 ${i} 项`, icon: FolderTree }));

describe("刘海里的格子", () => {
  it("is as wide as §4.3 says for 2, 3, 5 and 6 cells, and never wider than the side panel", () => {
    expect([2, 3, 5, 6].map(notchWidth)).toEqual([136, 176, 256, 296]);
    expect(notchWidth(NOTCH_MAX_CELLS)).toBeLessThanOrEqual(LIST_WIDTH);
  });

  it("draws every item while they fit", () => {
    for (const n of [2, 3, 5, 6]) {
      const { cells, overflow } = notchCells(items(n));
      expect(cells.map((cell) => cell.id)).toEqual(items(n).map((item) => item.id));
      expect(overflow).toEqual([]);
    }
  });

  it("from the 7th item on, turns the 6th cell into ⋯ and puts the rest in its menu", () => {
    for (const n of [7, 8]) {
      const { cells, overflow } = notchCells(items(n));
      expect(cells).toHaveLength(NOTCH_MAX_CELLS);
      expect(cells.slice(0, 5).map((cell) => cell.id)).toEqual(items(5).map((item) => item.id));
      expect(cells[5]!.id).toBe("more");
      expect(overflow.map((item) => item.id)).toEqual(
        items(n)
          .slice(5)
          .map((item) => item.id),
      );
    }
  });
});

describe("图标的签名动作（playIconMotion）", () => {
  /** 记下每一次 animate 的关键帧和选项，不真的放 */
  const fake = () => {
    const calls: { keyframes: PropertyIndexedKeyframes; options: KeyframeAnimationOptions }[] = [];
    const el = {
      animate: (keyframes: PropertyIndexedKeyframes, options: KeyframeAnimationOptions) => {
        calls.push({ keyframes, options });
        return {} as Animation;
      },
    } as unknown as HTMLElement;
    return { el, calls };
  };

  it("puts rotate and scale on the compositor as CSS individual transform properties, each segment ease-in-out", () => {
    const { el, calls } = fake();
    playIconMotion(el, {
      rotate: [0, -12, 6, 0],
      scale: [1, 1.1, 1],
      transition: { duration: 0.42 },
    });
    expect(calls.map((call) => call.keyframes)).toEqual([
      { rotate: ["0deg", "-12deg", "6deg", "0deg"], easing: "ease-in-out" },
      { scale: ["1", "1.1", "1"], easing: "ease-in-out" },
    ]);
    expect(calls.every((call) => call.options.duration === 420)).toBe(true);
  });

  it("turns scaleY into a two-value scale and y into translate", () => {
    const { el, calls } = fake();
    playIconMotion(el, {
      scaleY: [1, 0.74, 1.08, 1],
      y: [0, 2, 0],
      transition: { duration: 0.46 },
    });
    expect(calls.map((call) => call.keyframes)).toEqual([
      { scale: ["1 1", "1 0.74", "1 1.08", "1 1"], easing: "ease-in-out" },
      { translate: ["0px 0px", "0px 2px", "0px 0px"], easing: "ease-in-out" },
    ]);
  });

  it("does nothing where the element cannot animate (no Web Animations)", () => {
    expect(playIconMotion({} as HTMLElement, { scale: [1, 1.1, 1] })).toEqual([]);
  });
});
