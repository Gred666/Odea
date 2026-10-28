import { useApp } from "@/app/store";
import type { OutlineItem } from "@/data/types";
import type { EditorOutlineHandle } from "@/editor/MarkdownEditor";
import { cn } from "@/lib/cn";
import { spring, tween, usePrefersReducedMotion } from "@/lib/motion";
import { rememberSpot, spotOf } from "@/lib/viewMemory";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { AnimatePresence, type Transition, motion } from "motion/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { OverlayScrollbar } from "./OverlayScrollbar";
import { SwapFade } from "./SwapFade";
import { type OutlineNode, foldableUnder, outlineTree, visibleId } from "./outlineTree";

/**
 * 右侧目录树。
 * 活动项跟随正文滚动联动，指示条用 layoutId 在条目间滑动。
 *
 * 用 IntersectionObserver 而不是 scroll 事件 —— 后者每帧都要 getBoundingClientRect，
 * 是典型的强制同步布局，正文一长就掉帧。
 */
export function Outline({
  items,
  scrollRef,
  resetKey,
  memoryKey = "",
  editorHandle,
  zen,
}: {
  items: OutlineItem[];
  /** 专注模式：不占布局，改成贴右边缘的浮层刻度 */
  zen?: boolean;
  /** 记住每篇收起了哪些用的键（store 的 saveKeyOf）；没有就不记 */
  memoryKey?: string;
  /** 正文滚动容器 */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** 切换文档时用它重置激活项 */
  resetKey: string;
  /** 可编辑文档直接使用编辑器行号控制器，不依赖虚假的预览 DOM 锚点。 */
  editorHandle?: EditorOutlineHandle | null;
}) {
  const [activeId, setActiveId] = useState<string | null>(items[0]?.id ?? null);
  const ratios = useRef(new Map<string, number>());

  // biome-ignore lint/correctness/useExhaustiveDependencies: 换文档 / 换首个锚点时才重置
  useEffect(() => {
    setActiveId(items[0]?.id ?? null);
    ratios.current.clear();
  }, [resetKey, items[0]?.id]);

  useEffect(() => editorHandle?.subscribe(setActiveId), [editorHandle]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey 用于强制重建 observer
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || items.length === 0 || editorHandle) return;

    const targets = items
      .map((it) => root.querySelector<HTMLElement>(`[data-outline-id="${it.id}"]`))
      .filter((el): el is HTMLElement => !!el);
    if (!targets.length) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.outlineId!;
          ratios.current.set(id, e.isIntersecting ? e.intersectionRatio : 0);
        }
        // 取当前可见度最高的标题；都不可见时保持上一个
        let best: string | null = null;
        let bestRatio = 0;
        for (const it of items) {
          const r = ratios.current.get(it.id) ?? 0;
          if (r > bestRatio) {
            bestRatio = r;
            best = it.id;
          }
        }
        if (best) setActiveId(best);
      },
      {
        root,
        // 顶部 12% 到底部 55% 的带状区域，标题进入这里才算「当前」
        rootMargin: "-12% 0px -55% 0px",
        threshold: [0, 0.25, 0.5, 0.75, 1],
      },
    );

    for (const t of targets) io.observe(t);
    return () => io.disconnect();
  }, [items, scrollRef, resetKey, editorHandle]);

  const scrollTo = (id: string) => {
    if (editorHandle) {
      editorHandle.scrollTo(id);
      setActiveId(id);
      return;
    }
    const root = scrollRef.current;
    const el = root?.querySelector<HTMLElement>(`[data-outline-id="${id}"]`);
    if (!root || !el) return;
    const top = el.offsetTop - 28;
    root.scrollTo({ top, behavior: "smooth" });
    setActiveId(id);
  };

  // 占位必须和下面真目录用同一套显隐规则。以前这里少了 hidden/xl:block ——
  // 真目录在 xl 以下宽度为 0，占位却一直占着 180px，结果反过来了：
  // 没标题的文档比有标题的多占一栏，两类笔记之间切换正文宽度会跳 180px。
  if (items.length === 0) {
    return zen ? null : <aside className="hidden w-[180px] shrink-0 xl:block" />;
  }

  /* 布局和外观彻底拆开：
     - 占位 div 只管布局，宽度在 180 / 0 之间**瞬时**切换；
     - 两种形态都常驻，都是绝对定位，谁也不占布局，靠 opacity 交叉淡入。

     绕了两版才到这里，记一下别再踩：
     ① 最早是 `zen ? <刻度> : <文字目录>`，React 直接卸载重挂，目录是「啪」地
        换掉的，而同一时刻正文列还在滑 460ms，中间那一下硬切特别显眼。
     ② 于是套了 AnimatePresence + mode="popLayout" 想让退场元素被摘出文档流。
        实测没摘掉：退场的文字目录仍然是 static，那 180px 要等淡出结束才还给
        编辑区，编辑区变成在 0ms 和 212ms 各变宽一次 —— 等于在动画中间又插了
        一次重排。而且退场动画本身也没跑完，两个 aside 会一直卡在 DOM 里。
     现在两边都不卸载、都不占位，纯 CSS 过渡，没有任何 presence 状态机可失效。 */
  return (
    <>
      {!zen && <div className="hidden w-[180px] shrink-0 xl:block" aria-hidden="true" />}
      <RailOutline
        items={items}
        activeId={activeId}
        onJump={scrollTo}
        hidden={!!zen}
        resetKey={resetKey}
        memoryKey={memoryKey}
      />
      <ZenOutline items={items} activeId={activeId} onJump={scrollTo} hidden={!zen} />
    </>
  );
}

