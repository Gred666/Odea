import { openDocument } from "@/app/navigate";
import { useApp } from "@/app/store";
import {
  attachFiles,
  attachPaths,
  documentFolder,
  localAttachmentHost,
  wikiImageResolver,
} from "@/data/attachments";
import { folderLabel, folderOf } from "@/data/folders";
import { useData } from "@/data/store";
import { type DocumentModel, NOTE, noteRef, vaultRef } from "@/data/types";
import type { WikiCandidate } from "@/editor/suggest";
import { FILE_EXTENSIONS } from "@/lib/embeds";
import { resolveVaultFile } from "@/lib/wikiFiles";
import { linkedNote } from "@/lib/wikilinks";
import { useCallback, useMemo, useRef } from "react";

/* ============================================================
   编辑仓库里一篇的编辑器要的那几样：文档视图的正文、白板上正在编辑的卡片（docs/白板.md §13.7）用同一份。
   - `[[` 菜单能链到哪些笔记（也用来认出链到不存在的笔记的双链）、Ctrl + 点双链去哪
   - 图片、`![[图.png]]`、`![[说明书.pdf]]` 按这一篇所在的文件夹、仓库里的附件找
   - 粘贴、拖进来的文件存进仓库的「附件」
   做客的那一篇（协作时别人的文档）不在仓库里，这几样换成主持人那边的（DocumentView 里）
   ============================================================ */

export interface EditorHost {
  /** 这一篇是笔记的话它的 id（`[[` 菜单里不列它自己） */
  noteId: string | null;
  linkTargets: WikiCandidate[];
  onWikiLink: (title: string, heading?: string, newTab?: boolean) => void;
  imageBase: string | null;
  wikiImage: ReturnType<typeof wikiImageResolver>;
  attachments: ReturnType<typeof localAttachmentHost>;
  onAttachFiles: (files: File[]) => ReturnType<typeof attachFiles>;
  onAttachPaths: (paths: string[]) => ReturnType<typeof attachPaths>;
}

export function useEditorHost(doc: DocumentModel): EditorHost {
  const target = vaultRef(doc.editor?.target);
  const noteId = target?.type === NOTE ? target.key : null;
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;

  // Mod + 点击 [[双链]]：按标题找到那篇笔记就跳过去（归档里的也算），再按着 Shift 开在新标签里。
  // `[[标题#小节]]` 再记一个待滚动的锚点，等那篇的编辑器挂上后滚过去。
  // 还没有这篇（编辑器里画成虚线）：就地新建一篇这个标题的，放在当前这篇所在的文件夹，
  // 打开它、光标在正文开头；底部提示条可以撤销
  const onWikiLink = useCallback((title: string, heading?: string, newTab = false) => {
    const wanted = title.trim().toLowerCase();
    if (!wanted) return;
    const { notes, archived, attachments } = useData.getState();
    // `[[图.png]]`、`[[说明书.pdf]]` 链的是附件，不是笔记：不新建。在仓库里找得到就用系统的程序打开
    if (FILE_EXTENSIONS.test(wanted)) {
      const from = notes.find((note) => note.id === noteIdRef.current)?.relPath ?? null;
      const rel = resolveVaultFile(title, from, attachments);
      if (rel) void useData.getState().openAttachment(rel);
      else useData.setState({ error: `仓库里找不到「${title.trim()}」` });
      return;
    }
    const hit = linkedNote(title, notes, archived);
    if (hit) {
      openDocument(noteRef(hit.id), heading ? { heading } : undefined, newTab);
      return;
    }
    const here = notes.find((note) => note.id === noteIdRef.current);
    void useData
      .getState()
      .createLinkedNote(title.trim(), here ? folderOf(here) : "")
      .then((id) => {
        if (!id) return;
        useApp.getState().setFocusRequest({ docKey: `note-${id}`, at: "body" });
        openDocument(noteRef(id), undefined, newTab);
      });
  }, []);

  // 只在标题集合变了时重算：自动保存每次都换一份 notes，不能每次都让编辑器重标一遍
  const linkKey = useData((state) =>
    [...state.notes, ...state.archived].map((note) => `${note.id}\u0001${note.title}`).join("\n"),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: linkKey 就是标题集合的指纹
  const linkTargets = useMemo<WikiCandidate[]>(() => {
    const { notes, archived } = useData.getState();
    return [...notes, ...archived]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((note) => ({
        id: note.id,
        title: note.title,
        folder: folderOf(note) ? folderLabel(folderOf(note)) : "",
        archived: note.isArchived,
      }));
  }, [linkKey]);

  // 附件：粘贴 / 拖进来的文件存进仓库的「附件」，正文里的相对路径以这篇所在的文件夹为基准
  const vaultRoot = useData((s) => s.vaultRoot);
  const imageBase = documentFolder(vaultRoot, doc.relPath);
  // Obsidian 的 `![[图.png]]`、`![[说明书.pdf]]`：按名字在整个仓库的附件里找（lib/wikiFiles.ts）
  const vaultAttachments = useData((s) => s.attachments);
  const wikiImage = useMemo(
    () => wikiImageResolver(vaultRoot, doc.relPath, vaultAttachments),
    [vaultRoot, doc.relPath, vaultAttachments],
  );
  const attachments = useMemo(
    () => localAttachmentHost(vaultRoot, doc.relPath, vaultAttachments),
    [vaultRoot, doc.relPath, vaultAttachments],
  );
  const onAttachFiles = useCallback(
    (files: File[]) => (target ? attachFiles(target, files) : Promise.resolve([])),
    [target],
  );
  const onAttachPaths = useCallback(
    (paths: string[]) => (target ? attachPaths(target, paths) : Promise.resolve([])),
    [target],
  );

  return {
    noteId,
    linkTargets,
    onWikiLink,
    imageBase,
    wikiImage,
    attachments,
    onAttachFiles,
    onAttachPaths,
  };
}
