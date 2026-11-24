import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { TIP, placeBeside, snap, tip } from "./tooltip";

/*
 * 悬停提示（docs/悬停提示.md）：界面上不再用系统原生的 title。
 *
 * 2026-11-20 换的时候 src 里有 137 处 title=，原生提示要停一秒多才出、压在鼠标底下、暗色里是亮的、
 * 一排按钮之间每一个都要重新等。换成 lib/tooltip.ts 以后，新写的再出现 title 属性就挂。
 */

const SRC = join(__dirname, "..");
/**
 * 不查的目录。例外只在这里加，写清楚为什么
 */
const EXEMPT_DIRS: string[] = [];

/**
 * 用代码写 title、但不是给元素出提示的，逐条写理由（「文件 代码」）。
 * 窗口标题（document.title、doc.title、win.document.title）按规则放过，不用写在这里
 */
const ALLOWED = new Set([
  // 假后端（浏览器预览）里的笔记记录，不是 DOM
  "data/mock.ts current.title = clean",
  // iframe 的 title 是它的无障碍名字（读屏念「插件沙箱：某插件」），鼠标在里面时浏览器也不出它的提示
  "plugins/sandbox/host.ts frame.title = `插件沙箱：${plugin}`",
]);

function sources(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".d.ts") && !file.includes(".test."))
    .filter((file) => !EXEMPT_DIRS.some((dir) => file.startsWith(dir)));
}

/** 往外跳过括号、条件表达式：`url ? { title } : undefined` 里的对象算作直接传进去的 */
function outer(node: ts.Node): ts.Node {
  let at = node;
  while (ts.isParenthesizedExpression(at.parent) || ts.isConditionalExpression(at.parent)) {
    at = at.parent;
  }
  return at;
}

/**
 * 落到 DOM 上的 title 属性：
 * - JSX：小写开头的标签（button、span、motion.button）、带命名空间的组件（DropdownMenu.Item 这类
 *   Radix 原件，属性原样落到元素上）。自己的组件叫 title 的 prop 是标题（<Empty title="…" />），不算；
 *   SVG 的 <title> 是元素不是属性，不会被扫到
 * - 用代码建的 DOM（编辑器的替身、浮在正文上的按钮）：`node.title = …`、`setAttribute("title", …)`；
 *   编辑器装饰的属性表 `Decoration.mark({ attributes: { title } })`、`addMark(…, { title })`、`attributes.title = …`。
 *   窗口标题（document.title）不算
 */
