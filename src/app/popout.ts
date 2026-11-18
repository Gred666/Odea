import { isBaseTab } from "@/bases/ids";
import { useData } from "@/data/store";
import { registerBeforeClose } from "@/editor/saveBus";
import { installCrossWindowObservers, registerPopoutWindow } from "@/lib/paneWindow";
import { isTauri, win as mainWindow, popoutOp } from "@/lib/tauri";
import {
  type PopoutBounds,
  type PopoutLayout,
  type StoredPopout,
  bringBack,
  newPopout,
  restorePopout,
  tabsOf,
} from "./panes";
import { providePopoutBounds, saveSessionNow, useApp } from "./store";

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
  /**
   * 开出来的窗口比 window.open 要的 left / top 偏了多少（Windows 上无边框窗口四周有看不见的缩放边，
   * screenX 不算它、window.open 算它：2026-11-18 实测偏 8、1）。记位置时扣掉，下次开在同一个地方。
   * 没量好（null）之前不记位置
   */
  drift: { x: number; y: number } | null;
}

const handles = new Map<string, PopoutHandle>();

export const popoutHandle = (id: string): PopoutHandle | undefined => handles.get(id);

/** 这个 Tauri 窗口标签是哪个弹出窗口 */
export function popoutOfLabel(label: string): string | null {
  for (const [id, handle] of handles) if (handle.label() === label) return id;
  return null;
}

/** 新窗口默认多大：和拖出来的那一栏差不多宽，太窄、太宽都不好写 */
const WIDTH = { min: 720, max: 1100 };
const HEIGHT = { min: 560, max: 1000 };

/**
 * 一个标签（主窗口的、或者另一个弹出窗口的）拆成弹出窗口。at：窗口放在屏幕上的哪里（拖出窗口松手的地方，CSS 像素），
 * 指针落在新窗口的标签上；没有就在主窗口左上角往里错开一点。开不出来（访客窗口、被拦了）返回 false
 */
export function popOut(tabId: string, at?: { x: number; y: number }, width?: number): boolean {
  const app = useApp.getState();
  // 主窗口里的，或者从一个弹出窗口里拖出来再开一个（docs/标签页与分屏.md §20.4）
  const tab = [...app.notePanes.flatMap((pane) => pane.tabs), ...app.popouts.flatMap(tabsOf)].find(
    (other) => other.id === tabId,
  );
  if (!tab?.noteId) return false;
  return openPopout(newPopout([tab]), placeFor(at, width), tabId);
}

/** 新开的弹出窗口放在哪、多大：见 popOut 的说明 */
function placeFor(at?: { x: number; y: number }, width?: number): PopoutBounds {
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
  return { left, top, width: w, height: h };
}

/**
 * 开一个窗口装这个弹出窗口。fromTab：从别的窗口里拿走的那个（拆出去）；null 是重开记下的
 * （标签本来就不在别的窗口里）。开不出来返回 false
 */
function openPopout(popout: PopoutLayout, bounds: PopoutBounds, fromTab: string | null): boolean {
  const { left, top, width: w, height: h } = bounds;
  const win = window.open(
    "about:blank",
    "_blank",
    `left=${Math.round(left)},top=${Math.round(top)},width=${Math.round(w)},height=${Math.round(h)}`,
  );
  if (!win) return false;
  installCrossWindowObservers();
  const unregister = registerPopoutWindow(win);
  const unmirror = mirrorDocument(win);
  let label: string | null = null;
  const handle: PopoutHandle = {
    win,
    label: () => {
      label ??= tauriLabel(win);
      return label;
    },
    detach: () => {
      unmirror();
      unregister();
    },
    drift: null,
  };
  handles.set(popout.id, handle);
  // 等窗口到了要的大小再量偏了多少：刚返回时是 0×0，一百来毫秒时有一下是 (0, 0)、和屏幕一样大
  // （2026-11-18 实测），这时量就错了。一直不是要的大小（屏幕放不下、系统改了）就照最后看到的，偏得离谱的当没偏
  const settle = (tries: number) => {
    if (win.closed) return;
    const sized =
      win.innerWidth > 0 &&
      Math.abs(win.outerWidth - Math.round(w)) <= 1 &&
      Math.abs(win.outerHeight - Math.round(h)) <= 1;
    if (!sized && tries > 0) {
      window.setTimeout(() => settle(tries - 1), 8);
      return;
    }
    const x = win.screenX - Math.round(left);
    const y = win.screenY - Math.round(top);
    handle.drift = Math.abs(x) <= 32 && Math.abs(y) <= 32 ? { x, y } : { x: 0, y: 0 };
    saveSessionNow();
  };
  settle(125);
  watchPopouts();
  raiseWindow(popout.id);
  useApp.getState().addPopout(popout, fromTab);
  return true;
}

