// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { typoraDecorations } from "./MarkdownEditor";
import { type AttachmentHost, attachmentHost } from "./attachmentEmbed";
import { markdownSupport } from "./markdownParser";

const views: EditorView[] = [];

function mount(doc: string, host: AttachmentHost | null, anchor = doc.length) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdownSupport(), typoraDecorations, attachmentHost.of(host)],
    }),
  });
  views.push(view);
  return { parent, view };
}

const FILES: Record<string, string> = {
  "说明书.pdf": "附件/说明书.pdf",
  "录音.m4a": "附件/录音.m4a",
  "季度/报表.xlsx": "笔记/季度/报表.xlsx",
};

function host(open = vi.fn(), remote = false): AttachmentHost {
  return {
    resolve: (name) => {
      const rel = FILES[name];
      return rel ? { rel, src: `asset://${rel}` } : null;
    },
    open,
    remote,
  };
}

const cards = (parent: HTMLElement) => [...parent.querySelectorAll<HTMLElement>(".cm-odea-file")];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe("![[说明书.pdf]] 附件卡片", () => {
  it("draws a card for an attachment on its own line, and leaves everything else alone", () => {
    const doc = [
      "![[说明书.pdf]]",
      "",
      "![[季度/报表.xlsx|三季度报表]]",
      "",
      "夹在字里的 ![[说明书.pdf]] 不画卡片",
      "",
      "![[找不到.docx]]",
      "",
      "![[周报]]",
      "",
      "末尾",
    ].join("\n");
    const { parent } = mount(doc, host());
    const [pdf, sheet, missing, ...rest] = cards(parent);
    expect(rest).toHaveLength(0);
    expect(pdf?.classList.contains("is-pdf")).toBe(true);
    expect(pdf?.querySelector(".cm-odea-file-name")?.textContent).toBe("说明书.pdf");
    expect(pdf?.querySelector(".cm-odea-file-meta")?.textContent).toBe("PDF 文档 · 附件");
    // 写了 `|别名` 的显示别名
    expect(sheet?.querySelector(".cm-odea-file-name")?.textContent).toBe("三季度报表");
    expect(sheet?.querySelector(".cm-odea-file-meta")?.textContent).toBe("Excel 表格 · 笔记/季度");
    expect(missing?.classList.contains("is-missing")).toBe(true);
    expect(missing?.textContent).toContain("仓库里找不到「找不到.docx」");
    expect(missing?.querySelector("button")).toBeNull();
    // 源码收着：那一行只剩卡片
    expect(parent.querySelector(".cm-odea-embed-line")?.textContent).not.toContain("![[");
  });

  it("opens the file and reveals it from the card's buttons", () => {
    const open = vi.fn();
    const { parent, view } = mount("![[说明书.pdf]]\n\n末尾", host(open));
    const [openButton, revealButton] = [...parent.querySelectorAll<HTMLButtonElement>("button")];
    openButton!.click();
    revealButton!.click();
    expect(open.mock.calls).toEqual([
      ["说明书.pdf", false],
      ["说明书.pdf", true],
    ]);
    // 点按钮不挪光标
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it("plays audio and video in the card", () => {
    const { parent } = mount("![[录音.m4a]]\n\n末尾", host());
    const audio = parent.querySelector("audio");
    expect(audio?.getAttribute("src")).toBe("asset://附件/录音.m4a");
    expect(audio?.controls).toBe(true);
  });

  it("shows the source under the card when the cursor is on that line", () => {
    const { parent } = mount("![[说明书.pdf]]\n\n末尾", host(), 3);
    expect(cards(parent)).toHaveLength(1);
    expect(parent.querySelector(".cm-odea-embed-source")?.textContent).toContain("说明书.pdf]]");
  });

  it("asks the host for a guest's attachment and has no reveal button", () => {
    const open = vi.fn();
    const guest: AttachmentHost = {
      resolve: (name) => ({ rel: name, src: "" }),
      open,
      remote: true,
    };
    const { parent } = mount("![[录音.m4a]]\n\n末尾", guest);
    expect(parent.querySelector(".cm-odea-file-meta")?.textContent).toBe("音频 · 在主持人那边");
    // 主持人那边的音视频要先整个要过来，卡片里不放
    expect(parent.querySelector("audio")).toBeNull();
    const buttons = [...parent.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons).toHaveLength(1);
    buttons[0]!.click();
    expect(open).toHaveBeenCalledWith("录音.m4a", false);
  });

  it("stays source without a host (the browser lab)", () => {
    const { parent } = mount("![[说明书.pdf]]\n\n末尾", null);
    expect(cards(parent)).toHaveLength(0);
  });
});
