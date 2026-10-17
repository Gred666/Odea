import type { EditorView } from "@codemirror/view";
import type katex from "katex";
import { OtwWidget, positionOf } from "./widgets";

/* ============================================================
   `$…$` / `$$…$$` 的 KaTeX 替身。

   KaTeX 连字体有 300KB 多，只在文档里真的出现公式时才拉；拉到之前替身
   显示原始 TeX（等宽、淡色），拉到后原地渲染再让 CodeMirror 重新量高。

   块级公式不出滚动条。以前是 overflow-x: auto —— 那会顺带把 overflow-y 变成
   auto，而 KaTeX 的积分号、求和上下限总要超出自己的盒子几个像素，于是每个块级
   公式右边都挂着一根竖滑块。现在 overflow 可见（盒子有上下留白，溢出的那几像素
   不会压到别的行）；太宽放不下时整体缩小字号塞进这一行（fitToWidth）。
   ============================================================ */

type Katex = typeof katex;

let loaded: Katex | null = null;
let loading: Promise<Katex> | null = null;

export function loadKatex(): Promise<Katex> {
  loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(
    ([module]) => {
      loaded = module.default;
      return loaded;
    },
  );
  return loading;
}

/**
 * 把 TeX 渲染进节点。KaTeX 的输出是它自己生成的标记（用户原文都经过了转义），
 * 所以可以走 innerHTML —— katex.render 内部也是这么做的，只是多了一个
 * 「不在 quirks 模式」的检查，测试用的 happy-dom 没有 doctype 会被它拦下。
 */
function render(engine: Katex, node: HTMLElement, tex: string, display: boolean): void {
  try {
    node.innerHTML = engine.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
    });
    node.classList.remove("is-loading");
  } catch {
    node.textContent = tex;
    node.classList.add("is-error");
    node.title = "公式无法渲染";
  }
}

/** 缩到这么小还放不下，就不再缩了（再小就看不清），改成可以横向拖（滑块藏起来） */
const MIN_SCALE = 0.65;

/**
 * 公式本来有多宽。KaTeX 的外层是整行宽的块，量不出内容宽度；居中的内容溢出时
 * 两边都出界，scrollWidth 也只算右边那一半。这里取最外层各段（katex-base、编号）
 * 的并集。
 */
function naturalWidth(node: HTMLElement): number {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const part of node.querySelectorAll(".katex-html > *")) {
    const box = part.getBoundingClientRect();
    if (!box.width) continue;
    left = Math.min(left, box.left);
    right = Math.max(right, box.right);
  }
  return right > left ? right - left : 0;
}

/** 块级公式的外层 → 里面的公式节点和它所在的编辑器 */
const fitting = new WeakMap<Element, { node: HTMLElement; view: EditorView }>();

/**
 * 太宽的块级公式整体缩小字号塞进一行，尺寸变了的让编辑器重新量高。
 *
 * 一批一起来：先把它们都恢复原来的字号，再一起量，最后一起写。一个一个来的话
 * 「写字号 → 量宽度」每个公式都要整页强制排版一次 —— 冷启动打开语法全览，十几条
 * 公式在 KaTeX 拉到、ResizeObserver 头一回报尺寸、字体拉到时各来一遍，
 * 4 倍降速下两百多毫秒。
 */
function fitToWidth(blocks: Iterable<Element>) {
  const due: { node: HTMLElement; view: EditorView; before: string }[] = [];
  for (const block of blocks) {
    const target = fitting.get(block);
    if (!target?.node.isConnected) continue;
    due.push({ ...target, before: target.node.style.fontSize });
    target.node.style.fontSize = "";
    target.node.classList.remove("is-overflowing");
  }
  const sizes = due.map(({ node }) => ({ available: node.clientWidth, width: naturalWidth(node) }));
  const changed = new Set<EditorView>();
  due.forEach(({ node, view, before }, index) => {
    const { available, width } = sizes[index]!;
    if (available > 0 && width > available) {
      const scale = Math.max(MIN_SCALE, Math.floor((available / width) * 100) / 100);
      node.style.fontSize = `${scale}em`;
      if (scale === MIN_SCALE) node.classList.add("is-overflowing");
    }
    if (node.style.fontSize !== before) changed.add(view);
  });
  for (const view of changed) view.requestMeasure();
}

