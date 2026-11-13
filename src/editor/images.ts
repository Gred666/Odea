import { wikiImageTarget } from "@/lib/wikiFiles";
import { type ImageBase, type WikiImageResolver, resolveImageSource } from "./html";
import type { ImageSpec } from "./widgets";

/* ============================================================
   正文里一张图片的源码 → 画它要的东西（地址、alt、标题、尺寸）。编辑器的替身（widgets.ts 的 ImageWidget）
   和静态渲染（render/staticHtml.ts：嵌入卡片、导出）共用这一份认法：

   - `![alt](地址 "标题")`、`![alt][ref]`：alt 里的 `|300` / `|300x200` 是 Obsidian 式尺寸
   - `![[图.png]]`、`![[图.png|300]]`：Obsidian 的附件写法，只写名字，按名字在仓库里找（lib/wikiFiles.ts）
   ============================================================ */

/** 源码里写的样子，地址还没解析（相对路径、本机路径、网址原样） */
export function parseImage(markdown: string, source: string): ImageSpec | null {
  const inline = /^!\[([^\]]*)\]\((\S+?)(?:\s+["'](.*)["'])?\)$/.exec(source);
  if (inline) return withSize(inline[1]!, inline[2]!, inline[3] ?? "");

  const reference = /^!\[([^\]]*)\]\[([^\]]*)\]$/.exec(source);
  if (!reference) return null;
  const label = (reference[2] || reference[1]!).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const definition = new RegExp(
    `^\\[${label}\\]:\\s*(?:<([^>]+)>|(\\S+))(?:\\s+["'(](.*?)["')])?`,
    "im",
  ).exec(markdown);
  const url = definition?.[1] ?? definition?.[2];
  return url ? withSize(reference[1]!, url, definition?.[3] ?? "") : null;
}

/**
 * `![alt](src "title")` / `![alt][ref]`，地址按这篇文档的位置解析成 <img> 用的（html.ts 的 resolveImageSource）。
 */
export function resolveImage(
  markdown: string,
  source: string,
  base: ImageBase = null,
): ImageSpec | null {
  const image = parseImage(markdown, source);
  return image && { ...image, source: resolveImageSource(image.source, base) };
}

function withSize(rawAlt: string, source: string, title: string): ImageSpec {
  const size = /^(.*?)\|(\d+)(?:x(\d+))?$/.exec(rawAlt);
  return {
    alt: (size ? size[1]! : rawAlt).trim(),
    source,
    title,
    width: size ? Number(size[2]) : null,
    height: size?.[3] ? Number(size[3]) : null,
  };
}

/** `![[图.png]]` 的整段源码 → 图片要画的东西，地址用 resolver 找；不是这种写法返回 null。找不到文件时地址是空串 */
export function wikiImage(source: string, resolver: WikiImageResolver | null): ImageSpec | null {
  const inner = /^!\[\[([^\]]+)\]\]$/.exec(source)?.[1];
  const target = inner === undefined ? null : wikiImageTarget(inner);
  if (!target) return null;
  const found = resolver?.(target.name) ?? null;
  return {
    alt: target.alt,
    source: found?.src ?? "",
    title: found ? "" : `仓库里找不到「${target.name}」`,
    width: target.width,
    height: target.height,
  };
}
