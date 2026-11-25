// @vitest-environment happy-dom

import { useData } from "@/data/store";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { typoraDecorations } from "./MarkdownEditor";
import { type EmbedHost, embedHost } from "./embed";
import { markdownSupport } from "./markdownParser";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WEEKLY = "# 周报\n## 本周\n做完了两件事\n## 下周计划\n还没想";

const views: EditorView[] = [];

function mount(doc: string, host: EmbedHost | null, anchor = doc.length) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdownSupport(), typoraDecorations, embedHost.of(host)],
    }),
  });
  views.push(view);
  return { parent, view };
}

const host = (open = vi.fn()): EmbedHost => ({ ids: new Map([["周报", "n1"]]), open });
/** 等所有嵌入卡片把正文异步排进 DOM（不靠固定毫秒，并行跑 KaTeX 首轮加载也不闪断） */
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
  await vi.waitFor(() => {
    for (const body of document.querySelectorAll(".cm-odea-embed-body")) {
      expect(body.childNodes.length).toBeGreaterThan(0);
    }
  });
};
const cards = (parent: HTMLElement) => [...parent.querySelectorAll<HTMLElement>(".cm-odea-embed")];

afterEach(async () => {
  await act(async () => {
    for (const view of views.splice(0)) view.destroy();
  });
  document.body.replaceChildren();
  useData.setState({ bodies: {} });
});

