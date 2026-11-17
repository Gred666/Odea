// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushEditorsComposed, registerEditorFlush } from "./saveBus";

/* 建协作会话、加入一篇之前存编辑器：正在组字的等组完（docs/协同编辑.md §27.5） */

describe("flushEditorsComposed", () => {
  const unregister: (() => void)[] = [];
  afterEach(() => {
    for (const off of unregister.splice(0)) off();
    vi.useRealTimers();
  });

  it("有编辑器正在组字：等组完再存，存的就不是拼音", async () => {
    vi.useFakeTimers();
    let composing = true;
    let text = "你好ni";
    const saved: string[] = [];
    unregister.push(
      registerEditorFlush(
        async () => {
          saved.push(text);
        },
        () => composing,
      ),
    );
    let done = false;
    void flushEditorsComposed().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(saved).toEqual([]);
    expect(done).toBe(false);

    composing = false;
    text = "你好你";
    await vi.advanceTimersByTimeAsync(60);
    expect(saved).toEqual(["你好你"]);
    expect(done).toBe(true);
  });

  it("没在组字：当场存；输入法卡住了也最多等十秒", async () => {
    vi.useFakeTimers();
    const saved: number[] = [];
    unregister.push(registerEditorFlush(async () => void saved.push(Date.now())));
    const start = Date.now();
    await flushEditorsComposed();
    expect(saved).toEqual([start]);

    unregister.push(
      registerEditorFlush(
        async () => {},
        () => true,
      ),
    );
    let done = false;
    void flushEditorsComposed().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(done).toBe(true);
  });
});
