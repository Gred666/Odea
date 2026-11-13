import type { DocumentRef } from "@/data/types";
import type { PropertyCatalog } from "@/lib/bindings";
import { create } from "zustand";

/* ============================================================
   属性面板（docs/提醒与属性.md §3）在窗口里共用的几样：

   - 每篇的属性（缓存）：取笔记时一起来的先放进来（data/backend 的 noteGet），面板第一帧就有，
     不会先空着、等它到了正文再往下跳
   - 整个仓库的属性一览：加属性、填值时的提示，空着的值认类型。第一次要用时取，改过以后再取
   - 显示成面板还是源码（本机偏好）
   - 「添加属性」（命令面板、Ctrl+;）交给正在写的那一篇的面板
   ============================================================ */

export interface DocProps {
  text: string;
  editable: boolean;
}

export const propKey = (target: DocumentRef) => `${target.type}:${target.key}`;

const cache = new Map<string, DocProps>();

export function primeProperties(target: DocumentRef, text: string, editable = true): void {
  cache.set(propKey(target), { text, editable });
}

export function cachedProperties(target: DocumentRef): DocProps | null {
  return cache.get(propKey(target)) ?? null;
}

/* ---------------- 整个仓库的一览 ---------------- */

interface CatalogState {
  catalog: PropertyCatalog | null;
  /** 改过属性以后：下一次要用时重取 */
  stale: boolean;
}

export const useCatalog = create<CatalogState>(() => ({ catalog: null, stale: true }));

let loading: Promise<void> | null = null;

export function loadCatalog(): Promise<void> {
  if (!useCatalog.getState().stale) return Promise.resolve();
  loading ??= (async () => {
    try {
      const { backend } = await import("@/data/backend");
      const catalog = await (await backend()).propertyCatalog();
      useCatalog.setState({ catalog, stale: false });
    } catch {
      /* 取不到就没有提示，面板照样能用 */
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export function invalidateCatalog(): void {
  useCatalog.setState({ stale: true });
}

/** 记着的类型（面板里改过「这个键是什么类型」） */
export function setRecordedTypes(types: Record<string, string>): void {
  const catalog = useCatalog.getState().catalog;
  useCatalog.setState({ catalog: catalog ? { ...catalog, types } : { keys: [], types } });
}

/* ---------------- 面板还是源码 ---------------- */

const LS_KEY = "odea.properties";

function loadView(): boolean {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? "{}").source === true;
  } catch {
    return false;
  }
}

export const usePropertyView = create<{ source: boolean }>(() => ({ source: loadView() }));

export function setPropertySource(source: boolean): void {
  usePropertyView.setState({ source });
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ source }));
  } catch {
    /* 隐私模式：这一次记着就行 */
  }
}

/* ---------------- 添加属性 ---------------- */

/** 哪一篇要加属性（at 让同一篇连着要两次也认得出是新的一次） */
export const useAddRequest = create<{ key: string | null; at: number }>(() => ({
  key: null,
  at: 0,
}));

export function requestAddProperty(target: DocumentRef): void {
  useAddRequest.setState({ key: propKey(target), at: Date.now() });
}
