import { useApp } from "@/app/store";
import { MEASURES } from "@/app/typography";
import { documentFolder, vaultFileSrc } from "@/data/attachments";
import { backend } from "@/data/backend";
import {
  UNSORTED,
  cleanFolderName,
  fileStemFor,
  folderLabel,
  folderName,
  folderOf,
  manualKey,
  within,
} from "@/data/folders";
import { saveKeyOf, useData } from "@/data/store";
import { type NoteSummary, noteRef } from "@/data/types";
import { localImagePath } from "@/editor/html";
import { type EmbedTarget, sectionOf } from "@/lib/embeds";
import { focusedDocument, liveEditor } from "@/lib/liveDocuments";
import { IS_WINDOWS } from "@/lib/platform";
import { isTauri } from "@/lib/tauri";
import { resolveVaultFile } from "@/lib/wikiFiles";
import staticCss from "@/render/static.css?raw";
import {
  type StaticOptions,
  escapeHtml,
  renderStaticHtml,
  slug,
  stripFrontMatter,
} from "@/render/staticHtml";
import katexCss from "katex/dist/katex.min.css?raw";
import { type PageSetup, loadPageSetup, pageCss, paperSize, today } from "./pageSetup";

/* ============================================================
   导出：一篇，或者整个文件夹。

   一篇 → HTML（一个文件，浏览器直接打开）或 PDF。整个文件夹 → 一份 PDF（每篇另起一页，前面是目录），
   或者一个放网页的文件夹（每篇一页，外加目录 index.html，篇和篇之间的双链能点）。

   正文用静态渲染器排（render/staticHtml.ts，嵌入卡片也用它），外面包一整页：标题、亮色的 token、
   static.css、有公式时再加 KaTeX 的样式和字体。一个文件里什么都有 ——
   - 本机图片（相对这一篇、`![[图.png]]`、本机路径）读成 data: 嵌进去（Rust 的 export_image）；
     网络图片照旧是网址
   - 公式的字体嵌成 data:（KaTeX 的 woff2 一共 260 KB，只在有公式时带）
   - `![[笔记]]` 嵌的那一篇排进来，里面再嵌的不展开
   - 打印（PDF）时收起的 callout 展开，字号按纸张来（10.5pt）；纸张、页边距、页眉页脚是页面设置里的
     （export/pageSetup.ts，记在本机）

   先弹「另存为」再排（Rust 的 export_pick）：点了命令马上有对话框。macOS / Linux 的 PDF 没有
   「另存为」这一步，排好交给系统的打印对话框（print.rs）。
   ============================================================ */

export type ExportFormat = "html" | "pdf";

export interface ExportSource {
  title: string;
  markdown: string;
  /** 在仓库里的路径：相对路径的图片、`![[图.png]]` 按它找 */
  relPath: string | null;
}

/** 亮色的 token（globals.css 的 @theme 和代码高亮那一段；那边改了这里跟着改） */
const TOKENS = `:root {
  --color-ink: #1a1a18;
  --color-body: #353532;
  --color-muted: #74746e;
  --color-faint: #91918a;
  --color-canvas: #ffffff;
  --color-panel: #fafaf8;
  --color-rail: #f1f1ed;
  --color-raised: #e5e5df;
  --color-line: #f1f1ee;
  --color-line-strong: #e7e7e1;
  --color-accent: #2f63d8;
  --color-accent-wash: #f1f4fa;
  --color-accent-line: #dbe4f7;
  --color-success: #2f8a5b;
  --color-danger: #c8483d;
  --color-warning: #b8802a;
  --color-callout-important: #7c5cd6;
  --radius-xs: 4px;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif;
  --font-display: -apple-system, BlinkMacSystemFont, "Segoe UI Variable Display", "Segoe UI",
    "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC",
    system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "Cascadia Mono", ui-monospace, "SFMono-Regular", Consolas,
    "Liberation Mono", "Microsoft YaHei UI", "PingFang SC", "Noto Sans Mono CJK SC", "Noto Sans SC",
    monospace;
  --code-keyword: #8b3fc9;
  --code-string: #2f7d4f;
  --code-comment: #8c8c85;
  --code-number: #b45d1f;
  --code-function: #2f63d8;
  --code-definition: #1f5fb8;
  --code-type: #0e7c86;
  --code-property: #3b5bcc;
  --code-tag: #2f8a5b;
  --code-operator: #74746e;
  --code-punct: #8d8d85;
  --code-meta: #8d8d85;
  --code-invalid: #c8483d;
}`;

