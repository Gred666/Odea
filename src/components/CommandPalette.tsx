import { openDocument } from "@/app/navigate";
import { useApp } from "@/app/store";
import { releaseOf } from "@/content/changelog";
import { backend } from "@/data/backend";
import { folderLabel, folderOf } from "@/data/folders";
import { useData } from "@/data/store";
import { useTextSearch } from "@/data/textSearch";
import type {
  DocumentSaveTarget,
  JournalDoc,
  NoteSummary,
  TextHit,
  WorkspaceId,
} from "@/data/types";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/date";
import { runEditorCommand } from "@/lib/editorCommands";
import { popoverCard, spring, tween } from "@/lib/motion";
import { type Range, matchKeywords, matchText, snippetAround } from "@/lib/paletteSearch";
import { isMac } from "@/lib/platform";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  BookOpen,
  CalendarDays,
  CircleFadingArrowUp,
  Cloud,
  CornerDownLeft,
  FileText,
  FolderInput,
  FolderOpen,
  FolderSearch,
  History,
  Keyboard,
  ListCollapse,
  ListTree,
  Monitor,
  Moon,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  Sparkles,
  SquareCheckBig,
  Sun,
  Target,
  TextSearch,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { version as APP_VERSION } from "../../package.json";

type Group =
  | "最近"
  | "笔记"
  | "日记与目标"
  | "操作"
  | "跳转"
  | "外观"
  | "文件"
  | "同步"
  | "帮助"
  | "新建"
  | "搜索";

interface Item {
  id: string;
  group: Group;
  icon: LucideIcon;
  label: string;
  /** 右边的小字（所在文件夹、多久前改的、「当前」） */
  hint?: string;
  /** 搜得到、但不显示的别名 */
  keywords?: string;
  /** 标题里命中的字 */
  ranges?: Range[];
  /** 正文命中：标题下面一行，命中的字标出来 */
  snippet?: { text: string; range: Range };
  run: () => void;
}

/** 输入框那一栏的高度（和下面的 h-[52px] 一致）：面板展开的第一帧露出它 */
const INPUT_BAR_HEIGHT = 52;
/** 列表最高多少：加上底栏，整个面板和以前一样高（以前列表 336，没有底栏） */
const LIST_MAX = 304;
const RECENT_COUNT = 5;
/** 搜笔记时最多列多少篇：再多就该换个更准的词了 */
const NOTE_RESULTS = 40;
/**
 * 长路径留头尾，中间省掉：说明文字放不下时从末尾截断，最要紧的那个文件夹名就看不见了。
 * `C:\Users\Gred\Documents\Odea` → `C:\…\Documents\Odea`
 */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/);
  if (path.length <= 24 || parts.length <= 3) return path;
  const separator = path.includes("\\") ? "\\" : "/";
  return [parts[0], "…", ...parts.slice(-2)].join(separator);
}

/** 全局搜索（FindDialog）的快捷键。写字不写 ⇧⌘：正文字体里没有（见 editor/popupGlyphs.test.ts） */
const FIND_SHORTCUT = isMac ? "Cmd+Shift+F" : "Ctrl+Shift+F";

/**
 * 命令面板（⌘K / Ctrl+K）。
 *
 * - 一打开先是「最近」改过的几篇和「新建笔记」，然后才是跳转、外观、文件 ——
 *   跳转侧栏上就有，最常用的是回到刚才那几篇
 * - 搜索：标题连续命中 > 几个词都出现 > 按顺序跳着命中；命令还认别名（「深色」「dark」都能找到
 *   「切换到暗色」）；笔记的正文也搜，命中的那一行显示在标题下面。命中的字标成强调色
 * - 日记（某一天）和目标也搜：打开面板时取一次它们的标题（data/store 的 loadJournal）。
 *   正文（笔记、日记、目标）由 Rust 在索引里搜（data/textSearch）：前端不留全文。
 *   标题命中的立刻出来，正文命中的晚几毫秒补上
 * - 打了字就一定有「新建笔记「…」」和最后一项「在所有笔记里搜索「…」」（全局搜索，FindDialog）：
 *   什么都没搜到也不是死路
 * - 结果多少变了，列表的高度跟着平滑地变，不会一下缩成一截
 * - 输入法选字时的回车 / 上下键是在选字，不执行、不挪高亮
 *
 * 遮罩用静态 backdrop-blur、只动 opacity —— 动画化 backdrop-filter
 * 会让每帧重新采样模糊，是最贵的一类动画（技术方案 §10.1）。
 */
