import { snapToDevicePixels } from "@/lib/devicePixels";
import { motionReduced } from "./animatedEmoji";

/* ============================================================
   查看大图：正文里那张图原地放大到屏幕中间，背后的页面磨砂、淡下去；
   点图片外面、按 Esc、点右上角的关闭，原路缩回正文里那个位置。

   飞出、飞回用 FLIP：先按终点摆好，再用 transform 从起点的位置、大小倒放过去。
   放大的是一份复制出来的 <img>，正文里那张在这期间藏起来（visibility，不占位的
   变化一概没有），飞回去落定了再露出来 —— 看起来就是同一张图飞出去又飞回来。

   打开以后能缩放：滚轮 / 触控板捏合（以鼠标为中心）、双击在「适应屏幕」和 100% 之间
   切换、`+` `-` `0`，底部的缩放条也行；放大了按住拖动。缩放改的是图片的 left / top /
   width / height 而不是 transform —— transform 缩放是把一张位图拉伸，放大时发虚，
   停下来那一帧再按新尺寸重画、清楚一下（docs/技术方案.md §10.1 第 4 条）；直接改尺寸
   每一帧都是按当时的大小画的。一个 fixed 的元素，改尺寸不牵动别的排版。
   缩放朝目标值指数逼近（对数空间里），连续滚动时一路跟着、不顿。
   ============================================================ */

/** 离屏幕四边至少留这么多（适应屏幕时） */
const MARGIN = 48;
/** 放大以后拖到边上，最多露出这么多空白 */
const PAN_MARGIN = 24;
const OPEN_MS = 380;
const CLOSE_MS = 300;
const EASE_OPEN = "cubic-bezier(0.22, 1, 0.36, 1)";
const EASE_CLOSE = "cubic-bezier(0.32, 0.72, 0, 1)";
/** 缩放跟手的快慢：每过这么多毫秒，离目标的距离（对数上）剩 1/e */
const ZOOM_LAG_MS = 70;
/** 按键、缩放条上的按钮每次放大 / 缩小的倍数 */
const STEP = 1.5;

const MINUS_ICON = "M5 12h14";
const PLUS_ICON = "M5 12h14M12 5v14";
const CLOSE_ICON = "M18 6L6 18M6 6l12 12";

let open: { close: () => Promise<void> } | null = null;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 从 rect 倒放到 box 用的 transform（transform-origin 在左上角）：按宽度等比缩放，竖直方向对中 */
function flipFrom(rect: Box, box: Box) {
  const scale = rect.width / box.width;
  const dx = rect.left - box.left;
  const dy = rect.top + rect.height / 2 - (box.top + (box.height * scale) / 2);
  return `translate(${dx}px, ${dy}px) scale(${scale})`;
}

function icon(d: string): SVGSVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "2");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  node.append(path);
  return node;
}

function button(label: string, content: Node | string, run: () => void, className = "") {
  const node = document.createElement("button");
  node.type = "button";
  node.className = `otw-image-viewer-button ${className}`.trim();
  node.title = label;
  node.setAttribute("aria-label", label);
  node.append(content);
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    run();
  });
  return node;
}

