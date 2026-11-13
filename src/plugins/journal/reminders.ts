import { openDocument } from "@/app/navigate";
import { messageOf, saveKeyOf, useData } from "@/data/store";
import type { DocumentRef } from "@/data/types";
import { events, type ReminderAction, commands } from "@/lib/bindings";
import { liveEditor } from "@/lib/liveDocuments";
import { isTauri, thisWindow } from "@/lib/tauri";

/* ============================================================
   到点提醒在仓库窗口这一头（src-tauri/src/plugins/journal/reminders.rs，docs/提醒与属性.md §1）：
   计时、弹通知、响都在 Rust；通知上点了「完成」「打开」，Rust 交给那个仓库窗口（ReminderAction）。

   - 完成：和速记一样走打字那条路 —— 那一篇开在编辑器里就经编辑器勾（和正在打的字合在一起、编辑器去存，
     不会撞出冲突副本），没开着交给 Rust 改文件（task_complete）。都是只勾不取消：点晚了、在别处已经勾上了，
     不会把它翻回去
   - 打开：打开那一篇、光标停在那一行（窗口 Rust 已经提到前面了）
   ============================================================ */

const CHECKBOX = /^(\s*(?:[-*+]|\d{1,9}[.)])[ \t]+\[) \]/;

/** 那一行勾上以后的样子；已经勾上了、不是任务行是 null */
export function checkedLine(raw: string): string | null {
  return CHECKBOX.test(raw) ? raw.replace(CHECKBOX, "$1x]") : null;
}

/**
 * 在编辑器的正文里找到那一行：原文一样的，挑离它上次所在最近的那一行（上面加了几行字也找得到）。
 * 找不到是 null。编辑器里的就是正文（属性块在 Rust 那边拆掉了），行号和 Rust 数的一样
 */
export function findTaskLine(text: string, line: number, raw: string): number | null {
  const lines = text.split("\n");
  const expected = line;
  let best: number | null = null;
  lines.forEach((candidate, index) => {
    if (candidate !== raw) return;
    if (best === null || Math.abs(index - expected) < Math.abs(best - expected)) best = index;
  });
  return best;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 「完成」：把那一行勾上。没勾上抛出原因 */
export async function completeTask(action: ReminderAction): Promise<void> {
  const key = saveKeyOf(action.source as DocumentRef);
  // 编辑器正在组字（输入法）时改不了：等它组完，最多等 3 秒
  for (let tries = 0; tries < 10; tries += 1) {
    const editor = liveEditor(key);
    if (!editor) break;
    const text = editor.text();
    const index = findTaskLine(text, action.line, action.raw);
    // 编辑器里已经没有原样的这一行：多半是刚在这里勾上了，或者改了字。勾上了就算了
    if (index === null) {
      if (text.split("\n").includes(checkedLine(action.raw) ?? "\u0000")) return;
      throw new Error("这条任务改过了，找不到它，去那一篇里勾吧");
    }
    const from = text
      .split("\n")
      .slice(0, index)
      .reduce((sum, line) => sum + line.length + 1, 0);
    const checked = checkedLine(action.raw);
    if (checked === null) return;
    const outcome = editor.edit(
      editor.revision(),
      [{ from, to: from + action.raw.length, insert: checked }],
      "reminder",
    );
    if (outcome.ok) return;
    if (outcome.code === "readonly") throw new Error("这一篇现在是只读的");
    await sleep(300);
  }
  const result = await commands.taskComplete(action.docId, action.line, action.raw);
  if (result.status === "error") throw new Error(messageOf(result.error));
}

/** 仓库窗口一直听着（日程开着时，Effects 里挂） */
export function listenReminders(): () => void {
  if (!isTauri) return () => {};
  const stop = events.reminderAction(thisWindow()).listen(async ({ payload }) => {
    if (payload.action === "open") {
      // 锚点的行号从 1 起（日历「当日安排」点出处也是这样）；那一篇开着的话按原文找准那一行
      const editor = liveEditor(saveKeyOf(payload.source as DocumentRef));
      const found = editor ? findTaskLine(editor.text(), payload.line, payload.raw) : null;
      openDocument(payload.source as DocumentRef, { line: (found ?? payload.line) + 1 });
      return;
    }
    if (payload.action === "done") {
      try {
        await completeTask(payload);
      } catch (cause) {
        useData.setState({ error: cause instanceof Error ? cause.message : messageOf(cause) });
      }
    }
  });
  return () => void stop.then((unlisten) => unlisten());
}
