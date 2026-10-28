import { cn } from "@/lib/cn";
import { layoutIds, popoverCard, spring } from "@/lib/motion";
import { shortcut } from "@/lib/platform";
import { CornerDownLeft, Search } from "lucide-react";
import { motion, useIsPresent } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ANIMATED_EMOJIS, type AnimatedEmoji, EmojiPlayer } from "./animatedEmoji";
import { EMOJI_GROUPS } from "./animatedEmojiSet";

/* ============================================================
   动态表情选择器（编辑器里 Ctrl/⌘ + E）。

   贴着光标弹出来：下面放得下就在下面，放不下翻到上面。一行 6 个，分组正好
   各一行；最上面一行是最近用过的，网格限高、放不下就滚动。方向键在格子里走
   （走到看不见的格子会滚过去），回车插入，Esc 关掉并把焦点还给编辑器；输入框
   里打字就是搜索（中文、拼音、英文都行）。
   当前格子里的表情循环播放，其余静止 —— 一屏几十个同时动太吵。
   ============================================================ */

export interface EmojiPickerAnchor {
  /** 光标的视口坐标（coordsAtPos） */
  left: number;
  top: number;
  bottom: number;
}

const COLUMNS = 6;
const GAP = 6;
const EDGE = 8;
/** 面板尺寸（和下面的类名一致：w-[292px]，搜索栏 42 + 网格限高 322 + 底栏 34） */
const PANEL_WIDTH = 292;
const GRID_HEIGHT = 322;
const SEARCH_HEIGHT = 42;
const FOOTER_HEIGHT = 34;
const PANEL_HEIGHT = SEARCH_HEIGHT + GRID_HEIGHT + FOOTER_HEIGHT;

/* ---------------- 最近使用 ---------------- */

const RECENT_KEY = "odea.emoji.recent";
const RECENT_LIMIT = COLUMNS;

export function loadRecent(): AnimatedEmoji[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    if (!Array.isArray(ids)) return [];
    return ids
      .map((id) => ANIMATED_EMOJIS.find((emoji) => emoji.id === id))
      .filter((emoji): emoji is AnimatedEmoji => !!emoji)
      .slice(0, RECENT_LIMIT);
  } catch {
    /* 隐私模式 / 数据损坏：当没有 */
    return [];
  }
}

export function rememberRecent(emoji: AnimatedEmoji): void {
  try {
    const ids = [
      emoji.id,
      ...loadRecent()
        .map((item) => item.id)
        .filter((id) => id !== emoji.id),
    ];
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, RECENT_LIMIT)));
  } catch {
    /* 存不下就算了，不影响插入 */
  }
}

/* ---------------- 搜索与分区 ---------------- */

/** 中文名、近义词、拼音、英文、Unicode 表情本身都能搜；也认 `:odea_fire` 这种短码写法。 */
export function searchEmojis(query: string): AnimatedEmoji[] {
  const q = query
    .trim()
    .toLowerCase()
    .replace(/^:/, "")
    .replace(/^(?:odea|otw)_/, "")
    .replace(/:$/, "");
  if (!q) return [...ANIMATED_EMOJIS];
  return ANIMATED_EMOJIS.filter(
    (emoji) =>
      emoji.id.includes(q) ||
      emoji.name.includes(q) ||
      emoji.fallback === q ||
      emoji.keywords
        .toLowerCase()
        .split(" ")
        .some((keyword) => keyword.includes(q)),
  );
}

export interface PickerSection {
  id: string;
  label: string;
  items: AnimatedEmoji[];
}

export function pickerSections(query: string, recent: AnimatedEmoji[]): PickerSection[] {
  if (query.trim()) {
    const items = searchEmojis(query);
    return items.length ? [{ id: "search", label: "搜索结果", items }] : [];
  }
  const sections: PickerSection[] = [];
  if (recent.length) sections.push({ id: "recent", label: "最近使用", items: recent });
  for (const group of EMOJI_GROUPS) {
    sections.push({
      id: group.id,
      label: group.label,
      items: ANIMATED_EMOJIS.filter((emoji) => emoji.group === group.id),
    });
  }
  return sections;
}

/** 分区切成行，每行最多 COLUMNS 个。方向键按行列走，而不是按下标 ±6 —— 最近使用那行可能不满。 */
export function gridRows(sections: PickerSection[]): number[][] {
  const rows: number[][] = [];
  let index = 0;
  for (const section of sections) {
    for (let start = 0; start < section.items.length; start += COLUMNS) {
      const row: number[] = [];
      for (let col = start; col < Math.min(start + COLUMNS, section.items.length); col += 1) {
        row.push(index);
        index += 1;
      }
      rows.push(row);
    }
  }
  return rows;
}

