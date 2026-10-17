import { readFileSync } from "node:fs";
import { join } from "node:path";
import { popoverCard } from "@/lib/motion";
import { describe, expect, it } from "vitest";

/*
 * 贴着光标弹出、盖在正文上的浮层（Ctrl+E 表情选择器、/模板 模板选择器）：
 * 卡片从光标那条边展开，里面的字从第一帧起就在最终位置上，不缩放、不变透明。
 *
 * 踩过的两个坑：
 * - 整块从透明淡入：前 100ms 里半透明的表情格子和底下的正文一行行叠在一起，用户看到的
 *   是「打开的时候正文跳了一下」—— 实机录屏里正文一个像素都没动过，动的是这层叠影
 * - 卡片 scale 0.97 → 1：带字的层被当成位图拉伸，打开那 200ms 里字是糊的，动画结束撤掉
 *   transform 的那一帧重新画，字一下变清楚还挪一点 ——「先糊、再抖一下」
 */

type Target = Record<string, unknown>;
const resolve = (variant: unknown, custom?: unknown): Target =>
  (typeof variant === "function" ? variant(custom, {}, {}) : variant) as Target;
const TRANSFORMS = ["scale", "scaleX", "scaleY", "x", "y", "rotate", "transform"];

/** cubic-bezier 缓动在时间进度 x 处的值（二分找参数 t） */
function cubicBezier([x1, y1, x2, y2]: [number, number, number, number], x: number): number {
  const at = (a: number, b: number, t: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (at(x1, x2, mid) < x) lo = mid;
    else hi = mid;
  }
  return at(y1, y2, lo);
}

describe("盖在正文上的浮层", () => {
  it("never fades or scales the card in: it is opaque and full size from the first frame", () => {
    for (const target of [resolve(popoverCard.hidden, 42), resolve(popoverCard.shown)]) {
      expect(target).not.toHaveProperty("opacity");
      for (const key of TRANSFORMS) expect(target).not.toHaveProperty(key);
    }
  });

  it("unfolds from the caret-side bar to the content's own height", () => {
    expect(resolve(popoverCard.hidden, 42).height).toBe(42);
    expect(resolve(popoverCard.hidden, 34).height).toBe(34);
    expect(resolve(popoverCard.shown).height).toBe("auto");
  });

  it("folds back into the caret edge and only fades the last sliver", () => {
    const gone = resolve(popoverCard.gone);
    expect(gone.height).toBe(0);
    for (const key of TRANSFORMS) expect(gone).not.toHaveProperty(key);
    // 前一段完全不透明，收到只剩空白边（不到 10px）才淡掉 —— 早淡的话，半透明的那一条
    // 带着搜索栏的字叠在光标那一行正文上
    expect(gone.opacity).toEqual([1, 1, 0]);
    const transition = gone.transition as {
      ease: [number, number, number, number];
      opacity: { times: number[] };
    };
    const fadeFrom = transition.opacity.times[1]!;
    expect(398 * (1 - cubicBezier(transition.ease, fadeFrom))).toBeLessThanOrEqual(10);
  });

  for (const file of ["EmojiPicker.tsx", "TemplatePicker.tsx"]) {
    it(`${file} pins the caret edge and keeps the content static`, () => {
      const source = readFileSync(join(__dirname, file), "utf8");
      const start = source.indexOf('role="dialog"');
      const panel = source.slice(start, source.indexOf("</motion.div>", start));
      expect(panel).toContain("variants={popoverCard}");
      expect(panel).toMatch(/custom=\{place\.above \? FOOTER_HEIGHT : (SEARCH|HEADER)_HEIGHT\}/);
      expect(panel).toContain("...pinnedEdge(anchor, place)");
      // 往上开时内容贴着下边排，展开时露出来的是贴着光标的那一头
      expect(panel).toContain('place.above && "justify-end"');
      // hidden 还是滚动容器：展开途中 scrollIntoView 会把内容卷上去
      expect(panel).toContain("overflow-clip");
      expect(panel).not.toContain("transformOrigin");
      // 内容是普通 div：不带自己的入场动画
      expect(panel).toContain('<div ref={contentRef} className="shrink-0">');
    });
  }
});

/*
 * 带字的浮层、提示条、按钮一律不缩放。缩放（以及合成器上的位移）会让整层字被当成位图
 * 重采样：动画里发虚，结束那一帧回到正常绘制时字一下变清楚、还挪一点。2026-10-06 用
 * 1.5 倍屏十倍慢放逐帧查过：命令面板、下拉菜单、悬停卡片、三种提示条、日历「今天」
 * 都是这样；只动 opacity 的版本从头到尾和最终画面一致。
 */
describe("带字的元素不缩放", () => {
  const src = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");

  it("the command palette unfolds like the pickers instead of scaling", () => {
    const source = src("components/CommandPalette.tsx");
    const start = source.indexOf('aria-label="命令面板"');
    const dialog = source.slice(start, source.indexOf("onKeyDown", start));
    expect(dialog).toContain("variants={popoverCard}");
    expect(dialog).toContain("overflow-clip");
    expect(source).not.toMatch(/scale:\s*0?\.\d/);
  });

  for (const path of [
    "components/UndoToast.tsx",
    "components/ErrorToast.tsx",
    "components/ListColumn.tsx",
    "views/CalendarView.tsx",
  ]) {
    it(`${path} never animates scale`, () => {
      expect(src(path)).not.toMatch(/scale:\s*0?\.\d/);
    });
  }

  it("dropdown menus and hover cards only fade", () => {
    const css = src("styles/globals.css");
    for (const name of [
      "odea-menu-in",
      "odea-menu-out",
      "odea-hovercard-in",
      "odea-hovercard-out",
    ]) {
      const start = css.indexOf(`@keyframes ${name} `);
      expect(start).toBeGreaterThan(-1);
      const body = css.slice(start, css.indexOf("\n}", start));
      expect(body).toContain("opacity");
      expect(body).not.toContain("transform");
    }
  });
});
