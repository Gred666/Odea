import type { TreeShape } from "./tree";
import { type NoteSummary, ODEA_LAYOUT, type VaultLayout } from "./types";

/* ============================================================
   文件树上文件夹的路径小工具。

   文件夹路径相对树根：`工作/周报`；空串是树根本身（全部笔记）。树根是仓库里的「笔记」
   （Odea 建的仓库），或者整个仓库（没开日程的，比如打开的 Obsidian 库），见 VaultLayout。
   一篇笔记在哪个文件夹由它的 relPath 决定（`笔记/工作/周报/第 40 周.md`）；
   不在树根底下的（仓库根上、别的工具建的目录里）、在日程那几个文件夹里的都算在「全部笔记」这一层。

   逻辑目录（docs/仓库与启动器.md §7）：文件夹在清单里（data/tree.ts 摊开的 TreeShape），
   一篇在哪个文件夹看它在树上的位置、和文件在哪无关；没放进树里的在「未整理」（UNSORTED）。
   文件夹按手动排的顺序，不按名字
   ============================================================ */

export const ROOT_LABEL = "全部笔记";
/** 「未整理」在界面上的路径：真的文件夹路径不会以 / 开头（Rust 的 tree::UNSORTED） */
export const UNSORTED = "/";
export const UNSORTED_LABEL = "未整理";

/** 逻辑目录的树摊开的样子；本地目录是 null。data/store 取到树时换上（setTreeShape） */
let logical: TreeShape | null = null;

export function setTreeShape(shape: TreeShape | null) {
  logical = shape;
}

export const isLogical = () => logical !== null;

/** 智能文件夹的条件；不是智能文件夹返回 undefined */
export const smartQuery = (path: string) => logical?.smart.get(path);

/** 放在这个文件夹里的快捷方式（逻辑目录才有），按排序键 */
export const shortcutsIn = (path: string) => logical?.shortcuts.get(path) ?? [];

/** 手动排序（逻辑目录）时这一篇的排序键；没放进树里的没有 */
export const manualKey = (note: Pick<NoteSummary, "id">) => logical?.placement.get(note.id)?.key;

/** 这个窗口的仓库怎么摆。data/store 取到仓库信息时换成真的（setTreeLayout） */
let tree: Pick<VaultLayout, "notesDir" | "hiddenDirs"> = ODEA_LAYOUT;

export function setTreeLayout(layout: Pick<VaultLayout, "notesDir" | "hiddenDirs">) {
  tree = layout;
}

/** 树根在仓库里的路径：「笔记」，或者整个仓库（空串） */
export const treeRoot = () => tree.notesDir;

/** 树上的文件夹 → 仓库里的目录 */
const dirOf = (folder: string) =>
  tree.notesDir && folder ? `${tree.notesDir}/${folder}` : tree.notesDir || folder;

export const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** folder 是不是 path 本身或者在它底下（path 为空串时所有文件夹都算） */
export const within = (folder: string, path: string) =>
  path === "" || folder === path || folder.startsWith(`${path}/`);

/** 给人看的路径：`工作 / 周报`，空串是「全部笔记」 */
export const folderLabel = (path: string) =>
  path === UNSORTED ? UNSORTED_LABEL : path ? path.split("/").join(" / ") : ROOT_LABEL;

/** 文件夹自己的名字：空串是「全部笔记」，UNSORTED 是「未整理」 */
export const folderName = (path: string) =>
  path === UNSORTED ? UNSORTED_LABEL : path ? nameOf(path) : ROOT_LABEL;

/** 笔记所在的文件夹（和 Rust 的 Layout::folder_of_dir 一样）。逻辑目录看它在树上的位置 */
export function folderOf(note: Pick<NoteSummary, "relPath"> & { id?: string }): string {
  if (logical) return (note.id && logical.placement.get(note.id)?.folder) ?? UNSORTED;
  const rel = note.relPath ?? "";
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  if (tree.hiddenDirs.some((hidden) => dir === hidden || dir.startsWith(`${hidden}/`))) return "";
  const root = tree.notesDir;
  if (!root) return dir;
  if (dir === root) return "";
  return dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : "";
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

/** 直接的子文件夹，按名字排（中文按拼音）。逻辑目录按手动排的顺序（folders 本来就是这个顺序） */
export function childFolders(folders: string[], parent: string): string[] {
  const children = folders.filter((folder) => parentOf(folder) === parent && folder !== UNSORTED);
  if (logical) return children;
  return children.sort((a, b) => nameOf(a).localeCompare(nameOf(b), "zh-Hans-CN"));
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
export function countIn(notes: NoteSummary[], path: string): number {
  return notes.filter((note) => within(folderOf(note), path)).length;
}

/** 文件夹改了名：一条路径跟着换前缀（不在它底下的原样） */
export function renamedPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
}

/** relPath 跟着文件夹改名换前缀 */
export function renamedRelPath(relPath: string, from: string, to: string): string {
  const prefix = `${dirOf(from)}/`;
  return relPath.startsWith(prefix) ? `${dirOf(to)}/${relPath.slice(prefix.length)}` : relPath;
}

/** 一篇笔记挪到 folder 之后的 relPath（文件名不变；重名加序号由后端决定，这里只是乐观的猜测） */
export function relPathIn(note: Pick<NoteSummary, "relPath" | "title">, folder: string): string {
  const name = note.relPath
    ? note.relPath.slice(note.relPath.lastIndexOf("/") + 1)
    : `${fileStemFor(note.title)}.md`;
  const dir = dirOf(folder);
  return dir ? `${dir}/${name}` : name;
}
