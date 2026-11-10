import type { DocumentRef } from "@/data/types";
import type { EditOutcome } from "@/lib/liveDocuments";
import type { Port } from "./protocol";
import type { DocInfo, RuntimeHost, SandboxFactory } from "./runtime";
import type { ViewNode } from "./views";
import { type WorkerScope, workerMain } from "./worker";

/* ============================================================
   单测用：在进程里跑沙箱。

   真的沙箱是 iframe 里的 Worker（host.ts），单测里没有。这里拿一对假的 MessagePort（异步投递、
   structuredClone，和真的一样不共享对象）一头交给宿主，一头接上真的 workerMain —— 宿主、协议、
   插件看到的 odea 都是真的，只有隔离是假的。隔离本身在真的 Chrome / WebView2 里测
   （scripts/perf/plugin-sandbox.mjs）。
   ============================================================ */

/** 一对假的 MessagePort：发出去的下一个宏任务才到，内容是克隆的 */
export function channel(): [Port, Port] {
  let closed = false;
  const make = (): Port => ({
    onmessage: null,
    postMessage(message) {
      if (closed) return;
      const data = structuredClone(message);
      setTimeout(() => {
        if (!closed) other(this).onmessage?.({ data });
      });
    },
    close() {
      closed = true;
    },
  });
  const a = make();
  const b = make();
  const other = (port: Port) => (port === a ? b : a);
  return [a, b];
}

class FakeBlob {
  readonly text: string;
  constructor(parts: unknown[]) {
    this.text = parts.map(String).join("");
  }
}

/** Worker 的全局：importScripts 就地执行（插件的脚本里的 odea、self 指向这里） */
export function workerScope(port: Port): WorkerScope {
  const blobs = new Map<string, string>();
  let next = 0;
  const scope: WorkerScope = {
    postMessage: (message) => port.postMessage(message),
    get onmessage() {
      return port.onmessage;
    },
    set onmessage(listener) {
      port.onmessage = listener;
    },
    importScripts(...urls) {
      for (const url of urls) {
        const code = blobs.get(url);
        if (code === undefined) throw new Error(`读不到 ${url}`);
        new Function("odea", "self", code)(scope.odea, scope);
      }
    },
    URL: {
      createObjectURL(blob) {
        next += 1;
        const url = `blob:test/${next}`;
        blobs.set(url, (blob as unknown as FakeBlob).text);
        return url;
      },
      revokeObjectURL(url) {
        blobs.delete(url);
      },
    },
    Blob: FakeBlob as unknown as typeof Blob,
    queueMicrotask: (callback) => queueMicrotask(callback),
    addEventListener() {},
    console: { error() {}, warn() {} },
  };
  return scope;
}

/** 在进程里起沙箱；stats 数起了几个、拆了几个（停用后不留残留） */
export function inProcessSandbox() {
  const stats = { created: 0, disposed: 0 };
  const factory: SandboxFactory = async () => {
    stats.created += 1;
    const [host, worker] = channel();
    workerMain(workerScope(worker));
    let done = false;
    return {
      port: host,
      dispose() {
        if (done) return;
        done = true;
        stats.disposed += 1;
        host.close?.();
      },
    };
  };
  return { factory, stats };
}

interface FakeDoc {
  title: string;
  text: string;
  visible: boolean;
  revision: number;
}

/** 假的应用：几篇笔记，哪几篇看得见，按修订号改 */
export function fakeHost(docs: Record<string, { title: string; text: string; visible?: boolean }>) {
  const store = new Map<string, FakeDoc>(
    Object.entries(docs).map(([key, doc]) => [
      key,
      { title: doc.title, text: doc.text, visible: doc.visible ?? true, revision: 0 },
    ]),
  );
  const currentListeners = new Set<(doc: DocInfo | null) => void>();
  const changeListeners = new Set<(doc: DocInfo) => void>();
  const notices: string[] = [];
  const slots = new Map<string, ViewNode | null>();
  const info = (key: string): DocInfo => {
    const doc = store.get(key)!;
    return { ref: { type: "note", key }, title: doc.title, revision: `${key}.${doc.revision}` };
  };
  const visible = (ref: DocumentRef) => ref.type === "note" && !!store.get(ref.key)?.visible;
  let current: string | null = [...store.entries()].find(([, doc]) => doc.visible)?.[0] ?? null;

  const host: RuntimeHost = {
    current: () => (current ? info(current) : null),
    isVisible: visible,
    async read(ref) {
      const doc = ref.type === "note" ? store.get(ref.key) : undefined;
      return doc ? { ...info(ref.key), text: doc.text } : null;
    },
    list: () =>
      [...store.entries()].map(([key, doc]) => ({
        ref: { type: "note", key },
        title: doc.title,
        folder: "",
        updatedAt: 0,
        archived: false,
      })),
    edit(ref, base, changes): EditOutcome | null {
      const doc = store.get(ref.key);
      if (!doc || !doc.visible) return null;
      if (base !== `${ref.key}.${doc.revision}`) {
        return { ok: false, code: "stale", message: "过时了" };
      }
      let text = doc.text;
      for (const change of [...(changes as { from: number; to: number; insert: string }[])].sort(
        (a, b) => b.from - a.from,
      )) {
        text = text.slice(0, change.from) + change.insert + text.slice(change.to);
      }
      doc.text = text;
      doc.revision += 1;
      return { ok: true, revision: `${ref.key}.${doc.revision}` };
    },
    notify: (text) => notices.push(text),
    onCurrentChange(listener) {
      currentListeners.add(listener);
      return () => currentListeners.delete(listener);
    },
    onDocumentChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    pushSlot(slot, ref, tree) {
      slots.set(`${slot}\n${ref.key}`, tree);
    },
    slotTree: (slot, ref) => slots.get(`${slot}\n${ref.key}`) ?? null,
  };

  return {
    host,
    notices,
    slots,
    text: (key: string) => store.get(key)!.text,
    /** 用户在这一篇里打了字 */
    type(key: string, text: string) {
      const doc = store.get(key)!;
      doc.text = text;
      doc.revision += 1;
      for (const listener of changeListeners) listener(info(key));
    },
    /** 换到另一篇 */
    focus(key: string | null) {
      current = key;
      for (const listener of currentListeners) listener(key ? info(key) : null);
    },
    /** 宿主这边挂着的监听（停用后应该是 0） */
    listeners: () => currentListeners.size + changeListeners.size,
  };
}

/** 等到条件成立（异步投递的消息要几个宏任务才到） */
export async function until(check: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("等不到");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
