import {
  Cursor,
  type ImportStatus,
  LoroDoc,
  type LoroText,
  type PeerID,
  VersionVector,
} from "loro-crdt";

/* ============================================================
   协作会话：一篇文档的 Loro 文档，和网络之间收发字节（docs/协同编辑.md §3、§4.3、§5.5、§20）。

   Loro 文档不放在编辑器里：切到别的笔记时会话照收更新、主持人照存，切回来时用正文建编辑器。
   编辑器挂着的时候由 binding.ts 把 CodeMirror 和正文（Text `body`）接起来。

   网络在这里只是一个 CollabTransport（两个发送函数）：同一个窗口里的模拟网络（loopback.ts），
   或者 Rust 那边的 iroh。Rust 只搬字节，不懂文档。

   ── 收（远端更新 → 文档） ──
   - 到了就应用。同一帧里来了好几个（重连补齐、三个人同时打字），这一帧已经应用过一次的话，
     剩下的攒到下一帧一起 import（importBatch），免得一帧里重排好几次
   - 编辑器在组字：先让编辑器把 DOM 里没读的组字改动读完（readPendingInput），再 import；
     碰到组字那一行的改动由 binding 先攒着、组字结束再派发（§20.10）。编辑器读不了的时候
     先排队，连文档都不碰（不然组字期间本地的改动按 CodeMirror 的位置写进正文就错位了），
     组字结束、最后一次组字改动读进来以后 binding 调 flushHeld 放行

   ── 发（本地改动 → 网络） ──
   - 每次 commit 出一个更新包（subscribeLocalUpdates，同步给）。不攒批：同一个任务里出的几个
     在微任务里合成一包（自己这个 peer 那一段 updates-in-range）发出去
   - 组字期间只写不发：组字时文档里是拼音字母，发出去的话对方看到「nihao」闪一下变成「你好」。
     更新包先攒着，组字结束合成一包发 —— 对方 import 那一包只看到上屏的字
   ============================================================ */

/** 正文在文档里的名字 */
export const TEXT_NAME = "body";
/** binding 自己写进正文时 commit 的 origin：正文的事件里认出是它，不再派发回编辑器 */
export const BINDING_ORIGIN = "binding";

/** 一个参与者。id 是设备公钥（P10.1 起），颜色从固定色板里按 id 算（peerColor） */
export interface Peer {
  id: string;
  name: string;
  /** 色板下标（globals.css 的 --color-peer-N） */
  color: number;
}

/** 网络：文档更新走可靠、按序的流；光标走数据报，丢了不补 */
export interface CollabTransport {
  sendUpdate(update: Uint8Array): void;
  sendCursor(payload: Uint8Array): void;
}

/** 挂着的编辑器：会话问它「现在能不能动文档」 */
export interface CollabEditor {
  /** 正在组字（含组字刚结束、最后一次改动还没读进来）：本地改动先不发 */
  composing(): boolean;
  /**
   * 组字期间远端改动要进来：编辑器先把 DOM 里没读的组字改动读完，返回 true，会话就 import；
   * 读不了返回 false，这一次排队等组字结束（docs/协同编辑.md §20.10）。没有这一项的一律排队
   */
  readPendingInput?(): boolean;
}

/** 一个远端参与者的光标 */
export interface RemoteCursor {
  peer: Peer;
  /** 对方没有光标（切到别的笔记、关了编辑器）时是 null */
  anchor: Cursor | null;
  head: Cursor | null;
  /** 只认序号更大的：数据报可能乱序 */
  seq: number;
  /** 最近一次收到（心跳也算），超过 CURSOR_TIMEOUT 没消息就淡出 */
  seenAt: number;
  /** 最近一次位置变了：名字标签亮多久按这个算 */
  movedAt: number;
}

