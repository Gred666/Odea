import { JOURNAL_WORKSPACES, NAV_WIDTH, hasListColumn, useApp } from "@/app/store";
import { useData } from "@/data/store";
import type { SyncState, WorkspaceId } from "@/data/types";
import { cn } from "@/lib/cn";
import { spring, tween, usePrefersReducedMotion } from "@/lib/motion";
import { shortcut } from "@/lib/platform";
import { describeSync } from "@/lib/syncText";
import {
  Archive,
  CalendarDays,
  CircleFadingArrowUp,
  Cloud,
  CloudAlert,
  CloudOff,
  FolderTree,
  KeyRound,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  SquareCheckBig,
  Target,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AnimatePresence, motion, motionValue, useAnimationControls } from "motion/react";
import type { TargetAndTransition } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";

interface NavItem {
  id: WorkspaceId;
  label: string;
  icon: LucideIcon;
}

// 「文件」一直在；今日 / 目标 / 日历 / 归档是「日程」，仓库开了才有（docs/仓库与启动器.md §6）。
// 扩展页还没有运行时（下载下来的只是一份清单），先不进导航；页面本身留着
const NAV: NavItem[] = [
  { id: "notes", label: "文件", icon: FolderTree },
  { id: "today", label: "今日TODO", icon: SquareCheckBig },
  { id: "goal", label: "/GOAL", icon: Target },
  { id: "calendar", label: "日历", icon: CalendarDays },
  { id: "archive", label: "归档", icon: Archive },
];

/** 窄栏上一格：左右各 12、图标再往里 12，图标中心落在 31.5（64 宽的正中） */
const ROW =
  "group relative flex w-full items-center rounded-lg px-3 transition-colors duration-[140ms]";

/** Logo 里「O」以外那几笔一直是藏着的（窄栏上只有 O） */
const LOGO_HIDDEN = motionValue(0);

const INSTANT = { duration: 0 };

/**
 * 最左边的窄栏（Obsidian 的 ribbon、VS Code 的活动栏，docs/仓库与启动器.md §6）：
 * Logo、各个区的图标、后台读索引 / 新版本 / 同步三样状态、左下角的侧栏开关、命令面板、主题。
 * 字都在悬停提示里。
 *
 * 2026-10-20 以前这里是能在 240 宽（带字）和 64 宽之间切换的导航栏；P11.2 起一直是 64 宽，
 * 能收起的是它右边的列表栏（文件树、月历、归档列表），像 VS Code 的侧栏：
 * 点已经选中的那一项收起 / 展开它，点别的区顺手展开。
 */
export function Sidebar() {
  const workspace = useApp((s) => s.workspace);
  const setWorkspace = useApp((s) => s.setWorkspace);
  const panelCollapsed = useApp((s) => s.panelCollapsed);
  const setPanelCollapsed = useApp((s) => s.setPanelCollapsed);
  const journal = useData((s) => s.layout.journal);
  const appReduce = useApp((s) => s.reduceMotion);
  const systemReduce = usePrefersReducedMotion();
  const reduce = appReduce || systemReduce;
  const items = journal ? NAV : NAV.filter((item) => !JOURNAL_WORKSPACES.includes(item.id));

  const select = (id: WorkspaceId) => {
    if (id === workspace) {
      if (hasListColumn(id)) setPanelCollapsed(!panelCollapsed);
      return;
    }
    setWorkspace(id);
    if (panelCollapsed && hasListColumn(id)) setPanelCollapsed(false);
  };

  return (
    // z-20：中列表栏（z-10）进出场时要从这条窄栏底下滑出来 / 滑回去
    <nav
      className="relative z-20 flex h-full shrink-0 flex-col overflow-hidden bg-rail"
      style={{ width: NAV_WIDTH }}
      aria-label="主导航"
    >
      {/* 顶部：Logo（只有「O」）。pt 留出无边框窗口的拖拽区高度 */}
      <div className="flex h-[76px] shrink-0 items-end px-[22px] pb-4">
        <Logo collapsed reduce={reduce} fade={LOGO_HIDDEN} />
      </div>

      <ul className="flex flex-col gap-[2px] px-3 pt-1">
        {items.map((item, i) => (
          <NavRow
            key={item.id}
            item={item}
            index={i}
            active={workspace === item.id}
            onSelect={() => select(item.id)}
          />
        ))}
      </ul>

      <div className="flex-1" />

      <IndexRow reduce={reduce} />
      <UpdateRow reduce={reduce} />
      <SyncRow reduce={reduce} />
      <FootControls />
    </nav>
  );
}

