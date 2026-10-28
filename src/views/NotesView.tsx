import { selectNeighbor } from "@/app/navigate";
import { type NoteSort, useApp } from "@/app/store";
import { EmptyState } from "@/components/EmptyArt";
import {
  ColumnButton,
  GroupLabel,
  ListColumn,
  MoreRows,
  ROW_BATCH,
  useRowBatch,
} from "@/components/ListColumn";
import { ActionMenu, type MenuAction, RowMenu } from "@/components/RowMenu";
import { SearchInput } from "@/components/SearchInput";
import { conflictOriginalTitle, conflictTarget } from "@/data/conflicts";
import {
  UNSORTED,
  childFolders,
  cleanFolderName,
  countIn,
  folderLabel,
  folderName,
  folderOf,
  manualKey,
  nameOf,
  parentOf,
  renamedPath,
  rootLabel,
  shortcutsIn,
  smartQuery,
  uniqueChild,
  within,
} from "@/data/folders";
import { useData } from "@/data/store";
import { type Shortcut, moveBranch } from "@/data/tree";
import type { NoteSummary, TreeFile } from "@/data/types";
import { cn } from "@/lib/cn";
import { animatedEmojiText } from "@/lib/emojiText";
import { spring, tween } from "@/lib/motion";
import { isTauri } from "@/lib/tauri";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ALargeSmall,
  Archive,
  ArrowUpDown,
  CalendarPlus,
  ChevronDown,
  ChevronLeft,
  FilePlus,
  FileSymlink,
  FileText,
  FileType,
  Focus,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  History,
  Import,
  Inbox,
  ListFilter,
  ListOrdered,
  type LucideIcon,
  Pencil,
  Pin,
  PinOff,
  Plus,
  TextQuote,
  Trash2,
} from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import {
  Fragment,
  type ReactNode,
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { FolderPicker } from "./notes/FolderPicker";
import { SmartFolderEditor } from "./notes/SmartFolderEditor";
import {
  type DropTarget,
  beginFolderDrag,
  beginNoteDrag,
  branchEdge,
  consumeDragClick,
  draggingNote,
  dropInto,
  noteEdge,
  useNoteDrag,
} from "./notes/noteDrag";

type SortMode = NoteSort;
const SORT_MODES: SortMode[] = ["updated", "created", "title"];
/** 逻辑目录多一个「手动排序」：按树上摆的顺序，能拖着排 */
const LOGICAL_SORT_MODES: SortMode[] = ["manual", "updated", "created", "title"];
const SORT_LABEL: Record<SortMode, string> = {
  manual: "手动排序",
  updated: "按更新时间",
  created: "按创建时间",
  title: "按标题",
};
const SORT_ICON: Record<SortMode, LucideIcon> = {
  manual: ListOrdered,
  updated: History,
  created: CalendarPlus,
  title: ALargeSmall,
};

/** 手动排序：按树上的排序键；没放进树里的（未整理）排在后面，照最近改过的顺序（sort 是稳定的） */
function manualOrder(a: NoteSummary, b: NoteSummary): number {
  const ka = manualKey(a);
  const kb = manualKey(b);
  if (ka === undefined || kb === undefined) return ka === kb ? 0 : ka === undefined ? 1 : -1;
  return ka < kb ? -1 : ka > kb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 树里每深一层缩进多少 */
const INDENT = 16;
/** 笔记卡片的高度（两行字 + 上下留白）：分批画时给还没画的那一截占位（ListColumn 的 MoreRows） */
const CARD_HEIGHT = 63.25;
/** 树上一行的高度：文件夹、笔记、快捷方式、图片 PDF，哪一层都一样。分批画时同样拿来占位 */
const ROW_HEIGHT = 34;
/** 开着「显示摘要」时笔记那一行的高度：标题一行 + 摘要一行。文件夹那几行还是 ROW_HEIGHT */
const EXCERPT_ROW_HEIGHT = 52;
/** 行的左内边距（图标位从这里开始） */
const ROW_PAD = 9;
/** 树上的一行：图标位、名字、右边一格（数字 / 图钉 / 「…」）。深度只体现在左缩进上 */
const TREE_ROW = cn(
  "group relative flex h-[34px] cursor-default items-center gap-1.5 rounded-lg pr-3 outline-none",
  "focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-inset",
);
/**
 * 带摘要的笔记行：两行字，图标、右边一格都和标题那一行对齐（顶上留 7px，标题行高 20px，
 * 和单行时标题落的位置一样）
 */
const EXCERPT_ROW = "h-[52px] items-start pt-[7px]";

type Editing = { kind: "new"; parent: string } | { kind: "rename"; path: string } | null;
type Picker =
  | { mode: "jump" }
  | { mode: "move"; noteId: string }
  /** 笔记「…」菜单里的「添加快捷方式到…」（逻辑目录） */
  | { mode: "shortcut"; noteId: string }
  /** 智能文件夹的编辑卡片：新建（建在 parent 里）或者改（path） */
  | { mode: "smart"; parent: string; path?: string }
  | null;
type Settle = { path: string; slide: boolean; at: number } | null;

/**
 * 树里一个文件夹（连同展开出来的子树）、一个就地起名的输入框，进出都只动高度。
 * custom 是「要不要动」：起名后原地换的那一下进出都是瞬间的，字不挪；
 * 其余（删文件夹、外部改动、排到别处去的新名字）按高度收起 / 展开
 */
const entryMotion = {
  enter: (slide: boolean) => (slide ? { height: 0 } : {}),
  shown: { height: "auto", transition: tween.base },
  gone: (slide: boolean) =>
    slide ? { height: 0, transition: tween.base } : { height: 0, transition: { duration: 0 } },
};

/* ============================================================
   笔记列表栏。

   文件夹就是仓库里「笔记」下面的子目录（data/folders.ts）。列表栏是一棵树
   （docs/仓库与启动器.md §17）：上面一组置顶，下面是这一层的东西 —— 子文件夹、笔记、
   快捷方式、图片 PDF，哪一层都是同一种行（图标 + 名字），只是缩进不同。

   - 有层级的用行，平铺的用卡片：搜索结果、智能文件夹里、未整理里没有层级，用带摘要的卡片
   - 点文件夹整行是展开 / 收起（按住 Alt 连子文件夹一起），展开了哪些记在本机；
     空的文件夹没什么可展开的，点了是进去（那里告诉你怎么往里放东西）
   - 「进去」是次要的：文件夹「…」里的「聚焦到这里」、点标题打开文件夹切换器。进去以后
     搜索框下面一行面包屑回上层（标题栏那 38px 是拖窗口的，放不了按钮）
   - 置顶的每篇只出现一次：在最上面那一组（这一层和下面各层的，带上所在文件夹），
     树上它那个位置不再列
   - 笔记可以拖进任何看得见的文件夹（含面包屑），停在收起的文件夹上会自动展开
   - 搜索标题时搜所有文件夹

   逻辑目录（docs/仓库与启动器.md §7）：文件夹在清单里，按手动摆的顺序；「手动排序」时笔记也按树上的
   顺序，拖到两篇之间就是排顺序。文件夹能拖：拖到别的文件夹上是放进去，拖到两个文件夹之间是排顺序。
   没放进树里的在根上固定的「未整理」里；智能文件夹按条件列出笔记，里面放不了东西
   ============================================================ */

export function NotesList({ notes }: { notes: NoteSummary[] }) {
  const selectedId = useApp((s) => s.selectedNoteId);
  const selectNote = useApp((s) => s.selectNote);
  const query = useApp((s) => s.noteQuery);
  const setQuery = useApp((s) => s.setNoteQuery);
  const folder = useApp((s) => s.noteFolder);
  const navDir = useApp((s) => s.noteFolderDir);
  const setNoteFolder = useApp((s) => s.setNoteFolder);
  const revealTick = useApp((s) => s.noteRevealTick);
  const expanded = useApp((s) => s.expandedFolders);
  const setFolderExpanded = useApp((s) => s.setFolderExpanded);
  const followFolderRename = useApp((s) => s.followFolderRename);
  // 后台还在把文件读进索引：列表空着不是「还没有笔记」
  const indexing = useData((s) => s.indexing !== null);
  const forgetFolder = useApp((s) => s.forgetFolder);
  const folders = useData((s) => s.folders);
  const files = useData((s) => s.files);
  const createNote = useData((s) => s.createNote);
  const createFolder = useData((s) => s.createFolder);
  const renameFolder = useData((s) => s.renameFolder);
  const deleteFolder = useData((s) => s.deleteFolder);
  const moveNote = useData((s) => s.moveNote);
  const placeNote = useData((s) => s.placeNote);
  const moveFolder = useData((s) => s.moveFolder);
  const createSmartFolder = useData((s) => s.createSmartFolder);
  const addShortcut = useData((s) => s.addShortcut);
  const removeShortcut = useData((s) => s.removeShortcut);
  const importFolder = useData((s) => s.importFolder);
  const editSmartFolder = useData((s) => s.editSmartFolder);
  const logical = useData((s) => s.layout.logical);
  const tree = useData((s) => s.tree);
  const smartResults = useData((s) => s.smartResults);
  // 排序记在本机：以前切到日历再回来就变回「按更新时间」。「手动排序」只有逻辑目录有
  const sort = useApp((s) => s.noteSort);
  const sortMode: SortMode = sort === "manual" && !logical ? "updated" : sort;
  const setSort = useApp((s) => s.setNoteSort);
  // 树上的笔记带不带一行摘要（平铺的卡片一直带）
  const excerpts = useApp((s) => s.noteExcerpts);
  const setExcerpts = useApp((s) => s.setNoteExcerpts);
  /** 现在所在的是智能文件夹的话，它的条件 */
  const smartHere = smartQuery(folder);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [picker, setPicker] = useState<Picker>(null);
  const [pickerTop, setPickerTop] = useState(0);
  const [flash, setFlash] = useState<{ path: string; at: number } | null>(null);
  /** 刚起好名字的那个文件夹：落在别处（slide）时新行按高度展开，输入框那一行按高度收起 */
  const [settle, setSettle] = useState<Settle>(null);
  useEffect(() => {
    if (!settle) return;
    const timer = setTimeout(() => setSettle(null), 600);
    return () => clearTimeout(timer);
  }, [settle]);
  const titleButton = useRef<HTMLButtonElement>(null);
  const renaming = useRef(false);

  // 选中的那篇没了：从这里删、归档的已经先挪到了下一篇（app/navigate 的 selectNeighbor），
  // 走到这儿的是别处删掉的（资源管理器里、网盘同步），或者上次打开的那篇已经不在了。
  // 落到列表里看得见的第一篇（正文那边已经退到了第一篇，见 adapter），高亮得跟过去 ——
  // 否则右边显示着一篇笔记、左边却没有任何一行是亮的。
  useEffect(() => {
    if (notes.length === 0 || notes.some((n) => n.id === selectedId)) return;
    const alive = new Set(notes.map((note) => note.id));
    const firstVisible = [
      ...document.querySelectorAll<HTMLElement>("[data-list-scroller] [data-note-row]"),
    ]
      .map((row) => row.dataset.noteRow ?? "")
      .find((id) => alive.has(id));
    selectNote(firstVisible ?? notes[0]!.id);
  }, [notes, selectedId, selectNote]);

  // 从正文区标题上方的路径点过来的：等新的一列换上来，把选中的那篇滚到看得见的地方
  // （它可能在列表很下面）。只在这时候滚 —— 平时进出文件夹不动用户的滚动位置
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只应在点了路径时触发
  useEffect(() => {
    if (!revealTick) return;
    const timer = setTimeout(() => revealNoteRow(selectedId), 220);
    return () => clearTimeout(timer);
  }, [revealTick]);

  // 正待着的文件夹没了（在资源管理器里删了 / 改了名）：退到还在的那一层
  useEffect(() => {
    if (folder === UNSORTED) {
      if (!logical) setNoteFolder("");
      return;
    }
    if (!folder || renaming.current || folders.includes(folder)) return;
    let up = parentOf(folder);
    while (up && !folders.includes(up)) up = parentOf(up);
    setNoteFolder(up);
  }, [folder, folders, logical, setNoteFolder]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 树变了手动排序跟着变（manualKey 读的是 data/folders 里摊开的那一份）
  const sortNotes = useCallback(
    (list: NoteSummary[]) =>
      // 「按更新时间」直接用 store 里的顺序（加载 / 置顶 / 归档时已按 updatedAt 排好），
      // 不在这里按 updatedAt 重排：自动保存每 400ms 刷新一次它，正在编辑的那篇
      // 会在侧栏里当着用户的面往上跳 —— store 刻意不重排就是为了避免这个。
      sortMode === "updated"
        ? list
        : sortMode === "manual"
          ? [...list].sort(manualOrder)
          : [...list].sort((a, b) =>
              sortMode === "title"
                ? a.title.localeCompare(b.title, "zh-Hans-CN")
                : b.createdAt - a.createdAt,
            ),
    [sortMode, tree],
  );

  /**
   * 每个文件夹里直接列出来的笔记（按当前排序）。逻辑目录按树上的位置（folderOf），树变了跟着变。
   * 置顶的不在这里：它们在最上面那一组，每篇只出现一次
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: folderOf 在逻辑目录里读 data/folders 里摊开的树
  const notesByFolder = useMemo(() => {
    const map = new Map<string, NoteSummary[]>();
    for (const note of sortNotes(notes)) {
      if (note.isPinned) continue;
      const key = folderOf(note);
      const list = map.get(key);
      if (list) list.push(note);
      else map.set(key, [note]);
    }
    return map;
  }, [notes, sortNotes, tree]);

  /** 每个文件夹里的图片、PDF（本地目录才有），按名字 */
  const filesByFolder = useMemo(() => {
    const map = new Map<string, TreeFile[]>();
    for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))) {
      const list = map.get(file.folder);
      if (list) list.push(file);
      else map.set(file.folder, [file]);
    }
    return map;
  }, [files]);

  /** 文件夹里的快捷方式（逻辑目录），指着的那篇不在列表里（删了、归档了）的不列 */
  // biome-ignore lint/correctness/useExhaustiveDependencies: shortcutsIn 读的是 data/folders 里摊开的树
  const shortcutsOf = useCallback(
    (path: string) => {
      const alive = new Set(notes.map((note) => note.id));
      return shortcutsIn(path).filter((shortcut) => alive.has(shortcut.note));
    },
    [notes, tree],
  );

  /** 智能文件夹筛出来的笔记（照筛出来的顺序：置顶在前、最近改过的在前） */
  const smartNotes = useCallback(
    (query: string) => {
      const byId = new Map(notes.map((note) => [note.id, note]));
      return (smartResults[query] ?? [])
        .map((id) => byId.get(id))
        .filter((note): note is NoteSummary => !!note);
    },
    [notes, smartResults],
  );

  // 只按标题筛（不走全文搜索：输入「周」翻出一堆正文里提到它的笔记，跟标题对不上）。
  // 有搜索词时搜所有文件夹。
  const q = query.trim().toLowerCase();
  /** 平铺的列表（搜索结果、智能文件夹里、未整理里）：没有层级，笔记用带摘要的卡片 */
  const flat = q !== "" || smartHere !== undefined || folder === UNSORTED;
  const view = useMemo(() => {
    if (q) {
      return {
        search: true,
        pinned: [] as NoteSummary[],
        folders: folders
          .filter((path) => nameOf(path).toLowerCase().includes(q))
          .sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
        notes: sortNotes(notes.filter((n) => n.title.toLowerCase().includes(q))),
        files: files.filter((file) => file.name.toLowerCase().includes(q)),
        shortcuts: [] as Shortcut[],
      };
    }
    if (smartHere !== undefined) {
      const found = smartNotes(smartHere);
      return {
        search: false,
        pinned: [] as NoteSummary[],
        folders: [] as string[],
        notes: sortMode === "manual" ? found : sortNotes(found),
        files: [] as TreeFile[],
        shortcuts: [] as Shortcut[],
      };
    }
    return {
      search: false,
      // 这一层和下面各层里置顶的（树根上就是所有置顶的）：树上不再列它们
      pinned: sortNotes(notes.filter((n) => n.isPinned && within(folderOf(n), folder))),
      folders: childFolders(folders, folder),
      notes: notesByFolder.get(folder) ?? [],
      files: filesByFolder.get(folder) ?? [],
      shortcuts: shortcutsOf(folder),
    };
  }, [
    shortcutsOf,
    q,
    folders,
    folder,
    notes,
    notesByFolder,
    sortNotes,
    smartHere,
    smartNotes,
    sortMode,
    files,
    filesByFolder,
  ]);

  // 「笔记」那一组分批画（ListColumn 的 useRowBatch）。换了文件夹、换了搜索词从头算
  const { shown, more } = useRowBatch(
    q ? `search:${q}` : `folder:${folder}`,
    view.notes.length,
    view.notes.findIndex((note) => note.id === selectedId),
  );

  /** 让那一行闪一下：东西去了哪、刚从哪出来 */
  const flashRow = (path: string | null, delay = 0) => {
    if (path === null) return;
    setTimeout(() => setFlash({ path, at: Date.now() }), delay);
  };

  const navigate = (to: string) => {
    if (to === folder && !q) return;
    const up = to !== folder && within(folder, to);
    setPicker(null);
    setEditing(null);
    if (q) setQuery("");
    setNoteFolder(to);
    // 退回上层：刚出来的那个文件夹闪一下（等新的一列换上来）
    if (up) flashRow(nearestVisible(folder, to, expanded), 140);
  };

  /** 新建一篇：into 是文件夹「…」里点的那个文件夹，没给就是列表栏现在这一层 */
  const handleCreate = async (into?: string) => {
    // 后端慢的时候连点两下会白建好几篇空笔记
    if (creating) return;
    setCreating(true);
    try {
      // 智能文件夹里放不了东西：新的一篇放在根上，跟过去
      const here = into === undefined && smartHere !== undefined;
      const id = await createNote(into ?? (here ? "" : folder));
      if (!id) return;
      if (here) setNoteFolder("");
      // 从文件夹的「…」建的：展开那个文件夹，新的一篇就在它底下
      if (into !== undefined && into !== folder) {
        setFolderExpanded([into], true);
        setTimeout(() => revealNoteRow(id), 260);
      }
      // 新笔记是空的，搜索词留着的话它进不了当前筛选结果 ——
      // 用户点了「新建」，界面上却什么都没发生。
      setQuery("");
      // 光标直接落在标题里：以前焦点还停在「+」上，得先点一下才能起名
      useApp.getState().setFocusRequest({ docKey: `note-${id}`, at: "title" });
      selectNote(id);
    } finally {
      setCreating(false);
    }
  };

  const startNewFolder = (parent: string) => {
    if (q) setQuery("");
    if (parent !== folder) setFolderExpanded([parent], true);
    setEditing({ kind: "new", parent });
  };

  /**
   * 起好名字回车：输入框和文件夹在同一帧里换过来（store 先按后端的规矩把结果放进列表，
   * 不等那一个来回）。落在输入框原来那一格就原地换，字不挪；排到别处去了，输入框那一行
   * 收起、文件夹在新位置展开（只动高度），然后闪一下告诉你它在哪
   */
  const submitName = async (name: string) => {
    const current = editing;
    setEditing(null);
    const clean = cleanFolderName(name);
    if (!current || !clean) return;
    const at = Date.now();
    if (current.kind === "new") {
      const guess = uniqueChild(folders, current.parent, clean);
      // 输入框在这一层的最上面：新文件夹也排在第一个，就是原地（逻辑目录的新文件夹总在最前面）
      const inPlace = logical || childFolders([...folders, guess], current.parent)[0] === guess;
      setSettle({ path: guess, slide: !inPlace, at });
      setFlash({ path: guess, at });
      const path = await createFolder(current.parent, name);
      if (path && path !== guess) setFlash({ path, at: Date.now() });
      return;
    }
    const parent = parentOf(current.path);
    const guess = uniqueChild(folders, parent, clean, current.path);
    if (guess === current.path) return;
    const after = folders.map((path) => renamedPath(path, current.path, guess));
    // 逻辑目录改名不换位置
    const inPlace =
      logical ||
      childFolders(folders, parent).indexOf(current.path) ===
        childFolders(after, parent).indexOf(guess);
    setSettle({ path: guess, slide: !inPlace, at });
    setFlash({ path: guess, at });
    renaming.current = true;
    try {
      const pending = renameFolder(current.path, name);
      // 和 store 里的乐观改名同一帧：当前位置、展开状态跟着换，不会被当成「文件夹没了」
      followFolderRename(current.path, guess);
      const next = await pending;
      if (next === null) followFolderRename(guess, current.path);
      else if (next !== guess) {
        followFolderRename(guess, next);
        setFlash({ path: next, at: Date.now() });
      }
    } finally {
      renaming.current = false;
    }
  };

  const removeFolder = (path: string) => {
    forgetFolder(path);
    void deleteFolder(path);
  };

  const move = async (id: string, to: string) => {
    await moveNote(id, to);
    const { noteFolder, expandedFolders } = useApp.getState();
    flashRow(nearestVisible(to, noteFolder, expandedFolders));
  };

  /** 一篇笔记松手了：放进文件夹，或者（手动排序）插在某一篇前后 */
  const dropNote = (id: string, target: DropTarget) => {
    if (target.kind === "into") return void move(id, target.folder);
    if (target.kind !== "note") return;
    const list = notesByFolder.get(target.folder) ?? [];
    const index = list.findIndex((note) => note.id === target.note);
    const after =
      target.edge === "below" ? target.note : index > 0 ? (list[index - 1]?.id ?? null) : null;
    // 插在紧挨着它自己的地方：原地不动
    if (after === id) return;
    void placeNote(id, target.folder, after);
  };

  /** 一个文件夹松手了：放进别的文件夹（排在最前面），或者插在某个文件夹前后 */
  const dropFolder = async (path: string, target: DropTarget) => {
    let parent: string;
    let after: string | null = null;
    if (target.kind === "into") parent = target.folder;
    else if (target.kind === "branch") {
      parent = parentOf(target.path);
      const siblings = childFolders(folders, parent);
      const index = siblings.indexOf(target.path);
      after =
        target.edge === "below" ? target.path : index > 0 ? (siblings[index - 1] ?? null) : null;
      if (after === path) return;
    } else return;
    const guess = tree ? moveBranch(tree, path, parent, after)?.path : undefined;
    if (!guess) return;
    // 和 store 里的乐观挪动同一帧：展开状态、当前位置跟着换，不会被当成「文件夹没了」
    renaming.current = true;
    try {
      const pending = moveFolder(path, parent, after);
      followFolderRename(path, guess);
      const next = await pending;
      if (next === null) followFolderRename(guess, path);
      else if (next !== guess) followFolderRename(guess, next);
      if (next) {
        if (parent && parent !== folder) setFolderExpanded([parent], true);
        flashRow(next, 60);
      }
    } finally {
      renaming.current = false;
    }
  };

  /** 智能文件夹的编辑卡片里点了保存 */
  const saveSmart = async (
    parent: string,
    path: string | undefined,
    name: string,
    query: string,
  ) => {
    setPicker(null);
    if (!path) {
      const created = await createSmartFolder(parent, name, query);
      if (created) flashRow(created, 60);
      return;
    }
    renaming.current = true;
    try {
      const next = await editSmartFolder(path, name, query);
      if (next && next !== path) followFolderRename(path, next);
    } finally {
      renaming.current = false;
    }
  };

  const openPicker = (next: NonNullable<Picker>) => {
    const button = titleButton.current;
    if (button) setPickerTop(button.offsetTop + button.offsetHeight + 6);
    setPicker(next);
  };

  const newSmartFolder = (parent: string) => {
    if (q) setQuery("");
    openPicker({ mode: "smart", parent });
  };

  // 这一次渲染的操作（闭包里是这一次的状态）。行拿到的是下面那份身份不变的转发，
  // 调用时才取最新的这一份
  const latest = useRef<TreeActions | null>(null);
  latest.current = {
    open: navigate,
    toggle: (path, all) => {
      const open = !expanded.has(path);
      const paths = all ? folders.filter((f) => within(f, path)) : [path];
      setFolderExpanded(paths, open);
    },
    select: selectNote,
    newNote: (path) => void handleCreate(path),
    dropNote,
    dropFolder: (path, target) => void dropFolder(path, target),
    springOpen: (path) => setFolderExpanded([path], true),
    startNewFolder,
    newSmartFolder,
    editSmartFolder: (path) => openPicker({ mode: "smart", parent: parentOf(path), path }),
    startRename: (path) => setEditing({ kind: "rename", path }),
    remove: removeFolder,
    submitName: (name) => void submitName(name),
    cancelName: () => setEditing(null),
    moveTo: (id) => openPicker({ mode: "move", noteId: id }),
    unsort: (id) => void move(id, UNSORTED),
    shortcutTo: (id) => openPicker({ mode: "shortcut", noteId: id }),
    removeShortcut: (node) => void removeShortcut(node),
    openOrigin: (id) => {
      const note = notes.find((item) => item.id === id);
      if (note) navigate(folderOf(note));
      selectNote(id);
    },
    importHere: (path) =>
      void importFolder(path).then((created) => {
        if (!created) return;
        if (parentOf(created) !== folder) setFolderExpanded([parentOf(created)], true);
        flashRow(created, 60);
      }),
  };
  const actions = useMemo<TreeActions>(() => {
    const now = () => latest.current as TreeActions;
    return {
      open: (path) => now().open(path),
      toggle: (path, all) => now().toggle(path, all),
      select: (id) => now().select(id),
      newNote: (path) => now().newNote(path),
      dropNote: (id, target) => now().dropNote(id, target),
      dropFolder: (path, target) => now().dropFolder(path, target),
      springOpen: (path) => now().springOpen(path),
      startNewFolder: (parent) => now().startNewFolder(parent),
      newSmartFolder: (parent) => now().newSmartFolder(parent),
      editSmartFolder: (path) => now().editSmartFolder(path),
      startRename: (path) => now().startRename(path),
      remove: (path) => now().remove(path),
      submitName: (name) => now().submitName(name),
      cancelName: () => now().cancelName(),
      moveTo: (id) => now().moveTo(id),
      unsort: (id) => now().unsort(id),
      shortcutTo: (id) => now().shortcutTo(id),
      removeShortcut: (node) => now().removeShortcut(node),
      openOrigin: (id) => now().openOrigin(id),
      importHere: (path) => now().importHere(path),
    };
  }, []);
  // 手动排序时笔记能拖着排：卡片、展开的文件夹里那一行都是落点（逻辑目录才有）
  const reorder = logical && sortMode === "manual";
  const treeValue = useMemo<TreeContextValue>(
    () => ({
      ...actions,
      folder,
      notesByFolder,
      filesByFolder,
      folders,
      notes,
      expanded,
      editing,
      flash,
      settle,
      logical,
      reorder,
      smartNotes,
      shortcutsOf,
    }),
    [
      shortcutsOf,
      actions,
      folder,
      notesByFolder,
      filesByFolder,
      folders,
      notes,
      expanded,
      editing,
      flash,
      settle,
      logical,
      reorder,
      smartNotes,
    ],
  );

  // 卡片是 memo 的：切换选中只重渲染新旧两张，自动保存只重渲染存的那一张（几百张卡片
  // 每张都带着 Motion 和菜单，以前每次都整列重渲染，4 倍降速下切一篇要两三百毫秒）。
  // 可卡片的 layout 动画要靠重渲染那一刻量位置 —— 卡片上面的东西变了（多了 / 少了 / 换了
  // 顺序的卡片、文件夹展开收起、就地起名的输入框），这个数就加一，所有卡片照旧一起重渲染、
  // 一起量位置（Motion 的 layoutDependency）
  const shapeKey = [
    view.search,
    view.pinned.map((note) => note.id).join(","),
    view.folders.join(","),
    view.notes.map((note) => note.id).join(","),
    view.files.map((file) => file.relPath).join(","),
    view.shortcuts.map((shortcut) => shortcut.node).join(","),
    [...expanded]
      .map(
        (path) =>
          `${path}:${notesByFolder.get(path)?.length ?? 0}:${filesByFolder.get(path)?.length ?? 0}:${shortcutsOf(path).length}`,
      )
      .join(","),
    editing ? `${editing.kind}:${editing.kind === "new" ? editing.parent : editing.path}` : "",
    settle ? `${settle.path}:${settle.at}` : "",
    // 逻辑目录：未整理那一行出现 / 消失也会把下面的卡片挤动
    logical ? `${notesByFolder.get(UNSORTED)?.length ?? 0}` : "",
  ].join("\n");
  const shape = useRef({ key: shapeKey, tick: 0 });
  if (shape.current.key !== shapeKey)
    shape.current = { key: shapeKey, tick: shape.current.tick + 1 };
  const shapeTick = shape.current.tick;

  // 平铺的列表分组（文件夹 / 笔记 / 文件），每组带标题；树只有两组：置顶，和这一层的树（不带标题）
  const groups: { key: string; label?: ReactNode; body: ReactNode }[] = [];
  if (view.pinned.length) {
    groups.push({
      key: "pinned",
      label: <GroupLabel icon={<Pin size={10} strokeWidth={2} />} text="置顶" />,
      body: flat
        ? view.pinned.map((n, i) => (
            <NoteCard
              key={n.id}
              note={n}
              index={i}
              selected={n.id === selectedId}
              folder={folder}
              shapeTick={shapeTick}
              boxed
            />
          ))
        : view.pinned.map((n) => (
            <TreeNoteRow key={n.id} note={n} depth={0} where={hintFolder(n, folder)} />
          )),
    });
  }
  if (flat) {
    if (view.folders.length) {
      groups.push({
        key: "folders",
        label: <GroupLabel text="文件夹" />,
        body: view.folders.map((path) => <FolderRow key={path} path={path} depth={0} hint />),
      });
    }
    if (view.notes.length) {
      const rest = view.notes.length - shown;
      groups.push({
        key: "notes",
        label: <GroupLabel text="笔记" />,
        body: (
          <div className="flex flex-col">
            {view.notes.slice(0, shown).map((n, i) => (
              <NoteCard
                key={n.id}
                note={n}
                index={view.pinned.length + i}
                selected={n.id === selectedId}
                folder={folder}
                shapeTick={shapeTick}
                reorderIn={reorder && smartHere === undefined ? folderOf(n) : undefined}
                divided={i > 0}
                appear={i < ROW_BATCH}
              />
            ))}
            {rest > 0 && <MoreRows height={rest * CARD_HEIGHT} onNear={more} />}
          </div>
        ),
      });
    }
    if (view.files.length) {
      groups.push({
        key: "files",
        label: <GroupLabel text="文件" />,
        body: view.files.map((file) => (
          <TreeFileRow key={file.relPath} file={file} depth={0} hint />
        )),
      });
    }
  } else {
    const newHere = editing?.kind === "new" && editing.parent === folder;
    // 逻辑目录：根上固定一行「未整理」（有东西的时候），没放进树里的笔记在里面
    const unsorted = logical && folder === "" && (notesByFolder.get(UNSORTED)?.length ?? 0) > 0;
    if (
      newHere ||
      unsorted ||
      view.folders.length ||
      view.notes.length ||
      view.shortcuts.length ||
      view.files.length
    ) {
      groups.push({
        key: "tree",
        body: <FolderContents path={folder} depth={0} batch={{ shown, more }} />,
      });
    }
  }
  const labelled = !flat || groups.length > 1 || view.pinned.length > 0 || view.search;
  const pickerNote =
    picker?.mode === "move" || picker?.mode === "shortcut"
      ? notes.find((note) => note.id === picker.noteId)
      : undefined;
  // 未整理、智能文件夹里不能建子文件夹
  const canNest = folder !== UNSORTED && smartHere === undefined;

  return (
    <TreeActionsContext.Provider value={actions}>
      <TreeContext.Provider value={treeValue}>
        <ListColumn
          title={folderName(folder)}
          titleSlot={
            <h2 className="flex min-w-0">
              <button
                ref={titleButton}
                type="button"
                data-folder-picker-trigger
                aria-expanded={picker?.mode === "jump"}
                title="跳到文件夹"
                onClick={() =>
                  picker?.mode === "jump" ? setPicker(null) : openPicker({ mode: "jump" })
                }
                // -my-px：悬停底色上下多出的那 1px 不占排版，标题和日历 / 归档的标题同一个高度，
                // 下面的搜索框、列表也不会比那两栏低 2px（切过去时整栏跳一下）
                className="group -my-px -ml-[7px] flex min-w-0 items-center gap-[3px] rounded-lg py-px pl-[7px] pr-[5px]
                         transition-colors duration-[140ms] hover:bg-raised/55 aria-expanded:bg-raised/55"
              >
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={folder}
                    // 只淡入淡出：标题是大字，位移 / 缩放都会让它先糊再跳清楚
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={tween.fast}
                    className="truncate font-display text-[25px] font-bold leading-tight text-ink"
                  >
                    {folderName(folder)}
                  </motion.span>
                </AnimatePresence>
                <ChevronDown
                  size={15}
                  strokeWidth={2}
                  className={cn(
                    "mt-1 shrink-0 text-faint transition-[rotate,color] duration-[220ms] group-hover:text-muted",
                    picker?.mode === "jump" && "rotate-180 text-muted",
                  )}
                />
              </button>
            </h2>
          }
          action={
            <div className="flex items-center gap-1.5">
              {/* 排序：点开一个单选菜单，而不是盲点循环 —— 循环切换看不到还有哪些
                选项、也不知道现在是哪一种，得点三下才能确认转了一圈。
                分隔线下面是「显示摘要」：树上的每一篇都多一行摘要，哪一层都一样 */}
              <ActionMenu
                trigger={
                  <ColumnButton
                    label={`排序：${SORT_LABEL[sortMode]}${excerpts ? "，显示摘要" : ""}`}
                  >
                    <ArrowUpDown size={13} strokeWidth={1.9} />
                  </ColumnButton>
                }
                actions={[
                  ...(logical ? LOGICAL_SORT_MODES : SORT_MODES).map((mode) => ({
                    id: mode,
                    label: SORT_LABEL[mode],
                    icon: SORT_ICON[mode],
                    checked: sortMode === mode,
                    onSelect: () => setSort(mode),
                  })),
                  {
                    id: "excerpts",
                    label: "显示摘要",
                    icon: TextQuote,
                    toggle: true,
                    checked: excerpts,
                    onSelect: () => setExcerpts(!excerpts),
                  },
                ]}
              />
              {canNest &&
                (logical ? (
                  <ActionMenu
                    trigger={
                      <ColumnButton label="新建文件夹">
                        <FolderPlus size={14} strokeWidth={1.9} />
                      </ColumnButton>
                    }
                    actions={[
                      {
                        id: "folder",
                        label: "新建文件夹",
                        icon: FolderPlus,
                        onSelect: () => startNewFolder(folder),
                      },
                      {
                        id: "smart",
                        label: "新建智能文件夹…",
                        icon: ListFilter,
                        onSelect: () => newSmartFolder(folder),
                      },
                      {
                        id: "import",
                        label: "导入文件夹…",
                        icon: Import,
                        onSelect: () => actions.importHere(folder),
                      },
                    ]}
                  />
                ) : (
                  <ActionMenu
                    trigger={
                      <ColumnButton label="新建文件夹">
                        <FolderPlus size={14} strokeWidth={1.9} />
                      </ColumnButton>
                    }
                    actions={[
                      {
                        id: "folder",
                        label: "新建文件夹",
                        icon: FolderPlus,
                        onSelect: () => startNewFolder(folder),
                      },
                      {
                        id: "import",
                        label: "导入文件夹…",
                        icon: Import,
                        onSelect: () => actions.importHere(folder),
                      },
                    ]}
                  />
                ))}
              <ColumnButton label="新建笔记" onClick={() => void handleCreate()}>
                <Plus size={15} strokeWidth={2.1} />
              </ColumnButton>
            </div>
          }
          belowTitle={
            <>
              <SearchInput value={query} onChange={setQuery} placeholder="搜索标题" />
              {folder && !q && <Crumbs folder={folder} onNavigate={navigate} />}
            </>
          }
          overlay={
            <AnimatePresence>
              {picker?.mode === "smart" && (
                <SmartFolderEditor
                  key={`smart:${picker.path ?? picker.parent}`}
                  parent={picker.parent}
                  path={picker.path}
                  top={pickerTop}
                  onClose={() => setPicker(null)}
                  onSave={(name, query) => void saveSmart(picker.parent, picker.path, name, query)}
                />
              )}
              {picker && picker.mode !== "smart" && (
                <FolderPicker
                  key={picker.mode === "jump" ? "jump" : `${picker.mode}:${picker.noteId}`}
                  mode={picker.mode}
                  current={picker.mode === "jump" ? folder : pickerNote ? folderOf(pickerNote) : ""}
                  noteTitle={pickerNote?.title}
                  top={pickerTop}
                  onClose={() => setPicker(null)}
                  onPick={(path) => {
                    setPicker(null);
                    if (picker.mode === "jump") navigate(path);
                    else if (picker.mode === "shortcut") void addShortcut(picker.noteId, path);
                    else void move(picker.noteId, path);
                  }}
                />
              )}
            </AnimatePresence>
          }
        >
          <AnimatePresence mode="wait" initial={false} custom={navDir}>
            <motion.div
              key={q ? "search" : `folder:${folder}`}
              custom={navDir}
              // 换文件夹：整列朝进出的方向挪一小段。动的是 left（主线程排版），不是 transform ——
              // 合成层上位移的字在动画里是灰阶抗锯齿，停下那一帧才变回清晰的，看着像抖一下
              variants={{
                enter: (dir: number) => ({ opacity: 0, left: 16 * dir }),
                shown: { opacity: 1, left: 0 },
                leave: (dir: number) => ({ opacity: 0, left: -12 * dir }),
              }}
              initial="enter"
              animate="shown"
              exit="leave"
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
              className="relative"
            >
              {groups.length === 0 ? (
                <EmptyResult
                  query={query}
                  emptyTitle={
                    indexing
                      ? "正在读取笔记文件夹…"
                      : smartHere !== undefined
                        ? "没有符合条件的笔记"
                        : folder === UNSORTED
                          ? "都整理好了"
                          : folder
                            ? "这个文件夹还是空的"
                            : "还没有笔记"
                  }
                  emptyHint={
                    indexing
                      ? "读完了笔记就会出现在这里"
                      : smartHere !== undefined
                        ? `条件：${smartHere || "（空的，什么都要）"}`
                        : folder === UNSORTED
                          ? "没放进树里的笔记会出现在这里"
                          : folder
                            ? "点右上角的 + 新建一篇，或者把笔记拖进来"
                            : "点右上角的 + 新建一篇"
                  }
                />
              ) : (
                groups.map((group, i) => (
                  <Fragment key={group.key}>
                    {/* 两组之间原本只有 6px 空隙、下面一组还没有标题，翻起来根本看不出
                      哪里是分界。补一条分隔线和一个对称的组标题。 */}
                    {i > 0 && <div className="mx-3 mt-3 mb-1 border-t border-line-strong/70" />}
                    {labelled && group.label}
                    {group.body}
                  </Fragment>
                ))
              )}
            </motion.div>
          </AnimatePresence>
        </ListColumn>
        <NoteDragGhost />
      </TreeContext.Provider>
    </TreeActionsContext.Provider>
  );
}

