// 实验 5 的另一半：白板文件拿到别的编辑器里打开、改几个字、存，回来标记还在不在。
//
//   node scripts/perf/board/roundtrip-editors.mjs [obsidian|typora]
//
// 用临时的配置目录起编辑器（不碰用户自己的库和设置），走它的 DevTools 协议操作，
// 存完和「原文 + 那一处改动」逐字节比。结束时只关自己起的那个进程。
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, sleep } from "../cdp.mjs";
import { parseBoard, serializeBoard } from "./notation.mjs";
import { BASE } from "./sample.mjs";

const OBSIDIAN = process.env.OBSIDIAN ?? "D:/Obsidian/Obsidian.exe";
const TYPORA = process.env.TYPORA ?? "D:/Program Files/Typora/Typora.exe";
const which = process.argv[2] ?? "obsidian";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "odea-board-editors-"));
const vault = path.join(root, "vault");
fs.mkdirSync(vault);
const original = serializeBoard(BASE, "loose");
const file = path.join(vault, "白板样本.md");
fs.writeFileSync(file, original);
fs.writeFileSync(path.join(vault, "性能基线.md"), "两千篇：40 秒。\n");
console.log(`临时目录 ${root}`);

const kill = (child) => {
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // 已经退了
  }
};

async function pageOf(port, match) {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = list.find((t) => t.type === "page" && match(t));
      if (target) return connect(target.webSocketDebuggerUrl);
    } catch {
      // 还没起来
    }
    await sleep(200);
  }
  throw new Error("调试端口上没等到页面");
}

/** 逐行比，打印不一样的行 */
function report(name, expected, actual) {
  if (expected === actual) {
    console.log(`✓ ${name}：除了改的那一处，一个字节不差`);
    return;
  }
  console.log(`✗ ${name}：文件别处也变了`);
  const [a, b] = [expected.split("\n"), actual.split("\n")];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) console.log(`   第 ${i + 1} 行\n   - ${JSON.stringify(a[i])}\n   + ${JSON.stringify(b[i])}`);
  }
  const board = parseBoard(actual);
  console.log(
    `   读回来：${board.items.length} 个对象（原来 ${BASE.items.length} 个），` +
      `有位置的 ${board.items.filter((item) => item.x !== undefined).length} 个`,
  );
}

