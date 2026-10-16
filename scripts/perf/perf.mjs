// 性能回归脚本：在无头 Chrome 里用浏览器 mock 后端跑一遍常用操作，量出来写成 JSON。
//
//   pnpm build && pnpm exec vite preview --port 1432        （另开一个终端，或 launch.json 的 ontheway-preview）
//   node scripts/perf/perf.mjs http://localhost:1432 --out after.json
//   node scripts/perf/compare.mjs before.json after.json
//
// 默认 4 倍 CPU 降速 + 2x 屏：用户的桌面端（WebView2）比本机的 Chrome 慢好几倍，不降速量不出差别。
// 量生产构建：开发构建（pnpm dev / tauri dev）慢 2.5–3.5 倍，而且 React 是开发模式。
// 选项：--cpu 4  --notes 400（仓库里有多少篇笔记）  --port 9333（Chrome 调试端口）
//       --only startup,switch,typing,arrows,scroll,palette,nav,memory
//
// 按键的延迟是页面里量的「keydown（面板里打字是 input）→ 下一帧画完」（rAF 里再 setTimeout 0）：Event Timing 的按键条目
// 在无头模式下按键之后没有新画面时会一直算到下一次绘制，长尾全是假的。点击（切换笔记、切区）
// 有画面变化，用 Event Timing 的 duration（就是 INP 量的那个）。
import fs from "node:fs";
import { launch, sleep, traceMainThread } from "./cdp.mjs";
import { STRESS_ID, buildState } from "./seed.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const BASE = args.find((arg) => /^https?:/.test(arg)) ?? "http://localhost:1432";
const CPU = Number(option("cpu", 4));
const NOTES = Number(option("notes", 400));
const ONLY = option("only", "startup,switch,typing,arrows,scroll,palette,nav,memory").split(",");

/** 每个页面一开始就装上：Event Timing、长动画帧、按键 → 下一帧、首次挂载的时刻 */
const PROBES = `
  window.__perf = { events: [], frames: [], keys: [], inputs: [], marks: {} };
  new PerformanceObserver((list) => { for (const e of list.getEntries())
    __perf.events.push({ name: e.name, id: e.interactionId, duration: e.duration }); })
    .observe({ type: "event", buffered: true, durationThreshold: 16 });
  new PerformanceObserver((list) => { for (const e of list.getEntries()) __perf.frames.push(e.duration); })
    .observe({ type: "long-animation-frame", buffered: true });
  const afterFrame = (start, sink) =>
    requestAnimationFrame(() => setTimeout(() => sink.push(performance.now() - start), 0));
  addEventListener("keydown", (e) => afterFrame(e.timeStamp, __perf.keys), true);
  addEventListener("input", (e) => afterFrame(e.timeStamp, __perf.inputs), true);
  new MutationObserver((_, observer) => {
    if (!__perf.marks.root && document.querySelector("#root > *")) __perf.marks.root = performance.now();
    if (!__perf.marks.editor && document.querySelector(".cm-content")) __perf.marks.editor = performance.now();
    if (__perf.marks.root && __perf.marks.editor) observer.disconnect();
  }).observe(document, { childList: true, subtree: true });
  // mock 后端每存一次都把整个仓库 JSON.stringify 进 localStorage（几 MB），桌面端是 Rust 写文件：量的时候跳过
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (key === "otw.mock.v5" && window.__perfSeeded) return;
    return setItem.call(this, key, value);
  };
`;

const stats = (values) => {
  const sorted = values.map(Math.round).sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), max: sorted.at(-1) ?? 0 };
};

const page = await launch(Number(option("port", 9333)));
const { send, evaluate } = page;
const out = { base: BASE, cpu: CPU, notes: NOTES };

const loaded = () => new Promise((resolve) => page.on("Page.loadEventFired", resolve));
const reload = async () => {
  const done = loaded();
  await send("Page.reload");
  await done;
};
/** 等主线程安静下来：连续 quietMs 里每一帧都不超过 50ms */
const idle = (quietMs = 500) =>
  evaluate(`new Promise((done) => { const t0 = performance.now(); let last = t0, calm = t0;
    const tick = (t) => { if (t - last > 50) calm = t; last = t;
      if (t - calm > ${quietMs} || t - t0 > 15000) done(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick); })`);
const resetProbes = () =>
  evaluate(
    "__perf.events.length = __perf.frames.length = __perf.keys.length = __perf.inputs.length = 0",
  );
const probes = () =>
  evaluate(
    "({ events: __perf.events.slice(), frames: __perf.frames.slice(), keys: __perf.keys.slice(), inputs: __perf.inputs.slice() })",
  );
/** 一次点击里最慢的那个事件（INP 的口径） */
const clickInp = (events) =>
  Math.round(
    Math.max(
      0,
      ...events
        .filter((e) => ["pointerdown", "pointerup", "click"].includes(e.name))
        .map((e) => e.duration),
    ),
  );
