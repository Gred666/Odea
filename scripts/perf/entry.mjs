// 各种窗口打开时要加载多少 JS、主线程忙多久、多久画出第一屏（docs/1110审查与研究.md §5.3）。
//
//   pnpm exec vite build --outDir <目录>
//   node scripts/perf/entry.mjs <目录> [--cpu 4] [--runs 5] [--only launcher,capture,guest,vault] [--out x.json]
//
// 不用 vite preview：脚本自己起一个静态文件服务，不压缩、不带缓存头，接近桌面端从应用的协议读包里的文件。
// 每次都关掉缓存（Network.setCacheDisabled）：桌面端每个窗口都是冷的，没有 HTTP 缓存可用。
// 跑的是浏览器的 mock 后端（启动器、访客窗口、速记小窗在浏览器里也认 `?launcher` 这些参数，lib/tauri.ts）。
//
// 量的：
//   root   第一个 React 节点挂上 #root 的时刻（导航开始算起）
//   ready  root 之后再过两帧（main.tsx 在这时 signalReady，桌面端的窗口这时才显示）
//   busy   从导航到 ready，渲染主线程上的任务一共忙了多久（解析、编译、执行 JS 都在里面）
//   js     ready 之前加载的 JS：几个文件、多少字节（解压后）
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { launch, sleep, traceMainThread } from "./cdp.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const DIR = path.resolve(args.find((arg) => !arg.startsWith("--") && !args[args.indexOf(arg) - 1]?.startsWith("--")) ?? "dist");
const CPU = Number(option("cpu", 4));
const RUNS = Number(option("runs", 5));
const ONLY = option("only", "launcher,capture,guest,vault").split(",");
const OUT = option("out", null);
const HTTP_PORT = Number(option("http", 1471));
const CDP_PORT = Number(option("port", 9351));

const KINDS = {
  launcher: "/?launcher",
  capture: "/?capture",
  guest: "/?guest",
  vault: "/",
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let file = path.join(DIR, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory())
    file = path.join(DIR, "index.html");
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(HTTP_PORT, "127.0.0.1", resolve));
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

/** 每个页面一开始就装上：第一个节点挂上 #root 的时刻，再过两帧算 ready */
const PROBES = `
  window.__entry = {};
  new MutationObserver((_, observer) => {
    if (__entry.root || !document.querySelector("#root > *")) return;
    __entry.root = performance.now();
    observer.disconnect();
    requestAnimationFrame(() => requestAnimationFrame(() => { __entry.ready = performance.now(); }));
  }).observe(document, { childList: true, subtree: true });
  try { sessionStorage.setItem("odea.introPlayed", "1"); } catch {}
`;

const page = await launch(CDP_PORT);
const { send, evaluate } = page;
await send("Page.enable");
await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: PROBES });
await send("Emulation.setCPUThrottlingRate", { rate: CPU });

async function measure(url) {
  let marks = null;
  const { busyMs, longTasks } = await traceMainThread(page, async () => {
    await send("Page.navigate", { url });
    for (let i = 0; i < 600; i++) {
      await sleep(50);
      marks = await evaluate("window.__entry && window.__entry.ready ? window.__entry : null").catch(() => null);
      if (marks) break;
    }
  });
  if (!marks) throw new Error(`${url} 30 秒内没画出来`);
  const scripts = await evaluate(`performance.getEntriesByType("resource")
    .filter((e) => /\\.js$/.test(new URL(e.name).pathname) && e.responseEnd <= ${marks.ready})
    .map((e) => ({ name: new URL(e.name).pathname.split("/").pop(), bytes: e.decodedBodySize }))`);
  return {
    root: Math.round(marks.root),
    ready: Math.round(marks.ready),
    busyMs,
    longestTask: Math.max(0, ...longTasks),
    jsFiles: scripts.length,
    jsBytes: scripts.reduce((sum, s) => sum + s.bytes, 0),
    scripts,
  };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const out = { dir: DIR, cpu: CPU, runs: RUNS };
try {
  // 先开一次仓库窗口：mock 后端第一次要往 localStorage 里铺一份示例仓库，别算进量的里面
  await measure(`${BASE}/`);
  for (const kind of ONLY) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await measure(`${BASE}${KINDS[kind]}`));
    out[kind] = {
      root: median(runs.map((r) => r.root)),
      ready: median(runs.map((r) => r.ready)),
      busyMs: median(runs.map((r) => r.busyMs)),
      longestTask: median(runs.map((r) => r.longestTask)),
      jsFiles: runs[0].jsFiles,
      jsBytes: runs[0].jsBytes,
      scripts: runs[0].scripts.sort((a, b) => b.bytes - a.bytes),
      all: runs.map(({ scripts, ...rest }) => rest),
    };
    const r = out[kind];
    console.log(
      `${kind.padEnd(9)} root ${String(r.root).padStart(5)}ms  ready ${String(r.ready).padStart(5)}ms  ` +
        `主线程 ${String(r.busyMs).padStart(5)}ms  最长任务 ${String(r.longestTask).padStart(4)}ms  ` +
        `JS ${r.jsFiles} 个 ${(r.jsBytes / 1024).toFixed(0)} KB`,
    );
  }
} finally {
  await page.close();
  server.close();
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
