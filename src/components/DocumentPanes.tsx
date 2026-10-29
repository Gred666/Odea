import { selectNeighbor } from "@/app/navigate";
import type { NotePane } from "@/app/panes";
import { useApp } from "@/app/store";
import { usePaneDocument } from "@/data/adapter";
import { useData } from "@/data/store";
import type { DocumentModel, DocumentSaveTarget } from "@/data/types";
import { useInstantLayoutTransition } from "motion/react";
import {
  Fragment,
  type PointerEvent as ReactPointerEvent,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DocumentView } from "./DocumentView";
import { NoteTabs } from "./NoteTabs";
import { SwapFade } from "./SwapFade";

/* ============================================================
   正文区：一排左右并排的窗格（docs/标签页与分屏.md §12）。

   笔记区按 store 里的窗格画，每个窗格一条标签栏、一个 DocumentView；别的区（日历、归档、日程）
   只有一栏，画的是 Shell 给的那一篇。正在写的那个窗格的 key 两边一样：笔记 ↔ 日历换的只是
   里面那一篇（SwapFade 溶解），不重挂。

   窗格多了、少了（拆出一栏、关掉一栏）：还在的窗格不重挂，只有新的那一栏挂上来；整排拍一张快照
   盖在上面退（SwapFade，和换篇同一个溶解），底下还在的那一栏变宽变窄、重新折行都在快照底下。
   2026-10-29 以前是 Shell 换一屏：每个窗格的编辑器都重建（长文要重新解析）、整页重算样式和排版，
   4 倍降速下按键以后卡 380–410ms 才开始淡 —— 用户说的「分屏开、关都是卡的」（§15.6）。

   正在写的那个窗格显示 Shell 给的那一篇（useCurrentDocument：做客时它换成共享的那一篇，
   命令面板、团队视图也看它）；别的窗格各自按自己的当前标签取（usePaneDocument）。
   ============================================================ */

/** 一栏最窄多少（拖分割条拖不过去）：再窄正文一行放不下几个字 */
const MIN_PANE = 320;
/** 分屏时窗格这么宽以上才出目录树（正文最宽 860 + 目录 180）；只有一栏时照旧按窗口宽度 */
const OUTLINE_PANE = 1060;

export interface Handlers {
  onToggleTask: (id: string) => void;
  onSegmentChange?: (v: string) => void;
  onSaveDocument: (target: DocumentSaveTarget, markdown: string) => Promise<void>;
  onSaveTitle: (target: DocumentSaveTarget, title: string) => Promise<void>;
}

export const activeNoteOf = (pane: Pick<NotePane, "tabs" | "activeTab">) =>
  pane.tabs.find((tab) => tab.id === pane.activeTab)?.noteId ?? "";

export function DocumentPanes({ doc, ...handlers }: { doc: DocumentModel } & Handlers) {
  const workspace = useApp((s) => s.workspace);
  const notePanes = useApp((s) => s.notePanes);
  const activePane = useApp((s) => s.activePane);
  const notes = workspace === "notes";
  // 做客：正文区是共享的那一篇，只有一栏（标签栏也收起，设计 §3）
  const guest = doc.editor?.target.kind === "shared";
  const focused = notePanes.find((pane) => pane.id === activePane) ?? notePanes[0]!;
  const panes = notes && !guest ? notePanes : [focused];
  const rowRef = useRef<HTMLDivElement>(null);

  // 窗格多了、少了的这一次不做 Motion 的布局动画（标签底色、目录指示条滑过去）：反正盖在溶解的快照底下。
  // 不拦的话，带 layoutId 的元素一卸掉（变窄的那一栏收起目录、关掉的那一栏的标签）Motion 就要量一遍
  // 位置，这时 React 改 DOM 改到一半，整页的排版被逼着算一遍，帧末再算一遍（§15.6）。
  // 要在提交之前拦，只能放在渲染里；拦一次只管下一次提交
  const instant = useInstantLayoutTransition();
  const paneIds = panes.map((pane) => pane.id).join("|");
  const lastPaneIds = useRef(paneIds);
  if (lastPaneIds.current !== paneIds) {
    lastPaneIds.current = paneIds;
    instant();
  }

  // 同一篇开在两个窗格、又在协作中：只在一个窗格里编辑（正在写的那个，不是的话最左边那个），
  // 协作的绑定一个编辑器一份，两份绑同一个会话会互相吞掉对方的改动
  const owner = new Map<string, string>();
  for (const pane of [focused, ...panes]) {
    const noteId = activeNoteOf(pane);
    if (noteId && !owner.has(noteId)) owner.set(noteId, pane.id);
  }

  return (
    // 拆出、关掉一栏时的快照放在这一层（SwapFade 往上找 data-swap-host）
    <div className="relative h-full w-full" data-swap-host>
      <SwapFade swapKey={paneIds} className="h-full w-full">
        <div ref={rowRef} className="flex h-full w-full">
          {panes.map((pane, index) => (
            <Fragment key={pane.id}>
              {index > 0 && <Sash rowRef={rowRef} index={index} />}
              <Pane
                pane={pane}
                index={index}
                count={panes.length}
                notes={notes}
                focused={pane === focused}
                mirror={owner.get(activeNoteOf(pane)) !== pane.id}
                shellDoc={doc}
                {...handlers}
              />
            </Fragment>
          ))}
        </div>
      </SwapFade>
    </div>
  );
}

