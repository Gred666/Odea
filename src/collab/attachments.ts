import type { Attachment } from "@/data/types";
import type { ImageResolver } from "@/editor/html";
import type { FetchedAttachment } from "./net";

/* ============================================================
   协作里的附件（docs/协同编辑.md §7.2）：只给这篇正文里引用了的、落在仓库「附件」里的文件。

   - 主持人：正文一变，把正文里相对路径的图片算成仓库里的路径交给 Rust（setAttachmentRefs）。
     访客来要的不在这里面就不给 —— 不然写个 `../../` 就能读到主持人硬盘上的任意文件。
     Rust 那边再查一遍「规范化之后落在附件/ 里」
   - 访客：正文里相对路径的图片向主持人要，缓存在本机，编辑器按 GuestImages 给的解析器显示。
     还没要到的先是空的（图片显示占位），要到了换一个新的解析器，编辑器重画那几张图。
     正文里的本机绝对路径（C:\…\a.png）是主持人电脑上的，不显示；网络图片访客自己加载
   - 访客「存一份到我的笔记」（§3）：缓存里的图片存进自己的「附件」，正文里的路径换成新的
     （copyImages）。还没要到的留着原来的路径
   ============================================================ */

/** `![alt](src "title")`：和编辑器认图片的写法一样（MarkdownEditor 的 resolveImage） */
const INLINE_IMAGE = /!\[[^\]]*\]\((\S+?)(?:\s+["'][^"']*["'])?\)/g;
/** 引用式的定义：`[label]: <src>` / `[label]: src` */
const DEFINITION = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(?:<([^>\n]+)>|(\S+))/gm;
/** `<img src="…">` */
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** 带协议的（http:、data:、asset:、file:……）、锚点、本机绝对路径：不是相对路径 */
const NOT_RELATIVE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|#|\/|\\)/;

export function isRelativeRef(source: string): boolean {
  const trimmed = source.trim();
  return !!trimmed && !NOT_RELATIVE.test(trimmed);
}

/** 正文里相对路径的图片地址（写的样子，去重、按出现顺序） */
export function imageRefs(markdown: string): string[] {
  const found: string[] = [];
  const add = (source: string | undefined) => {
    const trimmed = source?.trim();
    if (trimmed && isRelativeRef(trimmed) && !found.includes(trimmed)) found.push(trimmed);
  };
  for (const match of markdown.matchAll(INLINE_IMAGE)) add(match[1]);
  for (const match of markdown.matchAll(DEFINITION)) add(match[1] ?? match[2]);
  for (const match of markdown.matchAll(HTML_IMAGE)) add(match[1] ?? match[2] ?? match[3]);
  return found;
}

/**
 * 把正文里这些图片的地址换掉（只换图片语法里地址那一段，alt、标题里一样的字不动）。
 * 认法和 imageRefs 一样：行内、引用式的定义、<img src>
 */
export function rewriteImageRefs(markdown: string, links: ReadonlyMap<string, string>): string {
  if (!links.size) return markdown;
  const edits: { from: number; to: number; insert: string }[] = [];
  const collect = (pattern: RegExp) => {
    const indexed = new RegExp(pattern.source, `${pattern.flags}d`);
    for (const match of markdown.matchAll(indexed)) {
      const group = match.indices?.slice(1).findIndex((range) => range !== undefined) ?? -1;
      if (group < 0) continue;
      const [from, to] = match.indices![group + 1]!;
      const raw = markdown.slice(from, to);
      const link = links.get(raw.trim());
      if (link === undefined) continue;
      // 地址两头的空白（`<img src=" a.png ">`）留着，只换中间
      const start = from + (raw.length - raw.trimStart().length);
      edits.push({ from: start, to: start + raw.trim().length, insert: link });
    }
  };
  collect(INLINE_IMAGE);
  collect(DEFINITION);
  collect(HTML_IMAGE);
  edits.sort((a, b) => b.from - a.from);
  let out = markdown;
  for (const edit of edits) out = out.slice(0, edit.from) + edit.insert + out.slice(edit.to);
  return out;
}

/** 正文里写的文件名（最后一段，解开 %xx）：浏览器预览里按名字存的时候用 */
function fileNameOf(ref: string): string {
  return decode(ref.trim()).split(/[\\/]/).pop() || "图片.png";
}

