// @vitest-environment happy-dom

import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { CALLOUT_HEAD_RE, calloutKind, parseCalloutHead } from "./callout";
import { emojiFor } from "./emoji";
import { decodeEntity } from "./entities";
import { frontMatterRange } from "./frontMatter";
import { inlinePlainText, renderInline } from "./inlineDom";
import { isOpenableUrl, normalizeLabel } from "./links";

describe("emoji", () => {
  it("maps shortcodes case-insensitively and rejects unknown ones", () => {
    expect(emojiFor(":smile:")).toBe("😄");
    expect(emojiFor(":+1:")).toBe("👍");
    expect(emojiFor("ROCKET")).toBe("🚀");
    expect(emojiFor(":definitely_not_an_emoji:")).toBeNull();
  });
});

describe("entities", () => {
  it("decodes named, decimal and hex entities", () => {
    expect(decodeEntity("&amp;")).toBe("&");
    expect(decodeEntity("&mdash;")).toBe("—");
    expect(decodeEntity("&#8212;")).toBe("—");
    expect(decodeEntity("&#x1F600;")).toBe("😀");
  });

  it("keeps unknown and unprintable entities as source", () => {
    expect(decodeEntity("&nosuch;")).toBeNull();
    expect(decodeEntity("&#0;")).toBeNull();
    expect(decodeEntity("&#xD800;")).toBeNull();
    expect(decodeEntity("amp")).toBeNull();
  });
});

describe("callout", () => {
  it("recognises the head line and classifies labels", () => {
    expect(CALLOUT_HEAD_RE.exec("> [!NOTE]")?.[2]).toBe("NOTE");
    expect(CALLOUT_HEAD_RE.exec(">  [!核心判断]  ")?.[2]).toBe("核心判断");
    expect(CALLOUT_HEAD_RE.test("> [!NOTE]x")).toBe(false);
    expect(calloutKind("tip")).toBe("tip");
    expect(calloutKind("注意")).toBe("warning");
    expect(calloutKind("Caution")).toBe("caution");
    expect(calloutKind("核心判断")).toBe("generic");
  });

  it("parses Obsidian fold signs and custom titles", () => {
    expect(parseCalloutHead("> [!tip]- 折叠的标题")).toMatchObject({
      label: "tip",
      kind: "tip",
      fold: "-",
      title: "折叠的标题",
      labelOffset: 2,
      foldOffset: 8,
    });
    expect(parseCalloutHead("> [!NOTE]+")).toMatchObject({ fold: "+", title: "" });
    expect(parseCalloutHead("> [!NOTE] 只有标题")).toMatchObject({ fold: "", title: "只有标题" });
  });
});

describe("frontMatterRange", () => {
  const range = (source: string) => frontMatterRange(Text.of(source.split("\n")));

  it("needs an opening fence on line one, a key line and a closing fence", () => {
    expect(range("---\ntitle: x\n---\n正文")).toEqual({
      from: 0,
      to: 16,
      openLine: 1,
      closeLine: 3,
    });
    expect(range("正文\n---\ntitle: x\n---")).toBeNull();
    expect(range("---\n\n---\n正文")).toBeNull();
    expect(range("---\ntitle: x\n正文")).toBeNull();
    expect(range("---\n\n正文")).toBeNull();
  });
});

describe("renderInline", () => {
  const html = (source: string) => {
    const host = document.createElement("div");
    host.append(...renderInline(source));
    return host.innerHTML;
  };

  it("builds real elements for the inline syntaxes", () => {
    expect(html("**粗** *斜* ~~删~~ ==高== <u>下</u>")).toBe(
      '<strong class="cm-odea-strong">粗</strong> <em class="cm-odea-emphasis">斜</em> ' +
        '<del class="cm-odea-strike">删</del> <mark class="cm-odea-highlight">高</mark> ' +
        '<u class="cm-odea-underline">下</u>',
    );
    expect(html("`a**b**` 与 **`c`**")).toBe(
      '<code class="cm-odea-code">a**b**</code> 与 <strong class="cm-odea-strong"><code class="cm-odea-code">c</code></strong>',
    );
  });

  it("renders links, wikilinks, escapes, entities and emoji", () => {
    expect(html("[官网](https://x.dev)")).toBe(
      '<span class="cm-odea-link" data-href="https://x.dev" title="https://x.dev">官网</span>',
    );
    expect(html("[[目标|别名]]")).toBe(
      '<span class="cm-odea-wikilink" data-target="目标">别名</span>',
    );
    expect(html("\\*不斜\\* &amp; :smile:")).toBe("*不斜* &amp; 😄");
  });

  it("never interprets markup as HTML", () => {
    expect(html("<img src=x onerror=alert(1)>")).toBe("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("strips markup for plain text", () => {
    expect(inlinePlainText("**二** `x` [[a|b]]")).toBe("二 x b");
  });
});

describe("links helpers", () => {
  it("normalises labels like CommonMark", () => {
    expect(normalizeLabel("[ Foo   Bar ]")).toBe("foo bar");
  });

  it("only opens web-ish schemes", () => {
    expect(isOpenableUrl("https://a.b")).toBe(true);
    expect(isOpenableUrl("mailto:me@a.b")).toBe(true);
    expect(isOpenableUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableUrl("file:///C:/x")).toBe(false);
    expect(isOpenableUrl("note.md")).toBe(false);
  });
});
