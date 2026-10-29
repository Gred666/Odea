import { createContext, useContext } from "react";

/* ============================================================
   窗格画在哪个窗口里（docs/标签页与分屏.md §16）：主窗口，或者一个弹出窗口。

   弹出窗口和主窗口是同一个 JS 环境（window.open 拿到的子窗口，React portal 进去），全局的
   document / window 一直是主窗口的。浮层挂到哪个 body、在哪个窗口上听键盘和点击、按哪个窗口的
   宽高和像素比摆位置，都要按东西实际在哪个窗口来：

   - React 组件：usePaneWindow()（弹出窗口那一棵树外面包了一层 Provider）
   - DOM / CodeMirror 里：docOf(节点)、winOf(节点)，按节点的 ownerDocument 认
   ============================================================ */

export interface PaneWindow {
  doc: Document;
  win: Window;
  /** 弹出窗口里的那个窗格的 id；主窗口是 null */
  popout: string | null;
}

const MAIN: PaneWindow | null =
  typeof document === "undefined" ? null : { doc: document, win: window, popout: null };

export const PaneWindowContext = createContext<PaneWindow | null>(MAIN);

export function usePaneWindow(): PaneWindow {
  return useContext(PaneWindowContext) ?? MAIN!;
}

export const docOf = (node: Node | null | undefined): Document => node?.ownerDocument ?? document;

export const winOf = (node: Node | null | undefined): Window => docOf(node).defaultView ?? window;

let crossWindow = false;
/** 开着的弹出窗口（app/popout.ts 登记） */
const popoutWindows = new Set<Window>();

export function registerPopoutWindow(win: Window): () => void {
  popoutWindows.add(win);
  return () => popoutWindows.delete(win);
}

/**
 * 主窗口的 ResizeObserver 看不见别的窗口里的元素（2026-10-29 在 WebView2 上实测：子窗口里的元素
 * 变了大小，主窗口建的观察器一次都不报；IntersectionObserver 照常报）。CodeMirror、滚动条、
 * 目录树都用全局的 ResizeObserver，弹出窗口里的编辑器就不知道自己变宽了。
 *
 * 第一次开弹出窗口时把全局的换成一个分派的：observe 谁，就用那个元素所在窗口的 ResizeObserver 看。
 * 还没挂到页面上的元素（CodeMirror 先在游离的 DOM 里建好、开始观察，再挂进弹出窗口）不知道会去哪，
 * 每个开着的窗口的都看一份：元素只会画在一个窗口里，只有那一个会报。
 * 换之前建好的（主窗口里的）不受影响
 */
export function installCrossWindowObservers(): void {
  if (crossWindow || typeof window === "undefined" || !window.ResizeObserver) return;
  crossWindow = true;
  const Native = window.ResizeObserver;
  class CrossWindowResizeObserver implements ResizeObserver {
    private readonly byWindow = new Map<Window, ResizeObserver>();
    constructor(private readonly callback: ResizeObserverCallback) {}
    private of(win: Window): ResizeObserver {
      let observer = this.byWindow.get(win);
      if (!observer) {
        // 主窗口自己的已经换成了这个类，用换之前的那个
        const Ctor =
          win === window
            ? Native
            : ((win as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver ??
              Native);
        observer = new Ctor((entries) => this.callback(entries, this));
        this.byWindow.set(win, observer);
      }
      return observer;
    }
    private windowsOf(target: Element): Window[] {
      if (target.isConnected) return [winOf(target)];
      return [window, ...[...popoutWindows].filter((win) => !win.closed)];
    }
    observe(target: Element, options?: ResizeObserverOptions) {
      for (const win of this.windowsOf(target)) this.of(win).observe(target, options);
    }
    unobserve(target: Element) {
      for (const observer of this.byWindow.values()) observer.unobserve(target);
    }
    disconnect() {
      for (const observer of this.byWindow.values()) observer.disconnect();
      this.byWindow.clear();
    }
  }
  window.ResizeObserver = CrossWindowResizeObserver;
}
