// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { typoraDecorations } from "./MarkdownEditor";
import { diagramEngine } from "./diagram";
import { hoverCard } from "./hoverCard";
import { resolveImageSource, safeImageSource, sanitizeHtml, sanitizeStyle } from "./html";
import { splitWikiTarget, wikiTargetAt } from "./links";
import { markdownSupport } from "./markdownParser";
import { parseDelimitedTable } from "./markdownTable";
import { loadKatex } from "./math";

const views: EditorView[] = [];

function mount(doc: string, anchor: number) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: Math.min(anchor, doc.length) },
      extensions: [markdownSupport(), typoraDecorations],
    }),
  });
  views.push(view);
  return { parent, view };
}

const lines = (parent: HTMLElement) =>
  [...parent.querySelectorAll(".cm-line")].map((line) => line.textContent);
const text = (parent: HTMLElement) => parent.querySelector(".cm-content")?.textContent;
const markers = (parent: HTMLElement) =>
  [...parent.querySelectorAll(".cm-otw-list-marker")].map((n) => n.textContent);
const click = (node: Element | null) =>
  node?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const styleOf = (node: Element | null) => node?.getAttribute("style")?.replace(/;\s*$/, "");

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  diagramEngine.cached = null;
});

describe("行内 HTML", () => {
  it("maps whitelisted tags to the same classes as markdown and hides the tags", () => {
    const source = '<b>粗</b> <mark>亮</mark> <span style="color:red;position:fixed">红</span> 完';
    const { parent, view } = mount(source, 999);
    expect(parent.querySelector(".cm-otw-strong")?.textContent).toBe("粗");
    expect(parent.querySelector(".cm-otw-highlight")?.textContent).toBe("亮");
    const span = parent.querySelector(".cm-otw-span") as HTMLElement;
    expect(span.textContent).toBe("红");
    expect(styleOf(span)).toBe("color: red");
    expect(text(parent)).toBe("粗 亮 红 完");

    view.dispatch({ selection: { anchor: 2 } });
    expect(text(parent)).toBe("<b>粗</b> 亮 红 完");
    expect(parent.querySelectorAll(".cm-otw-syntax-marker")).toHaveLength(2);
  });

  it("renders <sub>, <sup>, <kbd> and <font>", () => {
    const { parent } = mount(
      'H<sub>2</sub>O x<sup>2</sup> <kbd>Ctrl</kbd> <font color="blue" size="5">大</font> 完',
      999,
    );
    expect(parent.querySelector(".cm-otw-sub")?.textContent).toBe("2");
    expect(parent.querySelector(".cm-otw-sup")?.textContent).toBe("2");
    expect(parent.querySelector(".cm-otw-kbd")?.textContent).toBe("Ctrl");
    expect(styleOf(parent.querySelector(".cm-otw-span"))).toBe("color: blue; font-size: 1.5em");
    expect(text(parent)).toBe("H2O x2 Ctrl 大 完");
  });

  it("leaves unpaired and unknown tags as source", () => {
    const { parent } = mount("<b>没闭合 和 <blink>x</blink> 完", 999);
    expect(parent.querySelector(".cm-otw-strong")).toBeNull();
    expect(parent.querySelectorAll(".cm-otw-html").length).toBeGreaterThan(0);
    expect(text(parent)).toBe("<b>没闭合 和 <blink>x</blink> 完");
  });

  it("turns <br> into a real line break and <img> into an image", () => {
    const { parent, view } = mount(
      '一<br>二 <img src="https://x.dev/a.png" alt="图" width="80"> 完',
      999,
    );
    expect(parent.querySelector(".cm-otw-br br")).not.toBeNull();
    const image = parent.querySelector(".cm-otw-image") as HTMLImageElement;
    expect(image.alt).toBe("图");
    expect(image.style.width).toBe("80px");
    expect(text(parent)).toBe("一↵二  完");

    view.dispatch({ selection: { anchor: 3 } });
    expect(parent.querySelector(".cm-otw-br")).toBeNull();
    expect(lines(parent)[0]).toContain("<br>");
  });

  it("refuses dangerous image sources and anchors", () => {
    const { parent } = mount(
      '<img src="javascript:alert(1)"> <a href="javascript:x">坏</a> <a href="https://x.dev">好</a> 完',
      999,
    );
    expect(parent.querySelector(".cm-otw-image")).toBeNull();
    const links = [...parent.querySelectorAll(".cm-otw-link")] as HTMLElement[];
    expect(links.map((n) => [n.textContent, n.dataset.href ?? null])).toEqual([
      ["坏", null],
      ["好", "https://x.dev"],
    ]);
  });

  it("collapses html comments into a pill until the cursor is on that line", () => {
    const { parent, view } = mount("前 <!-- 备注 --> 后\n\n<!-- 整块注释 -->\n\n尾", 999);
    expect(parent.querySelectorAll(".cm-otw-comment")).toHaveLength(2);
    expect(lines(parent)).toEqual(["前 注释 后", "", "", "尾"]);

    view.dispatch({ selection: { anchor: 1 } });
    expect(lines(parent)[0]).toBe("前 <!-- 备注 --> 后");
  });
});

