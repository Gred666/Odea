// @vitest-environment happy-dom

import { buildOutline } from "@/lib/markdown";
import { clearViewMemory, spotOf } from "@/lib/viewMemory";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Outline } from "./Outline";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 右侧目录树的收起（技术方案 §12.9）：点箭头收起 / 展开、Alt 连下面各层、高亮落到收起的祖先、
 * ← →、全部收起 / 展开、每篇记着收起了哪些。动画本身（高度的弹簧、箭头的转动）在无头 Chrome 里
 * 逐帧量过，这里只管状态
 */

const MARKDOWN = [
  "## 第一节",
  "",
  "### 小节 A",
  "",
  "#### 更深一层",
  "",
  "### 小节 B",
  "",
  "## 第二节",
  "",
  "### 小节 C",
].join("\n");
const items = buildOutline(MARKDOWN);
const idOf = (text: string) => items.find((item) => item.text === text)!.id;

let container: HTMLDivElement;
let root: Root;
const scrollRef = { current: null };

beforeEach(() => {
  clearViewMemory();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(resetKey = "note-1", memoryKey = "note:1") {
  act(() =>
    root.render(
      <Outline items={items} scrollRef={scrollRef} resetKey={resetKey} memoryKey={memoryKey} />,
    ),
  );
}

const rail = () => container.querySelector("aside")!;
const row = (text: string) =>
  [...rail().querySelectorAll<HTMLButtonElement>("[data-outline-item]")].find(
    (button) => button.textContent?.trim() === text,
  )!;
const chevron = (text: string) =>
  row(text).parentElement!.querySelector<HTMLButtonElement>("[data-outline-control]")!;
const expanded = (text: string) => row(text).getAttribute("aria-expanded");
/** 没被收起来的条目（收起的子树带 inert） */
const visible = () =>
  [...rail().querySelectorAll<HTMLElement>("[data-outline-item]")]
    .filter((button) => !button.closest("[inert]"))
    .map((button) => button.textContent?.trim());
const highlighted = () =>
  rail().querySelector("[data-outline-item] > span.absolute")?.parentElement?.textContent?.trim();

function click(target: HTMLElement, altKey = false) {
  act(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey })));
}

describe("目录树收起", () => {
  it("puts a chevron only on entries with something under them", () => {
    render();
    expect(chevron("第一节")).toBeTruthy();
    expect(chevron("小节 A")).toBeTruthy();
    expect(chevron("小节 B")).toBeNull();
    expect(chevron("更深一层")).toBeNull();
    // 「概览」不当谁的父亲
    expect(row("概览").getAttribute("aria-expanded")).toBeNull();
  });

  it("folds from the chevron without jumping, and remembers it per document", () => {
    render();
    click(chevron("第一节"));
    expect(expanded("第一节")).toBe("false");
    expect(visible()).toEqual(["概览", "第一节", "第二节", "小节 C"]);
    expect(spotOf("note:1")?.outline).toEqual(["1:第一节#0"]);

    // 换一篇：那一篇自己的（没收起过）
    render("note-2", "note:2");
    expect(expanded("第一节")).toBe("true");
    // 换回来：还收着
    render("note-1", "note:1");
    expect(expanded("第一节")).toBe("false");
  });

  it("folds every level below with Alt, and keeps inner folds when only the outer one opens", () => {
    render();
    click(chevron("第一节"), true);
    expect(expanded("第一节")).toBe("false");
    expect(expanded("小节 A")).toBe("false");
    click(chevron("第一节"));
    expect(visible()).toEqual(["概览", "第一节", "小节 A", "小节 B", "第二节", "小节 C"]);
    click(chevron("第一节"), true);
    click(chevron("第一节"), true);
    expect(expanded("小节 A")).toBe("true");
  });

  it("moves the highlight to the folded section that holds the current one", async () => {
    let jump: (id: string) => void = () => {};
    const handle = {
      scrollTo: (id: string) => {
        jump(id);
        return true;
      },
      subscribe: (listener: (id: string) => void) => {
        jump = listener;
        return () => {};
      },
      scrollToLine: () => true,
      focusStart: () => true,
    };
    act(() =>
      root.render(
        <Outline
          items={items}
          scrollRef={scrollRef}
          resetKey="note-1"
          memoryKey="note:1"
          editorHandle={handle}
        />,
      ),
    );
    act(() => jump(idOf("更深一层")));
    expect(highlighted()).toBe("更深一层");
    click(chevron("小节 A"));
    expect(highlighted()).toBe("小节 A");
    click(chevron("第一节"));
    expect(highlighted()).toBe("第一节");
    click(chevron("第一节"));
    expect(highlighted()).toBe("小节 A");
  });

  it("folds with ← and →, and ← on a leaf goes up a level", () => {
    render();
    const key = (target: HTMLElement, name: string) =>
      act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
    key(row("第二节"), "ArrowLeft");
    expect(expanded("第二节")).toBe("false");
    key(row("第二节"), "ArrowRight");
    expect(expanded("第二节")).toBe("true");
    row("小节 C").focus();
    key(row("小节 C"), "ArrowLeft");
    expect(document.activeElement).toBe(row("第二节"));
  });

  it("folds and unfolds everything from the header", () => {
    render();
    const all = rail().querySelector<HTMLButtonElement>('[aria-label="全部收起"]')!;
    click(all);
    expect(visible()).toEqual(["概览", "第一节", "第二节"]);
    click(rail().querySelector<HTMLButtonElement>('[aria-label="全部展开"]')!);
    expect(visible()).toHaveLength(items.length);
  });
});
