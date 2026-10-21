import { backend } from "@/data/backend";
import { folderLabel, nameOf, smartQuery } from "@/data/folders";
import { cn } from "@/lib/cn";
import { popoverCard } from "@/lib/motion";
import { ListFilter } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

/* ============================================================
   智能文件夹（docs/仓库与启动器.md §7.2）：起个名字、写一行条件，打开时按条件把笔记筛一遍。
   条件的写法见 Rust 的 vault/query.rs，这里列几条最常用的，边写边告诉你现在命中几篇。

   和文件夹选择器一样盖在列表栏上：第一帧就是实心的，按高度从顶上展开、里面的字不动（popoverCard）
   ============================================================ */

const EXAMPLES: [string, string][] = [
  ["复盘 交易", "标题或正文里有这几个词"],
  ["#复盘", "正文里的标签"],
  ["in:交易", "在树上这个文件夹里"],
  ["updated:7d", "7 天内改过（d 天 · w 周 · m 月）"],
  ["has:todo", "有没勾的待办"],
  ["-#草稿", "前面加 - 是「不要」"],
];

export function SmartFolderEditor({
  parent,
  path,
  top,
  onSave,
  onClose,
}: {
  /** 新建：建在哪个文件夹里 */
  parent: string;
  /** 改：这个智能文件夹的路径；新建是 undefined */
  path?: string;
  top: number;
  onSave: (name: string, query: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(path ? nameOf(path) : "");
  const [query, setQuery] = useState((path && smartQuery(path)) ?? "");
  const [count, setCount] = useState<number | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const queryInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (path ? queryInput : nameInput).current?.focus();
  }, [path]);

  // 边写边筛一遍，告诉你现在命中几篇（停手 250ms 再问）
  useEffect(() => {
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const [found] = await (await backend()).treeQueries([query]);
        if (live) setCount(found?.length ?? 0);
      } catch {
        if (live) setCount(null);
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  // 点卡片外面关掉
  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onClose]);

  const submit = () => {
    const finalName = name.trim() || query.trim();
    if (!finalName) {
      nameInput.current?.focus();
      return;
    }
    onSave(finalName, query.trim());
  };

  const keys = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <motion.div
      ref={panel}
      role="dialog"
      aria-label={path ? "改智能文件夹" : "新建智能文件夹"}
      variants={popoverCard}
      custom={40}
      initial="hidden"
      animate="shown"
      exit="gone"
      style={{ top }}
      className="absolute inset-x-4 z-30 flex flex-col overflow-clip rounded-[10px] bg-canvas
                 shadow-float ring-1 ring-line-strong"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <ListFilter size={13} strokeWidth={2} className="shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
          {path ? "改智能文件夹" : "新建智能文件夹"}
        </span>
        {!path && parent && (
          <span className="min-w-0 max-w-[45%] truncate text-[12px] text-faint">
            在「{folderLabel(parent)}」里
          </span>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-2.5 px-3 pt-3 pb-2.5">
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-muted">名字</span>
          <input
            ref={nameInput}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={keys}
            placeholder="不写就用条件当名字"
            className={FIELD}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="flex items-baseline justify-between text-[12px] text-muted">
            条件
            <span className="tabular-nums text-faint">
              {count === null ? "" : count ? `现在有 ${count} 篇` : "现在一篇都没有"}
            </span>
          </span>
          <input
            ref={queryInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={keys}
            placeholder="#复盘 updated:30d"
            spellCheck={false}
            className={cn(FIELD, "font-mono text-[12.5px]")}
          />
        </label>
        <ul className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-[3px] pt-0.5 text-[12px]">
          {EXAMPLES.map(([example, meaning]) => (
            <li key={example} className="contents">
              <button
                type="button"
                title="加到条件里"
                onClick={() => {
                  setQuery((current) =>
                    current.trim() ? `${current.trim()} ${example}` : example,
                  );
                  queryInput.current?.focus();
                }}
                className="justify-self-start rounded px-1 font-mono text-[12px] text-muted
                           transition-colors duration-[140ms] hover:bg-raised hover:text-ink"
              >
                {example}
              </button>
              <span className="text-faint">{meaning}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex shrink-0 justify-end gap-2 border-t border-line px-3 py-2">
        <button
          type="button"
          onClick={onClose}
          className="h-7 rounded-md px-3 text-[13px] text-muted transition-colors duration-[140ms] hover:bg-raised hover:text-ink"
        >
          取消
        </button>
        <button
          type="button"
          onClick={submit}
          className="h-7 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-ink transition-colors duration-[140ms] hover:bg-accent-hover"
        >
          {path ? "保存" : "建好"}
        </button>
      </div>
    </motion.div>
  );
}

const FIELD =
  "h-[30px] rounded-md bg-canvas px-2 text-[13px] text-ink outline-none ring-1 ring-line-strong " +
  "placeholder:text-faint focus:ring-accent-line focus:shadow-[0_0_0_3px_var(--color-accent-wash)]";
