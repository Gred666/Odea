import { type SavedSnapshot, mergeExternal, snapshot } from "@/collab/external";
import { type SessionLink, linkSession } from "@/collab/link";
import { type Frame, PIPE } from "@/collab/net";
import { type CollabScheduler, type CollabSession, type Peer, peerColor } from "@/collab/session";
import type { DocumentSaveTarget } from "@/data/types";
import type { PresenceDoc, TeamControl, TeamPeer, TeamSelf } from "@/lib/bindings";
import { merge3 } from "@/lib/merge3";
import type { TeamNet } from "./net";

/* ============================================================
   团队仓库里同一篇谁主持、谁做客（docs/协同编辑.md §22.2、§22.4）。不碰界面：数据层的读写从 TeamIO 进来，
   测试里一个进程起好几台（mockNet.ts 的 hub）。

   每台设备一次只看一篇（编辑器里的那篇，view）。每篇在 Presence 里写：开着、主持着没有、在哪一份会话里
   （session：主持人建会话时起的 id，访客跟着主持人的）。按别人的 Presence 定自己该怎么做：

   - 一个人开着（solo）：不建会话，照常编辑、存盘
   - 有人在主持：加入（joining → guest）。先把自己的存下去，等主持人那份到了，本机没提交的改动
     （相对 git 里最近一次提交，TeamNet.base）三方合进会话（规矩 2）。访客不存这一篇（remote）
   - 没人主持、开着的都是 solo：公钥最小的那位主持（host），别人等他的 Presence 再加入
   - 主持人走了（orphan）：自己关掉的马上接手，断线的等 10 秒（可能马上回来）。同一份会话里留下的人里
     公钥最小的接手（takeover）：先同步一轮 git（拉下旧主持人推上去的，规矩 4），再开始主持、存盘。
     别人同一份会话照旧连新主持人，CRDT 状态向量一换就补齐，不重新合
   - 两边都在主持（断网时各自开了，连上以后）：公钥大的让。同一份会话的照旧连过去；不是同一份的
     先把自己的存下去，再按「加入」合
   - 主持人身边没人了（访客都走了、也没人开着）：过一会儿收掉会话，回到 solo
   - 主持人自己切走了、还有访客：先存、推一轮 git，再不主持（访客那边接手时拉得到）

   同一篇在会话里时只有主持人写盘（规矩 1）：访客的编辑器绑着会话、不存（adapter 里 collab.remote），
   git 拉来的这一篇的改动也不当外部改动合 —— 那就是主持人存的
   ============================================================ */

export interface TeamIO {
  /** 编辑器里没存的先存下去 */
  flush(): Promise<void>;
  /** 数据层里这一篇现在的正文（磁盘上的；某一天没写过时是延续来的） */
  load(target: DocumentSaveTarget): Promise<string | undefined>;
  save(target: DocumentSaveTarget, text: string): Promise<void>;
  /** 这一篇被别处改了（git 拉来的、别的程序）：给磁盘上的新正文 */
  onExternal(target: DocumentSaveTarget, listener: (disk: string) => void): () => void;
}

export interface TeamTiming {
  /** 加入时等主持人那份正文多久 */
  joinTimeout: number;
  /** 主持人断线（不是自己不主持）以后等多久才接手 */
  dropGrace: number;
  /** 主持人身边没人了多久收掉会话 */
  aloneGrace: number;
  /** 主持人存盘的防抖 */
  saveDelay: number;
  /** 接手、交接时 git 同步最多等多久 */
  syncWait: number;
  /** 加入被拒（Presence 还没跟上）以后多久再试 */
  retryAfter: number;
}

const DEFAULT_TIMING: TeamTiming = {
  joinTimeout: 8000,
  dropGrace: 10000,
  aloneGrace: 5000,
  saveDelay: 400,
  syncWait: 10000,
  retryAfter: 2000,
};

export interface TeamView {
  /** 文档 id：笔记是相对路径，某一天 `day-日期`，目标 `goal-周期-开始日期` */
  doc: string;
  target: DocumentSaveTarget;
}

