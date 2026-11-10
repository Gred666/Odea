// 带脚本的插件（L1）的沙箱，在真的浏览器内核里验（docs/插件与跨端.md §5.5 的拒绝测试、§10 P14.3 的验收）
//
//   pnpm exec vite --host 127.0.0.1 --port 1434        # 浏览器预览开着
//   node scripts/perf/plugin-sandbox.mjs [地址]        # 无头 Chrome，默认 http://127.0.0.1:1434/
//   node scripts/perf/plugin-sandbox.mjs --cdp 9333    # 接到开着的桌面端（WebView2 的调试端口，pnpm tauri dev）
//
// 单测（src/plugins/sandbox/*.test.ts）里的沙箱是进程里的一对假端口，隔离是假的；这里起真的
// <iframe sandbox="allow-scripts"> 和它里面的 Worker（plugins/sandbox/host.ts），查：
//
// 1. 拒绝测试，iframe 主线程和 Worker 里各跑一遍：
//    - 没有 __TAURI_INTERNALS__、window.ipc；经 WebView2 的 chrome.webview.postMessage、ipc.localhost 调命令都不成
//      （桌面端还回头看一眼：仓库标记里没多出那个插件）
//    - 网络全关：应用自己的地址、外网、WebSocket、importScripts 外网脚本都被拦
//    - 读不到应用的 localStorage、IndexedDB、Cache、cookie；同名的 BroadcastChannel 两个方向都收不到
//    - parent.document 抛错；改不了顶层窗口的地址；开不了新窗口
// 2. 死循环：插件的命令里 while(true)。主线程照常（计时器不拖、帧不掉），5 秒超时、两次就停下它，
//    iframe 和 Worker 都没了（DevTools 协议看 Worker 的 target 是不是走了）
// 3. 插件启动时抛错：启动失败，沙箱拆掉
import { connect, launch, sleep } from "./cdp.mjs";

const args = process.argv.slice(2);
const cdpAt = args.indexOf("--cdp");
const desktop = cdpAt >= 0;

let page;
if (desktop) {
  const port = Number(args[cdpAt + 1] ?? 9333);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  // 仓库窗口：地址不带 launcher、guest，也不是弹出窗口的 about:blank
  const target = targets.find(
    (item) => item.type === "page" && /^https?:/.test(item.url) && !/[?&](launcher|guest)/.test(item.url),
  );
  if (!target) throw new Error(`端口 ${port} 上没找到仓库窗口：${targets.map((item) => item.url).join(", ")}`);
  page = await connect(target.webSocketDebuggerUrl);
  page.close = async () => page.ws.close();
} else {
  page = await launch(9351);
  await page.send("Page.enable");
  await page.send("Page.navigate", { url: args[0] ?? "http://127.0.0.1:1434/" });
}
const { send, on, evaluate } = page;

// Worker 的 target 来了、走了（看停下以后 Worker 是不是真没了）
const workers = new Map();
on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
  if (targetInfo.type === "worker") workers.set(sessionId, targetInfo.url);
});
on("Target.detachedFromTarget", ({ sessionId }) => workers.delete(sessionId));
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

let failed = false;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed = true;
};

