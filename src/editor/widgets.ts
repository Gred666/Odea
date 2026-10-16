import { snapToDevicePixels } from "@/lib/devicePixels";
import { type EditorView, WidgetType } from "@codemirror/view";
import {
  type AnimatedEmoji,
  EmojiPlayer,
  animateWhileVisible,
  replay,
  stopAnimating,
  takeIntro,
  wake,
} from "./animatedEmoji";
import { type CalloutHead, type CalloutKind, calloutIcon } from "./callout";
import { glideTo } from "./glide";
import { hasRenderableHtml, safeHref, sanitizeHtml } from "./html";
import { openImageViewer } from "./imageViewer";
import { inlinePlainText } from "./inlineDom";
import { openExternal } from "./links";
import { revealNow } from "./reveal";

/* ============================================================
   编辑器里所有的 DOM 替身。（表格、公式、图表的替身各有自己的文件：
   tableWidget.ts / math.ts / diagram.ts。）

   两条硬规则（都是 CodeMirror 用 getBoundingClientRect 量高度带来的）：
   1. 块级 widget 的留白只能用外层容器的 padding，绝不能用 margin ——
      margin 不在边框盒里，高度图会比真实布局短，点击就会落到错误的行。
   2. widget 内部的动画只能动 transform / opacity / stroke，不能改尺寸。
   ============================================================ */

/** 点一下把光标放回源码位置。所有「点击即编辑」的替身都用它。 */
export function jumpToSource(view: EditorView, position: number) {
  view.dispatch({ selection: { anchor: position }, effects: revealNow() });
  view.focus();
}

/**
 * 块级替身自己在文档里的位置：点击时再问 CodeMirror，而不是构造时存进来。
 *
 * 位置一旦进了 widget 的身份（eq），在它上方打一个字，后面所有替身的位置都变了，
 * 每一个都会被判定为「换了个 widget」而重建 DOM —— 表格重排、图表重新走一遍
 * mermaid、公式重新走一遍 KaTeX，一个字 50ms。大块头一律用这个。
 */
export function positionOf(view: EditorView, dom: HTMLElement): number {
  return view.posAtDOM(dom);
}

/**
 * 所有替身的基类，只多一个开关：这一份 DOM 要不要播入场动画。
 *
 * 替身的 DOM 每创建一次，CSS 里的入场动画（淡入、弹出）就播一次。可「创建」不都是
 * 「新出现」：光标从一个语法里移开，源码换回替身，也是新建一份 DOM —— 以前每次
 * 光标离开，列表圆点、徽章、表格都从透明重新淡入一遍，看着就是闪了一下。
 *
 * 所以由装饰层在把替身放进文档时判断（MarkdownEditor 里的 freshness）：这段源码是
 * 这一下才打出来 / 改动过的，或者整篇刚打开，才播；光标移开、滚进视口、别处的
 * 改动带来的重建，直接以最终状态出现（加 is-settled，CSS 里关掉入场动画）。
 *
 * fresh 不进 eq：同一个替身不会因为这个开关不同就被重建。
 *
 * 另一件事是估高。CodeMirror 只画视口附近的内容，没画过的块级替身一律按「一行」
 * 估高度 —— 一张 mermaid 图 300px、一张表几百 px，都被当成 24px。跳到远处
 * （Ctrl+F、目录）时先按估计的高度滚过去，上面的替身画出来一量，整页往下一沉，
 * 刚找到的地方就被挤出视口。所以块级替身报一个估计值（guessHeight），画过一次的
 * 按内容（heightKey）记住量到的真实高度，下次（切走再切回这篇）直接用。
 */
export abstract class OtwWidget extends WidgetType {
  fresh = true;

  /** 块级替身按内容给一个键，量到的真实高度记在它名下；行内替身不用 */
  protected heightKey(): string | null {
    return null;
  }

  /** 没量过时的估计（px，按编辑器 17px 正文算）；-1 表示不知道，CodeMirror 按一行算 */
  protected guessHeight(): number {
    return -1;
  }

  override get estimatedHeight(): number {
    const key = this.heightKey();
    return (key !== null && measuredHeights.get(key)) || this.guessHeight();
  }

  /** toDOM 返回根节点前过一下：不是新内容就标成 is-settled；块级替身开始记高度 */
  protected settle<T extends Element>(dom: T): T {
    if (!this.fresh) dom.classList.add("is-settled");
    this.trackHeight(dom);
    return dom;
  }

  /** updateDOM 复用旧 DOM 时内容变了，高度也改记到新的键下 */
  protected trackHeight(dom: Element) {
    const key = this.heightKey();
    if (key === null || !heightObserver) return;
    trackedHeights.set(dom, key);
    heightObserver.observe(dom);
  }

  override destroy(dom: HTMLElement) {
    if (!trackedHeights.has(dom)) return;
    heightObserver?.unobserve(dom);
    trackedHeights.delete(dom);
  }
}

/** 量到过的块级替身高度，按内容记；上限 400 条，满了丢最早的 */
const measuredHeights = new Map<string, number>();
const MEASURED_HEIGHT_LIMIT = 400;
const trackedHeights = new WeakMap<Element, string>();
const heightObserver =
  typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver((entries) => {
        for (const entry of entries) {
          const key = trackedHeights.get(entry.target);
          const height =
            entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
          if (!key || !(height > 0)) continue;
          measuredHeights.delete(key);
          if (measuredHeights.size >= MEASURED_HEIGHT_LIMIT) {
            const oldest = measuredHeights.keys().next().value;
            if (oldest !== undefined) measuredHeights.delete(oldest);
          }
          measuredHeights.set(key, height);
        }
      });

