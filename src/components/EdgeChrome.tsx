import { FLARE_WIDTH, LIST_WIDTH, NOTCH_HEIGHT, notchWidth, panelOf, useApp } from "@/app/store";
import { useData } from "@/data/store";
import { cn } from "@/lib/cn";
import {
  CONVEX_RADIUS,
  LIP_WIDTH,
  type PiecePath,
  bottomFlarePath,
  convexCornerPath,
  flarePath,
  footprintOf,
  lipPath,
  sideLipPath,
} from "@/lib/edgeShape";
import { spring, usePrefersReducedMotion } from "@/lib/motion";
import { type Track, springTrack, valueAt, velocityAt } from "@/lib/springTrack";
import { tip } from "@/lib/tooltip";
import { navItemOf } from "@/plugins/registry";
import { ArchiveList } from "@/views/ArchiveView";
import { NotesList } from "@/views/NotesView";
import { AnimatePresence, motion, useSpring } from "motion/react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ControlCenter } from "./ControlCenter";
import { ErrorBoundary } from "./ErrorBoundary";
import { NotchNav, notchCells, useNavItems, useNavRows } from "./NotchNav";
import { StatusOrb } from "./StatusOrb";
import { VaultSwitcher } from "./VaultSwitcher";

/* ============================================================
   左上角的一块形状：刘海（「O」+ 导航格子）和从它往下长的侧栏（docs/边栏.md）。
   2026-11-19 取代 64 宽的窄栏 + 300 宽的列表栏。

   三种高度（§4.2）：笔记、归档拉到窗口底边；日历只长到月格子那么高；今日TODO、/GOAL、扩展，
   以及任何一区收起了，只剩刘海（宽 = 56 + 40 × 格数）。侧栏永远 300 宽。

   形状怎么画、怎么动（§6.2）：不逐帧重算路径，拆成几块刚体，伸缩时每块只平移 ——
   - body / column：两块纯色的底，宽高都比形状大，右下角对准形状的右下角平移过去，
     超出去的部分在窗口左边、上边外面（被 Shell 的 overflow-hidden 裁掉）。比方案里写的
     「中间那块 scaleX / scaleY」更省：不缩放，静止时不用重新栅格化，边缘在整像素上
   - corner：右下的凸角（R=16），跟着右下角平移
   - flareTop：右上贴顶边的凹弯（R=12），跟着右边平移
   - flareLeft：左下贴左边的凹弯（R=12），跟着底边平移
   - flareBottom：拉到底时右下角贴底边的凹弯，只淡入淡出
   片和片之间叠 2px，同一个不透明的颜色，叠的地方看不出来。路径全部来自 lib/edgeShape.ts。

   动画：宽、高两路弹簧（刚度 260、阻尼 32）预先算成关键帧，交给 Web Animations 在合成器上跑
   （lib/springTrack.ts）：切区的那一下主线程在挂新的一页，形状照样走。被打断时从当前的位置、速度接着走。
   内容不跟着拉：收的时候先 110ms 淡出、形状再缩；长的时候形状先长，内容晚 110ms、200ms 淡入（§5.2）。

   两个把手（§5.3、§5.3.1）：收起了，鼠标到刘海上，刘海底边探出一个（点了展开）；展开着，鼠标到侧栏
   右边缘外侧那一条，右边缘在鼠标那个高度鼓出一个（SideLip，点了收起）。同一个形状（lib/edgeShape.ts）。

   层次：整块在 Shell 里 z-[45]，比标题栏的拖拽带（z-40）高 —— 刘海那一块不能拖窗口，
   刘海右边的顶边照样能拖、双击最大化（§6.3）。形状本身不接指针，只有刘海、侧栏的内容、把手接。
   ============================================================ */