/** 在网格里走一步：左右跨行连续走，上下保持列（目标行短就落在它最后一个）。 */
export function moveInGrid(
  rows: number[][],
  current: number,
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
): number {
  const total = rows.reduce((sum, row) => sum + row.length, 0);
  if (!total) return 0;
  if (key === "ArrowLeft") return (current - 1 + total) % total;
  if (key === "ArrowRight") return (current + 1) % total;
  const rowIndex = rows.findIndex((row) => row.includes(current));
  const row = rows[rowIndex] ?? rows[0]!;
  const col = Math.max(0, row.indexOf(current));
  const target = rows[rowIndex + (key === "ArrowUp" ? -1 : 1)];
  if (!target) return current;
  return target[Math.min(col, target.length - 1)]!;
}

/* ---------------- 定位 ---------------- */

export interface Placement {
  left: number;
  top: number;
  above: boolean;
  /** 上下都放不下完整面板时，把网格压到这么高（滚动看其余的） */
  gridMax?: number;
}

/** 网格最少留两行多一点，再矮就没法用了 */
const MIN_GRID = 120;

export function viewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function samePlacement(a: Placement, b: Placement): boolean {
  return a.left === b.left && a.top === b.top && a.above === b.above && a.gridMax === b.gridMax;
}

/**
 * 面板的 CSS 定位：钉住贴着光标的那条边（往下开钉上边，往上开用 bottom 钉下边），
 * 展开、收起时那条边不动（lib/motion.ts 的 popoverCard）。对齐到物理像素：落在半个
 * 像素上，边框和字都会被抗锯齿成两行，发虚。
 */
export function pinnedEdge(
  anchor: EmojiPickerAnchor,
  place: Placement,
  viewport = viewportSize(),
  dpr = window.devicePixelRatio || 1,
): { left: number; top?: number; bottom?: number } {
  const snap = (value: number) => Math.round(value * dpr) / dpr;
  return place.above
    ? { left: snap(place.left), bottom: snap(viewport.height - (anchor.top - GAP)) }
    : { left: snap(place.left), top: snap(place.top) };
}

/**
 * 下面放得下就放下面，否则放得下就翻到上面；两边都放不下（矮窗口、光标在中间）
 * 时挑空间大的一边，把网格压矮到正好放得下。左右夹在窗口里。
 * 模板选择器（TemplatePicker）也用它，`grid` 是它可以压矮的列表区。
 */
export function placePicker(
  anchor: EmojiPickerAnchor,
  size: {
    width: number;
    height: number;
    grid: number;
    viewport: { width: number; height: number };
    /** 面板左缘比锚点往左挪多少（默认让第一格表情对准光标） */
    nudge?: number;
  },
): Placement {
  const { width, height, grid, viewport, nudge = 18 } = size;
  const roomBelow = viewport.height - EDGE - (anchor.bottom + GAP);
  const roomAbove = anchor.top - GAP - EDGE;
  let above = false;
  let fitted = height;
  if (height > roomBelow) {
    if (height <= roomAbove) {
      above = true;
    } else {
      above = roomAbove > roomBelow;
      fitted = Math.max(height - grid + MIN_GRID, above ? roomAbove : roomBelow);
    }
  }
  const gridMax = fitted < height ? grid - (height - fitted) : undefined;
  return {
    left: Math.max(EDGE, Math.min(anchor.left - nudge, viewport.width - width - EDGE)),
    top: above ? anchor.top - GAP - fitted : Math.max(EDGE, anchor.bottom + GAP),
    above,
    gridMax,
  };
}

/* ---------------- 组件 ---------------- */

/** 一个格子里的表情：当前项循环播放，离开就停回静止帧。 */
function EmojiGlyph({ emoji, active }: { emoji: AnimatedEmoji; active: boolean }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const playerRef = useRef<EmojiPlayer | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const player = new EmojiPlayer(emoji);
    playerRef.current = player;
    // 选择器里每个表情各出现一次，静止帧不用图：每张不同的图浏览器都要单独建一个
    // SVG 文档，48 个一起建，打开选择器就卡一下（见 EmojiPlayer.mount）
    player.mount(host, { image: false });
    return () => {
      player.stop();
      host.replaceChildren();
      playerRef.current = null;
    };
  }, [emoji]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    if (active) player.loop();
    else player.stop();
  }, [active]);

  return <span ref={hostRef} className="odea-ae odea-ae-picker" aria-hidden="true" />;
}

