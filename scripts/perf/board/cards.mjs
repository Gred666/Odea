// 实验 2（docs/白板.md §9）：两百张卡片的白板，只给正在编辑的那张挂编辑器，开销多少。
//
//   先开着开发服务器（launch.json 的 odea-browser-v4），再
//   node scripts/perf/board/cards.mjs [地址] [卡片数]      默认 http://127.0.0.1:1434、200
//
// 量：开一张白板（认卡片 + 静态渲染 + 挂上去）、换一张编辑、在卡片里打字每键多久（keydown → 下一帧，
// 和 perf.mjs 一个口径）；对照是整篇正文放进一个编辑器（文档视图）；反例是一张卡片一个编辑器。
// 开发构建比生产构建慢 2.5–3.5 倍（perf.mjs 开头），这里看的是相互之间的比例。
import { sleep } from "../cdp.mjs";
import { launchChrome } from "./chrome.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:1434";
const COUNT = Number(process.argv[3] ?? 200);
const page = await launchChrome(9520, ["--force-device-scale-factor=1"]);
const { send, evaluate } = page;

const stats = (values) => {
  const sorted = values.map((v) => +v.toFixed(1)).sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return `中位 ${at(0.5)}  九成 ${at(0.9)}  最大 ${sorted.at(-1) ?? 0}（${sorted.length} 次）`;
};
const key = async (keyName, code, keyCode, text) => {
  await send("Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown",
    key: keyName,
    code,
    windowsVirtualKeyCode: keyCode,
    text,
    unmodifiedText: text,
  });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode });
};
/** 打 16 个字、回车、6 个退格（perf.mjs 的那一串），返回每键 keydown → 下一帧 的毫秒 */
const type = async () => {
  await evaluate("__keys.length = 0");
  for (const ch of "今天的进度还可以abc def") {
    await key(ch, "", 0, ch);
    await sleep(110);
  }
  await key("Enter", "Enter", 13, "\r");
  await sleep(110);
  for (let i = 0; i < 6; i++) {
    await key("Backspace", "Backspace", 8);
    await sleep(110);
  }
  await sleep(300);
  return evaluate("__keys.slice()");
};

try {
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 0, mobile: false });
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__keys = [];
      addEventListener("keydown", (e) => requestAnimationFrame(() => setTimeout(() => __keys.push(performance.now() - e.timeStamp), 0)), true);`,
  });
  for (const cpu of [1, 4]) {
    await send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await send("Page.navigate", { url: `${BASE}/scripts/perf/board/cards.html` });
    for (let i = 0; i < 300 && !(await evaluate("!!window.lab?.ready").catch(() => false)); i++) await sleep(100);
    // 编辑器那一包先载进来：开发服务器上第一次要几百个请求，和生产构建不是一回事，不算进去
    await evaluate("lab.open(4).then(() => lab.edit(0))");
    await sleep(500);
    await send("Emulation.setCPUThrottlingRate", { rate: cpu });
    console.log(`\n======== ${cpu} 倍 CPU 降速，${COUNT} 张卡片 ========`);

    const opened = await evaluate(`lab.open(${COUNT})`);
    console.log(
      `开白板：认卡片 ${opened.parseMs.toFixed(1)} ms，静态渲染 ${opened.renderMs.toFixed(0)} ms，` +
        `挂上去到画出来 ${opened.mountMs.toFixed(0)} ms；正文 ${opened.docChars} 个字符，${opened.nodes} 个节点`,
    );

    const swaps = [];
    for (const index of [3, 17, 42, 99, 150, 8, 61, 123]) {
      swaps.push(await evaluate(`lab.edit(${index % COUNT})`));
      await sleep(150);
    }
    console.log(`换一张编辑（上一张换回静态的 + 这一张挂编辑器）：${stats(swaps)} ms`);

    const inCard = await type();
    console.log(`在卡片里打字，每键：${stats(inCard)} ms`);
    console.log(
      `  把一张卡片的改动写回整篇正文（换掉那一段、后面的范围跟着挪）：平均 ${(await evaluate("lab.writeBackBench(2000)")).toFixed(4)} ms 一次`,
    );

    const many = await evaluate("lab.editMany(30)");
    console.log(`反例，30 张卡片各挂一个编辑器：${many.ms.toFixed(0)} ms，${many.nodes} 个节点`);

    const full = await evaluate("lab.full()");
    console.log(`对照，整篇正文放进一个编辑器：挂上 ${full.toFixed(0)} ms`);
    const inFull = await type();
    console.log(`  在它中间打字，每键：${stats(inFull)} ms`);
  }
} finally {
  await page.close();
}