describe("![[笔记]] 嵌入", () => {
  it("draws a card for an embed on its own line, and leaves everything else alone", async () => {
    useData.setState({ bodies: { n1: WEEKLY } });
    const doc = [
      "![[周报]]",
      "",
      "![[周报#下周计划]]",
      "",
      "夹在字里的 ![[周报]] 不嵌",
      "",
      "![[截图.png]]",
      "",
      "![[还没写]]",
      "",
      "末尾",
    ].join("\n");
    const { parent } = mount(doc, host());
    await settle();

    const [whole, section, missing, ...rest] = cards(parent);
    expect(rest).toHaveLength(0);
    expect(whole?.textContent).toContain("做完了两件事");
    expect(whole?.textContent).toContain("还没想");
    expect(section?.querySelector(".cm-odea-embed-section")?.textContent).toBe("› 下周计划");
    expect(section?.textContent).toContain("还没想");
    expect(section?.textContent).not.toContain("做完了两件事");
    expect(missing?.textContent).toContain("还没有「还没写」这篇笔记");
    // 源码收着：那一行只剩卡片
    expect(parent.querySelector(".cm-odea-embed-line")?.textContent).not.toContain("![[");
  });

  it("keeps the card when the cursor comes onto the line: no empty flash, an opened callout stays open", async () => {
    useData.setState({ bodies: { n1: "# 周报\n> [!NOTE]- 细节\n> 收起来的字\n\n做完了两件事" } });
    const { parent, view } = mount("![[周报]]\n\n末尾", host());
    await settle();
    const card = cards(parent)[0]!;
    const details = card.querySelector("details")!;
    details.open = true;

    // 点卡片的空白处、方向键路过：光标进这一行，源码露出来
    await act(async () => {
      view.dispatch({ selection: { anchor: 3 } });
    });
    expect(parent.querySelector(".cm-odea-embed-source")).not.toBeNull();
    expect(parent.querySelector(".cm-odea-embed-frame")?.classList.contains("is-open")).toBe(true);
    // 还是那一张：以前这里换了一张新的，正文要等下一轮才排出来（卡片先塌成只剩标题那一条），展开的 callout 也收回去了
    expect(cards(parent)[0]).toBe(card);
    expect(card.textContent).toContain("做完了两件事");
    expect(card.querySelector("details")?.open).toBe(true);

    await act(async () => {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    });
    expect(cards(parent)[0]).toBe(card);
    expect(parent.querySelector(".cm-odea-embed-frame")?.classList.contains("is-open")).toBe(false);
  });

  it("follows the embedded note when it changes", async () => {
    useData.setState({ bodies: { n1: WEEKLY } });
    const { parent } = mount("![[周报#本周]]\n\n末尾", host());
    await settle();
    expect(cards(parent)[0]?.textContent).toContain("做完了两件事");

    await act(async () => {
      useData.setState({ bodies: { n1: "# 周报\n## 本周\n又做完一件" } });
    });
    await vi.waitFor(() => expect(cards(parent)[0]?.textContent).toContain("又做完一件"));

    await act(async () => {
      useData.setState({ bodies: { n1: "# 周报\n把这一节删了" } });
    });
    await vi.waitFor(() =>
      expect(cards(parent)[0]?.textContent).toContain("「周报」里没有「本周」这一节"),
    );
  });

  it("shows the source under the card when the cursor is on that line", async () => {
    useData.setState({ bodies: { n1: WEEKLY } });
    const { parent, view } = mount("![[周报]]\n\n末尾", host());
    await settle();
    expect(parent.querySelector(".cm-odea-embed-frame.is-open")).toBeNull();

    await act(async () => {
      view.dispatch({ selection: EditorSelection.cursor(3) });
    });
    await settle();
    expect(parent.querySelector(".cm-odea-embed-frame.is-open")).not.toBeNull();
    expect(parent.querySelector(".cm-odea-embed-source")?.textContent).toContain("周报");
  });

  it("opens the note on a modifier click", async () => {
    useData.setState({ bodies: { n1: WEEKLY } });
    const open = vi.fn();
    const { parent } = mount("![[周报#下周计划]]\n\n末尾", host(open));
    await settle();
    const frame = parent.querySelector<HTMLElement>(".cm-odea-embed-frame")!;
    frame.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, ctrlKey: true, metaKey: true }),
    );
    expect(open).toHaveBeenCalledWith("周报", "下周计划", false);
  });

  it("draws the images and formulas of the embedded note, but no embed inside an embed", async () => {
    useData.setState({
      bodies: { n1: "# 周报\n\n![[图.png|120]]\n\n质能 $E=mc^2$\n\n![[周报]]" },
      attachments: ["附件/图.png"],
    });
    const { parent } = mount("![[周报]]\n\n末尾", host());
    await settle();
    const card = cards(parent)[0]!;
    const image = card.querySelector("img");
    // 浏览器预览里没有仓库文件夹：按站点根目录给（data/attachments.ts 的 vaultFileSrc）
    expect(image?.getAttribute("src")).toBe(
      `/${encodeURIComponent("附件")}/${encodeURIComponent("图.png")}`,
    );
    expect(image?.getAttribute("width")).toBe("120");
    expect(card.querySelector(".katex")).not.toBeNull();
    expect(card.querySelectorAll(".cm-odea-embed, .embed")).toHaveLength(0);
    expect(card.querySelector(".wikilink")?.textContent).toBe("周报");
    useData.setState({ attachments: [] });
  });

  it("does not embed without knowing the notes (a guest's document)", async () => {
    useData.setState({ bodies: { n1: WEEKLY } });
    const { parent } = mount("![[周报]]\n\n末尾", null);
    await settle();
    expect(cards(parent)).toHaveLength(0);
  });

  it("does not stringify the whole doc on an open ![[note]] line or inline ![](url) image", async () => {
    useData.setState({ bodies: { n1: WEEKLY } });
    const doc =
      "![[周报]]\n\n![封面](https://example.com/cover.png)\n\n[周报]: https://example.com/a.png\n\n末尾";
    const { parent, view } = mount(doc, host(), doc.length);
    await settle();

    const spy = vi.spyOn(view.state.doc, "toString");
    await act(async () => {
      view.dispatch({ selection: { anchor: 3 } });
    });
    expect(spy).not.toHaveBeenCalled();
    expect(cards(parent)).toHaveLength(1);
    expect(parent.querySelectorAll("img.cm-odea-image")).toHaveLength(1);
  });
});
