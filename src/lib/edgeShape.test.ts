import { describe, expect, it } from "vitest";
import {
  CONVEX_RADIUS,
  FLARE_RADIUS,
  LIP,
  LIP_WIDTH,
  bottomFlarePath,
  convexCornerPath,
  corner,
  flarePath,
  footprintOf,
  lipPath,
  sideLipPath,
  smootherstep,
} from "./edgeShape";

/*
 * 边栏的弧线（docs/边栏.md §3、§7 第 2 条，技术方案 §9.6）：曲率在两端为 0、一路没有跳变、
 * 占掉的直边和 §3.3 那张表对得上。转角要是被改回圆弧（ξ = 0），第二条就挂：直边接圆弧的那一点
 * 曲率从 0 一下跳到 1/R
 */

/** 路径里的点：M、L 后面那一对对数 */
const pointsOf = (d: string) =>
  [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(([, x, y]) => ({ x: Number(x), y: Number(y) }));

describe("曲率剖面转角", () => {
  for (const [radius, turn] of [
    [FLARE_RADIUS, -Math.PI / 2],
    [CONVEX_RADIUS, Math.PI / 2],
  ] as const) {
    it(`R=${radius}: curvature is zero at both ends`, () => {
      const { samples } = corner(turn, radius);
      expect(Math.abs(samples[0]!.curvature)).toBe(0);
      expect(Math.abs(samples.at(-1)!.curvature)).toBeLessThan(1e-9);
    });

    it(`R=${radius}: curvature never jumps (neighbouring samples differ by ≤ 8% of the peak)`, () => {
      const { samples } = corner(turn, radius);
      const peak = Math.max(...samples.map((s) => Math.abs(s.curvature)));
      // 最小曲率半径就是 R
      expect(1 / peak).toBeCloseTo(radius, 6);
      for (let i = 1; i < samples.length; i++) {
        expect(Math.abs(samples[i]!.curvature - samples[i - 1]!.curvature)).toBeLessThanOrEqual(
          peak * 0.08,
        );
      }
    });

    it(`R=${radius}: turns exactly by the corner angle and is symmetric`, () => {
      const c = corner(turn, radius);
      const end = c.samples.at(-1)!;
      expect(end.heading).toBeCloseTo(turn, 5);
      // 两条边吃掉的一样长
      expect(Math.abs(end.y)).toBeCloseTo(Math.abs(end.x), 3);
    });
  }

  it("eats the straight edge the table in 边栏.md §3.3 says", () => {
    expect(footprintOf(12)).toBeCloseTo(17.9, 1);
    expect(footprintOf(16)).toBeCloseTo(23.9, 1);
    expect(footprintOf(20)).toBeCloseTo(29.8, 1);
    // 90° 的角吃掉 1.4907R（技术方案 §9.6；CSS 盒子的四个角按它放大 border-radius）
    expect(footprintOf(10) / 10).toBeCloseTo(1.4907, 3);
  });

  it("is a plain circular corner at ξ = 0, not a smoothed one", () => {
    expect(footprintOf(12, 0)).toBeCloseTo(12, 2);
    const { samples } = corner(Math.PI / 2, 12, 0);
    // 圆弧：曲率处处是 1/R，接直边的那一点从 0 跳上去
    expect(samples[0]!.curvature).toBeCloseTo(1 / 12, 9);
  });

  it("caches by parameters", () => {
    expect(corner(Math.PI / 2, 16)).toBe(corner(Math.PI / 2, 16));
  });
});

describe("边栏的几块", () => {
  const fl = footprintOf(FLARE_RADIUS);
  const cv = footprintOf(CONVEX_RADIUS);

  it("the flare runs from one edge to the other and stays inside its box", () => {
    const { d, box } = flarePath();
    const points = pointsOf(d);
    // 从 +x 那条边上 fp 处落下来，落到 +y 那条边上 fp 处
    expect(points).toContainEqual({ x: Number(fl.toFixed(2)), y: 0 });
    expect(points).toContainEqual({ x: 0, y: Number(fl.toFixed(2)) });
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(box.x);
      expect(p.y).toBeGreaterThanOrEqual(box.y);
      expect(p.x).toBeLessThanOrEqual(box.x + box.w);
      expect(p.y).toBeLessThanOrEqual(box.y + box.h);
    }
  });

  it("the convex corner leaves the right edge and lands on the bottom edge", () => {
    const { d, box } = convexCornerPath();
    const points = pointsOf(d);
    expect(points).toContainEqual({ x: 0, y: -Number(cv.toFixed(2)) });
    expect(points).toContainEqual({ x: -Number(cv.toFixed(2)), y: 0 });
    // 盒子往上、往左多叠了一截，接上面那一列和左边那一块
    expect(box.x).toBeLessThanOrEqual(-cv - 2);
    expect(box.y).toBeLessThanOrEqual(-cv - 2);
    for (const p of points) {
      expect(p.x).toBeLessThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(0);
    }
  });

  it("the bottom flare meets the window's bottom edge", () => {
    const points = pointsOf(bottomFlarePath().d);
    expect(points).toContainEqual({ x: 0, y: -Number(fl.toFixed(2)) });
    expect(points).toContainEqual({ x: Number(fl.toFixed(2)), y: 0 });
  });

  it("the lip is a flat-topped bump as wide and deep as 边栏.md §5.3 says", () => {
    const points = pointsOf(lipPath().d);
    const below = points.filter((p) => p.y >= 0);
    const xs = below.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(LIP_WIDTH + 4, 6);
    expect(Math.max(...points.map((p) => p.y))).toBe(LIP.depth);
    expect(LIP_WIDTH).toBe(66);
  });

  it("the side lip (§5.3.1) is the same bump stood upright, bulging out to the right", () => {
    const lip = lipPath();
    const side = sideLipPath();
    // 把刘海底下那个的每个点 (x, y) 换成 (y, x)，就是侧栏右边那个
    expect(pointsOf(side.d)).toEqual(pointsOf(lip.d).map(({ x, y }) => ({ x: y, y: x })));
    expect(side.box).toEqual({ x: lip.box.y, y: lip.box.x, w: lip.box.h, h: lip.box.w });
    const out = pointsOf(side.d).filter((p) => p.x >= 0);
    expect(Math.max(...out.map((p) => p.x))).toBe(LIP.depth);
    const ys = out.map((p) => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(LIP_WIDTH + 4, 6);
  });

  it("the lip falls with zero slope and curvature at both ends of each ramp", () => {
    const h = 1e-4;
    const slope = (u: number) => (smootherstep(u + h) - smootherstep(u - h)) / (2 * h);
    const bend = (u: number) =>
      (smootherstep(u + h) - 2 * smootherstep(u) + smootherstep(u - h)) / (h * h);
    for (const u of [h, 1 - h]) {
      expect(Math.abs(slope(u))).toBeLessThan(1e-3);
      expect(Math.abs(bend(u))).toBeLessThan(1e-2);
    }
  });
});