describe("块级 HTML", () => {
  it("renders headings and tables from html, dropping scripts and handlers", () => {
    const source =
      '<h2 onclick="x()">标题</h2>\n<table><tr><td style="color:red;background:url(x)">格</td></tr></table>\n<script>alert(1)</script>\n<details open><summary>更多</summary>内容</details>';
    const { parent } = mount(`${source}\n\n后`, 999);
    const widget = parent.querySelector(".cm-otw-html-widget") as HTMLElement;
    expect(widget.querySelector("h2")?.textContent).toBe("标题");
    expect(widget.querySelector("h2")?.hasAttribute("onclick")).toBe(false);
    expect(styleOf(widget.querySelector("td"))).toBe("color: red");
    expect(widget.querySelector("script")).toBeNull();
    expect(widget.querySelector("details")?.hasAttribute("open")).toBe(true);
    expect(lines(parent)).toEqual(["", "后"]);
  });

  it("sanitizes independently of the editor", () => {
    const host = document.createElement("div");
    // iframe 指向 about:blank：happy-dom 的 DOMParser 文档不像浏览器那样是惰性的，
    // 相对地址会真的去请求 localhost:3000，在测试输出里留一条 ECONNREFUSED
    host.append(
      sanitizeHtml(
        '<iframe src="about:blank"></iframe><p title="t" id="i" class="c" onmouseover="y">段<a href="javascript:z">a</a><a href="mailto:me@x.dev">m</a></p>',
      ),
    );
    expect(host.innerHTML).toBe('<p title="t">段<a>a</a><a href="mailto:me@x.dev">m</a></p>');
    expect(
      sanitizeStyle("color: #fff; font-size: 2em; position: absolute; background: url(a)"),
    ).toBe("color: #fff; font-size: 2em");
  });
});

describe("Callout 变体", () => {
  it("shows the custom title next to the badge", () => {
    const { parent } = mount("> [!tip] 自定义标题\n> 正文\n\n后", 999);
    expect(parent.querySelector(".cm-otw-callout-badge.is-tip")?.textContent).toBe("tip");
    expect(parent.querySelector(".cm-otw-callout-title")?.textContent).toBe("自定义标题");
    expect(lines(parent)[0]).toBe("tip 自定义标题");
  });

  it("folds `[!x]-` bodies and toggles the sign in the source on click", () => {
    const source = "> [!note]- 收起\n> 第一行\n> 第二行\n\n后";
    const { parent, view } = mount(source, source.length);
    expect(parent.querySelector(".cm-otw-callout-badge.is-collapsed")).not.toBeNull();
    expect(parent.querySelector(".cm-otw-callout-fold-button")?.textContent).toBe("… 展开 2 行");
    expect(lines(parent)).toEqual(["note 收起", "", "后"]);
    expect(parent.querySelector(".cm-line.cm-otw-callout-head.cm-otw-callout-tail")).not.toBeNull();

    click(parent.querySelector(".cm-otw-callout-fold-button"));
    expect(view.state.doc.toString()).toBe("> [!note]+ 收起\n> 第一行\n> 第二行\n\n后");
    expect(parent.querySelector(".cm-otw-callout-fold-button")).toBeNull();
    expect(parent.querySelector(".cm-otw-callout-badge.is-expanded")).not.toBeNull();
    expect(lines(parent)).toEqual(["note 收起", "第一行", "第二行", "", "后"]);

    click(parent.querySelector(".cm-otw-callout-badge"));
    expect(view.state.doc.toString()).toBe(source);
  });

  it("keeps the body visible while the cursor is inside a collapsed callout", () => {
    const { parent } = mount("> [!note]-\n> 第一行\n\n后", 12);
    expect(parent.querySelector(".cm-otw-callout-fold-button")).toBeNull();
    // 光标在正文行的 `>` 后面：徽章照常显示，只有光标碰到的那一个 `>` 露出来
    expect(lines(parent)).toEqual(["note", "> 第一行", "", "后"]);
  });
});

