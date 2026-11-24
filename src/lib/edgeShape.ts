/* ============================================================
   界面上「盒子外面」的弧线：贴边的凹弯、刘海的转角、两个把手（docs/边栏.md §3、§5.3、§6.2，
   技术方案 §9.6 的硬规定）。路径一律从这里来，不手写。

   转角用「曲率剖面」直接定义：曲率沿路程用 sin² 从 0 爬到 1/R，平一段（圆弧），再对称地落回 0，
   积分出形状。曲率和曲率的变化率在两端都是 0，接直边是 G3，眼睛看不到接缝（圆弧圆角在接点上
   曲率从 0 一下跳到 1/R）。R 是最小曲率半径，和 border-radius 一个意思；ξ 是爬坡占的比例：
     κ(s) = (1/R)·sin²(πs / 2Lr)   0 ≤ s < Lr
          = 1/R                    Lr ≤ s < Lr + Lp
          = 对称落回 0
     Lr = ξ·θ·R，Lp = (1−ξ)·θ·R，θ 是转角
   ξ = 0 就是普通圆角；90° 的角、ξ = 0.6 时吃掉的直边是 1.4907R。

   边栏的形状拆成几块刚体（EdgeChrome）：每块的路径在这里按 R、ξ 算一次缓存起来，伸缩时只平移。
   ============================================================ */

/** 平滑度：iOS 连续圆角、Figma 60% 的同一个位置（边栏.md §3.4） */
export const SMOOTHING = 0.6;
/** 贴边的凹弯（接窗口顶边、左边、底边） */
export const FLARE_RADIUS = 12;
/** 刘海、侧栏右下的凸角：刘海里选中块圆角 10 + 离刘海底边 6（同心） */
export const CONVEX_RADIUS = 16;
/** 片和片之间叠多少：同一个不透明的颜色，叠的地方看不出来；不叠的话 1.25 / 1.5 倍屏上露发丝缝 */
export const PIECE_OVERLAP = 2;

export interface CornerSample {
  x: number;
  y: number;
  /** 切线方向（弧度） */
  heading: number;
  /** 有向曲率：正的往 +heading 方向拐 */
  curvature: number;
}

export interface Corner {
  /** 从 (0, 0)、朝 +x 出发，转过 turn 的一串采样点（含两头） */
  samples: CornerSample[];
  /** 弧长 */
  length: number;
  /** 两条边各被吃掉多长（对称） */
  footprint: number;
  turn: number;
}

/** 采样步长（沿弧长）：0.25px，R=16 的 90° 角一百六十来个点 */
const STEP = 0.25;

const cache = new Map<string, Corner>();

/**
 * 一个转角：turn 是有向转角（屏幕坐标 y 朝下，正的顺时针拐），radius 是最小曲率半径，xi 是平滑度。
 * 按参数缓存，算一次不到 1ms
 */
