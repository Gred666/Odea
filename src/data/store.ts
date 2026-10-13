import { type ISODate, today } from "@/lib/date";
import { isTauri } from "@/lib/tauri";
import { create } from "zustand";
import { version as APP_VERSION } from "../../package.json";
import { backend } from "./backend";
import { conflictOriginalContent, conflictOriginalTitle, conflictTarget } from "./conflicts";
import {
  cleanFolderName,
  folderLabel,
  folderOf,
  nameOf,
  parentOf,
  relPathIn,
  renamedPath,
  renamedRelPath,
  uniqueChild,
  within,
} from "./folders";
import {
  type AppUpgrade,
  type CalendarMarks,
  type DayDoc,
  type DocumentSaveTarget,
  type FolderDeletion,
  type Goal,
  type GoalHorizon,
  type GuideName,
  type GuideUpdate,
  type JournalDoc,
  type Note,
  SYNC_OFF,
  type SearchResult,
  type SyncStatus,
  type Task,
  type UpdateInfo,
  type VaultChange,
  goalKey,
} from "./types";

interface DataState {
  notes: Note[];
  archived: Note[];
  tasks: Record<string, Task>;
  /** 按 `horizon:periodStart` 缓存的目标（见 goalKey）。没写过的周期也会缓存一篇空文档。 */
  goals: Record<string, Goal>;
  /**
   * 按日期缓存的某天文档。「今日TODO」就是今天这一篇 ——
   * 今天还没写过时后端会把之前最近一天延续过来（carriedFrom），用户一编辑才落库。
   */
  dayDocs: DayDoc[];
  /** 日历月网格上的记号：写过记录 / 做过事的日子，还有待办的日子 */
  marks: CalendarMarks;
  /** 重新取一次日历记号（勾了任务、别处改了带日期的任务） */
  refreshMarks: () => Promise<void>;
  /**
   * 所有写过的某一天、某个周期的目标（连同正文）。命令面板打开时取一次，
   * 搜索时和笔记一起搜；取回来之前是空的。
   */
  journal: JournalDoc[];
  loadJournal: () => Promise<void>;
  /**
   * 仓库文件夹的绝对路径（浏览器预览里是 null）。正文里的相对图片路径（附件）
   * 按「仓库 + 文档所在的文件夹」解析，见 editor/html.ts 的 resolveImageSource。
   */
  vaultRoot: string | null;
  initialized: boolean;
  loading: boolean;
  /** 保存以外的操作（加载、置顶、归档、勾选…）失败的原因，由 ErrorToast 显示。 */
  error: string | null;
  clearError: () => void;
  /** 不是失败、但得让人知道的事（外部改动撞上没存的修改，另存了一份冲突副本）。 */
  notice: string | null;
  clearNotice: () => void;
  /**
   * 每篇文档被外部改动刷新过几次，键同 saveKeyOf。编辑器据此分辨「store 里的正文变了」
   * 是自己的保存回来了，还是别的程序改了文件（见 MarkdownEditor 的 externalRevision）。
   */
  externalRevisions: Record<string, number>;
  /**
   * 外部改动到的时候编辑器里正有没存的修改：这几篇下一次保存前，先让后端把磁盘上
   * 那一版另存成冲突副本 —— 编辑器里的照常存，两边都不丢。键同 saveKeyOf。
   */
  conflicts: Set<string>;
  markConflict: (target: DocumentSaveTarget) => void;
  /** 仓库里别处发生的变化（文件监听、勾任务改了别的文档）：刷新受影响的缓存 */
  applyVaultChange: (change: VaultChange) => Promise<void>;
  /** 多设备同步的状态（技术方案 §5.9）；没开同步时 state 是 off */
  syncStatus: SyncStatus;
  /** 下好了、等着装的新版本（src-tauri/src/update.rs）；没有是 null */
  update: UpdateInfo | null;
  /** 这一次启动是升级上来的（启动时取一次）：给用户看这之间的更新说明，看过就清掉 */
  upgrade: AppUpgrade | null;
  clearUpgrade: () => void;
  /** 命令面板「检查更新」：现在就查。查到了返回新版本；最新的、查不了的在提示条里说 */
  checkUpdate: () => Promise<UpdateInfo | null>;
  /**
   * 重启并更新：先把编辑器里的、没存上的草稿都存掉，存不上就不装。
   * 装上了就不会返回（进程结束 / 重启）；装不上返回原因
   */
  installUpdate: () => Promise<string>;
  /** 在系统的文件管理器里定位这篇文档的文件 */
  revealDocument: (target: DocumentSaveTarget) => Promise<void>;
  openVaultFolder: () => Promise<void>;
  /** 换一个文件夹当仓库。先把编辑器里的都存掉；换成功就整页重载 */
  changeVaultRoot: () => Promise<void>;
  /** 正在保存的文档，键为 `kind:id`。界面据此显示「保存中」。 */
  savingDocs: Set<string>;
  /**
   * 最近一次保存失败：哪篇文档（saveKeyOf 的键）、为什么。只在那篇文档的状态栏里
   * 显示 —— 以前是一个全局字符串，A 篇存失败了，切到 B 篇也挂着「保存失败」。
   * key 为 null 的是不属于某一篇的（关窗时的保存），每篇都显示。
   */
  saveError: { key: string | null; message: string } | null;
  clearSaveError: () => void;
  /**
   * 保存失败、还没落盘的正文，键同 saveKeyOf。编辑器一卸载（切到别的文档），它自己
   * 的保存队列就跟着没了 —— 失败的那一版以前就这样丢了，再打开还是旧内容。现在留在
   * 这里：再打开这篇显示的是它（adapter），下一次保存成功就清掉，关窗时也会再试一次。
   */
  drafts: Record<string, { target: DocumentSaveTarget; contentMd: string }>;
  /** 把所有草稿再存一遍。关窗时在编辑器 flush 之后调用。 */
  flushDrafts: () => Promise<void>;