export function openImageViewer(source: HTMLImageElement): void {
  if (open || !source.isConnected) return;
  const doc = source.ownerDocument;
  const win = doc.defaultView;
  const from = source.getBoundingClientRect();
  if (!win || !from.width || !from.height) return;
  const reduce = motionReduced();
  const naturalWidth = source.naturalWidth || from.width;
  const naturalHeight = source.naturalHeight || from.height;

  /* ---------- 缩放的几何：z 是相对原图的倍数，(x, y) 是图片左上角在屏幕上的位置 ---------- */

  /** 适应屏幕：按原图尺寸缩进屏幕，至少和正文里一样大，小图不放大到糊 */
  const fitZoom = () =>
    Math.min(
      (win.innerWidth - MARGIN * 2) / naturalWidth,
      (win.innerHeight - MARGIN * 2) / naturalHeight,
      Math.max(1, from.width / naturalWidth),
    );
  let base = fitZoom();
  const minZoom = () => base / 2;
  const maxZoom = () => Math.max(8, base * 4);
  const clampZoom = (value: number) => Math.min(maxZoom(), Math.max(minZoom(), value));
  /** 比屏幕小的方向居中；比屏幕大的方向夹住，边上最多露 PAN_MARGIN 的空白 */
  const clampAxis = (position: number, size: number, viewport: number) =>
    size + PAN_MARGIN * 2 <= viewport
      ? (viewport - size) / 2
      : Math.min(PAN_MARGIN, Math.max(viewport - PAN_MARGIN - size, position));

  let z = base;
  let x = (win.innerWidth - naturalWidth * z) / 2;
  let y = (win.innerHeight - naturalHeight * z) / 2;
  let target = z;
  /** 这一次缩放钉住的点：屏幕上的位置、图片上的位置（按原图像素算） */
  let anchor: { sx: number; sy: number; ix: number; iy: number } | null = null;
  let frame = 0;
  let last = 0;

  const overlay = doc.createElement("div");
  overlay.className = "otw-image-viewer";
  overlay.tabIndex = -1;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", source.alt ? `查看图片：${source.alt}` : "查看图片");
  const backdrop = doc.createElement("div");
  backdrop.className = "otw-image-viewer-backdrop";
  const image = doc.createElement("img");
  image.className = "otw-image-viewer-image";
  image.src = source.currentSrc || source.src;
  image.alt = source.alt;
  image.draggable = false;

  const zoomOut = button("缩小（-）", icon(MINUS_ICON), () => stepZoom(1 / STEP));
  const zoomIn = button("放大（+）", icon(PLUS_ICON), () => stepZoom(STEP));
  const level = button("适应屏幕 / 原始大小（双击图片）", "", () => toggleZoom(), "is-zoom");
  const bar = doc.createElement("div");
  bar.className = "otw-image-viewer-bar";
  bar.append(zoomOut, level, zoomIn);
  const closer = doc.createElement("div");
  closer.className = "otw-image-viewer-close";
  closer.append(button("关闭（Esc）", icon(CLOSE_ICON), () => close()));

  const box = (): Box => ({
    left: x,
    top: y,
    width: naturalWidth * z,
    height: naturalHeight * z,
  });
  const paint = () => {
    const { left, top, width, height } = box();
    image.style.left = `${left}px`;
    image.style.top = `${top}px`;
    image.style.width = `${width}px`;
    image.style.height = `${height}px`;
    image.classList.toggle(
      "is-pannable",
      width + PAN_MARGIN * 2 > win.innerWidth || height + PAN_MARGIN * 2 > win.innerHeight,
    );
    level.textContent = `${Math.round(z * 100)}%`;
    zoomOut.disabled = target <= minZoom() + 1e-6;
    zoomIn.disabled = target >= maxZoom() - 1e-6;
  };
  const place = () => {
    x = clampAxis(x, naturalWidth * z, win.innerWidth);
    y = clampAxis(y, naturalHeight * z, win.innerHeight);
  };

  const tick = (now: number) => {
    const elapsed = last ? now - last : 16;
    last = now;
    const k = reduce ? 1 : 1 - Math.exp(-elapsed / ZOOM_LAG_MS);
    z = Math.exp(Math.log(z) + (Math.log(target) - Math.log(z)) * k);
    if (Math.abs(Math.log(target / z)) < 0.002) z = target;
    if (anchor) {
      x = anchor.sx - anchor.ix * z;
      y = anchor.sy - anchor.iy * z;
    }
    place();
    paint();
    if (z !== target) frame = requestAnimationFrame(tick);
    else {
      frame = 0;
      anchor = null;
    }
  };
  /** 缩放到 value 倍，屏幕上的 (sx, sy) 那一点钉住不动 */
  const zoomTo = (value: number, sx = win.innerWidth / 2, sy = win.innerHeight / 2) => {
    target = clampZoom(value);
    anchor = { sx, sy, ix: (sx - x) / z, iy: (sy - y) / z };
    if (!frame) {
      last = 0;
      frame = requestAnimationFrame(tick);
    }
  };
  const stepZoom = (factor: number) => zoomTo(target * factor);
  /** 适应屏幕和 100% 之间来回；原图本来就比屏幕小时，在适应屏幕和两倍之间 */
  const toggleZoom = (sx?: number, sy?: number) => {
    const full = Math.abs(base - 1) < 0.01 ? 2 : 1;
    zoomTo(Math.abs(target - base) < 0.01 ? full : base, sx, sy);
  };

  /* ---------- 挂上去，飞出来 ---------- */

  paint();
  overlay.append(backdrop, image, bar, closer);
  doc.body.append(overlay);
  // 焦点放到浮层上：不然按键还会打进背后的正文里。关的时候还回去
  const previous = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
  overlay.focus({ preventScroll: true });
  source.classList.add("is-viewing");
  // 缩放条、关闭按钮要淡入：先对齐到整物理像素，淡完不闪（lib/devicePixels.ts）
  snapToDevicePixels(bar);
  snapToDevicePixels(closer);

  image.animate([{ transform: flipFrom(from, box()) }, { transform: "none" }], {
    duration: reduce ? 0 : OPEN_MS,
    easing: EASE_OPEN,
  });
  for (const layer of [backdrop, bar, closer]) {
    layer.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: reduce ? 0 : OPEN_MS * 0.7,
      easing: "ease-out",
      fill: "both",
    });
  }

  /* ---------- 操作 ---------- */

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    // 鼠标滚轮一格约 100：缩 0.86 倍；触控板捏合（ctrlKey）一次只有几，要灵敏些
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
    const speed = event.ctrlKey ? 0.01 : 0.0015;
    zoomTo(target * Math.exp(-delta * speed), event.clientX, event.clientY);
  };
  let drag: { id: number; startX: number; startY: number; x: number; y: number } | null = null;
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !image.classList.contains("is-pannable")) return;
    event.preventDefault();
    drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x, y };
    image.setPointerCapture(event.pointerId);
    image.classList.add("is-panning");
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    // 拖动接管位置：还在跑的缩放停在当前倍数
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
      target = z;
      anchor = null;
    }
    x = drag.x + event.clientX - drag.startX;
    y = drag.y + event.clientY - drag.startY;
    place();
    paint();
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    image.classList.remove("is-panning");
  };
  const onDoubleClick = (event: MouseEvent) => {
    event.preventDefault();
    toggleZoom(event.clientX, event.clientY);
  };
  const onKey = (event: KeyboardEvent) => {
    event.stopPropagation();
    const handled = (() => {
      if (event.key === "Escape") close();
      else if (event.key === "+" || event.key === "=") stepZoom(STEP);
      else if (event.key === "-" || event.key === "_") stepZoom(1 / STEP);
      else if (event.key === "0") zoomTo(base);
      else return false;
      return true;
    })();
    if (handled) event.preventDefault();
  };
  /** 窗口变了：适应屏幕的倍数重算；本来就是适应屏幕的，跟着变 */
  const onResize = () => {
    const wasFit = Math.abs(target - base) < 0.01;
    base = fitZoom();
    if (wasFit) {
      z = target = base;
      x = (win.innerWidth - naturalWidth * z) / 2;
      y = (win.innerHeight - naturalHeight * z) / 2;
    }
    place();
    paint();
  };

  backdrop.addEventListener("click", () => close());
  overlay.addEventListener("wheel", onWheel, { passive: false });
  image.addEventListener("pointerdown", onPointerDown);
  image.addEventListener("pointermove", onPointerMove);
  image.addEventListener("pointerup", onPointerUp);
  image.addEventListener("pointercancel", onPointerUp);
  image.addEventListener("dblclick", onDoubleClick);
  doc.addEventListener("keydown", onKey, true);
  win.addEventListener("resize", onResize);

  /* ---------- 飞回去 ---------- */

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing) return closing;
    if (frame) cancelAnimationFrame(frame);
    doc.removeEventListener("keydown", onKey, true);
    win.removeEventListener("resize", onResize);
    overlay.style.pointerEvents = "none";
    // 缩放过，缩放条的宽度（百分比的位数）可能变了：淡出前再对齐一次
    snapToDevicePixels(bar);
    // 飞回正文里它现在的位置（打开期间可能滚动过、换过行）；它已经不在了就原地淡出
    const back = source.isConnected ? source.getBoundingClientRect() : null;
    const flying =
      back?.width && back.height
        ? image.animate([{ transform: "none" }, { transform: flipFrom(back, box()) }], {
            duration: reduce ? 0 : CLOSE_MS,
            easing: EASE_CLOSE,
            fill: "forwards",
          })
        : image.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: reduce ? 0 : CLOSE_MS,
            fill: "forwards",
          });
    const fading = [backdrop, bar, closer].map((layer) =>
      layer.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: reduce ? 0 : CLOSE_MS * 0.8,
        easing: "ease-in",
        fill: "forwards",
      }),
    );
    const done = () => {
      source.classList.remove("is-viewing");
      overlay.remove();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      open = null;
    };
    closing = Promise.all([flying.finished, ...fading.map((animation) => animation.finished)]).then(
      done,
      done,
    );
    return closing;
  };
  open = { close };
}

/** 关掉开着的大图；飞回去落定了 resolve（测试用） */
export function closeImageViewer(): Promise<void> {
  return open?.close() ?? Promise.resolve();
}