export function corner(turn: number, radius: number, xi = SMOOTHING): Corner {
  const key = `${turn}|${radius}|${xi}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const theta = Math.abs(turn);
  const peak = Math.sign(turn) / radius;
  const ramp = xi * theta * radius;
  const plateau = (1 - xi) * theta * radius;
  const length = 2 * ramp + plateau;
  const curvatureAt = (s: number): number => {
    if (ramp <= 0) return peak;
    if (s < ramp) return peak * Math.sin((Math.PI * s) / (2 * ramp)) ** 2;
    if (s < ramp + plateau) return peak;
    return peak * Math.sin((Math.PI * Math.max(0, length - s)) / (2 * ramp)) ** 2;
  };
  const n = Math.max(16, Math.ceil(length / STEP));
  const ds = length / n;
  let x = 0;
  let y = 0;
  let heading = 0;
  const samples: CornerSample[] = [{ x, y, heading, curvature: curvatureAt(0) }];
  for (let i = 0; i < n; i++) {
    // 中点法：这一步的方向取步中间的切线
    const k = curvatureAt((i + 0.5) * ds);
    const mid = heading + (k * ds) / 2;
    x += Math.cos(mid) * ds;
    y += Math.sin(mid) * ds;
    heading += k * ds;
    samples.push({ x, y, heading, curvature: curvatureAt(Math.min(length, (i + 1) * ds)) });
  }
  const result = { samples, length, footprint: Math.abs(x), turn };
  cache.set(key, result);
  return result;
}

/** 90° 的角吃掉的直边（R 太小时采样点少，比例按 R=100 算：footprintOf(100) / 100 = 1.4907） */
export const footprintOf = (radius: number, xi = SMOOTHING) =>
  corner(Math.PI / 2, radius, xi).footprint;

/**
 * CSS 盒子的角（技术方案 §9.6）：border-radius 写 1.4907R 配 corner-shape: superellipse(1.58)，
 * 不支持 corner-shape 的引擎写 R。和 globals.css 的 --corner-scale 同一个数（styles/radius.test.ts 对着）
 */
export const CORNER_SCALE =
  typeof CSS !== "undefined" && CSS.supports?.("corner-shape", "superellipse(1.58)")
    ? footprintOf(100) / 100
    : 1;

/**
 * 圆角 R 在 border-radius 里写多少像素。只给 Motion 的 layoutId 元素用：它要在 style 里拿到像素值，
 * 换位置时宽高变了，缩放的那几帧才校正得回圆角（别处用 rounded-* 工具类）
 */
export const cornerRadius = (radius: number) => radius * CORNER_SCALE;

/** 路径里的数字：两位小数够了（1/100 px） */
const num = (value: number) => {
  const snapped = Math.round(value * 100) / 100;
  return Object.is(snapped, -0) ? "0" : String(snapped);
};

/**
 * 「海龟」画笔：走直线、拐转角，拼成 SVG 路径。转角每 4 个采样点（约 1px）落一个点
 */
export class Pen {
  private d: string;
  constructor(
    public x: number,
    public y: number,
    public heading: number,
  ) {
    this.d = `M${num(x)} ${num(y)}`;
  }
  lineTo(x: number, y: number): this {
    this.x = x;
    this.y = y;
    this.d += `L${num(x)} ${num(y)}`;
    return this;
  }
  turnCorner(c: Corner, every = 4): this {
    const cos = Math.cos(this.heading);
    const sin = Math.sin(this.heading);
    const { x: ox, y: oy } = this;
    const last = c.samples.length - 1;
    for (let i = 1; i <= last; i++) {
      if (i % every !== 0 && i !== last) continue;
      const p = c.samples[i]!;
      this.d += `L${num(ox + p.x * cos - p.y * sin)} ${num(oy + p.x * sin + p.y * cos)}`;
    }
    const end = c.samples[last]!;
    this.x = ox + end.x * cos - end.y * sin;
    this.y = oy + end.x * sin + end.y * cos;
    this.heading += c.turn;
    return this;
  }
  close(): string {
    return `${this.d}Z`;
  }
}

export interface PiecePath {
  d: string;
  /** 包住路径的盒子（局部坐标），svg 的 viewBox 和摆放位置都按它 */
  box: { x: number; y: number; w: number; h: number };
}

const piece = (d: string, x: number, y: number, w: number, h: number): PiecePath => ({
  d,
  box: { x, y, w, h },
});

const pieces = new Map<string, PiecePath>();
const memo = (key: string, build: () => PiecePath) => {
  const hit = pieces.get(key);
  if (hit) return hit;
  const made = build();
  pieces.set(key, made);
  return made;
};

/**
 * 贴边的凹弯：局部原点是两条边相交的那个角，一条边沿 +x（y = 0），一条沿 +y（x = 0），
 * 填的是角和弧线之间那一小块。往 −x、−y 各多叠 PIECE_OVERLAP（叠进旁边那块）。
 * 右上（顶边 + 侧栏右边）、左下（侧栏底边 + 窗口左边）都是它
 */
export function flarePath(radius = FLARE_RADIUS, xi = SMOOTHING): PiecePath {
  return memo(`flare|${radius}|${xi}`, () => {
    const c = corner(-Math.PI / 2, radius, xi);
    const fp = c.footprint;
    const o = PIECE_OVERLAP;
    const d = new Pen(-o, -o, 0).lineTo(fp, -o).lineTo(fp, 0);
    d.heading = Math.PI;
    d.turnCorner(c).lineTo(-o, fp);
    const size = Math.ceil(fp) + o;
    return piece(d.close(), -o, -o, size, size);
  });
}

/**
 * 侧栏拉到窗口底边时，右下角贴底边的凹弯：局部原点是侧栏右边和窗口底边的交点，
 * 侧栏的边沿 −y 往上，底边沿 +x 往右。往 −x 叠进侧栏，往 +y 伸到窗口外面
 */
export function bottomFlarePath(radius = FLARE_RADIUS, xi = SMOOTHING): PiecePath {
  return memo(`bottom|${radius}|${xi}`, () => {
    const c = corner(-Math.PI / 2, radius, xi);
    const fp = c.footprint;
    const o = PIECE_OVERLAP;
    const d = new Pen(-o, -fp, Math.PI / 2).lineTo(0, -fp);
    d.turnCorner(c).lineTo(fp, o).lineTo(-o, o);
    const size = Math.ceil(fp);
    return piece(d.close(), -o, -size, size + o, size + o);
  });
}

/**
 * 凸角（侧栏 / 刘海的右下角）：局部原点是这个角本来的顶点（右边和底边的延长线相交处），
 * 右边从上面下来、底边往左走。往上、往左各多叠 PIECE_OVERLAP，和上面、左边那两块接上
 */
export function convexCornerPath(radius = CONVEX_RADIUS, xi = SMOOTHING): PiecePath {
  return memo(`convex|${radius}|${xi}`, () => {
    const c = corner(Math.PI / 2, radius, xi);
    const fp = c.footprint;
    const size = Math.ceil(fp + PIECE_OVERLAP);
    const d = new Pen(-size, -size, 0).lineTo(0, -size).lineTo(0, -fp);
    d.heading = Math.PI / 2;
    d.turnCorner(c).lineTo(-size, 0);
    return piece(d.close(), -size, -size, size, size);
  });
}

/** 把手（平顶鼓包：收起以后从刘海底边探出来，§5.3；展开着时从侧栏右边缘鼓出来，§5.3.1）的尺寸 */
export const LIP = {
  /** 落下来的那一段（每边） */
  ramp: 18,
  /** 平顶 */
  flat: 30,
  /** 探出来多深 */
  depth: 11,
  /** 往上叠进刘海多少（藏着的时候整个缩在刘海里） */
  tuck: 4,
} as const;
/** 把手贴着刘海底边那一截有多宽：18 + 30 + 18 */
export const LIP_WIDTH = LIP.ramp * 2 + LIP.flat;

/** 五次「最小加加速度」曲线（smootherstep）：两端一阶、二阶导数都是 0，落下来的两头曲率为 0 */
export const smootherstep = (u: number) => u * u * u * (u * (6 * u - 15) + 10);

/**
 * 把手的轮廓：[沿着边, 往外] 一串点。沿着边以把手正中为 0；往外以边为 0，往里 tuck 叠进形状。
 * 两头用五次曲线从 0 落到 depth，中间平的
 */
function lipOutline(): [along: number, out: number][] {
  const { ramp, depth, tuck } = LIP;
  const half = LIP_WIDTH / 2;
  const o = PIECE_OVERLAP;
  const steps = 24;
  const points: [number, number][] = [
    [-half - o, -tuck],
    [-half - o, 0],
    [-half, 0],
  ];
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    points.push([-half + u * ramp, depth * smootherstep(u)]);
  }
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    points.push([half - ramp + u * ramp, depth * smootherstep(1 - u)]);
  }
  points.push([half + o, 0], [half + o, -tuck]);
  return points;
}

const outlinePath = (points: readonly (readonly [number, number])[]) =>
  `${points.map(([x, y], i) => `${i ? "L" : "M"}${num(x)} ${num(y)}`).join("")}Z`;

/**
 * 收起以后从刘海底边探出来的把手（§5.3）：局部原点在刘海底边、把手正中。
 * y = 0 是刘海底边，往下 depth 探出来，往上 tuck 叠进刘海
 */
export function lipPath(): PiecePath {
  return memo("lip", () => {
    const { depth, tuck } = LIP;
    const o = PIECE_OVERLAP;
    return piece(
      outlinePath(lipOutline()),
      -LIP_WIDTH / 2 - o,
      -tuck,
      LIP_WIDTH + o * 2,
      depth + tuck,
    );
  });
}

/**
 * 展开着时从侧栏右边缘鼓出来的把手（§5.3.1）：和 lipPath 同一个形状，竖过来。
 * 局部原点在侧栏右边缘、把手正中；x = 0 是右边缘，往右 depth 鼓出来，往左 tuck 叠进侧栏
 */
export function sideLipPath(): PiecePath {
  return memo("side-lip", () => {
    const { depth, tuck } = LIP;
    const o = PIECE_OVERLAP;
    const points = lipOutline().map(([along, out]) => [out, along] as const);
    return piece(outlinePath(points), -tuck, -LIP_WIDTH / 2 - o, depth + tuck, LIP_WIDTH + o * 2);
  });
}
