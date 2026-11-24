import { useIntro } from "@/app/intro";
import { useApp } from "@/app/store";
import { useData } from "@/data/store";
import type { SyncStatus } from "@/data/types";
import { cn } from "@/lib/cn";
import { usePrefersReducedMotion } from "@/lib/motion";
import { describeSync } from "@/lib/syncText";
import { tip } from "@/lib/tooltip";
import { useTeam } from "@/team/store";
import { AnimatePresence, motion } from "motion/react";
import { forwardRef, useEffect, useState } from "react";
import { DOT, MARK_VIEWBOX_ATTR, STROKES, STROKE_WIDTH } from "./logoGeometry";

/* ============================================================
   刘海左头的「O」（docs/边栏.md §4.4）：平时就是 logo；后台的状态长在它上面 ——
   灵动岛的 minimal：同步中外面一圈在转，读索引时同一圈当进度环；出错 / 要登录（红）> 离线（黄）
   > 有新版本（强调色）是一个点，落在「O」缺口里的蓝点上，同时只显示最要紧的那一个。点它打开控制中心（ControlCenter）。

   以前这几样是窄栏左下角的几格（读索引、新版本、同步），加上命令面板、主题两颗按钮；
   状态、动作、偏好长得一样，侧栏收起时还浮在正文左下角（边栏.md §4.5）。
   ============================================================ */

/** 状态环的半径、粗细（28px 的圆里） */
const RING_R = 12.2;
const RING_C = 2 * Math.PI * RING_R;
/** 同步中转的那一段弧占一圈的多少 */
const SPIN_ARC = 0.22;

export type StatusTone = "danger" | "warning" | "accent";

export interface StatusSummary {
  sync: SyncStatus;
  /** describeSync 的短句和说明（「已同步 · 3 分钟前」） */
  syncLabel: string;
  syncDetail: string;
  /** 团队仓库里谁在线（协同编辑.md §22.4）；不是团队仓库是 null */
  team: string | null;
  indexing: { done: number; total: number } | null;
  update: { version: string } | null;
  /** 右上角那个点：只出最要紧的一个 */
  dot: StatusTone | null;
  /** 悬停那一句：「正在读取笔记 702 / 2000 · 离线 · 有新版本 0.10.3」 */
  line: string;
}

/** 「O」和控制中心共用：现在后台是什么状态 */
export function useStatusSummary(): StatusSummary {
  const sync = useData((s) => s.syncStatus);
  const indexing = useData((s) => s.indexing);
  const update = useData((s) => s.update);
  // 「3 分钟前」要自己往前走：同步好了的时候半分钟刷一次
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (sync.state !== "idle") return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [sync]);
  const { label, detail } = describeSync(sync, now);
  const teamActive = useTeam((s) => s.active);
  const peers = useTeam((s) => s.peers);
  const online = [...new Set(peers.filter((peer) => peer.online).map((peer) => peer.name))];
  const team = teamActive
    ? online.length
      ? `${online.join("、")} 在线`
      : "团队里别人都不在线"
    : null;

  const dot: StatusTone | null =
    sync.state === "error" || sync.state === "auth"
      ? "danger"
      : sync.state === "offline"
        ? "warning"
        : update
          ? "accent"
          : null;
  const parts: string[] = [];
  if (indexing) parts.push(`正在读取笔记 ${indexing.done} / ${indexing.total}`);
  // 没开同步就不说（那不是一个「状态」）
  if (sync.state !== "off") parts.push(label);
  if (update) parts.push(`有新版本 ${update.version}`);
  return {
    sync,
    syncLabel: label,
    syncDetail: detail,
    team,
    indexing,
    update,
    dot,
    line: parts.join(" · "),
  };
}

const DOT_TONE: Record<StatusTone, string> = {
  danger: "bg-danger",
  warning: "bg-warning",
  accent: "bg-accent",
};

/** 点从 0 弹到 1，带一点回弹（没有字，能缩，技术方案 §10.1 第 4 条） */
const DOT_POP = { type: "spring", stiffness: 520, damping: 22 } as const;