/** 帧和定时器。测试里换成手动推进的 */
export interface CollabScheduler {
  now(): number;
  /** 下一帧。窗口最小化时 requestAnimationFrame 不跑，要有兜底 */
  frame(callback: () => void): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** 选区停下多久后补发一次最终位置（数据报可能丢） */
export const CURSOR_SETTLE_MS = 200;
/** 静止时多久发一次心跳 */
export const CURSOR_HEARTBEAT_MS = 5000;
/** 多久没消息就当对方的光标没了 */
export const CURSOR_TIMEOUT_MS = 15000;

export const browserScheduler: CollabScheduler = {
  now: () => performance.now(),
  frame(callback) {
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      callback();
    };
    requestAnimationFrame(run);
    // 窗口藏起来时 rAF 停了，远端的字还得照收（主持人要照存）
    setTimeout(run, 50);
  },
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface CollabSessionOptions {
  self: Peer;
  transport: CollabTransport;
  /**
   * 主持人：文档现在的正文。访客不给，从主持人那里同步（两边各自用同一段文字建文档
   * 的话，合并后正文会重复一遍）
   */
  initialText?: string;
  /**
   * 继续上次没正常结束的协作：落盘的文档状态（record.rs）。双方的 CRDT 历史都在，
   * 重连后同步就补齐，不用退回文本 diff
   */
  initialState?: Uint8Array;
  scheduler?: CollabScheduler;
  /** 收到坏掉的更新包之类：不让它把编辑器带崩，报出来 */
  onError?: (error: unknown) => void;
}

export class CollabSession {
  readonly doc = new LoroDoc();
  readonly text: LoroText;
  readonly self: Peer;

  private readonly transport: CollabTransport;
  private readonly scheduler: CollabScheduler;
  private readonly onError: (error: unknown) => void;
  private editor: CollabEditor | null = null;

  /** 还没发出去的本地更新包（同一个任务里攒着合成一包；组字期间一直攒着） */
  private outbox: Uint8Array[] = [];
  /** 自己这个 peer 发到第几个改动了：合包时从这里导出 */
  private sentCounter: number;
  private outScheduled = false;
  /** 还没应用的远端更新包 */
  private inbox: Uint8Array[] = [];
  /** 这一帧已经应用过一次了 */
  private appliedThisFrame = false;
  private frameScheduled = false;
  /** 组字期间别人来要同步：放行时再回 */
  private deferredSync: Array<() => void> = [];
  /** 组字期间到的外部改动（external.ts）：放行时再合进来 */
  private externalQueue: Uint8Array[] = [];
  /** import 了但还挂着（缺前面的改动）的包：until 是每个 peer 要到第几个才算都生效了（notePending） */
  private pendingBlobs: { bytes: Uint8Array; until: Map<PeerID, number> }[] = [];

  private readonly cursors = new Map<string, StoredCursor>();
  private readonly cursorListeners = new Set<() => void>();
  private readonly appliedListeners = new Set<() => void>();
  private local: { anchor: Uint8Array; head: Uint8Array } | null = null;
  private cursorSeq = 0;
  private cursorFrameScheduled = false;
  private settleTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private readonly stopLocalUpdates: () => void;
  private destroyed = false;

  constructor(options: CollabSessionOptions) {
    this.self = options.self;
    this.transport = options.transport;
    this.scheduler = options.scheduler ?? browserScheduler;
    this.onError = options.onError ?? ((error) => console.error("协作：", error));
    this.text = this.doc.getText(TEXT_NAME);
    if (options.initialState) {
      try {
        this.doc.import(options.initialState);
      } catch (error) {
        // 落盘的是别的格式（换 Loro 以前的）、坏了：当没有，重连时从对方那里补齐
        this.onError(error);
      }
    } else if (options.initialText) {
      this.text.insert(0, options.initialText);
      this.doc.commit();
    }
    // 建好之后才开始往外发：初始正文由同步（Sync2）带过去
    this.sentCounter = this.ownCounter();
    this.stopLocalUpdates = this.doc.subscribeLocalUpdates(this.onLocalUpdate);
  }

  /** 现在的正文（编辑器没挂着时主持人照这个存） */
  toString(): string {
    return this.text.toString();
  }

  /** 整个文档的状态：落盘用（崩溃后接得上） */
  encodeState(): Uint8Array {
    return this.doc.export({ mode: "snapshot" });
  }

  /** 改正文（不经过编辑器：实验台的机器人、测试里扮演另一台电脑上打字的人）。改完就 commit */
  insertText(index: number, content: string): void {
    this.text.insert(Math.min(index, this.text.length), content);
    this.doc.commit();
  }

  deleteText(index: number, length: number): void {
    this.text.delete(index, length);
    this.doc.commit();
  }

  /* ---------------- 编辑器 ---------------- */

  /** 编辑器挂上来。同一时刻只挂一个；返回的函数是摘下 */
  attach(editor: CollabEditor): () => void {
    this.editor = editor;
    return () => {
      if (this.editor !== editor) return;
      this.editor = null;
      this.flushHeld();
    };
  }

