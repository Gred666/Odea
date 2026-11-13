import { isTauri } from "@/lib/tauri";

/* 从 editor/links.ts 挪出来：启动器、同步 / 中继 / 更新对话框也要开网址，
   留在那边的话为了这一个函数要把 CodeMirror 整个带进来（docs/1110审查与研究.md §5.3.1） */

/** 只放行 http(s) / mailto / tel；本地路径和 javascript: 一律不开。 */
export function isOpenableUrl(url: string): boolean {
  return /^(?:https?:\/\/|mailto:|tel:)/i.test(url.trim());
}

/** 用系统浏览器打开。桌面端走 opener 插件，浏览器里退化成新标签页。 */
export async function openExternal(url: string): Promise<void> {
  if (!isOpenableUrl(url)) return;
  if (isTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url.trim());
    return;
  }
  window.open(url.trim(), "_blank", "noopener,noreferrer");
}
