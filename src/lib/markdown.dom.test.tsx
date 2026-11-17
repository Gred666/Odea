// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { renderMarkdown } from "./markdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const opened = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/openExternal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openExternal")>()),
  openExternal: async (url: string) => {
    opened.push(url);
  },
}));

// 审查 2026-11-13 §4.33：只读预览、更新说明、模板预览里的链接不能让应用的窗口跳走
it("opens links in the system browser and never navigates the app window", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <div>{renderMarkdown("[官网](https://odea.app) [脚本](javascript:x) [相对](a.md)")}</div>,
    ),
  );
  const links = [...container.querySelectorAll("a")];
  expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://odea.app", null, null]);
  expect(links.some((link) => link.hasAttribute("target"))).toBe(false);

  const prevented = links.map((link) => {
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    return click.defaultPrevented;
  });
  expect(prevented).toEqual([true, true, true]);
  // 交给 openExternal 的都是原样的地址：能不能开由它判（javascript:、相对路径它不开）
  expect(opened).toEqual(["https://odea.app", "javascript:x", "a.md"]);
  act(() => root.unmount());
  container.remove();
});
