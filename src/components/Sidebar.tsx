import {
  LABEL_IN,
  LABEL_OUT,
  NAV_TRANSITION,
  navLabelOpacity,
  navLayoutWidth,
  navPanelWidth,
  navWidthOf,
} from "@/app/navMotion";
import { useApp } from "@/app/store";
import { useData } from "@/data/store";
import type { SyncState, WorkspaceId } from "@/data/types";
import { cn } from "@/lib/cn";
import { spring, stagger, tween, usePrefersReducedMotion } from "@/lib/motion";
import { shortcut } from "@/lib/platform";
import { describeSync } from "@/lib/syncText";
import {
  Archive,
  CalendarDays,
  CircleFadingArrowUp,
  Cloud,
  CloudAlert,
  CloudOff,
  KeyRound,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  SquareCheckBig,
  Target,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AnimatePresence, animate, motion, useAnimationControls } from "motion/react";
import type { TargetAndTransition } from "motion/react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";

interface NavItem {
  id: WorkspaceId;
  label: string;
  icon: LucideIcon;
}

// 扩展页还没有运行时（下载下来的只是一份清单），先不进导航；页面本身留着
const NAV: NavItem[] = [
  { id: "notes", label: "笔记", icon: NotebookPen },
  { id: "today", label: "今日TODO", icon: SquareCheckBig },
  { id: "goal", label: "/GOAL", icon: Target },
  { id: "calendar", label: "日历", icon: CalendarDays },
  { id: "archive", label: "归档", icon: Archive },
];

/** 导航项的行样式：左右各 12、图标再往里 12 —— 收起时图标正好在 64 宽的中间 */
const ROW =
  "group relative flex w-full items-center gap-2.5 rounded-lg px-3 text-left transition-colors duration-[140ms]";

/**
 * 左侧导航。可以收成一条 64px 宽、只有图标的窄栏（窄窗口里给正文让地方），收起与否记在本机。
 *
 * 两层：外面的 <nav> 是排版用的盒子，切换那一帧直接是新宽度（正文只重排一次）；
 * 看得见的底板是里面一层 absolute 的面板，宽度从旧值滑到新值，里面的行跟着它的宽度排
 * （十来个元素，关在 contain 里，碰不到外面）。图标在两种宽度下是同一个 x，滑的时候一动不动；
 * 文字只淡入淡出，被底板的右边缘裁掉。列表栏、正文怎么跟上，见 app/navMotion.ts。
 */
export function Sidebar() {
  const workspace = useApp((s) => s.workspace);
  const setWorkspace = useApp((s) => s.setWorkspace);
  const collapsed = useApp((s) => s.navCollapsed);
  const appReduce = useApp((s) => s.reduceMotion);
  const systemReduce = usePrefersReducedMotion();
  const reduce = appReduce || systemReduce;

  // 切换的那一帧：排版宽度立刻是新值，底板和文字从现在的样子动过去（中途再点也接得上）。
  // layout effect：列表栏的位移（看起来的宽 - 排版上的宽）得在这一帧画出来之前就对上
  const first = useRef(true);
  useLayoutEffect(() => {
    const target = navWidthOf(collapsed);
    navLayoutWidth.set(target);
    if (first.current || reduce) {
      first.current = false;
      navPanelWidth.set(target);
      navLabelOpacity.set(collapsed ? 0 : 1);
      return;
    }
    const panel = animate(navPanelWidth, target, NAV_TRANSITION);
    const labels = animate(navLabelOpacity, collapsed ? 0 : 1, collapsed ? LABEL_OUT : LABEL_IN);
    return () => {
      panel.stop();
      labels.stop();
    };
  }, [collapsed, reduce]);

  return (
    // z-20：中列表栏（z-10）进出场时要从这条导航栏底下滑出来 / 滑回去
    <nav
      className="relative z-20 h-full shrink-0"
      style={{ width: navWidthOf(collapsed) }}
      aria-label="主导航"
    >
      <motion.div
        className="absolute inset-y-0 left-0 flex flex-col overflow-hidden bg-rail [contain:layout_paint]"
        style={{ width: navPanelWidth }}
      >
        {/* 顶部：Logo。pt 留出无边框窗口的拖拽区高度 */}
        <div className="flex h-[76px] shrink-0 items-end px-[22px] pb-4">
          {/* 收起时字母跟着导航文字淡出，「O」留下来变成图标的样子（见 Logo） */}
          <Logo collapsed={collapsed} reduce={reduce} fade={navLabelOpacity} />
        </div>

        <ul className="flex flex-col gap-[2px] px-3 pt-1">
          {NAV.map((item, i) => (
            <NavRow
              key={item.id}
              item={item}
              index={i}
              active={workspace === item.id}
              collapsed={collapsed}
              onSelect={() => setWorkspace(item.id)}
            />
          ))}
        </ul>

        <div className="flex-1" />

        <UpdateRow collapsed={collapsed} reduce={reduce} />
        <SyncRow collapsed={collapsed} reduce={reduce} />
        <FootControls collapsed={collapsed} reduce={reduce} />
      </motion.div>
    </nav>
  );
}

