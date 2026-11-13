// 实验用的「机器写的字」：数字和运算符的笔画，带一点随机的歪斜、大小、抖动。
// 不是真人的字 —— 没有笔的机器上只能先这样，量出来的是上限，不是真实的准确率。
// 坐标：一个字占宽 w、高 1 的格子，y 朝下。每一笔是几个控制点，用 Catmull-Rom 连成曲线。

/** 每个字：{ w, strokes: [[ [x, y], … ], … ] } */
export const GLYPHS = {
  0: { w: 0.6, strokes: [[[0.32, 0.02], [0.12, 0.2], [0.06, 0.5], [0.12, 0.82], [0.3, 0.99], [0.48, 0.82], [0.55, 0.5], [0.48, 0.18], [0.3, 0.02]]] },
  1: { w: 0.4, strokes: [[[0.06, 0.24], [0.24, 0.02], [0.24, 0.5], [0.24, 1.0]]] },
  2: { w: 0.6, strokes: [[[0.08, 0.22], [0.2, 0.05], [0.4, 0.03], [0.52, 0.2], [0.44, 0.44], [0.24, 0.72], [0.08, 0.98], [0.3, 0.97], [0.56, 0.97]]] },
  3: { w: 0.6, strokes: [[[0.1, 0.12], [0.3, 0.01], [0.5, 0.14], [0.46, 0.36], [0.26, 0.47], [0.48, 0.6], [0.52, 0.84], [0.3, 1.0], [0.08, 0.9]]] },
  4: { w: 0.62, strokes: [[[0.42, 0.02], [0.24, 0.32], [0.05, 0.66], [0.3, 0.66], [0.6, 0.66]], [[0.44, 0.3], [0.44, 0.65], [0.44, 1.0]]] },
  5: { w: 0.6, strokes: [[[0.16, 0.03], [0.13, 0.24], [0.12, 0.45], [0.34, 0.38], [0.53, 0.55], [0.52, 0.84], [0.3, 1.0], [0.06, 0.9]], [[0.16, 0.03], [0.36, 0.03], [0.55, 0.02]]] },
  6: { w: 0.6, strokes: [[[0.48, 0.04], [0.24, 0.24], [0.09, 0.58], [0.14, 0.9], [0.32, 1.0], [0.5, 0.86], [0.48, 0.62], [0.3, 0.52], [0.12, 0.66]]] },
  7: { w: 0.6, strokes: [[[0.06, 0.03], [0.32, 0.03], [0.56, 0.03], [0.4, 0.5], [0.26, 1.0]]] },
  8: { w: 0.6, strokes: [[[0.46, 0.16], [0.3, 0.01], [0.13, 0.15], [0.2, 0.37], [0.42, 0.6], [0.5, 0.83], [0.3, 1.0], [0.1, 0.84], [0.2, 0.58], [0.42, 0.34], [0.48, 0.13]]] },
  9: { w: 0.6, strokes: [[[0.5, 0.2], [0.32, 0.01], [0.12, 0.16], [0.16, 0.42], [0.34, 0.47], [0.5, 0.3], [0.5, 0.1], [0.5, 0.6], [0.42, 1.0]]] },
  "+": { w: 0.6, strokes: [[[0.05, 0.52], [0.3, 0.52], [0.55, 0.52]], [[0.3, 0.27], [0.3, 0.52], [0.3, 0.77]]] },
  "-": { w: 0.55, strokes: [[[0.06, 0.52], [0.28, 0.52], [0.5, 0.52]]] },
  "×": { w: 0.6, strokes: [[[0.1, 0.32], [0.3, 0.52], [0.5, 0.72]], [[0.5, 0.32], [0.3, 0.52], [0.1, 0.72]]] },
  "÷": { w: 0.6, strokes: [[[0.05, 0.52], [0.3, 0.52], [0.55, 0.52]], [[0.29, 0.3], [0.31, 0.32]], [[0.29, 0.72], [0.31, 0.74]]] },
  "=": { w: 0.6, strokes: [[[0.06, 0.42], [0.3, 0.42], [0.54, 0.42]], [[0.06, 0.62], [0.3, 0.62], [0.54, 0.62]]] },
  "(": { w: 0.32, strokes: [[[0.26, 0.0], [0.1, 0.25], [0.06, 0.5], [0.1, 0.78], [0.26, 1.04]]] },
  ")": { w: 0.32, strokes: [[[0.06, 0.0], [0.22, 0.25], [0.26, 0.5], [0.22, 0.78], [0.06, 1.04]]] },
  ".": { w: 0.22, strokes: [[[0.1, 0.95], [0.12, 0.97]]] },
  "/": { w: 0.5, strokes: [[[0.44, 0.04], [0.25, 0.5], [0.06, 0.98]]] },
};

/** 可重复的随机数 */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 控制点 → 光滑的折线（Catmull-Rom），每段 steps 个点 */
export function smooth(points, steps = 6) {
  if (points.length < 3) return points.map((p) => [...p]);
  const out = [];
  const at = (i) => points[Math.max(0, Math.min(points.length - 1, i))];
  for (let i = 0; i < points.length - 1; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const f = (k) =>
        0.5 *
        (2 * p1[k] +
          (-p0[k] + p2[k]) * t +
          (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t * t +
          (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t * t * t);
      out.push([f(0), f(1)]);
    }
  }
  out.push([...points.at(-1)]);
  return out;
}

/**
 * 把一行字写成笔画：返回 { strokes: [[ [x, y], … ], … ], symbols: [{ char, strokes: [下标…] }], width }。
 * height 是字高（返回的坐标单位），messy 0–1 越大越潦草。
 */
export function write(text, { seed = 1, height = 100, messy = 0.5 } = {}) {
  const random = rng(seed);
  const jitter = (amount) => (random() * 2 - 1) * amount * messy;
  const slant = 0.12 + jitter(0.2);
  const strokes = [];
  const symbols = [];
  let pen = 0;
  for (const char of text) {
    if (char === " ") {
      pen += 0.4;
      continue;
    }
    const glyph = GLYPHS[char];
    if (!glyph) throw new Error(`没有这个字：${char}`);
    const scale = 1 + jitter(0.12);
    const lift = jitter(0.06);
    const indexes = [];
    for (const stroke of glyph.strokes) {
      const controls = stroke.map(([x, y]) => [x + jitter(0.025), y + jitter(0.025)]);
      const line = smooth(controls).map(([x, y]) => {
        const yy = (y - 1) * scale + 1 + lift;
        const xx = pen + x * scale + (1 - yy) * slant;
        return [(xx + jitter(0.004)) * height, (yy + jitter(0.004)) * height];
      });
      indexes.push(strokes.length);
      strokes.push(line);
    }
    symbols.push({ char, strokes: indexes });
    pen += glyph.w * scale + 0.16 + jitter(0.06);
  }
  return { strokes, symbols, width: pen * height };
}