/** 一整页的版式。网页按应用里的正文字号、行宽；纸上另算（纸张、页边距在 pageCss） */
function layoutCss(bodySize: number, chars: number | null): string {
  const width = chars ? `${chars * bodySize + 48}px` : "none";
  return `html {
  background: #ffffff;
}
body {
  margin: 0;
  background: var(--color-canvas);
  -webkit-text-size-adjust: 100%;
  --odea-body-size: ${bodySize}px;
}
.odea-page {
  box-sizing: border-box;
  max-width: ${width};
  margin: 0 auto;
  padding: 56px 24px 96px;
}
.odea-page .odea-title {
  margin: 0 0 0.8em;
  border: 0;
  padding: 0;
  color: var(--color-ink);
  font-family: var(--font-display);
  font-size: 2em;
  font-weight: 700;
  line-height: 1.25;
}
.odea-static a.wikilink {
  text-decoration: none;
}
/* 整个文件夹导出成网页：每页顶上回目录 */
.odea-page .odea-back {
  margin: 0 0 28px;
  font-size: 13px;
}
.odea-page .odea-back a {
  color: var(--color-muted);
  text-decoration: none;
}
/* 目录：整个文件夹导出时的第一页、网页的 index.html */
.odea-static .odea-toc-meta {
  margin: -0.4em 0 1.6em;
  color: var(--color-muted);
  font-size: 0.86em;
}
.odea-static .odea-toc-group {
  margin: 1.4em 0 0.4em;
  color: var(--color-muted);
  font-size: 0.86em;
  font-weight: 500;
}
.odea-static .odea-toc ol {
  margin: 0;
  padding: 0;
  list-style: none;
}
.odea-static .odea-toc li {
  margin: 0.35em 0;
}
.odea-static .odea-toc a {
  color: var(--color-ink);
  text-decoration: none;
}
/* 整个文件夹合成一份：每篇另起一页（目录也单占一页） */
.odea-book > .odea-chapter + .odea-chapter,
.odea-book > .odea-toc + .odea-chapter {
  break-before: page;
}
@media screen {
  .odea-book > .odea-chapter + .odea-chapter,
  .odea-book > .odea-toc + .odea-chapter {
    margin-top: 72px;
    border-top: 1px solid var(--color-line-strong);
    padding-top: 56px;
  }
}
@media print {
  html,
  body {
    background: #ffffff;
  }
  body {
    --odea-body-size: 14px;
    /* 纸上很淡的线看不见：分隔线、表格的边加深一档 */
    --color-line: #e4e4de;
    --color-line-strong: #d6d6ce;
  }
  .odea-page {
    max-width: none;
    padding: 0;
  }
}`;
}

/** KaTeX 的字体：只用 woff2（现在的浏览器都认），嵌成 data: */
const katexFonts = import.meta.glob("/node_modules/katex/dist/fonts/*.woff2", {
  query: "?url",
  import: "default",
  exhaustive: true,
}) as Record<string, () => Promise<string>>;

let katexStyle: Promise<string> | null = null;

/** KaTeX 的样式，字体换成 data:（woff、ttf 那两份去掉） */
function katexStylesheet(): Promise<string> {
  katexStyle ??= (async () => {
    const names = [...katexCss.matchAll(/url\(fonts\/([\w-]+)\.woff2\)/g)].map(
      (match) => match[1]!,
    );
    const fonts = new Map<string, string>();
    await Promise.all(
      [...new Set(names)].map(async (name) => {
        const load = katexFonts[`/node_modules/katex/dist/fonts/${name}.woff2`];
        if (!load) return;
        const data = await dataUrl(await load()).catch(() => null);
        if (data) fonts.set(name, data);
      }),
    );
    return katexCss.replace(
      /src:url\(fonts\/([\w-]+)\.woff2\) format\("woff2"\)(?:,url\([^)]*\) format\("[^"]*"\))*/g,
      (whole, name: string) => {
        const data = fonts.get(name);
        return data ? `src:url(${data}) format("woff2")` : whole;
      },
    );
  })();
  return katexStyle;
}

