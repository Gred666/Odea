// @vitest-environment happy-dom

import { EditorView } from "@codemirror/view";
import { MotionGlobalConfig } from "motion/react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor, clearEditorStateCache } from "./MarkdownEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
MotionGlobalConfig.skipAnimations = true;

/*
 * 存盘回来的那一版（store 里换成它，initialMarkdown 跟着变）是自己的回音，不能拿它盖掉编辑器里更新的字
 * （审查 2026-11-13 §4.32）：存盘还在路上时把刚打的字删了，正文正好等于上次对上的那一版，
 * 以前回音一到就整篇换上，删掉的字回来了。
 */

const noop = () => {};
let roots: Root[] = [];

beforeEach(() => {
  clearEditorStateCache();
  vi.useFakeTimers();
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.replaceChildren();
  vi.useRealTimers();
});

/** 一个编辑器，onSave 挂起直到 release；render 模拟 store 换了正文 */
function mount(markdown: string, saves: string[]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const pending: (() => void)[] = [];
  const onSave = (md: string) => {
    saves.push(md);
    return new Promise<void>((resolve) => pending.push(resolve));
  };
  const render = (md: string, externalRevision = 0) =>
    act(() =>
      root.render(
        <MarkdownEditor
          initialMarkdown={md}
          externalRevision={externalRevision}
          onSave={onSave}
          outlineItems={[]}
          onOutlineHandle={noop}
          cacheKey="note:echo"
        />,
      ),
    );
  render(markdown);
  const view = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
  return { view, render, release: () => pending.shift()?.() };
}

const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });

describe("the echo of the editor's own save", () => {
  it("does not bring back what was deleted while the save was on its way", async () => {
    const saves: string[] = [];
    const { view, render, release } = mount("A", saves);
    view.dispatch({ changes: { from: 1, insert: "x" }, userEvent: "input.type" });
    await settle();
    expect(saves).toEqual(["Ax"]);

    view.dispatch({ changes: { from: 1, to: 2 }, userEvent: "delete.backward" });
    release();
    render("Ax");
    expect(view.state.doc.toString()).toBe("A");

    await settle();
    expect(saves).toEqual(["Ax", "A"]);
    release();
    render("A");
    expect(view.state.doc.toString()).toBe("A");
  });

  it("still takes a change that came from elsewhere", async () => {
    const saves: string[] = [];
    const { view, render, release } = mount("A", saves);
    view.dispatch({ changes: { from: 1, insert: "x" }, userEvent: "input.type" });
    await settle();
    release();
    render("Ax");
    // 别处改了（不是这里交出去的那几版）、编辑器里没有没存的：换上
    render("B");
    expect(view.state.doc.toString()).toBe("B");
    // 外部改动正好是以前存过的那一版，也照样换上
    render("Ax", 1);
    expect(view.state.doc.toString()).toBe("Ax");
  });

  it("is recognised by the same note open in another pane", async () => {
    const leftSaves: string[] = [];
    const rightSaves: string[] = [];
    const left = mount("A", leftSaves);
    const right = mount("A", rightSaves);
    left.view.dispatch({ changes: { from: 1, insert: "x" }, userEvent: "input.type" });
    await settle();
    expect(leftSaves).toEqual(["Ax"]);
    left.view.dispatch({ changes: { from: 1, to: 2 }, userEvent: "delete.backward" });
    left.release();
    left.render("Ax");
    right.render("Ax");
    expect(left.view.state.doc.toString()).toBe("A");
    expect(right.view.state.doc.toString()).toBe("A");
    expect(rightSaves).toEqual([]);
  });
});
