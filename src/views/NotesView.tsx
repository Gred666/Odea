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
import { ActionMenu, RowMenu } from "@/components/RowMenu";
import { SearchInput } from "@/components/SearchInput";
import { conflictOriginalTitle, conflictTarget } from "@/data/conflicts";
import {
  ROOT_LABEL,
  childFolders,
  cleanFolderName,
  countIn,
  folderLabel,
  folderOf,
  nameOf,
  parentOf,
  renamedPath,
  uniqueChild,
  within,
} from "@/data/folders";
import { useData } from "@/data/store";
import type { Note } from "@/data/types";
import { cn } from "@/lib/cn";
import { animatedEmojiText } from "@/lib/emojiText";
import { spring, tween } from "@/lib/motion";
import {
  ALargeSmall,
  Archive,
  ArrowUpDown,
  CalendarPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  History,
  type LucideIcon,
  Pencil,
  Pin,
  PinOff,
  Plus,
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
import { beginNoteDrag, consumeDragClick, useNoteDrag } from "./notes/noteDrag";

type SortMode = NoteSort;
const SORT_MODES: SortMode[] = ["updated", "created", "title"];
const SORT_LABEL: Record<SortMode, string> = {
  updated: "按更新时间",
  created: "按创建时间",
  title: "按标题",
};
const SORT_ICON: Record<SortMode, LucideIcon> = {
  updated: History,
  created: CalendarPlus,
  title: ALargeSmall,
};

/** 树里每深一层缩进多少 */
const INDENT = 16;
/** 笔记卡片的高度（两行字 + 上下留白）：分批画时给还没画的那一截占位（ListColumn 的 MoreRows） */
const CARD_HEIGHT = 63.25;
/** 行的左内边距（图标位从这里开始） */
const ROW_PAD = 9;

type Editing = { kind: "new"; parent: string } | { kind: "rename"; path: string } | null;
type Picker = { mode: "jump" } | { mode: "move"; noteId: string } | null;
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

   文件夹就是仓库里「笔记」下面的子目录（data/folders.ts）。列表栏是「当前文件夹」
   的视图：上面是置顶，然后是这一层的文件夹，最后是直接放在这一层的笔记。

   - 文件夹就地展开：图标位悬停变成箭头，点开在原地列出子文件夹和里面笔记的标题
     （只有标题，一行一篇），展开了哪些记在本机。点文件夹的其余地方是进去
   - 进了文件夹，搜索框下面一行面包屑回上层（标题栏那 38px 是拖窗口的，放不了按钮）；
     点标题打开文件夹切换器，任意文件夹之间直接跳
   - 笔记可以拖进任何看得见的文件夹（含面包屑），停在收起的文件夹上会自动展开
   - 「全部笔记」里的置顶包括所有文件夹里置顶的笔记，带上所在文件夹
   - 搜索标题时搜所有文件夹
   ============================================================ */

export function NotesList({ notes }: { notes: Note[] }) {
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
  const createNote = useData((s) => s.createNote);
  const createFolder = useData((s) => s.createFolder);
  const renameFolder = useData((s) => s.renameFolder);
  const deleteFolder = useData((s) => s.deleteFolder);
  const moveNote = useData((s) => s.moveNote);
  // 排序记在本机：以前切到日历再回来就变回「按更新时间」
  const sort = useApp((s) => s.noteSort);
  const setSort = useApp((s) => s.setNoteSort);
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
    if (!folder || renaming.current || folders.includes(folder)) return;
    let up = parentOf(folder);
    while (up && !folders.includes(up)) up = parentOf(up);
    setNoteFolder(up);
  }, [folder, folders, setNoteFolder]);

  const sortNotes = useCallback(
    (list: Note[]) =>
      // 「按更新时间」直接用 store 里的顺序（加载 / 置顶 / 归档时已按 updatedAt 排好），
      // 不在这里按 updatedAt 重排：自动保存每 400ms 刷新一次它，正在编辑的那篇
      // 会在侧栏里当着用户的面往上跳 —— store 刻意不重排就是为了避免这个。
      sort === "updated"
        ? list
        : [...list].sort((a, b) =>
            sort === "title"
              ? a.title.localeCompare(b.title, "zh-Hans-CN")
              : b.createdAt - a.createdAt,
          ),
    [sort],
  );

  /** 每个文件夹里直接放着的笔记（按当前排序） */
  const notesByFolder = useMemo(() => {
    const map = new Map<string, Note[]>();
    for (const note of sortNotes(notes)) {
      const key = folderOf(note);
      const list = map.get(key);
      if (list) list.push(note);
      else map.set(key, [note]);
    }
    return map;
  }, [notes, sortNotes]);

  // 只按标题筛（不走全文搜索：输入「周」翻出一堆正文里提到它的笔记，跟标题对不上）。
  // 有搜索词时搜所有文件夹。
  const q = query.trim().toLowerCase();
  const view = useMemo(() => {
    if (q) {
      return {
        search: true,
        pinned: [] as Note[],
        folders: folders
          .filter((path) => nameOf(path).toLowerCase().includes(q))
          .sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
        notes: sortNotes(notes.filter((n) => n.title.toLowerCase().includes(q))),
      };
    }
    const here = notesByFolder.get(folder) ?? [];
    return {
      search: false,
      pinned: sortNotes(
        notes.filter((n) => n.isPinned && (folder === "" || folderOf(n) === folder)),
      ),
      folders: childFolders(folders, folder),
      notes: here.filter((n) => !n.isPinned),
    };
  }, [q, folders, folder, notes, notesByFolder, sortNotes]);

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

  const handleCreate = async () => {
    // 后端慢的时候连点两下会白建好几篇空笔记
    if (creating) return;
    setCreating(true);
    try {
      const id = await createNote(folder);
      if (!id) return;
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
      // 输入框在这一层的最上面：新文件夹也排在第一个，就是原地
      const inPlace = childFolders([...folders, guess], current.parent)[0] === guess;
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
    const inPlace =
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

  const openPicker = (next: NonNullable<Picker>) => {
    const button = titleButton.current;
    if (button) setPickerTop(button.offsetTop + button.offsetHeight + 6);
    setPicker(next);
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
    move: (id, to) => void move(id, to),
    springOpen: (path) => setFolderExpanded([path], true),
    startNewFolder,
    startRename: (path) => setEditing({ kind: "rename", path }),
    remove: removeFolder,
    submitName: (name) => void submitName(name),
    cancelName: () => setEditing(null),
    moveTo: (id) => openPicker({ mode: "move", noteId: id }),
  };
  const actions = useMemo<TreeActions>(() => {
    const now = () => latest.current as TreeActions;
    return {
      open: (path) => now().open(path),
      toggle: (path, all) => now().toggle(path, all),
      select: (id) => now().select(id),
      move: (id, to) => now().move(id, to),
      springOpen: (path) => now().springOpen(path),
      startNewFolder: (parent) => now().startNewFolder(parent),
      startRename: (path) => now().startRename(path),
      remove: (path) => now().remove(path),
      submitName: (name) => now().submitName(name),
      cancelName: () => now().cancelName(),
      moveTo: (id) => now().moveTo(id),
    };
  }, []);
  const tree = useMemo<TreeContextValue>(
    () => ({ ...actions, folder, notesByFolder, folders, notes, expanded, editing, flash, settle }),
    [actions, folder, notesByFolder, folders, notes, expanded, editing, flash, settle],
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
    [...expanded].map((path) => `${path}:${notesByFolder.get(path)?.length ?? 0}`).join(","),
    editing ? `${editing.kind}:${editing.kind === "new" ? editing.parent : editing.path}` : "",
    settle ? `${settle.path}:${settle.at}` : "",
  ].join("\n");
  const shape = useRef({ key: shapeKey, tick: 0 });
  if (shape.current.key !== shapeKey)
    shape.current = { key: shapeKey, tick: shape.current.tick + 1 };
  const shapeTick = shape.current.tick;

  const groups: { key: string; label: ReactNode; body: ReactNode }[] = [];
  if (view.pinned.length) {
    groups.push({
      key: "pinned",
      label: <GroupLabel icon={<Pin size={10} strokeWidth={2} />} text="置顶" />,
      body: view.pinned.map((n, i) => (
        <NoteCard
          key={n.id}
          note={n}
          index={i}
          selected={n.id === selectedId}
          folder={folder}
          shapeTick={shapeTick}
          boxed
        />
      )),
    });
  }
  const newHere = !view.search && editing?.kind === "new" && editing.parent === folder;
  if (view.folders.length || newHere) {
    groups.push({
      key: "folders",
      label: <GroupLabel text="文件夹" />,
      body: view.search ? (
        view.folders.map((path) => <FolderRow key={path} path={path} depth={0} hint />)
      ) : (
        <>
          <AnimatePresence initial={false} custom={settle?.slide ?? true}>
            {newHere && <FolderNameInput key="new" depth={0} initial="新建文件夹" fresh />}
          </AnimatePresence>
          <FolderBranch parent={folder} depth={0} />
        </>
      ),
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
              divided={i > 0}
              appear={i < ROW_BATCH}
            />
          ))}
          {rest > 0 && <MoreRows height={rest * CARD_HEIGHT} onNear={more} />}
        </div>
      ),
    });
  }
  const labelled = groups.length > 1 || view.pinned.length > 0 || view.search;
  const pickerNote =
    picker?.mode === "move" ? notes.find((note) => note.id === picker.noteId) : undefined;

  return (
    <TreeActionsContext.Provider value={actions}>
      <TreeContext.Provider value={tree}>
        <ListColumn
          title={folder ? nameOf(folder) : ROOT_LABEL}
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
                    className="truncate text-[25px] font-bold leading-tight tracking-[-0.02em] text-ink"
                  >
                    {folder ? nameOf(folder) : ROOT_LABEL}
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
                选项、也不知道现在是哪一种，得点三下才能确认转了一圈。 */}
              <ActionMenu
                trigger={
                  <ColumnButton label={`排序：${SORT_LABEL[sort]}`}>
                    <ArrowUpDown size={13} strokeWidth={1.9} />
                  </ColumnButton>
                }
                actions={SORT_MODES.map((mode) => ({
                  id: mode,
                  label: SORT_LABEL[mode],
                  icon: SORT_ICON[mode],
                  checked: sort === mode,
                  onSelect: () => setSort(mode),
                }))}
              />
              <ColumnButton label="新建文件夹" onClick={() => startNewFolder(folder)}>
                <FolderPlus size={14} strokeWidth={1.9} />
              </ColumnButton>
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
              {picker && (
                <FolderPicker
                  key={picker.mode === "move" ? `move:${picker.noteId}` : "jump"}
                  mode={picker.mode}
                  current={picker.mode === "jump" ? folder : pickerNote ? folderOf(pickerNote) : ""}
                  noteTitle={pickerNote?.title}
                  top={pickerTop}
                  onClose={() => setPicker(null)}
                  onPick={(path) => {
                    setPicker(null);
                    if (picker.mode === "jump") navigate(path);
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
                    indexing ? "正在读取笔记文件夹…" : folder ? "这个文件夹还是空的" : "还没有笔记"
                  }
                  emptyHint={
                    indexing
                      ? "读完了笔记就会出现在这里"
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
  move: (id: string, to: string) => void;
  springOpen: (path: string) => void;
  startNewFolder: (parent: string) => void;
  startRename: (path: string) => void;
  remove: (path: string) => void;
  submitName: (name: string) => void;
  cancelName: () => void;
  moveTo: (id: string) => void;
}

/** 文件夹那几行要的东西：数据 + 操作。笔记、展开、起名……一变就换一份 */
interface TreeContextValue extends TreeActions {
  folder: string;
  notesByFolder: Map<string, Note[]>;
  folders: string[];
  notes: Note[];
  expanded: Set<string>;
  editing: Editing;
  flash: { path: string; at: number } | null;
  settle: Settle;
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

/** 展开一个文件夹看得到什么：子文件夹，或者直接放在里面的笔记 */
function hasContent(tree: TreeContextValue, path: string) {
  return (
    childFolders(tree.folders, path).length > 0 || (tree.notesByFolder.get(path)?.length ?? 0) > 0
  );
}

/** parent 下面这一层的文件夹，展开的那些连同里面的东西一起 */
function FolderBranch({ parent, depth }: { parent: string; depth: number }) {
  const tree = useTree();
  return (
    <AnimatePresence initial={false} custom={tree.settle?.slide ?? true}>
      {childFolders(tree.folders, parent).map((path) => (
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
  const notes = tree.notesByFolder.get(path) ?? [];
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
            <AnimatePresence initial={false} custom={tree.settle?.slide ?? true}>
              {newInside && (
                <FolderNameInput key="new" depth={depth + 1} initial="新建文件夹" fresh />
              )}
            </AnimatePresence>
            <FolderBranch parent={path} depth={depth + 1} />
            {notes.map((note) => (
              <TreeNoteRow key={note.id} note={note} depth={depth + 1} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function FolderRow({ path, depth, hint }: { path: string; depth: number; hint?: boolean }) {
  const tree = useTree();
  const dropOn = useNoteDrag((s) => s.target === path);
  const [menuOpen, setMenuOpen] = useState(false);
  const expandable = !hint && hasContent(tree, path);
  const open = expandable && tree.expanded.has(path);
  const nested = depth > 0;
  const flashing = tree.flash?.path === path;
  const count = countIn(tree.notes, path);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expandable ? open : undefined}
      data-folder-row={path}
      data-drop-folder={path}
      data-spring-open={expandable && !open ? "" : undefined}
      onClick={() => {
        if (!useNoteDrag.getState().noteId) tree.open(path);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          tree.open(path);
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
      className={cn(
        "group relative flex cursor-default items-center gap-1.5 rounded-lg pr-3 outline-none",
        "focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-inset",
        nested ? "h-[34px]" : "h-10",
      )}
    >
      <span
        key={flashing ? tree.flash?.at : undefined}
        className={cn(
          "absolute inset-x-0 inset-y-[2px] rounded-lg transition-[background-color,box-shadow] duration-[150ms]",
          dropOn
            ? "bg-accent-wash ring-1 ring-accent-line"
            : menuOpen
              ? "bg-raised/40"
              : "group-hover:bg-raised/40",
          flashing && !dropOn && "otw-folder-flash",
        )}
      />
      {expandable ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? "收起" : "展开"}
          title={open ? "收起" : "展开（按住 Alt 连子文件夹一起）"}
          onClick={(event) => {
            event.stopPropagation();
            tree.toggle(path, event.altKey);
          }}
          className="relative z-10 grid h-5 w-5 shrink-0 place-items-center rounded-[5px] text-faint
                     transition-colors duration-[140ms] hover:bg-raised hover:text-ink"
        >
          <FolderGlyph open={open || dropOn} accent={dropOn} expandable />
          <ChevronRight
            size={13}
            strokeWidth={2.2}
            className={cn(
              "col-start-1 row-start-1 opacity-0 transition-[opacity,rotate] duration-[180ms] group-hover:opacity-100",
              open && "rotate-90",
              dropOn && "!opacity-0",
            )}
          />
        </button>
      ) : (
        <span className="relative z-10 grid h-5 w-5 shrink-0 place-items-center text-faint">
          <FolderGlyph open={dropOn} accent={dropOn} />
        </span>
      )}
      <span
        className={cn(
          "relative z-10 min-w-0 flex-1 truncate text-[13px]",
          nested ? "text-body" : "font-medium text-ink/90",
          dropOn && "text-accent",
        )}
      >
        {nameOf(path)}
        {hint && parentOf(path) && (
          <span className="ml-1.5 text-[11.5px] font-normal text-faint">
            {folderLabel(parentOf(path))}
          </span>
        )}
      </span>
      <span
        className={cn(
          "relative z-10 min-w-5 text-right text-[11.5px] tabular-nums text-faint transition-opacity duration-[150ms]",
          menuOpen ? "opacity-0" : "group-hover:opacity-0",
        )}
      >
        {count}
      </span>
      <ChevronRight
        size={12}
        strokeWidth={2}
        className="otw-row-actions relative z-10 -mr-1 shrink-0 text-faint opacity-0 transition-opacity duration-[150ms] group-hover:opacity-100"
      />
      {/* 「…」叠在数字的位置：静止时看到数字，悬停时换成菜单 */}
      <div
        className="otw-row-actions absolute top-[calc(50%-10px)] right-[30px] z-20"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <RowMenu
          onOpenChange={setMenuOpen}
          actions={[
            {
              id: "new-sub",
              label: "新建子文件夹",
              icon: FolderPlus,
              onSelect: () => tree.startNewFolder(path),
            },
            { id: "rename", label: "重命名", icon: Pencil, onSelect: () => tree.startRename(path) },
            {
              id: "reveal",
              label: "在文件夹中显示",
              icon: FolderOpen,
              onSelect: () => void useData.getState().revealFolder(path),
            },
            {
              id: "delete",
              label: count ? `删除文件夹和 ${count} 篇笔记` : "删除文件夹",
              icon: Trash2,
              danger: true,
              onSelect: () => tree.remove(path),
            },
          ]}
        />
      </div>
    </div>
  );
}

/** 文件夹图标：平时合着，展开 / 拖到上面时打开。有子内容的悬停时让位给箭头 */
function FolderGlyph({
  open,
  accent,
  expandable,
}: { open: boolean; accent?: boolean; expandable?: boolean }) {
  const Icon = open ? FolderOpen : Folder;
  return (
    <Icon
      size={14}
      strokeWidth={1.9}
      className={cn(
        "col-start-1 row-start-1 transition-opacity duration-[150ms]",
        // 拖到上面时一直是打开的文件夹（箭头这时候让位）
        expandable && !accent && "group-hover:opacity-0",
        accent && "text-accent",
      )}
    />
  );
}

/** 展开的文件夹里一篇笔记：只有标题，一行。选中与否自己订阅：换一篇只重渲染新旧两行 */
const TreeNoteRow = memo(function TreeNoteRow({ note, depth }: { note: Note; depth: number }) {
  const tree = useTreeActions();
  const selected = useApp((s) => s.selectedNoteId === note.id);
  const dragging = useNoteDrag((s) => s.noteId === note.id);
  const title = useListTitle(note);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected ? "true" : undefined}
      data-note-row={note.id}
      onPointerDown={(event) =>
        beginNoteDrag(event, note, {
          onDrop: (to) => tree.move(note.id, to),
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
      className={cn(
        "group relative flex h-8 cursor-default items-center gap-1.5 rounded-lg pr-3 outline-none",
        "focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-inset",
        dragging && "opacity-40",
      )}
    >
      <span
        className={cn(
          "absolute inset-x-0 inset-y-[2px] rounded-lg transition-colors duration-[150ms]",
          selected ? "bg-accent-wash" : "group-hover:bg-raised/40",
        )}
      />
      <span className="relative z-10 grid h-5 w-5 shrink-0 place-items-center text-faint">
        <FileText size={13} strokeWidth={1.8} />
      </span>
      <span
        className={cn(
          "relative z-10 min-w-0 flex-1 truncate text-[12.5px]",
          selected ? "font-medium text-ink" : "text-body",
        )}
      >
        {title}
      </span>
      {note.conflictOf && (
        <span className="relative z-10 shrink-0 text-[10.5px] font-medium text-warning">副本</span>
      )}
      {note.isPinned && (
        <Pin size={10.5} strokeWidth={2} className="relative z-10 rotate-45 text-accent" />
      )}
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
        className={cn("relative flex items-center gap-1.5 pr-3", depth > 0 ? "h-[34px]" : "h-10")}
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
            "ring-1 ring-accent-line focus:shadow-[0_0_0_3px_var(--color-accent-wash)]",
            depth > 0 ? "text-body" : "font-medium text-ink/90",
          )}
        />
      </div>
    </TreeSlot>
  );
}

/** 进了文件夹以后搜索框下面那一行：上面每一层都能点，也能把笔记拖上去 */
function Crumbs({ folder, onNavigate }: { folder: string; onNavigate: (path: string) => void }) {
  const parts = folder.split("/");
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
  const dropOn = useNoteDrag((s) => s.target === path);
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
      <span className="truncate">{path ? nameOf(path) : ROOT_LABEL}</span>
    </button>
  );
}

/** 拖着的那篇：跟着指针的一张小卡片，写着会放到哪 */
function NoteDragGhost() {
  const { noteId, title, x, y, target } = useNoteDrag();
  if (!noteId) return null;
  return createPortal(
    <div
      // left / top 走主线程：影子里的字不会先糊后清
      style={{ left: Math.round(x + 14), top: Math.round(y + 12) }}
      className="otw-drag-ghost pointer-events-none fixed z-[60] max-w-[230px] rounded-lg bg-canvas px-[11px] pt-[7px] pb-2
                 shadow-float ring-1 ring-line-strong"
    >
      <span className="block truncate text-[12.5px] font-semibold text-ink">{title}</span>
      <span
        className={cn("block truncate text-[11px]", target !== null ? "text-accent" : "text-faint")}
      >
        {target !== null ? `移到「${folderLabel(target)}」` : "拖到文件夹上"}
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
  boxed,
  divided,
  appear = true,
}: {
  note: Note;
  index: number;
  selected: boolean;
  /** 列表栏现在在哪个文件夹 */
  folder: string;
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
  const togglePin = useData((s) => s.togglePin);
  const archiveNote = useData((s) => s.archiveNote);
  const deleteNote = useData((s) => s.deleteNote);
  const revealDocument = useData((s) => s.revealDocument);
  const dragging = useNoteDrag((s) => s.noteId === note.id);
  // 「…」菜单开着的时候指针在菜单上、不在行上，行会掉出 hover 态；
  // 底色一暗一亮，看着像菜单和行没关系。开着就按住不放。
  const [menuOpen, setMenuOpen] = useState(false);
  // 不在当前这一层的（「全部笔记」里别的文件夹的置顶、搜索结果）：摘要前面带上文件夹
  const where = folderOf(note);
  const showFolder = where !== "" && where !== folder;
  const title = useListTitle(note);

  return (
    <motion.div
      layout="position"
      layoutDependency={shapeTick}
      role="button"
      tabIndex={0}
      aria-current={selected ? "true" : undefined}
      data-note-row={note.id}
      onPointerDown={(event) =>
        beginNoteDrag(event, note, {
          onDrop: (to) => tree.move(note.id, to),
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
              "block truncate text-[13.5px] font-semibold leading-[1.45]",
              selected ? "text-ink" : "text-ink/90",
            )}
          >
            {title}
          </span>
          <span className="mt-[3px] flex min-w-0 items-center text-[11.5px] leading-[1.45] text-muted">
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
        <RowMenu
          onOpenChange={setMenuOpen}
          actions={[
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
            {
              // 每篇笔记就是笔记文件夹里的一个 .md 文件：打开资源管理器并选中它
              id: "reveal",
              label: "在文件夹中显示",
              icon: FolderOpen,
              onSelect: () => void revealDocument({ kind: "note", id: note.id }),
            },
            {
              id: "archive",
              label: "归档",
              icon: Archive,
              onSelect: () => {
                selectNeighbor(note.id);
                void archiveNote(note.id);
              },
            },
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
          ]}
        />
      </div>
    </motion.div>
  );
});

function FolderChip({ path }: { path: string }) {
  return (
    <span
      title={folderLabel(path)}
      className="mr-1.5 inline-flex max-w-[60%] shrink-0 items-center gap-[3px] rounded-[4px] bg-raised/70 py-px pr-[5px] pl-1
                 text-[10.5px] font-medium text-muted"
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
export function useListTitle(note: Note): string {
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
    <span className="mr-1.5 inline-block rounded-[4px] bg-warning/15 px-1 text-[10.5px] font-medium text-warning">
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
            <p className="text-[12.5px] text-muted">{emptyTitle}</p>
            <p className="mt-1 text-[11.5px] text-faint">{emptyHint}</p>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