/** 列表里那一篇（卡片或展开的文件夹里那一行）不在可视区里的话，滚到刚好露出来 */
function revealNoteRow(id: string) {
  const row = document.querySelector<HTMLElement>(`[data-note-row="${CSS.escape(id)}"]`);
  const scroller = row?.closest<HTMLElement>("[data-list-scroller]");
  if (!row || !scroller) return;
  const box = row.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  const margin = 12;
  const delta =
    box.top < view.top + margin
      ? box.top - view.top - margin
      : box.bottom > view.bottom - margin
        ? box.bottom - view.bottom + margin
        : 0;
  if (delta) scroller.scrollBy({ top: delta, behavior: "smooth" });
}

/**
 * 站在 base 这一层看，path 那一行（看不见的话就是它看得见的上层）是哪个文件夹：
 * base 这一层的文件夹总看得见，再往下要一路都展开着。看不见（不在 base 底下）返回 null
 */
function nearestVisible(path: string, base: string, expanded: Set<string>): string | null {
  for (let p = path; p && p !== base; p = parentOf(p)) {
    if (!within(p, base)) return null;
    let shown = true;
    for (let up = parentOf(p); up !== base; up = parentOf(up)) {
      if (!expanded.has(up)) {
        shown = false;
        break;
      }
    }
    if (shown) return p;
  }
  return null;
}

