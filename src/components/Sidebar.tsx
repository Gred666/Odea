import { JOURNAL_WORKSPACES, NAV_WIDTH, hasListColumn, useApp } from "@/app/store";
import { useData } from "@/data/store";
import type { SyncState, WorkspaceId } from "@/data/types";
import { cn } from "@/lib/cn";
import { snapToDevicePixels } from "@/lib/devicePixels";
import { spring, tween, usePrefersReducedMotion } from "@/lib/motion";
import { shortcut } from "@/lib/platform";
import { describeSync } from "@/lib/syncText";
import { useTeam } from "@/team/store";
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
  RefreshCw,
  Search,
  SquareCheckBig,
  Target,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AnimatePresence, motion, motionValue, useAnimationControls } from "motion/react";
import type { TargetAndTransition } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

/**
 * 窄栏上一格：40×40，左右各留 12，图标居中，中心落在 32（64 宽的正中）。
 * 导航项、同步、命令面板、主题都是这一个尺寸（docs/排版规范.md §10）
 */
const ROW =
  "group relative flex h-10 w-full items-center justify-center rounded-lg transition-colors duration-[140ms]";

/** 导航项的图标：窄栏上没有字，只能靠图标认，取 20（macOS 侧栏「中」档、VS Code 活动栏都是图标占格子一半） */
const NAV_ICON = { size: 20, strokeWidth: 1.75 } as const;
/** 底下那几格（读索引、新版本、同步、命令面板、主题）：次一级，小一档 */
const FOOT_ICON = { size: 18, strokeWidth: 1.8 } as const;

/** Logo 里「O」以外那几笔一直是藏着的（窄栏上只有 O） */
const LOGO_HIDDEN = motionValue(0);

const INSTANT = { duration: 0 };