function svg(viewBox: string, d: string, className: string): SVGSVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", viewBox);
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "2");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  node.setAttribute("class", className);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("pathLength", "1");
  node.append(path);
  return node;
}

/* ---------------- 任务勾选框 ---------------- */

/*
 * 下面这些小替身的身份（eq）里都不放文档位置，点击时再用 positionOf 问 CodeMirror。
 * 位置进了 eq 的话，在它上方打一个字，后面同屏的每一个替身都会被判定为「换了个
 * widget」而重建 DOM、重放入场动画 —— 在列表第一项里打一个字，下面十几个圆点
 * 一起闪一下。
 */

export class TaskWidget extends OtwWidget {
  /** offset：替身盖住的是整段 `- [ ] `，`[` 离开头几个字符 */
  constructor(
    private readonly checked: boolean,
    private readonly offset = 0,
  ) {
    super();
  }

  eq(other: TaskWidget) {
    return other.checked === this.checked && other.offset === this.offset;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("span");
    box.className = `cm-otw-task${this.checked ? " is-checked" : ""}`;
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.checked));
    // 对勾是一条 SVG 路径：勾上时从左到右描出来（stroke-dashoffset），
    // 比直接冒出一个 ✓ 字符有「动作」感。
    box.append(svg("0 0 16 16", "M3.5 8.5l3 3 6-6.5", "cm-otw-task-check"));
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const from = positionOf(view, box) + this.offset;
      view.dispatch({ changes: { from, to: from + 3, insert: this.checked ? "[ ]" : "[x]" } });
      view.focus();
    });
    return this.settle(box);
  }
}

/* ---------------- 列表符号 ---------------- */

/**
 * 显示什么由调用方算好传进来：有序列表按在列表里的位置自动编号（源码里写
 * `1. 1. 1.` 也显示 1 2 3），无序列表按嵌套深度换 • ◦ ▪。style 是符号格的宽度
 * （光标移上来换回源码时格子一样宽，见 globals.css「列表的几何」）。
 */
export class ListMarkerWidget extends OtwWidget {
  constructor(
    private readonly display: string,
    private readonly style = "",
  ) {
    super();
  }

  eq(other: ListMarkerWidget) {
    return other.display === this.display && other.style === this.style;
  }

  toDOM(view: EditorView) {
    const marker = document.createElement("span");
    marker.className = "cm-otw-list-marker";
    marker.textContent = this.display;
    if (this.style) marker.setAttribute("style", this.style);
    marker.addEventListener("mousedown", (event) => {
      event.preventDefault();
      jumpToSource(view, positionOf(view, marker));
    });
    return this.settle(marker);
  }
}

/* ---------------- 代码块 ---------------- */

export class CodeInfoWidget extends OtwWidget {
  constructor(private readonly language: string) {
    super();
  }

  eq(other: CodeInfoWidget) {
    return other.language === this.language;
  }

  toDOM(view: EditorView) {
    const label = document.createElement("span");
    label.className = "cm-otw-code-info";
    label.textContent = this.language;
    label.addEventListener("mousedown", (event) => {
      event.preventDefault();
      jumpToSource(view, positionOf(view, label));
    });
    return this.settle(label);
  }
}

const COPY_ICON =
  "M8 4H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-2M8 4V3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1M8 4h6a2 2 0 0 1 2 2v6";
const DONE_ICON = "M4 9.5l3.5 3.5L15 5";

/** 折叠掉的围栏行本身的替身：代码块的上下封口，开头那条顺带显示语言名和复制按钮。 */
export class CodeFenceWidget extends OtwWidget {
  constructor(
    private readonly side: "open" | "close",
    private readonly language: string,
    private readonly code: string,
  ) {
    super();
  }

  eq(other: CodeFenceWidget) {
    return other.side === this.side && other.language === this.language && other.code === this.code;
  }

  /** 开头封口 8 + 28，结尾封口 14 + 8（globals.css「围栏的几何」） */
  protected override guessHeight() {
    return this.side === "open" ? 36 : 22;
  }

  toDOM(view: EditorView) {
    // 外层只负责留白（padding，见文件头）。
    const block = document.createElement("div");
    block.className = `cm-otw-fence-block is-${this.side}`;
    const cap = document.createElement("div");
    cap.className = `cm-otw-code-fence is-${this.side}`;
    if (this.side === "open") {
      if (this.language) {
        const label = document.createElement("span");
        label.className = "cm-otw-code-lang";
        label.textContent = this.language;
        cap.append(label);
      }
      cap.append(copyButton(view, () => this.code, "复制代码"));
    }
    block.append(cap);
    return this.settle(block);
  }
}

