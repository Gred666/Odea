// 实验 1（docs/白板.md §9）：白板缩放时卡片里的字和描边。
//
//   node scripts/perf/board/zoom.mjs [倍率,倍率…]      默认 1,1.25,1.5
//
// 四种做法（zoom.html 开头有说明），各量四样：
//   A 途中：一步一步放大，每一步画出来的和「一上来就在这个缩放值」的静止画面一样不一样；停下来之后还变不变
//   B 排版：从 0.5 到 2.0 每 0.01 走一遍，卡片的行数变不变、同一个字的位置挪不挪
//   C 开销：两百张卡片连着缩放 60 帧，每帧改样式加排版多久（4 倍 CPU 降速）
//   D 描边：静止在非整数的缩放值上，1px 的描边是实的还是半透明的
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sleep } from "../cdp.mjs";
import { launchChrome } from "./chrome.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODES = ["transform", "transform-wc", "zoom", "relayout"];
const DSFS = (process.argv[2] ?? "1,1.25,1.5").split(",").map(Number);
/** --dump 目录：把每种做法最后一步的画面和对照存成 PNG */
const DUMP = process.argv.includes("--dump") ? process.argv[process.argv.indexOf("--dump") + 1] : null;
const STEPS = 10;
const zoomAt = (i) => +(1.6 ** (i / STEPS)).toFixed(4);
const clip = { x: 0, y: 0, width: 1200, height: 800, scale: 1 };
const pad = (value, width) => String(value).padStart(width);

