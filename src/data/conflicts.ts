import { documentType, refOfId } from "@/plugins/registry";
import { type DocumentRef, NOTE, type NoteSummary } from "./types";

/* ============================================================
   冲突副本的原文（技术方案 §5.5、§5.9.5）。

   Note.conflictOf 是原文的 id：一般是另一篇笔记的 id；也可能是插件的一篇在索引里的 id
   （日程的某一天 `day:2026-10-07`、某个周期的目标 `goal:week:2026-09-21`）—— 两台设备都改了今日TODO
   是同步里最常见的冲突，副本「2026-10-07 (冲突 …).md」的名字不是日期，落在「日记」里当一篇笔记。
   列表标题、冲突横幅、「用这一版替换原文」都从这里认原文；插件的那几种由插件认（DocumentType.keyOf）
   ============================================================ */

/** conflictOf → 原文是哪篇：打开它、往里保存都用这个 */
export function conflictTarget(conflictOf: string): DocumentRef {
  return refOfId(conflictOf);
}

interface NoteLists {
  notes: NoteSummary[];
  archived: NoteSummary[];
}

interface Documents extends NoteLists {
  /** 留着的笔记正文（store 的 bodies） */
  bodies: Record<string, string>;
}

function findNote(lists: NoteLists, id: string): NoteSummary | undefined {
  return (
    lists.notes.find((note) => note.id === id) ?? lists.archived.find((note) => note.id === id)
  );
}

/**
 * 原文叫什么：笔记是它的标题，插件的一篇照插件说的（某一天「10月7日」，目标「第 39 周目标」，
 * 和反向链接的出处一样）。原文是笔记、但已经不在了：undefined
 */
export function conflictOriginalTitle(target: DocumentRef, lists: NoteLists): string | undefined {
  if (target.type !== NOTE) return documentType(target.type)?.title(target.key);
  return findNote(lists, target.key)?.title;
}

/**
 * 原文现在的正文。笔记的正文、插件的文档都是按需取的（loadBody / DocumentType.load），
 * 还没取回来时 undefined
 */
export function conflictOriginalContent(target: DocumentRef, docs: Documents): string | undefined {
  if (target.type !== NOTE) return documentType(target.type)?.body(target.key);
  return findNote(docs, target.key) ? docs.bodies[target.key] : undefined;
}
