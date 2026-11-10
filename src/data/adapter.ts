import { useApp } from "@/app/store";
import { useCollab } from "@/collab/store";
import { formatFullCN, formatRelativeTime, formatTimestampFull, toISODate } from "@/lib/date";
import { installedPlugins, noteTemplateContext } from "@/plugins/registry";
import { teamDocId, useTeam } from "@/team/store";
import { useEffect, useRef } from "react";
import { conflictOriginalTitle, conflictTarget } from "./conflicts";
import { folderOf } from "./folders";
import { saveKeyOf, useData } from "./store";
import { type DocumentModel, type DocumentRef, NOTE, type NoteSummary, noteRef } from "./types";

/* ============================================================
   把「当前工作区 + 选中项」映射成统一的 DocumentModel。
   ★ 这是「一切皆文档」抽象的落点 ——
   核心的几页（笔记、归档）在这里，插件的页由插件给出那一篇（文档类型注册表，plugins/registry.ts）：
   DocumentView 完全不知道自己在渲染笔记还是日历。
   ============================================================ */

export function useCurrentDocument(): DocumentModel {
  return useWithTeam(useVaultDocument());
}

/**
 * 笔记区一个窗格里显示的那一篇（docs/标签页与分屏.md）：和 useCurrentDocument 的笔记那一支一样，
 * 只是看的是这个窗格自己的当前标签。正在写的那个窗格直接用 useCurrentDocument（做客时它换成共享的那一篇）
 */
export function usePaneDocument(noteId: string, active: boolean): DocumentModel {
  return useWithTeam(useNoteDocument(noteId, active));
}

/** 团队仓库（docs/协同编辑.md §22.4）：别人也开着这一篇、在一份会话里，编辑器绑上它；别人主持的不存盘 */
function useWithTeam(doc: DocumentModel): DocumentModel {
  const teamId = teamDocId(doc);
  const team = useTeam((s) => (teamId ? s.sessions[teamId] : undefined));
  if (!team) return doc;
  // 协作借着团队这份会话（请了外人）时两边是同一份：存不存盘听团队的（别人主持就是他存）
  return {
    ...doc,
    collab: { session: team.session, readOnly: doc.collab?.readOnly ?? false, remote: team.remote },
  };
}

/**
 * 保存失败、还没落盘的正文优先于库里的版本：切走再切回来，用户写的东西还在。
 * 返回「有草稿就用草稿，没有就用库里的正文」（插件给出它的文档时也用它）
 */
export function useDraftOr(): (target: DocumentRef, stored: string) => string {
  const drafts = useData((s) => s.drafts);
  return (target, stored) => drafts[saveKeyOf(target)]?.contentMd ?? stored;
}

/**
 * 插件的页显示哪一篇（文档槽位）：每个装着的插件的 useDocument 都调一遍，是它的页的那一个给出文档。
 * 插件在第一帧之前就装好了（plugins/index.ts），个数和顺序每次渲染都一样，挨个调不违反 hook 的规矩
 */
function usePluginDocument(page: string): DocumentModel | null {
  let found: DocumentModel | null = null;
  for (const plugin of installedPlugins()) {
    const hook = plugin.useDocument;
    const doc = hook(page);
    if (!found && doc) found = doc;
  }
  return found;
}

