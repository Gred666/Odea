import { isTauri } from "@/lib/tauri";
import { convertFileSrc } from "@tauri-apps/api/core";
import { type RelayLimits, relayEnv, relayMain } from "./relay";
import SANDBOX_HTML from "./sandbox.html?raw";
import { workerMain } from "./worker";

/* ============================================================
   起一个插件沙箱（docs/插件与跨端.md §5.5）：一个隐藏的 <iframe sandbox="allow-scripts">，
   里面的中转再起一个 Worker 跑插件的脚本（relay.ts 说了为什么）。

   - 不给 allow-same-origin：iframe 的 origin 是 opaque 的，碰不到应用的 localStorage / IndexedDB，
     parent.document 会抛错；也不给 allow-top-navigation、allow-popups、allow-forms
   - iframe 的文档不能是 srcdoc：srcdoc 继承父页面的 CSP，桌面端父页面的 script-src 里没有 'unsafe-inline'，
     中转一行都跑不起来（想放开就得放开整个应用）。所以桌面端从 Rust 的 odea-plugin:// 发一份
     （src-tauri/src/plugins/sandbox.rs），带它自己的 CSP；浏览器预览的页面没有 CSP，用 srcdoc
   - IPC：Windows 上 wry 把 Tauri 的初始化脚本一律注入子框架，iframe 主线程上看得见 __TAURI_INTERNALS__（连 invoke key），
     但调不通：ipc.localhost 的 fetch 被沙箱的 CSP 拦下，退回 postMessage 也没有回应（docs/插件与跨端.md §15.3、§15.8）。
     插件的代码在 Worker 里，那里什么都没有
   - iframe 挂在主窗口的 document 上，从不挪动：弹出窗口是把 React 子树 portal 过去的
     （components/Popouts.tsx），iframe 一换 document 就会重载，状态全丢。所以这里写死全局 document

   握手：iframe 起来先 postMessage「ready」给父页面；这边认准是这个 iframe（event.source）以后，
   新开一条 MessageChannel，把中转的源码、Worker 的源码和一头的端口交过去。之后两边只走这条端口，
   window 上的消息一概不认（iframe 里的脚本再发「ready」也没用）。
   ============================================================ */

export const SANDBOX_SCHEME = "odea-plugin";

/** 中转：iframe 主线程上跑的全部代码（sandbox.html 拿到以后当内联脚本执行） */
export const RELAY_SOURCE = `self.__odeaRelay=function(boot,port){(${relayMain.toString()})(boot,port,(${relayEnv.toString()})());};`;

/** Worker 的源码：插件看到的 odea（worker.ts） */
export const WORKER_SOURCE = `"use strict";(${workerMain.toString()})(self);`;

export interface Sandbox {
  port: MessagePort;
  frame: HTMLIFrameElement;
  dispose(): void;
}

export interface SandboxOptions {
  /** 哪个插件（只用来给 iframe 起名字、调试时认） */
  plugin: string;
  limits: RelayLimits;
  /** 等 iframe 起来多久 */
  timeout?: number;
  /** 换一段中转（只给 scripts/perf/plugin-sandbox.mjs 在 iframe 主线程上跑拒绝测试用） */
  relay?: string;
}

/** iframe 的文档从哪来：桌面端是 Rust 发的 odea-plugin://，浏览器预览是 srcdoc */
export function sandboxSource(): { src: string } | { srcdoc: string } {
  return isTauri
    ? { src: convertFileSrc("sandbox.html", SANDBOX_SCHEME) }
    : { srcdoc: SANDBOX_HTML };
}

export function createSandbox(options: SandboxOptions): Promise<Sandbox> {
  const { plugin, limits, timeout = 10_000, relay = RELAY_SOURCE } = options;
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.dataset.odeaPlugin = plugin;
  frame.title = `插件沙箱：${plugin}`;
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  // 不占地方、不画；display:none 的 iframe 照样跑脚本
  frame.style.display = "none";
  const source = sandboxSource();
  if ("src" in source) frame.src = source.src;
  else frame.srcdoc = source.srcdoc;

  return new Promise<Sandbox>((resolve, reject) => {
    let settled = false;
    let channel: MessageChannel | null = null;
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    };
    const dispose = () => {
      cleanup();
      channel?.port1.close();
      frame.remove();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      dispose();
      reject(new Error("插件的沙箱起不来（等了 10 秒）"));
    }, timeout);
    function onMessage(event: MessageEvent) {
      if (settled || event.source !== frame.contentWindow) return;
      const data = event.data as { odeaSandbox?: unknown } | null;
      if (!data || data.odeaSandbox !== "ready") return;
      settled = true;
      cleanup();
      channel = new MessageChannel();
      // opaque origin 只能用 "*"：消息交给的是 frame.contentWindow 这个对象本身，不会落到别处
      frame.contentWindow!.postMessage(
        { odeaSandbox: "boot", relay, worker: WORKER_SOURCE, limits },
        "*",
        [channel.port2],
      );
      resolve({ port: channel.port1, frame, dispose });
    }
    window.addEventListener("message", onMessage);
    document.body.append(frame);
  });
}

/** 现在挂着的沙箱 iframe 有几个（停用后不留残留，单测、拒绝测试用） */
export function sandboxFrames(): HTMLIFrameElement[] {
  return [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-odea-plugin]")];
}
