// 起一个带额外参数的无头 Chrome（cdp.mjs 的 launch 不收参数）。
// 要真的 1.25 / 1.5 倍屏得用 --force-device-scale-factor 起：DevTools 模拟的倍率排版还按 1 倍算（docs/VERIFICATION.md「逐帧对比」）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, sleep } from "../cdp.mjs";

const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

export async function launchChrome(port, flags = []) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "odea-board-"));
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
      "--window-size=1280,900",
      ...flags,
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
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      try {
        fs.rmSync(profile, { recursive: true, force: true });
        return;
      } catch {
        // 子进程还没退干净，等一下再删
      }
    }
  };
  return page;
}
