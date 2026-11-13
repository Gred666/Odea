import type { DocumentRef } from "@/data/types";

/* ============================================================
   插件（L1，docs/插件与跨端.md §5.5）够到「正在看的文档」的地方。和 editorCommands 一个思路：
   插件的宿主不在编辑器的分包里，不能直接碰 CodeMirror，只经过这里。

   两种登记：
   - 看得见的文档：每个 DocumentView 显示着一篇仓库里的文档时登记（窗格、弹出窗口里的都算），
     带着它在不在正在写的那个窗格。能力 documents.*: current 的「正在看的」就是这几篇。
     做客的那一篇（别人的文档）不登记，插件看不到
   - 开着的编辑器：MarkdownEditor 每个实例登记一份，给出实时的正文、修订号、改它的入口。
     同一篇开在两个窗格里时有两份，先登记的那一份说了算（修订号是按那个编辑器自己的改动数的，
     读和改要落在同一个编辑器上，见 editor/pluginEdits.ts）

   正文变了：编辑器每次改动都报一声 touched，这里攒 400ms（打字停下来）再告诉订阅的人。
   插件不进输入的热路径（§5.3）：每敲一个字都不会叫醒沙箱。
   ============================================================ */

/** 插件交来的一处改动：位置按它读到的那一版算 */
export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

export type EditOutcome =
  | { ok: true; revision: string }
  | { ok: false; code: "stale" | "busy" | "readonly" | "invalid"; message: string };

export interface LiveEditor {
  text(): string;
  revision(): string;
  /** 照着 base 那一版改；中间别人改过的能挪就挪（不重叠），挪不了回 stale */
  edit(base: string, changes: TextChange[], origin: string): EditOutcome;
}

export interface VisibleDocument {
  ref: DocumentRef;
  /** 文档的键（data/store 的 saveKeyOf）：编辑器按它登记 */
  key: string;
  title: string;
  /** 在正在写的那个窗格里 */
  focused: boolean;
  /** 编辑器还没挂上时的正文 */
  bodyMd: string;
  /** 在仓库里的路径（导出时相对路径的图片按它解析）；还没有文件的文档没有 */
  relPath?: string;
}

const visible = new Map<number, VisibleDocument>();
/** 最近一次「在正在写的那个窗格里」的那一份（弹出窗口、主窗口各有一个 focused 时，后来的算） */
let lastFocused = 0;
let nextVisible = 1;
const editors = new Map<string, LiveEditor[]>();
const visibleListeners = new Set<() => void>();
const changeListeners = new Set<(key: string) => void>();
const touchTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 打字停下来多久才算「改完了」 */
export const CHANGE_SETTLE_MS = 400;

const emitVisible = () => {
  for (const listener of visibleListeners) listener();
};

/** DocumentView 显示着一篇：登记，内容变了 update，换篇、卸载时 dispose */
export function registerVisibleDocument(entry: VisibleDocument): {
  update(entry: VisibleDocument): void;
  dispose(): void;
} {
  const id = nextVisible++;
  visible.set(id, entry);
  if (entry.focused) lastFocused = id;
  emitVisible();
  return {
    update(next) {
      const before = visible.get(id);
      if (!before) return;
      visible.set(id, next);
      if (next.focused && !before.focused) lastFocused = id;
      if (
        before.key !== next.key ||
        before.focused !== next.focused ||
        before.title !== next.title
      ) {
        emitVisible();
      }
    },
    dispose() {
      if (!visible.delete(id)) return;
      if (lastFocused === id) lastFocused = 0;
      emitVisible();
    },
  };
}

/** 现在看得见的文档（同一篇开在两处只算一次） */
export function visibleDocuments(): VisibleDocument[] {
  const seen = new Set<string>();
  const out: VisibleDocument[] = [];
  for (const entry of visible.values()) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    out.push(entry);
  }
  return out;
}

export function visibleDocument(key: string): VisibleDocument | undefined {
  for (const entry of visible.values()) if (entry.key === key) return entry;
  return undefined;
}

/** 正在写的那一篇：正在写的那个窗格里的；一个都没标的话，最早登记的那一份 */
export function focusedDocument(): VisibleDocument | null {
  const focused = visible.get(lastFocused);
  if (focused?.focused) return focused;
  for (const entry of visible.values()) if (entry.focused) return entry;
  return visible.values().next().value ?? null;
}

export function onVisibleChange(listener: () => void): () => void {
  visibleListeners.add(listener);
  return () => {
    visibleListeners.delete(listener);
  };
}

/** 编辑器挂上时登记，卸载时 dispose */
export function registerLiveEditor(key: string, editor: LiveEditor): () => void {
  const list = editors.get(key) ?? [];
  list.push(editor);
  editors.set(key, list);
  return () => {
    const current = editors.get(key);
    if (!current) return;
    const index = current.indexOf(editor);
    if (index >= 0) current.splice(index, 1);
    if (!current.length) editors.delete(key);
  };
}

/** 这一篇开着的编辑器（先登记的那一份） */
export function liveEditor(key: string): LiveEditor | undefined {
  return editors.get(key)?.[0];
}

/** 编辑器里改了一笔（谁改的都算）：攒一会儿再告诉订阅的人 */
export function touched(key: string): void {
  if (!changeListeners.size) return;
  const timer = touchTimers.get(key);
  if (timer) clearTimeout(timer);
  touchTimers.set(
    key,
    setTimeout(() => {
      touchTimers.delete(key);
      for (const listener of changeListeners) listener(key);
    }, CHANGE_SETTLE_MS),
  );
}

export function onDocumentTouched(listener: (key: string) => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}
