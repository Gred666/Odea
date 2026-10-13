import type { Note } from "./types";

/* ============================================================
   笔记文件夹的路径小工具。

   文件夹路径相对仓库里的「笔记」：`工作/周报`；空串是「笔记」本身（全部笔记）。
   一篇笔记在哪个文件夹由它的 relPath 决定（`笔记/工作/周报/第 40 周.md`）；
   不在「笔记」底下的（仓库根上、别的工具建的目录里）都算在「全部笔记」这一层。
   ============================================================ */

export const NOTES_DIR = "笔记";
export const ROOT_LABEL = "全部笔记";

export const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** folder 是不是 path 本身或者在它底下（path 为空串时所有文件夹都算） */
export const within = (folder: string, path: string) =>
  path === "" || folder === path || folder.startsWith(`${path}/`);

/** 给人看的路径：`工作 / 周报`，空串是「全部笔记」 */
export const folderLabel = (path: string) => (path ? path.split("/").join(" / ") : ROOT_LABEL);

/** 笔记所在的文件夹 */
export function folderOf(note: Pick<Note, "relPath">): string {
  const rel = note.relPath ?? "";
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  if (dir === NOTES_DIR) return "";
  return dir.startsWith(`${NOTES_DIR}/`) ? dir.slice(NOTES_DIR.length + 1) : "";
}

export const joinFolder = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);

const FULL_WIDTH: Record<string, string> = {
  "/": "／",
  "\\": "＼",
  ":": "：",
  "*": "＊",
  "?": "？",
  '"': "＂",
  "<": "＜",
  ">": "＞",
  "|": "｜",
};

/**
 * 用户起的文件夹名 → 磁盘上的目录名。和后端 layout::folder_name 同一套规矩：
 * 非法字符换成相近的全角字符、最多 80 个字、去掉开头的点和结尾的点 / 空格、
 * 避开 CON / LPT1 这类设备名。空的返回 null。
 * 前端先按它把新名字显示出来（不等后端那一个来回），后端回来的不一样再改正。
 */
export function cleanFolderName(raw: string): string | null {
  const trimEnds = (s: string) => s.replace(/^\.+/, "").replace(/[. ]+$/, "");
  if (!trimEnds(raw.trim()).trim()) return null;
  let name = [...raw.trim()]
    .map((c) => {
      const code = c.codePointAt(0) ?? 0;
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return " ";
      return FULL_WIDTH[c] ?? c;
    })
    .slice(0, 80)
    .join("");
  name = trimEnds(name);
  const base = (name.split(".")[0] ?? "").toUpperCase();
  if (/^(CON|PRN|AUX|NUL)$/.test(base) || /^(COM|LPT)\d$/.test(base)) name += "_";
  return name.trim();
}

/**
 * 笔记标题 → 磁盘上的文件名（不带 .md），和后端 layout::file_stem_for_title 同一套规矩：
 * 规矩和文件夹名一样，空的是「无标题笔记」。标题里的 `/` 换成全角的 `／`，不会变成一层文件夹
 */
export function fileStemFor(title: string): string {
  return cleanFolderName(title) ?? "无标题笔记";
}

/** parent 下给文件夹名找一个没被占用的：`工作`、`工作 2`…（不分大小写；keep 是改名时它自己） */
export function uniqueChild(
  folders: string[],
  parent: string,
  name: string,
  keep?: string,
): string {
  const taken = new Set(folders.map((folder) => folder.toLowerCase()));
  for (let n = 1; ; n++) {
    const candidate = joinFolder(parent, n === 1 ? name : `${name} ${n}`);
    const lower = candidate.toLowerCase();
    if (lower === keep?.toLowerCase() || !taken.has(lower)) return candidate;
  }
}

/** 直接的子文件夹，按名字排（中文按拼音） */
export function childFolders(folders: string[], parent: string): string[] {
  return folders
    .filter((folder) => parentOf(folder) === parent)
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b), "zh-Hans-CN"));
}

/** 整棵树按显示顺序摊平：父在前、子在后，带深度 */
export function folderTree(
  folders: string[],
  parent = "",
  depth = 0,
): { path: string; depth: number }[] {
  return childFolders(folders, parent).flatMap((path) => [
    { path, depth },
    ...folderTree(folders, path, depth + 1),
  ]);
}

/** 文件夹里一共几篇（子文件夹里的也算） */
export function countIn(notes: Note[], path: string): number {
  return notes.filter((note) => within(folderOf(note), path)).length;
}

/** 文件夹改了名：一条路径跟着换前缀（不在它底下的原样） */
export function renamedPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
}

/** relPath 跟着文件夹改名换前缀 */
export function renamedRelPath(relPath: string, from: string, to: string): string {
  const prefix = `${NOTES_DIR}/${from}/`;
  return relPath.startsWith(prefix)
    ? `${NOTES_DIR}/${to}/${relPath.slice(prefix.length)}`
    : relPath;
}

/** 一篇笔记挪到 folder 之后的 relPath（文件名不变；重名加序号由后端决定，这里只是乐观的猜测） */
export function relPathIn(note: Pick<Note, "relPath" | "title">, folder: string): string {
  const name = note.relPath
    ? note.relPath.slice(note.relPath.lastIndexOf("/") + 1)
    : `${fileStemFor(note.title)}.md`;
  return folder ? `${NOTES_DIR}/${folder}/${name}` : `${NOTES_DIR}/${name}`;
}