  initialize: () => Promise<void>;
  /**
   * 取某一天的文档。`asToday` 为 true 时（这一天就是今天）允许延续之前最近的一天。
   * 已缓存的日期不重复取；今天的缓存如果还是延续来的、且又过了一天，会由 loadDay
   * 的调用方通过 todayDate 变化自然刷新。
   */
  loadDay: (date: ISODate, asToday?: boolean) => Promise<void>;
  /** 取某个周期的目标（没写过就是空文档）。已缓存的不重复取。 */
  loadGoal: (horizon: GoalHorizon, periodStart: ISODate) => Promise<void>;
  /**
   * 丢掉缓存里所有「延续来的」某天文档。跨过零点时调：昨天那份延续来的内容
   * 从来不是昨天自己的记录，留着的话翻回昨天会把它当成昨天写的。
   *
   * 新的今天如果缓存着一篇空白文档也一并丢掉：它是还没成为「今天」时取的
   * （比如前一晚在日历里点开过明天），当时没有尝试延续；留着的话 loadDay
   * 命中缓存，今日TODO 就一直是空白，不会延续前一天。
   */
  forgetCarriedDays: (today: ISODate) => void;
  searchNotes: (query: string) => Promise<SearchResult>;
  saveDocument: (target: DocumentSaveTarget, contentMd: string) => Promise<void>;
  /** 新建一篇空笔记（放在 folder 里，默认「笔记」本身），返回后端分配的 id；失败返回 null。 */
  createNote: (folder?: string) => Promise<string | null>;
  /**
   * 点了链到还没有的笔记的 `[[标题]]`：新建一篇这个标题的（放在 folder 里），返回它的 id。
   * 底部提示条可以撤销（直接删掉，不再弹「已删除」）
   */
  createLinkedNote: (title: string, folder: string) => Promise<string | null>;

  /* ---- 文件夹：仓库里「笔记」下面的子目录，路径相对「笔记」（见 data/folders.ts） ---- */
  folders: string[];
  refreshFolders: () => Promise<void>;
  /** 新建文件夹，返回它的路径（重名时后端加了序号）；失败返回 null */
  createFolder: (parent: string, name: string) => Promise<string | null>;
  /** 改名，返回新路径；失败返回 null。底下笔记的路径跟着换 */
  renameFolder: (folder: string, name: string) => Promise<string | null>;
  /** 删除文件夹：里面的笔记进回收站，底部提示条可以撤销 */
  deleteFolder: (folder: string) => Promise<void>;
  /** 在系统的文件管理器里打开这个文件夹 */
  revealFolder: (folder: string) => Promise<void>;
  /** 把笔记挪到另一个文件夹，底部提示条可以撤销 */
  moveNote: (id: string, folder: string) => Promise<void>;
  /**
   * 能撤销的上一个操作（移动笔记、删除文件夹、归档、恢复），和 lastDeleted 共用底部那条提示：
   * 谁后发生显示谁，另一个随之作废。
   */
  undoable: {
    key: string;
    kind: "move" | "delete" | "archive" | "restore" | "create" | "relink" | "history";
    message: string;
    undo: () => Promise<void>;
    /** 撤销完要打开的笔记（归档 / 恢复撤销后回到那一篇） */
    reopen?: string;
  } | null;
  dismissUndoable: () => void;
  /**
   * 改标题：笔记和某一天都行；GOAL 的标题由周期决定，改不了。
   * 笔记改了标题，别处的 `[[旧标题]]` 随后跟着改成新标题（relinkTitle）
   */
  saveTitle: (target: DocumentSaveTarget, title: string) => Promise<void>;
  /**
   * 笔记改了标题之后：别处链到旧标题的 `[[…]]` 改成新标题，底部提示条可以撤销。
   * 改不了（新标题写不进双链、和别的笔记重名）时提示一句为什么
   */
  relinkTitle: (id: string, oldTitle: string, newTitle: string) => Promise<void>;
  /**
   * 把一篇文档的正文换成历史里的某一版（when 是那一版的时间，提示条里说）。
   * 底部提示条可以撤销：换回恢复之前的正文
   */
  restoreVersion: (target: DocumentSaveTarget, body: string, when: string) => Promise<void>;
  toggleTask: (id: string) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
  /** 归档。底部提示条可以撤销；撤销本身（undoable: false）不再给提示条 */
  archiveNote: (id: string, options?: { undoable?: boolean }) => Promise<void>;
  /** 从归档恢复到笔记。同上 */
  restoreNote: (id: string, options?: { undoable?: boolean }) => Promise<void>;
  /** 删除笔记（归档里的也行），进回收站，底部提示条可以撤销 */
  deleteNote: (id: string) => Promise<void>;
  /**
   * 刚删掉、还能撤销的那篇笔记，它原来在哪个列表的第几行。撤销提示条据此显示；
   * 只保留最近一篇，提示条消失（dismissUndo）后就不能撤销了。
   */
  lastDeleted: { note: Note; index: number; archived: boolean } | null;
  /** 撤销最近一次删除。成功返回恢复的笔记 id，失败或没有可撤销的返回 null。 */
  undoDelete: () => Promise<string | null>;
  dismissUndo: () => void;
  /**
   * 处理一篇冲突副本：`copy` = 用副本这一版替换原文，然后删掉副本；`original` = 留原文、
   * 删掉副本。删掉的副本进回收站，撤销提示条照常能撤销。返回原文（笔记、某一天或目标），
   * 横幅接着打开它。
   */
  resolveConflict: (
    copyId: string,
    keep: "copy" | "original",
  ) => Promise<DocumentSaveTarget | null>;

  /* ---- 使用指南（src-tauri/src/vault/guide.rs）：没改过的升级时自动换新，改过的在那一篇上问 ---- */
  /** 用户改过、而这个版本带着新版的指南。启动时取一次 */
  guideUpdates: GuideUpdate[];
  /** 把那一篇换成新版（底部提示条可以撤销）；记下之后，以后的升级又能自动换上来 */
  adoptGuideUpdate: (id: string) => Promise<void>;
  /** 留着自己改过的那一版，到下一次升级前不再问 */
  keepGuide: (id: string) => Promise<void>;
  /** 命令面板「使用指南」：返回那一篇的 id（删掉了会照这个版本重新放一篇）；失败返回 null */
  openGuide: (name: GuideName) => Promise<string | null>;
}

/**
 * 取一条能给用户看的错误信息。
 * Rust 侧的错误是 `{ kind, message }`，直接 JSON.stringify 会在状态栏里
 * 甩出一坨大括号，得把 message 拆出来。
 */
export const messageOf = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const { message } = error as { message: unknown };
    if (typeof message === "string" && message) return message;
  }
  return JSON.stringify(error);
};

/** 新笔记 / 还没起标题的某一天的占位标题。空标题存不进去 —— saveTitle 会拒绝空串。 */
export const NEW_NOTE_TITLE = "无标题笔记";

