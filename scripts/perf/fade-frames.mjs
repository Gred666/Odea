// 淡入有没有「结束那一帧闪一下」：逐帧截图和最终帧比（CLAUDE.md「动效：先对齐再动」）
//
//   pnpm dev                                   # 先把开发服务器开着
//   node scripts/perf/fade-frames.mjs [地址]   # 默认 http://localhost:1420/
//
// 1.5 倍屏无头 Chrome，往当前笔记里放一张图，鼠标移上去让右上角的悬停按钮淡入，
// 动画放慢 10 倍，每 ~100ms 截一张按钮那一块，和最终帧逐像素比。
// 正常的淡入：差异一路降到 0。有问题的：中途画面已经不动了、却和最终帧不一样，动画
// 结束那一帧才突然归零 —— 那一下就是用户看到的「闪一下 / 重新渲染了一下」。
// 要查别的控件，改 SCENE 里放进去的正文、要截的选择器和触发方式。
import { launch, sleep } from "./cdp.mjs";

const URL = process.argv[2] ?? "http://localhost:1420/";
const SCENE = {
  markdown: "正文一行。\n\n![图](/src-tauri/icons/Square310x310Logo.png)\n\n后面一行。\n",
  /** 要截的那一块 */
  target: ".cm-otw-image-tools",
  /** 鼠标移到哪里触发 */
  hover: "img.cm-otw-image",
};

const page = await launch(9345);
const { send, evaluate } = page;
try {
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 860,
    deviceScaleFactor: 1.5,
    mobile: false,
  });
  await send("Page.navigate", { url: URL });
  for (let i = 0; i < 100 && !(await evaluate("!!document.querySelector('.cm-editor')")); i++) {
    await sleep(100);
  }
  await sleep(1500);
  await evaluate(`(async () => {
    const { EditorView } = await import('/node_modules/.vite/deps/@codemirror_view.js');
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(SCENE.markdown)} } });
    document.querySelector('[data-doc-scroller]').scrollTop = 0;
    await document.querySelector('img.cm-otw-image')?.decode().catch(() => {});
  })()`);
  await sleep(800);
  const rect = (selector) =>
    evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
  const target = await rect(SCENE.target);
  const hover = await rect(SCENE.hover);
  const clip = {
    x: Math.floor(target.x - 6),
    y: Math.floor(target.y - 6),
    width: Math.ceil(target.width + 12),
    height: Math.ceil(target.height + 12),
    scale: 1,
  };

  await send("Animation.enable");
  await send("Animation.setPlaybackRate", { playbackRate: 0.1 });
  const start = Date.now();
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: hover.x + hover.width / 2,
    y: hover.y + hover.height / 2,
  });
  const frames = [];
  while (Date.now() - start < 3600) {
    frames.push({
      t: Date.now() - start,
      data: (await send("Page.captureScreenshot", { format: "png", clip })).data,
    });
    await sleep(60);
  }
  await sleep(1500);
  const final = (await send("Page.captureScreenshot", { format: "png", clip })).data;
  const diffs = await evaluate(`(async () => {
    const pixels = async (b64) => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, img.width, img.height).data; };
    const F = await pixels(${JSON.stringify(final)});
    const out = [];
    for (const b64 of ${JSON.stringify(frames.map((frame) => frame.data))}) {
      const A = await pixels(b64); let sum = 0, max = 0, changed = 0;
      for (let i = 0; i < A.length; i += 4) {
        const d = Math.abs(A[i] - F[i]) + Math.abs(A[i + 1] - F[i + 1]) + Math.abs(A[i + 2] - F[i + 2]);
        sum += d; if (d > max) max = d; if (d > 6) changed++;
      }
      out.push({ mean: +(sum / (A.length / 4)).toFixed(2), max, changed });
    }
    return out;
  })()`);

  console.log(`${SCENE.target}：${clip.width}×${clip.height} CSS px，1.5 倍屏，动画放慢 10 倍`);
  console.log("动画时间(ms)  平均差  最大差  差得明显的像素");
  frames.forEach((frame, index) => {
    const { mean, max, changed } = diffs[index];
    console.log(
      `${String(Math.round(frame.t / 10)).padStart(10)}  ${String(mean).padStart(6)}  ${String(max).padStart(6)}  ${changed}`,
    );
  });
  // 平台：连着几帧一模一样、又不等于最终帧 —— 画面停住了，结束那一帧还会再变一下
  const last = diffs.findLastIndex((d) => d.mean > 0);
  const plateau = diffs
    .slice(0, last + 1)
    .some((d, i, all) => i > 0 && d.mean > 0.5 && d.mean === all[i - 1].mean);
  console.log(
    plateau
      ? "✗ 有「静止却不等于最终帧」的平台：动画结束那一帧会闪一下"
      : "✓ 一路收敛到最终帧，结束时没有跳变",
  );
} finally {
  await page.close();
}
