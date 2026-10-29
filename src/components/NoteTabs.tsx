import { MAX_PANES, type NotePane } from "@/app/panes";
import { popOut } from "@/app/popout";
import { type NoteTab, useApp } from "@/app/store";
import { folderLabel, folderOf } from "@/data/folders";
import { NEW_NOTE_TITLE, useData } from "@/data/store";
import { cn } from "@/lib/cn";
import { snapToDevicePixels } from "@/lib/devicePixels";
import { spring, tween, usePrefersReducedMotion } from "@/lib/motion";
import { usePaneWindow } from "@/lib/paneWindow";
import { MOD_KEY, isMac } from "@/lib/platform";
import { isTauri, windowKind } from "@/lib/tauri";
import { type MotionValue, animate, motion, useMotionValue } from "motion/react";
import {
  type PointerEvent as ReactPointerEvent,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/* ============================================================
   笔记的标签栏（docs/标签页与分屏.md §5）。一个窗格一条，在它那一栏的正上方（分屏时几条并排）。

   长在窗口最上面那条 38px 的拖动区里（Chrome、Arc 那样），正文一点不往下挪；
   只开着一篇时没有它，最上面那条还是空的拖动区。和「路径 / 标题」（DocumentView 的
   TitleStrip）同一种叠法：底色那一层（下沿 16px 渐隐，盖住滚上来的正文）在标题栏（z-40）
   底下，标签那一层在它上面（z-41）；整层不接指针，只有标签接 —— 标签之间、右边空着的地方
   照样拖窗口、双击最大化。

   底色那一层是 z-29，比左边的 chrome（z-30）低：列表栏收起的那 220ms 里它还在滑，
   这一层的左边缘已经跳到了窄栏边上，高了会盖住它的上沿。

   动效（CLAUDE.md「动效：先对齐再动」）：
   - 整条出现 / 收起只淡 opacity，一直待在自己的图层上，开始淡之前对齐整物理像素
   - 列表栏收起 / 展开时整条跟着它的右缘滑（和列表栏同一条 tween.base，useFollowList）
   - 一个标签开出来淡入、关掉先原地淡出；别的标签从原处滑到新位置（FLIP，Web Animations，
     起步就走、收尾短的曲线），动之前对齐整物理像素
   - 当前标签的底色在标签之间滑（layoutId，和分段控件的滑块一样；它没有字，可以缩放）
   - 关闭的 × 和保存失败的圆点淡的是 color（一排很多个，不进合成层）
   - 拖着标签离开这一条：变成「停靠」（§13），指针底下那个窗格亮出落点，松手拆分或挪过去；
     拖出主窗口松手：开成弹出窗口（§16）

   弹出窗口里也是这一条（components/Popouts.tsx）：浮层、监听都按它所在的那个窗口（usePaneWindow）
   ============================================================ */

/** 桌面端右边让出窗口按钮（TitleBar：三格 38 + 最右边多 8） */
const WINDOW_BUTTONS = 128;
const SLIDE_EASE = "cubic-bezier(0.33, 1, 0.68, 1)";
const OPEN_MS = 160;
const CLOSE_MS = 120;
const SLIDE_MS = 200;
/** 按下以后挪过这么多才算拖，不然是点 */
const DRAG_SLOP = 4;

const STRIP_HEIGHT = 38;

export function NoteTabs({
  pane,
  shown,
  focused,
  last: rightmost,
}: {
  pane: Pick<NotePane, "id" | "tabs" | "activeTab">;
  shown: boolean;
  /** 正在写的那个窗格（分屏时别的窗格的当前标签淡一档） */
  focused: boolean;
  /** 最右边那一栏：让出窗口按钮 */
  last: boolean;
}) {
  const tabs = pane.tabs;
  const active = pane.activeTab;
  const panelCollapsed = useApp((s) => s.panelCollapsed);
  const reduce = useApp((s) => s.reduceMotion) || usePrefersReducedMotion();
  // 收起的那一段里字留着收起之前的样子（关到只剩一个时，淡出的还是那两个标签）
  const last = useRef({ tabs, active });
  if (shown) last.current = { tabs, active };
  const view = last.current;

  const stripRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 开始淡之前对齐到整物理像素（层里画出来才不糊，淡完不闪）
  // biome-ignore lint/correctness/useExhaustiveDependencies: shown 变了就是要开始淡了
  useLayoutEffect(() => {
    if (stripRef.current) snapToDevicePixels(stripRef.current);
  }, [shown]);

  // 一个个标签的动画只在整条已经显示着的时候播：整条正在淡入淡出时，里面再各淡各的、
  // 还留着上一次收起前那几个在淡出，就乱了
  const wasShown = useRef(shown);
  const followX = useFollowList(stripRef, panelCollapsed, shown && !reduce);
  const rows = useTabRows(listRef, view.tabs, shown && wasShown.current && !reduce);
  useLayoutEffect(() => {
    wasShown.current = shown;
  }, [shown]);
  const host = usePaneWindow();
  const drag = useTabDrag(listRef, pane.id, host.popout !== null);
  const [menu, setMenu] = useState<TabMenuAt | null>(null);

  // 竖着滚轮也横着滚（标签多到放不下时）。React 的 onWheel 是 passive 的，拦不住页面滚
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onWheel = (event: WheelEvent) => {
      if (list.scrollWidth <= list.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      list.scrollLeft += event.deltaY;
    };
    list.addEventListener("wheel", onWheel, { passive: false });
    return () => list.removeEventListener("wheel", onWheel);
  }, []);

  // 切过去的那个滚进视野
  useEffect(() => {
    const list = listRef.current;
    const tab = list?.querySelector<HTMLElement>(`[data-tab="${view.active}"]`);
    if (!list || !tab) return;
    const pad = 12;
    const right = list.clientWidth - (isTauri && rightmost ? WINDOW_BUTTONS : pad);
    if (tab.offsetLeft - pad < list.scrollLeft) list.scrollLeft = tab.offsetLeft - pad;
    else if (tab.offsetLeft + tab.offsetWidth > list.scrollLeft + right)
      list.scrollLeft = tab.offsetLeft + tab.offsetWidth - right;
  }, [view.active, rightmost]);

  return (
    <>
      <div
        aria-hidden="true"
        data-shown={shown || undefined}
        className="odea-doc-strip pointer-events-none absolute inset-x-0 top-0 z-[29]"
        style={{
          height: STRIP_HEIGHT + 16,
          background: `linear-gradient(to bottom, var(--color-canvas) ${STRIP_HEIGHT}px, transparent)`,
        }}
      />
      <motion.div
        ref={stripRef}
        data-shown={shown || undefined}
        className="odea-doc-strip pointer-events-none absolute inset-x-0 top-0 z-[41]"
        style={{ height: STRIP_HEIGHT, x: followX }}
      >
        <div
          ref={listRef}
          role="tablist"
          aria-label="打开的笔记"
          className="scroll-none relative flex h-full items-center gap-0.5 overflow-x-auto pl-3"
          style={{ paddingRight: isTauri && rightmost ? WINDOW_BUTTONS : 16 }}
        >
          {rows.map((row) => (
            <Tab
              key={row.tab.id}
              tab={row.tab}
              paneId={pane.id}
              active={row.tab.id === view.active}
              focused={focused}
              leaving={row.leaving}
              onPointerDown={drag}
              onMenu={setMenu}
            />
          ))}
        </div>
      </motion.div>
      {menu && <TabMenu at={menu} onClose={() => setMenu(null)} />}
    </>
  );
}