/* ---------------- 树：文件夹行、展开出来的子树、标题行 ---------------- */

/** 树上的行要调的操作。身份不变（见 NotesList），memo 的行拿着它不会跟着列表重渲染 */
interface TreeActions {
  open: (path: string) => void;
  toggle: (path: string, all: boolean) => void;
  select: (id: string) => void;
  /** 文件夹「…」里的「新建笔记」：建在那个文件夹里 */
  newNote: (path: string) => void;
  /** 拖着的笔记 / 文件夹松手了 */
  dropNote: (id: string, target: DropTarget) => void;
  dropFolder: (path: string, target: DropTarget) => void;
  springOpen: (path: string) => void;
  startNewFolder: (parent: string) => void;
  newSmartFolder: (parent: string) => void;
  editSmartFolder: (path: string) => void;
  startRename: (path: string) => void;
  remove: (path: string) => void;
  submitName: (name: string) => void;
  cancelName: () => void;
  moveTo: (id: string) => void;
  /** 移到未整理（逻辑目录）：只改清单 */
  unsort: (id: string) => void;
  /** 「添加快捷方式到…」：打开选文件夹的卡片 */
  shortcutTo: (id: string) => void;
  /** 删一个快捷方式（节点 id） */
  removeShortcut: (node: string) => void;
  /** 快捷方式的「打开原位置」：到那篇真正所在的文件夹、选中它 */
  openOrigin: (id: string) => void;
  /** 「导入文件夹…」：放在这个文件夹里 */
  importHere: (path: string) => void;
}

