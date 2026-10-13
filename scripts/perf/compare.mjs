// 两次 perf.mjs 的结果并排看：node scripts/perf/compare.mjs before.json after.json
import fs from "node:fs";

const [before, after] = process.argv
  .slice(2, 4)
  .map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
if (!before || !after) {
  console.error("用法：node scripts/perf/compare.mjs before.json after.json");
  process.exit(1);
}

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const rows = [];
const row = (label, pick) => {
  const value = (result) => {
    try {
      return pick(result) ?? "-";
    } catch {
      return "-";
    }
  };
  rows.push([label, String(value(before)), String(value(after))]);
};

for (const [key, name] of [
  ["startupShort", "启动（停在短笔记）"],
  ["startupLong", "启动（停在长文）"],
]) {
  row(`${name} 首屏 ms`, (r) => median(r[key].map((run) => run.firstRender)));
  row(`${name} 主线程忙碌 ms`, (r) => median(r[key].map((run) => run.busyMs)));
  row(`${name} 最长任务 ms`, (r) => median(r[key].map((run) => run.longestTask)));
}
row("切换短笔记 INP 中位数", (r) => r.switch.short.p50);
row("切换短笔记 INP 最大", (r) => r.switch.short.max);
row("切换到长文 INP", (r) => r.switch.long.join(" / "));
for (const [key, name] of [
  ["typingMiddle", "长文中间打字"],
  ["typingEnd", "长文末尾打字"],
  ["arrows", "长文里按 ↓"],
]) {
  row(`${name} 按键→出帧 p50`, (r) => r[key].p50);
  row(`${name} 按键→出帧 p90`, (r) => r[key].p90);
}
row("滚动长文（第一遍）>33ms 的帧", (r) => `${r.scrollFirst.over33ms}/${r.scrollFirst.frames}`);
row("滚动长文（第二遍）>33ms 的帧", (r) => `${r.scrollAgain.over33ms}/${r.scrollAgain.frames}`);
row("打开命令面板 p50", (r) => r.palette.open.p50);
row("命令面板里打字 p50", (r) => r.palette.typing.p50);
for (let i = 0; i < Math.max(before.nav?.length ?? 0, after.nav?.length ?? 0); i++) {
  const label = before.nav?.[i]?.label ?? after.nav?.[i]?.label;
  row(`切到「${label}」INP / 最长一帧`, (r) => `${r.nav[i].inp} / ${r.nav[i].longestFrame}`);
}
row("列表里画出来的行", (r) => r.listRows);
row("JS 堆 MB", (r) => r.memory.heapMB);
row("DOM 节点", (r) => r.memory.domNodes);

const width = (text) => [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);
const pad = (text, size) => text + " ".repeat(Math.max(0, size - width(text)));
const padStart = (text, size) => " ".repeat(Math.max(0, size - width(text))) + text;
const first = Math.max(...rows.map(([label]) => width(label)));
for (const [label, a, b] of [["", "之前", "之后"], ...rows]) {
  console.log(`${pad(label, first)}  ${padStart(a, 12)}  ${padStart(b, 12)}`);
}
