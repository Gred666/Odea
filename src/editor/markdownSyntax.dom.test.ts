// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView, type WidgetType } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { resolveImage, typoraBlockDecorations, typoraDecorations } from "./MarkdownEditor";
import { linkTargetAt, wikiTargetAt } from "./links";
import { markdownSupport } from "./markdownParser";
import { TableWidget } from "./tableWidget";

/** 使用指南里的「语法全览」：每一种语法都在里面 */
import guide from "@/content/guide/syntax.md?raw";

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

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe("行内小语法", () => {
  it("renders <sub> and ^superscript^ with hidden marks", () => {
    const { parent, view } = mount("H<sub>2</sub>O 和 x^2^ 完", 999);
    expect(parent.querySelector(".cm-otw-sub")?.textContent).toBe("2");
    expect(parent.querySelector(".cm-otw-sup")?.textContent).toBe("2");
    expect(text(parent)).toBe("H2O 和 x2 完");

    view.dispatch({ selection: { anchor: 2 } });
    expect(text(parent)).toBe("H<sub>2</sub>O 和 x2 完");
  });

  it("treats a single ~ as strikethrough, like GitHub", () => {
    const { parent } = mount("~a~ 和 ~~b~~ 完", 999);
    expect([...parent.querySelectorAll(".cm-otw-strike")].map((n) => n.textContent)).toEqual([
      "a",
      "b",
    ]);
    expect(text(parent)).toBe("a 和 b 完");
  });

  it("swaps known emoji shortcodes for the glyph and leaves unknown ones alone", () => {
    const { parent } = mount("好 :smile: :nope: 完", 999);
    expect(parent.querySelector(".cm-otw-glyph.is-emoji")?.textContent).toBe("😄");
    expect(text(parent)).toBe("好 😄 :nope: 完");
  });

  it("decodes entities and reveals the source when the cursor is inside", () => {
    const { parent, view } = mount("A &amp; B &#8212; C", 0);
    expect(text(parent)).toBe("A & B — C");
    view.dispatch({ selection: { anchor: 4 } });
    expect(text(parent)).toBe("A &amp; B — C");
  });

  it("hides the escape backslash only", () => {
    const { parent, view } = mount("不是\\*斜体\\* 完", 0);
    expect(text(parent)).toBe("不是*斜体* 完");
    view.dispatch({ selection: { anchor: 3 } });
    expect(text(parent)).toBe("不是\\*斜体* 完");
  });

  it("marks hard breaks with a glyph without merging lines", () => {
    const { parent } = mount("第一行  \n第二行\\\n第三行", 999);
    expect(parent.querySelectorAll(".cm-otw-hard-break")).toHaveLength(2);
    expect(lines(parent)).toEqual(["第一行↵", "第二行↵", "第三行"]);
  });

  it("keeps pairing ==highlight== after a Setext underline or code full of equals", () => {
    const source = "标题\n=====\n\n`a==b` 和 ==真高亮== 完\n\n==又一个== 尾";
    const { parent } = mount(source, source.length);
    expect([...parent.querySelectorAll(".cm-otw-highlight")].map((n) => n.textContent)).toEqual([
      "真高亮",
      "又一个",
    ]);
    expect(lines(parent)).toEqual(["标题", "", "a==b 和 真高亮 完", "", "又一个 尾"]);
  });

  it("highlights ==text== but not spaced equals", () => {
    const { parent } = mount("a ==重点== b 而 x == y == z 不算", 999);
    expect(parent.querySelector(".cm-otw-highlight")?.textContent).toBe("重点");
    expect(parent.querySelectorAll(".cm-otw-highlight")).toHaveLength(1);
    expect(text(parent)).toBe("a 重点 b 而 x == y == z 不算");
  });
});

