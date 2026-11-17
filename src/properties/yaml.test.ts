import { describe, expect, it } from "vitest";
import {
  type Entry,
  KINDS,
  type Kind,
  appendEntry,
  entryLines,
  fitsKind,
  kindOf,
  mergeProperties,
  parse,
  removeEntry,
  renameEntry,
  replaceEntry,
  singleValue,
  valueFits,
} from "./yaml";

/** 找不到就让测试失败 */
function pick(entries: Entry[], key: string): Entry {
  const found = entries.find((entry) => entry.key === key);
  if (!found) throw new Error(`没有 ${key}`);
  return found;
}

const SAMPLE = [
  "status: 进行中",
  "# 下面是标签",
  'tags: [项目, "发版, 0.9"]',
  "aliases:",
  "  - 发版",
  "  - release",
  "截止: 2026-11-20",
  "摘要: |",
  "  第一行",
  "  第二行",
  "优先级: 1",
  "公开: false",
  '链接: "[[0.9 更新日志]]"',
  "空的:",
].join("\n");

describe("属性块里的几行", () => {
  it("reads the common ways people write properties", () => {
    const { entries } = parse(SAMPLE);
    const find = (key: string) => entries.find((entry) => entry.key === key);
    expect(entries.map((entry) => entry.key)).toEqual([
      "status",
      "tags",
      "aliases",
      "截止",
      "摘要",
      "优先级",
      "公开",
      "链接",
      "空的",
    ]);
    expect(find("status")?.value).toBe("进行中");
    expect(find("tags")).toMatchObject({ shape: "list", flow: true, items: ["项目", "发版, 0.9"] });
    expect(find("aliases")).toMatchObject({
      shape: "list",
      flow: false,
      items: ["发版", "release"],
    });
    expect(find("摘要")?.shape).toBe("complex");
    expect(find("链接")?.value).toBe("[[0.9 更新日志]]");
    expect(find("空的")).toMatchObject({ shape: "scalar", value: "" });
  });

  it("tells kinds by the recorded type, the key, the value, then the vault", () => {
    const { entries } = parse(SAMPLE);
    const find = (key: string) => pick(entries, key);
    expect(kindOf(find("status"), {})).toBe("text");
    expect(kindOf(find("tags"), {})).toBe("tags");
    expect(kindOf(find("aliases"), {})).toBe("aliases");
    expect(kindOf(find("截止"), {})).toBe("date");
    expect(kindOf(find("优先级"), {})).toBe("number");
    expect(kindOf(find("公开"), {})).toBe("checkbox");
    // 空着的：看整个仓库里这个键多半是什么
    expect(kindOf(find("空的"), {}, "date")).toBe("date");
    // 记着的类型说了算
    expect(kindOf(find("优先级"), { 优先级: "text" })).toBe("text");
  });

  it("changes only the lines of the entry it edits", () => {
    const parsed = parse(SAMPLE);
    const find = (key: string) => pick(parsed.entries, key);
    const next = replaceEntry(
      parsed,
      find("aliases"),
      entryLines("aliases", "aliases", ["发版", "release", "0.9"]),
    );
    expect(next).toBe(SAMPLE.replace("  - release", '  - release\n  - "0.9"'));
    // 一行写完的列表照一行写
    const tags = replaceEntry(parsed, find("tags"), entryLines("tags", "tags", ["项目"], true));
    expect(tags.split("\n")[2]).toBe("tags: [项目]");
    // 注释、多行字符串一个字节不动
    expect(removeEntry(parsed, find("status"))).toBe(SAMPLE.split("\n").slice(1).join("\n"));
    expect(renameEntry(parsed, find("优先级"), "priority")).toContain("\npriority: 1\n");
    expect(appendEntry(parsed, ["新的: 值"]).endsWith("空的:\n新的: 值")).toBe(true);
    expect(appendEntry(parse(""), ["新的: 值"])).toBe("新的: 值");
  });

  it("quotes text that would read back as something else", () => {
    expect(entryLines("版本", "text", "2")).toEqual(['版本: "2"']);
    expect(entryLines("答", "text", "true")).toEqual(['答: "true"']);
    expect(entryLines("时间", "text", "下午 3: 30")).toEqual(['时间: "下午 3: 30"']);
    expect(entryLines("链接", "text", "[[笔记]]")).toEqual(['链接: "[[笔记]]"']);
    expect(entryLines("优先级", "number", "2")).toEqual(["优先级: 2"]);
    expect(entryLines("公开", "checkbox", "true")).toEqual(["公开: true"]);
    expect(entryLines("截止", "date", "")).toEqual(["截止:"]);
    expect(entryLines("my key: x", "text", "a")).toEqual(['"my key: x": a']);
    expect(entryLines("tags", "tags", [])).toEqual(["tags:"]);
    expect(entryLines("tags", "tags", ["a, b"], true)).toEqual(['tags: ["a, b"]']);
  });

  it("tells whether a kind's control can show a value as it is (审查 §6.8)", () => {
    const { entries } = parse(
      [
        "s: 草稿",
        "截止: 2026-11-20",
        "at: 2026-11-20T15:30",
        "坏的: 2026-13-45",
        "n: 12",
        "ok: true",
        "大写: True",
        "空的:",
        "tags: [a, b]",
        "one: [2026-11-20]",
      ].join("\n"),
    );
    const fits = (key: string, kind: Kind) => fitsKind(pick(entries, key), kind);
    // 列表、文字什么都读得了；「草稿」不是日期、数字、勾选
    for (const kind of ["text", "multitext", "tags", "aliases"] as Kind[]) {
      expect(fits("s", kind)).toBe(true);
    }
    for (const kind of ["date", "datetime", "number", "checkbox"] as Kind[]) {
      expect(fits("s", kind)).toBe(false);
    }
    // 日期当日期时间读得了；日期时间当日期读不了（日期控件会把时间丢了）
    expect(fits("截止", "datetime")).toBe(true);
    expect(fits("at", "date")).toBe(false);
    expect(fits("at", "datetime")).toBe(true);
    expect(fits("坏的", "date")).toBe(false);
    expect(fits("n", "number")).toBe(true);
    expect(fits("n", "checkbox")).toBe(false);
    expect(fits("ok", "checkbox")).toBe(true);
    // 勾选只认 true、false：别的画成框会被一点盖掉
    expect(fits("大写", "checkbox")).toBe(false);
    // 空着的哪种都读得了
    for (const kind of KINDS) expect(fits("空的", kind)).toBe(true);
    // 两项的列表当不了一个值；一项的当得了
    expect(fits("tags", "text")).toBe(false);
    expect(fits("tags", "tags")).toBe(true);
    expect(fits("one", "date")).toBe(true);
    expect(singleValue(pick(entries, "one"))).toBe("2026-11-20");
    // 改进去的值：读得了照这种类型写，读不了照文字写
    expect(valueFits("2026-11-20", "date")).toBe(true);
    expect(valueFits("soon", "date")).toBe(false);
    expect(valueFits("", "checkbox")).toBe(true);
  });
});