/** 一行里图标后面的文字：跟着底板淡入淡出，被它的右边缘裁掉（不出省略号）。不动位置、不缩放 */
function RowLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.span
      style={{ opacity: navLabelOpacity }}
      className={cn("relative z-10 min-w-0 flex-1 overflow-hidden whitespace-nowrap", className)}
    >
      {children}
    </motion.span>
  );
}

/* ---------------- 新版本（技术方案 §14.4） ----------------
   新版本在后台下好、验过签以后，同步那一行上面多出这一行：强调色的「待更新」图标 + 「新版本 0.2.0」。
   点它打开新版本卡片（components/UpdateDialog.tsx），「稍后」就是关掉卡片，这一行留着，
   直到装上为止。不弹窗、不标红、不挨着 Logo：红色在这里是出错，Logo 那块收起时只剩一个「O」。
   它占的是上面那段空白（flex-1），同步那一行和左下角那排不挪。
   出现时只淡入（带字的不缩放、不位移），图标里的箭头往上探两下；减少动效时什么都不动 */

/** 箭头往上探两下：图标是 SVG，可以动 transform */
const UPDATE_NUDGE = {
  y: [0, -2.5, 0, -2.5, 0],
  transition: { duration: 1.1, delay: 0.35, ease: "easeInOut" as const },
};

function UpdateRow({ collapsed, reduce }: { collapsed: boolean; reduce: boolean }) {
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
            title={collapsed ? `${label}：点开看看` : "点开看看这一版有什么"}
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
            <RowLabel className="text-[12.5px]">{label}</RowLabel>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ---------------- 同步状态（技术方案 §5.9.9） ----------------
   导航项下面、左下角那排按钮上面的一行：图标 + 一句状态（已同步 · 3 分钟前 / 同步中… / 离线…）。
   和导航项一样的行：收起时只剩图标，图标的 x 不变，文字跟着导航的文字一起淡出。
   点它打开同步对话框 —— 没开同步时这一行就是「开启同步」的入口。
   放在这里而不是左下角那排：那排展开时塞不下第四个按钮（命令面板的字会被截掉）。 */

const SYNC_ICON: Record<SyncState, LucideIcon> = {
  off: Cloud,
  idle: Cloud,
  syncing: RefreshCw,
  offline: CloudOff,
  auth: KeyRound,
  error: CloudAlert,
};

function SyncRow({ collapsed, reduce }: { collapsed: boolean; reduce: boolean }) {
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
        title={collapsed ? `${label}：${detail}` : detail}
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
        <RowLabel className="text-[12.5px]">{label}</RowLabel>
      </button>
    </div>
  );
}

/* ---------------- 左下角：主题、命令面板、收起 ----------------
   展开时是一行：[主题][命令面板 ……… Ctrl K][收起]；收起时是贴着 64px 窄栏中线的一列，
   从下往上：主题、命令面板、展开 —— 像那一行以「主题」为轴往上折起来，离得越远的折得越高。

   三样东西各自 absolute 定在左下角这块里，坐标写死（不跟底板的宽度走），只动 transform 和
   命令面板那颗按钮自己的宽度：底板滑动的时候它们不重排，各走各的路线。

   两段走，任何时候都不叠在一起、也不被底板的右边缘裁掉：
   - 收起：先在原地错开成三层（主题不动，命令面板升一格、同时缩成方块，收起按钮升两格），
     再整列跟着边缘往左收。横向和边缘同一条曲线，最右边那个永远在边缘以内
   - 展开：倒过来。整列先跟着边缘往右走（还是三层，互相不碰），快到位了再落成一行；
     命令面板的字等落下来才出来
   只先横着收的话（上一版），命令面板会滑到主题身上、收起按钮会压在 Ctrl K 上，要好几帧才分开。 */