/** 代码块封口和 CSV 标签栏上的「复制」按钮。复制成功后对勾描出来，1.4 秒后复原。 */
export function copyButton(view: EditorView, text: () => string, what: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-otw-code-copy";
  button.setAttribute("aria-label", what);
  button.title = what;
  const icon = svg("0 0 20 20", COPY_ICON, "cm-otw-code-copy-icon");
  const label = document.createElement("span");
  label.textContent = "复制";
  button.append(icon, label);

  let timer: ReturnType<typeof setTimeout> | null = null;
  // mousedown 要拦掉：否则点按钮的同时光标会被 CodeMirror 放进代码块，
  // 块一激活封口就消失了，按钮在手指底下不见。
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => {
    void copyText(text(), view).then((copied) => {
      if (!copied) return;
      button.classList.add("is-done");
      icon.firstElementChild?.setAttribute("d", DONE_ICON);
      label.textContent = "已复制";
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        button.classList.remove("is-done");
        icon.firstElementChild?.setAttribute("d", COPY_ICON);
        label.textContent = "复制";
      }, 1400);
    });
  });
  return button;
}

/**
 * 写剪贴板。异步 API 在没有权限的宿主里会直接 reject（WebView 偶尔也会），
 * 退回老式的 execCommand；两条路都不通就安静地放弃，别在控制台甩未处理的拒绝。
 */
async function copyText(text: string, view: EditorView): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 走下面的退路 */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    // 临时文本域抢走了焦点，还回编辑器
    view.focus();
    return copied;
  } catch {
    return false;
  }
}

/* ---------------- 分隔线 ---------------- */

/** 每次构建装饰都新建一个（fresh 是逐个设的），所有分隔线彼此相等。 */
export class HorizontalRuleWidget extends OtwWidget {
  eq() {
    return true;
  }

  /** 1px 线 + 上下各 0.9em */
  protected override guessHeight() {
    return 32;
  }

  toDOM() {
    const rule = document.createElement("div");
    rule.className = "cm-otw-hr";
    return this.settle(rule);
  }
}

/* ---------------- 图片 ---------------- */

export interface ImageSpec {
  alt: string;
  source: string;
  title: string;
  /** Obsidian 式 `![alt|300]` / `![alt|300x200]` */
  width: number | null;
  height: number | null;
}

/** 图片在源码里怎么写的：改尺寸时按它写回去 */
export type ImageSyntax = "markdown" | "html";

/** 拖着改宽度时最窄到这么多 */
const IMAGE_MIN_WIDTH = 48;
/** 比这小的图不放悬停按钮（会盖住大半张图），右下角的拖柄照样有 */
const IMAGE_TOOLS_MIN = { width: 128, height: 72 };

const ZOOM_ICON = "M3 11a8 8 0 1 0 16 0a8 8 0 1 0-16 0M21 21l-4.35-4.35M11 8v6M8 11h6";
const SOURCE_ICON = "M18 16l4-4-4-4M6 8l-4 4 4 4M14.5 4l-5 16";

/** 正文里每一张图的 DOM 现在对应哪个替身（updateDOM 换了替身，事件里要用新的） */
const liveImages = new WeakMap<HTMLElement, ImageWidget>();

/**
 * `![alt|宽](地址)` 换成新的宽度（null 是去掉尺寸，回到原图大小）；HTML 的 `<img>` 改 width
 * 属性。高度一律去掉，按原图比例走。认不出来就返回 null
 */
export function resizedImageSource(
  raw: string,
  syntax: ImageSyntax,
  width: number | null,
): string | null {
  if (syntax === "markdown") {
    const head = /^!\[([^\]]*)\]/.exec(raw);
    if (!head) return null;
    const alt = head[1]!.replace(/\|\d+(?:x\d+)?$/, "");
    return `![${width ? `${alt}|${width}` : alt}]${raw.slice(head[0].length)}`;
  }
  const attribute = (name: string) =>
    new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i");
  const tag = raw.replace(attribute("height"), "");
  if (!width) return tag.replace(attribute("width"), "");
  if (attribute("width").test(tag)) return tag.replace(attribute("width"), ` width="${width}"`);
  return tag.replace(/\s*(\/?>)$/, ` width="${width}"$1`);
}

/**
 * 图片。一直画着：光标碰到它时源码在图片下面露出来一行（open），图片本身一动不动 ——
 * 以前是整张图换成一行源码，几百 px 高的图一下缩成一行字，下面整篇往上一跳。
 *
 * 点图片本身：光标放到源码末尾，接着就能改。悬停时右上角两个按钮，查看大图、编辑源码
 * （开着时再点是收起）；右下角的拖柄拖一下改宽度，松手写回 `![alt|宽](…)`，双击拖柄
 * 回到原图大小。都是普通的编辑，撤销一下就回去。
 *
 * 身份里有源码原文（raw）和 open：光标进出、改了宽度时 eq 不相等，CodeMirror 拿
 * updateDOM 就地改 —— 同一个 <img> 一直用着，不会重新加载、闪一下。位置不进身份，
 * 点的时候再问（positionOf），拿 raw 核对一遍
 */
export class ImageWidget extends OtwWidget {
  constructor(
    private readonly image: ImageSpec,
    private readonly raw = "",
    private readonly syntax: ImageSyntax = "markdown",
    private readonly open = false,
  ) {
    super();
  }

  eq(other: ImageWidget) {
    const a = this.image;
    const b = other.image;
    return (
      a.alt === b.alt &&
      a.source === b.source &&
      a.title === b.title &&
      a.width === b.width &&
      a.height === b.height &&
      other.raw === this.raw &&
      other.syntax === this.syntax &&
      other.open === this.open
    );
  }

