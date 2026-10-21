import type {
  AttachmentRef,
  CollabIdentity,
  CollabResume,
  Control,
  Diagnosis,
  MemberInfo,
  Permission,
  Reach,
  RelayInfo,
  Status,
  TrustedPeer,
} from "@/lib/bindings";
import { type CollabNet, type Frame, PIPE } from "./net";
import { CollabSession, type Peer, peerColor } from "./session";

/* ============================================================
   浏览器预览里的协作网络（没有 Rust）。和 Rust 那边说同一套帧（net.ts 的 PIPE），
   所以前端的会话、界面一行不用改：
   - 主持：一会儿以后「Alex 想加入」；允许了，Alex 用一个真的 Yjs 会话和你同步，隔一会儿
     在第一段后面打一句话、光标跟着动
   - 加入：连接中 → 等确认 → 进来，对面「林夕」的文档同步过来，她也会打几个字
   - 互联网上（P10.2）：主持时过一会儿报「只有同一网络里的人能加入」（配了中继的话是经由它）；
     链接里有 far 的连不上（3 秒给结论），生成回连链接以后过一会儿「主持人拨过来了」；
     链接里有 relay 的带着主持人的中继；主持时打开回连链接，过一会儿「Sam 想加入」
   - 中继：存在内存里；地址里有 bad 的测试时令牌被拒
   - 附近：过一会儿列出林夕和 Sam；点了照常进来
   - 落盘：交来的状态存在内存里；单测用 simulateCrash() 假装崩了，再「继续上次的协作」
   - 附件：访客要的图片回一张占位的 SVG；粘贴的回「附件/文件名」
   时间可以按比例缩（单测里设得很快）。
   ============================================================ */

export interface MockNetOptions {
  /** 所有等待乘上它（单测里给 0.01） */
  speed?: number;
  /** 模拟的人自己打不打字（单测里关掉，手动调 remoteType） */
  bots?: boolean;
}

export interface MockNet extends CollabNet {
  /** 单测：让对面那位打几个字 */
  remoteType(text: string, at?: number): void;
  /** 单测：对面那位的正文 */
  remoteText(): string;
  /** 单测：主持人最近交来的附件引用 */
  attachmentRefs(): AttachmentRef[];
  /** 单测：假装崩了 —— 落盘的留着，会话没了（下次 resumeInfo 里有） */
  simulateCrash(): void;
}

const SAMPLE = `# 周会记录

这一页大家一起改：林夕在主持，你是访客。

## 本周

- [ ] 把协同编辑接上网络
- [x] 编辑器绑定
`;