interface PaneProps extends Handlers {
  index: number;
  count: number;
  /** 笔记区（别的区只有一栏、没有标签） */
  notes: boolean;
  focused: boolean;
  /** 这一篇别的窗格里也开着、而且那边是编辑的那个（协作中的不在这里编辑） */
  mirror: boolean;
  shellDoc: DocumentModel;
}

/**
 * 一个窗格的外壳：只管占多宽、按下就成了正在写的。里面（PaneBody）是 memo 的、不收宽度：
 * 拖完分割条只有这一层重渲染。以前整个窗格跟着重画，松手那一下两个 DocumentView（连目录树、
 * 编辑器外壳）全过一遍，4 倍降速下 576ms
 */
function Pane({ pane, ...props }: PaneProps & { pane: NotePane }) {
  const ref = useRef<HTMLDivElement>(null);
  const focus = () => {
    if (props.notes && !props.focused) useApp.getState().focusPane(pane.id);
  };
  return (
    <div
      ref={ref}
      data-pane={pane.id}
      className="relative h-full min-w-0"
      style={{ flex: `${pane.size} 1 0px` }}
      onPointerDownCapture={focus}
      onFocusCapture={focus}
    >
      <PaneBody
        paneId={pane.id}
        tabs={pane.tabs}
        activeTab={pane.activeTab}
        hostRef={ref}
        {...props}
      />
    </div>
  );
}

const PaneBody = memo(function PaneBody({
  paneId,
  tabs,
  activeTab,
  hostRef,
  index,
  count,
  notes,
  focused,
  mirror,
  shellDoc,
  onToggleTask,
  onSegmentChange,
  onSaveDocument,
  onSaveTitle,
}: PaneProps & {
  paneId: string;
  tabs: NotePane["tabs"];
  activeTab: string;
  hostRef: React.RefObject<HTMLDivElement | null>;
}) {
  const pane = useMemo(() => ({ id: paneId, tabs, activeTab }), [paneId, tabs, activeTab]);
  const zen = useApp((s) => s.zen);
  // 正在弹出窗口里写：从正文里打开一篇要滚到的小节归那边接（docs/标签页与分屏.md §16）
  const popoutActive = useApp((s) => s.activePopout !== null);
  const initialized = useData((s) => s.initialized);
  const own = usePaneDocument(activeNoteOf(pane), notes && !focused);
  const shown = !notes || focused ? shellDoc : own;
  const doc = mirror && shown.collab ? collabElsewhere(shown) : shown;
  const tabsShown =
    notes &&
    !zen &&
    initialized &&
    doc.editor?.target.kind !== "shared" &&
    (count > 1 || tabs.length > 1);
  const wide = usePaneWide(hostRef, count > 1);

  const handleDelete = () => {
    // 删的是这个窗格里的这一篇。按下的那一刻这个窗格已经成了正在写的（外壳的 focus）
    const target = doc.editor?.target;
    if (target?.kind !== "note") return;
    selectNeighbor(target.id);
    void useData.getState().deleteNote(target.id);
  };

  return (
    <>
      <NoteTabs
        pane={pane}
        shown={tabsShown}
        focused={focused || count === 1}
        last={index === count - 1}
      />
      <DocumentView
        doc={doc}
        onToggleTask={onToggleTask}
        onSegmentChange={onSegmentChange}
        onDelete={handleDelete}
        onSaveDocument={onSaveDocument}
        onSaveTitle={onSaveTitle}
        titleStrip={!tabsShown}
        focused={focused && !popoutActive}
        first={index === 0}
        last={index === count - 1}
        outline={count === 1 || wide}
      />
    </>
  );
});