try {
  for (let i = 0; i < 200 && !(await evaluate("!!document.querySelector('[data-doc-scroller]')")); i++) {
    await sleep(100);
  }
  // 页面用的那一份模块（tauri dev 里带 ?t= 时间戳，自己拼地址拿到的是另一份）
  await evaluate(`window.__probeImport = (path) => {
    const hit = performance.getEntriesByType("resource").map((entry) => entry.name)
      .find((name) => new URL(name).pathname === path);
    return import(hit ?? path);
  }; true`);

  /* ---------------- 1. 拒绝测试 ---------------- */

  const results = await evaluate(`(async () => {
    const host = await window.__probeImport("/src/plugins/sandbox/host.ts");
    const appUrl = location.origin + "/";
    const channelName = "odea-probe-" + Math.random().toString(36).slice(2);

    // 两个地方共用的那几项（iframe 主线程、Worker 里都有的 API）
    const common = async (ctx, scope) => {
      const out = {};
      const rejects = async (name, run) => {
        try { await run(); out[name] = "没拦住"; } catch (error) { out[name] = "拦下了"; }
      };
      // Windows 上 wry 的初始化脚本一律注入子框架：iframe 主线程上看得见（记一笔「注」），要紧的是调不调得通（下面几条）。
      // Worker 里一定不能有
      const seen = (present) =>
        !present ? "拦下了" : typeof document !== "undefined" ? "注：看得见（Windows 上 wry 一律注入子框架），调不调得通见下" : "有";
      out["没有 __TAURI_INTERNALS__"] = seen(typeof scope.__TAURI_INTERNALS__ !== "undefined");
      out["没有 __TAURI__ / isTauri"] = seen(typeof scope.__TAURI__ !== "undefined" || typeof scope.isTauri !== "undefined");
      out["没有 window.ipc"] = seen(typeof scope.ipc !== "undefined");
      await rejects("fetch 应用自己的地址", () => fetch(ctx.appUrl, { mode: "no-cors" }));
      await rejects("fetch 外网", () => fetch("https://example.com/", { mode: "no-cors" }));
      await rejects("fetch ipc.localhost", () =>
        fetch("http://ipc.localhost/vault_info", { method: "POST", body: "{}" }));
      await rejects("fetch ipc://", () => fetch("ipc://localhost/vault_info", { method: "POST", body: "{}" }));
      await rejects("WebSocket", () => new Promise((resolve, reject) => {
        const socket = new WebSocket("wss://example.com/");
        socket.onopen = resolve;
        socket.onerror = reject;
        setTimeout(() => reject(new Error("没连上")), 3000);
      }));
      await rejects("IndexedDB", () => new Promise((resolve, reject) => {
        const request = indexedDB.open("odea-probe");
        request.onsuccess = resolve;
        request.onerror = reject;
      }));
      await rejects("CacheStorage", () => caches.keys());
      // BroadcastChannel：应用那一头在发，这里收不到；这里发的，应用那一头也收不到（scripts 里另外看）
      out["BroadcastChannel 收不到应用的"] = await new Promise((resolve) => {
        const channel = new BroadcastChannel(ctx.channelName);
        let got = false;
        // 只认应用发的：iframe 和它的 Worker 是同一个（opaque）origin，彼此收得到是对的
        channel.onmessage = (event) => { if (event.data === "来自应用") got = true; };
        channel.postMessage("来自沙箱");
        setTimeout(() => { channel.close(); resolve(got ? "收到了" : "拦下了"); }, 800);
      });
      return out;
    };

    const frameProbes = async (ctx) => {
      const out = await common(ctx, window);
      const throws = (name, run) => { try { run(); out[name] = "没拦住"; } catch { out[name] = "拦下了"; } };
      throws("localStorage", () => localStorage.getItem("odea.session"));
      throws("document.cookie", () => document.cookie);
      throws("parent.document", () => parent.document.title);
      throws("改顶层窗口的地址", () => { top.location.href = ctx.appUrl + "#probe-hacked"; });
      out["开新窗口"] = window.open("about:blank") === null ? "拦下了" : "开出来了";
      // WebView2 的宿主通道：发一条调命令的消息（没有 invoke key），桌面端事后看仓库标记有没有变
      const webview = window.chrome && window.chrome.webview;
      if (webview && webview.postMessage) {
        try {
          webview.postMessage(JSON.stringify({ cmd: "vault_set_extension", callback: 1, error: 2,
            payload: { id: "probe.should-not-exist", on: true, version: null }, options: {} }));
          out["chrome.webview.postMessage"] = "发出去了（事后看有没有生效）";
        } catch { out["chrome.webview.postMessage"] = "拦下了"; }
      } else {
        out["chrome.webview.postMessage"] = "拦下了（没有这个通道）";
      }
      // Windows 上 wry 的初始化脚本一律注入子框架（wry 0.55 webview2：「scripts are always added to
      // subframes」），iframe 主线程上有 __TAURI_INTERNALS__、invoke key 也在。要看的是真的调不调得通
      const internals = window.__TAURI_INTERNALS__;
      if (internals && internals.invoke) {
        const call = (cmd, args) => Promise.race([
          Promise.resolve().then(() => internals.invoke(cmd, args)).then(
            (value) => "没拦住：" + JSON.stringify(value).slice(0, 60),
            (error) => "拦下了（报错：" + String(error && error.message || error).slice(0, 60) + "）"),
          new Promise((resolve) => setTimeout(() => resolve("拦下了（一直没回应）"), 3000)),
        ]);
        out["__TAURI_INTERNALS__.invoke 读"] = await call("vault_info");
        out["__TAURI_INTERNALS__.invoke 写"] = await call("vault_set_extension",
          { id: "probe.via-internals", on: true, version: null });
      }
      return out;
    };

    const workerProbes = async (ctx) => {
      const out = await common(ctx, self);
      out["Worker 里没有 document、parent"] =
        typeof document === "undefined" && typeof parent === "undefined" ? "拦下了" : "有";
      out["Worker 里没有 localStorage"] = typeof localStorage === "undefined" ? "拦下了" : "有";
      try { importScripts("https://example.com/x.js"); out["importScripts 外网"] = "没拦住"; }
      catch { out["importScripts 外网"] = "拦下了"; }
      return out;
    };

    const ctx = { appUrl, channelName };
    // 中转：先照常起 Worker，再在 iframe 主线程上跑一遍
    const relay = host.RELAY_SOURCE + ";(function(){var normal=self.__odeaRelay;self.__odeaRelay=function(boot,port){" +
      "normal(boot,port);var common=(" + common + ");(" + frameProbes + ")(" + JSON.stringify(ctx) + ").then(function(r){port.postMessage({relay:'probe',where:'frame',results:r});});};})();";
    // 应用这一头：同名的频道一直在发，也看沙箱发的到不到这里
    const appChannel = new BroadcastChannel(channelName);
    let appGot = false;
    appChannel.onmessage = (event) => { if (event.data === "来自沙箱") appGot = true; };
    const ticker = setInterval(() => appChannel.postMessage("来自应用"), 50);

    const sandbox = await host.createSandbox({ plugin: "probe", limits: { messagesPerSecond: 2000 }, relay });
    const done = { frame: null, worker: null };
    sandbox.port.onmessage = (event) => {
      const data = event.data;
      for (const message of Array.isArray(data) ? data : [data]) {
        if (message && message.relay === "probe") done[message.where] = message.results;
        if (message && message.method === "probe") done.worker = message.params;
      }
    };
    // Worker 里那一份当插件的脚本载进去
    const code = "var common=(" + common + ");(" + workerProbes + ")(" + JSON.stringify(ctx) + ").then(function(r){self.postMessage({method:'probe',params:r});});";
    sandbox.port.postMessage({ id: 1, method: "activate", params: { code, plugin: { id: "probe", version: "0" }, capabilities: [], host: {} } });
    for (let i = 0; i < 200 && !(done.frame && done.worker); i++) await new Promise((r) => setTimeout(r, 50));
    clearInterval(ticker);
    appChannel.close();
    const frames = host.sandboxFrames().length;
    sandbox.dispose();
    return { ...done, appGot, hash: location.hash, framesWhileOpen: frames, framesAfter: host.sandboxFrames().length };
  })()`);

  for (const where of ["frame", "worker"]) {
    const list = results[where];
    if (!list) {
      check(`${where === "frame" ? "iframe 主线程" : "Worker"}里的探针跑完了`, false, "没回来");
      continue;
    }
    console.log(`— ${where === "frame" ? "iframe 主线程" : "Worker"}里：`);
    for (const [name, value] of Object.entries(list)) {
      if (value.startsWith("注：")) console.log(`·   ${name}  ${value.slice(2)}`);
      else check(`  ${name}`, value.startsWith("拦下了") || value.startsWith("发出去了"), value);
    }
  }
  check("应用那一头收不到沙箱发的 BroadcastChannel", !results.appGot);
  check("顶层窗口的地址没被改", !results.hash.includes("probe-hacked"), results.hash || "（没有 #）");
  check("沙箱拆掉以后 iframe 没了", results.framesWhileOpen === 1 && results.framesAfter === 0);
  if (desktop) {
    await sleep(800);
    const extensions = await evaluate(
      "window.__TAURI_INTERNALS__.invoke('vault_info').then((info) => info.layout.extensions.map((e) => e.id))",
    );
    check("经 chrome.webview、iframe 里的 __TAURI_INTERNALS__ 发的命令都没生效（仓库标记里没有 probe.*）",
      !extensions.some((id) => id.startsWith("probe.")), JSON.stringify(extensions));
  }

  /* ---------------- 2. 死循环 ---------------- */

  const loop = await evaluate(`(async () => {
    const host = await window.__probeImport("/src/plugins/sandbox/host.ts");
    const { PluginRuntime, LIMITS } = await window.__probeImport("/src/plugins/sandbox/runtime.ts");
    const manifest = { id: "probe.loop", name: "死循环", version: "0.0.1", contributes: { commands: [{ id: "loop", title: "loop" }] } };
    const warnings = [];
    const noop = () => () => {};
    const runtime = new PluginRuntime(manifest, 'odea.commands.register("loop", () => { while (true) {} });', [],
      { current: () => null, isVisible: () => false, read: async () => null, list: () => [], edit: () => null,
        notify() {}, onCurrentChange: noop, onDocumentChange: noop, pushSlot() {}, slotTree: () => null },
      async (m) => { const s = await host.createSandbox({ plugin: m.id, limits: { messagesPerSecond: 2000 } }); return { port: s.port, dispose: s.dispose }; },
      { onStatus() {}, onLog() {}, onWarn: (message) => warnings.push(message) },
      { ...LIMITS, pingInterval: 1e9 });
    await runtime.start();
    const framesRunning = host.sandboxFrames().length;
    // 主线程这边：每 16ms 一个计时器，记最长隔了多久
    let last = performance.now(), worst = 0, ticks = 0;
    const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; ticks++; }, 16);
    const started = performance.now();
    const first = await runtime.runCommand("loop").then(() => "回来了", (error) => error.code);
    const firstMs = Math.round(performance.now() - started);
    const statusAfterFirst = runtime.status.state;
    const second = await runtime.runCommand("loop").then(() => "回来了", (error) => error.code);
    clearInterval(timer);
    return { first, firstMs, statusAfterFirst, second, status: runtime.status, warnings,
      worstGap: Math.round(worst), ticks, framesRunning, framesAfter: host.sandboxFrames().length };
  })()`);
  check("死循环的命令 5 秒超时", loop.first === "timeout", `${loop.firstMs}ms`);
  check("第一次超时只警告、还在跑", loop.statusAfterFirst === "running", loop.warnings[0] ?? "");
  check("第二次就停下它", loop.second === "timeout" && loop.status.state === "stopped", loop.status.message ?? "");
  check("插件死循环时主线程照常（计时器最长隔了多久）", loop.worstGap < 200, `${loop.worstGap}ms，${loop.ticks} 次`);
  check("停下以后 iframe 没了", loop.framesRunning === 1 && loop.framesAfter === 0);
  await sleep(1000);
  check("停下以后 Worker 也没了", ![...workers.values()].some((url) => url.startsWith("blob:")), JSON.stringify([...workers.values()]));

  /* ---------------- 3. 启动时抛错 ---------------- */

  const thrown = await evaluate(`(async () => {
    const host = await window.__probeImport("/src/plugins/sandbox/host.ts");
    const { PluginRuntime, LIMITS } = await window.__probeImport("/src/plugins/sandbox/runtime.ts");
    const noop = () => () => {};
    const runtime = new PluginRuntime({ id: "probe.throw", name: "抛错", version: "0.0.1", contributes: {} },
      'throw new Error("我坏了")', [],
      { current: () => null, isVisible: () => false, read: async () => null, list: () => [], edit: () => null,
        notify() {}, onCurrentChange: noop, onDocumentChange: noop, pushSlot() {}, slotTree: () => null },
      async (m) => { const s = await host.createSandbox({ plugin: m.id, limits: { messagesPerSecond: 2000 } }); return { port: s.port, dispose: s.dispose }; },
      { onStatus() {}, onLog() {}, onWarn() {} }, LIMITS);
    const error = await runtime.start().then(() => "起来了", (e) => e.message);
    return { error, status: runtime.status.state, frames: host.sandboxFrames().length };
  })()`);
  check("启动时抛错：启动失败，报出原因", thrown.status === "failed" && thrown.error.includes("我坏了"), thrown.error);
  check("启动失败以后沙箱拆掉了", thrown.frames === 0);
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  await page.close();
}
console.log(failed ? "\n有没过的" : "\n全部通过");
process.exit(failed ? 1 : 0);