/**
 * 列表栏收起 / 展开：整条跟着列表栏的右缘滑，不然列表栏还没滑走，标签已经跳到了它上面
 * （标签那一层比左边的 chrome 高）。
 *
 * 列表栏是 Shell 里 Motion 的 x（tween.base），在主线程上逐帧算，主线程一忙它就顿一下。
 * 这里也用 Motion 的 animate、同一条曲线，在同一次提交里起步：Motion 在一次同步执行里给的
 * 「现在」是同一个，两条的进度每一帧都一样，顿也一起顿。试过的两种都对不齐：Motion 的
 * layout="position" 要等量完下一帧才起步，展开时开头 100ms 标签压在列表栏上；合成器上的
 * Web Animations 不跟着主线程顿，列表栏一顿就差出几十个像素
 */
function useFollowList(
  stripRef: React.RefObject<HTMLDivElement | null>,
  panelCollapsed: boolean,
  animated: boolean,
): MotionValue<number> {
  const x = useMotionValue(0);
  /** 上一次的左缘（正文区的左缘，不含正在跑的位移）和那时列表栏收没收 */
  const last = useRef<{ left: number; collapsed: boolean } | null>(null);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const host = strip?.parentElement;
    if (!strip || !host) return;
    const left = host.getBoundingClientRect().left;
    const before = last.current;
    last.current = { left, collapsed: panelCollapsed };
    if (!before || before.collapsed === panelCollapsed || before.left === left) return;
    if (!animated) return;
    // 正在滑的半道上又切了一次：从现在看得见的地方接着滑
    x.set(x.get() + before.left - left);
    snapToDevicePixels(strip);
    void animate(x, 0, tween.base).then(() => snapToDevicePixels(strip));
  });
  return x;
}

/* ---------------- 一个标签 ---------------- */

