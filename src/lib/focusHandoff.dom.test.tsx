// @vitest-environment happy-dom

import { MarkdownEditor, clearEditorStateCache } from "@/editor/MarkdownEditor";
import { EditorView } from "@codemirror/view";
import { MotionGlobalConfig } from "motion/react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimEditorFocus, offerEditorFocus } from "./focusHandoff";
import { useModalFocus } from "./modalFocus";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
MotionGlobalConfig.skipAnimations = true;

/*
 * 换篇时焦点的交接（体验轮 §4.46）：正文编辑器按篇挂，Ctrl+Tab、Alt+数字、Ctrl+W、从命令面板打开另一篇
 * 都是旧的编辑器连同焦点一起拆掉、新的挂上。以前焦点掉在 body 上，得再点一下正文才能打字
 */

let container: HTMLDivElement;
let root: Root;
const onOutlineHandle = () => {};
const DOCS: Record<string, string> = { a: "# 甲\n\n第一篇的正文", b: "# 乙\n\n第二篇的正文" };

beforeEach(() => {
  clearEditorStateCache();
  claimEditorFocus(); // 清掉上一条留下的
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function Doc({ id }: { id: string }) {
  return (
    <MarkdownEditor
      key={id}
      initialMarkdown={DOCS[id]!}
      onSave={async () => {}}
      outlineItems={[]}
      onOutlineHandle={onOutlineHandle}
      cacheKey={id}
    />
  );
}

/** 一个窗格：上面一个按钮（焦点不在正文时的落脚处），下面是这一篇 */
function show(id: string, extra?: React.ReactNode) {
  act(() =>
    root.render(
      <>
        <button type="button" id="outside">
          列表
        </button>
        <Doc id={id} />
        {extra}
      </>,
    ),
  );
}

const view = () => EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
const text = () => view().state.doc.toString();

describe("换篇时正文的焦点跟着走", () => {
  it("正文里有焦点时换篇：新的一篇接着聚焦，光标回到这一篇上次的位置", () => {
    show("a");
    act(() => {
      view().dispatch({ selection: { anchor: 4 } });
      view().focus();
    });
    show("b");
    expect(text()).toContain("第二篇");
    expect(view().hasFocus).toBe(true);

    act(() => view().dispatch({ selection: { anchor: 6 } }));
    show("a");
    expect(text()).toContain("第一篇");
    expect(view().hasFocus).toBe(true);
    expect(view().state.selection.main.head).toBe(4);
  });

  it("焦点在正文外面（比如在列表里点了另一篇）：新的一篇不抢焦点", () => {
    show("a");
    const outside = container.querySelector<HTMLButtonElement>("#outside")!;
    act(() => outside.focus());
    show("b");
    expect(view().hasFocus).toBe(false);
    expect(document.activeElement).toBe(outside);
  });

  it("焦点已经被别的接走了（新建的一篇聚焦了标题）：不抢", () => {
    show("a");
    act(() => view().focus());
    // 拆掉以后、新的挂上之前，别处拿走了焦点
    act(() => root.render(<button type="button" id="title" />));
    act(() => container.querySelector<HTMLButtonElement>("#title")!.focus());
    show("b");
    expect(view().hasFocus).toBe(false);
  });

  it("交了以后过了一秒才挂上的编辑器不接（那时多半是用户换了别的事）", () => {
    show("a");
    act(() => view().focus());
    const now = performance.now();
    act(() => root.render(null));
    vi.spyOn(performance, "now").mockReturnValue(now + 1500);
    show("b");
    expect(view().hasFocus).toBe(false);
  });

  it("交一次只接一次", () => {
    offerEditorFocus();
    expect(claimEditorFocus()).toBe(true);
    expect(claimEditorFocus()).toBe(false);
  });
});

function Modal({ open }: { open: boolean }) {
  const ref = useModalFocus(open);
  return open ? (
    <div role="dialog" aria-modal="true" ref={ref}>
      <input aria-label="搜索" />
    </div>
  ) : null;
}

describe("从模态框（命令面板）打开另一篇", () => {
  it("面板关掉时原来的正文已经换掉了：焦点交给新挂上的那一篇", () => {
    show("a", <Modal open={false} />);
    act(() => view().focus());
    show("a", <Modal open />);
    act(() => container.querySelector<HTMLInputElement>('[aria-label="搜索"]')!.focus());
    // 回车：面板关掉、换成另一篇，同一次渲染
    show("b", <Modal open={false} />);
    expect(text()).toContain("第二篇");
    expect(view().hasFocus).toBe(true);
  });

  it("没换篇（Esc）：照旧还给原来的正文", () => {
    show("a", <Modal open={false} />);
    act(() => view().focus());
    const before = view();
    show("a", <Modal open />);
    show("a", <Modal open={false} />);
    expect(view()).toBe(before);
    expect(view().hasFocus).toBe(true);
  });
});
