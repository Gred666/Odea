import { EditorView } from "@codemirror/view";

/* ============================================================
   程序化跳转时平滑地「滑」过去：Ctrl+F 找到的匹配、右侧目录树、正文里的 [TOC]、
   脚注在引用和定义之间来回跳，都走这里。

   以前是一下子瞬移过去。可目标附近的内容还没画过 —— CodeMirror 只画视口附近，
   没画过的表格、图表、公式、长段落都是估计的高度 —— 先按估计值跳过去，画出来一量，
   整页一沉，刚找到的地方就被挤走了。

   滑动的每一帧都重新量一次目标现在在哪（画过的用真实坐标，没画过的用 CodeMirror 的
   高度图），按缓动曲线把「剩下的距离」走掉该走的那一部分。路上内容被画出来、变高了，
   终点跟着挪，曲线照样平滑收尾；滑到之后再补几帧，把最后那一轮测量带来的偏差对齐。

   用户自己动手（滚轮、触摸、在别处点击或按键）立刻停下，不跟他抢。
   减少动效时不滑，交给 CodeMirror 一步到位。
   ============================================================ */

export interface GlideOptions {
  /** start：停在可视区顶部往下 margin 的地方；center：停在可视区正中 */
  y: "start" | "center";
  margin?: number;
  /** 可视区的上下边（窗口坐标）；默认是滚动容器露在窗口里的那一段 */
  band?: () => { top: number; bottom: number };
  /** 目标已经在可视区里（离上下边都留着余量）就不滚 */
  nearest?: boolean;
  /** 到了：目标最后停在窗口坐标的哪个高度；减少动效时不知道，给 null */
  onArrive?: (y: number | null) => void;
  /** 在这个元素里的点击、按键不算用户接手（比如查找面板：接着打字会发起新的一次滑动） */
  keep?: Element | null;
}

