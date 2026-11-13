// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { type StaticOptions, renderStaticHtml, stripFrontMatter } from "./staticHtml";

const plain: StaticOptions = {
  image: (source) => `img:${source}`,
  wikiImage: (name) => (name === "图.png" ? "img:附件/图.png" : null),
  math: false,
  diagrams: false,
  highlight: false,
};

const render = (markdown: string, options: Partial<StaticOptions> = {}) =>
  renderStaticHtml(markdown, { ...plain, ...options });

describe("静态渲染：行内", () => {
  it("renders emphasis, code, highlights across nested marks and keeps line breaks", async () => {
    const html = await render("**粗** *斜* ~删~ `a<b` ==高亮里 **粗**==\n第二行");
    expect(html).toBe(
      "<p><strong>粗</strong> <em>斜</em> <del>删</del> <code>a&lt;b</code> <mark>高亮里 <strong>粗</strong></mark><br>\n第二行</p>",
    );
    expect(await render("a == b == c")).toBe("<p>a == b == c</p>");
    expect(await render("`==不是高亮==`")).toBe("<p><code>==不是高亮==</code></p>");
  });

  it("turns wikilinks, footnotes, abbreviations and smart punctuation into HTML", async () => {
    const html = await render(
      [
        "见 [[周报#结论|这里]]，HTML 和 amp 都行[^1]；再引一次[^1]... (c)",
        "",
        "[^1]: 脚注 **粗**",
        "*[HTML]: HyperText Markup Language",
        "*[amp]: 不该碰到实体",
        "",
        "a & b",
      ].join("\n"),
    );
    expect(html).toContain('<span class="wikilink" title="周报 › 结论">这里</span>');
    expect(html).toContain('<abbr title="HyperText Markup Language">HTML</abbr>');
    expect(html).toContain('<sup class="footnote-ref"><a href="#fn-1" id="fn-1-ref">1</a></sup>');
    expect(html).toContain('再引一次<sup class="footnote-ref"><a href="#fn-1">1</a></sup>');
    expect(html).toContain("…");
    expect(html).toContain("©");
    expect(html).toContain("<p>a &amp; b</p>");
    expect(html).toContain(
      '<section class="footnotes"><ol><li id="fn-1">脚注 <strong>粗</strong> <a class="footnote-back" href="#fn-1-ref"',
    );
    // 定义行本身不出现
    expect(html).not.toContain("*[HTML]");
    expect(html).not.toContain("[^1]:");
  });

  it("never lets user text or unsafe links through", async () => {
    const html = await render(
      [
        "<script>alert(1)</script>",
        "",
        '[点](javascript:alert(1)) <span style="position:fixed;color:#c00">红</span> <b>粗 <u>未闭合',
        "",
        '<img src="x.png" onerror="alert(1)">',
        "",
        '<div onclick="alert(1)">块<script>alert(2)</script></div>',
      ].join("\n"),
    );
    expect(html).not.toMatch(/<script|onerror|onclick|javascript:/i);
    expect(html).toContain('<span class="link">点</span>');
    expect(html).toContain('<span style="color: #c00">红</span>');
    expect(html).toContain("&lt;b&gt;粗 &lt;u&gt;未闭合");
  });

  it("resolves images, Obsidian image embeds and sizes", async () => {
    const html = await render(
      '![图|300x200](../附件/a.png "说明")\n\n![[图.png|240]]\n\n![[没有.png]]',
    );
    expect(html).toContain(
      '<img src="img:../附件/a.png" alt="图" title="说明" width="300" height="200">',
    );
    expect(html).toContain('<img src="img:附件/图.png" alt="图.png" width="240">');
    expect(html).toContain('<span class="image-missing">仓库里找不到「没有.png」</span>');
  });
});

