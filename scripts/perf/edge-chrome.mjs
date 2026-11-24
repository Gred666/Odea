// 边栏（左上角的刘海 + 往下长的侧栏，docs/边栏.md）的动画：动画帧里有没有布局 / 重绘，多倍屏下片和片之间有没有发丝缝
//
//   pnpm build && pnpm exec vite preview --port 1432        （另开一个终端，或 launch.json 的 odea-preview）
//   node scripts/perf/edge-chrome.mjs http://localhost:1432 trace   # 4 倍降速、2x 屏，每个场景录一段 trace
//   node scripts/perf/edge-chrome.mjs http://localhost:1432 seams   # 1 / 1.25 / 1.5 / 2 倍屏，逐帧找发丝缝
//
// 选项：--scenes collapse,expand,calendar,today,notes,journal-off,journal-on（默认全跑，按这个顺序，一个接一个）
//       --cpu 4（trace）  --dpr 1,1.25,1.5,2（seams）  --theme dark  --port 9352（Chrome 调试端口）
//       --dump <目录>（trace）：每个场景的 trace 存成 <场景>.json，DevTools 的 Performance 面板能直接打开
//       --gap 1（seams 自检）：大的那块底和右边那一列之间故意空出 1px 的缝，确认这个找法找得到
//
// trace：点下去以后第一帧（换内容；侧栏在流里的宽度一帧给到）允许有布局和重绘。之后到动画走完，
// 渲染主线程上的 Layout、Paint 一条条列出来（Paint 带着重画的是哪个节点），UpdateLayoutTree、PrePaint 只数个数。
// 只有合成的话，后面那一段 Layout、Paint 都是 0。点击用 element.click()，不带鼠标悬停（悬停的变色另算）。
//
// seams：Chrome 用 --force-device-scale-factor 起（DevTools 模拟的高 DPI 不是真的，VERIFICATION.md「逐帧对比」）。
// 只留形状那几块（别的全 visibility: hidden，露出来的是 body 的底色），动画放慢 10 倍逐帧截左上那一块，
// 找「两边都是侧栏色、中间 1–2 个物理像素不是」的像素，横竖都看 —— 片和片之间的发丝缝就长这样；
// 形状本来的边一边是侧栏色、一边是底色，不算。静止的最后一帧也查。
import fs from "node:fs";
import path from "node:path";
import { launch, sleep } from "./cdp.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const BASE = args.find((arg) => /^https?:/.test(arg)) ?? "http://localhost:1432";
const MODE = args.find((arg) => arg === "trace" || arg === "seams") ?? "trace";
const CPU = Number(option("cpu", 4));
const DPRS = option("dpr", "1,1.25,1.5,2").split(",").map(Number);
const THEME = option("theme", "light");
const PORT = Number(option("port", 9352));
const ALL = ["collapse", "expand", "calendar", "today", "notes", "journal-off", "journal-on"];
const SCENES = option("scenes", ALL.join(",")).split(",");
const DUMP = option("dump", null);
/** 自检：大的那块底往左挪 4 + gap px（本来和右边那一列叠 4px），故意空出 gap px 的缝，看 seams 找不找得到 */
const GAP = Number(option("gap", 0));

const NAV = `[...document.querySelectorAll('nav[aria-label="主导航"] ul button')]`;
const clickNav = (label) =>
  `(() => { const b = ${NAV}.find((b) => b.getAttribute("aria-label") === ${JSON.stringify(label)});
    if (!b) throw new Error("导航里没有 ${label}"); b.click(); return true; })()`;
/** 每个场景：说明、触发（页面里跑的 JS；palette 的走命令面板） */
const SCENE = {
  collapse: { name: "笔记：收起侧栏（拉到底 → 只剩刘海）", js: clickNav("文件") },
  expand: { name: "笔记：展开侧栏（只剩刘海 → 拉到底）", js: clickNav("文件") },
  calendar: { name: "笔记 → 日历（拉到底 → 按月格子的高）", js: clickNav("日历") },
  today: { name: "日历 → 今日TODO（按内容高 → 只剩刘海）", js: clickNav("今日TODO") },
  notes: { name: "今日TODO → 笔记（只剩刘海 → 拉到底）", js: clickNav("文件") },
  "journal-off": { name: "关日程（刘海少三格）", palette: "关闭日程" },
  "journal-on": { name: "开日程（刘海多三格）", palette: "启用日程" },
};

