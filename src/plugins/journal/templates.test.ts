import type { TemplateContext } from "@/data/types";
import { parseBlocks } from "@/lib/markdown";
import { CARET, registerTemplates, templatesFor } from "@/plugins/registry";
import { describe, expect, it } from "vitest";
import { TEMPLATES, type TemplateScope, scopeLabel, templatePlaceholder } from "./templates";

/* 日程那几套模板（某一天、周、月、年）：按日期现算。触发、插入、「待续」是编辑器的事（editor/templates.test.ts） */

registerTemplates(TEMPLATES);

const byId = (id: string) => TEMPLATES.find((template) => template.id === id)!;
const ctx = (
  scope: TemplateScope | string,
  date: string,
  today = "2026-09-27",
): TemplateContext => ({
  scope,
  date,
  today,
  label: "",
  placeholder: "",
});

describe("模板清单", () => {
  it("offers every document kind a few templates, with unique ids", () => {
    expect(templatesFor("day").map((t) => t.name)).toEqual([
      "今日计划",
      "时间块",
      "晚间复盘",
      "三行日记",
    ]);
    expect(templatesFor("week")).toHaveLength(3);
    expect(templatesFor("month")).toHaveLength(2);
    expect(templatesFor("year")).toHaveLength(2);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
  });

  it("builds every template with exactly one caret and well-formed tables", () => {
    for (const template of TEMPLATES) {
      const source = template.build(
        ctx(template.scope, template.scope === "day" ? "2026-09-27" : "2026-09-28"),
      );
      expect(source.split(CARET), template.id).toHaveLength(2);
      // 同一张表每一行的格子数一样（多一格少一格，表格就退回源码了）
      let columns: number | null = null;
      for (const line of source.split("\n")) {
        if (!line.startsWith("|")) {
          columns = null;
          continue;
        }
        const cells = line.split("|").length - 2;
        if (columns === null) columns = cells;
        expect(cells, `${template.id}: ${line}`).toBe(columns);
      }
    }
  });

  it("previews every table as a table, not as raw pipes", () => {
    // 预览走占位渲染器（lib/markdown.tsx），它的分隔行至少要三个 `-`
    for (const template of TEMPLATES) {
      const source = template.build(ctx(template.scope, "2026-09-28"));
      const tables = source.split("\n").filter((line) => /^\|[:-]+\|/.test(line)).length;
      const rendered = parseBlocks(source).filter((block) => block.kind === "table").length;
      expect(rendered, template.id).toBe(tables);
      expect(
        parseBlocks(source).some((block) => block.kind === "p" && block.text.includes("|")),
      ).toBe(false);
    }
  });

  it("labels the picker with the document's own period", () => {
    expect(scopeLabel(ctx("day", "2026-09-27"))).toBe("9月27日 · 周日");
    expect(scopeLabel(ctx("week", "2026-09-28"))).toBe("第 40 周");
    expect(scopeLabel(ctx("month", "2026-10-01"))).toBe("十月");
    expect(scopeLabel(ctx("year", "2026-01-01"))).toBe("2026 年");
  });

  it("tells an empty document it can start from a template", () => {
    for (const scope of ["day", "week", "month", "year"] as const) {
      expect(templatePlaceholder(scope), scope).toContain("/模板");
    }
  });
});

describe("按日期现算", () => {
  it("lays out the seven days of the week, dated so they land in the calendar", () => {
    const source = byId("week-plan").build(ctx("week", "2026-09-28"));
    expect(source).toContain("- **周一**\n  - [ ] @2026-09-28 \n- **周二**");
    expect(source).toContain("- **周日**\n  - [ ] @2026-10-04 ");
    expect(source).toContain("- [ ] 周复盘 @2026-10-04 20:00 #复盘");
  });

  it("leaves out review checkpoints that are already in the past", () => {
    const past = byId("week-plan").build(ctx("week", "2026-09-21", "2026-09-28"));
    expect(past).not.toContain("周复盘");
    const lastDay = byId("week-plan").build(ctx("week", "2026-09-21", "2026-09-27"));
    expect(lastDay).toContain("周复盘 @2026-09-27");

    const year = byId("year-plan").build(ctx("year", "2026-01-01", "2026-09-27"));
    expect(year).not.toContain("第一季度回顾");
    expect(year).not.toContain("年中回顾");
    expect(year).toContain("- [ ] 第三季度回顾 @2026-09-30 #复盘");
    expect(year).toContain("- [ ] 年度复盘 @2026-12-31 #复盘");
    expect(byId("year-plan").build(ctx("year", "2025-01-01"))).not.toContain("回顾节点");
  });

  it("dates the habit tracker's columns, across a month boundary", () => {
    const source = byId("week-habits").build(ctx("week", "2026-09-28"));
    expect(source).toContain("| 习惯 | 一 28 | 二 29 | 三 30 | 四 1 | 五 2 | 六 3 | 日 4 |");
  });

  it("splits the month into its weeks, clipped to the month", () => {
    const source = byId("month-plan").build(ctx("month", "2026-10-01"));
    expect(source).toContain("> [!十月的主题]");
    expect(source).toContain(
      [
        "- **第 40 周** 10/1 – 10/4：",
        "- **第 41 周** 10/5 – 10/11：",
        "- **第 42 周** 10/12 – 10/18：",
        "- **第 43 周** 10/19 – 10/25：",
        "- **第 44 周** 10/26 – 10/31：",
      ].join("\n"),
    );
    expect(source).toContain("- [ ] 月度复盘 @2026-10-31 20:00 #复盘");
    // 二月、跨年的一月
    expect(byId("month-plan").build(ctx("month", "2027-02-01"))).toContain("2/22 – 2/28：");
    expect(byId("month-plan").build(ctx("month", "2027-01-01"))).toContain(
      "- **第 53 周** 1/1 – 1/3：",
    );
  });
});
