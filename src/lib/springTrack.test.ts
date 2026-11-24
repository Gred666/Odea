import { describe, expect, it } from "vitest";
import { FRAME_MS, springTrack, valueAt, velocityAt } from "./springTrack";

/* 边栏的伸缩：弹簧预先算成关键帧（docs/边栏.md §5.2，刚度 260、阻尼 32） */

const EDGE = { stiffness: 260, damping: 32 };

describe("springTrack", () => {
  it("starts at the start, ends exactly at the target and settles in a few hundred ms", () => {
    const track = springTrack([48, 296], [900, 300], [0, 0], EDGE);
    expect(valueAt(track, 0)).toEqual([48, 296]);
    expect(valueAt(track, track.duration)).toEqual([900, 300]);
    expect(track.duration).toBeGreaterThan(200);
    expect(track.duration).toBeLessThan(900);
    expect(track.values[0]!.length).toBe(Math.round(track.duration / FRAME_MS) + 1);
  });

  it("barely overshoots (damping ratio ≈ 1)", () => {
    const track = springTrack([0], [100], [0], EDGE);
    expect(Math.max(...track.values[0]!)).toBeLessThan(100.5);
  });

  it("picks up where it was, at the speed it had, when retargeted mid-way", () => {
    const first = springTrack([48], [900], [0], EDGE);
    const at = 120;
    const [x] = valueAt(first, at);
    const [v] = velocityAt(first, at);
    expect(v).toBeGreaterThan(0);
    const second = springTrack([x!], [48], [v!], EDGE);
    expect(valueAt(second, 0)[0]).toBeCloseTo(x!, 6);
    // 接着往下长了一小段才掉头：速度是接上的
    expect(second.values[0]![1]!).toBeGreaterThan(x!);
    expect(valueAt(second, second.duration)[0]).toBe(48);
  });

  it("is a single frame when nothing has to move", () => {
    const track = springTrack([300], [300], [0], EDGE);
    expect(track.duration).toBe(0);
  });
});