/** 同源的一个地址（应用自己的资源、浏览器预览里站点上的图）读成 data: */
async function dataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** 本机的一张图（绝对路径）读成 data:；同一张只读一次 */
function imageReader(): (path: string) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>();
  return (path) => {
    let pending = cache.get(path);
    if (!pending) {
      pending = isTauri
        ? backend()
            .then((api) => api.exportImage(path))
            .catch(() => null)
        : Promise.resolve(null);
      cache.set(path, pending);
    }
    return pending;
  };
}

/** 一次导出里每篇都一样的：读图（同一张只读一次）、双链链到哪 */
interface RenderRun {
  /** 给 PDF 用：收起的 callout 展开 */
  print: boolean;
  read: (path: string) => Promise<string | null>;
  /** 整个文件夹导出时，`[[双链]]` 链到同一批里的那一篇 */
  wikiHref?: (title: string, heading: string | undefined) => string | null;
}

/** 一篇的渲染选项：图片读成 data:，`![[笔记]]` 嵌进来（nested 时不再展开：嵌进来的那一篇里不嵌） */
function exportOptions(relPath: string | null, run: RenderRun, nested: boolean): StaticOptions {
  const { vaultRoot, attachments } = useData.getState();
  const folder = documentFolder(vaultRoot, relPath ?? undefined);
  const root = vaultRoot?.replace(/\\/g, "/").replace(/\/+$/, "") ?? null;
  return {
    image: (source) => {
      const trimmed = source.trim();
      if (/^data:image\//i.test(trimmed) || /^https?:\/\//i.test(trimmed)) return trimmed;
      if (
        /^[a-z][a-z0-9+.-]*:/i.test(trimmed) &&
        !/^file:/i.test(trimmed) &&
        !/^[a-z]:[\\/]/i.test(trimmed)
      ) {
        return null;
      }
      const path = localImagePath(trimmed, folder);
      return path ? run.read(path) : null;
    },
    wikiImage: (name) => {
      const rel = resolveVaultFile(name, relPath, attachments);
      if (!rel) return null;
      // 浏览器预览里没有仓库文件夹：图是站点上的（data/attachments.ts 的 vaultFileSrc）
      if (!isTauri || !root) return dataUrl(vaultFileSrc(null, rel)).catch(() => null);
      return run.read(`${root}/${rel}`);
    },
    embed: nested ? undefined : (target) => embedNote(target, run),
    wikiHref: run.wikiHref,
    math: true,
    diagrams: true,
    highlight: true,
    expandFolds: run.print,
  };
}

/** `![[笔记]]`：按标题找那一篇（和编辑器一样，不分大小写），排好它（或它的一节） */
async function embedNote(target: EmbedTarget, run: RenderRun): Promise<string | null> {
  const { notes, archived, loadBody } = useData.getState();
  const wanted = target.title.trim().toLowerCase();
  const note = [...notes, ...archived].find((item) => item.title.trim().toLowerCase() === wanted);
  if (!note) return null;
  const body = await loadBody(note.id);
  if (body === undefined) return null;
  const shown = target.heading ? sectionOf(body, target.heading) : body;
  if (shown === null) {
    return `<p class="embed-note">「${escapeHtml(note.title)}」里没有「${escapeHtml(target.heading ?? "")}」这一节</p>`;
  }
  return renderStaticHtml(shown, {
    ...exportOptions(note.relPath, run, true),
    idPrefix: `embed-${note.id}-`,
  });
}

/** 正文开头已经是和标题一样的一级标题：页面上不再另放标题 */
function startsWithTitle(markdown: string, title: string): boolean {
  const first = stripFrontMatter(markdown).trimStart().split("\n", 1)[0] ?? "";
  const heading = /^#\s+(.*?)\s*#*\s*$/.exec(first)?.[1];
  return !!heading && heading.trim().toLowerCase() === title.trim().toLowerCase();
}

const shownTitle = (title: string) => title.trim() || "无标题";

/** 一篇：标题（正文开头没有同样的一级标题时）+ 正文 */
async function renderNote(source: ExportSource, run: RenderRun, idPrefix = ""): Promise<string> {
  const body = await renderStaticHtml(source.markdown, {
    ...exportOptions(source.relPath, run, false),
    idPrefix,
  });
  const heading = startsWithTitle(source.markdown, source.title)
    ? ""
    : `<h1 class="odea-title">${escapeHtml(shownTitle(source.title))}</h1>`;
  return heading + body;
}

/**
 * 包成一整页。print：给 PDF 用（按页面设置排纸、不许脚本）；网页里也带着 @page，
 * 在浏览器里打印出来一样。marginTitle 是页眉页脚的 {标题}
 */
async function pageShell(
  title: string,
  main: string,
  print: boolean,
  setup: PageSetup,
  marginTitle = title,
  mainClass = "",
): Promise<string> {
  const { bodySize, measure } = useApp.getState();
  const chars = MEASURES.find((item) => item.id === measure)?.chars ?? null;
  const styles = [TOKENS, layoutCss(bodySize, chars), pageCss(setup, marginTitle), staticCss];
  if (main.includes('class="katex')) styles.push(await katexStylesheet());
  // 打印用的那一页只是拿来印的：不许脚本、不许连外面（网络图片除外）
  const csp = print
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data:">\n`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${csp}<meta name="generator" content="Odea">
<title>${escapeHtml(title)}</title>
<style>
${styles.join("\n")}
</style>
</head>
<body>
<main class="odea-page odea-static${mainClass ? ` ${mainClass}` : ""}">
${main}
</main>
</body>
</html>
`;
}

/** 排成一整页 HTML。print：给 PDF 用（收起的展开、按纸张排、不许脚本） */
export async function buildExportHtml(
  source: ExportSource,
  print: boolean,
  setup: PageSetup = loadPageSetup(),
): Promise<string> {
  const main = await renderNote(source, { print, read: imageReader() });
  return pageShell(shownTitle(source.title), main, print, setup);
}

const say = (notice: string | null) => useData.setState({ notice });

const errorText = (error: unknown) =>
  error && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);

/** 正在写的那个窗格里的那一篇导出（命令面板的「导出为 PDF / HTML」） */
export async function exportFocusedDocument(format: ExportFormat): Promise<void> {
  const doc = focusedDocument();
  if (!doc) {
    say("先打开要导出的那一篇");
    return;
  }
  // 编辑器里的就是最新的（还没存的也算）
  const markdown = liveEditor(doc.key)?.text() ?? doc.bodyMd;
  await exportDocument(format, { title: doc.title, markdown, relPath: doc.relPath ?? null });
}

/** 排好的一整页交给 Rust 写成 PDF；macOS / Linux 弹系统的打印对话框（返回 false） */
async function writePdf(path: string | null, title: string, html: string, setup: PageSetup) {
  const [width, height] = paperSize(setup);
  return (await backend()).exportPdf(path, title, html, width, height);
}

/** 导出一篇：弹「另存为」、排版、写文件，结果走底部的提示条 */
export async function exportDocument(format: ExportFormat, source: ExportSource): Promise<void> {
  try {
    const api = await backend();
    // macOS / Linux 的 PDF 交给系统的打印对话框，那里自己选存到哪
    const pick = format === "html" || IS_WINDOWS;
    const path = pick ? await api.exportPick(source.title, format) : null;
    if (pick && !path) return;
    say(`正在导出「${shownTitle(source.title)}」…`);
    const setup = loadPageSetup();
    const html = await buildExportHtml(source, format === "pdf", setup);
    if (format === "html") {
      await api.exportHtml(path!, html);
    } else if (!(await writePdf(path, source.title, html, setup))) {
      say("在打印对话框里选「存储为 PDF」");
      return;
    }
    say(`已导出：${path}`);
  } catch (error) {
    useData.setState({ notice: null, error: `导出失败：${errorText(error)}` });
  }
}

/* ---------------- 整个文件夹 ---------------- */

export interface FolderEntry {
  note: NoteSummary;
  /** 相对导出的那个文件夹的子文件夹（`周报/十月`），就在它里面的是空串 */
  sub: string;
}

const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });

/**
 * 文件夹里（连同子文件夹）的笔记，按树上的顺序：先是就在这个文件夹里的，再一个个子文件夹；
 * 同一个文件夹里手动排过的（逻辑目录）按手动的顺序，别的按标题。归档的不算
 */
export function folderNotes(folder: string): FolderEntry[] {
  const { notes, folders } = useData.getState();
  const order = new Map(folders.map((path, index) => [path, index]));
  const entries = notes
    .map((note) => ({ note, at: folderOf(note) }))
    .filter(({ at }) => within(at, folder))
    .map(({ note, at }) => ({
      note,
      at,
      sub:
        at === folder
          ? ""
          : folder === ""
            ? at === UNSORTED
              ? folderName(UNSORTED)
              : at
            : at.slice(folder.length + 1),
    }));
  const rank = (at: string) =>
    at === folder
      ? -1
      : at === UNSORTED
        ? Number.MAX_SAFE_INTEGER
        : (order.get(at) ?? folders.length);
  entries.sort((a, b) => {
    const byFolder = rank(a.at) - rank(b.at) || collator.compare(a.at, b.at);
    if (byFolder) return byFolder;
    const ka = manualKey(a.note);
    const kb = manualKey(b.note);
    if (ka !== undefined && kb !== undefined && ka !== kb) return ka < kb ? -1 : 1;
    return collator.compare(a.note.title, b.note.title);
  });
  return entries.map(({ note, sub }) => ({ note, sub }));
}

/** 目录：按子文件夹分组，每篇一个链接 */
function tocHtml(
  title: string,
  entries: FolderEntry[],
  href: (index: number) => string,
  headingTag: "h1" | "none",
): string {
  const groups: string[] = [];
  let current: string | null = null;
  let items: string[] = [];
  const flush = () => {
    if (current === null) return;
    const label = current
      ? `<p class="odea-toc-group">${escapeHtml(current.split("/").join(" / "))}</p>`
      : "";
    groups.push(`${label}<ol>${items.join("")}</ol>`);
    items = [];
  };
  entries.forEach((entry, index) => {
    if (entry.sub !== current) {
      flush();
      current = entry.sub;
    }
    items.push(
      `<li><a href="${escapeHtml(href(index))}">${escapeHtml(shownTitle(entry.note.title))}</a></li>`,
    );
  });
  flush();
  const head = headingTag === "h1" ? `<h1 class="odea-title">${escapeHtml(title)}</h1>` : "";
  const meta = `<p class="odea-toc-meta">${entries.length} 篇 · 导出于 ${today()}</p>`;
  return `<nav class="odea-toc">${head}${meta}${groups.join("")}</nav>`;
}

/** 标题 → 同一批里的第几篇（不分大小写；同名的取第一篇） */
function titleIndex(entries: FolderEntry[]): Map<string, number> {
  const map = new Map<string, number>();
  entries.forEach((entry, index) => {
    const key = entry.note.title.trim().toLowerCase();
    if (!map.has(key)) map.set(key, index);
  });
  return map;
}

/**
 * 每篇在导出的文件夹里的路径（`周报/第 40 周.html`）：子文件夹照树上的，文件名按标题
 * （和存笔记一样的规矩，data/folders.ts 的 fileStemFor），同一个文件夹里重名的加「 (2)」
 */
export function pagePaths(entries: FolderEntry[]): string[] {
  const taken = new Set<string>(["index.html"]);
  return entries.map((entry) => {
    const dirs = entry.sub
      ? entry.sub.split("/").map((part) => cleanFolderName(part) ?? "文件夹")
      : [];
    const stem = fileStemFor(entry.note.title);
    for (let n = 1; ; n += 1) {
      const name = n === 1 ? `${stem}.html` : `${stem} (${n}).html`;
      const path = [...dirs, name].join("/");
      if (taken.has(path.toLowerCase())) continue;
      taken.add(path.toLowerCase());
      return path;
    }
  });
}

/** 从 from 这一页到 to 这一页的相对地址（都是导出文件夹里的路径），每段都编码 */
export function relativeHref(from: string, to: string): string {
  const fromDirs = from.split("/").slice(0, -1);
  const toParts = to.split("/");
  let common = 0;
  while (
    common < fromDirs.length &&
    common < toParts.length - 1 &&
    fromDirs[common] === toParts[common]
  ) {
    common += 1;
  }
  return [
    ...fromDirs.slice(common).map(() => ".."),
    ...toParts.slice(common).map(encodeURIComponent),
  ].join("/");
}

export interface FolderExportOptions {
  /** 文件夹路径（data/folders.ts 的写法，空串是树根） */
  folder: string;
  format: ExportFormat;
  /** PDF：开头放一页目录 */
  toc: boolean;
}

/** 导出整个文件夹：PDF 合成一份，网页是一个文件夹。进度、结果走底部的提示条 */
export async function exportFolder(options: FolderExportOptions): Promise<void> {
  const entries = folderNotes(options.folder);
  const name = folderName(options.folder);
  if (!entries.length) {
    say(`「${folderLabel(options.folder)}」里还没有笔记`);
    return;
  }
  try {
    if (options.format === "pdf") await folderPdf(name, entries, options.toc);
    else await folderSite(name, entries);
  } catch (error) {
    useData.setState({ notice: null, error: `导出失败：${errorText(error)}` });
  }
}

/** 一篇的正文：编辑器里开着的用编辑器里的（还没存的也算） */
async function bodyOf(note: NoteSummary): Promise<string> {
  const live = liveEditor(saveKeyOf(noteRef(note.id)))?.text();
  if (live !== undefined) return live;
  return (await useData.getState().loadBody(note.id)) ?? "";
}

/** 整个文件夹合成一份 PDF：目录一页，每篇另起一页；篇和篇之间的双链跳到那一篇 */
async function folderPdf(name: string, entries: FolderEntry[], toc: boolean): Promise<void> {
  const api = await backend();
  const path = IS_WINDOWS ? await api.exportPick(name, "pdf") : null;
  if (IS_WINDOWS && !path) return;
  const setup = loadPageSetup();
  const index = titleIndex(entries);
  const run: RenderRun = {
    print: true,
    read: imageReader(),
    wikiHref: (title, heading) => {
      const at = index.get(title.trim().toLowerCase());
      if (at === undefined) return null;
      return heading ? `#c${at}-${slug(heading)}` : `#chapter-${at + 1}`;
    },
  };
  const chapters: string[] = [];
  for (const [at, entry] of entries.entries()) {
    say(`正在导出「${name}」：${at + 1} / ${entries.length}`);
    const source = {
      title: entry.note.title,
      markdown: await bodyOf(entry.note),
      relPath: entry.note.relPath,
    };
    const body = await renderNote(source, run, `c${at}-`);
    chapters.push(`<article class="odea-chapter" id="chapter-${at + 1}">${body}</article>`);
  }
  const head = toc ? tocHtml(name, entries, (at) => `#chapter-${at + 1}`, "h1") : "";
  const html = await pageShell(name, head + chapters.join("\n"), true, setup, name, "odea-book");
  say(`正在写「${name}」的 PDF…`);
  if (!(await writePdf(path, name, html, setup))) {
    say("在打印对话框里选「存储为 PDF」");
    return;
  }
  say(`已导出 ${entries.length} 篇：${path}`);
}

