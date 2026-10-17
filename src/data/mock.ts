import {
  APP_VERSION,
  GUIDES,
  type Guide,
  carryChecks,
  guideFingerprint,
  guideIdPrefix,
  guideOf,
  newerThan,
} from "@/content/guide";
import { formatMonthDayCN, goalTitle, periodStartOf } from "@/lib/date";
import { countWords, makeExcerpt } from "@/lib/plainText";
import {
  contextLine,
  findWikiLinks,
  linkableTitle,
  retargetWikiLinks,
  sameTitle,
} from "@/lib/wikilinks";
import type { Backend } from "./backend";
import {
  cleanFolderName,
  fileStemFor,
  folderOf,
  parentOf,
  relPathIn,
  renamedPath,
  renamedRelPath,
  uniqueChild,
  within,
} from "./folders";
import {
  type AppUpgrade,
  type Backlink,
  type DayDoc,
  type DocHistory,
  type DocumentSaveTarget,
  type FindFile,
  type FindMatch,
  type FindOptions,
  type FolderDeletion,
  type Goal,
  type GoalHorizon,
  type GuideName,
  type GuideUpdate,
  type JournalDoc,
  type LinkRewrite,
  type Note,
  type NoteInput,
  type NoteSummary,
  type Relink,
  SYNC_OFF,
  type Task,
  type TextHit,
  type UpdateInfo,
  type VaultChange,
  type VaultInfo,
  goalKey,
} from "./types";

/* ============================================================
   浏览器 mock 后端。

   只在 `pnpm dev` 直开 1420 端口调 UI 时用；桌面版走 Rust（仓库文件夹里的 .md 文件）。
   语义尽量贴近 Rust 实现（删除可撤销、归档清置顶、置顶排前），
   这样在浏览器里看到的行为和真机一致。跟文件打交道的操作（在文件夹中显示…）只在桌面版里有。
   带日期的任务在这里是一份独立的列表，不从正文里解析。
   新仓库里只有使用指南（src/content/guide/），和桌面版一样；升级时的新旧也按同一套规矩管。

   状态存在 localStorage，改了 seed 想清空就升版本号。
   ============================================================ */

// v3：「今日TODO」从笔记 n-today 变成带标题的 day_doc，GOAL 改成一个周期一篇
// v4：笔记带上 relPath / conflictOf，多一篇冲突副本的演示
// v5：原型的示例笔记、日记、目标都去掉了，新仓库里只有使用指南
const LS_KEY = "odea.mock.v5";

/**
 * 使用指南那几篇多一个记号（桌面版写在文件的属性块里）：上一次给它的是哪个版本带的指南、
 * 那一版正文的指纹
 */
type MockNote = Note & { guide?: { name: GuideName; version: string; hash: string } };

interface MockState {
  notes: MockNote[];
  tasks: Record<string, Task>;
  /** 按日期索引的某天文档（不含任务） */
  days: Record<string, { title: string; noteMd: string; updatedAt: number }>;
  /** 按 `horizon:periodStart` 索引的目标 */
  goals: Record<string, Goal>;
  /** 删掉的笔记。和 Rust 侧的软删除一样可以撤销；旧版存档里没有这一项 */
  trash?: MockNote[];
  /** 「笔记」下面的文件夹（相对「笔记」的路径）；旧版存档里没有这一项 */
  folders?: string[];
}

function load(): MockState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as MockState;
      if (Array.isArray(p.notes) && p.tasks && p.days && p.goals) return p;
    }
  } catch {
    /* 隐私模式 / 数据损坏：从一个新仓库开始 */
  }
  const fresh: MockState = {
    notes: GUIDES.map((guide) => newGuideNote(guide, Date.now())),
    tasks: {},
    days: {},
    goals: {},
  };
  // 马上存下：指南的 id 是随机的，不存的话每次刷新都换一批，记住的「上次停在哪一篇」就对不上了
  save(fresh);
  return fresh;
}

/** 新放进去的一篇指南（和 Rust 侧 guide::new_file 一样） */
function newGuideNote(guide: Guide, now: number): MockNote {
  return {
    id: `${guideIdPrefix(guide.name)}${crypto.randomUUID()}`,
    title: guide.title,
    contentMd: guide.body,
    excerpt: makeExcerpt(guide.body, 60),
    wordCount: countWords(guide.body),
    isPinned: guide.pinned,
    isArchived: false,
    archiveCategory: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    relPath: `笔记/${fileStemFor(guide.title)}.md`,
    conflictOf: null,
    guide: { name: guide.name, version: APP_VERSION, hash: guideFingerprint(guide.body) },
  };
}

/** 记下的那一版和这个应用带的不一样，而且不是更新的应用写的 */
function guideOutdated(note: MockNote, guide: Guide): boolean {
  const mark = note.guide;
  return (
    !!mark && mark.hash !== guideFingerprint(guide.body) && !newerThan(mark.version, APP_VERSION)
  );
}

