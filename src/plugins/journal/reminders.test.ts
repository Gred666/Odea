import type { ReminderAction } from "@/lib/bindings";
import { type LiveEditor, type TextChange, registerLiveEditor } from "@/lib/liveDocuments";
import { afterEach, describe, expect, it, vi } from "vitest";

const taskComplete = vi.fn();
vi.mock("@/lib/bindings", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/bindings")>();
  return { ...original, commands: { ...original.commands, taskComplete } };
});

const { checkedLine, completeTask, findTaskLine } = await import("./reminders");

/** 一个只认字的编辑器：改动照着做，修订号是改了几次 */
function fakeEditor(initial: string): LiveEditor & { value: () => string } {
  let text = initial;
  let revision = 0;
  return {
    text: () => text,
    value: () => text,
    revision: () => String(revision),
    edit(base: string, changes: TextChange[]) {
      if (base !== String(revision)) return { ok: false, code: "stale", message: "" };
      for (const change of [...changes].sort((a, b) => b.from - a.from)) {
        text = text.slice(0, change.from) + change.insert + text.slice(change.to);
      }
      revision += 1;
      return { ok: true, revision: String(revision) };
    },
  };
}

const action = (raw: string, line: number): ReminderAction => ({
  action: "done",
  docId: "n1",
  line,
  raw,
  source: { type: "note", key: "n1" },
});

describe("提醒上点了「完成」", () => {
  let unregister: (() => void) | null = null;
  afterEach(() => {
    unregister?.();
    unregister = null;
    taskComplete.mockReset();
  });

  it("only ever checks, never unchecks", () => {
    expect(checkedLine("- [ ] 交周报 @2026-11-12 18:00")).toBe("- [x] 交周报 @2026-11-12 18:00");
    expect(checkedLine("  3. [ ] 第三件")).toBe("  3. [x] 第三件");
    expect(checkedLine("- [x] 交周报")).toBeNull();
    expect(checkedLine("- 普通列表")).toBeNull();
  });

  it("finds the line by its text, nearest to where it was", () => {
    const text = "# 本周\n\n- [ ] 交周报\n- [x] 开会\n\n- [ ] 交周报";
    expect(findTaskLine(text, 2, "- [ ] 交周报")).toBe(2);
    // 上面加了几行：还是离原来最近的那一条
    expect(findTaskLine(text, 6, "- [ ] 交周报")).toBe(5);
    expect(findTaskLine(text, 2, "- [ ] 不在了")).toBeNull();
  });

  it("goes through the open editor, so typing and saving stay one path", async () => {
    const editor = fakeEditor("加了一行\n# 本周\n- [ ] 交周报 @2026-11-12 18:00\n");
    unregister = registerLiveEditor("note:n1", editor);
    await completeTask(action("- [ ] 交周报 @2026-11-12 18:00", 1));
    expect(editor.value()).toBe("加了一行\n# 本周\n- [x] 交周报 @2026-11-12 18:00\n");
    expect(taskComplete).not.toHaveBeenCalled();
  });

  it("does nothing when it was already checked here", async () => {
    const editor = fakeEditor("- [x] 交周报\n");
    unregister = registerLiveEditor("note:n1", editor);
    await completeTask(action("- [ ] 交周报", 0));
    expect(editor.value()).toBe("- [x] 交周报\n");
  });

  it("asks Rust to edit the file when the note is not open", async () => {
    taskComplete.mockResolvedValue({ status: "ok", data: true });
    await completeTask(action("- [ ] 交周报", 3));
    expect(taskComplete).toHaveBeenCalledWith("n1", 3, "- [ ] 交周报");
  });
});
