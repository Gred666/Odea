import { UNSORTED, folderOf, parentOf } from "@/data/folders";
import type { NoteSummary } from "@/data/types";
import type { PointerEvent as ReactPointerEvent } from "react";
import { create } from "zustand";

/* ============================================================
   列表栏里的拖动：把笔记拖进文件夹；逻辑目录（docs/仓库与启动器.md §7）里还能拖着排顺序、
   拖文件夹。

   用指针事件自己做，不用 HTML5 拖放：桌面端窗口开着 dragDropEnabled（拖文件进来
   当附件要用），Windows 上 WebView 里的 HTML5 拖放会被它整个吃掉。

   - 按下后挪过 5px 才算开始拖，之前松手就是普通的点击（选中这篇 / 进这个文件夹）
   - 能放的地方带记号：
       `data-drop-folder="路径"`   放进这个文件夹（文件夹行、面包屑）；它自己所在的文件夹不算
       `data-drop-note="id"`       手动排序时插在这一篇前面 / 后面（看指针在上半截还是下半截），
                                   `data-note-folder` 是它所在的文件夹
       `data-drop-branch="路径"`   拖文件夹时插在这个文件夹前面 / 后面（行的上下四分之一），
                                   中间那一半是放进去
   - 停在一个收起的、有内容的文件夹上（`data-spring-open`）0.8 秒，它就地展开，
     接着往里拖 —— 不用离开当前列表
   - Esc 取消；拖完那一下的 click 吞掉，不然松手时还会选中起点那一行
   ============================================================ */

export type DragItem =
  | { kind: "note"; id: string; title: string; from: string }
  | { kind: "folder"; path: string; title: string };

export type DropTarget =
  /** 放进这个文件夹（笔记、文件夹都行） */
  | { kind: "into"; folder: string }
  /** 插在这一篇前面 / 后面（手动排序） */
  | { kind: "note"; folder: string; note: string; edge: "above" | "below" }
  /** 文件夹插在这个文件夹前面 / 后面 */
  | { kind: "branch"; path: string; edge: "above" | "below" };

interface DragState {
  /** 正在拖的；没在拖时是 null */
  item: DragItem | null;
  /** 指针位置（视口坐标），影子跟着它 */
  x: number;
  y: number;
  /** 松手的话落在哪；没有能放的地方是 null */
  target: DropTarget | null;
}

export const useNoteDrag = create<DragState>(() => ({
  item: null,
  x: 0,
  y: 0,
  target: null,
}));

/** 正在拖的那篇（给行变淡用） */
export const draggingNote = (state: DragState) =>
  state.item?.kind === "note" ? state.item.id : null;

/** 指针下面要放进去的文件夹（文件夹行、面包屑亮起来用） */
export const dropInto = (state: DragState) =>
  state.target?.kind === "into" ? state.target.folder : null;

/** 插入线画在哪一篇的上边 / 下边 */
export const noteEdge = (state: DragState, id: string) =>
  state.target?.kind === "note" && state.target.note === id ? state.target.edge : null;

/** 插入线画在哪个文件夹的上边 / 下边 */
export const branchEdge = (state: DragState, path: string) =>
  state.target?.kind === "branch" && state.target.path === path ? state.target.edge : null;

const START_DISTANCE = 5;
const SPRING_OPEN_MS = 800;

let swallowClick = false;

/** 行的 onClick 里先问一下：刚拖完的那次 click 不算点击 */
export function consumeDragClick(): boolean {
  const swallowed = swallowClick;
  swallowClick = false;
  return swallowed;
}

/** 拖一篇笔记 */
export function beginNoteDrag(
  event: ReactPointerEvent,
  note: NoteSummary,
  handlers: {
    /** 松手时指针下面是能放的地方 */
    onDrop: (target: DropTarget) => void;
    /** 停在收起的文件夹上够久了：展开它 */
    onSpringOpen: (folder: string) => void;
  },
) {
  beginDrag(
    event,
    { kind: "note", id: note.id, title: note.title, from: folderOf(note) },
    handlers,
  );
}

/** 拖一个文件夹（逻辑目录） */
export function beginFolderDrag(
  event: ReactPointerEvent,
  path: string,
  title: string,
  handlers: { onDrop: (target: DropTarget) => void; onSpringOpen: (folder: string) => void },
) {
  beginDrag(event, { kind: "folder", path, title }, handlers);
}

const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/** 指针下面能放的地方 */
function hitTest(
  x: number,
  y: number,
  item: DragItem,
): { target: DropTarget | null; spring: HTMLElement | null } {
  const element = document.elementFromPoint(x, y);
  const noteRow = element?.closest<HTMLElement>("[data-drop-note]");
  if (noteRow) {
    const id = noteRow.dataset.dropNote ?? "";
    if (item.kind !== "note" || id === item.id) return { target: null, spring: null };
    const box = noteRow.getBoundingClientRect();
    const edge = y < box.top + box.height / 2 ? "above" : "below";
    return {
      target: { kind: "note", folder: noteRow.dataset.noteFolder ?? "", note: id, edge },
      spring: null,
    };
  }
  const row = element?.closest<HTMLElement>("[data-drop-folder], [data-drop-branch]");
  if (!row) return { target: null, spring: null };
  const into = row.dataset.dropFolder;
  const branch = row.dataset.dropBranch;
  if (item.kind === "folder" && branch !== undefined && !inside(branch, item.path)) {
    const box = row.getBoundingClientRect();
    const at = (y - box.top) / box.height;
    // 上下四分之一是插在前后；放不进去的（智能文件夹、未整理）整行都是插在前后
    const edge =
      at < 0.28
        ? "above"
        : at > 0.72
          ? "below"
          : into === undefined
            ? at < 0.5
              ? "above"
              : "below"
            : null;
    if (edge) return { target: { kind: "branch", path: branch, edge }, spring: null };
  }
  if (into === undefined) return { target: null, spring: null };
  const allowed =
    item.kind === "note"
      ? into !== item.from
      : into !== UNSORTED && !inside(into, item.path) && into !== parentOf(item.path);
  if (!allowed) return { target: null, spring: null };
  return {
    target: { kind: "into", folder: into },
    spring: row.dataset.springOpen !== undefined ? row : null,
  };
}

const sameTarget = (a: DropTarget | null, b: DropTarget | null) =>
  JSON.stringify(a) === JSON.stringify(b);

function beginDrag(
  event: ReactPointerEvent,
  item: DragItem,
  handlers: { onDrop: (target: DropTarget) => void; onSpringOpen: (folder: string) => void },
) {
  if (event.button !== 0) return;
  // 按在行里的按钮（展开箭头、「…」菜单）上不算拖
  if ((event.target as HTMLElement).closest("button") && item.kind === "folder") return;
  const startX = event.clientX;
  const startY = event.clientY;
  let dragging = false;
  let springTimer: ReturnType<typeof setTimeout> | undefined;

  const move = (e: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < START_DISTANCE) return;
      dragging = true;
      document.body.classList.add("odea-dragging");
      // 拖动时别把文字选上一大片
      window.getSelection()?.removeAllRanges();
      useNoteDrag.setState({ item, target: null });
    }
    const { target, spring } = hitTest(e.clientX, e.clientY, item);
    if (!sameTarget(target, useNoteDrag.getState().target)) {
      clearTimeout(springTimer);
      if (target?.kind === "into" && spring) {
        springTimer = setTimeout(() => handlers.onSpringOpen(target.folder), SPRING_OPEN_MS);
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
    useNoteDrag.setState({ item: null, target: null });
    document.body.classList.remove("odea-dragging");
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