  private get held(): boolean {
    return !!this.editor?.composing();
  }

  /** 组字结束：攒着的本地更新合成一包发出去，排队的远端更新一次应用 */
  flushHeld(): void {
    if (this.held || this.destroyed) return;
    this.flushOut();
    this.appliedThisFrame = false;
    this.flushIn();
    for (const update of this.externalQueue.splice(0)) this.applyExternal(update);
    for (const answer of this.deferredSync.splice(0)) answer();
    // 组字期间发的光标可能指着拼音字母（对方那里还没有），放行后补发一次
    if (this.local) this.scheduleCursorSend();
  }

  /* ---------------- 发 ---------------- */

  /** 自己这个 peer 下一个改动的序号 */
  private ownCounter(): number {
    return this.doc.oplogVersion().get(this.doc.peerIdStr) ?? 0;
  }

  private readonly onLocalUpdate = (update: Uint8Array) => {
    if (this.destroyed) return;
    this.outbox.push(update);
    if (this.outScheduled) return;
    this.outScheduled = true;
    queueMicrotask(() => {
      this.outScheduled = false;
      if (!this.held) this.flushOut();
    });
  };

  private flushOut() {
    if (!this.outbox.length) return;
    const end = this.ownCounter();
    let update = this.outbox[0]!;
    if (this.outbox.length > 1 && end > this.sentCounter) {
      // 好几包合成一包：组字期间的拼音、删掉重打都在里面，对方 import 一次只看到结果
      update = this.doc.export({
        mode: "updates-in-range",
        spans: [
          {
            id: { peer: this.doc.peerIdStr, counter: this.sentCounter },
            len: end - this.sentCounter,
          },
        ],
      });
    }
    this.outbox = [];
    this.sentCounter = end;
    this.transport.sendUpdate(update);
  }

  /* ---------------- 收 ---------------- */

  receiveUpdate(update: Uint8Array): void {
    if (this.destroyed) return;
    this.inbox.push(update);
    if (this.appliedThisFrame) {
      this.scheduleFrame();
      return;
    }
    this.flushIn();
  }

  private flushIn() {
    if (!this.inbox.length) return;
    // 组字期间：编辑器读完 DOM 里的组字改动才能动文档，读不了就等组字结束（flushHeld）
    if (this.held && !this.editor?.readPendingInput?.()) return;
    const batch = this.inbox;
    this.inbox = [];
    this.appliedThisFrame = true;
    this.scheduleFrame();
    try {
      const status = batch.length === 1 ? this.doc.import(batch[0]!) : this.doc.importBatch(batch);
      this.notePending(batch, status);
    } catch (error) {
      // 一起 import 不进去：一个个来，坏的那个跳过（报出来）
      if (batch.length === 1) this.onError(error);
      else
        for (const each of batch) {
          try {
            this.notePending([each], this.doc.import(each));
          } catch (single) {
            this.onError(single);
          }
        }
    }
    this.prunePending();
    for (const listener of this.appliedListeners) listener();
  }

  /**
   * import 进来、但缺着前面的改动、Loro 先挂起来没生效的包，原样留着，回同步时一起给（answerSync）：
   * Loro 按版本向量导出的增量里没有挂着的。主持人收到一个挂着的包、转给当时正断着的人没送到，
   * 那人重连时主持人导出的里面也没有它，等依赖到了只转依赖本身 —— 他就永远缺这一包
   * （模糊测试种子 1015）。Yjs 导出时会带上挂着的，换 Loro 以后要自己记
   */
  private notePending(blobs: Uint8Array[], status: ImportStatus) {
    if (!status.pending?.size) return;
    const until = new Map([...status.pending].map(([peer, span]) => [peer, span.end]));
    for (const bytes of blobs) this.pendingBlobs.push({ bytes, until });
  }

  /** 依赖都到了、已经生效的包不用再留 */
  private prunePending() {
    if (!this.pendingBlobs.length) return;
    const version = this.doc.oplogVersion();
    this.pendingBlobs = this.pendingBlobs.filter(({ until }) =>
      [...until].some(([peer, end]) => (version.get(peer) ?? 0) < end),
    );
  }

  private scheduleFrame() {
    if (this.frameScheduled) return;
    this.frameScheduled = true;
    this.scheduler.frame(() => {
      this.frameScheduled = false;
      this.appliedThisFrame = false;
      if (this.inbox.length) this.flushIn();
    });
  }

