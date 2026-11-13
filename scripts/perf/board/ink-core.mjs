// 墨迹的几样基本功（实验 3 用，浏览器和 Node 里都能跑）：
// 采样 → 变宽的轮廓；轮廓 → SVG 路径；原始采样的紧凑编码；把一条折线变成「像是笔写出来的」带时间和压感的采样。

/**
 * 一条折线（[x, y]…）→ 笔的采样（[x, y, 压感 0–1, 毫秒]…）。
 * 写字的速度按每秒 speed 像素算，采样率 hz；压感起笔轻、中间重、收笔轻。
 */
export function penSamples(line, { hz = 240, speed = 260, random = Math.random } = {}) {
  let length = 0;
  const at = [0];
  for (let i = 1; i < line.length; i++) {
    length += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    at.push(length);
  }
  const duration = Math.min(1.2, Math.max(0.06, length / speed));
  const count = Math.max(2, Math.round(duration * hz));
  const out = [];
  let seg = 1;
  for (let k = 0; k < count; k++) {
    const u = k / (count - 1);
    const d = u * length;
    while (seg < at.length - 1 && at[seg] < d) seg++;
    const span = at[seg] - at[seg - 1] || 1;
    const f = (d - at[seg - 1]) / span;
    const x = line[seg - 1][0] + (line[seg][0] - line[seg - 1][0]) * f;
    const y = line[seg - 1][1] + (line[seg][1] - line[seg - 1][1]) * f;
    const pressure = Math.min(1, Math.max(0.05, 0.25 + 0.6 * Math.sin(Math.PI * u) ** 0.6 + (random() - 0.5) * 0.06));
    out.push([x, y, pressure, Math.round(u * duration * 1000)]);
  }
  return out;
}

/** 采样 → 轮廓多边形（[x, y]…）：两边各偏出半个笔宽，两头补半圆。size 是最粗处的直径 */
export function outline(samples, size = 3) {
  const n = samples.length;
  if (n === 0) return [];
  const radius = (p) => (size / 2) * (0.35 + 0.65 * p);
  if (n === 1) return circle(samples[0][0], samples[0][1], radius(samples[0][2]), 8);
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    const a = samples[Math.max(0, i - 1)];
    const b = samples[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const r = radius(samples[i][2]);
    left.push([samples[i][0] - dy * r, samples[i][1] + dx * r]);
    right.push([samples[i][0] + dy * r, samples[i][1] - dx * r]);
  }
  const cap = (center, from, steps = 4) => {
    const r = Math.hypot(from[0] - center[0], from[1] - center[1]);
    const start = Math.atan2(from[1] - center[1], from[0] - center[0]);
    const out = [];
    for (let s = 1; s < steps; s++) {
      const angle = start + (Math.PI * s) / steps;
      out.push([center[0] + Math.cos(angle) * r, center[1] + Math.sin(angle) * r]);
    }
    return out;
  };
  return [...left, ...cap(samples[n - 1], left[n - 1]), ...right.reverse(), ...cap(samples[0], right[n - 1])];
}

function circle(x, y, r, steps) {
  const out = [];
  for (let s = 0; s < steps; s++) out.push([x + Math.cos((2 * Math.PI * s) / steps) * r, y + Math.sin((2 * Math.PI * s) / steps) * r]);
  return out;
}

/** Ramer–Douglas–Peucker：离直线不到 tolerance 的点去掉 */
export function simplify(points, tolerance = 0.2) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let worst = 0;
    let index = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((points[i][0] - ax) * (by - ay) - (points[i][1] - ay) * (bx - ax)) / len;
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (worst > tolerance) {
      keep[index] = 1;
      stack.push([a, index], [index, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const fmt = (v) => {
  const s = (Math.round(v * 10) / 10).toString();
  return s.startsWith("0.") ? s.slice(1) : s.startsWith("-0.") ? `-${s.slice(2)}` : s;
};

/** 多边形 → SVG 的 d：第一个点绝对坐标，后面用相对的 l，保留一位小数 */
export function pathData(points) {
  if (!points.length) return "";
  let d = `M${fmt(points[0][0])} ${fmt(points[0][1])}l`;
  let px = Math.round(points[0][0] * 10) / 10;
  let py = Math.round(points[0][1] * 10) / 10;
  for (let i = 1; i < points.length; i++) {
    const x = Math.round(points[i][0] * 10) / 10;
    const y = Math.round(points[i][1] * 10) / 10;
    const dy = fmt(y - py);
    d += `${i > 1 ? " " : ""}${fmt(x - px)}${dy.startsWith("-") ? "" : " "}${dy}`;
    px = x;
    py = y;
  }
  return `${d}z`;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * 原始采样的紧凑编码：x、y 量化到 1/8 像素、压感到 0–63、时间到毫秒，都存和上一个采样的差，
 * 之字形变长整数，6 位一组写成 base64url。读回来用 decodeRaw
 */
export function encodeRaw(samples) {
  const groups = [];
  const put = (value) => {
    let v = value < 0 ? -value * 2 - 1 : value * 2;
    do {
      const low = v & 31;
      v = Math.floor(v / 32);
      groups.push(low | (v > 0 ? 32 : 0));
    } while (v > 0);
  };
  let px = 0;
  let py = 0;
  let pp = 0;
  let pt = 0;
  for (const [x, y, p, t] of samples) {
    const qx = Math.round(x * 8);
    const qy = Math.round(y * 8);
    const qp = Math.round(p * 63);
    put(qx - px);
    put(qy - py);
    put(qp - pp);
    put(t - pt);
    px = qx;
    py = qy;
    pp = qp;
    pt = t;
  }
  let out = "";
  for (const g of groups) out += B64[g];
  return out;
}

export function decodeRaw(text) {
  const values = [];
  let v = 0;
  let shift = 1;
  for (const ch of text) {
    const g = B64.indexOf(ch);
    v += (g & 31) * shift;
    if (g & 32) shift *= 32;
    else {
      values.push(v % 2 ? -(v + 1) / 2 : v / 2);
      v = 0;
      shift = 1;
    }
  }
  const out = [];
  let x = 0;
  let y = 0;
  let p = 0;
  let t = 0;
  for (let i = 0; i + 3 < values.length; i += 4) {
    x += values[i];
    y += values[i + 1];
    p += values[i + 2];
    t += values[i + 3];
    out.push([x / 8, y / 8, p / 63, t]);
  }
  return out;
}
