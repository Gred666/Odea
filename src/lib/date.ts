/* ============================================================
   全局唯一的时间入口。
   业务代码禁止直接 new Date() 做加减 —— 一律走这里。
   P5 接 Rust 后端后，这里换成 Temporal，对外签名不变。
   ============================================================ */

export type ISODate = string; // 'YYYY-MM-DD'

const CN_WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"] as const;
const CN_MONTH = [
  "一月",
  "二月",
  "三月",
  "四月",
  "五月",
  "六月",
  "七月",
  "八月",
  "九月",
  "十月",
  "十一月",
  "十二月",
] as const;

/** 本地日期 → 'YYYY-MM-DD'。不能用 toISOString()，那是 UTC，会差一天。 */
export function toISODate(d: Date): ISODate {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 'YYYY-MM-DD' → 本地 00:00 的 Date。 */
export function fromISODate(s: ISODate): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

export function today(): ISODate {
  return toISODate(new Date());
}

export function addDays(s: ISODate, n: number): ISODate {
  const d = fromISODate(s);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

export function addMonths(s: ISODate, n: number): ISODate {
  const d = fromISODate(s);
  const targetDay = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  // 处理 1月31日 + 1月 这类溢出：钳到目标月最后一天
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(targetDay, lastDay));
  return toISODate(d);
}

/** 周一为一周之首（中文习惯）。返回该周的周一。 */
export function startOfWeek(s: ISODate): ISODate {
  const d = fromISODate(s);
  const dow = d.getDay(); // 0=周日
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return toISODate(d);
}

export function startOfMonth(s: ISODate): ISODate {
  const d = fromISODate(s);
  d.setDate(1);
  return toISODate(d);
}

export function startOfYear(s: ISODate): ISODate {
  return `${s.slice(0, 4)}-01-01`;
}

/* ---------- 目标周期 ----------
   一个周期一篇 GOAL，键是它的起点。这里的算法必须和 Rust 侧的校验一致：
   周 → 周一，月 → 1 号，年 → 1 月 1 日。 */

export type PeriodHorizon = "week" | "month" | "year";

/** 某一天所在周期的起点 */
export function periodStartOf(horizon: PeriodHorizon, s: ISODate): ISODate {
  if (horizon === "week") return startOfWeek(s);
  if (horizon === "month") return startOfMonth(s);
  return startOfYear(s);
}

/** 周期最后一天（含） */
export function periodEndOf(horizon: PeriodHorizon, periodStart: ISODate): ISODate {
  if (horizon === "week") return addDays(periodStart, 6);
  if (horizon === "month") return addDays(addMonths(periodStart, 1), -1);
  return `${periodStart.slice(0, 4)}-12-31`;
}

/** 周期的范围说明，放在状态栏：「9月14日 – 9月20日」「2026年9月」「2026年」 */
export function formatPeriodCN(horizon: PeriodHorizon, periodStart: ISODate): string {
  if (horizon === "week") {
    return `${formatMonthDayCN(periodStart)} – ${formatMonthDayCN(periodEndOf("week", periodStart))}`;
  }
  const d = fromISODate(periodStart);
  if (horizon === "month") return `${d.getFullYear()}年${d.getMonth() + 1}月`;
  return `${d.getFullYear()}年`;
}

/** ISO 8601 周数。日历左列显示的「35」就是它。 */
export function isoWeekNumber(s: ISODate): number {
  const d = fromISODate(s);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNum = (d.getDay() + 6) % 7; // 周一=0
  target.setDate(target.getDate() - dayNum + 3); // 移到本周周四
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const firstDayNum = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNum + 3);
  return 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 864e5));
}

/**
 * 月视图网格：始终 6 行 × 7 列 = 42 天，从当月第一天所在周的周一开始。
 * 固定 42 格意味着切换月份时网格高度不变 —— 布局不跳动，动画才干净。
 */
export function monthGrid(anchor: ISODate): ISODate[] {
  const first = startOfMonth(anchor);
  const gridStart = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

export function isSameMonth(a: ISODate, b: ISODate): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

/* ---------- 格式化 ---------- */

export function formatMonthCN(s: ISODate): string {
  return CN_MONTH[fromISODate(s).getMonth()]!;
}

export function formatYear(s: ISODate): number {
  return fromISODate(s).getFullYear();
}

export function formatDayNum(s: ISODate): number {
  return fromISODate(s).getDate();
}

export function formatWeekdayCN(s: ISODate): string {
  return CN_WEEKDAY[fromISODate(s).getDay()]!;
}

/** 「8月29日」 */
export function formatMonthDayCN(s: ISODate): string {
  const d = fromISODate(s);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 「8月29日 · 周六」，日历某天文档标题上方的小字 */
export function formatDayEyebrowCN(s: ISODate): string {
  return `${formatMonthDayCN(s)} · 周${formatWeekdayCN(s)}`;
}

/** 「2026年8月18日」 */
export function formatFullCN(s: ISODate): string {
  const d = fromISODate(s);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 「8月12日」，同年省略年份；跨年则「2025年8月12日」 */
export function formatSmartCN(s: ISODate): string {
  const d = fromISODate(s);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() ? formatMonthDayCN(s) : formatFullCN(s);
}

/** 时间戳 → 「今天 09:12」/「昨天 20:14」/「8月12日 11:59」 */
export function formatRelativeTime(ts: number): string {
  const d = new Date(ts);
  const iso = toISODate(d);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const t = `${hh}:${mm}`;

  const now = today();
  if (iso === now) return `今天 ${t}`;
  if (iso === addDays(now, -1)) return `昨天 ${t}`;
  return `${formatSmartCN(iso)} ${t}`;
}

/** 时间戳 → 「2026年 8月28日 11:59」，状态栏用的完整形式 */
export function formatTimestampFull(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getFullYear()}年 ${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}
