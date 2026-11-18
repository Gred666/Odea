/* ============================================================
   在视图里改一篇的属性（docs/视图文件.md §3.7）：和属性面板同一套 ——
   properties/yaml.ts 只换那一条的那几行（没有就加在最后），doc_set_properties 写回（核对、正文不动）。

   先改界面上的数，Rust 写好了换成它回的那一版、告诉属性面板；失败了退回去、抛给调用的说为什么。
   同一篇连着改几次一次一次排着写，每次都在上一次的结果上改
   ============================================================ */

import { backend } from "@/data/backend";
import type { DocumentRef } from "@/data/types";
import { announceProperties, invalidateCatalog, propKey } from "@/properties/store";
import {
  type Kind,
  appendEntry,
  entryLines,
  parse,
  replaceEntry,
  valueFits,
} from "@/properties/yaml";
import { currentProps, patchProps, refreshBaseDocs } from "./docs";

const queues = new Map<string, Promise<unknown>>();

/** 一篇的属性原文里，key 这一条换成 value（没有这一条就加上） */
export function withValue(text: string, key: string, kind: Kind, value: string | string[]): string {
  const parsed = parse(text);
  const entry = parsed.entries.find((item) => item.key === key);
  // 类型对不上的值照文字写（同属性面板：改完的值这种类型读得了就照它写，读不了照文字）
  const as = typeof value === "string" && !valueFits(value, kind) ? "text" : kind;
  if (!entry) return appendEntry(parsed, entryLines(key, as, value));
  return replaceEntry(parsed, entry, entryLines(key, as, value, entry.flow));
}

/**
 * 改一篇的一个属性。失败了退回改之前的样子、抛出去（调用的在视图顶上说为什么）
 */
export function writeProperty(
  target: DocumentRef,
  key: string,
  kind: Kind,
  value: string | string[],
): Promise<void> {
  const id = propKey(target);
  const before = currentProps(target);
  if (before === null) return Promise.reject(new Error("这一篇不在了"));
  const next = withValue(before, key, kind, value);
  if (next === before) return Promise.resolve();
  patchProps(target, next);
  const run = (queues.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      try {
        const saved = await (await backend()).docSetProperties(target, next);
        // 后面又排了一次：界面上已经是更新的那一版，等最后一次写完再换
        if (currentProps(target) === next) patchProps(target, saved.text);
        announceProperties(target, saved);
        invalidateCatalog();
        // 标签变了：Rust 那边认的标签（file.tags、hasTag）要重取
        if (/^tags?$/i.test(key)) refreshBaseDocs();
      } catch (error) {
        if (currentProps(target) === next) patchProps(target, before);
        throw error;
      }
    });
  queues.set(id, run);
  const settle = () => {
    if (queues.get(id) === run) queues.delete(id);
  };
  run.then(settle, settle);
  return run;
}
