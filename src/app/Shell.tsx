import { ZEN_TRANSITION } from "@/app/navMotion";
import { focusedPane } from "@/app/panes";
import { LIST_WIDTH, chromeWidth, hasListColumn, useApp } from "@/app/store";
import { isBaseTab } from "@/bases/ids";
import { CaptureSettingsDialog } from "@/components/CaptureSettingsDialog";
import { CollabDialog, CollabRequests, CollabResume } from "@/components/CollabDialog";
import { CommandPalette } from "@/components/CommandPalette";
import { DocumentPanes, activeNoteOf } from "@/components/DocumentPanes";
import { EdgeChrome } from "@/components/EdgeChrome";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ErrorToast, ImportToast, LayoutChangeToast, NoticeToast } from "@/components/ErrorToast";
import { ExportDialog } from "@/components/ExportDialog";
import { FindDialog } from "@/components/FindDialog";
import { HistoryDialog } from "@/components/HistoryDialog";
import { Intro } from "@/components/Intro";
import { useNotchWidth } from "@/components/NotchNav";
import { useTabKeys } from "@/components/NoteTabs";
import { PluginConsent } from "@/components/PluginConsent";
import { InActiveWindow, Popouts } from "@/components/Popouts";
import { RelayDialog } from "@/components/RelayDialog";
import { SyncDialog } from "@/components/SyncDialog";
import { TeamDialog } from "@/components/TeamDialog";
import { TeamRelayToast } from "@/components/TeamRelayToast";
import { TitleBar } from "@/components/TitleBar";
import { TrashDialog } from "@/components/TrashDialog";
import { UndoToast } from "@/components/UndoToast";
import { UpdateDialog } from "@/components/UpdateDialog";
import { useCurrentDocument } from "@/data/adapter";
import { enabledPlugins, saveKeyOf, useData } from "@/data/store";
import { noteRef, vaultRef } from "@/data/types";
import { pinEditorStates } from "@/editor/statePins";
import { cn } from "@/lib/cn";
import { initTeam } from "@/team/store";
import { ExtensionsView } from "@/views/ExtensionsView";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { type ReactNode, useEffect } from "react";

/**
 * 专注模式的进出。
 * 用有确定时长的 tween 而不是弹簧：这条动画和「编辑区一帧内拿到新宽度」是
 * 同时发生的，弹簧的尾巴会拖到 600ms 以上，位移早就看不出来了还在跑。
 * 曲线前段快、后段长，收尾时几乎察觉不到停下的那一下。
 */
const zenTransition = ZEN_TRANSITION;

/** 版面换了时旧的一屏盖在新的上面退掉（和 SwapFade 同一个节奏） */
const FRAME_DISSOLVE = { duration: 0.18, ease: [0.22, 1, 0.36, 1] } as const;

/**
 * 某一块渲染出错了（docs/技术方案.md §8.9）：弹错误提示条。那一块自己换成「出错了」（列表栏、正文），
 * 或者不画（浮在上面的那些）；别的块照常能用、能存
 */
const showRenderError = (message: string) => useData.setState({ error: message });

/** 浮在上面的（对话框、提示条、弹出窗口、插件的副作用）：出错了只弹提示条，不画东西 */
function Guard({ area, children }: { area: string; children: ReactNode }) {
  return (
    <ErrorBoundary area={area} fallback="none" onError={showRenderError}>
      {children}
    </ErrorBoundary>
  );
}