const Tab = memo(function Tab({
  tab,
  paneId,
  active,
  focused,
  leaving,
  onPointerDown,
  onMenu,
}: {
  tab: NoteTab;
  paneId: string;
  active: boolean;
  focused: boolean;
  /** 关掉了、正在原地淡出：点不到、读屏器不念 */
  leaving: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, tab: NoteTab, wasActive: boolean) => void;
  onMenu: (at: TabMenuAt) => void;
}) {
  const note = useData((s) => s.notes.find((item) => item.id === tab.noteId));
  // 有修改没存进去（保存失败）：× 的位置是一个小圆点，悬停变回 ×
  const unsaved = useData((s) => !!s.drafts[`note:${tab.noteId}`]);
  const title = note ? note.title.trim() || NEW_NOTE_TITLE : "";
  const folder = note ? folderOf(note) : "";
  const close = () => useApp.getState().closeTab(tab.id);

  return (
    <div
      role="tab"
      // 键盘走快捷键（Ctrl+Tab、Alt+数字），不进 Tab 键的顺序
      tabIndex={-1}
      aria-selected={active}
      aria-hidden={leaving || undefined}
      data-tab={tab.id}
      data-leaving={leaving || undefined}
      title={folder ? `${folderLabel(folder)} / ${title}` : title}
      onPointerDown={(event) => onPointerDown(event, tab, active)}
      onMouseDown={(event) => {
        // 中键按下时浏览器会进「自动滚动」
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        close();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
      }}
      className={cn(
        // 按字数排宽（最宽 200）：没选中的标签没有底，一样宽的话字和字之间的空一段大一段小
        "group relative flex h-7 min-w-[72px] max-w-[200px] flex-[0_1_auto] cursor-default select-none",
        "items-center rounded-lg pl-2.5 pr-1 text-[13px] transition-colors duration-[120ms]",
        leaving ? "pointer-events-none" : "pointer-events-auto",
        active
          ? focused
            ? "text-ink"
            : "text-body"
          : "text-muted hover:bg-raised/35 hover:text-body",
      )}
    >
      {active && (
        <motion.span
          // 一个窗格一块；分屏时不在写的那个窗格的当前标签底色浅一档（换的是颜色，不进合成层）
          layoutId={`note-tab-pill-${paneId}`}
          className={cn(
            "absolute inset-0 rounded-lg transition-colors duration-[120ms]",
            focused ? "bg-raised" : "bg-raised/55",
          )}
          style={{ borderRadius: 8 }}
          transition={spring.smooth}
        />
      )}
      <span data-tab-title className="relative min-w-0 flex-1 truncate leading-[20px]">
        {title}
      </span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`关闭「${title}」`}
        title="关闭"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          close();
        }}
        className={cn(
          "relative ml-0.5 grid h-5 w-[18px] shrink-0 place-items-center rounded-md",
          // 当前标签的底就是 raised：按钮的悬停用半透明的墨色，压在哪种底上都看得出
          "transition-colors duration-[120ms] hover:bg-ink/10 hover:text-ink",
          // 不是当前的、没悬停：看不见（淡颜色，不淡透明度）
          active || unsaved ? "text-faint" : "text-transparent group-hover:text-faint",
        )}
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
          <path
            d="M4.5 4.5l7 7M11.5 4.5l-7 7"
            fill="none"
            strokeWidth="1.4"
            strokeLinecap="round"
            className={cn(
              "transition-[stroke] duration-[120ms]",
              unsaved ? "stroke-transparent group-hover:stroke-current" : "stroke-current",
            )}
          />
          {unsaved && (
            <circle
              cx="8"
              cy="8"
              r="3"
              className="fill-warning transition-[fill] duration-[120ms] group-hover:fill-transparent"
            />
          )}
        </svg>
      </button>
    </div>
  );
});

/* ---------------- 开出来、关掉、挪位置 ---------------- */

interface TabRow {
  tab: NoteTab;
  leaving: boolean;
}

/**
 * 要画的标签：现在的这些，加上刚关掉、还在原地淡出的（插回它原来的位置）。
 * 排版只变一次；动的都是合成器上的 opacity / transform（和 Sidebar 的 useNavRows 一个路子）
 */
