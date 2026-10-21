import { snapToDevicePixels } from "@/lib/devicePixels";
import { EditorSelection, type Extension, StateEffect, StateField } from "@codemirror/state";
import { type EditorView, type LayerMarker, RectangleMarker, layer } from "@codemirror/view";

/* ============================================================
   远端光标：别人的光标、选区和名字标签（docs/协同编辑.md §4.3「远端光标」）。

   画在 CodeMirror 的图层里，和自己的光标（smoothCaret.ts）、选区（selectionLayer.ts）一样。
   - 位置变了直接落位，不做位移过渡（CLAUDE.md 动效规矩第 1 条）：别人打字时光标是一跳一跳的，
     滑过去反而像在追
   - 名字标签只淡 opacity，一直待在自己的图层上（will-change），每次开始淡之前对齐到整物理
     像素（规矩第 3 条）；底色是这个人自己颜色的实色，不用毛玻璃（第 4 条）
   - 标签在对方动了以后亮一会儿就熄，光标留着；15 秒没消息（对方断了）整个淡出
   - 不参与藏标记：reveal 只认本地光标，别人的光标一动你这边排版就跳，是最糟的体验

   位置由 binding.ts 从 Loro 的 Cursor 换算好放进来；之后正文每改一次在这里映射，
   不用每个按键再派发一次。
   ============================================================ */

export interface RemoteCaret {
  id: string;
  name: string;
  /** 色板下标 */
  color: number;
  anchor: number;
  head: number;
  /** 名字标签亮着 */
  labeled: boolean;
  /** 超时了，正在淡出 */
  leaving: boolean;
}

export const setRemoteCarets = StateEffect.define<readonly RemoteCaret[]>();

export const remoteCarets = StateField.define<readonly RemoteCaret[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setRemoteCarets)) return effect.value;
    }
    if (!transaction.docChanged || !value.length) return value;
    // 贴着后面那个字：对方在自己光标处打字时，光标跟着跑到新字后面（和 Loro 的 Cursor 一致）
    return value.map((caret) => ({
      ...caret,
      anchor: transaction.changes.mapPos(caret.anchor, 1),
      head: transaction.changes.mapPos(caret.head, 1),
    }));
  },
});

const peerClass = (color: number) => `odea-peer-${color}`;

const remoteSelectionLayer = layer({
  above: true,
  class: "odea-remote-selection-layer",
  markers(view) {
    const markers: RectangleMarker[] = [];
    for (const caret of view.state.field(remoteCarets)) {
      if (caret.anchor === caret.head) continue;
      const range = EditorSelection.range(caret.anchor, caret.head);
      markers.push(
        ...RectangleMarker.forRange(
          view,
          `odea-remote-selection ${peerClass(caret.color)}${caret.leaving ? " is-leaving" : ""}`,
          range,
        ),
      );
    }
    return markers;
  },
  update: (update) =>
    update.docChanged ||
    update.viewportChanged ||
    update.geometryChanged ||
    update.startState.field(remoteCarets) !== update.state.field(remoteCarets),
});

class RemoteCaretMarker implements LayerMarker {
  constructor(
    readonly caret: RemoteCaret,
    readonly left: number,
    readonly top: number,
    readonly height: number,
    /** 光标在最上面一行：标签放到光标下面，不然被切掉 */
    readonly below: boolean,
  ) {}

  eq(other: LayerMarker): boolean {
    return (
      other instanceof RemoteCaretMarker &&
      other.caret.id === this.caret.id &&
      other.caret.name === this.caret.name &&
      other.caret.color === this.caret.color &&
      other.caret.labeled === this.caret.labeled &&
      other.caret.leaving === this.caret.leaving &&
      other.left === this.left &&
      other.top === this.top &&
      other.height === this.height &&
      other.below === this.below
    );
  }

  draw(): HTMLElement {
    const dom = document.createElement("div");
    const label = document.createElement("div");
    label.className = "odea-remote-label";
    dom.append(label);
    this.paint(dom, null);
    return dom;
  }

  update(dom: HTMLElement, previous: LayerMarker): boolean {
    // 按下标复用 DOM：换了人就重画，免得一个人的淡入淡出接到另一个人身上
    if (!(previous instanceof RemoteCaretMarker) || previous.caret.id !== this.caret.id) {
      return false;
    }
    this.paint(dom, previous);
    return true;
  }

  private paint(dom: HTMLElement, previous: RemoteCaretMarker | null) {
    const { caret } = this;
    const label = dom.firstElementChild as HTMLElement;
    dom.className = `odea-remote-caret ${peerClass(caret.color)}`;
    dom.classList.toggle("is-below", this.below);
    // 直接落位：不过渡
    dom.style.left = `${this.left}px`;
    dom.style.top = `${this.top}px`;
    dom.style.height = `${this.height}px`;
    if (label.textContent !== caret.name) label.textContent = caret.name;

    const shown = caret.labeled && !caret.leaving;
    const wasShown = !!previous && previous.caret.labeled && !previous.caret.leaving;
    const wasLeaving = !!previous?.caret.leaving;
    if (!previous) {
      // 新出现的：先以「没亮」画上去，下一帧再亮，才有淡入
      dom.classList.add("is-entering");
      requestAnimationFrame(() => {
        if (!dom.isConnected) return;
        snap(dom, label);
        dom.classList.remove("is-entering");
        label.classList.toggle("is-shown", shown);
      });
      return;
    }
    if (dom.classList.contains("is-entering")) return;
    if (shown !== wasShown || caret.leaving !== wasLeaving) snap(dom, label);
    label.classList.toggle("is-shown", shown);
    dom.classList.toggle("is-leaving", caret.leaving);
  }
}

/** 开始淡之前对齐到整物理像素：层里画出来才不糊，淡完那一帧也不跳（CLAUDE.md「动效：先对齐再动」） */
function snap(dom: HTMLElement, label: HTMLElement) {
  snapToDevicePixels(dom);
  snapToDevicePixels(label);
}

const remoteCaretLayer = layer({
  above: true,
  class: "odea-remote-caret-layer",
  markers(view: EditorView) {
    const markers: RemoteCaretMarker[] = [];
    const carets = [...view.state.field(remoteCarets)].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const caret of carets) {
      if (caret.head < view.viewport.from || caret.head > view.viewport.to) continue;
      const [piece] = RectangleMarker.forRange(view, "", EditorSelection.cursor(caret.head));
      if (!piece) continue;
      markers.push(
        new RemoteCaretMarker(caret, piece.left, piece.top, piece.height, piece.top < 20),
      );
    }
    return markers;
  },
  update: (update) =>
    update.docChanged ||
    update.viewportChanged ||
    update.geometryChanged ||
    update.startState.field(remoteCarets) !== update.state.field(remoteCarets),
});

export const remoteCursorLayers: Extension = [remoteCarets, remoteSelectionLayer, remoteCaretLayer];