/** 文件夹那几行要的东西：数据 + 操作。笔记、展开、起名……一变就换一份 */
interface TreeContextValue extends TreeActions {
  folder: string;
  notesByFolder: Map<string, NoteSummary[]>;
  folders: string[];
  notes: NoteSummary[];
  expanded: Set<string>;
  editing: Editing;
  flash: { path: string; at: number } | null;
  settle: Settle;
  /** 逻辑目录：文件夹能拖、有未整理和智能文件夹 */
  logical: boolean;
  /** 手动排序：笔记能拖着排 */
  reorder: boolean;
  /** 智能文件夹筛出来的笔记 */
  smartNotes: (query: string) => NoteSummary[];
  /** 每个文件夹里的图片、PDF（本地目录才有） */
  filesByFolder: Map<string, TreeFile[]>;
  /** 文件夹里的快捷方式（逻辑目录才有） */
  shortcutsOf: (path: string) => Shortcut[];
}

const TreeContext = createContext<TreeContextValue | null>(null);
const TreeActionsContext = createContext<TreeActions | null>(null);

function useTree(): TreeContextValue {
  const tree = useContext(TreeContext);
  if (!tree) throw new Error("useTree 只能在 NotesList 里用");
  return tree;
}

function useTreeActions(): TreeActions {
  const actions = useContext(TreeActionsContext);
  if (!actions) throw new Error("useTreeActions 只能在 NotesList 里用");
  return actions;
}

