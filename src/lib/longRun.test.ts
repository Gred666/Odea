import { describe, expect, it } from "vitest";
import { hasLongRun } from "./longRun";

describe("很长、没有断点的西文串", () => {
  it("24 个字符以上、中间没有空白的算", () => {
    expect(hasLongRun(`欢迎使用 Odea${"1".repeat(40)}`)).toBe(true);
    expect(hasLongRun("https://example.com/a/very/long/path?x=1")).toBe(true);
  });

  it("普通单词、汉字、有空格隔开的不算", () => {
    expect(hasLongRun("internationalization")).toBe(false);
    expect(hasLongRun("一".repeat(60))).toBe(false);
    expect(hasLongRun("Release notes for the next build of the app")).toBe(false);
  });

  it("汉字把西文隔开了也不算：汉字前后本来就能断", () => {
    expect(hasLongRun(`${"a".repeat(20)}中${"b".repeat(20)}`)).toBe(false);
  });
});