describe("列表符号", () => {
  it("numbers ordered items by position, honouring the start and delimiter", () => {
    expect(markers(mount("1. a\n1. b\n1. c\n\n后", 999).parent)).toEqual(["1.", "2.", "3."]);
    expect(markers(mount("3. a\n1. b\n\n后", 999).parent)).toEqual(["3.", "4."]);
    expect(markers(mount("1) a\n7) b\n\n后", 999).parent)).toEqual(["1)", "2)"]);
  });

  it("changes the bullet glyph by nesting depth", () => {
    const { parent } = mount("- a\n  - b\n    - c\n      - d\n\n后", 999);
    expect(markers(parent)).toEqual(["•", "◦", "▪", "•"]);
  });

  it("numbers a nested ordered list independently", () => {
    const { parent } = mount("1. a\n   1. x\n   1. y\n2. b\n\n后", 999);
    expect(markers(parent)).toEqual(["1.", "1.", "2.", "2."]);
  });
});

describe("数学公式", () => {
  it("replaces inline math with a KaTeX widget and keeps emphasis out", async () => {
    const { parent, view } = mount("看 $a*b$ 和 $c*d$ 完", 999);
    expect(parent.querySelectorAll(".cm-otw-math.is-inline")).toHaveLength(2);
    expect(parent.querySelector(".cm-otw-emphasis")).toBeNull();
    await loadKatex();
    await tick();
    expect(parent.querySelector(".cm-otw-math .katex")).not.toBeNull();
    expect(parent.querySelector(".cm-otw-math.is-loading")).toBeNull();

    view.dispatch({ selection: { anchor: 4 } });
    expect(parent.querySelector(".cm-otw-math-source")?.textContent).toBe("$a*b$");
    expect(parent.querySelectorAll(".cm-otw-math.is-inline")).toHaveLength(1);
  });

  it("folds $$ blocks into a display widget and shows the source when active", () => {
    const source = "上\n$$\n\\sum_i x_i\n$$\n下";
    const { parent, view } = mount(source, source.length);
    expect(parent.querySelector(".cm-otw-math-block .cm-otw-math.is-block")).not.toBeNull();
    expect(lines(parent)).toEqual(["上", "下"]);

    view.dispatch({ selection: { anchor: 5 } });
    expect(parent.querySelectorAll(".cm-line.cm-otw-math-source")).toHaveLength(3);
    expect(lines(parent)).toEqual(["上", "$$", "\\sum_i x_i", "$$", "下"]);
  });

  it("does not mistake prices for math", () => {
    const { parent } = mount("花了 $5 和 $10 完", 999);
    expect(parent.querySelector(".cm-otw-math")).toBeNull();
    expect(text(parent)).toBe("花了 $5 和 $10 完");
  });
});