describe("方括号家族", () => {
  it("styles [[wikilinks]], hides the brackets and honours aliases", () => {
    const { parent, view } = mount("看 [[我的笔记]] 和 [[目标|别名]] 完", 999);
    expect([...parent.querySelectorAll(".cm-otw-wikilink")].map((n) => n.textContent)).toEqual([
      "我的笔记",
      "别名",
    ]);
    expect(text(parent)).toBe("看 我的笔记 和 别名 完");
    expect(wikiTargetAt(view.state, 4)).toBe("我的笔记");
    expect(wikiTargetAt(view.state, 16)).toBe("目标");

    view.dispatch({ selection: { anchor: 4 } });
    expect(text(parent)).toBe("看 [[我的笔记]] 和 别名 完");
  });

  it("treats plain [brackets] as text unless a reference definition exists", () => {
    const plain = mount("见 [附录] 完", 999);
    expect(plain.parent.querySelector(".cm-otw-link")).toBeNull();
    expect(text(plain.parent)).toBe("见 [附录] 完");

    const defined = mount("见 [附录] 完\n\n[附录]: https://example.com", 999);
    expect(defined.parent.querySelector(".cm-otw-link")?.textContent).toBe("附录");
    expect(linkTargetAt(defined.view.state, 3)).toBe("https://example.com");
  });

  it("renders footnote references and definitions as badges", () => {
    const { parent, view } = mount("正文[^1] 完\n\n[^1]: 注释内容", 0);
    const badges = [...parent.querySelectorAll(".cm-otw-footnote")];
    expect(badges.map((n) => n.className)).toEqual([
      "cm-otw-footnote is-ref",
      "cm-otw-footnote is-def",
    ]);
    expect(lines(parent)).toEqual(["正文1 完", "", "1注释内容"]);
    expect(parent.querySelector(".cm-line.cm-otw-footnote-def")).not.toBeNull();

    view.dispatch({ selection: { anchor: 3 } });
    expect(lines(parent)[0]).toBe("正文[^1] 完");
  });

  it("renders back-to-back footnotes in Chinese prose as badges, not superscript", () => {
    const { parent } = mount("正文[^1]，接着写[^long]。\n\n[^1]: 甲\n[^long]: 乙", 0);
    const badges = [...parent.querySelectorAll(".cm-otw-footnote")];
    expect(badges.map((n) => n.className)).toEqual([
      "cm-otw-footnote is-ref",
      "cm-otw-footnote is-ref",
      "cm-otw-footnote is-def",
      "cm-otw-footnote is-def",
    ]);
    expect(parent.querySelector(".cm-otw-sup")).toBeNull();
    expect(lines(parent)).toEqual(["正文1，接着写long。", "", "1甲", "long乙"]);
  });

  it("hides the link title together with the destination", () => {
    const { parent, view } = mount('[官网](https://x.dev "标题") 完', 999);
    expect(text(parent)).toBe("官网 完");
    expect(parent.querySelector(".cm-otw-link")?.getAttribute("title")).toContain("https://x.dev");
    expect(linkTargetAt(view.state, 1)).toBe("https://x.dev");
  });
});

