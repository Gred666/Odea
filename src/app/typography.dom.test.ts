// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BODY_SIZES,
  DEFAULT_BODY_SIZE,
  DEFAULT_MEASURE,
  MEASURES,
  applyTypography,
  isBodySize,
  isMeasure,
  stepBodySize,
} from "./typography";

const css = readFileSync(join(__dirname, "../styles/globals.css"), "utf8");
const root = () => document.documentElement.style;

afterEach(() => {
  document.documentElement.removeAttribute("style");
});

describe("正文字号、行宽", () => {
  it("steps through the sizes and stops at either end", () => {
    expect(stepBodySize(17, 1)).toBe(18);
    expect(stepBodySize(17, -1)).toBe(16);
    expect(stepBodySize(BODY_SIZES[BODY_SIZES.length - 1]!, 1)).toBeNull();
    expect(stepBodySize(BODY_SIZES[0]!, -1)).toBeNull();
    // 存着的不是档位里的（手改过 localStorage）：从默认那一档起
    expect(stepBodySize(23, 1)).toBe(DEFAULT_BODY_SIZE + 1);
  });

  it("only accepts values it knows when reading saved prefs", () => {
    expect(isBodySize(18)).toBe(true);
    expect(isBodySize(17.5)).toBe(false);
    expect(isBodySize("18")).toBe(false);
    expect(isMeasure("wide")).toBe(true);
    expect(isMeasure("huge")).toBe(false);
  });

  it("writes both onto <html> as CSS variables", () => {
    applyTypography(19, "narrow");
    expect(root().getPropertyValue("--odea-body-size")).toBe("19px");
    expect(root().getPropertyValue("--odea-measure")).toBe("36");
    // 铺满：一个大到碰不到的字数
    applyTypography(17, "full");
    expect(Number(root().getPropertyValue("--odea-measure"))).toBeGreaterThan(1000);
  });

  it("keeps the defaults in globals.css the same as here, and the column as wide as before", () => {
    // 不一致的话启动时（偏好还没写上去的那一刻）和写上去之后不一样宽，会跳一下
    expect(css).toMatch(new RegExp(`--odea-body-size: ${DEFAULT_BODY_SIZE}px;`));
    const standard = MEASURES.find((measure) => measure.id === DEFAULT_MEASURE);
    expect(css).toMatch(new RegExp(`--odea-measure: ${standard?.chars};`));
    // 以前正文那一列写死 max-w-[860px]：标准 44 字 × 17px + 两边内边距 112px
    expect(css).toContain("max-width: calc(var(--odea-measure) * var(--odea-body-size) + 112px);");
    expect((standard?.chars ?? 0) * DEFAULT_BODY_SIZE + 112).toBe(860);
  });

  it("does not leave a fixed body size behind in the editor styles", () => {
    // 编辑器、只读占位、表格都跟着 --odea-body-size；在 .cm-editor 上再定义一次，偏好就不起作用了
    expect(css.match(/--odea-body-size:\s*\d+px/g)).toHaveLength(1);
    expect(css).not.toMatch(/\.prose-doc \{[^}]*font-size: 17px/);
  });
});
