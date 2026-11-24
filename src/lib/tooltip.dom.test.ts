// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TIP, installTooltips, setTip, tip } from "./tooltip";

/*
 * 悬停提示的时间表和收起的几种情形（docs/悬停提示.md §4.3、§6 第 2 条）。
 * happy-dom 没有排版和动画：位置、滑过去在 tooltip.test.ts（placeBeside）和
 * scripts/perf/fade-frames.mjs 的 tooltip 场景里验
 */

let uninstall: () => void;

function button(label: string, extra: Record<string, string> = {}): HTMLButtonElement {
  const element = document.createElement("button");
  for (const [key, value] of Object.entries({ ...tip(label), ...extra })) {
    if (value !== undefined) element.setAttribute(key, value);
  }
  document.body.append(element);
  return element;
}

const pointer = (
  type: "pointerover" | "pointerout" | "pointerdown",
  target: Element,
  related: Element | null = null,
  pointerType = "mouse",
) =>
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, pointerType, relatedTarget: related }),
  );

/** 从 from 移到 to（from 为 null 是从窗口外进来） */
function move(from: Element | null, to: Element | null) {
  if (from) pointer("pointerout", from, to);
  if (to) pointer("pointerover", to, from);
}

const root = () => document.querySelector<HTMLElement>(".odea-tip")!;
/** 现在显示着的字（没有就是 null） */
const shown = () => {
  if (root().dataset.state !== "shown") return null;
  const layers = root().querySelectorAll(".odea-tip-txt:not([aria-hidden=true])");
  return layers[layers.length - 1]?.querySelector(".odea-tip-line > span")?.textContent ?? null;
};

beforeEach(() => {
  vi.useFakeTimers();
  uninstall = installTooltips(window);
});

