import { within } from "@/data/folders";
import type { DocumentAnchor, DocumentRef, VaultLayout, WorkspaceId } from "@/data/types";
import { FLARE_RADIUS, footprintOf } from "@/lib/edgeShape";
import { isTauri } from "@/lib/tauri";
import { transitionTheme } from "@/lib/themeTransition";
import { navIds, navItemOf } from "@/plugins/registry";
import { create } from "zustand";
import * as panes from "./panes";
import type { NotePane, PaneLayout, StoredLayout } from "./panes";
import {
  DEFAULT_BODY_SIZE,
  DEFAULT_MEASURE,
  type Measure,
  applyTypography,
  isBodySize,
  isMeasure,
} from "./typography";

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

/**
 * 内置插件自己的对话框（贡献点 commands 的 dialog，docs/插件与跨端.md §5.3.1）：`plugin:<插件 id>.<对话框>`。
 * 只能是这个前缀，插件冒充不了核心的对话框
 */
export type PluginDialog = `plugin:${string}`;

/** 命令面板能打开、能从那里「返回」命令面板的对话框（components/PaletteBack.tsx） */
export type PaletteDialog =
  | PluginDialog
  | "find"
  | "history"
  | "trash"
  | "sync"
  | "update"
  | "collab"
  | "team"
  | "relays"
  | "export"
  | "capture";

