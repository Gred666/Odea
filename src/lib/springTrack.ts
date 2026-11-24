/* ============================================================
   把一段弹簧预先算成一串关键帧（Web Animations 用），让它在合成器上跑。

   为什么不用 Motion 的弹簧：Motion 每一帧在主线程上算、写 style。边栏的形状正好在切区的那一下伸缩，
   主线程这时候在挂新的一页（4 倍降速几十到一百多毫秒），一顿形状就跟着顿（Sidebar 以前开关插件时
   「左侧小图标会掉帧」是同一回事，docs/PITFALLS/动效.md）。关键帧交给合成器以后，主线程再忙也照常走。

   几个量一起动（宽、高）时各算各的弹簧，按同一个时间网格取样，拼成同一串关键帧。
   被打断时从当前的位置和速度接着算（valueAt / velocityAt），不跳、不顿。
   ============================================================ */

export interface SpringParams {
  stiffness: number;
  damping: number;
  mass?: number;
}

/** 关键帧的间隔（毫秒）：60Hz 一帧。中间由浏览器线性插值，弹簧这么平的曲线看不出折线 */
export const FRAME_MS = 1000 / 60;
/** 积分步长（秒） */
const SUBSTEP = 1 / 240;
/**
 * 差这么点、慢到这个速度就算停了。只给没有字的色块用（边栏的形状）：最后一下跳不到 0.05px，看不出来。
 * 带字的位移照技术方案 §10.1 第 4 条给 0.01
 */
const REST = 0.05;
/** 每秒不到 2px（一帧 0.03px）。按位置的阈值算速度的话（0.05px/s），尾巴要多拖半秒 */
const REST_SPEED = 2;
/** 最长算多久：弹簧参数写错了也不会算个没完 */
const LIMIT_MS = 2000;

export interface Track {
  /** 每一路在每个关键帧上的值；第一帧是起点，最后一帧正好是终点 */
  values: number[][];
  /** 每一路在每个关键帧上的速度（每秒） */
  velocities: number[][];
  /** 一共多长（毫秒）= (帧数 - 1) × FRAME_MS */
  duration: number;
}

/**
 * 几路弹簧同时从 from 走到 to（各带初速度 velocity），按 FRAME_MS 取样，直到每一路都停稳
 */
export function springTrack(
  from: readonly number[],
  to: readonly number[],
  velocity: readonly number[],
  { stiffness, damping, mass = 1 }: SpringParams,
): Track {
  const x = [...from];
  const v = from.map((_, i) => velocity[i] ?? 0);
  const values = from.map((value) => [value]);
  const velocities = v.map((value) => [value]);
  const settled = () =>
    x.every((value, i) => Math.abs(value - to[i]!) < REST && Math.abs(v[i]!) < REST_SPEED);
  let elapsed = 0;
  while (!settled() && elapsed < LIMIT_MS) {
    let left = FRAME_MS / 1000;
    while (left > 1e-9) {
      const h = Math.min(left, SUBSTEP);
      for (let i = 0; i < x.length; i++) {
        const a = (-stiffness * (x[i]! - to[i]!) - damping * v[i]!) / mass;
        v[i]! += a * h;
        x[i]! += v[i]! * h;
      }
      left -= h;
    }
    elapsed += FRAME_MS;
    for (let i = 0; i < x.length; i++) {
      values[i]!.push(x[i]!);
      velocities[i]!.push(v[i]!);
    }
  }
  // 最后一帧落在终点上（差的不到 REST）
  for (let i = 0; i < x.length; i++) {
    values[i]![values[i]!.length - 1] = to[i]!;
    velocities[i]![velocities[i]!.length - 1] = 0;
  }
  return { values, velocities, duration: (values[0]!.length - 1) * FRAME_MS };
}

const sampleAt = (series: readonly number[], ms: number): number => {
  if (ms <= 0) return series[0]!;
  const at = ms / FRAME_MS;
  const i = Math.floor(at);
  if (i >= series.length - 1) return series[series.length - 1]!;
  const t = at - i;
  return series[i]! * (1 - t) + series[i + 1]! * t;
};

/** 第 ms 毫秒时每一路走到了哪 */
export const valueAt = (track: Track, ms: number) => track.values.map((s) => sampleAt(s, ms));
/** 第 ms 毫秒时每一路的速度 */
export const velocityAt = (track: Track, ms: number) =>
  track.velocities.map((s) => sampleAt(s, ms));
