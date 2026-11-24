/* ============================================================
   手写 Logo 的几何：刘海里的「O」（StatusOrb.tsx）、开场动画（Intro.tsx）、启动器的字标共用。
   开场那个「O」最后要和刘海里的逐像素重合，所以两边必须是同一份数据。

   设计：起笔一点（design/logo/）。Odea 是把 idea 的 i 写成了 O —— i 上那一点留着，
   就是 O 右上缺口里的蓝点：先有一个想法，再从它旁边起笔，绕一圈写成字。
   所以字标里的 O 本来就是开口的、带着蓝点，和应用图标、刘海里的「O」是同一个样子。
   ============================================================ */

/**
 * 字标的 viewBox（启动器的字标用它）
 */
export const LOGO_VIEWBOX = { x: 3, y: 5, w: 138.68, h: 78 } as const;
export const LOGO_VIEWBOX_ATTR = `${LOGO_VIEWBOX.x} ${LOGO_VIEWBOX.y} ${LOGO_VIEWBOX.w} ${LOGO_VIEWBOX.h}`;

/**
 * 每段笔画的 d，顺序 = 书写顺序。d 是先绕碗、再从上往下一竖，所以一共五段。
 * O 从缺口这头（正上方稍偏右）起笔，逆时针绕一圈，停在缺口那头（右侧偏上）。
 * 它是从一条闭合的 O 上按弧长截出来的（缺口两端在原路径的 11.8% 和 89.6%）；
 * e、a 和改名前字标里的那两个字母是同一笔，只是挪了位置
 */
export const STROKES = [
  // O
  "M30.78 14.91 C 26.57 14.27, 21.99 15.45, 18 19 C 9 27, 7 46, 15 55 C 23 64, 38 60, 43 47 C 45.65 39.94, 45.18 32.1, 42.97 26.24",
  // d 的碗
  "M74 37 C 69 32, 60 32, 56 39 C 52 46, 54 56, 61 59 C 67 61, 72 55, 73 47 C 74 41, 74 38, 74 36",
  // d 的竖
  "M76 12 C 75 26, 74 41, 74 52 C 74 56, 74 59, 75 61",
  // e
  "M82 48 C 88 46, 96 44, 101 42 C 103 37, 99 33, 94 34 C 88 35, 83 41, 83 48 C 83 55, 88 62, 96 61 C 100 60, 103 57, 105 54",
  // a
  "M134 37 C 129 32, 120 32, 116 39 C 112 46, 114 56, 121 59 C 127 61, 132 55, 133 47 C 134 41, 134 37, 134 35 C 133 44, 133 53, 134 61",
];

/** 笔画宽（viewBox 单位） */
export const STROKE_WIDTH = 5;

/** 「O」的外接框中心（viewBox 单位）：开场时让它落在窗口正中 */
export const O_CENTER = { x: 27.4, y: 37.3 } as const;
/** 「O」的高（viewBox 单位） */
export const O_HEIGHT = 45.2;

/**
 * 蓝点：落在缺口里，起笔和收笔延长了会交叉的那个位置。方向和大小照应用图标：
 * 缺口在一点半方向，直径约为笔画宽的 1.4 倍
 */
export const DOT = { cx: 38.4, cy: 18.8, r: 3.5 } as const;

/**
 * 刘海里那颗「O」（StatusOrb，docs/边栏.md §4.4）：28px 的圆按钮里只画 O 和蓝点，
 * 用一个以 O 的外接框中心为中心的正方形 viewBox。边长 76.7 个单位装进 28px：O 高 16.5px、笔画 1.8px，
 * 外面那一圈状态环（r = 12.2）里还留 2.9px。开场的「O」照它算落点（Intro.tsx）
 */
export const MARK_SIDE = 76.7;
export const MARK_VIEWBOX = {
  x: O_CENTER.x - MARK_SIDE / 2,
  y: O_CENTER.y - MARK_SIDE / 2,
  w: MARK_SIDE,
  h: MARK_SIDE,
} as const;
export const MARK_VIEWBOX_ATTR = `${MARK_VIEWBOX.x} ${MARK_VIEWBOX.y} ${MARK_SIDE} ${MARK_SIDE}`;

/**
 * 蓝点长出来（开场时，最先出来的就是它）：阻尼比 0.68，冲过头约 5% —— 看不出弹，
 * 只是收尾是「落定」而不是「刹住」。阻尼 22 那一版冲过头 13%，慢放里那几帧明显大一圈
 */
export const DOT_IN = { type: "spring", stiffness: 420, damping: 28, restDelta: 0.001 } as const;
