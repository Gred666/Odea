import type { MatchAnchor } from "@/data/types";
import { isTauri } from "@/lib/tauri";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  setSearchQuery,
} from "@codemirror/search";
import {
  EditorSelection,
  type EditorState,
  type SelectionRange,
  StateEffect,
} from "@codemirror/state";
import { EditorView, type Panel, type ViewUpdate, runScopeHandlers } from "@codemirror/view";
import { cancelGlide, glideTo, scrollParent } from "./glide";

/* ============================================================
   查找 / 替换面板（Mod-F）。

   CodeMirror 自带的面板是一排原生复选框和按钮，挤在编辑器顶上、占着文档流：
   一打开整篇正文往下推一百来像素，关掉再弹回去；控件换行也没有规律，
   「全部」选中所有匹配项在不允许多选区的编辑器里只剩一个，匹配到的位置常常
   贴着视口边缘。这里换成自己的面板：

   - 固定在窗口顶上那条标题栏带里、贴着文档区右边，不占文档流，开关不推正文，也不压正文
   - 一行：输入框（带「第几个 / 共几个」）、大小写 / 全词 / 正则三个开关、上一个 / 下一个、
     展开替换、关闭；替换是折叠的第二行
   - 边打边搜（输入法组字期间不搜，组完再搜），并且直接跳到打开面板时光标之后的
     第一个匹配（后面没有就从头找）；没有结果、正则写错了都有提示
   - 回车下一个、Shift+回车上一个；替换框里回车替换一个、Mod+回车全部替换；
     Alt+C / Alt+W / Alt+R 切换三个开关（和 VS Code 一样）；Esc 关闭并回到正文
   - 匹配项已经在视口里就不滚；不在的话滚到视口中间，不会再贴着边、也不会被面板挡住
   - 不在视口里的匹配平滑地滑过去（glide.ts：每一帧重新量目标位置，路上画出来的内容
     变高了终点跟着挪），到了之后再把匹配项「钉」在屏幕上那个位置（见 SearchPanel.hold）：
     上面还没画过的表格、图表、公式、图片画出来会变高，以前刚找到就被挤出视口
   - 文档区右边缘一列小刻度：所有匹配项在全文里的位置，当前那个是实的、换的时候滑过去
     （MatchMarks）。几十个匹配分布在哪，一眼就看到
   - 打开时从窗口顶边落下来、关掉时收回去；展开替换那一行按高度展开。动的都是 top / height
     （主线程排版），不是 transform，也不淡入：合成层上位移的字在动画里是灰阶抗锯齿、停下那一帧
     才变回清晰的（「先糊再抖一下」）；半透明的面板压在正文上，看着像正文在跳
   ============================================================ */

const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
const EASE_IN = "cubic-bezier(0.55, 0, 0.75, 0.2)";
/** 面板停在离窗口顶边多远（和 CSS 的 top 一致） */
const PANEL_TOP = 4;