/** 整个文件夹导出成网页：每篇一页、子文件夹照树上的，外加 index.html 目录；篇和篇之间的双链能点 */
async function folderSite(name: string, entries: FolderEntry[]): Promise<void> {
  const api = await backend();
  const root = await api.exportFolderPick(name);
  if (!root) return;
  const setup = loadPageSetup();
  const paths = pagePaths(entries);
  const index = titleIndex(entries);
  const read = imageReader();
  try {
    for (const [at, entry] of entries.entries()) {
      say(`正在导出「${name}」：${at + 1} / ${entries.length}`);
      const here = paths[at]!;
      const run: RenderRun = {
        print: false,
        read,
        wikiHref: (title, heading) => {
          const target = index.get(title.trim().toLowerCase());
          if (target === undefined) return null;
          const page = target === at ? "" : relativeHref(here, paths[target]!);
          return heading ? `${page}#${encodeURIComponent(slug(heading))}` : page || "#";
        },
      };
      const source = {
        title: entry.note.title,
        markdown: await bodyOf(entry.note),
        relPath: entry.note.relPath,
      };
      const back = `<p class="odea-back"><a href="${escapeHtml(relativeHref(here, "index.html"))}">‹ ${escapeHtml(name)}</a></p>`;
      const main = back + (await renderNote(source, run));
      await api.exportFolderWrite(
        root,
        here,
        await pageShell(shownTitle(source.title), main, false, setup),
      );
    }
    const toc = tocHtml(name, entries, (at) => relativeHref("index.html", paths[at]!), "h1");
    await api.exportFolderWrite(root, "index.html", await pageShell(name, toc, false, setup));
  } finally {
    await api.exportFolderDone(root).catch(() => {});
  }
  say(`已导出 ${entries.length} 篇：${root}（打开 index.html）`);
}
