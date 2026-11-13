/* ============================================================
   Obsidian 的附件写法：`![[图.png]]`、`![[图.png|300]]`、`![[附件/图.png|300x200]]`。

   只写了文件名（或者半截路径），要在整个仓库里找。仓库里有哪些图片由 Rust 扫描时顺带记着
   （Vault::images，命令 vault_images，多了少了发 vault-changed 的 images），这里只管认写法、配名字：

   1. 当成从仓库根起的路径（`附件/图.png`）
   2. 当成相对这一篇所在的文件夹（`./图.png`、`../附件/图.png`）
   3. 按结尾那几段配（`图.png` 配得上 `附件/图.png`、`笔记/工作/图.png`）：同名的有好几个时，
      挑和这一篇在同一个文件夹的，再挑路径最短的，再按路径排

   都不分大小写（Windows、macOS 的文件名默认不分，Obsidian 也不分）。
   `![[笔记]]` 嵌一篇笔记的那一种在 lib/embeds.ts。
   ============================================================ */

/** 按图片画的扩展名；和 Rust 的 IMAGE_EXTENSIONS 一致 */
export const IMAGE_FILE_RE = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;

/**
 * 图片以外、`![[x]]` 嵌成附件卡片的扩展名；和 Rust 的 ATTACHMENT_EXTENSIONS 一致（仓库扫描只收这些）。
 * 卡片上能用系统的程序打开，所以没有能执行的（exe、bat、lnk、html……）
 */
export const ATTACHMENT_FILE_RE =
  /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|tsv|epub|pages|numbers|key|mp3|wav|m4a|ogg|oga|flac|aac|opus|mp4|m4v|webm|mov|mkv|avi|zip|7z|rar|psd|xmind|drawio|heic)$/i;

/** 卡片里能直接放的音频、视频（和 tauri.conf.json 里 asset 协议放行的一致） */
const AUDIO_FILE_RE = /\.(?:mp3|wav|m4a|ogg|oga|flac|aac|opus)$/i;
const VIDEO_FILE_RE = /\.(?:mp4|m4v|webm|mov)$/i;

export type AttachmentKind = "pdf" | "audio" | "video" | "file";

/** 附件按什么画：PDF、能直接放的音频 / 视频，别的都是一张文件卡片 */
export function attachmentKind(name: string): AttachmentKind {
  if (/\.pdf$/i.test(name)) return "pdf";
  if (AUDIO_FILE_RE.test(name)) return "audio";
  if (VIDEO_FILE_RE.test(name)) return "video";
  return "file";
}

/** 卡片上写的类型 */
export function attachmentLabel(name: string): string {
  const ext = /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  const known: Record<string, string> = {
    pdf: "PDF 文档",
    doc: "Word 文档",
    docx: "Word 文档",
    xls: "Excel 表格",
    xlsx: "Excel 表格",
    ppt: "PowerPoint 演示",
    pptx: "PowerPoint 演示",
    txt: "文本",
    csv: "CSV 表格",
    tsv: "TSV 表格",
    epub: "电子书",
    zip: "压缩包",
    "7z": "压缩包",
    rar: "压缩包",
  };
  const kind = attachmentKind(name);
  return (
    known[ext] ??
    (kind === "audio" ? "音频" : kind === "video" ? "视频" : `${ext.toUpperCase()} 文件`)
  );
}

export interface WikiFile {
  /** 写的名字或半截路径 */
  name: string;
  /** `|` 后面写的字（`![[说明书.pdf|安装说明]]`）：卡片上替文件名显示；没写是空串 */
  label: string;
}

/** `![[` 和 `]]` 之间那一段：是图片以外的附件（PDF、文档、音视频……）就返回名字，不是返回 null */
export function wikiFileTarget(inner: string): WikiFile | null {
  const pipe = inner.indexOf("|");
  const name = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
  // `![[说明书.pdf#page=3]]`：Obsidian 的页码，卡片上不管
  const file = name.replace(/#.*$/, "").trim();
  if (!ATTACHMENT_FILE_RE.test(file)) return null;
  const label = pipe >= 0 ? inner.slice(pipe + 1).trim() : "";
  // `|300`：Obsidian 给视频、PDF 写的高度，不当名字
  return { name: file, label: /^\d+(?:x\d+)?$/.test(label) ? "" : label };
}

export interface WikiImage {
  /** 写的名字或半截路径 */
  name: string;
  alt: string;
  width: number | null;
  height: number | null;
}

/** `![[` 和 `]]` 之间那一段：是图片就返回名字和尺寸（`|300`、`|300x200`；别的字当图注），不是返回 null */
export function wikiImageTarget(inner: string): WikiImage | null {
  const pipe = inner.indexOf("|");
  const name = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
  if (!IMAGE_FILE_RE.test(name)) return null;
  const rest = pipe >= 0 ? inner.slice(pipe + 1).trim() : "";
  const size = /^(\d+)(?:x(\d+))?$/.exec(rest);
  const fileName = name.slice(name.lastIndexOf("/") + 1);
  return {
    name,
    alt: size || !rest ? fileName : rest,
    width: size ? Number(size[1]) : null,
    height: size?.[2] ? Number(size[2]) : null,
  };
}

/** `a/./b/../c` → `a/c`，反斜杠换成正斜杠；退到仓库根之上的返回 null */
function normalize(path: string): string | null {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

const dirOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

/**
 * 写的名字 → 仓库里的相对路径（files 里的那一个原样返回）。fromRel 是这一篇在仓库里的路径
 * （不知道就 null：只按仓库根和结尾配）。找不到返回 null
 */
export function resolveVaultFile(
  name: string,
  fromRel: string | null,
  files: readonly string[],
): string | null {
  const wanted = name.trim().replace(/\\/g, "/");
  if (!wanted || !files.length) return null;
  const byKey = new Map<string, string>();
  for (const file of files) byKey.set(file.toLowerCase(), file);
  const exact = (path: string | null) =>
    path === null ? undefined : byKey.get(path.toLowerCase());

  const fromRoot = /^\.\.?\//.test(wanted) ? undefined : exact(normalize(wanted));
  if (fromRoot) return fromRoot;
  const here = fromRel === null ? null : dirOf(fromRel);
  if (here !== null) {
    const beside = exact(normalize(here ? `${here}/${wanted}` : wanted));
    if (beside) return beside;
  }
  const tail = normalize(wanted)?.toLowerCase();
  if (!tail) return null;
  const candidates = files.filter((file) => {
    const key = file.toLowerCase();
    return key === tail || key.endsWith(`/${tail}`);
  });
  if (!candidates.length) return null;
  const folder = here?.toLowerCase();
  return candidates.reduce((best, file) => {
    const near = (path: string) =>
      folder !== undefined && dirOf(path).toLowerCase() === folder ? 0 : 1;
    const order =
      near(file) - near(best) ||
      file.split("/").length - best.split("/").length ||
      file.length - best.length ||
      (file < best ? -1 : file > best ? 1 : 0);
    return order < 0 ? file : best;
  });
}
