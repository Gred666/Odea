import { openDocument } from "@/app/navigate";
import { useApp } from "@/app/store";
import { folderLabel, folderOf } from "@/data/folders";
import { useData } from "@/data/store";
import { useFindInVault } from "@/data/textSearch";
import type { FindFile, FindMatch, FindOptions, NoteSummary } from "@/data/types";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/date";
import { popoverCard, tween } from "@/lib/motion";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  CornerDownLeft,
  FileText,
  Target,
  TextSearch,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AutoHeight, KeyHint } from "./CommandPalette";
import { DialogLead, usePaletteBack } from "./PaletteBack";

/** 输入框那一栏的高度（和下面的 h-[52px] 一致）：面板展开的第一帧露出它 */
const INPUT_BAR_HEIGHT = 52;
/** 列表最高多少 */
const LIST_MAX = 420;

type OptionKey = keyof FindOptions;

/** 三个开关：和编辑器里的查找面板（editor/searchPanel.ts）一样的字、一样的快捷键 */
const TOGGLES: { key: OptionKey; label: string; title: string; code: string }[] = [
  { key: "caseSensitive", label: "Aa", title: "区分大小写 (Alt+C)", code: "KeyC" },
  { key: "wholeWord", label: "ab", title: "全词匹配 (Alt+W)", code: "KeyW" },
  { key: "regex", label: ".*", title: "正则表达式 (Alt+R)", code: "KeyR" },
];

/** 列表里能选中的一行：第几篇里的一处命中 */
interface Row {
  file: FindFile;
  match: FindMatch;
}

/**
 * 全局搜索（Ctrl+Shift+F / Cmd+Shift+F，命令面板里「在所有笔记里搜索…」）：像 VS Code 的「在文件中查找」。
 *
 * - 搜笔记（含归档）、日记、目标的正文，按篇分组列出每一处命中和它在第几行；
 *   区分大小写 / 全词匹配 / 正则三个开关，含义同编辑器里的查找面板（Alt+C / W / R 切换）
 * - 纯文本匹配，不分词：打什么找什么（Rust 的 find_in_vault，一个字一个字地比，
 *   2026-10-16 以前那套 jieba 分词的全文索引没有界面在用，去掉了，技术方案 §6）
 * - 回车 / 点一处：打开那一篇、滚到那一行、选中那一处；篇内查找（Mod-F、F3）接着用同一个条件
 * - 再打开时还是上次搜的词和结果（选中了好直接改）；在正文里选了一段字再按快捷键就搜那段字
 * - 和命令面板一次只开一个（app/store）
 */
