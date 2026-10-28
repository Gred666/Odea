import { type ThemePref, useApp } from "@/app/store";
import { spring } from "@/lib/motion";
import { onThemeTransition } from "@/lib/themeTransition";
import { Monitor } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

const ORDER: ThemePref[] = ["system", "light", "dark"];
const LABEL = { system: "跟随系统", light: "亮色", dark: "暗色" } as const;
/** 和窄栏底下那几格的图标一样大（Sidebar 的 FOOT_ICON） */
const ICON_SIZE = 18;

/**
 * 三态主题切换。
 * 亮色 / 暗色的图标是同一个太阳月亮：换主题时整页播日落 / 日出（lib/themeTransition.ts），
 * 这里同时让太阳收起光芒、沉到地平线下，月亮升起来；日出反过来。
 * 那段时间整页盖着一层旧主题的副本，按钮在它底下 —— 太阳月亮那一段画在副本上面的一层里，
 * 和按钮里的图标重合，播完再交回按钮。
 * 飞的那一段对准图标量位置（不是按钮）：导航栏收起 / 展开时按钮自己在动，量图标最准。
 */
export function ThemeToggle({ className }: { className: string }) {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const glyph = useRef<HTMLSpanElement>(null);
  const [flight, setFlight] = useState<Flight | null>(null);

  // 不管是点这里、命令面板，还是跟随系统时系统换了明暗，都从这里接到「开始了」
  useEffect(
    () =>
      onThemeTransition(({ toDark, duration, finished }) => {
        const rect = glyph.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;
        const at = performance.now();
        setFlight({
          toDark,
          duration,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          at,
        });
        // 和整页的日落 / 日出同一时刻落定（被下一次切换打断时，交给下一段）
        void finished.then(() => setFlight((current) => (current?.at === at ? null : current)));
      }),
    [],
  );

  return (
    <button
      type="button"
      title={`主题：${LABEL[theme]}`}
      aria-label={`主题：${LABEL[theme]}，点击切换`}
      onClick={() => setTheme(ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!)}
      className={className}
    >
      {/* 飞着的那一段落定后交回来：太阳月亮和它一模一样，直接换；落在「跟随系统」上是另一个
          图标，淡入一下。藏起来的那一下总是立刻的，免得和上面那一层叠出两个 */}
      <span
        ref={glyph}
        data-sky-glyph
        className="relative grid h-[18px] w-[18px] shrink-0 place-items-center"
        style={
          flight
            ? { opacity: 0, transition: "none" }
            : { opacity: 1, transition: theme === "system" ? "opacity 200ms" : "none" }
        }
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={theme === "system" ? "system" : "sky"}
            initial={{ opacity: 0, rotate: -75, scale: 0.6 }}
            animate={{ opacity: 1, rotate: 0, scale: 1 }}
            exit={{ opacity: 0, rotate: 75, scale: 0.6 }}
            transition={spring.snappy}
            className="absolute grid place-items-center"
          >
            {theme === "system" ? (
              <Monitor size={ICON_SIZE} strokeWidth={1.8} />
            ) : (
              <SkyGlyph night={theme === "dark"} />
            )}
          </motion.span>
        </AnimatePresence>
      </span>
      {flight &&
        createPortal(
          <span
            key={flight.at}
            aria-hidden="true"
            className="pointer-events-none fixed z-[2147483002] grid -translate-x-1/2 -translate-y-1/2
                       place-items-center text-muted"
            style={{ left: flight.x, top: flight.y }}
          >
            <SkyGlyph
              night={flight.toDark}
              from={!flight.toDark}
              duration={flight.duration / 1000}
            />
          </span>,
          document.body,
        )}
    </button>
  );
}

interface Flight {
  toDark: boolean;
  duration: number;
  /** 图标中心，屏幕坐标 */
  x: number;
  y: number;
  at: number;
}

/** 太阳 / 月亮落到地平线下的那段距离（viewBox 单位）：月亮最高点 y=3，挪 20 就整个在地平线下 */
const BELOW = 20;
const HORIZON = 21.5;

/**
 * 太阳和月亮画在同一个 24×24 里，地平线在最底下。
 * 不给 from 就是静态的 night 那一个；给了 from（起点是不是夜）就从 from 播到 night：
 * 日落 —— 光芒收起，太阳沉下去，地平线亮一下，月亮升起来；日出 —— 月亮沉下去，太阳升起来，光芒再张开。
 * 只动图标里的形状（位移、光芒的缩放），不碰字
 */
function SkyGlyph({
  night,
  from,
  duration = 0,
}: { night: boolean; from?: boolean; duration?: number }) {
  const play = from !== undefined && from !== night;
  const d = duration;
  const sunset = play && night;
  const sunrise = play && !night;
  const state = (isNight: boolean) => ({
    sun: { y: isNight ? BELOW : 0 },
    rays: { scale: isNight ? 0.7 : 1, opacity: isNight ? 0 : 1 },
    moon: { y: isNight ? 0 : BELOW },
  });
  const start = state(play ? from : night);
  const end = state(night);
  const ease = [0.45, 0, 0.25, 1] as const;
  const clip = useId();

  return (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      overflow="visible"
    >
      <defs>
        <clipPath id={clip}>
          <rect x="-4" y="-4" width="32" height={HORIZON + 4} />
        </clipPath>
      </defs>
      <motion.g
        initial={start.rays}
        animate={end.rays}
        // 日落时光芒先收起来；日出时太阳整个升到地平线上之后才张开（缩小的光芒落在圆盘里像一张脸，
        // 所以没张开之前是完全透明的）
        transition={
          sunset
            ? { duration: d * 0.24, ease }
            : sunrise
              ? {
                  scale: { ...spring.bouncy, delay: d * 0.6 },
                  opacity: { duration: d * 0.12, delay: d * 0.6 },
                }
              : { duration: 0 }
        }
      >
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </motion.g>
      <g clipPath={`url(#${CSS.escape(clip)})`}>
        <motion.g
          initial={start.sun}
          animate={end.sun}
          transition={
            sunset
              ? { duration: d * 0.46, delay: d * 0.14, ease }
              : sunrise
                ? { duration: d * 0.46, delay: d * 0.2, ease: [0.2, 0.7, 0.3, 1] }
                : { duration: 0 }
          }
        >
          <circle cx="12" cy="12" r="4" />
        </motion.g>
        <motion.g
          initial={start.moon}
          animate={end.moon}
          transition={
            sunset
              ? { duration: d * 0.46, delay: d * 0.5, ease: [0.2, 0.7, 0.3, 1] }
              : sunrise
                ? { duration: d * 0.4, ease }
                : { duration: 0 }
          }
        >
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </motion.g>
      </g>
      {play && (
        <motion.path
          d={`M3.5 ${HORIZON}H20.5`}
          initial={{ opacity: 0, pathLength: 0 }}
          animate={{ opacity: [0, 1, 1, 0], pathLength: [0, 1, 1, 1] }}
          transition={{ duration: d, times: [0, 0.16, 0.78, 1], ease: "easeInOut" }}
        />
      )}
    </svg>
  );
}
