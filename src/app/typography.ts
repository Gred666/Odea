/* ============================================================
   正文字号、行宽（每行最多几个字）：偏好，记在本机（app/store.ts 的 prefs）。

   写成 <html> 上的两个 CSS 变量（--odea-body-size、--odea-measure，globals.css）：编辑器、只读占位、
   模板预览、正文那一列的宽度都按它们算。弹出窗口照着主窗口的 <html> 同步属性（app/popout.ts），
   不用另外管。CodeMirror 的滚动区一变大小它自己会重新量行高，也不用另外通知。

   行宽按「字」算，不按像素：字号调大以后每行的字数不变，正文那一列跟着变宽。
   档位和依据见 docs/排版规范.md §2（字号 17px、行长 25–40 字，最多 48 字）、§9
   ============================================================ */

/** 正文字号的档位（px）。个人差异大，15–20 最实在（docs/排版规范.md §9） */
export const BODY_SIZES = [15, 16, 17, 18, 19, 20] as const;
export const DEFAULT_BODY_SIZE = 17;

export type Measure = "narrow" | "standard" | "wide" | "full";
export const DEFAULT_MEASURE: Measure = "standard";

/** 正文那一列每行最多几个字；铺满是不限，正文区多宽就多宽 */
export const MEASURES: { id: Measure; label: string; chars: number | null }[] = [
  { id: "narrow", label: "窄", chars: 36 },
  // 以前写死的 860px：44 字 × 17px + 两边内边距 112px
  { id: "standard", label: "标准", chars: 44 },
  { id: "wide", label: "宽", chars: 52 },
  { id: "full", label: "铺满", chars: null },
];

export const isBodySize = (value: unknown): value is number =>
  BODY_SIZES.includes(value as (typeof BODY_SIZES)[number]);

export const isMeasure = (value: unknown): value is Measure =>
  MEASURES.some((measure) => measure.id === value);

/** 大一号 / 小一号：到头了返回 null */
export function stepBodySize(current: number, step: 1 | -1): number | null {
  const index = BODY_SIZES.indexOf(current as (typeof BODY_SIZES)[number]);
  return BODY_SIZES[(index < 0 ? BODY_SIZES.indexOf(DEFAULT_BODY_SIZE) : index) + step] ?? null;
}

/** 写到 <html> 上（启动时、改了偏好时） */
export function applyTypography(bodySize: number, measure: Measure) {
  const style = document.documentElement.style;
  style.setProperty("--odea-body-size", `${bodySize}px`);
  // 铺满：一个大到碰不到的字数，max-width 的算式不用分两种写
  const chars = MEASURES.find((item) => item.id === measure)?.chars ?? 9999;
  style.setProperty("--odea-measure", String(chars));
}