/** 启动时：没改过的指南换成这一版带的（勾过的框照勾），和 Rust 侧 guide_refresh 一样 */
function refreshGuides(s: MockState) {
  let changed = false;
  for (const note of s.notes) {
    const guide = guideOf(note.id);
    if (!guide || note.guide?.name !== guide.name || !guideOutdated(note, guide)) continue;
    if (guideFingerprint(note.contentMd) !== note.guide.hash) continue;
    note.contentMd = carryChecks(note.contentMd, guide.body);
    note.excerpt = makeExcerpt(note.contentMd, 60);
    note.wordCount = countWords(note.contentMd);
    note.updatedAt = Date.now();
    note.guide = { name: guide.name, version: APP_VERSION, hash: guideFingerprint(guide.body) };
    changed = true;
  }
  return changed;
}

/** 冲突副本的名字（和 Rust 侧 layout::conflict_originals 的常见几种一样），原文的标题 */
function conflictOriginalTitle(title: string): string | null {
  const patterns = [
    /^(.*?)\s*[(（][^()（）]*(?:冲突|conflict)[^()（）]*[)）](?: \d+)?$/i,
    /^(.*?)\.sync-conflict-\d{8}-\d{6}(?:-[A-Z0-9]+)?$/,
    /^(.*?)\s*[(（]\d+[)）]$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(title);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

/** 给前端的那一份：算上它是不是谁的冲突副本 */
function present({ guide: _mark, ...note }: MockNote): Note {
  const originalTitle = conflictOriginalTitle(note.title);
  const original = originalTitle
    ? state.notes.find((other) => other.id !== note.id && other.title === originalTitle)
    : undefined;
  return {
    ...note,
    relPath: note.relPath ?? `${note.isArchived ? "归档" : "笔记"}/${fileStemFor(note.title)}.md`,
    conflictOf: original?.id ?? null,
  };
}

const dayRelPath = (date: string) => `日记/${date.slice(0, 4)}/${date}.md`;
const goalRelPath = (periodStart: string) => `目标/${periodStart.slice(0, 4)}/${periodStart}.md`;

function save(s: MockState) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    /* 忽略 */
  }
}

const state: MockState = load();
if (refreshGuides(state)) save(state);

/** 文件夹在不在（空串是「笔记」本身，总在） */
const hasFolder = (folder: string) => folder === "" || (state.folders ?? []).includes(folder);

/** 把文件夹连同它的上层都建上（恢复 / 撤销删除时原来的文件夹可能没了） */
function ensureFolder(folder: string) {
  const folders = new Set(state.folders ?? []);
  for (let path = folder; path; path = parentOf(path)) folders.add(path);
  state.folders = [...folders].sort();
}

const uniqueFolder = (parent: string, name: string, keep?: string) =>
  uniqueChild(state.folders ?? [], parent, name, keep);

/** 模拟一点 IPC 往返延迟，免得开发时对真机性能有错觉 */
const tick = () => new Promise<void>((r) => setTimeout(r, 8));

/** 某个列表（笔记 / 归档）的笔记，顺序和 Rust 侧一样：置顶在前，再按更新 / 归档时间倒序 */
function listed(archived: boolean): Note[] {
  const key = archived ? "archivedAt" : "updatedAt";
  return state.notes
    .filter((n) => n.isArchived === archived)
    .sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return (b[key] ?? 0) - (a[key] ?? 0);
    });
}

function notFound(what: string): never {
  throw { kind: "NotFound", message: what };
}

/** 浏览器预览里没有仓库文件夹：跟文件打交道的操作只在桌面版里有 */
function syncDesktopOnly(): never {
  throw { kind: "Invalid", message: "浏览器预览里没有笔记文件夹，桌面版里才能开启同步" };
}

function desktopOnly(): never {
  throw { kind: "Invalid", message: "浏览器预览里没有本地文件，桌面版里才能打开笔记文件夹" };
}

/* ---------------- 别处的改动 ----------------
   浏览器里没有别的程序会改文件；只有改标题时改写别处的双链会动到别的文档，照桌面版的样子通知前端 */

const vaultListeners = new Set<(change: VaultChange) => void>();

function announce(change: Partial<VaultChange>) {
  const full: VaultChange = {
    notes: [],
    days: [],
    goals: [],
    tasks: false,
    conflicts: [],
    foundCopies: [],
    folders: false,
    ...change,
  };
  setTimeout(() => {
    for (const listener of vaultListeners) listener(full);
  }, 0);
}

/** 正文里可能写着双链的每一篇（笔记、某一天、目标），改写别处的链接时用 */
function linkSources() {
  const notes = state.notes.map((note) => ({
    kind: "note" as const,
    id: note.id,
    relPath: present(note).relPath,
    title: note.title,
    get: () => note.contentMd,
    set: (body: string) => {
      note.contentMd = body;
      note.excerpt = makeExcerpt(body, 60);
      note.wordCount = countWords(body);
      note.updatedAt = Date.now();
      recordVersion(`note:${note.id}`, body, note.title);
    },
  }));
  const days = Object.entries(state.days).map(([date, day]) => ({
    kind: "day" as const,
    id: date,
    relPath: dayRelPath(date),
    title: day.title ? `${formatMonthDayCN(date)} · ${day.title}` : formatMonthDayCN(date),
    get: () => day.noteMd,
    set: (body: string) => {
      day.noteMd = body;
      day.updatedAt = Date.now();
      recordVersion(`day:${date}`, body);
    },
  }));
  const goals = Object.entries(state.goals).map(([key, goal]) => ({
    kind: "goal" as const,
    id: key,
    relPath: goalRelPath(goal.periodStart),
    title: goalTitle(goal.horizon, goal.periodStart),
    get: () => goal.contentMd,
    set: (body: string) => {
      goal.contentMd = body;
      goal.updatedAt = Date.now();
      recordVersion(`goal:${key}`, body);
    },
  }));
  return [...notes, ...days, ...goals];
}

