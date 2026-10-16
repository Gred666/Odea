import { selectNeighbor } from "@/app/navigate";
import { useApp } from "@/app/store";
import { ListColumn, MoreRows, ROW_BATCH, useRowBatch } from "@/components/ListColumn";
import { SearchInput } from "@/components/SearchInput";
import { useData } from "@/data/store";
import { useTextSearch } from "@/data/textSearch";
import type { NoteSummary } from "@/data/types";
import { cn } from "@/lib/cn";
import { formatSmartCN, toISODate } from "@/lib/date";
import { animatedEmojiText } from "@/lib/emojiText";
import { spring, tween } from "@/lib/motion";
import { RotateCcw, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { memo, useEffect, useMemo, useRef } from "react";
import { ConflictTag, EmptyResult, useListTitle } from "./NotesView";

/** 归档卡片的高度（三行字 + 上下留白）：分批画时给还没画的那一截占位（ListColumn 的 MoreRows） */
const CARD_HEIGHT = 86.08;
/** 搜索框在正文里最多找出几篇（Rust 那边的上限） */
const ARCHIVE_SEARCH_LIMIT = 1000;

/** 卡片上的操作。身份不变：卡片是 memo 的，不能每次渲染都拿到一份新的回调 */
interface ArchiveActions {
  select: (id: string) => void;
  restore: (id: string) => void;
  remove: (id: string) => void;
}

export function ArchiveList({
  items,
  onRestore,
}: {
  items: NoteSummary[];
  onRestore: (id: string) => void;
}) {
  const selectedId = useApp((s) => s.selectedArchiveId);
  const selectArchive = useApp((s) => s.selectArchive);
  const query = useApp((s) => s.archiveQuery);
  const setQuery = useApp((s) => s.setArchiveQuery);
  const deleteNote = useData((s) => s.deleteNote);

  // 同 NotesList：选中的那条在别处没了（或上次看的那条已经不在），正文退到第一条，
  // 列表高亮也跟过去。从这里恢复 / 删除的已经先挪到了下一条（selectNeighbor）
  useEffect(() => {
    if (items.length === 0 || items.some((n) => n.id === selectedId)) return;
    selectArchive(items[0]!.id);
  }, [items, selectedId, selectArchive]);

  // 正文里有没有由 Rust 搜（data/textSearch）。列表按最后一次搜完的那个词整个换：
  // 不先剩下标题命中的、过一会儿再冒出正文命中的
  const searched = useTextSearch(query, ARCHIVE_SEARCH_LIMIT, true);
  const q = query.trim() ? (searched?.query ?? "").toLowerCase() : "";
  const filtered = useMemo(() => {
    if (!q || !searched) return items;
    const inBody = new Set(
      searched.result.notes.map((hit) => (hit.target.kind === "note" ? hit.target.id : "")),
    );
    return items.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.excerpt.toLowerCase().includes(q) ||
        inBody.has(n.id),
    );
  }, [items, q, searched]);

  // 分批画（同笔记列表）：几百篇归档整列画出来，切进归档要多花好几百毫秒
  const { shown, more } = useRowBatch(
    q ? `search:${q}` : "all",
    filtered.length,
    filtered.findIndex((n) => n.id === selectedId),
  );

  const latest = useRef({ selectArchive, onRestore, deleteNote });
  latest.current = { selectArchive, onRestore, deleteNote };
  const actions = useMemo<ArchiveActions>(
    () => ({
      select: (id) => latest.current.selectArchive(id),
      // 正在看的这篇走了：选中先挪到下一篇（app/navigate 的 selectNeighbor）
      restore: (id) => {
        selectNeighbor(id);
        latest.current.onRestore(id);
      },
      remove: (id) => {
        selectNeighbor(id);
        void latest.current.deleteNote(id);
      },
    }),
    [],
  );

  return (
    <ListColumn
      title="归档"
      belowTitle={<SearchInput value={query} onChange={setQuery} placeholder="搜索归档内容" />}
    >
      {filtered.length === 0 ? (
        <EmptyResult
          query={query}
          emptyTitle="归档是空的"
          emptyHint="归档的笔记会保留在这里，不出现在日常列表中"
        />
      ) : (
        <div className="flex flex-col">
          {filtered.slice(0, shown).map((n, i) => (
            <ArchiveCard
              key={n.id}
              note={n}
              index={i}
              divided={i > 0}
              selected={n.id === selectedId}
              appear={i < ROW_BATCH}
              actions={actions}
            />
          ))}
          {shown < filtered.length && (
            <MoreRows height={(filtered.length - shown) * CARD_HEIGHT} onNear={more} />
          )}
        </div>
      )}
    </ListColumn>
  );
}

