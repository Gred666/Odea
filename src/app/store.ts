import { within } from "@/data/folders";
import type { DocumentAnchor, DocumentSaveTarget, GoalHorizon, WorkspaceId } from "@/data/types";
import { type ISODate, today } from "@/lib/date";
import { isTauri } from "@/lib/tauri";
import { transitionTheme } from "@/lib/themeTransition";
import { create } from "zustand";
import * as panes from "./panes";
import type { NotePane, PaneLayout, StoredLayout } from "./panes";

export type { NotePane, NoteTab } from "./panes";

export type ThemePref = "system" | "light" | "dark";
/** 笔记列表的排序。「手动」只有逻辑目录有：按树上摆的顺序 */
export type NoteSort = "manual" | "updated" | "created" | "title";

/**
 * 新建之后光标该去哪：标题（还没起名）还是正文开头（起好名了）。
 * 那一篇的标题框 / 编辑器挂上来时消费并清掉；docKey 保证不会落到别的篇上。
 */
export interface FocusRequest {
  docKey: string;
  at: "title" | "body";
}

/** 命令面板能打开、能从那里「返回」命令面板的对话框（components/PaletteBack.tsx） */
export type PaletteDialog =
  | "find"
  | "history"
  | "trash"
  | "sync"
  | "update"
  | "collab"
  | "team"
  | "relays";

/** 从命令面板打开了哪个对话框，回去的时候面板里还是刚才打的字、高亮停在刚才选的那一项 */
export interface PaletteBack {
  dialog: PaletteDialog;
  query: string;
  itemId: string;
}

interface AppState {
  /* ---- 导航 ---- */
  workspace: WorkspaceId;
  /** 导航切换方向，用于让主内容做方向感知的位移动画 */
  navDirection: 1 | -1;
  setWorkspace: (w: WorkspaceId) => void;
  /**
   * 这个仓库开没开日程、归档（data/store 取到仓库信息时调）：没开的话，停在日程那几页、归档的回到文件
   */
  fitLayout: (journal: boolean, archive: boolean) => void;

  /* ---- 各区的选中项 ---- */
  selectedNoteId: string;
  selectedArchiveId: string;
  selectedDate: ISODate;
  /**
   * 「今天」。放进 store 而不是每次 today() 现算：应用开着跨过零点时，
   * 今日TODO、日历上的今天标记都要跟着翻页，得有一个能触发重渲染的信号。
   * 由 startTodayTicker() 在每个零点刷新。
   */
  todayDate: ISODate;
  setTodayDate: (d: ISODate) => void;
  /** 日历右侧的分段：日TODO / 周·月·年 GOAL */
  calendarScope: "day" | "week" | "month" | "year";
  goalHorizon: GoalHorizon;

  /**
   * 在正在写的窗格的当前标签里打开这一篇；这个窗格别的标签里开着就切过去。
   * popout：开在这个弹出窗口里（从那里的正文打开的，见 navigate.ts 的 openDocument）
   */
  selectNote: (id: string, popout?: string | null) => void;
  selectArchive: (id: string) => void;

  /* ---- 笔记的窗格和标签（docs/标签页与分屏.md，规矩在 app/panes.ts）----
     不变式：正在写的那个窗格（activePane）的当前标签就是 selectedNoteId。
     列表高亮、命令面板里的「这一篇」、团队视图照旧只看 selectedNoteId */
  /** 从左到右，至少一个，每个至少一个标签 */
  notePanes: NotePane[];
  activePane: string;
  /** 开在新标签里（默认正在写的窗格，paneId 也可以是弹出窗口的）；那个窗格里已经开着就切过去 */
  openNoteTab: (noteId: string, paneId?: string) => void;
  /** 切到这个标签（它所在的窗格也成了正在写的） */
  switchTab: (tabId: string) => void;
  focusPane: (paneId: string) => void;
  /** 关掉；窗格里只剩它时关掉这个窗格，整个窗口只剩它时不关 */
  closeTab: (tabId: string) => void;
  closeOtherTabs: (tabId: string) => void;
  closeTabsToRight: (tabId: string) => void;
  /** 挪到某个窗格的第 index 个（同一个窗格里就是排顺序） */
  moveTab: (tabId: string, paneId: string, index: number) => void;
  /** 在 paneId 左边 / 右边拆出一栏放这个标签；copy：同一篇再开一个（向右拆分），否则是挪过去 */
  splitTab: (tabId: string, paneId: string, side: "left" | "right", copy: boolean) => void;
  /** 拖完分割条：每个窗格占的比例 */
  resizePanes: (sizes: number[]) => void;
  /** 当前标签往回 / 往前走一步（alive：那一篇还在不在）；popout：那个弹出窗口里的 */
  walkTab: (step: -1 | 1, alive: (noteId: string) => boolean, popout?: string) => void;
  /** 重新打开最近关掉的那个（放进正在写的窗格原来的位置）；不在了的跳过 */
  reopenTab: (alive: (noteId: string) => boolean) => void;
  /**
   * 笔记列表变了：指着已经不在的笔记的标签关掉（别处删掉、归档了）。alive 里没有的都算不在，
   * 所以要等列表取回来以后才调
   */
  pruneTabs: (alive: ReadonlySet<string>) => void;
  /** 笔记的 id 整个换了（开关日程、转成逻辑目录以后按路径认回来）：标签跟着换，认不回来的关掉 */
  remapTabs: (map: (noteId: string) => string | undefined) => void;

