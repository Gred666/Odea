/* ============================================================
   标签里的视图文件（docs/视图文件.md §3.5）。

   标签存的是一个字符串（app/panes.ts 的 NoteTab.noteId）：笔记是它的 id，视图文件是 `base:` + 相对路径。
   标签、窗格、往回走、弹出窗口、记在本机全按这一个字符串走，不用给标签加一个「种类」。
   笔记 id 是应用生成的 UUID，外来笔记的是属性块里写的字；要以 `base:` 开头又以 `.base` 结尾才算，撞不上。
   这个文件很轻：核心（列表、标签、正文区）只引它，视图本身用到时才加载
   ============================================================ */

const PREFIX = "base:";

export const baseTabId = (relPath: string) => `${PREFIX}${relPath}`;

/** 这个标签开的是不是视图文件：是的话给相对路径 */
export function baseOfTab(id: string): string | null {
  return id.startsWith(PREFIX) && /\.base$/i.test(id) ? id.slice(PREFIX.length) : null;
}

export const isBaseTab = (id: string) => baseOfTab(id) !== null;

/** 视图文件的名字（不带 `.base`）：标签、页头上写的 */
export function baseTitle(relPath: string): string {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  return name.replace(/\.base$/i, "");
}