/** 当前条目离目录可视区上下边缘不足这么多时，把它滚回中间 */
const FOLLOW_MARGIN = 32;

/** 各档缩进的字从哪起（px）。左边留出箭头的位置：箭头 16px，贴着字左边 2px */
const INDENT: Record<OutlineItem["level"], number> = { 1: 20, 2: 32, 3: 44 };

/**
 * 收起 / 展开的曲线：ease-out cubic，不回弹。箭头的转动用同一条，和高度同步。
 *
 * 动的是排版（高度），下面的条目是落在整像素上画的字，所以要看的是「每一帧实际挪了几个像素」。
 * 以前用临界阻尼的弹簧（420 / 41），用户说「感觉帧数不高」，60Hz 下算过、无头 Chrome 里量过：
 * 弹簧从静止起步，点下去头两帧只走 116px 里的 17px，像没反应；末尾又磨蹭 100–200ms，
 * 每帧走不到 1px，条目停住、隔几帧跳 1px、再停住。ease-out cubic 头两帧走 42px，之后每帧
 * 平稳地少走一点，没有停住的帧（2026-10-17）。quint（tween.base）头一帧就冲出 37px，太猛
 */
const FOLD_EASE = [0.33, 1, 0.68, 1] as const;
/** 一行的高度（上下 5px + 行高 20px + 行间 1px），估子树多高用 */
const ROW_HEIGHT = 31;
/** 子树越高动得越久（220–320ms），和 glide.ts 的滑动一个道理：一样的时长，长距离会显得猛 */
const foldTransition = (rows: number): Transition => ({
  duration: Math.min(0.32, 0.22 + (rows * ROW_HEIGHT) / 4000),
  ease: FOLD_EASE,
});
const INSTANT = { duration: 0 } as const;

/** 展开时露出来几行：下级，加上没收起的下级的下级 */
function shownRows(node: OutlineNode, collapsed: ReadonlySet<string>): number {
  return node.children.reduce(
    (sum, child) => sum + 1 + (collapsed.has(child.key) ? 0 : shownRows(child, collapsed)),
    0,
  );
}

/** 这一篇上次收起了哪些（lib/viewMemory.ts） */
const recall = (memoryKey: string) => new Set(memoryKey ? (spotOf(memoryKey)?.outline ?? []) : []);

/** 每一层都要的动作。整份目录只建一次（里面调的是最新的那一份），不让它破坏下面的 memo */
interface BranchActions {
  onJump: (id: string) => void;
  toggle: (node: OutlineNode, deep: boolean) => void;
  /** 焦点挪到某一条（← 回到上一级） */
  focus: (id: string) => void;
}

interface BranchProps {
  node: OutlineNode;
  collapsed: ReadonlySet<string>;
  /** 高亮落在哪一条（被收起时是收起的那个祖先） */
  shown: string | null;
  byId: ReadonlyMap<string, OutlineNode>;
  /** 减少动效：收起展开一步到位 */
  reduce: boolean;
  actions: BranchActions;
}