  /* ---- 弹出窗口（docs/标签页与分屏.md §16）：一个窗口一个窗格，不进 notePanes ----
     上面那些按标签 id 的动作（切、关、排、往回走）认得出标签在哪个窗口里，各改各的。
     弹出窗口里关掉最后一个标签就是关这个窗口 */
  popouts: NotePane[];
  /**
   * 正在写的是哪个弹出窗口（它有焦点）；null 是主窗口。从正文里打开一篇（双链、反向链接）、
   * Ctrl+Shift+T 作用在它上面。列表栏在主窗口里，点它之前主窗口先拿到焦点，所以列表照旧开在主窗口
   */
  activePopout: string | null;
  setActivePopout: (paneId: string | null) => void;
  /** 拆成弹出窗口：fromTab 从主窗口那一排里拿走，pane 是装着它的新窗格（app/popout.ts 先开好窗口） */
  addPopout: (pane: NotePane, fromTab: string) => void;
  /** 弹出窗口关了：back 时标签回到主窗口（关窗口），不然就丢掉（里面的标签都关掉了） */
  removePopout: (paneId: string, back: boolean) => void;
  /** 弹出窗口里的一个标签挪回主窗口（挪的是最后一个就关掉这个窗口） */
  tabToMain: (tabId: string) => void;

  /**
   * 跳到另一篇之后要滚到的位置：`[[标题#小节]]` 的小节，或反向链接里那一行
   * （正文的行号，从 1 开始），全局搜索的结果还带着那一处命中（选中它）。那一篇的编辑器挂上、
   * 目录算出来之后由正在写的那个窗格的 DocumentView 消费并清掉；docKey 保证不会滚错篇。
   */
  pendingAnchor: ({ docKey: string } & DocumentAnchor) | null;
  setPendingAnchor: (anchor: AppState["pendingAnchor"]) => void;
  selectDate: (d: ISODate) => void;
  setCalendarScope: (s: AppState["calendarScope"]) => void;
  setGoalHorizon: (h: GoalHorizon) => void;

  /* ---- 笔记的文件夹 ---- */
  /** 列表栏现在在哪个文件夹（相对「笔记」，空串是「全部笔记」） */
  noteFolder: string;
  /** 上一次换文件夹的方向：进子文件夹 1、退回上层 -1、跳到不相干的 0（列表按它朝进出的方向挪） */
  noteFolderDir: 1 | -1 | 0;
  setNoteFolder: (folder: string) => void;
  /**
   * 正文区标题上方的路径点了一段：列表栏换到那个文件夹（清掉搜索词、退出专注模式），
   * 并且 noteRevealTick 加一 —— 列表栏据此把选中的那篇滚到看得见的地方
   */
  openNoteFolder: (folder: string) => void;
  noteRevealTick: number;
  /** 列表栏里就地展开了哪些文件夹。记在本机，下次打开还是这样 */
  expandedFolders: Set<string>;
  setFolderExpanded: (paths: string[], open: boolean) => void;
  /** 文件夹改了名 / 删了：当前位置和展开状态跟着换 */
  followFolderRename: (from: string, to: string) => void;
  forgetFolder: (path: string) => void;

  /** 笔记列表的排序，记在本机 */
  noteSort: NoteSort;
  setNoteSort: (sort: NoteSort) => void;
  /** 树上的笔记带不带一行摘要（排序菜单里的开关），记在本机 */
  noteExcerpts: boolean;
  setNoteExcerpts: (on: boolean) => void;

  /** 新建完要把光标放到哪（见 FocusRequest） */
  focusRequest: FocusRequest | null;
  setFocusRequest: (request: FocusRequest | null) => void;