function useTabRows(
  listRef: React.RefObject<HTMLDivElement | null>,
  tabs: NoteTab[],
  animate: boolean,
): TabRow[] {
  const key = tabs.map((tab) => tab.id).join("|");
  /** 上一次提交时的标签 */
  const shown = useRef(tabs);
  const [leaving, setLeaving] = useState<{ tab: NoteTab; index: number }[]>([]);
  // 这一次刚关掉、还没登记进 leaving 的：这一帧先照旧画在原处，下面的 layout effect 开始淡
  const dropping = animate
    ? shown.current
        .map((tab, index) => ({ tab, index }))
        .filter(({ tab }) => !tabs.some((other) => other.id === tab.id))
    : [];
  const rows: TabRow[] = tabs.map((tab) => ({ tab, leaving: false }));
  for (const { tab, index } of [...leaving, ...dropping]) {
    if (rows.some((row) => row.tab.id === tab.id)) continue;
    rows.splice(Math.min(index, rows.length), 0, { tab, leaving: true });
  }
  const rowsKey = rows.map((row) => row.tab.id).join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: key 就是 tabs 的指纹
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = tabs;
    // 关掉又开回来的（Ctrl+Shift+T 是新的 id，不会撞上）：照常
    const removed = before
      .map((tab, index) => ({ tab, index }))
      .filter(({ tab }) => !tabs.some((other) => other.id === tab.id));
    const list = listRef.current;
    if (!removed.length || !animate || !list) return;
    setLeaving((now) => [
      ...now,
      ...removed.filter(({ tab }) => !now.some((o) => o.tab.id === tab.id)),
    ]);
    for (const { tab } of removed) {
      const element = list.querySelector<HTMLElement>(`[data-tab="${tab.id}"]`);
      if (!element || typeof element.animate !== "function") continue;
      snapToDevicePixels(element);
      const fade = element.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: CLOSE_MS,
        easing: "ease-out",
        fill: "forwards",
      });
      fade.onfinish = () => setLeaving((now) => now.filter((other) => other.tab.id !== tab.id));
    }
  }, [key, animate]);

  // 不动画的时候（整条藏着、减少动效）不留淡出的
  useEffect(() => {
    if (!animate) setLeaving([]);
  }, [animate]);

  // 格子变了：挪了位置的从原处滑过去，新开出来的淡入
  // biome-ignore lint/correctness/useExhaustiveDependencies: rowsKey 就是这一排的指纹
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const previous = lefts.get(list) ?? new Map<string, number>();
    const next = new Map<string, number>();
    for (const element of list.querySelectorAll<HTMLElement>("[data-tab]")) {
      const id = element.dataset.tab!;
      const left = element.offsetLeft;
      next.set(id, left);
      if (!animate || typeof element.animate !== "function") continue;
      const old = previous.get(id);
      if (old === undefined) {
        snapToDevicePixels(element);
        element.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: OPEN_MS,
          easing: "ease-out",
          fill: "backwards",
        });
      } else if (Math.abs(old - left) >= 0.5) {
        snapToDevicePixels(element);
        element.animate([{ transform: `translateX(${old - left}px)` }, { transform: "none" }], {
          duration: SLIDE_MS,
          easing: SLIDE_EASE,
        });
      }
    }
    lefts.set(list, next);
  }, [rowsKey, animate]);

  return rows;
}

/**
 * 每个标签上一次排好的位置（offsetLeft，不含正在跑的 transform）。拖着排松手的那一下
 * 改成松手时看得见的位置，挪到新位置的那一下就从那里接着滑，不跳回原处（useTabDrag）
 */
const lefts = new WeakMap<HTMLElement, Map<string, number>>();

/* ---------------- 拖着排、停靠、点 ---------------- */

/** 上下拖出这么远就不是排顺序了，是要挪到别的窗格 / 拆出一栏（停靠） */
const DOCK_SLOP = 24;
/** 窗格左右各这么宽是「拆到这一边」，中间是「挪进这个窗格」 */
const EDGE = 0.25;
/** 指针离窗口边不到这么远（或者出了窗口）：松手开成弹出窗口 */
const EDGE_OUT = 2;

interface DockZone {
  paneId: string;
  /** outside：拖出了窗口，松手开成弹出窗口（§16） */
  kind: "left" | "right" | "center" | "outside";
  rect: { left: number; top: number; width: number; height: number };
}

/**
 * 按下就切过去（和浏览器一样）；左右拖过 4px 是排顺序：被拖的跟着指针走，别的让位，
 * 松手才真的挪（moveTab）。上下拖出 24px 是停靠（docs/标签页与分屏.md §13）：标签回到原处、
 * 淡一档，一个小签跟着指针走，指针底下那个窗格亮出落点 —— 左右四分之一是拆到那一边，中间是挪进去。
 * 点已经是当前的那个：这个窗格的正文滚回顶上（标签栏显示着时没有「路径 / 标题」那一行可点）
 */
