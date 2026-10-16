// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { typoraDecorations } from "./MarkdownEditor";
import { markdownSupport } from "./markdownParser";
import { selectionOpensRange } from "./markdownStyleRegistry";
import { resizedImageSource } from "./widgets";

const views: EditorView[] = [];

function mount(doc: string, anchor: number) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdownSupport(), typoraDecorations],
    }),
  });
  views.push(view);
  return { parent, view };
}

const text = (parent: HTMLElement) => parent.querySelector(".cm-content")?.textContent;
const imageOf = (parent: HTMLElement) => parent.querySelector<HTMLImageElement>("img.cm-otw-image");
const frameOf = (parent: HTMLElement) => parent.querySelector<HTMLElement>(".cm-otw-image-frame");

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

const DOC = "前\n\n![图](a.png)\n\n后";
const TO = DOC.indexOf(")") + 1;

describe("图片一直画着，源码露在下面", () => {
  it("shows the source under the same image while the cursor is on it", () => {
    const { parent, view } = mount(DOC, 0);
    const image = imageOf(parent);
    expect(image).not.toBeNull();
    expect(text(parent)).toBe("前后");
    expect(frameOf(parent)?.classList.contains("is-open")).toBe(false);

    view.dispatch({ selection: { anchor: TO } });
    expect(imageOf(parent)).toBe(image);
    expect(frameOf(parent)?.classList.contains("is-open")).toBe(true);
    expect(text(parent)).toContain("![图](a.png)");
    expect(parent.querySelector(".cm-otw-image-source")?.textContent).toBe("![图](a.png)");

    view.dispatch({ selection: { anchor: 0 } });
    expect(imageOf(parent)).toBe(image);
    expect(text(parent)).toBe("前后");
  });

  it("keeps the source folded under a selection that covers the image whole", () => {
    const range = (from: number, to = from) => ({ from, to, head: to, empty: from === to });
    expect(selectionOpensRange([range(4)], 4, 14)).toBe(true);
    expect(selectionOpensRange([range(14)], 4, 14)).toBe(true);
    expect(selectionOpensRange([range(3)], 4, 14)).toBe(false);
    expect(selectionOpensRange([range(0, 20)], 4, 14)).toBe(false);
    expect(selectionOpensRange([range(4, 14)], 4, 14)).toBe(false);
    expect(selectionOpensRange([range(6, 20)], 4, 14)).toBe(true);
    expect(selectionOpensRange([range(0, 4)], 4, 14)).toBe(false);

    const { parent, view } = mount(DOC, 0);
    view.dispatch({ selection: { anchor: 0, head: DOC.length } });
    expect(frameOf(parent)?.classList.contains("is-open")).toBe(false);
    expect(text(parent)).toBe("前后");
  });

  it("puts the cursor after the source when the image is clicked", () => {
    const { view, parent } = mount(DOC, 0);
    imageOf(parent)?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(view.state.selection.main.head).toBe(TO);
    expect(frameOf(parent)?.classList.contains("is-open")).toBe(true);
  });

  it("does the same for an HTML <img>", () => {
    const doc = '前 <img src="https://x.dev/a.png" width="80"> 后';
    const { view, parent } = mount(doc, 0);
    expect(imageOf(parent)?.style.width).toBe("80px");
    imageOf(parent)?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(view.state.selection.main.head).toBe(doc.indexOf(">") + 1);
  });
});

describe("改图片大小", () => {
  it("writes the width back into the alt, keeping the rest of the source", () => {
    expect(resizedImageSource("![图](a.png)", "markdown", 320)).toBe("![图|320](a.png)");
    expect(resizedImageSource('![图|300x200](a.png "说明")', "markdown", 240)).toBe(
      '![图|240](a.png "说明")',
    );
    expect(resizedImageSource("![|300](a.png)", "markdown", null)).toBe("![](a.png)");
    expect(resizedImageSource("![图][ref]", "markdown", 100)).toBe("![图|100][ref]");
    expect(resizedImageSource("不是图片", "markdown", 100)).toBeNull();
  });

  it("sets the width attribute of an <img> and drops its height", () => {
    expect(resizedImageSource('<img src="a.png">', "html", 200)).toBe(
      '<img src="a.png" width="200">',
    );
    expect(resizedImageSource('<img src="a.png" width="80" height="40" />', "html", 200)).toBe(
      '<img src="a.png" width="200" />',
    );
    expect(resizedImageSource("<img src=a.png width=80>", "html", null)).toBe("<img src=a.png>");
  });

  it("restores the original size on a double click of the handle, as one undoable edit", () => {
    const doc = "前\n\n![图|300](a.png)\n\n后";
    const { view, parent } = mount(doc, 0);
    const image = imageOf(parent);
    expect(image?.style.width).toBe("300px");

    parent
      .querySelector(".cm-otw-image-handle")
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(view.state.doc.toString()).toBe("前\n\n![图](a.png)\n\n后");
    // 同一个 <img> 就地改了尺寸，没有重新加载
    expect(imageOf(parent)).toBe(image);
    expect(image?.style.width).toBe("");
  });
});
