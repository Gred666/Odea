// CEF 试验（docs/插件与跨端.md §7.2）：同一个前端分别放进 WebView2 和 CEF，按任务管理器的口径
// （专用工作集，整棵进程树）量内存。先起 launch.json 的 spike-cef-web（生产构建，127.0.0.1:4173），再：
//
//   node scripts/perf/shell-memory.mjs [轮数=3]
//
// 先每个运行时各热一次身（建配置目录、代码缓存，不算数），之后每轮两个运行时交替各跑一次：
// 起外壳 → 等编辑器出来 → 静置 20 秒，量「刚打开」→ 点开列表里的几篇、来回切几个区、在编辑器里
// 打一段字 → 静置 30 秒，量「用了一阵」→ 整棵进程树关掉
//
// 量装好的那一份（tauri build 打的安装包，前端在包里）：SHELL_EXE 指到装好的 exe，SHELL_URL=app
// （不给外壳地址，开包里的 index.html?mock，不用起 spike-cef-web）。给 CEF 另加的开关、配置目录
// 照外壳的 ODEA_CEF_ARGS、ODEA_CEF_CACHE 传（spikes/cef-shell/src/main.rs）
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attach, sleep } from "./cdp.mjs";

const EXE =
  process.env.SHELL_EXE ?? "E:/odea-spike-cef/spikes/cef-shell/target/release/odea-cef-shell.exe";
const URL = process.env.SHELL_URL ?? "http://127.0.0.1:4173/?mock";
const ROUNDS = Number(process.argv[2] ?? 3);
const PORT = { cef: 9351, wry: 9352 };

// 进程树和专用工作集：PowerShell 5.1 读没有 BOM 的脚本按 GBK 解，这里只写 ASCII
const PS = `param([int]$Root)
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
$perf = @{}; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { $perf[[int]$_.IDProcess] = [int64]$_.WorkingSetPrivate }
$ids = New-Object System.Collections.Generic.List[int]; $ids.Add($Root); $i = 0
while ($i -lt $ids.Count) { $cur = $ids[$i]; $all | Where-Object { $_.ParentProcessId -eq $cur } | ForEach-Object { $ids.Add([int]$_.ProcessId) }; $i++ }
$rows = foreach ($id in $ids) {
  $p = $all | Where-Object { $_.ProcessId -eq $id }
  $type = 'main'
  if ($p.CommandLine -match '--type=([a-z-]+)') { $type = $matches[1] }
  if ($p.CommandLine -match '--utility-sub-type=([a-zA-Z.]+)') { $type = $type + ':' + ($matches[1] -replace '^.*\\.', '') }
  if ($p.Name -eq 'msedgewebview2.exe' -and $type -eq 'main') { $type = 'webview2-browser' }
  [pscustomobject]@{ pid = $id; name = $p.Name; type = $type; bytes = $perf[$id] }
}
$rows | ConvertTo-Json -Compress`;
const psFile = path.join(os.tmpdir(), "odea-shell-memory.ps1");
fs.writeFileSync(psFile, PS);

function measure(rootPid) {
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psFile, "-Root", String(rootPid)],
    { encoding: "utf8" },
  );
  const rows = [JSON.parse(out)].flat();
  const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
  const byType = {};
  for (const row of rows) byType[row.type] = mb((byType[row.type] ?? 0) * 1048576 + (row.bytes ?? 0));
  return { total: mb(rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0)), count: rows.length, byType };
}

async function click(page, selector) {
  const box = await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (!box) return false;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", { type, ...box, button: "left", clickCount: 1 });
  }
  return true;
}

async function run(runtime, measured) {
  const started = Date.now();
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      ODEA_RUNTIME: runtime,
      ...(URL === "app" ? {} : { ODEA_URL: URL }),
      ODEA_CDP_PORT: String(PORT.cef),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT.wry}`,
    },
    stdio: "ignore",
  });
  try {
    const port = PORT[runtime];
    const page = await attach(port);
    const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser;
    for (let i = 0; i < 300 && !(await page.evaluate("!!document.querySelector('.cm-content')")); i++) {
      await sleep(100);
    }
    const readyMs = Date.now() - started;
    if (!measured) {
      await sleep(5000);
      page.ws.close();
      return null;
    }
    await sleep(20_000);
    const fresh = measure(child.pid);

    const rows = await page.evaluate(
      "[...document.querySelectorAll('[data-note-row]')].slice(0, 6).map((el) => el.getAttribute('data-note-row'))",
    );
    for (const id of rows) {
      await click(page, `[data-note-row="${id}"]`);
      await sleep(700);
    }
    for (const nav of ["today", "goal", "calendar", "archive", "notes"]) {
      await click(page, `[data-nav="${nav}"]`);
      await sleep(900);
    }
    await page.evaluate("document.querySelector('.cm-content')?.focus()");
    for (let i = 0; i < 30; i++) {
      await page.send("Input.insertText", { text: "这是一段用来量内存的文字，" });
      await sleep(40);
    }
    await page.evaluate(
      "(() => { const s = document.querySelector('[data-doc-scroller]'); if (s) s.scrollTop = s.scrollHeight; })()",
    );
    await sleep(30_000);
    const used = measure(child.pid);
    page.ws.close();
    return { runtime, version, readyMs, notes: rows.length, fresh, used };
  } finally {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // 主进程一倒，有的子进程先自己退了：taskkill 找不到它们就报 255，整棵树其实已经没了
    }
    await sleep(3000);
  }
}

const results = [];
for (const runtime of ["cef", "wry"]) await run(runtime, false);
for (let round = 0; round < ROUNDS; round++) {
  for (const runtime of round % 2 ? ["wry", "cef"] : ["cef", "wry"]) {
    const result = await run(runtime, true);
    results.push(result);
    console.log(
      `${runtime.padEnd(4)} 第 ${round + 1} 轮：编辑器出来 ${result.readyMs}ms，` +
        `刚打开 ${result.fresh.total} MB（${result.fresh.count} 个进程），用了一阵 ${result.used.total} MB；` +
        `${JSON.stringify(result.used.byType)}`,
    );
  }
}
for (const runtime of ["cef", "wry"]) {
  const mine = results.filter((r) => r.runtime === runtime);
  const avg = (pick) => Math.round((mine.reduce((sum, r) => sum + pick(r), 0) / mine.length) * 10) / 10;
  console.log(
    `${runtime}（${mine[0].version}）：编辑器出来 ${avg((r) => r.readyMs)}ms，刚打开 ${avg((r) => r.fresh.total)} MB，` +
      `用了一阵 ${avg((r) => r.used.total)} MB，切过 ${mine[0].notes} 篇`,
  );
}
fs.writeFileSync(path.join(os.tmpdir(), "odea-shell-memory.json"), JSON.stringify(results, null, 2));
