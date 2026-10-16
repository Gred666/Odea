import type { Extension, SelectionRange } from "@codemirror/state";
import { type EditorView, RectangleMarker, layer } from "@codemirror/view";

/* ============================================================
   自己画的选区。

   以前用的是原生选区：浏览器按每一段文字自己的字号画底色。标题露出来的 `#`、
   正文里的 `**`、链接地址这些标记是 0.78em 的小字，选中时它们底下那块就矮一截、
   还往上错开一点，和旁边正文的底色高低不齐（用户截图「没对齐」）。

   这里按行画：每一行一块，高度取这一行里被选中的文字里最高的那个字框；中间整行
   被选中的部分画成一整块。原生选区在 globals.css 里藏掉。

   图层在文字上面（above）：画在下面的话，代码块、callout、表格源码这些带底色的行
   会把它整个盖住。整层一个透明度、每一块是实心的主色 —— 块和块叠在一起也不会
   叠出更深的一道。
   ============================================================ */

/** 一块属于「一行」还是夹在几行之间的整块：看它的中线落在哪些字框里 */
function within(rect: DOMRect, top: number, bottom: number): boolean {
  const middle = (rect.top + rect.bottom) / 2;
  return middle >= top && middle <= bottom;
}

/** 这一段文档在页面上的各个字框（每一行、每一种字号各一个） */
function fragmentsOf(view: EditorView, from: number, to: number): DOMRect[] {
  if (from >= to) return [];
  try {
    const start = view.domAtPos(from);
    const end = view.domAtPos(to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  } catch {
    return [];
  }
}

function rectsForRange(view: EditorView, range: SelectionRange): readonly RectangleMarker[] {
  const pieces = RectangleMarker.forRange(view, "", range);
  if (!pieces.length) return pieces;

  const { doc } = view.state;
  const from = Math.max(range.from, view.viewport.from);
  const to = Math.min(range.to, view.viewport.to);
  // 只有首尾两行的高度是拿两端的字框量的，要补；中间那一整块本来就是满的
  const first = doc.lineAt(from);
  const last = doc.lineAt(to);
  const fragments = fragmentsOf(view, from, Math.min(to, first.to));
  if (last.number > first.number) fragments.push(...fragmentsOf(view, last.from, to));

  // CodeMirror 量出来的左右边界跟着视口里第一行的 padding 走（引用、callout 的行有左内边距），
  // 换成正文区的两边，整行选中时左右都对齐
  const content = view.contentDOM.getBoundingClientRect();
  const scroller = view.scrollDOM.getBoundingClientRect();
  const baseLeft = scroller.left - view.scrollDOM.scrollLeft * view.scaleX;
  const baseTop = scroller.top - view.scrollDOM.scrollTop * view.scaleY;
  const line = view.contentDOM.querySelector(".cm-line");
  const style = line ? getComputedStyle(line) : null;
  const cmLeft =
    content.left +
    (style
      ? Number.parseInt(style.paddingLeft) + Math.min(0, Number.parseInt(style.textIndent))
      : 0);
  const cmRight = content.right - (style ? Number.parseInt(style.paddingRight) : 0);

  return pieces.map((piece) => {
    let left = piece.left + baseLeft;
    let right = left + (piece.width ?? 0);
    let top = piece.top + baseTop;
    let bottom = top + piece.height;
    if (Math.abs(left - cmLeft) < 0.5) left = content.left;
    if (Math.abs(right - cmRight) < 0.5) right = content.right;
    for (const rect of fragments) {
      if (!within(rect, top, bottom)) continue;
      top = Math.min(top, rect.top);
      bottom = Math.max(bottom, rect.bottom);
    }
    return new RectangleMarker(
      "otw-selection",
      left - baseLeft,
      top - baseTop,
      Math.max(0, right - left),
      bottom - top,
    );
  });
}

export const selectionLayer: Extension = layer({
  above: true,
  class: "otw-selection-layer",
  markers(view) {
    const markers: RectangleMarker[] = [];
    for (const range of view.state.selection.ranges) {
      if (!range.empty) markers.push(...rectsForRange(view, range));
    }
    return markers;
  },
  update: (update) => update.docChanged || update.selectionSet || update.viewportChanged,
});
