import { CARET } from "@/plugins/registry";
import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import { frontMatterRange } from "./frontMatter";

export type { TemplateContext } from "@/data/types";
export {
  CARET,
  type DocTemplate,
  NOTE_PLACEHOLDER,
  onTemplatesChange,
  templatesFor,
  templatesRevisionOf,
} from "@/plugins/registry";

/* ============================================================
   文档模板的触发和插入。模板本身由插件交来（贡献点 templates，plugins/registry.ts；
   日程那几套在 plugins/journal/templates.ts），这篇文档能用哪一组看 DocumentModel.templates。

   在一行里只写 `/模板`（也认 `/model` `/template` `/mb`，以及中文输入法下 `/` 打出来
   的 `、模板`），编辑器就在光标下面弹出这篇文档能用的模板：某一天只列日模板，周目标
   只列周模板……回车把那一行换成模板，Shift+回车用模板替换全文 —— 原文里还没勾掉
   的 `- [ ]` 收进最后的「待续」，一条都不丢（今天延续了昨天的内容时正好用得上）。
   ============================================================ */

/* ---------------- 触发词 ---------------- */

/**
 * 一整行只有触发词（前后可以有空白）。中文输入法下 `/` 键打出来的是顿号，
 * 所以 `、模板` 也算；`mb` 是「模板」的拼音首字母，不用切输入法。
 */
const TRIGGER_RE = /^\s*[/、](?:模板|mb|muban|model|template|tpl)\s*$/i;

export function isTemplateTrigger(lineText: string): boolean {
  return TRIGGER_RE.test(lineText);
}

/** 光标（单个、空选区）停在触发词末尾时，返回触发词所在的整行。 */
export function templateTrigger(state: EditorState): { from: number; to: number } | null {
  const { ranges, main } = state.selection;
  if (ranges.length !== 1 || !main.empty) return null;
  const line = state.doc.lineAt(main.head);
  if (!isTemplateTrigger(line.text)) return null;
  const end = line.from + line.text.trimEnd().length;
  if (main.head < end) return null;
  return { from: line.from, to: line.to };
}

/* ---------------- 插入 ---------------- */

export type TemplateMode = "insert" | "replace";

/** 正文里还没勾掉的任务（围栏代码里的不算），统一成顶层的 `- [ ] …`，去重。 */
export function openTasksOf(markdown: string): string[] {
  const seen = new Set<string>();
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const task = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\[ \]\s+(\S.*?)\s*$/.exec(line);
    if (task) seen.add(`- [ ] ${task[1]}`);
  }
  return [...seen];
}

/** 除了触发词那一行，正文里还有没有别的内容（有才给「替换全文」） */
export function hasOtherContent(
  state: EditorState,
  trigger: { from: number; to: number },
): boolean {
  const doc = state.doc;
  return !!(doc.sliceString(0, trigger.from) + doc.sliceString(trigger.to)).trim();
}

/** 替换全文时会带进「待续」的任务 */
export function carriedTasks(state: EditorState, trigger: { from: number; to: number }): string[] {
  const doc = state.doc;
  const front = frontMatterRange(doc);
  const start = front ? front.to : 0;
  const before = trigger.from > start ? doc.sliceString(start, trigger.from) : "";
  return openTasksOf(before + doc.sliceString(trigger.to));
}

/**
 * 用模板换掉触发词那一行（insert），或者换掉整篇正文（replace）。
 * - insert：和上下文之间各留一个空行，别让表格 / 列表粘到前后的段落上
 * - replace：开头的属性块（front matter）留着；原文里没勾掉的任务收进「待续」
 */
export function applyTemplate(
  state: EditorState,
  trigger: { from: number; to: number },
  source: string,
  mode: TemplateMode,
): TransactionSpec {
  const doc = state.doc;
  let from: number;
  let to: number;
  let head = "";
  let body = source;

  if (mode === "replace") {
    const tasks = carriedTasks(state, trigger);
    if (tasks.length) body += `\n\n## 待续\n\n${tasks.join("\n")}`;
    const front = frontMatterRange(doc);
    from = front ? front.to : 0;
    to = doc.length;
    if (front) head = "\n\n";
  } else {
    from = trigger.from;
    to = trigger.to;
    const line = doc.lineAt(from);
    if (line.number > 1 && doc.line(line.number - 1).text.trim()) head = "\n";
    if (line.number < doc.lines && doc.line(line.number + 1).text.trim()) body += "\n";
  }

  const caret = body.indexOf(CARET);
  const text = head + body.replace(CARET, "");
  const offset = caret < 0 ? text.length : head.length + caret;
  return {
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(from + offset),
    scrollIntoView: true,
    userEvent: "input.template",
  };
}
