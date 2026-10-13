import { cn } from "@/lib/cn";
import { tween } from "@/lib/motion";
import { motion } from "motion/react";
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from "react";

/**
 * 中列表栏的统一外壳。
 * 笔记 / 日历 / 归档 三个视图共用，保证标题排版、内边距、滚动行为一致。
 */
export function ListColumn({
  title,
  titleSlot,
  action,
  children,
  belowTitle,
  overlay,
}: {
  title: string;
  /** 换掉默认的标题（笔记区的标题是文件夹切换器） */
  titleSlot?: ReactNode;
  /** 标题右侧的按钮（排序、今天…） */
  action?: ReactNode;
  /** 标题下方、滚动区之上的固定内容（搜索框、月份选择器…） */
  belowTitle?: ReactNode;
  /** 盖在整栏上面的浮层（笔记区的文件夹切换器），相对这一栏定位 */
  overlay?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative flex h-full w-[300px] shrink-0 flex-col border-r border-line-strong/60 bg-panel">
      <div className="shrink-0 px-6 pt-[42px]">
        <div className="flex items-center justify-between gap-3">
          {titleSlot ?? (
            <motion.h2
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={tween.base}
              className="truncate text-[25px] font-bold leading-tight tracking-[-0.02em] text-ink"
            >
              {title}
            </motion.h2>
          )}
          {action && (
            // 只淡入不缩放：按钮里可能是字（日历的「今天」），缩放会让字先糊、停下时再跳清楚
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ ...tween.base, delay: 0.06 }}
              className="shrink-0"
            >
              {action}
            </motion.div>
          )}
        </div>

        {belowTitle && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...tween.base, delay: 0.05 }}
            className="mt-4"
          >
            {belowTitle}
          </motion.div>
        )}
      </div>

      <div data-list-scroller className="scroll-thin mt-3 min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        {children}
      </div>
      {overlay}
    </div>
  );
}

/**
 * 列表栏顶部的小图标按钮（排序、今天）。
 * 其余 props（含 ref）原样透传，这样它能直接当 Radix 菜单的触发元素：
 * Slot 会把 ref、data-state、键盘/指针事件合并进来。
 *
 * 按下的反馈只用颜色，**不缩放**。原来是 whileTap scale 0.94：当它是菜单的
 * 触发器时，菜单在 pointerdown 那一刻按缩小了的按钮定位，松手后按钮用 100ms
 * 弹回原大，floating-ui 的位移监听（IntersectionObserver 盯着触发器的包围盒）
 * 每一帧都跟着重新定位 —— 整个菜单跟着按钮的回弹抖一小段。
 */
export function ColumnButton({
  children,
  label,
  wide,
  className,
  ...rest
}: ComponentProps<"button"> & {
  children: ReactNode;
  label: string;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "flex h-[30px] items-center justify-center gap-1.5 rounded-lg border border-line-strong",
        "bg-canvas text-muted transition-colors duration-[140ms] hover:border-faint/40",
        "hover:text-ink active:bg-raised/60",
        "data-[state=open]:border-faint/40 data-[state=open]:bg-raised/60 data-[state=open]:text-ink",
        wide ? "px-2.5 text-[11.5px]" : "w-[30px]",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * 长列表一次画多少行。几百行整列画出来，启动、切进这个区都要多花好几百毫秒，而且每一行都是
 * Motion 投影树上的节点 —— 任何一个 layout 动画（选中高亮滑过去、导航指示块）每一帧都要把
 * 它们全部过一遍。先画这么多，后面按行高占位，往下滚快到底时再画下一批（只增不减）
 */
export const ROW_BATCH = 40;

/**
 * 分批画一个列表：返回画到第几行，和「再画一批」。listKey 换了（换文件夹、换搜索词）从头算；
 * 选中的那一行连同后面几行总画着 —— 删掉、归档它时要落到下一行（app/navigate 的
 * selectNeighbor 看的是画出来的行）
 */
export function useRowBatch(listKey: string, total: number, selectedAt: number) {
  const [batch, setBatch] = useState({ key: listKey, count: ROW_BATCH });
  const budget = batch.key === listKey ? batch.count : ROW_BATCH;
  const shown = Math.min(total, Math.max(budget, selectedAt + 6));
  return { shown, more: () => setBatch({ key: listKey, count: shown + ROW_BATCH }) };
}

/** 还没画的那些行：按大概的高度占着（对不上只是滚动条长度差一点），快滚到（600px 以内）时再要下一批 */
export function MoreRows({ height, onNear }: { height: number; onNear: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useRef(onNear);
  near.current = onNear;
  // height 变了（刚画了一批）重新观察一次：还在范围里就接着要下一批
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上
  useEffect(() => {
    const spacer = ref.current;
    if (!spacer) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) near.current();
      },
      { root: spacer.closest("[data-list-scroller]"), rootMargin: "600px 0px" },
    );
    observer.observe(spacer);
    return () => observer.disconnect();
  }, [height]);
  return <div ref={ref} aria-hidden="true" style={{ height }} />;
}

/** 分组标签，如「置顶」 */
export function GroupLabel({ icon, text }: { icon?: ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-2">
      {icon && <span className="text-faint">{icon}</span>}
      <span className="text-[11px] font-medium tracking-[0.04em] text-faint">{text}</span>
    </div>
  );
}
