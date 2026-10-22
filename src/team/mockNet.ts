import { type Frame, PIPE } from "@/collab/net";
import type { DocumentSaveTarget } from "@/data/types";
import type { PresenceDoc, TeamControl, TeamPeer, TeamSelf } from "@/lib/bindings";
import type { TeamNet } from "./net";

/* ============================================================
   一个进程里的几台设备（单测）：和 Rust 的团队端点（src-tauri/src/team）同一套规矩 ——
   Presence 发给所有在线的人；在主持的才接 open，不然 docClosed（refused）；访客的更新、光标经主持人
   转给这一篇的其他访客（转过去的更新算主持人发的，光标保留是谁的）；不主持了、断线了，那一头是
   docClosed。成员号整个 hub 一套（Rust 那边每台设备各编各的，前端不在乎）
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
  const later = (run: () => void) => setTimeout(run, 0);

  const peersOf = (me: MockDevice): TeamPeer[] =>
    [...devices.values()]
      .filter((device) => device !== me)
      .map((device) => {
        const online = device.online && me.online;
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

  const netOf = (me: MockDevice): TeamNet => ({
    start: async () => ({
      team: "mock",
      id: me.id,
      member: me.member,
      name: me.name,
      peers: peersOf(me),
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
      if (!host || !host.online || !me.online) throw new Error("他不在线");
      detach(me, doc);
      if (!host.hosted.has(doc)) {
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
      const guests = me.guests.get(doc);
      const host = me.attached.get(doc);
      switch (kind) {
        case PIPE.update:
          if (guests)
            for (const guest of guests) frame(guest, PIPE.update, me.member, doc, payload);
          else if (host) {
            frame(host, PIPE.update, me.member, doc, payload);
            // 星形：主持人转给其他访客（算主持人发的）
            for (const guest of host.guests.get(doc) ?? []) {
              if (guest !== me) frame(guest, PIPE.update, host.member, doc, payload);
            }
          }
          return;
        case PIPE.cursor:
          if (guests)
            for (const guest of guests) frame(guest, PIPE.cursor, me.member, doc, payload);
          else if (host) {
            frame(host, PIPE.cursor, me.member, doc, payload);
            for (const guest of host.guests.get(doc) ?? []) {
              if (guest !== me) frame(guest, PIPE.cursor, me.member, doc, payload);
            }
          }
          return;
        case PIPE.syncVector:
        case PIPE.syncReply: {
          const to = [...(guests ?? []), ...(host ? [host] : [])].find(
            (device) => device.member === member,
          );
          // Rust：发来的 Sync1 交给前端是「回他缺的」，Sync2 是更新
          if (to)
            frame(
              to,
              kind === PIPE.syncVector ? PIPE.syncReply : PIPE.update,
              me.member,
              doc,
              payload,
            );
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
        self: () => ({ team: "mock", id, member: device.member, name, peers: peersOf(device) }),
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
    setBase(id, target, text) {
      devices.get(id)?.bases.set(keyOf(target), text);
    },
    syncs: (id) => devices.get(id)?.syncs ?? 0,
  };
}