type LinkSource = ReturnType<typeof linkSources>[number];

function announceSources(sources: LinkSource[]) {
  announce({
    notes: sources.filter((s) => s.kind === "note").map((s) => s.id),
    days: sources.filter((s) => s.kind === "day").map((s) => s.id),
    goals: sources.filter((s) => s.kind === "goal").map((s) => s.id),
  });
}

/* ---------------- 历史版本 ----------------
   浏览器里没有 git：每次保存记一版，停笔一分钟以内的算同一版（和同步停笔一分钟提交一次差不多）。
   示例内容第一次看历史时编出两版更早的，好看效果。只在内存里，刷新就没了 */

interface MockVersion {
  blob: string;
  time: number;
  device: string;
  mine: boolean;
  title: string;
  body: string;
}

const versionLog = new Map<string, MockVersion[]>();
let blobSeq = 0;

function recordVersion(key: string, body: string, title = "") {
  const list = versionLog.get(key) ?? [];
  const last = list[0];
  if (last?.body === body && last.title === title) return;
  const now = Date.now();
  const version = {
    blob: `mock-${++blobSeq}`,
    time: now,
    device: "这台电脑",
    mine: true,
    title,
    body,
  };
  if (last?.mine && now - last.time < 60_000) {
    // 一分钟里又改回了上一版的样子：等于没改（同步那边也只会在停笔一分钟后提交一次）
    const previous = list[1];
    if (previous?.body === body && previous.title === title) list.shift();
    else list[0] = version;
  } else {
    list.unshift(version);
  }
  versionLog.set(key, list);
}

function historyOf(key: string, body: string, title: string): MockVersion[] {
  if (!versionLog.has(key) && body.trim()) {
    const paragraphs = body.split(/\n{2,}/);
    const earlier = (drop: number) =>
      paragraphs.slice(0, Math.max(1, paragraphs.length - drop)).join("\n\n");
    const hour = 3_600_000;
    const now = Date.now();
    versionLog.set(key, [
      {
        blob: `mock-${++blobSeq}`,
        time: now - 2 * hour,
        device: "这台电脑",
        mine: true,
        title,
        body,
      },
      {
        blob: `mock-${++blobSeq}`,
        time: now - 29 * hour,
        device: "书房的电脑",
        mine: false,
        title,
        body: earlier(1),
      },
      {
        blob: `mock-${++blobSeq}`,
        time: now - 74 * hour,
        device: "这台电脑",
        mine: true,
        title,
        body: `${earlier(2)}\n\n（草稿，还没想好）`,
      },
    ]);
  }
  return versionLog.get(key) ?? [];
}

const emptyGoal = (horizon: GoalHorizon, periodStart: string): Goal => ({
  id: "",
  horizon,
  title: "",
  periodStart,
  contentMd: "",
  createdAt: 0,
  updatedAt: 0,
  relPath: goalRelPath(periodStart),
});

/** 去掉正文：和 Rust 的 note_list 一样，列表里不带 */
function summary(note: MockNote): NoteSummary {
  const { contentMd: _body, ...rest } = present(note);
  return rest;
}

/** 写过的某一天和目标，连同正文（journalList 去掉正文给出去，searchText 在正文里找） */
function journalEntries(): (JournalDoc & { contentMd: string })[] {
  const days = Object.entries(state.days)
    .filter(([, day]) => day.noteMd || day.title)
    .map(([date, day]) => ({
      target: { kind: "day", id: date } as DocumentSaveTarget,
      kind: "day" as const,
      title: day.title ? `${formatMonthDayCN(date)} · ${day.title}` : formatMonthDayCN(date),
      contentMd: day.noteMd,
      updatedAt: day.updatedAt,
    }));
  const goals = Object.values(state.goals)
    .filter((goal) => goal.contentMd)
    .map((goal) => ({
      target: {
        kind: "goal",
        horizon: goal.horizon,
        periodStart: goal.periodStart,
      } as DocumentSaveTarget,
      kind: "goal" as const,
      title: goalTitle(goal.horizon, goal.periodStart),
      contentMd: goal.contentMd,
      updatedAt: goal.updatedAt,
    }));
  return [...days, ...goals].sort((a, b) => b.updatedAt - a.updatedAt);
}

/* ---- 全局搜索（findInVault），同 Rust 的 domain::search::Finder / vault::find_text ---- */

const FIND_MATCH_LIMIT = 1000;

/** 空查询返回 null；正则写错了返回原因 */
function compileFinder(query: string, options: FindOptions): RegExp | string | null {
  if (!query) return null;
  const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(source, `gmu${options.caseSensitive ? "" : "i"}`);
  } catch (error) {
    return error instanceof Error ? error.message : "正则写错了";
  }
}

const WORD_CHAR = /[\p{Alphabetic}\p{Number}_]/u;