  toDOM(view: EditorView) {
    // 外层管留白（padding，见文件头），里层贴着图片的边，按钮和拖柄按它定位
    const frame = document.createElement("span");
    frame.className = "cm-otw-image-frame";
    const box = document.createElement("span");
    box.className = "cm-otw-image-box";
    const image = document.createElement("img");
    image.className = "cm-otw-image";
    image.loading = "lazy";
    image.decoding = "async";
    image.draggable = false;
    // 加载完再淡入。直接出现的话大图会「啪」地把下面的正文顶下去。
    // 图到了这一行就变高了：告诉 CodeMirror 重新量。它自己只在上次更新 75ms 以后才理会
    // 尺寸变化，刚粘贴的截图几十毫秒就加载完 —— 光标、选区还按图片没高度时画，停在图片中间
    const settle = (state: "is-loaded" | "is-error") => {
      image.classList.add(state);
      measureTools(frame, image);
      if (image.isConnected) view.requestMeasure();
    };
    image.addEventListener("load", () => settle("is-loaded"));
    image.addEventListener("error", () => settle("is-error"));

    const tools = document.createElement("span");
    tools.className = "cm-otw-image-tools";
    const zoom = imageTool(ZOOM_ICON, "查看大图", () => openImageViewer(image));
    const source = imageTool(SOURCE_ICON, "编辑源码", () =>
      liveImages.get(frame)?.toggleSource(view, frame),
    );
    source.classList.add("is-source");
    tools.append(zoom, source);

    const handle = document.createElement("span");
    handle.className = "cm-otw-image-handle";
    handle.title = "拖动改大小，双击还原";
    handle.addEventListener("pointerdown", (event) => startResize(view, frame, image, event));
    handle.addEventListener("dblclick", (event) => {
      event.preventDefault();
      liveImages.get(frame)?.resize(view, frame, null);
    });

    image.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      liveImages.get(frame)?.openSource(view, frame);
    });
    image.addEventListener("dblclick", () => openImageViewer(image));

    // 悬停按钮、拖柄淡入淡出前先对齐到整物理像素（lib/devicePixels.ts），不然淡完会闪一下
    const snapControls = () => {
      snapToDevicePixels(tools);
      snapToDevicePixels(handle);
    };
    box.addEventListener("pointerenter", snapControls);
    box.addEventListener("pointerleave", snapControls);

    box.append(image, tools, handle);
    frame.append(box);
    liveImages.set(frame, this);
    this.paint(frame, image);
    if (image.complete && image.naturalWidth > 0) settle("is-loaded");
    return this.settle(frame);
  }

  override updateDOM(dom: HTMLElement): boolean {
    const image = dom.querySelector<HTMLImageElement>("img.cm-otw-image");
    if (!dom.classList.contains("cm-otw-image-frame") || !image) return false;
    liveImages.set(dom, this);
    this.paint(dom, image);
    return true;
  }

  /** 把这一份的内容写到 DOM 上（新建和 updateDOM 共用） */
  private paint(frame: HTMLElement, image: HTMLImageElement) {
    const { alt, title, width, height, source } = this.image;
    frame.classList.toggle("is-open", this.open);
    frame.querySelector(".cm-otw-image-tool.is-source")?.classList.toggle("is-active", this.open);
    image.alt = alt;
    image.title = title;
    image.style.width = width ? `${width}px` : "";
    image.style.height = height ? `${height}px` : "";
    image.classList.toggle("has-size", !!width);
    // 地址真的变了才换：同一个 src 再赋一遍，有的 WebView 会重新走一遍加载
    if (image.getAttribute("src") !== source) {
      image.classList.remove("is-loaded", "is-error");
      image.src = source;
    }
  }

  /** 这张图的源码在文档里的位置；文档对不上（刚改过、还没重画）就是 null */
  private rangeIn(view: EditorView, frame: HTMLElement) {
    const from = positionOf(view, frame);
    const to = from + this.raw.length;
    return this.raw && view.state.sliceDoc(from, to) === this.raw ? { from, to } : null;
  }

  openSource(view: EditorView, frame: HTMLElement) {
    const range = this.rangeIn(view, frame);
    if (range) jumpToSource(view, range.to);
  }

  /** 编辑源码按钮：没开就打开；开着就收起 —— 离开正文，光标还留在原处 */
  toggleSource(view: EditorView, frame: HTMLElement) {
    if (this.open && view.hasFocus) view.contentDOM.blur();
    else this.openSource(view, frame);
  }

  /** 宽度写回源码（null：去掉尺寸）。只换变了的那一截，后面的光标不会被挤走 */
  resize(view: EditorView, frame: HTMLElement, width: number | null) {
    const range = this.rangeIn(view, frame);
    const next = range && resizedImageSource(this.raw, this.syntax, width);
    if (!range || !next || next === this.raw) return;
    const raw = this.raw;
    let start = 0;
    while (start < raw.length && start < next.length && raw[start] === next[start]) start += 1;
    let end = 0;
    while (
      end < raw.length - start &&
      end < next.length - start &&
      raw[raw.length - 1 - end] === next[next.length - 1 - end]
    ) {
      end += 1;
    }
    view.dispatch({
      changes: {
        from: range.from + start,
        to: range.to - end,
        insert: next.slice(start, next.length - end),
      },
      userEvent: "input.resize",
    });
  }

  /** 图片里的按下、拖动都自己管，CodeMirror 别拿去放光标、拖选 */
  override ignoreEvent() {
    return true;
  }
}