afterEach(() => {
  uninstall();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("悬停提示：时间", () => {
  it("waits 500ms the first time", () => {
    const a = button("导出");
    move(null, a);
    vi.advanceTimersByTime(TIP.openDelay - 1);
    expect(shown()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(shown()).toBe("导出");
  });

  it("follows at once to the next one while warm, and goes cold after 400ms", () => {
    const [a, b, c] = [button("导出"), button("历史版本"), button("删除")];
    move(null, a);
    vi.advanceTimersByTime(TIP.openDelay);
    // 挨着的下一个：不用再等
    move(a, b);
    expect(shown()).toBe("历史版本");
    // 离开、收掉以后 400ms 内回来：还是立刻出
    move(b, document.body);
    vi.advanceTimersByTime(TIP.grace + 100);
    expect(shown()).toBeNull();
    move(document.body, c);
    expect(shown()).toBe("删除");
    // 收掉超过 400ms：又要等
    move(c, document.body);
    vi.advanceTimersByTime(TIP.grace + TIP.warm + 50);
    move(document.body, a);
    expect(shown()).toBeNull();
    vi.advanceTimersByTime(TIP.openDelay);
    expect(shown()).toBe("导出");
  });

  it("stays 80ms after leaving, and stays while the pointer is on the tip (WCAG 1.4.13)", () => {
    const a = button("在文件夹中显示");
    move(null, a);
    vi.advanceTimersByTime(TIP.openDelay);
    const layer = root().querySelector(".odea-tip-txt")!;
    // 移到提示上
    move(a, layer);
    vi.advanceTimersByTime(1000);
    expect(shown()).toBe("在文件夹中显示");
    // 从提示移开：留 80ms
    move(layer, document.body);
    vi.advanceTimersByTime(TIP.grace - 1);
    expect(shown()).toBe("在文件夹中显示");
    vi.advanceTimersByTime(1);
    expect(shown()).toBeNull();
  });

  it("never hides on its own while the pointer stays", () => {
    const a = button("历史版本");
    move(null, a);
    vi.advanceTimersByTime(60_000);
    expect(shown()).toBe("历史版本");
  });

  it("shows at once on keyboard focus, not on focus from a click", () => {
    const [a, b] = [button("导出"), button("历史版本")];
    const focusVisible = (element: HTMLElement, visible: boolean) => {
      const matches = element.matches.bind(element);
      element.matches = (selector: string) =>
        selector === ":focus-visible" ? visible : matches(selector);
    };
    focusVisible(a, false);
    a.focus();
    expect(shown()).toBeNull();
    focusVisible(b, true);
    b.focus();
    expect(shown()).toBe("历史版本");
    b.blur();
    expect(shown()).toBeNull();
  });

  it("does nothing for touch", () => {
    const a = button("导出");
    move(null, null);
    pointer("pointerover", a, null, "touch");
    vi.advanceTimersByTime(2000);
    expect(shown()).toBeNull();
  });
});

describe("悬停提示：立刻收", () => {
  it("closes on Escape without swallowing it", () => {
    const a = button("导出");
    move(null, a);
    vi.advanceTimersByTime(TIP.openDelay);
    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(shown()).toBeNull();
    expect(seen).toHaveBeenCalledTimes(1);
    expect((seen.mock.calls[0]![0] as KeyboardEvent).defaultPrevented).toBe(false);
    document.removeEventListener("keydown", seen);
    // 鼠标还在上面：离开之前不再出
    pointer("pointerover", a, null);
    vi.advanceTimersByTime(2000);
    expect(shown()).toBeNull();
  });

  it("closes on press and stays closed until the pointer leaves that button", () => {
    const [a, b] = [button("删除"), button("导出")];
    move(null, a);
    vi.advanceTimersByTime(TIP.openDelay);
    pointer("pointerdown", a);
    expect(shown()).toBeNull();
    // 按完还停在上面、里面挪了挪：不出
    pointer("pointerover", a, a);
    vi.advanceTimersByTime(2000);
    expect(shown()).toBeNull();
    // 离开、去别的：照常
    move(a, b);
    vi.advanceTimersByTime(TIP.openDelay);
    expect(shown()).toBe("导出");
    // 再回来：按下的那一个也照常了
    move(b, a);
    expect(shown()).toBe("删除");
  });

  it("closes when the target's layer scrolls or the window loses focus", () => {
    const list = document.createElement("div");
    const a = button("导出");
    list.append(a);
    document.body.append(list);
    const other = document.createElement("div");
    document.body.append(other);
    move(null, a);
    vi.advanceTimersByTime(TIP.openDelay);
    // 别处自己在滚（同步时正文跟着动）：不碍事
    other.dispatchEvent(new Event("scroll"));
    expect(shown()).toBe("导出");
    list.dispatchEvent(new Event("scroll"));
    expect(shown()).toBeNull();

    move(a, document.body);
    vi.advanceTimersByTime(1000);
    move(null, a);
    vi.advanceTimersByTime(TIP.openDelay);
    expect(shown()).toBe("导出");
    window.dispatchEvent(new Event("blur"));
    expect(shown()).toBeNull();
  });

  it("closes when its target goes away", async () => {
    const a = button("删除");
    move(null, a);
    vi.advanceTimersByTime(TIP.openDelay);
    a.remove();
    await Promise.resolve();
    expect(shown()).toBeNull();
  });
});

describe("悬停提示：内容", () => {
  it("shows a truncated title only when it is truncated", () => {
    const span = document.createElement("span");
    span.textContent = "读书笔记 · 设计心理学（第二遍，带批注和自己的例子）";
    span.setAttribute("data-tip-overflow", "");
    document.body.append(span);
    const size = (scroll: number, client: number) => {
      Object.defineProperty(span, "scrollWidth", { configurable: true, value: scroll });
      Object.defineProperty(span, "clientWidth", { configurable: true, value: client });
    };
    size(200, 200);
    move(null, span);
    vi.advanceTimersByTime(TIP.openDelay);
    expect(shown()).toBeNull();
    move(span, document.body);
    vi.advanceTimersByTime(1000);
    size(320, 200);
    move(null, span);
    vi.advanceTimersByTime(TIP.openDelay);
    expect(shown()).toBe("读书笔记 · 设计心理学（第二遍，带批注和自己的例子）");
    // 只是露在外面的字：读屏不用再读一遍
    expect(root().getAttribute("aria-hidden")).toBe("true");
  });

  it("skips a tip that repeats the visible words, unless part of them is cut off", () => {
    // 控制中心同步那一行：第二行就是提示的字，卡片窄、第二行带省略号时要出
    const row = button("把笔记同步到 GitHub / Gitee 上的私有仓库", { "aria-label": "没开同步" });
    const line = document.createElement("span");
    line.textContent = "把笔记同步到 GitHub / Gitee 上的私有仓库";
    row.append(line);
    const size = (scroll: number, client: number) => {
      Object.defineProperty(line, "scrollWidth", { configurable: true, value: scroll });
      Object.defineProperty(line, "clientWidth", { configurable: true, value: client });
    };
    size(226, 226);
    move(null, row);
    vi.advanceTimersByTime(TIP.openDelay);
    expect(shown()).toBeNull();
    move(row, document.body);
    vi.advanceTimersByTime(1000);
    size(231, 226);
    move(null, row);
    vi.advanceTimersByTime(TIP.openDelay);
    expect(shown()).toBe("把笔记同步到 GitHub / Gitee 上的私有仓库");
  });

  it("draws key caps and the second line, and links them for screen readers", () => {
    const a = button("导出", {
      "data-tip-kbd": "Ctrl Shift E",
      "data-tip-detail": "Markdown、HTML、PDF",
    });
    move(null, a);
    vi.advanceTimersByTime(TIP.openDelay);
    const layer = root().querySelector(".odea-tip-txt")!;
    expect([...layer.querySelectorAll("kbd > span")].map((key) => key.textContent)).toEqual([
      "Ctrl",
      "Shift",
      "E",
    ]);
    expect(layer.querySelector(".odea-tip-detail")?.textContent).toBe("Markdown、HTML、PDF");
    expect(root().getAttribute("role")).toBe("tooltip");
    expect(root().getAttribute("aria-hidden")).toBe("false");
    expect(a.getAttribute("aria-describedby")).toBe(root().id);
    // 主字和 aria-label 一样：只读多出来的快捷键、说明
    expect(layer.querySelector(".odea-tip-line > span")?.getAttribute("aria-hidden")).toBe("true");
    move(a, document.body);
    vi.advanceTimersByTime(TIP.grace + 200);
    expect(a.hasAttribute("aria-describedby")).toBe(false);
  });

  it("changes the words in place when the target's tip changes while shown", async () => {
    const orb = button("同步中…");
    move(null, orb);
    vi.advanceTimersByTime(TIP.openDelay);
    orb.setAttribute("data-tip", "已同步 · 刚刚");
    await Promise.resolve();
    expect(shown()).toBe("已同步 · 刚刚");
  });

  it("gives way to a hover card inside it (an <abbr> in an HTML block)", () => {
    // 整块有提示的 HTML 块，里面的 <abbr> 出的是正文的悬停卡片（editor/hoverCard.ts）
    const block = button("点击空白处编辑 HTML");
    const abbr = document.createElement("abbr");
    abbr.setAttribute("data-odea-tip", "HyperText Markup Language");
    block.append(abbr);
    // 先停在块上、没到 500ms 就移进 <abbr>：不出
    move(null, block);
    vi.advanceTimersByTime(TIP.openDelay - 100);
    move(block, abbr);
    vi.advanceTimersByTime(TIP.openDelay);
    expect(shown()).toBeNull();
    // 块的提示出着时移进去：和移出去一样，留 80ms 后收
    move(abbr, block);
    vi.advanceTimersByTime(TIP.openDelay);
    expect(shown()).toBe("点击空白处编辑 HTML");
    move(block, abbr);
    vi.advanceTimersByTime(TIP.grace + 200);
    expect(shown()).toBeNull();
  });

  it("is one node per window, removed on uninstall", () => {
    expect(installTooltips(window)).toBe(uninstall);
    expect(document.querySelectorAll(".odea-tip")).toHaveLength(1);
    uninstall();
    expect(document.querySelector(".odea-tip")).toBeNull();
    const a = button("导出");
    move(null, a);
    vi.advanceTimersByTime(TIP.openDelay);
    uninstall = installTooltips(window);
    expect(shown()).toBeNull();
  });
});

describe("setTip：用代码建的 DOM", () => {
  it("puts the attributes on, replaces them, and takes them off for an empty label", () => {
    const link = document.createElement("span");
    setTip(link, "https://x.dev", { detail: "Ctrl+点击打开", side: "top", name: false });
    expect(link.dataset.tip).toBe("https://x.dev");
    expect(link.dataset.tipDetail).toBe("Ctrl+点击打开");
    expect(link.dataset.tipSide).toBe("top");
    expect(link.hasAttribute("aria-label")).toBe(false);

    // 再调一次：这次没给的说明、方向拿掉；默认顺手给 aria-label
    setTip(link, "播放");
    expect(link.dataset.tip).toBe("播放");
    expect(link.hasAttribute("data-tip-detail")).toBe(false);
    expect(link.hasAttribute("data-tip-side")).toBe(false);
    expect(link.getAttribute("aria-label")).toBe("播放");

    // 空的：提示整个拿掉，aria-label 不动
    setTip(link, "");
    expect(link.hasAttribute("data-tip")).toBe(false);
    expect(link.getAttribute("aria-label")).toBe("播放");
  });
});