export function Shell() {
  const workspace = useApp((s) => s.workspace);
  const reduceMotion = useApp((s) => s.reduceMotion);
  const zen = useApp((s) => s.zen);
  const panelCollapsed = useApp((s) => s.panelCollapsed);
  // 开着的插件：它们的副作用跟着主窗口挂着（日程：零点翻页、按需取数据、日程切换器）
  const layout = useData((s) => s.layout);
  const plugins = enabledPlugins(layout);
  const notes = useData((s) => s.notes);
  const saveDocument = useData((s) => s.saveDocument);
  const saveTitle = useData((s) => s.saveTitle);

  const doc = useCurrentDocument();
  const paletteOpen = useApp((s) => s.paletteOpen);
  const findOpen = useApp((s) => s.findOpen);
  // 正在弹出窗口里写：命令面板里「这一篇」的命令对着那边的那一篇（视图文件不算一篇）
  const popoutNote = useApp((s) => {
    const popout = s.popouts.find((other) => other.id === s.activePopout);
    return popout ? activeNoteOf(focusedPane(popout)) : null;
  });
  const popoutTarget = popoutNote && !isBaseTab(popoutNote) ? noteRef(popoutNote) : undefined;
  // 命令面板里那些「这一篇」的命令只认仓库里的文档（做客的那一篇不算）
  const docTarget = vaultRef(doc.editor?.target);
  // 侧栏收起了（像 VS Code 的侧栏）：和今日TODO、目标一样只剩刘海和正文
  const showList = hasListColumn(workspace) && !panelCollapsed;
  // 专注模式要把整块 chrome（刘海 + 侧栏）推出去有多远
  const notch = useNotchWidth();
  const zenShift = zen ? -chromeWidth(showList, notch) : 0;
  // 主内容的版面（见下面主内容那段注释）：版面一样的两页之间不重挂，只换文档。
  // 笔记分屏不算换版面：拆出一栏、关掉一栏由 DocumentPanes 自己溶解，还在的窗格不重挂
  // （docs/标签页与分屏.md §15.6；以前在这里换一屏，每个编辑器都重建，卡几百毫秒）
  const frame =
    workspace === "extensions" ? "extensions" : hasListColumn(workspace) ? "listed" : "full";

  // 笔记的窗格和标签（docs/标签页与分屏.md）：标签栏在每个窗格里（DocumentPanes），这里管快捷键、对账、缓存
  const initialized = useData((s) => s.initialized);
  const indexing = useData((s) => s.indexing !== null);
  useTabKeys();
  // 别处删掉、归档了的笔记，指着它的标签关掉。列表取回来以前、后台还在读索引时列表不全，不动
  useEffect(() => {
    if (!initialized || indexing) return;
    useApp.getState().pruneTabs(new Set(notes.map((note) => note.id)));
  }, [initialized, indexing, notes]);
  // 开着的标签那几篇的编辑器状态不挤出缓存（弹出窗口里的也算）
  const openNotes = useApp((s) =>
    [...s.notePanes, ...s.popouts.flatMap((popout) => popout.panes)]
      .flatMap((pane) => pane.tabs.map((tab) => tab.noteId))
      .join("\n"),
  );
  useEffect(() => {
    pinEditorStates(openNotes.split("\n").map((id) => saveKeyOf(noteRef(id))));
  }, [openNotes]);

  // 团队仓库（docs/协同编辑.md §22.4）：起团队端点。每个窗格显示着哪一篇由窗格自己报（DocumentPanes 的 useTeamView）
  const team = useData((s) => s.team);
  useEffect(() => {
    if (team) void initTeam();
  }, [team]);

  // Esc 退出专注模式。走冒泡阶段并且看 defaultPrevented ——
  // 命令面板在捕获阶段处理 Esc 并且会 preventDefault，这样两者不会打架：
  // 面板开着时 Esc 先关面板，再按一次才退出专注模式。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (!useApp.getState().zen) return;
      e.preventDefault();
      useApp.getState().setZen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
      <div className="relative flex h-full w-full overflow-hidden bg-canvas">
        <Guard area="标题栏">
          <TitleBar />
        </Guard>

        {/* ---------- 左侧 chrome（刘海 + 侧栏，docs/边栏.md） ----------
            在流里只占侧栏那 300（侧栏收起、没有侧栏的页是 0）：开关侧栏时正文那一侧一帧之内拿到新宽度，
            只重排这一次；形状本身是绝对定位的几块刚体，伸缩只动 transform（EdgeChrome）。
            正文那一列跟着滑到新的居中位置（DocumentView 的 CenteredColumn）。

            z-[45]：比标题栏的拖拽带（z-40）高，刘海那一块点得到、不拖窗口；比对话框（z-50）低。

            专注模式的动画全在这一层做，而且刻意**不用**布局属性：
            切进专注模式的瞬间这一层变成 absolute，立刻脱离 flex 流 ——
            编辑区一帧之内就拿到整页宽度，只重排这一次；随后的位移纯粹是 transform，走合成器。
            如果改成动画化 width/marginLeft，行程里每一帧都要重排，开了 lineWrapping 的 CodeMirror
            会被迫逐帧重新折行。退出时反过来：先回到流内（编辑区一帧内缩回去），再滑回 0。

            正文的画布往它底下多铺了 300（DocumentView 里的负外边距）：退出时它滑回来的那 460ms 里，
            身后是连续的白色画布和正在往右滑的正文，不是外层容器露出的一块底色。 */}
        <motion.div
          className={cn("relative z-[45] h-full shrink-0", zen && "absolute inset-y-0 left-0")}
          style={{ width: showList ? LIST_WIDTH : 0 }}
          animate={{ x: zenShift }}
          transition={zenTransition}
        >
          <ErrorBoundary area="侧栏" fallback="compact" onError={showRenderError}>
            <EdgeChrome />
          </ErrorBoundary>
        </motion.div>

        {/* ---------- 主内容 ----------
            按「版面」换，不按区换：frame 是「这一区有列表栏 / 没有 / 扩展页」。列表栏收起了也算有：
            在笔记里收起 / 展开它不换一屏，正文那一列自己滑过去（DocumentView 的 CenteredColumn）。
            版面一样的两页（今日TODO ↔ /GOAL，笔记 ↔ 日历 ↔ 归档，插件的页也一样）是同一个 DocumentView，
            只是换了一篇文档 —— 和在列表里换一篇笔记一样走 SwapFade 的溶解：标题、分隔线、
            状态栏原地不动，只有字换掉。2026-10-28 以前按区换，今日TODO ↔ /GOAL 是整屏卸掉
            重挂：旧的一屏 140ms 淡出还往旁边挪 12px，新的一屏 220ms 淡入，分隔线从 0 再展开一次、
            状态栏再晚一拍淡进来 —— 用户说的「闪来闪去」。

            版面变了（列表栏出现 / 收起）才换一屏，也是溶解：新的一屏挂上就是不透明的，
            旧的一屏冻在原尺寸上（popLayout，见下）盖在它上面退掉。新的一屏从头到尾不动，
            编辑器能在第一帧直接挂上（它不能挂在正在动 transform 的祖先里，技术方案 §11.3②），
            也不会淡完再被提出图层重画一次。旧的那一屏得画在新的上面：新的一屏的根（DocumentView）
            是 relative 的、DOM 里又排在后面，不管的话它盖住旧的，就成了一下硬切。退场时 Motion 给
            那一屏挂上 data-motion-pop-id（在画之前），globals.css 的 .odea-frame 照着它抬高一层。

            mode="popLayout" 而不是 "wait"：退场的那一屏立刻脱离文档流并被冻结在原尺寸上，
            新一屏在最终布局里直接挂载。这一点和上面列表栏的进出配套：列表栏一出现主内容就收窄，
            如果旧正文还留在流里，它会在退场的同时被重新折行，看起来就是先跳一下再消失。

            anchorX="right"：popLayout 把退场那一屏钉在它的定位父级上，而这个
            父级（下面那个 flex-1 的 div）正是列表栏进出时左边缘会挪 300px 的
            那个盒子。默认钉左边，旧正文就会跟着父级往右跳 300px 再淡出；钉右边
            —— 父级的右边缘是窗口右边缘，从来不动 —— 它就原地不动。

            这一层不能 overflow-hidden：正文画布要往左 chrome 底下铺（见上），
            在这里裁掉就白铺了。 */}
        <div className="relative min-w-0 flex-1">
          <AnimatePresence mode="popLayout" anchorX="right" initial={false}>
            <motion.main
              key={frame}
              initial={false}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={FRAME_DISSOLVE}
              className="odea-frame h-full"
            >
              {/* 每个窗格里还有一个（DocumentPanes 的 Pane）：分屏时一栏出错另一栏照常 */}
              <ErrorBoundary
                area={workspace === "extensions" ? "扩展页" : "正文"}
                fallback="block"
                className="bg-canvas"
                resetKey={`${workspace}:${doc.key}`}
                onError={showRenderError}
              >
                {workspace === "extensions" ? (
                  <ExtensionsView />
                ) : (
                  // 一排窗格（笔记分屏时几栏，别的区一栏）；每栏的标签栏、删除都在里面
                  <DocumentPanes doc={doc} onSaveDocument={saveDocument} onSaveTitle={saveTitle} />
                )}
              </ErrorBoundary>
            </motion.main>
          </AnimatePresence>

          {/* 底部居中的提示条：错误在上、撤销在下。容器不接收指针，只有提示条本身接收。
              在正文区里居中（以前按整个窗口居中，跨在列表栏和正文的分界线上）。
              离底 72px：底下贴着正文的状态栏（32px 高），「保存失败」就显示在那一行，别压上去 */}
          <div className="pointer-events-none absolute inset-x-0 bottom-[72px] z-40 flex flex-col items-center gap-2 px-6">
            {/* 错误提示条自己出错了就只记在控制台：再弹提示条也是它 */}
            <ErrorBoundary area="错误提示条" fallback="none">
              <ErrorToast />
            </ErrorBoundary>
            <Guard area="提示条">
              <ImportToast />
              <NoticeToast />
              <LayoutChangeToast />
              <TeamRelayToast />
              <CollabRequests />
              <CollabResume />
              <UndoToast />
            </Guard>
          </div>
        </div>
        {/* 在按快捷键的那个窗口里开（弹出窗口里按就开在那边，docs/标签页与分屏.md §20.2） */}
        <InActiveWindow open={paletteOpen}>
          <Guard area="命令面板">
            <CommandPalette docTarget={popoutTarget ?? docTarget} />
          </Guard>
        </InActiveWindow>
        <InActiveWindow open={findOpen}>
          <Guard area="全局搜索">
            <FindDialog />
          </Guard>
        </InActiveWindow>
        <Guard area="同步对话框">
          <SyncDialog />
        </Guard>
        <Guard area="协作对话框">
          <CollabDialog />
        </Guard>
        {/* 在协作对话框之上：连不上时从协作对话框里「配中继…」打开 */}
        <Guard area="中继对话框">
          <RelayDialog />
        </Guard>
        <Guard area="团队对话框">
          <TeamDialog />
        </Guard>
        <Guard area="历史版本">
          <HistoryDialog />
        </Guard>
        <Guard area="回收站">
          <TrashDialog />
        </Guard>
        <Guard area="导出对话框">
          <ExportDialog />
        </Guard>
        <Guard area="速记设置">
          <CaptureSettingsDialog />
        </Guard>
        <Guard area="新版本卡片">
          <UpdateDialog />
        </Guard>
        {/* 带脚本的插件（L1）要的权限：扩展页装之前、授权时弹（plugins/scripted.ts 的 askConsent） */}
        <Guard area="插件授权">
          <PluginConsent />
        </Guard>
        {/* 弹出窗口（docs/标签页与分屏.md §16）：每个 portal 进它自己的窗口，这里不占地方 */}
        <Guard area="弹出窗口">
          <Popouts onSaveDocument={saveDocument} onSaveTitle={saveTitle} />
        </Guard>
        {/* 开着的插件跟着主窗口挂着的副作用（plugins/registry.ts 的 Effects） */}
        {plugins.map(
          (plugin) =>
            plugin.Effects && (
              <Guard key={plugin.id} area={`插件「${plugin.name}」`}>
                <plugin.Effects />
              </Guard>
            ),
        )}
        {/* 开场：冷启动时盖在最上面，写一个「O」再把它送回侧栏（components/Intro.tsx） */}
        <Guard area="开场动画">
          <Intro />
        </Guard>
      </div>
    </MotionConfig>
  );
}
