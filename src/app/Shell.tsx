import { ZEN_TRANSITION } from "@/app/navMotion";
import { selectNeighbor } from "@/app/navigate";
import { LIST_WIDTH, chromeWidth, hasListColumn, startTodayTicker, useApp } from "@/app/store";
import { CollabDialog, CollabRequests, CollabResume } from "@/components/CollabDialog";
import { CommandPalette } from "@/components/CommandPalette";
import { DocumentView } from "@/components/DocumentView";
import { ErrorToast, LayoutChangeToast, NoticeToast } from "@/components/ErrorToast";
import { FindDialog } from "@/components/FindDialog";
import { HistoryDialog } from "@/components/HistoryDialog";
import { Intro } from "@/components/Intro";
import { journalSwitchNext } from "@/components/JournalSwitcher";
import { RelayDialog } from "@/components/RelayDialog";
import { Sidebar } from "@/components/Sidebar";
import { SyncDialog } from "@/components/SyncDialog";
import { TeamDialog } from "@/components/TeamDialog";
import { TeamRelayToast } from "@/components/TeamRelayToast";
import { TitleBar } from "@/components/TitleBar";
import { TrashDialog } from "@/components/TrashDialog";
import { UndoToast } from "@/components/UndoToast";
import { UpdateDialog } from "@/components/UpdateDialog";
import { VaultSwitcher } from "@/components/VaultSwitcher";
import { labelToHorizon, labelToScope, useCurrentDocument } from "@/data/adapter";
import { backend } from "@/data/backend";
import { useData } from "@/data/store";
import { cn } from "@/lib/cn";
import { periodStartOf } from "@/lib/date";
import { tween } from "@/lib/motion";
import { initTeam, setTeamView, teamDocId } from "@/team/store";
import { ArchiveList } from "@/views/ArchiveView";
import { CalendarPanel } from "@/views/CalendarView";
import { ExtensionsView } from "@/views/ExtensionsView";
import { NotesList } from "@/views/NotesView";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useRef } from "react";

/**
 * 专注模式的进出。
 * 用有确定时长的 tween 而不是弹簧：这条动画和「编辑区一帧内拿到新宽度」是
 * 同时发生的，弹簧的尾巴会拖到 600ms 以上，位移早就看不出来了还在跑。
 * 曲线前段快、后段长，收尾时几乎察觉不到停下的那一下。
 */
const zenTransition = ZEN_TRANSITION;

/** 版面换了时旧的一屏盖在新的上面退掉（和 SwapFade 同一个节奏） */
const FRAME_DISSOLVE = { duration: 0.18, ease: [0.22, 1, 0.36, 1] } as const;