export interface TeamDocSession {
  session: CollabSession;
  /** 别人主持：这边不存盘 */
  remote: boolean;
}

export interface TeamSnapshot {
  peers: TeamPeer[];
  /** 文档 id → 会话（主持着的、做客的）：编辑器绑它 */
  sessions: Record<string, TeamDocSession>;
}

type Role = "solo" | "host" | "joining" | "guest" | "orphan" | "takeover";

interface Entry {
  doc: string;
  target: DocumentSaveTarget;
  role: Role;
  /** 每换一次角色加一：异步做到一半角色变了的，回来以后就不接着做 */
  epoch: number;
  link: SessionLink | null;
  /** 在哪一份会话里 */
  lineage: string | null;
  /** 做客：主持人的编号 */
  host: number | null;
  /** 编辑器里正是这一篇；false = 我切走了，在交接 */
  viewing: boolean;
  /** 主持：开着它的访客 */
  guests: Set<number>;
  /** 主持：存盘、外部改动 */
  stopHosting: (() => void) | null;
  saveNow: (() => Promise<void>) | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** 加入：主持人那份到了 */
  synced: (() => void) | null;
  /** 主持人断线后等够了 */
  graceOver: boolean;
  /** 加入被拒过：这之前不再试 */
  retryAt: number;
  /** 正在做一个转换（加入、主持、接手、交接）：做完之前不再按 Presence 判断，做完再判断一次 */
  busy: boolean;
}

