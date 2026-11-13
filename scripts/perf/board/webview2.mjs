// 实验 3 的补充：在真的 WebView2（Odea 的桌面端窗口）里看墨迹要的接口在不在、画布画不画得动。
//
//   先起一个带调试端口的桌面端（launch.json 里带 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 的那些），
//   开着开发服务器（odea-browser-v4），再
//   node scripts/perf/board/webview2.mjs [调试端口] [开发服务器地址]
//
// 做法：接到那个窗口的页面上，把它导航到实验页（回环地址是安全上下文，接口都开着）。量完不负责关窗口。
import { connect, sleep } from "../cdp.mjs";

const PORT = Number(process.argv[2] ?? 9347);
const BASE = process.argv[3] ?? "http://127.0.0.1:1434";

let target = null;
for (let i = 0; i < 100 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page");
  } catch {
    // 还没起来
  }
  if (!target) await sleep(300);
}
if (!target) throw new Error(`调试端口 ${PORT} 上没有页面`);
const page = await connect(target.webSocketDebuggerUrl);
const { send, evaluate } = page;
await send("Page.enable");
console.log(`接上了：${target.url}`);
console.log((await send("Browser.getVersion")).product);

await send("Page.navigate", { url: `${BASE}/scripts/perf/board/ink.html` });
for (let i = 0; i < 200 && !(await evaluate("!!window.ink?.ready").catch(() => false)); i++) await sleep(100);

const features = await evaluate(`(async () => {
  const c = document.createElement("canvas");
  const g = c.getContext("2d", { desynchronized: true });
  return {
    页面: location.origin,
    安全上下文: isSecureContext,
    倍率: devicePixelRatio,
    窗口: innerWidth + "×" + innerHeight,
    "navigator.ink": "ink" in navigator,
    "拿到 presenter": ink.hasPresenter,
    getCoalescedEvents: "getCoalescedEvents" in PointerEvent.prototype,
    getPredictedEvents: "getPredictedEvents" in PointerEvent.prototype,
    pointerrawupdate: "onpointerrawupdate" in window,
    "desynchronized 画布": g.getContextAttributes().desynchronized,
    OffscreenCanvas: typeof OffscreenCanvas !== "undefined",
    WebGPU: "gpu" in navigator && !!(await navigator.gpu.requestAdapter().catch(() => null)),
    "CSS zoom": CSS.supports("zoom", "2"),
    "手写识别接口": "createHandwritingRecognizer" in navigator,
  };
})()`);
for (const [name, value] of Object.entries(features)) console.log(`  ${name}: ${value}`);

// 发「笔」的事件
const pen = (type, x, y) =>
  send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: 1,
    pointerType: "pen",
    force: 0.2 + 0.6 * Math.abs(Math.sin(x / 40)),
    tiltX: 20,
    tiltY: -10,
  });
await pen("mousePressed", 120, 200);
const moves = [];
for (let i = 1; i <= 240; i++) moves.push(pen("mouseMoved", 120 + i * 2, 200 + Math.sin(i / 12) * 60));
await Promise.all(moves);
await pen("mouseReleased", 600, 200);
await sleep(300);
const log = await evaluate("ink.log");
const sum = (list) => list.reduce((a, b) => a + b, 0);
console.log(
  `笔的事件：类型 ${log.types.join("/")}，pointermove ${log.move} 次、合并的采样 ${sum(log.coalesced)} 个，` +
    `pointerrawupdate ${log.raw} 次，预测最多 ${Math.max(0, ...log.predicted)} 个，` +
    `压感 ${Math.min(...log.pressures).toFixed(2)}–${Math.max(...log.pressures).toFixed(2)}；墨迹尾巴：${log.trail}`,
);

console.log("写完的笔画，平移 90 帧，每帧整层重画（一笔一次、剔掉视口外的）");
for (const [count, zoom] of [[2000, 1], [10000, 1], [10000, 0.25]]) {
  await evaluate(`ink.buildPage(${count})`);
  const r = await evaluate(`ink.benchDry(${zoom}, 90, "each")`);
  console.log(
    `  一页 ${count} 笔，缩放 ${zoom}：每帧画 ${r.drawn} 笔，JS 中位 ${r.work.p50.toFixed(2)} ms，` +
      `两帧间隔 中位 ${r.gaps.p50.toFixed(1)} / 95% ${r.gaps.p95.toFixed(1)} ms`,
  );
}
page.ws.close();
