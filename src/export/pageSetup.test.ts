import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SETUP,
  fitTitle,
  marginContent,
  marginPreview,
  normalizePageSetup,
  pageCss,
  paperSize,
} from "./pageSetup";

describe("PDF 的页面设置", () => {
  it("turns the header and footer lines into margin-box content", () => {
    expect(marginContent("{页码} / {总页数}", "周报", "2026-11-12")).toBe(
      'counter(page) " / " counter(pages)',
    );
    expect(marginContent("第 {页码} 页 · {标题} · {日期}", "周报", "2026-11-12")).toBe(
      '"第 " counter(page) " 页 · " "周报" " · " "2026-11-12"',
    );
    expect(marginContent("   ", "周报", "2026-11-12")).toBeNull();
    // 标题里的引号、反斜杠转义，写不出 CSS 去
    expect(marginContent("{标题}", 'a"b\\c', "")).toBe('"a\\"b\\\\c"');
    // 这一段是写在 <style> 里的：标题里的 </style> 会把样式表提前收尾，后面的字就成了页面上的标签
    const sneaky = marginContent("{标题}", "</style><script>alert(1)</script>", "");
    expect(sneaky).not.toContain("<");
    expect(sneaky).toBe('"\\3c /style>\\3c script>alert(1)\\3c /script>"');
  });

  it("writes the paper, the margins and only the chosen margin boxes", () => {
    const css = pageCss(
      {
        ...DEFAULT_PAGE_SETUP,
        paper: "A5",
        landscape: true,
        header: "{标题}",
        headerAlign: "right",
      },
      "周报",
    );
    expect(css).toContain("size: 210mm 148mm;");
    expect(css).toContain("margin: 20mm 18mm 22mm 18mm;");
    expect(css).toContain("@top-right {");
    expect(css).toContain('content: "周报";');
    expect(css).toContain("@bottom-center {");
    expect(css).not.toContain("@top-left");
    const bare = pageCss({ ...DEFAULT_PAGE_SETUP, footer: "" }, "周报");
    expect(bare).not.toContain("@bottom");
  });

  // 标题长了页边框盒子折成几行、再长压到正文（审查 2026-11-13 §5.2）：截成一行、末尾「…」
  it("cuts a long {标题} to one line of the margin box", () => {
    const a4 = { ...DEFAULT_PAGE_SETUP, header: "{标题}" };
    expect(fitTitle("{标题}", "周报", a4, "2026-11-17")).toBe("周报");
    const long = "一".repeat(100);
    const cut = fitTitle("{标题}", long, a4, "2026-11-17");
    expect(cut.endsWith("…")).toBe(true);
    // A4 竖放、标准页边距：174 mm ÷ 9pt（3.175 mm）≈ 54.8 个汉字的宽，「…」占一个
    expect([...cut].length).toBe(54);
    expect(pageCss(a4, long)).toContain(`content: "${cut}";`);
    // 一行里还有别的字：标题让出它们的位子；横着放的纸能放更多
    const withDate = fitTitle("{标题} · {日期}", long, a4, "2026-11-17");
    expect([...withDate].length).toBeLessThan([...cut].length);
    const landscape = fitTitle("{标题}", long, { ...a4, landscape: true }, "2026-11-17");
    expect([...landscape].length).toBeGreaterThan([...cut].length);
    // 西文按窄一点算：放得下的字数多
    expect([...fitTitle("{标题}", "a".repeat(200), a4, "")].length).toBeGreaterThan(54);
    // 没写 {标题} 的不动
    expect(fitTitle("{页码}", long, a4, "")).toBe(long);
  });

  it("reads back what it saved, and falls back on anything it does not know", () => {
    expect(normalizePageSetup(null)).toEqual(DEFAULT_PAGE_SETUP);
    expect(
      normalizePageSetup({
        paper: "A6",
        landscape: "yes",
        margin: "wide",
        header: "多\n行",
        headerAlign: "middle",
        footer: 3,
      }),
    ).toEqual({
      ...DEFAULT_PAGE_SETUP,
      margin: "wide",
      header: "多 行",
    });
    expect(paperSize({ ...DEFAULT_PAGE_SETUP, paper: "Letter" })).toEqual([215.9, 279.4]);
  });

  it("shows sample numbers in the preview", () => {
    expect(marginPreview("{标题} {页码}/{总页数}", "周报", "2026-11-12")).toBe("周报 1/3");
  });
});
