import { useData } from "@/data/store";
import { type DocumentAnchor, type DocumentSaveTarget, goalKey } from "@/data/types";
import { useApp } from "./store";

/**
 * 正在看的那篇马上要从列表里走掉（删除、归档、恢复）：先把选中挪到列表里它的下一篇，
 * 没有下一篇就上一篇。以前是退回列表第一篇 —— 往往是别的文件夹里置顶的那篇，
 * 删一篇就被甩回顶上，在子文件夹里删的话左边一行高亮都没有。
 *
 * 顺序取列表栏里看得见的行（置顶、展开的文件夹、这一层的笔记，从上到下）。
 * 和删除在同一拍里改选中，正文只换一次。不是正在看的那篇就什么都不做。
 */
/** 列表栏里看得见的笔记行，从上到下。正在收起的（刚删掉、挪走的，NotesView 的 NoteSlot）不算 */
export const LIST_ROWS = "[data-list-scroller] [data-note-row]:not([data-leaving] *)";

export function selectNeighbor(id: string): void {
  const app = useApp.getState();
  const archive = app.workspace === "archive";
  // 开着别的标签、别的窗格：关掉正在看它的这个标签，切到旁边的标签；窗格里只剩它就关这个窗格
  // （docs/标签页与分屏.md §4.3）
  const pane = app.notePanes.find((other) => other.id === app.activePane);
  if (!archive && pane && app.selectedNoteId === id) {
    if (pane.tabs.length > 1 || app.notePanes.length > 1) {
      app.closeTab(pane.activeTab);
      return;
    }
  }
  const list = archive ? useData.getState().archived : useData.getState().notes;
  const selected = archive ? app.selectedArchiveId : app.selectedNoteId;
  // 选中的 id 不在了的时候正文显示的是第一篇（data/adapter.ts）
  const shown = list.some((note) => note.id === selected) ? selected : list[0]?.id;
  if (shown !== id) return;
  const rows = [...document.querySelectorAll<HTMLElement>(LIST_ROWS)].map(
    (row) => row.dataset.noteRow ?? "",
  );
  const index = rows.indexOf(id);
  if (index < 0) return;
  const next =
    rows.slice(index + 1).find((row) => row !== id) ??
    rows
      .slice(0, index)
      .reverse()
      .find((row) => row !== id);
  if (!next) return;
  if (archive) app.selectArchive(next);
  else app.selectNote(next);
}

/**
 * 打开一篇文档：切到它所在的区、选中它，可选地记下要滚到的小节或行（全局搜索的结果还要选中
 * 那一处命中，见 DocumentAnchor）。DocumentView 在那一篇的编辑器挂上后滚过去。
 *
 * docKey 要和 data/adapter.ts 给每篇文档起的 key 一模一样，否则锚点永远等不到它那一篇：
 * 笔记 `note-` / 归档 `archive-` / 某一天 `day-` / 目标 `goal-周期键`。
 */
export function openDocument(
  target: DocumentSaveTarget,
  anchor?: DocumentAnchor,
  /** 笔记开在新标签里（docs/标签页与分屏.md §4.1）；别的文档没有标签，不管它 */
  newTab = false,
): void {
  // 笔记的正文是按需取的：先取回来再切过去（一般就几毫秒），不然常常还要跨区，先换区、
  // 再在新的区里等正文，会先闪一下那个区上次显示的那一篇
  const data = useData.getState();
  if (target.kind === "note" && data.bodies[target.id] === undefined) {
    void data.loadBody(target.id).then(() => show(target, anchor, newTab));
    return;
  }
  show(target, anchor, newTab);
}

function show(
  target: DocumentSaveTarget,
  anchor: DocumentAnchor | undefined,
  newTab: boolean,
): void {
  const app = useApp.getState();
  let docKey: string;
  if (target.kind === "note") {
    if (useData.getState().archived.some((note) => note.id === target.id)) {
      app.selectArchive(target.id);
      app.setWorkspace("archive");
      docKey = `archive-${target.id}`;
    } else if (app.activePopout) {
      // 从弹出窗口的正文里打开的（双链、反向链接）：开在那个窗口里，主窗口不动（docs/标签页与分屏.md §16）
      if (newTab) app.openNoteTab(target.id, app.activePopout);
      else app.selectNote(target.id, app.activePopout);
      docKey = `note-${target.id}`;
    } else {
      if (newTab) app.openNoteTab(target.id);
      else app.selectNote(target.id);
      app.setWorkspace("notes");
      docKey = `note-${target.id}`;
    }
  } else if (target.kind === "day") {
    if (target.id === app.todayDate) {
      app.setWorkspace("today");
    } else {
      app.setCalendarScope("day");
      app.selectDate(target.id);
      app.setWorkspace("calendar");
    }
    docKey = `day-${target.id}`;
  } else {
    app.setCalendarScope(target.horizon);
    app.selectDate(target.periodStart);
    app.setWorkspace("calendar");
    docKey = `goal-${goalKey(target.horizon, target.periodStart)}`;
  }
  const wanted = anchor && (anchor.heading || anchor.line !== undefined);
  app.setPendingAnchor(wanted ? { docKey, ...anchor } : null);
}