  /* ---- 搜索 ---- */
  noteQuery: string;
  archiveQuery: string;
  setNoteQuery: (q: string) => void;
  setArchiveQuery: (q: string) => void;

  /* ---- 界面 ---- */
  theme: ThemePref;
  /** 换主题；明暗真的变了会播日落 / 日出（lib/themeTransition.ts），播了返回 true */
  setTheme: (t: ThemePref) => boolean;
  reduceMotion: boolean;
  setReduceMotion: (v: boolean) => void;
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  /** 刚从命令面板打开的对话框；那个对话框关掉就清（PaletteBack.tsx） */
  paletteBack: PaletteBack | null;
  setPaletteBack: (v: PaletteBack | null) => void;
  /** 命令面板这次打开要恢复成什么样（从对话框返回的）；面板打开时取走 */
  paletteRestore: PaletteBack | null;
  /** 从对话框回到命令面板：对话框自己关，这里只管把面板按原样打开 */
  backToPalette: () => void;
  /** 全局搜索（components/FindDialog.tsx，Ctrl+Shift+F）。和命令面板一次只开一个 */
  findOpen: boolean;
  /** 打开时搜什么（命令面板里打了字再选「在所有笔记里搜索」）；null = 接着上次的 */
  findSeed: string | null;
  setFindOpen: (open: boolean, seed?: string) => void;
  /** 同步对话框（开启同步 / 同步状态，技术方案 §5.9.9） */
  syncOpen: boolean;
  setSyncOpen: (v: boolean) => void;
  /** 新版本卡片（components/UpdateDialog.tsx）：等着装的新版本 / 升级后的更新说明；null = 关着 */
  updateDialog: "update" | "notes" | null;
  setUpdateDialog: (v: "update" | "notes" | null) => void;
  /** 回收站对话框（components/TrashDialog.tsx）：删掉的笔记、协作时本机留的几份 */
  trashOpen: boolean;
  setTrashOpen: (v: boolean) => void;
  /** 历史版本对话框开着的那一篇（技术方案 §5.9.11）；null = 关着 */
  historyFor: DocumentSaveTarget | null;
  setHistoryFor: (target: DocumentSaveTarget | null) => void;
  /**
   * 窄栏右边那一栏（文件树、日历的月历、归档列表）收起来，给正文让地方（像 VS Code 的侧栏），
   * 记在本机。今日TODO、目标本来就没有这一栏
   */
  panelCollapsed: boolean;
  setPanelCollapsed: (v: boolean) => void;

  /* ---- 专注模式：编辑区铺满整页，只有笔记区有 ---- */
  zen: boolean;
  setZen: (v: boolean) => void;
}

/** 导航顺序 —— 决定切换时主内容往哪个方向位移 */
const NAV_ORDER: WorkspaceId[] = ["notes", "today", "goal", "calendar", "archive", "extensions"];

/** 日程那几页（docs/仓库与启动器.md §6）：仓库开了日程才有。归档单独一个开关，不算在里面 */
export const JOURNAL_WORKSPACES: WorkspaceId[] = ["today", "goal", "calendar"];

const LS_KEY = "odea.prefs";

interface Prefs {
  theme: ThemePref;
  reduceMotion: boolean;
  noteSort: NoteSort;
  noteExcerpts: boolean;
  panelCollapsed: boolean;
}

function loadPrefs(): Prefs {
  const prefs: Prefs = {
    theme: "system",
    reduceMotion: false,
    noteSort: "updated",
    noteExcerpts: false,
    panelCollapsed: false,
  };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p.theme === "light" || p.theme === "dark") prefs.theme = p.theme;
      prefs.reduceMotion = !!p.reduceMotion;
      if (p.noteSort === "created" || p.noteSort === "title" || p.noteSort === "manual")
        prefs.noteSort = p.noteSort;
      prefs.noteExcerpts = !!p.noteExcerpts;
      // 以前的 navCollapsed（导航栏收成图标栏）不接着用：导航栏现在一直是窄栏（P11.2）
      prefs.panelCollapsed = !!p.panelCollapsed;
    }
  } catch {
    /* 隐私模式 / 禁用存储：走默认值 */
  }
  return prefs;
}

function savePrefs(patch: Partial<Prefs>) {
  try {
    const { theme, reduceMotion, noteSort, noteExcerpts, panelCollapsed } = useApp.getState();
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ theme, reduceMotion, noteSort, noteExcerpts, panelCollapsed, ...patch }),
    );
  } catch {
    /* 忽略：偏好丢失不影响使用 */
  }
}

const initialPrefs = loadPrefs();

