import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 会淡入淡出的小控件（CLAUDE.md「动效：先对齐再动」）：只淡 opacity，不位移、不缩放、
 * 不用毛玻璃；一直待在自己的图层上（will-change: opacity）。2026-10-17 图片的悬停按钮
 * 上移 3px + 毛玻璃淡入，用户报「出来的时候闪一下」；去掉位移、只留淡入，结束那一帧照样
 * 闪（层里和页面里抗锯齿不同）—— 加上 will-change 才没有了。
 */
const CSS = readFileSync(path.join(process.cwd(), "src/styles/globals.css"), "utf8");

const FADING_CONTROLS = [
  "cm-otw-image-tools",
  "cm-otw-image-handle",
  "cm-otw-image-size",
  "otw-image-viewer-bar",
  "otw-image-viewer-close",
];

/** 选择器里提到这个类的所有规则的声明（不含伪元素 ::after 这类里面画图标的） */
function declarationsFor(className: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = re.exec(CSS); match; match = re.exec(CSS)) {
    const selector = match[1]!.replace(/\/\*[\s\S]*?\*\//g, "");
    if (!new RegExp(`\\.${className}(?![\\w-])(?!::)`).test(selector)) continue;
    out.push(
      ...match[2]!
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(";")
        .map((d) => d.trim().replace(/\s+/g, " "))
        .filter(Boolean),
    );
  }
  return out;
}

describe("会淡入淡出的小控件", () => {
  for (const className of FADING_CONTROLS) {
    it(`.${className} only fades, from its own layer`, () => {
      const declarations = declarationsFor(className);
      expect(declarations.length).toBeGreaterThan(0);
      const moving = declarations.filter((d) =>
        /^(transform|translate|scale|rotate|backdrop-filter|-webkit-backdrop-filter|filter)\s*:/.test(
          d,
        ),
      );
      expect(moving).toEqual([]);
      const transitions = declarations.filter((d) => /^transition\s*:/.test(d));
      for (const transition of transitions) {
        expect(transition).not.toMatch(/transform|translate|scale|box-shadow|filter/);
      }
      expect(declarations).toContain("will-change: opacity");
    });
  }
});
