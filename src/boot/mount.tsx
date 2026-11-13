import { signalReady } from "@/lib/tauri";
import { type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";

/**
 * 挂上 React，首帧真正上屏后再让 Rust show() 窗口，避免开局白闪（窗口建的时候是 `visible: false`）。
 * 双 rAF：第一帧排进渲染队列，第二帧确认已经 paint。返回时窗口已经显示出来了
 */
export function mount(node: ReactNode): Promise<void> {
  createRoot(document.getElementById("root")!).render(<StrictMode>{node}</StrictMode>);
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => void signalReady().then(resolve))),
  );
}
