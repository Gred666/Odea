import { commonmarkLanguage } from "@codemirror/lang-markdown";
import type { MarkdownParser } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { markdownExtensions } from "./markdownParser";

const parser = (commonmarkLanguage.parser as MarkdownParser).configure(markdownExtensions);

/** 把语法树压成 `Name(from,to)` 的扁平列表，只保留感兴趣的节点。 */
function nodes(source: string, names: RegExp): string[] {
  const out: string[] = [];
  parser.parse(source).iterate({
    enter(node) {
      if (names.test(node.type.name)) {
        out.push(`${node.type.name}:${source.slice(node.from, node.to)}`);
      }
    },
  });
  return out;
}

describe("数学公式", () => {
  it("parses $x$ and $$x$$ inline, keeping emphasis out of the formula", () => {
    expect(nodes("和 $a*b$ 与 $c*d$ 完", /Math|Emphasis/)).toEqual([
      "InlineMath:$a*b$",
      "MathMark:$",
      "MathMark:$",
      "InlineMath:$c*d$",
      "MathMark:$",
      "MathMark:$",
    ]);
    expect(nodes("看 $$E=mc^2$$ 看", /InlineMath/)).toEqual(["InlineMath:$$E=mc^2$$"]);
  });

  it("does not treat prices as math", () => {
    expect(nodes("花了 $5 和 $10", /Math/)).toEqual([]);
    expect(nodes("空格 $ x$ 不算，$x $ 也不算", /Math/)).toEqual([]);
    expect(nodes("转义 \\$x\\$ 不算", /Math/)).toEqual([]);
  });

  it("parses $$ blocks across lines and lets them interrupt paragraphs", () => {
    const source = "上文\n$$\n\\sum_i x_i\n$$\n下文";
    expect(nodes(source, /MathBlock|Paragraph/)).toEqual([
      "Paragraph:上文",
      "MathBlock:$$\n\\sum_i x_i\n$$",
      "Paragraph:下文",
    ]);
    expect(nodes("$$ a+b $$", /MathBlock/)).toEqual(["MathBlock:$$ a+b $$"]);
  });

  it("runs an unterminated block to the end of the document", () => {
    expect(nodes("$$\nx\ny", /MathBlock/)).toEqual(["MathBlock:$$\nx\ny"]);
  });
});

describe("删除线", () => {
  it("accepts one or two tildes but never mixes them", () => {
    expect(nodes("~a~ ~~b~~", /Strikethrough$/)).toEqual([
      "Strikethrough:~a~",
      "Strikethrough:~~b~~",
    ]);
    expect(nodes("~a~~", /Strikethrough$/)).toEqual([]);
  });

  it("leaves paths and lone tildes alone", () => {
    expect(nodes("看 ~/a 和 ~/b", /Strikethrough/)).toEqual([]);
    expect(nodes("约 ~ 3 个", /Strikethrough/)).toEqual([]);
  });

  it("no longer produces subscript nodes", () => {
    expect(nodes("H~2~O", /Subscript|Strikethrough$/)).toEqual(["Strikethrough:~2~"]);
    expect(nodes("x^2^", /Superscript$/)).toEqual(["Superscript:^2^"]);
  });
});

describe("上标", () => {
  it("parses ^x^ with escapes, but not across spaces", () => {
    expect(nodes("x^2^ 和 e^i\\^π^", /Superscript$/)).toEqual([
      "Superscript:^2^",
      "Superscript:^i\\^π^",
    ]);
    expect(nodes("a ^b c^ d", /Superscript$/)).toEqual([]);
  });

  it("keeps footnote references in Chinese prose out of superscript", () => {
    // 两个脚注之间没有空格：以前 `^1]，接着写[^` 会被整段认成上标
    const source = "正文[^1]，接着写[^long]。\n\n[^1]: 甲\n[^long]: 乙";
    expect(nodes(source, /Superscript$/)).toEqual([]);
    expect(nodes(source, /^Link$/)).toEqual(["Link:[^1]", "Link:[^long]"]);
  });

  it("does not reach across brackets", () => {
    expect(nodes("[[标题^abc]]之后x^2^", /Superscript$/)).toEqual(["Superscript:^2^"]);
    expect(nodes("看[x^2^]", /Superscript$/)).toEqual(["Superscript:^2^"]);
  });
});

describe("Setext 标题", () => {
  const blocks = (source: string) =>
    nodes(source, /^(Paragraph|SetextHeading\d|HorizontalRule|BulletList)$/);

  it("still reads a one-line title over === or ---", () => {
    expect(blocks("一级标题\n===\n\n二级标题\n----------")).toEqual([
      "SetextHeading1:一级标题\n===",
      "SetextHeading2:二级标题\n----------",
    ]);
    // 引用、列表里也一样
    expect(nodes("> 标题\n> ---", /SetextHeading/)).toEqual(["SetextHeading2:标题\n> ---"]);
  });

  it("does not turn the line above into a heading while - or == is being typed", () => {
    for (const typed of ["-", "- ", "--", "=", "==", "== "]) {
      expect(blocks(`闭源\n宣传视频\n${typed}`)).toEqual([`Paragraph:闭源\n宣传视频\n${typed}`]);
      expect(blocks(`宣传视频\n${typed}`)).toEqual([`Paragraph:宣传视频\n${typed}`]);
    }
    // `- -` 是嵌套的列表，`- - -` 是分隔线：都只管这一行，上面那段还是段落
    expect(blocks("宣传视频\n- -")).toEqual([
      "Paragraph:宣传视频",
      "BulletList:- -",
      "BulletList:-",
    ]);
    expect(blocks("宣传视频\n- - -")).toEqual(["Paragraph:宣传视频", "HorizontalRule:- - -"]);
  });

  it("ends a paragraph of several lines at --- instead of making it all a heading", () => {
    expect(blocks("闭源\n重新取名 Odea\n宣传视频\n/\n---\n多人编辑")).toEqual([
      "Paragraph:闭源\n重新取名 Odea\n宣传视频\n/",
      "HorizontalRule:---",
      "Paragraph:多人编辑",
    ]);
    expect(blocks("两行\n的段落\n===")).toEqual(["Paragraph:两行\n的段落\n==="]);
  });
});
