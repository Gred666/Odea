import { type CollabScheduler, CollabSession, type Peer, browserScheduler } from "./session";

/* ============================================================
   同一个窗口里的模拟网络（P10.0：不碰真网络，先把编辑器这一头做对）。

   星形，和设计 §5.4 一样：所有更新经主持人，主持人收到谁的就转给其他人。
   - 文档更新：每条链路按序到（QUIC 的流），延迟可以设；模糊测试里可以打开乱序、重复投递
   - 光标：数据报，可以丢、可以乱序
   - 断线：路上的全丢；重连时双方各发一次 Sync1、回 Sync2，断线期间各自的改动就补齐了

   P10.1 换成 Rust 那边的 iroh 时，CollabSession 一行不用改：它只认 CollabTransport。
   ============================================================ */

export interface LoopbackOptions {
  /** 每条消息的单程延迟（毫秒），每次现取：可以带抖动 */
  latency?: () => number;
  /** 文档更新也允许乱序到（真实的流不会，模糊测试用来折腾 Yjs） */
  reorder?: boolean;
  /** 一条更新被重复投递的概率 */
  duplicate?: number;
  /** 光标数据报丢掉的概率 */
  dropCursor?: number;
  /** 随机数（模糊测试给固定种子的） */
  random?: () => number;
  scheduler?: CollabScheduler;
}

export interface LoopbackMember {
  readonly peer: Peer;
  readonly session: CollabSession;
  readonly host: boolean;
  readonly connected: boolean;
}

interface Member extends LoopbackMember {
  connected: boolean;
  /** 断线一次换一代：路上的旧消息到了也不要 */
  generation: number;
}

export class LoopbackHub {
  private readonly members: Member[] = [];
  private readonly latency: () => number;
  private readonly random: () => number;
  private readonly scheduler: CollabScheduler;
  /** 每条链路上一条消息的到达时间：按序到 */
  private readonly lastArrival = new Map<string, number>();
  /** 还在路上的消息数（测试等它们都到） */
  private inFlight = 0;

  constructor(private readonly options: LoopbackOptions = {}) {
    this.latency = options.latency ?? (() => 0);
    this.random = options.random ?? Math.random;
    this.scheduler = options.scheduler ?? browserScheduler;
  }

  get hostMember(): LoopbackMember | undefined {
    return this.members.find((member) => member.host);
  }

  get all(): readonly LoopbackMember[] {
    return this.members;
  }

  get pending(): number {
    return this.inFlight;
  }

  /** 主持人开始协作：拿编辑器里现在的正文建会话 */
  host(peer: Peer, text: string): LoopbackMember {
    if (this.hostMember) throw new Error("已经有主持人了");
    return this.add(peer, true, text);
  }

  /** 访客加入：空的会话，马上和主持人同步一次（不走延迟：加入时等快照到了才打开文档） */
  join(peer: Peer): LoopbackMember {
    const host = this.members.find((member) => member.host);
    if (!host) throw new Error("还没有主持人");
    const member = this.add(peer, false);
    host.session.answerSync(member.session.stateVector(), (update) =>
      member.session.receiveUpdate(update),
    );
    member.session.answerSync(host.session.stateVector(), (update) =>
      host.session.receiveUpdate(update),
    );
    return member;
  }

  /** 断线：路上的全丢，之后谁的消息都收不到 */
  disconnect(target: LoopbackMember): void {
    const member = target as Member;
    if (!member.connected) return;
    member.connected = false;
    member.generation += 1;
    for (const other of this.members) {
      if (other !== member) other.session.removePeer(member.peer.id);
    }
    if (member.host) {
      for (const other of this.members) if (other !== member) other.generation += 1;
    }
  }

  /** 重连：和主持人互发 Sync1 / Sync2（主持人重连就是和每个访客各来一遍） */
  reconnect(target: LoopbackMember): void {
    const member = target as Member;
    if (member.connected) return;
    member.connected = true;
    const host = this.members.find((each) => each.host);
    if (!host) return;
    const pairs = member.host
      ? this.members.filter((each) => !each.host && each.connected).map((guest) => [host, guest])
      : host.connected
        ? [[host, member]]
        : [];
    for (const [a, b] of pairs as [Member, Member][]) {
      this.send(a, b, "sync", a.session.stateVector());
      this.send(b, a, "sync", b.session.stateVector());
    }
  }

  /** 有人离开：会话停掉 */
  leave(target: LoopbackMember): void {
    const member = target as Member;
    this.disconnect(member);
    member.session.destroy();
    this.members.splice(this.members.indexOf(member), 1);
  }

  destroy(): void {
    for (const member of this.members.splice(0)) member.session.destroy();
  }