function charAfter(text: string, at: number): string | undefined {
  const code = text.codePointAt(at);
  return code === undefined ? undefined : String.fromCodePoint(code);
}

function charBefore(text: string, at: number): string | undefined {
  if (at <= 0) return undefined;
  const low = text.charCodeAt(at - 1);
  const pair = low >= 0xdc00 && low <= 0xdfff && at >= 2;
  return text.slice(pair ? at - 2 : at - 1, at);
}

/** CodeMirror 的全词判断：两头各自只要外面那个字和里面那个字不都是词字符 */
function wordBounded(line: string, from: number, to: number): boolean {
  const word = (c: string | undefined) => !!c && WORD_CHAR.test(c);
  return (
    (!word(charBefore(line, from)) || !word(charAfter(line, from))) &&
    (!word(charBefore(line, to)) || !word(charAfter(line, to)))
  );
}

/** 一行里的匹配（UTF-16 位置，不含空匹配） */
function findInLine(finder: RegExp, line: string, wholeWord: boolean): [number, number][] {
  const found: [number, number][] = [];
  let at = 0;
  while (at <= line.length) {
    finder.lastIndex = at;
    const hit = finder.exec(line);
    if (!hit) break;
    const from = hit.index;
    const to = from + hit[0].length;
    if (from === to || (wholeWord && !wordBounded(line, from, to))) {
      at = from + (charAfter(line, from)?.length ?? 1);
      continue;
    }
    found.push([from, to]);
    at = to;
  }
  return found;
}

function findMatch(line: string, index: number, from: number, to: number): FindMatch {
  const clip = (text: string, max: number) => {
    const chars = [...text];
    return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
  };
  const head = [...line.slice(0, from).trimStart()];
  return {
    line: index + 1,
    column: from,
    length: to - from,
    before: head.length > 32 ? `…${head.slice(-32).join("")}` : head.join(""),
    text: clip(line.slice(from, to), 200),
    after: clip(line.slice(to).trimEnd(), 160),
  };
}

/** 正文里第一次出现 needle（已经转成小写）的那一行，同 Rust 的 index::line_with */
function lineWith(content: string, needle: string): string | null {
  const lower = content.toLowerCase();
  const at = lower.indexOf(needle);
  if (at < 0) return null;
  const start = lower.lastIndexOf("\n", at - 1) + 1;
  const end = content.indexOf("\n", at);
  const line = content.slice(start, end < 0 ? content.length : end).replace(/\r$/, "");
  if (line.length <= 600) return line;
  const from = Math.max(0, at - start - 200);
  return line.slice(from, from + 600);
}