export const StatusOrb = forwardRef<
  HTMLButtonElement,
  { open: boolean; onToggle: () => void; controls: string }
>(function StatusOrb({ open, onToggle, controls }, ref) {
  const status = useStatusSummary();
  const appReduce = useApp((s) => s.reduceMotion);
  const systemReduce = usePrefersReducedMotion();
  const reduce = appReduce || systemReduce;
  // 开场还盖着的时候先空着：开场写好的「O」落到这里的那一帧才显示（Intro.tsx）
  const covered = useIntro((s) => s.phase) === "cover";

  const progress = status.indexing
    ? status.indexing.total > 0
      ? status.indexing.done / status.indexing.total
      : 0
    : null;
  const spinning = progress === null && status.sync.state === "syncing";
  const ring = progress !== null || spinning;
  const arc = progress !== null ? Math.max(0.04, progress) : SPIN_ARC;
  const label = status.line ? `控制中心：${status.line}` : "控制中心";
  // 悬停提示的字跟着状态走：主字是同步那一句（没开同步就是「控制中心」），读索引、有新版本放第二行
  const tipText = status.sync.state !== "off" ? status.syncLabel : "控制中心";
  const tipDetail = [
    status.indexing && `正在读取笔记 ${status.indexing.done} / ${status.indexing.total}`,
    status.update && `有新版本 ${status.update.version}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      // 控制中心「点外面收起」不算它（它自己会开关）
      data-control-center-trigger=""
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      {...tip(tipText, { detail: tipDetail, name: false })}
      aria-label={label}
      className="group relative grid h-7 w-7 shrink-0 place-items-center rounded-full text-ink"
    >
      <span
        className={cn(
          "absolute -inset-0.5 rounded-full bg-raised transition-opacity duration-[80ms]",
          open ? "opacity-60" : "opacity-0 group-hover:opacity-45",
        )}
      />
      {/* 状态环：转的是这一层 svg 自己（合成器上转），读索引时按进度一段段画，不是逐帧动画 */}
      <svg
        viewBox="0 0 28 28"
        aria-hidden="true"
        className={cn(
          "absolute inset-0 h-7 w-7 transition-opacity duration-200",
          ring ? "opacity-100" : "opacity-0",
          spinning && !reduce && "odea-orb-spin",
        )}
      >
        <circle
          cx="14"
          cy="14"
          r={RING_R}
          fill="none"
          strokeWidth="1.6"
          className="stroke-line-strong"
        />
        <circle
          cx="14"
          cy="14"
          r={RING_R}
          fill="none"
          strokeWidth="1.6"
          strokeLinecap="round"
          transform="rotate(-90 14 14)"
          strokeDasharray={`${(RING_C * arc).toFixed(2)} ${RING_C.toFixed(2)}`}
          className="stroke-accent transition-[stroke-dasharray] duration-300"
        />
      </svg>
      <svg
        viewBox={MARK_VIEWBOX_ATTR}
        aria-hidden="true"
        // 开场动画量这里的位置，让它的「O」落在这儿
        data-odea-logo=""
        className="relative h-7 w-7 overflow-visible"
        style={{ opacity: covered ? 0 : 1 }}
      >
        <path
          d={STROKES[0]}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
        />
        <circle cx={DOT.cx} cy={DOT.cy} r={DOT.r} className="fill-accent" />
      </svg>
      <AnimatePresence initial={false}>
        {status.dot && (
          <motion.span
            key="dot"
            initial={reduce ? false : { scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
            transition={reduce ? { duration: 0 } : DOT_POP}
            // 就落在「O」缺口里那个蓝点上、把它盖住：想法的那一点变成状态（离线黄、出错红、新版本的点大一圈）。
            // 外面一圈刘海的底色把它和「O」、状态环隔开（静态的 box-shadow，不动画）
            className={cn(
              "absolute left-3.5 top-[3px] h-2 w-2 rounded-full shadow-[0_0_0_2px_var(--color-rail)]",
              "transition-colors duration-[120ms]",
              DOT_TONE[status.dot],
            )}
          />
        )}
      </AnimatePresence>
    </button>
  );
});
