// @vitest-environment happy-dom

import { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MotionGlobalConfig } from "motion/react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor, clearEditorStateCache } from "./MarkdownEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
MotionGlobalConfig.skipAnimations = true;

/*
 * 只读的编辑器（文件不是 UTF-8，docs/1110审查与研究.md §5.1；协作的只读访客）：
 * EditorState.readOnly 只拦键盘，点一下就改源码的小部件（勾任务、折叠提示块）、快捷键是直接 dispatch 的，
 * 要另外拦。别处同步过来的（Transaction.remote）照常进来
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  clearEditorStateCache();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function mount(markdown: string, readOnly: boolean, onSave: (markdown: string) => Promise<void>) {
  act(() =>
    root.render(
      <MarkdownEditor
        initialMarkdown={markdown}
        onSave={onSave}
        outlineItems={[]}
        onOutlineHandle={() => {}}
        cacheKey="note:read-only"
        readOnly={readOnly}
      />,
    ),
  );
  const editor = container.querySelector<HTMLElement>(".cm-editor");
  expect(editor).not.toBeNull();
  return EditorView.findFromDOM(editor!)!;
}

describe("a read-only editor", () => {
  it("drops edits that do not come from elsewhere, and saves nothing", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn(async () => {});
    const view = mount("开头\n\n- [ ] 买菜", true, onSave);

    // 勾任务的方框就是这么改的（widgets.ts 的 TaskWidget）
    const at = view.state.doc.toString().indexOf("[ ]");
    view.dispatch({ changes: { from: at, to: at + 3, insert: "[x]" } });
    view.dispatch({ changes: { from: 0, insert: "**" }, userEvent: "input.type" });
    expect(view.state.doc.toString()).toBe("开头\n\n- [ ] 买菜");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onSave).not.toHaveBeenCalled();

    // 别处同步过来的照常进来（协作的对方；外部改动回填）
    view.dispatch({
      changes: { from: 0, insert: "对方：" },
      annotations: Transaction.remote.of(true),
    });
    expect(view.state.doc.toString()).toBe("对方：开头\n\n- [ ] 买菜");
  });

  it("lets the same edits through once it is editable", () => {
    const view = mount("- [ ] 买菜", false, async () => {});
    view.dispatch({ changes: { from: 2, to: 5, insert: "[x]" } });
    expect(view.state.doc.toString()).toBe("- [x] 买菜");
  });
});
