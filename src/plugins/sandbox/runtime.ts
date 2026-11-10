import type { DocumentRef } from "@/data/types";
import {
  type Capability,
  PLUGIN_API,
  type PluginManifest,
  capabilityKey,
} from "@/extensions/manifest";
import type { EditOutcome } from "@/lib/liveDocuments";
import { Endpoint, type Port, RpcError } from "./protocol";
import type { RelayMessage } from "./relay";
import { ViewError, type ViewNode, applyPatch, validateView } from "./views";

/* ============================================================
   一个 L1 插件跑起来以后（docs/插件与跨端.md §5.4、§5.5）：生命周期、资源作用域、能力、预算。

   生命周期：idle →（用到了）starting → running → 停用时先问它一声（deactivate，最多等 1 秒）再拆。
   拆就是把这个插件名下的东西一次撤掉：订阅、心跳、还没回的请求、消息端口，最后整个 iframe 拿掉，
   Worker 和它里面的计时器、没跑完的循环也就跟着没了。槽位里画着的东西由 scripted.ts 看状态撤掉。

   能力：插件发来的每一个请求，宿主按 iframe（也就是这个运行时）认是哪个插件，再看这台设备上
   同意了哪几项（清单里没申请的、用户没同意的都回 denied）。插件自己说自己是谁不算数。

   预算（§5.4）：
   - 宿主问插件的每一次（命令、槽位、点了按钮、心跳）都有超时，默认 5 秒
   - 插件一分钟最多调 1200 次，同时挂着的最多 32 个，订阅最多 16 个，提示条一分钟最多 5 条
   - 超时、超了一分钟的次数，各算一次「犯规」：第一次在提示条里警告，第二次就停下它（不改仓库里的开关，
     扩展页里能重新启动）。iframe 里的中转发现 Worker 刷屏会直接掐掉
   插件出错、卡死都不挡住打开文档：宿主从来不在打开文档的路上等插件，槽位晚到、不到都只是那一段空着。
   ============================================================ */

/** 一篇文档给插件看的样子 */
export interface DocInfo {
  ref: DocumentRef;
  title: string;
  /** 修订号：documents.edit 照着它改 */
  revision: string;
}

export interface DocRead extends DocInfo {
  text: string;
}

export interface DocListing {
  ref: DocumentRef;
  title: string;
  /** 所在的文件夹（相对仓库） */
  folder: string;
  updatedAt: number;
  archived: boolean;
}

/** 运行时从应用拿的东西（scripted.ts 接到真的文档上，单测给假的） */
export interface RuntimeHost {
  /** 正在写的那一篇 */
  current(): DocInfo | null;
  /** 这一篇看不看得见（能力的 current 范围） */
  isVisible(ref: DocumentRef): boolean;
  /** 读一篇；没有是 null。看得见的从编辑器里读实时的 */
  read(ref: DocumentRef): Promise<DocRead | null>;
  list(): DocListing[];
  /** 改一篇看得见的；它没在编辑器里开着是 null */
  edit(ref: DocumentRef, base: string, changes: unknown): EditOutcome | null;
  notify(text: string): void;
  /** 正在写的换了一篇 */
  onCurrentChange(listener: (doc: DocInfo | null) => void): () => void;
  /** 看得见的某一篇改完了（打字停下来） */
  onDocumentChange(listener: (doc: DocInfo) => void): () => void;
  /** 插件主动换某一篇上的槽位（已经校验过） */
  pushSlot(slot: string, ref: DocumentRef, tree: ViewNode | null): void;
  /** 某一篇上那个槽位现在画的那一棵（JSON Patch 在它上面改） */
  slotTree(slot: string, ref: DocumentRef): ViewNode | null;
}

export interface SandboxHandle {
  port: Port;
  dispose(): void;
}

export type SandboxFactory = (manifest: PluginManifest) => Promise<SandboxHandle>;