function motionReduced(doc: Document): boolean {
  return (
    doc.documentElement.dataset.reduceMotion === "true" ||
    doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** 能不能做动画：关了动效、或者环境没有 Web Animations（单测的 DOM）就直接到位 */
function canAnimate(node: HTMLElement): boolean {
  return typeof node.animate === "function" && !motionReduced(node.ownerDocument);
}

/** 钉住多久：图表、公式是异步画的，网络图片可能要一两秒才加载完 */
const HOLD_MS = 4000;

/** 找到的匹配项该待在的竖向区间（窗口坐标）：面板下面、窗口底边上面 */
function comfortBand(view: EditorView): { top: number; bottom: number } {
  const panel = view.dom.querySelector(".otw-search");
  const top = Math.max(0, panel?.getBoundingClientRect().bottom ?? 0) + 8;
  const bottom = view.dom.ownerDocument.documentElement.clientHeight - 24;
  return { top, bottom };
}

/** 挂着我们这个面板的编辑器：找到匹配后的滚动由面板自己来（平滑滑过去 + 钉住） */
const panelViews = new WeakSet<EditorView>();
/** 面板接管滚动时，给 CodeMirror 的「滚过去」换成一个什么都不做的效果 */
const panelScrolls = StateEffect.define<null>();

/** 计数的上限：超过就显示「999+」，长文档里搜一个「的」也不会卡 */
export const MATCH_COUNT_LIMIT = 999;

/** 面板离文档区右边缘、离窗口右边缘至少留这么多 */
const PANEL_GAP = 16;
/** 桌面端窗口右上角三个自绘按钮（TitleBar.tsx：3 × 36px + 间距 + 右边距）再留一点空 */
const WINDOW_CONTROLS_WIDTH = 132;
/** 面板再窄就放不下输入框和按钮了 */
const PANEL_MIN_WIDTH = 240;

/**
 * 面板的横向位置（`position: fixed` 的 right 和 max-width），按窗口坐标算。
 * 右边贴着文档区（`frameRight`），但不压到窗口按钮上；左边不越过正文的左边缘。
 */
export function panelPlacement(
  viewportWidth: number,
  frameRight: number,
  editorLeft: number,
  windowControls: boolean,
): { right: number; maxWidth: number } {
  const reserve = windowControls ? WINDOW_CONTROLS_WIDTH : PANEL_GAP;
  const right = Math.max(reserve, viewportWidth - frameRight + PANEL_GAP);
  const maxWidth = Math.max(PANEL_MIN_WIDTH, viewportWidth - right - editorLeft);
  return { right, maxWidth };
}

/** 所有匹配项的位置（最多 limit + 1 个，多出来的那一个只用来判断「还有更多」）。 */
export function collectMatches(
  state: EditorState,
  query: SearchQuery,
  limit = MATCH_COUNT_LIMIT,
): Array<{ from: number; to: number }> {
  const matches: Array<{ from: number; to: number }> = [];
  if (!query.valid || !query.search) return matches;
  const cursor = query.getCursor(state);
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    matches.push({ from: step.value.from, to: step.value.to });
    if (matches.length > limit) break;
  }
  return matches;
}

/** 选区正好是第几个匹配（从 1 数）；不是任何一个时为 0。 */
export function matchIndex(
  matches: ReadonlyArray<{ from: number; to: number }>,
  selection: SelectionRange,
): number {
  let low = 0;
  let high = matches.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const match = matches[middle]!;
    if (match.from < selection.from) low = middle + 1;
    else if (match.from > selection.from) high = middle - 1;
    else return match.to === selection.to ? middle + 1 : 0;
  }
  return 0;
}

/** 计数那一格的文字 */
export function matchLabel(
  state: EditorState,
  query: SearchQuery,
  matches: ReadonlyArray<{ from: number; to: number }>,
  current: number,
): { text: string; empty: boolean } {
  if (!query.search) return { text: "", empty: false };
  if (!query.valid) return { text: state.phrase("Invalid regexp"), empty: true };
  if (matches.length === 0) return { text: state.phrase("No results"), empty: true };
  const total = matches.length > MATCH_COUNT_LIMIT ? `${MATCH_COUNT_LIMIT}+` : `${matches.length}`;
  return { text: current ? `${current}/${total}` : total, empty: false };
}

/**
 * 找到匹配项时怎么滚：已经在视口里（且不在面板底下）就不动，否则滚到正中。
 * 编辑器自己不滚（外层的文档视图在滚），所以这里按窗口量。
 *
 * 面板开着的时候不在这里滚，由面板平滑地滑过去（SearchPanel.reveal）；
 * 面板关着直接按 F3 找下一个，还是照旧一步到位。
 */
export function scrollToMatch(range: SelectionRange, view: EditorView) {
  if (panelViews.has(view)) return panelScrolls.of(null);
  const coords = view.coordsAtPos(range.from);
  const { top, bottom } = comfortBand(view);
  const visible = !!coords && coords.top >= top && coords.bottom <= bottom;
  return EditorView.scrollIntoView(range.from, { y: visible ? "nearest" : "center" });
}