function useTabDrag(
  listRef: React.RefObject<HTMLDivElement | null>,
  paneId: string,
  /** 在弹出窗口里：只排顺序，不停靠、不拆分（跨窗口拖不了，指针一出窗口就不归它管了） */
  inPopout: boolean,
) {
  return (event: ReactPointerEvent<HTMLElement>, tab: NoteTab, wasActive: boolean) => {
    if (event.button !== 0) return;
    const list = listRef.current;
    const element = event.currentTarget;
    if (!list) return;
    const doc = element.ownerDocument;
    useApp.getState().switchTab(tab.id);

    const others = [...list.querySelectorAll<HTMLElement>("[data-tab]:not([data-leaving])")];
    const from = others.indexOf(element);
    const slots = others.map((other) => ({
      element: other,
      left: other.offsetLeft,
      center: other.offsetLeft + other.offsetWidth / 2,
    }));
    const width = element.offsetWidth + 2; // gap-0.5
    const startX = event.clientX;
    const startY = event.clientY;
    const min = -element.offsetLeft + (slots[0]?.left ?? 0);
    const last = slots[slots.length - 1];
    const max = last
      ? last.left + last.element.offsetWidth - element.offsetLeft - element.offsetWidth
      : 0;
    let mode: "press" | "reorder" | "dock" = "press";
    let target = from;
    let dock: Dock | null = null;
    let zone: DockZone | null = null;
    element.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      if (!inPopout && mode !== "dock" && Math.abs(moveEvent.clientY - startY) >= DOCK_SLOP) {
        // 别的标签滑回原处，被拖的回到自己的格子里、淡一档
        mode = "dock";
        target = from;
        for (const slot of slots) slot.element.style.transform = "";
        element.style.transition = "";
        element.style.zIndex = "";
        element.style.opacity = "0.4";
        dock = openDock(element.querySelector("[data-tab-title]")?.textContent ?? "", doc);
      }
      if (mode === "dock") {
        zone = dockZoneAt(moveEvent.clientX, moveEvent.clientY, paneId, doc);
        dock?.move(moveEvent.clientX, moveEvent.clientY, zone);
        return;
      }
      if (mode === "press") {
        if (Math.abs(moveEvent.clientX - startX) < DRAG_SLOP) return;
        mode = "reorder";
        element.style.zIndex = "1";
        for (const slot of slots) {
          if (slot.element !== element)
            slot.element.style.transition = `transform ${SLIDE_MS}ms ${SLIDE_EASE}`;
        }
      }
      const dx = Math.max(min, Math.min(max, moveEvent.clientX - startX));
      element.style.transform = `translateX(${dx}px)`;
      const center = slots[from]!.center + dx;
      target = slots.filter((slot, index) => index !== from && slot.center < center).length;
      slots.forEach((slot, index) => {
        if (index === from) return;
        const shift =
          index > from && index <= target ? -width : index < from && index >= target ? width : 0;
        slot.element.style.transform = shift ? `translateX(${shift}px)` : "";
      });
    };

    const up = (upEvent: PointerEvent) => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      if (mode === "press") {
        if (wasActive) {
          element
            .closest("[data-pane]")
            ?.querySelector<HTMLElement>("[data-doc-scroller]")
            ?.scrollTo({ top: 0, behavior: "smooth" });
        }
        return;
      }
      if (mode === "dock") {
        dock?.close();
        element.style.opacity = "";
        for (const slot of slots) slot.element.style.transition = "";
        const drop = zone;
        if (!drop) return;
        const app = useApp.getState();
        if (drop.kind === "outside") {
          if (upEvent.type !== "pointerup") return;
          // 松手的地方就是新窗口里这个标签的位置；宽度和它原来那一栏差不多
          const width = element.closest<HTMLElement>("[data-pane]")?.offsetWidth;
          popOut(tab.id, { x: upEvent.screenX, y: upEvent.screenY }, width);
          return;
        }
        if (drop.kind === "center") {
          const into = app.notePanes.find((pane) => pane.id === drop.paneId);
          app.moveTab(tab.id, drop.paneId, into ? into.tabs.length : 0);
        } else {
          app.splitTab(tab.id, drop.paneId, drop.kind, false);
        }
        return;
      }
      // 松手时看得见的位置记成「上一次的位置」：挪过去以后从这里接着滑到格子里
      const listLeft = list.getBoundingClientRect().left - list.scrollLeft;
      const seen = lefts.get(list) ?? new Map<string, number>();
      for (const slot of slots) {
        seen.set(slot.element.dataset.tab!, slot.element.getBoundingClientRect().left - listLeft);
        slot.element.style.transition = "";
        slot.element.style.transform = "";
        slot.element.style.zIndex = "";
      }
      lefts.set(list, seen);
      if (target !== from) {
        useApp.getState().moveTab(tab.id, paneId, target);
        return;
      }
      // 没挪：被拖的那个滑回原处
      const offset = (seen.get(tab.id) ?? element.offsetLeft) - element.offsetLeft;
      if (Math.abs(offset) >= 0.5 && typeof element.animate === "function") {
        element.animate([{ transform: `translateX(${offset}px)` }, { transform: "none" }], {
          duration: SLIDE_MS,
          easing: SLIDE_EASE,
        });
      }
      seen.set(tab.id, element.offsetLeft);
    };

    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
  };
}

