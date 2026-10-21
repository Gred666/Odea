import { backend } from "./backend";
import { useData } from "./store";
import type { Attachment, DocumentSaveTarget } from "./types";

/* ============================================================
   附件：粘贴 / 拖进编辑器的文件存进仓库的「附件」文件夹（Rust 的 Vault::attach），
   拿回从这篇文档引用它的相对路径，由编辑器插进正文。

   失败（太大、写不进去）照常走错误提示条；已经存好的那几个照样插进去。
   ============================================================ */

/** 剪贴板 / 浏览器拖放拿到的文件（内容在内存里） */
export async function attachFiles(
  target: DocumentSaveTarget,
  files: File[],
): Promise<Attachment[]> {
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
export async function attachPaths(
  target: DocumentSaveTarget,
  paths: string[],
): Promise<Attachment[]> {
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