const key = async (keyName, code, keyCode, { modifiers = 0, text } = {}) => {
  await send("Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown",
    key: keyName,
    code,
    windowsVirtualKeyCode: keyCode,
    modifiers,
    text,
    unmodifiedText: text,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: keyName,
    code,
    windowsVirtualKeyCode: keyCode,
    modifiers,
  });
};
const click = async ({ x, y }) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
};
/** 元素（JS 表达式）滚进视野后的点击位置 */
const pointOf = (expression) =>
  evaluate(`(() => { const e = ${expression}; if (!e) return null; e.scrollIntoView({ block: "nearest" });
    const r = e.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 120), y: r.y + r.height / 2 }; })()`);
const openSession = (noteId) =>
  evaluate(
    `localStorage.setItem("otw.session", JSON.stringify({ workspace: "notes", noteId: "${noteId}", archiveId: "", noteFolder: "" })); true`,
  );
const VIEW = "document.querySelector('.cm-content').cmTile.view";
/** 堆里有几个 EditorView（queryObjects 会先做一次 GC）。查完放掉句柄，不然它们被控制台握着 */
const liveEditorViews = async () => {
  const group = { objectGroup: "perf-views" };
  const { result } = await send("Runtime.evaluate", {
    expression: `${VIEW}.constructor.prototype`,
    ...group,
  });
  const { objects } = await send("Runtime.queryObjects", {
    prototypeObjectId: result.objectId,
    ...group,
  });
  const { result: count } = await send("Runtime.callFunctionOn", {
    objectId: objects.objectId,
    functionDeclaration: "function () { return this.length; }",
    returnByValue: true,
    ...group,
  });
  await send("Runtime.releaseObjectGroup", group);
  return count.value;
};

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: PROBES });

  // 造数据：先让应用把它的新仓库（使用指南）写进去，再整个换掉
  const first = loaded();
  await send("Page.navigate", { url: BASE });
  await first;
  for (let i = 0; i < 50 && !(await evaluate(`!!localStorage.getItem("otw.mock.v5")`)); i++)
    await sleep(100);
  const state = buildState(NOTES);
  await evaluate(`(() => { const old = JSON.parse(localStorage.getItem("otw.mock.v5") || "null");
    const state = ${JSON.stringify(state)};
    if (old) state.notes.push(...old.notes.filter((note) => note.id.startsWith("guide-")));
    localStorage.setItem("otw.mock.v5", JSON.stringify(state));
    sessionStorage.setItem("otw.introPlayed", "1"); return true; })()`);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__perfSeeded = true;" });
  await send("Emulation.setCPUThrottlingRate", { rate: CPU });

  if (ONLY.includes("startup")) {
    // 启动：停在一篇短笔记 / 停在长文。每种三次，第一次常常偏慢（缓存还是冷的）
    for (const [label, noteId] of [
      ["startupShort", state.notes[5].id],
      ["startupLong", STRESS_ID],
    ]) {
      await openSession(noteId);
      const runs = [];
      for (let i = 0; i < 3; i++) {
        const { busyMs, longTasks } = await traceMainThread(page, async () => {
          await reload();
          await idle(800);
        });
        const marks = await evaluate("__perf.marks");
        runs.push({
          firstRender: Math.round(marks.root),
          editor: Math.round(marks.editor),
          busyMs,
          longestTask: Math.max(0, ...longTasks),
        });
      }
      out[label] = runs;
    }
  }

  await openSession(STRESS_ID);
  await reload();
  await idle(1000);

  if (ONLY.includes("switch")) {
    // 切换笔记：在列表里点 16 次，其中两次是长文
    const rows = await evaluate(
      `[...document.querySelectorAll('[data-list-scroller] [data-note-row]')].map((e) => e.getAttribute('data-note-row'))`,
    );
    // 只从前 30 行里挑：列表画多少行因版本而异（分批渲染），挑的笔记得每个版本都一样
    const shorts = rows.filter((id) => id !== STRESS_ID).slice(0, 30);
    const picks = Array.from({ length: 14 }, (_, i) => shorts[(i * 7 + 3) % shorts.length]);
    picks.splice(4, 0, STRESS_ID);
    picks.splice(10, 0, STRESS_ID);
    const short = [];
    const long = [];
    for (const id of picks) {
      const at = await pointOf(`document.querySelector('[data-note-row="${id}"]')`);
      if (!at) continue;
      await sleep(200);
      await resetProbes();
      await click(at);
      await idle(500);
      (id === STRESS_ID ? long : short).push(clickInp((await probes()).events));
    }
    out.switch = { short: stats(short), long };
    out.listRows = rows.length;
    // 切过 16 次以后还活着几个编辑器：应该只有眼前这一个。多出来的就是切走的那些连着整棵 DOM
    // 没放掉（2026-10-14 修过一次：切 120 篇留着 122 个）。下面要重新加载，得在这之前数
    await send("HeapProfiler.collectGarbage");
    out.editorViews = await liveEditorViews();
    // 后面打字、滚动都在长文里
    await openSession(STRESS_ID);
    await reload();
    await idle(1000);
  }

  if (ONLY.includes("typing")) {
    // 在长文中间 / 末尾打字：16 个字、回车、6 个退格
    for (const [label, where] of [
      ["typingMiddle", 0.5],
      ["typingEnd", 1],
    ]) {
      await evaluate(`(() => { const v = ${VIEW}; const line = v.state.doc.lineAt(Math.floor(v.state.doc.length * ${where}));
        v.dispatch({ selection: { anchor: line.to }, scrollIntoView: true }); v.focus(); return true; })()`);
      await idle();
      await resetProbes();
      for (const ch of "今天的进度还可以abc def") {
        await key(ch, "", 0, { text: ch });
        await sleep(110);
      }
      await key("Enter", "Enter", 13, { text: "\r" });
      await sleep(110);
      for (let i = 0; i < 6; i++) {
        await key("Backspace", "Backspace", 8);
        await sleep(110);
      }
      await idle(400);
      out[label] = stats((await probes()).keys);
    }
  }

  if (ONLY.includes("arrows")) {
    // 长文里按 30 次 ↓
    await evaluate(`(() => { const v = ${VIEW}; const pos = v.state.doc.line(Math.floor(v.state.doc.lines * 0.3)).from;
      v.dispatch({ selection: { anchor: pos }, scrollIntoView: true }); v.focus(); return true; })()`);
    await idle();
    await resetProbes();
    for (let i = 0; i < 30; i++) {
      await key("ArrowDown", "ArrowDown", 40);
      await sleep(90);
    }
    await idle(400);
    out.arrows = stats((await probes()).keys);
  }

  if (ONLY.includes("scroll")) {
    // 滚轮把长文从头滚下去两遍：第一遍图表、公式第一次画出来，第二遍只看滚动本身
    for (const label of ["scrollFirst", "scrollAgain"]) {
      await evaluate(`document.querySelector('[data-doc-scroller]').scrollTop = 0; true`);
      await idle();
      await evaluate(`(() => { const list = []; let last = performance.now(); __perf.scrollFrames = list;
        const tick = (t) => { list.push(t - last); last = t; if (!__perf.stopFrames) requestAnimationFrame(tick); };
        __perf.stopFrames = false; requestAnimationFrame(tick); return true; })()`);
      for (let i = 0; i < 40; i++) {
        await send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: 900,
          y: 500,
          deltaX: 0,
          deltaY: 240,
        });
        await sleep(40);
      }
      await sleep(500);
      const frames = await evaluate(
        "(() => { __perf.stopFrames = true; return __perf.scrollFrames; })()",
      );
      out[label] = {
        frames: frames.length,
        over33ms: frames.filter((f) => f > 33.4).length,
        ...stats(frames),
      };
    }
  }

  if (ONLY.includes("palette")) {
    // 命令面板：打开 8 次，每次打两个字（搜标题和全文）
    await idle();
    const open = [];
    const typing = [];
    for (let i = 0; i < 8; i++) {
      await resetProbes();
      await key("k", "KeyK", 75, { modifiers: 2 });
      await idle(400);
      open.push(...(await probes()).keys.slice(0, 1));
      await resetProbes();
      for (const ch of i % 2 ? "周报" : "计划") {
        await send("Input.insertText", { text: ch });
        await sleep(250);
      }
      await idle(300);
      typing.push(...(await probes()).inputs);
      await key("Escape", "Escape", 27);
      await idle(400);
    }
    out.palette = { open: stats(open), typing: stats(typing) };
  }

  if (ONLY.includes("nav")) {
    // 左侧导航挨个点一遍，最后回到笔记
    const labels = await evaluate(
      `[...document.querySelectorAll('nav[aria-label="主导航"] button')].map((b) => b.textContent.trim()).filter(Boolean)`,
    );
    out.nav = [];
    for (const label of [...labels.slice(1, 4), labels[0]]) {
      const at = await pointOf(
        `[...document.querySelectorAll('nav[aria-label="主导航"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`,
      );
      if (!at) continue;
      await sleep(200);
      await resetProbes();
      await click(at);
      await idle(700);
      const { events, frames } = await probes();
      out.nav.push({
        label,
        inp: clickInp(events),
        longestFrame: Math.round(Math.max(0, ...frames)),
      });
    }
  }

  if (ONLY.includes("memory")) {
    await send("HeapProfiler.enable");
    await send("HeapProfiler.collectGarbage");
    const memory = await evaluate(
      `({ heap: performance.memory.usedJSHeapSize, nodes: document.getElementsByTagName("*").length })`,
    );
    out.memory = { heapMB: Math.round(memory.heap / 104857.6) / 10, domNodes: memory.nodes };
  }
} finally {
  await page.close();
}

const file = option("out", null);
if (file) fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
