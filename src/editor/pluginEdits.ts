import type { EditOutcome, TextChange } from "@/lib/liveDocuments";
import { ChangeSet } from "@codemirror/state";

/* ============================================================
   插件改正文（docs/插件与跨端.md §5.5「改文档分两步」）：先 documents.read 拿到正文和修订号，
   再 documents.edit({ ref, baseRevision, changes })。

   修订号按编辑器实例记：每个 MarkdownEditor 一份日志，这个编辑器里每改一笔（打字、撤销、
   另一个窗格转过来的、协作别人的、外部回填的）加一，记下那一笔的 ChangeSet。修订号写成
   「日志的 id.第几笔」：编辑器换了一个（切走又切回来、重新打开），旧的修订号对不上，一律算过时。

   插件照着旧的那一版改：把那以后的几笔合起来，插件要改的地方要是没被碰过，就把插件的改动挪到
   现在的正文上（ChangeSet.map）；碰过了就回 stale，插件重新读一遍再改 —— 不让旧结果盖掉新正文
   （Obsidian 的 Vault.process 也是这个用意）。挪得动的情况：用户在前面加了一行、在别处打了几个字。
   ============================================================ */

/** 最多记多少笔：再往前的修订号算过时 */
const KEEP = 200;
/** 一次最多改几处、插进去的字最多多少 */
export const EDIT_LIMITS = { changes: 1000, insert: 1024 * 1024 };

export interface RevisionLog {
  epoch: string;
  n: number;
  entries: { n: number; changes: ChangeSet }[];
}

let epochs = 0;

export function createRevisionLog(): RevisionLog {
  epochs += 1;
  return { epoch: `${Date.now().toString(36)}${epochs.toString(36)}`, n: 0, entries: [] };
}

export function recordRevision(log: RevisionLog, changes: ChangeSet): void {
  log.n += 1;
  log.entries.push({ n: log.n, changes });
  if (log.entries.length > KEEP) log.entries.shift();
}

export const revisionOf = (log: RevisionLog): string => `${log.epoch}.${log.n}`;

type Rebased = { ok: true; changes: ChangeSet } | Extract<EditOutcome, { ok: false }>;

const invalid = (message: string): Rebased => ({ ok: false, code: "invalid", message });
const stale = (message: string): Rebased => ({ ok: false, code: "stale", message });

/**
 * 插件照着 base 那一版交来的改动 → 能直接用在现在正文上的 ChangeSet。docLength 是现在正文的长度
 */
export function rebaseEdit(
  log: RevisionLog,
  base: unknown,
  changes: unknown,
  docLength: number,
): Rebased {
  if (typeof base !== "string") return invalid("baseRevision 要是 documents.read 给的修订号");
  const dot = base.lastIndexOf(".");
  const epoch = base.slice(0, dot);
  const n = Number(base.slice(dot + 1));
  if (dot < 0 || !Number.isSafeInteger(n) || n < 0) return invalid("baseRevision 写得不对");
  if (epoch !== log.epoch) return stale("这篇重新打开过了，重新读一遍再改");
  if (n > log.n) return invalid("baseRevision 比现在的还新");
  const after = log.entries.filter((entry) => entry.n > n);
  if (after.length !== log.n - n) return stale("那以后改得太多了，重新读一遍再改");
  const since = after.reduce<ChangeSet | null>(
    (sum, entry) => (sum ? sum.compose(entry.changes) : entry.changes),
    null,
  );
  const baseLength = since ? since.length : docLength;

  if (!Array.isArray(changes)) return invalid("changes 要是数组（[{ from, to, insert }]）");
  if (changes.length > EDIT_LIMITS.changes) {
    return invalid(`一次最多改 ${EDIT_LIMITS.changes} 处`);
  }
  let inserted = 0;
  let previous = 0;
  const list: TextChange[] = [];
  for (const [index, raw] of changes.entries()) {
    const change = raw as Partial<TextChange> | null;
    const { from, to, insert = "" } = change ?? {};
    if (
      !change ||
      typeof from !== "number" ||
      typeof to !== "number" ||
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      typeof insert !== "string"
    ) {
      return invalid(`changes[${index}] 要是 { from, to, insert }，from、to 是整数`);
    }
    if (from < 0 || to < from || to > baseLength) {
      return invalid(`changes[${index}] 超出了正文（那一版有 ${baseLength} 个字符）`);
    }
    if (from < previous) return invalid(`changes[${index}] 要按位置从前往后排，不能重叠`);
    previous = to;
    inserted += insert.length;
    if (inserted > EDIT_LIMITS.insert) return invalid("插进去的字太多了");
    list.push({ from, to, insert });
  }
  if (!list.length) return invalid("changes 是空的");
  const set = ChangeSet.of(list, baseLength);
  if (!since) return { ok: true, changes: set };
  for (const { from, to } of list) {
    if (since.touchesRange(from, to)) return stale("要改的地方刚被改过，重新读一遍再改");
  }
  return { ok: true, changes: set.map(since) };
}