const noteOrder = (a: Note, b: Note) =>
  a.isPinned === b.isPinned ? b.updatedAt - a.updatedAt : a.isPinned ? -1 : 1;

/** 日历记号取多大的范围：两个 Set 而已，一次取完比按月分页省事 */
const MARKS_FROM = "2000-01-01";
const MARKS_TO = "2100-12-31";

const isDone = (task: Task) => task.status === "done";

/** 提示条里的标题：还没起名的显示占位 */
const titleOf = (note: Note) => note.title.trim() || NEW_NOTE_TITLE;

/** 某一天写没写过记录变了：只动 written，待办那一种等 refreshMarks */
function withWritten(marks: CalendarMarks, date: string, written: boolean): CalendarMarks {
  if (marks.written.has(date) === written) return marks;
  const next = new Set(marks.written);
  if (written) next.add(date);
  else next.delete(date);
  return { ...marks, written: next };
}

const withGoal = (goals: Record<string, Goal>, goal: Goal): Record<string, Goal> => ({
  ...goals,
  [goalKey(goal.horizon, goal.periodStart)]: goal,
});

/** 放回原来的位置，而不是按排序规则重排 —— 撤销后它应该出现在删掉之前那一行。 */
const insertAt = (notes: Note[], index: number, note: Note): Note[] => [
  ...notes.slice(0, index),
  note,
  ...notes.slice(index),
];

const withDay = (days: DayDoc[], day: DayDoc): DayDoc[] => [
  ...days.filter((item) => item.date !== day.date),
  day,
];

/** 任务只出现在某一天的「当日安排」里 */
function patchTask(state: DataState, id: string, task: Task): Partial<DataState> {
  return {
    tasks: { ...state.tasks, [id]: task },
    dayDocs: state.dayDocs.map((day) => ({
      ...day,
      tasks: day.tasks.map((item) => (item.id === id ? task : item)),
    })),
  };
}

let initializePromise: Promise<void> | null = null;
/** 仓库变化的订阅只装一次（initialize 失败重试时不重复装） */
let vaultSubscription: Promise<() => void> | null = null;
let syncSubscriptions: Promise<(() => void)[]> | null = null;
let updateSubscription: Promise<() => void> | null = null;

const isNotFound = (error: unknown) =>
  !!error && typeof error === "object" && (error as { kind?: unknown }).kind === "NotFound";

const bumped = (revisions: Record<string, number>, key: string) => ({
  ...revisions,
  [key]: (revisions[key] ?? 0) + 1,
});

/**
 * 同一篇文档的写入排队。标题和正文是两条路保存的，但写的都是整篇
 * （笔记 upsert 带 title + contentMd，某一天带 title + noteMd），各自带着另一半的
 * 旧值：两次写同时在路上时，后落库的会把先落库那次改的另一半覆盖回去。
 * 排队之后，每次写都在上一次把 store 更新完之后才去读 source，带的就是最新的另一半。
 */
const writeQueues = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, write: () => Promise<T>): Promise<T> {
  const next = (writeQueues.get(key) ?? Promise.resolve()).then(write);
  const tail = next.catch(() => undefined);
  writeQueues.set(key, tail);
  void tail.then(() => {
    if (writeQueues.get(key) === tail) writeQueues.delete(key);
  });
  return next;
}
/** 正在进行的删除。撤销要排在它后面：删除还没落库就恢复，恢复会扑空，随后删除又生效。 */
let pendingDelete: Promise<unknown> = Promise.resolve();

