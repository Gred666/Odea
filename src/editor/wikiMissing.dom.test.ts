// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { knownWikiTitles, typoraDecorations } from "./MarkdownEditor";
import { markdownSupport } from "./markdownParser";

const views: EditorView[] = [];

function mount(doc: string, titles: ReadonlySet<string> | null) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      // 光标放在最后一行，双链所在的那一行不激活
      selection: { anchor: doc.length },
      extensions: [markdownSupport(), typoraDecorations, knownWikiTitles.of(titles)],
    }),
  });
  views.push(view);
  return parent;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe("链到还没有的笔记的双链", () => {
  it("draws links to missing notes differently and says how to create them", () => {
    const parent = mount("见 [[秋季复盘]] 和 [[还没写]]\n\n末尾", new Set(["秋季复盘"]));
    const links = [...parent.querySelectorAll<HTMLElement>(".cm-odea-wikilink")];
    expect(links.map((link) => link.textContent)).toEqual(["秋季复盘", "还没写"]);
    expect(links[0]?.classList.contains("is-missing")).toBe(false);
    expect(links[1]?.classList.contains("is-missing")).toBe(true);
    expect(links[1]?.title).toContain("新建");
  });

  it("matches titles the way backlinks do: trimmed and case-insensitive", () => {
    const parent = mount("[[ Weekly Notes ]]\n\n末尾", new Set(["weekly notes"]));
    expect(parent.querySelector(".cm-odea-wikilink.is-missing")).toBeNull();
  });

  it("marks nothing when the note list is unknown", () => {
    const parent = mount("[[随便]]\n\n末尾", null);
    expect(parent.querySelector(".cm-odea-wikilink")).not.toBeNull();
    expect(parent.querySelector(".cm-odea-wikilink.is-missing")).toBeNull();
  });
});
