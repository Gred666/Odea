import { type Frame, PIPE } from "@/collab/net";
import type { DocumentSaveTarget } from "@/data/types";
import type { PresenceDoc, TeamControl, TeamPeer, TeamSelf } from "@/lib/bindings";
import type { TeamNet } from "./net";

/* ============================================================
   一个进程里的几台设备（单测）：和 Rust 的团队端点（src-tauri/src/team）同一套规矩 ——
   Presence 发给连得上的人；host 了这一篇的才接 open，不然 docClosed（refused）；每台收到的更新、光标
   转给这一篇的其他下游和上游（转过去的更新算转的那位发的，光标保留是谁的）；不接自己上游开来的流、
   不往自己的下游开流；不主持了、断线了，那一头是 docClosed。block 让两台互相连不上（隔着 NAT）。
   成员号整个 hub 一套（Rust 那边每台设备各编各的，前端不在乎）
   ============================================================ */

interface MockDevice {
  id: string;
  member: number;
  name: string;
  online: boolean;
  presence: PresenceDoc[];
  hosted: Set<string>;
  /** 主持：文档 → 访客 */
  guests: Map<string, Set<MockDevice>>;
  /** 做客：文档 → 主持人 */
  attached: Map<string, MockDevice>;
  pipe: ((frame: Frame) => void) | null;
  controls: Set<(control: TeamControl) => void>;
  /** 测试给的 git 里的版本 */
  bases: Map<string, string>;
  syncs: number;
}

export interface MockTeamHub {
  /** 加一台设备，返回它的网络层和「我」 */
  device(id: string, name: string): { net: TeamNet; self: () => TeamSelf };
  /** 断线 / 回来 */
  setOnline(id: string, online: boolean): void;
  /** 这两台互相连不上（各自和别人照常） */
  block(a: string, b: string): void;
  setBase(id: string, target: DocumentSaveTarget, text: string): void;
  /** 这台同步过几轮 git */
  syncs(id: string): number;
}

const keyOf = (target: DocumentSaveTarget) =>
  target.kind === "goal"
    ? `goal:${target.horizon}:${target.periodStart}`
    : `${target.kind}:${target.id}`;