/* ---------------- 跨窗口拖标签（docs/标签页与分屏.md §20.4） ---------------- */

/**
 * 应用的窗口从上到下的次序：最近拿到焦点（在里面按下）的在前，主窗口是 null。弹出窗口不是主窗口的从属窗口，
 * 谁被点了谁就到最上面，所以按「最近拿到焦点」排就是叠放的次序（别的程序的窗口盖在上面不知道）
 */
let stacking: (string | null)[] = [null];

/** 这个窗口拿到了焦点（components/Popouts.tsx 在每个窗口的 focus、pointerdown 上调） */
export function raiseWindow(id: string | null): void {
  if (stacking[0] !== id) stacking = [id, ...stacking.filter((other) => other !== id)];
}

export interface WindowHit {
  /** 弹出窗口的 id；主窗口是 null */
  popout: string | null;
  win: Window;
  /** 换算成那个窗口里的坐标（clientX / clientY） */
  x: number;
  y: number;
}

/**
 * 屏幕上的这一点（screenX / screenY，CSS 像素）落在哪个应用窗口里。几个窗口叠着取最上面的；
 * 最小化的窗口在屏幕外（-32000），落不进去
 */
export function windowAt(screenX: number, screenY: number): WindowHit | null {
  const ids = [...stacking, ...[...handles.keys()].filter((id) => !stacking.includes(id))];
  for (const id of ids) {
    const win = id === null ? window : handles.get(id)?.win;
    if (!win || win.closed) continue;
    const { left, top } = contentOrigin(win);
    const x = screenX - left;
    const y = screenY - top;
    if (x >= 0 && y >= 0 && x < win.innerWidth && y < win.innerHeight) {
      return { popout: id, win, x, y };
    }
  }
  return null;
}

/**
 * 窗口里页面左上角在屏幕上的哪里。screenX / screenY 是整个窗口的，窗口都是无边框的，外框和页面一样大；
 * 万一有边框（左右下一样宽、上面多一条标题栏）也扣掉
 */
function contentOrigin(win: Window): { left: number; top: number } {
  const side = Math.max(0, (win.outerWidth - win.innerWidth) / 2);
  const top = Math.max(0, win.outerHeight - win.innerHeight - side);
  return { left: win.screenX + side, top: win.screenY + top };
}

/** 把这个窗口提到前面、给它焦点（标签拖进去以后，接着在那里写） */
export function focusWindow(id: string | null): void {
  if (id === null) {
    if (isTauri) void mainWindow.focus();
    else window.focus();
    return;
  }
  const handle = handles.get(id);
  const label = handle?.label();
  if (isTauri && label) void popoutOp(label, "focus");
  else handle?.win.focus();
}

/* ---------------- 记住弹出窗口（docs/标签页与分屏.md §20.3） ---------------- */