/** 导出对话框（components/ExportDialog.tsx）：PDF 的页面设置，或者导出整个文件夹 */
export type ExportDialogState = { kind: "page" } | { kind: "folder"; folder: string };

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
   * 这个仓库的摆法定了（data/store 取到仓库信息时调）：停在没开的插件的页、没开的归档、认不出来的页的，回到文件
   */
  fitLayout: (layout: VaultLayout) => void;
  /**
   * 插件的页里换了要看的那一篇（日历点到另一天）：pageTick 加一。做客时共享的那一篇据此收起来（collab/store），
   * 和换区、换篇一样
   */
  pageTick: number;
  touchPage: () => void;

  /* ---- 各区的选中项 ---- */
  selectedNoteId: string;
  selectedArchiveId: string;

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
  /**
   * 开在正在写的那个窗格旁边的窗格里，没有就向右拆出一栏（白板上双击引用卡片，docs/白板.md §13.9）。
   * 正在写的是弹出窗口的就在那个窗口里
   */
  openNoteBeside: (noteId: string) => void;
  /** 切到这个标签（它所在的窗格也成了正在写的） */
  switchTab: (tabId: string) => void;
  /** 换一个标签的摆法（白板，docs/白板.md §13.4）；undefined 是文档。主窗口、弹出窗口里的都认 */
  setTabView: (tabId: string, view: string | undefined) => void;
  focusPane: (paneId: string) => void;
  /** 关掉；窗格里只剩它时关掉这个窗格，整个窗口只剩它时不关 */
  closeTab: (tabId: string) => void;
  closeOtherTabs: (tabId: string) => void;
  closeTabsToRight: (tabId: string) => void;
  /**
   * 挪到某个窗格的第 index 个（同一个窗格里就是排顺序）。那个窗格可以在另一个窗口里（跨窗口拖标签，
   * docs/标签页与分屏.md §20.4）：从原来的窗口拿走（弹出窗口拿空了就关），那个窗口成了正在写的
   */
  moveTab: (tabId: string, paneId: string, index: number) => void;
  /**
   * 在 paneId 左边 / 右边拆出一栏放这个标签；copy：同一篇再开一个（向右拆分），否则是挪过去（也能挪到
   * 另一个窗口里拆）
   */
  splitTab: (tabId: string, paneId: string, side: "left" | "right", copy: boolean) => void;
  /** 拖完分割条：每个窗格占的比例。popout：那个弹出窗口里的 */
  resizePanes: (sizes: number[], popout?: string | null) => void;
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

  /* ---- 弹出窗口（docs/标签页与分屏.md §16、§20）：一个窗口一排窗格（能分屏），不进 notePanes ----
     上面那些按标签 id 的动作（切、关、排、往回走）认得出标签在哪个窗口里，各改各的。
     弹出窗口里关掉最后一个标签就是关这个窗口 */
  popouts: panes.PopoutLayout[];
  /**
   * 正在写的是哪个弹出窗口（它有焦点）；null 是主窗口。从正文里打开一篇（双链、反向链接）、
   * Ctrl+Shift+T 作用在它上面。列表栏在主窗口里，点它之前主窗口先拿到焦点，所以列表照旧开在主窗口
   */
  activePopout: string | null;
  setActivePopout: (paneId: string | null) => void;
  /**
   * 拆成弹出窗口：fromTab 从它所在的窗口里拿走（主窗口、或者另一个弹出窗口，拿空了就关），popout 是装着它的
   * 新窗口（app/popout.ts 先开好窗口）。fromTab 是 null：重开记下的弹出窗口（标签本来就不在别的窗口里），
   * 也不抢「正在写的」
   */
  addPopout: (popout: panes.PopoutLayout, fromTab: string | null) => void;
  /** 弹出窗口关了：back 时标签回到主窗口（关窗口），不然就丢掉（里面的标签都关掉了） */
  removePopout: (paneId: string, back: boolean) => void;
  /** 弹出窗口里的一个标签挪回主窗口正在写的那个窗格、切过去（挪的是最后一个就关掉这个窗口） */
  tabToMain: (tabId: string) => void;

  /**
   * 跳到另一篇之后要滚到的位置：`[[标题#小节]]` 的小节，或反向链接里那一行
   * （正文的行号，从 1 开始），全局搜索的结果还带着那一处命中（选中它）。那一篇的编辑器挂上、
   * 目录算出来之后由正在写的那个窗格的 DocumentView 消费并清掉；docKey 保证不会滚错篇。
   */
  pendingAnchor: ({ docKey: string } & DocumentAnchor) | null;
  setPendingAnchor: (anchor: AppState["pendingAnchor"]) => void;

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
  /** 正文字号（px，typography.ts 的 BODY_SIZES 里的一档），记在本机 */
  bodySize: number;
  setBodySize: (px: number) => void;
  /** 正文那一列每行最多几个字（窄 / 标准 / 宽 / 铺满），记在本机 */
  measure: Measure;
  setMeasure: (measure: Measure) => void;
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
  historyFor: DocumentRef | null;
  setHistoryFor: (target: DocumentRef | null) => void;
  /** 导出对话框（页面设置、导出整个文件夹）；null = 关着 */
  exportDialog: ExportDialogState | null;
  setExportDialog: (v: ExportDialogState | null) => void;
  /** 全局快捷键速记的设置（components/CaptureSettingsDialog.tsx） */
  captureSettingsOpen: boolean;
  setCaptureSettingsOpen: (v: boolean) => void;
  /**
   * 侧栏（从刘海往下长的那一栏：文件树、归档列表、插件的侧栏：日历的月历）收回刘海里，给正文让地方
   * （像 VS Code 的侧栏），记在本机。没有侧栏的页（今日TODO、目标）本来就只剩刘海
   */
  panelCollapsed: boolean;
  setPanelCollapsed: (v: boolean) => void;

  /* ---- 专注模式：编辑区铺满整页，只有笔记区有 ---- */
  zen: boolean;
  setZen: (v: boolean) => void;
}

/**
 * 导航顺序 —— 决定切换时主内容往哪个方向位移：文件在最前，插件的那几项按它们的 order，归档、扩展页在最后；
 * 开着的 L0 插件能调（清单的 navOrder，plugins/registry.ts 的 navIds）
 */
export function navOrder(): WorkspaceId[] {
  return navIds();
}

const LS_KEY = "odea.prefs";

interface Prefs {
  theme: ThemePref;
  reduceMotion: boolean;
  bodySize: number;
  measure: Measure;
  noteSort: NoteSort;
  noteExcerpts: boolean;
  panelCollapsed: boolean;
}

function loadPrefs(): Prefs {
  const prefs: Prefs = {
    theme: "system",
    reduceMotion: false,
    bodySize: DEFAULT_BODY_SIZE,
    measure: DEFAULT_MEASURE,
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
      if (isBodySize(p.bodySize)) prefs.bodySize = p.bodySize;
      if (isMeasure(p.measure)) prefs.measure = p.measure;
      if (p.noteSort === "created" || p.noteSort === "title" || p.noteSort === "manual")
        prefs.noteSort = p.noteSort;
      prefs.noteExcerpts = !!p.noteExcerpts;
      // 以前的 navCollapsed（导航栏收成图标栏）不接着用：P11.2 起导航栏是常驻的窄栏，2026-11-20 起是左上角的刘海（docs/边栏.md）
      prefs.panelCollapsed = !!p.panelCollapsed;
    }
  } catch {
    /* 隐私模式 / 禁用存储：走默认值 */
  }
  return prefs;
}