describe("源码框和外面的改动按属性合（桌面端验证 §4.9）", () => {
  const base = "状态: 草稿\n截止: 2026-11-20\ntags: [项目]";

  it("不同的键各改各的：两边的都留下，顺序跟着框里的", () => {
    const mine = "截止: 2026-11-25\n状态: 草稿\ntags: [项目]";
    const theirs = "状态: 已完成\n截止: 2026-11-20\ntags: [项目]";
    expect(mergeProperties(base, mine, theirs)).toEqual({
      text: "截止: 2026-11-25\n状态: 已完成\ntags: [项目]",
      conflicts: [],
      unreadable: false,
    });
  });

  it("同一个键两边都改了：以框里的为准，点名", () => {
    const mine = "状态: 进行中\n截止: 2026-11-20\ntags: [项目]";
    const theirs = "状态: 已完成\n截止: 2026-11-21\ntags: [项目]";
    const merged = mergeProperties(base, mine, theirs);
    expect(merged.text).toBe("状态: 进行中\n截止: 2026-11-21\ntags: [项目]");
    expect(merged.conflicts).toEqual(["状态"]);
    // 两边改成一样的不算
    expect(
      mergeProperties(base, mine, mine.replace("截止: 2026-11-20", "截止: 2026-11-21")).conflicts,
    ).toEqual([]);
  });

  it("外面加的键：加在最后一条属性后面，末尾的注释、空行留在后面", () => {
    const mine = "状态: 进行中\n截止: 2026-11-20\ntags: [项目]\n# 备注";
    const theirs = `${base}\n负责人: 小王\naliases:\n  - 发版`;
    expect(mergeProperties(base, mine, theirs).text).toBe(
      "状态: 进行中\n截止: 2026-11-20\ntags: [项目]\n负责人: 小王\naliases:\n  - 发版\n# 备注",
    );
    // 框里也加了同一个键、值不一样：以框里的为准
    const both = mergeProperties(base, `${mine}\n负责人: 小李`, theirs);
    expect(both.text).toContain("负责人: 小李");
    expect(both.text).not.toContain("小王");
    expect(both.conflicts).toEqual(["负责人"]);
    // 框里全删光了：外面加的照样加上
    expect(mergeProperties(base, "", theirs).text).toBe("负责人: 小王\naliases:\n  - 发版");
  });

  it("外面删的键：框里没动就删，框里改了就留着、点名；框里删的、外面改了的以框里的为准", () => {
    const theirs = "状态: 草稿\ntags: [项目]";
    expect(mergeProperties(base, "状态: 进行中\n截止: 2026-11-20\ntags: [项目]", theirs).text).toBe(
      "状态: 进行中\ntags: [项目]",
    );
    const kept = mergeProperties(base, "状态: 草稿\n截止: 2026-12-01\ntags: [项目]", theirs);
    expect(kept.text).toBe("状态: 草稿\n截止: 2026-12-01\ntags: [项目]");
    expect(kept.conflicts).toEqual(["截止"]);
    const dropped = mergeProperties(
      base,
      "状态: 草稿\ntags: [项目]",
      "状态: 草稿\n截止: 2026-11-30\ntags: [项目]",
    );
    expect(dropped.text).toBe("状态: 草稿\ntags: [项目]");
    expect(dropped.conflicts).toEqual(["截止"]);
  });

  it("读不出来（有不属于任何属性的行、键重名）：整块以框里的为准，说一声", () => {
    const theirs = "状态: 已完成\n截止: 2026-11-20\ntags: [项目]";
    for (const mine of ["状态: 进行中\n这一行不是属性\ntags: [项目]", "状态: 进行中\n状态: 草稿"]) {
      expect(mergeProperties(base, mine, theirs)).toEqual({
        text: mine,
        conflicts: [],
        unreadable: true,
      });
    }
    // 外面那一版读不出来也一样
    expect(mergeProperties(base, "状态: 进行中", "乱写的").unreadable).toBe(true);
  });

  it("只有一边动了：直接用动了的那一边", () => {
    expect(mergeProperties(base, base, "状态: 已完成").text).toBe("状态: 已完成");
    expect(mergeProperties(base, "状态: 进行中", base).text).toBe("状态: 进行中");
  });
});