describe("静态渲染：块", () => {
  it("gives headings stable ids and builds the table of contents", async () => {
    const html = await render("[TOC]\n\n# 标题 一\n\n## 小节\n\n## 小节\n\nSetext\n======");
    expect(html).toContain('<h1 id="标题-一">标题 一</h1>');
    expect(html).toContain('<h2 id="小节">小节</h2>');
    expect(html).toContain('<h2 id="小节-1">小节</h2>');
    expect(html).toContain('<h1 id="setext">Setext</h1>');
    expect(html).toContain('<li style="--depth: 1"><a href="#小节-1">小节</a></li>');
  });

  it("drops the front matter", async () => {
    expect(stripFrontMatter("---\ntitle: x\n---\n正文")).toBe("正文");
    expect(stripFrontMatter("---\n不是属性\n---\n正文")).toBe("---\n不是属性\n---\n正文");
    expect(await render("---\ntitle: x\ntags: [a]\n---\n\n正文")).toBe("<p>正文</p>");
  });

  it("renders tight and loose lists, ordered starts and tasks", async () => {
    expect(await render("- a\n- b\n  - c")).toBe(
      "<ul><li>a</li><li>b\n<ul><li>c</li></ul></li></ul>",
    );
    expect(await render("- a\n\n- b")).toBe("<ul><li><p>a</p></li><li><p>b</p></li></ul>");
    expect(await render("3. 三\n3. 四")).toBe('<ol start="3"><li>三</li><li>四</li></ol>');
    expect(await render("- [x] 做完 *了*\n- [ ] 没做")).toBe(
      '<ul class="tasks"><li class="task is-done"><input type="checkbox" disabled checked><div class="task-body">做完 <em>了</em></div></li><li class="task"><input type="checkbox" disabled><div class="task-body">没做</div></li></ul>',
    );
  });

  it("renders callouts the way the editor does, folded ones as details", async () => {
    const html = await render("> [!TIP] 小 **贴士**\n> 正文\n> - 一项");
    expect(html).toMatch(
      /^<div class="callout is-tip"><div class="callout-head"><span class="callout-badge"><svg/,
    );
    expect(html).toContain('<span class="callout-title">小 <strong>贴士</strong></span>');
    expect(html).toContain('<div class="callout-body"><p>正文</p>\n<ul><li>一项</li></ul></div>');
    const folded = await render("> [!WARNING]- 收起的\n> 里面");
    expect(folded).toMatch(/^<details class="callout is-warning"><summary class="callout-head">/);
    expect(await render("> [!WARNING]- 收起的\n> 里面", { expandFolds: true })).toMatch(
      /^<div class="callout is-warning">/,
    );
    // 引用里套的 callout：正文去掉两层 `>`
    const nested = await render("> 外面\n>\n> > [!NOTE]\n> > 里面");
    expect(nested).toContain('<div class="callout-body"><p>里面</p></div>');
    expect(await render("> 普通\n> 引用")).toBe("<blockquote><p>普通<br>\n引用</p></blockquote>");
  });

  it("keeps code inside quotes and lists free of the container prefixes", async () => {
    expect(await render("> ```js\n> a < b\n>   c\n> ```")).toBe(
      '<blockquote><pre class="code" data-lang="js"><code>a &lt; b\n  c</code></pre></blockquote>',
    );
    expect(await render("- ```\n  x\n  ```")).toBe(
      '<ul><li><pre class="code"><code>x</code></pre></li></ul>',
    );
  });

  it("renders tables with alignment, numbers and merged cells", async () => {
    const html = await render(
      [
        "| 阶段 | 金额 | 负责人 |",
        "|:-----|---|:-:|",
        "| 第一期 | ¥1,000 | 张三 |",
        "| ^ | 20% | ^ |",
        "| 备注 | `a | b` | < |",
      ].join("\n"),
    );
    expect(html).toContain('<th style="text-align: left">阶段</th>');
    expect(html).toContain('<td rowspan="2" style="text-align: left">第一期</td>');
    expect(html).toContain('<td rowspan="2" style="text-align: center">张三</td>');
    expect(html).toContain("<td>20%</td>");
    expect(html).toContain('<td colspan="2"><code>a | b</code></td>');
    // 没写对齐、非空的格子全是数：右对齐、等宽数字
    expect(await render("| 项 | 钱 |\n|-|-|\n| a | ¥1,000 |\n| b | 20% |")).toContain(
      '<td style="text-align: right" class="num">¥1,000</td>',
    );
    // 格子里的 `# ` 只是字
    expect(await render("| a |\n|---|\n| # 不是标题 |")).toContain("<td># 不是标题</td>");
  });

  it("turns definition lists, csv fences and html blocks into HTML", async () => {
    expect(await render("术语\n: 释义一\n: 释义二")).toBe(
      "<dl><dt>术语</dt><dd>释义一</dd><dd>释义二</dd></dl>",
    );
    expect(await render("术语\n\n: 隔一行也算")).toBe("<dl><dt>术语</dt><dd>隔一行也算</dd></dl>");
    expect(await render("```csv\n名字,数量\n苹果,3\n```")).toContain(
      '<td>苹果</td><td style="text-align: right" class="num">3</td>',
    );
    const html = await render(
      '<details open>\n<summary>点开</summary>\n<img src="b.png" width="80">\n</details>',
    );
    expect(html).toContain('<div class="html-block"><details open="">');
    expect(html).toContain('src="img:b.png"');
  });

  it("embeds a note through the callback, and falls back to a wikilink", async () => {
    const embed = async (target: { title: string; heading?: string }) =>
      target.title === "周报" ? `<p>周报的正文 ${target.heading ?? ""}</p>` : null;
    const html = await render("![[周报#结论]]\n\n![[没有的]]", { embed });
    expect(html).toContain(
      '<div class="embed"><div class="embed-head">周报<span class="embed-section"> › 结论</span></div><div class="embed-body"><p>周报的正文 结论</p></div></div>',
    );
    expect(html).toContain('<p><span class="wikilink" title="没有的">没有的</span></p>');
  });

  it("links wikilinks when told where, and names attachments it cannot open", async () => {
    const wikiHref = (title: string, heading: string | undefined) =>
      title === "周报" ? `周报.html${heading ? `#${heading}` : ""}` : null;
    const html = await render(
      "[[周报#结论|这里]] [[没有的]]\n\n![[说明书.pdf]] ![[报表.xlsx|三季度]]",
      {
        wikiHref,
      },
    );
    expect(html).toContain(
      '<a class="wikilink" href="周报.html#结论" title="周报 › 结论">这里</a> <span class="wikilink" title="没有的">没有的</span>',
    );
    expect(html).toContain(
      '<span class="attachment" title="说明书.pdf">说明书.pdf<span class="attachment-kind">PDF 文档</span></span>',
    );
    expect(html).toContain('三季度<span class="attachment-kind">Excel 表格</span>');
  });

  it("shows TeX source when math is off and renders it with KaTeX when on", async () => {
    expect(await render("$E=mc^2$")).toBe(
      '<p><span class="math-inline is-source">$E=mc^2$</span></p>',
    );
    const html = await render("$$\nx^2\n$$", { math: true });
    expect(html).toMatch(/^<div class="math-display"><span class="katex-display">/);
  });
});
