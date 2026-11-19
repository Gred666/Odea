// @vitest-environment happy-dom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary, errorReport } from "./ErrorBoundary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 白屏的兜底（docs/技术方案.md §8.9）：哪一块渲染出错只换掉那一块，别的还在；能重试、换一篇自动再试；
 * 浮在上面的不画东西、交给提示条，等下一次点、按键再试
 */

let container: HTMLDivElement;
let root: Root;
/** 为真时 Broken 渲染就抛错 */
let broken = true;

function Broken({ label }: { label: string }) {
  if (broken) throw new Error(`${label} 画不出来`);
  return <p>{label} 好了</p>;
}

beforeEach(() => {
  broken = true;
  // React 和边界自己都会 console.error 一遍：测试里不刷屏
  vi.spyOn(console, "error").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const render = (node: React.ReactNode) => act(() => root.render(node));
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === text);

describe("ErrorBoundary", () => {
  it("swaps only the broken block, keeps its neighbours, and retries on demand", () => {
    const onError = vi.fn();
    render(
      <>
        <ErrorBoundary area="列表栏" fallback="block" onError={onError}>
          <Broken label="列表" />
        </ErrorBoundary>
        <p>正文还在</p>
      </>,
    );
    expect(container.textContent).toContain("列表栏出错了");
    expect(container.textContent).toContain("列表 画不出来");
    expect(container.textContent).toContain("正文还在");
    expect(onError).toHaveBeenCalledWith("列表栏出错了：列表 画不出来");

    broken = false;
    act(() => button("重试")?.click());
    expect(container.textContent).toContain("列表 好了");
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("tries again by itself when what it shows changes", () => {
    const view = (key: string) => (
      <ErrorBoundary area="正文" fallback="block" resetKey={key}>
        <Broken label="这一篇" />
      </ErrorBoundary>
    );
    render(view("a"));
    expect(container.textContent).toContain("正文出错了");
    broken = false;
    render(view("a"));
    expect(container.textContent).toContain("正文出错了");
    render(view("b"));
    expect(container.textContent).toContain("这一篇 好了");
  });

  it("draws nothing for an overlay, hands the message on, and retries on the next input a few times", () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary area="同步对话框" fallback="none" onError={onError}>
        <Broken label="对话框" />
      </ErrorBoundary>,
    );
    expect(container.innerHTML).toBe("");
    expect(onError).toHaveBeenCalledTimes(1);

    // 一直坏着：每次输入再试一次，试够了就不再试
    for (let i = 0; i < 5; i += 1) {
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })));
    }
    expect(onError).toHaveBeenCalledTimes(4);

    // 修好了也不会再自己回来（要等别的办法：重新载入），但之前那几次是真的试了
    broken = false;
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })));
    expect(container.innerHTML).toBe("");
  });

  it("comes back on the next click once an overlay works again", () => {
    render(
      <ErrorBoundary area="回收站" fallback="none">
        <Broken label="回收站" />
      </ErrorBoundary>,
    );
    broken = false;
    act(() => window.dispatchEvent(new MouseEvent("pointerdown")));
    expect(container.textContent).toContain("回收站 好了");
  });

  it("replaces the whole window with a way out instead of going blank", () => {
    render(
      <ErrorBoundary area="这个窗口" fallback="window">
        <Broken label="整个窗口" />
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain("Odea 出错了");
    expect(container.textContent).toContain("整个窗口 画不出来");
    expect(button("重新载入")).toBeDefined();
    expect(button("复制错误信息")).toBeDefined();
  });

  it("copies a report with the version, the block, the error and the components", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <ErrorBoundary area="列表栏" fallback="block">
        <Broken label="列表" />
      </ErrorBoundary>,
    );
    await act(async () => button("复制错误信息")?.click());
    const report = writeText.mock.calls[0]?.[0] ?? "";
    expect(report).toMatch(/^Odea \d+\.\d+\.\d+/);
    expect(report).toContain("位置：列表栏");
    expect(report).toContain("Error: 列表 画不出来");
    expect(report).toContain("Broken");
    expect(button("已复制")).toBeDefined();
  });
});

describe("errorReport", () => {
  it("still says something for a thrown non-error", () => {
    expect(errorReport("提示条", "坏了")).toContain("坏了");
  });
});