/** 展开一个文件夹看得到什么：子文件夹，或者直接放在里面的笔记；智能文件夹是筛出来的笔记 */
function hasContent(tree: TreeContextValue, path: string) {
  const smart = smartQuery(path);
  if (smart !== undefined) return tree.smartNotes(smart).length > 0;
  return (
    childFolders(tree.folders, path).length > 0 ||
    (tree.notesByFolder.get(path)?.length ?? 0) > 0 ||
    (tree.filesByFolder.get(path)?.length ?? 0) > 0 ||
    tree.shortcutsOf(path).length > 0
  );
}

/** 一个文件夹里直接看得到的笔记（置顶的不在树上）：智能文件夹是筛出来的那些 */
function notesIn(tree: TreeContextValue, path: string) {
  const smart = smartQuery(path);
  return smart !== undefined ? tree.smartNotes(smart) : (tree.notesByFolder.get(path) ?? []);
}

/** 置顶那一组里不在列表栏这一层的：名字后面带上它在哪个文件夹（未整理里的不带） */
function hintFolder(note: NoteSummary, folder: string) {
  const where = folderOf(note);
  return where !== folder && where !== "" && where !== UNSORTED ? where : undefined;
}

/**
 * 一个文件夹里的东西，按树的顺序：就地起名的输入框、子文件夹（逻辑目录的根上最后是「未整理」）、
 * 笔记、快捷方式、图片 PDF。列表栏这一层和展开出来的子树都是它：同一种行，只是缩进不同。
 * batch：列表栏这一层的笔记可能有几百篇，分批画（ListColumn 的 useRowBatch）
 */
function FolderContents({
  path,
  depth,
  batch,
}: {
  path: string;
  depth: number;
  batch?: { shown: number; more: () => void };
}) {
  const tree = useTree();
  const excerpts = useApp((s) => s.noteExcerpts);
  const newInside = tree.editing?.kind === "new" && tree.editing.parent === path;
  const smart = smartQuery(path) !== undefined;
  const notes = notesIn(tree, path);
  const shown = batch ? Math.min(batch.shown, notes.length) : notes.length;
  // 手动排序时这几行能拖着排（智能文件夹里的不行：顺序是筛出来的）
  const reorderIn = tree.reorder && !smart ? path : undefined;
  return (
    <>
      <AnimatePresence initial={false} custom={tree.settle?.slide ?? true}>
        {newInside && <FolderNameInput key="new" depth={depth} initial="新建文件夹" fresh />}
      </AnimatePresence>
      <FolderBranch parent={path} depth={depth} />
      {notes.slice(0, shown).map((note) => (
        <TreeNoteRow
          key={note.id}
          note={note}
          depth={depth}
          reorderIn={reorderIn}
          filtered={smart}
        />
      ))}
      {batch && notes.length > shown && (
        <MoreRows
          height={(notes.length - shown) * (excerpts ? EXCERPT_ROW_HEIGHT : ROW_HEIGHT)}
          onNear={batch.more}
        />
      )}
      {!smart &&
        tree
          .shortcutsOf(path)
          .map((shortcut) => (
            <TreeShortcutRow key={shortcut.node} shortcut={shortcut} depth={depth} />
          ))}
      {(tree.filesByFolder.get(path) ?? []).map((file) => (
        <TreeFileRow key={file.relPath} file={file} depth={depth} />
      ))}
    </>
  );
}

/** parent 下面这一层的文件夹，展开的那些连同里面的东西一起。逻辑目录的根上最后一行是「未整理」 */
function FolderBranch({ parent, depth }: { parent: string; depth: number }) {
  const tree = useTree();
  const unsorted =
    tree.logical && parent === "" && (tree.notesByFolder.get(UNSORTED)?.length ?? 0) > 0
      ? [UNSORTED]
      : [];
  return (
    <AnimatePresence initial={false} custom={tree.settle?.slide ?? true}>
      {[...childFolders(tree.folders, parent), ...unsorted].map((path) => (
        <TreeSlot key={path} slide={tree.settle?.path === path ? tree.settle.slide : true}>
          <FolderEntry path={path} depth={depth} />
        </TreeSlot>
      ))}
    </AnimatePresence>
  );
}

/**
 * 树里进出只动高度的一格：一个文件夹（连同展开出来的子树），或者一个就地起名的输入框。
 * slide 是进场时要不要按高度展开；退场的看 AnimatePresence 的 custom，同一个意思。
 *
 * 原地换掉的那一下（起好的名字落在输入框原来那一格、改名后还在原位），走掉的那一格
 * 在同一次提交里就不占地方。光靠 0 秒的退场动画不够：动画要等提交之后才跑，这一次提交里
 * 新旧两格同时占着位置，下面笔记卡片的 layout 动画正好在这时量位置 —— 量到多出一行，
 * 整列先往上弹 40px 再一张张滑回来
 */
function TreeSlot({ slide, children }: { slide: boolean; children: ReactNode }) {
  const tree = useTree();
  const present = useIsPresent();
  const swappedOut = !present && tree.settle?.slide === false;
  return (
    <motion.div
      custom={slide}
      variants={entryMotion}
      initial="enter"
      animate="shown"
      exit="gone"
      className={cn("overflow-clip", swappedOut && "hidden")}
    >
      {children}
    </motion.div>
  );
}

function FolderEntry({ path, depth }: { path: string; depth: number }) {
  const tree = useTree();
  const newInside = tree.editing?.kind === "new" && tree.editing.parent === path;
  const open = tree.expanded.has(path) && (hasContent(tree, path) || newInside);
  return (
    <>
      {tree.editing?.kind === "rename" && tree.editing.path === path ? (
        <FolderNameInput depth={depth} initial={nameOf(path)} />
      ) : (
        <FolderRow path={path} depth={depth} />
      )}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="sub"
            // 按高度展开，里面的行原地不动
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            transition={tween.base}
            className="relative overflow-clip"
          >
            {/* 子树左边一条淡竖线，对着上一层图标的中线 */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-0 bottom-1.5 w-px bg-line-strong"
              style={{ left: ROW_PAD + depth * INDENT + 9.5 }}
            />
            <FolderContents path={path} depth={depth + 1} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function FolderRow({ path, depth, hint }: { path: string; depth: number; hint?: boolean }) {
  const tree = useTree();
  const dropOn = useNoteDrag((s) => dropInto(s) === path);
  const edge = useNoteDrag((s) => branchEdge(s, path));
  const dragged = useNoteDrag((s) => s.item?.kind === "folder" && s.item.path === path);
  const [menuOpen, setMenuOpen] = useState(false);
  const expandable = !hint && hasContent(tree, path);
  const open = expandable && tree.expanded.has(path);
  const flashing = tree.flash?.path === path;
  const smart = smartQuery(path);
  const unsorted = path === UNSORTED;
  // 篇数连置顶的一起算：置顶的只是列在最上面，还是在这个文件夹里
  const count = smart !== undefined ? notesIn(tree, path).length : countIn(tree.notes, path);
  // 逻辑目录的文件夹能拖（未整理固定在最后，不能拖）
  const draggable = tree.logical && !unsorted && !hint;
  // 点整行：有东西就展开 / 收起（按住 Alt 连子文件夹一起）；空的没什么可展开，进去 ——
  // 那里告诉你怎么往里放东西。搜索结果里的不展开，也是进去
  const activate = (all: boolean) => (expandable ? tree.toggle(path, all) : tree.open(path));

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expandable ? open : undefined}
      data-folder-row={path}
      // 智能文件夹里放不了东西；未整理只收笔记（noteDrag 里管）
      data-drop-folder={smart === undefined ? path : undefined}
      data-drop-branch={draggable ? path : undefined}
      data-spring-open={expandable && !open ? "" : undefined}
      onPointerDown={(event) => {
        if (!draggable) return;
        beginFolderDrag(event, path, folderName(path), {
          onDrop: (target) => tree.dropFolder(path, target),
          onSpringOpen: tree.springOpen,
        });
      }}
      onClick={(event) => {
        if (!consumeDragClick()) activate(event.altKey);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate(event.altKey);
        } else if (event.key === "ArrowRight" && expandable && !open) {
          event.preventDefault();
          tree.toggle(path, event.altKey);
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          if (open) tree.toggle(path, false);
          else
            document
              .querySelector<HTMLElement>(`[data-folder-row="${CSS.escape(parentOf(path))}"]`)
              ?.focus();
        }
      }}
      style={{ paddingLeft: ROW_PAD + depth * INDENT }}
      className={cn(TREE_ROW, dragged && "opacity-40")}
    >
      {edge && <DropLine edge={edge} indent={ROW_PAD + depth * INDENT} />}
      <span
        key={flashing ? tree.flash?.at : undefined}
        className={cn(
          "absolute inset-x-0 inset-y-[2px] rounded-lg transition-[background-color,box-shadow] duration-[150ms]",
          dropOn
            ? "bg-accent-wash ring-1 ring-accent-line"
            : menuOpen
              ? "bg-raised/40"
              : "group-hover:bg-raised/40",
          flashing && !dropOn && "odea-folder-flash",
        )}
      />
      {/* 图标位：有东西可展开的，悬停时文件夹图标让位给箭头（整行都能点，箭头只是告诉你点了会展开） */}
      <span className="relative z-10 grid h-5 w-5 shrink-0 place-items-center">
        <FolderGlyph
          open={open || dropOn}
          accent={dropOn}
          expandable={expandable}
          icon={glyphOf(path)}
        />
        {expandable && <Twisty open={open} hidden={dropOn} />}
      </span>
      <span
        className={cn(
          "relative z-10 min-w-0 flex-1 truncate text-[13px] font-medium",
          dropOn ? "text-accent" : "text-ink/90",
        )}
      >
        {folderName(path)}
        {hint && parentOf(path) && (
          <span className="ml-1.5 text-[12px] font-normal text-faint">
            {folderLabel(parentOf(path))}
          </span>
        )}
      </span>
      {/* 右边一格：静止时是篇数，悬停时换成「…」。淡的是颜色，不是 opacity（CLAUDE.md 动效规矩第 3 条：
          一排很多个的不进合成层）。未整理是固定的，没有菜单 */}
      <span className="relative z-20 -mr-1 grid min-w-5 shrink-0 place-items-center justify-items-end">
        <span
          className={cn(
            "col-start-1 row-start-1 pr-[3px] text-[12px] tabular-nums transition-colors duration-[150ms]",
            unsorted
              ? "text-faint"
              : menuOpen
                ? "text-transparent"
                : "text-faint group-hover:text-transparent",
          )}
        >
          {count}
        </span>
        {!unsorted && (
          <div
            className="odea-row-actions col-start-1 row-start-1"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <RowMenu onOpenChange={setMenuOpen} actions={folderActions(tree, path, smart, count)} />
          </div>
        )}
      </span>
    </div>
  );
}

