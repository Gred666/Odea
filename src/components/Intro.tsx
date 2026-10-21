import { landIntro, useIntro } from "@/app/intro";
import { animate, motion, useMotionValue, useMotionValueEvent, useTransform } from "motion/react";
import type { AnimationPlaybackControls } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  DOT,
  DOT_IN,
  LOGO_VIEWBOX,
  MARK_SHIFT,
  O_CENTER,
  O_HEIGHT,
  STROKES,
  STROKE_WIDTH,
} from "./logoGeometry";

/* ============================================================
   开场：起笔一点，然后归位。

   双击的是任务栏上那个「O」，开场就从它开始：
   1. 窗口出来是一张纸（导航栏的底色）。正中先落下一滴蓝 —— 一个想法
      （和应用图标、收起后的导航栏同一个点）
   2. 笔从它旁边起笔，逆时针绕一圈写出手写的「O」，停在缺口另一头
      （和字标同一条路径、同一条书写曲线）
   3. 带着蓝点滑向左上角、一路缩小，落在侧栏字标的「O」上；纸同时淡开，露出早就排好的界面
   4. 落地那一帧交给侧栏的 Logo（Logo.tsx）：展开着就从 d 接着写；
      收起着就停成收起时的样子

   界面本身一下都不动：字不缩放、不位移，只是盖在上面的纸在淡（技术方案 §10.1）。
   「O」是矢量，每一帧按当时的大小重画（动的是 svg 的位置和宽高，不是 transform），
   缩小的一路上都是清楚的，落地时和侧栏那份逐像素重合。

   冷启动才播，减少动效时不播（app/intro.ts）。中途点一下、按任意键：快进到位。
   ============================================================ */

/**
 * 落笔之前先等主线程静下来：窗口刚出来的头一两百毫秒，刚到的数据（今天那一篇之类）让整棵树
 * 重画一两遍 —— 正常机器上各几十毫秒，慢机器上几百毫秒，正好卡在笔画的头几帧。
 * 连着 QUIET_FRAMES 帧都在 QUIET_FRAME 以内才开始，最多等 QUIET_MAX（纸是空白的，等这一下看不出来）
 */
const QUIET_FRAME = 24;
const QUIET_FRAMES = 4;
const QUIET_MAX = 500;
/** 静下来以后再停一小下，蓝点先落下来 */
const DOT_AT = 0.04;
/** 蓝点快落定了，笔从它旁边起笔 */
const WRITE_AT = 0.3;
/** 写那一圈：和字标每一笔同一条曲线（globals.css 的 odea-logo-write） */
const WRITE = 0.5;
const WRITE_EASE = [0.45, 0.05, 0.35, 1] as const;
/** 写完停一拍，再走 */
const GLIDE_AT = WRITE_AT + WRITE + 0.18;
const GLIDE = 0.52;
/**
 * 三个方向各一条曲线，走出一道弧：先抬起来（y 领先），再横着滑过去（x），
 * 个头最后才缩（scale 落后）—— 像把它拎起来、放回原处，而不是沿直线缩过去
 */
const GLIDE_EASE_Y = [0.35, 0, 0.1, 1] as const;
const GLIDE_EASE_X = [0.5, 0, 0.12, 1] as const;
const GLIDE_EASE_SCALE = [0.6, 0, 0.12, 1] as const;
/** 纸淡开：在「O」落地之前就淡完，它是落在已经露出来的界面上 */
const FADE_AT = GLIDE_AT + 0.06;
const FADE = 0.38;
const FADE_EASE = [0.4, 0, 0.2, 1] as const;
/** 快进（中途点了 / 按了键）：剩下的一口气走完 */
const SKIP = 0.26;

/** 开场时「O」有多高：窗口高的 8.5%（64–96px），光学上的中心比几何中心略高一点 */
const startHeight = () => Math.min(96, Math.max(64, window.innerHeight * 0.085));
const START_Y = 0.46;
/**
 * 侧栏 Logo 的比例（每个 viewBox 单位多少 px），出发时按实际量到的覆盖。
 * Logo 的 svg 是 68×38 的盒子装 138.68×78 的 viewBox，默认等比适配（meet）：起作用的是
 * 高（38/78），不是宽（68/138.68），横向还居中留了 0.22px。以前按宽算，落点差 0.2px，
 * 交接那一帧笔画边缘闪一下
 */