/** id 那一条是不是 node 自己，或者在它下面 */
function holds(
  node: OutlineNode,
  id: string | null,
  byId: ReadonlyMap<string, OutlineNode>,
): boolean {
  for (let at = id ? byId.get(id) : undefined; at; at = at.parent ?? undefined) {
    if (at === node) return true;
  }
  return false;
}

/**
 * 只有这一枝里有变化才重画：收起状态变了的条目在这一枝里，或者高亮从这一枝里进出。
 * 以前点一下整棵树每一条都重画（每条带好几个 Motion 组件）：两百多条的目录，点下去那一帧
 * 主线程 45ms，动画开头掉两三帧（2026-10-17 量的）
 */
const sameBranch = (a: BranchProps, b: BranchProps) =>
  a.node === b.node &&
  a.reduce === b.reduce &&
  a.actions === b.actions &&
  a.byId === b.byId &&
  (a.collapsed === b.collapsed ||
    foldableUnder(a.node).every((key) => a.collapsed.has(key) === b.collapsed.has(key))) &&
  (a.shown === b.shown || (!holds(a.node, a.shown, a.byId) && !holds(a.node, b.shown, a.byId)));

/**
 * 常规形态：右侧固定一栏文字目录。
 *
 * 条目多了会超出一屏，所以条目放在自己的滚动区里，配和正文一样的覆盖式滚动条。
 * 读到哪一节，目录就跟到哪一节：当前条目滚出可视区时把它带回中间，
 * 不然长文档读到后半篇，高亮的那一条早就在目录底下看不见了。
 *
 * 按标题层级建树，有下级的条目能收起（技术方案 §12.9）：只动子树的高度，里面的字
 * 原地不动、不淡；箭头悬停才出来，收起的一直亮着。
 */
