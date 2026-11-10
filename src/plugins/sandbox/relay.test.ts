import { describe, expect, it } from "vitest";
import { type RelayPort, type RelayWorker, relayMain } from "./relay";

/* iframe 主线程上的中转（relay.ts）：接通端口和 Worker，Worker 刷屏就掐掉 */

function fakes() {
  const toHost: unknown[] = [];
  const toWorker: unknown[] = [];
  let terminated = false;
  const port: RelayPort = { onmessage: null, postMessage: (message) => toHost.push(message) };
  const worker: RelayWorker = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: (message) => toWorker.push(message),
    terminate: () => {
      terminated = true;
    },
  };
  return { port, worker, toHost, toWorker, terminated: () => terminated };
}

describe("沙箱里的中转", () => {
  it("两头接通，先报一声 started", () => {
    const { port, worker, toHost, toWorker } = fakes();
    relayMain({ worker: "", limits: { messagesPerSecond: 100 } }, port, {
      now: () => 0,
      createWorker: () => worker,
    });
    expect(toHost).toEqual([{ relay: "started" }]);
    port.onmessage?.({ data: { id: 1, method: "ping" } });
    worker.onmessage?.({ data: { id: 1, result: "pong" } });
    expect(toWorker).toEqual([{ id: 1, method: "ping" }]);
    expect(toHost.at(-1)).toEqual({ id: 1, result: "pong" });
  });

  it("Worker 一秒发太多：掐掉，之后什么都不转", () => {
    const { port, worker, toHost, toWorker, terminated } = fakes();
    let now = 0;
    relayMain({ worker: "", limits: { messagesPerSecond: 3 } }, port, {
      now: () => now,
      createWorker: () => worker,
    });
    for (let i = 0; i < 3; i++) worker.onmessage?.({ data: i });
    now = 1500; // 过了一秒，重新数
    for (let i = 0; i < 3; i++) worker.onmessage?.({ data: i });
    expect(terminated()).toBe(false);
    worker.onmessage?.({ data: "多了" });
    expect(terminated()).toBe(true);
    expect(toHost.at(-1)).toMatchObject({ relay: "fatal", reason: "flood" });
    port.onmessage?.({ data: "还发" });
    worker.onmessage?.({ data: "还发" });
    expect(toWorker).toEqual([]);
    expect(toHost.filter((message) => message === "还发")).toEqual([]);
  });

  it("起不了 Worker：报 no-worker", () => {
    const { port, toHost } = fakes();
    relayMain({ worker: "", limits: { messagesPerSecond: 3 } }, port, {
      now: () => 0,
      createWorker: () => {
        throw new Error("SecurityError");
      },
    });
    expect(toHost).toEqual([{ relay: "fatal", reason: "no-worker", message: "SecurityError" }]);
  });

  it("Worker 没接住的错转给宿主，不在 iframe 的控制台里再抛", () => {
    const { port, worker, toHost } = fakes();
    relayMain({ worker: "", limits: { messagesPerSecond: 3 } }, port, {
      now: () => 0,
      createWorker: () => worker,
    });
    let prevented = false;
    worker.onerror?.({
      message: "ReferenceError: x is not defined",
      lineno: 3,
      colno: 1,
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
    expect(toHost.at(-1)).toEqual({
      relay: "error",
      message: "ReferenceError: x is not defined",
      line: 3,
      column: 1,
    });
  });
});
