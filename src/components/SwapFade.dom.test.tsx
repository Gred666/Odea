// @vitest-environment happy-dom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwapFade } from "./SwapFade";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 换文档时的交叉淡化：旧内容留一份快照在原处淡出，新内容淡入。
 * happy-dom 不排版也不跑动画，所以包围盒和 animate() 都换成假的：
 * 这里测的是快照拍没拍、拍的是不是旧的那一份、什么时候收掉。
 */

interface FakeAnimation {
  target: Element;
  keyframes: Keyframe[];
  onfinish: (() => void) | null;
  cancelled: boolean;
  cancel(): void;
}

let animations: FakeAnimation[] = [];
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  animations = [];
  vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(function (
    this: HTMLElement,
    keyframes,
  ) {
    const animation: FakeAnimation = {
      target: this,
      keyframes: keyframes as Keyframe[],
      onfinish: null,
      cancelled: false,
      cancel() {
        this.cancelled = true;
      },
    };
    animations.push(animation);
    return animation as unknown as Animation;
  });
  // 宿主是 800×600 的可视区，内容从 (40, -120) 开始（往下滚过一截）
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const host = this.hasAttribute("data-swap-host");
    return DOMRect.fromRect(
      host ? { x: 0, y: 0, width: 800, height: 600 } : { x: 40, y: -120, width: 720, height: 2000 },
    );
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete document.documentElement.dataset.reduceMotion;
  vi.restoreAllMocks();
});

function render(swapKey: string, title: string) {
  act(() =>
    root.render(
      <div data-swap-host>
        <SwapFade swapKey={swapKey} exitLift={4}>
          <h1 id="doc-top">{title}</h1>
          <textarea aria-label="标题" defaultValue={title} />
        </SwapFade>
      </div>,
    ),
  );
}

const host = () => container.querySelector<HTMLElement>("[data-swap-host]")!;
const ghosts = () => [...host().querySelectorAll<HTMLElement>(".odea-swap-ghost")];
const ghostAnimation = (ghost: HTMLElement) => animations.find((a) => a.target === ghost);

describe("SwapFade", () => {
  it("leaves a snapshot of the old content in place while the new one fades in", () => {
    render("a", "旧的一篇");
    // 输入框里打了一半、还没存的字不在属性里，快照也得带上
    container.querySelector("textarea")!.value = "旧的一篇（改了一半）";

    render("b", "新的一篇");

    const [ghost] = ghosts();
    expect(ghosts()).toHaveLength(1);
    expect(ghost!.textContent).toContain("旧的一篇");
    expect(ghost!.querySelector("textarea")!.value).toBe("旧的一篇（改了一半）");
    // 快照钉在旧内容当时的位置上，宽高照旧
    const clone = ghost!.firstElementChild as HTMLElement;
    expect(clone.style.top).toBe("-120px");
    expect(clone.style.left).toBe("40px");
    expect(clone.style.width).toBe("720px");
    // 克隆出来的 id 不能和新内容撞车
    expect(ghost!.querySelector("[id]")).toBeNull();
    expect(document.querySelectorAll("#doc-top")).toHaveLength(1);
    // 快照挡不住点击、读屏器也不念
    expect(ghost!.getAttribute("aria-hidden")).toBe("true");

    // 新内容已经是新的，并且从透明淡入；快照往上飘着淡出
    expect(container.querySelector("h1")!.textContent).toBe("新的一篇");
    const fadeIn = animations.find((a) => a.target !== ghost)!;
    expect(fadeIn.keyframes.map((frame) => frame.opacity)).toEqual([0, 1]);
    const fadeOut = ghostAnimation(ghost!)!;
    expect(fadeOut.keyframes.at(-1)).toMatchObject({ opacity: 0, transform: "translateY(-4px)" });

    // 淡完就收掉
    act(() => fadeOut.onfinish?.());
    expect(ghosts()).toHaveLength(0);
  });

  it("does nothing while the key stays the same", () => {
    render("a", "标题");
    render("a", "标题改了");
    expect(ghosts()).toHaveLength(0);
    expect(animations).toHaveLength(0);
  });

  it("keeps only the latest snapshot when switching again before the last one faded", () => {
    render("a", "第一篇");
    render("b", "第二篇");
    const [first] = ghosts();
    const firstFadeIn = animations.find((a) => a.target !== first)!;

    render("c", "第三篇");
    expect(ghosts()).toHaveLength(1);
    expect(ghosts()[0]!.textContent).toContain("第二篇");
    expect(firstFadeIn.cancelled).toBe(true);

    // 上一份的淡出回调晚到了，也不能把新的这份收掉
    act(() => ghostAnimation(first!)?.onfinish?.());
    expect(ghosts()).toHaveLength(1);
  });

  it("switches instantly when motion is reduced", () => {
    document.documentElement.dataset.reduceMotion = "true";
    render("a", "旧的");
    render("b", "新的");
    expect(ghosts()).toHaveLength(0);
    expect(animations).toHaveLength(0);
  });

  it("clears its snapshot when unmounted mid-fade", () => {
    render("a", "旧的");
    render("b", "新的");
    expect(ghosts()).toHaveLength(1);
    act(() => root.render(<div data-swap-host />));
    expect(ghosts()).toHaveLength(0);
  });
});