export const mockBackend: Backend = {
  async noteList(archived) {
    await tick();
    return listed(archived).map(summary);
  },

  async noteGet(id) {
    await tick();
    const n = state.notes.find((x) => x.id === id);
    if (!n) notFound(`note ${id}`);
    return present(n);
  },

  async noteUpsert(input: NoteInput) {
    await tick();
    const now = Date.now();
    const id = input.id ?? crypto.randomUUID();
    const current = state.notes.find((x) => x.id === id);
    const contentMd = input.contentMd;
    const excerpt = makeExcerpt(contentMd, 60);

    if (current) {
      if (current.title !== input.title) {
        // 和后端一样按标题起文件名：标题里的 `/` 不能变成一层文件夹（那篇会从列表里消失）
        const dir = current.relPath.slice(0, current.relPath.lastIndexOf("/"));
        current.relPath = `${dir}/${fileStemFor(input.title)}.md`;
      }
      current.title = input.title;
      current.contentMd = contentMd;
      current.excerpt = excerpt;
      current.wordCount = countWords(contentMd);
      current.updatedAt = now;
      recordVersion(`note:${id}`, contentMd, input.title);
    } else {
      state.notes.unshift({
        id,
        title: input.title,
        contentMd,
        excerpt,
        wordCount: countWords(contentMd),
        isPinned: false,
        isArchived: false,
        archiveCategory: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
        relPath: `笔记/${fileStemFor(input.title)}.md`,
        conflictOf: null,
      });
    }
    save(state);
    return id;
  },

  async noteSetPinned(id, pinned) {
    await tick();
    const n = state.notes.find((x) => x.id === id);
    if (!n) notFound(`note ${id}`);
    n.isPinned = pinned;
    n.updatedAt = Date.now();
    save(state);
  },

  async noteArchive(id, category) {
    await tick();
    const n = state.notes.find((x) => x.id === id);
    if (!n) notFound(`note ${id}`);
    n.isArchived = true;
    n.isPinned = false; // 归档清除置顶，和 Rust 侧一致
    n.archivedAt = Date.now();
    n.archiveCategory = category ?? n.archiveCategory ?? "笔记";
    n.updatedAt = n.archivedAt;
    save(state);
  },

  async noteRestore(id) {
    await tick();
    const n = state.notes.find((x) => x.id === id);
    if (!n) notFound(`note ${id}`);
    // relPath 归档时没动：恢复回原来的文件夹，文件夹没了就建上（和 Rust 侧一样）
    ensureFolder(folderOf(n));
    n.isArchived = false;
    n.archivedAt = null;
    n.updatedAt = Date.now();
    save(state);
  },

  async noteDelete(id) {
    await tick();
    const i = state.notes.findIndex((x) => x.id === id);
    if (i < 0) notFound(`note ${id}`);
    const [removed] = state.notes.splice(i, 1);
    state.trash = [...(state.trash ?? []), { ...removed!, updatedAt: Date.now() }];
    save(state);
  },

  async noteUndelete(id) {
    await tick();
    const trash = state.trash ?? [];
    const i = trash.findIndex((x) => x.id === id);
    if (i < 0) notFound(`deleted note ${id}`);
    const [restored] = trash.splice(i, 1);
    ensureFolder(folderOf(restored!));
    state.notes.push(restored!);
    save(state);
  },

  async noteCreate(folder, title) {
    await tick();
    if (!hasFolder(folder)) notFound(`文件夹「${folder}」不在了`);
    const now = Date.now();
    const id = crypto.randomUUID();
    state.notes.unshift({
      id,
      title,
      contentMd: "",
      excerpt: "",
      wordCount: 0,
      isPinned: false,
      isArchived: false,
      archiveCategory: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      relPath: relPathIn({ relPath: "", title }, folder),
      conflictOf: null,
    });
    save(state);
    return id;
  },

  async noteMove(id, folder) {
    await tick();
    const n = state.notes.find((x) => x.id === id);
    if (!n) notFound(`note ${id}`);
    if (n.isArchived) throw { kind: "Invalid", message: "归档里的笔记先恢复再移动" };
    if (!hasFolder(folder)) notFound(`文件夹「${folder}」不在了`);
    n.relPath = relPathIn(n, folder);
    save(state);
    return present(n);
  },

  async folderList() {
    await tick();
    return [...(state.folders ?? [])].sort();
  },

  async folderCreate(parent, name) {
    await tick();
    if (!hasFolder(parent)) notFound(`文件夹「${parent}」不在了`);
    const clean = cleanFolderName(name);
    if (!clean) throw { kind: "Invalid", message: "文件夹名不能是空的" };
    const path = uniqueFolder(parent, clean);
    ensureFolder(path);
    save(state);
    return path;
  },

  async folderRename(folder, name) {
    await tick();
    if (!folder || !hasFolder(folder)) notFound(`文件夹「${folder}」不在了`);
    const clean = cleanFolderName(name);
    if (!clean) throw { kind: "Invalid", message: "文件夹名不能是空的" };
    const next = uniqueFolder(parentOf(folder), clean, folder);
    if (next === folder) return folder;
    state.folders = (state.folders ?? []).map((path) => renamedPath(path, folder, next)).sort();
    for (const note of [...state.notes, ...(state.trash ?? [])]) {
      note.relPath = renamedRelPath(note.relPath, folder, next);
    }
    save(state);
    return next;
  },

  async folderDelete(folder): Promise<FolderDeletion> {
    await tick();
    if (!folder || !hasFolder(folder)) notFound(`文件夹「${folder}」不在了`);
    const gone = state.notes.filter((n) => !n.isArchived && within(folderOf(n), folder));
    state.notes = state.notes.filter((n) => !gone.includes(n));
    state.trash = [...(state.trash ?? []), ...gone];
    const folders = (state.folders ?? []).filter((path) => within(path, folder));
    state.folders = (state.folders ?? []).filter((path) => !within(path, folder));
    save(state);
    return { folder, notes: gone.map((n) => n.id), folders, kept: false };
  },

  async folderUndelete(deletion) {
    await tick();
    for (const path of deletion.folders) ensureFolder(path);
    const ids = new Set(deletion.notes);
    const back = (state.trash ?? []).filter((n) => ids.has(n.id));
    state.trash = (state.trash ?? []).filter((n) => !ids.has(n.id));
    state.notes.push(...back);
    save(state);
  },

  async folderReveal() {
    desktopOnly();
  },

  async noteBacklinks(id): Promise<Backlink[]> {
    await tick();
    const note = state.notes.find((x) => x.id === id);
    if (!note) notFound(`note ${id}`);
    const sources: Omit<Backlink, "lines" | "count">[] = [];
    const bodies: string[] = [];
    for (const other of state.notes) {
      if (other.id === id) continue;
      sources.push({
        target: { kind: "note", id: other.id },
        kind: "note",
        title: other.title,
        archived: other.isArchived,
        updatedAt: other.updatedAt,
      });
      bodies.push(other.contentMd);
    }
    for (const [date, day] of Object.entries(state.days)) {
      sources.push({
        target: { kind: "day", id: date },
        kind: "day",
        title: day.title ? `${formatMonthDayCN(date)} · ${day.title}` : formatMonthDayCN(date),
        archived: false,
        updatedAt: day.updatedAt,
      });
      bodies.push(day.noteMd);
    }
    for (const goal of Object.values(state.goals)) {
      sources.push({
        target: { kind: "goal", horizon: goal.horizon, periodStart: goal.periodStart },
        kind: "goal",
        title: goalTitle(goal.horizon, goal.periodStart),
        archived: false,
        updatedAt: goal.updatedAt,
      });
      bodies.push(goal.contentMd);
    }
    const out: Backlink[] = [];
    sources.forEach((source, index) => {
      const body = bodies[index]!;
      const hits = findWikiLinks(body).filter((hit) => sameTitle(hit.title, note.title));
      if (!hits.length) return;
      const rows = body.split("\n");
      const lines = [...new Set(hits.map((hit) => hit.line))]
        .slice(0, 3)
        .map((line) => ({ line, text: contextLine(rows[line] ?? "") }));
      out.push({ ...source, lines, count: hits.length });
    });
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  /** 规则和 Rust 侧 Vault::relink 一样 */
  async noteRelink(id, oldTitle): Promise<Relink> {
    await tick();
    const note = state.notes.find((x) => x.id === id);
    if (!note) notFound(`note ${id}`);
    const from = oldTitle.trim();
    const to = note.title.trim();
    const result: Relink = { links: 0, docs: [], skipped: null, rewrites: [] };
    if (!from || sameTitle(from, to)) return result;
    const sources = linkSources().filter(
      (source) =>
        !(source.kind === "note" && source.id === id) &&
        findWikiLinks(source.get()).some((hit) => sameTitle(hit.title, from)),
    );
    if (!sources.length) return result;

    const taken = (title: string) =>
      state.notes.some((other) => other.id !== id && sameTitle(other.title, title));
    result.skipped = !linkableTitle(to)
      ? `新标题里有 [ ] | # ^，写不进双链：别处的 [[${from}]] 没有改`
      : taken(from)
        ? `还有一篇也叫「${from}」，别处的 [[${from}]] 仍然指向它，没有改`
        : taken(to)
          ? `已经有一篇叫「${to}」了，别处的 [[${from}]] 没有改，免得分不清链到哪篇`
          : null;
    if (result.skipped) {
      result.links = sources.reduce(
        (sum, source) =>
          sum + findWikiLinks(source.get()).filter((hit) => sameTitle(hit.title, from)).length,
        0,
      );
      return result;
    }

    for (const source of sources) {
      const before = source.get();
      const rewritten = retargetWikiLinks(before, from, to);
      if (!rewritten) continue;
      source.set(rewritten.body);
      result.links += rewritten.count;
      result.docs.push(source.title);
      result.rewrites.push({ relPath: source.relPath, before, after: rewritten.body });
    }
    save(state);
    announceSources(sources);
    return result;
  },

  async noteRelinkUndo(rewrites: LinkRewrite[]) {
    await tick();
    const sources = linkSources();
    const touched: LinkSource[] = [];
    for (const rewrite of rewrites) {
      const source = sources.find((s) => s.relPath === rewrite.relPath);
      if (!source || source.get() !== rewrite.after) continue;
      source.set(rewrite.before);
      touched.push(source);
    }
    save(state);
    announceSources(touched);
    return touched.length;
  },

  async docHistory(target: DocumentSaveTarget): Promise<DocHistory> {
    await tick();
    let key: string;
    let body = "";
    let title = "";
    if (target.kind === "note") {
      const note = state.notes.find((x) => x.id === target.id);
      if (!note) notFound(`note ${target.id}`);
      key = `note:${note.id}`;
      body = note.contentMd;
      title = note.title;
    } else if (target.kind === "day") {
      key = `day:${target.id}`;
      body = state.days[target.id]?.noteMd ?? "";
    } else {
      const goal = goalKey(target.horizon, target.periodStart);
      key = `goal:${goal}`;
      body = state.goals[goal]?.contentMd ?? "";
    }
    const versions = historyOf(key, body, title).map(({ body: _body, ...version }) => version);
    return { unavailable: null, versions, more: false };
  },

  async docVersionText(blob) {
    await tick();
    for (const list of versionLog.values()) {
      const found = list.find((version) => version.blob === blob);
      if (found) return found.body;
    }
    notFound(`version ${blob}`);
  },

  async searchText(query, limit, archivedOnly) {
    await tick();
    const needle = query.trim().toLowerCase();
    if (!needle) return { notes: [], journal: [] };
    const notes: TextHit[] = [];
    for (const note of archivedOnly ? listed(true) : [...listed(false), ...listed(true)]) {
      if (notes.length >= limit) break;
      const line = lineWith(note.contentMd, needle);
      if (line !== null) {
        const target = { kind: "note", id: note.id } as const;
        notes.push({ target, title: note.title, updatedAt: note.updatedAt, line });
      }
    }
    const journal: TextHit[] = [];
    for (const entry of archivedOnly ? [] : journalEntries()) {
      if (journal.length >= limit) break;
      const line = lineWith(entry.contentMd, needle);
      if (line !== null)
        journal.push({
          target: entry.target,
          title: entry.title,
          updatedAt: entry.updatedAt,
          line,
        });
    }
    return { notes, journal };
  },

  async findInVault(query, options) {
    await tick();
    const finder = compileFinder(query, options);
    if (finder === null) return { files: [], total: 0, truncated: false, error: null };
    if (typeof finder === "string") return { files: [], total: 0, truncated: false, error: finder };
    const docs = [
      ...[...listed(false), ...listed(true)].map((note) => ({
        target: { kind: "note", id: note.id } as DocumentSaveTarget,
        title: note.title,
        updatedAt: note.updatedAt,
        contentMd: note.contentMd,
      })),
      ...journalEntries(),
    ];
    const files: FindFile[] = [];
    let total = 0;
    let budget = FIND_MATCH_LIMIT;
    for (const doc of docs) {
      const matches: FindMatch[] = [];
      let count = 0;
      doc.contentMd.split("\n").forEach((raw, index) => {
        const line = raw.replace(/\r$/, "");
        for (const [from, to] of findInLine(finder, line, options.wholeWord)) {
          count += 1;
          if (matches.length < budget) matches.push(findMatch(line, index, from, to));
        }
      });
      total += count;
      if (count && budget > 0) {
        budget -= matches.length;
        files.push({
          target: doc.target,
          title: doc.title,
          updatedAt: doc.updatedAt,
          matches,
          count,
        });
      }
    }
    return { files, total, truncated: total > FIND_MATCH_LIMIT, error: null };
  },

  async taskToggle(id) {
    await tick();
    const t = state.tasks[id];
    if (!t) notFound(`task ${id}`);
    const done = t.status === "done";
    t.status = done ? "todo" : "done";
    save(state);
    return { ...t };
  },

  /** 某个周期的目标；没写过就是一篇空文档，和 Rust 侧一样不落库 */
  async goalGet(horizon, periodStart): Promise<Goal> {
    await tick();
    if (periodStartOf(horizon, periodStart) !== periodStart) {
      throw { kind: "Invalid", message: `${periodStart} 不是 ${horizon} 周期的起点` };
    }
    const g = state.goals[goalKey(horizon, periodStart)];
    return g ? { ...g, relPath: goalRelPath(periodStart) } : emptyGoal(horizon, periodStart);
  },

  async goalSave(horizon, periodStart, contentMd): Promise<Goal> {
    await tick();
    const key = goalKey(horizon, periodStart);
    const now = Date.now();
    const current = state.goals[key];
    state.goals[key] = current
      ? { ...current, contentMd, updatedAt: now }
      : {
          ...emptyGoal(horizon, periodStart),
          id: crypto.randomUUID(),
          contentMd,
          createdAt: now,
          updatedAt: now,
        };
    recordVersion(`goal:${key}`, contentMd);
    save(state);
    return this.goalGet(horizon, periodStart);
  },

  /** carryOver：这一天没写过时延续之前最近写过的一天，不落库（和 Rust 侧一致） */
  async calendarDay(date, carryOver): Promise<DayDoc> {
    await tick();
    const tasks = Object.values(state.tasks).filter((t) => t.dueDate === date);
    const own = state.days[date];
    const relPath = dayRelPath(date);
    if (own) return { date, tasks, ...own, carriedFrom: null, relPath };

    const previous = carryOver
      ? Object.keys(state.days)
          .filter((d) => d < date && (state.days[d]!.noteMd || state.days[d]!.title))
          .sort()
          .pop()
      : undefined;
    if (previous) {
      return { date, tasks, ...state.days[previous]!, carriedFrom: previous, relPath };
    }

    return {
      date,
      title: "",
      tasks,
      noteMd: "",
      updatedAt: Date.now(),
      carriedFrom: null,
      relPath,
    };
  },

  async calendarDaySave(date, title, noteMd): Promise<DayDoc> {
    await tick();
    state.days[date] = { title, noteMd, updatedAt: Date.now() };
    recordVersion(`day:${date}`, noteMd);
    save(state);
    return this.calendarDay(date, false);
  },

  async calendarMarks(from, to) {
    await tick();
    const inRange = (date: string) => date >= from && date <= to;
    const written = new Set<string>();
    const open = new Set<string>();
    for (const t of Object.values(state.tasks)) {
      if (!t.dueDate || !inRange(t.dueDate)) continue;
      (t.status === "done" ? written : open).add(t.dueDate);
    }
    for (const [d, v] of Object.entries(state.days))
      if ((v.noteMd || v.title) && inRange(d)) written.add(d);
    return { written, open };
  },

  async journalList(): Promise<JournalDoc[]> {
    await tick();
    return journalEntries().map(({ contentMd: _body, ...entry }) => entry);
  },

  async guidePending(): Promise<GuideUpdate[]> {
    await tick();
    return state.notes.flatMap((note) => {
      const guide = guideOf(note.id);
      if (!guide || !note.guide || !guideOutdated(note, guide)) return [];
      if (guideFingerprint(note.contentMd) === note.guide.hash) return [];
      return [{ id: note.id, name: guide.name, body: guide.body }];
    });
  },

  async guideSettle(id) {
    await tick();
    const note = state.notes.find((x) => x.id === id);
    const guide = guideOf(id);
    if (!note || !guide) notFound(`guide ${id}`);
    note.guide = { name: guide.name, version: APP_VERSION, hash: guideFingerprint(guide.body) };
    save(state);
  },

  async guideOpen(name) {
    await tick();
    const prefix = guideIdPrefix(name);
    const found =
      state.notes.find((note) => note.id.startsWith(prefix) && !note.isArchived) ??
      state.notes.find((note) => note.id.startsWith(prefix));
    if (found) return found.id;
    const guide = GUIDES.find((item) => item.name === name);
    if (!guide) throw { kind: "Invalid", message: `没有叫 ${name} 的使用指南` };
    const note = newGuideNote(guide, Date.now());
    state.notes.unshift(note);
    save(state);
    return note.id;
  },

  async vaultInfo(): Promise<VaultInfo> {
    await tick();
    return {
      root: "浏览器预览（localStorage）",
      notes: state.notes.filter((n) => !n.isArchived).length,
      archived: state.notes.filter((n) => n.isArchived).length,
      days: Object.keys(state.days).length,
      goals: Object.keys(state.goals).length,
      tasks: Object.values(state.tasks).filter((t) => t.dueDate).length,
    };
  },

  async vaultReveal() {
    await tick();
    desktopOnly();
  },

  async vaultOpenFolder() {
    await tick();
    desktopOnly();
  },

  async vaultKeepConflictCopy() {
    await tick();
    return null;
  },

  async vaultChangeRoot() {
    await tick();
    desktopOnly();
  },

  async vaultFirstRun() {
    const root = readMock(MOCK_FIRST_RUN_KEY);
    if (root === null) return null;
    // 只给一次，和桌面版一样
    try {
      localStorage.removeItem(MOCK_FIRST_RUN_KEY);
    } catch {}
    return root || "C:\\Users\\你\\Documents\\Odea";
  },

  // 浏览器里没有仓库文件夹：粘贴的图片直接写成 data: 地址插进正文
  async vaultAttach(_target, name, dataBase64) {
    await tick();
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const mime: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
    };
    const type = mime[ext];
    return {
      link: `data:${type ?? "application/octet-stream"};base64,${dataBase64}`,
      name,
      isImage: !!type,
    };
  },

  async vaultAttachPath() {
    await tick();
    desktopOnly();
  },

  // 浏览器里没有别的程序会改这些数据；只有改写别处双链时会通知（announce）
  async onVaultChanged(listener) {
    vaultListeners.add(listener);
    return () => {
      vaultListeners.delete(listener);
    };
  },

  // 浏览器里没有文件要读进索引
  async indexProgress() {
    return null;
  },
  async onIndexProgress() {
    return () => {};
  },

  // 浏览器里没有仓库文件夹，也就没有同步
  async syncStatus() {
    return SYNC_OFF;
  },
  async syncNow() {
    return false;
  },
  async onSyncStatus() {
    return () => {};
  },
  async onSyncNotice() {
    return () => {};
  },
  async syncAccounts() {
    return [];
  },
  async syncGithubLoginStart() {
    syncDesktopOnly();
  },
  async syncGithubLoginWait() {
    syncDesktopOnly();
  },
  async syncLoginCancel() {},
  async syncGiteeLogin() {
    syncDesktopOnly();
  },
  async syncLogout() {},
  async syncRepos() {
    syncDesktopOnly();
  },
  async syncCreateRepo() {
    syncDesktopOnly();
  },
  async syncProxy() {
    return { configured: null, effective: null };
  },
  async syncSetProxy(proxy) {
    return { configured: proxy, effective: proxy };
  },
  async syncInspect() {
    syncDesktopOnly();
  },
  async syncEnable() {
    syncDesktopOnly();
  },
  async syncDisable() {
    return SYNC_OFF;
  },

  // 浏览器里没有安装包，也就没有更新。调界面时用 localStorage 假装一下（见 mockUpdate）
  async updateStatus() {
    return mockUpdate();
  },
  async updateCheck() {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return mockUpdate();
  },
  async updateInstall() {
    await tick();
    throw { kind: "Invalid", message: "浏览器预览里没有安装包，桌面版里才能更新" };
  },
  async onUpdateReady() {
    return () => {};
  },
  async appUpgrade() {
    const from = readMock(MOCK_UPGRADE_KEY);
    if (from === null) return null;
    // 只给一次，和桌面版一样
    try {
      localStorage.removeItem(MOCK_UPGRADE_KEY);
    } catch {}
    return { from: from || null, to: APP_VERSION } satisfies AppUpgrade;
  },
};

