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
   ============================================================ */

export interface SessionLink {
  /** 哪一篇（文档 id） */
  readonly doc: string;
  readonly session: CollabSession;
  /** 收到一帧 */
  receive(frame: Frame): void;
  /** 成员变了：成员号 → 是谁（光标按它认人）；走了的人光标马上收起 */
  setMembers(members: readonly MemberInfo[]): void;
  peerOf(member: number): Peer | undefined;
  destroy(): void;
}

export function peerOfMember(member: MemberInfo): Peer {
  return { id: member.id, name: member.name, color: peerColor(member.id) };
}

export function linkSession(
  net: CollabNet,
  options: {
    doc: string;
    self: Peer;
    initialText?: string;
    initialState?: Uint8Array;
    scheduler?: CollabScheduler;
  },
): SessionLink {
  const peers = new Map<number, Peer>();
  const { doc } = options;
  const session = new CollabSession({
    self: options.self,
    initialText: options.initialText,
    initialState: options.initialState,
    scheduler: options.scheduler,
    transport: {
      sendUpdate: (update) => net.send(PIPE.update, 0, doc, update),
      sendCursor: (payload) => net.send(PIPE.cursor, 0, doc, payload),
    },
  });

  return {
    doc,
    session,
    receive(frame) {
      switch (frame.kind) {
        case PIPE.update:
          session.receiveUpdate(frame.payload.slice());
          return;
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
        if (peer.id !== options.self.id) peers.set(member, peer);
      }
    },
    peerOf: (member) => peers.get(member),
    destroy() {
      peers.clear();
      session.destroy();
    },
  };
}