/**
 * 最左边的窄栏（Obsidian 的 ribbon、VS Code 的活动栏，docs/仓库与启动器.md §6）：
 * Logo、各个区的图标、后台读索引 / 新版本 / 同步三样状态、左下角的命令面板、主题。
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
  const archive = useData((s) => s.layout.archive);
  const appReduce = useApp((s) => s.reduceMotion);
  const systemReduce = usePrefersReducedMotion();
  const reduce = appReduce || systemReduce;
  const items = NAV.filter(
    (item) =>
      (journal || !JOURNAL_WORKSPACES.includes(item.id)) && (archive || item.id !== "archive"),
  );
  const listRef = useRef<HTMLUListElement>(null);
  const { rows, leaving, booted } = useNavRows(listRef, items, reduce);

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

      {/* 开关日程、归档是就地换的（data/store 的 switchLayout）：多出来 / 没了的那几项怎么进出见 useNavRows */}
      <ul ref={listRef} className="flex flex-col px-3 pt-1">
        {rows.map((item, i) => (
          <NavRow
            key={item.id}
            item={item}
            index={i}
            inserted={booted}
            leaving={leaving.includes(item.id)}
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
            className={cn(ROW, "cursor-default text-muted")}
          >
            {/* 转的是图标（SVG），不是字 */}
            <LoaderCircle
              {...FOOT_ICON}
              className={cn(
                "relative z-10 shrink-0 text-muted",
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
            className={cn(ROW, "text-body hover:text-ink")}
          >
            <span
              className="absolute inset-0 rounded-lg bg-accent-wash opacity-0 transition-opacity
                         duration-[140ms] group-hover:opacity-100"
            />
            <motion.span
              className="relative z-10 flex shrink-0 text-accent"
              animate={reduce ? undefined : UPDATE_NUDGE}
            >
              <CircleFadingArrowUp {...FOOT_ICON} />
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
  // 团队仓库（docs/协同编辑.md §22.4）：谁在线（连着的成员）
  const teamActive = useTeam((s) => s.active);
  const peers = useTeam((s) => s.peers);
  const online = [...new Set(peers.filter((peer) => peer.online).map((peer) => peer.name))];
  const team = teamActive
    ? `
${online.length ? `${online.join("、")} 在线` : "团队里别人都不在线"}`
    : "";
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
        title={`${label}：${detail}${team}`}
        aria-label={`${label}：${detail}${team}`}
        className={cn(ROW, "text-muted hover:text-ink")}
      >
        <span
          className="absolute inset-0 rounded-lg bg-raised opacity-0 transition-opacity
                     duration-[140ms] group-hover:opacity-45"
        />
        {/* 转的是图标（SVG），不是字 */}
        <Icon
          {...FOOT_ICON}
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

/* ---------------- 左下角：命令面板、主题 ----------------
   贴着 64 宽窄栏的中线一列，从下往上：主题、命令面板。
   以前最上面还有一颗侧栏开关，可它收起 / 展开的是窄栏右边那一栏（文件树、月历、归档列表），
   今日TODO、目标没有那一栏，在那两页按它什么都不发生（2026-10-28 用户反馈）。
   开关挪到了正文底下状态栏的最左端（DocumentView 的 StatusBar），紧挨着它收起的那一栏，
   只在有那一栏的几页出现；点窄栏上已经选中的那一项照样收起 / 展开 */

function FootControls() {
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  const combo = shortcut("K");

  // 和上面的导航项、同步一样是 40×40 一格（以前是 28×28，底下三颗三个尺寸）
  return (
    <div className="flex shrink-0 flex-col gap-1 px-3 pt-3 pb-4">
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        aria-label={`打开命令面板（${combo}）`}
        title={`命令面板（${combo}）`}
        className={cn(ROW, "text-muted hover:bg-raised hover:text-ink")}
      >
        <Search {...FOOT_ICON} />
      </button>

      <ThemeToggle className={cn(ROW, "text-muted hover:bg-raised hover:text-ink")} />
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

/** 窄栏那几项挪位置的曲线：起步就走、收尾短（CLAUDE.md 动效规矩 7） */
const SLIDE_EASE = "cubic-bezier(0.33, 1, 0.68, 1)";
const SLIDE_MS = 240;
/** 拿掉的那几项原地淡出；淡完下面的才滑上去 */
const LEAVE_MS = 140;
/** 新出现的那几项淡入。晚一点开始：从上面滑下来的「归档」先过去，别和它们叠在一起 */
const ENTER_MS = 180;
const ENTER_DELAY = 70;

/**
 * 开关日程、归档时窄栏那几项的进出（2026-10-28）。
 *
 * 以前是动高度（0 ↔ 38）：高度只能在主线程上一帧一帧算，可开关的那一下主线程正忙着按新的列表
 * 把整个应用重画一遍（4 倍降速的开发版里一下 106ms），接着今天那一篇取回来又是 53ms ——
 * 动画的头几帧和中间都卡住，用户说「左侧小图标会掉帧」。
 *
 * 现在排版只变一次，动的都是合成器上的 opacity / transform（Web Animations），主线程再忙也照常走：
 * - 多出来的：挂上就占好格子，淡入；它下面的（「归档」）从原来的位置滑过去（FLIP）
 * - 拿掉的：先留在原来的格子里淡出（leaving，点不到），淡完撤掉，下面的再滑上去
 * 位置都是整 CSS 像素，可 1.25 倍屏上奇数格落在半个物理像素上：动之前先对齐（CLAUDE.md 规矩 3）。
 */
function useNavRows(
  listRef: React.RefObject<HTMLUListElement | null>,
  items: NavItem[],
  reduce: boolean,
) {
  const ids = items.map((item) => item.id);
  const key = ids.join("|");
  // 首屏那一批错峰淡入（NavRow）；之后新出现的才算「插进来的」
  const [booted, setBooted] = useState(false);
  useEffect(() => setBooted(true), []);
  /** 上一次提交时窄栏上有哪几项 */
  const shown = useRef(ids);
  /** 正在淡出的几项：还占着格子 */
  const [leaving, setLeaving] = useState<WorkspaceId[]>([]);
  const fades = useRef(new Map<WorkspaceId, Animation>());
  // 这一次刚拿掉、还没登记进 leaving 的：这一帧先照旧画着，下面的 layout effect 开始淡
  const dropping = reduce ? [] : shown.current.filter((id) => !ids.includes(id));
  const rows = NAV.filter(
    (item) => ids.includes(item.id) || leaving.includes(item.id) || dropping.includes(item.id),
  );
  const rowsKey = rows.map((item) => item.id).join("|");

  // 拿掉的开始淡出；又回来的（淡到一半又开了）停下、照常显示
  // biome-ignore lint/correctness/useExhaustiveDependencies: key 就是 ids 的指纹
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = ids;
    const list = listRef.current;
    for (const id of ids) {
      const fade = fades.current.get(id);
      if (!fade) continue;
      fade.cancel();
      fades.current.delete(id);
      setLeaving((now) => now.filter((other) => other !== id));
    }
    const removed = before.filter((id) => !ids.includes(id));
    if (!removed.length || reduce || !list) return;
    setLeaving((now) => [...now, ...removed.filter((id) => !now.includes(id))]);
    for (const id of removed) {
      const row = list.querySelector<HTMLElement>(`[data-nav="${id}"]`);
      if (!row || typeof row.animate !== "function") continue;
      snapToDevicePixels(row);
      const fade = row.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: LEAVE_MS,
        easing: "ease-out",
        fill: "forwards",
      });
      fades.current.set(id, fade);
      fade.onfinish = () => {
        if (fades.current.get(id) !== fade) return;
        fades.current.delete(id);
        setLeaving((now) => now.filter((other) => other !== id));
      };
    }
  }, [key, reduce]);

  // 格子变了（插进来、淡完撤掉）：挪了位置的从原处滑过去，新出现的淡入
  const tops = useRef(new Map<string, number>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: rowsKey 就是这一列的指纹
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const previous = tops.current;
    const next = new Map<string, number>();
    for (const row of list.querySelectorAll<HTMLElement>("[data-nav]")) {
      const id = row.dataset.nav!;
      const top = row.offsetTop;
      next.set(id, top);
      if (!booted || reduce || typeof row.animate !== "function") continue;
      const old = previous.get(id);
      if (old === undefined) {
        snapToDevicePixels(row);
        row.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: ENTER_MS,
          delay: ENTER_DELAY,
          easing: "ease-out",
          fill: "backwards",
        });
      } else if (old !== top) {
        snapToDevicePixels(row);
        row.animate([{ transform: `translateY(${old - top}px)` }, { transform: "none" }], {
          duration: SLIDE_MS,
          easing: SLIDE_EASE,
        });
      }
    }
    tops.current = next;
  }, [rowsKey]);

  return { rows, leaving: [...leaving, ...dropping], booted };
}

function NavRow({
  item,
  index,
  inserted,
  leaving,
  active,
  onSelect,
}: {
  item: NavItem;
  index: number;
  /** 首屏之后才出现的（开了日程）：不错峰淡入，由 useNavRows 淡入 */
  inserted: boolean;
  /** 已经拿掉了、正在原地淡出（useNavRows）：点不到 */
  leaving: boolean;
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
    // 首屏错峰淡入。只淡 opacity，不位移（CLAUDE.md 动效规矩 1）。
    // 之后插进来的、拿掉的由 useNavRows 用 Web Animations 淡 / 滑；一直待在自己的图层上（规矩 3）
    <motion.li
      data-nav={item.id}
      initial={inserted ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ ...tween.base, delay: 0.3 + index * 0.04 }}
      aria-hidden={leaving || undefined}
      className={cn(
        "shrink-0 pb-1 will-change-[opacity,transform]",
        leaving && "pointer-events-none",
      )}
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
        className={cn(ROW, active ? "text-ink" : "text-body hover:text-ink")}
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
            {...NAV_ICON}
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
