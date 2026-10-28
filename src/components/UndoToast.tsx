import { openDocument } from "@/app/navigate";
import { useApp } from "@/app/store";
import { NEW_NOTE_TITLE, useData } from "@/data/store";
import { tween } from "@/lib/motion";
import {
  Archive,
  ArchiveRestore,
  FilePlus2,
  FolderInput,
  History,
  Link2,
  Trash2,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

const UNDOABLE_ICON = {
  move: FolderInput,
  delete: Trash2,
  archive: Archive,
  restore: ArchiveRestore,
  create: FilePlus2,
  relink: Link2,
  history: History,
} as const;

/** 提示条停留多久。指针停在上面时暂停计时。 */
const UNDO_WINDOW_MS = 6000;

/**
 * 底部的「已删除 · 撤销」提示条。删笔记、删文件夹、把笔记挪到别的文件夹、归档 / 恢复、
 * 改标题时改写了别处的双链、恢复了历史版本之后出现。
 *
 * 操作本身立刻生效（删除是软删除，进仓库的回收站），这里只是给一个反悔的窗口：
 * 以前删除既不确认也不能撤销，界面上又没有回收站，手一滑就等于永久删除。
 * 用撤销而不是确认框 —— 删除是有意为之的时候居多，每次都拦一道只是多一次点击。
 * 同一时间只有一条：后发生的顶掉前一条（store 里 lastDeleted 和 undoable 互斥）。
 * 所以删除的提示条上还有「回收站」：提示条过了、被顶掉了，删掉的笔记在回收站里留 30 天（TrashDialog）。
 */
export function UndoToast() {
  const deleted = useData((s) => s.lastDeleted);
  const undoable = useData((s) => s.undoable);
  const undoDelete = useData((s) => s.undoDelete);
  const dismissUndo = useData((s) => s.dismissUndo);
  const dismissUndoable = useData((s) => s.dismissUndoable);
  const setTrashOpen = useApp((s) => s.setTrashOpen);
  const [hovered, setHovered] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const item = deleted
    ? {
        key: `note:${deleted.note.id}`,
        icon: Trash2,
        message: `已删除「${deleted.note.title.trim() || NEW_NOTE_TITLE}」`,
      }
    : undoable
      ? {
          key: undoable.key,
          icon: UNDOABLE_ICON[undoable.kind],
          message: undoable.message,
        }
      : null;

  const key = item?.key;
  useEffect(() => {
    if (!key || hovered) return;
    timer.current = setTimeout(() => {
      dismissUndo();
      dismissUndoable();
    }, UNDO_WINDOW_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [key, hovered, dismissUndo, dismissUndoable]);

  const undo = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // 撤销完回到那一篇（它在笔记里就打开笔记，回了归档就打开归档）
      if (deleted) {
        const id = await undoDelete();
        if (id) openDocument({ kind: "note", id });
      } else if (undoable) {
        dismissUndoable();
        await undoable.undo();
        if (undoable.reopen) openDocument({ kind: "note", id: undoable.reopen });
      }
    } finally {
      setBusy(false);
      setHovered(false);
    }
  };

  const Icon = item?.icon ?? Trash2;
  const deletion = !!deleted || undoable?.kind === "delete";

  // 定位交给 Shell 里的 ToastStack，和错误提示叠在一起
  return (
    <AnimatePresence>
      {item && (
        <motion.div
          key={item.key}
          role="status"
          // 不缩放：提示条里是字，缩放会让字在动画里发虚、停下那一帧再跳清楚。
          // tween 不用 spring：spring 收尾时差不到半个像素就直接跳到终点
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8, transition: tween.fast }}
          transition={tween.slow}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          className="pointer-events-auto flex max-w-[420px] items-center gap-3 rounded-xl
                       bg-ink py-2 pl-3.5 pr-2 text-[13px] text-canvas shadow-float"
        >
          <Icon size={14} strokeWidth={1.9} className="shrink-0 opacity-70" />
          <span className="min-w-0 truncate">{item.message}</span>
          <button
            type="button"
            onClick={() => void undo()}
            disabled={busy}
            className="shrink-0 rounded-md px-2 py-1 font-semibold text-canvas
                         transition-colors duration-[140ms] hover:bg-canvas/15 disabled:opacity-60"
          >
            撤销
          </button>
          {deletion && (
            <button
              type="button"
              onClick={() => {
                dismissUndo();
                dismissUndoable();
                setTrashOpen(true);
              }}
              className="-ml-2 shrink-0 rounded-md px-2 py-1 text-canvas/75
                         transition-colors duration-[140ms] hover:bg-canvas/15 hover:text-canvas"
            >
              回收站
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
