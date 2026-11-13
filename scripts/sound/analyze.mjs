// 读 WAV（PCM 16/24/32 位、float32），量：时长、峰值 dBFS、整体 RMS、最响 400ms 的 RMS、起音时间、频谱重心、各频段能量
import fs from "node:fs";
export function readWav(path) {
  const b = fs.readFileSync(path);
  let p = 12, fmt, data;
  while (p < b.length - 8) {
    const id = b.toString("ascii", p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === "fmt ") fmt = { format: b.readUInt16LE(p + 8), ch: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === "data") data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size & 1);
  }
  const bytes = fmt.bits / 8, n = Math.floor(data.length / bytes / fmt.ch), out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const o = (i * fmt.ch + c) * bytes;
      let v;
      if (fmt.format === 3) v = data.readFloatLE(o);
      else if (bytes === 2) v = data.readInt16LE(o) / 32768;
      else if (bytes === 3) v = data.readIntLE(o, 3) / 8388608;
      else v = data.readInt32LE(o) / 2147483648;
      s += v;
    }
    out[i] = s / fmt.ch;
  }
  return { rate: fmt.rate, x: out, fmt };
}
function fftMag(seg) {
  let n = 1; while (n < seg.length) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < seg.length; i++) re[i] = seg[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (seg.length - 1)));
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len; for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) { const c = Math.cos(a * k), s = Math.sin(a * k), ur = re[i + k], ui = im[i + k], vr = re[i + k + len / 2] * c - im[i + k + len / 2] * s, vi = re[i + k + len / 2] * s + im[i + k + len / 2] * c; re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi; } }
  const mag = new Float64Array(n / 2); for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]); return { mag, n };
}
export function analyze({ rate, x }) {
  const db = (v) => (20 * Math.log10(Math.max(v, 1e-9))).toFixed(1);
  let peak = 0, sum = 0; for (const v of x) { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
  // 有声的部分：从第一个超过峰值 -40dB 的采样到最后一个
  const th = peak * 0.01; let a = 0, z = x.length - 1; while (a < x.length && Math.abs(x[a]) < th) a++; while (z > a && Math.abs(x[z]) < th) z--;
  // 起音：从开始到包络第一次达到峰值 90%
  let atk = a; while (atk < x.length && Math.abs(x[atk]) < peak * 0.9) atk++;
  // 最响 400ms 窗口的 RMS
  const w = Math.round(rate * 0.4); let best = 0, acc = 0; for (let i = 0; i < x.length; i++) { acc += x[i] * x[i]; if (i >= w) acc -= x[i - w] * x[i - w]; best = Math.max(best, acc); }
  // 频谱：整段（有声部分）
  const seg = x.subarray(a, Math.min(z + 1, a + rate * 2)); const { mag, n } = fftMag(seg);
  let num = 0, den = 0; const bands = [[0, 300], [300, 700], [700, 2000], [2000, 4000], [4000, 8000], [8000, 24000]].map(() => 0);
  const edges = [300, 700, 2000, 4000, 8000, 1e9];
  for (let i = 1; i < mag.length; i++) { const f = i * rate / n, e = mag[i] * mag[i]; num += f * e; den += e; bands[edges.findIndex((x) => f < x)] += e; }
  // 主峰频率
  let pk = 1; for (let i = 1; i < mag.length; i++) if (mag[i] > mag[pk]) pk = i;
  return {
    时长秒: ((z - a) / rate).toFixed(2), 峰值dBFS: db(peak), 最响400msRMS: db(Math.sqrt(best / w)),
    起音ms: ((atk - a) / rate * 1000).toFixed(1), 重心Hz: Math.round(num / den), 主峰Hz: Math.round(pk * rate / n),
    频段占比: bands.map((e, i) => `${["<300", "300-700", "700-2k", "2-4k", "4-8k", ">8k"][i]}:${(e / den * 100).toFixed(0)}%`).join(" "),
  };
}
if (process.argv[1].endsWith("analyze.mjs")) for (const f of process.argv.slice(2)) console.log(f.split(/[\/]/).pop(), analyze(readWav(f)));