describe("图表与 CSV 围栏", () => {
  it("renders a mermaid fence through the diagram engine", async () => {
    const render = vi.fn(async () => ({
      svg: "<svg><g id='ok'></g></svg>",
      bindFunctions: undefined,
    }));
    vi.spyOn(diagramEngine, "load").mockResolvedValue({ render } as never);
    const source = "```mermaid\ngraph TD; A-->B\n```\n\n后";
    const { parent, view } = mount(source, source.length);
    expect(parent.querySelector(".cm-otw-diagram.is-loading")).not.toBeNull();
    expect(lines(parent)).toEqual(["", "后"]);
    await tick();
    await tick();
    expect(render).toHaveBeenCalledWith(expect.stringMatching(/^otw-diagram-/), "graph TD; A-->B");
    expect(parent.querySelector(".cm-otw-diagram svg #ok")).not.toBeNull();

    view.dispatch({ selection: { anchor: 3 } });
    expect(parent.querySelector(".cm-otw-diagram")).toBeNull();
    expect(lines(parent)[0]).toBe("```mermaid");
  });

  it("shows the error in place when the diagram is invalid", async () => {
    vi.spyOn(diagramEngine, "load").mockResolvedValue({
      render: async () => {
        throw new Error("Parse error on line 1\ndetail");
      },
    } as never);
    const { parent } = mount("```mermaid\nnonsense\n```\n\n后", 999);
    await tick();
    await tick();
    expect(parent.querySelector(".cm-otw-diagram.is-error")?.textContent).toBe(
      "图表无法渲染：Parse error on line 1",
    );
  });

  it("renders csv fences as tables with quoted fields", () => {
    const source = '```csv\n名字,值\n甲,"1, 2"\n乙,3\n```\n\n后';
    const { parent, view } = mount(source, source.length);
    const cells = [...parent.querySelectorAll(".cm-otw-table-widget td")].map((n) => n.textContent);
    expect(cells).toEqual(["甲", "1, 2", "乙", "3"]);
    expect(lines(parent)).toEqual(["", "后"]);

    view.dispatch({ selection: { anchor: 8 } });
    expect(parent.querySelector(".cm-otw-table-widget")).toBeNull();
    expect(parent.querySelectorAll(".cm-line.cm-otw-code-block").length).toBeGreaterThan(0);
  });

  it("parses tsv and rfc4180 quotes", () => {
    expect(parseDelimitedTable('a\tb\n"x ""q"""\ty\n', "\t")).toMatchObject({
      header: ["a", "b"],
      rows: [['x "q"', "y"]],
      alignments: [null, null],
    });
    expect(parseDelimitedTable("", ",")).toBeNull();
  });

  it("breaks lines inside table cells on <br>", () => {
    const { parent } = mount("| a | b |\n|---|---|\n| 一<br>二 | <b>粗</b> |\n\n后", 999);
    const cell = parent.querySelector(".cm-otw-table-widget td");
    expect(cell?.querySelector("br")).not.toBeNull();
    expect(cell?.textContent).toBe("一二");
    expect(parent.querySelector(".cm-otw-table-widget .cm-otw-strong")?.textContent).toBe("粗");
  });
});

describe("定义列表、缩写、智能标点", () => {
  it("styles `term / : definition` pairs and hides the colon", () => {
    const { parent, view } = mount("术语\n: 释义一\n: 释义二\n\n后", 999);
    expect(parent.querySelectorAll(".cm-line.cm-otw-dt")).toHaveLength(1);
    expect(parent.querySelectorAll(".cm-line.cm-otw-dd")).toHaveLength(2);
    expect(lines(parent)).toEqual(["术语", "释义一", "释义二", "", "后"]);

    view.dispatch({ selection: { anchor: 5 } });
    expect(lines(parent)[1]).toBe(": 释义一");
  });

  it("does not turn a heading into a term", () => {
    const { parent } = mount("## 标题\n\n: 不是释义\n\n后", 999);
    expect(parent.querySelector(".cm-line.cm-otw-dt")).toBeNull();
  });

  it("annotates abbreviations defined with *[X]: …", () => {
    const { parent } = mount("HTML 很好，HTML5 不算\n\n*[HTML]: 超文本标记语言\n\n后", 999);
    const abbr = parent.querySelectorAll(".cm-otw-abbr");
    expect(abbr).toHaveLength(1);
    expect(abbr[0]?.getAttribute("data-otw-tip")).toBe("超文本标记语言");
    expect(abbr[0]?.getAttribute("data-otw-tip-label")).toBe("HTML");
    expect(parent.querySelector(".cm-line.cm-otw-abbr-def")).not.toBeNull();
  });

  it("swaps dashes, ellipses and marks for typographic glyphs on display only", () => {
    const source = "a -- b --- c ... (c) (tm)\n\n---\n\n`--` 后";
    const { parent, view } = mount(source, source.length);
    expect(lines(parent)[0]).toBe("a – b — c … © ™");
    expect(parent.querySelector(".cm-otw-hr")).not.toBeNull();
    expect(lines(parent).at(-1)).toBe("-- 后");
    expect(view.state.doc.toString()).toBe(source);

    view.dispatch({ selection: { anchor: 3 } });
    expect(lines(parent)[0]).toBe("a -- b — c … © ™");
  });

  it("leaves table delimiter rows and setext underlines alone", () => {
    const { parent } = mount("| a |\n|---|\n| 1 |\n\n标题\n---\n\n后", 6);
    expect(lines(parent)[1]).toBe("|---|");
    const setext = mount("标题\n---\n\n后", 1).parent;
    expect(lines(setext)[1]).toBe("---");
  });
});

