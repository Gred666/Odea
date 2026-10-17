import { type RefObject, useEffect, useRef } from "react";

/** 停止滚动后多久淡出 */
const HIDE_DELAY = 1000;
/** 滑块最短高度：文档很长时按比例算会只剩几个像素，抓都抓不住 */
const MIN_THUMB = 28;
/** 文档高度跟随的时间常数，越大越黏。90ms 大约 250ms 收敛完 */
const EASE_TAU = 90;

/**
 * 覆盖式滚动条：滚动时淡入，停下 1 秒后淡出。
 *
 * 为什么是自己画而不是改原生滚动条：
 * - Chromium 只要设了 scrollbar-width，::-webkit-scrollbar 那套就整个失效，
 *   两套样式系统只能二选一；
 * - 而想让它不占布局（Windows 上原生滚动条占 10px，文档一过一屏正文就整体左移），
 *   就必须用 scrollbar-width: none —— 于是没法再用伪元素做淡入淡出；
 * - 标准属性 scrollbar-color 在 Chromium 上又不参与 transition。
 *
 * ★ 长文档的坑：scrollHeight 在滚动过程中是会变的。
 *   CodeMirror 按视口渲染，没渲染到的行只有估算高度，滚过去测到真实高度才回填。
 *   实测一篇 400 段的文档往下滚，scrollHeight 从 17846 一路涨到 22286（+25%）。
 *   照着它每帧重算，滑块就会边滚边缩、位置还往回跳。
 *
 *   解法是「平滑跟随」而不是「离散校正」：真实高度随便跳，用于绘制的那个值
 *   每帧朝它指数缓动过去。滑块于是一直在连续地缩，而不是走楼梯。
 *
 *   之前试过「滚动中冻结、停下再校正一次」，不行 —— 滚轮每一格之间的间隔
 *   往往就超过空闲阈值，一次连续滚动会被切成好几段，楼梯照走；而且校正用的
 *   CSS transition 还没跑完就又开始滚，transform 带着过渡会追不上滚动位置。
 *   缩放动画交给这里每帧算，CSS 就只管透明度。
 */