/* ---- 上次停在哪：重新打开应用回到那个区、那一篇、那个文件夹 ----
   按仓库分开记（docs/仓库与启动器.md §4.2）：一个窗口一个仓库，localStorage 是所有窗口共用的。
   键是「旧键:仓库路径」；main.tsx 在第一帧之前调 restoreVaultSession 换成这个仓库的记录。
   浏览器预览里不分（只有一个假仓库），用旧键 */

const SESSION_KEY = "odea.session";
const EXPANDED_KEY = "odea.folders.expanded";
/** 这个窗口的仓库路径。restoreVaultSession 之前是 null */
let vaultKey: string | null = null;
/** 从旧配置迁过来的那个仓库：自己的记录还没有时读旧的、不分仓库的那份 */
let legacyFallback = true;
const keyOf = (base: string) => (vaultKey === null ? base : `${base}:${vaultKey}`);

function readStored(base: string): string | null {
  const own = localStorage.getItem(keyOf(base));
  if (own !== null || vaultKey === null || !legacyFallback) return own;
  return localStorage.getItem(base);
}

interface Session {
  workspace: WorkspaceId;
  noteId: string;
  archiveId: string;
  noteFolder: string;
  /** 窗格和标签（app/panes.ts 的 StoredLayout）。只有一个标签时不记 */
  layout?: StoredLayout;
  /** P12.1 记的：一个窗格里的标签（笔记 id）。读得懂，不再写 */
  tabs?: string[];
}

function loadSession(): Session {
  const session: Session = { workspace: "notes", noteId: "", archiveId: "", noteFolder: "" };
  try {
    const p = JSON.parse(readStored(SESSION_KEY) ?? "{}");
    // 扩展页还没有运行时，从导航里拿掉了：停在那儿的回到笔记
    if (NAV_ORDER.includes(p.workspace) && p.workspace !== "extensions") {
      session.workspace = p.workspace;
    }
    if (typeof p.noteId === "string") session.noteId = p.noteId;
    if (typeof p.archiveId === "string") session.archiveId = p.archiveId;
    if (typeof p.noteFolder === "string") session.noteFolder = p.noteFolder;
    if (Array.isArray(p.tabs)) {
      const ids = (p.tabs as unknown[]).filter(
        (id): id is string => typeof id === "string" && !!id,
      );
      session.tabs = [...new Set(ids)];
    }
    if (p.layout && typeof p.layout === "object") session.layout = p.layout;
  } catch {
    /* 隐私模式 / 数据损坏：从笔记区开始 */
  }
  return session;
}

/** 记下的样子 → 窗格。P12.1 记的是一排标签，当成一个窗格 */
function layoutOf(session: Session): PaneLayout {
  const stored =
    session.layout ??
    (session.tabs?.length
      ? { panes: [{ tabs: session.tabs, active: 0, size: 1 }], pane: 0 }
      : null);
  return panes.restoreLayout(stored, session.noteId);
}

/** 关掉的标签（这次运行里），Ctrl+Shift+T 从后往前开回来 */
const CLOSED_LIMIT = 20;
let closedTabs: panes.Closed[] = [];

/** 新的布局放进 store：selectedNoteId 跟着正在写的窗格（不变式） */
const laid = (layout: PaneLayout) => ({
  notePanes: layout.panes,
  activePane: layout.activePane,
  selectedNoteId: panes.selectedOf(layout),
});
const layoutOfState = (state: Pick<AppState, "notePanes" | "activePane">): PaneLayout => ({
  panes: state.notePanes,
  activePane: state.activePane,
});

const initialSession = loadSession();
const initialLayout = layoutOf(initialSession);

function loadExpanded(): Set<string> {
  try {
    const raw = JSON.parse(readStored(EXPANDED_KEY) ?? "[]");
    if (Array.isArray(raw)) return new Set(raw.filter((item) => typeof item === "string"));
  } catch {
    /* 隐私模式 / 数据损坏：全部收起 */
  }
  return new Set();
}

function saveExpanded(expanded: Set<string>) {
  try {
    localStorage.setItem(keyOf(EXPANDED_KEY), JSON.stringify([...expanded]));
  } catch {
    /* 忽略：展开状态丢了不影响使用 */
  }
}

/** 文件夹改名：路径换前缀（不在它底下的原样） */
const renamed = (path: string, from: string, to: string) =>
  path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);
/** 从 from 换到 to 是往里走（1）、往外退（-1），还是跳到不相干的地方（0） */
const folderDir = (from: string, to: string): 1 | -1 | 0 =>
  to === from ? 0 : within(to, from) ? 1 : within(from, to) ? -1 : 0;