const LOGO_SCALE = Math.min(68 / LOGO_VIEWBOX.w, 38 / LOGO_VIEWBOX.h);
/**
 * 光学尺寸：大的时候笔画相对细一点、蓝点相对小一点（照字标原样放大，72px 高时笔画 8px，
 * 太笨），一路缩回去一路加粗，落地时正好是字标的 5 个单位 —— 和字体在大字号用细一点的字重一个道理
 */
const START_STROKE = 3.8;
const START_DOT_R = 3.1;

export function Intro() {
  const phase = useIntro((s) => s.phase);
  const shown = useIntro((s) => s.shown);
  // 落地以后元素再留两帧才卸（这边的「O」在落地那一帧就藏了，见下面的 useLayoutEffect）
  const [gone, setGone] = useState(false);

  // 窄栏上的 Logo 是收起后的样子（整体往左挪了一点），开场全程带着这个偏移，落地才对得上
  const shiftU = MARK_SHIFT;

  const [startScale] = useState(() => startHeight() / O_HEIGHT);
  const tail = useMotionValue(0);
  const dot = useMotionValue(0);
  const scale = useMotionValue(startScale);
  const cx = useMotionValue(window.innerWidth / 2);
  const cy = useMotionValue(window.innerHeight * START_Y);
  const paper = useMotionValue(1);
  const endScale = useMotionValue(LOGO_SCALE);
  const markOpacity = useMotionValue(1);

  // 「O」摆在哪、多大：让它的中心落在 (cx, cy)，每个字标单位是 scale 个像素。
  // 动的是 svg 里面一层 <g> 的 transform 属性（亚像素、矢量重画），svg 盒子本身铺满窗口不动 ——
  // 动盒子的位置的话，浏览器把盒子对齐到整像素：滑到最后每帧不到 1px 时 O 一格一格地跳，
  // 落地时也对不上 Logo 里那 0.22px 的居中偏移
  const placement = useTransform(() => {
    const s = scale.get();
    const x = cx.get() - (O_CENTER.x + shiftU - LOGO_VIEWBOX.x) * s;
    const y = cy.get() - (O_CENTER.y - LOGO_VIEWBOX.y) * s;
    return `translate(${x} ${y}) scale(${s}) translate(${-LOGO_VIEWBOX.x} ${-LOGO_VIEWBOX.y})`;
  });
  const placed = useRef<SVGGElement>(null);
  useMotionValueEvent(placement, "change", (value) =>
    placed.current?.setAttribute("transform", value),
  );
  const dasharray = useTransform(() => `${Math.max(tail.get(), 0)} 2`);
  // 长度为 0 的一段，圆头笔帽会画出一个点：落笔之前整条藏起来
  const inkOpacity = useTransform(() => (tail.get() > 0.002 ? 1 : 0));
  // 缩回去走了几成：0 = 开场那么大，1 = 侧栏那么大。笔画和蓝点照它从「光学尺寸」过渡回原样
  const shrunk = useTransform(() =>
    Math.min(1, Math.max(0, (startScale - scale.get()) / (startScale - endScale.get()))),
  );
  const strokeWidth = useTransform(
    () => `${START_STROKE + (STROKE_WIDTH - START_STROKE) * shrunk.get()}px`,
  );
  // 蓝点长出来、缩回原样都改半径，不用 transform: scale —— 圆是矢量，每一帧按当时的大小重画
  //（CLAUDE.md 动效规矩 5）
  const dotR = useTransform(() => dot.get() * (START_DOT_R + (DOT.r - START_DOT_R) * shrunk.get()));
  const dotEl = useRef<SVGCircleElement>(null);
  useMotionValueEvent(dotR, "change", (value) =>
    dotEl.current?.setAttribute("r", `${Math.max(value, 0)}`),
  );

  const running = useRef<AnimationPlaybackControls[]>([]);
  const skipped = useRef(false);

  useEffect(() => {
    if (phase !== "cover" || !shown) return;

    /** 落点：侧栏 Logo 的 svg（和这里同一个 viewBox） */
    const target = () => {
      const logo = document.querySelector("[data-odea-logo]");
      const rect = logo?.getBoundingClientRect();
      if (!rect || rect.width === 0) return null;
      // 和浏览器画 Logo 一样：等比适配（取小的那个比例），多出来的那一边居中
      const s = Math.min(rect.width / LOGO_VIEWBOX.w, rect.height / LOGO_VIEWBOX.h);
      const left = rect.left + (rect.width - LOGO_VIEWBOX.w * s) / 2;
      const top = rect.top + (rect.height - LOGO_VIEWBOX.h * s) / 2;
      endScale.set(s);
      return {
        s,
        x: left + (O_CENTER.x + shiftU - LOGO_VIEWBOX.x) * s,
        y: top + (O_CENTER.y - LOGO_VIEWBOX.y) * s,
      };
    };

    const glide = (duration: number, delay: number) => {
      const to = target();
      if (!to) return [];
      return [
        animate(cy, to.y, { duration, delay, ease: GLIDE_EASE_Y }),
        animate(cx, to.x, { duration, delay, ease: GLIDE_EASE_X }),
        animate(scale, to.s, { duration, delay, ease: GLIDE_EASE_SCALE }),
      ];
    };

    let landed = false;
    const play = () => {
      const drop = animate(dot, 1, { ...DOT_IN, delay: DOT_AT });
      const write = animate(tail, 1, {
        duration: WRITE,
        delay: WRITE_AT,
        ease: WRITE_EASE,
      });
      const fade = animate(paper, 0, { duration: FADE, delay: FADE_AT, ease: FADE_EASE });
      // 落点要等到出发那一刻再量：那时候排版早就稳了
      const depart = animate(0, 1, { duration: GLIDE_AT });
      running.current = [drop, write, fade, depart];
      depart.then(() => {
        if (skipped.current) return;
        const moves = glide(GLIDE, 0);
        running.current.push(...moves);
        Promise.all(moves).then(() => {
          if (!skipped.current && !landed) {
            landed = true;
            landIntro();
          }
        });
      });
    };

    // 等主线程静下来再落笔（rAF 的时间戳：帧和帧之间真实隔了多久）
    let raf = 0;
    let first = 0;
    let last = 0;
    let calm = 0;
    const listen = (t: number) => {
      if (skipped.current) return;
      if (!first) first = t;
      else calm = t - last < QUIET_FRAME ? calm + 1 : 0;
      last = t;
      if (calm >= QUIET_FRAMES || t - first > QUIET_MAX) play();
      else raf = requestAnimationFrame(listen);
    };
    raf = requestAnimationFrame(listen);

    /** 快进：点了一下、按了个键 —— 不打断用户，剩下的一口气走完 */
    const skip = () => {
      if (skipped.current || landed) return;
      skipped.current = true;
      for (const c of running.current) c.stop();
      const quick = { duration: SKIP * 0.5, ease: "easeOut" } as const;
      const moves = [
        animate(dot, 1, quick),
        animate(tail, 1, quick),
        animate(paper, 0, { duration: SKIP * 0.8, ease: FADE_EASE }),
        ...glide(SKIP, 0),
      ];
      running.current = moves;
      Promise.all(moves).then(() => {
        landed = true;
        landIntro();
      });
    };
    window.addEventListener("pointerdown", skip, true);
    window.addEventListener("keydown", skip, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointerdown", skip, true);
      window.removeEventListener("keydown", skip, true);
      for (const c of running.current) c.stop();
    };
  }, [phase, shown, shiftU, tail, dot, scale, cx, cy, paper, endScale]);

  // 落地这一次提交里，Logo 在它的 useLayoutEffect 里把自己那份摆出来（motion value，下一帧上屏）；
  // 这边也在同一次提交里用 motion value 藏起来 —— 两边在同一帧换，不重叠、也不空一帧。
  // 以前这边多留两帧，两份重叠的那两帧笔画边缘被画两遍，亮了一下
  useLayoutEffect(() => {
    if (phase === "landed") markOpacity.set(0);
  }, [phase, markOpacity]);

  useEffect(() => {
    if (phase !== "landed") return;
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => setGone(true));
    });
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  if (phase === "off" || gone) return null;

  return (
    <div
      aria-hidden="true"
      data-ghost-skip
      className={
        phase === "cover" ? "fixed inset-0 z-[100]" : "pointer-events-none fixed inset-0 z-[100]"
      }
    >
      <motion.div className="absolute inset-0 bg-rail" style={{ opacity: paper }} />
      <motion.svg
        aria-hidden="true"
        className="absolute inset-0 h-full w-full overflow-visible text-ink"
        style={{ opacity: markOpacity }}
      >
        <g ref={placed} transform={placement.get()}>
          <g transform={`translate(${shiftU} 0)`}>
            <motion.path
              d={STROKES[0]}
              pathLength="1"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              style={{
                strokeWidth,
                strokeDasharray: dasharray,
                strokeDashoffset: 0,
                opacity: inkOpacity,
              }}
            />
            <circle ref={dotEl} cx={DOT.cx} cy={DOT.cy} r={0} className="fill-accent" />
          </g>
        </g>
      </motion.svg>
    </div>
  );
}