/** 文件夹的「…」菜单：本地目录、逻辑目录的文件夹、智能文件夹各不一样 */
function folderActions(
  tree: TreeContextValue,
  path: string,
  smart: string | undefined,
  count: number,
) {
  // 「进去」不再是点一下（点一下是展开），放在菜单里
  const focus = {
    id: "focus",
    label: "聚焦到这里",
    icon: Focus,
    onSelect: () => tree.open(path),
  };
  if (smart !== undefined) {
    return [
      focus,
      {
        id: "edit",
        label: "改条件…",
        icon: ListFilter,
        onSelect: () => tree.editSmartFolder(path),
      },
      { id: "rename", label: "重命名", icon: Pencil, onSelect: () => tree.startRename(path) },
      {
        id: "delete",
        label: "删除智能文件夹",
        hint: "只是不再列出，笔记都还在",
        icon: Trash2,
        danger: true,
        onSelect: () => tree.remove(path),
      },
    ];
  }
  return [
    focus,
    {
      id: "new-note",
      label: "新建笔记",
      icon: FilePlus,
      onSelect: () => tree.newNote(path),
    },
    {
      id: "new-sub",
      label: "新建子文件夹",
      icon: FolderPlus,
      onSelect: () => tree.startNewFolder(path),
    },
    ...(tree.logical
      ? [
          {
            id: "new-smart",
            label: "新建智能文件夹…",
            icon: ListFilter,
            onSelect: () => tree.newSmartFolder(path),
          },
        ]
      : []),
    { id: "rename", label: "重命名", icon: Pencil, onSelect: () => tree.startRename(path) },
    {
      id: "import",
      label: "导入文件夹到这里…",
      icon: Import,
      onSelect: () => tree.importHere(path),
    },
    // 逻辑目录的文件夹不在硬盘上
    ...(tree.logical
      ? []
      : [
          {
            id: "reveal",
            label: "在文件夹中显示",
            icon: FolderOpen,
            onSelect: () => void useData.getState().revealFolder(path),
          },
        ]),
    {
      id: "delete",
      label: count ? `删除文件夹和 ${count} 篇笔记` : "删除文件夹",
      icon: Trash2,
      danger: true,
      onSelect: () => tree.remove(path),
    },
  ];
}

/** 未整理、智能文件夹的图标（普通的文件夹是 undefined：合着 / 打开的文件夹） */
const glyphOf = (path: string): LucideIcon | undefined =>
  path === UNSORTED ? Inbox : smartQuery(path) !== undefined ? ListFilter : undefined;

/** 拖着排顺序时的插入线：画在这一行的上边或下边，直接出现（不做动画） */
function DropLine({ edge, indent }: { edge: "above" | "below"; indent: number }) {
  return (
    <span
      aria-hidden="true"
      style={{ left: indent }}
      className={cn(
        "pointer-events-none absolute right-2 z-30 h-[2px] rounded-full bg-accent",
        edge === "above" ? "-top-px" : "-bottom-px",
      )}
    />
  );
}

/**
 * 文件夹图标：平时合着，展开 / 拖到上面时打开。有子内容的悬停时让位给箭头（Twisty）。
 * 让位淡的是颜色，不是 opacity：一列文件夹每个都进合成层的话，淡完那一帧退回页面会挪半个像素
 */
function FolderGlyph({
  open,
  accent,
  expandable,
  icon,
}: { open: boolean; accent?: boolean; expandable?: boolean; icon?: LucideIcon }) {
  const Icon = icon ?? (open ? FolderOpen : Folder);
  return (
    <Icon
      size={14}
      strokeWidth={1.9}
      className={cn(
        "col-start-1 row-start-1 transition-colors duration-[150ms]",
        // 拖到上面时一直是打开的文件夹（箭头这时候让位）
        accent
          ? "text-accent"
          : expandable
            ? "text-faint group-hover:text-transparent"
            : "text-faint",
      )}
    />
  );
}

/**
 * 悬停时图标位上的箭头：收着朝右，展开了朝下。和右侧目录树的收起箭头一样（components/Outline.tsx）：
 * 淡入淡出的是颜色，转的是 SVG 里的 <path>，都在原地重画、不进合成层，不用 will-change、不用对齐像素
 */
function Twisty({ open, hidden }: { open: boolean; hidden: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={13}
      height={13}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(
        "col-start-1 row-start-1 text-transparent transition-colors duration-[150ms]",
        !hidden && "group-hover:text-faint",
      )}
    >
      <title>{open ? "收起（按住 Alt 连子文件夹一起）" : "展开（按住 Alt 连子文件夹一起）"}</title>
      <motion.path
        d="m9 18 6-6-6-6"
        initial={false}
        animate={{ rotate: open ? 90 : 0 }}
        transition={tween.base}
      />
    </svg>
  );
}

/**
 * 树上一篇笔记：标题一行；开着「显示摘要」时底下再一行摘要，哪一层都一样。
 * 选中与否自己订阅：换一篇只重渲染新旧两行。
 * 右边一格：置顶的静止时是图钉，悬停时换成「…」（和卡片一样的菜单）
 */
const TreeNoteRow = memo(function TreeNoteRow({
  note,
  depth,
  reorderIn,
  where,
  filtered,
}: {
  note: NoteSummary;
  depth: number;
  /** 手动排序：这一行是落点，拖来的插在它前后（它所在的文件夹） */
  reorderIn?: string;
  /** 置顶那一组里：它在哪个文件夹（不在列表栏这一层的才给），名字后面淡淡地写上 */
  where?: string;
  /**
   * 智能文件夹筛出来的：同一篇在树上还有它本来的位置。选中时这里只淡淡地亮（同快捷方式），
   * 不然两处一样亮，看不出哪一处是它真正在的地方
   */
  filtered?: boolean;
}) {
  const tree = useTreeActions();
  const selected = useApp((s) => s.selectedNoteId === note.id);
  const excerpts = useApp((s) => s.noteExcerpts);
  const dragging = useNoteDrag((s) => draggingNote(s) === note.id);
  const edge = useNoteDrag((s) => (reorderIn === undefined ? null : noteEdge(s, note.id)));
  const title = useListTitle(note);
  const menu = useNoteMenu(note);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected ? "true" : undefined}
      data-note-row={note.id}
      data-drop-note={reorderIn === undefined ? undefined : note.id}
      data-note-folder={reorderIn}
      onPointerDown={(event) =>
        beginNoteDrag(event, note, {
          onDrop: (target) => tree.dropNote(note.id, target),
          onSpringOpen: tree.springOpen,
        })
      }
      onClick={() => {
        if (!consumeDragClick()) tree.select(note.id);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          tree.select(note.id);
        }
      }}
      style={{ paddingLeft: ROW_PAD + depth * INDENT }}
      className={cn(TREE_ROW, excerpts && EXCERPT_ROW, dragging && "opacity-40")}
    >
      {edge && <DropLine edge={edge} indent={ROW_PAD + depth * INDENT} />}
      <span
        className={cn(
          "absolute inset-x-0 inset-y-[2px] rounded-lg transition-colors duration-[150ms]",
          selected
            ? filtered
              ? "bg-accent-wash/60"
              : "bg-accent-wash"
            : menuOpen
              ? "bg-raised/40"
              : "group-hover:bg-raised/40",
        )}
      />
      <span className="relative z-10 grid h-5 w-5 shrink-0 place-items-center text-faint">
        <FileText size={13} strokeWidth={1.8} />
      </span>
      <span className="relative z-10 min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-[13px]",
            excerpts && "leading-5",
            selected && !filtered ? "font-medium text-ink" : selected ? "text-ink" : "text-body",
          )}
        >
          {title}
          {where !== undefined && (
            <span className="ml-1.5 text-[12px] font-normal text-faint">{folderLabel(where)}</span>
          )}
        </span>
        {excerpts && (
          <span className="block truncate text-[12px] leading-[17px] text-muted">
            {animatedEmojiText(note.excerpt)}
          </span>
        )}
      </span>
      {note.conflictOf && (
        <span
          className={cn(
            "relative z-10 shrink-0 text-[12px] font-medium text-warning",
            excerpts && "leading-5",
          )}
        >
          副本
        </span>
      )}
      {/* 图钉和「…」叠在同一格里：悬停时图钉淡成透明、「…」淡出来。淡的都是颜色（同文件夹行的篇数） */}
      <span className="relative z-20 -mr-1 grid shrink-0 place-items-center">
        {note.isPinned && (
          <Pin
            size={10.5}
            strokeWidth={2}
            aria-hidden="true"
            className={cn(
              "pointer-events-none col-start-1 row-start-1 rotate-45 transition-colors duration-[150ms]",
              menuOpen ? "text-transparent" : "text-accent group-hover:text-transparent",
            )}
          />
        )}
        <div
          className="odea-row-actions col-start-1 row-start-1"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <RowMenu onOpenChange={setMenuOpen} actions={menu} />
        </div>
      </span>
    </div>
  );
});

