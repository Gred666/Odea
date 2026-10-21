import { describe, expect, it } from "vitest";
import { ManualScheduler } from "./loopback";
import { CollabSession, type Peer } from "./session";

/* 会话本身（不挂编辑器）：Loro 挂起的包、合包。编辑器那一侧在 binding.dom.test.ts */

const peer = (id: string): Peer => ({ id, name: id, color: 0 });

/** 所有会话共用一个假时钟：同一帧里第二次收到的更新要等下一帧才 import */
const scheduler = new ManualScheduler();

function session(id: string, sent: Uint8Array[], initialText?: string) {
  return new CollabSession({
    self: peer(id),
    initialText,
    scheduler,
    transport: { sendUpdate: (update) => sent.push(update), sendCursor: () => {} },
  });
}

describe("CollabSession", () => {
  it("挂着的包（依赖还没到）回同步时一起给：不然转发没送到的那位永远缺它（种子 1015）", async () => {
    const fromC: Uint8Array[] = [];
    const host = session("host", []);
    const c = session("c", fromC);
    // 往外发在微任务里：隔开才是两包
    c.insertText(0, "第一句");
    await Promise.resolve();
    c.insertText(3, "，第二句");
    await Promise.resolve();
    expect(fromC).toHaveLength(2);
    const [u1, u2] = fromC as [Uint8Array, Uint8Array];
    // 主持人先收到第二包：缺着第一包，Loro 先挂起
    host.receiveUpdate(u2);
    expect(host.toString()).toBe("");
    // 这时 b 重连来要同步：导出里没有挂着的那包，原样补上
    const b = session("b", []);
    const replies: Uint8Array[] = [];
    host.answerSync(b.stateVector(), (update) => replies.push(update));
    expect(replies).toHaveLength(2);
    for (const reply of replies) b.receiveUpdate(reply);
    await scheduler.advance(20);
    // 第一包到了主持人，转给 b（第二包当初转给 b 时 b 正断着，没送到）
    host.receiveUpdate(u1);
    b.receiveUpdate(u1);
    await scheduler.advance(20);
    expect(host.toString()).toBe("第一句，第二句");
    expect(b.toString()).toBe("第一句，第二句");
    // 都生效了就不再留着
    const later: Uint8Array[] = [];
    host.answerSync(b.stateVector(), (update) => later.push(update));
    expect(later).toHaveLength(1);
  });

  it("同一个任务里的几次改动合成一包发出去，对方 import 一次", async () => {
    const sent: Uint8Array[] = [];
    const a = session("a", sent, "开头");
    a.insertText(2, "n");
    a.insertText(3, "i");
    a.deleteText(2, 2);
    a.insertText(2, "你");
    expect(sent).toHaveLength(0);
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    const b = session("b", []);
    a.answerSync(b.stateVector(), (update) => b.receiveUpdate(update));
    expect(b.toString()).toBe("开头你");
  });
});
