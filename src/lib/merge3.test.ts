import { describe, expect, it } from "vitest";
import { merge3 } from "./merge3";

const base = ["# 周会", "", "- 张三：接口", "- 李四：界面", "", "## 下周", "- 发版"].join("\n");

describe("逐行三方合并", () => {
  it("一边没改：就是另一边", () => {
    expect(merge3(base, base, "改过的")).toEqual({ text: "改过的", skipped: 0 });
    expect(merge3(base, "我改的", base)).toEqual({ text: "我改的", skipped: 0 });
  });

  it("两边改的是不同的地方：都留下", () => {
    const ours = base.replace("- 张三：接口", "- 张三：接口（周三前）");
    const theirs = base.replace("- 发版", "- 发版\n- 写更新说明");
    const merged = merge3(base, ours, theirs)!;
    expect(merged.skipped).toBe(0);
    expect(merged.text).toContain("- 张三：接口（周三前）");
    expect(merged.text).toContain("- 写更新说明");
    expect(merged.text.split("\n")).toHaveLength(8);
  });

  it("改到同一处、挨着的：我这边的不打，以对方的为准", () => {
    const ours = base.replace("- 李四：界面", "- 李四：界面和文档");
    const theirs = base.replace("- 李四：界面", "- 李四：请假");
    expect(merge3(base, ours, theirs)).toEqual({ text: theirs, skipped: 1 });
    // 挨着的下一行也算撞上
    const near = base.replace("- 张三：接口", "- 张三：接口！");
    expect(merge3(base, near, theirs)?.skipped).toBe(1);
  });

  it("在开头、末尾加行", () => {
    const ours = `置顶\n${base}`;
    const theirs = `${base}\n末尾`;
    expect(merge3(base, ours, theirs)?.text).toBe(`置顶\n${base}\n末尾`);
  });
});
