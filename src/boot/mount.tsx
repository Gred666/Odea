import { ErrorBoundary } from "@/components/ErrorBoundary";
import { signalReady } from "@/lib/tauri";
import { installTooltips } from "@/lib/tooltip";
import { type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";

/**
 * 挂上 React，首帧真正上屏后再让 Rust show() 窗口，避免开局白闪（窗口建的时候是 `visible: false`）。
 * 双 rAF：第一帧排进渲染队列，第二帧确认已经 paint。返回时窗口已经显示出来了
 */
export function mount(node: ReactNode): Promise<void> {
  // 悬停提示（docs/悬停提示.md）：每种窗口都装，不靠 React；弹出窗口在 components/Popouts.tsx 里各装一份
  installTooltips(window);
  // 根上一个错误边界（docs/技术方案.md §8.9）：哪里漏了没接住的渲染错误，换成「出错了」，不白屏
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary area="这个窗口" fallback="window">
        {node}
      </ErrorBoundary>
    </StrictMode>,
  );
  return new Promise((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        // 崩溃后重新载入时盖着的那句话（index.html）：画出来了，拿掉
        document.getElementById("recovering")?.remove();
        void signalReady().then(resolve);
      }),
    ),
  );
}
