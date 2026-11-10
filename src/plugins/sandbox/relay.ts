/* ============================================================
   沙箱 iframe 里的中转（docs/插件与跨端.md §5.5）。

   插件的脚本不在 iframe 的主线程上跑，跑在 iframe 里另起的一个 Worker 里：
   - 死循环、长计算卡住的只是那个 Worker 的线程。WKWebView、WebView2 里 iframe 和页面多半在
     同一个线程上（§5.5「主线程的问题」），脚本要是跑在 iframe 的主线程上，一个 while(true) 整个应用就不动了
   - Worker 碰不到 DOM，也就改不了 iframe 自己的地址（sandbox 拦不住 iframe 导航自己，CSP 也不管导航，
     在 iframe 主线程上的脚本能把数据拼进地址带出去）
   - Worker 是从 blob 地址起的，继承 iframe 的 opaque origin 和 CSP：网络照样全关着

   这一段就是 iframe 主线程上全部的事：起 Worker，把宿主的 MessagePort 和 Worker 接起来，
   Worker 一秒发太多条就把它掐掉（宿主那边的主线程扛不住），Worker 自己的报错转给宿主。

   relayMain、relayEnv 都要自成一体：host.ts 用 toString() 把它们拼成一段源码交给 iframe，
   里面不能引用这个模块外面的任何东西。
   ============================================================ */

export interface RelayLimits {
  /** Worker 一秒最多往外发几条（一串算一条）；超了掐掉 */
  messagesPerSecond: number;
}

export interface RelayBoot {
  /** Worker 的源码（worker.ts 的 workerMain 拼出来的） */
  worker: string;
  limits: RelayLimits;
}

/** iframe 那一头的 MessagePort 的那一点 */
export interface RelayPort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface RelayWorker {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror:
    | ((event: {
        message?: string;
        lineno?: number;
        colno?: number;
        preventDefault?: () => void;
      }) => void)
    | null;
  onmessageerror: ((event: unknown) => void) | null;
}

export interface RelayEnv {
  now(): number;
  createWorker(source: string): RelayWorker;
}

/** 发给宿主的外壳消息（带 relay 字段，protocol.ts 的 onOther 收） */
export type RelayMessage =
  | { relay: "started" }
  | { relay: "fatal"; reason: "no-worker" | "flood"; message: string }
  | { relay: "error"; message: string; line?: number; column?: number };

export function relayMain(boot: RelayBoot, port: RelayPort, env: RelayEnv): void {
  let worker: RelayWorker;
  try {
    worker = env.createWorker(boot.worker);
  } catch (error) {
    port.postMessage({
      relay: "fatal",
      reason: "no-worker",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const limit = boot.limits.messagesPerSecond;
  let windowStart = env.now();
  let count = 0;
  let dead = false;
  const kill = (message: string) => {
    if (dead) return;
    dead = true;
    worker.terminate();
    port.onmessage = null;
    port.postMessage({ relay: "fatal", reason: "flood", message });
  };
  worker.onmessage = (event) => {
    if (dead) return;
    const now = env.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    if (count > limit) {
      kill(`一秒发了 ${limit} 条以上的消息`);
      return;
    }
    port.postMessage(event.data);
  };
  worker.onerror = (event) => {
    // 不往 iframe 的控制台里再抛一遍（宿主那边会记下来）
    event.preventDefault?.();
    if (dead) return;
    port.postMessage({
      relay: "error",
      message: String(event.message ?? "脚本出错了").slice(0, 1000),
      line: event.lineno,
      column: event.colno,
    });
  };
  worker.onmessageerror = () => {
    if (!dead) port.postMessage({ relay: "error", message: "收到一条读不出来的消息" });
  };
  port.onmessage = (event) => {
    if (!dead) worker.postMessage(event.data);
  };
  port.postMessage({ relay: "started" });
}

/** iframe 里真的那一份环境：Worker 从 blob 地址起（继承 iframe 的 opaque origin 和 CSP） */
export function relayEnv(): RelayEnv {
  return {
    now: () => Date.now(),
    createWorker(source) {
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      const worker = new Worker(url);
      // 马上撤掉有的内核会读不到；Worker 起来要不了这么久
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return worker as unknown as RelayWorker;
    },
  };
}