/**
 * 一条归档。memo：换选中只重渲染新旧两张。位置只会因为上面多了 / 少了卡片而变 —— 那时
 * index 跟着变，这张也就重渲染、量位置播 layout 动画（layoutDependency）
 */
const ArchiveCard = memo(function ArchiveCard({
  note,
  index,
  divided,
  selected,
  appear,
  actions,
}: {
  note: NoteSummary;
  index: number;
  divided: boolean;
  selected: boolean;
  /** 挂上时淡入；往下滚才画出来的那几批不播 */
  appear: boolean;
  actions: ArchiveActions;
}) {
  const dateLabel = note.archivedAt ? formatSmartCN(toISODate(new Date(note.archivedAt))) : "";
  const title = useListTitle(note);

  return (
    <motion.div
      layout="position"
      layoutDependency={index}
      initial={appear ? { opacity: 0, y: 7 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -12, transition: tween.fast }}
      transition={{ ...tween.base, delay: Math.min(index, 9) * 0.028 }}
      data-note-row={note.id}
      className={cn(
        "group relative",
        divided && "before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-line",
      )}
    >
      <button
        type="button"
        onClick={() => actions.select(note.id)}
        className="relative w-full rounded-lg px-3 py-3 pr-14 text-left"
      >
        {selected && (
          <motion.span
            layoutId="archive-selection"
            className="absolute inset-x-0 inset-y-[2px] rounded-lg bg-accent-wash ring-1
                       ring-accent-line/60"
            transition={spring.smooth}
          />
        )}
        {!selected && (
          <span
            className="absolute inset-x-0 inset-y-[2px] rounded-lg transition-colors
                       duration-[150ms] group-hover:bg-raised/40"
          />
        )}

        <span className="relative z-10 flex items-start gap-2">
          <span className="min-w-0 flex-1">
            {/* 同 NotesView：标题单行，超出用省略号 */}
            <span className="block truncate text-[13.5px] font-semibold leading-[1.45] text-ink/90">
              {title}
            </span>
            <span className="mt-[3px] block truncate text-[11.5px] leading-[1.45] text-muted">
              {note.conflictOf && <ConflictTag title={note.title} />}
              {animatedEmojiText(note.excerpt)}
            </span>
            <span className="mt-[5px] flex items-center gap-1.5 text-[10.5px] text-faint">
              <span>{note.archiveCategory}</span>
              <span className="opacity-50">·</span>
              <span className="font-mono tabular-nums">{dateLabel}</span>
            </span>
          </span>
        </span>
      </button>

      {/* 右上角两个按钮：删除（悬停才出现）、恢复（选中时常亮）。
          以前只有恢复 —— 归档里的笔记删不掉，得先恢复出来再删 */}
      <div className="absolute right-3 top-[11px] z-20 flex items-center gap-1">
        <button
          type="button"
          aria-label={`删除「${title}」`}
          title="删除（可以撤销）"
          onClick={() => actions.remove(note.id)}
          className="grid h-5 w-5 place-items-center rounded text-faint opacity-0 transition-[opacity,color]
                     duration-[150ms] hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Trash2 size={12} strokeWidth={2} />
        </button>
        {/* 恢复按钮：悬停旋转一圈，是「转回去」的直观隐喻 */}
        <motion.button
          type="button"
          aria-label={`恢复「${title}」`}
          title="恢复到笔记"
          onClick={() => actions.restore(note.id)}
          whileHover={{ rotate: -150 }}
          whileTap={{ scale: 0.85, rotate: -300 }}
          transition={spring.smooth}
          className={cn(
            "grid h-5 w-5 place-items-center rounded",
            "transition-opacity duration-[150ms] hover:text-accent focus-visible:opacity-100",
            selected ? "text-accent opacity-100" : "text-faint opacity-0 group-hover:opacity-100",
          )}
        >
          <RotateCcw size={12.5} strokeWidth={2} />
        </motion.button>
      </div>
    </motion.div>
  );
});
