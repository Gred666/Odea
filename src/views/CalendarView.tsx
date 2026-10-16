import { useApp } from "@/app/store";
import { ColumnButton, ListColumn } from "@/components/ListColumn";
import type { CalendarMarks } from "@/data/types";
import { cn } from "@/lib/cn";
import {
  type ISODate,
  addMonths,
  formatDayEyebrowCN,
  formatDayNum,
  isSameMonth,
  isoWeekNumber,
  monthGrid,
  startOfMonth,
  startOfWeek,
} from "@/lib/date";
import { spring, tween, usePrefersReducedMotion } from "@/lib/motion";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "motion/react";
import { useEffect, useState } from "react";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"] as const;

/**
 * 月历面板。
 *
 * 打开就是今天：selectedDate 的初始值是 today()，零点会由 startTodayTicker 翻页。
 * 「今天」按钮只在离开今天时出现 —— 停在今天的时候它没有任何事可做，
 * 常驻只是多一个按钮。
 *
 * 视觉上尽量安静：一行「2026年9月」+ 两个箭头，数字用正文字体（不是等宽）。
 * 两套语义各用一种颜色：
 *   - 主色 = 「时间光标」：今天是主色数字，选中是一个点绕着日期转一周画出的浅蓝圈；
 *   - 墨色 = 「有没有写」：写过的日子数字加深加粗、下面一粒实心墨点，没写的退成中灰。
 *     还有没做完的待办的日子，下面是一个空心小圈（和实心墨点并排）。
 * 这样一眼扫过去，深色的数字就是这个月留下过东西的日子，空心圈是还欠着事的日子。
 * 周数列和整周的底色留着 —— 周/GOAL 跟着选中日期所在的那一周走，
 * 这条底色就是「现在看的是哪一周」。
 */
export function CalendarPanel({ marks }: { marks: CalendarMarks }) {
  const selected = useApp((s) => s.selectedDate);
  const todayISO = useApp((s) => s.todayDate);
  const selectDate = useApp((s) => s.selectDate);

  const [anchor, setAnchor] = useState<ISODate>(() => startOfMonth(selected));
  const [dir, setDir] = useState<1 | -1>(1);

  // 选中日期在外部变了（零点翻页、命令面板跳转）：月份跟过去
  useEffect(() => {
    setAnchor((current) => {
      if (isSameMonth(current, selected)) return current;
      setDir(selected > current ? 1 : -1);
      return startOfMonth(selected);
    });
  }, [selected]);

  const go = (delta: number) => {
    setDir(delta > 0 ? 1 : -1);
    setAnchor((a) => addMonths(a, delta));
  };

  const awayFromToday = selected !== todayISO || !isSameMonth(anchor, todayISO);

  const jumpToday = () => {
    setDir(todayISO > anchor ? 1 : -1);
    setAnchor(startOfMonth(todayISO));
    selectDate(todayISO);
  };

  const days = monthGrid(anchor);
  const selectedWeekStart = startOfWeek(selected);
  const [year, month] = anchor.split("-").map(Number);

  return (
    <ListColumn
      title="日历"
      action={
        <AnimatePresence initial={false}>
          {awayFromToday && (
            <motion.div
              key="today"
              // 只淡入淡出：缩放会让「今天」两个字先糊、停下时再跳清楚
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={tween.fast}
            >
              <ColumnButton label="回到今天" onClick={jumpToday} wide>
                今天
              </ColumnButton>
            </motion.div>
          )}
        </AnimatePresence>
      }
      belowTitle={
        <div className="flex items-center justify-between">
          {/* 月份标题做方向感知的上下滚动替换 */}
          <div className="relative h-[24px] min-w-[120px] overflow-hidden">
            <AnimatePresence mode="popLayout" initial={false} custom={dir}>
              <motion.span
                key={anchor.slice(0, 7)}
                custom={dir}
                initial={{ y: dir * 18, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: dir * -18, opacity: 0 }}
                // 同下面的日期网格：收尾不留半像素的跳
                transition={{ ...spring.smooth, restDelta: 0.01, opacity: tween.fast }}
                className="absolute inset-0 flex items-center text-[15px] font-semibold
                           text-ink tabular-nums"
              >
                {year}年{month}月
              </motion.span>
            </AnimatePresence>
          </div>

          <div className="flex shrink-0 items-center">
            <StepButton label="上一月" onClick={() => go(-1)}>
              <ChevronLeft size={15} strokeWidth={1.8} />
            </StepButton>
            <StepButton label="下一月" onClick={() => go(1)}>
              <ChevronRight size={15} strokeWidth={1.8} />
            </StepButton>
          </div>
        </div>
      }
    >
      {/* 表头：「周」+ 七天，同一排字号，周数列不再是一块空白 */}
      <div className="mt-1 grid grid-cols-[24px_repeat(7,1fr)] px-1 pb-1">
        <span className="text-center text-[12px] font-medium text-faint/75">周</span>
        {WEEKDAYS.map((w) => (
          <span key={w} className="text-center text-[12px] font-medium text-faint">
            {w}
          </span>
        ))}
      </div>

      {/* 网格固定 6 行 —— 切月时高度不变，动画才干净 */}
      <div className="relative overflow-hidden px-1">
        <AnimatePresence mode="popLayout" initial={false} custom={dir}>
          <motion.div
            key={anchor.slice(0, 7)}
            custom={dir}
            initial={{ x: dir * 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: dir * -24, opacity: 0 }}
            // restDelta：spring 默认差半个像素以内就直接跳到终点，满屏日期数字最后会一起抖一下
            transition={{ ...spring.smooth, restDelta: 0.01, opacity: tween.fast }}
            className="flex flex-col"
          >
            {Array.from({ length: 6 }, (_, row) => {
              const weekDays = days.slice(row * 7, row * 7 + 7);
              const weekStart = weekDays[0]!;

              return (
                <WeekRow
                  key={weekStart}
                  weekDays={weekDays}
                  weekNo={isoWeekNumber(weekStart)}
                  anchor={anchor}
                  selected={selected}
                  todayISO={todayISO}
                  marks={marks}
                  highlighted={weekStart === selectedWeekStart}
                  onSelect={selectDate}
                />
              );
            })}
          </motion.div>
        </AnimatePresence>
      </div>
    </ListColumn>
  );
}

