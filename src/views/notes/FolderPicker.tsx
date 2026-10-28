import {
  UNSORTED,
  countIn,
  folderLabel,
  folderName,
  folderOf,
  folderTree,
  parentOf,
  smartQuery,
} from "@/data/folders";
import { useData } from "@/data/store";
import { cn } from "@/lib/cn";
import { popoverCard } from "@/lib/motion";
import { Check, Copy, Folder, Inbox, ListFilter, Search } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

/* ============================================================
   文件夹选择器：盖在列表栏上的一张卡片，列出全部文件夹（树），打字筛选，
   ↑↓ 选、回车确定。两种用法：
   - jump：点标题打开，跳到任何一个文件夹 —— 平级之间来回不用先退回上层
   - move：笔记「…」菜单里的「移动到…」，选目标文件夹
   - shortcut：笔记「…」菜单里的「添加快捷方式到…」（逻辑目录），选放快捷方式的文件夹
   逻辑目录（docs/仓库与启动器.md §7）的最后一项是「未整理」；智能文件夹能跳过去，不能往里放

   盖在文字上，所以从第一帧就是实心的，按高度从顶上展开、里面的字不动
   （lib/motion.ts 的 popoverCard）。
   ============================================================ */

interface Entry {
  path: string;
  depth: number;
  /** 筛选结果是摊平的，名字后面带上上层路径 */
  hint?: string;
}

const SEARCH_BAR_HEIGHT = 40;

