import type { Transition, Variants } from "motion/react";
import { useSyncExternalStore } from "react";

/* ============================================================
   动效 token
   规则（技术方案 §10）：
   1. 只动 transform / opacity
   2. 不动画化 backdrop-filter / box-shadow
   3. 时长 80–320ms，spring 必须可打断
   4. 带字的元素不缩放：缩放让整层字被当位图重采样，动画里发虚，结束那一帧
      回到正常绘制时字一下变清楚、还挪一点（「先糊、再抖一下」）。浮层用
      popoverCard 展开，小东西只淡入；缩放只给图标、圆点这类没有字的
   ============================================================ */

/* ---------- 系统「减少动效」偏好 ---------- */

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

const subscribeReduce = (onChange: () => void) => {
  const mq = window.matchMedia(REDUCE_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
};

/**
 * 系统是否要求减少动效。
 *
 * 不要用 motion 自己的 useReducedMotion()：Shell 上的 MotionConfig 只要设过一次
 * reducedMotion="always"，motion 就把「要减少」写进了它的全局状态，之后即使切回
 * "user" 也不会重新去读系统值 —— 表现就是应用内开关关掉以后，那个 hook 仍然一直
 * 返回 true，靠它做判断的动画直到刷新页面才会回来。
 * 直接问 matchMedia 不受这层影响。
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduce,
    () => window.matchMedia(REDUCE_QUERY).matches,
    () => false,
  );
}

export const spring = {
  /** 按钮、勾选、开关 —— 快，几乎不回弹 */
  snappy: { type: "spring", stiffness: 520, damping: 34, mass: 0.7 },
  /** 列表重排、卡片位移、指示器滑动 —— 默认选择 */
  smooth: { type: "spring", stiffness: 320, damping: 30 },
  /** 面板滑入、大块内容 */
  gentle: { type: "spring", stiffness: 190, damping: 26 },
  /** 强调：完成、达成 —— 少用 */
  bouncy: { type: "spring", stiffness: 420, damping: 17 },
  /** 布局重排专用：比 smooth 稍软，避免多项同时动时显得躁 */
  layout: { type: "spring", stiffness: 380, damping: 34, mass: 0.9 },
} satisfies Record<string, Transition>;

export const tween = {
  instant: { duration: 0.08, ease: [0.22, 1, 0.36, 1] },
  fast: { duration: 0.14, ease: [0.22, 1, 0.36, 1] },
  base: { duration: 0.22, ease: [0.22, 1, 0.36, 1] },
  slow: { duration: 0.32, ease: [0.16, 1, 0.3, 1] },
} satisfies Record<string, Transition>;

/**
 * 列表入场错峰。
 * 上限 10 项 —— 否则第 30 项要等 600ms 才出现，感觉是「卡住了」而不是「有动画」。
 */
export function stagger(index: number, step = 0.022, cap = 10): Transition {
  return { delay: Math.min(index, cap) * step };
}

/* ---------- 常用 variants ---------- */

/** 从下方淡入。列表项、卡片的默认入场。 */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
};

/** 纯淡入。用于数量多、不适合位移的场景（如日历事件块）。 */
export const fade: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1 },
  exit: { opacity: 0 },
};

/* ---------- 贴着光标展开、盖在正文上的浮层（Ctrl+E 表情选择器、/模板 模板选择器） ----------
   卡片从贴着光标的那条边往外展开（动的是卡片的高度），里面的内容从第一帧起就钉在
   最终位置上，不缩放、不变透明，展开只是把它一行行露出来：
   - 不能整块从透明淡入：卡片盖在正文上，半透明的那 100ms 里表情格子和底下的正文
     一行行叠在一起，看着就是「正文跳了一下」（用户实机录屏确认过）
   - 也不能缩放：带字的层一缩放，浏览器就拿位图去拉伸，动画那 200ms 里字是糊的；
     结束撤掉 transform 的那一帧重新按原尺寸画，字一下变清楚、还挪了一点 ——
     「先糊、再抖一下」（1.5 倍屏无头 Chrome 十倍慢放逐帧确认过）
   所以这里破例动 height（§10.1 第 1 条）：面板是 fixed 的小盒子，里面内容的高度不跟着
   它变，每帧只重排这一个盒子。
   收起反过来：折回光标那条边，最后一窄条才淡掉（不然最后一帧是一条带阴影的细线）。
   淡出要等到只剩不到 10px：那时露着的只是搜索栏 / 底栏的空白边，没有字和正文叠影。
   曲线起步柔（展开第一帧不会一下冲出半张）、中段快、落定软；淡出起点按它算。
   面板要钉住贴着光标的那条边（往上开的用 bottom 定位），内容也贴着那条边排。 */

const unfoldEase = [0.32, 0.72, 0, 1] as const;

/** 用 initial="hidden" animate="shown" exit="gone"；custom 传第一帧露出来多高（贴着光标的那一栏） */
export const popoverCard: Variants = {
  hidden: (peek: number) => ({ height: peek }),
  // opacity 要写回 1：收起（gone）淡到一半又打开的（连按两下 Ctrl+K、从对话框返回命令面板），
  // 用的还是那一张卡片，不写的话就停在半透明。平时本来就是 1，duration 0 不起动画
  shown: {
    height: "auto",
    opacity: 1,
    transition: { duration: 0.28, ease: unfoldEase, opacity: { duration: 0 } },
  },
  gone: {
    height: 0,
    opacity: [1, 1, 0],
    transition: {
      duration: 0.2,
      ease: unfoldEase,
      // 这条曲线走到 60% 时，398px 高的面板只剩 10px
      opacity: { duration: 0.2, times: [0, 0.6, 1], ease: "linear" },
    },
  },
};

/** 侧向滑入。方向感知的视图切换用。 */
export function slideX(dir: 1 | -1): Variants {
  return {
    hidden: { opacity: 0, x: dir * 18 },
    show: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: dir * -18 },
  };
}

/* ---------- layoutId 命名空间 ----------
   同一个 layoutId 在同一时刻只能存在一个元素，否则 Motion 会警告并乱飞。
   集中在这里定义，避免散落各处写错字符串。
*/
export const layoutIds = {
  navIndicator: "nav-indicator",
  listSelection: "list-selection",
  outlineIndicator: "outline-indicator",
  segmentThumb: (group: string) => `segment-thumb-${group}`,
  calendarDay: "calendar-day-badge",
  /** 动态表情选择器里的当前格高亮 */
  emojiCursor: "emoji-cursor",
  /** 模板选择器里的当前项高亮 */
  templateCursor: "template-cursor",
  /** `/` 插入菜单、`[[` 笔记链接菜单里的当前项高亮 */
  suggestCursor: "suggest-cursor",
} as const;