/** 一篇笔记的「…」菜单：卡片和树上的行是同一份 */
function useNoteMenu(note: NoteSummary): MenuAction[] {
  const tree = useTreeActions();
  const togglePin = useData((s) => s.togglePin);
  const archiveNote = useData((s) => s.archiveNote);
  // 归档单独一个开关（和日程无关）：没开的仓库里没有「归档」这一项
  const archiveOn = useData((s) => s.layout.archive);
  const logical = useData((s) => s.layout.logical);
  const deleteNote = useData((s) => s.deleteNote);
  const revealDocument = useData((s) => s.revealDocument);
  const where = folderOf(note);
  return [
    {
      id: "pin",
      label: note.isPinned ? "取消置顶" : "置顶",
      icon: note.isPinned ? PinOff : Pin,
      onSelect: () => togglePin(note.id),
    },
    {
      id: "move",
      label: "移动到…",
      icon: FolderInput,
      onSelect: () => tree.moveTo(note.id),
    },
    // 逻辑目录：一篇只在一个位置，别处要看得到它就放快捷方式（docs/仓库与启动器.md §7.5）
    ...(logical
      ? [
          {
            id: "shortcut",
            label: "添加快捷方式到…",
            icon: FileSymlink,
            onSelect: () => tree.shortcutTo(note.id),
          },
        ]
      : []),
    // 逻辑目录：挪出文件夹和删除是两回事（docs/仓库与启动器.md §7.5），只改清单
    ...(logical && where !== UNSORTED
      ? [
          {
            id: "unsort",
            label: "移到未整理",
            icon: Inbox,
            onSelect: () => tree.unsort(note.id),
          },
        ]
      : []),
    {
      // 每篇笔记就是笔记文件夹里的一个 .md 文件：打开资源管理器并选中它
      id: "reveal",
      label: "在文件夹中显示",
      icon: FolderOpen,
      onSelect: () => void revealDocument({ kind: "note", id: note.id }),
    },
    ...(archiveOn
      ? [
          {
            id: "archive",
            label: "归档",
            icon: Archive,
            onSelect: () => {
              selectNeighbor(note.id);
              void archiveNote(note.id);
            },
          },
        ]
      : []),
    {
      id: "delete",
      label: "删除",
      icon: Trash2,
      danger: true,
      onSelect: () => {
        selectNeighbor(note.id);
        void deleteNote(note.id);
      },
    },
  ];
}

/**
 * 快捷方式（逻辑目录，docs/仓库与启动器.md §7.5）：一行，标题是它指着的那篇，图标带个小箭头。
 * 点一下打开那篇（列表栏留在这里）；「…」里「打开原位置」到那篇真正所在的文件夹，「删除快捷方式」只拿掉这一行
 */
const TreeShortcutRow = memo(function TreeShortcutRow({
  shortcut,
  depth,
}: { shortcut: Shortcut; depth: number }) {
  const tree = useTreeActions();
  const note = useData((s) => s.notes.find((item) => item.id === shortcut.note));
  const selected = useApp((s) => s.selectedNoteId === shortcut.note);
  const [menuOpen, setMenuOpen] = useState(false);
  if (!note) return null;
  const where = folderOf(note);
  return (
    <div
      role="button"
      tabIndex={0}
      data-shortcut-row={shortcut.node}
      onClick={() => tree.select(note.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          tree.select(note.id);
        }
      }}
      title={`快捷方式 · 在「${folderLabel(where)}」`}
      style={{ paddingLeft: ROW_PAD + depth * INDENT }}
      className={TREE_ROW}
    >
      <span
        className={cn(
          "absolute inset-x-0 inset-y-[2px] rounded-lg transition-colors duration-[150ms]",
          selected ? "bg-accent-wash/60" : menuOpen ? "bg-raised/40" : "group-hover:bg-raised/40",
        )}
      />
      <span className="relative z-10 grid h-5 w-5 shrink-0 place-items-center text-faint">
        <FileSymlink size={13} strokeWidth={1.8} />
      </span>
      <ShortcutTitle note={note} selected={selected} />
      <div
        className="odea-row-actions relative z-20 -mr-1 shrink-0"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <RowMenu
          onOpenChange={setMenuOpen}
          actions={[
            {
              id: "origin",
              label: "打开原位置",
              icon: FolderOpen,
              onSelect: () => tree.openOrigin(note.id),
            },
            {
              id: "remove",
              label: "删除快捷方式",
              icon: Trash2,
              danger: true,
              onSelect: () => tree.removeShortcut(shortcut.node),
            },
          ]}
        />
      </div>
    </div>
  );
});

function ShortcutTitle({ note, selected }: { note: NoteSummary; selected: boolean }) {
  const title = useListTitle(note);
  return (
    <span
      className={cn(
        "relative z-10 min-w-0 flex-1 truncate text-[13px] italic",
        selected ? "text-ink" : "text-body",
      )}
    >
      {title}
    </span>
  );
}

/** 树上一张图片的地址：桌面端按仓库的绝对路径转成 asset 协议；浏览器预览里原样交给 <img> */
function fileSource(vaultRoot: string | null, relPath: string): string {
  if (!isTauri || !vaultRoot) return relPath;
  return convertFileSrc(`${vaultRoot.replaceAll("\\", "/")}/${relPath}`);
}

/**
 * 树上的一个图片、PDF（docs/仓库与启动器.md §11）：一行，和展开的文件夹里的笔记一样高。
 * 图片的图标位是它自己的缩略图，点一下从这张缩略图放大成大图（editor/imageViewer.ts）；
 * PDF 交给系统的默认程序。「…」里能用默认程序打开、在文件夹中显示
 */
const TreeFileRow = memo(function TreeFileRow({
  file,
  depth,
  hint,
}: { file: TreeFile; depth: number; hint?: boolean }) {
  const vaultRoot = useData((s) => s.vaultRoot);
  const openTreeFile = useData((s) => s.openTreeFile);
  const thumb = useRef<HTMLImageElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const image = file.kind === "image" && !broken;
  const open = async () => {
    const source = thumb.current;
    if (image && source?.complete && source.naturalWidth) {
      const { openImageViewer } = await import("@/editor/imageViewer");
      openImageViewer(source);
    } else void openTreeFile(file.relPath);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      data-file-row={file.relPath}
      onClick={() => void open()}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void open();
        }
      }}
      title={file.name}
      style={{ paddingLeft: ROW_PAD + depth * INDENT }}
      className={TREE_ROW}
    >
      <span
        className={cn(
          "absolute inset-x-0 inset-y-[2px] rounded-lg transition-colors duration-[150ms]",
          menuOpen ? "bg-raised/40" : "group-hover:bg-raised/40",
        )}
      />
      <span className="relative z-10 grid h-5 w-5 shrink-0 place-items-center text-faint">
        {image ? (
          <img
            ref={thumb}
            src={fileSource(vaultRoot, file.relPath)}
            alt={file.name}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setBroken(true)}
            className="h-4 w-4 rounded-[3px] object-cover ring-1 ring-line-strong"
          />
        ) : (
          <FileType size={13} strokeWidth={1.8} />
        )}
      </span>
      <span className="relative z-10 min-w-0 flex-1 truncate text-[13px] text-body">
        {file.name}
        {hint && file.folder && (
          <span className="ml-1.5 text-[12px] text-faint">{folderLabel(file.folder)}</span>
        )}
      </span>
      <div
        className="odea-row-actions relative z-20 -mr-1 shrink-0"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <RowMenu
          onOpenChange={setMenuOpen}
          actions={[
            {
              id: "open",
              label: "用默认程序打开",
              icon: FileType,
              onSelect: () => void openTreeFile(file.relPath),
            },
            {
              id: "reveal",
              label: "在文件夹中显示",
              icon: FolderOpen,
              onSelect: () => void openTreeFile(file.relPath, true),
            },
          ]}
        />
      </div>
    </div>
  );
});

/** 就地起名：新建文件夹、改名。回车确定，Esc 取消，点别处也算确定 */
function FolderNameInput({
  depth,
  initial,
  fresh,
}: { depth: number; initial: string; fresh?: boolean }) {
  const tree = useTree();
  const input = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const submit = () => {
    if (settled.current) return;
    settled.current = true;
    const value = input.current?.value.trim() ?? "";
    // 改名时没改就当取消；新建时留着默认名也照建
    if (value && (fresh || value !== initial)) tree.submitName(value);
    else tree.cancelName();
  };

  return (
    // 新建：输入框那一行按高度展开；改名：原地换掉那一行，不动
    <TreeSlot slide={!!fresh}>
      <div
        style={{ paddingLeft: ROW_PAD + depth * INDENT }}
        className="relative flex h-[34px] items-center gap-1.5 pr-3"
      >
        <span className="grid h-5 w-5 shrink-0 place-items-center text-faint">
          <Folder size={14} strokeWidth={1.9} />
        </span>
        <input
          ref={input}
          defaultValue={initial}
          aria-label={fresh ? "新文件夹的名字" : "文件夹的新名字"}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              settled.current = true;
              tree.cancelName();
            }
          }}
          onBlur={submit}
          // 框往左多出 7px，框里的字和起好名之后那一行的名字对齐（同样的字号、字重、颜色）：
          // 回车之后字原地不动，只是框没了
          className={cn(
            "-ml-[7px] h-[26px] min-w-0 flex-1 rounded-md bg-canvas px-[7px] text-[13px] outline-none",
            "font-medium text-ink/90 ring-1 ring-accent-line focus:shadow-[0_0_0_3px_var(--color-accent-wash)]",
          )}
        />
      </div>
    </TreeSlot>
  );
}

