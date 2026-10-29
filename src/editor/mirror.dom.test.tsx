// @vitest-environment happy-dom

import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { MotionGlobalConfig } from "motion/react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor, clearEditorStateCache } from "./MarkdownEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
MotionGlobalConfig.skipAnimations = true;

/*
 * 同一篇开在两个窗格（docs/标签页与分屏.md §14）：两个编辑器，一边打的字转给另一边；
 * 转过去的不进那边的撤销历史、不由那边存盘；后挂上的那个从先挂着的那个现在的正文开始。
 */

let containers: HTMLDivElement[] = [];
let roots: Root[] = [];

beforeEach(() => {
  clearEditorStateCache();
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  for (const container of containers) container.remove();
  containers = [];
  roots = [];
});

function mount(markdown: string, onSave: (markdown: string) => Promise<void>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  containers.push(container);
  roots.push(root);
  act(() =>
    root.render(
      <MarkdownEditor
        initialMarkdown={markdown}
        onSave={onSave}
        outlineItems={[]}
        onOutlineHandle={() => {}}
        cacheKey="note:same"
      />,
    ),
  );
  const editor = container.querySelector<HTMLElement>(".cm-editor");
  expect(editor).not.toBeNull();
  return EditorView.findFromDOM(editor!)!;
}

const type = (view: EditorView, text: string) =>
  view.dispatch({
    changes: { from: view.state.doc.length, insert: text },
    userEvent: "input.type",
  });

describe("the same note in two panes", () => {
  it("forwards typing both ways and saves only from the side that typed", async () => {
    vi.useFakeTimers();
    try {
      const saveLeft = vi.fn(async () => {});
      const saveRight = vi.fn(async () => {});
      const left = mount("第一行", saveLeft);
      // 左边打了还没存，右边挂上：从左边现在的正文开始，不是 store 里那一版
      type(left, "，左");
      const right = mount("第一行", saveRight);
      expect(right.state.doc.toString()).toBe("第一行，左");

      type(right, "，右");
      expect(left.state.doc.toString()).toBe("第一行，左，右");
      type(left, "！");
      expect(right.state.doc.toString()).toBe("第一行，左，右！");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      // 各存各打的那一版（都是整篇），转过去的不触发那边存盘
      expect(saveLeft).toHaveBeenLastCalledWith("第一行，左，右！");
      expect(saveRight).toHaveBeenCalledTimes(1);
      expect(saveRight).toHaveBeenLastCalledWith("第一行，左，右");

      // 右边撤销只撤右边自己打的
      undo(right);
      expect(right.state.doc.toString()).toBe("第一行，左！");
      expect(left.state.doc.toString()).toBe("第一行，左！");
      // 右边是从左边的状态接着用的（不重新解析），左边挂上之前打的那几个字不在右边的历史里
      expect(undo(right)).toBe(false);
      expect(right.state.doc.toString()).toBe("第一行，左！");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps going after one side is closed", () => {
    const left = mount("正文", async () => {});
    mount("正文", async () => {});
    act(() => roots[1]!.unmount());
    type(left, "，接着写");
    expect(left.state.doc.toString()).toBe("正文，接着写");
  });
});
