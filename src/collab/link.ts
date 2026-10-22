import type { MemberInfo } from "@/lib/bindings";
import { type CollabNet, type Frame, PIPE } from "./net";
import { type CollabScheduler, CollabSession, type Peer, peerColor } from "./session";

/* ============================================================
   把一个会话（session.ts）接到网络上：会话发出的更新、光标变成帧，收到的帧交给会话。
   一篇一个会话、一个 link（设计 §22.5）：发出去的帧带着这一篇的文档 id，收到的帧由调用方按 doc 分好再交过来。

   同步（y-protocols 的 sync step 1 / 2）在这里接上：
   - Rust 说「刚连上某人」（syncVector）：把自己的状态向量发给他
   - Rust 说「某人发来了状态向量」（syncReply）：回他缺的
   两边各来一遍，断线期间各自的改动就补齐了。会话在组字时会先压着不回（session.answerSync）

   一份文档几条链路（设计 §22.5 最后一段）：团队仓库里我在一份团队会话里，又用「邀请协作…」请了外人 ——
   外人那条（attachSession）接到同一份会话上。本机打的发给每一条；从一条收到的更新转给别的几条
   （CRDT 的更新重复收到没关系）。光标不跨着转：两边各自看得到我，看不到对面那几位
   ============================================================ */

export interface SessionLink {
  /** 哪一篇（文档 id） */
  readonly doc: string;
  readonly session: CollabSession;
  /** 收到一帧 */
  receive(frame: Frame): void;
  /** 成员变了：成员号 → 是谁（光标按它认人）；走了的人光标马上收起。团队那边给的是 TeamPeer，也有这几样 */
  setMembers(members: readonly LinkMember[]): void;
  peerOf(member: number): Peer | undefined;
  destroy(): void;
}

/** 认人用的几样：会话的成员（MemberInfo）、团队里的设备（TeamPeer）都有 */
export type LinkMember = Pick<MemberInfo, "member" | "id" | "name">;

export function peerOfMember(member: LinkMember): Peer {
  return { id: member.id, name: member.name, color: peerColor(member.id) };
}

type Sender = Pick<CollabNet, "send">;

/** 一条链路：发到哪个网络、那边这一篇叫什么 */
interface Route {
  net: Sender;
  doc: string;
}

/** 每份会话接着的几条链路 */
const routesOf = new WeakMap<CollabSession, Set<Route>>();

function fanOut(routes: Set<Route>, kind: number, payload: Uint8Array, except?: Route) {
  for (const route of routes) {
    if (route !== except) route.net.send(kind, 0, route.doc, payload);
  }
}

export function linkSession(
  net: Sender,
  options: {
    doc: string;
    self: Peer;
    initialText?: string;
    initialState?: Uint8Array;
    scheduler?: CollabScheduler;
  },
): SessionLink {
  const route: Route = { net, doc: options.doc };
  const routes = new Set([route]);
  const session = new CollabSession({
    self: options.self,
    initialText: options.initialText,
    initialState: options.initialState,
    scheduler: options.scheduler,
    transport: {
      sendUpdate: (update) => fanOut(routes, PIPE.update, update),
      sendCursor: (payload) => fanOut(routes, PIPE.cursor, payload),
    },
  });
  routesOf.set(session, routes);
  return makeLink(session, route, routes, () => session.destroy());
}

/** 把已有的会话再接到一条链路上：本机打的也发给它，它那边来的更新转给别的链路。destroy 只摘掉这一条 */
export function attachSession(
  net: Sender,
  options: { doc: string; session: CollabSession },
): SessionLink {
  const routes = routesOf.get(options.session);
  if (!routes) throw new Error("这份会话不是 linkSession 建的");
  const route: Route = { net, doc: options.doc };
  routes.add(route);
  return makeLink(options.session, route, routes, () => routes.delete(route));
}

function makeLink(
  session: CollabSession,
  route: Route,
  routes: Set<Route>,
  onDestroy: () => void,
): SessionLink {
  const peers = new Map<number, Peer>();
  const { net, doc } = route;
  return {
    doc,
    session,
    receive(frame) {
      switch (frame.kind) {
        case PIPE.update: {
          const update = frame.payload.slice();
          session.receiveUpdate(update);
          // 别的链路上的人也该看到（一份文档几条链路时）
          if (routes.size > 1) fanOut(routes, PIPE.update, update, route);
          return;
        }
        case PIPE.cursor: {
          const peer = peers.get(frame.member);
          if (peer) session.receiveCursor(peer, frame.payload.slice());
          return;
        }
        case PIPE.syncReply:
          session.answerSync(frame.payload.slice(), (reply) =>
            net.send(PIPE.syncReply, frame.member, doc, reply),
          );
          return;
        case PIPE.syncVector:
          net.send(PIPE.syncVector, frame.member, doc, session.stateVector());
          return;
      }
    },
    setMembers(members) {
      const next = new Map(members.map((member) => [member.member, peerOfMember(member)]));
      for (const [member, peer] of peers) {
        if (!next.has(member) || next.get(member)!.id !== peer.id) session.removePeer(peer.id);
      }
      peers.clear();
      for (const [member, peer] of next) {
        if (peer.id !== session.self.id) peers.set(member, peer);
      }
    },
    peerOf: (member) => peers.get(member),
    destroy() {
      for (const peer of peers.values()) session.removePeer(peer.id);
      peers.clear();
      onDestroy();
    },
  };
}