export function OverlayScrollbar({ targetRef }: { targetRef: RefObject<HTMLElement | null> }) {
  const thumbRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scroller = targetRef.current;
    const thumb = thumbRef.current;
    if (!scroller || !thumb) return;

    let raf = 0;
    let hideTimer = 0;
    let dragging = false;
    let hovering = false;
    let visible = false;

    /** ResizeObserver 说文档高度变了，下一帧重新量 */
    let stale = true;
    /** 最近一次实测的文档高度 */
    let docH = 0;
    /** 实际用于绘制的文档高度，每帧朝 docH 缓动 */
    let shownH = 0;
    let lastTime = 0;

    // 上一次真正写进 DOM 的值，用来跳过重复写入
    let lastY = -1;
    let lastThumbH = -1;

    const setVisible = (next: boolean) => {
      if (visible === next) return;
      visible = next;
      thumb.dataset.visible = String(next);
    };

    /** 这是整个组件唯一读 scrollHeight 的地方，且只在 rAF 里、且只在标记为脏时。 */
    const measure = () => {
      stale = false;
      docH = Math.max(scroller.scrollHeight, scroller.clientHeight);
    };

    const frame = (now: number) => {
      raf = 0;
      if (stale) measure();

      // 滑块看不见的时候不需要动画：换文档、改窗口大小都属于这类，直接对齐，
      // 否则每次切笔记都要看它慢慢缩一次
      if (!visible) {
        shownH = docH;
      } else {
        const dt = lastTime ? Math.min(64, now - lastTime) : 16;
        // 指数缓动，跟帧率无关：120Hz 和 60Hz 收敛时间一致
        shownH += (docH - shownH) * (1 - Math.exp(-dt / EASE_TAU));
      }
      lastTime = now;

      const clientH = scroller.clientHeight;
      const range = docH - clientH; // 位置比例要用真实值，否则滚到底滑块到不了底
      if (range <= 1) {
        setVisible(false);
        return;
      }

      // 高度和行程用缓动值 —— 缩放动画就在这里
      const thumbH = Math.max(MIN_THUMB, Math.round((clientH / shownH) * clientH));
      const travel = clientH - thumbH;
      const y = Math.round(Math.min(1, Math.max(0, scroller.scrollTop / range)) * travel);

      // 取整之后大部分帧和上一帧同值，跳过写入就没有多余的样式重算
      if (y !== lastY) {
        thumb.style.transform = `translateY(${y}px)`;
        lastY = y;
      }
      if (thumbH !== lastThumbH) {
        thumb.style.height = `${thumbH}px`;
        lastThumbH = thumbH;
      }

      // 还没追上就继续跑，直到收敛
      if (Math.abs(docH - shownH) > 0.5) schedule();
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };

    const hideSoon = () => {
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        // 正在拖、或者鼠标停在滑块上（准备去拖）时不能收
        if (!dragging && !hovering) setVisible(false);
      }, HIDE_DELAY);
    };

    /* ---- 滚动 ----
       这里绝对不能读布局。之前在这个回调里同步调过一次绘制，
       等于每个滚动事件都强制同步布局一次，而 CodeMirror 那边正在重新测量行高，
       代价极高。现在只排一帧，所有读写都在 rAF 里。 */
    const onScroll = () => {
      setVisible(true);
      schedule();
      hideSoon();
    };

    /* ---- 拖拽 ---- */
    const onPointerDown = (e: PointerEvent) => {
      e.preventDefault();
      if (stale) measure();
      dragging = true;
      thumb.setPointerCapture(e.pointerId);

      const startY = e.clientY;
      const startTop = scroller.scrollTop;
      const clientH = scroller.clientHeight;
      // 拖拽换算用实测值，不用缓动值 —— 拖到哪就该是哪，不能有橡皮筋感
      const range = docH - clientH;
      const travel = clientH - Math.max(MIN_THUMB, Math.round((clientH / docH) * clientH));

      const onMove = (move: PointerEvent) => {
        if (travel <= 0) return;
        scroller.scrollTop = startTop + ((move.clientY - startY) / travel) * range;
      };
      const onUp = (up: PointerEvent) => {
        dragging = false;
        thumb.releasePointerCapture(up.pointerId);
        thumb.removeEventListener("pointermove", onMove);
        thumb.removeEventListener("pointerup", onUp);
        hideSoon();
      };
      thumb.addEventListener("pointermove", onMove);
      thumb.addEventListener("pointerup", onUp);
    };

    const onEnter = () => {
      hovering = true;
      window.clearTimeout(hideTimer);
    };
    const onLeave = () => {
      hovering = false;
      hideSoon();
    };

    scroller.addEventListener("scroll", onScroll, { passive: true });
    thumb.addEventListener("pointerdown", onPointerDown);
    thumb.addEventListener("pointerenter", onEnter);
    thumb.addEventListener("pointerleave", onLeave);

    // 换文档、窗口缩放、CodeMirror 回填行高都会走到这里。只标记，测量留给下一帧。
    const observer = new ResizeObserver(() => {
      stale = true;
      schedule();
    });
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);

    schedule();

    return () => {
      window.clearTimeout(hideTimer);
      cancelAnimationFrame(raf);
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      thumb.removeEventListener("pointerdown", onPointerDown);
      thumb.removeEventListener("pointerenter", onEnter);
      thumb.removeEventListener("pointerleave", onLeave);
    };
  }, [targetRef]);

  return (
    <div
      ref={thumbRef}
      data-visible="false"
      aria-hidden="true"
      className="odea-scroll-thumb absolute right-[3px] top-0 w-[5px] rounded-full"
    />
  );
}
