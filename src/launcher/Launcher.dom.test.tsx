// @vitest-environment happy-dom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Launcher } from "./Launcher";
import { launcherApi } from "./api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 启动器右边几屏之间的焦点、出错的那一行（docs/REVIEWS/2026-11-13-全项目审查.md §4.55）。接浏览器预览的假接口
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
  vi.restoreAllMocks();
});

const settle = async (ms = 300) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

const button = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("main button")].find(
    (b) => b.textContent?.trim() === text,
  );

/** 用键盘按：先聚焦再点（happy-dom 的 click 不挪焦点） */
const press = (target: HTMLElement | undefined) =>
  act(() => {
    target?.focus();
    target?.click();
  });

const pressEscape = () =>
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });

describe("启动器", () => {
  it("从「新建」「加入」按 Esc 回到首页：焦点回到打开那一屏的按钮上，不掉在 body 上", async () => {
    act(() => root.render(<Launcher />));
    await settle();
    press(button("新建"));
    await settle(500);
    expect(document.activeElement?.tagName).toBe("INPUT");
    pressEscape();
    await settle(500);
    expect(document.activeElement).toBe(button("新建"));

    press(button("加入"));
    await settle(500);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("邀请链接");
    pressEscape();
    await settle(500);
    expect(document.activeElement).toBe(button("加入"));
  });

  it("「拉取」那一屏：一打开、退回一步，焦点都在「返回」上，Esc 一路退得回首页", async () => {
    vi.spyOn(launcherApi, "accounts").mockResolvedValue([{ provider: "github", login: "you" }]);
    act(() => root.render(<Launcher />));
    await settle();
    press(button("拉取"));
    await settle(500);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("返回");
    // 点 GitHub（登录过）→ 仓库列表：点过的按钮拆掉了，焦点放到「返回」上
    press(
      [...container.querySelectorAll<HTMLButtonElement>("main button")].find((b) =>
        b.textContent?.includes("GitHub"),
      ),
    );
    await settle(400);
    expect(container.textContent).toContain("you/odea-notes");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("返回");
    pressEscape();
    await settle(300);
    expect(container.textContent).toContain("Gitee");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("返回");
    pressEscape();
    await settle(500);
    expect(document.activeElement).toBe(button("拉取"));
  });

  it("没登录、点 GitHub 等验证码时按下的按钮变灰：焦点放到「返回」上，Esc 退得出去；要码失败了焦点也不掉在 body 上", async () => {
    vi.spyOn(launcherApi, "accounts").mockResolvedValue([]);
    let fail: (cause: Error) => void = () => {};
    vi.spyOn(launcherApi, "githubLoginStart").mockImplementation(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    vi.spyOn(launcherApi, "loginCancel").mockResolvedValue(undefined);
    act(() => root.render(<Launcher />));
    await settle();
    press(button("拉取"));
    await settle(500);
    const github = () =>
      [...container.querySelectorAll<HTMLButtonElement>("main button")].find((b) =>
        b.textContent?.includes("GitHub"),
      );
    press(github());
    await settle();
    expect(container.textContent).toContain("正在向 GitHub 要验证码");
    expect(github()?.disabled).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("返回");
    // 要码失败：回到选托管方、按钮又能按了，焦点还在「返回」上
    await act(async () => fail(new Error("网络不通")));
    await settle();
    expect(container.textContent).toContain("网络不通");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("返回");
    // 再点一次、等着的时候 Esc：退回首页
    press(github());
    await settle();
    pressEscape();
    await settle(500);
    expect(document.activeElement).toBe(button("拉取"));
  });

  it("出错了：那一行滚进窗口里（「新建」那一屏自己就到了窗口底）", async () => {
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    act(() => root.render(<Launcher />));
    await settle();
    expect(container.querySelector("[role=alert]")).toBeNull();
    press(button("新建"));
    await settle(500);
    const input = document.activeElement as HTMLInputElement;
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "forGPT");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => input.form?.requestSubmit());
    await settle(400);
    const alert = container.querySelector("[role=alert]");
    expect(alert?.textContent).toContain("已经有了");
    expect(scrolled).toContain(alert);
  });
});
