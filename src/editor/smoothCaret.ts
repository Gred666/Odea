import type { Extension } from "@codemirror/state";
import { type EditorView, type LayerMarker, RectangleMarker, layer } from "@codemirror/view";

/* ============================================================
   自己画的光标。

   系统光标是 1px、一跳一跳地瞬移，闪烁是硬切的亮 / 灭。这里把原生光标藏掉
   （globals.css 里 caret-color: transparent），在 CodeMirror 的一个图层上画一根
   2px 的圆头竖条：
   - 移动（打字、方向键、点到附近）时滑过去，而不是瞬移；
   - 跳得远（点到隔几段的地方、翻页）时不拖一条长轨迹，就地「落」下来；
   - 闪烁是柔和的呼吸（淡出淡入），每次移动重新从常亮开始 —— 打字时一直是亮的；
   - 高度跟着字号走，从正文移进大标题会平滑地长高。

   只画光标；选区在 selectionLayer.ts。

   位置用 transform（合成器上跑，不触发布局），不用 left / top。
   ============================================================ */

/** 超过这个距离就不滑了，直接落到新位置 */
const JUMP_DISTANCE = 120;

class CaretMarker implements LayerMarker {
  constructor(
    readonly primary: boolean,
    readonly left: number,
    readonly top: number,
    readonly height: number,
  ) {}

  eq(other: LayerMarker): boolean {
    return (
      other instanceof CaretMarker &&
      other.primary === this.primary &&
      other.left === this.left &&
      other.top === this.top &&
      other.height === this.height
    );
  }

  draw(): HTMLElement {
    const dom = document.createElement("div");
    dom.className = this.primary ? "odea-caret" : "odea-caret is-secondary";
    this.place(dom);
    land(dom);
    return dom;
  }

  update(dom: HTMLElement, previous: LayerMarker): boolean {
    if (!(previous instanceof CaretMarker) || previous.primary !== this.primary) return false;
    const far =
      Math.abs(previous.top - this.top) > JUMP_DISTANCE ||
      Math.abs(previous.left - this.left) > JUMP_DISTANCE * 4;
    if (far) {
      // 过渡先关掉、位置落定、强制算一次样式，再把过渡还回去 —— 这一下是瞬移的
      dom.classList.add("is-jumping");
      this.place(dom);
      void dom.offsetWidth;
      dom.classList.remove("is-jumping");
      land(dom);
    } else {
      this.place(dom);
    }
    return true;
  }

  private place(dom: HTMLElement) {
    dom.style.transform = `translate(${this.left}px, ${this.top}px)`;
    dom.style.height = `${this.height}px`;
  }
}

/** 落地动画：换个名字重新触发（同名动画改了也不会重播） */
function land(dom: HTMLElement) {
  dom.style.animationName =
    dom.style.animationName === "odea-caret-land" ? "odea-caret-land-2" : "odea-caret-land";
}

const caretLayer = layer({
  above: true,
  class: "odea-caret-layer",
  markers(view: EditorView) {
    const markers: CaretMarker[] = [];
    const { main, ranges } = view.state.selection;
    for (const range of ranges) {
      // 有选区时和系统一样不画光标，只看选区
      if (!range.empty) continue;
      for (const piece of RectangleMarker.forRange(view, "", range)) {
        markers.push(new CaretMarker(range === main, piece.left, piece.top, piece.height));
      }
    }
    return markers;
  },
  update(update, dom) {
    // 光标动了：闪烁从「常亮」那一段重新开始，打字、移动时不会正好碰上灭的那一下
    if (update.transactions.some((transaction) => transaction.selection)) {
      dom.style.animationName =
        dom.style.animationName === "odea-caret-blink" ? "odea-caret-blink-2" : "odea-caret-blink";
    }
    return update.docChanged || update.selectionSet || update.focusChanged;
  },
});

export const smoothCaret: Extension = caretLayer;
