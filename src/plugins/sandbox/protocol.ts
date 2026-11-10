/* ============================================================
   插件沙箱的消息协议（docs/插件与跨端.md §5.5），宿主这一头。

   宿主和沙箱里的脚本之间只有一条 MessagePort（host.ts 在握手时交过去）。两边都能发请求：
   - 请求 { id, method, params }，回复 { id, result } 或 { id, error: { code, message } }
   - 通知 { method, params }（没有 id，不回）：订阅推过来的事（event）、取消（cancel）
   - 一次可以发一串（数组），一个微任务里攒下的合成一条发
   id 各发各的：回复只会回到发请求的那一头，两边的 id 撞了也分得开。

   取消：等不及了（超时、用户走开了）就发 { method: "cancel", params: { id } }，对面把那个请求的
   AbortSignal 拨掉、立刻回 cancelled，之后算出来的结果不再要。

   沙箱那一头是 worker.ts 里的 workerMain，照同一份协议另写了一遍（它得是自成一体的一段源码，
   见那边的说明）。这里不信任对面发来的任何东西：不合协议的丢掉、报给 onInvalid。
   ============================================================ */

export const ERROR_CODES = [
  /** 没授权（清单里没申请，或者用户没同意） */
  "denied",
  /** 这台设备、这一版没有这个能力 */
  "unavailable",
  /** 照着改的那一版已经过时了：重新读一遍再改 */
  "stale",
  /** 正忙（输入法正在组字），过一会儿再来 */
  "busy",
  "timeout",
  "cancelled",
  /** 参数不对 */
  "invalid",
  /** 没有这个方法、这篇文档、这个命令 */
  "not_found",
  /** 超了预算（调用太频繁、同时挂着的请求太多） */
  "budget",
  /** 处理的时候出错了 */
  "failed",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class RpcError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** MessagePort 的那一点（单测用一对假的） */
export interface Port {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close?(): void;
}

export interface RequestOptions {
  /** 等多久回复，毫秒；0 是一直等 */
  timeout?: number;
  signal?: AbortSignal;
}

type Handler = (params: unknown, context: { signal: AbortSignal }) => unknown;

export interface EndpointOptions {
  /** 对面发来的通知 */
  onNotice?(method: string, params: unknown): void;
  /** 不是协议里的消息（沙箱外壳自己的，带 relay 字段） */
  onOther?(message: unknown): void;
  /** 对面发来的东西不合协议 */
  onInvalid?(reason: string): void;
  /** 每来一个请求先问一声（预算）：返回 RpcError 就直接拒掉，不交给处理函数 */
  admit?(method: string): RpcError | null;
}

/** 一次最多收几条（一串里多出来的丢掉） */
const MAX_BATCH = 256;

interface Pending {
  resolve(value: unknown): void;
  reject(error: RpcError): void;
  timer: ReturnType<typeof setTimeout> | null;
  cleanup(): void;
}

/** 5 秒、0.08 秒 */
const seconds = (ms: number) => `${ms >= 1000 ? Math.round(ms / 100) / 10 : ms / 1000} 秒`;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isCode = (code: unknown): code is ErrorCode =>
  typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code);

export class Endpoint {
  private next = 1;
  private readonly pending = new Map<number, Pending>();
  /** 对面发来、还在处理的请求：取消时拨掉 */
  private readonly incoming = new Map<number, AbortController>();
  private readonly handlers = new Map<string, Handler>();
  private queue: unknown[] = [];
  private closed = false;

  constructor(
    private readonly port: Port,
    private readonly options: EndpointOptions = {},
  ) {
    port.onmessage = (event) => this.receive(event.data);
  }

  /** 还没回的请求（宿主发出去的） */
  get waiting(): number {
    return this.pending.size;
  }

  /** 对面发来、还在处理的请求 */
  get serving(): number {
    return this.incoming.size;
  }