/** 悬停按钮。mousedown 拦掉：不然焦点会被抢走、光标被放到别处 */
function imageTool(icon: string, label: string, run: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-otw-image-tool";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(svg("0 0 24 24", icon, "cm-otw-image-tool-icon"));
  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    run();
  });
  return button;
}

/** 太小的图不放悬停按钮（见 IMAGE_TOOLS_MIN） */
function measureTools(frame: HTMLElement, image: HTMLImageElement) {
  const { width, height } = image.getBoundingClientRect();
  frame.classList.toggle(
    "is-tiny",
    width > 0 && (width < IMAGE_TOOLS_MIN.width || height < IMAGE_TOOLS_MIN.height),
  );
}

/**
 * 拖右下角改宽度：按原图比例，拖的时候图片跟着手实时变，角上显示「宽 × 高」；
 * 松手才写回源码（一次编辑，一次撤销）。拖的时候每帧让 CodeMirror 重新量一次高度，
 * 下面的正文跟着走，光标、选区不会画歪
 */
function startResize(
  view: EditorView,
  frame: HTMLElement,
  image: HTMLImageElement,
  event: PointerEvent,
) {
  if (event.button !== 0) return;
  // pointerdown 拦掉，后面就不会再有兼容的 mousedown —— CodeMirror 不会趁机拖选
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget as HTMLElement;
  const rect = image.getBoundingClientRect();
  const startX = event.clientX;
  const startWidth = Math.round(rect.width);
  const ratio = image.naturalWidth
    ? image.naturalHeight / image.naturalWidth
    : rect.height / rect.width;
  const line = frame.closest(".cm-line") ?? view.contentDOM;
  const limit = Math.max(IMAGE_MIN_WIDTH, Math.floor(line.getBoundingClientRect().width));
  const badge = document.createElement("span");
  badge.className = "cm-otw-image-size";
  let width = startWidth;
  let frameRequest = 0;

  const show = () => {
    badge.textContent = `${width} × ${Math.round(width * ratio)}`;
  };
  const move = (moveEvent: PointerEvent) => {
    const next = Math.round(startWidth + moveEvent.clientX - startX);
    width = Math.min(limit, Math.max(IMAGE_MIN_WIDTH, next));
    image.style.width = `${width}px`;
    image.style.height = "";
    image.classList.add("has-size");
    show();
    if (!frameRequest) {
      frameRequest = requestAnimationFrame(() => {
        frameRequest = 0;
        view.requestMeasure();
      });
    }
  };
  const finish = (commit: boolean) => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", cancel);
    if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    cancelAnimationFrame(frameRequest);
    badge.remove();
    frame.classList.remove("is-resizing");
    const widget = liveImages.get(frame);
    if (commit && width !== startWidth) widget?.resize(view, frame, width);
    // 没改（或者文档对不上、没写成）：按源码里的尺寸画回去
    const now = liveImages.get(frame);
    if (now === widget) now?.updateDOM(frame);
    measureTools(frame, image);
    view.requestMeasure();
  };
  const up = () => finish(true);
  const cancel = () => finish(false);

  handle.setPointerCapture?.(event.pointerId);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", cancel);
  frame.classList.add("is-resizing");
  show();
  image.parentElement?.append(badge);
  snapToDevicePixels(badge);
}

/* ---------------- 行内小替身：Emoji / 实体 / 硬换行 ---------------- */

/** `:smile:` → 😄 / `&mdash;` → — / `---` → —。点一下光标回到源码，可以继续改。 */
export class GlyphWidget extends OtwWidget {
  constructor(
    private readonly kind: "emoji" | "entity" | "smart",
    private readonly glyph: string,
    private readonly source: string,
  ) {
    super();
  }

  eq(other: GlyphWidget) {
    return other.kind === this.kind && other.glyph === this.glyph && other.source === this.source;
  }

  toDOM(view: EditorView) {
    const node = document.createElement("span");
    node.className = `cm-otw-glyph is-${this.kind}`;
    node.textContent = this.glyph;
    node.title = this.source;
    node.addEventListener("mousedown", (event) => {
      event.preventDefault();
      // 短码、实体把光标放进 `:` / `&` 后面，源码才会展开；智能标点放在它前面就行
      const inside = this.kind === "smart" ? 0 : 1;
      jumpToSource(view, positionOf(view, node) + inside);
    });
    return this.settle(node);
  }
}

/* ---------------- 动态表情 ---------------- */

const emojiPlayers = new WeakMap<HTMLElement, EmojiPlayer>();

/** 某个动态表情替身上的播放器（测试、调试用）。 */
export function emojiPlayerOf(dom: HTMLElement): EmojiPlayer | undefined {
  return emojiPlayers.get(dom);
}

/**
 * `:otw_fire:` 的替身。
 *
 * 和普通 Emoji 不同，它表现得像一个字符：光标停在它旁边时不展开源码
 * （否则刚插进去看到的就是一串短码），退格整个删掉，方向键一步跨过。
 * 露出视口时一直循环，滚出去停回静止帧（见 animateWhileVisible）。
 * 单击：光标落到点中的那一侧，动作从头再来；双击：展开源码可以改。
 *
 * eq 只比短码、不比位置：在它上面打字时 CodeMirror 复用 DOM，
 * 动画不会从头再来，播放器也不用重建。位置点击时再问（positionOf）。
 */