function savePrefs(patch: Partial<Prefs>) {
  try {
    const { theme, reduceMotion, bodySize, measure, noteSort, noteExcerpts, panelCollapsed } =
      useApp.getState();
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        theme,
        reduceMotion,
        bodySize,
        measure,
        noteSort,
        noteExcerpts,
        panelCollapsed,
        ...patch,
      }),
    );
  } catch {
    /* 忽略：偏好丢失不影响使用 */
  }
}

const initialPrefs = loadPrefs();

/* ---- 上次停在哪：重新打开应用回到那个区、那一篇、那个文件夹 ----
   按仓库分开记（docs/仓库与启动器.md §4.2）：一个窗口一个仓库，localStorage 是所有窗口共用的。
   键是「旧键:仓库路径」；boot/vault.tsx 在第一帧之前调 restoreVaultSession 换成这个仓库的记录。
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
  /** 开着的弹出窗口：里面的标签、窗口在屏幕上的位置（docs/标签页与分屏.md §20.3）。下次打开仓库时重开 */
  popouts?: panes.StoredPopout[];
}

function loadSession(): Session {
  const session: Session = { workspace: "notes", noteId: "", archiveId: "", noteFolder: "" };
  try {
    const p = JSON.parse(readStored(SESSION_KEY) ?? "{}");
    // 插件的页（今日TODO ……）这时还认不出来（插件在这之后才装上）：先照记的放着，
    // 取到仓库的摆法时 fitLayout 再核对。扩展页 P14.2 起回到了导航上，停在那儿的照旧回到那儿
    if (typeof p.workspace === "string" && p.workspace) {
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
    if (Array.isArray(p.popouts)) session.popouts = p.popouts;
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
/** 记下的弹出窗口，等界面起来以后重开（app/popout.ts 的 reopenPopouts）；拿走一次就没了 */
let pendingPopouts: panes.StoredPopout[] = initialSession.popouts ?? [];

export function takePendingPopouts(): panes.StoredPopout[] {
  const taken = pendingPopouts;
  pendingPopouts = [];
  return taken;
}

/** 弹出窗口在屏幕上的位置（app/popout.ts 给：store 不引它，它引 store） */
let popoutBounds: (paneId: string) => panes.PopoutBounds | null = () => null;
export function providePopoutBounds(get: (paneId: string) => panes.PopoutBounds | null) {
  popoutBounds = get;
}

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
   * 改一下窗格（app/panes.ts 的纯函数）；没变就不 set。popout：改的是这个弹出窗口（它也是一个布局），
   * 关空了就去掉它（窗口跟着关，app/popout.ts）
   */
  const apply = (change: (layout: PaneLayout) => PaneLayout, popout?: string | null) => {
    if (popout) {
      const before = popoutById(popout);
      if (!before) return;
      const after = change(before);
      if (after !== before) setPopout(before.id, panes.popoutAfter(before, after));
      return;
    }
    const before = layoutOfState(get());
    const after = change(before);
    if (after !== before) set(laid(after));
  };
  const popoutById = (id: string) => get().popouts.find((popout) => popout.id === id);
  /** 换掉一个弹出窗口；null 是关掉它 */
  const setPopout = (id: string, popout: panes.PopoutLayout | null) =>
    set((state) => ({
      popouts: popout
        ? state.popouts.map((other) => (other.id === id ? popout : other))
        : state.popouts.filter((other) => other.id !== id),
      activePopout: !popout && state.activePopout === id ? null : state.activePopout,
    }));
  /** 标签在哪个弹出窗口里；在主窗口里是 null */
  const popoutOf = (tabId: string) =>
    get().popouts.find((popout) => !!panes.paneOfTab(popout, tabId))?.id ?? null;
  /** 窗格在哪个弹出窗口里（弹出窗口自己的 id 也认：指的是它正在写的那个窗格）；在主窗口里是 null */
  const windowOfPane = (paneId?: string | null) =>
    (paneId &&
      get().popouts.find(
        (popout) => popout.id === paneId || popout.panes.some((pane) => pane.id === paneId),
      )?.id) ||
    null;
  /**
   * 一个标签挪到另一个窗口的 paneId 窗格（§20.4）：从原来的窗口拿走（不记进「最近关掉的」，弹出窗口拿空了就关），
   * 放进去（panes.adopt），那个窗口成了正在写的
   */
  const moveAcross = (tabId: string, paneId: string, where: number | "left" | "right") => {
    const from = popoutOf(tabId);
    const to = windowOfPane(paneId);
    const source = from ? popoutById(from) : layoutOfState(get());
    const tab = source && panes.tabsOf(source).find((other) => other.id === tabId);
    if (!tab?.noteId) return;
    if (from) setPopout(from, panes.closeInPopout(popoutById(from)!, tabId).popout);
    else set(laid(panes.takeOut(layoutOfState(get()), tabId)));
    apply((layout) => panes.adopt(layout, tab, paneId, where), to);
    get().setActivePopout(to);
  };
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
      if (w === get().workspace) return;
      const order = navOrder();
      const from = order.indexOf(get().workspace);
      const to = order.indexOf(w);
      // 离开笔记区就退出专注模式：其它区没有这个入口，留着的话侧栏会一直是收起的，
      // 用户在日历页找不到任何东西可以点回来。
      set({ workspace: w, navDirection: to > from ? 1 : -1, zen: false });
    },
    fitLayout: (layout) => {
      const workspace = get().workspace;
      const item = navItemOf(workspace);
      // 扩展页一直在（和以前一样，开关插件时停在那儿不动）；归档看开关；插件的页看插件开没开
      const fits =
        workspace === "notes" ||
        workspace === "extensions" ||
        (workspace === "archive" && layout.archive) ||
        (!!item && layout.plugins.includes(item.plugin));
      if (!fits) set({ workspace: "notes" });
    },
    pageTick: 0,
    touchPage: () => set((state) => ({ pageTick: state.pageTick + 1 })),

    // 上次看的那一篇；不在了（删了、换了仓库）由列表栏退到第一篇
    selectedNoteId: initialSession.noteId,
    selectedArchiveId: initialSession.archiveId,

    selectNote: (id, popout) => apply((layout) => panes.navigate(layout, id), windowOfPane(popout)),
    selectArchive: (id) => set({ selectedArchiveId: id }),

    notePanes: initialLayout.panes,
    activePane: initialLayout.activePane,
    openNoteTab: (noteId, paneId) => {
      const popout = windowOfPane(paneId);
      // 指名的是弹出窗口自己：开在它正在写的那个窗格里
      const pane = paneId === popout ? undefined : paneId;
      apply((layout) => panes.openTab(layout, noteId, pane), popout);
    },
    openNoteBeside: (noteId) =>
      apply((layout) => panes.openBeside(layout, noteId), get().activePopout),
    switchTab: (tabId) => apply((layout) => panes.switchTab(layout, tabId), popoutOf(tabId)),
    setTabView: (tabId, view) =>
      apply((layout) => panes.setTabView(layout, tabId, view), popoutOf(tabId)),
    focusPane: (paneId) => apply((layout) => panes.focusPane(layout, paneId), windowOfPane(paneId)),
    closeTab: (tabId) => {
      const popout = popoutOf(tabId);
      if (!popout) {
        close((layout) => panes.closeTab(layout, tabId));
        return;
      }
      // 弹出窗口里关掉最后一个标签：关这个窗口
      const { popout: after, closed } = panes.closeInPopout(popoutById(popout)!, tabId);
      remember(closed);
      setPopout(popout, after);
    },
    closeOtherTabs: (tabId) => close((layout) => panes.closeOthers(layout, tabId), popoutOf(tabId)),
    closeTabsToRight: (tabId) =>
      close((layout) => panes.closeRight(layout, tabId), popoutOf(tabId)),
    moveTab: (tabId, to, index) => {
      // 指名的是弹出窗口自己：它正在写的那个窗格
      const paneId = popoutById(to)?.activePane ?? to;
      const popout = popoutOf(tabId);
      if (popout !== windowOfPane(paneId)) moveAcross(tabId, paneId, index);
      else apply((layout) => panes.moveTab(layout, tabId, paneId, index), popout);
    },
    splitTab: (tabId, to, side, copy) => {
      const paneId = popoutById(to)?.activePane ?? to;
      const popout = popoutOf(tabId);
      if (popout === windowOfPane(paneId)) {
        apply((layout) => panes.split(layout, tabId, paneId, side, copy), popout);
      } else if (!copy) moveAcross(tabId, paneId, side);
    },
    resizePanes: (sizes, popout) =>
      apply((layout) => panes.resize(layout, sizes), windowOfPane(popout)),
    walkTab: (step, alive, popout) =>
      apply((layout) => panes.walkHistory(layout, step, alive), windowOfPane(popout)),
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
    addPopout: (popout, fromTab) => {
      // 从别的弹出窗口里拖出来的：那边拿走（拿空了那个窗口关掉）。拿走和加上要在同一次 set 里：
      // 新窗口已经开好了、还不在 popouts 里，中间多一次 set 的话 app/popout.ts 会当它是去掉了的、把它关掉
      const source = fromTab ? popoutOf(fromTab) : null;
      set((state) => {
        let popouts = state.popouts;
        if (source && fromTab) {
          const from = popouts.find((other) => other.id === source)!;
          const after = panes.closeInPopout(from, fromTab).popout;
          popouts = after
            ? popouts.map((other) => (other === from ? after : other))
            : popouts.filter((other) => other !== from);
        }
        return {
          ...(fromTab && !source ? laid(panes.takeOut(layoutOfState(state), fromTab)) : {}),
          popouts: [...popouts, popout],
          activePopout: fromTab ? popout.id : state.activePopout,
        };
      });
    },
    removePopout: (id, back) =>
      set((state) => {
        const popout = state.popouts.find((other) => other.id === id);
        if (!popout) return {};
        return {
          ...(back ? laid(panes.bringBack(layoutOfState(state), panes.tabsOf(popout))) : {}),
          popouts: state.popouts.filter((other) => other !== popout),
          activePopout: state.activePopout === id ? null : state.activePopout,
        };
      }),
    tabToMain: (tabId) => {
      const id = popoutOf(tabId);
      const popout = id ? popoutById(id) : undefined;
      const tab = popout && panes.tabsOf(popout).find((other) => other.id === tabId);
      if (!popout || !tab) return;
      // 回到主窗口正在写的那个窗格的最后，切过去（这一篇那里已经开着就切到那个）
      const main = layoutOfState(get());
      set(laid(panes.adopt(main, tab, main.activePane, Number.POSITIVE_INFINITY)));
      setPopout(popout.id, panes.closeInPopout(popout, tabId).popout);
    },
    pendingAnchor: null,
    setPendingAnchor: (pendingAnchor) => set({ pendingAnchor }),

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
    bodySize: initialPrefs.bodySize,
    setBodySize: (bodySize) => {
      if (!isBodySize(bodySize)) return;
      applyTypography(bodySize, get().measure);
      savePrefs({ bodySize });
      set({ bodySize });
    },
    measure: initialPrefs.measure,
    setMeasure: (measure) => {
      applyTypography(get().bodySize, measure);
      savePrefs({ measure });
      set({ measure });
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
    exportDialog: null,
    setExportDialog: (v) => set({ exportDialog: v }),
    captureSettingsOpen: false,
    setCaptureSettingsOpen: (v) => set({ captureSettingsOpen: v }),
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
 * 这个窗口开的是哪个仓库（boot/vault.tsx 在第一帧之前调）：换成这个仓库的「上次停在哪」和展开的文件夹，
 * 以后都记到它的键上。`legacy`：从旧配置迁过来的那个仓库，自己的记录还没有时读旧的那份
 */
export function restoreVaultSession(root: string, legacy: boolean) {
  vaultKey = root;
  legacyFallback = legacy;
  const session = loadSession();
  pendingPopouts = session.popouts ?? [];
  useApp.setState({
    workspace: session.workspace,
    selectedArchiveId: session.archiveId,
    noteFolder: session.noteFolder,
    ...laid(layoutOf(session)),
    expandedFolders: loadExpanded(),
  });
}

/** 每种窗口启动时调一次（src/boot/）：应用初始偏好并跟随系统变化，记下每次停在哪 */
let lastSession = "";
let persistSession: (state: AppState) => void = () => {};

/** 现在就记一次（弹出窗口挪了地方、改了大小：store 没变，关窗口之前补记一下位置） */
export function saveSessionNow(): void {
  persistSession(useApp.getState());
}

export function initPreferences() {
  const { theme, reduceMotion, bodySize, measure } = useApp.getState();
  applyTheme(theme);
  applyTypography(bodySize, measure);
  document.documentElement.setAttribute("data-reduce-motion", String(reduceMotion));

  // 换了区、换了篇、换了文件夹、开关了标签就记一下（只是几个字符串，不用节流）。
  // 桌面端在知道是哪个仓库之前不记：记下的会是还没换成这个仓库记录的初始值
  persistSession = (state: AppState) => {
    if (isTauri && vaultKey === null) return;
    // 弹出窗口记着（下次打开仓库时重开在原来的地方，docs/标签页与分屏.md §20.3）；
    // 重开不了的（浏览器预览、窗口开不出来）那时候再把标签放回主窗口
    const layout = panes.storeLayout(layoutOfState(state));
    const popouts = state.popouts
      .map((popout) => panes.storePopout(popout, popoutBounds(popout.id)))
      .filter((popout): popout is panes.StoredPopout => popout !== null);
    const session: Session = {
      workspace: state.workspace,
      noteId: state.selectedNoteId,
      archiveId: state.selectedArchiveId,
      noteFolder: state.noteFolder,
      ...(layout ? { layout } : {}),
      ...(popouts.length ? { popouts } : {}),
    };
    const json = JSON.stringify(session);
    if (json === lastSession) return;
    lastSession = json;
    try {
      localStorage.setItem(keyOf(SESSION_KEY), json);
    } catch {
      /* 忽略：下次从笔记区开始而已 */
    }
  };
  useApp.subscribe((state) => persistSession(state));

  mq?.addEventListener("change", () => {
    // 跟随系统时系统换了明暗（比如到点自动切暗色）：一样播日落 / 日出
    if (useApp.getState().theme === "system") applyTheme("system", true);
  });
}

/** 当前工作区有没有侧栏（从刘海往下长的那一栏）：文件、归档有；插件的页看它的导航项带不带（日历带，今日TODO 和 GOAL 只剩刘海） */
export function hasListColumn(w: WorkspaceId): boolean {
  return w === "notes" || w === "archive" || !!navItemOf(w)?.List;
}

/**
 * 侧栏长多高（docs/边栏.md §4.2）：full 拉到窗口底边（文件、归档，插件默认），fit 只长到内容那么高（日历）；
 * 没有侧栏的页是 null
 */
export function panelOf(w: WorkspaceId): "full" | "fit" | null {
  if (!hasListColumn(w)) return null;
  return navItemOf(w)?.panel ?? "full";
}

/** 侧栏的宽度：永远 300，导航有几项都不变（docs/边栏.md §4.3） */
export const LIST_WIDTH = 300;

/** 刘海的高（docs/边栏.md §3.4：两个角 17.9 + 23.9，剩 6.2 的直边） */
export const NOTCH_HEIGHT = 48;
/** 刘海里最多几格：300 宽放得下「O」+ 6 格，第 7 项起最后一格换成「⋯」 */
export const NOTCH_MAX_CELLS = 6;

/** 刘海多宽：左边 12 +「O」28 + 8，每格 36、间隔 4，右边 12（docs/边栏.md §4.3） */
export const notchWidth = (cells: number) => 56 + 40 * cells;

/** 贴边的凹弯伸出去多宽（R=12，17.9）：标签栏、专注模式按它让 */
export const FLARE_WIDTH = Math.ceil(footprintOf(FLARE_RADIUS));

/**
 * 左侧 chrome（刘海 + 侧栏，整块 rail 色）最宽多宽。
 * 正文的画布往它底下多铺这么宽（见 DocumentView）：退出专注模式时它滑回来，底下是连着的白。
 * 侧栏收起时多铺的那一截压在窗口外面，不碍事
 */
export const RAIL_WIDTH = LIST_WIDTH;

/** 现在左侧 chrome 露出来多宽（含右上那处凹弯）：专注模式要把这一整块推出去 */
export const chromeWidth = (panelShown: boolean, notch: number) =>
  (panelShown ? LIST_WIDTH : notch) + FLARE_WIDTH;
