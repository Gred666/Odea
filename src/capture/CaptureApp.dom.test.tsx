// @vitest-environment happy-dom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 速记小窗（docs/REVIEWS/2026-11-13-全项目审查.md §4.13）：记下一条以后过 0.65 秒自己收起来，
 * 这期间接着打下一条就不收 —— 以前照收，字打到一半窗口没了
 */

let shown: (() => void) | null = null;
const commands = {
  captureTarget: vi.fn(async () => ({ status: "ok", data: { name: "笔记", journal: true } })),
  captureSubmit: vi.fn(async () => ({ status: "ok", data: "笔记" })),
  captureHide: vi.fn(async () => ({ status: "ok", data: null })),
};
vi.mock("@/lib/bindings", () => ({
  commands,
  events: {
    captureShown: () => ({
      listen: async (handler: () => void) => {
        shown = handler;
        return () => {};
      },
    }),
  },
}));
vi.mock("@/lib/tauri", () => ({ thisWindow: () => ({}) }));

const { CaptureApp } = await import("./CaptureApp");

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  for (const mock of Object.values(commands)) mock.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<CaptureApp />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const field = () => container.querySelector("input") as HTMLInputElement;

async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(field(), value);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const enter = () =>
  act(async () => {
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });

describe("速记小窗", () => {
  it("hides itself a moment after a line is captured", async () => {
    await type("买牛奶");
    await enter();
    expect(commands.captureSubmit).toHaveBeenCalledWith("买牛奶");
    expect(container.textContent).toContain("记下了");
    expect(field().value).toBe("");
    expect(commands.captureHide).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(700));
    expect(commands.captureHide).toHaveBeenCalledTimes(1);
  });

  it("stays when the next line is already being typed", async () => {
    await type("买牛奶");
    await enter();
    await act(async () => vi.advanceTimersByTime(300));
    await type("取");
    await act(async () => vi.advanceTimersByTime(2000));
    expect(commands.captureHide).not.toHaveBeenCalled();
    expect(field().value).toBe("取");
  });

  it("stays when it is called up again right after it was hidden", async () => {
    await type("买牛奶");
    await enter();
    // 0.65 秒还没到：按快捷键收起、又按一次叫出来（Rust 发 CaptureShown）
    await act(async () => vi.advanceTimersByTime(200));
    await act(async () => shown?.());
    await act(async () => vi.advanceTimersByTime(2000));
    expect(commands.captureHide).not.toHaveBeenCalled();
  });
});
