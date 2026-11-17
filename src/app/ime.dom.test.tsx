// @vitest-environment happy-dom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 输入法正在组字时按下的快捷键归输入法（docs/REVIEWS/2026-11-15-桌面端验证.md §3.3）：
 * 以前组到一半按 Ctrl+Tab 换了篇，组着的拼音成了正文里的字、存进了文件（桌面端 WebView2 里复现的）。
 * 换篇（Ctrl+Tab、Ctrl+W、Alt+数字、Alt+←）、命令面板（Ctrl+K）、全局搜索（Ctrl+Shift+F）都一样：组字时不动
 */

vi.mock("@/data/backend", () => ({
  backend: async () => new Proxy({}, { get: () => async () => [] }),
}));

const { useApp } = await import("./store");
const { emptyLayout } = await import("./panes");
const { useTabKeys } = await import("@/components/NoteTabs");
const { CommandPalette } = await import("@/components/CommandPalette");
const { FindDialog } = await import("@/components/FindDialog");

function TabKeys() {
  useTabKeys();
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  const fresh = emptyLayout("a");
  useApp.setState({
    workspace: "notes",
    notePanes: fresh.panes,
    activePane: fresh.activePane,
    selectedNoteId: "a",
    popouts: [],
    activePopout: null,
    paletteOpen: false,
    findOpen: false,
  });
  useApp.getState().openNoteTab("b");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <>
        <TabKeys />
        <CommandPalette />
        <FindDialog />
      </>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const press = (init: KeyboardEventInit) =>
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
const current = () => useApp.getState().selectedNoteId;

describe("组字时的快捷键", () => {
  it("Ctrl+Tab, Alt+1 and Ctrl+W leave the tabs alone while composing, and work once it is over", () => {
    expect(current()).toBe("b");
    press({ key: "Tab", code: "Tab", ctrlKey: true, isComposing: true });
    press({ key: "1", code: "Digit1", altKey: true, isComposing: true });
    press({ key: "w", code: "KeyW", ctrlKey: true, isComposing: true });
    expect(current()).toBe("b");
    expect(useApp.getState().notePanes[0]!.tabs).toHaveLength(2);
    press({ key: "Tab", code: "Tab", ctrlKey: true });
    expect(current()).toBe("a");
  });

  it("Ctrl+K and Ctrl+Shift+F open nothing while composing", () => {
    press({ key: "k", code: "KeyK", ctrlKey: true, isComposing: true });
    press({ key: "F", code: "KeyF", ctrlKey: true, shiftKey: true, isComposing: true });
    expect(useApp.getState().paletteOpen).toBe(false);
    expect(useApp.getState().findOpen).toBe(false);
    press({ key: "k", code: "KeyK", ctrlKey: true });
    expect(useApp.getState().paletteOpen).toBe(true);
  });
});

describe("命令面板里组字", () => {
  // 以前列表照输入框里的拼音筛，每打一个字母换一遍（「新建笔记「nih」」），还每个字母搜一次正文（§3.4）
  it("keeps the list while the pinyin grows and filters by the committed word", async () => {
    press({ key: "k", code: "KeyK", ctrlKey: true });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    const options = () =>
      [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    const before = options();
    expect(before.length).toBeGreaterThan(0);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const typeIn = (text: string, isComposing: boolean) =>
      act(() => {
        setter.call(input, text);
        input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing }));
      });
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    for (const text of ["n", "ni", "nih"]) typeIn(text, true);
    expect(input.value).toBe("nih");
    expect(options()).toEqual(before);
    typeIn("你好", true);
    act(() => {
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" }));
    });
    expect(options().some((text) => text?.includes("新建笔记「你好」"))).toBe(true);
  });
});