export type RuntimeStatus =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "running" }
  /** 启动没成：脚本抛错、沙箱起不来 */
  | { state: "failed"; message: string }
  /** 宿主停下了它：卡住、太频繁、刷屏 */
  | { state: "stopped"; message: string };

export interface RuntimeEvents {
  onStatus(status: RuntimeStatus): void;
  /** 插件自己报的错、没接住的异常 */
  onLog(level: "error" | "warn", message: string): void;
  /** 第一次犯规：提示条里说一声 */
  onWarn(message: string): void;
}

export const LIMITS = {
  callTimeout: 5000,
  activateTimeout: 10_000,
  deactivateTimeout: 1000,
  pingInterval: 10_000,
  callsPerMinute: 1200,
  inFlight: 32,
  subscriptions: 16,
  noticesPerMinute: 5,
  noticeLength: 200,
  /** 第几次犯规停下它 */
  strikes: 2,
  /** iframe 里的中转：Worker 一秒最多发几条 */
  messagesPerSecond: 2000,
};
export type Limits = typeof LIMITS;

const CAPABILITY_LABEL: Record<string, string> = {
  "documents.read": "读文档",
  "documents.edit": "改文档",
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** 插件交来的文档引用：{ type, key } */
function refOf(value: unknown): DocumentRef {
  const ref = isObject(value) ? value : null;
  if (
    !ref ||
    typeof ref.type !== "string" ||
    typeof ref.key !== "string" ||
    !ref.type ||
    ref.type.length > 64 ||
    ref.key.length > 512
  ) {
    throw new RpcError("invalid", "ref 要是 documents.current / read / list 给的 { type, key }");
  }
  return { type: ref.type, key: ref.key };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class PluginRuntime {
  status: RuntimeStatus = { state: "idle" };
  private endpoint: Endpoint | null = null;
  private sandbox: SandboxHandle | null = null;
  private starting: Promise<void> | null = null;
  /** 每启动、停一次加一：前一次还没跑完的异步结果认得出是过时的 */
  private generation = 0;
  private subscriptions = new Map<string, () => void>();
  private nextSubscription = 1;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private strikes = 0;
  private calls = { windowStart: 0, count: 0, over: false };
  private notices: number[] = [];
  private readonly granted: Set<string>;

  constructor(
    readonly manifest: PluginManifest,
    private readonly code: string,
    granted: readonly string[],
    private readonly host: RuntimeHost,
    private readonly createSandbox: SandboxFactory,
    private readonly events: RuntimeEvents,
    private readonly limits: Limits = LIMITS,
  ) {
    this.granted = new Set(granted);
  }

  get id(): string {
    return this.manifest.id;
  }

  /** 同意了的那几项（交给插件的 odea.capabilities） */
  grantedCapabilities(): Capability[] {
    return (this.manifest.capabilities ?? []).filter((capability) =>
      this.granted.has(capabilityKey(capability)),
    );
  }

  /** 用到了：起来（起着的、正在起的照旧）。启动失败、被停下的不自己再起，要 restart */
  start(): Promise<void> {
    const { state } = this.status;
    if (state === "running") return Promise.resolve();
    if (this.starting) return this.starting;
    if (state === "failed" || state === "stopped") {
      return Promise.reject(new Error(this.status.message));
    }
    const generation = ++this.generation;
    const starting = this.boot(generation).finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  /** 扩展页的「重新启动」：犯规次数清零 */
  restart(): Promise<void> {
    this.teardown();
    this.strikes = 0;
    this.setStatus({ state: "idle" });
    return this.start();
  }

  /** 停用：先问它一声（交出还没交的东西），最多等 1 秒，然后拆 */
  async stop(): Promise<void> {
    const generation = ++this.generation;
    const endpoint = this.endpoint;
    this.starting = null;
    if (endpoint && this.status.state === "running") {
      try {
        await endpoint.request("deactivate", undefined, {
          timeout: this.limits.deactivateTimeout,
        });
      } catch {
        // 不回、出错都照样拆
      }
    }
    if (generation !== this.generation) return;
    this.teardown();
    this.setStatus({ state: "idle" });
  }

  /** 宿主停下它（犯规、刷屏）：立刻拆 */
  kill(message: string): void {
    this.generation += 1;
    this.starting = null;
    this.teardown();
    this.setStatus({ state: "stopped", message });
  }

  /** 跑一条命令（贡献点 commands） */
  async runCommand(command: string): Promise<void> {
    await this.call("commands.run", { command });
  }

  /**
   * 某一篇上的那个槽位画什么：交回校验过的树，null 是不显示。插件交来的树不合规矩是 undefined
   * （记一条错，照旧显示上一棵）
   */
  async renderSlot(
    slot: string,
    doc: DocInfo & { text?: string },
  ): Promise<ViewNode | null | undefined> {
    const tree = await this.call("slots.render", { slot, doc });
    if (tree === null || tree === undefined) return null;
    try {
      return validateView(tree);
    } catch (error) {
      this.events.onLog("error", `槽位 ${slot} 交来的视图不对：${errorText(error)}`);
      return undefined;
    }
  }

  /** 槽位里点了按钮、提交了表单 */
  async slotAction(
    slot: string,
    doc: DocInfo,
    action: string,
    value?: unknown,
    form?: Record<string, unknown>,
  ): Promise<void> {
    await this.call("slots.action", { slot, doc, action, value, form });
  }

  /** 读这一篇的权限：vault 都能读，current 只能读看得见的 */
  canRead(ref: DocumentRef): boolean {
    return (
      this.granted.has("documents.read:vault") ||
      (this.granted.has("documents.read:current") && this.host.isVisible(ref))
    );
  }

  /* ---------------- 里面 ---------------- */

  private setStatus(status: RuntimeStatus) {
    this.status = status;
    this.events.onStatus(status);
  }

  private async boot(generation: number): Promise<void> {
    this.setStatus({ state: "starting" });
    try {
      const sandbox = await this.createSandbox(this.manifest);
      if (generation !== this.generation) {
        sandbox.dispose();
        return;
      }
      this.sandbox = sandbox;
      const endpoint = new Endpoint(sandbox.port, {
        onNotice: (method, params) => this.onNotice(method, params),
        onOther: (message) => this.onRelay(message as RelayMessage),
        onInvalid: (reason) => this.events.onLog("warn", `收到一条不合协议的消息：${reason}`),
        admit: () => this.admit(),
      });
      this.endpoint = endpoint;
      this.serve(endpoint);
      await endpoint.request(
        "activate",
        {
          code: this.code,
          plugin: { id: this.manifest.id, version: this.manifest.version },
          capabilities: this.grantedCapabilities().map(({ name, scope }) => ({ name, scope })),
          host: { api: PLUGIN_API, platform: "desktop" },
        },
        { timeout: this.limits.activateTimeout },
      );
      if (generation !== this.generation) return;
      this.setStatus({ state: "running" });
      this.heartbeat = setInterval(() => {
        this.call("ping").catch(() => {});
      }, this.limits.pingInterval);
    } catch (error) {
      if (generation !== this.generation) return;
      this.teardown();
      const message = errorText(error);
      this.setStatus({ state: "failed", message });
      throw new Error(message);
    }
  }

  /** 拆：这个插件名下的东西一次撤掉 */
  private teardown() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const dispose of this.subscriptions.values()) dispose();
    this.subscriptions.clear();
    this.endpoint?.close();
    this.endpoint = null;
    this.sandbox?.dispose();
    this.sandbox = null;
    this.calls = { windowStart: 0, count: 0, over: false };
    this.notices = [];
  }

  /** 犯规一次：第一次警告，到了次数就停下 */
  private strike(reason: string) {
    this.strikes += 1;
    const name = `「${this.manifest.name}」`;
    if (this.strikes >= this.limits.strikes) {
      this.kill(`${reason}，这次先停下了`);
      this.events.onWarn(`${name}${reason}，这次先停下了；扩展页里可以重新启动`);
    } else {
      this.events.onWarn(`${name}${reason}；再这样就停下它`);
    }
  }

  /** 宿主问插件：带超时，超时算犯规 */
  private async call(method: string, params?: unknown): Promise<unknown> {
    const endpoint = this.endpoint;
    if (!endpoint || this.status.state !== "running") {
      throw new RpcError("unavailable", "插件没在跑");
    }
    try {
      return await endpoint.request(method, params, { timeout: this.limits.callTimeout });
    } catch (error) {
      if (error instanceof RpcError && error.code === "timeout" && this.endpoint === endpoint) {
        this.strike(
          method === "ping"
            ? `卡住了（${this.limits.callTimeout / 1000} 秒没回应）`
            : `做一件事 ${this.limits.callTimeout / 1000} 秒还没做完`,
        );
      }
      throw error;
    }
  }

  /** 插件发来的每一个请求先过预算 */
  private admit(): RpcError | null {
    if (this.endpoint && this.endpoint.serving >= this.limits.inFlight) {
      return new RpcError("budget", `同时挂着的请求太多了（最多 ${this.limits.inFlight} 个）`);
    }
    const now = Date.now();
    if (now - this.calls.windowStart >= 60_000)
      this.calls = { windowStart: now, count: 0, over: false };
    this.calls.count += 1;
    if (this.calls.count <= this.limits.callsPerMinute) return null;
    if (!this.calls.over) {
      this.calls.over = true;
      // 这一笔先回了 budget，再记犯规（可能就此停下）
      queueMicrotask(() => this.strike(`一分钟里调用了 ${this.limits.callsPerMinute} 次以上`));
    }
    return new RpcError("budget", "调用太频繁了，过一会儿再来");
  }

  private onNotice(method: string, params: unknown) {
    if (method !== "log" || !isObject(params)) return;
    const level = params.level === "warn" ? "warn" : "error";
    this.events.onLog(level, String(params.message ?? "").slice(0, 1000));
  }

  private onRelay(message: RelayMessage) {
    if (message.relay === "error") {
      const where = message.line ? `（第 ${message.line} 行）` : "";
      this.events.onLog("error", `${message.message}${where}`);
      return;
    }
    if (message.relay !== "fatal") return;
    const text =
      message.reason === "no-worker"
        ? `这台设备上起不了插件的后台线程（${message.message}）`
        : `${message.message}，被掐掉了`;
    if (this.status.state === "starting") {
      // boot 里等着的 activate 会被 close 拒掉，在那边记成 failed
      this.endpoint?.close(text);
      return;
    }
    this.kill(text);
    this.events.onWarn(`「${this.manifest.name}」${text}；扩展页里可以重新启动`);
  }

  private deny(name: string, scope: string): RpcError {
    const requested = (this.manifest.capabilities ?? []).some(
      (capability) => capability.name === name,
    );
    const label = CAPABILITY_LABEL[name] ?? name;
    return new RpcError(
      "denied",
      requested
        ? `这台设备上没同意它${label}（${name}: ${scope}）`
        : `清单里没申请${label}（${name}）`,
    );
  }

  private requireRead(ref: DocumentRef) {
    if (!this.canRead(ref)) {
      throw this.deny(
        "documents.read",
        this.granted.has("documents.read:current") ? "vault" : "current",
      );
    }
  }

  private requireAnyRead() {
    if (!this.granted.has("documents.read:current") && !this.granted.has("documents.read:vault")) {
      throw this.deny("documents.read", "current");
    }
  }

  /** 插件能调的方法 */
  private serve(endpoint: Endpoint) {
    endpoint.handle("documents.current", () => {
      this.requireAnyRead();
      const doc = this.host.current();
      return doc && this.canRead(doc.ref) ? doc : null;
    });

    endpoint.handle("documents.read", async (params) => {
      const ref = refOf(isObject(params) ? params.ref : undefined);
      this.requireRead(ref);
      const doc = await this.host.read(ref);
      if (!doc) throw new RpcError("not_found", "没有这一篇");
      return doc;
    });

    endpoint.handle("documents.list", () => {
      if (!this.granted.has("documents.read:vault")) throw this.deny("documents.read", "vault");
      return this.host.list();
    });

    endpoint.handle("documents.edit", (params) => {
      const body = isObject(params) ? params : {};
      const ref = refOf(body.ref);
      if (!this.granted.has("documents.edit:current")) throw this.deny("documents.edit", "current");
      if (!this.host.isVisible(ref)) {
        throw new RpcError("denied", "只能改正在看的文档（documents.edit: current）");
      }
      if (typeof body.baseRevision !== "string") {
        throw new RpcError("invalid", "baseRevision 要是 documents.read 给的修订号");
      }
      const outcome = this.host.edit(ref, body.baseRevision, body.changes);
      if (!outcome) throw new RpcError("unavailable", "这篇没在编辑器里打开，改不了");
      if (outcome.ok) return { revision: outcome.revision };
      throw new RpcError(outcome.code === "readonly" ? "denied" : outcome.code, outcome.message);
    });

    endpoint.handle("subscribe", (params) => {
      const topic = isObject(params) ? params.topic : undefined;
      if (topic !== "documents.current" && topic !== "documents.changed") {
        throw new RpcError("invalid", "topic 只能是 documents.current、documents.changed");
      }
      this.requireAnyRead();
      if (this.subscriptions.size >= this.limits.subscriptions) {
        throw new RpcError("budget", `订阅太多了（最多 ${this.limits.subscriptions} 个）`);
      }
      const subscription = `s${this.nextSubscription++}`;
      const send = (data: unknown) => endpoint.notify("event", { subscription, data });
      const dispose =
        topic === "documents.current"
          ? this.host.onCurrentChange((doc) => send(doc && this.canRead(doc.ref) ? doc : null))
          : this.host.onDocumentChange((doc) => {
              if (this.canRead(doc.ref)) send(doc);
            });
      this.subscriptions.set(subscription, dispose);
      return { subscription };
    });

    endpoint.handle("unsubscribe", (params) => {
      const subscription = isObject(params) ? String(params.subscription) : "";
      this.subscriptions.get(subscription)?.();
      this.subscriptions.delete(subscription);
      return null;
    });

    endpoint.handle("slots.update", (params) => {
      const body = isObject(params) ? params : {};
      const slot = String(body.slot ?? "");
      if (!(this.manifest.contributes.documentSlots ?? []).some((item) => item.id === slot)) {
        throw new RpcError("not_found", `清单里没声明槽位 ${slot}`);
      }
      const ref = refOf(body.ref);
      if (!this.host.isVisible(ref)) {
        throw new RpcError("unavailable", "这一篇现在没显示着（槽位只画在看得见的文档上）");
      }
      try {
        if (body.patch !== undefined) {
          const current = this.host.slotTree(slot, ref);
          if (!current) throw new RpcError("invalid", "这一篇上还没有视图，先用 update 交一整棵");
          this.host.pushSlot(slot, ref, validateView(applyPatch(current, body.patch)));
        } else {
          const tree =
            body.tree === null || body.tree === undefined ? null : validateView(body.tree);
          this.host.pushSlot(slot, ref, tree);
        }
      } catch (error) {
        if (error instanceof ViewError) throw new RpcError("invalid", `视图不对：${error.message}`);
        throw error;
      }
      return null;
    });

    endpoint.handle("ui.notify", (params) => {
      const text = isObject(params) ? String(params.text ?? "").trim() : "";
      if (!text) throw new RpcError("invalid", "text 是空的");
      const now = Date.now();
      this.notices = this.notices.filter((at) => now - at < 60_000);
      if (this.notices.length >= this.limits.noticesPerMinute) {
        throw new RpcError("budget", `提示条一分钟最多 ${this.limits.noticesPerMinute} 条`);
      }
      this.notices.push(now);
      this.host.notify(`${this.manifest.name}：${text.slice(0, this.limits.noticeLength)}`);
      return null;
    });
  }
}