function useVaultDocument(): DocumentModel {
  const workspace = useApp((s) => s.workspace);
  const selectedNoteId = useApp((s) => s.selectedNoteId);
  const selectedArchiveId = useApp((s) => s.selectedArchiveId);

  const notes = useData((s) => s.notes);
  const archived = useData((s) => s.archived);
  const bodies = useData((s) => s.bodies);
  const draftOr = useDraftOr();
  const pluginDocument = usePluginDocument(workspace);

  // 协作（docs/协同编辑.md）：做客时正文区换成共享的那一篇
  const showShared = useCollab((s) => s.showShared);
  const collabSession = useCollab((s) => s.session);
  const sessionKey = useCollab((s) => s.sessionKey);
  const shared = useCollab((s) =>
    s.shownSession === null ? undefined : s.sessions[s.shownSession],
  );
  // 笔记区正在写的那个窗格里的那一篇
  const noteDoc = useNoteDocument(selectedNoteId, workspace === "notes");
  // 归档列表显示哪一篇：选中的不在了就是第一篇；正文还没取回来就先接着显示上一篇
  const shownArchived = useShownNote(
    archived.find((n) => n.id === selectedArchiveId) ?? archived[0],
    workspace === "archive",
  );

  // 做客时正文区换成共享的那一篇（放在所有 hook 之后：提前 return 不能改变 hook 的顺序）
  if (shared?.phase === "guest" && showShared && collabSession) {
    const host = shared.members.find((member) => member.host)?.name;
    const ended = shared.status?.state === "ended";
    return {
      key: `shared-${sessionKey}`,
      title: shared.title || "协作的笔记",
      eyebrow: host ? `${host} 的笔记` : undefined,
      bodyMd: collabSession.toString(),
      statusParts: ended ? ["协作已结束"] : ["协作中", `${shared.members.length} 人`],
      editor: { target: { kind: "shared", id: sessionKey }, titleEditable: false },
      // 只读：主持人给的权限；协作结束以后也不再能改（改了也传不出去），要接着写就存一份
      collab: { session: collabSession, readOnly: shared.permission === "read" || ended },
    };
  }
  switch (workspace) {
    /* ---------------- 笔记 ---------------- */
    case "notes":
      return noteDoc;

    /* ---------------- 归档 ---------------- */
    case "archive": {
      const note = shownArchived;
      if (!note) {
        return emptyDoc({
          art: "archive",
          title: "归档是空的",
          hint: "用完的笔记归档到这里，不占日常列表，随时能找回来。",
        });
      }
      const body = bodies[note.id];
      return {
        key: `archive-${note.id}`,
        title: note.title,
        conflict: conflictOf(note, notes, archived),
        relPath: note.relPath,
        idInFile: note.idInFile,
        banner: {
          icon: "archive",
          text: `已归档 · ${formatFullCN(toISODate(new Date(note.archivedAt ?? note.updatedAt)))}`,
        },
        bodyMd: draftOr(noteRef(note.id), body ?? ""),
        statusParts: body === undefined ? ["载入中…"] : noteStatus(note, "最后编辑于"),
        // 归档里的也能直接删（进回收站，可以撤销），不用先恢复出来
        deletable: true,
        editor: body === undefined ? undefined : { target: noteRef(note.id), titleEditable: true },
      };
    }

    case "extensions":
      return { key: "empty-扩展", title: "扩展", bodyMd: "", statusParts: [] };

    /* ---------------- 插件的页（今日TODO、目标、日历……）；认不出来的回到笔记那一篇 ---------------- */
    default:
      return pluginDocument ?? noteDoc;
  }
}

/**
 * 笔记区里的一篇（正在写的窗格、别的窗格都是它）：noteId 不在了就是列表第一篇；
 * 正文还没取回来就先接着显示上一篇。active：这一区正显示着，才去取正文
 */
function useNoteDocument(noteId: string, active: boolean): DocumentModel {
  const notes = useData((s) => s.notes);
  const archived = useData((s) => s.archived);
  const bodies = useData((s) => s.bodies);
  // 后台还在把文件读进索引（第一次打开一个大文件夹）：一篇都没有不等于「还没有笔记」
  const indexing = useData((s) => s.indexing !== null);
  const draftOr = useDraftOr();
  // 主持的那几篇笔记带上各自的会话（一篇只在一个会话里，docs/协同编辑.md §25）
  const hostedDocs = useCollab((s) => s.hostedDocs);
  const hostedCollab = (id: string) => {
    const session = hostedDocs[id];
    return session ? { session, readOnly: false } : undefined;
  };
  const note = useShownNote(notes.find((n) => n.id === noteId) ?? notes[0], active);
  if (!note) {
    return emptyDoc(
      indexing
        ? {
            art: "notes",
            title: "正在读取笔记文件夹…",
            hint: "第一次打开这个文件夹要把笔记都读一遍，读完就会出现在左边的列表里。",
          }
        : {
            art: "notes",
            title: "还没有笔记",
            hint: "想到什么就记下来，标题可以晚点再起。",
            action: "createNote",
          },
    );
  }

  const body = bodies[note.id];
  return {
    key: `note-${note.id}`,
    title: note.title,
    conflict: conflictOf(note, notes, archived),
    relPath: note.relPath,
    idInFile: note.idInFile,
    folder: folderOf(note),
    bodyMd: draftOr(noteRef(note.id), body ?? ""),
    statusParts: body === undefined ? ["载入中…"] : noteStatus(note, "上次更新"),
    deletable: true,
    collab: hostedCollab(note.id),
    // 开了带模板的插件（L0）时 `/模板` 能用；没有就和以前一样
    templates: noteTemplateContext(note.title),
    // 正文取回来之前不给编辑器：空着挂上的话，一输入就把原来的正文整篇覆盖了
    editor: body === undefined ? undefined : { target: noteRef(note.id), titleEditable: true },
  };
}