function nativeTitles(file: string, text = readFileSync(join(SRC, file), "utf8")): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const hits: string[] = [];
  const hit = (node: ts.Node, what: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    hits.push(`${file}:${line + 1} ${what}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === "title") {
      const element = node.parent.parent as ts.JsxOpeningLikeElement;
      const tag = element.tagName.getText(source);
      if (/^[a-z]/.test(tag) || tag.includes(".")) hit(node, `<${tag} title=…>`);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "title"
    ) {
      const owner = node.left.expression.getText(source);
      const code = node.getText(source);
      const windowTitle = /(^|\.)(document|doc)$/.test(owner);
      if (!windowTitle && !ALLOWED.has(`${file} ${code}`)) hit(node, code);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "setAttribute" &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === "title"
    ) {
      hit(node, node.getText(source));
    } else if (ts.isObjectLiteralExpression(node)) {
      const title = node.properties.find(
        (property) =>
          (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          property.name.getText(source) === "title",
      );
      const at = outer(node);
      const parent = at.parent;
      const isAttributes =
        (ts.isPropertyAssignment(parent) &&
          /^(attributes|attrs)$/.test(parent.name.getText(source))) ||
        (ts.isCallExpression(parent) &&
          parent.arguments.includes(at as ts.Expression) &&
          /(^|\.)(addMark|mark|line)$/.test(parent.expression.getText(source)));
      if (title && isAttributes) hit(title, `{ ${title.getText(source)} }`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe("不用系统原生的 title 提示", () => {
  const files = sources();

  it("finds the component sources", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("has no title attribute on DOM elements (use tip() / data-tip-overflow)", () => {
    expect(files.flatMap((file) => nativeTitles(file))).toEqual([]);
  });

  it("catches the shapes it is meant to catch", () => {
    const probe = (code: string) => nativeTitles("probe.tsx", code).length;
    expect(probe(`<button title="x" />`)).toBe(1);
    expect(probe("<motion.span title={a}>x</motion.span>")).toBe(1);
    expect(probe(`<DropdownMenu.Item title="x" />`)).toBe(1);
    expect(probe(`<Empty title="没有内容" />`)).toBe(0);
    expect(probe("<svg><title>图</title></svg>")).toBe(0);
  });

  it("catches titles written from code (editor widgets, decorations)", () => {
    const probe = (code: string) => nativeTitles("probe.ts", code).length;
    expect(probe(`node.title = "点击编辑公式";`)).toBe(1);
    expect(probe("this.toggle.title = label;")).toBe(1);
    expect(probe(`button.setAttribute("title", label);`)).toBe(1);
    expect(probe("attributes.title = href;")).toBe(1);
    expect(probe("Decoration.mark({ class: 'a', attributes: { title: href } });")).toBe(1);
    expect(probe(`addMark(a, b, "cm-odea-link", url ? { title: url } : undefined);`)).toBe(1);
    expect(probe("addMark(a, b, 'x', { title });")).toBe(1);
    // 窗口标题、数据对象不算
    expect(probe(`document.title = "Odea";`)).toBe(0);
    expect(probe(`doc.title = "Odea";`)).toBe(0);
    expect(probe("handle.win.document.title = title;")).toBe(0);
    expect(probe(`const note = { id: "a", title: "周报" };`)).toBe(0);
    expect(probe("expect(found).toEqual({ title: '项目复盘' });")).toBe(0);
    expect(probe("api.noteGet.mockResolvedValue({ ...note('b'), title: 'B' });")).toBe(0);
  });
});

describe("tip()", () => {
  it("gives the accessible name and the tip in one go", () => {
    expect(tip("导出")).toEqual({ "aria-label": "导出", "data-tip": "导出" });
  });

  it("leaves the name alone on elements that already show text", () => {
    expect(tip("新建一篇笔记", { kbd: "Ctrl N", side: "top", name: false })).toEqual({
      "data-tip": "新建一篇笔记",
      "data-tip-kbd": "Ctrl N",
      "data-tip-side": "top",
    });
  });

  it("drops empty parts instead of writing empty attributes", () => {
    expect(tip("删除", { detail: "", kbd: undefined })).toEqual({
      "aria-label": "删除",
      "data-tip": "删除",
    });
  });
});

describe("placeBeside", () => {
  const view = { width: 800, height: 600, dpr: 1 };
  const box = (left: number, top: number, width: number, height: number) => ({
    left,
    top,
    right: left + width,
    bottom: top + height,
  });

  it("centres the tip 6px under the target by default", () => {
    expect(placeBeside(box(100, 100, 28, 28), { width: 60, height: 24 }, "bottom", view)).toEqual({
      x: 84,
      y: 134,
      side: "bottom",
    });
  });

  it("puts it on each of the four sides", () => {
    const target = box(300, 300, 40, 20);
    const size = { width: 50, height: 24 };
    expect(placeBeside(target, size, "top", view)).toMatchObject({ y: 300 - TIP.gap - 24 });
    expect(placeBeside(target, size, "right", view)).toMatchObject({ x: 340 + TIP.gap, y: 298 });
    expect(placeBeside(target, size, "left", view)).toMatchObject({ x: 300 - TIP.gap - 50 });
  });

  it("flips to the other side when its own side has no room", () => {
    // 状态栏贴着窗口底：底下放不下
    expect(placeBeside(box(100, 580, 28, 20), { width: 60, height: 24 }, "bottom", view).side).toBe(
      "top",
    );
    // 刘海贴着窗口顶：上面放不下
    expect(placeBeside(box(100, 2, 28, 28), { width: 60, height: 24 }, "top", view).side).toBe(
      "bottom",
    );
    // 右边贴着窗口右缘
    expect(placeBeside(box(760, 100, 30, 20), { width: 60, height: 24 }, "right", view).side).toBe(
      "left",
    );
  });

  it("keeps it inside the window, at least 8px from the edge", () => {
    expect(placeBeside(box(0, 100, 20, 20), { width: 120, height: 24 }, "bottom", view).x).toBe(
      TIP.edge,
    );
    expect(placeBeside(box(790, 100, 10, 20), { width: 120, height: 24 }, "bottom", view).x).toBe(
      800 - TIP.edge - 120,
    );
  });

  it("lands on whole device pixels (1.25x / 1.5x screens)", () => {
    for (const dpr of [1.25, 1.5]) {
      const { x, y } = placeBeside(
        box(100.3, 50.1, 27, 27),
        { width: 61.4, height: 24 },
        "bottom",
        { ...view, dpr },
      );
      expect(Number.isInteger(Math.round(x * dpr * 1000) / 1000)).toBe(true);
      expect(Number.isInteger(Math.round(y * dpr * 1000) / 1000)).toBe(true);
    }
    expect(snap(10.4, 1.5)).toBeCloseTo(10.6667, 3);
  });
});