const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TeamController {
  private peers: TeamPeer[];
  private readonly entries = new Map<string, Entry>();
  private readonly timing: TeamTiming;
  private readonly selfPeer: Peer;
  private destroyed = false;
  private lastPresence = "";

  constructor(
    private readonly net: TeamNet,
    private readonly self: TeamSelf,
    private readonly io: TeamIO,
    private readonly onChange: (snapshot: TeamSnapshot) => void,
    timing: Partial<TeamTiming> = {},
    private readonly scheduler?: CollabScheduler,
  ) {
    this.peers = self.peers;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.selfPeer = { id: self.id, name: self.name, color: peerColor(self.id) };
  }

  /* ---------------- 外面进来的 ---------------- */

  /** 编辑器里现在是哪一篇（null：不是能协作的文档，或者还没取到正文） */
  view(next: TeamView | null): void {
    if (this.destroyed) return;
    for (const entry of [...this.entries.values()]) {
      if (entry.viewing && entry.doc !== next?.doc) {
        entry.viewing = false;
        // 正在加入、做客：马上断开（加入的那个异步做到一半回来看到 epoch 变了就停）。主持人要交接，等它做完
        if (entry.busy && entry.role !== "host") this.leave(entry);
        else this.evaluate(entry);
      }
    }
    if (next) {
      let entry = this.entries.get(next.doc);
      if (!entry) {
        entry = this.newEntry(next);
        this.entries.set(next.doc, entry);
      }
      entry.viewing = true;
      entry.target = next.target;
      this.evaluate(entry);
    }
    this.publish();
  }

  receive(frame: Frame): void {
    const entry = this.entries.get(frame.doc);
    if (!entry?.link) return;
    // 主持人这边：有人接上这一篇了（Rust 说「把你的状态向量发给他」）
    if (entry.role === "host" && frame.kind === PIPE.syncVector) {
      entry.guests.add(frame.member);
      this.clearTimer(entry);
    }
    entry.link.receive(frame);
    if (entry.role === "joining" && frame.kind === PIPE.update) entry.synced?.();
  }

  control(control: TeamControl): void {
    if (this.destroyed) return;
    if (control.type === "peers") {
      this.peers = control.peers;
      for (const entry of this.entries.values()) entry.link?.setMembers(this.peers);
      for (const entry of [...this.entries.values()]) this.evaluate(entry);
      this.emit();
      return;
    }
    const entry = this.entries.get(control.doc);
    if (!entry) return;
    if (entry.role === "host") {
      entry.guests.delete(control.member);
      this.evaluate(entry);
      return;
    }
    if (entry.host !== control.member) return;
    if (entry.role === "joining") {
      // 主持人说不是他在主持（Presence 还没跟上）、连不上：过一会儿再按 Presence 来
      this.toSolo(entry);
      entry.retryAt = Date.now() + this.timing.retryAfter;
      this.later(entry, this.timing.retryAfter);
      this.publish();
      return;
    }
    if (entry.role === "guest") {
      this.setRole(entry, "orphan");
      entry.graceOver = false;
      // 连的时候被拒（他的 Presence 说在主持、其实已经不主持了）：过一会儿再试
      if (control.refused) {
        entry.retryAt = Date.now() + this.timing.retryAfter;
        this.later(entry, this.timing.retryAfter);
      }
      this.publish();
      this.evaluate(entry);
    }
  }

  snapshot(): TeamSnapshot {
    const sessions: Record<string, TeamDocSession> = {};
    for (const entry of this.entries.values()) {
      if (!entry.link || entry.role === "joining" || entry.role === "solo") continue;
      sessions[entry.doc] = { session: entry.link.session, remote: entry.role !== "host" };
    }
    return { peers: this.peers, sessions };
  }

  /** 窗口关了、换了仓库：主持着的存下去、不主持 */
  async destroy(): Promise<void> {
    this.destroyed = true;
    for (const entry of [...this.entries.values()]) {
      this.clearTimer(entry);
      if (entry.role === "host") await this.stopHosting(entry);
      else this.drop(entry);
    }
    this.entries.clear();
    await this.net.presence([]).catch(() => {});
  }

  /* ---------------- 按 Presence 定 ---------------- */

  /** 别人里开着这一篇的（在线的） */
  private others(doc: string): { peer: TeamPeer; state: PresenceDoc }[] {
    return this.peers.flatMap((peer) => {
      const state = peer.online ? peer.docs.find((item) => item.doc === doc) : undefined;
      return state ? [{ peer, state }] : [];
    });
  }

  private smallest(ids: string[]): boolean {
    return ids.every((id) => this.self.id < id);
  }

  private evaluate(entry: Entry): void {
    if (this.destroyed || this.entries.get(entry.doc) !== entry || entry.busy) return;
    if (!entry.viewing) {
      this.leave(entry);
      return;
    }
    const others = this.others(entry.doc);
    const hosts = others
      .filter(({ state }) => state.hosting)
      .sort((a, b) => (a.peer.id < b.peer.id ? -1 : 1));
    switch (entry.role) {
      case "solo": {
        if (Date.now() < entry.retryAt) return;
        const host = hosts[0];
        if (host) {
          this.run(entry, () => this.join(entry, host.peer, host.state.session));
          return;
        }
        // 别人在一份会话里（主持人刚走、正在接手）：等他们接好再加入
        if (others.some(({ state }) => state.session)) return;
        if (others.length && this.smallest(others.map(({ peer }) => peer.id))) {
          this.run(entry, () => this.becomeHost(entry));
        }
        return;
      }
      case "host": {
        const rival = hosts[0];
        if (rival && rival.peer.id < this.self.id) {
          this.run(entry, () => this.yieldTo(entry, rival.peer, rival.state.session));
          return;
        }
        // 身边没人了：过一会儿收掉
        if (!entry.guests.size && !others.length) {
          if (!entry.timer) {
            this.later(entry, this.timing.aloneGrace, () => {
              if (entry.role === "host" && !entry.guests.size && !this.others(entry.doc).length) {
                this.run(entry, () => this.stopHosting(entry));
              }
            });
          }
        } else {
          this.clearTimer(entry);
        }
        return;
      }
      case "orphan": {
        if (Date.now() < entry.retryAt) return;
        const same = hosts.find(({ state }) => state.session === entry.lineage);
        if (same) {
          this.run(entry, () => this.rejoin(entry, same.peer));
          return;
        }
        const other = hosts[0];
        if (other) {
          this.run(entry, () => this.join(entry, other.peer, other.state.session));
          return;
        }
        const old = this.peers.find((peer) => peer.member === entry.host);
        // 旧主持人还在线、Presence 里已经不主持了：是他自己关掉的，马上接手；断线的等一会儿
        const graceful =
          !!old?.online && !old.docs.some((item) => item.doc === entry.doc && item.hosting);
        if (!graceful && !entry.graceOver) {
          if (!entry.timer) {
            this.later(entry, this.timing.dropGrace, () => {
              entry.graceOver = true;
              this.evaluate(entry);
            });
          }
          return;
        }
        const peers = others
          .filter(({ state }) => state.session === entry.lineage)
          .map(({ peer }) => peer.id);
        if (this.smallest(peers)) this.run(entry, () => this.takeover(entry));
        return;
      }
      default:
        return;
    }
  }

  /* ---------------- 主持 ---------------- */

  /** 一个人开着、轮到我主持：会话从磁盘上的这一版开始 */
  private async becomeHost(entry: Entry): Promise<void> {
    const epoch = this.setRole(entry, "host");
    await this.io.flush();
    const text = (await this.io.load(entry.target)) ?? "";
    if (entry.epoch !== epoch) return;
    entry.link = this.newLink(entry, { initialText: text });
    entry.lineage = randomId();
    await this.startHosting(entry, false);
  }

  /** 主持人走了、轮到我：先拉下旧主持人推上去的，再开始存盘（会话还是原来那一份） */
  private async takeover(entry: Entry): Promise<void> {
    const epoch = this.setRole(entry, "takeover");
    this.publish();
    await this.net.syncNow(this.timing.syncWait).catch(() => {});
    // 拉下来的文件变化、索引要过一会儿才到数据层：等它们到了再开始盯外部改动
    await sleep(300);
    if (entry.epoch !== epoch || !entry.link) return;
    this.setRole(entry, "host");
    entry.host = null;
    await this.startHosting(entry, true);
  }

  private async startHosting(entry: Entry, writeNow: boolean): Promise<void> {
    const epoch = entry.epoch;
    const link = entry.link!;
    const session = link.session;
    let saved: SavedSnapshot = snapshot(session);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const save = async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      const shot = snapshot(session);
      try {
        await this.io.save(entry.target, shot.text);
        saved = shot;
      } catch {
        // 存失败的提示由数据层给；下次改动再存
      }
    };
    const stopChanges = session.onChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void save(), this.timing.saveDelay);
    });
    // 外部改动（别的程序、git 合并下来的别人的改动）：当成从上次存盘处分叉出去的协作者合进来
    const stopExternal = this.io.onExternal(entry.target, (disk) => {
      if (disk !== session.toString()) mergeExternal(session, saved, disk);
    });
    entry.saveNow = save;
    entry.stopHosting = () => {
      if (timer) clearTimeout(timer);
      stopChanges();
      stopExternal();
    };
    // 接手：会话里的比磁盘上的新（旧主持人最后那几下、自己做客时打的），马上存一次
    if (writeNow) await save();
    if (entry.epoch !== epoch) return;
    await this.net.host(entry.doc, true).catch(() => {});
    this.publish();
    this.emit();
  }

  /** 不主持了：存下去、收掉会话。还开着这一篇的回到 solo */
  private async stopHosting(entry: Entry): Promise<void> {
    const epoch = this.setRole(entry, "solo");
    this.clearTimer(entry);
    await entry.saveNow?.();
    entry.stopHosting?.();
    entry.stopHosting = null;
    entry.saveNow = null;
    // 先说不主持了，再收掉流：访客那边看到的是「他自己关掉的」，不用等 10 秒
    this.publishNow();
    await this.net.host(entry.doc, false).catch(() => {});
    if (entry.epoch !== epoch) return;
    entry.link?.destroy();
    entry.link = null;
    entry.lineage = null;
    entry.guests.clear();
    if (!entry.viewing) this.entries.delete(entry.doc);
    this.publish();
    this.emit();
  }

  /** 两边都在主持，对方公钥小：让给他 */
  private async yieldTo(entry: Entry, rival: TeamPeer, lineage: string | null): Promise<void> {
    if (lineage && lineage === entry.lineage) {
      // 同一份会话（两位都接了手）：不主持了，照旧连过去
      const link = entry.link;
      entry.link = null;
      await this.stopHosting(entry);
      if (!link || !entry.viewing) {
        link?.destroy();
        return;
      }
      entry.link = link;
      entry.lineage = lineage;
      this.setRole(entry, "orphan");
      await this.rejoin(entry, rival);
      return;
    }
    // 不是同一份：自己的先存下去（stopHosting 里存），再按「加入」合
    await this.stopHosting(entry);
    if (entry.viewing) await this.join(entry, rival, lineage);
  }

  /* ---------------- 做客 ---------------- */

  /**
   * 加入 host 主持的这一篇：先存下自己的，等主持人那份到了，本机没提交的改动三方合进去。
   * 之前在另一份会话里（orphan）的：那份的正文先存下去，不然没发出去的那几下就没了
   */
  private async join(entry: Entry, host: TeamPeer, lineage: string | null): Promise<void> {
    const previous = entry.link;
    const epoch = this.setRole(entry, "joining");
    entry.host = host.member;
    if (previous) {
      await this.io.save(entry.target, previous.session.toString()).catch(() => {});
      previous.destroy();
      entry.link = null;
      this.emit();
    }
    await this.io.flush();
    const local = await this.io.load(entry.target);
    if (entry.epoch !== epoch) return;
    const link = this.newLink(entry, {});
    entry.link = link;
    const synced = new Promise<boolean>((resolve) => {
      entry.synced = () => {
        entry.synced = null;
        // 收到的包要等下一帧才应用进文档
        const stop = link.session.onApplied(() => {
          stop();
          resolve(true);
        });
        setTimeout(() => resolve(true), 200);
      };
    });
    try {
      await this.net.open(entry.doc, host.member);
    } catch {
      if (entry.epoch === epoch) {
        this.toSolo(entry);
        entry.retryAt = Date.now() + this.timing.retryAfter;
      }
      return;
    }
    const ok = await Promise.race([synced, sleep(this.timing.joinTimeout).then(() => false)]);
    if (entry.epoch !== epoch) return;
    if (!ok) {
      void this.net.close(entry.doc).catch(() => {});
      this.toSolo(entry);
      entry.retryAt = Date.now() + this.timing.retryAfter;
      this.later(entry, this.timing.retryAfter);
      return;
    }
    const base = await this.net.base(entry.target).catch(() => null);
    if (entry.epoch !== epoch) return;
    const theirs = link.session.toString();
    if (base !== null && local !== undefined && local !== base) {
      const merged = merge3(base, local, theirs);
      if (merged && merged.text !== theirs) {
        mergeExternal(link.session, snapshot(link.session), merged.text);
      }
    }
    this.setRole(entry, "guest");
    entry.lineage = lineage ?? this.lineageOf(host, entry.doc);
    this.publish();
    this.emit();
  }

  /** 同一份会话的新主持人：连过去，状态向量一换就补齐 */
  private async rejoin(entry: Entry, host: TeamPeer): Promise<void> {
    const epoch = this.setRole(entry, "guest");
    entry.host = host.member;
    try {
      await this.net.open(entry.doc, host.member);
    } catch {
      // 连不上（他刚断线，Presence 还没跟上）：过一会儿再按 Presence 来。不设的话失败、再试全在微任务里转
      if (entry.epoch === epoch) {
        this.setRole(entry, "orphan");
        entry.retryAt = Date.now() + this.timing.retryAfter;
        this.later(entry, this.timing.retryAfter);
      }
      return;
    }
    this.publish();
  }

  private lineageOf(peer: TeamPeer, doc: string): string | null {
    return peer.docs.find((item) => item.doc === doc)?.session ?? null;
  }

  /* ---------------- 离开 ---------------- */

  /** 切走了 */
  private leave(entry: Entry): void {
    switch (entry.role) {
      case "solo":
        this.entries.delete(entry.doc);
        return;
      case "host":
        this.run(entry, () => (entry.guests.size ? this.handOff(entry) : this.stopHosting(entry)));
        return;
      default:
        this.drop(entry);
        this.entries.delete(entry.doc);
        this.emit();
    }
  }

  /** 主持人切走了、还有访客：存下去、推一轮 git，再不主持（访客接手时拉得到）。期间切回来就接着主持 */
  private async handOff(entry: Entry): Promise<void> {
    const epoch = entry.epoch;
    await entry.saveNow?.();
    await this.net.syncNow(this.timing.syncWait).catch(() => {});
    if (entry.epoch !== epoch || entry.viewing || entry.role !== "host") return;
    await this.stopHosting(entry);
  }

  /** 做客的、在等的：断开、收掉会话 */
  private drop(entry: Entry): void {
    this.clearTimer(entry);
    entry.epoch += 1;
    if (entry.role !== "solo" && entry.role !== "host")
      void this.net.close(entry.doc).catch(() => {});
    entry.link?.destroy();
    entry.link = null;
    entry.lineage = null;
    entry.host = null;
  }

  private toSolo(entry: Entry): void {
    this.drop(entry);
    this.setRole(entry, "solo");
    this.emit();
  }

  /* ---------------- 小工具 ---------------- */

  private newEntry(view: TeamView): Entry {
    return {
      doc: view.doc,
      target: view.target,
      role: "solo",
      epoch: 0,
      link: null,
      lineage: null,
      host: null,
      viewing: true,
      guests: new Set(),
      stopHosting: null,
      saveNow: null,
      timer: null,
      synced: null,
      graceOver: false,
      retryAt: 0,
      busy: false,
    };
  }

  private newLink(entry: Entry, init: { initialText?: string }): SessionLink {
    const link = linkSession(this.net, {
      doc: entry.doc,
      self: this.selfPeer,
      initialText: init.initialText,
      scheduler: this.scheduler,
    });
    link.setMembers(this.peers);
    return link;
  }

  /** 做一个转换：同一篇同一时刻只有一个，做完再按 Presence 判断一次 */
  private run(entry: Entry, transition: () => Promise<void>): void {
    if (entry.busy) return;
    entry.busy = true;
    void transition().then(
      () => {
        entry.busy = false;
        this.evaluate(entry);
      },
      (error) => {
        // 出错了（读不到正文、存不进去）：回到一个人编辑，过一会儿再按 Presence 来，别马上再试
        console.error("团队：", error);
        entry.busy = false;
        if (entry.role !== "host" || !entry.stopHosting) {
          this.drop(entry);
          this.setRole(entry, "solo");
          this.emit();
        }
        entry.retryAt = Date.now() + this.timing.retryAfter;
        this.later(entry, this.timing.retryAfter);
      },
    );
  }

  private setRole(entry: Entry, role: Role): number {
    entry.role = role;
    entry.epoch += 1;
    return entry.epoch;
  }

  private clearTimer(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
  }

  /** 过一会儿再按 Presence 来（或者做 then） */
  private later(entry: Entry, ms: number, then?: () => void): void {
    this.clearTimer(entry);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.destroyed || this.entries.get(entry.doc) !== entry) return;
      if (then) then();
      else this.evaluate(entry);
    }, ms);
  }

  private presenceDocs(): PresenceDoc[] {
    return [...this.entries.values()]
      .filter((entry) => entry.viewing || entry.role === "host")
      .map((entry) => ({
        doc: entry.doc,
        hosting: entry.role === "host" && !!entry.stopHosting,
        session: entry.role === "joining" || entry.role === "solo" ? null : entry.lineage,
      }));
  }

  private publish(): void {
    if (this.destroyed) return;
    this.publishNow();
  }

  private publishNow(): void {
    const docs = this.presenceDocs();
    const key = JSON.stringify(docs);
    if (key === this.lastPresence) return;
    this.lastPresence = key;
    void this.net.presence(docs).catch(() => {});
  }

  private emit(): void {
    if (!this.destroyed) this.onChange(this.snapshot());
  }
}
