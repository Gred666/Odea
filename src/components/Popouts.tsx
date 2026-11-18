import type { PopoutLayout } from "@/app/panes";
import { type PopoutHandle, popoutHandle, popoutOfLabel, raiseWindow } from "@/app/popout";
import { type NotePane, useApp } from "@/app/store";
import { BaseHost } from "@/bases/BaseHost";
import { usePaneDocument } from "@/data/adapter";
import { NEW_NOTE_TITLE, useData } from "@/data/store";
import { NOTE, vaultRef } from "@/data/types";
import { type PaneWindow, PaneWindowContext } from "@/lib/paneWindow";
import { onPopoutCloseRequested, popoutControls, popoutOp, popoutTitle } from "@/lib/tauri";
import { useTeamView } from "@/team/store";
import { Fragment, type ReactNode, memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Handlers, Sash, activeNoteOf, collabElsewhere, usePaneWide } from "./DocumentPanes";
import { DocumentView } from "./DocumentView";
import { NoteTabs, useTabKeys } from "./NoteTabs";
import { SwapFade } from "./SwapFade";
import { TitleBar } from "./TitleBar";

/* ============================================================
   弹出窗口（docs/标签页与分屏.md §16、§20）：把一个标签拖出主窗口，它成了一个独立的窗口。

   窗口是 app/popout.ts 开的（window.open，和主窗口同一个 JS 环境）；这里把它的一排窗格 portal 进去：
   每个窗格最上面一条标签栏（窗口按钮在最右边那一栏）、一个 DocumentView，能像主窗口一样分屏。
   store、编辑器缓存、保存、协作都是主窗口那一份，同一篇在两个窗口里开着也是两个编辑器互相转发（§14）。

   - 在弹出窗口里按下、它拿到焦点：它成了正在写的（activePopout）。从它的正文里打开的一篇开在它里面，
     团队视图报的是它的那一篇。主窗口拿到焦点就换回主窗口
   - 关窗口（标题栏的 ×、Alt+F4、任务栏）：标签回到主窗口；关掉最后一个标签：窗口没了
   - 浮层（菜单、补全、悬停卡片）都挂在它自己的 body 上（usePaneWindow / docOf）
   ============================================================ */

/**
 * 命令面板、全局搜索开在按快捷键的那个窗口里（docs/标签页与分屏.md §20.2）：正在弹出窗口里写，就 portal 进它的 body，
 * 浮层、焦点、读屏都在那个窗口里。开的那一刻定下在哪个窗口，开着时点了主窗口也不跟着跳过去
 */
export function InActiveWindow({ open, children }: { open: boolean; children: ReactNode }) {
  const active = useApp((s) => s.activePopout);
  const [at, setAt] = useState(active);
  // 关着的时候跟着正在写的窗口走；开着不动。渲染里比一下（React 认这种写法，下一次渲染就是新的）
  if (!open && at !== active) setAt(active);
  const handle = at ? popoutHandle(at) : undefined;
  const context = useMemo<PaneWindow | null>(
    () => (handle && at ? { doc: handle.win.document, win: handle.win, popout: at } : null),
    [handle, at],
  );
  if (!handle || !context || handle.win.closed) return <>{children}</>;
  return createPortal(
    <PaneWindowContext.Provider value={context}>{children}</PaneWindowContext.Provider>,
    handle.win.document.body,
  );
}

export function Popouts(handlers: Handlers) {
  const popouts = useApp((s) => s.popouts);

  // 用户关弹出窗口（Alt+F4、任务栏）：Rust 拦下来交到这里，标签回到主窗口；认不出的照常关
  useEffect(() => {
    const stop = onPopoutCloseRequested((label) => {
      const id = popoutOfLabel(label);
      if (id) useApp.getState().removePopout(id, true);
      else void popoutOp(label, "close");
    });
    return () => void stop.then((off) => off());
  }, []);

  // 主窗口拿到焦点、在主窗口里按下：正在写的回到主窗口（列表栏在这边，点它之前先到这里）
  useEffect(() => {
    const main = () => {
      raiseWindow(null);
      useApp.getState().setActivePopout(null);
    };
    window.addEventListener("focus", main);
    window.addEventListener("pointerdown", main, true);
    return () => {
      window.removeEventListener("focus", main);
      window.removeEventListener("pointerdown", main, true);
    };
  }, []);

  return (
    <>
      {popouts.map((popout) => (
        <PopoutWindow key={popout.id} popout={popout} {...handlers} />
      ))}
    </>
  );
}

