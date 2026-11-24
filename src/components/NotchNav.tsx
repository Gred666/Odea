import { NOTCH_MAX_CELLS, hasListColumn, notchWidth, useApp } from "@/app/store";
import { useData } from "@/data/store";
import type { WorkspaceId } from "@/data/types";
import { cn } from "@/lib/cn";
import { snapToDevicePixels } from "@/lib/devicePixels";
import { spring, tween, usePrefersReducedMotion } from "@/lib/motion";
import { springTrack } from "@/lib/springTrack";
import { tip } from "@/lib/tooltip";
import { useDeclared } from "@/plugins/declared";
import { navIds, pluginNavItems } from "@/plugins/registry";
import { Archive, FolderTree, MoreHorizontal, Puzzle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import type { TargetAndTransition } from "motion/react";
import {
  type ComponentProps,
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ActionMenu } from "./RowMenu";

/* ============================================================
   刘海里的导航格子（docs/边栏.md §4.3、§5.1）。

   2–6 项：文件、扩展一直在，归档、日程的今日TODO / /GOAL / 日历各有开关。第 7 项起（以后的内置插件）
   第 6 格换成「⋯」，放不下的收进它的菜单；当前那一区在菜单里时，选中块停在「⋯」上。
   哪几项在外面由导航顺序定（navIds，L0 插件能调）。

   图标只在增删时挪：收起 / 展开侧栏、切区，格子都不动（肌肉记忆）。开关插件、归档时拿掉的先原地淡出，
   剩下的再滑过去，新来的晚一点淡入（useNavRows）。选中块用 layoutId 在格子之间滑。
   字都在 title 里（全局的悬停提示另行设计，到时统一换掉）。
   ============================================================ */

export interface NavCell {
  id: WorkspaceId;
  label: string;
  icon: LucideIcon;
  /** 插件的导航项：哪个插件的（仓库开着它才有）。核心的「文件」「归档」「扩展」没有 */
  plugin?: string;
}

const NOTES_ITEM: NavCell = { id: "notes", label: "文件", icon: FolderTree };
const ARCHIVE_ITEM: NavCell = { id: "archive", label: "归档", icon: Archive };
const EXTENSIONS_ITEM: NavCell = { id: "extensions", label: "扩展", icon: Puzzle };
/** 放不下的那几项收在它后面 */
const MORE_ID = "more";
const MORE_CELL: NavCell = { id: MORE_ID, label: "更多", icon: MoreHorizontal };

/** 可能出现的每一项，按顺序（开着的 L0 插件能调先后，registry 的 navIds） */
function allNav(): NavCell[] {
  const order = navIds();
  return [NOTES_ITEM, ...pluginNavItems(), ARCHIVE_ITEM, EXTENSIONS_ITEM].sort(
    (a, b) => order.indexOf(a.id) - order.indexOf(b.id),
  );
}

/** 这个仓库里开着的导航项，按顺序 */
export function useNavItems(): NavCell[] {
  const plugins = useData((s) => s.layout.plugins);
  const archive = useData((s) => s.layout.archive);
  // 开着的 L0 插件调了先后：跟着重排（allNav 读的是 registry 里的那一份）
  useDeclared((s) => s.navOrder);
  return allNav().filter((item) =>
    item.plugin ? plugins.includes(item.plugin) : archive || item.id !== "archive",
  );
}

/** 刘海里画哪几格：放得下就全画；放不下时前 5 项 +「⋯」，其余的进「⋯」的菜单 */
export function notchCells(items: readonly NavCell[], max = NOTCH_MAX_CELLS) {
  if (items.length <= max) return { cells: [...items], overflow: [] as NavCell[] };
  return { cells: [...items.slice(0, max - 1), MORE_CELL], overflow: items.slice(max - 1) };
}

/** 刘海现在该多宽（按开着的导航项算）：标签栏、正文最上面那一条按它让位 */
export function useNotchWidth(): number {
  return notchWidth(notchCells(useNavItems()).cells.length);
}

/**
 * 每个图标的「签名动作」—— 切到这一页时播一次。
 *
 * 关键是动作得跟图标画的那个物件对得上：铃铛就摇、靶心就收拢、盖子就压下去。
 * 几个图标共用一套缩放的话，动是动了，但读不出「这是哪一页」——
 * Telegram 那套底栏之所以有记忆点，就在于每个图标动得不一样。
 *
 * 全部只动 transform（rotate / scale / scaleX / scaleY / x / y），由 playIconMotion 交给合成器，不触发排版、不重画。
 * 摆动类的支点要挪：铃铛在钟顶、归档盒在底边，用 origin 单独给。
 * 插件的导航项自己带着（今日TODO 是勾上一项、目标是命中靶心、日历是翻一页）
 */
const ICON_MOTION: Record<string, { to: TargetAndTransition; origin: string }> = {
  // 文件树晃一下：支点在左下角，像翻开一摞文件
  notes: {
    to: { rotate: [0, -12, 6, 0], scale: [1, 1.1, 1], transition: { duration: 0.42 } },
    origin: "30% 80%",
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

/** 均匀分布的关键帧重采样成 n 个（两条轨道要合进同一个 CSS 属性、个数又不一样时） */
function resample(track: number[], n: number): number[] {
  if (track.length === n) return track;
  return Array.from({ length: n }, (_, i) => {
    const at = (i / Math.max(1, n - 1)) * (track.length - 1);
    const lo = Math.floor(at);
    const hi = Math.min(track.length - 1, lo + 1);
    return track[lo]! + (track[hi]! - track[lo]!) * (at - lo);
  });
}

/**
 * 放一次签名动作：rotate、scale（或 scaleX / scaleY）、x / y 各是一条 WAAPI 动画，落在 CSS 单独的
 * rotate、scale、translate 属性上，在合成器上跑。关键帧照 Motion 的默认：均匀分布、每一段 easeInOut（= CSS 的 ease-in-out）。
 * 以前交给 Motion 的 useAnimationControls：单独的 rotate / scale / y 它是在主线程上逐帧写 style 的，
 * 图标那一小块每帧重画一次；切区那一下主线程正在挂新的一页，摇到一半就卡住（docs/边栏.md §10.3）
 */
export function playIconMotion(el: HTMLElement, to: TargetAndTransition): Animation[] {
  if (typeof el.animate !== "function") return [];
  const spec = to as Record<string, unknown>;
  const transition = (spec.transition ?? {}) as { duration?: number; delay?: number };
  const options: KeyframeAnimationOptions = {
    duration: (transition.duration ?? 0.4) * 1000,
    delay: (transition.delay ?? 0) * 1000,
  };
  const track = (key: string): number[] | null => {
    const value = spec[key];
    if (typeof value === "number") return [value];
    return Array.isArray(value) && value.every((v) => typeof v === "number") ? value : null;
  };
  /** 两条轨道合成一个属性的「a b」：缺的那条用 rest 补，个数不一样的重采样成一样多 */
  const zip = (a: number[] | null, b: number[] | null, rest: number) => {
    const n = Math.max(a?.length ?? 0, b?.length ?? 0);
    const left = a ? resample(a, n) : Array<number>(n).fill(rest);
    const right = b ? resample(b, n) : Array<number>(n).fill(rest);
    return left.map((value, i) => [value, right[i]!] as const);
  };
  const frames: Record<string, string[]> = {};
  const rotate = track("rotate");
  if (rotate) frames.rotate = rotate.map((v) => `${v}deg`);
  const scale = track("scale");
  const scaleX = track("scaleX");
  const scaleY = track("scaleY");
  if (scale) frames.scale = scale.map(String);
  else if (scaleX || scaleY) frames.scale = zip(scaleX, scaleY, 1).map(([x, y]) => `${x} ${y}`);
  const x = track("x");
  const y = track("y");
  if (x || y) frames.translate = zip(x, y, 0).map(([dx, dy]) => `${dx}px ${dy}px`);
  return Object.entries(frames).map(([property, values]) =>
    el.animate({ [property]: values, easing: "ease-in-out" }, options),
  );
}

/** 格子挪位置的曲线：起步就走、收尾短（docs/PITFALLS/动效.md 规矩 7） */
const SLIDE_EASE = "cubic-bezier(0.33, 1, 0.68, 1)";
const SLIDE_MS = 240;
/** 拿掉的那几格原地淡出；淡完右边的才滑过来 */
const LEAVE_MS = 140;
/** 新出现的那几格淡入。晚一点开始：从左边滑过来的那几格先过去，别和它们叠在一起 */
const ENTER_MS = 180;
const ENTER_DELAY = 70;

/**
 * 开关插件（日程）、归档时格子的进出（2026-10-28 竖着的窄栏上定的做法，2026-11-19 横过来）。
 *
 * 以前是动尺寸：尺寸只能在主线程上一帧一帧算，可开关的那一下主线程正忙着按新的列表把整个应用重画一遍
 * （4 倍降速的开发版里一下 106ms），接着今天那一篇取回来又是 53ms —— 动画的头几帧和中间都卡住。
 *
 * 现在排版只变一次，动的都是合成器上的 opacity / transform（Web Animations），主线程再忙也照常走：
 * - 多出来的：挂上就占好格子，淡入；它右边的从原来的位置滑过去（FLIP）
 * - 拿掉的：先留在原来的格子里淡出（leaving，点不到），淡完撤掉，右边的再滑过来
 * 刘海的宽度跟着 rows（含正在淡出的）走：拿掉的那一格淡完、撤掉以后刘海才收。
 * 位置都是整 CSS 像素，可 1.25 倍屏上落在半个物理像素上：动之前先对齐（docs/PITFALLS/动效.md 规矩 3）。
 */
export function useNavRows(
  listRef: React.RefObject<HTMLUListElement | null>,
  cells: readonly NavCell[],
  reduce: boolean,
) {
  const ids = cells.map((cell) => cell.id);
  const key = ids.join("|");
  // 首屏那一批错峰淡入（NavCellButton）；之后新出现的才算「插进来的」
  const [booted, setBooted] = useState(false);
  useEffect(() => setBooted(true), []);
  /** 上一次提交时刘海里有哪几格（拿掉的那几格淡出时还要按原样画） */
  const shown = useRef<NavCell[]>([...cells]);
  /** 正在淡出的几格：还占着位置 */
  const [leaving, setLeaving] = useState<WorkspaceId[]>([]);
  const fades = useRef(new Map<WorkspaceId, Animation>());
  const known = useRef(new Map<WorkspaceId, NavCell>());
  for (const cell of [...shown.current, ...cells]) known.current.set(cell.id, cell);
  // 这一次刚拿掉、还没登记进 leaving 的：这一帧先照旧画着，下面的 layout effect 开始淡
  const dropping = reduce ? [] : shown.current.map((c) => c.id).filter((id) => !ids.includes(id));
  // 按上一次的位置把正在淡出的插回去：右边的那几格等它淡完再滑过来
  const before = shown.current.map((c) => c.id);
  const gone = new Set([...leaving, ...dropping].filter((id) => !ids.includes(id)));
  const order: WorkspaceId[] = [];
  let next = 0;
  for (const id of before) {
    if (gone.has(id)) order.push(id);
    else if (ids.includes(id)) {
      while (next < ids.length && ids[next] !== id) {
        if (!order.includes(ids[next]!)) order.push(ids[next]!);
        next++;
      }
      if (!order.includes(id)) order.push(id);
      next++;
    }
  }
  for (const id of ids) if (!order.includes(id)) order.push(id);
  for (const id of gone) if (!order.includes(id)) order.push(id);
  const rows = order.map((id) => known.current.get(id)!).filter(Boolean);
  const rowsKey = rows.map((row) => row.id).join("|");

  // 拿掉的开始淡出；又回来的（淡到一半又开了）停下、照常显示
  // biome-ignore lint/correctness/useExhaustiveDependencies: key 就是 ids 的指纹
  useLayoutEffect(() => {
    const previous = shown.current.map((c) => c.id);
    shown.current = [...cells];
    const list = listRef.current;
    for (const id of ids) {
      const fade = fades.current.get(id);
      if (!fade) continue;
      fade.cancel();
      fades.current.delete(id);
      setLeaving((now) => now.filter((other) => other !== id));
    }
    const removed = previous.filter((id) => !ids.includes(id));
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
  const lefts = useRef(new Map<string, number>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: rowsKey 就是这一排的指纹
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const previous = lefts.current;
    const next = new Map<string, number>();
    for (const row of list.querySelectorAll<HTMLElement>("[data-nav]")) {
      const id = row.dataset.nav!;
      const left = row.offsetLeft;
      next.set(id, left);
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
      } else if (old !== left) {
        snapToDevicePixels(row);
        row.animate([{ transform: `translateX(${old - left}px)` }, { transform: "none" }], {
          duration: SLIDE_MS,
          easing: SLIDE_EASE,
        });
      }
    }
    lefts.current = next;
  }, [rowsKey]);

  return { rows, leaving: [...leaving, ...dropping], booted };
}

/** 一格：36×36，图标 18（刘海 48 高，格子离上下各 6）。选中块的圆角 10 + 离刘海底边 6 = 刘海的凸角 16（同心） */
const CELL =
  "group relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors duration-[140ms]";
const NAV_ICON = { size: 18, strokeWidth: 1.8 } as const;

export function NotchNav({
  listRef,
  rows,
  leaving,
  booted,
  overflow,
}: {
  listRef: React.RefObject<HTMLUListElement | null>;
  rows: readonly NavCell[];
  leaving: readonly WorkspaceId[];
  booted: boolean;
  /** 收进「⋯」的那几项 */
  overflow: readonly NavCell[];
}) {
  const workspace = useApp((s) => s.workspace);
  const setWorkspace = useApp((s) => s.setWorkspace);
  const setPanelCollapsed = useApp((s) => s.setPanelCollapsed);

  const select = (id: WorkspaceId) => {
    const { panelCollapsed } = useApp.getState();
    if (id === workspace) {
      if (hasListColumn(id)) setPanelCollapsed(!panelCollapsed);
      return;
    }
    setWorkspace(id);
    if (panelCollapsed && hasListColumn(id)) setPanelCollapsed(false);
  };
  const inOverflow = overflow.some((item) => item.id === workspace);

  return (
    <nav aria-label="主导航">
      <ul ref={listRef} className="flex gap-1">
        {rows.map((item, i) =>
          item.id === MORE_ID ? (
            <MoreCell
              key={item.id}
              index={i}
              inserted={booted}
              leaving={leaving.includes(item.id)}
              active={inOverflow}
              overflow={overflow}
              current={workspace}
              onSelect={select}
            />
          ) : (
            <NavCellButton
              key={item.id}
              item={item}
              index={i}
              inserted={booted}
              leaving={leaving.includes(item.id)}
              active={workspace === item.id}
              onSelect={() => select(item.id)}
            />
          ),
        )}
      </ul>
    </nav>
  );
}

/** 相邻两格的间距：格子 36 + 间隔 4（和 notchWidth 的 40 一致） */
const CELL_PITCH = 40;
/** 选中块上一次在哪一格（刘海只有主窗口里有一个，模块里记一份就够） */
let indicatorAt: number | null = null;

/**
 * 选中块：换到另一格时，从上一格那里滑过来。
 * 格子一样大，只差横向的 (旧 − 新) × 40：在新的格子里挂上，按 spring.smooth 预先算好的关键帧
 * （lib/springTrack.ts）从那个偏移滑回 0，WAAPI 在合成器上跑。
 * 2026-11-20 以前用 Motion 的 layoutId：它在主线程上逐帧写 transform 和修正圆角的 border-radius，
 * 每帧重画这一格和上面的图标，切区那一下主线程正忙着挂新的一页（docs/边栏.md §10.3）。
 * 格子增删（开关日程）时选中块不动，跟着它那一格由 useNavRows 滑
 */
function Indicator({ index }: { index: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  // 挂上这一刻上一个选中块在哪：在渲染时取（StrictMode 下两次挂载都取到同一个值）
  const [from] = useState(() => indicatorAt);
  const appReduce = useApp((s) => s.reduceMotion);
  const systemReduce = usePrefersReducedMotion();
  const reduce = appReduce || systemReduce;
  useLayoutEffect(() => {
    indicatorAt = index;
  }, [index]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂上的那一下滑一次；之后 index 变了是格子增删，不滑
  useLayoutEffect(() => {
    const el = ref.current;
    if (from === null || from === index || reduce || !el || typeof el.animate !== "function")
      return;
    const track = springTrack([(from - index) * CELL_PITCH], [0], [0], spring.smooth);
    const animation = el.animate(
      track.values[0]!.map((x) => ({ transform: `translateX(${x}px)` })),
      { duration: Math.max(1, track.duration), easing: "linear" },
    );
    return () => animation.cancel();
  }, []);
  return <span ref={ref} className="absolute inset-0 rounded-lg bg-raised" />;
}

/** 没选中的格子悬停时的底：独立一层，避免和选中块抢同一个背景 */
function HoverWash() {
  return (
    <span
      className="absolute inset-0 rounded-lg bg-raised opacity-0 transition-opacity
                 duration-[80ms] group-hover:opacity-45"
    />
  );
}

/** 一格的外层：首屏错峰淡入；之后插进来的、拿掉的由 useNavRows 淡 / 滑，一直待在自己的图层上 */
function CellSlot({
  id,
  index,
  inserted,
  leaving,
  children,
}: {
  id: WorkspaceId;
  index: number;
  inserted: boolean;
  leaving: boolean;
  children: React.ReactNode;
}) {
  return (
    // 只淡 opacity，不位移（docs/PITFALLS/动效.md 规矩 1）
    <motion.li
      data-nav={id}
      initial={inserted ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ ...tween.base, delay: 0.3 + index * 0.04 }}
      aria-hidden={leaving || undefined}
      className={cn("shrink-0 will-change-[opacity,transform]", leaving && "pointer-events-none")}
    >
      {children}
    </motion.li>
  );
}

function NavCellButton({
  item,
  index,
  inserted,
  leaving,
  active,
  onSelect,
}: {
  item: NavCell;
  index: number;
  /** 首屏之后才出现的（开了日程）：不错峰淡入，由 useNavRows 淡入 */
  inserted: boolean;
  /** 已经拿掉了、正在原地淡出（useNavRows）：点不到 */
  leaving: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = item.icon;
  const motionSpec = ICON_MOTION[item.id] ??
    pluginNavItems().find((other) => other.id === item.id)?.motion ?? { to: {}, origin: "50% 50%" };
  const iconRef = useRef<HTMLSpanElement>(null);
  const playing = useRef<Animation[]>([]);

  // 这一下是自己调 WAAPI 放的，Shell 上那层 MotionConfig（reducedMotion="always"）管不到
  // （以前用 useAnimationControls 时也一样：实测开了「减少动效」铃铛照样摇 ±18°）。
  // 所以按 Shell 同样的口径自己判一次：应用内开关 or 系统偏好。
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
    // 首屏那一次不播：格子本来就在做错峰入场，再叠一层就太吵了
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!active || skipMotion || !iconRef.current) return;
    for (const animation of playing.current) animation.cancel();
    playing.current = playIconMotion(iconRef.current, motionSpec.to);
  }, [active, tapCount, motionSpec, skipMotion]);
  useEffect(
    () => () => {
      for (const animation of playing.current) animation.cancel();
    },
    [],
  );

  return (
    <CellSlot id={item.id} index={index} inserted={inserted} leaving={leaving}>
      <motion.button
        type="button"
        onClick={() => {
          onSelect();
          setTapCount((n) => n + 1);
        }}
        // 按下去整格压一下：手指离开之前就有回应，不用等页面切完（只有图标，没有字）
        whileTap={skipMotion ? undefined : { scale: 0.94 }}
        transition={spring.snappy}
        aria-current={active ? "page" : undefined}
        {...tip(item.label)}
        className={cn(CELL, active ? "text-ink" : "text-body hover:text-ink")}
      >
        {active ? <Indicator index={index} /> : <HoverWash />}
        <span
          ref={iconRef}
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
        </span>
      </motion.button>
    </CellSlot>
  );
}

/** 「⋯」的按钮本体：Radix 的触发元素要能接 ref 和它合并进来的事件 */
const MoreButton = forwardRef<
  HTMLButtonElement,
  ComponentProps<"button"> & { active: boolean; index: number }
>(function MoreButton({ active, index, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...tip(MORE_CELL.label)}
      className={cn(
        CELL,
        active ? "text-ink" : "text-body hover:text-ink data-[state=open]:text-ink",
        className,
      )}
      {...rest}
    >
      {active ? <Indicator index={index} /> : <HoverWash />}
      <MoreHorizontal
        {...NAV_ICON}
        className={cn("relative z-10", active ? "text-ink" : "text-muted group-hover:text-body")}
      />
    </button>
  );
});

function MoreCell({
  index,
  inserted,
  leaving,
  active,
  overflow,
  current,
  onSelect,
}: {
  index: number;
  inserted: boolean;
  leaving: boolean;
  /** 当前那一区收在菜单里：选中块停在这一格 */
  active: boolean;
  overflow: readonly NavCell[];
  current: WorkspaceId;
  onSelect: (id: WorkspaceId) => void;
}) {
  return (
    <CellSlot id={MORE_ID} index={index} inserted={inserted} leaving={leaving}>
      <ActionMenu
        align="start"
        trigger={
          <MoreButton active={active} index={index} aria-current={active ? "page" : undefined} />
        }
        actions={overflow.map((item) => ({
          id: item.id,
          label: item.label,
          icon: item.icon,
          checked: item.id === current,
          onSelect: () => onSelect(item.id),
        }))}
      />
    </CellSlot>
  );
}