export class AnimatedEmojiWidget extends OtwWidget {
  constructor(
    readonly emoji: AnimatedEmoji,
    /** 源码原文（大小写可能和标准短码不同）；它的长度决定单击后光标落在哪 */
    readonly source: string,
  ) {
    super();
  }

  eq(other: AnimatedEmojiWidget) {
    return other.emoji === this.emoji && other.source === this.source;
  }

  toDOM(view: EditorView) {
    const node = document.createElement("span");
    node.className = "otw-ae cm-otw-ae";
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", this.emoji.name);
    node.title = `${this.emoji.name}  ${this.emoji.shortcode}\n双击编辑`;
    node.dataset.emoji = this.emoji.id;

    const player = new EmojiPlayer(this.emoji);
    emojiPlayers.set(node, player);
    player.mount(node);

    // 看得见就一直动；刚从选择器插进来的先整个弹出来
    animateWhileVisible(node, player, { intro: takeIntro(this.emoji) });

    // 同屏太多、还在排队的，鼠标移上去就先动起来
    node.addEventListener("pointerenter", () => wake(node));
    node.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const from = positionOf(view, node);
      if (event.detail >= 2) {
        // 双击：光标放进短码里，源码展开
        view.dispatch({ selection: { anchor: from + 1 } });
      } else {
        const box = node.getBoundingClientRect();
        const after = event.clientX >= box.left + box.width / 2;
        view.dispatch({ selection: { anchor: after ? from + this.source.length : from } });
        replay(node);
      }
      view.focus();
    });
    return this.settle(node);
  }

  destroy(dom: HTMLElement) {
    stopAnimating(dom);
    emojiPlayers.delete(dom);
  }
}

/** 硬换行（行尾两个空格或反斜杠）：留一个极淡的 ↵，否则谁也看不出这里有东西。 */
export class HardBreakWidget extends OtwWidget {
  eq() {
    return true;
  }

  toDOM(view: EditorView) {
    const node = document.createElement("span");
    node.className = "cm-otw-hard-break";
    node.textContent = "↵";
    node.title = "硬换行";
    node.addEventListener("mousedown", (event) => {
      event.preventDefault();
      jumpToSource(view, positionOf(view, node));
    });
    return this.settle(node);
  }
}

/* ---------------- Callout 标签 ---------------- */

const CHEVRON = "M6 9l6 6 6-6";

/** 把 `[!标签]-` 的折叠符在 `-` / `+` 之间翻转。状态就存在源码里，不用另外记。 */
export function toggleCalloutFold(view: EditorView, foldPosition: number): void {
  const current = view.state.sliceDoc(foldPosition, foldPosition + 1);
  if (current !== "-" && current !== "+") return;
  view.dispatch({
    changes: { from: foldPosition, to: foldPosition + 1, insert: current === "-" ? "+" : "-" },
  });
}

/**
 * `[!标签]` 的徽章。替身盖住的是 `[!标签]`（可折叠时连同后面的 `-` / `+`），
 * 所以折叠符离替身开头的距离是固定的，存距离、不存位置。
 */
export class CalloutBadgeWidget extends OtwWidget {
  constructor(
    private readonly head: Pick<CalloutHead, "label" | "kind" | "fold">,
    /** 折叠符离替身开头几个字符；不可折叠时是 null */
    private readonly foldOffset: number | null,
  ) {
    super();
  }

  eq(other: CalloutBadgeWidget) {
    return (
      other.head.label === this.head.label &&
      other.head.kind === this.head.kind &&
      other.head.fold === this.head.fold &&
      other.foldOffset === this.foldOffset
    );
  }

  toDOM(view: EditorView) {
    const badge = document.createElement("span");
    badge.className = `cm-otw-callout-badge is-${this.head.kind}`;
    const text = document.createElement("span");
    text.textContent = this.head.label;
    badge.append(calloutIcon(this.head.kind), text);
    const foldOffset = this.foldOffset;
    if (this.head.fold && foldOffset !== null) {
      badge.classList.add(this.head.fold === "-" ? "is-collapsed" : "is-expanded");
      badge.title = this.head.fold === "-" ? "展开" : "收起";
      badge.append(svg("0 0 24 24", CHEVRON, "cm-otw-callout-chevron"));
    }
    badge.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const from = positionOf(view, badge);
      if (this.head.fold && foldOffset !== null) toggleCalloutFold(view, from + foldOffset);
      // 光标放到 `[!` 后面，标签露出来可以改
      else jumpToSource(view, from + 2);
    });
    return this.settle(badge);
  }
}

/**
 * 收起的 callout 正文的替身：一行「… 展开 N 行」。它盖住的是标签行下面的正文，
 * 折叠符在上一行（标签行）的固定列上，存列号、不存位置。
 */
export class CalloutFoldWidget extends OtwWidget {
  constructor(
    private readonly lineCount: number,
    private readonly kind: CalloutKind,
    /** 折叠符在标签行里的列 */
    private readonly foldColumn: number,
  ) {
    super();
  }

  eq(other: CalloutFoldWidget) {
    return (
      other.lineCount === this.lineCount &&
      other.kind === this.kind &&
      other.foldColumn === this.foldColumn
    );
  }

