import { isBaseTab } from "@/bases/ids";
import { saveKeyOf, useData } from "@/data/store";
import { type NoteSummary, noteRef } from "@/data/types";
import { isMac } from "@/lib/platform";
import { rememberSpot, spotOf } from "@/lib/viewMemory";
import { type NoteView, noteViewOf, noteViewsOf } from "@/plugins/registry";
import { activeTabOf, focusedPane, setViewOfNote } from "./panes";
import type { NoteTab } from "./panes";
import { useApp } from "./store";

/* ============================================================
   笔记的摆法（插件的 noteViews，白板，docs/白板.md §13.4）：记在标签上，每个标签各记各的。

   - 在一个标签里打开另一篇时用哪种：这一篇在这台电脑上上次用的（lib/viewMemory.ts 的 view）；
     没用过的，问开着的插件「这一篇默认是不是你」（白板：有标记的）；都不是就是文档
   - 换摆法（命令面板、Ctrl+Shift+B、状态栏的按钮、白板右下角「文档」）换的只是这一个标签，顺手记下这一篇上次用的
   - 插件关了：标签上记的那种摆法没了，画成文档；再开回来还是那种
   - 新建一篇就用这种摆法（「新建白板」）：建好、起好名字，记成这种摆法再开，开出来就是它
   - 列表栏里一篇默认是哪种摆法（白板：有标记的），图标就换成那种的
   ============================================================ */

const memoryKey = (noteId: string) => saveKeyOf(noteRef(noteId));

/** 一篇笔记在标签里换上来时用哪种摆法（undefined 是文档） */
export function viewOfNote(noteId: string): string | undefined {
  if (!noteId || isBaseTab(noteId)) return undefined;
  const { layout, notes } = useData.getState();
  const remembered = spotOf(memoryKey(noteId))?.view;
  if (remembered !== undefined) {
    return remembered && noteViewOf(remembered, layout.plugins) ? remembered : undefined;
  }
  const note = notes.find((other) => other.id === noteId);
  return note ? noteViewsOf(layout.plugins).find((view) => view.defaultFor(note))?.id : undefined;
}

setViewOfNote(viewOfNote);

type AppState = ReturnType<typeof useApp.getState>;

/** 正在写的那个窗口（主窗口在笔记区时、或者弹出窗口）里正在写的那个标签。也给 useApp 当选择器用 */
export function focusedTabOf(app: AppState): NoteTab | null {
  const popout = app.activePopout ? app.popouts.find((p) => p.id === app.activePopout) : null;
  if (popout) return activeTabOf(focusedPane(popout));
  if (app.workspace !== "notes") return null;
  return activeTabOf(focusedPane({ panes: app.notePanes, activePane: app.activePane }));
}

export const focusedNoteTab = () => focusedTabOf(useApp.getState());

/** 这个标签画成哪种摆法（插件关了、是视图文件的是文档） */
export function shownView(tab: Pick<NoteTab, "noteId" | "view">, enabled: readonly string[]) {
  return isBaseTab(tab.noteId) ? undefined : noteViewOf(tab.view, enabled);
}

/** 换一个标签的摆法（undefined 是文档），记下这一篇上次用的 */
export function showNoteAs(tab: Pick<NoteTab, "id" | "noteId">, view: string | undefined): void {
  if (!tab.noteId || isBaseTab(tab.noteId)) return;
  rememberSpot(memoryKey(tab.noteId), { view: view ?? null });
  useApp.getState().setTabView(tab.id, view);
}

/** 这个标签换到这种摆法；已经是它就换回文档。不是笔记的标签（视图文件、空的）返回 false */
export function toggleTabView(tab: NoteTab, view: NoteView): boolean {
  if (!tab.noteId || isBaseTab(tab.noteId)) return false;
  const enabled = useData.getState().layout.plugins;
  showNoteAs(tab, shownView(tab, enabled)?.id === view.id ? undefined : view.id);
  return true;
}

/** 正在写的那个标签换到这种摆法（命令面板）；已经是它就换回文档 */
export function toggleNoteView(view: NoteView): boolean {
  const tab = focusedNoteTab();
  return !!tab && toggleTabView(tab, view);
}

/** 换到这种摆法的快捷键怎么写（「Ctrl+Shift+B」）；没有快捷键是 undefined */
export function viewShortcut(view: NoteView): string | undefined {
  const key = view.shortcut?.replace(/^Key/, "");
  return key ? `${isMac ? "Cmd" : "Ctrl"}+Shift+${key}` : undefined;
}

/**
 * 新建一篇、记成这种摆法（命令面板、文件夹「…」菜单里的「新建白板」）：开出来就是它。返回新的 id；
 * 这种摆法不能新建、没建成是 null。开哪儿、焦点去哪是调用的那边的事
 */
export async function createNoteAs(view: NoteView, folder: string): Promise<string | null> {
  if (!view.create) return null;
  const id = await useData.getState().createNote(folder, view.create.title);
  if (id) rememberSpot(memoryKey(id), { view: view.id });
  return id;
}

/** 开着的插件里能新建的那几种摆法 */
export function creatableViews(enabled: readonly string[]): NoteView[] {
  return noteViewsOf(enabled).filter((view) => view.create);
}

/** 列表栏里这一篇的图标：默认是哪种摆法就用它的（白板：有标记的），文档是 null */
export function noteViewIcon(note: NoteSummary, enabled: readonly string[]) {
  return noteViewsOf(enabled).find((view) => view.defaultFor(note))?.icon ?? null;
}

/** 按了 Ctrl（⌘）+ Shift + 这个键：哪种摆法（开着的插件给的） */
export function viewOfShortcut(code: string): NoteView | undefined {
  return noteViewsOf(useData.getState().layout.plugins).find((view) => view.shortcut === code);
}