describe("块级构造", () => {
  it("turns `> [!TIP]` into a callout with a badge and coloured lines", () => {
    const source = "> [!TIP]\n> 多喝水\n\n之后";
    const { parent, view } = mount(source, source.length);
    expect(parent.querySelector(".cm-otw-callout-badge.is-tip")?.textContent).toBe("TIP");
    expect(parent.querySelectorAll(".cm-line.cm-otw-callout.is-tip")).toHaveLength(2);
    expect(parent.querySelector(".cm-line.cm-otw-callout-head")).not.toBeNull();
    expect(parent.querySelector(".cm-line.cm-otw-callout-tail")).not.toBeNull();
    expect(parent.querySelector(".cm-line.cm-otw-quote")).toBeNull();
    expect(lines(parent)).toEqual(["TIP", "多喝水", "", "之后"]);

    view.dispatch({ selection: { anchor: 3 } });
    expect(parent.querySelector(".cm-otw-callout-badge")).toBeNull();
    // `>` 只在光标碰到它自己时露出来（画在竖线右边的留白里，不占正文的位置）
    expect(lines(parent)[0]).toBe("[!TIP]");
    view.dispatch({ selection: { anchor: 0 } });
    expect(lines(parent)[0]).toBe("> [!TIP]");
    expect(parent.querySelector(".cm-otw-syntax-marker.is-quote")?.textContent).toBe("> ");
  });

  it("maps Chinese labels to the generic callout", () => {
    const { parent } = mount("> [!核心判断]\n> 结论", 999);
    expect(parent.querySelector(".cm-otw-callout-badge.is-generic")?.textContent).toBe("核心判断");
  });

  it("indents nested blockquotes by depth", () => {
    const { parent } = mount("> 一层\n> > 两层\n> > > 三层\n\n后", 999);
    expect(parent.querySelectorAll(".cm-line.cm-otw-quote-d1")).toHaveLength(3);
    expect(parent.querySelectorAll(".cm-line.cm-otw-quote-d2")).toHaveLength(2);
    expect(parent.querySelectorAll(".cm-line.cm-otw-quote-d3")).toHaveLength(1);
    expect(lines(parent)).toEqual(["一层", "两层", "三层", "", "后"]);
  });

  it("folds front matter fences and never treats its keys as headings", () => {
    const source = "---\ntitle: 笔记\ntags: [a]\n---\n\n# 正文";
    const { parent, view } = mount(source, source.length);
    expect(parent.querySelectorAll(".cm-otw-frontmatter-fence")).toHaveLength(2);
    expect(parent.querySelector(".cm-otw-frontmatter-label")?.textContent).toBe("属性");
    expect(parent.querySelectorAll(".cm-line.cm-otw-frontmatter")).toHaveLength(2);
    expect(parent.querySelector(".cm-otw-h2")).toBeNull();
    expect(parent.querySelector(".cm-otw-hr")).toBeNull();
    expect(parent.querySelectorAll(".cm-otw-h1")).toHaveLength(1);

    view.dispatch({ selection: { anchor: 6 } });
    expect(parent.querySelectorAll(".cm-otw-frontmatter-fence")).toHaveLength(0);
    expect(lines(parent).slice(0, 4)).toEqual(["---", "title: 笔记", "tags: [a]", "---"]);
    // 露出来的 `---` 和封口一样高（globals.css），点进属性块时正文不跳
    expect(parent.querySelector(".cm-otw-frontmatter-fence-line.is-open")?.textContent).toBe("---");
    expect(parent.querySelector(".cm-otw-frontmatter-fence-line.is-close")?.textContent).toBe(
      "---",
    );
  });

  it("keeps front matter folded when a fresh editor sits at position 0", () => {
    // 新挂载的编辑器光标停在 0，不能算「点进了属性块」
    const { parent } = mount("---\ntitle: 笔记\n---\n\n正文", 0);
    expect(parent.querySelectorAll(".cm-otw-frontmatter-fence")).toHaveLength(2);
  });

  it("does not mistake a leading horizontal rule for front matter", () => {
    const { parent } = mount("---\n\n正文", 999);
    expect(parent.querySelector(".cm-otw-frontmatter-fence")).toBeNull();
    expect(parent.querySelector(".cm-otw-hr")).not.toBeNull();
  });

  it("replaces [TOC] with a clickable table of contents", () => {
    const source = "[TOC]\n\n# 一\n\n## 二 **粗**\n\n### 三";
    const { parent, view } = mount(source, source.length);
    const items = [...parent.querySelectorAll(".cm-otw-toc-item button")];
    expect(items.map((n) => n.textContent)).toEqual(["一", "二 粗", "三"]);
    expect(
      [...parent.querySelectorAll<HTMLElement>(".cm-otw-toc-item")].map((n) =>
        n.style.getPropertyValue("--depth"),
      ),
    ).toEqual(["0", "1", "2"]);

    items[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe("## 二 **粗**");

    view.dispatch({ selection: { anchor: 0 } });
    expect(parent.querySelector(".cm-otw-toc")).toBeNull();
    expect(lines(parent)[0]).toBe("[TOC]");
  });

  // CodeMirror 建状态时只同步解析开头约 3000 个字符。以前块级层就拿这半棵树：
  // 目录只列出开头几节，后面的表格还是源码，要点一下才「展开」。
  it("sees the whole document on open: full [TOC] and far-away tables without a click", () => {
    const filler = Array.from({ length: 400 }, (_, i) => `第 ${i} 段，用来把文档撑长。`).join(
      "\n\n",
    );
    const source = `[TOC]\n\n# 开头\n\n${filler}\n\n## 远处的标题\n\n| a | b |\n| :-: | --: |\n| 1 | 2 |\n\n后`;
    expect(source.length).toBeGreaterThan(6000);
    const { parent, view } = mount(source, source.length);
    const items = [...parent.querySelectorAll(".cm-otw-toc-item button")].map((n) => n.textContent);
    expect(items).toEqual(["开头", "远处的标题"]);
    const widgets: unknown[] = [];
    view.state.field(typoraBlockDecorations).decorations.between(0, source.length, (_f, _t, d) => {
      widgets.push(d.spec.widget);
    });
    expect(widgets.some((widget) => widget instanceof TableWidget)).toBe(true);
  });

  it("gives csv tables a format bar and right-aligns numeric columns", () => {
    const source = "```csv\n名字,数量,备注\n苹果,3,红的\n梨,12,\n```\n\n后";
    const { parent } = mount(source, source.length);
    expect(parent.querySelector(".cm-otw-table-format")?.textContent).toBe("CSV");
    expect(parent.querySelector(".cm-otw-table-meta")?.textContent).toBe("2 行 · 3 列");
    const cells = [
      ...parent.querySelectorAll<HTMLTableRowElement>(".cm-otw-table-widget tbody tr"),
    ][0]!.cells;
    expect([...cells].map((cell) => cell.style.textAlign)).toEqual(["left", "right", "left"]);
    expect(cells[1]!.classList.contains("is-num")).toBe(true);
    expect(parent.querySelector(".cm-otw-table-bar .cm-otw-code-copy")).not.toBeNull();
  });

  it("renders inline formatting inside table cells", () => {
    const source = "| A | B |\n|---|---|\n| **粗** `x` | [[双链]] ==高== |\n\n后";
    const { parent } = mount(source, source.length);
    const table = parent.querySelector(".cm-otw-table-widget")!;
    expect(table.querySelector("td strong")?.textContent).toBe("粗");
    expect(table.querySelector("td code")?.textContent).toBe("x");
    expect(table.querySelector("td .cm-otw-wikilink")?.textContent).toBe("双链");
    expect(table.querySelector("td mark")?.textContent).toBe("高");
    expect(table.querySelector("td")?.textContent).toBe("粗 x");
  });

  it("gives the copy button the code text", () => {
    const source = "```ts\nconst a = 1;\nconst b = 2;\n```\n\n后";
    const { parent } = mount(source, source.length);
    expect(parent.querySelector(".cm-otw-code-copy")?.getAttribute("aria-label")).toBe("复制代码");
    expect(parent.querySelector(".cm-otw-code-lang")?.textContent).toBe("ts");
  });

  it("renders html blocks as sanitized DOM and shows the source when active", () => {
    const { parent, view } = mount("<div>\n<u>x</u>\n</div>\n\n后", 999);
    const widget = parent.querySelector(".cm-otw-html-widget");
    expect(widget?.querySelector("div > u")?.textContent).toBe("x");
    expect(lines(parent)).toEqual(["", "后"]);

    view.dispatch({ selection: { anchor: 8 } });
    expect(parent.querySelector(".cm-otw-html-widget")).toBeNull();
    expect(parent.querySelectorAll(".cm-line.cm-otw-html-block")).toHaveLength(3);
  });
});

describe("只动光标时的块级层", () => {
  const source = [
    "第一段，光标在这里左右走。",
    "",
    "```js",
    "const a = 1;",
    "```",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "最后一段。",
  ].join("\n");
  const at = (needle: string) => source.indexOf(needle);
  const folded = (view: EditorView) => {
    const kinds: string[] = [];
    // 只看折叠掉的范围（行装饰的起点等于终点）
    view.state.field(typoraBlockDecorations).decorations.between(0, source.length, (f, t) => {
      if (t > f) kinds.push(view.state.sliceDoc(f, t).split("\n")[0]!);
    });
    return kinds;
  };

  it("keeps the same block state while the caret stays outside every block", () => {
    const { view } = mount(source, 2);
    const before = view.state.field(typoraBlockDecorations);
    view.dispatch({ selection: { anchor: 6 } });
    view.dispatch({ selection: { anchor: at("最后") + 2 } });
    expect(view.state.field(typoraBlockDecorations)).toBe(before);
  });

  it("still unfolds a block the caret enters, and folds it again on the way out", () => {
    const { view } = mount(source, 2);
    expect(folded(view)).toEqual(["```js", "```", "| a | b |"]);
    view.dispatch({ selection: { anchor: at("const") } });
    expect(folded(view)).toEqual(["| a | b |"]);
    view.dispatch({ selection: { anchor: at("| 1") + 1 } });
    expect(folded(view)).toEqual(["```js", "```"]);
    view.dispatch({ selection: { anchor: 2 } });
    expect(folded(view)).toEqual(["```js", "```", "| a | b |"]);
  });

  it("rebuilds for a selection that only covers part of a block", () => {
    const { view } = mount(source, 2);
    view.dispatch({ selection: { anchor: 2, head: at("const") + 2 } });
    expect(folded(view)).toEqual(["| a | b |"]);
  });
});

describe("打字时的块级层", () => {
  const extensions = [markdownSupport(), typoraDecorations];
  const create = (doc: string, anchor: number) =>
    EditorState.create({ doc, selection: { anchor }, extensions });
  /** 打开指南、把光标挪到 at（和真的先点一下再打字一样；也省得每个位置都整篇解析一遍） */
  let opened: EditorState | null = null;
  const caretAt = (at: number) => {
    opened ??= create(guide, 0);
    return opened.update({ selection: { anchor: at } }).state;
  };

  /** 块级层的产物摊平，好和整篇重建的比；替身按 eq 比 */
  function flatten(state: EditorState) {
    const value = state.field(typoraBlockDecorations);
    const ranges: { from: number; to: number; kind: string; widget: WidgetType | null }[] = [];
    value.decorations.between(0, state.doc.length, (from, to, decoration) => {
      const widget = (decoration.spec.widget as WidgetType | undefined) ?? null;
      ranges.push({ from, to, kind: widget?.constructor.name ?? decoration.spec.class, widget });
    });
    return {
      ranges,
      rest: {
        foldedLines: [...value.foldedLines].sort((a, b) => a - b),
        abbreviationLines: [...value.abbreviationLines].sort((a, b) => a - b),
        referenceLabels: [...value.referenceLabels].sort(),
        abbreviations: [...value.abbreviations],
        footnotes: [...value.footnotes],
        frontMatter: value.frontMatter,
        probes: value.probes,
        toc: value.toc,
      },
    };
  }

  function expectSameAsRebuild(state: EditorState, what: string) {
    const got = flatten(state);
    const want = flatten(create(state.doc.toString(), state.selection.main.head));
    expect(got.rest, what).toEqual(want.rest);
    expect(
      got.ranges.map(({ from, to, kind }) => `${from}-${to} ${kind}`),
      what,
    ).toEqual(want.ranges.map(({ from, to, kind }) => `${from}-${to} ${kind}`));
    got.ranges.forEach((range, index) => {
      const other = want.ranges[index]!.widget;
      if (range.widget && other) expect(range.widget.eq(other), what).toBe(true);
    });
  }

  it("matches a full rebuild after edits anywhere in the syntax guide", () => {
    let checked = 0;
    for (let at = 0; at < guide.length; at += 53) {
      for (const [label, change] of [
        ["insert", { from: at, insert: "字" }],
        ["delete", { from: at, to: Math.min(guide.length, at + 1) }],
        ["newline", { from: at, insert: "\n" }],
      ] as const) {
        const state = caretAt(at).update({ changes: change, selection: { anchor: at } }).state;
        expectSameAsRebuild(
          state,
          `${label} at ${at}: ${JSON.stringify(guide.slice(at - 10, at + 10))}`,
        );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(300);
    // 整篇每隔 53 个字符改三种、每次都整篇重建一遍比对：单独跑 2–3 秒，全量并行时机器忙，
    // 会超过默认的 5 秒
  }, 20_000);

  it("matches a rebuild at every position of the list and quote sections", () => {
    for (const [start, end] of [
      ["## 列表", "## 带日期的待办"],
      ["## 引用与提示块", "## 代码"],
    ] as const) {
      const from = guide.indexOf(start);
      const to = guide.indexOf(end);
      expect(from).toBeGreaterThan(0);
      for (let at = from; at < to; at += 1) {
        // 每个位置插一个字；删字隔一个位置删一次（整个跑一遍要好几秒，这样省一半）
        const changes = [{ from: at, insert: "字" }, ...(at % 2 ? [] : [{ from: at, to: at + 1 }])];
        for (const change of changes) {
          const state = caretAt(at).update({ changes: change, selection: { anchor: at } }).state;
          expectSameAsRebuild(
            state,
            `${JSON.stringify(change)} ${JSON.stringify(guide.slice(at - 10, at + 10))}`,
          );
        }
      }
    }
  }, 30_000);

  it("keeps typing in a paragraph matching a rebuild, keystroke after keystroke", () => {
    const at = guide.indexOf("。") + 1;
    let state = create(guide, at);
    for (const ch of "边打字边看块级层") {
      const head = state.selection.main.head;
      state = state.update({
        changes: { from: head, insert: ch },
        selection: { anchor: head + 1 },
      }).state;
    }
    expectSameAsRebuild(state, "typed");
    for (let i = 0; i < 4; i++) {
      const head = state.selection.main.head;
      state = state.update({
        changes: { from: head - 1, to: head },
        selection: { anchor: head - 1 },
      }).state;
    }
    expectSameAsRebuild(state, "deleted");
  });

  it("maps the old block state instead of rebuilding when typing in a plain paragraph", () => {
    const source = "开头一段。\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n最后一段。";
    const tableOf = (state: EditorState) => {
      let table: WidgetType | null = null;
      state.field(typoraBlockDecorations).decorations.between(0, state.doc.length, (_f, _t, d) => {
        if (d.spec.widget instanceof TableWidget) table = d.spec.widget;
      });
      return table;
    };
    const start = create(source, 2);
    const typed = start.update({
      changes: { from: 2, insert: "字" },
      selection: { anchor: 3 },
    }).state;
    // 整篇重建会新建一个替身（eq 一样、对象不同）；映射过去的还是原来那一个
    expect(tableOf(typed)).toBe(tableOf(start));
    expectSameAsRebuild(typed, "typed before the table");
  });
});

describe("resolveImage", () => {
  it("parses title and Obsidian-style sizes", () => {
    expect(resolveImage("", '![图|300x200](a.png "说明")')).toEqual({
      alt: "图",
      source: "a.png",
      title: "说明",
      width: 300,
      height: 200,
    });
    expect(resolveImage("", "![图|480](a.png)")).toMatchObject({ width: 480, height: null });
    expect(resolveImage('[ref]: <b.png> "t"', "![x][ref]")).toMatchObject({
      source: "b.png",
      title: "t",
    });
  });
});
