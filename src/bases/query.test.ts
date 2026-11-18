import type { BaseDoc } from "@/lib/bindings";
import { describe, expect, it } from "vitest";
import {
  type BaseConfig,
  editBase,
  newBaseText,
  readBase,
  setFilters,
  setSort,
  setViewKey,
} from "./config";
import {
  BDate,
  BDuration,
  ExprError,
  type Scope,
  Unsupported,
  evaluate,
  formatDate,
  parseExpr,
} from "./expr";
import {
  type KindHints,
  baseSource,
  buildRows,
  compileView,
  defaultOrder,
  propRef,
  runView,
} from "./query";

/* 视图文件（docs/视图文件.md）：表达式、配置的读写、一个视图算出来的结果 */

const NOW = new Date(2026, 10, 18, 10, 30).getTime();
const hints: KindHints = { recorded: {}, usual: new Map() };

function doc(relPath: string, props: string, extra: Partial<BaseDoc> = {}): BaseDoc {
  return {
    target: { type: "note", key: relPath },
    relPath,
    title: relPath.slice(relPath.lastIndexOf("/") + 1).replace(/\.md$/, ""),
    createdAt: NOW - 86_400_000 * 10,
    updatedAt: NOW - 86_400_000,
    size: 100,
    archived: false,
    notUtf8: false,
    props,
    tags: [],
    links: null,
    ...extra,
  };
}

const DOCS = [
  doc("笔记/项目/甲.md", "status: 进行中\npriority: 3\n截止: 2026-11-20\ntags: [项目]", {
    tags: ["项目"],
  }),
  doc("笔记/项目/乙.md", "status: 完成\npriority: 1\n截止: 2026-11-10"),
  doc("笔记/项目/丙.md", "status: 计划\n截止: 2026-12-01"),
  doc("笔记/别处/丁.md", "status: 进行中\npriority: 2"),
];
const rows = buildRows(DOCS, hints, new Map());
const scope = (index: number): Scope => ({
  file: rows[index]!.source,
  self: baseSource("笔记/项目/看板.base"),
  formula: () => null,
  now: NOW,
});
const run = (source: string, index = 0) => evaluate(parseExpr(source), scope(index));

describe("表达式", () => {
  it("reads properties, file fields and compares like JavaScript", () => {
    expect(run('status != "完成" && priority > 1')).toBe(true);
    expect(run('note.status == "进行中"')).toBe(true);
    expect(run('note["status"]')).toBe("进行中");
    expect(run("priority * 2 + 1")).toBe(7);
    expect(run('file.inFolder("笔记/项目")')).toBe(true);
    expect(run('file.inFolder("笔记/项目")', 3)).toBe(false);
    expect(run('file.hasTag("项目") && !file.hasTag("别的")')).toBe(true);
    expect(run('file.name + "|" + file.basename + "|" + file.folder')).toBe("甲.md|甲|笔记/项目");
    expect(run("file.hasProperty(\"截止\") && !file.hasProperty('没有')")).toBe(true);
    expect(run("缺的属性")).toBe(null);
    expect(run('if(priority > 2, "高", "低")')).toBe("高");
    expect(run("[1, 2, 3].filter(value > 1).map(value * 10)")).toEqual([20, 30]);
    expect(run('"a,b".split(",").length')).toBe(2);
  });

  it("does dates and durations", () => {
    expect(run("截止 > today()")).toBe(true);
    expect(run("截止 > today()", 1)).toBe(false);
    expect(run("(截止 - today()).days")).toBe(2);
    expect(run('today() + "1 week"')).toEqual(new BDate(new Date(2026, 10, 25).getTime(), true));
    expect(run('date("2026-01-31") + "1M"')).toEqual(
      new BDate(new Date(2026, 1, 28).getTime(), true),
    );
    expect(run('file.mtime > now() - "2d"')).toBe(true);
    expect(run('now() - date("2026-11-17 10:30")')).toEqual(new BDuration(86_400_000));
    expect(
      formatDate(new BDate(new Date(2026, 10, 20, 9, 5).getTime()), "YYYY-MM-DD ddd HH:mm [整]"),
    ).toBe("2026-11-20 周五 09:05 整");
  });

  it("says what it cannot do instead of guessing", () => {
    expect(() => parseExpr('status == "完成')).toThrow(ExprError);
    expect(() => parseExpr("a +")).toThrow(ExprError);
    expect(() => run("file.backlinks")).toThrow(Unsupported);
    expect(() => run("html(1)")).toThrow(Unsupported);
    // 没取正文：file.links 说不出来，不当成空的
    expect(() => run("file.links")).toThrow(Unsupported);
  });
});

const BASE = `# 项目看板
filters:
  and:
    - file.inFolder("笔记/项目")
formulas:
  剩几天: '(截止 - today()).days'
properties:
  note.status:
    displayName: 状态
summaries:
  x: 'values.mean()'
views:
  - type: table
    name: 进行中
    filters: 'status != "完成"'
    order:
      - file.name
      - status
      - formula.剩几天
    sort:
      - property: 截止
        direction: DESC
    columnSize:
      file.name: 240
  - type: kanban
    name: 看板
    groupBy:
      property: status
      direction: ASC
    groupOrder:
      - 计划
      - 进行中
      - 完成
      - null
  - type: map
    name: 地图
    lat: note.lat
    markers: [a, b]
`;

