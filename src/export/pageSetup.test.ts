import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SETUP,
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
