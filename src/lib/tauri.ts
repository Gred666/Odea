import { isTauri as detectTauri, invoke as tauriInvoke } from "@tauri-apps/api/core";

/* ============================================================
   Tauri 运行时的薄封装。
   浏览器里跑（pnpm dev 直开 1420 端口）时全部降级为 no-op，
   这样同一份代码既能在浏览器里快速调 UI，也能跑在桌面壳里。
   ============================================================ */

/** 使用官方检测逻辑；Tauri 2.11 暴露 globalThis.isTauri，不再依赖旧内部字段。 */
export const isTauri = detectTauri();

async function call<T>(cmd: string, fallback: T): Promise<T> {
  if (!isTauri) return fallback;
  try {
    return await tauriInvoke<T>(cmd);
  } catch (e) {
    console.error(`[tauri] ${cmd} failed`, e);
    return fallback;
  }
}

/** 前端首帧渲染完成，通知 Rust 把窗口显示出来。返回时窗口已经 show() 了（开场动画从这一刻开始） */
export function signalReady(): Promise<void> {
  return call("ready", undefined);
}

export const win = {
  minimize: () => call("win_minimize", undefined),
  toggleMaximize: () => call<boolean>("win_toggle_maximize", false),
  close: () => call("win_close", undefined),
  forceClose: () => call("win_force_close", undefined),
  isMaximized: () => call<boolean>("win_is_maximized", false),
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