describe("配置", () => {
  it("reads an Obsidian base and keeps what it does not know", () => {
    const { config, error } = readBase(BASE);
    expect(error).toBeNull();
    expect(config.views.map((view) => [view.type, view.name])).toEqual([
      ["table", "进行中"],
      ["kanban", "看板"],
      ["map", "地图"],
    ]);
    expect(config.views[0]!.sort).toEqual([{ property: "截止", direction: "DESC" }]);
    expect(config.views[0]!.columnSize).toEqual({ "file.name": 240 });
    expect(config.views[1]!.groupOrder).toEqual(["计划", "进行中", "完成", null]);
    expect(config.displayNames["note.status"]).toBe("状态");
    expect(config.formulas.剩几天).toBe("(截止 - today()).days");
  });

  it("changes only the key it was asked to and writes it the way Obsidian does", () => {
    const sorted = editBase(BASE, setSort(1, [{ property: "file.mtime", direction: "DESC" }]));
    expect(sorted).toContain("    sort:\n      - property: file.mtime\n        direction: DESC\n");
    // 别的一个字没动：注释、summaries、地图视图的经纬度、引号
    expect(
      sorted.replace("    sort:\n      - property: file.mtime\n        direction: DESC\n", ""),
    ).toBe(BASE);

    const filtered = editBase(
      BASE,
      setFilters(0, {
        op: "and",
        items: [{ expr: 'status != "完成"' }, { expr: "priority >= 2" }],
      }),
    );
    expect(filtered).toContain(
      `    filters:\n      and:\n        - status != "完成"\n        - priority >= 2\n`,
    );
    // 不加引号读不回来的，yaml 自己挑引号：有双引号用单引号（Obsidian 的写法）
    expect(editBase(BASE, setFilters(null, { expr: '!file.hasTag("x")' }))).toContain(
      `filters: '!file.hasTag("x")'\n`,
    );
    expect(readBase(filtered).config.views[0]!.filters).toEqual({
      op: "and",
      items: [{ expr: 'status != "完成"' }, { expr: "priority >= 2" }],
    });
    const cleared = editBase(BASE, setViewKey(0, "columnSize", undefined));
    expect(cleared).not.toContain("columnSize");
    expect(() => editBase("views: [", setViewKey(0, "name", "x"))).toThrow();
  });

  it("writes a new base the way Obsidian reads it", () => {
    expect(newBaseText("笔记/项目")).toBe(
      'filters:\n  and:\n    - file.inFolder("笔记/项目")\nviews:\n  - type: table\n    name: 表格\n    order:\n      - file.name\n      - file.mtime\n',
    );
    expect(readBase(newBaseText(null)).config.filters).toBeNull();
  });

  it("explains a broken file", () => {
    expect(readBase("views: [\n").error).toMatch(/YAML 写坏了/);
    expect(readBase("views: 3").error).toMatch(/views 要是一个列表/);
    expect(readBase("").config.views).toEqual([]);
  });
});

describe("一个视图", () => {
  const config: BaseConfig = readBase(BASE).config;
  const self = baseSource("笔记/项目/看板.base");

  it("filters, sorts with empties last and computes formulas", () => {
    const view = config.views[0]!;
    const result = runView(compileView(config, view), view, rows, self, NOW);
    expect(result.rows.map((row) => row.source.basename)).toEqual(["丙", "甲"]);
    expect(result.total).toBe(2);
    expect(result.cell(result.rows[1]!, "formula.剩几天")).toEqual({ value: 2, error: null });
    expect(result.cell(result.rows[1]!, "file.name").value).toBe("甲.md");
    expect(result.problems).toEqual([]);
  });

  it("groups by the written value in groupOrder order, with an empty column kept", () => {
    const view = config.views[1]!;
    const result = runView(compileView(config, view), view, rows, self, NOW);
    expect(
      result.groups!.map((group) => [group.key, group.rows.map((row) => row.source.basename)]),
    ).toEqual([
      ["计划", ["丙"]],
      ["进行中", ["甲"]],
      ["完成", ["乙"]],
      [null, []],
    ]);
  });

  it("keeps rows when a filter cannot be computed and says why", () => {
    const broken = readBase(
      "filters:\n  and:\n    - file.backlinks.length > 0\n    - priority > 1\nviews:\n  - type: table\n",
    ).config;
    const view = broken.views[0]!;
    const result = runView(compileView(broken, view), view, rows, self, NOW);
    expect(result.rows.map((row) => row.source.basename).sort()).toEqual(["丁", "甲"]);
    expect(result.problems).toEqual(["「file.backlinks.length > 0」Odea 还算不了 file.backlinks"]);
  });

  it("asks for the body only when tags or links are used", () => {
    const plain = readBase("views:\n  - type: table\n    order: [file.name, status]\n").config;
    expect(compileView(plain, plain.views[0]!).needsBody).toBe(false);
    const tags = readBase('filters: file.hasTag("a")\nviews:\n  - type: table\n').config;
    expect(compileView(tags, tags.views[0]!).needsBody).toBe(true);
    const column = readBase("views:\n  - type: table\n    order: [file.links]\n").config;
    expect(compileView(column, column.views[0]!).needsBody).toBe(true);
  });

  it("knows which property a column is", () => {
    expect(propRef("status")).toEqual({ ns: "note", name: "status", id: "note.status" });
    expect(propRef('note["带 空格"]')).toEqual({ ns: "note", name: "带 空格", id: "note.带 空格" });
    expect(propRef("formula.x").ns).toBe("formula");
    expect(defaultOrder(rows)).toEqual(["file.name", "status", "priority", "截止", "tags"]);
  });
});
