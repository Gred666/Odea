// 实验 3（docs/白板.md §9）里不用笔也能量的那一半。真正的延迟（笔尖到屏幕）要带笔的设备加高速录像，这里没有。
//
//   先开着开发服务器（launch.json 的 odea-browser-v4），再
//   node scripts/perf/board/ink.mjs [地址]
//
//   A 笔的事件：用 DevTools 协议发「笔」的指针事件，看页面收到什么（类型、压感、一帧里合并了几个、预测了几个）、
//     navigator.ink 的那一段调不调得通
//   B 湿墨迹：正在写的一笔越来越长，每帧画多久（整笔重画 / 只画新来的一段）
//   C 干墨迹：一页几千笔，平移时每帧整层重画多久（三种画法；带不带「逼着光栅化完」）
import { sleep } from "../cdp.mjs";
import { launchChrome } from "./chrome.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:1434";
const ms = (value) => (value === null ? "   —" : value.toFixed(2).padStart(6));

const DSFS = (process.argv[3] ?? "1,1.5").split(",").map(Number);
for (const [index, dsf] of DSFS.entries()) {
  const page = await launchChrome(9530 + index, [`--force-device-scale-factor=${dsf}`]);
  const { send, evaluate } = page;
  try {
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 0, mobile: false });
    await send("Page.navigate", { url: `${BASE}/scripts/perf/board/ink.html` });
    for (let i = 0; i < 200 && !(await evaluate("!!window.ink?.ready").catch(() => false)); i++) await sleep(100);
    console.log(`\n======== ${await evaluate("ink.dpr")} 倍屏，画布 ${(await evaluate("ink.size")).join("×")} ========`);

    if (index === 0) {
      /* ---- A：笔的事件 ---- */
      const pen = (type, x, y, extra = {}) =>
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
          ...extra,
        });
      await pen("mousePressed", 200, 300);
      // 一口气发 240 个移动，不等回应：看一帧里合并了几个
      const moves = [];
      for (let i = 1; i <= 240; i++) moves.push(pen("mouseMoved", 200 + i * 3, 300 + Math.sin(i / 12) * 80));
      await Promise.all(moves);
      await pen("mouseReleased", 920, 300);
      await sleep(300);
      const log = await evaluate("ink.log");
      const sum = (list) => list.reduce((a, b) => a + b, 0);
      console.log("\nA 笔的事件（DevTools 协议发的 240 个「笔」的移动）");
      console.log(`  指针类型 ${log.types.join("/")}；pointermove ${log.move} 次，合并进来的采样一共 ${sum(log.coalesced)} 个（一次最多 ${Math.max(...log.coalesced)} 个）`);
      console.log(`  pointerrawupdate ${log.raw} 次；预测的点一次最多 ${Math.max(...log.predicted)} 个`);
      console.log(`  压感 ${Math.min(...log.pressures).toFixed(2)}–${Math.max(...log.pressures).toFixed(2)}，倾斜 tiltX ${log.tilts[0]}`);
      console.log(`  navigator.ink：${(await evaluate("ink.hasPresenter")) ? "拿到了 presenter" : "没有"}，交出墨迹尾巴那一下：${log.trail}`);
    }

    for (const cpu of [1, 4]) {
      await send("Emulation.setCPUThrottlingRate", { rate: cpu });
      console.log(`\n—— ${cpu} 倍 CPU 降速 ——`);

      /* ---- B：湿墨迹 ---- */
      console.log("B 正在写的一笔，每帧「算 + 画」的毫秒（中位数），按这一笔已经有多少个采样");
      console.log("  画法                每帧来几个     ~50     ~200    ~1000");
      for (const [strategy, name] of [["full", "整笔重算重画"], ["tail", "只画新来的一段"]]) {
        const r = await evaluate(`ink.benchWet(1000, 4, ${JSON.stringify(strategy)})`);
        console.log(`  ${name.padEnd(10, "　")}${String(4).padStart(10)}     ${ms(r[50])}  ${ms(r[200])}  ${ms(r[1000])}`);
      }

      /* ---- C：干墨迹 ---- */
      console.log("C 写完的笔画，平移 90 帧，每帧整层重画（毫秒）");
      console.log("  一页几笔  缩放   画法              每帧画几笔   JS 中位    JS 95%    两帧间隔 中位     95%");
      for (const count of [2000, 10000]) {
        const built = await evaluate(`ink.buildPage(${count})`);
        for (const zoom of count === 2000 ? [1] : [1, 0.25]) {
          for (const [strategy, name] of [["each", "一笔一次"], ["batch", "并成一条"], ["all", "整页不剔除"]]) {
            const r = await evaluate(`ink.benchDry(${zoom}, 90, ${JSON.stringify(strategy)})`);
            console.log(
              `  ${String(built.strokes).padStart(6)}  ${String(zoom).padStart(5)}   ${name.padEnd(8, "　")}${String(r.drawn).padStart(10)}   ` +
                `${ms(r.work.p50)}   ${ms(r.work.p95)}        ${ms(r.gaps.p50)}   ${ms(r.gaps.p95)}`,
            );
          }
        }
      }
    }
    await send("Emulation.setCPUThrottlingRate", { rate: 1 });
  } finally {
    await page.close();
  }
}