/** 这一块的高度：一列三格（28 + 4 间隔）加上下留白 */
const FOOT_HEIGHT = 112;
/** 按钮边长，和 ThemeToggle 一样 */
const KNOB = 28;
/** 展开时那一行的 y（离底 16，和以前的 pb-4 一样） */
const ROW_Y = FOOT_HEIGHT - 16 - KNOB;
/** 收起时一格的高度 */
const SLOT = KNOB + 4;
/** 收起时那一列的 x：64 宽的正中 */
const COLUMN_X = 32 - KNOB / 2;

const FOOT_LAYOUT = {
  expanded: {
    // 主题和收起后一样在 COLUMN_X：图标的中线（32）和上面导航项、同步那一行的图标（31.5）
    // 对成一列。以前在 12，图标往左错出去 5.5px，一眼看过去最底下那颗不在列上；
    // 现在收起 / 展开时它也不横着挪，真的是整行折起来的那根轴
    theme: { x: COLUMN_X, y: ROW_Y },
    // 主题后面空 4，一直铺到收起按钮前面 4
    palette: {
      x: COLUMN_X + KNOB + 4,
      y: ROW_Y,
      width: 240 - 12 - KNOB - 4 - (COLUMN_X + KNOB + 4),
    },
    toggle: { x: 240 - 12 - KNOB, y: ROW_Y },
  },
  collapsed: {
    theme: { x: COLUMN_X, y: ROW_Y },
    palette: { x: COLUMN_X, y: ROW_Y - SLOT, width: KNOB },
    toggle: { x: COLUMN_X, y: ROW_Y - SLOT * 2 },
  },
} as const;

/** 错开 / 落下那一段：快起步、轻收尾 */
const SNAP_EASE = [0.22, 1, 0.36, 1] as const;
/** 收起：先竖起来（纵向和缩成方块都在头 0.24s 里），横向跟着底板的边缘 */
const FOLD = {
  y: { duration: 0.24, ease: SNAP_EASE },
  width: { duration: 0.24, ease: SNAP_EASE },
  x: NAV_TRANSITION,
};
/** 展开：横向跟着边缘先走，到了 0.3s（边缘走完大半）再落成一行 */
const UNFOLD = {
  x: NAV_TRANSITION,
  width: NAV_TRANSITION,
  y: { duration: 0.24, delay: 0.3, ease: SNAP_EASE },
};
const INSTANT = { duration: 0 };
/** 命令面板的字：收起时马上淡掉；展开时等落成一行再出来（不跟着竖着的那一格往下掉） */
const PALETTE_LABEL_OUT = { duration: 0.1, ease: "easeOut" } as const;
const PALETTE_LABEL_IN = { duration: 0.2, delay: 0.42, ease: "easeOut" } as const;

