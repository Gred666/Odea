import { ZEN_TRANSITION } from "@/app/navMotion";
import { openDocument } from "@/app/navigate";
import { RAIL_WIDTH, hasListColumn, useApp } from "@/app/store";
import { type GuestCopyState, useGuestCopies } from "@/collab/keep";
import { useCollab } from "@/collab/store";
import { attachFiles, attachPaths, documentFolder } from "@/data/attachments";
import { folderLabel, folderOf } from "@/data/folders";
import { NEW_NOTE_TITLE, saveKeyOf, useData } from "@/data/store";
import type { DocumentModel, DocumentSaveTarget } from "@/data/types";
import type { EditorOutlineHandle } from "@/editor/MarkdownEditor";
import type { WikiCandidate } from "@/editor/suggest";
import type { TemplateContext } from "@/editor/templates";
import { cn } from "@/lib/cn";
import { buildOutline, renderMarkdown } from "@/lib/markdown";
import { spring, tween } from "@/lib/motion";
import { MOD_KEY } from "@/lib/platform";
import { windowKind } from "@/lib/tauri";
import {
  AlertTriangle,
  Archive,
  FolderOpen,
  History,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Trash2,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DayTasks } from "./ActionItem";
import { Backlinks } from "./Backlinks";
import { CollabBanner, CollabPresence } from "./CollabDialog";
import { ConflictBanner } from "./ConflictBanner";
import { EmptyState } from "./EmptyArt";
import { GuideUpdateBanner } from "./GuideUpdateBanner";
import { JournalSwitcher, journalPageOf } from "./JournalSwitcher";
import { NotePath } from "./NotePath";
import { Outline } from "./Outline";
import { OverlayScrollbar } from "./OverlayScrollbar";
import { Segmented } from "./Segmented";
import { SwapFade } from "./SwapFade";
import { TeamPresence } from "./TeamPresence";

/** 目录树的指纹：标题文字或行号变了才需要重新渲染文档视图。 */
const outlineKeyOf = (markdown: string) =>
  buildOutline(markdown)
    .map((item) => `${item.id}@${item.line}:${item.depth}`)
    .join("|");

/* 编辑器分包在模块求值时就开始下载。DocumentView 是 Shell 的静态依赖，
   所以这一行等于「应用一启动就预载编辑器」。

   之所以要预载：首屏默认工作区（笔记）第一帧就要用编辑器渲染正文。chunk 没
   到位时会先渲染一次 DocumentPreview —— 而两者排版并不一致（正文 15px vs
   17px/1.4，h2 21px vs 29.75px），到位后一换，整篇重排一次，就是启动时那
   一下闪动。

   这里刻意没有用 React.lazy + Suspense：即便传给 lazy 的 promise 早已 resolve，
   首次渲染也必然先 suspend 一次、把 fallback 提交上屏，闪动照旧（实测预览仍
   会在 1162ms 出现一次）。改成自己持有解析后的组件引用，预载完成时首帧就能
   直接渲染编辑器，一次都不用替换。 */
type EditorComponent = typeof import("@/editor/MarkdownEditor").MarkdownEditor;

const editorModule = import("@/editor/MarkdownEditor");
/** 预载完成后同步可用；bootstrap 在挂载 React 之前把它填好。 */
let resolvedEditor: EditorComponent | null = null;

/** 供 bootstrap 在挂载 React 之前 await，确保首帧就能直接渲染编辑器。 */
export const preloadEditor = async () => {
  resolvedEditor = (await editorModule).MarkdownEditor;
};

/* ============================================================
   统一文档视图。
   笔记 / 今日TODO / GOAL / 日历某天 / 归档项 —— 全部由它渲染。
   新增内容类型只需要在 adapter 里多映射一个 DocumentModel，
   不需要写新的视图组件。
   ============================================================ */