/** 进了文件夹以后搜索框下面那一行：上面每一层都能点，也能把笔记拖上去 */
function Crumbs({ folder, onNavigate }: { folder: string; onNavigate: (path: string) => void }) {
  // 未整理就在根下面
  const parts = folder === UNSORTED ? [UNSORTED] : folder.split("/");
  const ancestors = ["", ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"))];
  return (
    <nav
      aria-label="所在位置"
      className="mt-2 -ml-[5px] flex h-[22px] min-w-0 items-center gap-0.5 text-[12px]"
    >
      {ancestors.map((path, i) => (
        <Fragment key={path || "/"}>
          {i > 0 && <span className="shrink-0 px-px text-faint">/</span>}
          <Crumb path={path} first={i === 0} onNavigate={onNavigate} />
        </Fragment>
      ))}
    </nav>
  );
}

function Crumb({
  path,
  first,
  onNavigate,
}: { path: string; first: boolean; onNavigate: (path: string) => void }) {
  const dropOn = useNoteDrag((s) => dropInto(s) === path);
  return (
    <button
      type="button"
      data-drop-folder={path}
      title={folderLabel(path)}
      onClick={() => onNavigate(path)}
      className={cn(
        "flex h-[22px] min-w-0 items-center gap-0.5 rounded-md px-[5px] text-muted",
        "transition-colors duration-[140ms] hover:bg-raised/60 hover:text-ink",
        first ? "shrink-0" : "max-w-[96px]",
        dropOn && "bg-accent-wash text-accent ring-1 ring-accent-line",
      )}
    >
      {first && <ChevronLeft size={12} strokeWidth={2} className="shrink-0" />}
      <span className="truncate">{path ? nameOf(path) : rootLabel()}</span>
    </button>
  );
}

/** 拖着的那篇：跟着指针的一张小卡片，写着会放到哪 */
function NoteDragGhost() {
  const { item, x, y, target } = useNoteDrag();
  if (!item) return null;
  const hint =
    target === null
      ? item.kind === "note"
        ? "拖到文件夹上"
        : "拖到文件夹上，或者两个文件夹之间"
      : target.kind === "into"
        ? `移到「${folderLabel(target.folder)}」`
        : target.kind === "note"
          ? `排在这里${target.folder === folderOf({ relPath: "", id: item.kind === "note" ? item.id : "" }) ? "" : `（移到「${folderLabel(target.folder)}」）`}`
          : `排在「${folderLabel(parentOf(target.path))}」里这个位置`;
  return createPortal(
    <div
      // left / top 走主线程：影子里的字不会先糊后清
      style={{ left: Math.round(x + 14), top: Math.round(y + 12) }}
      className="odea-drag-ghost pointer-events-none fixed z-[60] max-w-[230px] rounded-lg bg-canvas px-[11px] pt-[7px] pb-2
                 shadow-float ring-1 ring-line-strong"
    >
      <span className="block truncate text-[13px] font-semibold text-ink">{item.title}</span>
      <span
        className={cn("block truncate text-[12px]", target !== null ? "text-accent" : "text-faint")}
      >
        {hint}
      </span>
    </div>,
    document.body,
  );
}

/* ---------------- 笔记卡片 ---------------- */

const NoteCard = memo(function NoteCard({
  note,
  index,
  selected,
  folder,
  shapeTick,
  reorderIn,
  boxed,
  divided,
  appear = true,
}: {
  note: NoteSummary;
  index: number;
  selected: boolean;
  /** 列表栏现在在哪个文件夹 */
  folder: string;
  /** 手动排序：这一张是落点，拖来的插在它前后（它所在的文件夹） */
  reorderIn?: string;
  /** 列表的样子变了就加一（见 NotesList）：这时才量位置、播 layout 动画 */
  shapeTick: number;
  /** 置顶卡片带独立圆角底 */
  boxed?: boolean;
  /** 普通卡片之间画分隔线 */
  divided?: boolean;
  /** 挂上时淡入。往下滚才画出来的那几批不播：滚得快时会看到它们晚一拍浮上来 */
  appear?: boolean;
}) {
  const tree = useTreeActions();
  const menu = useNoteMenu(note);
  const dragging = useNoteDrag((s) => draggingNote(s) === note.id);
  const edge = useNoteDrag((s) => (reorderIn === undefined ? null : noteEdge(s, note.id)));
  // 「…」菜单开着的时候指针在菜单上、不在行上，行会掉出 hover 态；
  // 底色一暗一亮，看着像菜单和行没关系。开着就按住不放。
  const [menuOpen, setMenuOpen] = useState(false);
  // 不在当前这一层的（未整理里的置顶、搜索结果、智能文件夹）：摘要前面带上文件夹
  const where = folderOf(note);
  const showFolder = where !== "" && where !== folder && where !== UNSORTED;
  const title = useListTitle(note);

  return (
    <motion.div
      layout="position"
      layoutDependency={shapeTick}
      role="button"
      tabIndex={0}
      aria-current={selected ? "true" : undefined}
      data-note-row={note.id}
      data-drop-note={reorderIn === undefined ? undefined : note.id}
      data-note-folder={reorderIn}
      onPointerDown={(event) =>
        beginNoteDrag(event, note, {
          onDrop: (target) => tree.dropNote(note.id, target),
          onSpringOpen: tree.springOpen,
        })
      }
      onClick={() => {
        if (!consumeDragClick()) tree.select(note.id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          tree.select(note.id);
        }
      }}
      initial={appear ? { opacity: 0, y: 7 } : false}
      animate={{ opacity: dragging ? 0.4 : 1, y: 0 }}
      transition={{ ...tween.base, delay: Math.min(index, 9) * 0.028 }}
      className={cn(
        "group relative w-full cursor-default rounded-lg px-3 py-3 text-left",
        divided && "before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-line",
      )}
    >
      {edge && <DropLine edge={edge} indent={8} />}
      {/* 选中高亮：layoutId 让它在卡片之间滑过去，而不是瞬间跳过去 */}
      {selected && (
        <motion.span
          layoutId="note-selection"
          className={cn(
            "absolute inset-x-0 inset-y-[2px] rounded-lg bg-accent-wash",
            boxed && "ring-1 ring-accent-line/70",
          )}
          transition={spring.smooth}
        />
      )}
      {!selected && (
        /* 上下各缩 2px：底色铺满 inset-0 的话，选中那块和相邻那块悬停时会边贴边
           连成一片，看不出是两行。缩进之后中间留 4px，两块各自独立。
           「…」菜单开着时指针在菜单上、不在行上，这里按住不放。 */
        <span
          className={cn(
            "absolute inset-x-0 inset-y-[2px] rounded-lg transition-colors duration-[150ms]",
            menuOpen ? "bg-raised/40" : "bg-raised/0 group-hover:bg-raised/40",
          )}
        />
      )}

      <span className="relative z-10 flex items-start gap-2">
        <span className="min-w-0 flex-1">
          {/* 列表里标题只占一行，超出的部分用省略号；完整标题在正文区看。
              冲突副本显示原文的标题，副本的身份和时间放在摘要前面的标签里 */}
          <span
            className={cn(
              "block truncate text-[14px] font-semibold leading-[1.45]",
              selected ? "text-ink" : "text-ink/90",
            )}
          >
            {title}
          </span>
          <span className="mt-[3px] flex min-w-0 items-center text-[12px] leading-[1.45] text-muted">
            {showFolder && <FolderChip path={where} />}
            <span className="min-w-0 truncate">
              {note.conflictOf && <ConflictTag title={note.title} />}
              {animatedEmojiText(note.excerpt)}
            </span>
          </span>
        </span>

        {/* 占位：给右上角的图钉/菜单留出固定宽度，避免标题在悬停时抖动 */}
        <span className="block w-[13px] shrink-0" aria-hidden="true" />
      </span>

      {/* 操作菜单叠在图钉的位置：静止时看到图钉，悬停时换成「…」。
          图钉和「…」在同一个 20×20 的格子里居中：以前图钉画在上面那个占位里、靠左上排，
          比「…」高 2px、偏右 2px，一悬停换过来就跳一下。top 13：格子的中线对上标题那行字的中线 */}
      <div
        className="absolute right-[11px] top-[13px] z-20"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {note.isPinned && (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 grid place-items-center text-accent",
              "transition-opacity duration-[150ms] group-hover:opacity-0",
              menuOpen && "opacity-0",
            )}
          >
            <motion.span
              className="block"
              initial={{ scale: 0, rotate: -90 }}
              animate={{ scale: 1, rotate: 45 }}
              transition={spring.bouncy}
            >
              <Pin size={11.5} strokeWidth={2} className="block" />
            </motion.span>
          </span>
        )}
        <RowMenu onOpenChange={setMenuOpen} actions={menu} />
      </div>
    </motion.div>
  );
});

function FolderChip({ path }: { path: string }) {
  return (
    <span
      title={folderLabel(path)}
      className="mr-1.5 inline-flex max-w-[60%] shrink-0 items-center gap-[3px] rounded-[4px] bg-raised/70 py-px pr-[5px] pl-1
                 text-[12px] font-medium text-muted"
    >
      <Folder size={10} strokeWidth={2} className="shrink-0" />
      <span className="truncate">{nameOf(path)}</span>
    </span>
  );
}

/**
 * 列表里显示的标题。冲突副本的文件名是「原标题 (冲突 2026-08-28 2210)」这种（文件名里不能有冒号），
 * 列表里换成原文的标题 —— 身份和时间由摘要前面的标签说（ConflictTag）。原文是某一天 /
 * 目标时是「10月7日」「第 41 周目标」（data/conflicts.ts）
 */
export function useListTitle(note: NoteSummary): string {
  const original = useData((state) =>
    note.conflictOf ? conflictOriginalTitle(conflictTarget(note.conflictOf), state) : undefined,
  );
  return original ?? note.title;
}

/** 本应用另存的冲突副本，文件名里带着时间：`(冲突 2026-08-28 2210)` */
const CONFLICT_TIME_RE = /冲突\s*(\d{4})-(\d{2})-(\d{2})\s*(\d{2})(\d{2})/;

/** 摘要前面的小标签：这篇是别的笔记的冲突副本（网盘同步撞车留下的），能认出时间就带上 */
export function ConflictTag({ title }: { title: string }) {
  const time = CONFLICT_TIME_RE.exec(title);
  return (
    <span className="mr-1.5 inline-block rounded-[4px] bg-warning/15 px-1 text-[12px] font-medium text-warning">
      冲突副本
      {time && ` · ${Number(time[2])}月${Number(time[3])}日 ${time[4]}:${time[5]}`}
    </span>
  );
}

/**
 * 列表空了。有搜索词时是「没搜到」（配放大镜插画）；没有搜索词就是真的一篇都没有 ——
 * 正文区那边已经是大插画 + 「新建」，这里只留一行小字，不再重复一遍插画。
 * 以前两种情况都说「没有匹配的内容，试试更短的关键词」，可用户什么都没搜。
 */
export function EmptyResult({
  query,
  emptyTitle,
  emptyHint,
}: {
  query: string;
  /** 没有搜索词、列表本身就是空的时候显示的文案 */
  emptyTitle: string;
  emptyHint: string;
}) {
  const searching = query.trim() !== "";
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={searching ? "searching" : "empty"}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={tween.fast}
        className="px-3 pt-12"
      >
        {searching ? (
          <EmptyState size="sm" art="search" title="没有匹配的内容" hint="试试更短的关键词" />
        ) : (
          <div className="text-center">
            <p className="text-[13px] text-muted">{emptyTitle}</p>
            <p className="mt-1 text-[12px] text-faint">{emptyHint}</p>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