/** 协作中的这一篇在另一个窗格（或主窗口）里编辑着：这里不挂编辑器，说一声 */
export function collabElsewhere(doc: DocumentModel, inMain = false): DocumentModel {
  return {
    key: `elsewhere-${doc.key}`,
    title: doc.title,
    bodyMd: "",
    statusParts: [],
    empty: {
      art: "notes",
      title: "这篇正在协作",
      hint: inMain
        ? "协作中的笔记只在一个地方编辑，主窗口里也开着它，在那边接着写。"
        : "协作中的笔记只在一个窗格里编辑，在旁边开着它的那个窗格里接着写。",
    },
  };
}

/** 分屏时这个窗格够不够宽放目录树（跟着拖分割条、窗口大小变）；弹出窗口里也按它 */
export function usePaneWide(ref: React.RefObject<HTMLDivElement | null>, split: boolean): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const host = ref.current;
    if (!host || !split || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWide(entry.contentRect.width >= OUTLINE_PANE);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [ref, split]);
  return split && wide;
}

/* ---------------- 分割条 ---------------- */

/**
 * 两个窗格之间：一条 1px 的线（和别处的分隔线同色），能按的地方左右各 4px、从拖动区下面开始
 * （最上面那 38px 还是拖窗口的）。悬停一会儿（300ms，划过去不闪）变成主色。
 *
 * 拖的时候不经过 React：直接改左右两个窗格的 flex-grow（按像素当比例），每帧最多一次；松手才写进
 * store。双击：几栏一样宽
 */
function Sash({
  rowRef,
  index,
}: { rowRef: React.RefObject<HTMLDivElement | null>; index: number }) {
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const row = rowRef.current;
    if (!row) return;
    event.preventDefault();
    const hosts = [...row.querySelectorAll<HTMLElement>(":scope > [data-pane]")];
    const widths = hosts.map((host) => host.getBoundingClientRect().width);
    const total = widths.reduce((sum, width) => sum + width, 0);
    const left = index - 1;
    const right = index;
    const pair = widths[left]! + widths[right]!;
    const min = Math.min(MIN_PANE, pair / 2);
    const grow = [...widths];
    hosts.forEach((host, i) => {
      host.style.flexGrow = String(grow[i]);
    });
    const startX = event.clientX;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    document.documentElement.dataset.resizing = "";
    setDragging(true);
    let frame = 0;

    const apply = () => {
      frame = 0;
      hosts[left]!.style.flexGrow = String(grow[left]);
      hosts[right]!.style.flexGrow = String(grow[right]);
    };
    const move = (moveEvent: PointerEvent) => {
      const next = Math.max(min, Math.min(pair - min, widths[left]! + moveEvent.clientX - startX));
      grow[left] = next;
      grow[right] = pair - next;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      if (frame) cancelAnimationFrame(frame);
      delete document.documentElement.dataset.resizing;
      setDragging(false);
      const sizes = grow.map((width) => width / total);
      // 和 store 改完以后 React 画出来的一样，不留像素比例在上面（React 只改变了的那几个）
      hosts.forEach((host, i) => {
        host.style.flexGrow = "";
        host.style.flex = `${sizes[i]} 1 0px`;
      });
      useApp.getState().resizePanes(sizes);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  // 键盘：焦点在分割条上按左右键，一次挪 24px
  const nudge = (delta: number) => {
    const row = rowRef.current;
    if (!row) return;
    const widths = [...row.querySelectorAll<HTMLElement>(":scope > [data-pane]")].map(
      (host) => host.getBoundingClientRect().width,
    );
    const total = widths.reduce((sum, width) => sum + width, 0);
    const pair = widths[index - 1]! + widths[index]!;
    const min = Math.min(MIN_PANE, pair / 2);
    const next = Math.max(min, Math.min(pair - min, widths[index - 1]! + delta));
    widths[index - 1] = next;
    widths[index] = pair - next;
    useApp.getState().resizePanes(widths.map((width) => width / total));
  };

  const equalize = () => {
    const count = useApp.getState().notePanes.length;
    useApp.getState().resizePanes(Array.from({ length: count }, () => 1 / count));
  };

  return (
    <div data-dragging={dragging || undefined} className="group/sash relative z-[31] w-0 shrink-0">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 -left-px w-px bg-line-strong"
      />
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整两栏的宽度，双击一样宽"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onDoubleClick={equalize}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          nudge(event.key === "ArrowLeft" ? -24 : 24);
        }}
        className="absolute bottom-0 top-[38px] -left-1 w-2 cursor-col-resize"
      >
        <span
          className="absolute inset-y-0 left-[3px] w-0.5 bg-transparent transition-colors duration-[120ms]
                     group-hover/sash:bg-accent/70 group-hover/sash:delay-300
                     group-data-[dragging]/sash:bg-accent"
        />
      </div>
    </div>
  );
}
