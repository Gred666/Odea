import { describe, expect, it } from "vitest";
import { ViewError, applyPatch, validateView } from "./views";

/* 插件交来的声明式视图（docs/插件与跨端.md §5.6）：只认登记过的组件和字段，写错了报出是哪儿 */

const tree = {
  type: "stack",
  children: [
    { type: "heading", text: "统计" },
    { type: "stats", items: [{ label: "字", value: "1200" }] },
    {
      type: "list",
      items: [
        {
          id: "a",
          title: "第一项",
          icon: "check",
          tone: "success",
          actions: [{ action: "fix", label: "改", value: { line: 3 } }],
        },
      ],
    },
    { type: "tree", items: [{ id: "r", title: "根", children: [{ id: "c", title: "子" }] }] },
    { type: "buttons", buttons: [{ action: "all", label: "全部", primary: true }] },
    {
      type: "form",
      id: "f",
      fields: [
        { type: "text", name: "q", label: "找", placeholder: "关键词" },
        { type: "checkbox", name: "case", label: "区分大小写", value: true },
        { type: "select", name: "mode", label: "范围", options: [{ value: "a", label: "全部" }] },
      ],
      submit: { action: "go", label: "开始" },
    },
    { type: "empty", title: "没有了" },
    { type: "divider" },
  ],
};

const error = (value: unknown) => {
  try {
    validateView(value);
  } catch (caught) {
    if (caught instanceof ViewError) return caught.message;
    throw caught;
  }
  throw new Error("应该报错");
};

describe("声明式视图", () => {
  it("登记过的组件都认，交回的是同一棵", () => {
    expect(validateView(tree)).toEqual(tree);
  });

  it.each([
    [{ type: "html", html: "<img src=x onerror=alert(1)>" }, "type 只能是"],
    [{ type: "text", text: "x", style: "color:red" }, "style 不认识这个字段"],
    [{ type: "text", text: 5 }, "text 要是字符串"],
    [{ type: "text", text: "x", tone: "neon" }, "tone 只能是"],
    [{ type: "stack", children: [{ type: "text" }] }, "children[0].text 缺了"],
    [{ type: "list", items: [{ id: "a b", title: "x" }] }, "items[0].id 只能用字母"],
    [
      {
        type: "list",
        items: [
          { id: "a", title: "x" },
          { id: "a", title: "y" },
        ],
      },
      "items[1].id 「a」重复了",
    ],
    [{ type: "list", items: [{ id: "a", title: "x", icon: "constructor" }] }, "没有这个图标"],
    [{ type: "buttons", buttons: [{ action: "x", label: "y", onClick: "z" }] }, "不认识这个字段"],
    [{ type: "buttons", buttons: [{ action: "x", label: "y", tone: "rainbow" }] }, "只能是 danger"],
    [
      { type: "form", id: "f", fields: [{ type: "file", name: "x", label: "x" }], submit: {} },
      "只能是 text、checkbox、select",
    ],
    [{ type: "form", id: "f", fields: [] }, "submit 缺了"],
  ])("写错了报出是哪儿：%j", (value, message) => {
    expect(error(value)).toContain(message);
  });

  it("个数、层数、大小都有上限", () => {
    let deep: unknown = { type: "text", text: "底" };
    for (let i = 0; i < 12; i++) deep = { type: "stack", children: [deep] };
    expect(error(deep)).toContain("套得太深");
    const many = {
      type: "stack",
      children: Array.from({ length: 10 }, () => ({
        type: "list",
        items: Array.from({ length: 250 }, (_, i) => ({ id: `i${i}`, title: "x" })),
      })),
    };
    expect(error(many)).toContain("节点太多");
    expect(error({ type: "text", text: "字".repeat(300_000) })).toContain("太大了");
    const loop: Record<string, unknown> = { type: "stack" };
    loop.children = [loop];
    expect(error(loop)).toContain("不是纯数据");
  });

  it("JSON Patch：add、remove、replace，改完再校验一遍", () => {
    const base = validateView({
      type: "stack",
      children: [
        { type: "text", text: "一" },
        { type: "text", text: "二" },
      ],
    });
    const patched = applyPatch(base, [
      { op: "replace", path: "/children/0/text", value: "壹" },
      { op: "add", path: "/children/-", value: { type: "divider" } },
      { op: "remove", path: "/children/1" },
    ]);
    expect(validateView(patched)).toEqual({
      type: "stack",
      children: [{ type: "text", text: "壹" }, { type: "divider" }],
    });
    // 原来那棵没动
    expect(base).toMatchObject({ children: [{ text: "一" }, { text: "二" }] });
    expect(() => applyPatch(base, [{ op: "move", path: "/children/0", from: "/x" }])).toThrow(
      "只能是 add",
    );
    expect(() => applyPatch(base, [{ op: "remove", path: "/children/9" }])).toThrow("超出");
    expect(() => applyPatch(base, [{ op: "replace", path: "/nope/x", value: 1 }])).toThrow(
      "找不到",
    );
    // 改出来的不合规矩：校验那一步拦下
    const bad = applyPatch(base, [{ op: "replace", path: "/children/0/type", value: "script" }]);
    expect(() => validateView(bad)).toThrow("type 只能是");
  });
});
