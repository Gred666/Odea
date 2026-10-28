import { openDocument } from "@/app/navigate";
import { useApp } from "@/app/store";
import { type GuestCopy, dropGuestCopy, listGuestCopies } from "@/collab/keep";
import { backend } from "@/data/backend";
import { conflictOriginalContent } from "@/data/conflicts";
import { folderLabel, folderOf } from "@/data/folders";
import { NEW_NOTE_TITLE, messageOf, useData } from "@/data/store";
import type { DocumentSaveTarget, TrashedNote } from "@/data/types";
import { formatRelativeTime } from "@/lib/date";
import { popoverCard, tween } from "@/lib/motion";
import { LoaderCircle, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { SearchInput } from "./SearchInput";

/* ============================================================
   回收站（命令面板「回收站…」、仓库菜单）。删除不弹确认框，删完底部给 6 秒的「撤销」（UndoToast），
   这里是撤销之外的那条路：隔了几分钟、几天才发现删错了，也能在这里搜到、恢复。
   删掉的笔记在仓库的 .odea/trash/ 里留 30 天（打开仓库时清）。

   上面还列着协作时本机留的几份（collab/keep.ts，docs/协同编辑.md §24）：做客时主持人还没存下就断了、
   关了的字。能存成一篇笔记，或者丢掉。团队仓库里的那篇，主持人存的那一版已经同步过来、和这份一样了的，
   打开时自己删掉，不列出来。

   外壳和历史版本对话框一样：遮罩 + 从上往下展开的实心卡片（popoverCard）。打开之后再取列表 ——
   卡片一开始就是固定的高度，取到了只换里面的内容，不会展开到一半变高
   ============================================================ */

const HEADER = 52;
const DAY = 86_400_000;

interface Loaded {
  notes: TrashedNote[];
  copies: GuestCopy[];
}

/** 团队仓库里的一篇：这个仓库里它现在的正文（取不到是 undefined） */
async function currentBody(target: DocumentSaveTarget): Promise<string | undefined> {
  const data = useData.getState();
  if (target.kind === "note") return data.loadBody(target.id);
  if (target.kind === "day") await data.loadDay(target.id);
  if (target.kind === "goal") await data.loadGoal(target.horizon, target.periodStart);
  return conflictOriginalContent(target, useData.getState());
}

/** 这个窗口该列的几份：邀请做客的（不属于哪个仓库）和这个仓库的。已经和仓库里一样了的删掉 */
async function copiesHere(): Promise<GuestCopy[]> {
  const vault = useData.getState().vaultRoot;
  const mine = (await listGuestCopies()).filter(
    (copy) => copy.vault === null || copy.vault === vault,
  );
  const kept: GuestCopy[] = [];
  for (const copy of mine) {
    if (copy.target && copy.vault === vault) {
      // Rust 的 DocTarget 和 DocumentSaveTarget 同形，只是周期写成了 string（keep.ts 存进去的就是后者）
      const target = copy.target as DocumentSaveTarget;
      const body = await currentBody(target).catch(() => undefined);
      if (body === copy.text) {
        await dropGuestCopy(copy.key).catch(() => {});
        continue;
      }
    }
    kept.push(copy);
  }
  return kept;
}

async function load(): Promise<Loaded> {
  const [notes, copies] = await Promise.all([
    backend().then((api) => api.trashList()),
    copiesHere().catch(() => []),
  ]);
  return { notes, copies };
}

export function TrashDialog() {
  const open = useApp((s) => s.trashOpen);
  const setOpen = useApp((s) => s.setTrashOpen);
  const close = () => setOpen(false);
  // 每打开一次重新取：关上的淡出还没播完又打开时，AnimatePresence 用的还是那张卡片，列表不会自己再取
  const [opens, setOpens] = useState(0);

  useEffect(() => {
    if (!open) return;
    setOpens((count) => count + 1);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* 遮罩和面板分开：见 CommandPalette 里的说明（backdrop-filter 和 opacity 的坑） */}
          <motion.button
            key="scrim"
            type="button"
            data-ghost-skip
            aria-label="关闭回收站"
            onClick={close}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={tween.base}
            className="fixed inset-0 z-50 cursor-default bg-ink/[0.14] backdrop-blur-[3px]"
          />
          <div
            key="panel"
            data-ghost-skip
            className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label="回收站"
              custom={HEADER}
              variants={popoverCard}
              initial="hidden"
              animate="shown"
              exit="gone"
              className="pointer-events-auto relative flex w-[640px] max-w-[calc(100vw-48px)] flex-col
                         overflow-clip rounded-2xl bg-canvas shadow-modal ring-1 ring-line-strong"
            >
              <div
                className="flex shrink-0 items-center gap-2.5 border-b border-line px-4"
                style={{ height: HEADER }}
              >
                <Trash2 size={15} strokeWidth={2} className="shrink-0 text-faint" />
                <p className="min-w-0 flex-1 truncate text-[14px] text-ink">
                  <span className="font-medium">回收站</span>
                  <span className="text-muted"> · 删掉的笔记留 30 天</span>
                </p>
                <button
                  type="button"
                  aria-label="关闭"
                  onClick={close}
                  className="grid h-7 w-7 place-items-center rounded-md text-muted
                             transition-colors duration-[140ms] hover:bg-raised hover:text-ink"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </div>
              <TrashBody key={opens} onDone={close} />
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

function TrashBody({ onDone }: { onDone: () => void }) {
  const restoreTrashed = useData((s) => s.restoreTrashed);
  const createNoteWith = useData((s) => s.createNoteWith);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** 刚恢复、刚存成笔记的：那一行换成「打开」 */
  const [done, setDone] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    load().then(
      (result) => alive && setLoaded(result),
      (cause: unknown) => alive && setError(messageOf(cause)),
    );
    return () => {
      alive = false;
    };
  }, []);

  const needle = query.trim().toLowerCase();
  const matches = (...texts: string[]) =>
    !needle || texts.some((text) => text.toLowerCase().includes(needle));
  // 回收站里一般就几十篇：每次渲染筛一遍就行
  const notes = (loaded?.notes ?? []).filter((note) =>
    matches(note.title, note.excerpt, note.from),
  );
  const copies = (loaded?.copies ?? []).filter((copy) =>
    matches(copy.title, copy.host, copy.text.slice(0, 2000)),
  );

  const open = (id: string) => {
    openDocument({ kind: "note", id });
    onDone();
  };

  const restore = async (note: TrashedNote) => {
    setBusy(note.id);
    const id = await restoreTrashed(note.id);
    setBusy(null);
    if (id) setDone((now) => ({ ...now, [`note:${note.id}`]: id }));
  };

  const keepCopy = async (copy: GuestCopy) => {
    setBusy(copy.key);
    const id = await createNoteWith(copy.title, copy.text);
    if (id) {
      await dropGuestCopy(copy.key).catch(() => {});
      setDone((now) => ({ ...now, [`copy:${copy.key}`]: id }));
    }
    setBusy(null);
  };

  const discardCopy = async (copy: GuestCopy) => {
    setBusy(copy.key);
    try {
      await dropGuestCopy(copy.key);
      setLoaded((now) =>
        now ? { ...now, copies: now.copies.filter((other) => other.key !== copy.key) } : now,
      );
    } catch (cause) {
      setError(messageOf(cause));
    }
    setBusy(null);
  };

  const now = Date.now();
  const empty = loaded && !loaded.notes.length && !loaded.copies.length;

  return (
    <div className="flex h-[min(520px,66vh)] flex-col">
      <div className="shrink-0 px-4 pt-3 pb-2">
        <SearchInput value={query} onChange={setQuery} placeholder="搜标题、原来的位置、正文开头" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {error ? (
          <p className="px-2 py-6 text-center text-[13px] text-danger">{error}</p>
        ) : !loaded ? (
          <div className="grid h-full place-items-center text-faint">
            <LoaderCircle size={16} className="animate-spin" />
          </div>
        ) : empty ? (
          <p className="px-2 py-10 text-center text-[13px] text-muted">回收站是空的</p>
        ) : (
          <>
            {copies.length > 0 && (
              <section>
                <SectionTitle
                  title="协作时本机留的"
                  hint="做客时主持人还没存下的字，断线、关掉时留在了这台电脑上"
                />
                {copies.map((copy) => {
                  const opened = done[`copy:${copy.key}`];
                  return (
                    <Row
                      key={copy.key}
                      title={copy.title}
                      meta={`主持人 ${copy.host} · ${formatRelativeTime(copy.savedAt)}`}
                      excerpt={copy.text}
                    >
                      {opened ? (
                        <RowButton onClick={() => open(opened)}>打开</RowButton>
                      ) : (
                        <>
                          <RowButton
                            disabled={busy === copy.key}
                            onClick={() => void discardCopy(copy)}
                          >
                            丢掉
                          </RowButton>
                          <RowButton
                            primary
                            disabled={busy === copy.key}
                            onClick={() => void keepCopy(copy)}
                          >
                            存成笔记
                          </RowButton>
                        </>
                      )}
                    </Row>
                  );
                })}
              </section>
            )}
            {notes.length > 0 && (
              <section>
                {copies.length > 0 && <SectionTitle title="删掉的笔记" />}
                {notes.map((note) => {
                  const opened = done[`note:${note.id}`];
                  const days = Math.max(0, Math.ceil((note.purgeAt - now) / DAY));
                  const where = folderLabel(folderOf({ relPath: note.from, id: note.id }));
                  return (
                    <Row
                      key={note.id}
                      title={note.title.trim() || NEW_NOTE_TITLE}
                      meta={`${formatRelativeTime(note.deletedAt)} 删的 · 原来在「${where}」 · 还留 ${days} 天`}
                      excerpt={note.excerpt}
                    >
                      {opened ? (
                        <RowButton onClick={() => open(opened)}>打开</RowButton>
                      ) : (
                        <RowButton
                          primary
                          disabled={busy === note.id}
                          onClick={() => void restore(note)}
                        >
                          恢复
                        </RowButton>
                      )}
                    </Row>
                  );
                })}
              </section>
            )}
            {needle && !notes.length && !copies.length && (
              <p className="px-2 py-10 text-center text-[13px] text-muted">没有找到「{query}」</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-2 pt-3 pb-1.5">
      <p className="text-[12px] font-medium text-muted">{title}</p>
      {hint && <p className="mt-0.5 text-[11.5px] text-faint">{hint}</p>}
    </div>
  );
}

function Row({
  title,
  meta,
  excerpt,
  children,
}: {
  title: string;
  meta: string;
  excerpt: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg px-2 py-2.5 transition-colors duration-[120ms] hover:bg-raised/60">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-medium text-ink">{title}</p>
        <p className="mt-0.5 truncate text-[11.5px] text-faint">{meta}</p>
        {excerpt.trim() && (
          <p className="mt-1 line-clamp-2 text-[12px] leading-[1.55] text-muted">{excerpt}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pt-0.5">{children}</div>
    </div>
  );
}

function RowButton({
  children,
  primary,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={
        primary
          ? "h-7 rounded-md bg-accent px-2.5 text-[12.5px] font-medium text-accent-ink transition-colors duration-[120ms] hover:bg-accent-hover disabled:opacity-50"
          : "h-7 rounded-md px-2.5 text-[12.5px] text-muted ring-1 ring-line-strong transition-colors duration-[120ms] hover:bg-raised hover:text-ink disabled:opacity-50"
      }
    >
      {children}
    </button>
  );
}