export const useApp = create<AppState>((set, get) => {
  /**
   * 改一下窗格（app/panes.ts 的纯函数）；没变就不 set。popout：改的是这个弹出窗口（当成只有一栏的布局），
   * 关空了就去掉它（窗口跟着关，components/Popouts.tsx）
   */
  const apply = (change: (layout: PaneLayout) => PaneLayout, popout?: string | null) => {
    if (popout) {
      const pane = get().popouts.find((other) => other.id === popout);
      if (!pane) return;
      const before = panes.asLayout(pane);
      const after = change(before);
      if (after !== before) setPopout(pane.id, panes.popoutPane(pane, after));
      return;
    }
    const before = layoutOfState(get());
    const after = change(before);
    if (after !== before) set(laid(after));
  };
  /** 换掉一个弹出窗口的窗格；null 是关掉它 */
  const setPopout = (paneId: string, pane: NotePane | null) =>
    set((state) => ({
      popouts: pane
        ? state.popouts.map((other) => (other.id === paneId ? pane : other))
        : state.popouts.filter((other) => other.id !== paneId),
      activePopout: !pane && state.activePopout === paneId ? null : state.activePopout,
    }));
  /** 标签在哪个弹出窗口里；在主窗口里是 null */
  const popoutOf = (tabId: string) =>
    get().popouts.find((pane) => pane.tabs.some((tab) => tab.id === tabId))?.id ?? null;
  const isPopout = (paneId?: string | null): paneId is string =>
    !!paneId && get().popouts.some((pane) => pane.id === paneId);
  /** 关掉的记下来给 Ctrl+Shift+T */
  const remember = (closed: panes.Closed[]) => {
    closedTabs = [...closedTabs, ...closed].slice(-CLOSED_LIMIT);
  };
  /** 关标签 */
  const close = (
    change: (layout: PaneLayout) => { layout: PaneLayout; closed: panes.Closed[] },
    popout?: string | null,
  ) =>
    apply((layout) => {
      const { layout: after, closed } = change(layout);
      remember(closed);
      return after;
    }, popout);

  return {
    workspace: initialSession.workspace,
    navDirection: 1,
    setWorkspace: (w) => {
      const from = NAV_ORDER.indexOf(get().workspace);
      const to = NAV_ORDER.indexOf(w);
      if (from === to) return;
      // 离开笔记区就退出专注模式：其它区没有这个入口，留着的话侧栏会一直是收起的，
      // 用户在日历页找不到任何东西可以点回来。
      set({ workspace: w, navDirection: to > from ? 1 : -1, zen: false });
    },
    fitLayout: (journal, archive) => {
      const workspace = get().workspace;
      if (
        (!journal && JOURNAL_WORKSPACES.includes(workspace)) ||
        (!archive && workspace === "archive")
      )
        set({ workspace: "notes" });
    },

    // 上次看的那一篇；不在了（删了、换了仓库）由列表栏退到第一篇
    selectedNoteId: initialSession.noteId,
    selectedArchiveId: initialSession.archiveId,
    // 打开日历就是今天，不用每次手动定位
    selectedDate: today(),
    todayDate: today(),
    setTodayDate: (d) => set({ todayDate: d }),
    calendarScope: "day",
    goalHorizon: "week",

    selectNote: (id, popout) =>
      apply((layout) => panes.navigate(layout, id), isPopout(popout) ? popout : null),
    selectArchive: (id) => set({ selectedArchiveId: id }),

    notePanes: initialLayout.panes,
    activePane: initialLayout.activePane,
    openNoteTab: (noteId, paneId) =>
      apply((layout) => panes.openTab(layout, noteId, paneId), isPopout(paneId) ? paneId : null),
    switchTab: (tabId) => apply((layout) => panes.switchTab(layout, tabId), popoutOf(tabId)),
    focusPane: (paneId) => apply((layout) => panes.focusPane(layout, paneId)),
    closeTab: (tabId) => {
      const popout = get().popouts.find((pane) => pane.tabs.some((tab) => tab.id === tabId));
      if (!popout) {
        close((layout) => panes.closeTab(layout, tabId));
        return;
      }
      // 弹出窗口里关掉最后一个标签：关这个窗口
      const { pane, closed } = panes.closeInPopout(popout, tabId);
      remember(closed);
      setPopout(popout.id, pane);
    },
    closeOtherTabs: (tabId) => close((layout) => panes.closeOthers(layout, tabId), popoutOf(tabId)),
    closeTabsToRight: (tabId) =>
      close((layout) => panes.closeRight(layout, tabId), popoutOf(tabId)),
    moveTab: (tabId, paneId, index) => {
      const popout = popoutOf(tabId);
      // 跨窗口拖不了（指针出了窗口），只有弹出窗口里自己排顺序
      if (popout || isPopout(paneId)) {
        if (popout === paneId)
          apply((layout) => panes.moveTab(layout, tabId, paneId, index), popout);
        return;
      }
      apply((layout) => panes.moveTab(layout, tabId, paneId, index));
    },
    splitTab: (tabId, paneId, side, copy) => {
      if (popoutOf(tabId) || isPopout(paneId)) return;
      apply((layout) => panes.split(layout, tabId, paneId, side, copy));
    },
    resizePanes: (sizes) => apply((layout) => panes.resize(layout, sizes)),
    walkTab: (step, alive, popout) =>
      apply((layout) => panes.walkHistory(layout, step, alive), isPopout(popout) ? popout : null),
    reopenTab: (alive) => {
      // 开回正在写的那个窗口里：弹出窗口里按的 Ctrl+Shift+T 开在弹出窗口里
      const popout = get().activePopout;
      while (closedTabs.length) {
        const last = closedTabs[closedTabs.length - 1]!;
        closedTabs = closedTabs.slice(0, -1);
        if (!alive(last.noteId)) continue;
        apply((layout) => {
          const pane = panes.focusedPane(layout);
          if (pane.tabs.some((tab) => tab.noteId === last.noteId)) {
            return panes.openTab(layout, last.noteId);
          }
          // 放回原来的位置（标签少了就放最后）
          const tab = panes.newTab(last.noteId);
          const tabs = [...pane.tabs];
          tabs.splice(Math.min(last.index, tabs.length), 0, tab);
          return {
            panes: layout.panes.map((other) =>
              other === pane ? { ...pane, tabs, activeTab: tab.id } : other,
            ),
            activePane: pane.id,
          };
        }, popout);
        return;
      }
    },
    pruneTabs: (alive) => {
      apply((layout) => panes.prune(layout, alive));
      for (const pane of get().popouts) apply((layout) => panes.prune(layout, alive), pane.id);
    },
    remapTabs: (map) => {
      apply((layout) => panes.remap(layout, map));
      for (const pane of get().popouts) apply((layout) => panes.remap(layout, map), pane.id);
    },

    popouts: [],
    activePopout: null,
    setActivePopout: (paneId) => {
      if (get().activePopout !== paneId) set({ activePopout: paneId });
    },
    addPopout: (pane, fromTab) =>
      set((state) => ({
        ...laid(panes.takeOut(layoutOfState(state), fromTab)),
        popouts: [...state.popouts, pane],
        activePopout: pane.id,
      })),
    removePopout: (paneId, back) =>
      set((state) => {
        const pane = state.popouts.find((other) => other.id === paneId);
        if (!pane) return {};
        return {
          ...(back ? laid(panes.bringBack(layoutOfState(state), pane.tabs)) : {}),
          popouts: state.popouts.filter((other) => other !== pane),
          activePopout: state.activePopout === paneId ? null : state.activePopout,
        };
      }),
    tabToMain: (tabId) => {
      const popout = get().popouts.find((pane) => pane.tabs.some((tab) => tab.id === tabId));
      const tab = popout?.tabs.find((other) => other.id === tabId);
      if (!popout || !tab) return;
      // 回到主窗口正在写的那个窗格，切过去（这一篇那里已经开着就切到那个）
      const back = panes.bringBack(layoutOfState(get()), [tab]);
      const there = panes.focusedPane(back).tabs.find((other) => other.noteId === tab.noteId);
      set(laid(there ? panes.switchTab(back, there.id) : back));
      setPopout(popout.id, panes.closeInPopout(popout, tabId).pane);
    },
    pendingAnchor: null,
    setPendingAnchor: (pendingAnchor) => set({ pendingAnchor }),
    selectDate: (d) => set({ selectedDate: d }),
    setCalendarScope: (s) => set({ calendarScope: s }),
    setGoalHorizon: (h) => set({ goalHorizon: h }),

    noteFolder: initialSession.noteFolder,
    noteFolderDir: 0,
    setNoteFolder: (folder) =>
      set({ noteFolder: folder, noteFolderDir: folderDir(get().noteFolder, folder) }),
    openNoteFolder: (folder) => {
      // 侧栏收起着的话展开：点路径就是想在树上看到它
      if (get().panelCollapsed) savePrefs({ panelCollapsed: false });
      set((state) => ({
        noteFolder: folder,
        noteFolderDir: folderDir(state.noteFolder, folder),
        noteQuery: "",
        zen: false,
        panelCollapsed: false,
        noteRevealTick: state.noteRevealTick + 1,
      }));
    },
    noteRevealTick: 0,
    expandedFolders: loadExpanded(),
    setFolderExpanded: (paths, open) => {
      const expanded = new Set(get().expandedFolders);
      for (const path of paths) {
        if (open) expanded.add(path);
        else expanded.delete(path);
      }
      saveExpanded(expanded);
      set({ expandedFolders: expanded });
    },
    followFolderRename: (from, to) => {
      const expanded = new Set([...get().expandedFolders].map((path) => renamed(path, from, to)));
      saveExpanded(expanded);
      const current = get().noteFolder;
      const next = renamed(current, from, to);
      set({ expandedFolders: expanded, noteFolder: next, noteFolderDir: folderDir(current, next) });
    },
    forgetFolder: (folder) => {
      const expanded = new Set([...get().expandedFolders].filter((path) => !inside(path, folder)));
      saveExpanded(expanded);
      const current = get().noteFolder;
      // 正待在被删的文件夹（或它底下）里：退到它的上一层
      const parent = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
      const next = inside(current, folder) ? parent : current;
      set({ expandedFolders: expanded, noteFolder: next, noteFolderDir: folderDir(current, next) });
    },
    noteSort: initialPrefs.noteSort,
    setNoteSort: (noteSort) => {
      savePrefs({ noteSort });
      set({ noteSort });
    },
    noteExcerpts: initialPrefs.noteExcerpts,
    setNoteExcerpts: (noteExcerpts) => {
      savePrefs({ noteExcerpts });
      set({ noteExcerpts });
    },
    focusRequest: null,
    setFocusRequest: (focusRequest) => set({ focusRequest }),

    noteQuery: "",
    archiveQuery: "",
    setNoteQuery: (q) => set({ noteQuery: q }),
    setArchiveQuery: (q) => set({ archiveQuery: q }),

    theme: initialPrefs.theme,
    setTheme: (t) => {
      const animated = applyTheme(t, true);
      savePrefs({ theme: t });
      set({ theme: t });
      return animated;
    },
    reduceMotion: initialPrefs.reduceMotion,
    setReduceMotion: (v) => {
      document.documentElement.setAttribute("data-reduce-motion", String(v));
      savePrefs({ reduceMotion: v });
      set({ reduceMotion: v });
    },
    paletteOpen: false,
    setPaletteOpen: (v) => set(v ? { paletteOpen: true, findOpen: false } : { paletteOpen: false }),
    paletteBack: null,
    setPaletteBack: (paletteBack) => set({ paletteBack }),
    paletteRestore: null,
    backToPalette: () =>
      set((s) => ({
        paletteOpen: true,
        findOpen: false,
        paletteRestore: s.paletteBack,
        paletteBack: null,
      })),
    findOpen: false,
    findSeed: null,
    setFindOpen: (open, seed) =>
      set(
        open ? { findOpen: true, findSeed: seed ?? null, paletteOpen: false } : { findOpen: false },
      ),
    syncOpen: false,
    setSyncOpen: (v) => set({ syncOpen: v }),
    updateDialog: null,
    setUpdateDialog: (v) => set({ updateDialog: v }),
    trashOpen: false,
    setTrashOpen: (v) => set({ trashOpen: v }),
    historyFor: null,
    setHistoryFor: (target) => set({ historyFor: target }),
    panelCollapsed: initialPrefs.panelCollapsed,
    setPanelCollapsed: (panelCollapsed) => {
      savePrefs({ panelCollapsed });
      // 专注模式下侧栏推在屏幕外面：在命令面板里收起 / 展开它，就是想看见它
      set({ panelCollapsed, zen: false });
    },

    zen: false,
    setZen: (v) => set({ zen: v }),
  };
});

