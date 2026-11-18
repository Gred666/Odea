import { emptyLayout, openTab, prune, remap } from "@/app/panes";
import { describe, expect, it } from "vitest";
import { buildExpr, propExpr, toSimple } from "./filterRows";
import { baseOfTab, baseTabId, baseTitle } from "./ids";
import { withValue } from "./write";

/* 视图文件（docs/视图文件.md）：筛选面板的三格和表达式互转、改一格写回属性块、标签里的视图文件 */

describe("筛选的一行", () => {
  it("splits the simple shapes into property, operator and value and writes them back", () => {
    const cases: [string, ReturnType<typeof toSimple>][] = [
      ['status == "完成"', { prop: "status", op: "==", value: "完成" }],
      ['note.status != "完成"', { prop: "status", op: "!=", value: "完成" }],
      ["priority >= 2", { prop: "priority", op: ">=", value: "2" }],
      ['截止 < date("2026-11-20")', { prop: "截止", op: "<", value: "2026-11-20" }],
      ['note["带 空格"].contains("x")', { prop: "带 空格", op: "contains", value: "x" }],
      ['!tags.contains("项目")', { prop: "tags", op: "!contains", value: "项目" }],
      ["!due.isEmpty()", { prop: "due", op: "!empty", value: "" }],
      ['file.hasTag("book")', { prop: "file.tags", op: "hasTag", value: "book" }],
      ['file.inFolder("笔记/项目")', { prop: "file.folder", op: "inFolder", value: "笔记/项目" }],
      ['file.mtime > now() - "1 week"', null],
      ['status == "a" || status == "b"', null],
      ["写错了 ==", null],
    ];
    for (const [expr, simple] of cases) expect(toSimple(expr), expr).toEqual(simple);
    expect(buildExpr({ prop: "status", op: "==", value: "完成" })).toBe('status == "完成"');
    expect(buildExpr({ prop: "priority", op: ">", value: "2" }, "number")).toBe("priority > 2");
    // 文字的值像数字也加引号：status 记成文字时 `2` 是字
    expect(buildExpr({ prop: "code", op: "==", value: "2" }, "text")).toBe('code == "2"');
    expect(buildExpr({ prop: "截止", op: "<", value: "2026-11-20" }, "date")).toBe(
      '截止 < date("2026-11-20")',
    );
    expect(buildExpr({ prop: "file.tags", op: "hasTag", value: "#book" })).toBe(
      'file.hasTag("book")',
    );
    expect(propExpr("带 空格")).toBe('note["带 空格"]');
    expect(propExpr("file")).toBe('note["file"]');
    expect(propExpr("note.status")).toBe("status");
    // 写出来的再拆回去是同一个
    for (const [, simple] of cases) if (simple) expect(toSimple(buildExpr(simple))).toEqual(simple);
  });
});

describe("改一格", () => {
  it("rewrites only that entry, appends a missing one and keeps list style", () => {
    const text = "# 注释\nstatus: 进行中\ntags: [a, b]\n截止: 2026-11-20";
    expect(withValue(text, "status", "text", "完成")).toBe(
      "# 注释\nstatus: 完成\ntags: [a, b]\n截止: 2026-11-20",
    );
    expect(withValue(text, "tags", "tags", ["a", "c"])).toBe(
      "# 注释\nstatus: 进行中\ntags: [a, c]\n截止: 2026-11-20",
    );
    expect(withValue(text, "priority", "number", "2")).toBe(`${text}\npriority: 2`);
    // 类型对不上的值照文字写（加引号，读回来还是字）
    expect(withValue(text, "截止", "date", "下周")).toBe(
      "# 注释\nstatus: 进行中\ntags: [a, b]\n截止: 下周",
    );
    expect(withValue("", "status", "text", "2")).toBe('status: "2"');
  });
});

describe("标签里的视图文件", () => {
  it("is kept when notes are pruned or remapped", () => {
    const id = baseTabId("笔记/项目/看板.base");
    expect(baseOfTab(id)).toBe("笔记/项目/看板.base");
    expect(baseOfTab("base:不是视图.md")).toBeNull();
    expect(baseTitle("笔记/项目/看板.base")).toBe("看板");
    const layout = openTab(openTab(emptyLayout("n1"), id), "n2");
    const pruned = prune(layout, new Set(["n1"]));
    expect(pruned.panes[0]!.tabs.map((tab) => tab.noteId)).toEqual(["n1", id]);
    const remapped = remap(layout, (noteId) => (noteId === "n1" ? "n1-new" : undefined));
    expect(remapped.panes[0]!.tabs.map((tab) => tab.noteId)).toEqual(["n1-new", id]);
  });
});
