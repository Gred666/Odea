import { useIntro } from "@/app/intro";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import type { MotionValue } from "motion/react";
import { useLayoutEffect, useRef } from "react";
import { DOT, LOGO_VIEWBOX_ATTR, MARK_SHIFT, STROKES, STROKE_WIDTH } from "./logoGeometry";

/**
 * 手写 Logo：起笔一点（design/logo/）。
 *
 * 缺口里那个蓝点一直在 —— 想法先有，字围着它写。展开时五段笔画按真实书写顺序一段段描出来
 * （stroke-dashoffset 1 → 0），整词停一拍，再沿同方向收回去，只剩蓝点停一会儿，再从头写，
 * 无限循环：字来了又走，那一点留着。
 *
 * 收起时只剩开口的「O」和蓝点，就是应用图标的样子。字标里的 O 本来就是开口的，所以不用变形：
 * - 收起：其余字母淡出；O 从字标此刻的笔迹接手（写到一半就从一半开始），写满，和蓝点一起
 *   往左挪到窄栏图标那一列的中线上
 * - 展开：挪回来，交还给字标，从「写好了」那一刻接着走
 * - 开场（Intro.tsx）：冷启动时这里先空着，开场写好的「O」和蓝点从窗口中间滑过来、落在这里，
 *   落地那一帧交给这里：收起着就停在那儿；展开着就接着写 d、e、a
 *
 * 两个 O 是两条 path：字标里那条跟着 CSS 循环，另一条（收起、开场落地用）由 motion value 驱动。
 * 同一时刻只显示一条，交接的那一帧两条的笔迹完全一样，所以没有交叉淡化 —— 交叉淡化两个
 * 一样的形状，中间那一下墨色会掉到七成五。
 *
 * 实现要点：
 * - pathLength="1" 把每段路径的长度归一化成 1，dasharray / dashoffset 就能直接写常数，
 *   省掉 JS 量 getTotalLength() 那一步，也不用等布局
 * - 描边走 currentColor，蓝点走 accent，暗色模式跟着 token 走
 * - 动的只有描边和 svg 里一层 <g> 的位移（矢量重画），没有不透明度、缩放的过渡
 *
 * 停止态（减少动效时）是「写完」而不是「没写」，见 globals.css 里的兜底。
 */

/** 单段笔画的描出时长占整轮的 9%，起笔间隔 0.22s，节奏见 globals.css。 */
const STEP = 0.22;
/**
 * 从这一刻接着写：整轮 6.6s 里，最后一笔 0.88s 起笔、1.47s 写完，第一笔 3.63s 开始收 ——
 * 2.4s 时五笔都在。导航栏展开时从这里开始，淡进来的是一个写好的完整 Logo，
 * 而不是停在收起那一刻、写到一半的样子
 */
const WRITTEN_AT = 2.4;
/** 开场落地时字标从这一刻接着写：d 正好起笔（O 的那一笔由落下来的那个「O」代替） */
const INTRO_LOOP_AT = STEP;
/** 字标自己的 O 写完的时刻（9% × 6.6s），开场落地后交回它不能早于这一刻 */
const O_WRITTEN_AT = 0.6;

/** 收起：和导航栏底板同一条缓入缓出，略早一点停 */
const MOTION_EASE = [0.4, 0, 0.2, 1] as const;
const OPEN_DURATION = 0.46;
/** 展开：要赶在字母淡进来（LABEL_IN 0.2s 起）前后挪回去，交还给字标 */
const CLOSE_DURATION = 0.3;

/**
 * 字标里那条 O 此刻画出来的区间 [起, 止]。它的 dasharray 是「1 3」：
 * dashoffset 为正 = 正在写，画出 [0, 1 - d]；为负 = 正在收，画出 [-d, 1]。
 * 一点都没画（整轮里那一段空白）时返回 null。
 */
function writtenInterval(path: SVGPathElement | null): [number, number] | null {
  if (!path) return [0, 1];
  const d = Number.parseFloat(getComputedStyle(path).strokeDashoffset) || 0;
  const [start, end] = d >= 0 ? [0, 1 - d] : [-d, 1];
  return end - start > 0.01 ? [start, end] : null;
}