export function createMockNet(options: MockNetOptions = {}): MockNet {
  const speed = options.speed ?? 1;
  const bots = options.bots ?? true;
  const later = (ms: number, run: () => void) => setTimeout(run, ms * speed);

  let identity: CollabIdentity = {
    id: `mock-${Math.random().toString(16).slice(2, 10)}`,
    name: "我",
  };
  let onFrame: ((frame: Frame) => void) | null = null;
  const controls = new Set<(control: Control) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const schedule = (ms: number, run: () => void) => {
    const timer = later(ms, () => {
      timers.delete(timer);
      run();
    });
    timers.add(timer);
  };
  const emit = (control: Control) => {
    for (const listener of controls) listener(control);
  };
  const status = (status: Status) => emit({ type: "status", status });
  const frame = (kind: number, member: number, payload: Uint8Array) => {
    // 和真的 Channel 一样异步到
    queueMicrotask(() => onFrame?.({ kind, member, payload }));
  };

  /** 对面那位：成员号、Yjs 会话、权限 */
  let remote: {
    member: number;
    peer: Peer;
    session: CollabSession;
    permission: Permission;
    bot: ReturnType<typeof setInterval> | null;
  } | null = null;
  let role: "idle" | "host" | "guest" = "idle";
  let title = "";
  let pendingRequest: number | null = null;
  let pendingPeer: Peer | null = null;
  /** 记住的人（真的存在 config.json，这里只在这个模拟网络活着的时候有） */
  let trusted: TrustedPeer[] = [];
  let hostLink = "";
  let joining = "";
  let relays: RelayInfo[] = [];
  let hostNote = "";
  let refs: AttachmentRef[] = [];
  /** 落盘：现在这一次的、崩了留下来的 */
  let saved: Uint8Array | null = null;
  let left: { host: boolean; state: Uint8Array; note: string; title: string } | null = null;
  const PLACEHOLDER = `data:image/svg+xml;utf8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#e5e5df"/><text x="120" y="66" font-size="14" text-anchor="middle" fill="#74746e">主持人那边的图</text></svg>',
  )}`;

  /** 主持人的自检：先「在查」，过一会儿出结果（配了中继的话经由它） */
  const reachOf = (checking: boolean): Reach => ({
    checking,
    lan: ["192.168.1.23"],
    ipv6: [],
    publicV4: [],
    portmap: checking ? { state: "checking" } : { state: "unavailable" },
    firewall: checking ? { state: "unknown" } : { state: "allowed", public: false },
    relays: relays.map((relay) => ({
      url: relay.url,
      label: relay.name ?? relay.host,
      state: checking ? { state: "connecting" } : { state: "connected", latency: 38 },
    })),
  });
  const farDiagnosis: Diagnosis = {
    lan: ["192.168.7.5"],
    ipv6: [],
    ipv4: [],
    relay: null,
    sameNetwork: false,
    seenNearby: false,
    hasIpv6: true,
    cause: { kind: "differentNetwork" },
  };
  /** 等确认 → 进来（加入、回连都走这里） */
  const admitGuest = () => {
    status({ state: "waiting" });
    schedule(900, () => {
      if (role !== "guest") return;
      title = "周会记录";
      connect(
        { id: "mock-linxi", name: "林夕", color: peerColor("mock-linxi") },
        0,
        "edit",
        SAMPLE,
      );
      status({ state: "connected", member: 1, permission: "edit", title });
      emit({ type: "route", relayed: false });
    });
  };

  const selfInfo = (member: number): MemberInfo => ({
    member,
    id: identity.id,
    name: identity.name,
    permission: "edit",
    host: role === "host",
    via: null,
  });
  const members = (): MemberInfo[] => {
    if (!remote) return [selfInfo(0)];
    const other: MemberInfo = {
      member: remote.member,
      id: remote.peer.id,
      name: remote.peer.name,
      permission: remote.permission,
      host: role === "guest",
      via: null,
    };
    return role === "host" ? [selfInfo(0), other] : [other, selfInfo(1)];
  };

  /** 对面那位进来：建会话，双方互发 Sync1 */
  const connect = (peer: Peer, member: number, permission: Permission, text?: string) => {
    const session = new CollabSession({
      self: peer,
      initialText: text,
      transport: {
        sendUpdate: (update) => {
          // 只读的访客发的更新，主持人那边（Rust）会丢掉
          if (role === "host" && remote?.permission === "read") return;
          frame(PIPE.update, member, update);
        },
        sendCursor: (payload) => frame(PIPE.cursor, member, payload),
      },
    });
    remote = { member, peer, session, permission, bot: null };
    emit({ type: "members", members: members() });
    // 请前端把状态向量发过来；对面也把自己的发过去
    frame(PIPE.syncVector, member, new Uint8Array());
    frame(PIPE.syncReply, member, session.stateVector());
    if (bots) startBot();
  };

  const stopBot = () => {
    if (remote?.bot) clearInterval(remote.bot);
    if (remote) remote.bot = null;
  };

  const remoteType = (text: string, at?: number) => {
    const session = remote?.session;
    if (!session) return;
    let position = at ?? firstParagraphEnd(session.toString());
    for (const char of text) {
      session.insertText(Math.min(position, session.text.length), char);
      position += char.length;
    }
    session.setLocalCursor(position);
  };

  /** 隔一会儿打一句话，一个字一个字地打 */
  const startBot = () => {
    if (!remote) return;
    const line = role === "host" ? "（Alex：这一条我来跟进。）" : "（林夕：欢迎！）";
    let index = 0;
    let position = -1;
    schedule(2500, () => {
      if (!remote) return;
      remote.bot = setInterval(() => {
        const session = remote?.session;
        if (!session || remote?.permission === "read") return;
        if (index >= [...line].length) {
          stopBot();
          return;
        }
        if (position < 0) position = firstParagraphEnd(session.toString());
        const char = [...line][index]!;
        session.insertText(Math.min(position, session.text.length), char);
        position += char.length;
        index += 1;
        session.setLocalCursor(position);
      }, 180 * speed);
    });
  };

  const leave = () => {
    stopBot();
    remote?.session.destroy();
    remote = null;
  };

  return {
    identity: async () => identity,
    setName: async (name) => {
      identity = { ...identity, name: name.trim() || "我" };
      // 协作中改名：成员表跟着换（Rust 那边是主持人广播、访客发 NAME 帧）
      if (role !== "idle") emit({ type: "members", members: members() });
    },
    host: async (nextTitle, permission, note, resume) => {
      leave();
      role = "host";
      title = nextTitle;
      hostNote = note;
      void resume;
      await new Promise((resolve) => later(600, () => resolve(null)));
      // 过一会儿有人拿着链接来了
      schedule(1500, () => {
        if (role !== "host" || remote) return;
        const alex = { id: "mock-alex", name: "Alex", color: peerColor("mock-alex") };
        // 记住过的：不问，直接按记住的权限进来
        const known = trusted.find((peer) => peer.id === alex.id);
        if (known) {
          connect(alex, 1, known.permission);
          return;
        }
        pendingRequest = 1;
        pendingPeer = alex;
        emit({
          type: "joinRequest",
          request: 1,
          id: "mock-alex",
          name: "Alex",
          invited: true,
          via: null,
        });
      });
      void permission;
      hostLink = `odea://join/mock${identity.id.slice(5)}aaaabbbbccccdddd`;
      schedule(20, () => {
        if (role === "host") emit({ type: "reach", reach: reachOf(true), link: hostLink });
      });
      schedule(900, () => {
        if (role === "host") emit({ type: "reach", reach: reachOf(false), link: hostLink });
      });
      return { link: hostLink, id: identity.id, members: members() };
    },
    resetInvite: async () => `odea://join/mock${Math.random().toString(36).slice(2)}`,
    checkLink: async (link) =>
      /^\s*<?(odea:\/\/join\/)?[a-z2-7]{8,}/i.test(link)
        ? { relay: /relay/i.test(link) ? "relay.example.com" : null }
        : "这不是 Odea 的协作链接",
    join: async (link, directOnly) => {
      void directOnly;
      leave();
      role = "guest";
      joining = link;
      status({ state: "connecting" });
      // 链接里有 far：连不上，3 秒给结论（等回连）
      if (/far/i.test(link)) {
        schedule(3000, () => {
          if (role === "guest" && !remote)
            status({ state: "unreachable", diagnosis: farDiagnosis });
        });
        return;
      }
      schedule(500, admitGuest);
    },
    forwardLink: async () => {
      await new Promise((resolve) => later(600, () => resolve(null)));
      return {
        link: `odea://join/mock${identity.id.slice(5)}fwdfwdfwdfwdfwdf`,
        reach: { ...reachOf(false), ipv6: ["2408:8207:1234::6"] },
      };
    },
    callback: async () => {
      await new Promise((resolve) => later(600, () => resolve(null)));
      // 过一会儿主持人打开了回连链接、拨过来了
      schedule(2500, () => {
        if (role === "guest" && !remote && /far/i.test(joining)) admitGuest();
      });
      return {
        link: `odea://back/mock${identity.id.slice(5)}eeeeffffgggghhhh`,
        reach: { ...reachOf(false), ipv6: ["2408:8207:1234::5"] },
      };
    },
    dialBack: async (link) => {
      if (role !== "host") throw new Error("回连链接要在主持协作时打开");
      if (!/^\s*<?odea:\/\/back\//i.test(link)) throw new Error("这不是 Odea 的回连链接");
      schedule(800, () => {
        if (role !== "host") return;
        emit({ type: "dialBack", ok: true, detail: null });
        pendingRequest = 2;
        pendingPeer = { id: "mock-sam", name: "Sam", color: peerColor("mock-sam") };
        emit({
          type: "joinRequest",
          request: 2,
          id: "mock-sam",
          name: "Sam",
          invited: true,
          via: null,
        });
      });
    },
    nearbyStart: async () => {
      schedule(700, () =>
        emit({
          type: "nearby",
          hosts: [
            { id: "mock-linxi", name: "林夕" },
            { id: "mock-sam", name: "Sam" },
          ],
        }),
      );
    },
    nearbyStop: async () => {},
    joinNearby: async (id) => {
      void id;
      leave();
      role = "guest";
      joining = "nearby";
      status({ state: "connecting" });
      schedule(500, admitGuest);
    },
    saveState: (state) => {
      saved = state.slice();
    },
    resumeInfo: async (): Promise<CollabResume> => ({
      host:
        left?.host === true
          ? { note: left.note, title: left.title, guests: 1, savedAt: Date.now() }
          : null,
      guest:
        left?.host === false ? { title: left.title, hostName: "林夕", savedAt: Date.now() } : null,
    }),
    resumeState: async (host) => {
      if (!left || left.host !== host) throw new Error("上次协作的状态已经没了");
      return left.state;
    },
    rejoin: async () => {
      leave();
      role = "guest";
      joining = "rejoin";
      left = null;
      status({ state: "connecting" });
      schedule(500, admitGuest);
    },
    discardResume: async (host) => {
      if (left?.host === host) left = null;
    },
    setAttachmentRefs: async (next) => {
      refs = next;
    },
    fetchAttachment: async (path) => {
      await new Promise((resolve) => later(150, () => resolve(null)));
      if (role !== "guest") throw new Error("现在没连着主持人");
      void path;
      return { url: PLACEHOLDER, file: null };
    },
    putAttachment: async (name) => {
      await new Promise((resolve) => later(150, () => resolve(null)));
      return {
        link: `附件/${name}`,
        name,
        isImage: /\.(png|jpe?g|gif|webp|svg)$/i.test(name),
      };
    },
    putAttachmentPath: async (path) => {
      const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
      return { link: `附件/${name}`, name, isImage: /\.(png|jpe?g|gif|webp|svg)$/i.test(name) };
    },
    relays: async () => relays,
    relayInspect: async (code) => {
      if (!/odea:\/\/relay\/[a-z2-7]+/i.test(code)) throw new Error("这不是 Odea 的协作链接");
      return {
        url: "https://relay.example.com/",
        host: "relay.example.com",
        name: "团队的中继",
        hasToken: true,
        pinned: false,
      };
    },
    relayAdd: async (input) => {
      const info: RelayInfo =
        "code" in input
          ? {
              url: "https://relay.example.com/",
              host: "relay.example.com",
              name: "团队的中继",
              hasToken: true,
              pinned: false,
            }
          : (() => {
              const host = input.url
                .trim()
                .replace(/^https:\/\//i, "")
                .replace(/\/+$/, "");
              if (!host || /^http:/i.test(input.url))
                throw new Error("中继地址不对：要 https:// 开头");
              return {
                url: `https://${host.toLowerCase()}/`,
                host: host.toLowerCase(),
                name: input.name?.trim() || null,
                hasToken: !!input.token?.trim(),
                pinned: !!input.fingerprint?.trim(),
              };
            })();
      relays = [...relays.filter((relay) => relay.url !== info.url), info];
      return relays;
    },
    relayRemove: async (url) => {
      relays = relays.filter((relay) => relay.url !== url);
      return relays;
    },
    relayCode: async (url) => {
      if (!relays.some((relay) => relay.url === url)) throw new Error("这台中继已经删掉了");
      return "odea://relay/mockaaaabbbbccccdddd";
    },
    relayTest: async (url) => {
      await new Promise((resolve) => later(700, () => resolve(null)));
      if (/old/i.test(url))
        return {
          connected: false,
          latencyMs: null,
          denied: null,
          error: null,
          udp: null,
          outdated: "iroh-relay-v3",
        };
      return /bad/i.test(url)
        ? {
            connected: false,
            latencyMs: null,
            denied: "token rejected",
            error: null,
            udp: null,
            outdated: null,
          }
        : { connected: true, latencyMs: 38, denied: null, error: null, udp: true, outdated: null };
    },
    answer: async (request, allow) => {
      if (request !== pendingRequest || !pendingPeer) return false;
      pendingRequest = null;
      if (allow) {
        // 模拟的只有一位对面的人：后来的顶替先来的
        if (remote) leave();
        connect(pendingPeer, request, allow);
      }
      pendingPeer = null;
      return true;
    },
    setPermission: async (member, permission) => {
      if (remote?.member !== member) return;
      remote.permission = permission;
      const id = remote.peer.id;
      trusted = trusted.map((peer) => (peer.id === id ? { ...peer, permission } : peer));
      emit({ type: "members", members: members() });
    },
    kick: async (member) => {
      if (remote?.member !== member) return;
      const id = remote.peer.id;
      trusted = trusted.filter((peer) => peer.id !== id);
      leave();
      emit({ type: "members", members: members() });
    },
    trusted: async () => trusted,
    remember: async (id, name, permission) => {
      trusted = [...trusted.filter((peer) => peer.id !== id), { id, name, permission }];
      return trusted;
    },
    forget: async (id) => {
      trusted = trusted.filter((peer) => peer.id !== id);
      return trusted;
    },
    setTitle: async (next) => {
      title = next;
    },
    stop: async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      leave();
      pendingRequest = null;
      role = "idle";
      // 正常结束：落盘的删掉
      saved = null;
      status({ state: "ended", reason: { kind: "left" } });
    },
    openPipe: async (listener) => {
      onFrame = listener;
      return () => {
        if (onFrame === listener) onFrame = null;
      };
    },
    send: (kind, member, payload) => {
      const session = remote?.session;
      if (!session) return;
      const bytes = payload.slice();
      switch (kind) {
        case PIPE.update:
          session.receiveUpdate(bytes);
          return;
        case PIPE.cursor:
          session.receiveCursor(
            { id: identity.id, name: identity.name, color: peerColor(identity.id) },
            bytes,
          );
          return;
        case PIPE.syncVector:
          if (member !== remote!.member) return;
          session.answerSync(bytes, (reply) => frame(PIPE.update, member, reply));
          return;
        case PIPE.syncReply:
          if (member !== remote!.member) return;
          session.receiveUpdate(bytes);
          return;
      }
    },
    onControl: async (listener) => {
      controls.add(listener);
      return () => controls.delete(listener);
    },
    pendingLink: async () => null,
    onLink: async () => () => {},
    copyToVault: async () => {
      throw new Error("浏览器预览里没有别的仓库窗口，桌面版里才能存过去");
    },
    takeCopy: async () => null,
    onCopyReady: async () => () => {},
    remoteType,
    remoteText: () => remote?.session.toString() ?? "",
    attachmentRefs: () => refs,
    simulateCrash: () => {
      if (saved && role !== "idle") {
        left = { host: role === "host", state: saved, note: hostNote, title: title || "周会记录" };
      }
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      leave();
      pendingRequest = null;
      role = "idle";
      saved = null;
    },
  };
}

/** 第一段正文的末尾（跳过标题）：模拟的人在这里打字 */
function firstParagraphEnd(text: string): number {
  const lines = text.split("\n");
  let offset = 0;
  for (const line of lines) {
    if (line.trim() && !line.startsWith("#")) return offset + line.length;
    offset += line.length + 1;
  }
  return text.length;
}
