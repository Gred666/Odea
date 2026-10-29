import { installCrossWindowObservers, registerPopoutWindow } from "@/lib/paneWindow";
import { isTauri, popoutOp } from "@/lib/tauri";
import { newPane } from "./panes";
import { useApp } from "./store";

/* ============================================================
   弹出窗口（docs/标签页与分屏.md §16）：开窗口、把主窗口的样式带过去、关窗口。

   window.open('about:blank') 拿到的子窗口和主窗口是同一个 JS 环境（桌面端由 popout.rs 接住，
   浏览器预览里就是普通的弹窗）。这里先把它的文档摆成和主窗口一样（样式、<html> 上的主题这些属性），
   窗格的内容由 components/Popouts.tsx portal 进去。窗口跟着 store 里的 popouts 走：去掉了就关。

   窗口要在按下 / 松手的那一下同步开（浏览器的弹窗拦截只放过用户手势里的 window.open），
   所以开窗口不放在 React 的 effect 里。
   ============================================================ */

export interface PopoutHandle {
  win: Window;
  /** Tauri 的窗口标签（pop-N）。window.open 之后十几毫秒才拿得到，用的时候再取 */
  label: () => string | null;
  /** 停掉样式、属性的同步，从开着的窗口里去掉（paneWindow 的尺寸观察） */
  detach: () => void;
}

const handles = new Map<string, PopoutHandle>();

export const popoutHandle = (paneId: string): PopoutHandle | undefined => handles.get(paneId);

/** 这个 Tauri 窗口标签是哪个弹出窗口的窗格 */
export function paneOfLabel(label: string): string | null {
  for (const [paneId, handle] of handles) if (handle.label() === label) return paneId;
  return null;
}

/** 新窗口默认多大：和拖出来的那一栏差不多宽，太窄、太宽都不好写 */
const WIDTH = { min: 720, max: 1100 };
const HEIGHT = { min: 560, max: 1000 };

/**
 * 主窗口里的一个标签拆成弹出窗口。at：窗口放在屏幕上的哪里（拖出窗口松手的地方，CSS 像素），
 * 指针落在新窗口的标签上；没有就在主窗口左上角往里错开一点。开不出来（访客窗口、被拦了）返回 false
 */
