// 无头 Chrome + DevTools 协议的最小封装（不装 puppeteer / playwright：Node 24 自带 WebSocket）
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 起一个用临时配置目录的无头 Chrome，开一个空白页连上去。关的时候连配置目录一起删 */
export async function launch(port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "otw-perf-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch {
      // 还没起来
    }
    await sleep(100);
  }
  const target = await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
  ).json();
  const page = await connect(target.webSocketDebuggerUrl);
  page.close = async () => {
    page.ws.close();
    chrome.kill();
    await sleep(500);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  return page;
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(JSON.stringify(data.error)));
      else resolve(data.result);
    } else if (data.method) {
      for (const listener of listeners.get(data.method) ?? []) listener(data.params);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const on = (method, listener) => {
    listeners.set(method, [...(listeners.get(method) ?? []), listener]);
    return () =>
      listeners.set(
        method,
        (listeners.get(method) ?? []).filter((l) => l !== listener),
      );
  };
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 800));
    return result.result.value;
  };
  return { ws, send, on, evaluate };
}

/** 录一段 trace，返回渲染主线程上的任务：总忙碌时间、超过 50ms 的长任务 */
export async function traceMainThread(page, run) {
  const events = [];
  const off = page.on("Tracing.dataCollected", (data) => events.push(...data.value));
  await page.send("Tracing.start", {
    categories: "devtools.timeline,disabled-by-default-devtools.timeline",
    transferMode: "ReportEvents",
  });
  await run();
  const done = new Promise((resolve) => page.on("Tracing.tracingComplete", resolve));
  await page.send("Tracing.end");
  await done;
  off();
  const main = events.find(
    (e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain",
  );
  if (!main) return { busyMs: 0, longTasks: [] };
  const tasks = events.filter(
    (e) =>
      e.pid === main.pid &&
      e.tid === main.tid &&
      e.ph === "X" &&
      (e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask"),
  );
  return {
    busyMs: Math.round(tasks.reduce((sum, task) => sum + task.dur / 1000, 0)),
    longTasks: tasks.filter((task) => task.dur > 50_000).map((task) => Math.round(task.dur / 1000)),
  };
}
