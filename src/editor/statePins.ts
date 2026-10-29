/**
 * 编辑器状态缓存（MarkdownEditor.tsx）里哪些篇不挤掉：开着的标签那几篇（docs/标签页与分屏.md §6.3）。
 *
 * 单独一个小文件、不引别的：app 那边（主包）往里写，编辑器分包里的缓存往外读，
 * 不至于为了这一个集合把编辑器分包拖进主包。键是 data/store 的 saveKeyOf（`note:…`）
 */

let pinned: ReadonlySet<string> = new Set();

export function pinEditorStates(keys: Iterable<string>): void {
  pinned = new Set(keys);
}

export function isPinnedState(key: string): boolean {
  return pinned.has(key);
}
