import { showNoteAs, shownView, viewShortcut } from "@/app/noteViews";
import type { NoteTab } from "@/app/panes";
import { useData } from "@/data/store";
import { type DocumentModel, NOTE, vaultRef } from "@/data/types";
import { type NoteView, type NoteViewProps, noteViewsOf } from "@/plugins/registry";
import {
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
  Suspense,
  lazy,
  useMemo,
} from "react";
import { SwapFade } from "./SwapFade";

/* ============================================================
   窗格里的正文：文档视图，或者这个标签选的那种摆法（插件的 noteViews，白板，docs/白板.md §13.4）。
   摆法的组件是插件的分包，第一次用到才加载（和 BaseHost 一样）。换摆法、在白板里换篇时整块溶解（SwapFade）；
   文档视图里换篇由它自己的那一份溶解
   ============================================================ */

const loaded = new Map<string, LazyExoticComponent<ComponentType<NoteViewProps>>>();

function componentOf(view: NoteView) {
  let component = loaded.get(view.id);
  if (!component) {
    component = lazy(async () => ({ default: await view.load() }));
    loaded.set(view.id, component);
  }
  return component;
}

/** 这一篇这个标签里画成哪种摆法：只有仓库里的笔记有（做客的、视图文件、空白页、协作在别处的都是文档） */
export function useNoteView(
  tab: Pick<NoteTab, "noteId" | "view"> | undefined,
  doc: DocumentModel,
): NoteView | undefined {
  const enabled = useData((s) => s.layout.plugins);
  if (!tab?.view || doc.base || doc.empty) return undefined;
  if (vaultRef(doc.editor?.target)?.type !== NOTE) return undefined;
  return shownView(tab, enabled);
}

/** 文档视图状态栏里换摆法的按钮（每种一个） */
export interface ViewSwitch {
  id: string;
  label: string;
  icon: NoteView["icon"];
  /** 快捷键，悬停提示里的键帽（「Ctrl Shift B」）；没有是 undefined */
  kbd?: string;
  select: () => void;
}

/** 这一篇在这个标签里能换成哪几种摆法（文档视图状态栏里的按钮） */
export function useViewSwitches(
  tab: Pick<NoteTab, "id" | "noteId"> | undefined,
  doc: DocumentModel,
): ViewSwitch[] {
  const enabled = useData((s) => s.layout.plugins);
  const tabId = tab?.id ?? "";
  const noteId = tab?.noteId ?? "";
  const isNote = !doc.base && !doc.empty && vaultRef(doc.editor?.target)?.type === NOTE;
  // 每次渲染同一份（DocumentView 的状态栏拿它）：只在换了标签、开关了插件时换
  return useMemo(() => {
    if (!noteId || !isNote) return [];
    return noteViewsOf(enabled).map((view) => {
      const shortcut = viewShortcut(view);
      return {
        id: view.id,
        label: `以${view.label}查看`,
        icon: view.icon,
        kbd: shortcut?.replaceAll("+", " "),
        select: () => showNoteAs({ id: tabId, noteId }, view.id),
      };
    });
  }, [enabled, tabId, noteId, isNote]);
}

export function NoteBody({
  tab,
  view,
  doc,
  focused,
  onSaveDocument,
  document,
}: {
  tab: Pick<NoteTab, "id" | "noteId">;
  view: NoteView | undefined;
  doc: DocumentModel;
  focused: boolean;
  onSaveDocument: NoteViewProps["onSaveDocument"];
  /** 文档视图（摆法是文档时画它） */
  document: ReactNode;
}) {
  const View = view ? componentOf(view) : null;
  return (
    <div className="relative h-full w-full" data-swap-host>
      <SwapFade swapKey={view ? `${view.id}:${doc.key}` : "document"} className="h-full w-full">
        {View ? (
          <Suspense fallback={<div className="h-full w-full bg-panel" />}>
            <View
              doc={doc}
              focused={focused}
              onSaveDocument={onSaveDocument}
              onExit={() => showNoteAs(tab, undefined)}
            />
          </Suspense>
        ) : (
          document
        )}
      </SwapFade>
    </div>
  );
}
