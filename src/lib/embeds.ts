/* ============================================================
   `![[笔记]]`、`![[笔记#小节]]`：把另一篇（或它的一节）嵌进正文。这里只管认目标、取那一节；
   编辑器里画卡片在 editor/embed.ts。

   目标的写法和双链一样（lib/wikilinks.ts）：按标题认，去掉两头空白、不分大小写；`|别名` 不管。
   这几种不算嵌一篇笔记，照旧显示源码：
   - 带附件扩展名的 `![[图.png]]`、`![[说明书.pdf]]`（Obsidian 的图片、附件写法）
   - 块引用 `![[笔记^id]]`、`![[笔记#^id]]`
   - 只有小节、没写哪一篇的 `![[#小节]]`
   ============================================================ */

import { ATTACHMENT_FILE_RE, IMAGE_FILE_RE } from "./wikiFiles";

/**
 * 这些扩展名的 `![[x]]` 是附件，不是笔记。`.md` 不在里面：`![[周报.md]]` 就是「周报」那一篇。
 * 图片、附件卡片认的（lib/wikiFiles.ts），再加上 Obsidian 自己的几种文件（白板、数据库视图）
 */
export const FILE_EXTENSIONS = {
  test: (name: string) =>
    IMAGE_FILE_RE.test(name) ||
    ATTACHMENT_FILE_RE.test(name) ||
    /\.(?:canvas|base|excalidraw)$/i.test(name),
};

export interface EmbedTarget {
  title: string;
  /** 只嵌这一节（`![[笔记#小节]]`）；Obsidian 的 `#一级#二级` 取最后一段 */
  heading?: string;
}

/** `![[` 和 `]]` 之间那一段：嵌哪一篇、哪一节。不是嵌一篇笔记的返回 null */
export function noteEmbedTarget(inner: string): EmbedTarget | null {
  const raw = (inner.split("|")[0] ?? "").trim();
  const hash = raw.indexOf("#");
  const caret = raw.indexOf("^");
  // `笔记^id`：块引用
  if (caret >= 0 && (hash < 0 || caret < hash)) return null;
  const title = (hash >= 0 ? raw.slice(0, hash) : raw).trim().replace(/\.md$/i, "");
  if (!title || FILE_EXTENSIONS.test(title)) return null;
  if (hash < 0) return { title };
  const path = raw
    .slice(hash + 1)
    .split("#")
    .map((part) => part.trim())
    .filter(Boolean);
  const heading = path[path.length - 1];
  // `笔记#^id`：也是块引用
  if (heading?.startsWith("^")) return null;
  return heading ? { title, heading } : { title };
}

const sameHeading = (a: string, b: string) =>
  a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * 正文里叫这个名字的那一节：从这个标题那一行起，到下一个同级或更高一级的标题之前（连着它底下更小的标题）。
 * 同名的有好几节取第一节；围栏代码块里的 `#` 不算标题。找不到返回 null
 */
export function sectionOf(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n");
  let fence: string | null = null;
  let start = -1;
  let level = 0;
  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const match = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (!match) continue;
    const depth = match[1]!.length;
    if (start >= 0 && depth <= level) return lines.slice(start, index).join("\n").trimEnd();
    if (start < 0 && sameHeading(match[2]!, heading)) {
      start = index;
      level = depth;
    }
  }
  return start >= 0 ? lines.slice(start).join("\n").trimEnd() : null;
}
