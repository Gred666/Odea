import { MOD_KEY, isMac } from "@/lib/platform";
import {
  type AttachmentKind,
  type WikiFile,
  attachmentKind,
  attachmentLabel,
} from "@/lib/wikiFiles";
import { Facet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { VaultFile } from "./html";
import { OtwWidget, jumpToSource, positionOf } from "./widgets";

/* ============================================================
   `![[说明书.pdf]]`、`![[录音.m4a]]`、`![[报表.xlsx]]`：图片以外的附件，单独占一行时画成一张卡片
   （夹在一段字里的照旧是 `!` 加一个双链，Ctrl+点击打开）。认写法、按名字在仓库里找在 lib/wikiFiles.ts。

   卡片上：类型图标、文件名（`|别名` 写了就显示别名）、类型和所在的文件夹，「打开」（系统的默认程序）、
   「在文件夹中显示」。音频、视频（asset 协议放行的那几种）在卡片里直接放；PDF 交给系统的阅读器 ——
   WebView 里内嵌 PDF 各平台不一样（WebView2 能、WKWebView 只画第一页、WebKitGTK 不行）。
   按钮一直显示，不做悬停淡入（docs/PITFALLS/动效.md：少一层合成层）。

   和图片、`![[笔记]]` 一样：替身插在源码前面，光标碰到这一行时源码在卡片下面露出来；点卡片空白处把光标
   放进 `![[` 里，Mod + 点击打开。

   做客的那一篇：文件在主持人那台。「打开」先向主持人要（只给这篇的附件文件夹里的，docs/协同编辑.md §7.2），
   要到了再用系统的程序打开；不显示位置、没有「在文件夹中显示」，音视频不在卡片里放（要先整个要过来）
   ============================================================ */

export interface AttachmentHost {
  /** 写的名字 → 仓库里的哪个文件（相对仓库的路径、asset 地址）。找不到 null；做客时 rel 就是写的名字 */
  resolve(name: string): VaultFile | null;
  /** 用系统的程序打开（reveal：在文件夹中显示）。失败了自己提示 */
  open(name: string, reveal: boolean): void;
  /** 做客的那一篇：文件在主持人那台 */
  remote: boolean;
}

/** DocumentView 按仓库给；没给（浏览器的实验台）就不画卡片，照旧显示源码 */
export const attachmentHost = Facet.define<AttachmentHost | null, AttachmentHost | null>({
  combine: (values) => values[0] ?? null,
});

const ICONS: Record<AttachmentKind, string> = {
  pdf: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8",
  audio: "M9 18V5l12-2v13 M3 18a3 3 0 1 0 6 0a3 3 0 1 0-6 0 M15 16a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
  video:
    "M16 13l5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 10.5 M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6",
};
const OPEN_ICON = "M15 3h6v6 M10 14 21 3 M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6";
const FOLDER_ICON =
  "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z";

function icon(doc: Document, d: string, className: string): SVGSVGElement {
  const node = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("class", className);
  node.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  node.append(path);
  return node;
}

/** `附件/说明书.pdf` → `附件`；在仓库根上的是空串 */
const folderOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const baseName = (name: string) => name.slice(name.replace(/\\/g, "/").lastIndexOf("/") + 1);

export class AttachmentWidget extends OtwWidget {
  constructor(
    private readonly target: WikiFile,
    /** 仓库里的那个文件；null = 找不到 */
    private readonly file: VaultFile | null,
    /** 光标在这一行上：源码在卡片下面露出来 */
    private readonly open: boolean,
    private readonly remote: boolean,
  ) {
    super();
  }

  eq(other: AttachmentWidget) {
    return (
      other.target.name === this.target.name &&
      other.target.label === this.target.label &&
      other.file?.rel === this.file?.rel &&
      other.file?.src === this.file?.src &&
      other.open === this.open &&
      other.remote === this.remote
    );
  }

  private get kind(): AttachmentKind {
    return attachmentKind(this.target.name);
  }

  /** 卡片里放不放音频 / 视频：本机找得到、是能放的那几种 */
  private get playable(): boolean {
    return !this.remote && !!this.file?.src && (this.kind === "audio" || this.kind === "video");
  }

  protected override heightKey() {
    return this.playable ? `attachment:${this.file!.rel}` : null;
  }

  protected override guessHeight() {
    if (!this.playable) return 76;
    return this.kind === "video" ? 360 : 130;
  }

  toDOM(view: EditorView) {
    const doc = view.dom.ownerDocument;
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) => {
      const node = doc.createElement(tag);
      node.className = className;
      return node;
    };
    const { name, label } = this.target;
    const kind = this.kind;
    const missing = this.file === null;

    // 外层管留白（padding，见 widgets.ts 文件头），里层是卡片；和 `![[笔记]]` 的卡片同一套外框
    const frame = element(
      "span",
      `cm-odea-embed-frame cm-odea-file-frame${this.open ? " is-open" : ""}`,
    );
    const card = element("span", `cm-odea-file is-${kind}${missing ? " is-missing" : ""}`);
    const row = element("span", "cm-odea-file-row");
    const tile = element("span", "cm-odea-file-tile");
    tile.append(icon(doc, ICONS[kind], "cm-odea-file-icon"));
    const text = element("span", "cm-odea-file-text");
    const title = element("span", "cm-odea-file-name");
    title.textContent = label || baseName(name);
    const meta = element("span", "cm-odea-file-meta");
    const where = this.file && !this.remote ? folderOf(this.file.rel) : "";
    meta.textContent = missing
      ? `仓库里找不到「${name}」`
      : this.remote
        ? `${attachmentLabel(name)} · 在主持人那边`
        : where
          ? `${attachmentLabel(name)} · ${where}`
          : attachmentLabel(name);
    text.append(title, meta);
    row.append(tile, text);

    const host = () => view.state.facet(attachmentHost);
    if (!missing) {
      const actions = element("span", "cm-odea-file-actions");
      const button = (reveal: boolean) => {
        const node = element("button", `cm-odea-file-button${reveal ? " is-icon" : ""}`);
        node.type = "button";
        if (reveal) {
          node.append(icon(doc, FOLDER_ICON, "cm-odea-file-button-icon"));
          node.setAttribute("aria-label", "在文件夹中显示");
          node.dataset.odeaTip = "";
          node.dataset.odeaTipHint = "在文件夹中显示";
        } else {
          node.append(icon(doc, OPEN_ICON, "cm-odea-file-button-icon"), doc.createTextNode("打开"));
          node.dataset.odeaTip = "";
          node.dataset.odeaTipHint = this.remote
            ? "向主持人要来，用系统的程序打开"
            : "用系统的程序打开";
        }
        // 按下时不抢编辑器的焦点、不挪光标；松开（click）才做
        node.addEventListener("mousedown", (event) => event.preventDefault());
        node.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          host()?.open(name, reveal);
        });
        return node;
      };
      actions.append(button(false));
      if (!this.remote) actions.append(button(true));
      row.append(actions);
    }
    card.append(row);

    if (this.playable) {
      const media = element(kind === "video" ? "video" : "audio", "cm-odea-file-media");
      media.controls = true;
      media.preload = "metadata";
      media.src = this.file!.src;
      // 视频的尺寸要等元数据到了才知道：这一行变高了，叫 CodeMirror 重新量
      media.addEventListener("loadedmetadata", () => {
        if (frame.isConnected) view.requestMeasure();
      });
      const holder = element("span", "cm-odea-file-player");
      holder.append(media);
      card.append(holder);
    }
    frame.append(card);

    const modifier = (event: MouseEvent) => (isMac ? event.metaKey : event.ctrlKey);
    frame.addEventListener("mousedown", (event) => {
      const target = event.target as Element | null;
      if (event.button !== 0 || target?.closest("audio, video, button")) return;
      if (!modifier(event) || missing) return;
      event.preventDefault();
      host()?.open(name, false);
    });
    frame.addEventListener("click", (event) => {
      const target = event.target as Element | null;
      if (event.button !== 0 || modifier(event) || target?.closest("audio, video, button")) return;
      // 光标放进 `![[` 里面：源码露出来，好改
      jumpToSource(view, positionOf(view, frame) + 3);
    });
    if (!missing) {
      row.dataset.odeaTip = "";
      row.dataset.odeaTipHint = `${MOD_KEY}+点击打开`;
    }
    return this.settle(frame);
  }

  override ignoreEvent() {
    return true;
  }
}
