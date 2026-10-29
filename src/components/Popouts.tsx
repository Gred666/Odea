import { type PopoutHandle, paneOfLabel, popoutHandle } from "@/app/popout";
import { type NotePane, useApp } from "@/app/store";
import { usePaneDocument } from "@/data/adapter";
import { NEW_NOTE_TITLE, useData } from "@/data/store";
import { type PaneWindow, PaneWindowContext } from "@/lib/paneWindow";
import { onPopoutCloseRequested, popoutControls, popoutOp, popoutTitle } from "@/lib/tauri";
import { setTeamView, teamDocId } from "@/team/store";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Handlers, activeNoteOf, collabElsewhere, usePaneWide } from "./DocumentPanes";
import { DocumentView } from "./DocumentView";
import { NoteTabs, useTabKeys } from "./NoteTabs";
import { TitleBar } from "./TitleBar";

/* ============================================================
   弹出窗口（docs/标签页与分屏.md §16）：把一个标签拖出主窗口，它成了一个独立的窗口。

   窗口是 app/popout.ts 开的（window.open，和主窗口同一个 JS 环境）；这里把那个窗格 portal 进去：
   最上面一条标签栏（窗口按钮在右边）、一个 DocumentView。store、编辑器缓存、保存、协作都是主窗口那一份，
   同一篇在两个窗口里开着也是两个编辑器互相转发（§14），和分屏一样。

   - 在弹出窗口里按下、它拿到焦点：它成了正在写的（activePopout）。从它的正文里打开的一篇开在它里面，
     团队视图报的是它的那一篇。主窗口拿到焦点就换回主窗口
   - 关窗口（标题栏的 ×、Alt+F4、任务栏）：标签回到主窗口；关掉最后一个标签：窗口没了
   - 浮层（菜单、补全、悬停卡片）都挂在它自己的 body 上（usePaneWindow / docOf）
   ============================================================ */

export function Popouts(handlers: Handlers) {
  const popouts = useApp((s) => s.popouts);

  // 用户关弹出窗口（Alt+F4、任务栏）：Rust 拦下来交到这里，标签回到主窗口；认不出的照常关
  useEffect(() => {
    const stop = onPopoutCloseRequested((label) => {
      const paneId = paneOfLabel(label);
      if (paneId) useApp.getState().removePopout(paneId, true);
      else void popoutOp(label, "close");
    });
    return () => void stop.then((off) => off());
  }, []);

  // 主窗口拿到焦点、在主窗口里按下：正在写的回到主窗口（列表栏在这边，点它之前先到这里）
  useEffect(() => {
    const main = () => useApp.getState().setActivePopout(null);
    window.addEventListener("focus", main);
    window.addEventListener("pointerdown", main, true);
    return () => {
      window.removeEventListener("focus", main);
      window.removeEventListener("pointerdown", main, true);
    };
  }, []);

  return (
    <>
      {popouts.map((pane) => (
        <PopoutWindow key={pane.id} pane={pane} {...handlers} />
      ))}
    </>
  );
}

function PopoutWindow({ pane, ...handlers }: { pane: NotePane } & Handlers) {
  const handle = popoutHandle(pane.id);
  const context = useMemo<PaneWindow | null>(
    () => (handle ? { doc: handle.win.document, win: handle.win, popout: pane.id } : null),
    [handle, pane.id],
  );

  // 窗口没开出来（不该发生）：不留一个画不出来的窗格，标签回到主窗口
  useEffect(() => {
    if (!handle) useApp.getState().removePopout(pane.id, true);
  }, [handle, pane.id]);

  // 在这个窗口里按下、它拿到焦点：正在写的是它
  useEffect(() => {
    if (!handle) return;
    const win = handle.win;
    const mine = () => useApp.getState().setActivePopout(pane.id);
    win.addEventListener("focus", mine);
    win.addEventListener("pointerdown", mine, true);
    if (win.document.hasFocus()) mine();
    return () => {
      win.removeEventListener("focus", mine);
      win.removeEventListener("pointerdown", mine, true);
    };
  }, [handle, pane.id]);

  const keys = useMemo(
    () => (handle ? { win: handle.win, paneId: pane.id } : undefined),
    [handle, pane.id],
  );
  useTabKeys(keys);

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
      <PopoutBody pane={pane} handle={handle} {...handlers} />
    </PaneWindowContext.Provider>,
    root,
  );
}

const PopoutBody = memo(function PopoutBody({
  pane,
  handle,
  onToggleTask,
  onSaveDocument,
  onSaveTitle,
}: { pane: NotePane; handle: PopoutHandle } & Handlers) {
  const active = useApp((s) => s.activePopout === pane.id);
  const noteId = activeNoteOf(pane);
  const own = usePaneDocument(noteId, true);
  // 协作中的这一篇主窗口里也开着（当前标签）：在主窗口里编辑，协作的绑定一个编辑器一份（§14）
  const inMain = useApp((s) => s.notePanes.some((other) => activeNoteOf(other) === noteId));
  const doc = inMain && own.collab ? collabElsewhere(own, true) : own;
  const hostRef = useRef<HTMLDivElement>(null);
  const wide = usePaneWide(hostRef, true);
  const initialized = useData((s) => s.initialized);

  // 窗口标题跟着当前那一篇（任务栏、Alt+Tab 里看到的）
  const title = doc.title.trim() || NEW_NOTE_TITLE;
  useEffect(() => {
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
  }, [handle, title]);

  // 团队视图（「我在看哪一篇」）：正在这个窗口里写的时候报它的
  const teamDoc = teamDocId(doc);
  const target = doc.editor?.target;
  const teamTarget = useRef(target);
  teamTarget.current = target;
  useEffect(() => {
    if (!active) return;
    const view = teamTarget.current;
    setTeamView(teamDoc && view && view.kind !== "shared" ? { doc: teamDoc, target: view } : null);
  }, [active, teamDoc]);

  const controls = useMemo(
    () => popoutControls(handle.label, () => useApp.getState().removePopout(pane.id, true)),
    [handle, pane.id],
  );

  const handleDelete = () => {
    // 删的是这个窗口里的这一篇：先关掉它的标签（最后一个的话窗口也关了），再删
    const target = doc.editor?.target;
    if (target?.kind !== "note") return;
    useApp.getState().closeTab(pane.activeTab);
    void useData.getState().deleteNote(target.id);
  };

  return (
    <div className="relative flex h-full w-full overflow-hidden bg-canvas">
      <TitleBar controls={controls} />
      <div ref={hostRef} data-pane={pane.id} className="relative h-full min-w-0 flex-1">
        <NoteTabs pane={pane} shown={initialized} focused last />
        <DocumentView
          doc={doc}
          onToggleTask={onToggleTask}
          onDelete={handleDelete}
          onSaveDocument={onSaveDocument}
          onSaveTitle={onSaveTitle}
          tabBar={initialized}
          focused={active}
          first={false}
          last
          outline={wide}
        />
      </div>
    </div>
  );
});
