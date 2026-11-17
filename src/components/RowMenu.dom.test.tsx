// @vitest-environment happy-dom

import { Hash, Type } from "lucide-react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActionMenu } from "./RowMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 下拉菜单关上以后焦点去哪（docs/REVIEWS/2026-11-13-全项目审查.md §4.51）：
 * 以前一律不还，Esc、选完一项焦点都掉在 body 上；动作自己把焦点放到别处的（改名的输入框、对话框）不抢
 */

let container: HTMLDivElement;
let elsewhere: HTMLInputElement;
let root: Root;

beforeEach(() => {
  elsewhere = document.createElement("input");
  container = document.createElement("div");
  document.body.append(elsewhere, container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  elsewhere.remove();
});

/** Radix 收起以后在下一个宏任务里才处理焦点 */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

async function mountMenu(onSelect: () => void) {
  await act(async () =>
    root.render(
      <ActionMenu
        trigger={
          <button type="button" aria-label="换类型">
            T
          </button>
        }
        actions={[
          { id: "text", label: "文字", icon: Type, onSelect },
          { id: "number", label: "数字", icon: Hash, onSelect },
        ]}
      />,
    ),
  );
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="换类型"]')!;
  trigger.focus();
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle();
  const menu = document.querySelector<HTMLElement>("[role=menu]");
  expect(menu).not.toBeNull();
  return { trigger, menu: menu! };
}

describe("ActionMenu", () => {
  it("Esc hands the focus back to the button that opened it", async () => {
    const { trigger, menu } = await mountMenu(() => {});
    await act(async () => {
      (document.activeElement ?? menu).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();
    expect(document.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("picking an item hands the focus back to the button", async () => {
    const { trigger } = await mountMenu(() => {});
    const item = document.querySelector<HTMLElement>("[role^=menuitem]")!;
    await act(async () => {
      item.focus();
      item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    expect(document.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not take the focus back from where the action put it", async () => {
    await mountMenu(() => elsewhere.focus());
    const item = document.querySelector<HTMLElement>("[role^=menuitem]")!;
    await act(async () => {
      item.focus();
      item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    expect(document.activeElement).toBe(elsewhere);
  });
});