/* ============================================================
   主题：始终在 <html> 上落一个明确的 data-theme。
   不留「未指定」态 —— 否则 Tailwind 的 dark: 变体在系统暗色下不生效。
   ============================================================ */

const mq = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

/** animate：明暗真的变了就播日落 / 日出；启动时那一次直接落定。播了返回 true */
export function applyTheme(pref: ThemePref, animate = false): boolean {
  const resolved = pref === "system" ? (mq?.matches ? "dark" : "light") : pref;
  const write = () => document.documentElement.setAttribute("data-theme", resolved);
  let animated = false;
  if (animate) animated = transitionTheme(resolved === "dark", write);
  else write();
  try {
    localStorage.setItem("odea.theme", pref === "system" ? "" : pref);
  } catch {
    /* 忽略 */
  }
  return animated;
}

/**
 * 这个窗口开的是哪个仓库（main.tsx 在第一帧之前调）：换成这个仓库的「上次停在哪」和展开的文件夹，
 * 以后都记到它的键上。`legacy`：从旧配置迁过来的那个仓库，自己的记录还没有时读旧的那份
 */
export function restoreVaultSession(root: string, legacy: boolean) {
  vaultKey = root;
  legacyFallback = legacy;
  const session = loadSession();
  useApp.setState({
    workspace: session.workspace,
    selectedArchiveId: session.archiveId,
    noteFolder: session.noteFolder,
    ...laid(layoutOf(session)),
    expandedFolders: loadExpanded(),
  });
}