function FootControls({ collapsed, reduce }: { collapsed: boolean; reduce: boolean }) {
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  const setNavCollapsed = useApp((s) => s.setNavCollapsed);
  const combo = shortcut("K");
  const at = collapsed ? FOOT_LAYOUT.collapsed : FOOT_LAYOUT.expanded;
  const transition = reduce ? INSTANT : collapsed ? FOLD : UNFOLD;
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const toggleLabel = collapsed ? "展开导航栏" : "收起导航栏";

  // 按钮在跑的那半秒：指针还停在点下去的地方，悬停的底色不该跟着按钮一起跑走
  // （globals.css 的 [data-foot-moving]）。直接改 DOM 属性，不为它多渲染两次
  const box = useRef<HTMLDivElement>(null);
  const firstRun = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: collapsed 变了就是开始跑了
  useLayoutEffect(() => {
    const node = box.current;
    if (firstRun.current || !node) {
      firstRun.current = false;
      return;
    }
    node.dataset.footMoving = "";
    const timer = setTimeout(() => delete node.dataset.footMoving, 650);
    return () => {
      clearTimeout(timer);
      delete node.dataset.footMoving;
    };
  }, [collapsed]);

  return (
    <div ref={box} className="relative shrink-0" style={{ height: FOOT_HEIGHT }}>
      <motion.div
        className="absolute left-0 top-0"
        initial={false}
        animate={at.theme}
        transition={transition}
      >
        <ThemeToggle />
      </motion.div>

      {/* 命令面板：展开时是带字的长条，收起时缩成和另外两个一样的方块。
          图标钉在左边 7px（方块里正好居中），字和快捷键跟着导航的文字一起淡出 */}
      <motion.button
        type="button"
        onClick={() => setPaletteOpen(true)}
        aria-label={`打开命令面板（${combo}）`}
        title={`命令面板（${combo}）`}
        initial={false}
        animate={at.palette}
        transition={transition}
        style={{ height: KNOB }}
        className="absolute left-0 top-0 flex items-center gap-1.5 overflow-hidden rounded-md pl-[7px]
                   text-muted transition-colors duration-[140ms] hover:bg-raised hover:text-ink"
      >
        <Search size={14} strokeWidth={1.9} className="shrink-0" />
        <motion.span
          initial={false}
          animate={{ opacity: collapsed ? 0 : 1 }}
          transition={reduce ? INSTANT : collapsed ? PALETTE_LABEL_OUT : PALETTE_LABEL_IN}
          className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap pr-1.5"
          aria-hidden="true"
        >
          <span className="text-[12px]">命令面板</span>
          {/* 颜色继承按钮，不再单独压成 text-faint —— 那个灰度在 rail 底上对比度
              只有 2 出头，正是「看不清这是啥」的一半原因 */}
          <kbd
            className="ml-auto shrink-0 rounded border border-line-strong px-1 py-0.5 font-mono
                       text-[10px] leading-none"
          >
            {combo}
          </kbd>
        </motion.span>
      </motion.button>

      {/* 收起 / 展开。图标换的那一下只动图标（往收起的方向挪一点、交叉淡化） */}
      <motion.button
        type="button"
        onClick={() => setNavCollapsed(!collapsed)}
        aria-label={toggleLabel}
        title={toggleLabel}
        initial={false}
        animate={at.toggle}
        transition={transition}
        style={{ width: KNOB, height: KNOB }}
        className="absolute left-0 top-0 grid place-items-center rounded-md text-muted
                   transition-colors duration-[140ms] hover:bg-raised hover:text-ink"
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={collapsed ? "open" : "close"}
            initial={{ opacity: 0, x: collapsed ? -3 : 3 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: collapsed ? 3 : -3 }}
            transition={tween.fast}
            className="grid place-items-center"
          >
            <ToggleIcon size={14.5} strokeWidth={1.9} />
          </motion.span>
        </AnimatePresence>
      </motion.button>
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
  // 本子上的笔划一下：支点在左下角，像落笔时手腕一抖
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
  collapsed,
  onSelect,
}: {
  item: NavItem;
  index: number;
  active: boolean;
  /** 收成图标栏：只剩图标，文字放进 title 和读屏标签 */
  collapsed: boolean;
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
    <motion.li
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ ...tween.base, ...stagger(index, 0.04), delay: 0.3 + index * 0.04 }}
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
        aria-label={collapsed ? item.label : undefined}
        title={collapsed ? item.label : undefined}
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
        {/* 字重直接切，不过渡。font-weight 一过渡，每一帧都是一个新的小数字重，
            中文走系统字体回退（YaHei 没有可变轴），每个新字重都要重新做一次
            字体匹配 —— 实测一个标签一帧 11ms，切换时新旧两个标签一起变就是
            22ms 一帧，整整 140ms 都在掉帧；纯拉丁文字只要 0.5ms。 */}
        <RowLabel className={cn("text-[13.5px]", active ? "font-semibold" : "font-normal")}>
          {item.label}
        </RowLabel>
      </motion.button>
    </motion.li>
  );
}
