/* ============================================================
   一个开着的视图文件（docs/视图文件.md §3.2、§3.8）：读、改、写回、别处改了跟上。

   - 界面上的改动先换到界面上（在当前的全文上做那一处改动），再排着写回；写的时候带着磁盘上那一版的指纹
   - 别处改过了（Rust 回 bases::STALE）：重读，把还没写下去的改动在新的那一版上再做一遍，再写。
     改动都是「某个视图的某个键换成某个值」（config.ts 的 BaseEdit），重做一遍不会错。
     「源码」整份换掉的那种不重做：说一声、换成磁盘上的
   - 别处改了这个文件（树上的修改时间变了）：没在写的时候重读；和磁盘上的那一版一样就什么都不动
   ============================================================ */

import { backend } from "@/data/backend";
import { messageOf, useData } from "@/data/store";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type BaseEdit, type BaseFile, editBase, readBase } from "./config";

/** 别处改过了（同 Rust 的 bases::STALE） */
const STALE = "这个视图文件在别处改过了";

/** 一处改动：在 Document 上改一个键（能在新的那一版上重做），或者整份换掉（源码） */
type Change = { edit: BaseEdit } | { replace: string };

const apply = (text: string, change: Change) =>
  "replace" in change ? change.replace : editBase(text, change.edit);

export interface OpenBase {
  /** 界面上的全文（含还没写完的改动）；还没读到是 null */
  text: string | null;
  file: BaseFile | null;
  /** 不在了（删了、挪走了） */
  missing: boolean;
  /** 读、写失败的原因（顶上说一句） */
  error: string | null;
  clearError: () => void;
  /** 改一个键（筛选、排序、分组、列……） */
  edit: (edit: BaseEdit) => void;
  /** 「源码」：整份换掉 */
  replace: (text: string) => void;
}

/**
 * 每个视图文件磁盘上最后那一版（这个窗口里读到、写下的）：换个标签再回来先画它，同时再读一遍。
 * 只是个快照，不当真相：写的时候照样带指纹核对
 */
const lastRead = new Map<string, { text: string; fingerprint: string }>();

export function useBaseFile(relPath: string): OpenBase {
  const [text, setText] = useState<string | null>(() => lastRead.get(relPath)?.text ?? null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 磁盘上的那一版（最后一次读到、写下的）；换了就记进 lastRead */
  const diskRef = useRef<{ text: string; fingerprint: string } | null>(
    lastRead.get(relPath) ?? null,
  );
  const disk = useMemo(
    () => ({
      get current() {
        return diskRef.current;
      },
      set current(value) {
        diskRef.current = value;
        if (value) lastRead.set(relPath, value);
      },
    }),
    [relPath],
  );
  const pending = useRef<Change[]>([]);
  const writing = useRef(false);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    try {
      const fresh = await (await backend()).baseRead(relPath);
      if (!alive.current) return;
      disk.current = fresh;
      setMissing(false);
      // 自己还有没写下去的：写完会对一遍
      if (!writing.current && pending.current.length === 0) setText(fresh.text);
    } catch (cause) {
      if (!alive.current) return;
      const notFound = (cause as { kind?: string })?.kind === "NotFound";
      if (notFound) setMissing(true);
      else setError(messageOf(cause));
    }
  }, [relPath, disk]);

  useEffect(() => {
    alive.current = true;
    pending.current = [];
    setMissing(false);
    setError(null);
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  // 别处改了这个文件：树上的修改时间变了（vault-changed 带 folders，store 重取树上的文件）
  const stamp = useData((s) => s.files.find((file) => file.relPath === relPath)?.updatedAt);
  const firstStamp = useRef(stamp);
  useEffect(() => {
    if (stamp === firstStamp.current) return;
    firstStamp.current = stamp;
    if (!writing.current && pending.current.length === 0) void reload();
  }, [stamp, reload]);

  const flush = useCallback(async () => {
    if (writing.current) return;
    writing.current = true;
    const api = await backend();
    try {
      while (pending.current.length > 0 && alive.current) {
        const changes = pending.current.splice(0);
        let base = disk.current;
        if (!base) break;
        let next = changes.reduce(apply, base.text);
        try {
          disk.current = await api.baseWrite(relPath, next, base.fingerprint);
        } catch (cause) {
          if (messageOf(cause) !== STALE) throw cause;
          // 别处改过了：在新的那一版上再做一遍（整份换掉的不重做）
          base = await api.baseRead(relPath);
          disk.current = base;
          if (changes.some((change) => "replace" in change)) {
            throw new Error("这个视图文件在别处改过了，源码里改的没存，换成了现在的样子");
          }
          next = changes.reduce(apply, base.text);
          disk.current = await api.baseWrite(relPath, next, base.fingerprint);
        }
      }
    } catch (cause) {
      pending.current = [];
      if (alive.current) setError(messageOf(cause));
    } finally {
      writing.current = false;
      // 写完了（或者失败了）：界面换成磁盘上的；排着的还有就接着写
      if (alive.current && disk.current) {
        const shown = pending.current.reduce(apply, disk.current.text);
        setText(shown);
        if (pending.current.length > 0) void flush();
      }
    }
  }, [relPath, disk]);

  // 界面上的全文：连着改两处时第二处要在第一处的结果上改，等不到下一次渲染
  const shownRef = useRef(text);
  shownRef.current = text;
  const change = useCallback(
    (next: Change) => {
      const current = shownRef.current;
      if (current === null) return;
      let shown: string;
      try {
        shown = apply(current, next);
      } catch (cause) {
        setError(messageOf(cause));
        return;
      }
      pending.current.push(next);
      shownRef.current = shown;
      setText(shown);
      setError(null);
      void flush();
    },
    [flush],
  );

  const file = useMemo(() => (text === null ? null : readBase(text)), [text]);
  return {
    text,
    file,
    missing,
    error,
    clearError: () => setError(null),
    edit: (edit) => change({ edit }),
    replace: (replacement) => change({ replace: replacement }),
  };
}