/**
 * 指针底下是哪个窗格的哪一块。拆不了的（到了三栏、把一个窗格里唯一的标签拖到自己边上）
 * 两边也算「挪进去」；挪进自己所在的窗格等于没动，不算落点
 */
function dockZoneAt(x: number, y: number, fromPane: string, doc: Document): DockZone | null {
  const { notePanes } = useApp.getState();
  const source = notePanes.find((pane) => pane.id === fromPane);
  const view = doc.defaultView ?? window;
  // 拖出了主窗口、或者拖到了窗口的边上：开成弹出窗口（§16）。窗口最大化时指针出不了屏幕，
  // 也就出不了窗口，贴着边（最外面那 2px）也算
  if (
    x < EDGE_OUT ||
    y < EDGE_OUT ||
    x >= view.innerWidth - EDGE_OUT ||
    y >= view.innerHeight - EDGE_OUT
  ) {
    return windowKind === "vault"
      ? { paneId: fromPane, kind: "outside", rect: { left: 0, top: 0, width: 0, height: 0 } }
      : null;
  }
  for (const host of doc.querySelectorAll<HTMLElement>("[data-pane]")) {
    const box = host.getBoundingClientRect();
    if (x < box.left || x >= box.right || y < box.top || y >= box.bottom) continue;
    const paneId = host.dataset.pane!;
    const at = (x - box.left) / box.width;
    const lonely = paneId === fromPane && (source?.tabs.length ?? 0) < 2;
    const canSplit = notePanes.length < MAX_PANES && !lonely;
    const half = box.width / 2;
    const rect = { left: box.left, top: box.top, width: box.width, height: box.height };
    if (canSplit && at < EDGE) return { paneId, kind: "left", rect: { ...rect, width: half } };
    if (canSplit && at > 1 - EDGE) {
      return { paneId, kind: "right", rect: { ...rect, left: box.left + half, width: half } };
    }
    if (paneId === fromPane) return null;
    return { paneId, kind: "center", rect };
  }
  return null;
}

interface Dock {
  move: (x: number, y: number, zone: DockZone | null) => void;
  close: () => void;
}

/**
 * 停靠时的两样东西：跟着指针的小签、窗格上的落点。都是 fixed、不接指针，直接操作 DOM（指针每动一下
 * 不重渲染 React）。落点只淡入淡出；换了一块就把位置、大小滑过去（它没有字，CLAUDE.md 规矩 1 说的是
 * 带字的东西不缩放），第一次出现直接摆在那里再淡入，不从上一次的地方滑过来。
 * 坐标都对齐到整物理像素，边框不糊
 */
function openDock(label: string, doc: Document): Dock {
  const view = doc.defaultView ?? window;
  const ratio = view.devicePixelRatio || 1;
  const snap = (value: number) => Math.round(value * ratio) / ratio;
  const overlay = doc.createElement("div");
  overlay.className =
    "pointer-events-none fixed left-0 top-0 z-[60] rounded-[10px] border border-accent-line bg-accent-wash/70";
  overlay.style.opacity = "0";
  const ghost = doc.createElement("div");
  ghost.className =
    "pointer-events-none fixed left-0 top-0 z-[61] block h-7 max-w-[200px] truncate rounded-lg bg-canvas px-2.5 text-[13px] leading-[28px] text-ink shadow-float ring-1 ring-line-strong";
  ghost.textContent = label;
  let outside = false;
  ghost.style.opacity = "0";
  ghost.style.transition = "opacity 120ms ease-out";
  doc.body.append(overlay, ghost);
  // 小签挨着窗口右边、底边时往里收，不伸出窗口
  let ghostWidth = ghost.offsetWidth;
  const ghostHeight = ghost.offsetHeight;
  view.requestAnimationFrame(() => {
    ghost.style.opacity = "1";
  });
  let shown: DockZone | null = null;
  const FADE = "opacity 120ms ease-out";
  const SLIDE = ["left", "top", "width", "height"]
    .map((property) => `${property} 140ms ${SLIDE_EASE}`)
    .join(", ");

  return {
    move(x, y, zone) {
      // 松手会开成新窗口：小签上说一声
      if ((zone?.kind === "outside") !== outside) {
        outside = zone?.kind === "outside";
        ghost.textContent = outside ? `在新窗口中打开「${label}」` : label;
        ghostWidth = ghost.offsetWidth;
      }
      const left = Math.max(8, Math.min(x + 12, view.innerWidth - ghostWidth - 8));
      const top = Math.max(8, Math.min(y + 10, view.innerHeight - ghostHeight - 8));
      ghost.style.transform = `translate(${snap(left)}px, ${snap(top)}px)`;
      if (!zone || zone.kind === "outside") {
        overlay.style.transition = FADE;
        overlay.style.opacity = "0";
        shown = null;
        return;
      }
      if (shown?.paneId === zone.paneId && shown.kind === zone.kind) return;
      overlay.style.transition = shown ? `${FADE}, ${SLIDE}` : FADE;
      const inset = 6;
      overlay.style.left = `${snap(zone.rect.left + inset)}px`;
      overlay.style.top = `${snap(zone.rect.top + inset)}px`;
      overlay.style.width = `${snap(zone.rect.width - inset * 2)}px`;
      overlay.style.height = `${snap(zone.rect.height - inset * 2)}px`;
      overlay.style.opacity = "1";
      shown = zone;
    },
    close() {
      ghost.remove();
      overlay.style.transition = "opacity 100ms ease-out";
      overlay.style.opacity = "0";
      setTimeout(() => overlay.remove(), 120);
    },
  };
}