  private add(peer: Peer, host: boolean, initialText?: string): Member {
    const member = {
      peer,
      host,
      connected: true,
      generation: 0,
    } as Member;
    (member as { session: CollabSession }).session = new CollabSession({
      self: peer,
      initialText,
      scheduler: this.scheduler,
      transport: {
        sendUpdate: (update) => this.route(member, "update", update),
        sendCursor: (payload) => this.route(member, "cursor", payload),
      },
    });
    this.members.push(member);
    return member;
  }

  /** 星形：访客发给主持人；主持人发给所有访客 */
  private route(from: Member, kind: "update" | "cursor", bytes: Uint8Array, origin = from) {
    if (!from.connected) return;
    const targets = from.host
      ? this.members.filter((member) => member !== from && member !== origin)
      : this.members.filter((member) => member.host);
    for (const target of targets) this.send(from, target, kind, bytes, origin);
  }

  private send(
    from: Member,
    to: Member,
    kind: "update" | "cursor" | "sync" | "sync-reply",
    bytes: Uint8Array,
    origin = from,
  ) {
    if (!from.connected || !to.connected) return;
    if (kind === "cursor" && this.random() < (this.options.dropCursor ?? 0)) return;
    const copies = kind === "update" && this.random() < (this.options.duplicate ?? 0) ? 2 : 1;
    const generations = [from.generation, to.generation];
    const link = `${from.peer.id}→${to.peer.id}`;
    for (let copy = 0; copy < copies; copy += 1) {
      const now = this.scheduler.now();
      let arrival = now + Math.max(0, this.latency());
      // 流是按序的：后发的不能比先发的先到（乱序只给光标数据报，或者模糊测试明说要）
      const ordered = kind !== "cursor" && !this.options.reorder;
      if (ordered) arrival = Math.max(arrival, this.lastArrival.get(link) ?? 0);
      if (ordered) this.lastArrival.set(link, arrival);
      this.inFlight += 1;
      this.scheduler.setTimeout(() => {
        this.inFlight -= 1;
        if (!from.connected || !to.connected) return;
        if (from.generation !== generations[0] || to.generation !== generations[1]) return;
        this.deliver(from, to, kind, bytes, origin);
      }, arrival - now);
    }
  }

  private deliver(
    from: Member,
    to: Member,
    kind: "update" | "cursor" | "sync" | "sync-reply",
    bytes: Uint8Array,
    origin: Member,
  ) {
    switch (kind) {
      case "update":
        to.session.receiveUpdate(bytes);
        // 主持人转发给其他访客
        if (to.host) this.route(to, "update", bytes, origin);
        return;
      case "cursor":
        to.session.receiveCursor(origin.peer, bytes);
        if (to.host) this.route(to, "cursor", bytes, origin);
        return;
      case "sync":
        to.session.answerSync(bytes, (update) => this.send(to, from, "sync-reply", update));
        return;
      case "sync-reply":
        to.session.receiveUpdate(bytes);
        // 主持人从重连的访客那里补齐的东西，其他访客也缺
        if (to.host) this.route(to, "update", bytes, from);
        return;
    }
  }
}

/* ---------------- 手动推进的时钟（测试用） ---------------- */

interface Timer {
  at: number;
  order: number;
  callback: () => void;
  cancelled: boolean;
}

/** 把排着的微任务（包括它们排出来的微任务）跑完 */
export async function flushMicrotasks(): Promise<void> {
  for (let round = 0; round < 12; round += 1) await Promise.resolve();
}

/** 假的时钟：advance 时按时间顺序跑到点的定时器；一帧当 16ms */
export class ManualScheduler implements CollabScheduler {
  private time = 0;
  private order = 0;
  private timers: Timer[] = [];

  now(): number {
    return this.time;
  }

  frame(callback: () => void): void {
    this.setTimeout(callback, 16);
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const timer: Timer = {
      at: this.time + Math.max(0, ms),
      order: this.order++,
      callback,
      cancelled: false,
    };
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(handle: unknown): void {
    if (handle) (handle as Timer).cancelled = true;
  }

  /**
   * 往前走 ms 毫秒，途中到点的都跑（跑出来的新定时器到点了也跑）。每跑一个都把微任务
   * 清干净：会话往外发是在微任务里合包的，不清的话它们全挤到最后才发
   */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    await flushMicrotasks();
    for (;;) {
      this.timers = this.timers.filter((timer) => !timer.cancelled);
      let next: Timer | undefined;
      for (const timer of this.timers) {
        if (timer.at > end) continue;
        if (!next || timer.at < next.at || (timer.at === next.at && timer.order < next.order)) {
          next = timer;
        }
      }
      if (!next) break;
      this.time = Math.max(this.time, next.at);
      next.cancelled = true;
      next.callback();
      await flushMicrotasks();
    }
    this.time = end;
  }

  get size(): number {
    return this.timers.filter((timer) => !timer.cancelled).length;
  }
}