/** 在 main.tsx 调一次：应用初始偏好并跟随系统变化，记下每次停在哪 */
export function initPreferences() {
  const { theme, reduceMotion } = useApp.getState();
  applyTheme(theme);
  document.documentElement.setAttribute("data-reduce-motion", String(reduceMotion));

  // 换了区、换了篇、换了文件夹、开关了标签就记一下（只是几个字符串，不用节流）。
  // 桌面端在知道是哪个仓库之前不记：记下的会是还没换成这个仓库记录的初始值
  let last = "";
  useApp.subscribe((state) => {
    if (isTauri && vaultKey === null) return;
    const session: Session = {
      workspace: state.workspace,
      noteId: state.selectedNoteId,
      archiveId: state.selectedArchiveId,
      noteFolder: state.noteFolder,
      ...(() => {
        // 弹出窗口不记：下次打开时它们的标签在主窗口里（和关掉弹出窗口一样）
        const layout = panes.storeLayout(
          panes.bringBack(
            layoutOfState(state),
            state.popouts.flatMap((pane) => pane.tabs),
          ),
        );
        return layout ? { layout } : {};
      })(),
    };
    const json = JSON.stringify(session);
    if (json === last) return;
    last = json;
    try {
      localStorage.setItem(keyOf(SESSION_KEY), json);
    } catch {
      /* 忽略：下次从笔记区开始而已 */
    }
  });

  mq?.addEventListener("change", () => {
    // 跟随系统时系统换了明暗（比如到点自动切暗色）：一样播日落 / 日出
    if (useApp.getState().theme === "system") applyTheme("system", true);
  });
}

