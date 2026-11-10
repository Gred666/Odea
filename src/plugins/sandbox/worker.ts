/* ============================================================
   沙箱里插件脚本看到的 `odea`（docs/插件与跨端.md §5.5），在 iframe 另起的 Worker 里跑。

   workerMain 要自成一体：host.ts 用 toString() 把它拼成 Worker 的源码，里面不能引用这个模块外面的
   任何东西（类型除外，编译时就没了）。消息协议和宿主那一头（protocol.ts）是同一份，在这里另写一遍。

   插件的脚本（清单的 main）在宿主发来 activate 时用 importScripts 载进来，顶层同步地登记它的命令、
   槽位、订阅：

     odea.commands.register("tidy.all", async () => { … });
     odea.slots.register("tidy", {
       render(doc) { return { type: "text", text: doc.title }; },  // 交一棵组件树（views.ts），或者 null
       async onAction({ action, value, doc }) { … },
     });
     odea.documents.onChange(({ ref, revision }) => { … });

   能做的事都经宿主：documents.current / read / list / edit、slots.update、ui.notify。
   没授权的回 denied，宿主说了算；这里不是安全边界（脚本自己就能直接 postMessage），只是给插件一份好用的接口。
   ============================================================ */

/** 沙箱里那个 Worker 的全局，只用到这几样 */
export interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  importScripts(...urls: string[]): void;
  URL: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };
  Blob: typeof Blob;
  queueMicrotask(callback: () => void): void;
  addEventListener(type: string, listener: (event: never) => void): void;
  console: Pick<Console, "error" | "warn">;
  odea?: unknown;
}

