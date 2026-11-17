// @vitest-environment happy-dom
import { EditorView } from "@codemirror/view";
import { MotionGlobalConfig } from "motion/react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor, clearEditorStateCache } from "./MarkdownEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
MotionGlobalConfig.skipAnimations = true;

/*
 * 输入法组字时的存盘（docs/REVIEWS/2026-11-15-桌面端验证.md §3.2）：组字时正文里是拼音，
 * 以前防抖到点就存，拼音落盘；回音以后编辑器当成「没有没存的改动」，外面一改文件就整篇换掉，
 * 组着的字落到文档开头、拼音留成了正文（桌面端 WebView2 里复现的）
 */

let root: Root | null = null;
afterEach(() => {
  vi.useRealTimers();
  if (root) act(() => root!.unmount());
  root = null;
  clearEditorStateCache();
  document.body.replaceChildren();
});

/** 每次渲染同一个：编辑器按它重建 */
const noOutline = () => {};

function render(props: { markdown: string; revision: number }, spies: Spies) {
  act(() =>
    root!.render(
      <MarkdownEditor
        initialMarkdown={props.markdown}
        externalRevision={props.revision}
        onExternalConflict={spies.conflict}
        onSave={spies.save}
        outlineItems={[]}
        onOutlineHandle={noOutline}
      />,
    ),
  );
}
interface Spies {
  save: (markdown: string) => Promise<void>;
  conflict: () => void;
}

function open(markdown: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const saves: string[] = [];
  const spies: Spies = {
    save: vi.fn(async (value: string) => {
      saves.push(value);
    }),
    conflict: vi.fn(),
  };
  root = createRoot(host);
  render({ markdown, revision: 0 }, spies);
  const view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-content")!)!;
  const fire = (type: "compositionstart" | "compositionend") =>
    view.contentDOM.dispatchEvent(new CompositionEvent(type, { bubbles: true, data: "" }));
  const compose = (from: number, to: number, insert: string) =>
    view.dispatch({ changes: { from, to, insert }, userEvent: "input.type.compose" });
  return { host, view, saves, spies, fire, compose };
}

describe("组字时的存盘", () => {
  it("does not save the pinyin while composing, and saves the committed word afterwards", async () => {
    const { view, saves, fire, compose } = open("甲\n");
    vi.useFakeTimers();
    fire("compositionstart");
    compose(1, 1, "ni");
    await act(() => vi.advanceTimersByTimeAsync(1500));
    compose(1, 3, "nihao");
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(saves).toEqual([]);
    compose(1, 6, "你好");
    fire("compositionend");
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(saves).toEqual(["甲你好\n"]);
    expect(view.state.doc.toString()).toBe("甲你好\n");
  });

  it("an outside change during a long composition is a conflict, not a whole-document replacement", async () => {
    const { view, saves, spies, fire, compose } = open("# 标题\n\n外面会改这一篇。\n");
    const end = view.state.doc.length - 1;
    vi.useFakeTimers();
    fire("compositionstart");
    compose(end, end, "wai");
    await act(() => vi.advanceTimersByTimeAsync(1000));
    // 别的程序往文件里加了一行，文件监听送进来
    render({ markdown: "# 标题\n\n外面加的一行。\n\n外面会改这一篇。\n", revision: 1 }, spies);
    expect(view.state.doc.toString()).toBe("# 标题\n\n外面会改这一篇。wai\n");
    expect(spies.conflict).toHaveBeenCalledTimes(1);
    compose(end, end + 3, "外面");
    fire("compositionend");
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(saves).toEqual(["# 标题\n\n外面会改这一篇。外面\n"]);
  });
});
