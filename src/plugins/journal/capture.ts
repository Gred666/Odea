import { saveKeyOf, useData } from "@/data/store";
import type { DocumentRef } from "@/data/types";
import { liveEditor } from "@/lib/liveDocuments";
import { useJournal } from "./store";
import { DAY } from "./types";

/* ============================================================
   全局快捷键速记（src-tauri/src/quick_capture.rs）：记一行进今日TODO。

   记成一条待办 `- [ ] 写的字`，放在今天这一篇的末尾：最后一行是列表项就接在它下面，
   不是就空一行另起。

   和打字走同一条路：
   - 今天这一篇正开在编辑器里（哪个窗格、弹出窗口都算）：经编辑器改（liveDocuments 的 edit），
     和正在打的字合在一起，由编辑器去存
   - 没开着：照日程平时那样取今天（还没写过就是延续来的那一份）、加上这一行、存（data/store 的
     saveDocument → 日程的 saveDay）。延续来的今天就在这一刻以今天的身份落盘
   ============================================================ */

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/** 在 body 末尾加一条待办：返回插在哪、插什么 */
export function appendTask(body: string, text: string): { at: number; insert: string } {
  const line = `- [ ] ${text.replace(/\s*\n\s*/g, " ").trim()}`;
  const end = body.replace(/\s+$/, "").length;
  if (end === 0) return { at: 0, insert: `${line}\n` };
  const last = body.slice(body.lastIndexOf("\n", end - 1) + 1, end);
  return { at: end, insert: LIST_ITEM.test(last) ? `\n${line}` : `\n\n${line}` };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 记一行进今日TODO。没记上抛出原因（快捷键小窗里显示） */
export async function captureToToday(text: string): Promise<void> {
  const date = useJournal.getState().todayDate;
  const ref: DocumentRef = { type: DAY, key: date };
  // 编辑器正在组字（输入法）时改不了：等它组完，最多等 3 秒
  for (let tries = 0; tries < 10; tries += 1) {
    const editor = liveEditor(saveKeyOf(ref));
    if (!editor) break;
    const { at, insert } = appendTask(editor.text(), text);
    const outcome = editor.edit(editor.revision(), [{ from: at, to: at, insert }], "capture");
    if (outcome.ok) return;
    if (outcome.code === "readonly") throw new Error("今日TODO 现在是只读的");
    await sleep(300);
  }
  const journal = useJournal.getState();
  await journal.loadDay(date, true);
  const body = useJournal.getState().dayDocs.find((day) => day.date === date)?.noteMd;
  if (body === undefined) throw new Error("今日TODO 还没取到");
  const { at, insert } = appendTask(body, text);
  await useData.getState().saveDocument(ref, body.slice(0, at) + insert + body.slice(at));
  const saved = useJournal.getState().dayDocs.find((day) => day.date === date)?.noteMd;
  if (saved !== undefined && !saved.includes(insert.trim())) {
    throw new Error(useData.getState().error ?? "没存进去");
  }
}