/** 当前工作区是否有中列表栏（今日TODO 和 GOAL 是两栏布局） */
export function hasListColumn(w: WorkspaceId): boolean {
  return w === "notes" || w === "calendar" || w === "archive";
}

/** 中列表栏的宽度。进出场时它要从导航栏底下滑出来 / 滑回去，位移就是这么宽（见 Shell）。 */
export const LIST_WIDTH = 300;

/**
 * 最左边那条窄栏（Sidebar）的宽度。64 是算出来的：导航项左右各留 12、图标再往里 12，
 * 图标中心落在 31.5。2026-10-20 以前它能展开成 240 宽带字的导航，P11.2 起一直是窄栏
 */
export const NAV_WIDTH = 64;

/**
 * 左侧 chrome 最宽时的总宽：窄栏 64 + 列表栏 300。
 * 正文的画布往它底下多铺这么宽（见 DocumentView）；列表栏收起时多铺的那一截压在窗口外面，不碍事。
 */
export const RAIL_WIDTH = NAV_WIDTH + LIST_WIDTH;

/** 现在左侧 chrome 有多宽：专注模式要把这一整条推出去 */
export const chromeWidth = (listShown: boolean) => NAV_WIDTH + (listShown ? LIST_WIDTH : 0);

/**
 * 零点翻页：把 todayDate 刷成新的一天，并把日历上还停在昨天的选择带过去。
 * 用 setTimeout 对准下一个零点，而不是每分钟轮询；睡眠唤醒后 setTimeout
 * 可能晚点，所以醒来（visibilitychange）时再对一次表。
 */
export function startTodayTicker(): () => void {
  let timer = 0;

  const sync = () => {
    const now = today();
    const state = useApp.getState();
    if (state.todayDate !== now) {
      const followed = state.selectedDate === state.todayDate;
      useApp.setState({ todayDate: now, ...(followed ? { selectedDate: now } : {}) });
    }
    schedule();
  };

  const schedule = () => {
    window.clearTimeout(timer);
    const next = new Date();
    next.setHours(24, 0, 0, 500);
    timer = window.setTimeout(sync, Math.max(1000, next.getTime() - Date.now()));
  };

  const onVisible = () => {
    if (document.visibilityState === "visible") sync();
  };
  document.addEventListener("visibilitychange", onVisible);
  schedule();

  return () => {
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

export { NAV_ORDER, today };
