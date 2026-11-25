// @vitest-environment happy-dom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayScrollbar } from "./OverlayScrollbar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("OverlayScrollbar", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("releases drag state on pointercancel so moving the pointer no longer hijacks scroll", () => {
    vi.useFakeTimers();
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 200, configurable: true });
    scroller.scrollTop = 0;
    host.append(scroller);

    const ref = { current: scroller };
    act(() => root.render(<OverlayScrollbar targetRef={ref} />));
    const thumb = host.querySelector<HTMLElement>(".odea-scroll-thumb")!;
    expect(thumb).not.toBeNull();

    // 滚动一次让滑块显出来，接着按下开始拖
    scroller.dispatchEvent(new Event("scroll"));
    expect(thumb.dataset.visible).toBe("true");
    thumb.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        clientY: 20,
      }),
    );
    // 系统切走窗口或手势打断：只有 pointercancel，没有 pointerup
    thumb.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
    thumb.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientY: 120 }),
    );

    expect(scroller.scrollTop).toBe(0);
    vi.advanceTimersByTime(1200);
    expect(thumb.dataset.visible).toBe("false");
  });
});
