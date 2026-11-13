import { messageOf, useData } from "@/data/store";
import { events, commands } from "@/lib/bindings";
import { isTauri, thisWindow } from "@/lib/tauri";
import { installedPlugins } from "@/plugins/registry";

/* ============================================================
   全局快捷键速记（src-tauri/src/quick_capture.rs）在仓库窗口这一头：快捷键小窗记下的一行，Rust 交给
   最近用过的、开着日程的仓库窗口（CaptureRequest），这里交给开着的、会接的插件（Plugin.capture：
   日程记进今日TODO），做完了回话（capture_answer），小窗据此说「记下了」或者为什么没记上。
   核心不认得「今天」：记到哪由插件定
   ============================================================ */

export function startQuickCapture(): void {
  if (!isTauri) return;
  void events.captureRequest(thisWindow()).listen(async ({ payload }) => {
    const enabled = new Set(useData.getState().layout.plugins);
    const plugin = installedPlugins().find((item) => item.capture && enabled.has(item.id));
    let error: string | null = null;
    if (!plugin?.capture) {
      error = "这个仓库没开日程，没有今日TODO";
    } else {
      try {
        await plugin.capture(payload.text);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : messageOf(cause);
      }
    }
    await commands.captureAnswer(payload.id, error).catch(() => {});
  });
}
