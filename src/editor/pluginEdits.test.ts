import { EditorState, type TransactionSpec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { createRevisionLog, rebaseEdit, recordRevision, revisionOf } from "./pluginEdits";

/*
 * 插件按修订号改正文（docs/插件与跨端.md §5.5）：照着读到的那一版改；那以后用户在别处改过的，
 * 把插件的改动挪过去；改的正是插件要改的地方，回 stale，不让旧结果盖掉新正文
 */

function editor(text: string) {
  let state = EditorState.create({ doc: text });
  const log = createRevisionLog();
  return {
    log,
    text: () => state.doc.toString(),
    /** 用户（或者别的什么）改了一笔 */
    type(spec: TransactionSpec) {
      const transaction = state.update(spec);
      state = transaction.state;
      recordRevision(log, transaction.changes);
    },
    /** 插件照着 base 改 */
    plugin(base: string, changes: unknown) {
      const result = rebaseEdit(log, base, changes, state.doc.length);
      if (result.ok) this.type({ changes: result.changes });
      return result;
    },
  };
}

describe("插件改正文", () => {
  it("照着现在这一版改：直接用上，修订号往前走", () => {
    const doc = editor("一二三");
    const base = revisionOf(doc.log);
    expect(doc.plugin(base, [{ from: 1, to: 2, insert: "贰" }]).ok).toBe(true);
    expect(doc.text()).toBe("一贰三");
    expect(revisionOf(doc.log)).not.toBe(base);
  });

  it("那以后用户在前面加了一行：插件的改动挪过去", () => {
    const doc = editor("标题\n行尾空格   \n");
    const base = revisionOf(doc.log);
    doc.type({ changes: { from: 0, insert: "新的一行\n" } });
    const result = doc.plugin(base, [{ from: 7, to: 10, insert: "" }]);
    expect(result.ok).toBe(true);
    expect(doc.text()).toBe("新的一行\n标题\n行尾空格\n");
  });

  it("用户改的正是插件要改的地方：stale，正文不动", () => {
    const doc = editor("a   \nb");
    const base = revisionOf(doc.log);
    doc.type({ changes: { from: 2, to: 3, insert: "X" } });
    const result = doc.plugin(base, [{ from: 1, to: 4, insert: "" }]);
    expect(result).toMatchObject({ ok: false, code: "stale" });
    expect(doc.text()).toBe("a X \nb");
  });

  it("编辑器换过一个（切走又切回来）：旧的修订号一律过时", () => {
    const old = editor("x");
    const fresh = editor("x");
    expect(fresh.plugin(revisionOf(old.log), [{ from: 0, to: 1, insert: "y" }])).toMatchObject({
      ok: false,
      code: "stale",
    });
  });

  it("那以后改得太多（日志里没了）：stale", () => {
    const doc = editor("");
    const base = revisionOf(doc.log);
    for (let i = 0; i < 205; i++) doc.type({ changes: { from: 0, insert: "a" } });
    expect(doc.plugin(base, [{ from: 0, to: 0, insert: "b" }])).toMatchObject({ code: "stale" });
  });

  it.each([
    ["不是数组", "x", "要是数组"],
    ["空的", [], "是空的"],
    ["位置不是整数", [{ from: 0.5, to: 1, insert: "" }], "整数"],
    ["超出正文", [{ from: 0, to: 99, insert: "" }], "超出了正文"],
    [
      "倒着排",
      [
        { from: 2, to: 3 },
        { from: 0, to: 1 },
      ],
      "从前往后排",
    ],
    [
      "重叠",
      [
        { from: 0, to: 2 },
        { from: 1, to: 3 },
      ],
      "从前往后排",
    ],
    ["insert 不是字符串", [{ from: 0, to: 0, insert: 5 }], "{ from, to, insert }"],
  ])("改动写错了：%s", (_name, changes, message) => {
    const doc = editor("一二三四");
    const result = doc.plugin(revisionOf(doc.log), changes);
    expect(result).toMatchObject({ ok: false, code: "invalid" });
    expect(!result.ok && result.message).toContain(message);
    expect(doc.text()).toBe("一二三四");
  });

  it("修订号写得不对、比现在还新：invalid", () => {
    const doc = editor("x");
    expect(doc.plugin("乱写", [{ from: 0, to: 0, insert: "a" }])).toMatchObject({
      code: "invalid",
    });
    expect(doc.plugin(`${doc.log.epoch}.9`, [{ from: 0, to: 0, insert: "a" }])).toMatchObject({
      code: "invalid",
    });
  });
});
