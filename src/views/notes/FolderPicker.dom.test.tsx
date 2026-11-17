// @vitest-environment happy-dom

import { AnimatePresence } from "motion/react";
import { StrictMode, act, useState } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FolderPicker } from "./FolderPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 文件夹选择器（标题「跳到文件夹」、行菜单「移动到…」）的焦点（docs/REVIEWS/2026-11-13-全项目审查.md §4.56）：
 * 以前 Esc、选好以后焦点掉在 body 上；Tab 一项项走过列表、走出卡片，卡片还开着、Esc 也关不掉
 */

let container: HTMLDivElement;
let root: Root;
let setOpen: (open: boolean) => void = () => {};

function Host() {
  const [open, set] = useState(false);
  setOpen = set;
  return (
    <>
      <button type="button">笔记标题</button>
      <AnimatePresence>
        {open && (
          <FolderPicker
            mode="jump"
            current=""
            top={0}
            onPick={() => set(false)}
            onClose={() => set(false)}
          />
        )}
      </AnimatePresence>
    </>
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // 应用开发时套着 StrictMode：effect 跑两遍，中间那次收尾会把焦点还回去
  act(() =>
    root.render(
      <StrictMode>
        <Host />
      </StrictMode>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const trigger = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === "笔记标题");
const input = () => container.querySelector<HTMLInputElement>('input[aria-label="跳到文件夹"]');
const key = (key: string, shiftKey = false) =>
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }),
    );
  });

describe("文件夹选择器的焦点", () => {
  it("打开焦点在筛选框；Tab 不走出卡片；Esc 关掉，焦点回到打开它的按钮", () => {
    act(() => trigger()?.focus());
    act(() => setOpen(true));
    expect(document.activeElement).toBe(input());
    key("Tab");
    expect(document.activeElement).toBe(input());
    key("Tab", true);
    expect(document.activeElement).toBe(input());
    key("Escape");
    expect(document.activeElement).toBe(trigger());
  });

  it("焦点在卡片本身（点了卡片里的空白）时 Esc 也关得掉", () => {
    act(() => trigger()?.focus());
    act(() => setOpen(true));
    const panel = container.querySelector<HTMLElement>('[role="dialog"]');
    act(() => panel?.focus());
    key("Escape");
    expect(document.activeElement).toBe(trigger());
  });

  it("列表里的项不进 Tab 顺序，读屏按 activedescendant 念高亮的那一项", () => {
    act(() => setOpen(true));
    const option = container.querySelector<HTMLElement>('[role="option"]');
    expect(option?.tabIndex).toBe(-1);
    expect(input()?.getAttribute("aria-activedescendant")).toBe(option?.id);
  });
});
