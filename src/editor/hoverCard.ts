import { winOf } from "@/lib/paneWindow";
import { TIP, placeBeside, setTip } from "@/lib/tooltip";
import { type EditorView, ViewPlugin } from "@codemirror/view";

/* ============================================================
   正文里的悬停小卡片：脚注预览、缩写全称。

   以前用的是原生 title：要停一秒多才出来、样式是系统的、而且就压在鼠标底下，
   把正在读的那几个字盖住。这里换成一张贴着目标上方弹出的小卡片（上方放不下才
   放到下方），不挡当前这一行。

   用法：给元素挂 data 属性就行，替身的 DOM（toDOM）和装饰的 attributes 都可以。
     data-odea-tip        正文（必填，空串表示只有标签和提示）
     data-odea-tip-label  顶上的小标签，比如「脚注 1」
     data-odea-tip-hint   底下的操作提示，比如「点击跳到定义」

   卡片挂在 document.body 上、position: fixed，完全在 CodeMirror 的 DOM 之外 ——
   不进高度图、不影响点击坐标。

   界面上的悬停提示（lib/tooltip.ts）是「标签」，这里是「读内容」的卡片：长相、320ms 各管各的；
   刚看完一个不用再等、离开留多久、怎么放（翻面、夹在窗口里、对齐物理像素）用那边的，两边行为一致。
   状态机没合：这边是 CodeMirror 的 ViewPlugin，只听正文、目标会被重建（update 里查），
   合成一套要改它的生命周期，收益小（docs/悬停提示.md §9）
   ============================================================ */

/** 读内容的卡片比标签快一点 */
const SHOW_DELAY = 320;
/** 刚从一张卡片移到下一个目标：不用再等 */
const WARM_WINDOW = TIP.warm;
const HIDE_GRACE = TIP.grace;
const GAP = 8;
const EDGE = 12;

const TIP_SELECTOR = "[data-odea-tip]";

class HoverCard {
  private card: HTMLElement | null = null;
  private target: HTMLElement | null = null;
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHidden = 0;

  constructor(private readonly view: EditorView) {
    view.contentDOM.addEventListener("mouseover", this.onOver);
    view.contentDOM.addEventListener("mouseout", this.onOut);
    // 点击、打字、滚动时卡片都该让开
    view.contentDOM.addEventListener("mousedown", this.hideNow, true);
    view.contentDOM.addEventListener("keydown", this.hideNow, true);
    // 编辑器所在的那个窗口（弹出窗口里的编辑器，docs/标签页与分屏.md §16）
    winOf(view.dom).addEventListener("scroll", this.hideNow, true);
    winOf(view.dom).addEventListener("blur", this.hideNow);
  }

  update() {
    // 目标被重建掉了（光标进去展开了源码、别处的改动带来的重建）
    if (this.target && !this.target.isConnected) this.hideNow();
  }

  destroy() {
    this.hideNow();
    this.view.contentDOM.removeEventListener("mouseover", this.onOver);
    this.view.contentDOM.removeEventListener("mouseout", this.onOut);
    this.view.contentDOM.removeEventListener("mousedown", this.hideNow, true);
    this.view.contentDOM.removeEventListener("keydown", this.hideNow, true);
    winOf(this.view.dom).removeEventListener("scroll", this.hideNow, true);
    winOf(this.view.dom).removeEventListener("blur", this.hideNow);
  }

  private onOver = (event: MouseEvent) => {
    const target = (event.target as HTMLElement | null)?.closest?.<HTMLElement>(TIP_SELECTOR);
    if (!target || !this.view.contentDOM.contains(target)) return;
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (target === this.target) return;
    this.clearShow();
    this.target = target;
    const warm = this.card !== null || Date.now() - this.lastHidden < WARM_WINDOW;
    if (warm) this.show(target);
    else this.showTimer = setTimeout(() => this.show(target), SHOW_DELAY);
  };

  private onOut = (event: MouseEvent) => {
    if (!this.target) return;
    const next = event.relatedTarget as Node | null;
    if (next && this.target.contains(next)) return;
    this.clearShow();
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hideNow(), HIDE_GRACE);
  };

  private clearShow() {
    if (this.showTimer) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }
  }

  private show(target: HTMLElement) {
    this.showTimer = null;
    if (!target.isConnected) return;
    const body = target.dataset.odeaTip ?? "";
    const label = target.dataset.odeaTipLabel ?? "";
    const hint = target.dataset.odeaTipHint ?? "";
    if (!body && !label && !hint) return;

    this.card?.remove();
    const doc = this.view.dom.ownerDocument;
    const card = doc.createElement("div");
    card.className = "odea-hovercard";
    card.setAttribute("role", "tooltip");
    if (label) card.append(part("odea-hovercard-label", label));
    if (body) card.append(part("odea-hovercard-body", body));
    if (hint) card.append(part("odea-hovercard-hint", hint));
    doc.body.append(card);
    this.card = card;
    place(card, target);
  }

  private hideNow = () => {
    this.clearShow();
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.target = null;
    const card = this.card;
    if (!card) return;
    this.card = null;
    this.lastHidden = Date.now();
    card.classList.add("is-leaving");
    // 退场动画放完再拿掉；减少动效时动画是 0.01ms，也会立刻触发
    card.addEventListener("animationend", () => card.remove(), { once: true });
    setTimeout(() => card.remove(), 200);
  };
}

/** 缩写的悬停卡片属性：标签是缩写本身，正文是全称。给装饰的 attributes 用。 */
export function abbrTip(abbreviation: string, expansion: string): Record<string, string> {
  return { "data-odea-tip-label": abbreviation.trim(), "data-odea-tip": expansion };
}

/**
 * 用户写的 HTML（HTML 块、HTML 表格的格子、嵌入卡片里的静态渲染）带着原生 title：挂进正文之前换成应用里的提示 ——
 * <abbr> 走这张卡片（和正文里的 <abbr> 一样），别的（双链、附件、图片、随便哪个标签的 title）走 lib/tooltip.ts。
 * 净化器（html.ts）、静态渲染器本身不改：导出的页面、复制出去的 HTML 里没有提示引擎，title 得留着
 */
export function adoptTitles(root: ParentNode): void {
  for (const node of root.querySelectorAll<HTMLElement>("[title]")) {
    const text = node.getAttribute("title") ?? "";
    node.removeAttribute("title");
    if (!text.trim()) continue;
    if (node.localName === "abbr") {
      for (const [name, value] of Object.entries(abbrTip(node.textContent ?? "", text))) {
        node.setAttribute(name, value);
      }
    } else setTip(node, text, { name: false, side: "top" });
  }
}

function part(className: string, text: string): HTMLElement {
  const node = document.createElement("div");
  node.className = className;
  node.textContent = text;
  return node;
}

/** 贴着目标上方居中；上方放不下放下方；左右不出窗口；对齐到物理像素（落在半个像素上，边框和字发虚） */
function place(card: HTMLElement, target: HTMLElement) {
  const view = card.ownerDocument.defaultView ?? window;
  // 目标折行时（长缩写落在行尾）取第一段，卡片对着鼠标最可能在的那一截
  const rect = target.getClientRects()[0] ?? target.getBoundingClientRect();
  const { width, height } = card.getBoundingClientRect();
  const { x, y } = placeBeside(
    rect,
    { width, height },
    "top",
    { width: view.innerWidth, height: view.innerHeight, dpr: view.devicePixelRatio || 1 },
    GAP,
    EDGE,
  );
  card.style.top = `${y}px`;
  card.style.left = `${x}px`;
}

export const hoverCard = ViewPlugin.fromClass(HoverCard);
