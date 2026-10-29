import { winOf } from "@/lib/paneWindow";
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
   ============================================================ */

const SHOW_DELAY = 320;
/** 刚从一张卡片移到下一个目标：不用再等 */
const WARM_WINDOW = 400;
const HIDE_GRACE = 80;
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

function part(className: string, text: string): HTMLElement {
  const node = document.createElement("div");
  node.className = className;
  node.textContent = text;
  return node;
}

/** 贴着目标上方居中；上方放不下放下方；左右不出窗口。 */
function place(card: HTMLElement, target: HTMLElement) {
  const view = card.ownerDocument.defaultView ?? window;
  // 目标折行时（长缩写落在行尾）取第一段，卡片对着鼠标最可能在的那一截
  const rect = target.getClientRects()[0] ?? target.getBoundingClientRect();
  const { width, height } = card.getBoundingClientRect();
  const above = rect.top - GAP - height >= EDGE;
  const top = above ? rect.top - GAP - height : rect.bottom + GAP;
  const center = rect.left + rect.width / 2;
  const left = Math.min(
    Math.max(EDGE, center - width / 2),
    Math.max(EDGE, view.innerWidth - EDGE - width),
  );
  // 对齐到物理像素：落在半个像素上，边框和字会被抗锯齿成两行，发虚
  const dpr = view.devicePixelRatio || 1;
  card.style.top = `${Math.round(top * dpr) / dpr}px`;
  card.style.left = `${Math.round(left * dpr) / dpr}px`;
}

export const hoverCard = ViewPlugin.fromClass(HoverCard);
