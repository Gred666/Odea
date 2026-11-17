import { afterEach, describe, expect, it, vi } from "vitest";
import { createDebouncedSaver } from "./debouncedSave";

afterEach(() => vi.useRealTimers());

describe("debounced save", () => {
  it("persists only the latest version after 400ms", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const saver = createDebouncedSaver(async (value) => {
      writes.push(value);
    });
    saver.schedule("a");
    saver.schedule("ab");
    saver.schedule("abc");
    await vi.advanceTimersByTimeAsync(400);
    expect(writes).toEqual(["abc"]);
  });

  it("flushes immediately when switching document or closing", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const saver = createDebouncedSaver(async (value) => {
      writes.push(value);
    });
    saver.schedule("最后一版");
    await saver.flush();
    expect(writes).toEqual(["最后一版"]);
    expect(saver.pending()).toBe(false);
  });

  it("can retry after a failed write", async () => {
    let attempts = 0;
    const writes: string[] = [];
    const saver = createDebouncedSaver(async (value) => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary failure");
      writes.push(value);
    });

    saver.schedule("first");
    await expect(saver.flush()).rejects.toThrow("temporary failure");
    expect(saver.pending()).toBe(true);
    await expect(saver.flush()).resolves.toBeUndefined();
    expect(writes).toEqual(["first"]);
  });

  it("flushQuietly leaves no unhandled rejection and keeps the version for a retry", async () => {
    // vitest 把未处理的 rejection 当成失败：以前失焦 / Mod-S / 卸载时的
    // `void saver.flush()` 在保存失败时就会留下一个
    let attempts = 0;
    const writes: string[] = [];
    const saver = createDebouncedSaver(async (value) => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary failure");
      writes.push(value);
    });

    saver.schedule("first");
    saver.flushQuietly();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saver.pending()).toBe(true);
    await saver.flush();
    expect(writes).toEqual(["first"]);
  });

  it("prefers newer text when a write fails during continued typing", async () => {
    let rejectFirst!: (error: Error) => void;
    const writes: string[] = [];
    const saver = createDebouncedSaver((value) => {
      if (value === "old") {
        return new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      writes.push(value);
      return Promise.resolve();
    }, 10_000);

    saver.schedule("old");
    const failed = saver.flush();
    await Promise.resolve();
    await Promise.resolve();
    saver.schedule("new");
    rejectFirst(new Error("offline"));
    await expect(failed).rejects.toThrow("offline");
    await saver.flush();

    expect(writes).toEqual(["new"]);
  });

  // 输入法组字时正文里是拼音：到点也先不存，组完再存上屏的字（桌面端验证 §3.2）
  it("waits while hold() says so, then writes the latest text once it clears", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    let composing = true;
    const saver = createDebouncedSaver(
      async (value) => {
        writes.push(value);
      },
      400,
      () => composing,
    );
    saver.schedule("甲ni");
    await vi.advanceTimersByTimeAsync(2000);
    expect(writes).toEqual([]);
    expect(saver.pending()).toBe(true);
    saver.schedule("甲你");
    composing = false;
    await vi.advanceTimersByTimeAsync(400);
    expect(writes).toEqual(["甲你"]);
  });

  it("an explicit flush does not wait for hold(), and holding gives up after 30 seconds", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const saver = createDebouncedSaver(
      async (value) => {
        writes.push(value);
      },
      400,
      () => true,
    );
    // 换篇、关窗时还在组字：照样存（不然丢字）
    saver.schedule("换篇时");
    await saver.flush();
    expect(writes).toEqual(["换篇时"]);
    // 组字状态卡住了：最多等 30 秒
    saver.schedule("卡住了");
    await vi.advanceTimersByTimeAsync(29_000);
    expect(writes).toEqual(["换篇时"]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(writes).toEqual(["换篇时", "卡住了"]);
  });
});
