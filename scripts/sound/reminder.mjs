/* ============================================================
   提醒的提示音（docs/提醒与属性.md §2）：用加法合成算出来，写成 src-tauri/sounds/*.wav（16 位单声道 32kHz）。
   改了参数重新跑：node scripts/sound/reminder.mjs，再用 analyze 量一遍：
     node scripts/sound/reminder.mjs --analyze

   定下来的几条（§2.2 有出处）：
   - 两三个音的小旋律，音程协和（纯五度、大三度），上行：「轻轻拍一下肩」，不是警报
   - 基频 520–880 Hz：笔记本的小喇叭放得出来；能量压在 2 kHz 以下（尖锐度是听着烦的头号原因），
     泛音少、衰减快，不用纯正弦（纯音比复合音更招人烦）
   - 起音 5–8 ms：有个清楚的头，不像 Windows 自带的那几声慢慢涌上来、在别的声音里容易听漏；
     衰减按指数走，整段 1.3–1.5 秒
   - 响度和 Windows 自带的通知声一个量级：最响 400ms 的 RMS 约 -23 dBFS，峰值不超过 -11 dBFS
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 32000;
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "../../src-tauri/sounds");

/** 一个音：几条分音，各自起音后按指数衰减 */
function note(buf, { freq, at, gain, partials, attack = 0.006 }) {
  const start = Math.round(at * RATE);
  for (const [ratio, amp, tau] of partials) {
    const f = freq * ratio;
    if (f > RATE / 2.2) continue;
    const len = Math.min(buf.length - start, Math.round(tau * 9 * RATE));
    const w = (2 * Math.PI * f) / RATE;
    // 每条分音的初相错开一点，几个音叠在一起时起音不会撞成一个尖峰
    const phase = ratio * 1.7;
    for (let i = 0; i < len; i++) {
      const t = i / RATE;
      const env = (t < attack ? 0.5 - 0.5 * Math.cos((Math.PI * t) / attack) : 1) * Math.exp(-t / tau);
      buf[start + i] += gain * amp * env * Math.sin(w * i + phase);
    }
  }
}

/** 一点点房间感：Schroeder 混响（4 个梳状 + 2 个全通），湿声先过一道低通，不添尖 */
function reverb(dry, wet = 0.14) {
  const out = Float64Array.from(dry);
  const combs = [0.0297, 0.0371, 0.0411, 0.0437].map((d) => ({ n: Math.round(d * RATE), g: 0.74 }));
  const mix = new Float64Array(dry.length);
  for (const { n, g } of combs) {
    const line = new Float64Array(n);
    let p = 0, lp = 0;
    for (let i = 0; i < dry.length; i++) {
      const y = line[p];
      lp = lp + 0.35 * (y - lp);
      line[p] = dry[i] + g * lp;
      p = (p + 1) % n;
      mix[i] += y / combs.length;
    }
  }
  for (const [d, g] of [[0.005, 0.7], [0.0017, 0.7]]) {
    const n = Math.round(d * RATE), line = new Float64Array(n);
    let p = 0;
    for (let i = 0; i < mix.length; i++) {
      const delayed = line[p];
      const y = -g * mix[i] + delayed;
      line[p] = mix[i] + g * y;
      p = (p + 1) % n;
      mix[i] = y;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] += wet * mix[i];
  return out;
}

/** 按「最响 400ms 的 RMS」定响度，再看峰值别超；结尾 120ms 淡到 0 */
function finish(x, rmsDb = -23, peakDb = -11) {
  const w = Math.round(RATE * 0.4);
  let best = 0, acc = 0;
  for (let i = 0; i < x.length; i++) {
    acc += x[i] * x[i];
    if (i >= w) acc -= x[i - w] * x[i - w];
    best = Math.max(best, acc);
  }
  let k = 10 ** (rmsDb / 20) / Math.sqrt(best / w);
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  k = Math.min(k, 10 ** (peakDb / 20) / peak);
  const fade = Math.round(RATE * 0.12);
  return x.map((v, i) => v * k * (i > x.length - fade ? 0.5 + 0.5 * Math.cos((Math.PI * (i - (x.length - fade))) / fade) : 1));
}

function wav(x) {
  const data = Buffer.alloc(x.length * 2);
  x.forEach((v, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2));
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24); head.writeUInt32LE(RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

export const SOUNDS = {
  // 清泉（默认）：D5 → A5 上行纯五度，像碰了一下玻璃杯。分音近乎谐和，第 4.2 倍那条带一点玻璃味、很快就没了
  chime: () => {
    const x = new Float64Array(Math.round(RATE * 1.45));
    const partials = [[0.5, 0.08, 0.32], [1, 1, 0.42], [2, 0.2, 0.17], [3, 0.05, 0.085], [4.2, 0.03, 0.045]];
    note(x, { freq: hz(74), at: 0.0, gain: 1, partials });
    note(x, { freq: hz(81), at: 0.15, gain: 0.8, partials });
    return finish(reverb(x, 0.16));
  },
  // 木铃：C5 E5 G5 三个音的大三和弦往上走，马林巴的木头味（分音 1 : 3.93 : 9.2，高的那两条一下就没）
  marimba: () => {
    const x = new Float64Array(Math.round(RATE * 1.35));
    const partials = [[1, 1, 0.3], [3.93, 0.14, 0.05], [9.2, 0.025, 0.018]];
    note(x, { freq: hz(72), at: 0.0, gain: 0.9, partials, attack: 0.004 });
    note(x, { freq: hz(76), at: 0.11, gain: 0.85, partials, attack: 0.004 });
    note(x, { freq: hz(79), at: 0.22, gain: 0.95, partials: [[1, 1, 0.42], [3.93, 0.14, 0.06], [9.2, 0.025, 0.02]], attack: 0.004 });
    return finish(reverb(x, 0.12));
  },
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, make] of Object.entries(SOUNDS)) {
    const file = path.join(OUT, `reminder-${name}.wav`);
    fs.writeFileSync(file, wav(make()));
    console.log("写好了", path.relative(process.cwd(), file));
  }
  if (process.argv.includes("--analyze")) {
    const { readWav, analyze } = await import("./analyze.mjs");
    for (const name of Object.keys(SOUNDS)) console.log(name, analyze(readWav(path.join(OUT, `reminder-${name}.wav`))));
  }
}