/** 从 from 往后第一个匹配；后面没有就从文档开头找（和「下一个」一样绕回去） */
export function firstMatchFrom(
  state: EditorState,
  query: SearchQuery,
  from: number,
): { from: number; to: number } | null {
  if (!query.valid || !query.search) return null;
  const first = (start: number) => {
    const step = query.getCursor(state, start).next();
    return step.done ? null : { from: step.value.from, to: step.value.to };
  };
  return first(Math.min(from, state.doc.length)) ?? (from > 0 ? first(0) : null);
}

/** 全局搜索的条件换成篇内查找的（literal：不是正则时 `\n` 这类也照字面找，和 Rust 那边一样） */
export function queryOfAnchor(anchor: MatchAnchor): SearchQuery {
  return new SearchQuery({
    search: anchor.query,
    caseSensitive: anchor.caseSensitive,
    wholeWord: anchor.wholeWord,
    regexp: anchor.regex,
    literal: true,
  });
}

/**
 * 全局搜索的一处命中在这一篇里的位置：在第 line 行（从 1 开始）里按同样的条件找，取列号对得上的那个；
 * 对不上（打开后的正文和索引不完全一样，或者 JS 和 Rust 的正则有出入）取离得最近的；这一行里一个都没有，
 * 按列号选那一段（还在这一行里的话）。行号不存在返回 null
 */
export function matchOnLine(
  state: EditorState,
  line: number,
  anchor: MatchAnchor,
): { from: number; to: number } | null {
  if (line < 1 || line > state.doc.lines) return null;
  const row = state.doc.line(line);
  const expected = row.from + anchor.column;
  const query = queryOfAnchor(anchor);
  let nearest: { from: number; to: number } | null = null;
  if (query.valid && query.search) {
    const cursor = query.getCursor(state, row.from, row.to);
    for (let step = cursor.next(); !step.done; step = cursor.next()) {
      const { from, to } = step.value;
      if (from === expected) return { from, to };
      if (!nearest || Math.abs(from - expected) < Math.abs(nearest.from - expected)) {
        nearest = { from, to };
      }
    }
  }
  if (nearest) return nearest;
  if (anchor.column + anchor.length <= row.length) {
    return { from: expected, to: expected + anchor.length };
  }
  return { from: row.from, to: row.from };
}

const SVG_NS = "http://www.w3.org/2000/svg";

function icon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

const ICONS = {
  search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M20 20l-3.5-3.5"],
  up: ["M18 15l-6-6-6 6"],
  down: ["M6 9l6 6 6-6"],
  chevron: ["M9 18l6-6-6-6"],
  close: ["M18 6L6 18", "M6 6l12 12"],
};

function button(
  className: string,
  label: string,
  content: Node | string,
  onClick: () => void,
): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.title = label;
  node.setAttribute("aria-label", label);
  node.append(content);
  // 点按钮不抢输入框的焦点：点完开关、上一个下一个，接着打字、回车都还在输入框里
  node.addEventListener("mousedown", (event) => event.preventDefault());
  node.addEventListener("click", onClick);
  return node;
}

function field(placeholder: string, value: string): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "otw-search-input";
  input.type = "text";
  input.value = value;
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  input.spellcheck = false;
  input.autocomplete = "off";
  return input;
}

class SearchPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private query: SearchQuery;
  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly searchBox: HTMLElement;
  private readonly toggles: Record<"caseSensitive" | "wholeWord" | "regexp", HTMLButtonElement>;
  private readonly replaceToggle: HTMLButtonElement;
  private readonly replaceRow: HTMLElement;
  private matches: Array<{ from: number; to: number }> = [];
  private readonly marks: MatchMarks | null;
  private replaceMotion: Animation | null = null;
  private recount: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly onResize = () => this.place();
  /** 边打边搜从哪里往后找：打开面板时的光标，之后是「上一个 / 下一个」停下的地方 */
  private anchor: number;
  /**
   * 钉住的匹配项：pos 要一直待在窗口坐标 y 上（y 在第一次量到它落进可视区时定下）。
   * 用户自己滚动、点别处、时间到了就松开。
   */
  private pin: { pos: number; y: number | null; until: number } | null = null;
  private readonly pinRequest = {
    key: "otw-search-pin",
    read: (view: EditorView) => {
      const pin = this.pin;
      if (!pin) return null;
      if (Date.now() > pin.until) {
        this.pin = null;
        return null;
      }
      const coords = view.coordsAtPos(pin.pos, 1);
      return coords ? { top: coords.top, band: comfortBand(view) } : null;
    },
    write: (measured: { top: number; band: { top: number; bottom: number } } | null) => {
      const pin = this.pin;
      if (!pin || !measured) return;
      const { top, band } = measured;
      // 第一次量到：已经落在可视区里就钉在那里；还在外面（CodeMirror 还没滚过去，
      // 或者滚过去之后又被上面的内容挤走了）就钉在可视区中间
      pin.y ??=
        top >= band.top && top <= band.bottom - 20 ? top : (band.top + band.bottom) / 2 - 12;
      const drift = top - pin.y;
      if (Math.abs(drift) < 1) return;
      const scroller = scrollParent(this.view);
      if (scroller) scroller.scrollTop += drift;
      else this.view.dom.ownerDocument.defaultView?.scrollBy(0, drift);
    },
  };
  /** 用户自己动了（滚轮、触摸、在面板外点击或按键）：松开，不再跟他抢 */
  private readonly release = (event: Event) => {
    if (!this.pin) return;
    if (
      (event.type === "keydown" || event.type === "pointerdown") &&
      this.dom.contains(event.target as Node)
    ) {
      return;
    }
    this.pin = null;
  };

  constructor(private readonly view: EditorView) {
    const { state } = view;
    this.query = getSearchQuery(state);
    this.anchor = state.selection.main.from;

    this.searchField = field(state.phrase("Find"), this.query.search);
    // openSearchPanel / Mod-F 找的是带 main-field 的输入框：聚焦并全选
    this.searchField.setAttribute("main-field", "true");
    this.replaceField = field(state.phrase("Replace"), this.query.replace);
    for (const input of [this.searchField, this.replaceField]) {
      input.addEventListener("input", (event) => {
        // 输入法组字期间不搜，组完（compositionend）再搜
        if (!(event as InputEvent).isComposing) this.commit();
      });
      input.addEventListener("compositionend", () => this.commit());
      input.addEventListener("change", () => this.commit());
    }

    this.count = document.createElement("span");
    this.count.className = "otw-search-count";
    this.count.setAttribute("aria-live", "polite");

    const toggle = (
      key: "caseSensitive" | "wholeWord" | "regexp",
      phrase: string,
      text: string,
    ) => {
      const node = button("otw-search-toggle", `${state.phrase(phrase)}`, text, () => {
        this.flip(key);
      });
      node.dataset.option = key;
      return node;
    };
    this.toggles = {
      caseSensitive: toggle("caseSensitive", "match case", "Aa"),
      wholeWord: toggle("wholeWord", "by word", "ab"),
      regexp: toggle("regexp", "regexp", ".*"),
    };

    this.searchBox = document.createElement("div");
    this.searchBox.className = "otw-search-box";
    const lens = icon(ICONS.search);
    lens.classList.add("otw-search-lens");
    this.searchBox.append(
      lens,
      this.searchField,
      this.count,
      this.toggles.caseSensitive,
      this.toggles.wholeWord,
      this.toggles.regexp,
    );

    const readOnly = state.readOnly;
    this.replaceToggle = button(
      "otw-search-icon otw-search-expand",
      state.phrase("Toggle replace"),
      icon(ICONS.chevron),
      () => this.showReplace(this.replaceRow.hidden),
    );
    this.replaceToggle.hidden = readOnly;

    const findRow = document.createElement("div");
    findRow.className = "otw-search-row";
    findRow.append(
      this.replaceToggle,
      this.searchBox,
      button("otw-search-icon", `${state.phrase("previous")} (Shift+Enter)`, icon(ICONS.up), () =>
        this.go(findPrevious),
      ),
      button("otw-search-icon", `${state.phrase("next")} (Enter)`, icon(ICONS.down), () =>
        this.go(findNext),
      ),
      button("otw-search-icon", `${state.phrase("close")} (Esc)`, icon(ICONS.close), () =>
        closeSearchPanel(view),
      ),
    );

    const replaceBox = document.createElement("div");
    replaceBox.className = "otw-search-box";
    replaceBox.append(this.replaceField);
    // 外面一层负责按高度展开 / 收起（里面那一行的内容一直钉在原位，只是被一点点露出来）
    this.replaceRow = document.createElement("div");
    this.replaceRow.className = "otw-search-replace";
    const replaceInner = document.createElement("div");
    replaceInner.className = "otw-search-row otw-search-replace-row";
    this.replaceRow.append(replaceInner);
    replaceInner.append(
      replaceBox,
      button("otw-search-text", `${state.phrase("replace")} (Enter)`, state.phrase("replace"), () =>
        this.go(replaceNext),
      ),
      button("otw-search-text", state.phrase("replace all"), state.phrase("replace all"), () =>
        replaceAll(view),
      ),
    );
    // 上次展开过替换（替换框里还有字）就接着展开
    this.replaceRow.hidden = readOnly || !this.query.replace;

    this.dom = document.createElement("div");
    this.dom.className = "otw-search";
    this.dom.setAttribute("role", "search");
    this.dom.addEventListener("keydown", (event) => this.keydown(event));
    this.dom.append(findRow, this.replaceRow);

    const host = this.frame().parentElement;
    this.marks = this.frame() !== view.dom && host ? new MatchMarks(host, this.frame()) : null;

    this.syncOptions();
    this.refresh();
  }

  /** 所有匹配项在文档区右边那一列刻度上的位置：要量布局，放在 CodeMirror 的测量阶段 */
  private readonly marksRequest = {
    key: "otw-search-marks",
    read: (view: EditorView) => {
      const scroller = this.frame();
      const total = scroller.scrollHeight;
      const track = scroller.clientHeight;
      if (!this.marks || !total || !track) return null;
      // 正文顶端在滚动内容里的位置：编辑器上面还有标题、分隔线
      const docTop = view.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop;
      const at = (pos: number) => {
        const block = view.lineBlockAt(Math.min(pos, view.state.doc.length));
        return ((docTop + block.top + block.height / 2) / total) * track;
      };
      const current = matchIndex(this.matches, view.state.selection.main);
      return {
        ticks: this.matches.slice(0, MATCH_COUNT_LIMIT).map((match) => at(match.from)),
        current: current ? at(this.matches[current - 1]!.from) : null,
        track,
      };
    },
    write: (measured: { ticks: number[]; current: number | null; track: number } | null) => {
      if (measured) this.marks?.render(measured.ticks, measured.current, measured.track);
    },
  };

  mount() {
    this.place();
    // 从窗口顶边落下来（见文件头：动 top，不动 transform、不淡入）
    if (canAnimate(this.dom)) {
      this.dom.animate([{ top: `${-this.dom.offsetHeight - 12}px` }, { top: `${PANEL_TOP}px` }], {
        duration: 260,
        easing: EASE_OUT,
      });
    }
    this.marks?.show();
    this.view.requestMeasure(this.marksRequest);
    // 文档区宽度会变：拖窗口、进出专注模式、目录栏出现消失，都要跟着重新贴边
    window.addEventListener("resize", this.onResize);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(this.frame());
    }
    // Chromium 里 select() 顺带会聚焦，别的引擎不一定
    this.searchField.focus({ preventScroll: true });
    this.searchField.select();
    const win = this.view.dom.ownerDocument.defaultView;
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      win?.addEventListener(type, this.release, { capture: true, passive: true });
    }
    panelViews.add(this.view);
  }

  update(update: ViewUpdate) {
    let queryChanged = false;
    for (const transaction of update.transactions) {
      for (const effect of transaction.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.setQuery(effect.value);
          queryChanged = true;
        }
      }
    }
    // 「上一个 / 下一个」、边打边搜、替换之后选中了新的匹配：滑过去。
    // 更新过程中不能量布局，等这一轮更新完再开始
    if (
      update.selectionSet &&
      update.transactions.some(
        (transaction) =>
          transaction.isUserEvent("select.search") || transaction.isUserEvent("input.replace"),
      )
    ) {
      queueMicrotask(() => this.reveal());
    }
    if (update.docChanged) {
      this.anchor = update.changes.mapPos(this.anchor);
      if (this.pin) this.pin.pos = update.changes.mapPos(this.pin.pos);
    }
    // 钉着的时候，任何会让高度、视口变化的更新之后都量一次，漂了就滚回来
    if (
      this.pin &&
      (update.heightChanged ||
        update.geometryChanged ||
        update.viewportChanged ||
        update.docChanged ||
        update.selectionSet)
    ) {
      this.view.requestMeasure(this.pinRequest);
    }
    if (queryChanged) {
      // 别处换了关键词（面板开着时又按一次 Mod-F，带着新选中的词）：从那里重新开始
      this.anchor = update.state.selection.main.from;
      this.refresh();
    } else if (update.docChanged) {
      // 在正文里边改边看：数一遍要扫全文，打字时攒一攒再数
      if (this.recount) clearTimeout(this.recount);
      this.recount = setTimeout(() => {
        this.recount = null;
        this.refresh();
      }, 150);
    } else if (update.selectionSet) {
      this.renderCount();
    }
    if (update.geometryChanged) this.place();
    // 正文边画边量出真实高度、窗口变了：刻度跟着挪
    if (update.heightChanged || update.geometryChanged) this.view.requestMeasure(this.marksRequest);
  }

  destroy() {
    this.leave();
    this.marks?.dispose();
    this.replaceMotion?.cancel();
    if (this.recount) clearTimeout(this.recount);
    window.removeEventListener("resize", this.onResize);
    this.resizeObserver?.disconnect();
    const win = this.view.dom.ownerDocument.defaultView;
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      win?.removeEventListener(type, this.release, { capture: true });
    }
    this.pin = null;
    panelViews.delete(this.view);
    cancelGlide(this.view);
  }

  /**
   * 关掉：CodeMirror 这时就要把面板从 DOM 里拿走了，留一份副本在原处收回窗口顶边外面。
   */
  private leave() {
    if (!this.dom.isConnected || !canAnimate(this.dom)) return;
    const { top, height } = this.dom.getBoundingClientRect();
    const ghost = this.dom.cloneNode(true) as HTMLElement;
    ghost.classList.add("is-leaving");
    ghost.setAttribute("aria-hidden", "true");
    ghost.inert = true;
    // 输入框里的字在属性之外，cloneNode 带不过去
    const fields = this.dom.querySelectorAll("input");
    ghost.querySelectorAll("input").forEach((input, index) => {
      input.value = fields[index]?.value ?? "";
    });
    this.view.dom.append(ghost);
    const out = ghost.animate([{ top: `${top}px` }, { top: `${-height - 12}px` }], {
      duration: 190,
      easing: EASE_IN,
      fill: "forwards",
    });
    out.onfinish = () => ghost.remove();
    out.oncancel = () => ghost.remove();
  }

  /**
   * 把选中的匹配项平滑地滑到可视区中间（已经看得见就不动），到了之后钉住。
   * 滑动的每一帧都重新量目标的位置，上面的内容边画边变高也能准确停下。
   */
  private reveal() {
    if (!panelViews.has(this.view)) return;
    const { main } = this.view.state.selection;
    if (main.empty) return;
    this.pin = null;
    glideTo(this.view, main.from, {
      y: "center",
      nearest: true,
      band: () => comfortBand(this.view),
      keep: this.dom,
      onArrive: (y) => this.hold(y),
    });
  }

  /** 把当前选中的匹配项钉在窗口坐标 y 上，直到用户自己动手或者 HOLD_MS 过去 */
  private hold(y: number | null) {
    const { main } = this.view.state.selection;
    if (main.empty) return;
    this.pin = { pos: main.from, y, until: Date.now() + HOLD_MS };
    this.view.requestMeasure(this.pinRequest);
  }

  /** 边打边搜：跳到起点之后的第一个匹配（已经选中的就是它，只是钉住） */
  private jumpFromAnchor() {
    const { state } = this.view;
    const match = firstMatchFrom(state, this.query, this.anchor);
    if (!match) return;
    const { main } = state.selection;
    // 选中之后由 update 接着滑过去；已经选中的就是它，直接确认它看得见
    if (main.from !== match.from || main.to !== match.to) {
      this.view.dispatch({
        selection: EditorSelection.range(match.from, match.to),
        userEvent: "select.search",
      });
    } else {
      this.reveal();
    }
  }

  /** 文档区的滚动容器（DocumentView 上的 data-doc-scroller）；单独挂的编辑器就是它自己 */
  private frame(): HTMLElement {
    return this.view.dom.closest<HTMLElement>("[data-doc-scroller]") ?? this.view.dom;
  }

  /**
   * 面板固定在窗口顶上、标题栏那条带里（位置见 CSS），这里只算横向。
   *
   * 以前 .cm-panels 是 sticky 贴在编辑器顶上：文档还没往下滚时，sticky 元素待在
   * 自己的原位 —— 正文第一行那里，于是一打开就压住开头几行，滚下去以后又压着
   * 右上角那一截正文。标题栏那条带在文档顶部本来就是空的，放在那里什么都不挡。
   */
  private place() {
    const viewport = this.view.dom.ownerDocument.documentElement.clientWidth;
    const { right, maxWidth } = panelPlacement(
      viewport,
      this.frame().getBoundingClientRect().right,
      this.view.dom.getBoundingClientRect().left,
      isTauri,
    );
    this.dom.style.right = `${right}px`;
    this.dom.style.maxWidth = `${maxWidth}px`;
    this.view.requestMeasure(this.marksRequest);
  }

  private keydown(event: KeyboardEvent) {
    // Esc、Mod-F、F3 / Mod-G 这些和正文共用的快捷键
    if (runScopeHandlers(this.view, event, "search-panel")) {
      event.preventDefault();
      return;
    }
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      if (event.target === this.searchField) {
        event.preventDefault();
        this.go(event.shiftKey ? findPrevious : findNext);
      } else if (event.target === this.replaceField) {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) replaceAll(this.view);
        else this.go(replaceNext);
      }
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const key = { KeyC: "caseSensitive", KeyW: "wholeWord", KeyR: "regexp" }[event.code] as
        | "caseSensitive"
        | "wholeWord"
        | "regexp"
        | undefined;
      if (key) {
        event.preventDefault();
        this.flip(key);
      }
    }
  }

  /**
   * 上一个 / 下一个。CodeMirror 跳完会把查找框里的字全选上 —— 回车之后想接着补一个字，
   * 结果整个关键词被替换掉了。这里把光标放回原处。
   */
  private go(command: (view: EditorView) => boolean) {
    const { selectionStart, selectionEnd, selectionDirection } = this.searchField;
    command(this.view);
    // 接着往下打字时，从这一个开始找
    this.anchor = this.view.state.selection.main.from;
    if (this.searchField.ownerDocument.activeElement === this.searchField) {
      this.searchField.setSelectionRange(
        selectionStart,
        selectionEnd,
        selectionDirection ?? undefined,
      );
    }
  }

  private flip(key: "caseSensitive" | "wholeWord" | "regexp") {
    const next = new SearchQuery({ ...this.spec(), [key]: !this.query[key] });
    this.query = next;
    this.syncOptions();
    this.view.dispatch({ effects: setSearchQuery.of(next) });
    this.refresh();
    this.jumpFromAnchor();
  }

  private spec() {
    return {
      search: this.searchField.value,
      caseSensitive: this.query.caseSensitive,
      regexp: this.query.regexp,
      wholeWord: this.query.wholeWord,
      replace: this.replaceField.value,
    };
  }

  private commit() {
    const query = new SearchQuery(this.spec());
    if (query.eq(this.query)) return;
    // 只改了替换框：不用跳
    const searchChanged = query.search !== this.query.search;
    this.query = query;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    this.refresh();
    if (searchChanged) this.jumpFromAnchor();
  }

  private setQuery(query: SearchQuery) {
    this.query = query;
    if (this.searchField.value !== query.search) this.searchField.value = query.search;
    if (this.replaceField.value !== query.replace) this.replaceField.value = query.replace;
    this.syncOptions();
  }

  private syncOptions() {
    for (const [key, node] of Object.entries(this.toggles)) {
      const on = this.query[key as keyof typeof this.toggles];
      node.classList.toggle("is-on", on);
      node.setAttribute("aria-pressed", String(on));
    }
  }

  /** 展开 / 收起替换那一行：按高度，里面的内容钉在原位一点点露出来 */
  private showReplace(show: boolean) {
    const row = this.replaceRow;
    this.replaceToggle.classList.toggle("is-open", show);
    this.replaceToggle.setAttribute("aria-expanded", String(show));
    // 打断上一段（连点两下）：从它当时的高度接着走
    const from = row.hidden ? 0 : row.getBoundingClientRect().height;
    this.replaceMotion?.cancel();
    this.replaceMotion = null;
    row.hidden = false;
    (show ? this.replaceField : this.searchField).focus();
    if (!canAnimate(row)) {
      row.hidden = !show;
      return;
    }
    const full = row.scrollHeight;
    const motion = row.animate([{ height: `${from}px` }, { height: `${show ? full : 0}px` }], {
      duration: show ? 220 : 170,
      easing: show ? EASE_OUT : EASE_IN,
    });
    this.replaceMotion = motion;
    motion.onfinish = () => {
      if (this.replaceMotion === motion) this.replaceMotion = null;
      row.hidden = !show;
    };
  }

  /** 重新数一遍匹配项并刷新计数 */
  private refresh() {
    this.matches = collectMatches(this.view.state, this.query);
    this.replaceToggle.classList.toggle("is-open", !this.replaceRow.hidden);
    this.replaceToggle.setAttribute("aria-expanded", String(!this.replaceRow.hidden));
    this.renderCount();
  }

  private renderCount() {
    const current = matchIndex(this.matches, this.view.state.selection.main);
    const label = matchLabel(this.view.state, this.query, this.matches, current);
    this.count.textContent = label.text;
    this.searchBox.classList.toggle("is-empty", label.empty);
    this.view.requestMeasure(this.marksRequest);
  }
}

