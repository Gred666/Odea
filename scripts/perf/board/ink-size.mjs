// 实验 3 的一部分（docs/白板.md §9）：一页手写存下来多大。
//
//   node scripts/perf/board/ink-size.mjs
//
// 没有笔：笔画是 glyphs.mjs 机器写的数字和运算符，按每秒 260 像素的书写速度配上时间和压感。
// 真人写汉字每笔更短、笔数更多，所以按「每笔多少字节」看，再乘笔数。
import zlib from "node:zlib";
import { rng, write } from "./glyphs.mjs";
import { decodeRaw, encodeRaw, outline, pathData, penSamples, simplify } from "./ink-core.mjs";

const TEXTS = ["12+3=15", "1280×0.85=1088", "(40+2)÷6=7", "3.5+2.25=5.75", "86400", "99-100=", "6×(15-9)=36", "2026/11/12"];

function page(strokeTarget, hz) {
  const random = rng(7);
  const strokes = [];
  let line = 0;
  while (strokes.length < strokeTarget) {
    let x = 40;
    while (x < 900 && strokes.length < strokeTarget) {
      const text = TEXTS[Math.floor(random() * TEXTS.length)];
      // 字高 22 像素：横线本上写字差不多这么大
      const ink = write(text, { seed: strokes.length + 1, height: 22, messy: 0.6 });
      for (const stroke of ink.strokes) {
        strokes.push(penSamples(stroke.map(([px, py]) => [px + x, py + 40 + line * 38]), { hz, random }));
      }
      x += ink.width + 28;
    }
    line++;
  }
  return strokes.slice(0, strokeTarget);
}

const kb = (text) => (Buffer.byteLength(text) / 1024).toFixed(0);
const gz = (text) => (zlib.gzipSync(text).length / 1024).toFixed(0);
const svg = (lines) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 1400"><g fill="#1a1a18">\n${lines.join("\n")}\n</g></svg>\n`;

for (const hz of [240, 120]) {
  for (const count of [500, 2000]) {
    const strokes = page(count, hz);
    const samples = strokes.reduce((sum, stroke) => sum + stroke.length, 0);
    const started = performance.now();
    const outlines = strokes.map((stroke) => outline(stroke, 2.6));
    const outlineMs = performance.now() - started;
    const formats = {
      "轮廓 + 原始采样": svg(strokes.map((s, i) => `<path d="${pathData(outlines[i])}" data-p="${encodeRaw(s)}"/>`)),
      "化简的轮廓 + 原始采样": svg(strokes.map((s, i) => `<path d="${pathData(simplify(outlines[i], 0.15))}" data-p="${encodeRaw(s)}"/>`)),
      "只有化简的轮廓": svg(strokes.map((s, i) => `<path d="${pathData(simplify(outlines[i], 0.15))}"/>`)),
      "只有原始采样": `${strokes.map((s) => encodeRaw(s)).join("\n")}\n`,
      "JSON 数组": JSON.stringify(strokes.map((s) => s.map(([x, y, p, t]) => [+x.toFixed(1), +y.toFixed(1), +p.toFixed(2), t]))),
    };
    console.log(
      `\n${count} 笔，${hz} Hz：共 ${samples} 个采样，平均每笔 ${(samples / count).toFixed(0)} 个；` +
        `算轮廓 ${outlineMs.toFixed(0)} ms`,
    );
    for (const [name, text] of Object.entries(formats)) {
      console.log(
        `  ${name.padEnd(12, "　")} ${kb(text).padStart(5)} KB   压缩后 ${gz(text).padStart(4)} KB   每笔 ${(Buffer.byteLength(text) / count).toFixed(0)} 字节`,
      );
    }
    // 编码往返：读回来的和原来的差不超过量化的一格
    const back = decodeRaw(encodeRaw(strokes[0]));
    const worst = Math.max(...back.map((p, i) => Math.hypot(p[0] - strokes[0][i][0], p[1] - strokes[0][i][1])));
    if (worst > 0.1 || back.length !== strokes[0].length) console.log(`  ✗ 编码往返差了 ${worst}`);
  }
}
