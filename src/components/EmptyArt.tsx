import { cn } from "@/lib/cn";
import { tween } from "@/lib/motion";
import { motion } from "motion/react";

/* ============================================================
   空状态插画。

   线稿 + 一点主色，全部用颜色 token 画（描边 line-strong、纸面 canvas、
   底纸 raised、强调 accent），暗色模式下跟着换，不需要两套图。
   只淡入，不缩放、不位移（技术方案 §10.1 第 4 条：和它同屏的就是文字）。
   ============================================================ */

export type EmptyArtKind = "notes" | "archive" | "search";

const STROKE = "var(--color-line-strong)";
const PAPER = "var(--color-canvas)";
const UNDER = "var(--color-raised)";
const ACCENT = "var(--color-accent)";
const WASH = "var(--color-accent-wash)";
const FAINT = "var(--color-faint)";

export function EmptyArt({ kind, className }: { kind: EmptyArtKind; className?: string }) {
  return (
    <svg
      viewBox="0 0 160 120"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("block", className)}
    >
      {kind === "notes" && <NotesArt />}
      {kind === "archive" && <ArchiveArt />}
      {kind === "search" && <SearchArt />}
    </svg>
  );
}

/** 两页纸，一支笔：还没写，但可以从这里开始 */
function NotesArt() {
  return (
    <g strokeWidth={1.5}>
      <ellipse cx="80" cy="108" rx="46" ry="5" fill={UNDER} />
      <rect
        x="36"
        y="20"
        width="62"
        height="80"
        rx="7"
        fill={UNDER}
        stroke={STROKE}
        transform="rotate(-7 67 60)"
      />
      <rect
        x="56"
        y="14"
        width="64"
        height="84"
        rx="7"
        fill={PAPER}
        stroke={STROKE}
        transform="rotate(3 88 56)"
      />
      <g transform="rotate(3 88 56)">
        <rect
          x="67"
          y="28"
          width="26"
          height="5"
          rx="2.5"
          fill={ACCENT}
          stroke="none"
          opacity={0.85}
        />
        <path d="M67 43h40M67 52h34M67 61h38M67 70h22" stroke={STROKE} />
      </g>
      {/* 笔 */}
      <g transform="rotate(38 118 78)">
        <rect x="113" y="50" width="10" height="44" rx="3" fill={WASH} stroke={ACCENT} />
        <path d="M113 94l5 9 5-9" fill={PAPER} stroke={ACCENT} />
        <path d="M113 58h10" stroke={ACCENT} />
      </g>
      {/* 一点亮光 */}
      <path d="M30 26v8M26 30h8" stroke={ACCENT} />
      <circle cx="132" cy="22" r="2" fill={FAINT} stroke="none" />
    </g>
  );
}

/** 一个盒子，一页纸露出半截：收起来了，但没丢 */
function ArchiveArt() {
  return (
    <g strokeWidth={1.5}>
      <ellipse cx="80" cy="108" rx="50" ry="5" fill={UNDER} />
      <rect
        x="54"
        y="16"
        width="52"
        height="58"
        rx="5"
        fill={PAPER}
        stroke={STROKE}
        transform="rotate(-5 80 45)"
      />
      <g transform="rotate(-5 80 45)">
        <rect
          x="62"
          y="26"
          width="20"
          height="4"
          rx="2"
          fill={ACCENT}
          stroke="none"
          opacity={0.85}
        />
        <path d="M62 37h34M62 45h28" stroke={STROKE} />
      </g>
      {/* 盒身 */}
      <path d="M34 56h92v40a7 7 0 0 1-7 7H41a7 7 0 0 1-7-7z" fill={UNDER} stroke={STROKE} />
      {/* 盒沿 */}
      <rect x="28" y="48" width="104" height="12" rx="4" fill={PAPER} stroke={STROKE} />
      {/* 标签 */}
      <rect x="66" y="70" width="28" height="12" rx="3" fill={WASH} stroke={ACCENT} />
      <path d="M73 76h14" stroke={ACCENT} />
    </g>
  );
}

/** 一张空白卡片，放大镜照过去什么都没有 */
function SearchArt() {
  return (
    <g strokeWidth={1.5}>
      <ellipse cx="80" cy="108" rx="44" ry="5" fill={UNDER} />
      <rect x="38" y="20" width="74" height="78" rx="7" fill={PAPER} stroke={STROKE} />
      <path d="M50 36h34M50 48h44M50 60h26M50 72h38" stroke={STROKE} strokeDasharray="3 5" />
      {/* 放大镜 */}
      <circle cx="104" cy="66" r="17" fill={WASH} stroke={ACCENT} strokeWidth={2} />
      <path d="M116.5 78.5l12 12" stroke={ACCENT} strokeWidth={4} />
      <path d="M97 60.5a8 8 0 0 1 7-4" stroke={PAPER} strokeWidth={2} opacity={0.9} />
    </g>
  );
}

/** 插画 + 一句话（+ 一个按钮）。正文区和列表栏共用，size 决定插画多大。 */
export function EmptyState({
  art,
  title,
  hint,
  size = "lg",
  action,
}: {
  art: EmptyArtKind;
  title: string;
  hint?: string;
  size?: "sm" | "lg";
  action?: { label: string; onClick: () => void };
}) {
  const large = size === "lg";
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ ...tween.base, delay: 0.04 }}
      className="flex flex-col items-center text-center"
    >
      <EmptyArt kind={art} className={large ? "w-[176px]" : "w-[118px]"} />
      <p
        className={cn("font-semibold text-ink/90", large ? "mt-5 text-[17px]" : "mt-3 text-[13px]")}
      >
        {title}
      </p>
      {hint && (
        <p
          className={cn(
            "max-w-[300px] text-muted",
            large
              ? "mt-1.5 text-[13px] leading-[1.6]"
              : "mt-1 text-[12px] leading-[1.55] text-faint",
          )}
        >
          {hint}
        </p>
      )}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-5 rounded-lg bg-accent px-3.5 py-[7px] text-[13px] font-medium text-accent-ink
                     transition-colors duration-[140ms] hover:bg-accent-hover"
        >
          {action.label}
        </button>
      )}
    </motion.div>
  );
}