  toDOM(view: EditorView) {
    const block = document.createElement("div");
    block.className = `cm-otw-callout-fold is-${this.kind}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-otw-callout-fold-button";
    button.textContent = `… 展开 ${this.lineCount} 行`;
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const head = view.state.doc.lineAt(Math.max(0, positionOf(view, block) - 1));
      toggleCalloutFold(view, head.from + this.foldColumn);
    });
    block.append(button);
    return this.settle(block);
  }
}

/* ---------------- 脚注 ---------------- */

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `[^id]: …` 定义行的起点；没有定义返回 null。 */
export function footnoteDefinitionAt(view: EditorView, id: string): number | null {
  const pattern = new RegExp(`^\\[\\^${escapeRegExp(id)}\\]:`, "m");
  const match = pattern.exec(view.state.doc.toString());
  return match ? match.index : null;
}

/** 正文里第一处 `[^id]` 引用（不算定义行）的起点；没有返回 null。 */
export function footnoteReferenceAt(view: EditorView, id: string): number | null {
  const pattern = new RegExp(`\\[\\^${escapeRegExp(id)}\\](?!:)`);
  const match = pattern.exec(view.state.doc.toString());
  return match ? match.index : null;
}

/**
 * 脚注徽章。引用端悬停能看到脚注内容，点一下跳到定义；定义端点一下跳回第一处引用。
 * 要改脚注本身，点徽章旁边的文字就行。
 */
export class FootnoteWidget extends OtwWidget {
  constructor(
    private readonly id: string,
    private readonly role: "ref" | "def",
    private readonly preview = "",
  ) {
    super();
  }

  eq(other: FootnoteWidget) {
    return other.id === this.id && other.role === this.role && other.preview === this.preview;
  }

  toDOM(view: EditorView) {
    const node = document.createElement(this.role === "ref" ? "sup" : "span");
    node.className = `cm-otw-footnote is-${this.role}`;
    node.textContent = this.id;
    // 悬停卡片（hoverCard.ts），不用原生 title：那个就压在鼠标底下，把正在读的字盖住
    node.dataset.otwTipLabel = `脚注 ${this.id}`;
    if (this.role === "ref") {
      node.dataset.otwTip = this.preview || "还没有写这条脚注的内容";
      node.dataset.otwTipHint = this.preview ? "点击跳到脚注" : "点击编辑";
    } else {
      node.dataset.otwTip = "";
      node.dataset.otwTipHint = "点击回到正文引用处";
    }
    node.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const target =
        this.role === "ref"
          ? footnoteDefinitionAt(view, this.id)
          : footnoteReferenceAt(view, this.id);
      if (target === null) {
        // 另一端不存在：光标放进 `[^` 后面，露出源码
        jumpToSource(view, positionOf(view, node) + 2);
        return;
      }
      view.dispatch({ selection: { anchor: target } });
      view.focus();
      glideTo(view, target, { y: "center", nearest: true });
    });
    return this.settle(node);
  }
}

/* ---------------- [TOC] ---------------- */

export interface TocEntry {
  level: number;
  text: string;
  from: number;
}

/** 按层级 + 文字找标题所在行的起点；找不到返回 null。 */
function findHeading(view: EditorView, level: number, text: string): number | null {
  const pattern = new RegExp(`^\\s{0,3}#{${level}}\\s+`);
  for (let number = 1; number <= view.state.doc.lines; number += 1) {
    const line = view.state.doc.line(number);
    if (!pattern.test(line.text)) continue;
    const plain = inlinePlainText(
      line.text
        .replace(pattern, "")
        .replace(/\s+#+\s*$/, "")
        .trim(),
    );
    if (plain === text) return line.from;
  }
  return null;
}

export class TocWidget extends OtwWidget {
  private readonly key: string;

  constructor(private readonly entries: TocEntry[]) {
    super();
    // 身份只看层级和文字：位置会随上方的编辑漂移，不能进 eq
    this.key = entries.map((entry) => `${entry.level}:${entry.text}`).join("\n");
  }

  eq(other: TocWidget) {
    return other.key === this.key;
  }

  protected override heightKey() {
    return `toc:${this.key}`;
  }

  /** 留白、边框、「目录」小标题约 66px，每条 31px */
  protected override guessHeight() {
    return 66 + Math.max(1, this.entries.length) * 31;
  }

  toDOM(view: EditorView) {
    const block = document.createElement("div");
    block.className = "cm-otw-toc-block";
    const nav = document.createElement("nav");
    nav.className = "cm-otw-toc";
    nav.setAttribute("aria-label", "目录");
    nav.title = "点击空白处编辑";
    nav.addEventListener("mousedown", (event) => {
      event.preventDefault();
      if ((event.target as HTMLElement).closest("button")) return;
      jumpToSource(view, positionOf(view, block));
    });

    const title = document.createElement("div");
    title.className = "cm-otw-toc-title";
    title.textContent = "目录";
    nav.append(title);

    if (this.entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cm-otw-toc-empty";
      empty.textContent = "还没有标题";
      nav.append(empty);
    } else {
      const list = document.createElement("ol");
      list.className = "cm-otw-toc-list";
      // 最浅的标题顶格，其余按层级缩进 —— 全文只有 H2/H3 时不该空出 H1 那一档。
      const base = Math.min(...this.entries.map((entry) => entry.level));
      for (const entry of this.entries) {
        const item = document.createElement("li");
        item.className = "cm-otw-toc-item";
        item.style.setProperty("--depth", String(entry.level - base));
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = entry.text;
        button.addEventListener("click", () => {
          // 条目里存的位置可能已经过时（上方编辑过），按文字重新找一遍
          const target = findHeading(view, entry.level, entry.text) ?? entry.from;
          view.dispatch({ selection: { anchor: target } });
          view.focus();
          glideTo(view, target, { y: "start", margin: 72 });
        });
        item.append(button);
        list.append(item);
      }
      nav.append(list);
    }
    block.append(nav);
    return this.settle(block);
  }
}

/* ---------------- Front matter ---------------- */

/** 折叠掉的 `---` 行的替身：给属性块封上下两个口。 */
export class FrontMatterFenceWidget extends OtwWidget {
  constructor(private readonly side: "open" | "close") {
    super();
  }

  eq(other: FrontMatterFenceWidget) {
    return other.side === this.side;
  }

  /** 开头封口 26，结尾封口 14 + 14 留白 */
  protected override guessHeight() {
    return this.side === "open" ? 26 : 28;
  }

  toDOM(view: EditorView) {
    const block = document.createElement("div");
    block.className = `cm-otw-frontmatter-block is-${this.side}`;
    const cap = document.createElement("div");
    cap.className = `cm-otw-frontmatter-fence is-${this.side}`;
    if (this.side === "open") {
      const label = document.createElement("span");
      label.className = "cm-otw-frontmatter-label";
      label.textContent = "属性";
      cap.append(label);
    }
    cap.addEventListener("mousedown", (event) => {
      event.preventDefault();
      // 两个口都把光标放到第一个键的行首：属性块永远从文档第一行开始，那一行就是第二行
      jumpToSource(view, view.state.doc.line(Math.min(2, view.state.doc.lines)).from);
    });
    block.append(cap);
    return this.settle(block);
  }
}

/* ---------------- HTML ---------------- */

/** `<br>`：真的换一行，前面留一个极淡的 ↵ 提示这里有东西。 */
export class LineBreakWidget extends OtwWidget {
  eq() {
    return true;
  }

  toDOM(view: EditorView) {
    const node = document.createElement("span");
    node.className = "cm-otw-br";
    const hint = document.createElement("span");
    hint.className = "cm-otw-hard-break";
    hint.textContent = "↵";
    hint.title = "<br>";
    hint.addEventListener("mousedown", (event) => {
      event.preventDefault();
      jumpToSource(view, positionOf(view, node));
    });
    node.append(hint, document.createElement("br"));
    return this.settle(node);
  }
}

/** HTML 注释：藏成一个小小的「注释」标记，点一下展开源码。 */
export class CommentWidget extends OtwWidget {
  constructor(private readonly block: boolean) {
    super();
  }

  eq(other: CommentWidget) {
    return other.block === this.block;
  }

  toDOM(view: EditorView) {
    const pill = document.createElement("span");
    pill.className = "cm-otw-comment";
    pill.textContent = "注释";
    pill.title = "HTML 注释 · 点击查看";
    const root = this.block ? document.createElement("div") : pill;
    pill.addEventListener("mousedown", (event) => {
      event.preventDefault();
      jumpToSource(view, positionOf(view, root));
    });
    if (!this.block) return this.settle(pill);
    root.className = "cm-otw-comment-block";
    root.append(pill);
    return this.settle(root);
  }
}

/**
 * 块级 HTML 的替身：源码经白名单净化后重建成真实节点。
 * 点空白处回到源码编辑；<details> 的开合和 <a> 的点击照常工作。
 */
export class HtmlBlockWidget extends OtwWidget {
  constructor(private readonly source: string) {
    super();
  }

  eq(other: HtmlBlockWidget) {
    return other.source === this.source;
  }

  protected override heightKey() {
    return `html:${this.source}`;
  }

  /** 没量过：大致按源码行数算，一行 24px */
  protected override guessHeight() {
    return 12 + this.source.split("\n").length * 24;
  }

  toDOM(view: EditorView) {
    const block = document.createElement("div");
    block.className = "cm-otw-html-widget-block";
    const host = document.createElement("div");
    host.className = "cm-otw-html-widget";
    host.title = "点击空白处编辑 HTML";
    if (hasRenderableHtml(this.source)) host.append(sanitizeHtml(this.source));
    else host.textContent = this.source;
    host.addEventListener("mousedown", (event) => {
      const target = event.target as HTMLElement;
      const link = target.closest("a");
      if (link) {
        event.preventDefault();
        const href = safeHref(link.getAttribute("href") ?? undefined);
        if (href) void openExternal(href);
        return;
      }
      // <details> 的开合交给浏览器；别一点就把整块切回源码
      if (target.closest("summary")) return;
      event.preventDefault();
      jumpToSource(view, positionOf(view, block));
    });
    // 里面的 <img> 加载完、<details> 展开收起，这一块的高度都变了，让 CodeMirror 重新量
    // （见 ImageWidget）。load / toggle 不冒泡，在捕获阶段接
    const remeasure = () => {
      if (block.isConnected) view.requestMeasure();
    };
    for (const type of ["load", "error", "toggle"]) host.addEventListener(type, remeasure, true);
    block.append(host);
    return this.settle(block);
  }
}
