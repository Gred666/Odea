/* ============================================================
   悬停提示（docs/悬停提示.md）：替掉系统原生的 title。

   元素挂 data 属性就有提示，不用包组件、不用逐个加监听：
     data-tip           主字（图标按钮必须有，和 aria-label 一样就行，用 tip() 一起给）
     data-tip-kbd       快捷键，空格分键（「Ctrl Shift F」）；只配真有的
     data-tip-detail    第二行说明（状态、条件、后果）
     data-tip-side      放哪边：bottom（默认）/ top / right / left
     data-tip-overflow  被截断的字：真被截断了才出，出的是它自己的字（属性有值就用那个值）

   一个窗口装一份（installTooltips(win)）：委托在 document 上；整个窗口只有一个提示节点，反复用。
   - 时间：第一次停 500ms；刚看完一个、400ms 内移到下一个立刻出；离开留 80ms，鼠标能移到提示上
     （WCAG 1.4.13「能悬停」）；不定时收。按下、Esc、滚动、窗口失焦立刻收；键盘焦点（:focus-visible）立刻出
   - 长相：底色拆成三片（左圆头、中间、右圆头），字是另一层。挨着的按钮之间换目标，底色滑过去、
     宽度跟着变，字不动 —— 新字在终点原地淡入、旧字原地淡出。带字的东西不位移、不缩放
     （技术方案 §10.1 第 4 条），位置对齐整物理像素（PITFALLS/动效.md「先对齐再动」）
   正文里读内容的悬停卡片（editor/hoverCard.ts）是另一种东西，共用这里的定位和时间常数。
   ============================================================ */

export type TipSide = "top" | "bottom" | "left" | "right";

/** 时间、尺寸（docs/悬停提示.md §4） */
export const TIP = {
  /** 第一次停下多久出 */
  openDelay: 500,
  /** 刚收了一个，这么久以内移到下一个不用等 */
  warm: 400,
  /** 离开后留多久：这段时间里移到提示上就不收 */
  grace: 80,
  /** 离目标多远 */
  gap: 6,
  /** 离窗口边至少多远 */
  edge: 8,
  fadeIn: 120,
  fadeOut: 90,
  /** 底色滑过去 */
  glide: 180,
  /** 旧字原地淡出 */
  textOut: 70,
  /** 新字晚这么久开始淡入（淡入时长同 fadeIn） */
  textDelay: 50,
  /** 两个提示的位置隔得比这远就直接换，不滑（免得横穿半个窗口） */
  near: 160,
  /** 一行超过这么宽就折行 */
  maxWidth: 280,
  /** 底色左右两个圆头的宽 */
  cap: 10,
} as const;

const EASE_OUT_QUINT = "cubic-bezier(0.22, 1, 0.36, 1)";
const SELECTOR = "[data-tip], [data-tip-overflow]";
/** 带上正文里读内容的悬停卡片（editor/hoverCard.ts）管的元素：两种提示套在一起时找最里面那个 */
const OWNER_SELECTOR = `${SELECTOR}, [data-odea-tip]`;
const CONTENT_ATTRS = ["data-tip", "data-tip-kbd", "data-tip-detail", "data-tip-overflow"];
const TIP_ID = "odea-tip";

export interface TipOptions {
  /** 快捷键，空格分键：用 lib/platform 的 shortcut() 拼，只配真有的 */
  kbd?: string;
  /** 第二行说明 */
  detail?: string;
  side?: TipSide;
  /**
   * 顺手把主字给成 aria-label（默认给）。元素上本来就有看得见的字（带字的按钮、状态文字）时传 false：
   * 无障碍名字照旧是那几个字，提示的字出现时挂到 aria-describedby 上
   */
  name?: boolean;
}

export interface TipAttributes {
  "data-tip": string;
  "data-tip-kbd"?: string;
  "data-tip-detail"?: string;
  "data-tip-side"?: TipSide;
}