export function popOut(tabId: string, at?: { x: number; y: number }, width?: number): boolean {
  const app = useApp.getState();
  const tab = app.notePanes.flatMap((pane) => pane.tabs).find((other) => other.id === tabId);
  if (!tab?.noteId) return false;
  const area = screenArea();
  const w = Math.round(clamp(width ?? window.innerWidth * 0.6, WIDTH.min, WIDTH.max));
  const h = Math.round(
    Math.min(clamp(window.innerHeight - 120, HEIGHT.min, HEIGHT.max), area.height),
  );
  let left = Math.round(at ? at.x - 64 : window.screenX + 64);
  let top = Math.round(at ? at.y - 19 : window.screenY + 64);
  // 松在主窗口所在的那块屏幕上：整个窗口收进屏幕里（贴着屏幕边松手，不伸出去一半）。
  // 松在别的屏幕上不管：网页拿不到别的屏幕有多大
  const onThisScreen =
    !at ||
    (at.x >= area.left &&
      at.x < area.left + area.width &&
      at.y >= area.top &&
      at.y < area.top + area.height);
  if (onThisScreen) {
    left = Math.round(clamp(left, area.left, area.left + area.width - w));
    top = Math.round(clamp(top, area.top, area.top + area.height - h));
  }
  const win = window.open(
    "about:blank",
    "_blank",
    `left=${left},top=${top},width=${w},height=${h}`,
  );
  if (!win) return false;
  installCrossWindowObservers();
  const unregister = registerPopoutWindow(win);
  const unmirror = mirrorDocument(win);
  const pane = newPane([tab]);
  let label: string | null = null;
  handles.set(pane.id, {
    win,
    label: () => {
      label ??= tauriLabel(win);
      return label;
    },
    detach: () => {
      unmirror();
      unregister();
    },
  });
  watchPopouts();
  app.addPopout(pane, tabId);
  return true;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** 主窗口所在的那块屏幕去掉任务栏的地方（CSS 像素） */
function screenArea() {
  const screen = window.screen as Screen & { availLeft?: number; availTop?: number };
  return {
    left: screen.availLeft ?? 0,
    top: screen.availTop ?? 0,
    width: screen.availWidth,
    height: screen.availHeight,
  };
}

function tauriLabel(win: Window): string | null {
  try {
    const internals = (win as Window & { __TAURI_INTERNALS__?: TauriInternals })
      .__TAURI_INTERNALS__;
    return internals?.metadata?.currentWindow?.label ?? null;
  } catch {
    return null;
  }
}

interface TauriInternals {
  metadata?: { currentWindow?: { label?: string } };
}

/** 关掉窗口（store 里已经去掉了）。桌面端 window.close() 只关得掉页面、关不掉 Tauri 的窗口，要经 Rust */
function closeWindow(paneId: string) {
  const handle = handles.get(paneId);
  if (!handle) return;
  handles.delete(paneId);
  handle.detach();
  const label = handle.label();
  if (isTauri && label) void popoutOp(label, "close");
  else handle.win.close();
}

let watching = false;

/** store 里去掉了的弹出窗口，窗口跟着关（不管是关了最后一个标签、标签挪回去了、还是对账关掉的） */
function watchPopouts() {
  if (watching) return;
  watching = true;
  useApp.subscribe((state, before) => {
    if (state.popouts === before.popouts) return;
    for (const paneId of handles.keys()) {
      if (!state.popouts.some((pane) => pane.id === paneId)) closeWindow(paneId);
    }
  });
  // 主窗口的页面要没了（开发时刷新）：里面的东西是它画的，弹出窗口一起关
  window.addEventListener("pagehide", () => {
    for (const paneId of [...handles.keys()]) closeWindow(paneId);
  });
}

/* ---------------- 子窗口的文档跟着主窗口 ---------------- */

/**
 * 把主窗口 <head> 里的样式（Vite 注入的、懒加载的分包带来的、编辑器挂的）、<html> 和 <body> 上的属性
 * （主题、减少动效、拖分割条时的指针）抄到子窗口里，之后变了也跟着变。返回停掉同步的函数
 */
function mirrorDocument(win: Window): () => void {
  const doc = win.document;
  doc.title = "Odea";
  const copies = new Map<Node, Element>();
  const isStyle = (node: Node): node is HTMLStyleElement | HTMLLinkElement =>
    node instanceof HTMLStyleElement ||
    (node instanceof HTMLLinkElement && node.rel === "stylesheet");
  const copy = (node: HTMLStyleElement | HTMLLinkElement) => {
    const clone = doc.importNode(node, true) as Element;
    copies.set(node, clone);
    // 和主窗口里的先后一样（后面的覆盖前面的）：插在它后面最近的那个的抄本前头
    let next = node.nextSibling;
    while (next && !copies.has(next)) next = next.nextSibling;
    const before = next ? copies.get(next) : null;
    doc.head.insertBefore(clone, before?.parentNode === doc.head ? before : null);
  };
  for (const node of document.head.querySelectorAll("style, link[rel='stylesheet']")) {
    if (isStyle(node)) copy(node);
  }

  const syncAttributes = (from: Element, to: Element) => {
    for (const { name } of [...to.attributes]) {
      if (!from.hasAttribute(name)) to.removeAttribute(name);
    }
    for (const { name, value } of [...from.attributes]) {
      if (to.getAttribute(name) !== value) to.setAttribute(name, value);
    }
  };
  syncAttributes(document.documentElement, doc.documentElement);
  syncAttributes(document.body, doc.body);
  const root = doc.createElement("div");
  root.id = "root";
  doc.body.replaceChildren(root);

  const head = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (isStyle(node) && node.parentNode === document.head) copy(node);
      }
      for (const node of record.removedNodes) {
        copies.get(node)?.remove();
        copies.delete(node);
      }
      // 开发时 Vite 热更新改的是 <style> 里的字
      const style =
        record.target.parentNode === document.head ? record.target : record.target.parentNode;
      if (style && style !== document.head && copies.has(style)) {
        const clone = copies.get(style)!;
        if (clone.textContent !== style.textContent) clone.textContent = style.textContent;
      }
    }
  });
  head.observe(document.head, { childList: true, subtree: true, characterData: true });
  const attributes = new MutationObserver(() => {
    syncAttributes(document.documentElement, doc.documentElement);
    syncAttributes(document.body, doc.body);
  });
  attributes.observe(document.documentElement, { attributes: true });
  attributes.observe(document.body, { attributes: true });
  return () => {
    head.disconnect();
    attributes.disconnect();
  };
}
