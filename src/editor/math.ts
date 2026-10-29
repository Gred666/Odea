import type { EditorView } from "@codemirror/view";
import type katex from "katex";
import { OtwWidget, positionOf } from "./widgets";

/* ============================================================
   `$…$` / `$$…$$` 的 KaTeX 替身。

   KaTeX 连字体有 300KB 多，只在文档里真的出现公式时才拉；拉到之前替身
   显示原始 TeX（等宽、淡色），拉到后原地渲染再让 CodeMirror 重新量高。

   块级公式平时 overflow 可见（盒子有上下留白，积分号、上下限溢出的那几像素不会压到
   别的行）。以前是 overflow-x: auto —— 那会顺带把 overflow-y 变成 auto，每个块级
   公式右边都挂着一根竖滑块。

   太宽的块级公式（fitToWidth）：
   1. 只宽一点（缩到 92% 就放得下）：整体缩一点，看不出来，免得为一小截单独折一行
   2. 再宽：原字号，在顶层的关系符、运算符（= < + − × …）后面折行，第一行顶格、续行
      缩进 2em —— 像 MathJax 4 的 displayOverflow: linebreak。以前是一路缩到 65%，
      上下标只剩 8px，看不清（2026-10-29 用户反馈）。KaTeX 本来就在这些地方切好了段
      （.katex-base），只差把括号里的几段粘起来（prepareBreaks）
   3. 折开以后还有一段比一行宽（大矩阵、aligned、长 \text、没有运算符的一长串）：这一段
      缩到 90% 能放下就缩，不能就原字号横向滑动，底下一根细滑块
   不加竖滑块：正文本身在上下滚，里面再套一个上下滚的块，滚轮会卡在里面。
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
    if (display) prepareBreaks(node);
  } catch {
    node.textContent = tex;
    node.classList.add("is-error");
    node.title = "公式无法渲染";
  }
}

/** 缩到这么多就放得下：整体缩一点，不折行（看不出来缩了） */
const SHRINK_FLOOR = 0.92;
/** 折开以后最宽的那一段：缩到这么多能放下就缩，不能就横向滑动 */
const PIECE_FLOOR = 0.9;
/** 折行时续行缩进多少（em，公式自己的字号） */
const HANG_EM = 2;
/** 编号和折行的公式之间留多少（em） */
const TAG_GAP_EM = 1;

/** 普通括号、竖线：KaTeX 不把它们当一组，里面的运算符后面照样切段 */
const OPENERS = "([{⟨⌊⌈";
const CLOSERS = ")]}⟩⌋⌉";
const FENCES = "|‖";
const GLUE = "cm-odea-math-glue";
const ROW = "cm-odea-math-row";

/**
 * 给折行做准备，KaTeX 渲染完就做（只动块级公式的 .katex-html，不折行时排出来和原来一样）：
 *
 * - 分行：手写的 `\\` 把公式分成几行（KaTeX 在中间放一个空的块 .katex-newline）。每一行
 *   包进一个块（ROW），折行时各自第一行顶格、各自的续行缩进。不包的话缩进只认整个公式的
 *   第一行，`\\` 后面那行也被缩进去，看着像上一行的续行。编号放进最后一行：不折行时它是
 *   绝对定位、top 跟着它本来排在哪儿，放在块外面就掉到公式下面去了；折行时它跟在最后一行
 *   里、和那一行共用基线（绝对定位的话按整条公式的高度对齐，最后一行矮的时候掉到基线下面）
 * - 粘括号：KaTeX 在顶层的关系符、运算符后面切段，但 (x − x₀)、|x − y| 里的减号后面也切 ——
 *   折行时会把一对括号拆到两行。括号没配平的几段粘成一段（GLUE，white-space: nowrap），
 *   段和段之间才能断。竖线只在括号外面算（P(A|B)、{x | x>0} 里的竖线不是一对）。
 *   数错了（\text 里只有半个括号）的后果只是这一行后面粘成一大段、少几个能断的地方
 */
