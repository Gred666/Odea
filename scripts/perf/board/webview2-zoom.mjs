// 实验 1 的补充：缩放那几种做法在真的 WebView2（桌面端窗口、真显卡）里是不是和无头 Chrome 里一个结论。
//
//   起法同 webview2.mjs：node scripts/perf/board/webview2-zoom.mjs [调试端口] [开发服务器地址]
//
// 每种做法：连着缩放 60 帧（每帧都变）到 1.6 倍，刚停、过一会儿各截一张，和「一上来就在 1.6 倍」的静止画面比；
// 再量 30 / 200 张卡片时每帧「改样式 + 排版」多久、两帧隔多久。
import { connect, sleep } from "../cdp.mjs";

const PORT = Number(process.argv[2] ?? 9347);
const BASE = process.argv[3] ?? "http://127.0.0.1:1434";
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = await connect(list.find((t) => t.type === "page").webSocketDebuggerUrl);
const { send, evaluate } = page;
await send("Page.enable");
const clip = { x: 0, y: 0, width: 1200, height: 800, scale: 1 };
const Z = 1.6;
const open = async (mode, z = 1, cards = 40) => {
  await send("Page.navigate", { url: `${BASE}/scripts/perf/board/zoom.html?mode=${mode}&cards=${cards}&z=${z}` });
  for (let i = 0; i < 80 && !(await evaluate("!!window.board").catch(() => false)); i++) await sleep(100);
  await evaluate("document.fonts.ready.then(() => board.nextFrame())");
  await sleep(400);
};
const shot = async () => (await send("Page.captureScreenshot", { format: "png", clip })).data;
const pad = (value, width) => String(value).padStart(width);

console.log(`${(await send("Browser.getVersion")).product}，倍率 ${await evaluate("devicePixelRatio")}`);
console.log("做法            刚停时差得明显的像素  500ms 后   30 张每帧(ms)  两帧间隔   200 张每帧(ms)  两帧间隔");
for (const mode of ["transform", "transform-wc", "zoom", "relayout"]) {
  await open(mode, Z);
  const ref = await shot();
  await open(mode);
  await evaluate(`board.animate(1, ${Z}, 60).then(() => board.setZoom(${Z}))`);
  const now = (await evaluate(`board.diff(${JSON.stringify(await shot())}, ${JSON.stringify(ref)})`)).strong;
  await sleep(500);
  const later = (await evaluate(`board.diff(${JSON.stringify(await shot())}, ${JSON.stringify(ref)})`)).strong;
  const cost = [];
  for (const cards of [30, 200]) {
    await open(mode, 1, cards);
    const { work, gaps } = await evaluate(`board.animate(1, ${Z}, 60)`);
    const sorted = [...gaps].sort((a, b) => a - b);
    cost.push(
      `${pad((work.reduce((a, b) => a + b, 0) / work.length).toFixed(2), 10)}${pad(sorted[Math.floor(sorted.length / 2)].toFixed(1), 12)}`,
    );
  }
  console.log(`${mode.padEnd(14)}${pad(now, 14)}${pad(later, 14)}   ${cost.join("    ")}`);
}
page.ws.close();
