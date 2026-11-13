import type { AttachmentHost } from "@/editor/attachmentEmbed";
import type { VaultFile, WikiImageResolver } from "@/editor/html";
import { isTauri } from "@/lib/tauri";
import { resolveVaultFile } from "@/lib/wikiFiles";
import { convertFileSrc } from "@tauri-apps/api/core";
import { backend } from "./backend";
import { useData } from "./store";
import type { Attachment, DocumentRef } from "./types";

/* ============================================================
   附件：粘贴 / 拖进编辑器的文件存进仓库的「附件」文件夹（Rust 的 Vault::attach），
   拿回从这篇文档引用它的相对路径，由编辑器插进正文。

   失败（太大、写不进去）照常走错误提示条；已经存好的那几个照样插进去。
   ============================================================ */

/** 剪贴板 / 浏览器拖放拿到的文件（内容在内存里） */
export async function attachFiles(target: DocumentRef, files: File[]): Promise<Attachment[]> {
  const api = await backend();
  const out: Attachment[] = [];
  for (const file of files) {
    try {
      const data = await base64Of(file);
      out.push(await api.vaultAttach(target, file.name || fallbackName(file.type), data));
    } catch (error) {
      report(error);
    }
  }
  return out;
}

/** 桌面端从系统拖进窗口的文件（只有路径） */
export async function attachPaths(target: DocumentRef, paths: string[]): Promise<Attachment[]> {
  const api = await backend();
  const out: Attachment[] = [];
  for (const path of paths) {
    try {
      out.push(await api.vaultAttachPath(target, path));
    } catch (error) {
      report(error);
    }
  }
  return out;
}

/** 剪贴板里的截图没有文件名：按类型起一个，后端会换成「粘贴-时间」 */
export function fallbackName(type: string): string {
  const ext = type.split("/")[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg") || "png";
  return `image.${ext}`;
}

export function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("读不出这个文件"));
    reader.readAsDataURL(file);
  });
}

function report(error: unknown) {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
  useData.setState({ error: `附件没存进去：${message}` });
}

/**
 * 文档所在的文件夹（绝对路径，正斜杠）：正文里的相对图片路径以它为基准。
 * 浏览器预览里没有仓库文件夹，返回 null（那边插进去的是 data: 地址）。
 */
export function documentFolder(
  vaultRoot: string | null,
  relPath: string | undefined,
): string | null {
  if (!vaultRoot || !relPath) return null;
  const root = vaultRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const cut = relPath.lastIndexOf("/");
  return cut >= 0 ? `${root}/${relPath.slice(0, cut)}` : root;
}

/**
 * 仓库里的一个文件（相对仓库的路径）→ <img> 能用的地址。桌面端走 asset 协议；
 * 浏览器预览里没有仓库文件夹，按站点根目录给（public/ 里那几个，mock 的 vaultAttachments 列的就是它们）
 */
export function vaultFileSrc(vaultRoot: string | null, rel: string): string {
  if (vaultRoot && isTauri) {
    return convertFileSrc(`${vaultRoot.replace(/\\/g, "/").replace(/\/+$/, "")}/${rel}`);
  }
  return `/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Obsidian 的 `![[图.png]]`、`![[说明书.pdf]]` 怎么找文件：这一篇在仓库的 relPath，仓库里有 files 这些附件
 * （lib/wikiFiles.ts）。编辑器每画一次可见的那一段都要问，同一个名字记住答案（files 换了会整个换一个新的）
 */
export function wikiImageResolver(
  vaultRoot: string | null,
  relPath: string | null | undefined,
  files: readonly string[],
): WikiImageResolver {
  const known = new Map<string, VaultFile | null>();
  return (name) => {
    const cached = known.get(name);
    if (cached !== undefined) return cached;
    const rel = resolveVaultFile(name, relPath ?? null, files);
    const found = rel ? { rel, src: vaultFileSrc(vaultRoot, rel) } : null;
    known.set(name, found);
    return found;
  };
}

/**
 * `![[说明书.pdf]]` 的卡片（editor/attachmentEmbed.ts）在这台的仓库里怎么找、怎么打开：按名字找同上，
 * 打开走 Rust 的 vault_attachment_open（只认附件清单里有的）
 */
export function localAttachmentHost(
  vaultRoot: string | null,
  relPath: string | null | undefined,
  files: readonly string[],
): AttachmentHost {
  const resolve = wikiImageResolver(vaultRoot, relPath, files);
  return {
    resolve,
    open: (name, reveal) => {
      const found = resolve(name);
      if (found) void useData.getState().openAttachment(found.rel, reveal);
      else useData.setState({ error: `仓库里找不到「${name.trim()}」` });
    },
    remote: false,
  };
}