export function Shell() {
  const workspace = useApp((s) => s.workspace);
  const setCalendarScope = useApp((s) => s.setCalendarScope);
  const setGoalHorizon = useApp((s) => s.setGoalHorizon);
  const reduceMotion = useApp((s) => s.reduceMotion);
  const zen = useApp((s) => s.zen);
  const selectedDate = useApp((s) => s.selectedDate);
  const todayDate = useApp((s) => s.todayDate);
  const calendarScope = useApp((s) => s.calendarScope);
  const goalHorizon = useApp((s) => s.goalHorizon);
  const panelCollapsed = useApp((s) => s.panelCollapsed);
  const journal = useData((s) => s.layout.journal);

  const notes = useData((s) => s.notes);
  const archived = useData((s) => s.archived);
  const marks = useData((s) => s.marks);
  const toggleTask = useData((s) => s.toggleTask);
  const restoreNote = useData((s) => s.restoreNote);
  const deleteNote = useData((s) => s.deleteNote);
  const loadDay = useData((s) => s.loadDay);
  const loadGoal = useData((s) => s.loadGoal);
  const forgetCarriedDays = useData((s) => s.forgetCarriedDays);
  const saveDocument = useData((s) => s.saveDocument);
  const saveTitle = useData((s) => s.saveTitle);

  const doc = useCurrentDocument();
  // 命令面板里那些「这一篇」的命令只认仓库里的文档（做客的那一篇不算）
  const editorTarget = doc.editor?.target;
  const docTarget = editorTarget?.kind === "shared" ? undefined : editorTarget;
  // 列表栏收起了（像 VS Code 的侧栏）：和今日TODO、目标一样只剩窄栏和正文
  const showList = hasListColumn(workspace) && !panelCollapsed;
  // 专注模式要把整条 chrome 推出去有多远
  const zenShift = zen ? -chromeWidth(showList) : 0;
  // 主内容的版面（见下面主内容那段注释）：版面一样的两页之间不重挂，只换文档
  const frame =
    workspace === "extensions" ? "extensions" : hasListColumn(workspace) ? "listed" : "full";

  // 零点翻页
  useEffect(() => startTodayTicker(), []);

  // 团队仓库（docs/协同编辑.md §22.4）：起团队端点；编辑器里换了哪一篇告诉它（别人也开着就进同一个会话）
  const team = useData((s) => s.team);
  useEffect(() => {
    if (team) void initTeam();
  }, [team]);
  const teamDoc = teamDocId(doc);
  const teamTarget = useRef(docTarget);
  teamTarget.current = docTarget;
  useEffect(() => {
    const target = teamTarget.current;
    setTeamView(teamDoc && target ? { doc: teamDoc, target } : null);
  }, [teamDoc]);

  // 今天这一篇一进应用就取：今日TODO 页渲染的就是它，而下面那个 effect 只管
  // 日历和 /GOAL，不给今日TODO 单独取。
  // /GOAL 这一期的目标也先取着：第一次点过去是现成的，不先空着一页「载入中…」、再换上正文。
  // 跨过零点后，昨天那份「延续来的」缓存不再作数（它从来不是昨天自己的内容）。
  useEffect(() => {
    // 没开日程的仓库没有今日TODO（docs/仓库与启动器.md §6）
    if (!journal) return;
    forgetCarriedDays(todayDate);
    void loadDay(todayDate, true);
    const horizon = useApp.getState().goalHorizon;
    void loadGoal(horizon, periodStartOf(horizon, todayDate));
  }, [forgetCarriedDays, journal, loadDay, loadGoal, todayDate]);

  // 日历：选中的那一天 / 那一天所在周期的目标；/GOAL：今天所在周期的目标
  useEffect(() => {
    if (workspace === "calendar") {
      if (calendarScope === "day") void loadDay(selectedDate, selectedDate === todayDate);
      else void loadGoal(calendarScope, periodStartOf(calendarScope, selectedDate));
    } else if (workspace === "goal") {
      void loadGoal(goalHorizon, periodStartOf(goalHorizon, todayDate));
    }
  }, [calendarScope, goalHorizon, loadDay, loadGoal, selectedDate, todayDate, workspace]);

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

  // 日程切换器（docs/协同编辑.md §22.6）：从别的仓库的窗口跳过来，翻到那一页那一天；Ctrl+Alt+J 轮着切。
  // 按 code 认 J：macOS 上按着 Option 时 key 是别的字
  useEffect(() => {
    const unlisten = backend().then((api) =>
      api.onJournalGoto((page, date) => {
        const app = useApp.getState();
        app.setWorkspace(page);
        if (page === "calendar") app.selectDate(date);
      }),
    );
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.code !== "KeyJ" || !e.altKey || !(e.ctrlKey || e.metaKey)) return;
      if (!useData.getState().layout.journal) return;
      e.preventDefault();
      void journalSwitchNext();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      void unlisten.then((stop) => stop());
    };
  }, []);

  const handleSegment = (v: string) => {
    if (workspace === "goal") setGoalHorizon(labelToHorizon(v));
    else if (workspace === "calendar") setCalendarScope(labelToScope(v));
  };

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
      <div className="relative flex h-full w-full overflow-hidden bg-rail">
        <TitleBar />

        {/* ---------- 左侧 chrome（导航 + 列表栏） ----------
            专注模式的动画全在这一层做，而且刻意**不用**布局属性：

            切进专注模式的瞬间这一层变成 absolute，立刻脱离 flex 流 ——
            编辑区一帧之内就拿到整页宽度，只重排这一次；随后 540px 的位移
            纯粹是 transform，走合成器。如果改成动画化 width/marginLeft，
            540px 行程里每一帧都要重排，开了 lineWrapping 的 CodeMirror
            会被迫逐帧重新折行，正是上面列表栏那段注释说的那个坑 —— 而且
            这次行程是它的两倍宽。

            退出时反过来：先回到流内（编辑区一帧内缩回去），再从 -540
            滑回 0。两个方向都只重排一次。

            这一层**常驻** z-30，而且正文的画布往它底下多铺了 540px
            （DocumentView 里的负外边距）：退出时它滑回来的那 460ms 里，
            身后是连续的白色画布和正在往右滑的正文，而不是外层容器露出的
            一块灰底 —— 原来正文区一缩回去，左边立刻空出一块 bg-rail，
            正文还被自己的滚动容器在 540px 处切掉，看起来就是「先冒出一块
            空板、侧边栏再压上来」。铺底之后，进出两个方向是镜像的：
            都是 chrome 在白色画布上滑动、正文在它旁边跟着挪。 */}
        <motion.div
          className={cn("relative z-30 flex h-full", zen && "absolute inset-y-0 left-0")}
          animate={{ x: zenShift }}
          transition={zenTransition}
        >
          <Sidebar />

          {/* ---------- 中列表栏 ----------
            两栏 ↔ 三栏切换**只动 transform**，布局只变一次：

            进场：这一栏挂载的瞬间就以完整宽度进入 flex 流（主内容一帧之内收窄，
            只重排这一次），然后整块从导航栏底下滑出来 —— 导航栏是 z-20，它是
            z-10，所以看起来像一块板子从侧边抽屉里抽出，而不是凭空浮现。
            退场：mode="popLayout" 让它先脱离文档流（主内容同样只重排一次），
            再整块滑回导航栏底下。
            不带 opacity：它从一块不透明的导航栏底下抽出来，起点本来就看不见；
            加了淡入反而让露出来的那条边是半透明的，底下的白画布透上来。

            以前是动画化 marginLeft（-300 → 0）：布局属性，动画期间 flex 行
            每一帧都重排，主内容宽度跟着一路变，开了 lineWrapping 的 CodeMirror
            被迫逐帧重新折行 —— 220ms 里十几次全文重排，头几帧稳定在 28ms
            一帧（90Hz 屏上只有三分之一帧率），这就是「拉出来时掉帧」。
            而主内容那一头用的也是 popLayout（见下），退场的旧正文被冻结在原
            尺寸上淡出，不会因为这次重排而跳版。 */}
          <div className="relative z-10 flex h-full shrink-0">
            <AnimatePresence initial={false} mode="popLayout">
              {showList && (
                // key 只跟「有没有列表栏」走，不跟具体工作区走 ——
                // 否则「笔记 → 日历」会让整条栏先收起再展开，实际只需要换内容。
                <motion.div
                  key="list-column"
                  initial={{ x: -LIST_WIDTH }}
                  animate={{ x: 0 }}
                  exit={{ x: -LIST_WIDTH }}
                  transition={tween.base}
                  className="z-10 flex h-full shrink-0 flex-col overflow-hidden bg-panel"
                >
                  <div className="relative min-h-0 flex-1">
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.div
                        key={workspace}
                        initial={{ opacity: 0, x: 10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -8 }}
                        transition={tween.base}
                        className="h-full"
                      >
                        {workspace === "notes" && <NotesList notes={notes} />}
                        {workspace === "calendar" && <CalendarPanel marks={marks} />}
                        {workspace === "archive" && (
                          <ArchiveList items={archived} onRestore={restoreNote} />
                        )}
                      </motion.div>
                    </AnimatePresence>
                  </div>
                  {/* 仓库名 ⌄：换仓库、开关日程（Obsidian 也放在这里）。在换内容的那一层外面，
                      切工作区时它不跟着淡出淡入 */}
                  <VaultSwitcher />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>

        {/* ---------- 主内容 ----------
            按「版面」换，不按区换：frame 是「这一区有列表栏 / 没有 / 扩展页」。列表栏收起了也算有：
            在笔记里收起 / 展开它不换一屏，正文那一列自己滑过去（DocumentView 的 CenteredColumn）。
            版面一样的两页（今日TODO ↔ /GOAL，笔记 ↔ 日历 ↔ 归档）是同一个 DocumentView，
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
              {workspace === "extensions" ? (
                <ExtensionsView />
              ) : (
                <DocumentView
                  doc={doc}
                  onToggleTask={toggleTask}
                  onSegmentChange={handleSegment}
                  onDelete={() => {
                    // 笔记和归档里的都能删（归档那篇的 key 是 archive-…，id 从目标上取）。
                    // 选中先挪到列表里的下一篇，再删
                    const target = doc.editor?.target;
                    if (target?.kind !== "note") return;
                    selectNeighbor(target.id);
                    void deleteNote(target.id);
                  }}
                  onSaveDocument={saveDocument}
                  onSaveTitle={saveTitle}
                />
              )}
            </motion.main>
          </AnimatePresence>

          {/* 底部居中的提示条：错误在上、撤销在下。容器不接收指针，只有提示条本身接收。
              在正文区里居中（以前按整个窗口居中，跨在列表栏和正文的分界线上）。
              离底 72px：底下贴着正文的状态栏（32px 高），「保存失败」就显示在那一行，别压上去 */}
          <div className="pointer-events-none absolute inset-x-0 bottom-[72px] z-40 flex flex-col items-center gap-2 px-6">
            <ErrorToast />
            <NoticeToast />
            <LayoutChangeToast />
            <TeamRelayToast />
            <CollabRequests />
            <CollabResume />
            <UndoToast />
          </div>
        </div>
        <CommandPalette docTarget={docTarget} />
        <FindDialog />
        <SyncDialog />
        <CollabDialog />
        {/* 在协作对话框之上：连不上时从协作对话框里「配中继…」打开 */}
        <RelayDialog />
        <TeamDialog />
        <HistoryDialog />
        <TrashDialog />
        <UpdateDialog />
        {/* 开场：冷启动时盖在最上面，写一个「O」再把它送回侧栏（components/Intro.tsx） */}
        <Intro />
      </div>
    </MotionConfig>
  );
}
