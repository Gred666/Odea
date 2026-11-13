// 实验 4（docs/白板.md §9）：系统自带的手写识别器读不读得了一行算式。
//
//   node scripts/perf/board/recognize.mjs
//
// 没有笔，喂的是 glyphs.mjs 机器写的字（三档潦草程度，每档每条写 3 遍）。量的是「这条路通不通、
// 限定成数字之后有没有用」，不是真人手写的准确率。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { write } from "./glyphs.mjs";

const EXPRESSIONS = [
  "12+3=", "45-17=", "8×7=", "100÷4=", "3.5+2.25=", "(2+3)×4=", "1280×0.85=", "99-100=",
  "6×(15-9)=", "7/8", "2026", "360÷12=", "0.5×0.5=", "19+81=", "1024-768=", "3×3×3=",
  "(40+2)÷6=", "5.75-0.25=", "86400", "12+34+56=",
];
const LEVELS = [0.2, 0.6, 1.0];
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odea-board-hwr-"));

const items = [];
for (const messy of LEVELS) {
  for (const [index, text] of EXPRESSIONS.entries()) {
    for (let take = 0; take < 3; take++) {
      // 字高 8 mm = 800 个墨迹单位（0.01 mm）
      const ink = write(text, { seed: index * 100 + take * 7 + Math.round(messy * 10), height: 800, messy });
      items.push({
        text,
        messy,
        strokes: ink.strokes.map((stroke) => stroke.flatMap(([x, y]) => [Math.round(x), Math.round(y)])),
      });
    }
  }
}
const input = path.join(dir, "in.json");
const output = path.join(dir, "out.json");
fs.writeFileSync(input, JSON.stringify({ items }));
const started = Date.now();
execFileSync(
  "powershell",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "recognize.ps1"), "-In", input, "-Out", output],
  { stdio: "inherit" },
);
const elapsed = Date.now() - started;
const runs = JSON.parse(fs.readFileSync(output, "utf8"));

/** 写法不同、意思一样的算一样：x X * → ×，全角符号、空格去掉 */
const fold = (text) =>
  text
    .replace(/\s+/g, "")
    .replace(/[xX*✕╳]/g, "×")
    .replace(/[—–－一]/g, "-")
    .replace(/＝/g, "=")
    .replace(/＋/g, "+")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/。/g, ".")
    .replace(/[:：]/g, "÷");

const NAMES = { "0409": "英文", "0004": "简体中文", "0804": "简体中文" };
console.log(`${items.length} 条（${EXPRESSIONS.length} 个式子 × 3 档潦草 × 3 遍），一共 ${elapsed} ms`);
console.log("识别器      限定      潦草 0.2   0.6    1.0    合计   前五个候选里有");
for (const run of runs) {
  const cells = [];
  let total = 0;
  let inAlts = 0;
  for (const messy of LEVELS) {
    let right = 0;
    let count = 0;
    items.forEach((item, i) => {
      if (item.messy !== messy) return;
      count++;
      const result = run.results[i];
      if (fold(result.top ?? "") === item.text) right++;
      if ([result.top, ...(result.alts ?? [])].some((s) => fold(s ?? "") === item.text)) inAlts++;
    });
    total += right;
    cells.push(`${Math.round((right / count) * 100)}%`.padEnd(7));
  }
  console.log(
    `${(NAMES[run.recognizer] ?? run.recognizer).padEnd(8, "　")}${run.factoid.padEnd(10)}     ${cells.join("")}` +
      `${Math.round((total / items.length) * 100)}%`.padEnd(7) +
      `${Math.round((inAlts / items.length) * 100)}%`,
  );
}
// 读错的样子：每个式子读成了什么（去掉重复的）
for (const run of runs.filter((r) => r.factoid !== "DIGIT")) {
  const wrong = new Map();
  let perfect = 0;
  for (const text of EXPRESSIONS) {
    const tops = new Set();
    items.forEach((item, i) => {
      const top = run.results[i].top ?? "";
      if (item.text === text && fold(top) !== text) tops.add(top);
    });
    if (tops.size) wrong.set(text, [...tops].slice(0, 3));
    else perfect++;
  }
  console.log(
    `\n${NAMES[run.recognizer] ?? run.recognizer}（${run.factoid}）：${perfect} 个式子九遍全对。读错的：` +
      [...wrong].map(([text, tops]) => `${text} → ${tops.join(" / ")}`).join("　"),
  );
}
fs.rmSync(dir, { recursive: true, force: true });