function PopoutWindow({ popout, ...handlers }: { popout: PopoutLayout } & Handlers) {
  const id = popout.id;
  const handle = popoutHandle(id);
  const context = useMemo<PaneWindow | null>(
    () => (handle ? { doc: handle.win.document, win: handle.win, popout: id } : null),
    [handle, id],
  );

  // 窗口没开出来（不该发生）：不留一个画不出来的窗格，标签回到主窗口
  useEffect(() => {
    if (!handle) useApp.getState().removePopout(id, true);
  }, [handle, id]);

  // 在这个窗口里按下、它拿到焦点：正在写的是它
  useEffect(() => {
    if (!handle) return;
    const win = handle.win;
    const mine = () => {
      raiseWindow(id);
      useApp.getState().setActivePopout(id);
    };
    win.addEventListener("focus", mine);
    win.addEventListener("pointerdown", mine, true);
    if (win.document.hasFocus()) mine();
    return () => {
      win.removeEventListener("focus", mine);
      win.removeEventListener("pointerdown", mine, true);
    };
  }, [handle, id]);

  const keys = useMemo(() => (handle ? { win: handle.win, popout: id } : undefined), [handle, id]);
  useTabKeys(keys);

  // 整页重载：弹出窗口的页面是一张 about:blank，里面的东西是主窗口画的，一重载就成了一张白纸。
  // F5、Ctrl+R 在 Rust 那边拦下了（popout.rs 的 without_reload_keys；页面里 preventDefault 拦不住）。
  // 万一还是重载了（别的途径、别的平台），页面走之前把标签交回主窗口、关掉这个窗口（docs/标签页与分屏.md §20.1）
  useEffect(() => {
    if (!handle) return;
    const win = handle.win;
    const onHide = () => {
      // 自己关的（关窗口、移回主窗口、主窗口要刷新）先从 handles 里去掉了；还在就是页面自己要走了
      if (popoutHandle(id) !== handle) return;
      useApp.getState().removePopout(id, true);
    };
    win.addEventListener("pagehide", onHide);
    return () => win.removeEventListener("pagehide", onHide);
  }, [handle, id]);

  // 窗口有了大小再往里画。window.open 刚返回时子窗口的视口是 0×0，十几毫秒以后才是要的大小
  // （2026-10-29 实测）：编辑器要是在 0 宽的时候量了第一次，按一行十个字估出整篇两万像素高，
  // 滚动位置落到正文外面，它看自己不在窗口里就再也不量了
  const [sized, setSized] = useState(() => !!handle && handle.win.innerWidth > 0);
  useEffect(() => {
    if (!handle || sized) return;
    let timer = 0;
    const check = () => {
      if (handle.win.innerWidth > 0) setSized(true);
      else timer = window.setTimeout(check, 8);
    };
    check();
    return () => window.clearTimeout(timer);
  }, [handle, sized]);

  // 画好第一帧再显示（窗口建出来是藏着的，和仓库窗口一样不闪一个空窗口）。
  // 藏着的子窗口照样排版、跑 rAF（2026-10-29 实测），等的是主窗口的两帧
  useEffect(() => {
    if (!handle || !sized) return;
    let cancelled = false;
    requestAnimationFrame(() =>
      requestAnimationFrame(async () => {
        for (let i = 0; i < 50 && !handle.label() && !cancelled; i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const label = handle.label();
        if (label && !cancelled) void popoutOp(label, "show");
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [handle, sized]);

  if (!handle || !context || !sized) return null;
  const root = handle.win.document.getElementById("root");
  if (!root) return null;
  return createPortal(
    <PaneWindowContext.Provider value={context}>
      <PopoutBody popout={popout} handle={handle} {...handlers} />
    </PaneWindowContext.Provider>,
    root,
  );
}

/**
 * 一个弹出窗口里：标题栏（窗口按钮）、一排窗格（分屏和主窗口一样：分割条、最多三栏，§20.2）。
 * 窗格多了、少了整排溶解（SwapFade），还在的窗格不重挂
 */
const PopoutBody = memo(function PopoutBody({
  popout,
  handle,
  ...handlers
}: { popout: PopoutLayout; handle: PopoutHandle } & Handlers) {
  const active = useApp((s) => s.activePopout === popout.id);
  const rowRef = useRef<HTMLDivElement>(null);
  const focused = popout.panes.find((pane) => pane.id === popout.activePane) ?? popout.panes[0]!;
  const count = popout.panes.length;
  const paneIds = popout.panes.map((pane) => pane.id).join("|");

  // 同一篇开在这个窗口的两个窗格、又在协作中：只在一个里编辑（正在写的那个，不是的话最左边那个）；
  // 主窗口里也开着（当前标签）就都不在这里编辑（§16.4）
  const owner = new Map<string, string>();
  for (const pane of [focused, ...popout.panes]) {
    const noteId = activeNoteOf(pane);
    if (noteId && !owner.has(noteId)) owner.set(noteId, pane.id);
  }

  const controls = useMemo(
    () => popoutControls(handle.label, () => useApp.getState().removePopout(popout.id, true)),
    [handle, popout.id],
  );

  return (
    <div className="relative flex h-full w-full overflow-hidden bg-canvas">
      <TitleBar controls={controls} />
      <div className="relative h-full min-w-0 flex-1" data-swap-host>
        <SwapFade swapKey={paneIds} className="h-full w-full">
          <div ref={rowRef} className="flex h-full w-full">
            {popout.panes.map((pane, index) => (
              <Fragment key={pane.id}>
                {index > 0 && <Sash rowRef={rowRef} index={index} popout={popout.id} />}
                <PopoutPane
                  pane={pane}
                  handle={handle}
                  index={index}
                  count={count}
                  focused={pane === focused}
                  active={active}
                  mirror={owner.get(activeNoteOf(pane)) !== pane.id}
                  {...handlers}
                />
              </Fragment>
            ))}
          </div>
        </SwapFade>
      </div>
    </div>
  );
});

/** 弹出窗口里的一个窗格：一条标签栏、一个 DocumentView。正在写的那个窗格管窗口标题和团队视图 */
function PopoutPane({
  pane,
  handle,
  index,
  count,
  focused,
  active,
  mirror,
  onSaveDocument,
  onSaveTitle,
}: {
  pane: NotePane;
  handle: PopoutHandle;
  index: number;
  count: number;
  focused: boolean;
  /** 正在写的是这个窗口 */
  active: boolean;
  /** 同一篇这个窗口的另一个窗格里也开着、而且那边是编辑的那个 */
  mirror: boolean;
} & Handlers) {
  const noteId = activeNoteOf(pane);
  const own = usePaneDocument(noteId, true);
  // 协作中的这一篇主窗口里也开着（当前标签）：在主窗口里编辑，协作的绑定一个编辑器一份（§14）
  const inMain = useApp((s) => s.notePanes.some((other) => activeNoteOf(other) === noteId));
  const doc = own.collab && (inMain || mirror) ? collabElsewhere(own, inMain) : own;
  const hostRef = useRef<HTMLDivElement>(null);
  const wide = usePaneWide(hostRef, true);
  const initialized = useData((s) => s.initialized);

  // 窗口标题跟着正在写的那个窗格里的那一篇（任务栏、Alt+Tab 里看到的）
  const title = doc.title.trim() || NEW_NOTE_TITLE;
  useEffect(() => {
    if (!focused) return;
    handle.win.document.title = title;
    let cancelled = false;
    const set = async () => {
      for (let i = 0; i < 50 && !handle.label() && !cancelled; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const label = handle.label();
      if (label && !cancelled) void popoutTitle(label, title);
    };
    void set();
    return () => {
      cancelled = true;
    };
  }, [handle, title, focused]);

  // 团队视图（「我在看哪几篇」）：每个窗格都报自己显示着的那一篇（docs/协同编辑.md §29.3）
  useTeamView(pane.id, doc);

  const handleDelete = () => {
    // 删的是这个窗格里的这一篇：先关掉它的标签（窗口里最后一个的话窗口也关了），再删
    const target = vaultRef(doc.editor?.target);
    if (target?.type !== NOTE) return;
    useApp.getState().closeTab(pane.activeTab);
    void useData.getState().deleteNote(target.key);
  };

  const focus = () => {
    if (!focused) useApp.getState().focusPane(pane.id);
  };
  const last = index === count - 1;
  return (
    <div
      ref={hostRef}
      data-pane={pane.id}
      className="relative h-full min-w-0"
      style={{ flex: `${count > 1 ? pane.size : 1} 1 0px` }}
      onPointerDownCapture={focus}
      onFocusCapture={focus}
    >
      <NoteTabs pane={pane} shown={initialized} focused={focused || count === 1} last={last} />
      {doc.base ? (
        <BaseHost relPath={doc.base.relPath} />
      ) : (
        <DocumentView
          doc={doc}
          onDelete={handleDelete}
          onSaveDocument={onSaveDocument}
          onSaveTitle={onSaveTitle}
          tabBar={initialized}
          focused={active && focused}
          first={false}
          last={last}
          outline={wide}
        />
      )}
    </div>
  );
}
