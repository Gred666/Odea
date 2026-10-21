import { ensureLoro } from "@/collab/loro";
import { TEXT_NAME } from "@/collab/session";
import { backend } from "@/data/backend";
import type { GoalHorizon } from "@/data/types";
import type { Role, ShareInfo, ShareMember, ShareVersion } from "@/lib/bindings";
import { LoroDoc } from "loro-crdt";
import {
  SHARE_PIPE,
  type ShareFrame,
  type ShareNet,
  decodeShareFrame,
  encodeShareFrame,
} from "./net";

/* ============================================================
   浏览器预览里的共享仓库（没有 Rust）：只在内存里。

   - 「共享这个仓库」：我是管理员，邀请链接是假的
   - 过 3 秒有人（Alex）拿着链接来敲门；允许以后他在线，你开着一篇的话他会在第一行末尾打几个字
     （走的和真的一样：增量从管道推给前端那份 Loro 副本）
   - 打开一篇：从模拟的仓库里取正文建一个 Loro 文档（Rust 那份的替身）；前端推来的改动写回模拟的仓库
   ============================================================ */

const ME = "a".repeat(64);
const ALEX = "b".repeat(64);
const later = (ms: number, run: () => void) => setTimeout(run, ms);

export function createMockShare(): ShareNet {
  let info: ShareInfo | null = null;
  const docs = new Map<string, LoroDoc>();
  const listeners = new Set<() => void>();
  let pipe: ((frame: ShareFrame) => void) | null = null;
  let opened: string | null = null;
  let typed = false;

  const changed = () => {
    for (const listener of listeners) listener();
  };
  const member = (id: string, name: string, role: Role, online: boolean): ShareMember => ({
    id,
    name,
    role,
    online,
    me: id === ME,
  });

  /** 模拟仓库里这一篇现在的正文 */
  const bodyOf = async (doc: string): Promise<string> => {
    const api = await backend();
    if (doc.startsWith("day-")) return (await api.calendarDay(doc.slice(4), false)).noteMd;
    const goal = /^goal-(week|month|year)-(.+)$/.exec(doc);
    if (goal) return (await api.goalGet(goal[1] as GoalHorizon, goal[2]!)).contentMd;
    return (await api.noteGet(doc)).contentMd;
  };

  /** Rust 那份写盘的替身：写回模拟的仓库 */
  const write = async (doc: string, text: string) => {
    const api = await backend();
    if (doc.startsWith("day-")) {
      const date = doc.slice(4);
      const day = await api.calendarDay(date, false);
      await api.calendarDaySave(date, day.title, text);
      return;
    }
    const goal = /^goal-(week|month|year)-(.+)$/.exec(doc);
    if (goal) {
      await api.goalSave(goal[1] as GoalHorizon, goal[2]!, text);
      return;
    }
    const note = await api.noteGet(doc);
    await api.noteUpsert({ id: doc, title: note.title, contentMd: text });
  };

  /** Alex 在第一行末尾打几个字，一个字一包 */
  const alexTypes = (doc: string) => {
    const mine = docs.get(doc);
    if (!mine || typed) return;
    typed = true;
    const alex = mine.fork();
    const words = "（Alex：我也在看）";
    let index = 0;
    const step = () => {
      if (index >= words.length || opened !== doc) return;
      const text = alex.getText(TEXT_NAME);
      const end = text.toString().indexOf("\n");
      const before = alex.oplogVersion();
      text.insert(end < 0 ? text.length : end, words[index]!);
      alex.commit();
      const update = alex.export({ mode: "update", from: before });
      mine.import(update);
      pipe?.({ kind: SHARE_PIPE.update, doc, from: null, payload: update });
      index += 1;
      later(140, step);
    };
    later(800, step);
  };

  const net: ShareNet = {
    info: async () => info,
    create: async () => {
      info = {
        id: "mock".padEnd(32, "0"),
        name: "我的笔记",
        me: ME,
        role: "admin",
        state: { state: "ready" },
        members: [member(ME, "我", "admin", true)],
        requests: [],
        canInvite: true,
      };
      later(3000, () => {
        if (!info) return;
        info = { ...info, requests: [{ request: 1, id: ALEX, name: "Alex" }] };
        changed();
      });
      return info;
    },
    inviteLink: async () => "odea://share/mockmockmockmockmockmockmockmock",
    resetInvite: async () => "odea://share/mocknewnewnewnewnewnewnewnewnew",
    answer: async (request, role) => {
      if (!info) return false;
      const asked = info.requests.find((known) => known.request === request);
      info = {
        ...info,
        requests: info.requests.filter((known) => known.request !== request),
        members:
          asked && role
            ? [...info.members, member(asked.id, asked.name, role, true)]
            : info.members,
      };
      changed();
      if (asked && role && role !== "read" && opened) alexTypes(opened);
      return !!asked;
    },
    setRole: async (id, role) => {
      if (!info) return;
      info = {
        ...info,
        members: role
          ? info.members.map((known) => (known.id === id ? { ...known, role } : known))
          : info.members.filter((known) => known.id !== id),
      };
      changed();
    },
    checkLink: async () => ({ name: "团队笔记", role: "edit" }),
    join: async () => {
      throw new Error("浏览器预览里不能加入共享仓库（要桌面端）");
    },
    leave: async () => {
      info = null;
      docs.clear();
      changed();
    },
    history: async (doc): Promise<ShareVersion[]> => {
      const now = Date.now();
      const text = docs.get(doc)?.getText(TEXT_NAME).toString() ?? (await bodyOf(doc));
      return [
        { from: now - 3_600_000, to: now - 3_500_000, name: "我", device: ME, version: btoa("v1") },
        { from: now - 60_000, to: now - 30_000, name: "Alex", device: ALEX, version: btoa(text) },
      ];
    },
    versionText: async (doc, version) => {
      const text = atob(version);
      return text === "v1" ? (await bodyOf(doc)).split("\n").slice(0, 2).join("\n") : text;
    },
    restore: async (doc, version) => {
      const mine = docs.get(doc);
      if (!mine) return;
      const target = await net.versionText(doc, version);
      const before = mine.oplogVersion();
      mine.getText(TEXT_NAME).update(target);
      mine.commit();
      const update = mine.export({ mode: "update", from: before });
      pipe?.({ kind: SHARE_PIPE.update, doc, from: null, payload: update });
      await write(doc, target);
    },
    openDoc: async (doc) => {
      await ensureLoro();
      let mine = docs.get(doc);
      if (!mine) {
        mine = new LoroDoc();
        mine.getText(TEXT_NAME).insert(0, await bodyOf(doc));
        mine.commit();
        docs.set(doc, mine);
      }
      opened = doc;
      if (info?.members.some((known) => known.id === ALEX)) alexTypes(doc);
      return {
        peer: String(Math.floor(Math.random() * 2 ** 40)),
        snapshot: mine.export({ mode: "snapshot" }),
      };
    },
    closeDoc: async (doc) => {
      if (opened === doc) opened = null;
    },
    openPipe: async (onFrame) => {
      pipe = onFrame;
      return () => {
        pipe = null;
      };
    },
    send: (kind, doc, payload) => {
      // 走一遍编解码：和真的一样
      const frame = decodeShareFrame(encodeShareFrame(kind, doc, payload));
      if (!frame || frame.kind !== SHARE_PIPE.update) return;
      const mine = docs.get(doc);
      if (!mine) return;
      mine.import(frame.payload);
      void write(doc, mine.getText(TEXT_NAME).toString());
    },
    onChanged: async (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return net;
}