/* ---------------- 右键菜单 ---------------- */

interface TabMenuAt {
  tabId: string;
  x: number;
  y: number;
}

/**
 * 标签的右键菜单：关闭、关闭其他、关闭右侧、向右拆分、在新窗口中打开（弹出窗口里是「移回主窗口」）。
 * 样子和行菜单（RowMenu）一样，只淡入；开在指针那里，挨着窗口边就往里收
 */
function TabMenu({ at, onClose }: { at: TabMenuAt; onClose: () => void }) {
  const notePanes = useApp((s) => s.notePanes);
  const popouts = useApp((s) => s.popouts);
  const { doc, win: view, popout } = usePaneWindow();
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: at.x, top: at.y });

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    setPlace({
      left: Math.min(at.x, view.innerWidth - width - 8),
      top: Math.min(at.y, view.innerHeight - height - 8),
    });
  }, [at, view]);

  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    view.addEventListener("pointerdown", away, true);
    view.addEventListener("keydown", key, true);
    view.addEventListener("blur", onClose);
    view.addEventListener("resize", onClose);
    return () => {
      view.removeEventListener("pointerdown", away, true);
      view.removeEventListener("keydown", key, true);
      view.removeEventListener("blur", onClose);
      view.removeEventListener("resize", onClose);
    };
  }, [onClose, view]);

  const pane = (popout ? popouts : notePanes).find((other) =>
    other.tabs.some((tab) => tab.id === at.tabId),
  );
  if (!pane) return null;
  const index = pane.tabs.findIndex((tab) => tab.id === at.tabId);
  const app = useApp.getState();
  const items: { id: string; label: string; hint?: string; run: () => void }[] = [
    { id: "close", label: "关闭", hint: `${MOD_KEY}+W`, run: () => app.closeTab(at.tabId) },
    ...(pane.tabs.length > 1
      ? [{ id: "others", label: "关闭其他标签", run: () => app.closeOtherTabs(at.tabId) }]
      : []),
    ...(index < pane.tabs.length - 1
      ? [{ id: "right", label: "关闭右侧的标签", run: () => app.closeTabsToRight(at.tabId) }]
      : []),
    ...(!popout && notePanes.length < MAX_PANES
      ? [
          {
            id: "split",
            label: "向右拆分",
            hint: `${MOD_KEY}+\\`,
            run: () => app.splitTab(at.tabId, pane.id, "right", true),
          },
        ]
      : []),
    // 弹出窗口（§16）：主窗口里拆出去，弹出窗口里挪回来
    popout
      ? { id: "main", label: "移回主窗口", run: () => app.tabToMain(at.tabId) }
      : { id: "popout", label: "在新窗口中打开", run: () => void popOut(at.tabId) },
  ];

  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-state="open"
      className="odea-menu fixed z-50 min-w-[168px] overflow-hidden rounded-lg bg-canvas p-1 shadow-float outline-none ring-1 ring-line-strong"
      style={place}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            item.run();
          }}
          className="flex min-h-8 w-full cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-body outline-none transition-colors duration-[110ms] hover:bg-raised hover:text-ink focus-visible:bg-raised"
        >
          <span className="flex-1">{item.label}</span>
          {item.hint && <span className="text-[12px] text-faint">{item.hint}</span>}
        </button>
      ))}
    </div>,
    doc.body,
  );
}

/* ---------------- 快捷键 ---------------- */

