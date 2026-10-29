import { cn } from "@/lib/cn";
import { layoutIds, popoverCard, spring } from "@/lib/motion";
import type { Range } from "@/lib/paletteSearch";
import { usePaneWindow } from "@/lib/paneWindow";
import { ArrowDown, ArrowUp, CornerDownLeft, type LucideIcon } from "lucide-react";
import { motion, useIsPresent } from "motion/react";
import {
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type EmojiPickerAnchor,
  type Placement,
  pinnedEdge,
  placePicker,
  samePlacement,
  viewportSize,
} from "./EmojiPicker";

/* ============================================================
   打字触发的补全菜单：`/` 插入一块、`[[` 链接到笔记（逻辑在 suggest.ts）。

   和模板选择器一样，焦点一直留在正文里：方向键、回车、Tab、Esc 由编辑器转过来
   （SuggestMenuHandle），接着打字就是在筛选。点在面板上不让正文失焦。
   卡片从触发词那条边展开，里面的字不缩放、不变透明（lib/motion.ts 的 popoverCard）。
   ============================================================ */

export interface SuggestMenuHandle {
  move: (step: 1 | -1) => void;
  /** 选当前这一项；一项都没有时返回 false（回车照常换行） */
  pick: () => boolean;
}

export interface SuggestRow {
  id: string;
  icon: LucideIcon;
  label: string;
  /** 标题里命中筛选词的字 */
  ranges?: Range[];
  /** 右边的小字：快捷键、语法、所在文件夹 */
  hint?: string;
  /** 「还没有这篇」那一行：字是灰的 */
  muted?: boolean;
}

const ROW_HEIGHT = 34;
/** 列表最多这么高（8 行），再多滚动 */
const LIST_MAX = ROW_HEIGHT * 8 + 12;
const HEADER_HEIGHT = 32;
const FOOTER_HEIGHT = 30;
const PANEL_WIDTH = 300;
const NUDGE = 10;