// 记在本机的会话里带上每个弹出窗口在屏幕上的位置
providePopoutBounds((id) => {
  const handle = handles.get(id);
  const win = handle?.win;
  if (!handle?.drift || !win || win.closed) return null;
  return {
    left: win.screenX - handle.drift.x,
    top: win.screenY - handle.drift.y,
    width: win.outerWidth,
    height: win.outerHeight,
  };
});

let savingOnClose = false;

/**
 * 打开仓库时把上次开着的弹出窗口重开在原来的地方（界面起来以后调）。那一篇不在了的标签不要；
 * 窗口开不出来（浏览器预览、原来那块屏幕拔了）的，标签放回主窗口。挪窗口、改大小 store 不知道，
 * 关应用之前补记一次位置
 */
export async function reopenPopouts(stored: StoredPopout[]): Promise<void> {
  if (!savingOnClose) {
    savingOnClose = true;
    registerBeforeClose(async () => saveSessionNow());
  }
  if (!stored.length) return;
  const notes = new Set(useData.getState().notes.map((note) => note.id));
  const alive = (id: string) => isBaseTab(id) || notes.has(id);
  const screens = await screensOf();
  for (const raw of stored) {
    const restored = restorePopout(raw, alive);
    if (!restored) continue;
    const { popout, bounds } = restored;
    const fits = bounds && screens.some((screen) => overlaps(bounds, screen));
    // 只在桌面端重开：浏览器的弹窗拦截不放过没有用户手势的 window.open
    const opened = isTauri && openPopout(popout, fits ? bounds : placeFor(), null);
    if (!opened) {
      // 放回主窗口（不切过去：主窗口正看着的是上次停在的那一篇）
      useApp.setState((state) => {
        const main = { panes: state.notePanes, activePane: state.activePane };
        const layout = bringBack(main, tabsOf(popout));
        return { notePanes: layout.panes, activePane: layout.activePane };
      });
    }
  }
  saveSessionNow();
}

/** 屏幕（去掉任务栏，CSS 像素）。桌面端问 Tauri 要所有的屏幕，拿不到就只有这一块 */
async function screensOf(): Promise<PopoutBounds[]> {
  const here = screenArea();
  const fallback = [{ left: here.left, top: here.top, width: here.width, height: here.height }];
  if (!isTauri) return fallback;
  try {
    const { availableMonitors } = await import("@tauri-apps/api/window");
    const monitors = await availableMonitors();
    if (!monitors.length) return fallback;
    return monitors.map((monitor) => {
      const area = monitor.workArea ?? { position: monitor.position, size: monitor.size };
      const scale = monitor.scaleFactor || 1;
      return {
        left: area.position.x / scale,
        top: area.position.y / scale,
        width: area.size.width / scale,
        height: area.size.height / scale,
      };
    });
  } catch {
    return fallback;
  }
}

/** 窗口的标签栏那一截（左上角往里 120×40）落在这块屏幕上：拖得着、看得见 */
function overlaps(bounds: PopoutBounds, screen: PopoutBounds): boolean {
  const x = bounds.left + 60;
  const y = bounds.top + 20;
  return (
    x >= screen.left &&
    x < screen.left + screen.width &&
    y >= screen.top &&
    y < screen.top + screen.height
  );
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
function closeWindow(id: string) {
  const handle = handles.get(id);
  if (!handle) return;
  handles.delete(id);
  stacking = stacking.filter((other) => other !== id);
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
    // 只关这一次去掉了的：开好了、还没加进 store 的那一个不算
    for (const gone of before.popouts) {
      if (!state.popouts.some((popout) => popout.id === gone.id)) closeWindow(gone.id);
    }
  });
  // 主窗口的页面要没了（开发时刷新）：里面的东西是它画的，弹出窗口一起关。store 里还记着它们（下次重开），
  // 每个弹出窗口自己的 pagehide 看 handles 里已经没了它，不把标签交回主窗口（components/Popouts.tsx）
  window.addEventListener("pagehide", () => {
    saveSessionNow();
    for (const id of [...handles.keys()]) closeWindow(id);
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