async function obsidian() {
  const data = path.join(root, "obsidian-data");
  fs.mkdirSync(data);
  // 用户机器上更新下来的那一版，免得临时配置里的老版本自己去下更新
  const mine = path.join(process.env.APPDATA ?? "", "obsidian");
  const asar = fs.existsSync(mine)
    ? fs.readdirSync(mine).filter((name) => /^obsidian-.*\.asar$/.test(name)).sort().at(-1)
    : null;
  if (asar) fs.copyFileSync(path.join(mine, asar), path.join(data, asar));
  fs.writeFileSync(
    path.join(data, "obsidian.json"),
    JSON.stringify({
      vaults: { "0199f3c2aaaa0001": { path: vault, ts: Date.now(), open: true } },
      updateDisabled: true,
    }),
  );
  const port = 9491;
  const child = spawn(OBSIDIAN, [`--user-data-dir=${data}`, `--remote-debugging-port=${port}`], {
    stdio: "ignore",
  });
  try {
    const page = await pageOf(port, (t) => t.url.startsWith("app://obsidian.md"));
    for (let i = 0; i < 100; i++) {
      if (await page.evaluate("typeof app !== 'undefined' && !!app.workspace?.layoutReady")) break;
      await sleep(200);
    }
    console.log(`Obsidian ${await page.evaluate("require('electron').ipcRenderer.sendSync('version')")}`);
    await page.evaluate(`(async () => {
      const file = app.vault.getAbstractFileByPath('白板样本.md');
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(file);
      window.__leaf = leaf;
    })()`);
    await sleep(1200);

    const live = await page.evaluate(`(() => {
      const view = __leaf.view;
      const text = view.contentEl.querySelector('.cm-content').innerText;
      return { mode: view.getMode(), source: view.getState().source, showsMarker: text.includes('@card'), text };
    })()`);
    console.log(
      `实时预览（mode=${live.mode}，source=${live.source}）里${live.showsMarker ? "看得见" : "看不见"}标记`,
    );
    fs.writeFileSync(
      path.join(root, "obsidian-live.png"),
      Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64"),
    );

    // 在一张卡片的字前面打几个字，存
    await page.evaluate(`(async () => {
      const view = __leaf.view;
      const line = view.editor.getValue().split('\\n').indexOf('图片并行读，限 4 路。');
      view.editor.replaceRange('（Obsidian 里改的）', { line, ch: 0 });
      await view.save();
    })()`);
    await sleep(2500);
    report(
      "Obsidian 改正文",
      original.replace("图片并行读，限 4 路。", "（Obsidian 里改的）图片并行读，限 4 路。"),
      fs.readFileSync(file, "utf8"),
    );

    // 阅读视图里标记显不显示
    const reading = await page.evaluate(`(async () => {
      await __leaf.setViewState({ type: 'markdown', state: { file: '白板样本.md', mode: 'preview' } });
      await new Promise((r) => setTimeout(r, 1500));
      const text = __leaf.view.contentEl.querySelector('.markdown-preview-view').innerText;
      return { showsMarker: text.includes('@card') || text.includes('@frame'), text };
    })()`);
    console.log(`阅读视图里${reading.showsMarker ? "看得见" : "看不见"}标记`);
    fs.writeFileSync(
      path.join(root, "obsidian-reading.png"),
      Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64"),
    );

    // 经属性面板那条路改属性块（它会把 YAML 重写一遍）
    const before = fs.readFileSync(file, "utf8");
    await page.evaluate(`(async () => {
      const file = app.vault.getAbstractFileByPath('白板样本.md');
      await app.fileManager.processFrontMatter(file, (fm) => { fm.tags = ['白板']; });
    })()`);
    await sleep(1500);
    const after = fs.readFileSync(file, "utf8");
    const head = (text) => text.slice(0, text.indexOf("\n---", 4) + 4);
    console.log(`改属性之后的属性块：\n${head(after)}`);
    report("Obsidian 改属性（正文部分）", before.slice(head(before).length), after.slice(head(after).length));
    page.ws.close();
  } finally {
    kill(child);
  }
}

async function typora() {
  const data = path.join(root, "typora-data");
  fs.mkdirSync(data);
  const port = 9492;
  const child = spawn(TYPORA, [`--user-data-dir=${data}`, `--remote-debugging-port=${port}`, file], {
    stdio: "ignore",
  });
  try {
    const page = await pageOf(port, (t) => /window\.html|typemark/.test(t.url));
    await sleep(3000);
    const info = await page.evaluate(`(() => ({
      url: location.href,
      title: document.title,
      hasWrite: !!document.querySelector('#write'),
      fileKeys: typeof File === 'object' ? Object.keys(File).slice(0, 80) : null,
      text: document.querySelector('#write')?.innerText.slice(0, 600),
    }))()`);
    console.log(JSON.stringify(info, null, 1));
    fs.writeFileSync(
      path.join(root, "typora.png"),
      Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64"),
    );
    if (process.argv[3] === "probe") return;

    // 把光标放到那张卡片的字前面，打几个字（真的输入事件），再让它存
    await page.evaluate(`(() => {
      const walker = document.createTreeWalker(document.querySelector('#write'), NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) if (node.data.includes('图片并行读')) break;
      const range = document.createRange();
      range.setStart(node, node.data.indexOf('图片并行读'));
      range.collapse(true);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.querySelector('#write').focus();
    })()`);
    await page.send("Input.insertText", { text: "（Typora 里改的）" });
    await sleep(500);
    const saved = await page.evaluate(`(async () => {
      if (typeof File?.saveUseNode === 'function') { await File.saveUseNode(); return 'File.saveUseNode'; }
      if (typeof File?.save === 'function') { await File.save(); return 'File.save'; }
      return null;
    })()`);
    console.log(`存盘走的是 ${saved}`);
    await sleep(2000);
    report(
      "Typora 改正文",
      original.replace("图片并行读，限 4 路。", "（Typora 里改的）图片并行读，限 4 路。"),
      fs.readFileSync(file, "utf8"),
    );
    page.ws.close();
  } finally {
    kill(child);
  }
}

try {
  if (which === "obsidian") await obsidian();
  else await typora();
} finally {
  console.log(`截图和改过的文件留在 ${root}`);
}
