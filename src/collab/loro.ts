import * as loro from "loro-crdt";

/* ============================================================
   Loro 的 wasm 什么时候加载（docs/协同编辑.md §20.2）。

   桌面端和浏览器预览里 `loro-crdt` 被 vite.config.ts 换成了 `loro-crdt/web`：用之前要 await 它的
   init()，wasm 流式编译、不卡主线程（3.4MB，gzip 1.1MB）。它的 browser 版是同步 XHR + 同步编译，
   第一次开始协作时会把界面卡住一下，不用。
   测试（Node）里是 node 版，加载时就好了，init 没有 —— 这里什么都不做。

   协作的代码本来就只在真要协作时才动态加载（collab/store.ts 的 heavy），在那里等它。
   ============================================================ */

let ready: Promise<void> | null = null;

export function ensureLoro(): Promise<void> {
  const init = (loro as unknown as { default?: () => Promise<unknown> }).default;
  if (typeof init !== "function") return Promise.resolve();
  ready ??= init().then(() => undefined);
  return ready;
}
