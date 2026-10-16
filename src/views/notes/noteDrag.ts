import { folderOf } from "@/data/folders";
import type { NoteSummary } from "@/data/types";
import type { PointerEvent as ReactPointerEvent } from "react";
import { create } from "zustand";

/* ============================================================
   把笔记拖进文件夹。

   用指针事件自己做，不用 HTML5 拖放：桌面端窗口开着 dragDropEnabled（拖文件进来
   当附件要用），Windows 上 WebView 里的 HTML5 拖放会被它整个吃掉。

   - 按下后挪过 5px 才算开始拖，之前松手就是普通的点击（选中这篇）
   - 能放的地方带 `data-drop-folder="路径"`（文件夹行、面包屑）；指针下面那个就是目标，
     它自己所在的文件夹不算
   - 停在一个收起的、有子文件夹的文件夹上（`data-spring-open`）0.8 秒，它就地展开，
     接着往里拖 —— 不用离开当前列表
   - Esc 取消；拖完那一下的 click 吞掉，不然松手时还会选中起点那一行
   ============================================================ */

interface DragState {
  /** 正在拖的那篇；没在拖时是 null */
  noteId: string | null;
  title: string;
  /** 指针位置（视口坐标），影子跟着它 */
  x: number;
  y: number;
  /** 指针下面能放进去的文件夹（相对「笔记」的路径，空串是「全部笔记」）；没有是 null */
  target: string | null;
}

export const useNoteDrag = create<DragState>(() => ({
  noteId: null,
  title: "",
  x: 0,
  y: 0,
  target: null,
}));

const START_DISTANCE = 5;
const SPRING_OPEN_MS = 800;

let swallowClick = false;

/** 行的 onClick 里先问一下：刚拖完的那次 click 不算点击 */
export function consumeDragClick(): boolean {
  const swallowed = swallowClick;
  swallowClick = false;
  return swallowed;
}

export function beginNoteDrag(
  event: ReactPointerEvent,
  note: NoteSummary,
  handlers: {
    /** 松手时指针下面是一个文件夹 */
    onDrop: (folder: string) => void;
    /** 停在收起的文件夹上够久了：展开它 */
    onSpringOpen: (folder: string) => void;
  },
) {
  if (event.button !== 0) return;
  const startX = event.clientX;
  const startY = event.clientY;
  const from = folderOf(note);
  let dragging = false;
  let springTimer: ReturnType<typeof setTimeout> | undefined;

  const move = (e: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < START_DISTANCE) return;
      dragging = true;
      document.body.classList.add("otw-dragging");
      // 拖动时别把文字选上一大片
      window.getSelection()?.removeAllRanges();
      useNoteDrag.setState({ noteId: note.id, title: note.title, target: null });
    }
    const hit = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest<HTMLElement>("[data-drop-folder]");
    const path = hit?.dataset.dropFolder;
    const target = path !== undefined && path !== from ? path : null;
    if (target !== useNoteDrag.getState().target) {
      clearTimeout(springTimer);
      if (target !== null && hit?.dataset.springOpen !== undefined) {
        springTimer = setTimeout(() => handlers.onSpringOpen(target), SPRING_OPEN_MS);
      }
    }
    useNoteDrag.setState({ x: e.clientX, y: e.clientY, target });
  };

  const finish = (drop: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    clearTimeout(springTimer);
    if (!dragging) return;
    const { target } = useNoteDrag.getState();
    useNoteDrag.setState({ noteId: null, target: null });
    document.body.classList.remove("otw-dragging");
    // 松手那一下浏览器还会在起点那一行上补一个 click
    swallowClick = true;
    setTimeout(() => {
      swallowClick = false;
    }, 0);
    if (drop && target !== null) handlers.onDrop(target);
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !dragging) return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
}
