import { type ThemePref, useApp } from "@/app/store";
import { backend } from "@/data/backend";
import type { SyncState } from "@/data/types";
import { cn } from "@/lib/cn";
import { useModalFocus } from "@/lib/modalFocus";
import { popoverCard, usePrefersReducedMotion } from "@/lib/motion";
import { isMac } from "@/lib/platform";
import { tip } from "@/lib/tooltip";
import {
  CircleFadingArrowUp,
  Cloud,
  CloudAlert,
  CloudOff,
  Command,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Search,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { motion, useIsPresent } from "motion/react";
import { forwardRef, useEffect, useRef, useState } from "react";
import { Segmented } from "./Segmented";
import { useStatusSummary } from "./StatusOrb";
import { ThemeGlyph } from "./ThemeGlyph";

/* ============================================================
   控制中心（docs/边栏.md §4.4）：点刘海里的「O」从刘海下面展开的一张卡。
   同步（状态 + 立即同步，点这一行开同步对话框）、读索引（读的时候才有）、新版本（有才有）、
   外观（跟随系统 / 亮 / 暗）、搜索与命令（Ctrl K）。

   popoverCard 从上边展开，不缩放（技术方案 §10.1 第 4 条）。打开以后不跳（第 5 条）：
   读索引、新版本那两行有没有在打开的那一刻定下来，开着的时候读完了，那一行留着、写「读完了」；
   开着的时候才来的新版本等下次打开再列（「O」上的点已经在了）。
   焦点：打开进卡片、Tab 在卡片里转、Esc 和点外面收起，焦点还给「O」（useModalFocus）。
   ============================================================ */

const SYNC_ICON: Record<SyncState, LucideIcon> = {
  off: Cloud,
  idle: Cloud,
  syncing: RefreshCw,
  offline: CloudOff,
  auth: KeyRound,
  error: CloudAlert,
};

const SYNC_TONE: Record<SyncState, string> = {
  off: "text-faint",
  idle: "text-success",
  syncing: "text-accent",
  offline: "text-warning",
  auth: "text-danger",
  error: "text-danger",
};

const THEMES: { value: ThemePref; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "亮" },
  { value: "dark", label: "暗" },
];

const ICON = { size: 16, strokeWidth: 1.8 } as const;

/**
 * 一行 40 高，左右留 10；圆角 8 + 卡片的内边距 6 = 卡片的圆角 14（同心）
 */
const ROW = "flex min-h-10 items-center gap-2.5 rounded-md px-2.5 py-1.5";
/** 能点的那一行：悬停底色 80ms 淡入 */
const ROW_BUTTON = cn(ROW, "w-full text-left transition-colors duration-[80ms] hover:bg-rail");
/** 行右边的小按钮（立即同步、看看）：24 高 */
const SMALL_BUTTON =
  "h-6 shrink-0 rounded-sm bg-rail px-2.5 text-[12px] text-ink transition-colors duration-[80ms] hover:bg-raised disabled:opacity-50";