/** 伸缩的弹簧：基本不过冲（阻尼比 0.99） */
const EDGE_SPRING = { stiffness: 260, damping: 32 } as const;
/** 收的时候内容先淡出这么久，形状再缩 */
const CONTENT_OUT_MS = 110;
/** 长的时候内容晚这么久才淡入，淡 200ms */
const CONTENT_IN_DELAY = 0.11;
const CONTENT_IN = 0.2;
/** 拉到底时下沿（凸角、左下的凹弯）推到窗口外面多远 */
const FULL_OVERSHOOT = 64;
/** 按内容高度的那一栏（日历）还没量到时先按这么高长（量到了接着长到对的高度） */
const FIT_GUESS = 395;
/** 凸角那一块的边长（R=16 占 23.85，加 2px 叠进上面、左边那两块） */
const CORNER_BOX = 26;
/** 右边那一列（凸角上面）的底边离形状底边多远：凸角那块往上叠了 2px，取整数免得落在半像素上 */
const COLUMN_INSET = 24;
/** 大底的右边缘离形状右边多远：伸进凸角那一块和右边那一列 */
const BODY_INSET = 22;

type Pose = { w: number; h: number };

/** 每一块在 (w, h) 时的平移 */
const PIECES = {
  body: ({ w, h }: Pose) => [w - BODY_INSET, h],
  column: ({ w, h }: Pose) => [w, h - COLUMN_INSET],
  corner: ({ w, h }: Pose) => [w, h],
  flareTop: ({ w }: Pose) => [w, 0],
  flareLeft: ({ h }: Pose) => [0, h],
  hit: ({ w }: Pose) => [w, 0],
} as const;
type PieceName = keyof typeof PIECES;

const transformOf = (name: PieceName, pose: Pose) => {
  const [x, y] = PIECES[name](pose);
  return `translate(${x}px, ${y}px)`;
};

/**
 * 形状的几块跟着 (w, h) 走：第一次直接摆好；之后按弹簧放关键帧动画，被打断时接着当前的位置和速度。
 * jump：这一次直接跳过去（窗口改了大小）
 */
function useEdgeMotion(target: Pose, reduce: boolean, jump: boolean) {
  const refs = useRef<Partial<Record<PieceName, HTMLElement | SVGSVGElement | null>>>({});
  const current = useRef<{
    pose: Pose;
    track: Track | null;
    from: Pose;
    delay: number;
    animations: Animation[];
  } | null>(null);

  const place = useCallback((pose: Pose) => {
    for (const name of Object.keys(PIECES) as PieceName[]) {
      const el = refs.current[name];
      if (el) el.style.transform = transformOf(name, pose);
    }
  }, []);

  const { w, h } = target;
  useLayoutEffect(() => {
    const goal = { w, h };
    const state = current.current;
    if (!state) {
      place(goal);
      current.current = { pose: goal, track: null, from: goal, delay: 0, animations: [] };
      return;
    }
    // 现在在哪、多快（正在动的话按关键帧算出来）
    let from = state.pose;
    let velocity = [0, 0];
    const running = state.animations[0];
    if (state.track && running) {
      const elapsed = Number(running.currentTime ?? 0) - state.delay;
      if (elapsed > 0) {
        const [x, y] = valueAt(state.track, elapsed);
        from = { w: x!, h: y! };
        velocity = velocityAt(state.track, elapsed);
      } else from = state.from;
    }
    for (const animation of state.animations) animation.cancel();
    state.animations = [];
    state.track = null;
    if (reduce || jump || (from.w === goal.w && from.h === goal.h)) {
      place(goal);
      state.pose = goal;
      return;
    }
    const track = springTrack([from.w, from.h], [goal.w, goal.h], velocity, EDGE_SPRING);
    // 往回收（变矮）时内容先淡出，形状再缩；被打断在半道上的接着动，不再等
    const delay = goal.h < from.h && velocity.every((v) => v === 0) ? CONTENT_OUT_MS : 0;
    const frames = track.values[0]!.map((_, i) => ({
      w: track.values[0]![i]!,
      h: track.values[1]![i]!,
    }));
    place(from);
    for (const name of Object.keys(PIECES) as PieceName[]) {
      const el = refs.current[name];
      if (!el || typeof el.animate !== "function") continue;
      state.animations.push(
        el.animate(
          frames.map((pose) => ({ transform: transformOf(name, pose) })),
          { duration: Math.max(1, track.duration), delay, easing: "linear", fill: "both" },
        ),
      );
    }
    state.track = track;
    state.from = from;
    state.delay = delay;
    state.pose = goal;
    const first = state.animations[0];
    if (first) {
      // 走完把终点写进样式、撤掉动画（不让 fill 一直挂着）
      void first.finished
        .then(() => {
          if (current.current !== state || state.animations[0] !== first) return;
          place(goal);
          for (const animation of state.animations) animation.cancel();
          state.animations = [];
          state.track = null;
        })
        .catch(() => {});
    }
  }, [w, h, reduce, jump, place]);

  useEffect(
    () => () => {
      for (const animation of current.current?.animations ?? []) animation.cancel();
    },
    [],
  );

  return refs;
}