function RailOutline({
  items,
  activeId,
  onJump,
  hidden,
  resetKey,
  memoryKey,
}: {
  items: OutlineItem[];
  activeId: string | null;
  onJump: (id: string) => void;
  hidden: boolean;
  /** 换文档：整份目录跟正文一起交叉淡化 */
  resetKey: string;
  /** 记住收起了哪些用的键（store 的 saveKeyOf）；没有就不记 */
  memoryKey: string;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const appReduce = useApp((s) => s.reduceMotion);
  const systemReduce = usePrefersReducedMotion();
  const reduce = appReduce || systemReduce;

  const tree = useMemo(() => outlineTree(items), [items]);
  // 换了一篇就换成那一篇记着的（渲染时就换，不等 effect：不然新文档先按旧的收起状态画一帧）
  const [folds, setFolds] = useState(() => ({ doc: resetKey, collapsed: recall(memoryKey) }));
  if (folds.doc !== resetKey) setFolds({ doc: resetKey, collapsed: recall(memoryKey) });
  const collapsed = folds.doc === resetKey ? folds.collapsed : recall(memoryKey);
  const shown = visibleId(tree, activeId, collapsed);

  const commit = (next: Set<string>) => {
    setFolds({ doc: resetKey, collapsed: next });
    if (memoryKey) {
      const foldable = new Set(tree.foldable);
      rememberSpot(memoryKey, { outline: [...next].filter((key) => foldable.has(key)) });
    }
  };

  const focus = (id: string) =>
    navRef.current
      ?.querySelector<HTMLElement>(`[data-outline-item="${CSS.escape(id)}"]`)
      ?.focus({ preventScroll: true });

  const toggle = (node: OutlineNode, deep: boolean) => {
    const open = !collapsed.has(node.key);
    const next = new Set(collapsed);
    for (const key of deep ? foldableUnder(node) : [node.key]) {
      if (open) next.add(key);
      else next.delete(key);
    }
    // 焦点在要收进去的那几条上：挪回这一条，不然焦点留在看不见的地方
    const focused = document.activeElement;
    if (
      open &&
      focused instanceof HTMLElement &&
      focused.closest(`[data-outline-group="${CSS.escape(node.key)}"]`)
    ) {
      focus(node.item.id);
    }
    commit(next);
  };

  const anyCollapsed = tree.foldable.some((key) => collapsed.has(key));
  const toggleAll = () => commit(anyCollapsed ? new Set() : new Set(tree.foldable));

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !shown) return;
    const item = [...scroller.querySelectorAll<HTMLElement>("[data-outline-item]")].find(
      (node) => node.dataset.outlineItem === shown,
    );
    if (!item) return;
    // 滚动内容的坐标：条目可能套在几层子树里，offsetTop 只是相对最近的定位祖先
    const top =
      item.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const bottom = top + item.offsetHeight;
    const viewTop = scroller.scrollTop;
    const viewBottom = viewTop + scroller.clientHeight;
    if (top >= viewTop + FOLLOW_MARGIN && bottom <= viewBottom - FOLLOW_MARGIN) return;
    scroller.scrollTo({
      top: top - (scroller.clientHeight - item.offsetHeight) / 2,
      behavior: "smooth",
    });
  }, [shown]);

  const latest = useRef<BranchActions>({ onJump, toggle, focus });
  latest.current = { onJump, toggle, focus };
  const actions = useMemo<BranchActions>(
    () => ({
      onJump: (id) => latest.current.onJump(id),
      toggle: (node, deep) => latest.current.toggle(node, deep),
      focus: (id) => latest.current.focus(id),
    }),
    [],
  );

  return (
    <aside
      aria-label="目录树"
      aria-hidden={hidden}
      className={cn(
        // 右边距拆成两半：外 12px 在这里，内 12px 在滚动区上，滚动条就落在这 24px 的空白里
        "group/rail absolute right-0 top-0 hidden h-full w-[180px] flex-col pr-3 pt-[52px] xl:flex",
        "transition-opacity duration-[200ms] ease-linear [will-change:opacity]",
        hidden ? "pointer-events-none opacity-0" : "opacity-100",
      )}
    >
      {/* 「全部收起」紧跟在字后面：这一行的右上角压着专注模式的按钮（ZenToggle） */}
      <div className="mb-3 flex shrink-0 items-center gap-1.5">
        <motion.p
          className="pl-5 text-[12px] tracking-[0.08em] text-muted"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={tween.base}
        >
          目录树
        </motion.p>
        {tree.foldable.length > 0 && (
          <button
            type="button"
            data-outline-control
            // 不抢焦点：焦点留在原来的条目上
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggleAll}
            aria-label={anyCollapsed ? "全部展开" : "全部收起"}
            title={anyCollapsed ? "全部展开" : "全部收起"}
            // 和箭头一样淡的是颜色，不是 opacity（见 OutlineRow）
            className="grid h-5 w-5 place-items-center rounded-[5px] text-transparent
                       transition-[color,background-color] duration-[140ms]
                       focus-visible:text-muted group-hover/rail:text-muted
                       hover:bg-raised group-hover/rail:hover:text-ink"
          >
            {anyCollapsed ? (
              <ChevronsUpDown size={12} strokeWidth={2.2} />
            ) : (
              <ChevronsDownUp size={12} strokeWidth={2.2} />
            )}
          </button>
        )}
      </div>

      {/* data-swap-host：换文档时旧目录的快照放在这一层（它不滚动，见 SwapFade） */}
      <div className="relative min-h-0 flex-1" data-swap-host>
        {/* layoutScroll：指示条用 layoutId 在条目间滑动，滚动过的容器里要告诉 Motion
            把滚动偏移算进去，不然滚动后指示条会从错的位置飞过来 */}
        <motion.div
          ref={scrollerRef}
          layoutScroll
          className="scroll-none h-full overflow-y-auto pr-3"
        >
          {/* 换文档时整份目录和正文一起交叉淡化，条目不再逐条错峰：以前换一篇，
              旧目录一下子没了、新的一条条从右边滑进来，最后一条要等半秒多。
              nav 按文档重挂，AnimatePresence 的 initial={false} 让这一批不播入场；
              之后写出来的新标题才单独淡入。 */}
          <SwapFade swapKey={resetKey}>
            <nav ref={navRef} key={resetKey} className="relative flex flex-col gap-[1px] pb-8">
              {tree.overview && (
                <OutlineRow
                  item={tree.overview}
                  node={null}
                  open
                  active={tree.overview.id === shown}
                  actions={actions}
                />
              )}
              <AnimatePresence initial={false}>
                {tree.roots.map((node) => (
                  <OutlineBranch
                    key={node.key}
                    node={node}
                    collapsed={collapsed}
                    shown={shown}
                    byId={tree.byId}
                    reduce={reduce}
                    actions={actions}
                  />
                ))}
              </AnimatePresence>
            </nav>
          </SwapFade>
        </motion.div>
        <OverlayScrollbar targetRef={scrollerRef} />
      </div>
    </aside>
  );
}