export function SuggestMenu({
  anchor,
  title,
  icon: TitleIcon,
  rows,
  empty,
  handleRef,
  onPick,
  onClose,
}: {
  anchor: EmojiPickerAnchor;
  title: string;
  icon: LucideIcon;
  rows: SuggestRow[];
  /** 一项都没有时那一行写什么 */
  empty: string;
  handleRef: React.RefObject<SuggestMenuHandle | null>;
  onPick: (index: number) => void;
  onClose: () => void;
}) {
  // 弹出窗口里的编辑器（docs/标签页与分屏.md §16）：按它所在的那个窗口摆、听
  const { doc, win: view } = usePaneWindow();
  const [active, setActive] = useState(0);
  // 筛选词变了，高亮回到第一项
  const rowsKey = rows.map((row) => row.id).join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: 列表换了才复位
  useEffect(() => setActive(0), [rowsKey]);

  // 第一帧就摆在最终位置：按最高的尺寸算上下，打字筛选时不会忽上忽下地翻
  const [place, setPlace] = useState<Placement>(() =>
    placePicker(anchor, {
      width: PANEL_WIDTH,
      height: HEADER_HEIGHT + LIST_MAX + FOOTER_HEIGHT,
      grid: LIST_MAX,
      viewport: viewportSize(view),
      nudge: NUDGE,
    }),
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const measured = placePicker(anchor, {
      width: PANEL_WIDTH,
      height: HEADER_HEIGHT + LIST_MAX + FOOTER_HEIGHT,
      grid: LIST_MAX,
      viewport: viewportSize(view),
      nudge: NUDGE,
    });
    setPlace((current) => (samePlacement(current, measured) ? current : measured));
  }, [anchor, view]);

  useImperativeHandle(handleRef, () => ({
    move: (step) =>
      setActive((index) => (rows.length ? (index + step + rows.length) % rows.length : 0)),
    pick: () => {
      if (!rows.length) return false;
      onPick(Math.min(active, rows.length - 1));
      return true;
    },
  }));

  // 键盘挪到看不见的那一项时滚过去
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-suggest-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // 点到外面、滚轮、缩放、窗口失焦：锚点已经不对了，收起（同模板选择器）
  const present = useIsPresent();
  useEffect(() => {
    if (!present) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && !!panelRef.current?.contains(target);
    const onOutside = (event: Event) => {
      if (!inside(event.target)) onClose();
    };
    doc.addEventListener("pointerdown", onOutside, true);
    view.addEventListener("wheel", onOutside, { capture: true, passive: true });
    view.addEventListener("resize", onClose);
    view.addEventListener("blur", onClose);
    return () => {
      doc.removeEventListener("pointerdown", onOutside, true);
      view.removeEventListener("wheel", onOutside, true);
      view.removeEventListener("resize", onClose);
      view.removeEventListener("blur", onClose);
    };
  }, [onClose, present, doc, view]);

  return (
    <motion.div
      ref={panelRef}
      role="dialog"
      aria-label={title}
      custom={place.above ? FOOTER_HEIGHT : HEADER_HEIGHT}
      variants={popoverCard}
      initial="hidden"
      animate="shown"
      exit="gone"
      // 点在面板上不能让正文失焦：失焦会收起菜单，键盘也就接不上了
      onMouseDown={(event) => event.preventDefault()}
      style={{
        ...pinnedEdge(anchor, place, viewportSize(view), view.devicePixelRatio || 1),
        pointerEvents: present ? undefined : "none",
      }}
      className={cn(
        "odea-suggest-menu fixed z-50 flex flex-col overflow-clip rounded-xl bg-canvas shadow-float ring-1 ring-line-strong",
        place.above && "justify-end",
      )}
    >
      <div className="w-[300px] max-w-[calc(100vw-16px)] shrink-0">
        <div className="flex h-[32px] items-center gap-2 border-b border-line px-3">
          <TitleIcon size={14} strokeWidth={1.9} className="shrink-0 text-muted" />
          <span className="text-[12px] font-medium text-muted">{title}</span>
        </div>

        <div
          ref={listRef}
          role="listbox"
          aria-label={title}
          tabIndex={-1}
          className="scroll-thin overflow-y-auto overscroll-contain p-1.5"
          style={{ maxHeight: place.gridMax ?? LIST_MAX }}
        >
          {rows.length === 0 ? (
            <p className="px-2 py-2.5 text-[12px] text-muted">{empty}</p>
          ) : (
            rows.map((row, index) => {
              const selected = index === active;
              const Icon = row.icon;
              return (
                <button
                  key={row.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  data-suggest-index={index}
                  onMouseMove={() => {
                    if (!selected) setActive(index);
                  }}
                  onClick={() => onPick(index)}
                  className="relative flex h-[34px] w-full items-center gap-2.5 rounded-lg px-2 text-left"
                >
                  {/* 退场时撤掉：带 layoutId 的元素会让 Motion 把整个面板多留一会儿 */}
                  {selected && present && (
                    <motion.span
                      layoutId={layoutIds.suggestCursor}
                      className="absolute inset-0 rounded-lg bg-accent-wash"
                      transition={spring.snappy}
                    />
                  )}
                  <Icon
                    size={14}
                    strokeWidth={1.9}
                    className={cn(
                      "relative z-10 shrink-0 transition-colors duration-[140ms]",
                      selected ? "text-accent" : "text-muted",
                    )}
                  />
                  <span
                    className={cn(
                      "relative z-10 min-w-0 flex-1 truncate text-[13px]",
                      row.muted ? "text-muted" : selected ? "font-medium text-ink" : "text-body",
                    )}
                  >
                    <Marked text={row.label} ranges={row.ranges} />
                  </span>
                  {row.hint && (
                    <span className="relative z-10 max-w-[40%] shrink-0 truncate text-[12px] text-muted">
                      {row.hint}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="flex h-[30px] items-center gap-1 border-t border-line px-3 text-[12px] text-muted">
          {/* 按键画成图标，不用箭头、回车这类字（见 popupGlyphs.test.ts） */}
          <ArrowUp size={12} strokeWidth={2} aria-label="上" />
          <ArrowDown size={12} strokeWidth={2} aria-label="下" />
          <span>选择 ·</span>
          <CornerDownLeft size={12} strokeWidth={2} aria-label="回车" />
          <span>插入</span>
          <span className="ml-auto">Esc 关闭</span>
        </div>
      </div>
    </motion.div>
  );
}

/** 命中的字标成强调色 */
function Marked({ text, ranges }: { text: string; ranges?: Range[] }) {
  if (!ranges?.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [from, to] of ranges) {
    if (from > at) parts.push(text.slice(at, from));
    parts.push(
      <mark key={from} className="bg-transparent font-medium text-accent">
        {text.slice(from, to)}
      </mark>,
    );
    at = to;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