export function prepareBreaks(node: HTMLElement): void {
  const html = node.querySelector(".katex-display .katex-html");
  if (!html) return;
  let row: HTMLElement | null = null;
  let glue: HTMLElement | null = null;
  let depth = 0;
  let fenced = false;
  for (const part of [...html.children]) {
    // 换行留在原处（空的块，不占高），下一行另起一块；括号不跨行算
    if (part.classList.contains("katex-newline")) {
      row = glue = null;
      depth = 0;
      fenced = false;
      continue;
    }
    if (!row) {
      row = document.createElement("span");
      row.className = ROW;
      part.before(row);
    }
    if (!part.classList.contains("katex-base")) {
      // 编号前面垫一个空格：折行时这一行 text-align-last: justify，拉长的就是它，把编号推到右边
      // （见 globals.css）。不折行时编号绝对定位，空格落在行尾被吃掉
      if (part.classList.contains("katex-tag")) row.append(document.createTextNode(" "));
      row.append(part);
      glue = null;
      continue;
    }
    const inside = depth > 0 || fenced;
    for (const char of part.textContent ?? "") {
      if (OPENERS.includes(char)) depth++;
      else if (CLOSERS.includes(char)) depth = Math.max(0, depth - 1);
      else if (depth === 0 && FENCES.includes(char)) fenced = !fenced;
    }
    const open = depth > 0 || fenced;
    if (!inside && !open) {
      row.append(part);
      glue = null;
      continue;
    }
    if (!glue) {
      glue = document.createElement("span");
      glue.className = GLUE;
      row.append(glue);
    }
    glue.append(part);
    if (!open) glue = null;
  }
}

/** 公式的各段：能在它们之间折行的那些（katex-base 和粘起来的组），不含编号 */
function piecesOf(node: HTMLElement): Element[] {
  return [...node.querySelectorAll(`.katex-html > .${ROW} > *`)].filter(
    (part) => part.classList.contains("katex-base") || part.classList.contains(GLUE),
  );
}

export interface MathSize {
  /** 一行有多宽 */
  available: number;
  /** 公式本来多宽（不折行、原字号，不连编号） */
  width: number;
  /** 最宽的一段 */
  widest: number;
  /** 有几段（不到两段就没地方折） */
  count: number;
  /** 编号多宽（没有是 0） */
  tag: number;
  /** 公式的 1em 是多少 px */
  em: number;
}

/** 量一个块级公式（原样，没缩没折的时候量） */
function measure(node: HTMLElement): MathSize {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let widest = 0;
  const pieces = piecesOf(node);
  // KaTeX 的外层是整行宽的块，量不出内容宽度；居中的内容溢出时两边都出界，
  // scrollWidth 也只算右边那一半。所以取各段的并集（\\ 换成好几行时就是最宽的那一行）
  for (const part of pieces) {
    const box = part.getBoundingClientRect();
    if (!box.width) continue;
    left = Math.min(left, box.left);
    right = Math.max(right, box.right);
    widest = Math.max(widest, box.width);
  }
  const tag = node.querySelector(".katex-html .katex-tag");
  const katexNode = node.querySelector(".katex");
  return {
    available: node.clientWidth,
    width: right > left ? right - left : 0,
    widest,
    count: pieces.length,
    tag: tag?.getBoundingClientRect().width ?? 0,
    em: katexNode ? Number.parseFloat(getComputedStyle(katexNode).fontSize) || 0 : 0,
  };
}

export interface MathFit {
  scale: number;
  wrap: boolean;
  scroll: boolean;
}

/** 按量到的尺寸定怎么放（文件头的 1–3） */
export function chooseFit(size: MathSize): MathFit {
  const { available, width, widest, count, tag, em } = size;
  const asIs: MathFit = { scale: 1, wrap: false, scroll: false };
  if (available <= 0 || width <= 0) return asIs;
  // 有编号：公式居中、编号贴着右边，公式两边都得让出编号那么宽，不然右端压在编号上
  // （以前只看公式连编号的总宽，公式一宽过「一行减两个编号」就撞上）
  const centered = tag ? width + 2 * (tag + TAG_GAP_EM * em) : width;
  if (centered <= available) return asIs;
  const whole = available / centered;
  if (whole >= SHRINK_FLOOR) return { ...asIs, scale: floor2(whole) };
  // 没有能断的地方（一整块矩阵、aligned）：只能缩一点或者滑
  if (count < 2) {
    return whole >= PIECE_FLOOR ? { ...asIs, scale: floor2(whole) } : { ...asIs, scroll: true };
  }
  // 最宽的一段按放在续行上算（缩进 2em），右边还要给编号留地方
  const need = widest + HANG_EM * em + (tag ? tag + TAG_GAP_EM * em : 0);
  if (need <= available) return { scale: 1, wrap: true, scroll: false };
  const piece = available / need;
  return piece >= PIECE_FLOOR
    ? { scale: floor2(piece), wrap: true, scroll: false }
    : { scale: 1, wrap: true, scroll: true };
}