describe("脚注与双链", () => {
  it("previews the definition on the reference and jumps between the two", () => {
    const source = "正文[^a] 完\n\n[^a]: 这是 多个 词 的脚注";
    const { parent, view } = mount(source, 0);
    const ref = parent.querySelector(".cm-otw-footnote.is-ref") as HTMLElement;
    // 预览走悬停卡片（hoverCard.ts）的 data 属性，不再用原生 title
    expect(ref.dataset.otwTip).toBe("这是 多个 词 的脚注");
    expect(ref.dataset.otwTipLabel).toBe("脚注 a");
    expect(ref.hasAttribute("title")).toBe(false);
    expect(parent.querySelector(".cm-otw-footnote.is-def")).not.toBeNull();
    expect(lines(parent)).toEqual(["正文a 完", "", "a这是 多个 词 的脚注"]);

    click(ref);
    expect(view.state.selection.main.head).toBe(source.indexOf("[^a]:"));
    // 光标落在定义上时定义徽章会让位给源码，先挪开再点它
    view.dispatch({ selection: { anchor: source.length } });
    click(parent.querySelector(".cm-otw-footnote.is-def"));
    expect(view.state.selection.main.head).toBe(2);
  });

  it("splits wiki targets into title, heading and block", () => {
    expect(splitWikiTarget("笔记")).toEqual({ title: "笔记" });
    expect(splitWikiTarget("笔记#小节")).toEqual({ title: "笔记", heading: "小节" });
    expect(splitWikiTarget("笔记^abc")).toEqual({ title: "笔记", block: "abc" });
    const { parent, view } = mount("看 [[笔记#小节|别名]] 完", 999);
    expect(parent.querySelector(".cm-otw-wikilink")?.getAttribute("title")).toContain(
      "笔记 › 小节",
    );
    expect(wikiTargetAt(view.state, 4)).toBe("笔记#小节");
  });
});

describe("图片地址", () => {
  it("passes web and data urls through and refuses script urls", () => {
    expect(resolveImageSource("https://x.dev/a.png")).toBe("https://x.dev/a.png");
    expect(safeImageSource("data:image/png;base64,AA")).toBe("data:image/png;base64,AA");
    expect(safeImageSource("data:text/html,x")).toBeNull();
    expect(safeImageSource("javascript:alert(1)")).toBeNull();
    // 浏览器里没有 asset 协议可转，本机路径原样返回
    expect(resolveImageSource("C:\\pics\\a.png")).toBe("C:\\pics\\a.png");
  });
});

describe("悬停卡片", () => {
  function mountWithCard(doc: string) {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [markdownSupport(), typoraDecorations, hoverCard],
      }),
    });
    views.push(view);
    return { parent, view };
  }
  const over = (node: Element) =>
    node.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  const out = (node: Element) =>
    node.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));

  it("shows the footnote body above the badge after a short delay, and hides on leave", () => {
    vi.useFakeTimers();
    try {
      const { parent } = mountWithCard("正文[^a] 完\n\n[^a]: 脚注的内容\n\n后");
      const ref = parent.querySelector(".cm-otw-footnote.is-ref")!;
      over(ref);
      expect(document.querySelector(".otw-hovercard")).toBeNull();
      vi.advanceTimersByTime(400);
      const card = document.querySelector(".otw-hovercard")!;
      expect(card.querySelector(".otw-hovercard-label")?.textContent).toBe("脚注 a");
      expect(card.querySelector(".otw-hovercard-body")?.textContent).toBe("脚注的内容");
      expect(card.querySelector(".otw-hovercard-hint")?.textContent).toBe("点击跳到脚注");

      out(ref);
      vi.advanceTimersByTime(400);
      expect(document.querySelector(".otw-hovercard")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an abbreviation's expansion and gets out of the way on scroll", () => {
    vi.useFakeTimers();
    try {
      const { parent } = mountWithCard("HTML 很好\n\n*[HTML]: 超文本标记语言\n\n后");
      const abbr = parent.querySelector(".cm-otw-abbr")!;
      over(abbr);
      vi.advanceTimersByTime(400);
      expect(document.querySelector(".otw-hovercard-body")?.textContent).toBe("超文本标记语言");
      window.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(400);
      expect(document.querySelector(".otw-hovercard")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
