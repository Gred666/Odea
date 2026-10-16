import { useEffect, useState } from "react";
import { backend } from "./backend";
import type { FindOptions, FindResult, TextSearch } from "./types";

/* ============================================================
   在正文里搜（Rust 的 search_text）：命令面板、归档的搜索框。

   前端不留每篇笔记的全文（store 的 bodies 只有最近打开的几篇），搜正文都交给 Rust
   在索引里扫。异步回来：给出去的是「最后一次搜完的」—— 搜的哪个词连同结果一起，
   调用方按那一次的词把整张列表一起换掉，不会一半是新词的结果、一半是旧词的。
   打字时每个字都发一次，Rust 那边新的会顶掉还在扫的旧的，这边也只认最后一次。
   ============================================================ */

export interface TextSearchDone {
  /** 搜的是哪个词（trim 过） */
  query: string;
  result: TextSearch;
}

const EMPTY: TextSearch = { notes: [], journal: [] };

export function useTextSearch(
  query: string,
  limit: number,
  archivedOnly = false,
): TextSearchDone | null {
  const [done, setDone] = useState<TextSearchDone | null>(null);
  const q = query.trim();
  useEffect(() => {
    if (!q) {
      setDone(null);
      return;
    }
    let current = true;
    void backend()
      .then((api) => api.searchText(q, limit, archivedOnly))
      .catch(() => EMPTY)
      .then((result) => {
        if (current) setDone({ query: q, result });
      });
    return () => {
      current = false;
    };
  }, [q, limit, archivedOnly]);
  return done;
}

/* ============================================================
   全局搜索（Rust 的 find_in_vault，components/FindDialog.tsx）：每一处命中，带三个开关。
   查询不 trim（搜行首的空格也是正经需求，VS Code 也不 trim）。enabled 为 false（对话框关着）时不搜，
   留着上一次的结果：再打开先看到它，新的回来再换；打开那一下会重搜一次，关着的时候可能改过东西。
   ============================================================ */

export interface FindDone {
  query: string;
  options: FindOptions;
  result: FindResult;
}

const EMPTY_FIND: FindResult = { files: [], total: 0, truncated: false, error: null };

export function useFindInVault(
  query: string,
  options: FindOptions,
  enabled: boolean,
): FindDone | null {
  const [done, setDone] = useState<FindDone | null>(null);
  const { caseSensitive, wholeWord, regex } = options;
  useEffect(() => {
    if (!enabled) return;
    if (!query) {
      setDone(null);
      return;
    }
    let current = true;
    const asked = { caseSensitive, wholeWord, regex };
    void backend()
      .then((api) => api.findInVault(query, asked))
      .catch(() => EMPTY_FIND)
      .then((result) => {
        if (current) setDone({ query, options: asked, result });
      });
    return () => {
      current = false;
    };
  }, [query, caseSensitive, wholeWord, regex, enabled]);
  return done;
}