/**
 * 只在笔记区、没有对话框开着的时候（docs/标签页与分屏.md §4.2、§13）。捕获阶段：编辑器的按键表在
 * 正文里先拿到 Ctrl+Shift+T 之类的，会当成别的命令。都作用在正在写的那个窗格上
 *
 * - Ctrl / ⌘ + W 关当前的；窗格里只剩它就关这个窗格（整个窗口只剩它时什么都不做，不关窗口）
 * - Ctrl / ⌘ + Shift + T 开回最近关掉的
 * - Ctrl + Tab / Ctrl + Shift + Tab 下一个 / 上一个
 * - Alt + 1…8（macOS ⌃ + 1…8）第几个，9 是最后一个。Ctrl + 数字在编辑器里是「设成几级标题」
 * - Ctrl / ⌘ + \ 向右拆分：同一篇在右边再开一栏
 * - Alt + ← / →（macOS ⌘ + [ / ]）、鼠标的后退 / 前进键：这个标签里往回 / 往前走。
 *   macOS 上 Option + ← 是编辑器里按词移动，不占
 */
export function useTabKeys(
  /** 弹出窗口（§16）：在那个窗口上听，作用在它的窗格上（只关、切、往回走；不拆分） */
  popout?: { win: Window; paneId: string },
): void {
  useEffect(() => {
    const target = popout?.win ?? window;
    const busy = () => {
      const app = useApp.getState();
      return (
        (!popout && app.workspace !== "notes") ||
        app.paletteOpen ||
        app.findOpen ||
        app.syncOpen ||
        app.trashOpen ||
        !!app.historyFor ||
        !!app.updateDialog
      );
    };
    const alive = (id: string) => useData.getState().notes.some((note) => note.id === id);
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || busy()) return;
      const app = useApp.getState();
      const pane = popout
        ? app.popouts.find((other) => other.id === popout.paneId)
        : (app.notePanes.find((other) => other.id === app.activePane) ?? app.notePanes[0]);
      if (!pane) return;
      const tabs = pane.tabs;
      const index = tabs.findIndex((tab) => tab.id === pane.activeTab);
      const mod = event.ctrlKey || event.metaKey;
      const plain = !event.altKey && !event.shiftKey;
      const digit = /^Digit[1-9]$/.test(event.code) ? Number(event.code.slice(5)) : 0;
      const digitKey = isMac
        ? event.ctrlKey && !event.metaKey && !event.altKey
        : event.altKey && !event.ctrlKey && !event.metaKey;
      const back = isMac
        ? event.metaKey && plain && event.code === "BracketLeft"
        : event.altKey && !mod && !event.shiftKey && event.key === "ArrowLeft";
      const forward = isMac
        ? event.metaKey && plain && event.code === "BracketRight"
        : event.altKey && !mod && !event.shiftKey && event.key === "ArrowRight";

      if (mod && plain && event.code === "KeyW") {
        // 弹出窗口里关掉最后一个就是关这个窗口（像浏览器）；主窗口里不关窗口
        if (popout || tabs.length > 1 || app.notePanes.length > 1) app.closeTab(pane.activeTab);
      } else if (mod && !event.altKey && event.shiftKey && event.code === "KeyT") {
        app.reopenTab(alive);
      } else if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Tab") {
        if (tabs.length < 2) return;
        const by = event.shiftKey ? -1 : 1;
        app.switchTab(tabs[(index + by + tabs.length) % tabs.length]!.id);
      } else if (digit && digitKey && !event.shiftKey) {
        const tab = digit === 9 ? tabs[tabs.length - 1] : tabs[digit - 1];
        if (tab) app.switchTab(tab.id);
      } else if (!popout && mod && plain && event.code === "Backslash") {
        app.splitTab(pane.activeTab, pane.id, "right", true);
      } else if (back || forward) {
        app.walkTab(back ? -1 : 1, alive, popout?.paneId);
      } else return;
      event.preventDefault();
      event.stopPropagation();
    };
    // 鼠标侧面的后退 / 前进键（3 / 4）。按下时也拦：WebView 自己会拿它做页面的后退
    const onMouse = (event: MouseEvent) => {
      if ((event.button !== 3 && event.button !== 4) || busy()) return;
      event.preventDefault();
      if (event.type === "mouseup") {
        useApp.getState().walkTab(event.button === 3 ? -1 : 1, alive, popout?.paneId);
      }
    };
    target.addEventListener("keydown", onKey, true);
    target.addEventListener("mousedown", onMouse, true);
    target.addEventListener("mouseup", onMouse, true);
    return () => {
      target.removeEventListener("keydown", onKey, true);
      target.removeEventListener("mousedown", onMouse, true);
      target.removeEventListener("mouseup", onMouse, true);
    };
  }, [popout]);
}