/** 真正在滚的那个祖先（文档视图的 data-doc-scroller）；都不滚就是窗口（null） */
export function scrollParent(view: EditorView): HTMLElement | null {
  for (let node = view.dom.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

const reducedMotion = (doc: Document) =>
  doc.documentElement.dataset.reduceMotion === "true" ||
  (doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

/** 短距离一出手就到（先快后慢）；长距离起步和收尾都柔一点 */
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** 滑多久：随距离变长，但有上下限 —— 太快看不出是滑的，太慢像卡住 */
const durationFor = (distance: number) => 220 + Math.min(430, Math.sqrt(distance) * 5);

/** 滑完之后最多再补几帧对齐（最后一次滚动引起的重新测量） */
const SETTLE_FRAMES = 8;

const active = new WeakMap<EditorView, Glide>();

/** 滑到文档位置 pos。同一个编辑器上一次还没滑完的，直接换成这一次。 */
export function glideTo(view: EditorView, pos: number, options: GlideOptions): void {
  active.get(view)?.cancel();
  const glide = new Glide(view, pos, options);
  active.set(view, glide);
  glide.start();
}

export function cancelGlide(view: EditorView): void {
  active.get(view)?.cancel();
}

/** 这个编辑器正在滑（目录树跟随滚动时，滑的路上不算读到了哪，见 Outline.tsx） */
export function isGliding(view: EditorView): boolean {
  return active.has(view);
}

class Glide {
  private readonly scroller: HTMLElement | null;
  private readonly win: Window;
  private frame = 0;
  private startTime: number | null = null;
  private duration = 0;
  private progress = 0;
  private ease = easeOut;
  private settleLeft = SETTLE_FRAMES;
  private stable = 0;
  private done = false;

  constructor(
    private readonly view: EditorView,
    private readonly pos: number,
    private readonly options: GlideOptions,
  ) {
    this.scroller = scrollParent(view);
    this.win = view.dom.ownerDocument.defaultView ?? window;
  }

  start() {
    const doc = this.view.dom.ownerDocument;
    if (reducedMotion(doc) || typeof this.win.requestAnimationFrame !== "function") {
      this.finish();
      this.view.dispatch({
        effects: EditorView.scrollIntoView(this.pos, {
          y: this.options.y === "start" ? "start" : "center",
          yMargin: this.options.margin ?? 5,
        }),
      });
      this.options.onArrive?.(null);
      return;
    }
    const where = this.measure();
    if (!where) return this.finish();
    const remaining = where.top - where.desired;
    if (this.options.nearest && this.inBand(where)) {
      this.finish();
      this.options.onArrive?.(where.top);
      return;
    }
    const distance = Math.abs(remaining);
    this.duration = durationFor(distance);
    this.ease = distance > where.band.bottom - where.band.top ? easeInOut : easeOut;
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      this.win.addEventListener(type, this.interrupt, { capture: true, passive: true });
    }
    this.frame = this.win.requestAnimationFrame(this.step);
  }

  cancel() {
    this.finish();
  }

  private finish() {
    if (this.done) return;
    this.done = true;
    if (this.frame) this.win.cancelAnimationFrame(this.frame);
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      this.win.removeEventListener(type, this.interrupt, { capture: true });
    }
    if (active.get(this.view) === this) active.delete(this.view);
  }

  private readonly interrupt = (event: Event) => {
    const keep = this.options.keep;
    if (
      (event.type === "pointerdown" || event.type === "keydown") &&
      keep?.contains(event.target as Node)
    ) {
      return;
    }
    this.finish();
  };

  private readonly step = (now: number) => {
    this.frame = 0;
    if (this.done) return;
    if (!this.view.dom.isConnected) return this.finish();
    this.startTime ??= now;
    const t = Math.min(1, (now - this.startTime) / this.duration);
    const where = this.measure();
    if (t < 1) {
      const eased = this.ease(t);
      if (where) {
        const remaining = where.top - where.desired;
        // 按曲线，这一帧该走掉「剩下的」里面的多少
        this.scrollBy((remaining * (eased - this.progress)) / (1 - this.progress));
      }
      this.progress = eased;
      this.frame = this.win.requestAnimationFrame(this.step);
      return;
    }
    // 到了：把剩下的一点补齐；之后几帧里要是又被挤开（刚露出来的内容量出了真实高度）接着补，
    // 连续两帧不动了才算停稳
    const drift = where ? where.top - where.desired : 0;
    if (Math.abs(drift) >= 1) {
      this.scrollBy(drift);
      this.stable = 0;
    } else {
      this.stable += 1;
    }
    this.settleLeft -= 1;
    if (this.stable >= 2 || this.settleLeft <= 0) {
      this.finish();
      this.options.onArrive?.(where ? where.desired : null);
      return;
    }
    this.frame = this.win.requestAnimationFrame(this.step);
  };

  private scrollBy(delta: number) {
    if (!delta) return;
    if (this.scroller) this.scroller.scrollTop += delta;
    else this.win.scrollBy(0, delta);
  }

  private band(): { top: number; bottom: number } {
    if (this.options.band) return this.options.band();
    const height = this.win.innerHeight;
    const box = this.scroller?.getBoundingClientRect();
    return {
      top: Math.max(box?.top ?? 0, 0),
      bottom: Math.min(box?.bottom ?? height, height),
    };
  }

  private inBand(where: { top: number; height: number; band: { top: number; bottom: number } }) {
    return where.top >= where.band.top + 8 && where.top + where.height <= where.band.bottom - 8;
  }

  /** 目标现在在窗口坐标的哪个高度，以及该停在哪 */
  private measure() {
    const { view, pos, options } = this;
    let top: number;
    let height = 24;
    const rect = view.coordsAtPos(pos, 1);
    if (rect) {
      top = rect.top;
      height = rect.bottom - rect.top;
    } else {
      // 还没画出来：用 CodeMirror 的高度图（估计值会随着画出来越来越准）
      const block = view.lineBlockAt(Math.min(pos, view.state.doc.length));
      top = view.documentTop + block.top;
    }
    const band = this.band();
    const desired =
      options.y === "start"
        ? band.top + (options.margin ?? 0)
        : (band.top + band.bottom) / 2 - height / 2;
    return { top, height, desired, band };
  }
}