for (const [index, dsf] of DSFS.entries()) {
  const page = await launchChrome(9500 + index, [`--force-device-scale-factor=${dsf}`]);
  const { send, evaluate } = page;
  try {
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 0, mobile: false });
    const open = async (mode, z = 1, cards = 40) => {
      const url = `${pathToFileURL(path.join(here, "zoom.html")).href}?mode=${mode}&cards=${cards}&z=${z}`;
      await send("Page.navigate", { url });
      for (let i = 0; i < 50 && !(await evaluate("!!window.board").catch(() => false)); i++) await sleep(100);
      await evaluate("document.fonts.ready.then(() => board.nextFrame())");
      await sleep(350);
    };
    const shot = async () => (await send("Page.captureScreenshot", { format: "png", clip })).data;
    const diff = (a, b) => evaluate(`board.diff(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    console.log(`\n======== ${await evaluate("devicePixelRatio")} 倍屏 ========`);

    /* ---- A：途中和停下来之后 ---- */
    console.log("\nA 途中 / 停下来（和同一个缩放值的静止画面比，数不一样的像素；画面 1200×800）");
    console.log("做法            十步里一样的  途中最多差    停下后 0ms   150ms   500ms  1200ms");
    for (const mode of MODES) {
      await open(mode);
      const live = [];
      for (let i = 1; i <= STEPS; i++) {
        await evaluate(`(async () => { board.setZoom(${zoomAt(i)}); await board.nextFrame(); await board.nextFrame(); })()`);
        live.push(await shot());
      }
      const settle = [];
      for (const wait of [150, 350, 700]) {
        await sleep(wait);
        settle.push(await shot());
      }
      const refs = [];
      for (let i = 1; i <= STEPS; i++) {
        await open(mode, zoomAt(i));
        refs.push(await shot());
      }
      if (DUMP) {
        fs.mkdirSync(DUMP, { recursive: true });
        fs.writeFileSync(path.join(DUMP, `${dsf}-${mode}-live.png`), Buffer.from(live.at(-1), "base64"));
        fs.writeFileSync(path.join(DUMP, `${dsf}-${mode}-ref.png`), Buffer.from(refs.at(-1), "base64"));
      }
      const during = [];
      const strong = [];
      for (let i = 0; i < STEPS; i++) {
        const d = await diff(live[i], refs[i]);
        during.push(d.changed);
        strong.push(d.strong);
      }
      const after = [];
      for (const image of settle) after.push((await diff(image, refs.at(-1))).changed);
      console.log(
        `${mode.padEnd(14)}${pad(during.filter((n) => n === 0).length, 10)}${pad(Math.max(...during), 12)}` +
          `${pad(during.at(-1), 14)}${pad(after[0], 8)}${pad(after[1], 8)}${pad(after[2], 8)}` +
          `   其中差得明显的最多 ${Math.max(...strong)}`,
      );
    }

    /* ---- A2：每一帧都在变的快速缩放，停下来那一刻 ---- */
    console.log("\nA2 连着缩放 60 帧（每帧都变）之后，和静止画面差得明显的像素");
    console.log("做法            刚停    150ms   500ms  1200ms");
    for (const mode of MODES) {
      await open(mode, zoomAt(STEPS));
      const ref = await shot();
      await open(mode);
      // 末尾落在和对照同一个缩放值上
      await evaluate(`board.animate(1, ${zoomAt(STEPS)}, 60).then(() => board.setZoom(${zoomAt(STEPS)}))`);
      const cells = [];
      for (const wait of [0, 150, 350, 700]) {
        await sleep(wait);
        cells.push((await diff(await shot(), ref)).strong);
      }
      console.log(`${mode.padEnd(14)}${cells.map((n) => pad(n, 8)).join("")}`);
    }

    /* ---- B：排版稳不稳 ---- */
    console.log("\nB 排版（0.50 → 2.00 每 0.01 一步，共 151 步，40 张卡片；和 1.00 时比，长度都除掉了缩放）");
    console.log("做法            有卡片折行变了的步数  相邻两步之间折行变了几次  卡片高度最多差(px)  同一个字最多挪了(px，折行没变的)");
    for (const mode of MODES) {
      await open(mode);
      const base = await evaluate("board.metrics()");
      let stepsWithRewrap = 0;
      let flips = 0;
      let maxShift = 0;
      let maxHeight = 0;
      let previous = "";
      const where = [];
      for (let k = 50; k <= 200; k++) {
        const now = await evaluate(`(board.setZoom(${k / 100}), board.metrics())`);
        const rewrapped = [];
        now.forEach((card, i) => {
          if (card.lines !== base[i].lines) rewrapped.push(i);
          else {
            maxShift = Math.max(maxShift, Math.hypot(card.px - base[i].px, card.py - base[i].py));
            maxHeight = Math.max(maxHeight, Math.abs(card.h - base[i].h));
          }
        });
        if (rewrapped.length) where.push(`${(k / 100).toFixed(2)}(${rewrapped.length})`);
        if (rewrapped.length) stepsWithRewrap++;
        const key = rewrapped.join(",");
        if (k > 50 && key !== previous) flips++;
        previous = key;
      }
      console.log(
        `${mode.padEnd(14)}${pad(stepsWithRewrap, 14)}${pad(flips, 22)}${pad(maxHeight.toFixed(2), 20)}${pad(maxShift.toFixed(2), 20)}`,
      );
      if (where.length) console.log(`   折行变了的缩放值（几张）：${where.slice(0, 30).join(" ")}${where.length > 30 ? " …" : ""}`);
    }

    /* ---- C：开销 ---- */
    console.log("\nC 开销（连着缩放 60 帧，4 倍 CPU 降速；每帧「改样式 + 排版」的毫秒）");
    console.log("做法            卡片数  平均    最大    两帧间隔的中位数  最长的间隔");
    await send("Emulation.setCPUThrottlingRate", { rate: 4 });
    for (const count of [30, 200]) {
      for (const mode of MODES) {
        await open(mode, 1, count);
        const { work, gaps } = await evaluate("board.animate(1, 1.6, 60)");
        const sorted = [...gaps].sort((a, b) => a - b);
        console.log(
          `${mode.padEnd(14)}${pad(count, 6)}${pad((work.reduce((a, b) => a + b, 0) / work.length).toFixed(2), 8)}` +
            `${pad(Math.max(...work).toFixed(2), 8)}${pad(sorted[Math.floor(sorted.length / 2)].toFixed(1), 14)}` +
            `${pad(sorted.at(-1).toFixed(1), 14)}`,
        );
      }
    }
    await send("Emulation.setCPUThrottlingRate", { rate: 1 });

    /* ---- D：静止时的描边 ---- */
    console.log("\nD 静止时 1px 描边（横穿三张卡片的左边，各取 9 个物理像素；实 = 就是描边的颜色，虚 = 半透明）");
    console.log(`做法            ${[0.8, 1.1, 1.25, 1.5].map((z) => `缩放 ${z}`.padEnd(16)).join("")}`);
    for (const mode of MODES) {
      const cells = [];
      for (const z of [0.8, 1.1, 1.25, 1.5]) {
        await open(mode, z);
        const image = await shot();
        let solid = 0;
        let partial = 0;
        for (const card of [0, 6, 12]) {
          const box = await evaluate(`board.cardBox(${card})`);
          const probe = await evaluate(
            // 取卡片半高处：靠上是圆角，那里本来就是弧
            `board.edge(${JSON.stringify(image)}, ${box.left * dsf}, ${(box.top + box.height / 2) * dsf})`,
          );
          solid += probe.solid;
          partial += probe.partial;
        }
        cells.push(`实 ${solid} 虚 ${partial}`.padEnd(18));
      }
      console.log(`${mode.padEnd(14)}  ${cells.join("")}`);
    }
  } finally {
    await page.close();
  }
}