/** 往下取到 0.01：往上取的话差那零点几个像素又溢出了 */
function floor2(value: number): number {
  return Math.floor(value * 100) / 100;
}

/** 块级公式的外层 → 里面的公式节点和它所在的编辑器 */
const fitting = new WeakMap<Element, { node: HTMLElement; view: EditorView }>();

/** 这个公式现在是怎么放的：前后不一样才让编辑器重新量高 */
function fitState(node: HTMLElement): string {
  return `${node.style.cssText}|${node.className}`;
}

/**
 * 太宽的块级公式按文件头的规矩放（缩一点 / 折行 / 滑动），样子变了的让编辑器重新量高。
 *
 * 一批一起来：先把它们都恢复原样，再一起量，最后一起写。一个一个来的话
 * 「写样式 → 量宽度」每个公式都要整页强制排版一次 —— 冷启动打开语法全览，十几条
 * 公式在 KaTeX 拉到、ResizeObserver 头一回报尺寸、字体拉到时各来一遍，
 * 4 倍降速下两百多毫秒。
 */
function fitToWidth(blocks: Iterable<Element>) {
  const due: { node: HTMLElement; view: EditorView; before: string }[] = [];
  for (const block of blocks) {
    const target = fitting.get(block);
    if (!target?.node.isConnected) continue;
    const { node } = target;
    due.push({ ...target, before: fitState(node) });
    node.style.fontSize = "";
    node.style.removeProperty("--odea-math-tag");
    node.classList.remove("is-overflowing", "is-wrapped");
  }
  const sizes = due.map(({ node }) => measure(node));
  const changed = new Set<EditorView>();
  due.forEach(({ node, view, before }, index) => {
    const size = sizes[index]!;
    const fit = chooseFit(size);
    if (fit.scale < 1) node.style.fontSize = `${fit.scale}em`;
    node.classList.toggle("is-wrapped", fit.wrap);
    node.classList.toggle("is-overflowing", fit.scroll);
    // 折行时右边给编号留出地方（编号落在最后一行的右端，同 LaTeX 的 multline）
    if (fit.wrap && size.tag && size.em) {
      node.style.setProperty(
        "--odea-math-tag",
        `${(size.tag / size.em + TAG_GAP_EM).toFixed(3)}em`,
      );
    }
    if (fitState(node) !== before) changed.add(view);
  });
  for (const view of changed) view.requestMeasure();
}

/** 攒到这一轮微任务结束再一起放（KaTeX 拉到时，每个公式各自的回调排在同一轮里） */
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
 * 正文列宽变了（窗口缩放、开关目录栏）重新放一次。所有块级公式共用一个观察者，
 * 一次回调里的一起放。只看宽度：缩字号、折行会改高度，高度变化再触发一轮就成了死循环。
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
 * 屏幕上的块级公式都重新放一次。
 */
/** 已经在听字体的文档：主窗口一个，每个弹出窗口各一个（docs/标签页与分屏.md §16，字体是各自拉的） */
const watchedFonts = new WeakSet<Document>();

function watchFonts(doc: Document) {
  if (watchedFonts.has(doc) || !("fonts" in doc)) return;
  watchedFonts.add(doc);
  doc.fonts.addEventListener("loadingdone", () => {
    fitToWidth(doc.querySelectorAll(".cm-odea-math-block"));
  });
}

if (typeof document !== "undefined") watchFonts(document);

/** 这一下点在公式底下的横向滑块上（内容盒以下、边框以上那一条） */
function onScrollbar(node: HTMLElement, event: MouseEvent): boolean {
  if (node.scrollWidth <= node.clientWidth) return false;
  return event.clientY - node.getBoundingClientRect().top >= node.clientTop + node.clientHeight;
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
    watchFonts(view.dom.ownerDocument);
    // 块级公式外面再套一层，留白用 padding（见 widgets.ts 文件头的规矩）
    const node: HTMLElement = document.createElement(this.display ? "div" : "span");
    node.className = `cm-odea-math is-${this.display ? "block" : "inline"}`;
    node.title = "点击编辑公式";
    node.addEventListener("mousedown", (event) => {
      // 点在横向滑块上：拖滑块，别进源码（以前一点滑块就变成源码，滑块根本拖不了）
      if (onScrollbar(node, event)) return;
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