export const ControlCenter = forwardRef<HTMLDivElement, { id: string; onClose: () => void }>(
  function ControlCenter({ id, onClose }, ref) {
    const status = useStatusSummary();
    const setSyncOpen = useApp((s) => s.setSyncOpen);
    const setUpdateDialog = useApp((s) => s.setUpdateDialog);
    const setPaletteOpen = useApp((s) => s.setPaletteOpen);
    const theme = useApp((s) => s.theme);
    const setTheme = useApp((s) => s.setTheme);
    const appReduce = useApp((s) => s.reduceMotion);
    const systemReduce = usePrefersReducedMotion();
    const reduce = appReduce || systemReduce;

    // 打开的那一刻有哪几行（见文件开头：开着的时候不增减）
    const [rows] = useState(() => ({
      indexing: status.indexing !== null,
      update: status.update !== null,
    }));
    const lastUpdate = useRef(status.update);
    if (status.update) lastUpdate.current = status.update;

    const panel = useRef<HTMLDivElement | null>(null);
    const modalRef = useModalFocus(useIsPresent());
    const setPanel = (el: HTMLDivElement | null) => {
      panel.current = el;
      modalRef(el);
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    };

    // 点卡片外面收起（「O」自己会开关，不算外面）
    useEffect(() => {
      const away = (event: PointerEvent) => {
        const target = event.target as Element | null;
        if (panel.current?.contains(target) || target?.closest("[data-control-center-trigger]"))
          return;
        onClose();
      };
      document.addEventListener("pointerdown", away, true);
      return () => document.removeEventListener("pointerdown", away, true);
    }, [onClose]);

    const SyncIcon = SYNC_ICON[status.sync.state];
    const syncState = status.sync.state;
    const indexing = status.indexing;
    const update = lastUpdate.current;
    // 已同步时短句里已经有「3 分钟前」，说明那一行写同步到哪
    const syncDetail =
      syncState === "idle" && status.sync.remote ? status.sync.remote : status.syncDetail;
    const detail = [syncDetail, status.team].filter(Boolean).join(" · ");

    const openSync = () => {
      onClose();
      setSyncOpen(true);
    };

    return (
      <motion.div
        ref={setPanel}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-label="控制中心"
        // Esc 挂在卡片上：焦点在卡片本身时也收得掉
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
        variants={popoverCard}
        custom={0}
        initial="hidden"
        animate="shown"
        exit="gone"
        className="absolute left-2 top-[54px] z-[4] w-[284px] overflow-clip rounded-xl bg-canvas
                   shadow-float ring-1 ring-line-strong"
      >
        <div className="flex flex-col p-1.5">
          {/* ---------- 同步 ---------- */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={openSync}
              className={cn(ROW_BUTTON, "min-w-0 flex-1")}
              {...tip(detail, { name: false, side: "right" })}
            >
              <SyncIcon
                {...ICON}
                className={cn(
                  "shrink-0",
                  SYNC_TONE[syncState],
                  syncState === "syncing" && !reduce && "animate-spin [animation-duration:1.6s]",
                )}
              />
              <span className="flex min-w-0 flex-col leading-[1.35]">
                <span className="truncate text-[13px] font-medium text-ink">
                  {syncState === "off" ? "没开同步" : status.syncLabel}
                </span>
                <span className="truncate text-[12px] text-muted">{detail}</span>
              </span>
            </button>
            {syncState === "auth" ? (
              <button type="button" onClick={openSync} className={cn(SMALL_BUTTON, "mr-1.5")}>
                重新登录
              </button>
            ) : syncState !== "off" ? (
              <button
                type="button"
                disabled={syncState === "syncing"}
                onClick={() => void backend().then((api) => api.syncNow())}
                className={cn(SMALL_BUTTON, "mr-1.5")}
              >
                立即同步
              </button>
            ) : null}
          </div>

          {/* ---------- 读索引（打开的时候在读才有） ---------- */}
          {rows.indexing && (
            <div className={ROW} role="status">
              <LoaderCircle
                {...ICON}
                className={cn(
                  "shrink-0 text-accent",
                  indexing && !reduce && "animate-spin [animation-duration:1.6s]",
                )}
              />
              <span className="flex min-w-0 flex-1 flex-col leading-[1.35]">
                {/* 两行都只占一行：读完了换字，卡片高度不变 */}
                <span className="truncate text-[13px] font-medium text-ink tabular-nums">
                  {indexing ? `正在读取笔记 ${indexing.done} / ${indexing.total}` : "笔记读完了"}
                </span>
                <span className="truncate text-[12px] text-muted">
                  {indexing ? "读完之前列表和搜索里暂时缺一部分" : "列表和搜索都是全的了"}
                </span>
                <span className="rounded-capsule mt-1.5 h-[3px] overflow-hidden bg-line-strong">
                  <span
                    className="rounded-capsule block h-full bg-accent transition-[width] duration-300"
                    style={{
                      width: `${indexing ? (indexing.done / Math.max(1, indexing.total)) * 100 : 100}%`,
                    }}
                  />
                </span>
              </span>
            </div>
          )}

          {/* ---------- 新版本（打开的时候有才有） ---------- */}
          {rows.update && update && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  onClose();
                  setUpdateDialog("update");
                }}
                className={cn(ROW_BUTTON, "min-w-0 flex-1")}
              >
                <CircleFadingArrowUp {...ICON} className="shrink-0 text-accent" />
                <span className="flex min-w-0 flex-col leading-[1.35]">
                  <span className="truncate text-[13px] font-medium text-ink">
                    新版本 {update.version}
                  </span>
                  <span className="truncate text-[12px] text-muted">点开看看这一版有什么</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  setUpdateDialog("update");
                }}
                className={cn(SMALL_BUTTON, "mr-1.5")}
              >
                看看
              </button>
            </div>
          )}

          <div className="mx-2.5 my-1 h-px bg-line" />

          {/* ---------- 外观 ---------- */}
          <div className={cn(ROW, "justify-between")}>
            <span className="flex items-center gap-2.5 text-muted">
              <ThemeGlyph />
              <span className="text-[13px] font-medium text-ink">外观</span>
            </span>
            <Segmented
              group="theme"
              size="sm"
              options={THEMES}
              value={theme}
              onChange={(value) => void setTheme(value)}
            />
          </div>

          {/* ---------- 搜索与命令 ---------- */}
          <button
            type="button"
            onClick={() => {
              onClose();
              setPaletteOpen(true);
            }}
            className={ROW_BUTTON}
          >
            <Search {...ICON} className="shrink-0 text-muted" />
            <span className="flex-1 text-[13px] font-medium text-ink">搜索与命令</span>
            {/* 按键画成图标：⌘ 这类字界面字体里没有，第一次画要满系统找字体（PITFALLS/弹出层.md） */}
            <span className="flex items-center gap-1" aria-hidden="true">
              {[isMac ? Command : "Ctrl", "K"].map((Key) => (
                <kbd
                  key={typeof Key === "string" ? Key : "mod"}
                  className="grid h-[18px] min-w-[18px] place-items-center rounded-xs border border-line-strong
                             px-1 font-sans text-[11px] leading-none text-muted"
                >
                  {typeof Key === "string" ? Key : <Key size={12} strokeWidth={2.2} />}
                </kbd>
              ))}
            </span>
          </button>
        </div>
      </motion.div>
    );
  },
);