/* ---------------- 新版本 ----------------
   调界面用：
     localStorage["odea.mock.update"] = "0.2.0"       有一个下好了的新版本（写 "0.2.0 manual" 是只能手动装的）
     localStorage["odea.mock.upgradeFrom"] = "0.0.9"  这一次是从 0.0.9 升上来的（空串 = 不知道从哪一版），取一次就清掉
     localStorage["odea.mock.firstRun"] = ""           新装第一次打开，提示笔记放在哪（写路径就显示那个路径），取一次就清掉 */

const MOCK_UPDATE_KEY = "odea.mock.update";
const MOCK_UPGRADE_KEY = "odea.mock.upgradeFrom";
const MOCK_FIRST_RUN_KEY = "odea.mock.firstRun";

function readMock(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function mockUpdate(): UpdateInfo | null {
  const [version, manual] = (readMock(MOCK_UPDATE_KEY) ?? "").trim().split(/\s+/);
  if (!version) return null;
  return {
    version,
    current: APP_VERSION,
    notes: [
      "- 笔记可以拖进文件夹，停在收起的文件夹上会自动展开",
      "- 命令面板也搜日记和目标的正文",
      "- 修了暗色模式下没勾的任务圈看不见的问题",
    ].join("\n"),
    date: "2026-10-20",
    manual: manual ? "https://github.com/Gred666/Odea/releases/latest" : null,
  };
}