  handle(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  request<T = unknown>(method: string, params?: unknown, options: RequestOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError("cancelled", "插件已经停了"));
    const id = this.next++;
    const { timeout = 0, signal } = options;
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new RpcError("cancelled", "取消了"));
        return;
      }
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.settle(id);
        this.notify("cancel", { id });
        reject(new RpcError("cancelled", "取消了"));
      };
      const entry: Pending = {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: null,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      if (timeout > 0) {
        entry.timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.settle(id);
          // 告诉对面别算了：它要是没卡死，就不会再白算
          this.notify("cancel", { id });
          reject(new RpcError("timeout", `${method} 过了 ${seconds(timeout)}还没回`));
        }, timeout);
      }
      signal?.addEventListener("abort", onAbort);
      this.pending.set(id, entry);
      this.send(params === undefined ? { id, method } : { id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send(params === undefined ? { method } : { method, params });
  }

  /** 停下：还没回的请求都拒掉（cancelled），对面发来的都拨掉 */
  close(message = "插件已经停了"): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.pending.keys()]) {
      const entry = this.settle(id);
      entry?.reject(new RpcError("cancelled", message));
    }
    for (const controller of this.incoming.values()) controller.abort();
    this.incoming.clear();
    this.queue = [];
    this.port.onmessage = null;
    this.port.close?.();
  }

  /** 从挂着的里拿掉（清计时器、解监听），交回它 */
  private settle(id: number): Pending | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.cleanup();
    return entry;
  }

  private send(message: unknown) {
    this.queue.push(message);
    if (this.queue.length > 1) return;
    queueMicrotask(() => {
      if (this.closed) return;
      const batch = this.queue;
      this.queue = [];
      if (!batch.length) return;
      try {
        this.port.postMessage(batch.length === 1 ? batch[0] : batch);
      } catch (error) {
        // 发不出去（结果克隆不了）：对面等不到回复，这里也报一声
        this.options.onInvalid?.(`发不出去：${error instanceof Error ? error.message : error}`);
      }
    });
  }

  private receive(data: unknown) {
    if (this.closed) return;
    if (Array.isArray(data)) {
      if (data.length > MAX_BATCH) this.options.onInvalid?.(`一次发来 ${data.length} 条，太多了`);
      for (const message of data.slice(0, MAX_BATCH)) this.one(message);
      return;
    }
    this.one(data);
  }

  private one(message: unknown) {
    if (this.closed) return;
    if (!isObject(message)) {
      this.options.onInvalid?.("消息要是一个对象");
      return;
    }
    if ("relay" in message) {
      this.options.onOther?.(message);
      return;
    }
    const { id, method } = message;
    // 回复
    if (method === undefined) {
      if (typeof id !== "number") {
        this.options.onInvalid?.("回复没有 id");
        return;
      }
      const entry = this.settle(id);
      if (!entry) return; // 超时、取消过的：晚到的回复不要了
      if (isObject(message.error)) {
        const code = isCode(message.error.code) ? message.error.code : "failed";
        const text = typeof message.error.message === "string" ? message.error.message : "出错了";
        entry.reject(new RpcError(code, text.slice(0, 500)));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (typeof method !== "string" || method.length > 64) {
      this.options.onInvalid?.("method 要是字符串");
      return;
    }
    // 通知
    if (id === undefined) {
      if (method === "cancel") {
        const target = isObject(message.params) ? message.params.id : undefined;
        if (typeof target !== "number") return;
        const controller = this.incoming.get(target);
        if (!controller) return;
        this.incoming.delete(target);
        controller.abort();
        this.reply(target, { error: { code: "cancelled", message: "取消了" } });
        return;
      }
      this.options.onNotice?.(method, message.params);
      return;
    }
    // 请求
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      this.options.onInvalid?.("请求的 id 要是正整数");
      return;
    }
    if (this.incoming.has(id)) {
      this.reply(id, { error: { code: "invalid", message: `请求 ${id} 还没处理完，id 重复了` } });
      return;
    }
    const refused = this.options.admit?.(method);
    if (refused) {
      this.reply(id, { error: { code: refused.code, message: refused.message } });
      return;
    }
    const handler = this.handlers.get(method);
    if (!handler) {
      this.reply(id, { error: { code: "not_found", message: `没有 ${method} 这个方法` } });
      return;
    }
    const controller = new AbortController();
    this.incoming.set(id, controller);
    Promise.resolve()
      .then(() => handler(message.params, { signal: controller.signal }))
      .then(
        (result) => {
          if (this.incoming.get(id) !== controller) return;
          this.incoming.delete(id);
          this.reply(id, { result: result === undefined ? null : result });
        },
        (error: unknown) => {
          if (this.incoming.get(id) !== controller) return;
          this.incoming.delete(id);
          const code = error instanceof RpcError ? error.code : "failed";
          const text = error instanceof Error ? error.message : String(error);
          this.reply(id, { error: { code, message: text } });
        },
      );
  }

  private reply(id: number, body: { result?: unknown; error?: { code: string; message: string } }) {
    this.send({ id, ...body });
  }
}