async function open(extraArgs, metrics) {
  const page = await launch(PORT, extraArgs);
  const { send, evaluate } = page;
  await send("Page.enable");
  await send("Runtime.enable");
  if (metrics) await send("Emulation.setDeviceMetricsOverride", metrics);
  const loaded = () => new Promise((resolve) => page.on("Page.loadEventFired", resolve));
  let done = loaded();
  await send("Page.navigate", { url: BASE });
  await done;
  await evaluate(`sessionStorage.setItem("odea.introPlayed", "1");
    localStorage.setItem("odea.prefs", JSON.stringify({ ...JSON.parse(localStorage.getItem("odea.prefs") || "{}"),
      theme: ${JSON.stringify(THEME)}, panelCollapsed: false }));
    localStorage.setItem("odea.session", JSON.stringify({ workspace: "notes", noteId: "", archiveId: "", noteFolder: "" })); true`);
  done = loaded();
  await send("Page.reload");
  await done;
  for (let i = 0; i < 100 && !(await evaluate(`${NAV}.length > 0`)); i++) await sleep(100);
  await sleep(1500);
  return page;
}

/**
 * 主线程安静下来、有限长的 WAAPI / CSS 动画都走完（光标闪烁、转圈这种无限循环的不算）。
 * getAnimations() 会逼着先算一遍样式，只隔 250ms 查一次：每帧都查的话量的人自己在每帧里加了一次样式计算
 */
const settle = (evaluate, minMs) =>
  evaluate(`new Promise((done) => { const t0 = performance.now(); let last = t0, calm = t0;
    const running = () => document.getAnimations().some((a) => a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity);
    const timer = setInterval(() => { if (running()) calm = performance.now(); }, 250);
    const tick = (t) => { if (t - last > 50) calm = t; last = t;
      if ((t - t0 > ${minMs} && t - calm > 300) || t - t0 > 15000) { clearInterval(timer); done(); } else requestAnimationFrame(tick); };
    requestAnimationFrame(tick); })`);

async function trigger(page, scene) {
  const { send, evaluate } = page;
  const spec = SCENE[scene];
  if (!spec.palette) return evaluate(`console.timeStamp("edge-trigger"); ${spec.js}`);
  const key = (k, code, keyCode, modifiers = 0) =>
    Promise.all(
      ["rawKeyDown", "keyUp"].map((type) =>
        send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: keyCode, modifiers }),
      ),
    );
  await key("k", "KeyK", 75, 2);
  await sleep(600);
  await send("Input.insertText", { text: spec.palette });
  await sleep(600);
  await evaluate(`console.timeStamp("edge-trigger"); true`);
  await key("Enter", "Enter", 13);
}

/* ---------------- trace ---------------- */