function WeekRow({
  weekDays,
  weekNo,
  anchor,
  selected,
  todayISO,
  marks,
  highlighted,
  onSelect,
}: {
  weekDays: ISODate[];
  weekNo: number;
  anchor: ISODate;
  selected: ISODate;
  todayISO: ISODate;
  marks: CalendarMarks;
  highlighted: boolean;
  onSelect: (d: ISODate) => void;
}) {
  // 每周自成一个 grid 行 —— 这样整行底色可以用 inset-0，
  // 而不是靠负值外扩去猜宽度。
  return (
    <div className="relative grid grid-cols-[24px_repeat(7,1fr)]">
      {highlighted && (
        <motion.span
          layoutId="calendar-week-band"
          className="pointer-events-none absolute inset-x-0 inset-y-[1px] rounded-lg bg-raised/45"
          transition={spring.smooth}
        />
      )}

      <div className="relative grid h-[40px] place-items-center">
        <span
          className={cn(
            "text-[11px] tabular-nums transition-colors duration-200",
            highlighted ? "text-muted" : "text-faint/65",
          )}
        >
          {weekNo}
        </span>
      </div>

      {weekDays.map((d) => (
        <DayCell
          key={d}
          date={d}
          outside={!isSameMonth(d, anchor)}
          selected={d === selected}
          isToday={d === todayISO}
          written={marks.written.has(d)}
          open={marks.open.has(d)}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function DayCell({
  date,
  outside,
  selected,
  isToday,
  written,
  open,
  onSelect,
}: {
  date: ISODate;
  outside: boolean;
  selected: boolean;
  isToday: boolean;
  /** 这天写过记录 / 做过事 */
  written: boolean;
  /** 这天还有没做完的待办 */
  open: boolean;
  onSelect: (d: ISODate) => void;
}) {
  // 三层各管一件事：圈 = 选中、数字颜色 = 今天/有没有写、下面的记号 = 写过（实心）/ 欠着事（空心）。
  // 圈里的数字和记号都跟着主色走，整格只有一种色相。
  const marked = written || open;
  const accentTone = selected || isToday;
  const tone = accentTone
    ? "text-accent"
    : outside
      ? "text-faint/45"
      : marked
        ? "text-ink"
        : "text-muted";

  return (
    <button
      type="button"
      onClick={() => onSelect(date)}
      aria-label={`${formatDayEyebrowCN(date)}${written ? "，有记录" : ""}${open ? "，有待办" : ""}`}
      aria-current={selected ? "date" : isToday ? "true" : undefined}
      className="group relative grid h-[40px] place-items-center"
    >
      <span className="relative grid h-[30px] w-[30px] place-items-center">
        {!selected && (
          <span
            className="absolute inset-0 scale-90 rounded-full bg-raised opacity-0
                       transition-[opacity,transform] duration-[140ms]
                       group-hover:scale-100 group-hover:opacity-60"
          />
        )}
        {/* 选中：圈。这格一被选中就重画一遍；换到别的日期，旧圈淡出、新圈重画 */}
        <AnimatePresence>{selected && <OrbitRing key="ring" />}</AnimatePresence>

        <span
          className={cn(
            "relative z-10 text-[13px] leading-none tabular-nums transition-colors duration-[160ms]",
            tone,
            accentTone ? "font-semibold" : marked ? "font-medium" : "font-normal",
          )}
        >
          {formatDayNum(date)}
        </span>

        {/* 数字下面的记号，落在圈内：写过 = 实心墨点，还有待办 = 空心小圈，两个都有就并排 */}
        {marked && (
          <span className="absolute bottom-[3.5px] z-10 flex items-center gap-[2.5px]">
            {written && (
              <span
                className={cn(
                  "h-[3.5px] w-[3.5px] rounded-full transition-colors duration-200",
                  accentTone ? "bg-accent/75" : outside ? "bg-faint/40" : "bg-ink/60",
                )}
              />
            )}
            {open && (
              <span
                className={cn(
                  "h-[4.5px] w-[4.5px] rounded-full border-[1.2px] transition-colors duration-200",
                  accentTone ? "border-accent/80" : outside ? "border-faint/45" : "border-ink/55",
                )}
              />
            )}
          </span>
        )}
      </span>
    </button>
  );
}

const RING_R = 14.25;
const RING_C = 15;
/** 绕一圈的时长：故意比动效 token 里的上限慢，眼睛要能跟着点走完一圈 */
const RING_DURATION = 0.85;
/** ease-out-cubic：比 quint 平缓，前半圈不会一下冲过去 */
const RING_EASE = [0.33, 1, 0.68, 1] as const;

/**
 * 选中日的圈：一个主色小点从正上方出发，顺时针绕日期转一周，
 * 身后留下一圈浅蓝的线；画完点隐去，只剩圈。
 *
 * 线和点由同一个 progress 驱动 —— 线用 pathLength，点用三角函数算坐标 ——
 * 所以永远咬在一起。每次挂载（选中、打开日历、切月后落回）都从头画。
 * 减少动效时直接给出画好的圈。
 */
function OrbitRing() {
  const appReduce = useApp((s) => s.reduceMotion);
  const systemReduce = usePrefersReducedMotion();
  const skip = appReduce || systemReduce;

  const progress = useMotionValue(skip ? 1 : 0);
  // 从正上方（-90°）起笔，顺时针
  const cx = useTransform(progress, (p) => RING_C + RING_R * Math.cos((p - 0.25) * Math.PI * 2));
  const cy = useTransform(progress, (p) => RING_C + RING_R * Math.sin((p - 0.25) * Math.PI * 2));
  // 点在最后一小段淡出，收笔的时候刚好消失
  const dotOpacity = useTransform(progress, [0, 0.82, 1], [1, 1, 0]);

  useEffect(() => {
    if (skip) {
      progress.set(1);
      return;
    }
    progress.set(0);
    const controls = animate(progress, 1, { duration: RING_DURATION, ease: RING_EASE });
    return () => controls.stop();
  }, [progress, skip]);

  return (
    <motion.svg
      viewBox="0 0 30 30"
      className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
      aria-hidden="true"
      exit={{ opacity: 0 }}
      transition={tween.fast}
    >
      {/* SVG 的圆从 3 点钟方向起笔，转 -90° 让它和点一样从正上方开始 */}
      <g transform={`rotate(-90 ${RING_C} ${RING_C})`}>
        <motion.circle
          cx={RING_C}
          cy={RING_C}
          r={RING_R}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          className="stroke-calendar-ring"
          style={{ pathLength: progress }}
        />
      </g>
      {!skip && (
        <motion.circle r="2.4" className="fill-accent" style={{ cx, cy, opacity: dotOpacity }} />
      )}
    </motion.svg>
  );
}

function StepButton({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="grid h-[26px] w-[26px] place-items-center rounded-md text-faint
                 transition-colors duration-[140ms] hover:bg-raised hover:text-ink
                 active:bg-raised/70"
    >
      {children}
    </button>
  );
}