/**
 * 一条连同它下面的子树。子树收起 / 展开只动容器的高度（overflow: clip）：里面的行原地
 * 不动、不淡，由边缘把它们露出来 / 收进去；下面的条目跟着排版走，每一帧都是正常画出来的
 * 字，停下来那一帧不会变（技术方案 §12.9）。
 * 新写出来的标题只淡入（以前带 5px 位移）
 */
const OutlineBranch = memo(function OutlineBranch(props: BranchProps) {
  const { node, collapsed, shown, byId, reduce, actions } = props;
  const open = !collapsed.has(node.key);
  const transition = reduce ? INSTANT : foldTransition(shownRows(node, collapsed));
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={tween.base}
    >
      <OutlineRow
        item={node.item}
        node={node}
        open={open}
        active={node.item.id === shown}
        actions={actions}
        transition={transition}
      />
      {node.children.length > 0 && (
        <motion.div
          data-outline-group={node.key}
          className="overflow-clip"
          initial={false}
          animate={{ height: open ? "auto" : 0 }}
          transition={transition}
          // 收起时里面的条目不能用 Tab 走进去
          inert={!open}
        >
          {/* 和外层的 gap 一样，第一条上面的那 1px 放在里面：收起时一起收掉 */}
          <div className="flex flex-col gap-[1px] pt-[1px]">
            <AnimatePresence initial={false}>
              {node.children.map((child) => (
                <OutlineBranch
                  key={child.key}
                  node={child}
                  collapsed={collapsed}
                  shown={shown}
                  byId={byId}
                  reduce={reduce}
                  actions={actions}
                />
              ))}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}, sameBranch);

function OutlineRow({
  item,
  node,
  open,
  active,
  actions,
  transition = INSTANT,
}: {
  item: OutlineItem;
  /** 「概览」没有节点 */
  node: OutlineNode | null;
  /** 子树展开着（没有子树的也是 true） */
  open: boolean;
  /** 高亮在这一条上 */
  active: boolean;
  actions: BranchActions;
  /** 箭头转动的曲线：和这一条的子树收起展开同一条 */
  transition?: Transition;
}) {
  const foldable = !!node?.children.length;
  const indent = INDENT[item.level];
  return (
    <div className="relative">
      {node && foldable && (
        <button
          type="button"
          tabIndex={-1}
          data-outline-control
          // 不抢焦点：焦点在要收进去的条目上时，由 toggle 挪回这一条
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => actions.toggle(node, event.altKey)}
          aria-label={open ? "收起" : "展开"}
          title={open ? "收起（按住 Alt 连下面各层一起）" : "展开（按住 Alt 连下面各层一起）"}
          style={{ left: indent - 18 }}
          className={cn(
            // 16px、贴着第一行字的中线（上 5px + 行高 20px 的一半 - 8px）
            "absolute top-[7px] z-10 grid h-4 w-4 place-items-center rounded-[4px]",
            "transition-[color,background-color] duration-[140ms]",
            "hover:bg-raised group-hover/rail:hover:text-ink",
            open ? "text-transparent group-hover/rail:text-muted" : "text-muted",
          )}
        >
          {/* 淡入淡出的是颜色，不是 opacity；转的是 SVG 里的 <path>，不是外面的盒子。
              两样都在原地重画，不进合成层（Chrome 不给 SVG 里面的元素单独建层）。
              以前按 CLAUDE.md 第 3 条给每个箭头 will-change: opacity、里面转的那层
              will-change: transform，一个箭头两个图层：两百多条的目录一百二十多个图层，
              收起展开时每帧光整理图层就要 1ms 多，慢机器上（CPU 降速 4 倍）一帧画不完。
              不进图层就没有「淡完那一帧从图层退回页面、挪半个像素」的问题，也不用对齐像素 */}
          <svg
            viewBox="0 0 24 24"
            width={12}
            height={12}
            fill="none"
            stroke="currentColor"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <motion.path
              d="m9 18 6-6-6-6"
              initial={false}
              animate={{ rotate: open ? 90 : 0 }}
              transition={transition}
            />
          </svg>
        </button>
      )}
      <button
        type="button"
        data-outline-item={item.id}
        aria-expanded={foldable ? open : undefined}
        onClick={() => actions.onJump(item.id)}
        onKeyDown={(event) => {
          if (!node) return;
          if (event.key === "ArrowRight" && foldable && !open) {
            event.preventDefault();
            actions.toggle(node, event.altKey);
          } else if (event.key === "ArrowLeft") {
            if (foldable && open) {
              event.preventDefault();
              actions.toggle(node, event.altKey);
            } else if (node.parent) {
              event.preventDefault();
              actions.focus(node.parent.item.id);
            }
          }
        }}
        style={{ paddingLeft: indent }}
        className={cn(
          // 13px / 20px：目录是要扫着读、点着跳的（VitePress、Docusaurus 的目录都是 13px 上下）。
          // 以前 12px faint，亮色下对比度 3:1，和占位符一样淡
          "relative w-full rounded-r-sm py-[5px] pr-2 text-left text-[13px] leading-5",
          "transition-colors duration-[160ms]",
          active ? "text-ink" : "text-muted hover:text-ink",
        )}
      >
        {active && (
          <motion.span
            layoutId="outline-indicator"
            className="absolute left-0 top-[5px] bottom-[5px] w-[2px] rounded-full bg-ink"
            transition={spring.smooth}
          />
        )}
        {/* 字重不过渡：中文每个小数字重都要重新匹配字体，一帧十几毫秒（见 Sidebar）。
            这里尤其要紧 —— 滚动正文时活动标题一直在换。
            长标题完整折行，不截断、不加省略号。 */}
        <span className={cn("block break-words", active ? "font-semibold" : "font-normal")}>
          {item.text}
        </span>
      </button>
    </div>
  );
}

/**
 * 刻度长度按标题级别递减：一眼能看出文档的层级骨架，而不只是「有几个标题」。
 * buildOutline 的缩进最多三档（level 1–3），刻度也是三档。
 */
const TICK_WIDTH: Record<OutlineItem["level"], string> = { 1: "w-5", 2: "w-3", 3: "w-2" };
/** 展开后的面板里各档的缩进 */
const ZEN_INDENT: Record<OutlineItem["level"], string> = { 1: "pl-2", 2: "pl-5", 3: "pl-8" };

/**
 * 专注模式的目录：贴右边缘的一列刻度，鼠标靠近才展开成文字。
 *
 * 专注模式的前提是「除了正文什么都不要」，所以常驻一栏 180px 的文字目录是自相
 * 矛盾的。这里退化成一组横线 —— 长度编码标题级别，当前小节那条变深变长，
 * 于是它静止时既是目录也是进度条，占的墨水极少；真要跳转时移过去就展开。
 *
 * 收起 / 展开两态都常驻 DOM，只切 opacity（走合成器），
 * 不做尺寸动画，所以展开的时候正文一个像素都不会动。
 *
 * 展开要**快**、要**干净**。上一版是刻度先退 140ms、面板再等 90ms 才用 200ms
 * 淡入并从右边滑 4px 过来 —— 加起来 290ms，鼠标一放上去，文字是慢慢「显影」
 * 出来的，看着像还没渲染完。现在两层在同一个 120ms 里交叉淡入淡出，没有延迟、
 * 没有位移：手一到，目录就在那儿。
 *
 * 定位全部不用 transform。原来 aside 和面板都靠 top-1/2 + -translate-y-1/2 居中，
 * 面板高度是奇数时就落在半个像素上，合成层里的文字整段发虚 —— 也是「像没渲染
 * 完」的一部分。现在用 grid 把两层叠在同一格里居中，位置是整像素的布局结果。
 */
function ZenOutline({
  items,
  activeId,
  onJump,
  hidden,
}: {
  items: OutlineItem[];
  activeId: string | null;
  onJump: (id: string) => void;
  hidden: boolean;
}) {
  return (
    <aside
      aria-label="目录树"
      aria-hidden={hidden}
      className={cn(
        // pointer-events-none：hover 判定只认下面刻度那一小块和展开后的面板，
        // 不能整条右边缘都算。:hover 会沿祖先链向上匹配，所以 group 放这里没问题。
        // grid-rows-1 是 minmax(0, 1fr)：这一行钉死在窗口高度，不被一长列刻度撑高 ——
        // 下面刻度列的 max-h-full 才有一个确定的高度可以参照
        "pointer-events-none absolute inset-y-0 right-0 z-30 grid grid-rows-1 items-center justify-items-end",
        "group transition-opacity duration-[200ms] ease-linear [will-change:opacity]",
        hidden ? "opacity-0" : "opacity-100",
      )}
    >
      {/* 收起态：只有刻度。
          will-change 把它单独提成合成层 —— 不提的话 opacity 动画每一帧都要
          连着底下的正文一起重绘，全屏时那块面积是整页宽。

          每条刻度占一个 10px 的槽（2px 的线画在槽中间），间距和原来的 gap-2 一样。
          槽可以压扁到 3px：标题一多（一百来条）整列比窗口还高，以前是从中间往上下
          两头溢出去，两头的刻度够不着；现在整列限高，刻度等比挤紧，全都留在屏幕里。
          顺带点击范围也从 2px 的线变成了整个槽。
          上下各让出 80px：右上角 top 44–76 是退出全屏的按钮，整列顶满的话会压在它底下。 */}
      <div
        className={cn(
          "flex max-h-[calc(100%-160px)] flex-col items-end py-6 pl-16 pr-6 [grid-area:1/1]",
          "transition-opacity duration-[120ms] [will-change:opacity]",
          "group-hover:pointer-events-none group-hover:opacity-0 group-hover:duration-[80ms]",
          hidden ? "pointer-events-none" : "pointer-events-auto",
        )}
      >
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            aria-label={it.text}
            onClick={() => onJump(it.id)}
            className="flex h-2.5 min-h-[3px] shrink items-center"
          >
            {/* 未激活的刻度原来是 line-strong（#e7e7e1），白底上几乎看不见，
                整列像是不存在；faint 的六成仍然很轻，但看得出来 */}
            <span
              className={cn(
                "h-[2px] rounded-full transition-[background-color,width] duration-[220ms]",
                TICK_WIDTH[it.level],
                it.id === activeId ? "!w-6 bg-ink" : "bg-faint/60",
              )}
            />
          </button>
        ))}
      </div>

      {/* 展开态：叠在同一格里，只靠 opacity 出现，不改变任何尺寸。
          底色必须是**不透明**的。原来是 bg-canvas/95，半透明面板压在正文上，
          淡入的每一帧都要把它和底下的文字重新混合一次，而且中途能透出字来，
          看着就是脏。同样提成合成层。 */}
      {/* 条目多了会比窗口还高：和刻度列一样上下让出 80px、超出的部分自己滚，
          不然上下两头伸到窗口外面够不着，顶上还压着退出全屏的按钮 */}
      <div
        className="scroll-none pointer-events-none mr-4 max-h-[calc(100%-160px)] min-w-[168px]
                   max-w-[240px] overflow-y-auto rounded-xl bg-canvas p-2
                   opacity-0 shadow-float ring-1 ring-line-strong [grid-area:1/1]
                   [will-change:opacity] transition-opacity duration-[120ms] ease-out
                   group-hover:pointer-events-auto group-hover:opacity-100
                   group-hover:duration-[80ms]"
      >
        {items.map((it) => {
          const active = it.id === activeId;
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => onJump(it.id)}
              className={cn(
                "flex w-full items-start gap-2 rounded-lg py-[5px] pl-2 pr-2.5 text-left",
                "text-[13px] leading-5 transition-colors duration-[140ms]",
                ZEN_INDENT[it.level],
                active ? "text-ink" : "text-muted hover:bg-raised/50 hover:text-ink",
              )}
            >
              {/* 标题会折成多行：横线对齐第一行的中线（行高 20px），不跟着整块居中 */}
              <span
                className={cn(
                  "mt-[9px] h-[2px] w-3 shrink-0 rounded-full transition-colors duration-[140ms]",
                  active ? "bg-ink" : "bg-line-strong",
                )}
              />
              <span className={cn("min-w-0 break-words", active && "font-semibold")}>
                {it.text}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
