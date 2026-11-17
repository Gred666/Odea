import { describe, expect, it } from "vitest";
import { appendTask } from "./capture";

const apply = (body: string, text: string) => {
  const { at, insert } = appendTask(body, text);
  return body.slice(0, at) + insert + body.slice(at);
};

describe("速记记进今日TODO", () => {
  it("joins the list at the end, or starts one after a blank line", () => {
    expect(apply("", "买牛奶")).toBe("- [ ] 买牛奶\n");
    expect(apply("- [ ] 写周报\n- [x] 开会\n", "买牛奶")).toBe(
      "- [ ] 写周报\n- [x] 开会\n- [ ] 买牛奶\n",
    );
    expect(apply("## 今天\n\n写点东西\n\n\n", "买牛奶")).toBe(
      "## 今天\n\n写点东西\n\n- [ ] 买牛奶\n\n\n",
    );
    expect(apply("1. 第一件", "买牛奶")).toBe("1. 第一件\n- [ ] 买牛奶");
  });

  it("keeps it on one line", () => {
    expect(apply("", "  两行\n 合成一行 ")).toBe("- [ ] 两行 合成一行\n");
  });
});

describe("速记记进的是墙上的今天", () => {
  it("goes into today's page even when the store has not turned the page yet", async () => {
    const { saveKeyOf } = await import("@/data/store");
    const { registerLiveEditor } = await import("@/lib/liveDocuments");
    const { today } = await import("@/lib/date");
    const { useJournal } = await import("./store");
    const { captureToToday } = await import("./capture");
    const { DAY } = await import("./types");
    // 窗口在后台过了零点：零点那一下的定时器还没到，store 里的「今天」还是昨天
    useJournal.setState({ todayDate: "2000-01-01", selectedDate: "2000-01-01" });
    const edits: Record<string, string[]> = { today: [], stale: [] };
    const editor = (name: "today" | "stale") => ({
      text: () => "",
      revision: () => "0",
      edit: (_base: string, changes: { insert: string }[]) => {
        edits[name]!.push(...changes.map((change) => change.insert));
        return { ok: true as const, revision: "1" };
      },
    });
    const stops = [
      registerLiveEditor(saveKeyOf({ type: DAY, key: today() }), editor("today")),
      registerLiveEditor(saveKeyOf({ type: DAY, key: "2000-01-01" }), editor("stale")),
    ];
    try {
      await captureToToday("买牛奶");
    } finally {
      for (const stop of stops) stop();
    }
    expect(edits).toEqual({ today: ["- [ ] 买牛奶\n"], stale: [] });
    // 顺带把 store 对上了：今日TODO、日历上停在「今天」的选择都翻过来
    expect(useJournal.getState().todayDate).toBe(today());
    expect(useJournal.getState().selectedDate).toBe(today());
  });
});