export function FindDialog() {
  const open = useApp((s) => s.findOpen);
  const seed = useApp((s) => s.findSeed);
  const setOpen = useApp((s) => s.setFindOpen);
  const back = usePaletteBack("find", open, () => setOpen(false));
  const notes = useData((s) => s.notes);
  const archived = useData((s) => s.archived);

  const [query, setQuery] = useState("");
  /** 交给 Rust 去搜的词：输入法组字的时候不跟着变，拼音字母不搜 */
  const [searched, setSearched] = useState("");
  const [options, setOptions] = useState<FindOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const done = useFindInVault(searched, options, open);
  // 搜的词清空了：上一次的结果不再显示
  const result = searched ? (done?.result ?? null) : null;

  /* ---- 全局快捷键 ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        if (useApp.getState().findOpen) {
          // 已经开着：回到输入框（同 VS Code）
          inputRef.current?.focus();
          inputRef.current?.select();
        } else {
          setOpen(true, selectionSeed());
        }
      } else if (e.key === "Escape" && useApp.getState().findOpen && !e.isComposing) {
        e.preventDefault();
        if (back) back();
        else setOpen(false);
      }
    };
    // 捕获阶段：理由同命令面板（编辑器在 contentDOM 上监听按键）
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [setOpen, back]);

  useEffect(() => {
    if (!open) return;
    if (seed !== null) {
      setQuery(seed);
      setSearched(seed);
    }
    setCursor(0);
    // 等入场动画的第一帧过去再聚焦（同命令面板）；全选，好直接打新的词
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [open, seed]);

  const rows = useMemo<Row[]>(
    () => result?.files.flatMap((file) => file.matches.map((match) => ({ file, match }))) ?? [],
    [result],
  );
  /** 每一篇的第一处在 rows 里排第几 */
  const firstRow = useMemo(() => {
    const starts: number[] = [];
    let at = 0;
    for (const file of result?.files ?? []) {
      starts.push(at);
      at += file.matches.length;
    }
    return starts;
  }, [result]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 换了一批结果，高亮回到第一处
  useEffect(() => setCursor(0), [result]);

  // 键盘移动时把高亮项滚进视野；一篇的第一处连同上面的篇名一起露出来
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const head = firstRow.indexOf(cursor);
    const target =
      head >= 0
        ? list.querySelector(`[data-file-head="${head}"]`)
        : list.querySelector(`[data-row="${cursor}"]`);
    target?.scrollIntoView({ block: "nearest" });
  }, [cursor, firstRow]);

  const byId = useMemo(() => {
    const map = new Map<string, NoteSummary>();
    for (const note of [...notes, ...archived]) map.set(note.id, note);
    return map;
  }, [notes, archived]);

  const toggle = (key: OptionKey) => setOptions((now) => ({ ...now, [key]: !now[key] }));

  const openRow = (row: Row | undefined) => {
    if (!row || !done) return;
    const { file, match } = row;
    setOpen(false);
    openDocument(file.target, {
      line: match.line,
      match: { query: done.query, ...done.options, column: match.column, length: match.length },
    });
    // 列表栏也换到它所在的文件夹、把它滚出来（同命令面板）
    const target = file.target;
    if (target.kind === "note") {
      const note = byId.get(target.id);
      if (note && !note.isArchived) useApp.getState().openNoteFolder(folderOf(note));
    }
  };

  const status = (() => {
    if (!result) return searched ? "" : "搜笔记、日记、目标的正文";
    if (result.error) return `正则有误：${result.error}`;
    if (!result.total) return "没有找到";
    if (result.truncated) return `只列出前 ${rows.length} 处 · 共 ${result.total} 处`;
    return `${result.files.length} 篇 · ${result.total} 处`;
  })();

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* 遮罩、定位层、展开方式都同命令面板（见那边的注释） */}
          <motion.button
            key="scrim"
            type="button"
            data-ghost-skip
            aria-label="关闭全局搜索"
            onClick={() => setOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={tween.base}
            className="fixed inset-0 z-50 cursor-default bg-ink/[0.14] backdrop-blur-[3px]"
          />
          <div
            key="panel"
            data-ghost-skip
            className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center
                       pt-[12vh]"
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label="全局搜索"
              custom={INPUT_BAR_HEIGHT}
              variants={popoverCard}
              initial="hidden"
              animate="shown"
              exit="gone"
              className="pointer-events-auto relative w-[640px] max-w-[calc(100vw-48px)]
                       overflow-clip rounded-2xl bg-canvas shadow-modal ring-1 ring-line-strong"
              onKeyDown={(e) => {
                // 输入法选字时的回车、上下键是在选字
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.altKey && !e.ctrlKey && !e.metaKey) {
                  // 按物理键认：mac 上 Option+C 打出来的是「ç」
                  const hit = TOGGLES.find((entry) => entry.code === e.nativeEvent.code);
                  if (hit) {
                    e.preventDefault();
                    toggle(hit.key);
                  }
                  return;
                }
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setCursor((c) => (c + 1) % Math.max(rows.length, 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCursor((c) => (c - 1 + rows.length) % Math.max(rows.length, 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  openRow(rows[cursor]);
                }
              }}
            >
              <div className="flex h-[52px] items-center gap-3 border-b border-line px-4">
                <DialogLead icon={TextSearch} back={back} />
                <input
                  ref={inputRef}
                  role="combobox"
                  aria-expanded="true"
                  aria-controls="find-results"
                  aria-activedescendant={rows[cursor] ? `find-option-${cursor}` : undefined}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    if (!(e.nativeEvent as InputEvent).isComposing) setSearched(e.target.value);
                  }}
                  onCompositionEnd={(e) => setSearched(e.currentTarget.value)}
                  placeholder="在所有笔记里搜索正文…"
                  aria-label="在所有笔记里搜索正文"
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none
                           placeholder:text-faint"
                />
                <div className="flex shrink-0 items-center gap-0.5">
                  {TOGGLES.map((entry) => (
                    <button
                      key={entry.key}
                      type="button"
                      aria-pressed={options[entry.key]}
                      aria-label={entry.title}
                      title={entry.title}
                      // 焦点留在输入框里
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => toggle(entry.key)}
                      className={cn(
                        "grid h-5 w-[22px] place-items-center rounded-[5px] font-mono text-[11px] font-semibold",
                        "transition-colors duration-[120ms]",
                        options[entry.key]
                          ? "bg-accent-wash text-accent ring-1 ring-inset ring-accent-line"
                          : "text-muted hover:bg-raised hover:text-ink",
                        // 「全词」：ab 下面一道横线（同编辑器里的查找面板）
                        entry.key === "wholeWord" &&
                          "underline decoration-[1.5px] underline-offset-2",
                      )}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              </div>

              <AutoHeight>
                <div
                  ref={listRef}
                  id="find-results"
                  role="listbox"
                  aria-label="命中的地方"
                  tabIndex={-1}
                  className={cn("scroll-thin overflow-y-auto", rows.length > 0 && "p-1.5")}
                  style={{ maxHeight: `min(${LIST_MAX}px, 60vh)` }}
                >
                  {result?.files.map((file, fileIndex) => {
                    const first = firstRow[fileIndex] ?? 0;
                    const Icon = iconOf(file, byId);
                    const hint = hintOf(file, byId);
                    return (
                      <div key={fileKey(file)} role="group" aria-label={file.title}>
                        <button
                          type="button"
                          tabIndex={-1}
                          data-file-head={fileIndex}
                          onClick={() => openRow(rows[first])}
                          className="flex w-full items-center gap-2 rounded-lg px-2.5 pb-1 pt-2 text-left"
                        >
                          <Icon size={14} strokeWidth={1.9} className="shrink-0 text-muted" />
                          <span className="min-w-0 truncate text-[13px] font-medium text-ink">
                            {file.title}
                          </span>
                          {hint && (
                            <span className="min-w-0 shrink truncate text-[12px] text-muted">
                              {hint}
                            </span>
                          )}
                          <span
                            className="ml-auto shrink-0 rounded-full bg-raised px-1.5 text-[11px]
                                       leading-[16px] tabular-nums text-muted"
                          >
                            {file.count}
                          </span>
                        </button>
                        {file.matches.map((match, index) => {
                          const i = first + index;
                          const active = i === cursor;
                          return (
                            <button
                              key={`${match.line}:${match.column}`}
                              type="button"
                              id={`find-option-${i}`}
                              role="option"
                              aria-selected={active}
                              tabIndex={-1}
                              data-row={i}
                              onMouseMove={() => setCursor(i)}
                              onClick={() => openRow(rows[i])}
                              className={cn(
                                "flex w-full items-baseline gap-2.5 rounded-lg py-[5px] pl-2.5 pr-2.5 text-left",
                                active && "bg-accent-wash",
                              )}
                            >
                              <span
                                className="w-[34px] shrink-0 text-right text-[11px] tabular-nums
                                           text-faint"
                              >
                                {match.line}
                              </span>
                              <span
                                className={cn(
                                  "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-pre",
                                  "text-[13px] leading-[1.5]",
                                  active ? "text-ink" : "text-body",
                                )}
                              >
                                {match.before}
                                <mark className="bg-transparent font-medium text-accent">
                                  {match.text}
                                </mark>
                                {match.after}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </AutoHeight>

              <div className="flex h-8 items-center gap-3.5 border-t border-line px-4 text-[12px] text-muted">
                <KeyHint keys={[ArrowUp, ArrowDown]} label="选择" />
                <KeyHint keys={[CornerDownLeft]} label="打开" />
                <KeyHint keys={["Esc"]} label="关闭" />
                <span
                  className={cn(
                    "ml-auto min-w-0 truncate tabular-nums",
                    result?.error && "text-danger",
                  )}
                  title={result?.error ?? undefined}
                >
                  {status}
                </span>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

/** 按快捷键时正文里选着的一段字（一行之内、不太长）：就搜它（同 VS Code） */
function selectionSeed(): string | undefined {
  if (!document.activeElement?.closest(".cm-editor")) return undefined;
  const text = window.getSelection()?.toString() ?? "";
  return text && !text.includes("\n") && text.length <= 100 ? text : undefined;
}

function fileKey(file: FindFile): string {
  const target = file.target;
  if (target.kind === "goal") return `goal:${target.horizon}:${target.periodStart}`;
  return `${target.kind}:${target.id}`;
}

function iconOf(file: FindFile, byId: Map<string, NoteSummary>): LucideIcon {
  const target = file.target;
  if (target.kind === "day") return CalendarDays;
  if (target.kind === "goal") return Target;
  return byId.get(target.id)?.isArchived ? Archive : FileText;
}

/** 篇名右边的小字：笔记是出处（「归档 · 工作 / 周报」，「笔记」根下的不写），日记、目标是多久前改的 */
function hintOf(file: FindFile, byId: Map<string, NoteSummary>): string {
  const target = file.target;
  if (target.kind !== "note") return formatRelativeTime(file.updatedAt);
  const note = byId.get(target.id);
  if (!note) return "";
  return [note.isArchived ? "归档" : "", folderLabel(folderOf(note))]
    .filter((part) => part && part !== folderLabel(""))
    .join(" · ");
}
