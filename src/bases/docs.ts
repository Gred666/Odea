/* ============================================================
   视图文件要的每一篇（docs/视图文件.md §3.3）：Rust 一次给齐，这个窗口里开着的视图共用一份。

   - 第一个视图挂上时取，最后一个拆掉时不再跟着变（数据留着，下次挂上先画它、再重取）
   - 什么时候重取：vault-changed 里有笔记、插件文档变了（别处改的）；笔记多了少了（新建、删、归档）。
     标题、修改时间不重取，算的时候从笔记列表里接（query.ts 的 buildRows）
   - 要不要正文（标签、双链）：有一个视图要就带上
   - 这个窗口里改了属性（表格、属性面板）：经 properties/store 的通知改这一篇，不等 Rust
   ============================================================ */

import { backend } from "@/data/backend";
import { messageOf, useData } from "@/data/store";
import type { DocumentRef } from "@/data/types";
import type { BaseDoc } from "@/lib/bindings";
import { onPropertiesWritten, propKey } from "@/properties/store";
import { create } from "zustand";

interface DocsState {
  docs: BaseDoc[] | null;
  /** 现在这一份带没带正文（标签、双链） */
  withBody: boolean;
  error: string | null;
}

export const useBaseDocs = create<DocsState>(() => ({ docs: null, withBody: false, error: null }));

/** 挂着的视图几个、其中要正文的几个 */
let holders = 0;
let bodyHolders = 0;
let stopListening: (() => void) | null = null;
/** 取到第几次了：慢的那一次回来时已经有更新的了就不要 */
let asked = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

async function fetchDocs(): Promise<void> {
  const mine = ++asked;
  const withBody = bodyHolders > 0;
  try {
    const docs = await (await backend()).baseDocs(withBody);
    if (mine !== asked) return;
    useBaseDocs.setState({ docs, withBody, error: null });
  } catch (error) {
    if (mine === asked) useBaseDocs.setState({ error: messageOf(error) });
  }
}

/** 攒一下再取：同步、外部程序往往一下改好几篇 */
export function refreshBaseDocs(delayMs = 120): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (holders > 0) void fetchDocs();
  }, delayMs);
}

/** 笔记列表里的 id（多了、少了才重取；只是改了正文、标题不算） */
const noteIds = () => {
  const { notes, archived } = useData.getState();
  return `${notes.length}:${archived.length}:${notes.map((note) => note.id).join("|")}|${archived.map((note) => note.id).join("|")}`;
};

function listen(): () => void {
  let ids = noteIds();
  const stopData = useData.subscribe((state, previous) => {
    if (state.notes === previous.notes && state.archived === previous.archived) return;
    const next = noteIds();
    if (next === ids) return;
    ids = next;
    refreshBaseDocs();
  });
  const stopVault = backend().then((api) =>
    api.onVaultChanged((change) => {
      if (change.notes.length > 0 || change.docs.length > 0) refreshBaseDocs();
    }),
  );
  const stopWritten = onPropertiesWritten((target, props) => patchProps(target, props.text));
  return () => {
    stopData();
    stopWritten();
    void stopVault.then((unlisten) => unlisten());
  };
}

/**
 * 一个视图挂上：开始跟着变，拿一份最新的。withBody：这个视图要正文（筛选里用到标签、双链）。
 * 返回拆掉时调的
 */
export function holdBaseDocs(withBody: boolean): () => void {
  holders += 1;
  if (withBody) bodyHolders += 1;
  if (holders === 1) stopListening = listen();
  const { docs, withBody: has } = useBaseDocs.getState();
  // 第一个挂上的、或者这一份没带正文而这个视图要：取一遍（已经有的先画着）
  if (holders === 1 || !docs || (withBody && !has)) refreshBaseDocs(0);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (withBody) bodyHolders -= 1;
    if (holders === 0) {
      stopListening?.();
      stopListening = null;
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

/** 这一篇的属性原文换成 text（先改界面、写回失败退回去，都走这里） */
export function patchProps(target: DocumentRef, text: string): void {
  const docs = useBaseDocs.getState().docs;
  if (!docs) return;
  const key = propKey(target);
  const index = docs.findIndex((doc) => propKey(doc.target) === key);
  if (index < 0 || docs[index]!.props === text) return;
  const next = [...docs];
  next[index] = { ...docs[index]!, props: text };
  useBaseDocs.setState({ docs: next });
}

/** 这一篇现在的属性原文（界面上的，含还没写完的那一版） */
export function currentProps(target: DocumentRef): string | null {
  const key = propKey(target);
  return useBaseDocs.getState().docs?.find((doc) => propKey(doc.target) === key)?.props ?? null;
}