/**
 * 文档区右边缘的一列刻度：每个匹配项在全文里的位置（按滚动区的比例），当前那个是实的。
 * 挂在文档区（DocumentView 的 data-swap-host）里、滚动区后面、覆盖式滚动条前面 ——
 * 滚动条滑块盖在刻度上面，拖起来不受影响。刻度本身不接鼠标。
 */
class MatchMarks {
  private readonly dom: HTMLElement;
  private readonly current: HTMLElement;
  private key = "";

  constructor(host: HTMLElement, scroller: HTMLElement) {
    this.dom = document.createElement("div");
    this.dom.className = "otw-search-marks";
    this.dom.setAttribute("aria-hidden", "true");
    this.current = document.createElement("i");
    this.current.className = "is-current";
    this.current.hidden = true;
    host.insertBefore(this.dom, scroller.nextSibling);
  }

  show() {
    // 下一帧再加上：先以透明的样子画出来一次，过渡才有起点
    requestAnimationFrame(() => this.dom.classList.add("is-shown"));
  }

  render(ticks: number[], current: number | null, track: number) {
    const clamp = (y: number) => Math.round(Math.min(track - 4, Math.max(3, y)));
    // 同一个像素上的只画一个：长文档里搜「的」也就几百个点
    const rows = [...new Set(ticks.map(clamp))];
    const key = rows.join(",");
    if (key !== this.key) {
      this.key = key;
      const nodes = rows.map((y) => {
        const tick = document.createElement("i");
        tick.style.top = `${y - 1}px`;
        return tick;
      });
      this.dom.replaceChildren(...nodes, this.current);
    }
    this.current.hidden = current === null;
    if (current !== null) this.current.style.top = `${clamp(current) - 1.5}px`;
  }

  dispose() {
    this.dom.classList.remove("is-shown");
    if (!canAnimate(this.dom)) {
      this.dom.remove();
      return;
    }
    setTimeout(() => this.dom.remove(), 220);
  }
}

export function createSearchPanel(view: EditorView): Panel {
  return new SearchPanel(view);
}