  /** 文档变了（本地改的、import 进来的都算）：主持人存盘、落盘、访客看图片用 */
  onChange(listener: () => void): () => void {
    return this.doc.subscribe(() => {
      if (!this.destroyed) listener();
    });
  }

  /** 远端更新应用进来之后（光标要重新认位置：之前认不出的字可能到了） */
  onApplied(listener: () => void): () => void {
    this.appliedListeners.add(listener);
    return () => this.appliedListeners.delete(listener);
  }

  /**
   * 外部程序改了文件，合进会话（external.ts 算好的更新包，另一个 peer 写的）。和远端更新一样
   * 组字期间先排队；不一样的是它要发给所有人 —— 别人那里也该看到磁盘上的新内容
   */
  applyExternal(update: Uint8Array): void {
    if (this.destroyed) return;
    if (this.held) {
      this.externalQueue.push(update);
      return;
    }
    try {
      this.doc.import(update);
    } catch (error) {
      this.onError(error);
      return;
    }
    this.transport.sendUpdate(update);
  }

  /* ---------------- 同步（Sync1 / Sync2） ---------------- */

  /** Sync1：告诉对方我有什么（版本向量） */
  stateVector(): Uint8Array {
    return this.doc.oplogVersion().encode();
  }

  /**
   * 对方发来 Sync1：回它缺的（Sync2）。
   * - 收件箱里还排着没应用的（等下一帧的）先应用掉再回：那些包网络层收到时已经转给了当时
   *   连着的人，刚重连的这位没收到；Sync2 再不带上，他就永远缺这几个字（模糊测试种子 622）
   * - 组字期间先不回，不然拼音字母会跟着发过去；放行时先应用收件箱、再回
   */
  answerSync(stateVector: Uint8Array, reply: (update: Uint8Array) => void): void {
    const answer = () => {
      let from: VersionVector;
      try {
        from = VersionVector.decode(stateVector);
      } catch (error) {
        this.onError(error);
        return;
      }
      reply(this.doc.export({ mode: "update", from }));
      // 挂着的包导出里没有，原样补上（对方要是已经有了，再 import 一次也没事）
      for (const { bytes } of this.pendingBlobs) reply(bytes);
    };
    if (this.held) {
      this.deferredSync.push(answer);
      return;
    }
    this.flushIn();
    answer();
  }

  /* ---------------- 光标 ---------------- */

  /**
   * 本地选区变了。同一帧只发最后一次；停下 200ms 后补发一次（数据报可能丢）；
   * 静止时 5 秒一次心跳。null 是没有光标了（编辑器摘下来了）
   */
  setLocalCursor(anchor: number | null, head = anchor): void {
    if (this.destroyed) return;
    if (anchor === null || head === null) {
      if (!this.local) return;
      this.local = null;
      this.sendCursorNow();
      return;
    }
    const length = this.text.length;
    const anchorBytes = encodePosition(this.text, Math.min(anchor, length));
    const headBytes = encodePosition(this.text, Math.min(head, length));
    if (!anchorBytes || !headBytes) return;
    this.local = { anchor: anchorBytes, head: headBytes };
    this.scheduleCursorSend();
  }

  private scheduleCursorSend() {
    if (this.cursorFrameScheduled) return;
    this.cursorFrameScheduled = true;
    this.scheduler.frame(() => {
      this.cursorFrameScheduled = false;
      if (this.destroyed) return;
      this.sendCursorNow();
      this.scheduler.clearTimeout(this.settleTimer);
      this.settleTimer = this.scheduler.setTimeout(() => this.sendCursorNow(), CURSOR_SETTLE_MS);
    });
  }

  private sendCursorNow() {
    if (this.destroyed) return;
    this.cursorSeq += 1;
    this.transport.sendCursor(encodeCursor(this.cursorSeq, this.local));
    this.scheduler.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = this.local
      ? this.scheduler.setTimeout(() => this.sendCursorNow(), CURSOR_HEARTBEAT_MS)
      : null;
  }

