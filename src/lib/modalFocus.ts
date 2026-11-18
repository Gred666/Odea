import { useCallback, useEffect, useRef } from "react";
import { offerEditorFocus } from "./focusHandoff";
import { addWindowListener } from "./paneWindow";

/* ============================================================
   模态对话框的焦点（命令面板、提醒设置、同步、历史版本……都是 role="dialog" aria-modal="true"）：
   - 打开：焦点不在面板里（没有自己聚焦的输入框）就聚焦面板本身（tabIndex -1，不画焦点环），
     键盘接着就能 Tab 进去、Esc 关掉。以前焦点留在 body 上，第一下 Tab 落在遮罩那个全屏按钮上
   - Tab / Shift+Tab 在面板里转圈：只在两头接手，中间交给浏览器；焦点丢在 body 上时也拉回来。
     叠着几层时只有最上面那层管
   - 关掉：焦点还在面板里、或者掉在 body 上，就还给打开之前最后一个不在模态框里的元素。
     从命令面板开的对话框还给的是正文，不是已经没了的面板输入框；Ctrl+K → Esc 接着打字。
     那个正文已经换成了别的篇（从面板打开了另一篇），交给新挂上的编辑器（lib/focusHandoff.ts）。
     焦点已经被关掉时的动作挪到别处去了（新建的一篇聚焦标题），不抢
   ============================================================ */

const MODAL = '[aria-modal="true"]';
const TABBABLE =
  'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"], audio[controls], video[controls]';

/** 最后一个拿到过焦点、不在模态框里的元素：关掉对话框时还给它 */
let lastOutside: HTMLElement | null = null;
/** 开着的面板，后开的在后面 */
const stack: HTMLElement[] = [];
let tracking = false;
/** 面板开着时听 Tab 的那个（每个窗口都听） */
let stopTab: (() => void) | null = null;

/**
 * 遮罩：每个对话框都是「遮罩按钮 + 紧跟着的、装着面板的那一层」。点遮罩关掉时，按下的那一下焦点先落到遮罩上 ——
 * 它不算「打开之前的那个」，关掉时焦点在它上面也算丢了
 */
function isBackdrop(node: Element): boolean {
  return stack.some((panel) => node.nextElementSibling?.contains(panel));
}

/**
 * 下拉菜单（Radix 的 `role="menu"`）里的一项也不算：菜单一选就拆掉，从菜单里开的对话框
 * （行菜单「移动到…」「改智能文件夹」）关掉时该回到打开菜单的那个「…」按钮上
 */
const MENU = '[role="menu"]';

/**
 * 是不是一个元素。不用 instanceof：弹出窗口里的元素是那个窗口的 HTMLElement（另一个全局），
 * 主窗口的 instanceof HTMLElement 认不出来（docs/标签页与分屏.md §20.2）
 */
const isElement = (node: unknown): node is HTMLElement =>
  typeof node === "object" && node !== null && (node as Node).nodeType === 1;

function outsideModal(node: unknown): node is HTMLElement {
  return (
    isElement(node) &&
    node !== node.ownerDocument.body &&
    !node.closest(MODAL) &&
    !node.closest(MENU) &&
    !isBackdrop(node)
  );
}

function track() {
  if (tracking) return;
  tracking = true;
  // 主窗口和弹出窗口都听：命令面板也会开在弹出窗口里（docs/标签页与分屏.md §20.2）
  addWindowListener(
    "focusin",
    (event) => {
      if (outsideModal(event.target)) lastOutside = event.target;
    },
    true,
  );
}

// 一开始就记：面板里有 autoFocus 的输入框时，它在 effect 之前就把焦点拿走了，effect 里再看「打开之前是谁」已经晚了
if (typeof document !== "undefined") track();

function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) =>
      el.tabIndex >= 0 &&
      !(el as HTMLButtonElement).disabled &&
      !el.closest("[inert]") &&
      (typeof el.checkVisibility === "function"
        ? el.checkVisibility({ visibilityProperty: true })
        : el.getClientRects().length > 0),
  );
}

function onTab(event: KeyboardEvent) {
  if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.defaultPrevented || event.isComposing) return;
  const panel = stack.at(-1);
  if (!panel) return;
  const items = tabbables(panel);
  const active = panel.ownerDocument.activeElement;
  const inside = !!active && panel.contains(active);
  const first = items[0];
  const last = items.at(-1);
  let to: HTMLElement | undefined;
  if (!first || !last) to = panel;
  else if (!inside) to = event.shiftKey ? last : first;
  else if (event.shiftKey && (active === first || active === panel)) to = last;
  else if (!event.shiftKey && active === last) to = first;
  if (!to) return;
  event.preventDefault();
  to.focus({ preventScroll: true });
}

/**
 * 给模态对话框的面板（`role="dialog"` 的那个元素）用：`ref={useModalFocus(open)}`。
 * 面板随 `open` 挂上（AnimatePresence 退场时还挂着一会儿，那时 `open` 已经是 false）
 */
export function useModalFocus(open: boolean): (el: HTMLElement | null) => void {
  const panel = useRef<HTMLElement | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    panel.current = el;
    if (el && !el.hasAttribute("tabindex")) el.tabIndex = -1;
  }, []);

  useEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    track();
    // 面板在哪个窗口（弹出窗口里开的命令面板在那边的文档里）
    const doc = el.ownerDocument;
    const from = doc.activeElement;
    if (outsideModal(from)) lastOutside = from;
    stack.push(el);
    if (stack.length === 1) stopTab = addWindowListener("keydown", onTab, true);
    if (!el.contains(doc.activeElement)) el.focus({ preventScroll: true });
    return () => {
      const active = doc.activeElement;
      const lost = !active || active === doc.body || el.contains(active) || isBackdrop(active);
      const at = stack.lastIndexOf(el);
      if (at >= 0) stack.splice(at, 1);
      if (stack.length === 0) {
        stopTab?.();
        stopTab = null;
      }
      if (!lost) return;
      // 底下还有一层开着的：还给那一层；没有了：还给打开之前的那个
      const below = stack.at(-1);
      if (below) below.focus({ preventScroll: true });
      else if (lastOutside?.isConnected) lastOutside.focus({ preventScroll: true });
      else if (lastOutside?.classList.contains("cm-content")) {
        // 从命令面板打开了另一篇：原来的正文编辑器已经换掉了，交给新挂上的那个（lib/focusHandoff.ts）。
        // 面板退场时还挂着一会儿，焦点先从它身上拿下来，不然新编辑器看焦点不在 body 上就不接
        if (isElement(active) && el.contains(active)) active.blur();
        offerEditorFocus(el.ownerDocument);
      }
    };
  }, [open]);

  return ref;
}