export function DocumentView({
  doc,
  onToggleTask,
  onSegmentChange,
  onDelete,
  onSaveDocument,
  onSaveTitle,
  editorEnabled = true,
}: {
  doc: DocumentModel;
  onToggleTask: (id: string) => void;
  onSegmentChange?: (v: string) => void;
  onDelete?: () => void;
  onSaveDocument?: (target: DocumentSaveTarget, markdown: string) => Promise<void>;
  onSaveTitle?: (target: DocumentSaveTarget, title: string) => Promise<void>;
  editorEnabled?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 正文区上一次滚到的 scrollTop（滚动事件里记，见下面切换文档时拨回顶部） */
  const scrolledRef = useRef(0);
  const [editorOutline, setEditorOutline] = useState<EditorOutlineHandle | null>(null);
  const workspace = useApp((s) => s.workspace);
  const zen = useApp((s) => s.zen);
  const setZen = useApp((s) => s.setZen);
  // 只有笔记区给这个入口：其它区要么是两栏、要么本来就没有可铺满的正文。访客窗口没有侧栏可收
  const zenAvailable = workspace === "notes" && windowKind !== "guest";
  // 状态栏最左端的侧栏开关：只有有那一栏的几页（文件、日历、归档）才有。专注模式下那一栏推在屏幕外，也不给
  const panelCollapsed = useApp((s) => s.panelCollapsed);
  const setPanelCollapsed = useApp((s) => s.setPanelCollapsed);
  const panelToggle =
    hasListColumn(workspace) && windowKind !== "guest" && !zen
      ? { collapsed: panelCollapsed, onToggle: () => setPanelCollapsed(!panelCollapsed) }
      : undefined;
  // 编辑器里的实时正文。doc.bodyMd 要等一次保存往返才更新，
  // 只靠它的话目录树会永远慢半拍，点条目还会跳到旧行号。
  const [liveMarkdown, setLiveMarkdown] = useState<string | null>(null);
  const outlineKeyRef = useRef<string | null>(null);

  // 只有目录真的变了才把正文提上来，避免每敲一个字都重渲染整个文档视图。
  const handleDocumentChange = useCallback((markdown: string) => {
    const key = outlineKeyOf(markdown);
    if (key === outlineKeyRef.current) return;
    outlineKeyRef.current = key;
    setLiveMarkdown(markdown);
  }, []);

  // Mod + 点击 [[双链]]：按标题找到那篇笔记就跳过去（归档里的也算）。
  // `[[标题#小节]]` 再记一个待滚动的锚点，等那篇的编辑器挂上后滚过去。
  // 还没有这篇（编辑器里画成虚线）：就地新建一篇这个标题的，放在当前这篇所在的文件夹，
  // 打开它、光标在正文开头；底部提示条可以撤销
  const noteIdRef = useRef<string | null>(null);
  const handleWikiLink = useCallback((title: string, heading?: string) => {
    const wanted = title.trim().toLowerCase();
    if (!wanted) return;
    const { notes, archived } = useData.getState();
    const hit =
      notes.find((note) => note.title.trim().toLowerCase() === wanted) ??
      archived.find((note) => note.title.trim().toLowerCase() === wanted);
    if (hit) {
      openDocument({ kind: "note", id: hit.id }, heading ? { heading } : undefined);
      return;
    }
    const here = notes.find((note) => note.id === noteIdRef.current);
    void useData
      .getState()
      .createLinkedNote(title.trim(), here ? folderOf(here) : "")
      .then((id) => {
        if (!id) return;
        useApp.getState().setFocusRequest({ docKey: `note-${id}`, at: "body" });
        openDocument({ kind: "note", id });
      });
  }, []);

  // `[[` 菜单能链过去的笔记（最近改过的在前），也用来认出链到不存在的笔记的双链。
  // 只在标题集合变了时重算：自动保存每次都换一份 notes，不能每次都让编辑器重标一遍
  const linkKey = useData((state) =>
    [...state.notes, ...state.archived].map((note) => `${note.id}\u0001${note.title}`).join("\n"),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: linkKey 就是标题集合的指纹
  const linkTargets = useMemo<WikiCandidate[]>(() => {
    const { notes, archived } = useData.getState();
    return [...notes, ...archived]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((note) => ({
        id: note.id,
        title: note.title,
        folder: folderOf(note) ? folderLabel(folderOf(note)) : "",
        archived: note.isArchived,
      }));
  }, [linkKey]);

  const outlineSource = liveMarkdown ?? doc.bodyMd;
  const outline = useMemo(() => buildOutline(outlineSource), [outlineSource]);

  // 双链带的小节：目标笔记的目录一算出来就滚过去。旧编辑器的句柄会拒绝（返回 false），
  // 那就等下一次 —— 新编辑器挂上后 editorOutline 会换掉，effect 会再跑。
  const pendingAnchor = useApp((s) => s.pendingAnchor);
  const setPendingAnchor = useApp((s) => s.setPendingAnchor);
  useEffect(() => {
    if (!pendingAnchor || pendingAnchor.docKey !== doc.key || !editorOutline) return;
    if (pendingAnchor.line !== undefined) {
      if (editorOutline.scrollToLine(pendingAnchor.line, pendingAnchor.match))
        setPendingAnchor(null);
      return;
    }
    const wanted = (pendingAnchor.heading ?? "").trim().toLowerCase();
    const item = outline.find((entry) => entry.text.trim().toLowerCase() === wanted);
    if (!item) return;
    if (editorOutline.scrollTo(item.id)) setPendingAnchor(null);
  }, [pendingAnchor, doc.key, editorOutline, outline, setPendingAnchor]);

  const saving = useData((state) => (doc.editor ? state.savingDocs.has(saveKey(doc)) : false));
  // 做客的这一篇：主持人还没存下的字本机留着一份，还是都存下了（collab/keep.ts）
  const collabSession = doc.collab?.session;
  const guestCopy = useGuestCopies((state) =>
    collabSession ? state.states.get(collabSession) : undefined,
  );
  // 只显示这一篇自己的保存失败（以及不属于某一篇的，比如关窗时那次）。
  // saveError 只有一格，别的文档后来又失败会把它覆盖；这一篇还有草稿没落盘的话照样提示。
  const saveError = useData((state) => {
    if (!doc.editor) return null;
    const key = saveKey(doc);
    const failure = state.saveError;
    if (failure && (failure.key === null || failure.key === key)) return failure.message;
    return state.drafts[key] ? `有修改还没存进去，继续编辑或按 ${MOD_KEY}+S 重试` : null;
  });

  // 切换文档时先拨回顶部。用 instant 而不是 smooth ——
  // 换了一篇文档还看到旧位置平滑滚动，是错误的心智模型。
  // 上次在这篇看到哪由编辑器挂上之后自己滚回去（lib/viewMemory.ts），在这之后跑。
  // layout effect：新一篇的第一帧就得在顶上。放在 useEffect 里的话，不是点击触发的
  // 切换（比如命令面板）可能先按旧的滚动位置画出一帧，再跳回顶部。
  // 已经在顶上就不拨：scrollTo 要先把整页排一遍版才知道往哪滚，这时新的一篇刚换上、
  // 编辑器还没挂（它在后面的 effect 里挂），挂上以后又得整页再排一次 —— 白排的那一次
  // 切一篇 4 倍降速下约 30ms。滚动位置从滚动事件里记，读 scrollTop 本身也会强制排版
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只应在 doc.key 变化时触发
  useLayoutEffect(() => {
    if (scrolledRef.current !== 0) scrollRef.current?.scrollTo({ top: 0, behavior: "instant" });
    setLiveMarkdown(null);
    outlineKeyRef.current = null;
  }, [doc.key]);

  const canEdit = !!doc.editor && !!onSaveDocument && editorEnabled;

  // 别的程序改了这篇的文件：编辑器据此分辨「正文变了」是外部改动还是自己的保存回来了
  const externalRevision = useData((state) =>
    doc.editor ? (state.externalRevisions[saveKey(doc)] ?? 0) : 0,
  );
  // 仓库里的那一篇（保存、历史版本、附件、在文件夹里显示都按它）。做客的那一篇（协作时别人的文档）
  // 不在仓库里，这些都没有
  const editorTarget = doc.editor?.target;
  const target = editorTarget?.kind === "shared" ? undefined : editorTarget;
  const shared = editorTarget?.kind === "shared";
  // 某一天 / 某个周期的文档能用 `/模板`（editor/templates.ts）；笔记不接。
  // 只取类型：模板本身在编辑器分包里，不进主包
  const todayDate = useApp((s) => s.todayDate);
  const dayId = target?.kind === "day" ? target.id : null;
  const goalHorizon = target?.kind === "goal" ? target.horizon : null;
  const goalStart = target?.kind === "goal" ? target.periodStart : null;
  const templateContext = useMemo<TemplateContext | undefined>(() => {
    if (dayId) return { scope: "day", date: dayId, today: todayDate };
    if (goalHorizon && goalStart) return { scope: goalHorizon, date: goalStart, today: todayDate };
    return undefined;
  }, [dayId, goalHorizon, goalStart, todayDate]);
  const handleExternalConflict = useCallback(() => {
    if (target) useData.getState().markConflict(target);
  }, [target]);
  const handleReveal = target ? () => void useData.getState().revealDocument(target) : undefined;
  // 历史版本：同步用的 git 仓库里每次改过这篇的提交（没开同步时对话框里说明、给开启的入口）
  const handleHistory = target ? () => useApp.getState().setHistoryFor(target) : undefined;

  // 附件：粘贴 / 拖进来的文件存进仓库的「附件」，正文里的相对路径以这篇所在的文件夹为基准
  const vaultRoot = useData((s) => s.vaultRoot);
  const imageBase = documentFolder(vaultRoot, doc.relPath);
  const handleAttachFiles = useCallback(
    (files: File[]) => (target ? attachFiles(target, files) : Promise.resolve([])),
    [target],
  );
  const handleAttachPaths = useCallback(
    (paths: string[]) => (target ? attachPaths(target, paths) : Promise.resolve([])),
    [target],
  );
  // 做客的那一篇（设计 §7.2）：图片从主持人那里要来（解析器换了编辑器就重画那几张）；
  // 粘贴的文件交给主持人存进他的「附件」，插进正文的是从那篇引用它的路径
  const guestImages = useCollab((s) => s.images);
  const guestAttachFiles = useCallback(
    (files: File[]) => useCollab.getState().attachFiles(files),
    [],
  );
  const guestAttachPaths = useCallback(
    (paths: string[]) => useCollab.getState().attachPaths(paths),
    [],
  );
  const noteId = target?.kind === "note" ? target.id : null;
  noteIdRef.current = noteId;
  // 这篇是用户改过的使用指南、这个版本带着新版：标题上方问换不换
  const guideUpdate = useData((s) =>
    noteId ? s.guideUpdates.find((update) => update.id === noteId) : undefined,
  );

  // 新建完光标该去哪（app/store 的 FocusRequest）。标题的那种由标题框自己接（见下面）；
  // 正文开头的要等这一篇的编辑器挂上
  const focusRequest = useApp((s) => s.focusRequest);
  useEffect(() => {
    if (focusRequest?.docKey !== doc.key || focusRequest.at !== "body" || !editorOutline) return;
    if (editorOutline.focusStart()) useApp.getState().setFocusRequest(null);
  }, [focusRequest, doc.key, editorOutline]);

  // 标题和正文之间用键盘来回：标题里回车 / ↓ 进正文开头，正文第一行按 ↑ 回标题末尾
  const titleFieldRef = useRef<HTMLTextAreaElement>(null);
  const enterBody = useCallback(() => {
    editorOutline?.focusStart();
  }, [editorOutline]);
  const exitToTitle = useCallback(() => {
    const field = titleFieldRef.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);

  // 正常路径下 bootstrap 已经预载完，这里首帧就拿到组件。
  // 兜底：万一没走 bootstrap（比如单测直接渲染本组件），照旧异步加载后再补上。
  const [Editor, setEditor] = useState<EditorComponent | null>(() => resolvedEditor);
  useEffect(() => {
    if (Editor) return;
    let alive = true;
    void editorModule.then((module) => {
      resolvedEditor = module.MarkdownEditor;
      if (alive) setEditor(() => module.MarkdownEditor);
    });
    return () => {
      alive = false;
    };
  }, [Editor]);

  return (
    // 上面一行是正文（+ 右侧目录树），底下贴着状态栏（StatusBar）
    <div className="relative flex h-full min-w-0 flex-1 flex-col bg-canvas">
      <div className="relative flex min-h-0 flex-1">
        {/* 定位基准必须是滚动容器自己这一层。挂到外面那行上的话，
          absolute right-0 贴的是「正文 + 大纲栏」的右边 ——
          滑块会跑到大纲栏外侧去，离它真正在滚的那块内容隔着一整栏。 */}
        {/* data-swap-host：切换文档时旧内容的快照放在这一层（见 SwapFade）——
          它不滚动、就是正文的可视区，快照按它裁切。 */}
        <div className="relative min-w-0 flex-1" data-swap-host>
          {/* 画布往左 chrome 底下多铺 RAIL_WIDTH：负外边距把盒子拉过去，等宽的
            内边距把内容留在原位，所以排版一点没变，只是底色和裁切边界往左
            延到了窗口边缘。退出专注模式时 chrome 滑回来的那段时间，正文能
            一直完整地显示在白底上、往右滑到新位置 —— 否则滚动容器（overflow-y
            一设，横向也必然裁切）会在 chrome 的右边缘把正在位移的正文切掉。
            平时这一截压在 z-30 的 chrome 底下，看不见也摸不着。 */}
          <div
            ref={scrollRef}
            onScroll={(event) => {
              scrolledRef.current = event.currentTarget.scrollTop;
            }}
            // 查找面板（editor/searchPanel.ts）按它的右边缘贴边
            data-doc-scroller
            // @container：正文区多宽（容器查询量的是内容盒，多铺到 chrome 底下的那截内边距不算），
            // 窄的时候左右留白、大标题、分段控件的字跟着收（窗口窄、列表栏开着的时候）
            className="@container scroll-none h-full overflow-y-auto bg-canvas"
            style={{ marginLeft: -RAIL_WIDTH, paddingLeft: RAIL_WIDTH }}
          >
            <CenteredColumn className="min-h-full flex-col pb-16 pt-[52px]">
              {/* 换文档（也包括今日TODO ↔ /GOAL 这种同一个版面的两页）时整块溶解：旧的一份快照
                铺着底色盖在原处退掉，新的一份就在底下（见 SwapFade）。
                标题、分隔线、正文、状态栏都在里面，一起换，不再各播各的入场动画。 */}
              <SwapFade swapKey={doc.key} className="flex flex-1 flex-col">
                {doc.empty ? (
                  <EmptyDocument empty={doc.empty} />
                ) : (
                  <>
                    {/* ---------- 做客那一篇：重新连接中、只读、协作结束了 ---------- */}
                    {shared && <CollabBanner />}

                    {/* ---------- 冲突副本横幅 ---------- */}
                    {doc.conflict && (
                      <ConflictBanner key={doc.conflict.copyId} conflict={doc.conflict} />
                    )}

                    {/* ---------- 使用指南有新版（用户改过这一篇） ---------- */}
                    {guideUpdate && <GuideUpdateBanner key={guideUpdate.id} update={guideUpdate} />}

                    {/* ---------- 归档横幅 ----------
                  key 固定：在两篇归档笔记之间切换时横幅本身不动，文字跟着整块一起淡换。
                  原来按文字做 key，日期不同的两篇一切，旧条往上退、新条从上落，
                  两条叠在一起错开几像素 —— 看起来就是在抖。
                  中性色：归档不是出错，以前的红底看着像是这篇出了什么问题。 */}
                    <AnimatePresence mode="popLayout" initial={false}>
                      {doc.banner && (
                        <motion.div
                          key="banner"
                          initial={{ opacity: 0, y: -6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4 }}
                          transition={tween.base}
                          className="mb-7 flex items-center gap-2 rounded-lg bg-raised/70 px-3.5 py-2.5"
                        >
                          <Archive size={12.5} strokeWidth={1.9} className="shrink-0 text-muted" />
                          <span className="text-[12px] text-body">{doc.banner.text}</span>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* ---------- 标题行 ---------- */}
                    <header id="doc-top" data-outline-id="doc-top">
                      {/* 标题上方那一行：左边是小字（日历某天的日期、笔记的文件夹），右边是分段控件。
                    跟着正文滚：往下滚到大标题钻进窗口最上面那条底下，那里出现一行「路径 / 标题」
                    （TitleStrip），顶上不多占地方。2026-10-28 试过把这一行固定在正文上方，一直占着 80px，太挤。
                    分段控件原来和标题并排在同一行、分掉一截宽度，日历某天的标题
                    稍长就被它截掉。挪上来之后标题独占整行；这一行的高度钉在小字
                    的一行高，控件比它高出来的部分往上溢进顶部留白里（负外边距），
                    标题的位置不受影响，切「日TODO ↔ 周/GOAL」时控件也不挪窝。 */}
                      {(doc.eyebrow ||
                        doc.folder !== undefined ||
                        (doc.segments && onSegmentChange)) && (
                        <div className="mb-2 flex min-h-[20px] items-end justify-between gap-8">
                          {doc.eyebrow && (
                            <div className="flex min-w-0 items-center gap-1.5">
                              <p
                                className="min-w-0 truncate text-[12px] font-medium leading-[20px]
                                     tracking-[0.02em] text-muted"
                              >
                                {doc.eyebrow}
                              </p>
                              {/* 日程切换器（docs/协同编辑.md §22.6）：开着日程的仓库有两个以上时才有 */}
                              {journalPageOf(workspace) && <JournalSwitcher />}
                            </div>
                          )}
                          {/* 笔记：这篇在哪个文件夹（列表栏退回上层后，深处那篇在列表里看不见） */}
                          {doc.folder !== undefined && (
                            <NotePath folder={doc.folder} relPath={doc.relPath} />
                          )}
                          {/* 协作中：谁在、点一下回到协作的那篇（右上角是目录树的标题，放这一行的右端） */}
                          <CollabPresence docKey={doc.key} />
                          {/* 团队仓库：别人也开着这一篇（docs/协同编辑.md §22.4） */}
                          <TeamPresence doc={doc} />
                          {/* 盒子钉成小号控件的高（30），-10 之后正好是这一行的 20：大号的（34，/GOAL 那组）
                            多出来的 4px 往下垂进 mb-2 的空里，不再把这一行撑成 24 —— 以前 /GOAL 的标题、
                            分隔线、正文都比别的页低 4px，切过去就跳一下 */}
                          {doc.segments && onSegmentChange && (
                            <div className="-mt-2.5 ml-auto h-[30px] shrink-0">
                              <Segmented
                                group={doc.segments.group}
                                options={doc.segments.options.map((o, i) => {
                                  const short = doc.segments?.short?.[i];
                                  return {
                                    value: o,
                                    title: short ? o : undefined,
                                    // 正文区窄的时候换成一个字，免得把左边那行日期挤没了
                                    label: short ? (
                                      <>
                                        <span className="@min-[640px]:hidden">{short}</span>
                                        <span className="hidden @min-[640px]:inline">{o}</span>
                                      </>
                                    ) : (
                                      o
                                    ),
                                  };
                                })}
                                value={doc.segments.active}
                                onChange={onSegmentChange}
                                size={doc.segments.options.length > 3 ? "sm" : "md"}
                              />
                            </div>
                          )}
                        </div>
                      )}

                      {/* 标题按文档 key 重挂（可编辑标题的本地状态跟着换篇重置），
                    但不再单独播入场：以前旧标题直接消失、新标题从下面 16px 弹上来，
                    中间空着一拍，正文却已经换好了。 */}
                      {doc.editor?.titleEditable && onSaveTitle ? (
                        <EditableDocumentTitle
                          key={doc.key}
                          fieldRef={titleFieldRef}
                          title={doc.title}
                          // 占位标题（无标题笔记）不是真标题：输入框里留空，让用户直接起名
                          placeholder={doc.title === NEW_NOTE_TITLE}
                          // 刚新建的这一篇：光标直接落在标题里
                          autoFocus={
                            focusRequest?.docKey === doc.key && focusRequest.at === "title"
                          }
                          onEnterBody={enterBody}
                          onSave={(title) =>
                            target ? onSaveTitle(target, title) : Promise.resolve()
                          }
                        />
                      ) : (
                        <h1
                          key={doc.key}
                          className="selectable break-words font-display text-[30px] font-bold leading-[1.25]
                               text-ink @min-[480px]:text-[38px]"
                        >
                          {doc.title}
                        </h1>
                      )}
                    </header>

                    {/* 标题下的细分隔线：宽度从 0 展开，是「文档打开了」的一个小信号。
                  只在进这个工作区时播一次；换篇时它留在原地，跟着整块一起淡换 */}
                    <motion.div
                      className="mt-6 h-px origin-left bg-line"
                      initial={{ scaleX: 0, opacity: 0 }}
                      animate={{ scaleX: 1, opacity: 1 }}
                      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: 0.05 }}
                    />

                    {/* ---------- 正文 ----------
                  编辑器稳定岛：这里以及编辑器自身都没有 Motion layout/transform
                  （SwapFade 只动 opacity）。Shell 那边的工作区进场也是纯 opacity，
                  所以编辑器可以在新一屏的第一帧就挂上，不需要先拿 DocumentPreview
                  顶一段。这一点很重要：预览和编辑器的排版并不一致（正文 15px vs
                  17px/1.4，h2 21px vs 29.75px），中途替换会让整篇重排一次，看着像卡顿。
                  数据还没到（没有 doc.editor）或 editorEnabled 强制只读时才是预览。 */}
                    <div className="flex-1">
                      {canEdit && Editor ? (
                        <Editor
                          key={saveKey(doc)}
                          initialMarkdown={doc.bodyMd}
                          // 团队仓库里别人在主持这一篇：他存，这边不存（docs/协同编辑.md §22.2 规矩 1）
                          onSave={(markdown) =>
                            target && !doc.collab?.remote
                              ? onSaveDocument(target, markdown)
                              : Promise.resolve()
                          }
                          outlineItems={outline}
                          onOutlineHandle={setEditorOutline}
                          onDocumentChange={handleDocumentChange}
                          // 做客的那一篇：双链指向的是主持人的笔记，不在这里打开
                          onWikiLink={shared ? undefined : handleWikiLink}
                          // 日历当日安排跟在正文后面：编辑器别再撑 360px 把任务推到底下
                          fill={!doc.dayTasks?.length}
                          // 切走时缓存编辑器状态，切回来不用再解析全文
                          cacheKey={saveKey(doc)}
                          externalRevision={externalRevision}
                          onExternalConflict={handleExternalConflict}
                          templateContext={templateContext}
                          imageBase={shared ? guestImages : imageBase}
                          onAttachFiles={shared ? guestAttachFiles : handleAttachFiles}
                          onAttachPaths={shared ? guestAttachPaths : handleAttachPaths}
                          linkTargets={shared ? undefined : linkTargets}
                          // 双链指向的是主持人的笔记，这边没有：一律按「不存在」画
                          linksMissing={shared}
                          collab={doc.collab?.session ?? null}
                          readOnly={doc.collab?.readOnly ?? false}
                          linkSelf={noteId ?? undefined}
                          onExitTop={doc.editor?.titleEditable ? exitToTitle : undefined}
                        />
                      ) : (
                        <DocumentPreview markdown={doc.bodyMd} />
                      )}

                      {doc.dayTasks && doc.dayTasks.length > 0 && (
                        <DayTasks tasks={doc.dayTasks} onToggle={onToggleTask} />
                      )}

                      {/* ---------- 反向链接：别的文档里写了 [[这篇]] 的地方 ---------- */}
                      {noteId && <Backlinks key={noteId} noteId={noteId} title={doc.title} />}
                    </div>
                  </>
                )}
              </SwapFade>
            </CenteredColumn>
          </div>
          <OverlayScrollbar targetRef={scrollRef} />
          {/* 大标题滚出去以后，窗口最上面那条里的「路径 / 标题」 */}
          <TitleStrip doc={doc} scrollRef={scrollRef} />
          {/* 正文滚到状态栏跟前淡掉，不是被一刀切齐：状态栏不画分隔线（窄栏右边那一栏底下的
              「仓库名」有一条，高度对不上，两条线一高一低）。压在换篇的快照（z-5）上面，快照也一样淡 */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 z-[6] h-6"
            style={{ background: "linear-gradient(to bottom, transparent, var(--color-canvas))" }}
          />
        </div>

        <Outline
          items={outline}
          scrollRef={scrollRef}
          resetKey={doc.key}
          memoryKey={saveKey(doc)}
          editorHandle={editorOutline}
          zen={zen}
        />
      </div>

      {/* ---------- 底部状态栏：贴着窗口底边，不跟着正文滚 ---------- */}
      <StatusBar
        docKey={doc.key}
        parts={doc.empty ? [] : doc.statusParts}
        panelToggle={panelToggle}
        onDelete={doc.deletable ? onDelete : undefined}
        onReveal={handleReveal}
        onHistory={handleHistory}
        saving={saving}
        guestCopy={guestCopy}
        saveError={saveError}
      />

      {/* 换到没有专注模式的区（日历、归档）时淡掉：笔记 ↔ 日历是同一个 DocumentView，不跟着整屏换 */}
      <AnimatePresence initial={false}>
        {zenAvailable && <ZenToggle key="zen" zen={zen} onToggle={() => setZen(!zen)} />}
      </AnimatePresence>
    </div>
  );
}

/** 窗口最上面那条的高：无边框窗口的拖动区（TitleBar 也是这么高） */
const STRIP_HEIGHT = 38;

/**
 * 大标题滚出去以后，窗口最上面那条（无边框窗口的拖动区）里淡进来一行「路径 / 标题」
 * （docs/仓库与启动器.md §20）。像苹果的大标题收进导航栏：在顶上时路径、标题都在正文里，跟着滚，
 * 顶上一点不多占；往下滚到大标题整个钻进这一条底下，这一行淡进来，读到一半也知道在哪一篇、哪个文件夹。
 * 点标题滑回顶上，点路径的一段在列表栏里打开那个文件夹。
 *
 * 为什么是到点淡入、不是滚多少淡多少（CSS 滚动时间线）：换篇时正文先拨回顶上、编辑器挂上后再滚回
 * 上次看到的地方，跟着滚动走的话这一行会消失一帧再冒出来。现在看的是「大标题在不在这一条底下」
 * （IntersectionObserver，滚动时不用每帧算），换篇时它一直显示着的话，里面的字跟着正文一起溶解（SwapFade）；
 * 淡出的那一下字留着刚才那一篇的，不会换成新那篇的再淡掉。
 *
 * 两层：底色（铺满这一栏，下沿 16px 渐隐，盖住滚上来的正文）在标题栏（z-40）底下，窗口按钮照样在它上面
 * —— 它比 chrome（z-30）高，所以不能像正文画布那样往左多铺一截，不然盖到窄栏的 Logo 上；字那一层在标题栏上面（z-41），整层不接指针，只有路径的几段和标题接 ——
 * 空着的地方照样拖窗口、双击最大化。只淡 opacity（CLAUDE.md 规矩 1），一直待在自己的图层上（规矩 3）。
 * 给鼠标用的复本：读屏器、Tab 键走正文里那一行（aria-hidden、tabIndex -1）
 */
function TitleStrip({
  doc,
  scrollRef,
}: {
  doc: DocumentModel;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  // 显不显示，以及这是哪一篇的结论（换篇的那一次渲染里还是上一篇的，新那篇的要等下面的 observer 回来）
  const [state, setState] = useState({ key: doc.key, shown: false });
  // 大标题（连同上面那一行）整个钻进这一条底下了没有。换篇、从空白页换成有内容的，重新找标题
  // biome-ignore lint/correctness/useExhaustiveDependencies: doc.key / doc.empty 是「标题换了一个」的信号
  useEffect(() => {
    const scroller = scrollRef.current;
    const header = scroller?.querySelector<HTMLElement>("[data-outline-id='doc-top']");
    const key = doc.key;
    if (!scroller || !header || typeof IntersectionObserver === "undefined") {
      setState({ key, shown: false });
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        // 不在视口里、而且是在上面（不是被挤到了下面）
        const above = entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0);
        setState({ key, shown: !entry.isIntersecting && above });
      },
      { root: scroller, rootMargin: `-${STRIP_HEIGHT}px 0px 0px 0px` },
    );
    observer.observe(header);
    return () => observer.disconnect();
  }, [scrollRef, doc.key, doc.empty]);

  // 字跟着「显示着、而且是这一篇的结论」走：淡出的时候、新那篇的结论还没回来的时候，留着刚才那一篇的
  const shown = state.shown;
  const last = useRef(doc);
  if (shown && state.key === doc.key) last.current = doc;
  const info = last.current;
  if (info.empty) return null;
  const where =
    info.folder !== undefined ? (
      <NotePath folder={info.folder} relPath={info.relPath} tabIndex={-1} />
    ) : info.eyebrow ? (
      <span className="min-w-0 truncate">{info.eyebrow}</span>
    ) : null;

  return (
    <>
      <div
        aria-hidden="true"
        data-shown={shown || undefined}
        className="odea-doc-strip pointer-events-none absolute inset-x-0 top-0 z-[39]"
        style={{
          height: STRIP_HEIGHT + 16,
          background: `linear-gradient(to bottom, var(--color-canvas) ${STRIP_HEIGHT}px, transparent)`,
        }}
      />
      <div
        aria-hidden="true"
        data-shown={shown || undefined}
        className="odea-doc-strip @container pointer-events-none absolute inset-x-0 top-0 z-[41]"
        style={{ height: STRIP_HEIGHT }}
      >
        <CenteredColumn className="h-full items-center">
          {/* 右边让出窗口按钮的位置（正文区贴着窗口右边缘的时候） */}
          <div className="relative h-full min-w-0 max-w-[calc(100%-80px)]" data-swap-host>
            <SwapFade
              swapKey={info.key}
              className="flex h-full min-w-0 items-center text-[12px] font-medium leading-[20px] tracking-[0.02em] text-muted"
            >
              {where && (
                <div className="pointer-events-auto flex min-w-0 shrink items-center">{where}</div>
              )}
              {where && (
                <span aria-hidden="true" className="shrink-0 text-faint/70">
                  /
                </span>
              )}
              <button
                type="button"
                tabIndex={-1}
                title="回到顶上"
                onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
                className="pointer-events-auto h-5 min-w-0 shrink-[2] truncate rounded-md px-[5px] text-body
                           transition-colors duration-[140ms] hover:bg-raised/60 hover:text-ink"
              >
                {info.title}
              </button>
            </SwapFade>
          </div>
        </CenteredColumn>
      </div>
    </>
  );
}

/**
 * 正文那一列（和窗口最上面那条里「路径 / 标题」那一列）：居中、最宽 860。进出专注模式、列表栏收起 / 展开时，它「滑」到新的居中位置，
 * 而不是瞬间跳过去（layout="position"，只动位置不动尺寸 —— 尺寸动画是 scale，会把文字拉变形）。
 * layoutDependency 把重新测量限定在这两样变化的那一次，换笔记、正文变长都不会触发多余的位移动画。
 * 列表栏收起 / 展开时和它的进出场同一个节奏（Shell 里的 tween.base）。
 *
 * 单独成一个组件，是为了只让它自己订阅这两样：以前整个 DocumentView 订阅导航栏收起，
 * 一切换就把目录树、专注模式的刻度、编辑器外壳全部重渲染一遍 —— 长文档在 dev 构建里 68ms，
 * 4 倍降速 370ms，动画开头卡一下。现在只有这一层重渲染，children 是上层给的同一份，React 直接复用。
 */
function CenteredColumn({ className, children }: { className: string; children: React.ReactNode }) {
  const zen = useApp((s) => s.zen);
  const panelCollapsed = useApp((s) => s.panelCollapsed);
  // 这一次滑动是谁引起的，就跟谁的节奏走：专注模式和列表栏收起 / 展开的曲线不一样
  const last = useRef({ zen, panelCollapsed, by: "zen" as "zen" | "panel" });
  if (last.current.zen !== zen) last.current = { zen, panelCollapsed, by: "zen" };
  else if (last.current.panelCollapsed !== panelCollapsed)
    last.current = { zen, panelCollapsed, by: "panel" };
  return (
    <motion.div
      layout="position"
      layoutDependency={`${zen}|${panelCollapsed}`}
      transition={last.current.by === "panel" ? tween.base : ZEN_TRANSITION}
      className={cn("mx-auto flex w-full max-w-[860px] px-8 @min-[560px]:px-14", className)}
    >
      {children}
    </motion.div>
  );
}

/**
 * 全屏（专注模式）开关。
 *
 * 位置固定在正文区右上角，不跟着正文滚动。静止时是极淡的一个图标 ——
 * 写字的时候它不该抢注意力；悬停才变实。进入之后图标换成收起，
 * 加上 Esc 也能退出（见 Shell）。
 */
function ZenToggle({ zen, onToggle }: { zen: boolean; onToggle: () => void }) {
  const Icon = zen ? Minimize2 : Maximize2;
  const label = zen ? "退出全屏（Esc）" : "全屏编辑";

  return (
    <motion.button
      type="button"
      onClick={onToggle}
      aria-label={label}
      aria-pressed={zen}
      title={label}
      // 进出只淡（CLAUDE.md 动效规矩 1、3）：一直待在自己的图层上；右上角是整数位置，不用对齐
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      whileTap={{ scale: 0.9 }}
      transition={{ ...spring.snappy, opacity: tween.fast }}
      className={cn(
        "absolute right-4 top-[44px] z-40 grid h-8 w-8 place-items-center rounded-lg will-change-[opacity]",
        "text-faint transition-colors duration-[160ms] hover:bg-raised hover:text-ink",
      )}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={zen ? "min" : "max"}
          initial={{ opacity: 0, scale: 0.7, rotate: zen ? -35 : 35 }}
          animate={{ opacity: 1, scale: 1, rotate: 0 }}
          exit={{ opacity: 0, scale: 0.7, rotate: zen ? 35 : -35 }}
          transition={spring.snappy}
          className="grid place-items-center"
        >
          <Icon size={14.5} strokeWidth={2} />
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}

/**
 * 没有内容可显示（一篇笔记都没有、归档是空的）：插画 + 一句话，笔记区再给一个「新建」。
 * 以前是假装成一篇标题叫「还没有笔记」的文档，标题、分隔线、状态栏一样不少。
 */
function EmptyDocument({ empty }: { empty: NonNullable<DocumentModel["empty"]> }) {
  const createNote = useData((s) => s.createNote);
  const selectNote = useApp((s) => s.selectNote);
  return (
    <div className="flex flex-1 items-center justify-center pb-[12vh]">
      <EmptyState
        art={empty.art}
        title={empty.title}
        hint={empty.hint}
        action={
          empty.action === "createNote"
            ? {
                label: "新建笔记",
                onClick: () =>
                  void createNote().then((id) => {
                    if (!id) return;
                    useApp.getState().setFocusRequest({ docKey: `note-${id}`, at: "title" });
                    selectNote(id);
                  }),
              }
            : undefined
        }
      />
    </div>
  );
}

/**
 * 只读正文预览。
 *
 * 做成组件而不是父组件里的一个 useMemo：它主要是编辑器分包加载时的
 * Suspense 占位，而占位只在真正挂起时才会被渲染。写成 memo 之后，
 * 编辑器已经挂上的情况下这段渲染根本不会执行 —— 否则每次自动保存
 * 回填 bodyMd 都要白白重排一遍整篇（90KB 文档约 10ms）。
 */
const DocumentPreview = memo(function DocumentPreview({ markdown }: { markdown: string }) {
  const body = useMemo(() => renderMarkdown(markdown), [markdown]);
  return <article className="prose-doc selectable mt-7">{body}</article>;
});

/** store 里 savingDocs 的键。 */
function saveKey(doc: DocumentModel): string {
  const target = doc.editor?.target;
  if (!target) return "";
  return target.kind === "shared" ? `shared:${target.id}` : saveKeyOf(target);
}

/**
 * 标题按内容自动长高、超出一行就折行。WebView2（Chromium）认 `field-sizing: content`，
 * 文本框自己随内容长高；不认的内核拿 JS 量 scrollHeight，宽度变了（窗口缩放、
 * 进出专注模式）再量一次。
 */
const FIELD_SIZING = typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content");

function useFitHeight(ref: React.RefObject<HTMLTextAreaElement | null>, value: string) {
  const fit = useCallback(() => {
    const field = ref.current;
    if (!field || FIELD_SIZING) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [ref]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 内容变了就要重新量
  useLayoutEffect(fit, [fit, value]);

  useEffect(() => {
    const field = ref.current;
    if (!field || FIELD_SIZING || typeof ResizeObserver === "undefined") return;
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (field.clientWidth === width) return;
      width = field.clientWidth;
      fit();
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [ref, fit]);
}

/**
 * 可编辑的大标题。
 *
 * 是 textarea 不是 input：input 只有一行，标题一长就在框里横着往后滚，
 * 开头那半截被推出去看不见。textarea 按宽度折行、跟着内容长高；
 * 标题本身仍然是一行文字 —— 回车是「写完了」，接着进正文开头；粘贴进来的换行直接去掉。
 * ↓ 也进正文：标题只有一行、或者光标已经在末尾时（折了好几行的话先在标题里往下走）。
 */
export function EditableDocumentTitle({
  title,
  placeholder,
  autoFocus,
  fieldRef: outerRef,
  onEnterBody,
  onSave,
}: {
  title: string;
  /** 当前标题只是占位（还没起名）：输入框留空、显示占位文字 */
  placeholder?: boolean;
  /** 挂上就聚焦（刚新建的那一篇），接完把请求清掉 */
  autoFocus?: boolean;
  /** 上层要从正文回到标题时用 */
  fieldRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** 回车 / ↓：光标进正文开头 */
  onEnterBody?: () => void;
  onSave: (title: string) => Promise<void>;
}) {
  const shown = placeholder ? "" : title;
  const [value, setValue] = useState(shown);
  const [saving, setSaving] = useState(false);
  const localRef = useRef<HTMLTextAreaElement>(null);
  const fieldRef = outerRef ?? localRef;
  // Esc 是「不改了」：它调的 blur() 同步触发 onBlur，那时候这一次渲染里的 value 还是改过的那一版，
  // 不拦的话改动照样被存进去（还会顺手改写别处的 [[旧标题]]）
  const discarding = useRef(false);
  useFitHeight(fieldRef, value);

  useEffect(() => {
    if (!autoFocus) return;
    fieldRef.current?.focus();
    useApp.getState().setFocusRequest(null);
  }, [autoFocus, fieldRef]);

  const toBody = (field: HTMLTextAreaElement) => {
    if (onEnterBody) onEnterBody();
    else field.blur();
  };

  const commit = async () => {
    if (discarding.current) return;
    const clean = value.trim();
    if (!clean) {
      setValue(shown);
      return;
    }
    if (clean === title) return;
    setSaving(true);
    try {
      await onSave(clean);
      setValue(clean);
    } catch {
      setValue(shown);
    } finally {
      setSaving(false);
    }
  };

  return (
    <textarea
      ref={fieldRef}
      rows={1}
      value={value}
      disabled={saving}
      aria-label="笔记标题"
      placeholder={placeholder ? title : undefined}
      spellCheck={false}
      onChange={(event) => setValue(event.target.value.replace(/[\r\n]/g, ""))}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        // 输入法选字时的回车是在上屏，不是写完了
        if (event.nativeEvent.isComposing) return;
        const field = event.currentTarget;
        if (event.key === "Enter") {
          event.preventDefault();
          toBody(field);
        }
        if (event.key === "ArrowDown" && !event.shiftKey) {
          const lineHeight = Number.parseFloat(getComputedStyle(field).lineHeight) || 0;
          const oneLine = field.clientHeight < lineHeight * 1.5;
          const atEnd = field.selectionStart === field.value.length;
          if (oneLine || atEnd) {
            event.preventDefault();
            toBody(field);
          }
        }
        if (event.key === "Escape") {
          discarding.current = true;
          setValue(shown);
          field.blur();
          discarding.current = false;
        }
      }}
      className={cn(
        "block w-full min-w-0 resize-none overflow-hidden border-0 bg-transparent p-0",
        "font-display text-[30px] font-bold leading-[1.25] text-ink outline-none @min-[480px]:text-[38px]",
        "transition-opacity duration-[160ms] [field-sizing:content] placeholder:text-faint",
        saving && "opacity-65",
      )}
    />
  );
}

/** on 持续超过 delay 才变成 true；一变回 false 立刻跟着变 */
function useLingering(on: boolean, delay: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [on, delay]);
  return shown;
}

/** 状态栏分段之间的点 */
function Dot() {
  return (
    <span aria-hidden="true" className="w-[18px] shrink-0 text-center text-faint/50">
      ·
    </span>
  );
}

/** 状态栏右端的小按钮 */
const BAR_BUTTON =
  "grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint transition-colors duration-[140ms]";

/**
 * 正文底下的状态栏：贴着窗口底边，不跟着正文滚（像 Typora）。
 * 最左端是侧栏开关（只有有那一栏的几页才有），接着是字数、日期，右端是保存状态和
 * 历史版本、在文件夹中显示、删除。
 *
 * 2026-10-28 以前它跟在正文最后面，得滚到底才看得见，长文档里几乎没人看到过；
 * 侧栏开关在窄栏左下角，今日TODO、目标没有那一栏，在那两页按它什么都不发生。
 *
 * 不画分隔线，和正文同一个底色：正文滚到跟前是淡掉的（滚动区底下那条渐隐）。
 * 换篇时只有字那一截跟着正文一起溶解（SwapFade）：开关和按钮两边一样，原地不动。
 * 和正文的画布一样往左 chrome 底下多铺 RAIL_WIDTH（见上面的滚动容器）：退出专注模式时 chrome
 * 滑回来，底下这一截也是连着的白底，不露出外层的灰底。
 */
function StatusBar({
  docKey,
  parts,
  panelToggle,
  onDelete,
  onReveal,
  onHistory,
  saving,
  saveError,
  guestCopy,
}: {
  docKey: string;
  parts: string[];
  /** 收起 / 展开窄栏右边那一栏；这一页没有那一栏就不给 */
  panelToggle?: { collapsed: boolean; onToggle: () => void };
  onDelete?: () => void;
  /** 在文件夹中显示这篇文档的文件（每篇都是仓库里的一个 .md） */
  onReveal?: () => void;
  /** 打开这篇的历史版本 */
  onHistory?: () => void;
  saving?: boolean;
  saveError?: string | null;
  /** 做客：本机留着一份主持人还没存下的字（kept），还是都存下了（synced） */
  guestCopy?: GuestCopyState;
}) {
  // 本地保存一般几毫秒就完：每停一下笔就闪一次「保存中…」只是噪音。慢到看得出来才显示
  const slowSave = useLingering(!!saving, 600);
  const ToggleIcon = panelToggle?.collapsed ? PanelLeftOpen : PanelLeftClose;
  const toggleLabel = panelToggle?.collapsed ? "展开侧栏" : "收起侧栏";
  return (
    <footer
      className="relative z-10 flex h-8 shrink-0 items-center gap-1 bg-canvas pr-2.5"
      style={{ marginLeft: -RAIL_WIDTH, paddingLeft: RAIL_WIDTH + (panelToggle ? 6 : 16) }}
    >
      {panelToggle && (
        <button
          type="button"
          onClick={panelToggle.onToggle}
          aria-label={toggleLabel}
          title={toggleLabel}
          className={cn(BAR_BUTTON, "mr-1.5 hover:bg-raised hover:text-ink")}
        >
          <ToggleIcon size={13.5} strokeWidth={1.8} />
        </button>
      )}

      {/* 字数、日期：换篇时跟着正文一起溶解，快照只盖这一截 */}
      <div className="relative h-full min-w-0 flex-1 overflow-hidden" data-swap-host>
        <SwapFade swapKey={docKey} className="flex h-full items-center whitespace-nowrap">
          {parts.map((p, i) => (
            <span key={p} className="flex items-center">
              {i > 0 && <Dot />}
              <span className="font-mono text-[12px] leading-none text-faint">{p}</span>
            </span>
          ))}
        </SwapFade>
      </div>

      {/* 保存状态。以前 store 里记了 error 却没人渲染，自动保存失败时界面上完全看不出来 */}
      {saveError ? (
        <span
          className="flex min-w-0 max-w-[50%] items-center px-1.5"
          role="status"
          title={saveError}
        >
          <AlertTriangle size={11} strokeWidth={2} className="mr-1.5 shrink-0 text-danger" />
          <span className="truncate font-mono text-[12px] leading-none text-danger">
            保存失败：{saveError}
          </span>
        </span>
      ) : (
        slowSave && (
          <span
            className="shrink-0 px-1.5 font-mono text-[12px] leading-none text-muted"
            role="status"
          >
            保存中…
          </span>
        )
      )}
      {/* 做客时这一篇由主持人存：分清「这台电脑上留着」和「主持人已经存下」（docs/协同编辑.md §24） */}
      {guestCopy && (
        <span
          className="shrink-0 px-1.5 font-mono text-[12px] leading-none text-muted"
          role="status"
          title={
            guestCopy === "kept"
              ? "主持人还没存下你刚打的字：这台电脑上另留了一份，断线、关掉也在（回收站里找得到）"
              : "你打的字主持人都存下了"
          }
        >
          {guestCopy === "kept" ? "本机已保留" : "已同步给主持人"}
        </span>
      )}

      {onHistory && (
        <button
          type="button"
          onClick={onHistory}
          aria-label="历史版本"
          title="历史版本"
          className={cn(BAR_BUTTON, "hover:bg-raised hover:text-ink")}
        >
          <History size={13} strokeWidth={1.8} />
        </button>
      )}

      {onReveal && (
        <button
          type="button"
          onClick={onReveal}
          aria-label="在文件夹中显示"
          title="在文件夹中显示"
          className={cn(BAR_BUTTON, "hover:bg-raised hover:text-ink")}
        >
          <FolderOpen size={13} strokeWidth={1.8} />
        </button>
      )}

      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label="删除"
          title="删除（可以撤销）"
          className={cn(BAR_BUTTON, "hover:bg-danger/10 hover:text-danger")}
        >
          <Trash2 size={13} strokeWidth={1.8} />
        </button>
      )}
    </footer>
  );
}