export function workerMain(scope: WorkerScope): void {
  type Dict = Record<string, unknown>;
  type Handler = (params: Dict, signal: AbortSignal) => unknown;
  interface SlotHandlers {
    render(doc: unknown, context: { signal: AbortSignal }): unknown;
    onAction?(event: Dict): unknown;
  }

  const post = scope.postMessage.bind(scope);
  let nextId = 1;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const incoming = new Map<number, AbortController>();
  let queue: unknown[] = [];
  const commands = new Map<string, (context: { signal: AbortSignal }) => unknown>();
  const slots = new Map<string, SlotHandlers>();
  const deactivators: Array<() => unknown> = [];
  /** 订阅的 id → 回调 */
  const listeners = new Map<string, (data: unknown) => void>();

  const isObject = (value: unknown): value is Dict =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const textOf = (error: unknown) =>
    error instanceof Error ? error.message || error.name : String(error);
  const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

  const send = (message: unknown) => {
    queue.push(message);
    if (queue.length > 1) return;
    scope.queueMicrotask(() => {
      const batch = queue;
      queue = [];
      if (batch.length) post(batch.length === 1 ? batch[0] : batch);
    });
  };
  const notify = (method: string, params?: unknown) => send({ method, params });
  const report = (level: "error" | "warn", message: string) =>
    notify("log", { level, message: message.slice(0, 1000) });

  const request = (method: string, params?: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send(params === undefined ? { id, method } : { id, method, params });
    });

  const disposable = (dispose: () => void) => {
    let done = false;
    return {
      dispose() {
        if (done) return;
        done = true;
        dispose();
      },
    };
  };

  const subscribe = (topic: string, callback: (data: unknown) => void) => {
    if (typeof callback !== "function") throw new TypeError("要给一个回调函数");
    let id: string | null = null;
    let disposed = false;
    request("subscribe", { topic }).then(
      (result) => {
        id = String((result as Dict).subscription);
        if (disposed) {
          request("unsubscribe", { subscription: id }).catch(() => {});
          return;
        }
        listeners.set(id, callback);
      },
      (error) => report("error", `订阅 ${topic} 没成：${textOf(error)}`),
    );
    return disposable(() => {
      disposed = true;
      if (id === null) return;
      listeners.delete(id);
      request("unsubscribe", { subscription: id }).catch(() => {});
    });
  };

  const api = {
    /** 这个插件：{ id, version } */
    plugin: null as unknown,
    /** 这台设备上同意了的能力：[{ name, scope }] */
    capabilities: [] as unknown[],
    /** 宿主：{ api, platform } */
    host: null as unknown,
    documents: {
      /** 正在看的那一篇：{ ref, title, revision }，没有是 null */
      current: () => request("documents.current"),
      /** { ref, title, text, revision } */
      read: (ref: unknown) => request("documents.read", { ref }),
      /** 仓库里的笔记和日程：[{ ref, title, folder, updatedAt }]（要 documents.read: vault） */
      list: () => request("documents.list"),
      /** changes：[{ from, to, insert }]，位置按 baseRevision 那一版算。回 { revision }，过时了回 stale */
      edit: (ref: unknown, baseRevision: unknown, changes: unknown) =>
        request("documents.edit", { ref, baseRevision, changes }),
      onCurrentChange: (callback: (data: unknown) => void) =>
        subscribe("documents.current", callback),
      onChange: (callback: (data: unknown) => void) => subscribe("documents.changed", callback),
    },
    commands: {
      register(id: string, handler: (context: { signal: AbortSignal }) => unknown) {
        if (typeof handler !== "function") throw new TypeError("要给一个处理函数");
        commands.set(String(id), handler);
        return disposable(() => {
          if (commands.get(String(id)) === handler) commands.delete(String(id));
        });
      },
    },
    slots: {
      register(id: string, handlers: SlotHandlers) {
        if (!handlers || typeof handlers.render !== "function") {
          throw new TypeError("要给 { render(doc) { … } }");
        }
        slots.set(String(id), handlers);
        return disposable(() => {
          if (slots.get(String(id)) === handlers) slots.delete(String(id));
        });
      },
      /** 主动换掉某一篇上的那一段（tree 是 null 就是不显示） */
      update: (id: string, ref: unknown, tree: unknown) =>
        request("slots.update", { slot: id, ref, tree }),
      /** 只改一点（JSON Patch：add / remove / replace） */
      patch: (id: string, ref: unknown, patch: unknown) =>
        request("slots.update", { slot: id, ref, patch }),
    },
    ui: {
      /** 窗口底下的提示条 */
      notify: (text: unknown) => request("ui.notify", { text: String(text) }),
    },
    /** 停用前要做的事（收尾、交出还没交的编辑）；宿主最多等 1 秒 */
    onDeactivate(callback: () => unknown) {
      deactivators.push(callback);
      return disposable(() => {
        const at = deactivators.indexOf(callback);
        if (at >= 0) deactivators.splice(at, 1);
      });
    },
  };
  scope.odea = api;

  const handlers: Record<string, Handler> = {
    activate(params) {
      api.plugin = params.plugin;
      api.capabilities = Array.isArray(params.capabilities) ? params.capabilities : [];
      api.host = params.host;
      const url = scope.URL.createObjectURL(
        new scope.Blob([String(params.code)], { type: "text/javascript" }),
      );
      try {
        scope.importScripts(url);
      } catch (error) {
        throw failure("failed", `脚本出错了：${textOf(error)}`);
      } finally {
        scope.URL.revokeObjectURL(url);
      }
      return { commands: [...commands.keys()], slots: [...slots.keys()] };
    },
    async deactivate() {
      for (const callback of deactivators.splice(0).reverse()) {
        try {
          await callback();
        } catch (error) {
          report("error", `停用时出错了：${textOf(error)}`);
        }
      }
      return null;
    },
    async "commands.run"(params, signal) {
      const handler = commands.get(String(params.command));
      if (!handler) throw failure("not_found", `脚本里没有登记命令 ${params.command}`);
      await handler({ signal });
      return null;
    },
    async "slots.render"(params, signal) {
      const slot = slots.get(String(params.slot));
      if (!slot) return null;
      const tree = await slot.render(params.doc, { signal });
      return tree ?? null;
    },
    async "slots.action"(params, signal) {
      const slot = slots.get(String(params.slot));
      if (!slot?.onAction) throw failure("not_found", `槽位 ${params.slot} 没有 onAction`);
      await slot.onAction({
        action: params.action,
        value: params.value,
        form: params.form,
        doc: params.doc,
        signal,
      });
      return null;
    },
    ping: () => "pong",
  };

  const reply = (id: number, body: Dict) => send({ id, ...body });

  const handle = (message: unknown) => {
    if (!isObject(message)) return;
    const { id, method } = message;
    if (method === undefined) {
      const entry = typeof id === "number" ? pending.get(id) : undefined;
      if (!entry) return;
      pending.delete(id as number);
      if (isObject(message.error)) {
        entry.reject(failure(String(message.error.code), String(message.error.message)));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (id === undefined) {
      const params = isObject(message.params) ? message.params : {};
      if (method === "event") {
        const listener = listeners.get(String(params.subscription));
        if (!listener) return;
        try {
          listener(params.data);
        } catch (error) {
          report("error", `订阅的回调出错了：${textOf(error)}`);
        }
      } else if (method === "cancel" && typeof params.id === "number") {
        const controller = incoming.get(params.id);
        if (!controller) return;
        incoming.delete(params.id);
        controller.abort();
        reply(params.id, { error: { code: "cancelled", message: "取消了" } });
      }
      return;
    }
    if (typeof id !== "number") return;
    const handler = handlers[String(method)];
    if (!handler) {
      reply(id, { error: { code: "not_found", message: `沙箱里没有 ${method}` } });
      return;
    }
    const controller = new AbortController();
    incoming.set(id, controller);
    Promise.resolve()
      .then(() => handler(isObject(message.params) ? message.params : {}, controller.signal))
      .then(
        (result) => {
          if (incoming.get(id) !== controller) return;
          incoming.delete(id);
          reply(id, { result: result === undefined ? null : result });
        },
        (error: unknown) => {
          if (incoming.get(id) !== controller) return;
          incoming.delete(id);
          const code = isObject(error) && typeof error.code === "string" ? error.code : "failed";
          reply(id, { error: { code, message: textOf(error) } });
        },
      );
  };

  scope.onmessage = (event) => {
    const data = event.data;
    if (Array.isArray(data)) for (const message of data) handle(message);
    else handle(data);
  };

  // 脚本自己没接住的错：转给宿主，扩展页上列出来
  scope.addEventListener("error", ((event: { message?: string }) =>
    report("error", String(event.message ?? "脚本出错了"))) as (event: never) => void);
  scope.addEventListener("unhandledrejection", ((event: { reason?: unknown }) =>
    report("error", `没接住的 Promise：${textOf(event.reason)}`)) as (event: never) => void);
  for (const level of ["error", "warn"] as const) {
    const original = scope.console[level].bind(scope.console);
    scope.console[level] = (...args: unknown[]) => {
      original(...args);
      report(level, args.map((arg) => (typeof arg === "string" ? arg : textOf(arg))).join(" "));
    };
  }
}
