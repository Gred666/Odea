// @vitest-environment happy-dom

import type { ShareInfo } from "@/lib/bindings";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SHARE_PIPE,
  type ShareFrame,
  type ShareNet,
  decodeShareFrame,
  encodeShareFrame,
  peerOf,
} from "./net";
import { isShareLink, resetShareForTest, shareDocId, useShare } from "./store";

/* 共享仓库的前端那一半：帧、打开一篇时建的 Loro 副本（Rust 那份的增量进来、本地的发出去）、换篇 */

const ready: ShareInfo = {
  id: "s",
  name: "团队笔记",
  me: "a".repeat(64),
  role: "edit",
  state: { state: "ready" },
  members: [
    { id: "a".repeat(64), name: "我", role: "edit", online: true, me: true },
    { id: "b".repeat(64), name: "乙", role: "edit", online: true, me: false },
  ],
  requests: [],
  canInvite: false,
};

/** Rust 那份的替身：每篇一个 Loro 文档 */
function fakeNet() {
  const docs = new Map<string, LoroDoc>();
  const sent: Array<{ kind: number; doc: string; payload: Uint8Array }> = [];
  const closed: string[] = [];
  let pipe: ((frame: ShareFrame) => void) | null = null;
  const doc = (id: string) => {
    let found = docs.get(id);
    if (!found) {
      found = new LoroDoc();
      found.getText("body").insert(0, `${id} 的正文`);
      found.commit();
      docs.set(id, found);
    }
    return found;
  };
  const net = {
    info: async () => ready,
    openDoc: async (id: string) => ({
      peer: "12345678901234567",
      snapshot: doc(id).export({ mode: "snapshot" }),
    }),
    closeDoc: async (id: string) => {
      closed.push(id);
    },
    openPipe: async (onFrame: (frame: ShareFrame) => void) => {
      pipe = onFrame;
      return () => {};
    },
    send: (kind: number, id: string, payload: Uint8Array) => {
      sent.push({ kind, doc: id, payload });
      if (kind === SHARE_PIPE.update) doc(id).import(payload);
    },
    onChanged: async () => () => {},
  } as unknown as ShareNet;
  /** 别人（Rust 那边）改了这一篇：推给前端 */
  const remote = (id: string, edit: (text: ReturnType<LoroDoc["getText"]>) => void) => {
    const target = doc(id);
    const before = target.oplogVersion();
    edit(target.getText("body"));
    target.commit();
    pipe?.({
      kind: SHARE_PIPE.update,
      doc: id,
      from: null,
      payload: target.export({ mode: "update", from: before }),
    });
  };
  return { net, docs, sent, closed, remote, connect: () => net.openPipe(() => {}) };
}

async function settle() {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => resetShareForTest(null));

describe("共享仓库：帧", () => {
  it("编解码来回一趟不变，光标帧带着对方的公钥", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const update = decodeShareFrame(encodeShareFrame(SHARE_PIPE.update, "day-2026-10-21", payload));
    expect(update).toEqual({ kind: SHARE_PIPE.update, doc: "day-2026-10-21", from: null, payload });
    const from = "c".repeat(64);
    const raw = encodeShareFrame(
      SHARE_PIPE.cursor,
      "n1",
      new Uint8Array([...new TextEncoder().encode(from), 9]),
    );
    expect(decodeShareFrame(raw)).toEqual({
      kind: SHARE_PIPE.cursor,
      doc: "n1",
      from,
      payload: new Uint8Array([9]),
    });
    expect(decodeShareFrame(new Uint8Array([1]))).toBeNull();
  });

  it("peer 是 8 字节小端，超出 JS 安全整数也不丢", () => {
    const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]);
    expect(peerOf(bytes)).toBe("9223372036854775807");
    expect(peerOf(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]))).toBe("1");
  });

  it("文档 id 和 Rust 那边一样；认得出共享仓库的链接", () => {
    expect(shareDocId({ kind: "note", id: "0199" })).toBe("0199");
    expect(shareDocId({ kind: "day", id: "2026-10-21" })).toBe("day-2026-10-21");
    expect(shareDocId({ kind: "goal", horizon: "week", periodStart: "2026-10-19" })).toBe(
      "goal-week-2026-10-19",
    );
    expect(isShareLink(" <odea://share/abc> ")).toBe(true);
    expect(isShareLink("odea://join/abc")).toBe(false);
  });
});

describe("共享仓库：编辑器上的副本", () => {
  it("打开一篇建副本；Rust 推来的改动进副本，本地的改动发回去；换篇时收掉", async () => {
    const fake = fakeNet();
    resetShareForTest(fake.net);
    // initShare 里登记管道、取状态：测试里直接来
    await fake.net.openPipe(() => {});
    const { initShare } = await import("./store");
    await initShare();
    expect(useShare.getState().info?.state.state).toBe("ready");

    useShare.getState().focus("n1");
    await vi.waitFor(() => expect(useShare.getState().current?.session).toBeTruthy());
    const session = useShare.getState().current?.session;
    expect(session?.toString()).toBe("n1 的正文");
    // Rust 给的 peer：历史版本按它认人
    expect(session?.doc.peerIdStr).toBe("12345678901234567");

    fake.remote("n1", (text) => text.insert(0, "乙："));
    await vi.waitFor(() => expect(session?.toString()).toBe("乙：n1 的正文"));

    session?.insertText(session.toString().length, "（我）");
    await settle();
    const updates = fake.sent.filter((frame) => frame.kind === SHARE_PIPE.update);
    expect(updates.at(-1)?.doc).toBe("n1");
    expect(fake.docs.get("n1")?.getText("body").toString()).toBe("乙：n1 的正文（我）");

    const destroy = vi.spyOn(session!, "destroy");
    useShare.getState().focus("day-2026-10-21");
    expect(destroy).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(useShare.getState().current?.session?.toString()).toBe("day-2026-10-21 的正文"),
    );
    expect(fake.closed).toContain("n1");
  });

  it("打开时比快照先到的改动先攒着，副本建好以后补上", async () => {
    const fake = fakeNet();
    resetShareForTest(fake.net);
    const { initShare } = await import("./store");
    await initShare();
    useShare.getState().focus("n2");
    // 快照还在路上（openDoc 是异步的），这时 Rust 推来一包
    fake.remote("n2", (text) => text.insert(0, "抢先："));
    expect(useShare.getState().current?.session).toBeNull();
    await vi.waitFor(() =>
      expect(useShare.getState().current?.session?.toString()).toBe("抢先：n2 的正文"),
    );
  });
});