/** 窗口有多高：拉到底的那一栏要把下沿推到它外面 */
function useWindowHeight(): number {
  const [height, setHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return height;
}

/** 一块固定的弧线片：svg 按路径的盒子摆在局部原点周围，平移由 useEdgeMotion 给 */
function Piece({
  path,
  pieceRef,
  className,
  style,
}: {
  path: PiecePath;
  pieceRef?: (el: SVGSVGElement | null) => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { box } = path;
  return (
    <svg
      ref={pieceRef}
      aria-hidden="true"
      width={box.w}
      height={box.h}
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      className={className}
      style={{ position: "absolute", left: box.x, top: box.y, ...style }}
    >
      <path d={path.d} className="fill-rail" />
    </svg>
  );
}

/** 侧栏右边缘外侧接鼠标的那一条有多宽：正文那一侧，碰不到列表的滚动条（§5.3.1） */
const SIDE_STRIP = 12;
/** 边缘把手离上面的凹弯、下面的凹弯 / 凸角至少这么远 */
const SIDE_GAP = 24;
/** 离开那一条这么久才缩回去：鼠标擦出去一下又回来，把手不闪 */
const SIDE_LEAVE_MS = 120;
/** 缩回去要这么久（globals.css 的 .odea-edge-side）：缩完了再出来，直接落在鼠标那个高度，不从上次那儿滑过来 */
const SIDE_RETRACT_MS = 240;
/** 跟着鼠标上下走的弹簧（spring.smooth） */
const SIDE_FOLLOW = { stiffness: spring.smooth.stiffness, damping: spring.smooth.damping };
/** 凸角（日历那种按内容高度的侧栏的右下角）占掉右边缘多长 */
const CONVEX_FOOTPRINT = footprintOf(CONVEX_RADIUS);

/**
 * 展开着时的边缘把手（§5.3.1，取代状态栏左端的侧栏开关）：鼠标移到侧栏右边缘外侧那一条，
 * 右边缘在鼠标那个高度往外鼓出一个把手 —— 和收起时刘海底下那个同一个形状，竖过来，里面一个「‹」。
 * 鼓出来只动 translateX（CSS 过渡，240ms ease-out-quint）；沿着边缘上下移，外面那层用弹簧只动 translateY。
 * 点它收起。
 *
 * 缩回去以后整个藏起来（visibility）：它缩在侧栏里面，靠的是侧栏同一个颜色盖着；侧栏一变矮（笔记 → 日历）、
 * 一收起，它就露在正文上了。收起的时候（点了它）等内容淡完、形状开始缩的那一刻藏（CONTENT_OUT_MS）
 */
function SideLip({
  active,
  edgeBottom,
  reduce,
  onCollapse,
}: {
  /** 侧栏开着、不在专注模式 */
  active: boolean;
  /** 侧栏右边缘的直边到哪（往下就是凹弯 / 凸角） */
  edgeBottom: number;
  reduce: boolean;
  onCollapse: () => void;
}) {
  const [hover, setHover] = useState<"" | "edge" | "lip">("");
  const y = useSpring(0, SIDE_FOLLOW);
  const leaveTimer = useRef(0);
  /** 上一次开始缩回去的时刻：缩完了再出来就直接落在鼠标那儿 */
  const retractedAt = useRef(Number.NEGATIVE_INFINITY);
  const out = active ? hover : "";
  const wasOut = useRef(false);
  useEffect(() => {
    if (out) wasOut.current = true;
    else if (wasOut.current) retractedAt.current = performance.now();
  }, [out]);

  // 收起了、进了专注模式：鼠标还在原地也算离开（不然再展开时它直接鼓在上次那儿）
  useEffect(() => {
    if (!active) setHover("");
  }, [active]);
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  const box = sideLipPath().box;
  const top = FLARE_WIDTH + SIDE_GAP + LIP_WIDTH / 2;
  const bottom = Math.max(top, edgeBottom - SIDE_GAP - LIP_WIDTH / 2);
  const track = (event: React.PointerEvent) => {
    // 拖着东西（选字、拖文件）划过这一条不算
    if (event.buttons || !active) return;
    window.clearTimeout(leaveTimer.current);
    const at = Math.round(Math.min(bottom, Math.max(top, event.clientY)));
    const fresh = !out && performance.now() - retractedAt.current > SIDE_RETRACT_MS;
    if (fresh || reduce) y.jump(at);
    else y.set(at);
    if (!hover) setHover("edge");
  };

  return (
    <div
      onPointerEnter={track}
      onPointerMove={track}
      onPointerLeave={() => {
        window.clearTimeout(leaveTimer.current);
        leaveTimer.current = window.setTimeout(() => setHover(""), SIDE_LEAVE_MS);
      }}
    >
      {/* 接鼠标的那一条：从刘海底下到右边缘的直边走完（Shell 那一层 z-[45]，盖在正文上） */}
      <div
        aria-hidden="true"
        className={cn("absolute z-[1]", !active && "pointer-events-none")}
        style={{
          left: LIST_WIDTH,
          top: NOTCH_HEIGHT,
          width: SIDE_STRIP,
          height: Math.max(0, edgeBottom - NOTCH_HEIGHT),
        }}
      />
      <motion.div
        className="pointer-events-none absolute top-0 z-[1] will-change-transform"
        style={{ left: LIST_WIDTH, y }}
      >
        <button
          type="button"
          tabIndex={out ? 0 : -1}
          aria-hidden={!out || undefined}
          {...tip("收起侧栏", { side: "right" })}
          onClick={onCollapse}
          onPointerEnter={() => setHover("lip")}
          onPointerLeave={() => setHover((now) => (now ? "edge" : now))}
          className={cn(
            "odea-edge-side absolute block",
            out ? "pointer-events-auto" : "pointer-events-none",
          )}
          data-lip={out || undefined}
          data-gone={!active || undefined}
          style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
        >
          <svg
            aria-hidden="true"
            width={box.w}
            height={box.h}
            viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
            className="block overflow-visible"
          >
            <path d={sideLipPath().d} className="fill-rail" />
            <path
              d="M7.8 -5l-3.2 5 3.2 5"
              fill="none"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="odea-edge-lip-chevron"
            />
          </svg>
        </button>
      </motion.div>
    </div>
  );
}

export function EdgeChrome() {
  const workspace = useApp((s) => s.workspace);
  const panelCollapsed = useApp((s) => s.panelCollapsed);
  const setPanelCollapsed = useApp((s) => s.setPanelCollapsed);
  const zen = useApp((s) => s.zen);
  const appReduce = useApp((s) => s.reduceMotion);
  const systemReduce = usePrefersReducedMotion();
  const reduce = appReduce || systemReduce;

  const kind = panelOf(workspace);
  const shown = kind !== null && !panelCollapsed;
  const full = shown && kind === "full";
  // 拉到底的那一栏正在淡出（收起、换到日历 / 今日TODO）：装内容的那一层先按拉到底的高度留着，淡完再收。
  // 内容是 absolute 放的，不留着的话正在淡出的那一栏一下变成 0 高，里面的列表在半道上重排
  const [wasFull, setWasFull] = useState(full);
  const [leavingFull, setLeavingFull] = useState(false);
  if (wasFull !== full) {
    setWasFull(full);
    if (wasFull) setLeavingFull(true);
  }
  const tall = full || leavingFull;
  // 这一次是不是「换内容」（有内容 → 另一份内容）：新的那一栏等旧的淡完才挂（下面的 mode="wait"），不用再晚 110ms
  const contentKey = shown ? workspace : null;
  const [lastContent, setLastContent] = useState(contentKey);
  const [swapIn, setSwapIn] = useState(false);
  if (lastContent !== contentKey) {
    setLastContent(contentKey);
    setSwapIn(lastContent !== null && contentKey !== null);
  }

  // 刘海里的格子：宽度跟着画着的格子数（含正在淡出的）走，拿掉的那一格淡完刘海才收
  const items = useNavItems();
  const { cells, overflow } = notchCells(items);
  const listRef = useRef<HTMLUListElement>(null);
  const { rows, leaving, booted } = useNavRows(listRef, cells, reduce);
  const notch = notchWidth(rows.length);

  // 按内容高度的那一栏量到的高（每一区记一份：日历的月格子是固定的，量一次就对了）
  const [fitHeights, setFitHeights] = useState<Record<string, number>>({});
  const fitObserver = useRef<ResizeObserver | null>(null);
  const measureFit = useCallback(
    (el: HTMLDivElement | null) => {
      fitObserver.current?.disconnect();
      fitObserver.current = null;
      if (!el || kind !== "fit" || typeof ResizeObserver === "undefined") return;
      const id = workspace;
      const observer = new ResizeObserver(([entry]) => {
        if (!entry) return;
        const height = Math.ceil(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
        if (height > 0)
          setFitHeights((now) => (now[id] === height ? now : { ...now, [id]: height }));
      });
      observer.observe(el);
      fitObserver.current = observer;
    },
    [kind, workspace],
  );

  const winH = useWindowHeight();
  const lastWinH = useRef(winH);
  const resized = lastWinH.current !== winH;
  lastWinH.current = winH;
  const target: Pose = !shown
    ? { w: notch, h: NOTCH_HEIGHT }
    : full
      ? { w: LIST_WIDTH, h: winH + FULL_OVERSHOOT }
      : { w: LIST_WIDTH, h: NOTCH_HEIGHT + (fitHeights[workspace] ?? FIT_GUESS) };
  const refs = useEdgeMotion(target, reduce, resized && full);
  const bind = (name: PieceName) => (el: HTMLElement | SVGSVGElement | null) => {
    refs.current[name] = el;
  };
  // 右边缘的直边到哪：拉到底的到右下那处凹弯，按内容高度的到凸角
  const edgeBottom = full ? winH - FLARE_WIDTH : target.h - CONVEX_FOOTPRINT;
  const collapse = useCallback(() => setPanelCollapsed(true), [setPanelCollapsed]);

  // 收起了的那一区：鼠标到刘海上，底边探出把手；到把手上，再往下 3px（§5.3）
  const canPeek = kind !== null && panelCollapsed;
  const [hover, setHover] = useState<"" | "notch" | "lip">("");
  const [centerOpen, setCenterOpen] = useState(false);
  // 控制中心开着时不探：卡片就盖在把手那一块上
  const lip = !canPeek || centerOpen ? "" : hover;

  const centerId = useId();
  const closeCenter = useCallback(() => setCenterOpen(false), []);

  const notes = useData((s) => s.notes);
  const archived = useData((s) => s.archived);
  const restoreNote = useData((s) => s.restoreNote);
  const PluginList = navItemOf(workspace)?.List;

  return (
    <div className="absolute left-0 top-0 h-full w-0">
      {/* ---------- 形状：几块刚体，不接指针 ---------- */}
      <div aria-hidden="true" className="pointer-events-none">
        <div
          ref={bind("body")}
          className="absolute bottom-full right-full w-[300px] bg-rail will-change-transform"
          style={{ height: `calc(100% + ${FULL_OVERSHOOT * 3}px)` }}
        />
        <div
          ref={bind("column")}
          className="absolute bottom-full right-full bg-rail will-change-transform"
          style={{ width: CORNER_BOX, height: `calc(100% + ${FULL_OVERSHOOT * 3}px)` }}
        />
        <div ref={bind("corner")} className="absolute left-0 top-0 will-change-transform">
          <Piece path={convexCornerPath()} />
        </div>
        <div ref={bind("flareTop")} className="absolute left-0 top-0 will-change-transform">
          <Piece path={flarePath()} />
        </div>
        <div ref={bind("flareLeft")} className="absolute left-0 top-0 will-change-transform">
          <Piece path={flarePath()} />
        </div>
        {/* 拉到底时右下角贴底边的凹弯：等侧栏到了再淡入；离开拉到底时先淡掉 */}
        <div
          className="absolute bottom-0 will-change-[opacity]"
          style={{
            left: LIST_WIDTH,
            opacity: full ? 1 : 0,
            transition: reduce
              ? "none"
              : full
                ? "opacity 160ms ease-out 140ms"
                : "opacity 90ms ease-out",
          }}
        >
          <Piece path={bottomFlarePath()} style={{ top: "auto", bottom: -2 }} />
        </div>
      </div>

      {/* ---------- 侧栏的内容：不跟着形状拉，只淡入淡出 ----------
          换内容（笔记 ↔ 日历 ↔ 归档）用 mode="wait"：旧的那一栏淡完（110ms）新的才挂上，接着就淡入，
          新的一栏（笔记的文件树两千来个元素）不在点击的那一帧里挂、排版。看到的时间和「一起挂、晚 110ms 淡入」一样，
          点下去到出第一帧快了一大截（4 倍降速日历 → 笔记 +160ms 的回退就在这里，docs/边栏.md §10.3）；
          改版前的列表栏也是 wait。展开（之前没有内容）时没有要等的，挂上、晚 110ms 淡入，形状先长。
          以前是 popLayout：新旧一起挂，旧的那一栏靠往 <head> 里插一条 [data-motion-pop-id] 的样式钉住。
          收起时这一层也不切 pointer-events-none：它会继承，整棵文件树两千来个元素在点击的那一帧里全部重算样式
          （4 倍降速 120ms，笔记 → 今日TODO 的回退）；淡出的那 110ms 里还点得到，和改版前的列表栏一样 */}
      <div
        className="absolute left-0 z-[2] flex w-[300px] flex-col"
        style={{ top: NOTCH_HEIGHT, bottom: tall ? 0 : undefined }}
      >
        <div className={cn("relative", tall && "min-h-0 flex-1")}>
          <AnimatePresence initial={false} mode="wait" onExitComplete={() => setLeavingFull(false)}>
            {shown && (
              <motion.div
                key={workspace}
                ref={kind === "fit" ? measureFit : undefined}
                initial={{ opacity: 0 }}
                animate={{
                  opacity: 1,
                  transition: reduce
                    ? { duration: 0 }
                    : {
                        duration: CONTENT_IN,
                        delay: swapIn ? 0 : CONTENT_IN_DELAY,
                        ease: "easeOut",
                      },
                }}
                exit={{
                  opacity: 0,
                  transition: { duration: reduce ? 0 : CONTENT_OUT_MS / 1000, ease: "easeOut" },
                }}
                className={cn("absolute inset-x-0 top-0", full && "bottom-0")}
              >
                <ErrorBoundary
                  area="侧栏"
                  fallback="block"
                  resetKey={workspace}
                  onError={(message) => useData.setState({ error: message })}
                >
                  {workspace === "notes" && <NotesList notes={notes} />}
                  {PluginList && <PluginList />}
                  {workspace === "archive" && (
                    <ArchiveList items={archived} onRestore={restoreNote} />
                  )}
                </ErrorBoundary>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {/* 仓库名 ⌄：换仓库、开关插件（日程，Obsidian 也放在这里）。只在拉到底的那几区；
            在换内容的那一层外面，笔记 ↔ 归档时它不跟着淡出淡入 */}
        <AnimatePresence initial={false}>
          {full && (
            <motion.div
              key="vault"
              initial={{ opacity: 0 }}
              animate={{
                opacity: 1,
                transition: reduce
                  ? { duration: 0 }
                  : { duration: CONTENT_IN, delay: CONTENT_IN_DELAY, ease: "easeOut" },
              }}
              exit={{ opacity: 0, transition: { duration: reduce ? 0 : CONTENT_OUT_MS / 1000 } }}
              className="shrink-0"
            >
              <ErrorBoundary
                area="仓库菜单"
                fallback="none"
                onError={(message) => useData.setState({ error: message })}
              >
                <VaultSwitcher />
              </ErrorBoundary>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ---------- 展开着时右边缘的把手 ---------- */}
      <SideLip
        active={shown && !zen}
        edgeBottom={edgeBottom}
        reduce={reduce}
        onCollapse={collapse}
      />

      {/* ---------- 刘海：「O」+ 导航格子；连同把手一起算「鼠标在刘海上」 ---------- */}
      <div
        onPointerEnter={() => setHover((now) => (now === "lip" ? now : "notch"))}
        onPointerLeave={() => setHover("")}
      >
        {/* 把手：收起时藏在刘海里（同一个颜色，看不见），探出来只动 translateY */}
        <button
          type="button"
          tabIndex={lip ? 0 : -1}
          aria-hidden={!canPeek || undefined}
          {...tip("展开侧栏")}
          onClick={() => setPanelCollapsed(false)}
          onPointerEnter={() => setHover("lip")}
          onPointerLeave={() => setHover("notch")}
          className={cn(
            "odea-edge-lip absolute z-[1] block",
            lip ? "pointer-events-auto" : "pointer-events-none",
          )}
          data-lip={lip || undefined}
          style={{
            left: notch / 2 + lipPath().box.x,
            top: NOTCH_HEIGHT + lipPath().box.y,
            width: lipPath().box.w,
            height: lipPath().box.h,
          }}
        >
          <svg
            aria-hidden="true"
            width={lipPath().box.w}
            height={lipPath().box.h}
            viewBox={`${lipPath().box.x} ${lipPath().box.y} ${lipPath().box.w} ${lipPath().box.h}`}
            className="block overflow-visible"
          >
            <path d={lipPath().d} className="fill-rail" />
            <path
              d="M-5 4.6l5 3.2 5-3.2"
              fill="none"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="odea-edge-lip-chevron"
            />
          </svg>
        </button>
        {/* 刘海这一块：挡住底下标题栏的拖拽带（不能拖窗口），宽度跟着形状平移 */}
        <div
          ref={bind("hit")}
          className="absolute right-full top-0 z-[3] w-[300px] will-change-transform"
          style={{ height: NOTCH_HEIGHT }}
        />
        <div
          className="absolute left-0 top-0 z-[3] flex items-center gap-2 pl-3"
          style={{ height: NOTCH_HEIGHT }}
        >
          <StatusOrb
            open={centerOpen}
            controls={centerId}
            onToggle={() => setCenterOpen((open) => !open)}
          />
          <NotchNav
            listRef={listRef}
            rows={rows}
            leaving={leaving}
            booted={booted}
            overflow={overflow}
          />
        </div>
      </div>

      <AnimatePresence>
        {centerOpen && <ControlCenter key="center" id={centerId} onClose={closeCenter} />}
      </AnimatePresence>
    </div>
  );
}
