import { describe, expect, it } from "vitest";
import {
  type Entry,
  appendEntry,
  convertValue,
  entryLines,
  kindOf,
  parse,
  removeEntry,
  renameEntry,
  replaceEntry,
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

  it("keeps what it can when the kind changes", () => {
    const { entries } = parse("截止: 2026-11-20\ntags: [a, b]\nn: 12");
    expect(convertValue(pick(entries, "截止"), "date", "datetime")).toBe("2026-11-20T09:00");
    expect(convertValue(pick(entries, "tags"), "tags", "text")).toBe("a, b");
    expect(convertValue(pick(entries, "截止"), "date", "multitext")).toEqual(["2026-11-20"]);
    expect(convertValue(pick(entries, "n"), "number", "checkbox")).toBe("false");
  });
});