/** 提示要挂的属性：`<button {...tip("导出", { kbd: shortcut("Shift E"), side: "top" })}>` */
export function tip(label: string, options: TipOptions & { name: false }): TipAttributes;
export function tip(label: string, options?: TipOptions): TipAttributes & { "aria-label"?: string };
export function tip(label: string, options: TipOptions = {}) {
  const { kbd, detail, side, name = true } = options;
  const attributes: TipAttributes & { "aria-label"?: string } = { "data-tip": label };
  if (name) attributes["aria-label"] = label;
  if (kbd) attributes["data-tip-kbd"] = kbd;
  if (detail) attributes["data-tip-detail"] = detail;
  if (side) attributes["data-tip-side"] = side;
  return attributes;
}

/** 不经过 JSX 的地方（编辑器装饰的 attributes）：tip() 的那几项摊成「属性名 → 值」 */
export function tipAttributes(label: string, options: TipOptions = {}): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(tip(label, options))) {
    if (typeof value === "string") attributes[name] = value;
  }
  return attributes;
}

/**
 * 自己建的 DOM（编辑器的替身、浮在正文上的按钮）挂提示；同一个元素再调就换掉，这次没给的快捷键、说明、方向拿掉。
 * label 是空的：提示整个拿掉（aria-label 不动）
 */
export function setTip(element: HTMLElement, label: string, options: TipOptions = {}): void {
  const attributes = label ? tipAttributes(label, options) : {};
  for (const name of ["data-tip", "data-tip-kbd", "data-tip-detail", "data-tip-side"]) {
    if (!(name in attributes)) element.removeAttribute(name);
  }
  for (const [name, value] of Object.entries(attributes)) {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  }
}

export interface TipContent {
  text: string;
  kbd?: string;
  detail?: string;
  /** 截断的字：看得见的就是它，读屏不用再读一遍 */
  overflow?: boolean;
}

/** 量一下字有没有被截断：单行省略号看横向；多行截断（line-clamp）看竖向 */
export function isTruncated(element: HTMLElement): boolean {
  if (element.scrollWidth > element.clientWidth) return true;
  const clamp = element.ownerDocument.defaultView
    ?.getComputedStyle(element)
    .getPropertyValue("-webkit-line-clamp");
  return !!clamp && clamp !== "none" && element.scrollHeight > element.clientHeight;
}

/**
 * 提示和元素上看得见的字重复（宽的时候按钮上写着「筛选」，提示也是「筛选」）：不出。
 * 被截断了不算重复 —— 元素自己，或者里面哪一截带着省略号（控制中心同步那一行的第二行）；
 * 带快捷键、说明的照出。读 innerText 要排版，在量位置之后调（那时排版是新的）
 */
export function repeatsVisibleText(element: HTMLElement, content: TipContent): boolean {
  if (content.overflow || content.kbd || content.detail) return false;
  const visible = element.innerText;
  if (typeof visible !== "string") return false;
  const squash = (value: string) => value.replace(/\s+/g, "");
  if (!squash(visible).includes(squash(content.text)) || isTruncated(element)) return false;
  // 走到这里的都是字和提示一样的小控件，里面没几个元素
  for (const inner of element.querySelectorAll<HTMLElement>("*")) {
    if (inner.scrollWidth !== undefined && isTruncated(inner)) return false;
  }
  return true;
}

