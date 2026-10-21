import { useApp } from "@/app/store";
import { quietWindow } from "@/lib/tauri";
import { create } from "zustand";

/* ============================================================
   开场动画的状态（components/Intro.tsx 播，components/Logo.tsx 接）。

   cover  ：开场那层纸盖着；侧栏 Logo 先空着、字标停在没写的那一刻
   landed ：开场那个「O」落到了侧栏 Logo 的位置，交给 Logo 接着写
   off    ：这一次不播（减少动效、刷新页面）

   只在冷启动播：sessionStorage 跟着这个窗口进程走，刷新（开发时的整页重载）还在，
   重新打开应用就没了。
   ============================================================ */

export type IntroPhase = "off" | "cover" | "landed";

interface IntroState {
  phase: IntroPhase;
  /** 窗口已经显示出来了（Rust 的 ready 返回）。开场从这一刻开始，不在隐藏的窗口里白播 */
  shown: boolean;
}

export const useIntro = create<IntroState>(() => ({ phase: "off", shown: false }));

const PLAYED_KEY = "odea.introPlayed";

/** 挂载 React 之前调用：决定这一次要不要播 */
export function armIntro() {
  // 启动以后才开的仓库窗口（启动器里打开的、点链接打开的）不播：开场只属于冷启动
  if (quietWindow) return;
  const reduce =
    useApp.getState().reduceMotion || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return;
  try {
    if (sessionStorage.getItem(PLAYED_KEY)) return;
    sessionStorage.setItem(PLAYED_KEY, "1");
  } catch {
    // 存不了就每次都播，无所谓
  }
  useIntro.setState({ phase: "cover" });
}

/** 窗口显示出来了 */
export function markShown() {
  useIntro.setState({ shown: true });
}

/** 开场的「O」落地，交给侧栏 Logo */
export function landIntro() {
  if (useIntro.getState().phase === "cover") useIntro.setState({ phase: "landed" });
}