  /** 收到别人的光标（数据报） */
  receiveCursor(peer: Peer, payload: Uint8Array): void {
    if (this.destroyed || peer.id === this.self.id) return;
    let decoded: DecodedCursor;
    try {
      decoded = decodeCursor(payload);
    } catch (error) {
      this.onError(error);
      return;
    }
    const now = this.scheduler.now();
    const previous = this.cursors.get(peer.id);
    // 乱序到的旧消息不要。对方重开过（序号从头来）的话，旧的早就超时了
    if (previous && decoded.seq <= previous.seq && now - previous.seenAt < CURSOR_TIMEOUT_MS) {
      return;
    }
    const moved =
      !previous ||
      !sameBytes(previous.anchorBytes, decoded.anchor) ||
      !sameBytes(previous.headBytes, decoded.head) ||
      previous.peer.name !== peer.name ||
      previous.peer.color !== peer.color;
    const cursor: StoredCursor = {
      peer,
      anchor: decodePosition(decoded.anchor),
      head: decodePosition(decoded.head),
      anchorBytes: decoded.anchor,
      headBytes: decoded.head,
      seq: decoded.seq,
      seenAt: now,
      movedAt: moved ? now : (previous?.movedAt ?? now),
    };
    this.cursors.set(peer.id, cursor);
    for (const listener of this.cursorListeners) listener();
  }

  /** 有人走了：他的光标马上收起 */
  removePeer(id: string): void {
    if (!this.cursors.delete(id)) return;
    for (const listener of this.cursorListeners) listener();
  }

  remoteCursors(): ReadonlyMap<string, RemoteCursor> {
    return this.cursors;
  }

  onCursors(listener: () => void): () => void {
    this.cursorListeners.add(listener);
    return () => this.cursorListeners.delete(listener);
  }

  /** 把一个光标位置换成现在正文里的下标；指着的字还没到（更新包在路上）是 null */
  resolve(position: Cursor | null): number | null {
    if (!position) return null;
    try {
      return this.doc.getCursorPos(position)?.offset ?? null;
    } catch {
      return null;
    }
  }

  get now(): number {
    return this.scheduler.now();
  }

  /** 定时器（binding 里名字标签熄灭、光标超时用同一套，测试里一起推进） */
  get timers(): CollabScheduler {
    return this.scheduler;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scheduler.clearTimeout(this.settleTimer);
    this.scheduler.clearTimeout(this.heartbeatTimer);
    this.stopLocalUpdates();
    this.cursorListeners.clear();
    this.appliedListeners.clear();
  }
}

interface StoredCursor extends RemoteCursor {
  anchorBytes: Uint8Array | null;
  headBytes: Uint8Array | null;
}

export { PEER_COLORS, peerColor } from "./colors";

/* ---------------- 光标的编码 ----------------
   数据报的内容（Rust 不解析）：
     1 字节 版本（2）| 4 字节 序号（小端）| 1 字节 有没有光标
     有的话：2 字节 anchor 长度 | anchor | head
   位置是 Loro 的 Cursor.encode()：贴着字走，不会被别人的插入挤偏。 */

const CURSOR_VERSION = 2;

interface DecodedCursor {
  seq: number;
  anchor: Uint8Array | null;
  head: Uint8Array | null;
}

function encodePosition(text: LoroText, index: number): Uint8Array | null {
  return text.getCursor(index)?.encode() ?? null;
}

function decodePosition(bytes: Uint8Array | null): Cursor | null {
  if (!bytes) return null;
  try {
    return Cursor.decode(bytes);
  } catch {
    return null;
  }
}

export function encodeCursor(
  seq: number,
  cursor: { anchor: Uint8Array; head: Uint8Array } | null,
): Uint8Array {
  const size = 6 + (cursor ? 2 + cursor.anchor.length + cursor.head.length : 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, CURSOR_VERSION);
  view.setUint32(1, seq >>> 0, true);
  view.setUint8(5, cursor ? 1 : 0);
  if (cursor) {
    view.setUint16(6, cursor.anchor.length, true);
    bytes.set(cursor.anchor, 8);
    bytes.set(cursor.head, 8 + cursor.anchor.length);
  }
  return bytes;
}

function decodeCursor(bytes: Uint8Array): DecodedCursor {
  if (bytes.length < 6 || bytes[0] !== CURSOR_VERSION) throw new Error("认不出的光标消息");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seq = view.getUint32(1, true);
  if (!view.getUint8(5)) return { seq, anchor: null, head: null };
  if (bytes.length < 8) throw new Error("光标消息不完整");
  const anchorLength = view.getUint16(6, true);
  if (8 + anchorLength > bytes.length) throw new Error("光标消息不完整");
  return {
    seq,
    anchor: bytes.slice(8, 8 + anchorLength),
    head: bytes.slice(8 + anchorLength),
  };
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}