/** data: 地址里的内容，转成 base64（浏览器预览里要来的图片是 data: 地址） */
export function dataUrlBase64(url: string): string | null {
  const match = /^data:[^,]*?(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  if (match[1]) return match[2]!;
  const bytes = new TextEncoder().encode(decodeURIComponent(match[2]!));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface CopyTarget {
  /** 按本机的文件存（桌面端：缓存里的那个，文件名是正文里写的那个） */
  attachPath(file: string): Promise<Attachment>;
  /** 按内容存（浏览器预览） */
  attachData(name: string, dataBase64: string): Promise<Attachment>;
}

/**
 * 「存一份到我的笔记」：正文里要到了的图片存进自己的「附件」，返回换好路径的正文；
 * 没要到的（还在要、要不到、存不进去）数一下，路径原样留着
 */
export async function copyImages(
  markdown: string,
  fetched: (ref: string) => FetchedAttachment | undefined,
  target: CopyTarget,
): Promise<{ markdown: string; missing: number }> {
  const links = new Map<string, string>();
  let missing = 0;
  for (const ref of imageRefs(markdown)) {
    const got = fetched(ref);
    try {
      if (got?.file) links.set(ref, (await target.attachPath(got.file)).link);
      else {
        const data = got ? dataUrlBase64(got.url) : null;
        if (data === null) missing += 1;
        else links.set(ref, (await target.attachData(fileNameOf(ref), data)).link);
      }
    } catch {
      missing += 1;
    }
  }
  return { markdown: rewriteImageRefs(markdown, links), missing };
}

function decode(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/**
 * 笔记在仓库里的路径（`笔记/工作/周会.md`）+ 正文里写的相对路径（`../../附件/a.png`）→
 * 仓库里的路径（`附件/a.png`）。退到仓库外面去了就是 null
 */
export function vaultPathOf(noteRelPath: string, source: string): string | null {
  const parts = noteRelPath.replace(/\\/g, "/").split("/").slice(0, -1).filter(Boolean);
  for (const part of decode(source.trim()).replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

/* ---------------- 访客：要图片、缓存、给编辑器的解析器 ---------------- */

/** 要不到的过一会儿再试一次（主持人那边的引用表可能比正文晚一步） */
const RETRY_MS = 1500;
const MAX_TRIES = 3;

export class GuestImages {
  private readonly urls = new Map<string, FetchedAttachment>();
  private readonly pending = new Set<string>();
  private readonly tries = new Map<string, number>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private destroyed = false;
  private current: ImageResolver;

  constructor(
    private readonly fetch: (path: string) => Promise<FetchedAttachment>,
    private readonly onChange: (resolver: ImageResolver) => void,
  ) {
    this.current = this.makeResolver();
  }

  get resolver(): ImageResolver {
    return this.current;
  }

  /** 这张已经要到了的话：缓存在哪（「存一份到我的笔记」用） */
  fetched(ref: string): FetchedAttachment | undefined {
    return this.urls.get(ref.trim());
  }

  /** 连上了（第一次、或者断了又连上）：之前没要到的重新算次数 */
  retryFailed(): void {
    for (const ref of [...this.tries.keys()]) {
      if (!this.urls.has(ref) && !this.pending.has(ref)) this.tries.delete(ref);
    }
  }

  /** 正文变了：新出现的相对路径图片去要 */
  scan(markdown: string): void {
    for (const ref of imageRefs(markdown)) this.request(ref);
  }

  private request(ref: string) {
    if (this.destroyed || this.urls.has(ref) || this.pending.has(ref)) return;
    const tries = this.tries.get(ref) ?? 0;
    if (tries >= MAX_TRIES) return;
    this.tries.set(ref, tries + 1);
    this.pending.add(ref);
    this.fetch(ref).then(
      (got) => {
        this.pending.delete(ref);
        if (this.destroyed) return;
        this.urls.set(ref, got);
        this.current = this.makeResolver();
        this.onChange(this.current);
      },
      () => {
        this.pending.delete(ref);
        if (this.destroyed || tries + 1 >= MAX_TRIES) return;
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          this.request(ref);
        }, RETRY_MS);
        this.timers.add(timer);
      },
    );
  }

  /** 每次要到新图片换一个新的（编辑器按引用比较，换了才重画） */
  private makeResolver(): ImageResolver {
    const urls = new Map(this.urls);
    return {
      resolve: (source) => {
        const trimmed = source.trim();
        if (/^(?:https?:|data:image\/)/i.test(trimmed)) return trimmed;
        // 主持人电脑上的绝对路径、还没要到的：先空着（显示占位）
        return isRelativeRef(trimmed) ? (urls.get(trimmed)?.url ?? "") : "";
      },
    };
  }

  destroy(): void {
    this.destroyed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