/* ---------------- 后台读文件进索引（Rust 的 Vault::open_quick） ----------------
   第一次打开一个大文件夹、应用升级后索引要重建时，窗口先出来，文件在后台读 —— 读完之前列表、
   搜索、日历里暂时缺一部分。这一格说清楚还在读、读到哪了（悬停提示），读完就淡掉。
   只淡入淡出；不是按钮，没什么可点的 */

function IndexRow({ reduce }: { reduce: boolean }) {
  const indexing = useData((s) => s.indexing);
  const label = indexing ? `正在读取笔记 ${indexing.done} / ${indexing.total}` : "";
  return (
    <AnimatePresence initial={false}>
      {indexing && (
        <motion.div
          key="indexing"
          className="shrink-0 px-3"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduce ? INSTANT : tween.slow}
        >
          <div
            role="status"
            title={`${label}：第一次打开这个文件夹（或者应用升级了）要把笔记都读一遍，读完之前列表和搜索里暂时缺一部分`}
            aria-label={label}
            className={cn(ROW, "h-8 cursor-default text-muted")}
          >
            {/* 转的是图标（SVG），不是字 */}
            <LoaderCircle
              size={15}
              strokeWidth={1.9}
              className={cn(
                "relative z-10 shrink-0 text-faint",
                !reduce && "animate-spin [animation-duration:1.6s]",
              )}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ---------------- 新版本（技术方案 §14.4） ----------------
   新版本在后台下好、验过签以后，同步那一格上面多出这一格：强调色的「待更新」图标。
   点它打开新版本卡片（components/UpdateDialog.tsx），「稍后」就是关掉卡片，这一格留着，
   直到装上为止。不弹窗、不标红、不挨着 Logo：红色在这里是出错。
   出现时只淡入，图标里的箭头往上探两下；减少动效时什么都不动 */

/** 箭头往上探两下：图标是 SVG，可以动 transform */
const UPDATE_NUDGE = {
  y: [0, -2.5, 0, -2.5, 0],
  transition: { duration: 1.1, delay: 0.35, ease: "easeInOut" as const },
};

function UpdateRow({ reduce }: { reduce: boolean }) {
  const update = useData((s) => s.update);
  const setUpdateDialog = useApp((s) => s.setUpdateDialog);
  const label = update ? `新版本 ${update.version}` : "";
  return (
    <AnimatePresence initial={false}>
      {update && (
        <motion.div
          key="update"
          className="shrink-0 px-3"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduce ? INSTANT : tween.slow}
        >
          <button
            type="button"
            onClick={() => setUpdateDialog("update")}
            title={`${label}：点开看看这一版有什么`}
            aria-label={`${label}，点开看看`}
            className={cn(ROW, "h-8 text-body hover:text-ink")}
          >
            <span
              className="absolute inset-0 rounded-lg bg-accent-wash opacity-0 transition-opacity
                         duration-[140ms] group-hover:opacity-100"
            />
            <motion.span
              className="relative z-10 flex shrink-0 text-accent"
              animate={reduce ? undefined : UPDATE_NUDGE}
            >
              <CircleFadingArrowUp size={15} strokeWidth={1.9} />
            </motion.span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ---------------- 同步状态（技术方案 §5.9.9） ----------------
   导航项下面、左下角那几颗按钮上面的一格：状态图标，一句话（已同步 · 3 分钟前 / 同步中… / 离线…）
   在悬停提示里。点它打开同步对话框 —— 没开同步时这一格就是「开启同步」的入口。 */

const SYNC_ICON: Record<SyncState, LucideIcon> = {
  off: Cloud,
  idle: Cloud,
  syncing: RefreshCw,
  offline: CloudOff,
  auth: KeyRound,
  error: CloudAlert,
};

function SyncRow({ reduce }: { reduce: boolean }) {
  const status = useData((s) => s.syncStatus);
  const setSyncOpen = useApp((s) => s.setSyncOpen);
  // 「3 分钟前」要自己往前走：同步好了的时候半分钟刷一次
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (status.state !== "idle") return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [status]);

  const { label, detail } = describeSync(status, now);
  const Icon = SYNC_ICON[status.state];
  const tone =
    status.state === "auth" || status.state === "error"
      ? "text-danger"
      : status.state === "offline"
        ? "text-warning"
        : status.state === "off"
          ? "text-faint group-hover:text-muted"
          : "text-muted group-hover:text-body";
  return (
    <div className="shrink-0 px-3">
      <button
        type="button"
        onClick={() => setSyncOpen(true)}
        title={`${label}：${detail}`}
        aria-label={`${label}：${detail}`}
        className={cn(ROW, "h-8 text-muted hover:text-ink")}
      >
        <span
          className="absolute inset-0 rounded-lg bg-raised opacity-0 transition-opacity
                     duration-[140ms] group-hover:opacity-45"
        />
        {/* 转的是图标（SVG），不是字 */}
        <Icon
          size={15}
          strokeWidth={1.9}
          className={cn(
            "relative z-10 shrink-0 transition-colors duration-[140ms]",
            tone,
            status.state === "syncing" && !reduce && "animate-spin [animation-duration:1.6s]",
          )}
        />
      </button>
    </div>
  );
}

/* ---------------- 左下角：侧栏开关、命令面板、主题 ----------------
   贴着 64 宽窄栏的中线一列，从下往上：主题、命令面板、侧栏开关（和以前导航栏收起后的样子一样）。
   侧栏开关收起 / 展开的是窄栏右边那一栏（文件树、月历、归档列表）；今日TODO、目标没有那一栏，
   这时候按它只是记下来，回到文件时照着办 */

/** 按钮边长，和 ThemeToggle 一样 */
const KNOB = 28;

function FootControls() {
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  const panelCollapsed = useApp((s) => s.panelCollapsed);
  const setPanelCollapsed = useApp((s) => s.setPanelCollapsed);
  const combo = shortcut("K");
  const ToggleIcon = panelCollapsed ? PanelLeftOpen : PanelLeftClose;
  const toggleLabel = panelCollapsed ? "展开侧栏" : "收起侧栏";

  return (
    <div className="flex shrink-0 flex-col items-center gap-1 pt-3 pb-4">
      {/* 收起 / 展开。图标换的那一下只淡（CLAUDE.md 动效规矩 1） */}
      <button
        type="button"
        onClick={() => setPanelCollapsed(!panelCollapsed)}
        aria-label={toggleLabel}
        title={toggleLabel}
        style={{ width: KNOB, height: KNOB }}
        className="grid place-items-center rounded-md text-muted transition-colors duration-[140ms]
                   hover:bg-raised hover:text-ink"
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={panelCollapsed ? "open" : "close"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={tween.fast}
            className="grid place-items-center"
          >
            <ToggleIcon size={14.5} strokeWidth={1.9} />
          </motion.span>
        </AnimatePresence>
      </button>

      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        aria-label={`打开命令面板（${combo}）`}
        title={`命令面板（${combo}）`}
        style={{ width: KNOB, height: KNOB }}
        className="grid place-items-center rounded-md text-muted transition-colors duration-[140ms]
                   hover:bg-raised hover:text-ink"
      >
        <Search size={14} strokeWidth={1.9} />
      </button>

      <ThemeToggle />
    </div>
  );
}

/**
 * 每个图标的「签名动作」—— 切到这一页时播一次。
 *
 * 关键是动作得跟图标画的那个物件对得上：铃铛就摇、靶心就收拢、盖子就压下去。
 * 六个图标共用一套缩放的话，动是动了，但读不出「这是哪一页」——
 * Telegram 那套底栏之所以有记忆点，就在于每个图标动得不一样。
 *
 * 全部只动 transform（rotate / scale / y），走合成器，不触发排版。
 * 摆动类的支点要挪：铃铛在钟顶、归档盒在底边，用 origin 单独给。
 */
const ICON_MOTION: Record<WorkspaceId, { to: TargetAndTransition; origin: string }> = {
  // 文件树晃一下：支点在左下角，像翻开一摞文件
  notes: {
    to: { rotate: [0, -12, 6, 0], scale: [1, 1.1, 1], transition: { duration: 0.42 } },
    origin: "30% 80%",
  },
  // 勾上一项：先按下去，再弹起来
  today: {
    to: { scale: [1, 0.8, 1.14, 1], y: [0, 1.5, -1, 0], transition: { duration: 0.42 } },
    origin: "50% 60%",
  },
  // 命中靶心：先收后放
  goal: {
    to: { scale: [1, 0.78, 1.18, 1], transition: { duration: 0.44 } },
    origin: "50% 50%",
  },
  // 翻一页，轻轻跳一下
  calendar: {
    to: { y: [0, -3.5, 0], scale: [1, 1.09, 1], transition: { duration: 0.4 } },
    origin: "50% 50%",
  },
  // 盖子压下去再回弹，支点在盒底
  archive: {
    to: { scaleY: [1, 0.74, 1.08, 1], y: [0, 2, 0], transition: { duration: 0.46 } },
    origin: "50% 82%",
  },
  // 拼图咔一下扣进去
  extensions: {
    to: { rotate: [0, 18, -8, 0], scale: [1, 1.1, 1], transition: { duration: 0.5 } },
    origin: "50% 50%",
  },
};

function NavRow({
  item,
  index,
  active,
  onSelect,
}: {
  item: NavItem;
  index: number;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = item.icon;
  const motionSpec = ICON_MOTION[item.id];
  const icon = useAnimationControls();

  // Shell 上那层 MotionConfig 管不到这里：reducedMotion="always" 不会拦
  // useAnimationControls().start() 派下去的 transform（实测开了「减少动效」
  // 铃铛照样摇 ±18°）。所以按 Shell 同样的口径自己判一次：
  // 应用内开关 or 系统偏好。
  const appReduce = useApp((s) => s.reduceMotion);
  const systemReduce = usePrefersReducedMotion();
  const skipMotion = appReduce || systemReduce;

  // 点已经选中的那一项也要有反馈，所以不能只看 active 翻没翻 —— 补一个计数器。
  // 点未选中项时两者在同一次提交里一起变，effect 仍然只跑一次。
  const [tapCount, setTapCount] = useState(0);
  const mounted = useRef(false);

  // tapCount 在函数体里没被读到，但它就是「再播一次」的信号：少了它，
  // 点击已经选中的那一项不会有任何反馈。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 计数器用作重放触发器
  useEffect(() => {
    // 首屏那一次不播：导航项本来就在做错峰入场，再叠一层就太吵了
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!active || skipMotion) return;
    void icon.start(motionSpec.to);
  }, [active, tapCount, icon, motionSpec, skipMotion]);

  return (
    // 首屏错峰淡入。只淡 opacity，不位移（CLAUDE.md 动效规矩 1）
    <motion.li
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ ...tween.base, delay: 0.3 + index * 0.04 }}
    >
      <motion.button
        type="button"
        onClick={() => {
          onSelect();
          setTapCount((n) => n + 1);
        }}
        // 按下去整条压一下：手指离开之前就有回应，不用等页面切完
        whileTap={skipMotion ? undefined : { scale: 0.965 }}
        transition={spring.snappy}
        aria-current={active ? "page" : undefined}
        aria-label={item.label}
        title={item.label}
        className={cn(ROW, "h-9", active ? "text-ink" : "text-body hover:text-ink")}
      >
        {/* 活动指示：同一个 layoutId 在导航项之间滑动 */}
        {active && (
          <motion.span
            layoutId="nav-indicator"
            className="absolute inset-0 rounded-lg bg-raised"
            transition={spring.smooth}
          />
        )}
        {/* 非活动项的 hover 底：独立一层，避免和指示器抢同一个背景 */}
        {!active && (
          <span
            className="absolute inset-0 rounded-lg bg-raised opacity-0 transition-opacity
                       duration-[140ms] group-hover:opacity-45"
          />
        )}

        <motion.span
          animate={icon}
          style={{ transformOrigin: motionSpec.origin }}
          className="relative z-10 flex shrink-0"
        >
          <Icon
            size={15}
            strokeWidth={1.9}
            className={cn(
              "transition-colors duration-[140ms]",
              active ? "text-ink" : "text-muted group-hover:text-body",
            )}
          />
        </motion.span>
      </motion.button>
    </motion.li>
  );
}
