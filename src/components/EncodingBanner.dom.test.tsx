// @vitest-environment happy-dom

import type { Backend } from "@/data/backend";
import type { LegacyText } from "@/data/types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 文件不是 UTF-8 时的横幅（docs/1110审查与研究.md §5.1）：先给人看认出来的样子，字对了才转；
 * 转的时候带上预览那一版的指纹；认不出编码就不给转
 */

let legacy: LegacyText;
const api = {
  docLegacyText: vi.fn(async () => legacy),
  docConvertUtf8: vi.fn(async () => {}),
};
vi.mock("@/data/backend", () => ({ backend: async () => api as unknown as Backend }));

const { EncodingBanner } = await import("./EncodingBanner");

const target = { type: "note", key: "n1" };
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  api.docLegacyText.mockClear();
  api.docConvertUtf8.mockClear();
  legacy = {
    encoding: "GBK",
    preview: "你好，世界",
    backup: "老笔记 (GBK 原文).txt",
    fingerprint: "f1",
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<EncodingBanner target={target} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
const click = async (text: string) => {
  const found = button(text);
  expect(found, text).toBeTruthy();
  await act(async () => {
    found!.click();
  });
};

describe("EncodingBanner", () => {
  it("shows what it would become before converting, then converts that version", async () => {
    expect(container.textContent).toContain("这篇不是 UTF-8 编码，只能看");
    await click("转成 UTF-8…");
    expect(api.docLegacyText).toHaveBeenCalledWith(target);
    expect(container.querySelector("[data-legacy-preview]")?.textContent).toBe("你好，世界");
    expect(container.textContent).toContain("按 GBK 认出来是这样");
    expect(container.textContent).toContain("「老笔记 (GBK 原文).txt」");
    expect(api.docConvertUtf8).not.toHaveBeenCalled();

    await click("字对，转成 UTF-8");
    expect(api.docConvertUtf8).toHaveBeenCalledWith(target, "f1");
    // 转完收起（后端通知这一篇变了，整个横幅随之消失）
    expect(container.querySelector("[data-legacy-preview]")).toBeNull();
  });

  it("can back out after looking", async () => {
    await click("转成 UTF-8…");
    await click("算了");
    expect(container.querySelector("[data-legacy-preview]")).toBeNull();
    expect(api.docConvertUtf8).not.toHaveBeenCalled();
  });

  it("offers nothing to convert when the encoding is not recognised", async () => {
    legacy = { encoding: null, preview: "", backup: "", fingerprint: "f2" };
    await click("转成 UTF-8…");
    expect(container.textContent).toContain("认不出是什么编码");
    expect(button("字对，转成 UTF-8")).toBeUndefined();
  });
});