/** 这个元素要出什么；不该出（没被截断、没有字）是 null */
export function tipContent(element: HTMLElement): TipContent | null {
  if (element.hasAttribute("data-tip-overflow")) {
    if (!isTruncated(element)) return null;
    const text = element.getAttribute("data-tip-overflow") || element.textContent?.trim() || "";
    return text ? { text, overflow: true } : null;
  }
  const text = element.getAttribute("data-tip")?.trim();
  if (!text) return null;
  return {
    text,
    kbd: element.getAttribute("data-tip-kbd") || undefined,
    detail: element.getAttribute("data-tip-detail") || undefined,
  };
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const OPPOSITE: Record<TipSide, TipSide> = {
  bottom: "top",
  top: "bottom",
  right: "left",
  left: "right",
};

/**
 * 放在目标的哪一边、坐标是多少：首选那一边放不下就翻到对面；夹在窗口里，离边至少 edge；
 * 坐标对齐整物理像素。悬停卡片（editor/hoverCard.ts）也用这个
 */
export function placeBeside(
  anchor: Box,
  size: { width: number; height: number },
  side: TipSide,
  viewport: { width: number; height: number; dpr: number },
  gap: number = TIP.gap,
  edge: number = TIP.edge,
): { x: number; y: number; side: TipSide } {
  const { width: w, height: h } = size;
  const fits: Record<TipSide, boolean> = {
    bottom: anchor.bottom + gap + h <= viewport.height - edge,
    top: anchor.top - gap - h >= edge,
    right: anchor.right + gap + w <= viewport.width - edge,
    left: anchor.left - gap - w >= edge,
  };
  const chosen = !fits[side] && fits[OPPOSITE[side]] ? OPPOSITE[side] : side;
  let x: number;
  let y: number;
  if (chosen === "bottom" || chosen === "top") {
    x = (anchor.left + anchor.right) / 2 - w / 2;
    y = chosen === "bottom" ? anchor.bottom + gap : anchor.top - gap - h;
  } else {
    y = (anchor.top + anchor.bottom) / 2 - h / 2;
    x = chosen === "right" ? anchor.right + gap : anchor.left - gap - w;
  }
  x = Math.min(Math.max(edge, x), Math.max(edge, viewport.width - edge - w));
  y = Math.min(Math.max(edge, y), Math.max(edge, viewport.height - edge - h));
  return { x: snap(x, viewport.dpr), y: snap(y, viewport.dpr), side: chosen };
}

/** 对齐到整物理像素 */
export function snap(value: number, dpr: number): number {
  return Math.round(value * dpr) / dpr;
}

/** 往上取到整物理像素（宽高：取小了字会被底色的边切掉） */
function snapUp(value: number, dpr: number): number {
  return Math.ceil(value * dpr - 0.01) / dpr;
}

const installed = new WeakMap<Window, () => void>();

/**
 * 在一个窗口里装上悬停提示，返回拆掉的函数。主窗口在启动时装（boot/mount.tsx），
 * 弹出窗口各装一份（components/Popouts.tsx）。同一个窗口重复装拿到的是同一份
 */
export function installTooltips(win: Window = window): () => void {
  const existing = installed.get(win);
  if (existing) return existing;

  const doc = win.document;
  const root = doc.createElement("div");
  root.className = "odea-tip";
  root.id = TIP_ID;
  root.setAttribute("role", "tooltip");
  root.setAttribute("aria-hidden", "true");
  root.style.opacity = "0";
  // 给调试、测试、逐帧脚本看的：shown / hiding / hidden
  root.dataset.state = "hidden";
  const bg = doc.createElement("div");
  bg.className = "odea-tip-bg";
  const capLeft = doc.createElement("i");
  capLeft.className = "odea-tip-cap is-left";
  const middle = doc.createElement("i");
  middle.className = "odea-tip-mid";
  const capRight = doc.createElement("i");
  capRight.className = "odea-tip-cap is-right";
  bg.append(capLeft, middle, capRight);
  root.append(bg);
  doc.body.append(root);

  const canAnimate = typeof root.animate === "function";
  const reduceQuery = win.matchMedia?.("(prefers-reduced-motion: reduce)");
  const reduced = () =>
    doc.documentElement.dataset.reduceMotion === "true" || reduceQuery?.matches === true;
  const now = () => Date.now();
  const dpr = () => win.devicePixelRatio || 1;

  /** 鼠标 / 键盘焦点所在的触发元素 */
  let target: HTMLElement | null = null;
  /** 提示正对着的 */
  let shown: HTMLElement | null = null;
  /** 提示整块看得见（含正在淡出的） */
  let visible = false;
  /** 当前那一层字 */
  let text: HTMLElement | null = null;
  let last: { x: number; y: number } | null = null;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let fadeOut: Animation | null = null;
  let fadeFallback: ReturnType<typeof setTimeout> | undefined;
  let lastHidden = Number.NEGATIVE_INFINITY;
  /** 刚按下的：鼠标离开它之前不再出 */
  let suppressed: HTMLElement | null = null;
  /** 挂了 aria-describedby 的元素和它原来的值 */
  let described: { element: HTMLElement; original: string | null } | null = null;

  const Observer =
    (win as Window & { MutationObserver?: typeof MutationObserver }).MutationObserver ??
    MutationObserver;
  // 只在显示时挂：内容变了（同步状态变了）原地换字；目标被拆掉了就收
  const observer = new Observer((records) => {
    if (!shown) return;
    if (!shown.isConnected) return hide(true);
    if (records.some((record) => record.type === "attributes" && record.target === shown)) {
      show(shown, true);
    }
  });

  // 弹出窗口里的元素是那个窗口的 Element，不用 instanceof（docs/标签页与分屏.md §20.2）。
  // 最里面那个说了算：整块带提示的 HTML 块、目录里面的 <abbr>、脚注出的是正文的悬停卡片，外面这个让位
  const triggerOf = (node: EventTarget | null): HTMLElement | null => {
    if (typeof (node as Element | null)?.closest !== "function") return null;
    const owner = (node as Element).closest<HTMLElement>(OWNER_SELECTOR);
    return owner?.matches(SELECTOR) ? owner : null;
  };

  const clearOpen = () => {
    clearTimeout(openTimer);
    openTimer = undefined;
  };
  const clearHide = () => {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  };

  function makeText(content: TipContent, label: string | null): HTMLElement {
    const layer = doc.createElement("div");
    layer.className = "odea-tip-txt";
    const line = doc.createElement("div");
    line.className = "odea-tip-line";
    const main = doc.createElement("span");
    main.textContent = content.text;
    // 和 aria-label 一样的那几个字不用再读一遍（读屏读的是 aria-describedby 指过来的这一层）
    if (content.text === label) main.setAttribute("aria-hidden", "true");
    line.append(main);
    if (content.kbd) {
      const keys = doc.createElement("kbd");
      for (const key of content.kbd.split(/\s+/).filter(Boolean)) {
        const cap = doc.createElement("span");
        cap.textContent = key;
        keys.append(cap);
      }
      line.append(keys);
    }
    layer.append(line);
    if (content.detail) {
      const detail = doc.createElement("div");
      detail.className = "odea-tip-detail";
      detail.textContent = content.detail;
      layer.append(detail);
    }
    return layer;
  }

  /** 改 transform：要滑就从当前位置（被打断了也接得上）滑到终点；终点先写进 style，动画完了不用再补 */
  function moveTo(element: HTMLElement, transform: string, animate: boolean) {
    let from = "";
    if (canAnimate) {
      const running = element.getAnimations();
      if (running.length) {
        if (animate) from = win.getComputedStyle(element).transform;
        for (const animation of running) animation.cancel();
      }
    }
    if (animate && !from) from = element.style.transform;
    element.style.transform = transform;
    if (animate && canAnimate && from && from !== "none" && from !== transform) {
      element.animate([{ transform: from }, { transform }], {
        duration: TIP.glide,
        easing: EASE_OUT_QUINT,
      });
    }
  }

  /** 底色三片：左圆头不动，中间那片横向缩放，右圆头平移，整块平移 —— 全是 transform，圆头不变形 */
  function setBackground(x: number, y: number, w: number, h: number, animate: boolean) {
    const inner = Math.max(0, w - 2 * TIP.cap + 2);
    bg.style.height = `${h}px`;
    moveTo(bg, `translate(${x}px, ${y}px)`, animate);
    moveTo(middle, `scaleX(${inner / TIP.cap})`, animate);
    moveTo(capRight, `translateX(${w - TIP.cap}px)`, animate);
  }

  function describe(element: HTMLElement, content: TipContent) {
    undescribe();
    const label = element.getAttribute("aria-label");
    const extra = !content.overflow && (content.kbd || content.detail || content.text !== label);
    root.setAttribute("aria-hidden", extra ? "false" : "true");
    if (!extra) return;
    const original = element.getAttribute("aria-describedby");
    described = { element, original };
    element.setAttribute("aria-describedby", original ? `${original} ${TIP_ID}` : TIP_ID);
  }

  function undescribe() {
    if (!described) return;
    const { element, original } = described;
    described = null;
    if (original === null) element.removeAttribute("aria-describedby");
    else element.setAttribute("aria-describedby", original);
  }

  function show(element: HTMLElement, instant: boolean) {
    clearOpen();
    clearHide();
    if (!element.isConnected) return;
    const content = tipContent(element);
    if (!content) {
      // 移到一个不用出的（没被截断的标题）：前一个也该收了
      if (shown) hide(false);
      return;
    }
    const reduce = reduced() || !canAnimate;
    const layer = makeText(content, element.getAttribute("aria-label"));
    layer.style.opacity = "0";
    root.append(layer);
    // 一次排版里读完：目标的位置、字的大小
    const anchor = element.getBoundingClientRect();
    if (repeatsVisibleText(element, content)) {
      layer.remove();
      if (shown) hide(false);
      return;
    }
    let size = layer.getBoundingClientRect();
    if (size.width > TIP.maxWidth) {
      layer.classList.add("is-wrapped");
      layer.style.width = `${TIP.maxWidth}px`;
      size = layer.getBoundingClientRect();
    }
    const ratio = dpr();
    const w = snapUp(size.width, ratio);
    const h = snapUp(size.height, ratio);
    const side = (element.getAttribute("data-tip-side") as TipSide | null) ?? "bottom";
    const { x, y } = placeBeside(
      anchor,
      { width: w, height: h },
      side in OPPOSITE ? side : "bottom",
      { width: win.innerWidth, height: win.innerHeight, dpr: ratio },
    );
    layer.style.transform = `translate(${x}px, ${y}px)`;

    // 正在淡出又要出：停掉淡出，从当时的透明度接着回到 1
    let resumeFrom = 1;
    if (fadeOut) {
      resumeFrom = Number(win.getComputedStyle(root).opacity) || 0;
      fadeOut.cancel();
      fadeOut = null;
      clearTimeout(fadeFallback);
    }
    const near = last !== null && Math.hypot(x - last.x, y - last.y) < TIP.near;
    const glide = visible && near && !reduce;
    setBackground(x, y, w, h, glide);
    last = { x, y };

    const previous = text;
    text = layer;
    if (previous) {
      previous.setAttribute("aria-hidden", "true");
      if (glide) {
        const out = previous.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: TIP.textOut,
          easing: "ease-out",
          fill: "forwards",
        });
        out.finished.then(
          () => previous.remove(),
          () => previous.remove(),
        );
      } else previous.remove();
    }
    // 别的残层（连着换了好几次，前面的还在淡）：留着它们自己淡完
    layer.style.opacity = "1";
    if (glide) {
      layer.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: TIP.fadeIn,
        delay: TIP.textDelay,
        easing: "ease-out",
        fill: "backwards",
      });
    }

    if (!visible || resumeFrom < 1) {
      root.style.opacity = "1";
      const from = visible ? resumeFrom : 0;
      if (!reduce && !(instant && !visible)) {
        root.animate([{ opacity: from }, { opacity: 1 }], {
          duration: TIP.fadeIn * (1 - from),
          easing: EASE_OUT_QUINT,
        });
      }
      visible = true;
    }

    if (shown !== element) {
      observer.disconnect();
      observer.observe(element, { attributes: true, attributeFilter: CONTENT_ATTRS });
      observer.observe(doc.body, { childList: true, subtree: true });
    }
    shown = element;
    root.dataset.state = "shown";
    describe(element, content);
  }

  function finishHide() {
    clearTimeout(fadeFallback);
    fadeOut = null;
    if (shown) return;
    visible = false;
    root.dataset.state = "hidden";
    root.style.opacity = "0";
    root.setAttribute("aria-hidden", "true");
    for (const layer of root.querySelectorAll(".odea-tip-txt")) layer.remove();
    text = null;
  }

  function hide(immediately: boolean) {
    clearOpen();
    clearHide();
    if (!shown) {
      // 正在淡出时按了 Esc、滚了：直接收完
      if (immediately && fadeOut) {
        fadeOut.cancel();
        finishHide();
      }
      return;
    }
    shown = null;
    lastHidden = now();
    observer.disconnect();
    undescribe();
    if (immediately || reduced() || !canAnimate) {
      fadeOut?.cancel();
      finishHide();
      return;
    }
    const animation = root.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: TIP.fadeOut,
      easing: "ease-out",
    });
    fadeOut = animation;
    root.dataset.state = "hiding";
    animation.finished.then(
      () => {
        if (fadeOut === animation) finishHide();
      },
      () => {},
    );
    // 窗口藏着、动画不走帧：兜底收掉。留足余量，主线程忙的那一下动画晚开始也不会被拦腰截断
    fadeFallback = setTimeout(() => {
      if (fadeOut === animation) {
        animation.cancel();
        finishHide();
      }
    }, TIP.fadeOut + 400);
  }

  const onOver = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    if (root.contains(event.target as Node)) {
      clearHide();
      return;
    }
    const element = triggerOf(event.target);
    if (!element) {
      // 移进了里面一个出悬停卡片的：和移出去一样
      if (target?.contains(event.target as Node)) leave();
      return;
    }
    if (element === target) {
      clearHide();
      return;
    }
    target = element;
    clearOpen();
    clearHide();
    if (suppressed && suppressed !== element) suppressed = null;
    if (suppressed === element) return;
    const warm = shown !== null || now() - lastHidden < TIP.warm;
    if (warm) show(element, true);
    else
      openTimer = setTimeout(() => {
        openTimer = undefined;
        if (target === element) show(element, false);
      }, TIP.openDelay);
  };

  const onOut = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    const fromTip = root.contains(event.target as Node);
    const element = fromTip ? null : triggerOf(event.target);
    if (!fromTip && !element) return;
    const to = event.relatedTarget as Node | null;
    if (to && (root.contains(to) || element?.contains(to) || target?.contains(to))) return;
    // 直接移到下一个：pointerover 接手
    if (triggerOf(to)) return;
    if (element && element === suppressed) suppressed = null;
    leave();
  };

  /** 鼠标离开了目标：还没出的不出了，出着的留一会儿（能移到提示上） */
  function leave() {
    target = null;
    clearOpen();
    if (shown) {
      clearHide();
      hideTimer = setTimeout(() => hide(false), TIP.grace);
    }
  }

  const onDown = (event: PointerEvent) => {
    const element = triggerOf(event.target);
    if (element) suppressed = element;
    hide(true);
  };

  const onKey = (event: KeyboardEvent) => {
    // 不拦：Esc 照常往下传（关对话框、退出选择）
    if (event.key === "Escape") hide(true);
  };

  const onScroll = (event: Event) => {
    if (!shown && !openTimer) return;
    // 滚的是目标所在的那一层（或整页）才收：别处在自己滚（同步时正文跟着动），不碍事
    const scrolled = event.target as Node | null;
    const anchor = shown ?? target;
    if (scrolled === doc || (anchor && scrolled?.contains?.(anchor))) {
      target = null;
      hide(true);
    }
  };

  const onBlur = () => {
    target = null;
    hide(true);
  };

  const onFocusIn = (event: FocusEvent) => {
    const element = event.target as HTMLElement | null;
    if (!element?.matches?.(SELECTOR)) return;
    // 输入框一聚焦就算 :focus-visible（规范如此），鼠标点进去也会出：不在聚焦时出
    if (element.matches("input, textarea, [contenteditable]")) return;
    let keyboard = false;
    try {
      keyboard = element.matches(":focus-visible");
    } catch {
      keyboard = false;
    }
    // 鼠标点出来的焦点不出
    if (!keyboard) return;
    target = element;
    show(element, false);
  };

  const onFocusOut = (event: FocusEvent) => {
    if (event.target === shown) {
      target = null;
      hide(false);
    }
  };

  doc.addEventListener("pointerover", onOver);
  doc.addEventListener("pointerout", onOut);
  doc.addEventListener("pointerdown", onDown, true);
  doc.addEventListener("focusin", onFocusIn);
  doc.addEventListener("focusout", onFocusOut);
  win.addEventListener("keydown", onKey, true);
  win.addEventListener("scroll", onScroll, true);
  win.addEventListener("blur", onBlur);

  const uninstall = () => {
    installed.delete(win);
    clearOpen();
    clearHide();
    clearTimeout(fadeFallback);
    observer.disconnect();
    undescribe();
    doc.removeEventListener("pointerover", onOver);
    doc.removeEventListener("pointerout", onOut);
    doc.removeEventListener("pointerdown", onDown, true);
    doc.removeEventListener("focusin", onFocusIn);
    doc.removeEventListener("focusout", onFocusOut);
    win.removeEventListener("keydown", onKey, true);
    win.removeEventListener("scroll", onScroll, true);
    win.removeEventListener("blur", onBlur);
    root.remove();
  };
  installed.set(win, uninstall);
  return uninstall;
}