export function EmojiPicker({
  anchor,
  onPick,
  onClose,
}: {
  anchor: EmojiPickerAnchor;
  onPick: (emoji: AnimatedEmoji) => void;
  /** refocus：是否把焦点还给编辑器（Esc 要还；点到别处去了就不抢） */
  onClose: (refocus: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recent] = useState(loadRecent);
  // 第一帧就摆在最终位置：入场方向（往上开还是往下开）只在挂载时取一次，得先知道。
  // 面板尺寸是定的，用常量先算；挂上以后再按量到的尺寸校正（见下面的 layout effect）
  const [place, setPlace] = useState<Placement>(() =>
    placePicker(anchor, {
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      grid: GRID_HEIGHT,
      viewport: viewportSize(),
    }),
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  /** 这次换当前项是不是键盘干的：键盘走到看不见的格子要滚过去，鼠标悬停不滚（不然边上的格子一碰就跳） */
  const keyboardMoveRef = useRef(false);

  const sections = useMemo(() => pickerSections(query, recent), [query, recent]);
  const items = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const rows = useMemo(() => gridRows(sections), [sections]);
  const current = items[active];

  // 查询变了从第一个开始
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只跟着输入复位
  useEffect(() => setActive(0), [query]);

  // 分组多了网格会滚动：键盘走到的格子保持在视野里
  // biome-ignore lint/correctness/useExhaustiveDependencies: 当前项变了才需要滚，读的是 DOM 上的选中格
  useEffect(() => {
    if (!keyboardMoveRef.current) return;
    keyboardMoveRef.current = false;
    const option = gridRef.current?.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]',
    );
    option?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // 校正定位：按量到的面板尺寸重新摆（和常量算的一样就不动）。在绘制之前跑，看不到挪动
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const content = contentRef.current;
    if (!panel || !content) return;
    // 高度量里面的内容：面板自己这时还是入场第一帧那一窄条
    const measured = placePicker(anchor, {
      width: panel.offsetWidth,
      height: content.offsetHeight,
      grid: gridRef.current?.offsetHeight ?? 0,
      viewport: viewportSize(),
    });
    setPlace((current) => (samePlacement(current, measured) ? current : measured));
  }, [anchor]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 点到外面、窗口失焦、页面滚动或缩放：锚点已经不对了，直接收起。
  // 已经在退场的那一个不再监听 —— 否则它会把紧接着新开的选择器也关掉。
  const present = useIsPresent();
  useEffect(() => {
    if (!present) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && !!panelRef.current?.contains(target);
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) onClose(false);
    };
    const onScroll = (event: Event) => {
      if (!inside(event.target)) onClose(false);
    };
    const onBlur = () => onClose(false);
    const onResize = () => onClose(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose, present]);

  const pick = (emoji: AnimatedEmoji | undefined) => {
    if (!emoji) return;
    rememberRecent(emoji);
    onPick(emoji);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // 输入法组字时回车 / 方向键是给候选框的
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const key = event.key;
    if (key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    } else if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "e") {
      // 再按一次快捷键：收起
      event.preventDefault();
      onClose(true);
    } else if (key === "Enter") {
      event.preventDefault();
      pick(current);
    } else if (
      key === "ArrowLeft" ||
      key === "ArrowRight" ||
      key === "ArrowUp" ||
      key === "ArrowDown"
    ) {
      event.preventDefault();
      keyboardMoveRef.current = true;
      setActive((index) => moveInGrid(rows, index, key));
    } else if (key === "Tab") {
      event.preventDefault();
      keyboardMoveRef.current = true;
      setActive((index) => moveInGrid(rows, index, event.shiftKey ? "ArrowLeft" : "ArrowRight"));
    }
  };

  let index = -1;
  return (
    // 从光标那条边展开，里面的字不缩放、不变透明：缩放会让字糊一下再抖一下，半透明会和
    // 底下的正文叠影，看着像正文跳了一下（见 lib/motion.ts 的 popoverCard）
    <motion.div
      ref={panelRef}
      role="dialog"
      aria-label="插入动态表情"
      // 第一帧露出贴着光标的那一栏：往下开是搜索栏，往上开是底栏
      custom={place.above ? FOOTER_HEIGHT : SEARCH_HEIGHT}
      variants={popoverCard}
      initial="hidden"
      animate="shown"
      exit="gone"
      onKeyDown={onKeyDown}
      style={{
        ...pinnedEdge(anchor, place),
        // 退场中的那几帧已经在收了，不能再接点击 —— 否则点在它原来的位置会插进一个表情
        pointerEvents: present ? undefined : "none",
      }}
      // overflow-clip 而不是 hidden：hidden 还是个滚动容器，展开途中键盘走到还没露出来的
      // 格子，scrollIntoView 会把整个面板的内容卷上去
      className={cn(
        "odea-emoji-picker fixed z-50 flex w-[292px] flex-col overflow-clip rounded-xl bg-canvas",
        "shadow-float ring-1 ring-line-strong",
        place.above && "justify-end",
      )}
    >
      <div ref={contentRef} className="shrink-0">
        <div className="flex h-[42px] items-center gap-2 border-b border-line px-3">
          <Search size={14} strokeWidth={2} className="shrink-0 text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索表情，如 冲 / huo / fire"
            aria-label="搜索动态表情"
            role="combobox"
            aria-expanded="true"
            aria-controls="odea-emoji-grid"
            aria-activedescendant={current ? `odea-emoji-${current.id}-${active}` : undefined}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none
                     placeholder:text-faint"
          />
        </div>

        <div
          ref={gridRef}
          id="odea-emoji-grid"
          style={place.gridMax ? { maxHeight: place.gridMax } : undefined}
          role="listbox"
          aria-label="动态表情"
          // 焦点始终留在输入框里（aria-activedescendant 指向当前格），这里只是满足 listbox 可聚焦
          tabIndex={-1}
          // 八组 + 最近使用一屏放不下：网格限高滚动，露出半行提示下面还有
          className="scroll-thin max-h-[322px] overflow-y-auto overscroll-contain px-2 pb-1.5 pt-1"
        >
          {sections.length === 0 ? (
            <p className="px-2 py-8 text-center text-[13px] text-muted">
              没有找到「{query.trim()}」
            </p>
          ) : (
            sections.map((section) => (
              <div key={section.id} role="group" aria-label={section.label}>
                <p className="px-1.5 pb-0.5 pt-1.5 text-[12px] font-medium tracking-[0.05em] text-muted">
                  {section.label}
                </p>
                <div className="grid grid-cols-6">
                  {section.items.map((emoji) => {
                    index += 1;
                    const itemIndex = index;
                    const selected = itemIndex === active;
                    return (
                      <button
                        key={`${section.id}-${emoji.id}`}
                        id={`odea-emoji-${emoji.id}-${itemIndex}`}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        aria-label={emoji.name}
                        title={`${emoji.name}  ${emoji.shortcode}`}
                        tabIndex={-1}
                        data-emoji={emoji.id}
                        // 按下时别把焦点从输入框抢走，键盘还能接着用
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseMove={() => {
                          if (!selected) setActive(itemIndex);
                        }}
                        onClick={() => pick(emoji)}
                        className="relative flex h-[44px] items-center justify-center rounded-lg"
                      >
                        {/* 退场时撤掉：带 layoutId 的元素会让 Motion 把整个面板多留一会儿 */}
                        {selected && present && (
                          <motion.span
                            layoutId={layoutIds.emojiCursor}
                            className="absolute inset-[2px] rounded-lg bg-accent-wash"
                            transition={spring.snappy}
                          />
                        )}
                        <span
                          className={cn(
                            "relative z-10 text-[23px] transition-transform duration-[140ms]",
                            selected && "scale-[1.12]",
                          )}
                        >
                          <EmojiGlyph emoji={emoji} active={selected} />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="flex h-[34px] items-center gap-2 border-t border-line px-3 text-[12px] text-muted">
          {current ? (
            <>
              <span className="truncate font-medium text-body">{current.name}</span>
              <span className="truncate font-mono text-[11px]">{current.shortcode}</span>
            </>
          ) : null}
          {/* 回车画成图标，不用 ↵：正文字体里没有这个字，第一次画它浏览器要把系统字体
            挨个找一遍（装的字体越多越慢），打开选择器就卡在这一下 */}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <CornerDownLeft size={12} strokeWidth={2} aria-label="回车" />
            插入 · Esc 关闭 · {shortcut("E")}
          </span>
        </div>
      </div>
    </motion.div>
  );
}