export function createMockTeamHub(): MockTeamHub {
  const devices = new Map<string, MockDevice>();
  const blocked = new Set<string>();
  const later = (run: () => void) => setTimeout(run, 0);
  const pair = (a: MockDevice, b: MockDevice) => [a.id, b.id].sort().join("|");
  const reach = (a: MockDevice, b: MockDevice) => a.online && b.online && !blocked.has(pair(a, b));

  const peersOf = (me: MockDevice): TeamPeer[] =>
    [...devices.values()]
      .filter((device) => device !== me)
      .map((device) => {
        const online = reach(device, me);
        return {
          member: device.member,
          id: device.id,
          account: `github:${device.name}`,
          name: device.name,
          online,
          docs: online ? device.presence : [],
        };
      });

  const control = (to: MockDevice, event: TeamControl) => {
    later(() => {
      for (const listener of to.controls) listener(event);
    });
  };
  const frame = (
    to: MockDevice,
    kind: number,
    member: number,
    doc: string,
    payload: Uint8Array,
  ) => {
    const copy = payload.slice();
    later(() => to.pipe?.({ kind, member, doc, payload: copy }));
  };
  const announce = () => {
    for (const device of devices.values())
      control(device, { type: "peers", peers: peersOf(device) });
  };

  /** 一头的流断了：两边各自收到 docClosed */
  const unhost = (host: MockDevice, doc: string) => {
    for (const guest of host.guests.get(doc) ?? []) {
      guest.attached.delete(doc);
      control(guest, { type: "docClosed", doc, member: host.member, refused: null });
    }
    host.guests.delete(doc);
  };
  const detach = (guest: MockDevice, doc: string) => {
    const host = guest.attached.get(doc);
    if (!host) return;
    guest.attached.delete(doc);
    host.guests.get(doc)?.delete(guest);
    control(host, { type: "docClosed", doc, member: guest.member, refused: null });
  };

  /** 这一篇我的上下游：连着我的、我连着的 */
  const neighbours = (me: MockDevice, doc: string): MockDevice[] => {
    const host = me.attached.get(doc);
    return [...(me.guests.get(doc) ?? []), ...(host ? [host] : [])];
  };
  /** to 收到 from 发来的一个更新：交给前端，再转给 to 的其他上下游（Rust 的 relay_update） */
  const deliver = (to: MockDevice, from: MockDevice, doc: string, payload: Uint8Array) => {
    frame(to, PIPE.update, from.member, doc, payload);
    for (const next of neighbours(to, doc)) {
      if (next !== from) deliver(next, to, doc, payload);
    }
  };
  const deliverCursor = (
    to: MockDevice,
    from: MockDevice,
    origin: MockDevice,
    doc: string,
    payload: Uint8Array,
  ) => {
    frame(to, PIPE.cursor, origin.member, doc, payload);
    for (const next of neighbours(to, doc)) {
      if (next !== from && next !== origin) deliverCursor(next, to, origin, doc, payload);
    }
  };

  const netOf = (me: MockDevice): TeamNet => ({
    start: async () => ({
      team: "mock",
      id: me.id,
      member: me.member,
      name: me.name,
      peers: peersOf(me),
      firewall: { state: "unknown" },
    }),
    presence: async (docs) => {
      me.presence = docs;
      announce();
    },
    host: async (doc, on) => {
      if (on) me.hosted.add(doc);
      else {
        me.hosted.delete(doc);
        unhost(me, doc);
      }
    },
    open: async (doc, member) => {
      const host = [...devices.values()].find((device) => device.member === member);
      if (!host || !reach(host, me)) throw new Error("他不在线");
      if (me.guests.get(doc)?.has(host)) throw new Error("他这一篇是连着我的");
      detach(me, doc);
      if (!host.hosted.has(doc) || host.attached.get(doc) === me) {
        control(me, { type: "docClosed", doc, member, refused: "这一篇不是他在主持" });
        return;
      }
      me.attached.set(doc, host);
      const guests = host.guests.get(doc) ?? new Set();
      guests.add(me);
      host.guests.set(doc, guests);
      frame(me, PIPE.syncVector, host.member, doc, new Uint8Array());
      frame(host, PIPE.syncVector, me.member, doc, new Uint8Array());
    },
    close: async (doc) => detach(me, doc),
    base: async (target) => me.bases.get(keyOf(target)) ?? null,
    syncNow: async () => {
      me.syncs += 1;
    },
    send: (kind, member, doc, payload) => {
      switch (kind) {
        case PIPE.update:
          for (const to of neighbours(me, doc)) deliver(to, me, doc, payload);
          return;
        case PIPE.cursor:
          for (const to of neighbours(me, doc)) deliverCursor(to, me, me, doc, payload);
          return;
        case PIPE.syncVector:
        case PIPE.syncReply: {
          const to = neighbours(me, doc).find((device) => device.member === member);
          if (!to) return;
          // Rust：发来的 Sync1 交给前端是「回他缺的」；Sync2 是更新（也往两头转）
          if (kind === PIPE.syncVector) frame(to, PIPE.syncReply, me.member, doc, payload);
          else deliver(to, me, doc, payload);
          return;
        }
      }
    },
    openPipe: async (onFrame) => {
      me.pipe = onFrame;
      return () => {
        me.pipe = null;
      };
    },
    onControl: async (listener) => {
      me.controls.add(listener);
      return () => me.controls.delete(listener);
    },
  });

  return {
    device(id, name) {
      const device: MockDevice = {
        id,
        member: devices.size + 1,
        name,
        online: true,
        presence: [],
        hosted: new Set(),
        guests: new Map(),
        attached: new Map(),
        pipe: null,
        controls: new Set(),
        bases: new Map(),
        syncs: 0,
      };
      devices.set(id, device);
      announce();
      return {
        net: netOf(device),
        self: () => ({
          team: "mock",
          id,
          member: device.member,
          name,
          peers: peersOf(device),
          firewall: { state: "unknown" },
        }),
      };
    },
    setOnline(id, online) {
      const device = devices.get(id);
      if (!device || device.online === online) return;
      if (!online) {
        for (const doc of [...device.guests.keys()]) unhost(device, doc);
        for (const doc of [...device.attached.keys()]) detach(device, doc);
      }
      device.online = online;
      announce();
    },
    block(a, b) {
      const one = devices.get(a);
      const two = devices.get(b);
      if (!one || !two) return;
      blocked.add(pair(one, two));
      for (const [x, y] of [
        [one, two],
        [two, one],
      ] as const) {
        for (const doc of [...x.attached.keys()]) if (x.attached.get(doc) === y) detach(x, doc);
      }
      announce();
    },
    setBase(id, target, text) {
      devices.get(id)?.bases.set(keyOf(target), text);
    },
    syncs: (id) => devices.get(id)?.syncs ?? 0,
  };
}
