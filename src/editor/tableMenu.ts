import { docOf, winOf } from "@/lib/paneWindow";

/* ============================================================
   表格的菜单：行 / 列抓手点开的、格子上右键的（docs/表格.md §5.2）。

   表格替身是纯 DOM（不在 React 树里），菜单也是：样子照着 ActionMenu（RowMenu.tsx）——
   32 高的项、13px 字、14px 图标、白底圆角卡片；进出只淡（.odea-menu 的 data-state 动画，
   CLAUDE.md 动效规矩 1）。挂在格子所在窗口的 body 上（弹出窗口里的表格挂到弹出窗口）。
   ============================================================ */

const SVG_NS = "http://www.w3.org/2000/svg";

/** 24×24 的线条图标：每一项是一条 path；`c:x,y` 是一个半径 1 的点（抓手的六个点） */
export const TABLE_ICONS = {
  "insert-above": ["M5 3h14", "m18 13-6-6-6 6", "M12 7v14"],
  "insert-below": ["M19 21H5", "m6 11 6 6 6-6", "M12 17V3"],
  "insert-left": ["M3 19V5", "m13 6-6 6 6 6", "M7 12h14"],
  "insert-right": ["M21 5v14", "m11 18 6-6-6-6", "M17 12H3"],
  delete: [
    "M3 6h18",
    "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
    "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  ],
  clear: [
    "m7 21-4.3-4.3a2.4 2.4 0 0 1 0-3.4l9.6-9.6a2.4 2.4 0 0 1 3.4 0l5.6 5.6a2.4 2.4 0 0 1 0 3.4L13 21",
    "M22 21H7",
    "m5 11 9 9",
  ],
  merge: [
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
    "M3 9h18",
    "M3 15h18",
    "M12 3v6",
    "M12 15v6",
  ],
  split: [
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
    "M3 9h18",
    "M3 15h18",
    "M12 9v6",
  ],
  "align-left": ["M21 6H3", "M15 12H3", "M17 18H3"],
  "align-center": ["M21 6H3", "M17 12H7", "M19 18H5"],
  "align-right": ["M21 6H3", "M21 12H9", "M21 18H7"],
  "sort-asc": ["m3 8 4-4 4 4", "M7 4v16", "M11 12h4", "M11 16h7", "M11 20h10"],
  "sort-desc": ["m3 16 4 4 4-4", "M7 20V4", "M11 4h10", "M11 8h7", "M11 12h4"],
  copy: [
    "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z",
    "M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2",
  ],
  source: ["m16 18 6-6-6-6", "m8 6-6 6 6 6"],
  convert: ["m16 3 4 4-4 4", "M20 7H4", "m8 21-4-4 4-4", "M4 17h16"],
  plus: ["M5 12h14", "M12 5v14"],
  "grip-row": ["c:9,5", "c:9,12", "c:9,19", "c:15,5", "c:15,12", "c:15,19"],
  "grip-col": ["c:5,9", "c:12,9", "c:19,9", "c:5,15", "c:12,15", "c:19,15"],
} as const;

export type TableIcon = keyof typeof TABLE_ICONS;

export function tableIcon(doc: Document, name: TableIcon): SVGSVGElement {
  const node = doc.createElementNS(SVG_NS, "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "1.9");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  for (const d of TABLE_ICONS[name]) {
    if (d.startsWith("c:")) {
      const [cx, cy] = d.slice(2).split(",");
      const dot = doc.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", cx!);
      dot.setAttribute("cy", cy!);
      dot.setAttribute("r", "1.6");
      dot.setAttribute("fill", "currentColor");
      dot.setAttribute("stroke", "none");
      node.append(dot);
      continue;
    }
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    node.append(path);
  }
  return node;
}

export interface MenuItem {
  label: string;
  icon: TableIcon;
  /** 右边的小字：快捷键 */
  hint?: string;
  danger?: boolean;
  /** 不能用：灰掉，悬停的提示说为什么 */
  disabled?: string | false;
  run: () => void;
}

/** 一排图标按钮（对齐）：左边一个标签 */
export interface MenuSegments {
  label: string;
  segments: { icon: TableIcon; label: string; active: boolean; run: () => void }[];
}

export type MenuEntry = MenuItem | MenuSegments | "separator";

export interface MenuHandle {
  close(): void;
}

let openMenu: { close: () => void } | null = null;

/**
 * 在 (x, y) 弹出菜单（贴着这一点往右下，放不下就翻到另一边）。选了一项、点了外面、
 * 按 Esc、滚动都会关；onClose 在关的那一刻调（焦点交还给表格）
 */
export function showTableMenu(
  owner: Node,
  at: { x: number; y: number },
  entries: MenuEntry[],
  onClose: () => void,
): MenuHandle {
  openMenu?.close();
  const doc = docOf(owner);
  const win = winOf(owner);
  const menu = doc.createElement("div");
  menu.className = "odea-menu cm-odea-table-menu";
  menu.dataset.state = "open";
  menu.setAttribute("role", "menu");
  menu.tabIndex = -1;

  const items: HTMLButtonElement[] = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (openMenu === handle) openMenu = null;
    win.removeEventListener("pointerdown", outside, true);
    win.removeEventListener("wheel", dismiss, true);
    win.removeEventListener("blur", dismiss);
    menu.dataset.state = "closed";
    const remove = () => menu.remove();
    menu.addEventListener("animationend", remove, { once: true });
    win.setTimeout(remove, 160);
    onClose();
  };
  const handle = { close };
  const choose = (run: () => void) => {
    close();
    run();
  };

  for (const entry of entries) {
    if (entry === "separator") {
      const line = doc.createElement("div");
      line.className = "cm-odea-table-menu-separator";
      line.setAttribute("role", "separator");
      menu.append(line);
      continue;
    }
    if ("segments" in entry) {
      const row = doc.createElement("div");
      row.className = "cm-odea-table-menu-segments";
      const label = doc.createElement("span");
      label.className = "cm-odea-table-menu-label";
      label.textContent = entry.label;
      row.append(label);
      for (const segment of entry.segments) {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "cm-odea-table-menu-segment";
        button.classList.toggle("is-on", segment.active);
        button.setAttribute("role", "menuitemradio");
        button.setAttribute("aria-checked", String(segment.active));
        button.setAttribute("aria-label", segment.label);
        button.title = segment.label;
        button.append(tableIcon(doc, segment.icon));
        button.addEventListener("click", () => choose(segment.run));
        items.push(button);
        row.append(button);
      }
      menu.append(row);
      continue;
    }
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "cm-odea-table-menu-item";
    button.classList.toggle("is-danger", !!entry.danger);
    button.setAttribute("role", "menuitem");
    button.append(tableIcon(doc, entry.icon));
    const label = doc.createElement("span");
    label.className = "cm-odea-table-menu-text";
    label.textContent = entry.label;
    button.append(label);
    if (entry.hint) {
      const hint = doc.createElement("span");
      hint.className = "cm-odea-table-menu-hint";
      hint.textContent = entry.hint;
      button.append(hint);
    }
    if (entry.disabled) {
      button.setAttribute("aria-disabled", "true");
      button.title = entry.disabled;
    } else button.addEventListener("click", () => choose(entry.run));
    items.push(button);
    menu.append(button);
  }

  // 鼠标移上去的那一项和键盘走到的是同一项（和 Radix 的菜单一样）
  const highlight = (index: number) => {
    items.forEach((item, i) => item.classList.toggle("is-highlighted", i === index));
    items[index]?.focus({ preventScroll: true });
  };
  const current = () => items.findIndex((item) => item.classList.contains("is-highlighted"));
  menu.addEventListener("pointermove", (event) => {
    const item = (event.target as Element).closest?.("button");
    const index = item ? items.indexOf(item as HTMLButtonElement) : -1;
    if (index >= 0 && index !== current()) highlight(index);
  });
  menu.addEventListener("pointerleave", () => {
    for (const item of items) item.classList.remove("is-highlighted");
    menu.focus({ preventScroll: true });
  });
  menu.addEventListener("keydown", (event) => {
    const enabled = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.getAttribute("aria-disabled") !== "true");
    const at = enabled.findIndex(({ index }) => index === current());
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!enabled.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next =
        at < 0
          ? step > 0
            ? 0
            : enabled.length - 1
          : (at + step + enabled.length) % enabled.length;
      highlight(enabled[next]!.index);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      items[current()]?.click();
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  menu.addEventListener("mousedown", (event) => event.preventDefault());

  doc.body.append(menu);
  // 摆位置：先贴着点往右下，出了窗口就翻过去。整数像素（菜单里全是字，见 CLAUDE.md 动效规矩 6）
  const box = menu.getBoundingClientRect();
  const width = win.innerWidth;
  const height = win.innerHeight;
  const left = at.x + box.width + 8 > width ? Math.max(8, at.x - box.width) : at.x;
  const top = at.y + box.height + 8 > height ? Math.max(8, at.y - box.height) : at.y;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.focus({ preventScroll: true });

  const outside = (event: Event) => {
    if (!menu.contains(event.target as Node)) close();
  };
  const dismiss = () => close();
  win.addEventListener("pointerdown", outside, true);
  win.addEventListener("wheel", dismiss, { capture: true, passive: true });
  win.addEventListener("blur", dismiss);
  openMenu = handle;
  return handle;
}

export function closeTableMenu() {
  openMenu?.close();
}