export function Logo({
  collapsed,
  reduce,
  fade,
}: {
  collapsed: boolean;
  reduce: boolean;
  /** O 以外那几笔的不透明度（和导航文字同一个值） */
  fade: MotionValue<number>;
}) {
  // 开场还盖着的时候这里先空着：字标停在一笔没写的那一刻，接手用的 O 和蓝点都藏着
  const intro = useIntro((s) => s.phase);
  const covered = intro === "cover";
  const paused = collapsed || covered;

  // 停过一次之后再放开：笔画重新挂上，接着写 —— 展开时从「写好了」那一刻（淡进来的是完整的 Logo），
  // 开场落地时从 d 起笔那一刻。在渲染里算，不放进 effect：展开那一下不为它再多提交一次
  const resumes = useRef(0);
  const resumeAt = useRef(0);
  const wasPaused = useRef(paused);
  const wasCovered = useRef(covered);
  if (wasPaused.current && !paused) {
    resumes.current += 1;
    resumeAt.current = wasCovered.current ? INTRO_LOOP_AT : WRITTEN_AT;
  }
  wasPaused.current = paused;
  wasCovered.current = covered;
  const offset = resumes.current > 0 ? resumeAt.current : 0;

  // 接手用的 O 画出的区间、蓝点在不在、现在是不是字标自己的 O 在显示、往左挪了多少
  const head = useMotionValue(0);
  const tail = useMotionValue(collapsed && !covered ? 1 : 0);
  const dot = useMotionValue(covered ? 0 : 1);
  const live = useMotionValue(collapsed || covered ? 0 : 1);
  const shift = useMotionValue(collapsed ? MARK_SHIFT : 0);
  const dasharray = useTransform(() => `${Math.max(tail.get() - head.get(), 0)} 2`);
  const dashoffset = useTransform(() => -head.get());
  // 长度为 0 的一段，圆头笔帽会画出一个点：没东西可画时整条藏起来。
  // 三个值都要先读出来：这种写法只在第一次运行时收集依赖，用 && 短路的话
  // head / tail 就没订阅上（从一片空白开始写的那种收起，O 会一直不出来）
  const takeoverOpacity = useTransform(() => {
    const length = tail.get() - head.get();
    return live.get() === 0 && length > 0.002 ? 1 : 0;
  });

  const writtenO = useRef<SVGPathElement>(null);
  const first = useRef(true);
  const lastIntro = useRef(intro);

  useLayoutEffect(() => {
    const landing = lastIntro.current === "cover" && intro !== "cover";
    lastIntro.current = intro;
    if (first.current) {
      first.current = false;
      return;
    }
    if (intro === "cover") return;

    /** 挪回来、写满；不早于 handoffAt 秒交还给字标（它这时是写好的完整 O） */
    const handBack = (handoffAt: number) => {
      const tween = { duration: CLOSE_DURATION, ease: MOTION_EASE };
      let cancelled = false;
      const controls = [
        animate(head, 0, tween),
        animate(tail, 1, tween),
        animate(shift, 0, tween),
        // 只是等：走 motion 的时钟，和上面几条在同一条时间线上
        animate(0, 1, { duration: Math.max(handoffAt, CLOSE_DURATION) }),
      ];
      Promise.all(controls).then(() => {
        if (!cancelled) live.set(1);
      });
      return () => {
        cancelled = true;
        for (const c of controls) c.stop();
      };
    };

    if (landing) {
      // 开场那个「O」和蓝点落在这里了：先摆成它落地时的样子（和开场那份逐像素一样），
      // 这一帧开场那份撤掉，看不出换了人
      head.set(0);
      tail.set(1);
      dot.set(1);
      live.set(0);
      shift.set(collapsed ? MARK_SHIFT : 0);
      if (collapsed || reduce) return;
      // 展开着：字标刚从 INTRO_LOOP_AT 开始走，它自己的 O 要到 O_WRITTEN_AT 才写完 ——
      // 交回去不能早于那一刻，不然换上去的是写到一半的 O
      return handBack(O_WRITTEN_AT - INTRO_LOOP_AT);
    }

    if (reduce) {
      head.set(0);
      tail.set(1);
      dot.set(1);
      live.set(collapsed ? 0 : 1);
      shift.set(collapsed ? MARK_SHIFT : 0);
      return;
    }

    if (collapsed) {
      // 从字标此刻的笔迹接手（交接这一帧两条 O 一模一样）；上一次展开还没交回去就接着动
      if (live.get() === 1) {
        // 那一刻一笔都没有：从起笔那头顺着书写方向写出来
        const [start, end] = writtenInterval(writtenO.current) ?? [0, 0];
        head.set(start);
        tail.set(end);
        live.set(0);
      }
      const tween = { duration: OPEN_DURATION, ease: MOTION_EASE };
      const controls = [
        animate(head, 0, tween),
        animate(tail, 1, tween),
        animate(shift, MARK_SHIFT, tween),
      ];
      return () => {
        for (const c of controls) c.stop();
      };
    }

    // 展开：挪回去就交还给字标（它这时是写好的完整 O，见 WRITTEN_AT）
    return handBack(0);
  }, [collapsed, reduce, intro, head, tail, dot, live, shift]);

  const strokeTiming = (i: number) => ({
    animationDelay: `${(i * STEP - offset).toFixed(2)}s`,
    // 导航栏收起时停在那一帧（字母已经淡没了，O 交给了接手的那条）；
    // 开场盖着的时候停在一笔没写的那一刻
    animationPlayState: paused ? ("paused" as const) : undefined,
  });

  return (
    <svg
      viewBox={LOGO_VIEWBOX_ATTR}
      className="h-[38px] w-[68px] shrink-0 overflow-visible text-ink"
      role="img"
      aria-label="Odea"
      // 开场动画量这里的位置，让它的「O」落在这儿
      data-odea-logo=""
    >
      <g
        key={resumes.current}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* 字标的 O：只有它不跟着字母淡出 —— 收起时直接交给下面接手的那条 */}
        <motion.path
          ref={writtenO}
          d={STROKES[0]}
          pathLength="1"
          className="odea-logo-stroke"
          style={{ ...strokeTiming(0), opacity: live }}
        />
        <motion.g style={{ opacity: fade }}>
          {STROKES.slice(1).map((d, i) => (
            <path
              // 笔画顺序即身份，数组是常量、不会重排
              // biome-ignore lint/suspicious/noArrayIndexKey: 静态常量数组
              key={i}
              d={d}
              pathLength="1"
              className="odea-logo-stroke"
              style={strokeTiming(i + 1)}
            />
          ))}
        </motion.g>
      </g>
      {/* 接手用的 O 和蓝点：收起后整体往左挪一点，对上窄栏图标的中线 */}
      <motion.g style={{ x: shift }}>
        <motion.path
          d={STROKES[0]}
          pathLength="1"
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          style={{
            strokeDasharray: dasharray,
            strokeDashoffset: dashoffset,
            opacity: takeoverOpacity,
          }}
        />
        <motion.circle
          cx={DOT.cx}
          cy={DOT.cy}
          r={DOT.r}
          className="fill-accent"
          style={{ opacity: dot }}
        />
      </motion.g>
    </svg>
  );
}