/** 攒到这一轮微任务结束再一起缩（KaTeX 拉到时，每个公式各自的回调排在同一轮里） */
const pendingFits = new Set<Element>();
function queueFit(block: Element) {
  if (!pendingFits.size) {
    queueMicrotask(() => {
      const blocks = [...pendingFits];
      pendingFits.clear();
      fitToWidth(blocks);
    });
  }
  pendingFits.add(block);
}

/**
 * 正文列宽变了（窗口缩放、开关目录栏）重新缩一次。所有块级公式共用一个观察者，
 * 一次回调里的一起缩。只看宽度：缩字号会改高度，高度变化再触发一轮就成了死循环。
 */
let resizeObserver: ResizeObserver | null = null;
const observedWidths = new WeakMap<Element, number>();

function observeWidth(block: Element) {
  if (typeof ResizeObserver === "undefined") return;
  resizeObserver ??= new ResizeObserver((entries) => {
    const resized: Element[] = [];
    for (const entry of entries) {
      const width = entry.contentRect.width;
      if (observedWidths.get(entry.target) === width) continue;
      observedWidths.set(entry.target, width);
      resized.push(entry.target);
    }
    fitToWidth(resized);
  });
  resizeObserver.observe(block);
}

/*
 * KaTeX 的字体用到哪款才拉哪款。第一次渲染时量的是后备字体，偏窄，以为放得下；
 * 字体拉到后公式变宽，列宽没变，ResizeObserver 不会响 —— 右边一截就被截掉了
 * （冷启动打开语法全览，那条泰勒展开式截掉 47px）。所以每拉完一批字体，
 * 屏幕上的块级公式都重新缩一次。
 */
if (typeof document !== "undefined" && "fonts" in document) {
  document.fonts.addEventListener("loadingdone", () => {
    fitToWidth(document.querySelectorAll(".cm-odea-math-block"));
  });
}

export class MathWidget extends OtwWidget {
  constructor(
    private readonly tex: string,
    private readonly display: boolean,
  ) {
    super();
  }

  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display;
  }

  protected override heightKey() {
    return this.display ? `math:${this.tex}` : null;
  }

  /** 块级公式：上下留白 17px，单行约 44px，`\\` 每多一行约 36px */
  protected override guessHeight() {
    if (!this.display) return -1;
    const rows = (this.tex.match(/\\\\/g)?.length ?? 0) + 1;
    return 61 + (Math.min(rows, 20) - 1) * 36;
  }

  toDOM(view: EditorView) {
    // 块级公式外面再套一层，留白用 padding（见 widgets.ts 文件头的规矩）
    const node = document.createElement(this.display ? "div" : "span");
    node.className = `cm-odea-math is-${this.display ? "block" : "inline"}`;
    node.title = "点击编辑公式";
    node.addEventListener("mousedown", (event) => {
      event.preventDefault();
      // 光标放到开头的 `$` 后面：块级是整行替身，行内是 `$…$` 本身
      const open = this.display ? 2 : 1;
      view.dispatch({ selection: { anchor: positionOf(view, node) + open } });
      view.focus();
    });

    const block = this.display ? document.createElement("div") : null;
    if (loaded) {
      render(loaded, node, this.tex, this.display);
    } else {
      node.classList.add("is-loading");
      node.textContent = this.tex;
      void loadKatex().then((engine) => {
        if (!node.isConnected) return;
        render(engine, node, this.tex, this.display);
        if (block) queueFit(block);
        view.requestMeasure();
      });
    }

    if (!block) return this.settle(node);
    block.className = "cm-odea-math-block";
    block.append(node);
    fitting.set(block, { node, view });
    observeWidth(block);
    return this.settle(block);
  }

  override destroy(dom: HTMLElement) {
    super.destroy(dom);
    resizeObserver?.unobserve(dom);
  }
}