export function CommandPalette({
  docTarget,
}: {
  /** 正在看的那篇文档（「在文件夹中显示当前文档」用）；空状态、扩展页没有 */
  docTarget?: DocumentSaveTarget;
}) {
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPaletteOpen);
  const workspace = useApp((s) => s.workspace);
  const setWorkspace = useApp((s) => s.setWorkspace);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const reduceMotion = useApp((s) => s.reduceMotion);
  const setReduceMotion = useApp((s) => s.setReduceMotion);
  const noteFolder = useApp((s) => s.noteFolder);
  const notes = useData((s) => s.notes);
  const archived = useData((s) => s.archived);
  const journal = useData((s) => s.journal);
  const navCollapsed = useApp((s) => s.navCollapsed);
  const setNavCollapsed = useApp((s) => s.setNavCollapsed);
  const revealDocument = useData((s) => s.revealDocument);
  const openVaultFolder = useData((s) => s.openVaultFolder);
  const changeVaultRoot = useData((s) => s.changeVaultRoot);
  const vaultRoot = useData((s) => s.vaultRoot);
  const openGuide = useData((s) => s.openGuide);
  const syncState = useData((s) => s.syncStatus.state);
  const setSyncOpen = useApp((s) => s.setSyncOpen);
  const setHistoryFor = useApp((s) => s.setHistoryFor);
  const update = useData((s) => s.update);
  const checkUpdate = useData((s) => s.checkUpdate);
  const setUpdateDialog = useApp((s) => s.setUpdateDialog);
  const setFindOpen = useApp((s) => s.setFindOpen);

  const [query, setQuery] = useState("");
  const searched = useTextSearch(open ? query : "", NOTE_RESULTS * 2);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /* ---- 全局快捷键 ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!useApp.getState().paletteOpen);
      } else if (e.key === "Escape" && useApp.getState().paletteOpen && !e.isComposing) {
        e.preventDefault();
        setOpen(false);
      }
    };
    // 捕获阶段：编辑器（CodeMirror）在 contentDOM 上监听并会 preventDefault，
    // 冒泡阶段注册的话，光标一在正文里 ⌘K 就永远打不开面板。
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [setOpen]);

  useEffect(() => {
    if (open) {
      // 日记和目标不常驻内存：每次打开取一份最新的（一次往返，几百篇也只是几百段文字）
      void useData.getState().loadJournal();
      setQuery("");
      setCursor(0);
      // 等入场动画的第一帧过去再聚焦，避免 iOS/WebKit 上的滚动跳动
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  /* ---- 固定的命令：操作、跳转、外观、文件 ---- */
  const commands = useMemo<Item[]>(() => {
    const here = noteFolder ? `放在「${folderLabel(noteFolder)}」` : undefined;
    const nav = (id: WorkspaceId, label: string, icon: LucideIcon, keywords: string): Item => ({
      id: `nav-${id}`,
      group: "跳转",
      icon,
      label,
      hint: workspace === id ? "当前" : undefined,
      keywords: `跳转 打开 ${keywords}`,
      run: () => setWorkspace(id),
    });
    const themeItem = (pref: typeof theme, label: string, icon: LucideIcon, keywords: string) =>
      ({
        id: `theme-${pref}`,
        group: "外观",
        icon,
        label,
        hint: theme === pref ? "当前" : undefined,
        keywords: `主题 外观 theme ${keywords}`,
        run: () => setTheme(pref),
      }) satisfies Item;

    return [
      {
        id: "new-note",
        group: "操作",
        icon: Plus,
        label: "新建笔记",
        hint: here,
        keywords: "new note 创建 添加 新笔记 写",
        run: () => void createNoteNamed(noteFolder),
      },
      {
        id: "find-in-vault",
        group: "操作",
        icon: TextSearch,
        label: "在所有笔记里搜索…",
        hint: FIND_SHORTCUT,
        keywords:
          "find search grep vscode 全局搜索 全文搜索 搜索全部 查找全部 在文件中查找 正文 每一处 正则 regex 大小写 全词",
        // 不带面板里打的字：打的多半是这条命令的名字（「全局搜索」）。要搜打的字用列表最后那一项
        run: () => setFindOpen(true),
      },
      ...(docTarget
        ? [
            {
              id: "reveal-current",
              group: "操作",
              icon: FolderSearch,
              label: "在文件夹中显示当前文档",
              keywords: "reveal 资源管理器 finder 文件 位置 定位",
              run: () => void revealDocument(docTarget),
            } satisfies Item,
            {
              id: "fold-all",
              group: "操作",
              icon: ListCollapse,
              label: "收起所有标题",
              hint: "每一节只留标题",
              keywords: "fold collapse 折叠 收起 标题 大纲 全部",
              run: () => runEditorCommand("fold-all"),
            } satisfies Item,
            {
              id: "unfold-all",
              group: "操作",
              icon: ListTree,
              label: "展开所有标题",
              keywords: "unfold expand 展开 标题 全部",
              run: () => runEditorCommand("unfold-all"),
            } satisfies Item,
            {
              id: "history-current",
              group: "操作",
              icon: History,
              label: "历史版本…",
              hint: "这一篇以前的样子，可以恢复",
              keywords: "history version 历史 版本 恢复 回退 撤回 以前 旧版 git",
              run: () => setHistoryFor(docTarget),
            } satisfies Item,
          ]
        : []),

      nav("notes", "笔记", NotebookPen, "notes 列表"),
      nav("today", "今日TODO", SquareCheckBig, "today 今天 待办 todo"),
      nav("goal", "/GOAL", Target, "goal 目标 周 月 年"),
      nav("calendar", "日历", CalendarDays, "calendar 日期 某天"),
      nav("archive", "归档", Archive, "archive 存档"),

      themeItem("light", "切换到亮色", Sun, "light 浅色 白天 日间 亮"),
      themeItem("dark", "切换到暗色", Moon, "dark 深色 夜间 黑 暗"),
      themeItem("system", "主题跟随系统", Monitor, "system auto 自动 系统"),
      {
        id: "reduce-motion",
        group: "外观",
        icon: Sparkles,
        label: reduceMotion ? "开启动画效果" : "减少动画效果",
        hint: reduceMotion ? "当前：已减少" : undefined,
        keywords: "动效 动画 motion animation reduce",
        run: () => setReduceMotion(!reduceMotion),
      },
      {
        id: "toggle-nav",
        group: "外观",
        icon: navCollapsed ? PanelLeftOpen : PanelLeftClose,
        label: navCollapsed ? "展开导航栏" : "收起导航栏",
        hint: navCollapsed ? undefined : "窄窗口里给正文让地方",
        keywords: "导航 侧栏 侧边栏 sidebar collapse 收起 展开 图标",
        run: () => setNavCollapsed(!navCollapsed),
      },

      {
        id: "open-vault",
        group: "文件",
        icon: FolderOpen,
        label: "打开笔记文件夹",
        hint: "所有笔记、日记、目标都在这里",
        keywords: "vault 仓库 目录 资源管理器 finder",
        run: () => void openVaultFolder(),
      },
      {
        id: "change-vault",
        group: "文件",
        icon: FolderInput,
        label: "更换笔记文件夹…",
        // 写上现在在哪：不少人是因为想知道笔记存在哪（默认在 C 盘的「文档」里）才来找的
        hint: vaultRoot ? `现在在 ${shortPath(vaultRoot)}` : "换一个位置存笔记",
        keywords: "vault 仓库 位置 网盘 迁移 搬 移动 C盘 D盘 换盘 存在哪",
        run: () => void changeVaultRoot(),
      },
      // 同步（技术方案 §5.9.9）：没开时是开启的入口，开了是状态 + 立即同步
      {
        id: "sync",
        group: "同步",
        icon: Cloud,
        label: syncState === "off" ? "开启同步…" : "同步状态…",
        hint: syncState === "off" ? "GitHub / Gitee 私有仓库" : undefined,
        keywords: "sync 同步 github gitee git 备份 云端 多设备 断开 登录 代理",
        run: () => setSyncOpen(true),
      },
      ...(syncState === "off"
        ? []
        : [
            {
              id: "sync-now",
              group: "同步",
              icon: RefreshCw,
              label: "立即同步",
              keywords: "sync now 同步 拉取 推送 上传 下载",
              run: () => void backend().then((api) => api.syncNow()),
            } satisfies Item,
          ]),

      // 内置的使用指南（src/content/guide/）：删掉了的话照这个版本重新放一篇
      {
        id: "guide-welcome",
        group: "帮助",
        icon: BookOpen,
        label: "使用指南",
        hint: "五个区、常用操作、笔记存在哪",
        keywords: "help guide 帮助 说明 说明书 教程 上手 入门 新手 欢迎",
        run: () => void openGuide("welcome").then((id) => id && openDocument({ kind: "note", id })),
      },
      {
        id: "guide-syntax",
        group: "帮助",
        icon: Keyboard,
        label: "语法全览",
        hint: "所有 Markdown 语法和快捷键",
        keywords: "markdown syntax shortcut 语法 快捷键 格式 公式 表格 帮助",
        run: () => void openGuide("syntax").then((id) => id && openDocument({ kind: "note", id })),
      },
      // 新版本（技术方案 §14.4）：后台下好了的直接打开卡片；没有的话现在查一次
      update
        ? ({
            id: "update",
            group: "帮助",
            icon: CircleFadingArrowUp,
            label: `更新到 ${update.version}…`,
            hint: update.manual ? "到下载页下载" : "已经下好了，重启就是新版",
            keywords: "update upgrade version 更新 升级 新版 版本 重启",
            run: () => setUpdateDialog("update"),
          } satisfies Item)
        : ({
            id: "update-check",
            group: "帮助",
            icon: CircleFadingArrowUp,
            label: "检查更新",
            hint: `现在是 ${APP_VERSION}`,
            keywords: "update upgrade version 更新 升级 新版 版本",
            run: () => {
              useData.setState({ notice: "正在检查更新…" });
              void checkUpdate().then((found) => {
                if (!found) return;
                useData.getState().clearNotice();
                setUpdateDialog("update");
              });
            },
          } satisfies Item),
      ...(releaseOf(APP_VERSION)
        ? [
            {
              id: "release-notes",
              group: "帮助",
              icon: ScrollText,
              label: "这一版的更新说明",
              hint: APP_VERSION,
              keywords: "changelog release notes what's new 更新 说明 新功能 版本 日志",
              run: () => setUpdateDialog("notes"),
            } satisfies Item,
          ]
        : []),
    ];
  }, [
    setFindOpen,
    update,
    checkUpdate,
    setUpdateDialog,
    openGuide,
    noteFolder,
    workspace,
    setWorkspace,
    theme,
    setTheme,
    reduceMotion,
    setReduceMotion,
    navCollapsed,
    setNavCollapsed,
    docTarget,
    revealDocument,
    openVaultFolder,
    syncState,
    setSyncOpen,
    setHistoryFor,
    changeVaultRoot,
    vaultRoot,
  ]);

  const currentNote = docTarget?.kind === "note" ? docTarget.id : null;

  /** 「最近」：最近改过的几篇，正在看的那篇不算 */
  const recent = useMemo<Item[]>(
    () =>
      [...notes]
        .filter((note) => note.id !== currentNote)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, RECENT_COUNT)
        .map((note) => {
          const where = folderOf(note);
          const when = formatRelativeTime(note.updatedAt);
          return noteItem(note, "最近", { hint: where ? `${folderLabel(where)} · ${when}` : when });
        }),
    [notes, currentNote],
  );

  const results = useMemo<Item[]>(() => {
    const q = query.trim();
    if (!q) return [...recent, ...commands];

    const scored: { item: Item; score: number }[] = [];
    for (const command of commands) {
      const hit = matchText(command.label, q);
      if (hit) scored.push({ item: { ...command, ranges: hit.ranges }, score: hit.score });
      else if (matchKeywords(command.keywords, q)) scored.push({ item: command, score: 55 });
    }

    // 正文里的由 Rust 搜（data/textSearch）。这个词的还没回来时用上一次的：接着往下打的话，
    // 命中的那一行里还有这个词的照样算（第一次出现在哪一行没变），别的等新结果
    const lower = q.toLowerCase();
    const fresh = searched?.query === q;
    const body =
      searched && (fresh || lower.startsWith(searched.query.toLowerCase()))
        ? searched.result
        : null;
    const usable = (hit: TextHit) => fresh || hit.line.toLowerCase().includes(lower);

    const found: { item: Item; score: number }[] = [];
    const byId = new Map<string, NoteSummary>();
    for (const note of [...notes, ...archived]) {
      byId.set(note.id, note);
      const title = matchText(note.title, q);
      if (title) {
        // 笔记是这里最主要的东西：同样命中时排在命令前面
        found.push({
          item: noteItem(note, "笔记", { hint: whereOf(note), ranges: title.ranges }),
          score: title.score + 8,
        });
        byId.delete(note.id);
      }
    }
    for (const hit of body?.notes ?? []) {
      // 标题已经命中的不再按正文算一次（byId 里删掉了）
      const note = hit.target.kind === "note" ? byId.get(hit.target.id) : undefined;
      const snippet = note && usable(hit) ? snippetAround(hit.line, q) : null;
      if (note && snippet)
        found.push({ item: noteItem(note, "笔记", { hint: whereOf(note), snippet }), score: 30 });
    }
    found.sort((a, b) => b.score - a.score);
    scored.push(...found.slice(0, NOTE_RESULTS));

    // 日记和目标：标题（「10月6日 · …」「第 41 周目标」）和正文都搜，排在同分的笔记后面
    const days: { item: Item; score: number }[] = [];
    const titled = new Set<string>();
    for (const entry of journal) {
      const title = matchText(entry.title, q);
      if (!title) continue;
      const hint = formatRelativeTime(entry.updatedAt);
      days.push({ item: journalItem(entry, { hint, ranges: title.ranges }), score: title.score });
      titled.add(journalKey(entry.target));
    }
    for (const hit of body?.journal ?? []) {
      if (hit.target.kind === "note" || titled.has(journalKey(hit.target)) || !usable(hit))
        continue;
      const snippet = snippetAround(hit.line, q);
      if (!snippet) continue;
      const entry: JournalDoc = { ...hit, kind: hit.target.kind };
      const hint = formatRelativeTime(entry.updatedAt);
      days.push({ item: journalItem(entry, { hint, snippet }), score: 28 });
    }
    days.sort((a, b) => b.score - a.score);
    scored.push(...days.slice(0, NOTE_RESULTS));

    // 分组：组按组里最好的那一项排，组里按分数排
    const groups = new Map<Group, { best: number; items: { item: Item; score: number }[] }>();
    for (const entry of scored) {
      const group = groups.get(entry.item.group) ?? { best: Number.NEGATIVE_INFINITY, items: [] };
      group.best = Math.max(group.best, entry.score);
      group.items.push(entry);
      groups.set(entry.item.group, group);
    }
    const ordered = [...groups.values()]
      .sort((a, b) => b.best - a.best)
      .flatMap((group) => group.items.sort((a, b) => b.score - a.score).map((entry) => entry.item));

    // 最后一项总是「新建笔记」，标题就是打的字：搜不到也能接着往下走
    ordered.push({
      id: "create-from-query",
      group: "新建",
      icon: Plus,
      label: `新建笔记「${q}」`,
      hint: noteFolder ? `放在「${folderLabel(noteFolder)}」` : undefined,
      run: () => void createNoteNamed(noteFolder, q),
    });
    // 再往下一项：在全局搜索（FindDialog）里搜打的字，看每一处。排在新建后面：搜不到时回车还是新建
    ordered.push({
      id: "find-query",
      group: "搜索",
      icon: TextSearch,
      label: `在所有笔记里搜索「${q}」`,
      hint: FIND_SHORTCUT,
      run: () => setFindOpen(true, q),
    });
    return ordered;
  }, [query, recent, commands, notes, archived, journal, noteFolder, searched, setFindOpen]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 输入变化时复位高亮
  useEffect(() => setCursor(0), [query]);

  // 键盘移动时把高亮项滚进视野
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const execute = (item: Item | undefined) => {
    if (!item) return;
    item.run();
    setOpen(false);
  };

  const searching = query.trim() !== "";
  const matchCount = results.filter(
    (item) => item.group !== "新建" && item.group !== "搜索",
  ).length;

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* 遮罩必须自己是 AnimatePresence 的直接子节点，不能塞进那个做 opacity
              动画的容器里。opacity < 1 会新建一个 Backdrop Root，
              backdrop-filter 采样的就不再是页面本身而是那个空容器 ——
              整段动画里模糊等于不存在，直到 opacity 落到 1 的那一帧才「啪」地
              出现（退场则是第一帧就消失）。用户看到的不丝滑就是这个跳变。

              opacity 落在带 backdrop-filter 的元素自己身上则没有这个问题：
              模糊结果会跟着 alpha 一起淡入，中间帧是真的半模糊。
              模糊半径依然是静态的 —— 动画化 blur() 才是每帧重新采样的那种贵
              （技术方案 §10.1），这里动的仍然只有 opacity。 */}
          <motion.button
            key="scrim"
            type="button"
            // 在这里换主题时它正要关掉：不进日落 / 日出的旧主题副本（lib/themeTransition.ts）
            data-ghost-skip
            aria-label="关闭命令面板"
            onClick={() => setOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={tween.base}
            className="fixed inset-0 z-50 cursor-default bg-ink/[0.14] backdrop-blur-[3px]"
          />

          {/* 只负责给面板定位。pointer-events 让开，点空白处才能落到下面的遮罩上。
              它自己不做动画：整块淡入会把面板里的字一起变成半透明的位图 */}
          <div
            key="panel"
            data-ghost-skip
            className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center
                       pt-[16vh]"
          >
            {/* 从输入框那一栏往下展开，里面的字不缩放、不变透明（同表情选择器，
                lib/motion.ts 的 popoverCard）。以前是 scale 0.97 + 下落 + 淡入：
                字在动画里被当位图拉伸，前 200ms 发虚，结束那一帧才跳清楚 */}
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label="命令面板"
              custom={INPUT_BAR_HEIGHT}
              variants={popoverCard}
              initial="hidden"
              animate="shown"
              exit="gone"
              // overflow-clip 而不是 hidden：hidden 还是滚动容器，展开途中键盘走到还没
              // 露出来的那一项，scrollIntoView 会把整块内容卷上去
              className="pointer-events-auto relative w-[520px] max-w-[calc(100vw-48px)]
                       overflow-clip rounded-2xl bg-canvas shadow-modal ring-1 ring-line-strong"
              onKeyDown={(e) => {
                // 输入法选字时的回车、上下键是在选字
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setCursor((c) => (c + 1) % Math.max(results.length, 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCursor((c) => (c - 1 + results.length) % Math.max(results.length, 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  execute(results[cursor]);
                }
              }}
            >
              <div className="flex h-[52px] items-center gap-3 border-b border-line px-4">
                <Search size={15} strokeWidth={2} className="shrink-0 text-faint" />
                <input
                  ref={inputRef}
                  // 焦点一直在输入框里，上下键挪的是列表里的高亮（读屏按 activedescendant 念）
                  role="combobox"
                  aria-expanded="true"
                  aria-controls="palette-results"
                  aria-activedescendant={results[cursor] ? `palette-option-${cursor}` : undefined}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索笔记、命令…"
                  aria-label="搜索笔记、命令"
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none
                           placeholder:text-faint"
                />
              </div>

              <AutoHeight>
                <div
                  ref={listRef}
                  id="palette-results"
                  role="listbox"
                  aria-label="结果"
                  tabIndex={-1}
                  className="scroll-thin overflow-y-auto p-1.5"
                  style={{ maxHeight: LIST_MAX }}
                >
                  {results.map((item, i) => {
                    const active = i === cursor;
                    const showGroup = i === 0 || results[i - 1]!.group !== item.group;
                    const Icon = item.icon;
                    return (
                      <div key={item.id}>
                        {showGroup && (
                          <p className="px-2.5 pb-1 pt-2.5 text-[12px] font-medium tracking-[0.05em] text-faint">
                            {item.group}
                          </p>
                        )}
                        <button
                          type="button"
                          id={`palette-option-${i}`}
                          role="option"
                          aria-selected={active}
                          tabIndex={-1}
                          data-idx={i}
                          onMouseMove={() => setCursor(i)}
                          onClick={() => execute(item)}
                          className={cn(
                            "relative flex w-full items-center gap-2.5 rounded-lg px-2.5 text-left",
                            item.snippet ? "py-[7px]" : "py-2",
                          )}
                        >
                          {active && (
                            <motion.span
                              layoutId="palette-cursor"
                              className="absolute inset-0 rounded-lg bg-accent-wash"
                              transition={spring.snappy}
                            />
                          )}
                          <Icon
                            size={14}
                            strokeWidth={1.9}
                            className={cn(
                              "relative z-10 shrink-0 self-start",
                              item.snippet ? "mt-[3px]" : "mt-[2.5px]",
                              active ? "text-accent" : "text-muted",
                            )}
                          />
                          <span className="relative z-10 min-w-0 flex-1">
                            <span
                              className={cn(
                                "block truncate text-[13px] leading-[1.45]",
                                active ? "font-medium text-ink" : "text-body",
                              )}
                            >
                              <Marked text={item.label} ranges={item.ranges} />
                            </span>
                            {item.snippet && (
                              <span className="mt-px block truncate text-[12px] leading-[1.45] text-muted">
                                <Marked text={item.snippet.text} ranges={[item.snippet.range]} />
                              </span>
                            )}
                          </span>
                          {item.hint && (
                            <span
                              className={cn(
                                "relative z-10 max-w-[45%] shrink-0 self-start truncate text-[12px] leading-[1.45]",
                                "mt-[1.5px]",
                                item.hint === "当前" ? "text-accent/80" : "text-faint",
                              )}
                            >
                              {item.hint}
                            </span>
                          )}
                          {active && (
                            <CornerDownLeft
                              size={11}
                              strokeWidth={2}
                              className="relative z-10 mt-[4px] shrink-0 self-start text-accent/60"
                            />
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </AutoHeight>

              <div className="flex h-8 items-center gap-3.5 border-t border-line px-4 text-[12px] text-faint">
                {/* 按键画成图标，不用箭头、回车这类字：正文字体里没有，第一次画它们浏览器要把
                    系统字体挨个找一遍，打开面板就卡一下（见 editor/popupGlyphs.test.ts） */}
                <KeyHint keys={[ArrowUp, ArrowDown]} label="选择" />
                <KeyHint keys={[CornerDownLeft]} label="打开" />
                <KeyHint keys={["Esc"]} label="关闭" />
                <span className="ml-auto tabular-nums">
                  {searching
                    ? matchCount
                      ? `${matchCount} 个结果`
                      : "没有找到，回车新建一篇"
                    : "笔记、日记、目标的正文都能搜"}
                </span>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

/** 笔记的出处：「归档 · 工作 / 周报」，「笔记」根下的不写 */
function whereOf(note: NoteSummary): string {
  return [note.isArchived ? "归档" : "", folderLabel(folderOf(note))]
    .filter((part) => part && part !== folderLabel(""))
    .join(" · ");
}

/** 某一天 / 某个周期的目标的键：标题命中过的不再按正文算一次 */
function journalKey(target: DocumentSaveTarget): string {
  return target.kind === "goal" ? `goal:${target.horizon}:${target.periodStart}` : target.id;
}

function noteItem(note: NoteSummary, group: Group, extra: Partial<Item>): Item {
  return {
    id: `${group}-note-${note.id}`,
    group,
    icon: note.isArchived ? Archive : FileText,
    label: note.title,
    ...extra,
    run: () => {
      openDocument({ kind: "note", id: note.id });
      // 列表栏也换到它所在的文件夹、把它滚出来：正文和列表对得上
      if (!note.isArchived) useApp.getState().openNoteFolder(folderOf(note));
    },
  };
}

/** 某一天 / 某个周期的目标：打开它（今天的在「今日TODO」，别的在日历里） */
function journalItem(entry: JournalDoc, extra: Partial<Item>): Item {
  const id =
    entry.target.kind === "goal"
      ? `${entry.target.horizon}:${entry.target.periodStart}`
      : entry.target.id;
  return {
    id: `journal-${entry.kind}-${id}`,
    group: "日记与目标",
    icon: entry.kind === "goal" ? Target : CalendarDays,
    label: entry.title,
    ...extra,
    run: () => openDocument(entry.target),
  };
}

/**
 * 新建一篇（放在列表栏现在所在的文件夹），有标题就起好名字，然后打开。
 * 光标跟过去：没标题的落在标题里，起好名字的落在正文开头
 */
async function createNoteNamed(folder: string, title?: string) {
  const data = useData.getState();
  const id = await data.createNote(folder);
  if (!id) return;
  if (title) await data.saveTitle({ kind: "note", id }, title);
  useApp.getState().setFocusRequest({ docKey: `note-${id}`, at: title ? "body" : "title" });
  openDocument({ kind: "note", id });
}

/** 命中的字标成强调色（不加底色：一排高亮块太吵） */
function Marked({ text, ranges }: { text: string; ranges?: Range[] }) {
  if (!ranges?.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [from, to] of ranges) {
    if (from > at) parts.push(text.slice(at, from));
    parts.push(
      <mark key={from} className="bg-transparent font-medium text-accent">
        {text.slice(from, to)}
      </mark>,
    );
    at = to;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

export function KeyHint({ keys, label }: { keys: (string | LucideIcon)[]; label: string }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((Key, index) => (
        <kbd
          // biome-ignore lint/suspicious/noArrayIndexKey: 固定的一两个键，不会重排
          key={index}
          className="grid h-[17px] min-w-[17px] place-items-center rounded border border-line-strong px-1
                     font-sans text-[11px] leading-none text-muted"
        >
          {typeof Key === "string" ? Key : <Key size={10} strokeWidth={2.2} aria-hidden="true" />}
        </kbd>
      ))}
      <span className="ml-0.5">{label}</span>
    </span>
  );
}

/**
 * 高度跟着里面的内容平滑地变：结果从十几项变成两三项，面板不会一下缩上去。
 * 只动这一层的 height（面板是 fixed 的小盒子，每帧只重排它自己），里面的字不缩放、不位移。
 */
export function AutoHeight({ children }: { children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  useLayoutEffect(() => {
    const node = inner.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <motion.div
      initial={false}
      animate={{ height }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-clip"
    >
      <div ref={inner}>{children}</div>
    </motion.div>
  );
}
