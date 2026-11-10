import { describe, expect, it, vi } from "vitest";
import { Endpoint, type Port, RpcError } from "./protocol";
import { channel, until } from "./testkit";

/* 沙箱的消息协议（docs/插件与跨端.md §5.5）：请求、回复、通知、取消、超时、一串一起发 */

function pair(options: ConstructorParameters<typeof Endpoint>[1] = {}) {
  const [a, b] = channel();
  return { host: new Endpoint(a, options), other: new Endpoint(b), a, b };
}

describe("消息协议", () => {
  it("请求和回复；出错带上错误码", async () => {
    const { host, other } = pair();
    other.handle("add", (params) => {
      const { x, y } = params as { x: number; y: number };
      return x + y;
    });
    other.handle("deny", () => {
      throw new RpcError("denied", "不给");
    });
    other.handle("boom", () => {
      throw new Error("炸了");
    });
    expect(await host.request("add", { x: 1, y: 2 })).toBe(3);
    await expect(host.request("deny")).rejects.toMatchObject({ code: "denied", message: "不给" });
    await expect(host.request("boom")).rejects.toMatchObject({ code: "failed", message: "炸了" });
    await expect(host.request("nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("超时：拒掉、告诉对面别算了（对面的 signal 拨掉），晚到的回复不要", async () => {
    const { host, other } = pair();
    let aborted = false;
    let finish: (value: string) => void = () => {};
    other.handle("slow", (_params, { signal }) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    await expect(host.request("slow", undefined, { timeout: 30 })).rejects.toMatchObject({
      code: "timeout",
    });
    await until(() => aborted);
    finish("晚了");
    expect(host.waiting).toBe(0);
    expect(other.serving).toBe(0);
  });

  it("用 AbortSignal 取消", async () => {
    const { host, other } = pair();
    let aborted = false;
    other.handle("wait", (_params, { signal }) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const pending = host.request("wait", undefined, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await until(() => aborted);
  });

  it("一个微任务里发的几条合成一串发", async () => {
    const [a, b] = channel();
    const post = vi.spyOn(a, "postMessage");
    const host = new Endpoint(a);
    const other = new Endpoint(b);
    other.handle("echo", (params) => params);
    const results = await Promise.all([1, 2, 3].map((n) => host.request("echo", n)));
    expect(results).toEqual([1, 2, 3]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(Array.isArray(post.mock.calls[0]![0])).toBe(true);
  });

  it("停下：还没回的都拒掉，之后发的也拒", async () => {
    const { host, other } = pair();
    other.handle("never", () => new Promise(() => {}));
    const pending = host.request("never");
    host.close("插件停了");
    await expect(pending).rejects.toMatchObject({ code: "cancelled", message: "插件停了" });
    await expect(host.request("never")).rejects.toMatchObject({ code: "cancelled" });
  });

  it("不合协议的消息报出来，不会把宿主弄坏", async () => {
    const invalid: string[] = [];
    const other: string[] = [];
    const [a, b] = channel();
    new Endpoint(a, {
      onInvalid: (reason) => invalid.push(reason),
      onOther: () => other.push("relay"),
    });
    const send = (message: unknown) => b.postMessage(message);
    send("hello");
    send({ id: "x", method: "a" });
    send({ result: 1 });
    send({ id: -1, method: "a" });
    send(Array.from({ length: 300 }, () => ({ method: "noop" })));
    send({ relay: "started" });
    await until(() => invalid.length >= 5 && other.length === 1);
    expect(invalid.length).toBe(5);
  });

  it("预算：admit 拒掉的不交给处理函数", async () => {
    const handled = vi.fn();
    const [a, b] = channel();
    const host = new Endpoint(a, { admit: () => new RpcError("budget", "太频繁") });
    host.handle("x", handled);
    const plugin = new Endpoint(b as Port);
    await expect(plugin.request("x")).rejects.toMatchObject({ code: "budget" });
    expect(handled).not.toHaveBeenCalled();
  });

  it("对面发来同一个 id 的请求还没处理完：回 invalid", async () => {
    const [a, b] = channel();
    const host = new Endpoint(a);
    host.handle("hang", () => new Promise(() => {}));
    const replies: unknown[] = [];
    b.onmessage = (event) => replies.push(event.data);
    b.postMessage([
      { id: 7, method: "hang" },
      { id: 7, method: "hang" },
    ]);
    await until(() => replies.length > 0);
    expect(replies[0]).toMatchObject({ id: 7, error: { code: "invalid" } });
  });
});
