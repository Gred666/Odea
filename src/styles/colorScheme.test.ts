import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "globals.css"), "utf8");

/** 写在行首的 `selector {` 那几块（不进 @media）里一共写了什么 */
function topLevel(selector: string): string {
  const head = new RegExp(`^${selector.replace(/[[\]"()]/g, "\\$&")} \\{\\n([^}]*)\\}`, "gm");
  return [...css.matchAll(head)].map((match) => match[1]).join("");
}

describe("原生控件的明暗", () => {
  // index.html 的 <meta name="color-scheme" content="light dark"> 只认系统：手动选了和系统相反的那一种，
  // 日期框的日历图标、下拉框的列表跟着系统画，亮色里是白的、暗色里是黑的
  it("follows the theme picked in the app, not the system's", () => {
    expect(topLevel(':root[data-theme="light"]')).toMatch(/color-scheme: light;/);
    expect(topLevel(':root[data-theme="dark"]')).toMatch(/color-scheme: dark;/);
  });
});
