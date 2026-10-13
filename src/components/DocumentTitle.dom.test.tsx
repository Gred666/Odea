// @vitest-environment happy-dom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditableDocumentTitle } from "./DocumentView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 正文上面那个可编辑的大标题：回车 / 点别处是「写完了」，Esc 是「不改了」。
 * Esc 自己调了 blur()，onBlur 同步跑在同一次渲染里 —— 以前那里拿到的还是改过的字，
 * 于是 Esc 也把改动存了进去（还会顺手改写别处链到旧标题的 [[…]]）。
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(onSave: (title: string) => Promise<void>) {
  act(() => root.render(<EditableDocumentTitle title="周末采购" onSave={onSave} />));
  return container.querySelector<HTMLTextAreaElement>("textarea")!;
}

/** 像用户打字那样改值：走原生 setter，React 才认 input 事件 */
function typeInto(field: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(field: HTMLTextAreaElement, key: string) {
  act(() => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("EditableDocumentTitle", () => {
  it("Esc throws the edit away instead of saving it", async () => {
    const onSave = vi.fn(async () => {});
    const field = render(onSave);
    act(() => field.focus());
    typeInto(field, "周末采购（改了）");

    press(field, "Escape");
    await act(async () => {});

    expect(onSave).not.toHaveBeenCalled();
    expect(field.value).toBe("周末采购");
    expect(document.activeElement).not.toBe(field);
  });

  it("still saves when the field loses focus normally", async () => {
    const onSave = vi.fn(async () => {});
    const field = render(onSave);
    act(() => field.focus());
    typeInto(field, "周末采购清单");

    act(() => field.blur());
    await act(async () => {});

    expect(onSave).toHaveBeenCalledWith("周末采购清单");
  });

  it("a later blur after Esc saves again", async () => {
    const onSave = vi.fn(async () => {});
    const field = render(onSave);
    act(() => field.focus());
    typeInto(field, "不要这个");
    press(field, "Escape");
    await act(async () => {});

    act(() => field.focus());
    typeInto(field, "要这个");
    act(() => field.blur());
    await act(async () => {});

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("要这个");
  });
});