export function FolderPicker({
  mode,
  current,
  noteTitle,
  top,
  onPick,
  onClose,
}: {
  mode: "jump" | "move" | "shortcut";
  /** jump：现在所在的文件夹（打勾）；move、shortcut：笔记现在所在的文件夹（不能选） */
  current: string;
  /** move 时显示「移动「…」到」 */
  noteTitle?: string;
  /** 卡片顶边相对列表栏的位置 */
  top: number;
  onPick: (folder: string) => void;
  onClose: () => void;
}) {
  const folders = useData((s) => s.folders);
  const notes = useData((s) => s.notes);
  const logical = useData((s) => s.layout.logical);
  const [query, setQuery] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // 快捷方式放不进「未整理」
  const withUnsorted = logical && mode !== "shortcut";
  const entries = useMemo(
    () => entriesFor(folders, query, withUnsorted),
    [folders, query, withUnsorted],
  );
  const disabled = (path: string) =>
    mode !== "jump" && (path === current || smartQuery(path) !== undefined);
  const firstEnabled = (list: Entry[]) =>
    Math.max(
      0,
      list.findIndex((entry) => !disabled(entry.path)),
    );
  const [active, setActive] = useState(() =>
    // 跳转：从现在所在的那一个开始；移动：现在所在的不能选，从第一个能选的开始
    mode === "jump"
      ? Math.max(
          0,
          entries.findIndex((entry) => entry.path === current),
        )
      : firstEnabled(entries),
  );

  const changeQuery = (next: string) => {
    setQuery(next);
    // 筛选词变了从第一个能选的开始
    setActive(firstEnabled(entriesFor(folders, next, withUnsorted)));
  };

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // 点卡片外面关掉（标题按钮自己会切换开关，不算外面）
  useEffect(() => {
    const away = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (panel.current?.contains(target) || target?.closest("[data-folder-picker-trigger]"))
        return;
      onClose();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onClose]);

  const step = (delta: number) => {
    if (!entries.length) return;
    let next = active;
    for (let i = 0; i < entries.length; i++) {
      next = (next + delta + entries.length) % entries.length;
      if (!disabled(entries[next]!.path)) break;
    }
    setActive(next);
  };

  const pick = (entry: Entry | undefined) => {
    if (!entry || disabled(entry.path)) return;
    onPick(entry.path);
  };

  return (
    <motion.div
      ref={panel}
      role="dialog"
      aria-label={
        mode === "jump" ? "跳到文件夹" : mode === "shortcut" ? "放快捷方式的文件夹" : "移动到文件夹"
      }
      variants={popoverCard}
      custom={SEARCH_BAR_HEIGHT}
      initial="hidden"
      animate="shown"
      exit="gone"
      style={{ top }}
      className="absolute inset-x-4 z-30 flex flex-col overflow-clip rounded-[10px] bg-canvas
                 shadow-float ring-1 ring-line-strong"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3 text-faint">
        <Search size={14} strokeWidth={2} className="shrink-0" />
        <input
          // biome-ignore lint/a11y/noAutofocus: 打开就是为了马上选，焦点直接给筛选框
          autoFocus
          value={query}
          onChange={(event) => changeQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              step(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              step(-1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              pick(entries[active]);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
          placeholder={
            mode === "jump"
              ? "跳到文件夹…"
              : mode === "shortcut"
                ? "放到哪个文件夹…"
                : "移到哪个文件夹…"
          }
          aria-label={
            mode === "jump"
              ? "跳到文件夹"
              : mode === "shortcut"
                ? "放到哪个文件夹"
                : "移到哪个文件夹"
          }
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
        />
      </div>

      {mode !== "jump" && noteTitle && (
        <div className="truncate px-3 pb-0.5 pt-2 text-[12px] text-muted">
          {mode === "shortcut" ? `给「${noteTitle}」放一个快捷方式到` : `移动「${noteTitle}」到`}
        </div>
      )}

      {/* shrink-0：卡片按高度展开的那几帧里列表不能被压扁 —— 压扁了就冒出滚动条，
          列表窄掉一条滚动条的宽度，右边的数字往左挪，展开完滚动条一消失又跳回去 */}
      <div
        ref={list}
        role="listbox"
        tabIndex={-1}
        className="scroll-thin max-h-[296px] shrink-0 overflow-y-auto p-1"
      >
        {entries.length === 0 && (
          <div className="px-2 py-5 text-center text-[12px] text-muted">没有叫这个名字的文件夹</div>
        )}
        {entries.map((entry, index) => {
          const isCurrent = entry.path === current;
          const off = disabled(entry.path);
          // 树根用以前左侧导航里「笔记」的那个图标
          const smart = smartQuery(entry.path) !== undefined;
          const Icon =
            entry.path === UNSORTED ? Inbox : smart ? ListFilter : entry.path ? Folder : Copy;
          return (
            <button
              key={entry.path || "/"}
              type="button"
              role="option"
              aria-selected={index === active}
              aria-disabled={off || undefined}
              data-index={index}
              onMouseMove={() => !off && index !== active && setActive(index)}
              onClick={() => pick(entry)}
              style={{ paddingLeft: 8 + entry.depth * 14 }}
              className={cn(
                "flex h-[30px] w-full items-center gap-2 rounded-md pr-2 text-left text-[13px]",
                off ? "cursor-default text-faint" : "text-body",
                index === active && !off && "bg-raised/70 text-ink",
                isCurrent && mode === "jump" && "text-accent",
              )}
            >
              <Icon
                size={14}
                strokeWidth={1.9}
                className={cn(
                  "shrink-0",
                  isCurrent && mode === "jump" ? "text-accent" : "text-faint",
                )}
              />
              <span className="min-w-0 truncate">{folderName(entry.path)}</span>
              {entry.hint && (
                <span className="min-w-0 truncate text-[12px] text-muted">{entry.hint}</span>
              )}
              <span className="ml-auto shrink-0 pl-2 text-[12px] tabular-nums text-muted">
                {off ? (
                  smart ? (
                    "智能文件夹"
                  ) : mode === "shortcut" ? (
                    "笔记在这里"
                  ) : (
                    "当前位置"
                  )
                ) : isCurrent && mode === "jump" ? (
                  <Check size={14} strokeWidth={2.2} className="text-accent" />
                ) : smart ? (
                  ""
                ) : entry.path === UNSORTED ? (
                  notes.filter((note) => folderOf(note) === UNSORTED).length
                ) : (
                  countIn(notes, entry.path)
                )}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex shrink-0 gap-3 border-t border-line px-3 pb-2 pt-[7px] text-[12px] text-muted">
        <span>
          <Kbd>↑↓</Kbd>选择
        </span>
        <span>
          <Kbd>Enter</Kbd>
          {mode === "jump" ? "打开" : mode === "shortcut" ? "放进去" : "移过去"}
        </span>
        <span>
          <Kbd>Esc</Kbd>关闭
        </span>
      </div>
    </motion.div>
  );
}

/**
 * 没有筛选词时是整棵树（树根打头，逻辑目录最后是「未整理」）；有的话是名字对得上的文件夹，摊平
 */
function entriesFor(folders: string[], query: string, unsorted: boolean): Entry[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [
      { path: "", depth: 0 },
      ...folderTree(folders).map((item) => ({ path: item.path, depth: item.depth + 1 })),
      ...(unsorted ? [{ path: UNSORTED, depth: 1 }] : []),
    ];
  }
  return [...folders, ...(unsorted ? [UNSORTED] : [])]
    .filter((folder) => folderName(folder).toLowerCase().includes(q))
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
    .map((path) => ({
      path,
      depth: 0,
      hint: parentOf(path) ? folderLabel(parentOf(path)) : undefined,
    }));
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="mr-1 rounded border border-line-strong px-1 font-mono text-[11px]">
      {children}
    </kbd>
  );
}