/* ---------------- 笔记的正文按需取 ---------------- */

/**
 * 显示这一篇要哪几篇的正文：它自己，是冲突副本的话还有原文（横幅要对比两版；
 * 原文是插件的一篇的由横幅自己去取）
 */
function bodiesFor(note: NoteSummary): string[] {
  const original = note.conflictOf ? conflictTarget(note.conflictOf) : null;
  return original?.type === NOTE ? [note.id, original.key] : [note.id];
}

/**
 * 列表里选中的这一篇（wanted）该显示了没有：正文都在 store 的 bodies 里了就显示它；还没取回来
 * （loadBody，一般就几毫秒）就接着显示上一篇有正文的，取回来再换 —— 中间不闪一帧没有正文的文档。
 * 一篇都没显示过（极少：刚启动时那两篇已经预先取好了）才给一篇「载入中」的。
 * active：这个区正显示着，才去取
 */
function useShownNote(wanted: NoteSummary | undefined, active: boolean): NoteSummary | undefined {
  const bodies = useData((s) => s.bodies);
  const loadBody = useData((s) => s.loadBody);
  const shown = useRef<NoteSummary | undefined>(undefined);
  const needed = wanted ? bodiesFor(wanted) : [];
  const ready = needed.every((id) => bodies[id] !== undefined);
  // 依赖里放字符串：bodiesFor 每次都是新数组
  const neededKey = needed.join("|");
  useEffect(() => {
    if (!active || ready || !neededKey) return;
    for (const id of neededKey.split("|")) void loadBody(id);
  }, [active, ready, neededKey, loadBody]);
  useEffect(() => {
    if (ready && wanted) shown.current = wanted;
  });
  if (!wanted || ready) return wanted;
  const previous = shown.current;
  return previous && bodies[previous.id] !== undefined ? previous : wanted;
}

/* ---------------- 辅助 ---------------- */

/**
 * 笔记的状态栏：字数、创建时间、上次更新。刚建的、建完还没过一分钟就改的，
 * 「创建」和「更新」是同一刻，只写一个
 */
function noteStatus(note: NoteSummary, updatedLabel: string): string[] {
  const parts = [`${note.wordCount} 字`, `创建时间 ${formatTimestampFull(note.createdAt)}`];
  if (note.updatedAt - note.createdAt >= 60_000) {
    parts.push(`${updatedLabel} ${formatRelativeTime(note.updatedAt)}`);
  }
  return parts;
}

function emptyDoc(empty: NonNullable<DocumentModel["empty"]>): DocumentModel {
  return { key: `empty-${empty.title}`, title: empty.title, bodyMd: "", statusParts: [], empty };
}

/** 这篇是冲突副本、原文还在：冲突横幅要的东西。原文是插件的一篇时，正文由横幅按需去取 */
function conflictOf(
  note: NoteSummary,
  notes: NoteSummary[],
  archived: NoteSummary[],
): DocumentModel["conflict"] {
  if (!note.conflictOf) return undefined;
  const original = conflictTarget(note.conflictOf);
  const originalTitle = conflictOriginalTitle(original, { notes, archived });
  if (originalTitle === undefined) return undefined;
  return { copyId: note.id, original, originalTitle };
}