export const useData = create<DataState>((set, get) => ({
  notes: [],
  archived: [],
  tasks: {},
  goals: {},
  dayDocs: [],
  marks: { written: new Set(), open: new Set() },
  refreshMarks: async () => {
    try {
      const marks = await (await backend()).calendarMarks(MARKS_FROM, MARKS_TO);
      set({ marks });
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },
  journal: [],
  loadJournal: async () => {
    try {
      const journal = await (await backend()).journalList();
      set({ journal });
    } catch {
      // 取不到就只搜笔记：命令面板里的附加结果，不该为它弹错误提示
    }
  },
  vaultRoot: null,
  initialized: false,
  loading: false,
  error: null,
  clearError: () => set({ error: null }),
  notice: null,
  clearNotice: () => set({ notice: null }),
  externalRevisions: {},
  syncStatus: SYNC_OFF,
  update: null,
  upgrade: null,
  clearUpgrade: () => set({ upgrade: null }),
  checkUpdate: async () => {
    try {
      const update = await (await backend()).updateCheck();
      if (update) set({ update });
      else set({ notice: `已经是最新版（${APP_VERSION}）` });
      return update;
    } catch (error) {
      set({ notice: `没能检查更新：${messageOf(error)}` });
      return null;
    }
  },
  installUpdate: async () => {
    try {
      // 和关窗口一样（editor/saveBus 的 installCloseGuard）：看到哪、编辑器里的、
      // 存失败留下的草稿都先落盘。动态引入：saveBus 自己引用了这个 store，静态引入会成环
      const { flushAllEditors } = await import("@/editor/saveBus");
      const { flushViewMemory } = await import("@/lib/viewMemory");
      flushViewMemory();
      await flushAllEditors();
      await get().flushDrafts();
    } catch (error) {
      return `有内容没存上，先不更新：${messageOf(error)}`;
    }
    try {
      await (await backend()).updateInstall();
      return "";
    } catch (error) {
      return messageOf(error);
    }
  },
  conflicts: new Set(),
  markConflict: (target) =>
    set((state) => ({ conflicts: new Set(state.conflicts).add(saveKeyOf(target)) })),

  applyVaultChange: async (change) => {
    const api = await backend();
    if (change.conflicts.length > 0) {
      set({
        notice: `别处改动了正在编辑的文档，那一版另存为「${change.conflicts.join("」「")}」`,
      });
    } else if (change.foundCopies?.length) {
      set({
        notice: `同步时两边都改过，留下了冲突副本「${change.foundCopies.join("」「")}」—— 打开它，选一版留下`,
      });
    }

    for (const id of change.notes) {
      try {
        const fresh = await api.noteGet(id);
        set((state) => {
          const previous =
            state.notes.find((note) => note.id === id) ??
            state.archived.find((note) => note.id === id);
          const place = (list: Note[], belongs: boolean) => {
            if (!belongs) return list.filter((note) => note.id !== id);
            return list.some((note) => note.id === id)
              ? list.map((note) => (note.id === id ? fresh : note))
              : [fresh, ...list];
          };
          return {
            notes: place(state.notes, !fresh.isArchived).sort(noteOrder),
            archived: place(state.archived, fresh.isArchived),
            externalRevisions:
              previous && previous.contentMd !== fresh.contentMd
                ? bumped(state.externalRevisions, `note:${id}`)
                : state.externalRevisions,
          };
        });
      } catch (error) {
        if (!isNotFound(error)) {
          set({ error: messageOf(error) });
          continue;
        }
        // 文件被删了 / 挪出了仓库
        set((state) => ({
          notes: state.notes.filter((note) => note.id !== id),
          archived: state.archived.filter((note) => note.id !== id),
        }));
      }
    }

    const todayDate = today();
    // 只刷新缓存里有的：没打开过的那一天 / 周期，下次切过去时自然会取
    const days = new Set(change.days.filter((date) => get().dayDocs.some((d) => d.date === date)));
    if (change.tasks) for (const day of get().dayDocs) days.add(day.date);
    for (const date of days) {
      try {
        const fresh = await api.calendarDay(date, date === todayDate);
        const contentChanged = change.days.includes(date);
        set((state) => {
          const previous = state.dayDocs.find((day) => day.date === date);
          if (!previous) return {};
          // 只是任务变了：正文不动（编辑器那边可能正有没存的修改）
          const next = contentChanged ? fresh : { ...previous, tasks: fresh.tasks };
          return {
            dayDocs: withDay(state.dayDocs, next),
            tasks: {
              ...state.tasks,
              ...Object.fromEntries(fresh.tasks.map((task) => [task.id, task])),
            },
            externalRevisions:
              contentChanged && previous.noteMd !== fresh.noteMd
                ? bumped(state.externalRevisions, `day:${date}`)
                : state.externalRevisions,
          };
        });
      } catch (error) {
        set({ error: messageOf(error) });
      }
    }

    for (const key of change.goals) {
      if (!get().goals[key]) continue;
      const [horizon, periodStart] = key.split(":") as [GoalHorizon, ISODate];
      try {
        const fresh = await api.goalGet(horizon, periodStart);
        set((state) => ({
          goals: withGoal(state.goals, fresh),
          externalRevisions:
            state.goals[key]?.contentMd !== fresh.contentMd
              ? bumped(state.externalRevisions, `goal:${key}`)
              : state.externalRevisions,
        }));
      } catch (error) {
        set({ error: messageOf(error) });
      }
    }

    if (change.tasks) await get().refreshMarks();

    if (change.folders) await get().refreshFolders();
  },

  revealDocument: async (target) => {
    try {
      await (await backend()).vaultReveal(target);
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  openVaultFolder: async () => {
    try {
      await (await backend()).vaultOpenFolder();
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  changeVaultRoot: async () => {
    try {
      // 先把编辑器里没存的都落进现在的仓库，换过去之后就回不来了。
      // 动态引入：saveBus 自己引用了这个 store，静态引入会成环
      const { flushAllEditors } = await import("@/editor/saveBus");
      await flushAllEditors();
      await get().flushDrafts();
      const info = await (await backend()).vaultChangeRoot();
      if (info) window.location.reload();
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  savingDocs: new Set(),
  saveError: null,
  clearSaveError: () => set({ saveError: null }),
  drafts: {},
  flushDrafts: async () => {
    const pending = Object.values(get().drafts);
    await Promise.all(
      pending.map(({ target, contentMd }) => get().saveDocument(target, contentMd)),
    );
  },

  initialize: async () => {
    if (get().initialized) return;
    if (initializePromise) return initializePromise;

    set({ loading: true, error: null });
    initializePromise = (async () => {
      try {
        const api = await backend();
        // 两个列表各一次往返拿回全文。以前是先取摘要列表、再逐篇 noteGet，
        // N 篇笔记就是 N 次 IPC，笔记一多启动就慢。
        const [notes, archived, folders, marks, info] = await Promise.all([
          api.noteListFull(false),
          api.noteListFull(true),
          // 文件夹列表取不到也不耽误启动：笔记都在，只是先全摊在「全部笔记」里
          Promise.resolve()
            .then(() => api.folderList())
            .catch(() => [] as string[]),
          api.calendarMarks(MARKS_FROM, MARKS_TO),
          // 只要路径（附件的相对路径按它解析）；取不到不耽误启动
          Promise.resolve()
            .then(() => api.vaultInfo())
            .catch(() => null),
        ]);

        // 别的程序改了仓库里的文件、或者一次操作连带改了别的文档：刷新受影响的缓存
        vaultSubscription ??= api.onVaultChanged((change) => {
          void get().applyVaultChange(change);
        });
        // 同步：状态跟着事件走；要告诉用户的话（冲突副本、超限文件没同步）走提示条
        syncSubscriptions ??= Promise.all([
          api.onSyncStatus((syncStatus) => set({ syncStatus })),
          api.onSyncNotice((notice) => set({ notice })),
        ]);
        // 新版本在后台下好了：导航栏里出现那一行（components/UpdateDialog.tsx）
        // 订阅、取状态都不该耽误启动：更新和更新说明都不是非看不可的
        updateSubscription ??= Promise.resolve()
          .then(() => api.onUpdateReady((update) => set({ update })))
          .catch(() => () => {});
        void Promise.resolve()
          .then(() => Promise.all([api.updateStatus(), api.appUpgrade()]))
          .then(([update, upgrade]) => set({ update, upgrade }))
          .catch(() => {});
        void Promise.resolve()
          .then(() => api.guidePending())
          .then((guideUpdates) => set({ guideUpdates }))
          .catch(() => {
            // 取不到就不问：指南还是用户自己那一版，什么也没丢
          });
        void Promise.resolve()
          .then(() => api.syncStatus())
          .then((syncStatus) => set({ syncStatus: syncStatus ?? SYNC_OFF }))
          .catch(() => {
            // 取不到就当没开同步
          });

        // 目标和某天的文档都按需取：切到哪个周期 / 哪一天再 loadGoal / loadDay
        set({
          notes: notes.sort(noteOrder),
          archived,
          folders,
          marks,
          vaultRoot: isTauri && info ? info.root : null,
          initialized: true,
          loading: false,
        });
      } catch (error) {
        set({ error: messageOf(error), loading: false });
      } finally {
        initializePromise = null;
      }
    })();
    return initializePromise;
  },

  loadDay: async (date, asToday = false) => {
    if (get().dayDocs.some((day) => day.date === date)) return;
    try {
      const day = await (await backend()).calendarDay(date, asToday);
      set((state) => ({
        dayDocs: withDay(state.dayDocs, day),
        tasks: {
          ...state.tasks,
          ...Object.fromEntries(day.tasks.map((task) => [task.id, task])),
        },
      }));
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  loadGoal: async (horizon, periodStart) => {
    if (get().goals[goalKey(horizon, periodStart)]) return;
    try {
      const goal = await (await backend()).goalGet(horizon, periodStart);
      set((state) => ({ goals: withGoal(state.goals, goal) }));
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  forgetCarriedDays: (today) =>
    set((state) => {
      const stale = (day: DayDoc) =>
        !!day.carriedFrom || (day.date === today && !day.title && !day.noteMd);
      return state.dayDocs.some(stale)
        ? { dayDocs: state.dayDocs.filter((day) => !stale(day)) }
        : {};
    }),

  searchNotes: async (query) => (await backend()).searchNotes(query, 200),

  saveDocument: async (target, contentMd) => {
    const key = saveKeyOf(target);

    /**
     * 真正写库的部分。三种目标各自判重后再落盘。返回 false 表示文档还没加载、
     * 什么都没做；true 表示库里已经是这一版了（刚写的，或者本来就一样）。
     */
    const write = async (): Promise<boolean> => {
      if (target.kind === "goal") {
        const { horizon, periodStart } = target;
        const source = get().goals[goalKey(horizon, periodStart)];
        // 这个周期还没取回来就别写：编辑器是空的，一输入会把已有的目标整篇覆盖
        if (!source) return false;
        if (source.contentMd === contentMd) return true;
        const updated = await (await backend()).goalSave(horizon, periodStart, contentMd);
        set((state) => ({ goals: withGoal(state.goals, updated) }));
        return true;
      }

      if (target.kind === "day") {
        const id = target.id;
        const source = get().dayDocs.find((day) => day.date === id);
        // 这一天还没加载完就别写。以前 `source?.noteMd === contentMd` 在
        // source 为 undefined 时不拦截，编辑器又是空的，
        // 于是一输入就把当天原有的备注整篇覆盖掉了。
        if (!source) return false;
        if (source.noteMd === contentMd) return true;
        // 延续来的今天：第一次编辑就带着延续来的标题一起，以今天的身份落库
        const updated = await (await backend()).calendarDaySave(id, source.title, contentMd);
        set((state) => ({
          dayDocs: withDay(state.dayDocs, updated),
          marks: withWritten(
            state.marks,
            id,
            !!(contentMd.trim() || updated.title || updated.tasks.some(isDone)),
          ),
        }));
        return true;
      }

      const id = target.id;
      const source =
        get().notes.find((note) => note.id === id) ?? get().archived.find((note) => note.id === id);
      if (!source) return false;
      if (source.contentMd === contentMd) return true;

      const api = await backend();
      await api.noteUpsert({ id, title: source.title, contentMd });
      const updated = await api.noteGet(id);
      set((state) => ({
        // 刻意不重排：自动保存每 400ms 刷新一次 updatedAt，
        // 按它排序会让正在编辑的这篇笔记在侧栏里当着用户的面往上跳。
        // 顺序在下次加载 / 置顶 / 归档时自然会更新。
        notes: state.notes.map((note) => (note.id === id ? updated : note)),
        archived: state.archived.map((note) => (note.id === id ? updated : note)),
      }));
      return true;
    };

    set((state) => ({ savingDocs: new Set(state.savingDocs).add(key) }));
    try {
      const stored = await serialized(key, async () => {
        // 外部改动撞上了没存的修改：先把磁盘上那一版另存一份，再写编辑器里的
        if (get().conflicts.has(key)) {
          await (await backend()).vaultKeepConflictCopy(target);
          set((state) => {
            const conflicts = new Set(state.conflicts);
            conflicts.delete(key);
            return { conflicts };
          });
        }
        return write();
      });
      set((state) => ({
        ...(clearsSaveError(state, key) ? { saveError: null } : {}),
        // 编辑器发来的总是整篇的最新内容，存进去了，之前失败的那一版就作废了
        ...(stored && state.drafts[key] ? { drafts: withoutKey(state.drafts, key) } : {}),
      }));
    } catch (error) {
      // 保存失败必须能被界面看见 —— 光写进 store 没人读等于没说。
      set((state) => ({
        saveError: { key, message: messageOf(error) },
        drafts: { ...state.drafts, [key]: { target, contentMd } },
      }));
      throw error;
    } finally {
      set((state) => {
        const savingDocs = new Set(state.savingDocs);
        savingDocs.delete(key);
        return { savingDocs };
      });
    }
  },

  createNote: async (folder = "") => {
    try {
      const api = await backend();
      // 真正的 id 由后端分配 —— 所以这里没法乐观更新，得等一个来回。
      // 新建是个一次性动作，不像输入那样每次按键都要响应。
      const id = await api.noteCreate(folder, NEW_NOTE_TITLE);
      const created = await api.noteGet(id);
      set((state) => ({ notes: [created, ...state.notes].sort(noteOrder), error: null }));
      return id;
    } catch (error) {
      set({ error: messageOf(error) });
      return null;
    }
  },

  createLinkedNote: async (title, folder) => {
    const id = await get().createNote(folder);
    if (!id) return null;
    try {
      await get().saveTitle({ kind: "note", id }, title);
    } catch {
      // 标题没存上：笔记已经建了，留着「无标题」也能用，错误在状态栏里
    }
    set({
      lastDeleted: null,
      undoable: {
        key: `create:${id}:${Date.now()}`,
        kind: "create",
        message: `已新建「${title}」`,
        undo: async () => {
          set((state) => ({ notes: state.notes.filter((note) => note.id !== id) }));
          try {
            await (await backend()).noteDelete(id);
          } catch (error) {
            set({ error: messageOf(error) });
            await get().refreshFolders();
          }
        },
      },
    });
    return id;
  },

  saveTitle: async (target, title) => {
    const cleanTitle = title.trim();
    if (!cleanTitle || target.kind === "goal") return;
    const key = saveKeyOf(target);
    let renamed: { id: string; from: string } | null = null;

    // 和正文的保存排在同一条队里，source 在轮到自己时才读（见 serialized）
    const write = async () => {
      const api = await backend();

      if (target.kind === "day") {
        const source = get().dayDocs.find((day) => day.date === target.id);
        if (!source || source.title === cleanTitle) return;
        // 延续来的今天在这里第一次落库：正文照延续的存，标题换成新的
        const updated = await api.calendarDaySave(target.id, cleanTitle, source.noteMd);
        set((state) => ({
          dayDocs: withDay(state.dayDocs, updated),
          marks: withWritten(state.marks, target.id, true),
        }));
        return;
      }

      const id = target.id;
      const source =
        get().notes.find((note) => note.id === id) ?? get().archived.find((note) => note.id === id);
      if (!source || source.title === cleanTitle) return;

      await api.noteUpsert({
        id,
        title: cleanTitle,
        contentMd: source.contentMd,
      });
      // 刚新建、还没起名的那篇（占位标题）没人会链它
      if (source.title !== NEW_NOTE_TITLE) renamed = { id, from: source.title };
      const updated = await api.noteGet(id);
      set((state) => ({
        // 同样不重排：改标题时列表在脚下跳一下同样很吓人。
        notes: state.notes.map((note) => (note.id === id ? updated : note)),
        archived: state.archived.map((note) => (note.id === id ? updated : note)),
      }));
    };

    try {
      await serialized(key, write);
      set((state) => (clearsSaveError(state, key) ? { saveError: null } : {}));
    } catch (error) {
      set({ saveError: { key, message: messageOf(error) } });
      throw error;
    }
    const done = renamed as { id: string; from: string } | null;
    if (done) void get().relinkTitle(done.id, done.from, cleanTitle);
  },

  relinkTitle: async (id, oldTitle, newTitle) => {
    try {
      // 别的文档要是还有没存的修改（刚切过来），先存掉：不然晚到的那次保存会把旧链接写回去
      const { flushAllEditors } = await import("@/editor/saveBus");
      await flushAllEditors();
      const api = await backend();
      const result = await api.noteRelink(id, oldTitle);
      if (result.skipped) {
        set({ notice: result.skipped });
        return;
      }
      if (!result.links) return;
      // 改过的文档由 vault-changed 逐篇刷新（桌面版是 Rust 发的，浏览器预览是 mock 发的）
      const where =
        result.docs.length === 1 ? `「${result.docs[0]}」` : ` ${result.docs.length} 篇`;
      set({
        lastDeleted: null,
        undoable: {
          key: `relink:${id}:${Date.now()}`,
          kind: "relink",
          message: `已把${where}里的 [[${oldTitle.trim()}]] 改成 [[${newTitle}]]`,
          undo: async () => {
            await api.noteRelinkUndo(result.rewrites);
          },
        },
      });
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  restoreVersion: async (target, body, when) => {
    try {
      // 编辑器里没存的先存掉：恢复之前的样子要是最新的，晚到的保存也不会把旧正文写回来
      const { flushAllEditors } = await import("@/editor/saveBus");
      await flushAllEditors();
      const before = conflictOriginalContent(target, get());
      if (before === undefined || before === body) return;
      const key = saveKeyOf(target);
      const replace = async (content: string) => {
        await get().saveDocument(target, content);
        // 编辑器开着这一篇：当成一次外部改动，换上新正文
        set((state) => ({ externalRevisions: bumped(state.externalRevisions, key) }));
      };
      await replace(body);
      set({
        lastDeleted: null,
        undoable: {
          key: `history:${key}:${Date.now()}`,
          kind: "history",
          message: `已恢复到 ${when} 的版本`,
          undo: async () => {
            await (await import("@/editor/saveBus")).flushAllEditors();
            await replace(before);
          },
        },
      });
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  toggleTask: async (id) => {
    const current = get().tasks[id];
    if (!current) return;
    const done = current.status === "done";
    const optimistic: Task = { ...current, status: done ? "todo" : "done" };
    set((state) => patchTask(state, id, optimistic));
    try {
      const saved = await (await backend()).taskToggle(id);
      set((state) => patchTask(state, id, saved));
      // 这一天还有没有没做完的：日历上的记号跟着变
      void get().refreshMarks();
    } catch (error) {
      set((state) => ({ ...patchTask(state, id, current), error: messageOf(error) }));
    }
  },

  togglePin: async (id) => {
    const previous = get().notes.find((note) => note.id === id);
    if (!previous) return;
    const pinned = !previous.isPinned;
    set((state) => ({
      notes: state.notes
        .map((note) => (note.id === id ? { ...note, isPinned: pinned } : note))
        .sort(noteOrder),
    }));
    try {
      await (await backend()).noteSetPinned(id, pinned);
    } catch (error) {
      set((state) => ({
        notes: state.notes.map((note) => (note.id === id ? previous : note)).sort(noteOrder),
        error: messageOf(error),
      }));
    }
  },

  archiveNote: async (id, { undoable = true } = {}) => {
    const previous = get().notes.find((note) => note.id === id);
    if (!previous) return;
    const optimistic: Note = {
      ...previous,
      isArchived: true,
      isPinned: false,
      archiveCategory: previous.archiveCategory ?? "笔记",
      archivedAt: Date.now(),
    };
    set((state) => ({
      notes: state.notes.filter((note) => note.id !== id),
      archived: [optimistic, ...state.archived],
    }));
    try {
      const api = await backend();
      await api.noteArchive(id);
      const saved = await api.noteGet(id);
      set((state) => ({
        archived: state.archived.map((note) => (note.id === id ? saved : note)),
        ...(undoable
          ? {
              lastDeleted: null,
              undoable: {
                key: `archive:${id}:${Date.now()}`,
                kind: "archive" as const,
                message: `已归档「${titleOf(previous)}」`,
                undo: () => get().restoreNote(id, { undoable: false }),
                reopen: id,
              },
            }
          : {}),
      }));
    } catch (error) {
      set((state) => ({
        notes: [previous, ...state.notes].sort(noteOrder),
        archived: state.archived.filter((note) => note.id !== id),
        error: messageOf(error),
      }));
    }
  },

  restoreNote: async (id, { undoable = true } = {}) => {
    const previous = get().archived.find((note) => note.id === id);
    if (!previous) return;
    const optimistic = { ...previous, isArchived: false, archivedAt: null };
    set((state) => ({
      archived: state.archived.filter((note) => note.id !== id),
      notes: [optimistic, ...state.notes].sort(noteOrder),
    }));
    try {
      const api = await backend();
      await api.noteRestore(id);
      const saved = await api.noteGet(id);
      set((state) => ({
        notes: state.notes.map((note) => (note.id === id ? saved : note)).sort(noteOrder),
        ...(undoable
          ? {
              lastDeleted: null,
              undoable: {
                key: `restore:${id}:${Date.now()}`,
                kind: "restore" as const,
                message: `已恢复「${titleOf(previous)}」到「${folderLabel(folderOf(saved))}」`,
                undo: () => get().archiveNote(id, { undoable: false }),
                reopen: id,
              },
            }
          : {}),
      }));
      // 回到归档前的文件夹；那个文件夹这期间被删了的话后端重新建上
      await get().refreshFolders();
    } catch (error) {
      set((state) => ({
        archived: [previous, ...state.archived],
        notes: state.notes.filter((note) => note.id !== id),
        error: messageOf(error),
      }));
    }
  },

  deleteNote: async (id) => {
    // 笔记列表里没有就去归档里找：两个列表各删各的，撤销时放回原来那一个
    const archived = !get().notes.some((note) => note.id === id);
    const listOf = (state: Pick<DataState, "notes" | "archived">) =>
      archived ? state.archived : state.notes;
    const patch = (list: Note[]) => (archived ? { archived: list } : { notes: list });
    const index = listOf(get()).findIndex((note) => note.id === id);
    const previous = listOf(get())[index];
    if (!previous) return;
    set((state) => ({
      ...patch(listOf(state).filter((note) => note.id !== id)),
      lastDeleted: { note: previous, index, archived },
      undoable: null,
    }));
    const request = (async () => (await backend()).noteDelete(id))();
    pendingDelete = request.catch(() => undefined);
    try {
      await request;
    } catch (error) {
      set((state) => ({
        ...patch(insertAt(listOf(state), index, previous)),
        lastDeleted: state.lastDeleted?.note.id === id ? null : state.lastDeleted,
        error: messageOf(error),
      }));
    }
  },

  lastDeleted: null,

  undoDelete: async () => {
    const deleted = get().lastDeleted;
    if (!deleted) return null;
    set({ lastDeleted: null });
    const { id } = deleted.note;
    try {
      await pendingDelete;
      const present = (state: Pick<DataState, "notes" | "archived">) =>
        state.notes.some((note) => note.id === id) || state.archived.some((note) => note.id === id);
      // 删除失败的话已经回滚过了，笔记还在列表里，没什么可撤销的
      if (present(get())) return id;
      const api = await backend();
      await api.noteUndelete(id);
      // 重新取一次：删之前失焦触发的那次保存可能比删除晚一步落库，
      // 手里这份未必是最新的正文。归档里删的，放回去还在归档里
      const restored = await api.noteGet(id);
      const index = restored.isArchived === deleted.archived ? deleted.index : 0;
      set((state) => {
        if (present(state)) return { error: null };
        return restored.isArchived
          ? { archived: insertAt(state.archived, index, restored), error: null }
          : { notes: insertAt(state.notes, index, restored), error: null };
      });
      // 原来的文件夹可能已经删了，放回去时后端重新建上
      await get().refreshFolders();
      return id;
    } catch (error) {
      set({ error: messageOf(error) });
      return null;
    }
  },

  dismissUndo: () => set({ lastDeleted: null }),

  folders: [],

  refreshFolders: async () => {
    try {
      const folders = await (await backend()).folderList();
      set({ folders });
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  // 新建、改名都先按后端的规矩（folders.ts 的 cleanFolderName / uniqueChild）把结果放进列表：
  // 回车那一下输入框就换成文件夹，中间不空一拍；后端回来的路径不一样（磁盘上有同名的
  // 别的东西之类）再改正，失败了退回去
  createFolder: async (parent, name) => {
    const clean = cleanFolderName(name);
    if (!clean) return null;
    const guess = uniqueChild(get().folders, parent, clean);
    set((state) => ({ folders: [...state.folders, guess].sort() }));
    try {
      const path = await (await backend()).folderCreate(parent, name);
      if (path !== guess) {
        set((state) => ({
          folders: [...new Set(state.folders.map((p) => (p === guess ? path : p)))].sort(),
        }));
      }
      return path;
    } catch (error) {
      set((state) => ({
        folders: state.folders.filter((p) => p !== guess),
        error: messageOf(error),
      }));
      return null;
    }
  },

  renameFolder: async (folder, name) => {
    const clean = cleanFolderName(name);
    if (!clean) return null;
    const guess = uniqueChild(get().folders, parentOf(folder), clean, folder);
    if (guess === folder) return folder;
    const before = { folders: get().folders, notes: get().notes };
    // 本地换掉前缀：列表立刻跟上，后端随后发来的 vault-changed 再逐篇刷新
    const move = (from: string, to: string) =>
      set((state) => ({
        folders: state.folders.map((path) => renamedPath(path, from, to)).sort(),
        notes: state.notes.map((note) => {
          const relPath = renamedRelPath(note.relPath, from, to);
          return relPath === note.relPath ? note : { ...note, relPath };
        }),
      }));
    move(folder, guess);
    try {
      const next = await (await backend()).folderRename(folder, name);
      if (next !== guess) move(guess, next);
      return next;
    } catch (error) {
      set({ ...before, error: messageOf(error) });
      return null;
    }
  },

  deleteFolder: async (folder) => {
    const before = { folders: get().folders, notes: get().notes };
    const name = nameOf(folder);
    set((state) => ({
      folders: state.folders.filter((path) => !within(path, folder)),
      notes: state.notes.filter((note) => !within(folderOf(note), folder)),
    }));
    try {
      // 正在编辑的那篇也在里面的话，先把没存的存掉，进回收站的是最新的一版
      const { flushAllEditors } = await import("@/editor/saveBus");
      await flushAllEditors();
      const deletion: FolderDeletion = await (await backend()).folderDelete(folder);
      const count = deletion.notes.length;
      set({
        lastDeleted: null,
        undoable: {
          key: `folder:${folder}:${Date.now()}`,
          kind: "delete",
          message: count ? `已删除「${name}」和里面的 ${count} 篇笔记` : `已删除「${name}」`,
          undo: async () => {
            const api = await backend();
            await api.folderUndelete(deletion);
            const [notes, folders] = await Promise.all([api.noteListFull(false), api.folderList()]);
            set({ notes: notes.sort(noteOrder), folders });
          },
        },
        ...(deletion.kept
          ? { notice: `「${name}」里还有别的文件（图片、PDF…），文件夹留着，笔记已经删掉了` }
          : {}),
      });
      if (deletion.kept) await get().refreshFolders();
    } catch (error) {
      set({ ...before, error: messageOf(error) });
    }
  },

  revealFolder: async (folder) => {
    try {
      await (await backend()).folderReveal(folder);
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  moveNote: async (id, folder) => {
    const previous = get().notes.find((note) => note.id === id);
    if (!previous || folderOf(previous) === folder) return;
    const from = folderOf(previous);
    // 乐观地先挪过去：文件名一般不变，重名加序号的情况等后端回来再改正
    set((state) => ({
      notes: state.notes.map((note) =>
        note.id === id ? { ...note, relPath: relPathIn(note, folder) } : note,
      ),
    }));
    try {
      // 正在编辑的话先把没存的存掉，再和这篇的保存排在同一条队里挪：挪的时候正文里的
      // 相对链接会改写，不能让一次晚到的保存把旧链接写回去
      const { flushAllEditors } = await import("@/editor/saveBus");
      await flushAllEditors();
      const key = saveKeyOf({ kind: "note", id });
      const moved = await serialized(key, async () => (await backend()).noteMove(id, folder));
      set((state) => ({
        notes: state.notes.map((note) => (note.id === id ? moved : note)),
        externalRevisions:
          moved.contentMd !== previous.contentMd
            ? bumped(state.externalRevisions, key)
            : state.externalRevisions,
        lastDeleted: null,
        undoable: {
          key: `move:${id}:${Date.now()}`,
          kind: "move",
          message: `已移到「${folderLabel(folder)}」`,
          undo: () =>
            get()
              .moveNote(id, from)
              .then(() => set({ undoable: null })),
        },
      }));
    } catch (error) {
      set((state) => ({
        notes: state.notes.map((note) => (note.id === id ? previous : note)),
        error: messageOf(error),
      }));
    }
  },

  undoable: null,
  dismissUndoable: () => set({ undoable: null }),

  resolveConflict: async (copyId, keep) => {
    const all = [...get().notes, ...get().archived];
    const copy = all.find((note) => note.id === copyId);
    if (!copy?.conflictOf) return null;
    const target = conflictTarget(copy.conflictOf);
    // 原文是笔记、已经不在了：横幅本来就不显示
    if (conflictOriginalTitle(target, get()) === undefined) return null;
    try {
      if (keep === "copy") {
        // 某一天 / 目标是按需取的：没取回来时 saveDocument 什么都不写
        if (target.kind === "day") await get().loadDay(target.id, target.id === today());
        if (target.kind === "goal") await get().loadGoal(target.horizon, target.periodStart);
        const current = conflictOriginalContent(target, get());
        if (current === undefined) return null;
        if (current !== copy.contentMd) {
          await get().saveDocument(target, copy.contentMd);
          // 原文的编辑器状态可能缓存着（切走时留的）：当成一次外部改动，下次打开换成新正文
          set((state) => ({
            externalRevisions: bumped(state.externalRevisions, saveKeyOf(target)),
          }));
        }
      }
      if (copy.isArchived) {
        // 归档里的副本：deleteNote 只管笔记列表，这里直接删
        await (await backend()).noteDelete(copy.id);
        set((state) => ({ archived: state.archived.filter((note) => note.id !== copy.id) }));
      } else {
        await get().deleteNote(copy.id);
      }
      return target;
    } catch (error) {
      set({ error: messageOf(error) });
      return null;
    }
  },

  guideUpdates: [],

  adoptGuideUpdate: async (id) => {
    const update = get().guideUpdates.find((item) => item.id === id);
    if (!update) return;
    const target: DocumentSaveTarget = { kind: "note", id };
    try {
      // 编辑器里没存的先存掉：撤销时换回来的要是最新的那一版
      const { flushAllEditors } = await import("@/editor/saveBus");
      await flushAllEditors();
      const before = conflictOriginalContent(target, get());
      if (before === undefined) return;
      const replace = async (content: string) => {
        await get().saveDocument(target, content);
        // 编辑器开着这一篇：当成一次外部改动，换上新正文
        set((state) => ({
          externalRevisions: bumped(state.externalRevisions, saveKeyOf(target)),
        }));
      };
      await replace(update.body);
      // 正文存好了再记：记下的指纹和正文对得上，以后就又是「没改过」了
      await (await backend()).guideSettle(id);
      set((state) => ({
        guideUpdates: state.guideUpdates.filter((item) => item.id !== id),
        lastDeleted: null,
        undoable: {
          key: `guide:${id}:${Date.now()}`,
          kind: "history",
          message: "已换成新版的使用指南",
          undo: async () => {
            await (await import("@/editor/saveBus")).flushAllEditors();
            await replace(before);
          },
        },
      }));
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  keepGuide: async (id) => {
    try {
      await (await backend()).guideSettle(id);
      set((state) => ({ guideUpdates: state.guideUpdates.filter((item) => item.id !== id) }));
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  openGuide: async (name) => {
    try {
      const api = await backend();
      const id = await api.guideOpen(name);
      const known = [...get().notes, ...get().archived].some((note) => note.id === id);
      if (!known) {
        // 删掉了、刚照这个版本重新放了一篇：放进列表
        const created = await api.noteGet(id);
        set((state) => ({ notes: [created, ...state.notes].sort(noteOrder) }));
      }
      return id;
    } catch (error) {
      set({ error: messageOf(error) });
      return null;
    }
  },
}));

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

/** 这篇保存成功之后该不该清掉 saveError：是它自己的，或者是不属于某一篇的（关窗那种）。 */
function clearsSaveError(state: DataState, key: string): boolean {
  return !!state.saveError && (state.saveError.key === key || state.saveError.key === null);
}

/** 保存中状态的键：和 DocumentView 里 savingDocs.has(saveKey(doc)) 用同一个算法 */
export function saveKeyOf(target: DocumentSaveTarget): string {
  if (target.kind === "goal") return `goal:${goalKey(target.horizon, target.periodStart)}`;
  return `${target.kind}:${target.id}`;
}