async function trace() {
  const page = await open([], { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  const { send, evaluate } = page;
  try {
    await send("DOM.enable");
    await send("DOM.getDocument", { depth: 0 });
    await send("Emulation.setCPUThrottlingRate", { rate: CPU });
    console.log(`trace：${CPU} 倍降速、2x 屏（模拟）、1280×800、${THEME}；第一帧之后的主线程工作\n`);
    for (const scene of SCENES) {
      const events = [];
      const off = page.on("Tracing.dataCollected", (data) => events.push(...data.value));
      await send("Tracing.start", {
        categories: "devtools.timeline,disabled-by-default-devtools.timeline",
        transferMode: "ReportEvents",
      });
      await sleep(200);
      await trigger(page, scene);
      await settle(evaluate, 1200);
      const finished = new Promise((resolve) => page.on("Tracing.tracingComplete", resolve));
      await send("Tracing.end");
      await finished;
      off();
      if (DUMP) {
        fs.mkdirSync(DUMP, { recursive: true });
        fs.writeFileSync(path.join(DUMP, `${scene}.json`), JSON.stringify({ traceEvents: events }));
      }
      await report(send, scene, events);
      await sleep(400);
    }
  } finally {
    await page.close();
  }
}

async function report(send, scene, events) {
  const mark = events.find((e) => e.name === "TimeStamp" && e.args?.data?.message === "edge-trigger");
  if (!mark) {
    console.log(`${SCENE[scene].name}：trace 里没找到触发点`);
    return;
  }
  const main = events.filter((e) => e.pid === mark.pid && e.tid === mark.tid && e.ph === "X");
  const after = main.filter((e) => e.ts >= mark.ts);
  // 第一帧：触发以后第一次 Commit（DOM 变了、侧栏在流里的宽度变了，这一帧该有布局和重绘）
  const firstCommit = after.find((e) => e.name === "Commit");
  const cut = firstCommit ? firstCommit.ts + firstCommit.dur : mark.ts;
  const end = Math.max(...after.map((e) => e.ts + (e.dur ?? 0)));
  const count = (list, name) => list.filter((e) => e.name === name).length;
  const first = after.filter((e) => e.ts < cut);
  const rest = after.filter((e) => e.ts >= cut);
  const ms = (us) => Math.round(us / 1000);
  console.log(`${SCENE[scene].name}（录到触发后 ${ms(end - mark.ts)}ms，第一帧在 +${ms(cut - mark.ts)}ms 画完）`);
  console.log(
    `  第一帧：Layout ${count(first, "Layout")}、Paint ${count(first, "Paint")}、UpdateLayoutTree ${count(first, "UpdateLayoutTree")}`,
  );
  console.log(
    `  之后：  Layout ${count(rest, "Layout")}、Paint ${count(rest, "Paint")}、UpdateLayoutTree ${count(rest, "UpdateLayoutTree")}、PrePaint ${count(rest, "PrePaint")}、Commit ${count(rest, "Commit")}`,
  );
  const describe = async (backendNodeId) => {
    if (!backendNodeId) return "?";
    try {
      const { node } = await send("DOM.describeNode", { backendNodeId });
      const attrs = Object.fromEntries(
        (node.attributes ?? []).reduce((pairs, value, i, all) => (i % 2 ? pairs : [...pairs, [value, all[i + 1]]]), []),
      );
      const label = attrs["aria-label"] ? `[aria-label=${attrs["aria-label"]}]` : "";
      const cls = (attrs.class ?? "").split(/\s+/).filter(Boolean).slice(0, 4).join(".");
      return `${node.nodeName.toLowerCase()}${cls ? `.${cls}` : ""}${label}`;
    } catch {
      return `#${backendNodeId}（已卸载）`;
    }
  };
  for (const e of rest.filter((e) => e.name === "Layout" || e.name === "Paint")) {
    const what =
      e.name === "Layout"
        ? `dirty ${e.args?.beginData?.dirtyObjects ?? "?"} / ${e.args?.beginData?.totalObjects ?? "?"}`
        : await describe(e.args?.data?.nodeId);
    console.log(`    +${ms(e.ts - mark.ts)}ms ${e.name} ${(e.dur / 1000).toFixed(1)}ms  ${what}`);
  }
  console.log("");
}

/* ---------------- seams ---------------- */

async function seams() {
  console.log(`seams：--force-device-scale-factor ${DPRS.join(" / ")}，动画放慢 10 倍，${THEME}\n`);
  for (const dpr of DPRS) {
    const page = await open([`--force-device-scale-factor=${dpr}`, "--window-size=1100,760"]);
    const { send, evaluate } = page;
    try {
      const real = await evaluate("({ dpr: devicePixelRatio, w: innerWidth, h: innerHeight })");
      console.log(`== ${real.dpr} 倍屏（窗口 ${real.w}×${real.h} CSS px）`);
      // 只留形状：几块底和弧线片都在同一个不接指针的容器里
      await evaluate(`(() => {
        const shape = document.querySelector("div.bg-rail.will-change-transform").parentElement;
        shape.setAttribute("data-edge-shape", "");
        const style = document.createElement("style");
        // 底色换成和侧栏色差得远的品红：页面本来的底色就是侧栏色（rail），缝露出来也看不见
        style.textContent = "html, body, #root { background: rgb(255, 0, 255) !important } #root * { visibility: hidden !important } #root [data-edge-shape], #root [data-edge-shape] * { visibility: visible !important }" + ${JSON.stringify(GAP ? `#root [data-edge-shape] > div:nth-child(1) { margin-right: ${4 + GAP}px }` : "")};
        document.head.append(style); return true; })()`);
      await sleep(300);
      const clip = { x: 0, y: 0, width: 340, height: real.h, scale: 1 };
      await send("Animation.enable");
      let rail = [];
      for (const scene of SCENES) {
        await send("Animation.setPlaybackRate", { playbackRate: 0.1 });
        const frames = [];
        const start = Date.now();
        await trigger(page, scene);
        while (Date.now() - start < 9000) {
          frames.push((await send("Page.captureScreenshot", { format: "png", clip })).data);
          await sleep(20);
        }
        await send("Animation.setPlaybackRate", { playbackRate: 1 });
        await settle(evaluate, 300);
        frames.push((await send("Page.captureScreenshot", { format: "png", clip })).data);
        const result = await evaluate(`(async () => {
          const frames = ${JSON.stringify(frames)};
          const decode = async (b64) => { const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
            const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext("2d"); g.drawImage(img, 0, 0);
            return { w: img.width, h: img.height, p: g.getImageData(0, 0, img.width, img.height).data }; };
          const last = await decode(frames.at(-1));
          const k = Math.round(8 * ${real.dpr});
          const at = (k * last.w + k) * 4;
          const rail = [last.p[at], last.p[at + 1], last.p[at + 2]];
          const out = [];
          for (const b64 of frames) {
            const { w, h, p } = await decode(b64);
            const off = (x, y) => { const i = (y * w + x) * 4;
              return Math.max(Math.abs(p[i] - rail[0]), Math.abs(p[i + 1] - rail[1]), Math.abs(p[i + 2] - rail[2])); };
            let n = 0, max = 0; const where = [];
            for (let y = 2; y < h - 3; y++) for (let x = 2; x < w - 3; x++) {
              const d = off(x, y); if (d < 3) continue;
              const across = (dx, dy) => off(x - dx, y - dy) <= 1 &&
                (off(x + dx, y + dy) <= 1 || (off(x + dx, y + dy) >= 3 && off(x + 2 * dx, y + 2 * dy) <= 1));
              if (across(1, 0) || across(0, 1)) { n++; if (d > max) max = d;
                if (where.length < 4) where.push([+(x / ${real.dpr}).toFixed(1), +(y / ${real.dpr}).toFixed(1)]); }
            }
            out.push({ n, max, where });
          }
          return { rail, out };
        })()`);
        rail = result.rail;
        const moving = result.out.slice(0, -1);
        const bad = moving.filter((f) => f.n > 0);
        const still = result.out.at(-1);
        const worst = bad.reduce((a, b) => (b.max > (a?.max ?? -1) ? b : a), null);
        console.log(
          `  ${SCENE[scene].name}：${moving.length} 帧，有缝的 ${bad.length} 帧` +
            (worst ? `（最深差 ${worst.max}，比如 CSS ${JSON.stringify(worst.where)}）` : "") +
            `；静止那一帧 ${still.n ? `有 ${still.n} 个像素（${JSON.stringify(still.where)}）` : "没有"}`,
        );
      }
      console.log(`  （截图里的侧栏色 rgb(${rail.join(", ")})，底色 ${await evaluate("getComputedStyle(document.body).backgroundColor")}）`);
    } finally {
      await page.close();
    }
  }
}
if (MODE === "trace") await trace();
else await seams();
