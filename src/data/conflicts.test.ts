import { describe, expect, it } from "vitest";
import { conflictOriginalContent, conflictOriginalTitle, conflictTarget } from "./conflicts";
import type { DayDoc, Goal, Note } from "./types";

const note = (id: string, title: string, contentMd: string): Note => ({
  id,
  title,
  contentMd,
  excerpt: "",
  wordCount: 1,
  isPinned: false,
  isArchived: false,
  archiveCategory: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  relPath: `笔记/${title}.md`,
  conflictOf: null,
  idInFile: true,
});

const day: DayDoc = {
  date: "2026-08-29",
  title: "",
  tasks: [],
  noteMd: "- [x] 买菜",
  updatedAt: 1,
  carriedFrom: null,
  relPath: "日记/2026/2026-08-29.md",
};

const goal: Goal = {
  id: "goal:week:2026-09-21",
  horizon: "week",
  title: "",
  periodStart: "2026-09-21",
  contentMd: "这周的目标",
  createdAt: 1,
  updatedAt: 1,
  relPath: "目标/2026/2026-W39.md",
};

describe("conflictTarget", () => {
  it("reads note ids, days and goal periods", () => {
    expect(conflictTarget("0199f3c2-aaaa")).toEqual({ kind: "note", id: "0199f3c2-aaaa" });
    expect(conflictTarget("day:2026-10-07")).toEqual({ kind: "day", id: "2026-10-07" });
    expect(conflictTarget("goal:week:2026-09-21")).toEqual({
      kind: "goal",
      horizon: "week",
      periodStart: "2026-09-21",
    });
    // 长得不像的就当笔记 id
    expect(conflictTarget("day:昨天")).toEqual({ kind: "note", id: "day:昨天" });
  });
});

describe("原文的标题和正文", () => {
  const lists = { notes: [note("n-1", "周报", "本机的")], archived: [] };
  const docs = {
    ...lists,
    dayDocs: [day],
    goals: { "week:2026-09-21": goal },
    bodies: { "n-1": "本机的" },
  };

  it("names a day by its date and a goal by its period, like backlinks do", () => {
    expect(conflictOriginalTitle({ kind: "day", id: "2026-08-29" }, lists)).toBe("8月29日");
    expect(
      conflictOriginalTitle({ kind: "goal", horizon: "week", periodStart: "2026-09-21" }, lists),
    ).toBe("第 39 周目标");
    expect(conflictOriginalTitle({ kind: "note", id: "n-1" }, lists)).toBe("周报");
    // 原文是笔记、已经不在了
    expect(conflictOriginalTitle({ kind: "note", id: "gone" }, lists)).toBeUndefined();
  });

  it("reads the original's body, undefined while it is not loaded yet", () => {
    expect(conflictOriginalContent({ kind: "day", id: "2026-08-29" }, docs)).toBe("- [x] 买菜");
    expect(conflictOriginalContent({ kind: "day", id: "2026-08-30" }, docs)).toBeUndefined();
    expect(
      conflictOriginalContent({ kind: "goal", horizon: "week", periodStart: "2026-09-21" }, docs),
    ).toBe("这周的目标");
    expect(
      conflictOriginalContent({ kind: "goal", horizon: "month", periodStart: "2026-09-01" }, docs),
    ).toBeUndefined();
    expect(conflictOriginalContent({ kind: "note", id: "n-1" }, docs)).toBe("本机的");
    // 笔记的正文也是按需取的（store 的 bodies 里没有就是还没取）
    expect(
      conflictOriginalContent({ kind: "note", id: "n-1" }, { ...docs, bodies: {} }),
    ).toBeUndefined();
  });
});
