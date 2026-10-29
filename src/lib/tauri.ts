import { isTauri as detectTauri, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { type WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { PopoutOp } from "./bindings";

/* ============================================================
   Tauri 运行时的薄封装。
   浏览器里跑（pnpm dev 直开 1420 端口）时全部降级为 no-op，
   这样同一份代码既能在浏览器里快速调 UI，也能跑在桌面壳里。
   ============================================================ */

/** 使用官方检测逻辑；Tauri 2.11 暴露 globalThis.isTauri，不再依赖旧内部字段。 */
export const isTauri = detectTauri();

/**
 * 这个窗口。订阅后端事件一律经它（`events.x(thisWindow()).listen`）：一个窗口一个仓库，
 * 后端的事件只发给那个仓库的窗口（emit_to），可全局的 `listen` 不管发给谁都收（Tauri 把
 * 「听任何目标」的订阅当成全收），别的仓库的变化、同步状态就串到这个窗口里来了
 * （docs/仓库与启动器.md §4.1）
 */
export function thisWindow(): WebviewWindow {
  return getCurrentWebviewWindow();
}

/** 地址上的参数（node 里跑的单测没有 location） */
const search = new URLSearchParams(typeof location === "undefined" ? "" : location.search);

/**
 * 这是哪种窗口：启动器的地址带 `?launcher`；协作的访客窗口（不开仓库）带 `?guest`；
 * 启动以后再开的仓库窗口带 `?quiet`（不播开场）。浏览器预览里也认得：`/?launcher` 就是启动器
 */
export const windowKind: "launcher" | "guest" | "vault" = search.has("launcher")
  ? "launcher"
  : search.has("guest")
    ? "guest"
    : "vault";

/** 启动以后才开的仓库窗口：开场只在冷启动的第一批窗口里播 */
export const quietWindow = search.has("quiet");

async function call<T>(cmd: string, fallback: T, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) return fallback;
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    console.error(`[tauri] ${cmd} failed`, e);
    return fallback;
  }
}

/** 前端首帧渲染完成，通知 Rust 把窗口显示出来。返回时窗口已经 show() 了（开场动画从这一刻开始） */
export function signalReady(): Promise<void> {
  return call("ready", undefined);
}

/** 标题栏上的窗口按钮和拖动区（TitleBar）：主窗口是 win，弹出窗口是 popoutControls */
export interface WindowControls {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<boolean>;
  close: () => Promise<void> | void;
  isMaximized: () => Promise<boolean>;
  startDragging: () => Promise<void>;
}

export const win = {
  minimize: () => call("win_minimize", undefined),
  toggleMaximize: () => call<boolean>("win_toggle_maximize", false),
  close: () => call("win_close", undefined),
  forceClose: () => call("win_force_close", undefined),
  isMaximized: () => call<boolean>("win_is_maximized", false),
  /** 提到前面（从弹出窗口里开了主窗口的对话框） */
  focus: () => call("win_focus", undefined),
  startDragging: async () => {
    if (!isTauri) return;
    try {
      // 必须在 mousedown 的同一调用栈里发起 IPC，不能等待动态 import。
      const started = await tauriInvoke<boolean>("win_start_dragging");
      if (!started) console.error("[tauri] native window drag was rejected");
    } catch (error) {
      console.error("[tauri] startDragging failed", error);
    }
  },
};

/* ---------------- 弹出窗口（docs/标签页与分屏.md §16） ----------------
   弹出窗口里的东西是主窗口的页面画的，命令也从主窗口发：要指名是哪个弹出窗口（Tauri 的窗口标签）。
   Rust 那边只认开它的那个仓库窗口（popout.rs） */

export const popoutOp = (label: string, op: PopoutOp) =>
  call<boolean>("popout_window", false, { label, op });

export const popoutTitle = (label: string, title: string) =>
  call("popout_set_title", undefined, { label, title });

/** 用户关弹出窗口（Alt+F4、任务栏）：Rust 拦下来发给开它的仓库窗口，载荷是弹出窗口的标签 */
export async function onPopoutCloseRequested(
  handler: (label: string) => void,
): Promise<() => void> {
  if (!isTauri) return () => {};
  return thisWindow().listen<string>("popout-close", (event) => handler(event.payload));
}

/** 弹出窗口的标题栏按钮。label 是拿到以后才有的（window.open 之后十几毫秒），用的时候再取 */
export function popoutControls(label: () => string | null, close: () => void): WindowControls {
  const op = async (name: PopoutOp) => {
    const target = label();
    return target ? popoutOp(target, name) : false;
  };
  return {
    minimize: async () => {
      await op("minimize");
    },
    toggleMaximize: () => op("toggleMaximize"),
    close,
    isMaximized: () => op("isMaximized"),
    startDragging: async () => {
      await op("startDragging");
    },
  };
}
