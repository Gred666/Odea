import {
  type ISODate,
  addDays,
  formatDayEyebrowCN,
  formatMonthCN,
  formatWeekdayCN,
  formatYear,
  fromISODate,
  isoWeekNumber,
  periodEndOf,
  startOfWeek,
} from "@/lib/date";
import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import {
  CalendarCheck,
  CalendarRange,
  Clock,
  Goal,
  History,
  ListTodo,
  type LucideIcon,
  Moon,
  Mountain,
  PenLine,
  Sparkles,
} from "lucide-react";
import { frontMatterRange } from "./frontMatter";

/* ============================================================
   文档模板（今日TODO / 日历某天 / 周·月·年 GOAL）。

   在一行里只写 `/模板`（也认 `/model` `/template` `/mb`，以及中文输入法下 `/` 打出来
   的 `、模板`），编辑器就在光标下面弹出这篇文档能用的模板：某一天只列日模板，周目标
   只列周模板……回车把那一行换成模板，Shift+回车用模板替换全文 —— 原文里还没勾掉
   的 `- [ ]` 收进最后的「待续」，一条都不丢（今天延续了昨天的内容时正好用得上）。

   模板是按日期现算的 Markdown：周计划写好这一周七天的日期，月度目标按月里的每一周
   拆开，复盘节点写成带日期的任务 —— 它们会出现在日历的那一天（技术方案 §5.4）。
   `‸` 是插入后光标停的位置。
   ============================================================ */

export type TemplateScope = "day" | "week" | "month" | "year";

export interface TemplateContext {
  scope: TemplateScope;
  /** 某一天：那一天；周 / 月 / 年：周期起点 */
  date: ISODate;
  /** 今天。已经过去的复盘节点不再排进日历 */
  today: ISODate;
}

export interface DocTemplate {
  id: string;
  scope: TemplateScope;
  name: string;
  /** 选择器里的一行说明 */
  description: string;
  icon: LucideIcon;
  /** 生成 Markdown；`‸`（CARET）是插入后光标的位置 */
  build: (ctx: TemplateContext) => string;
}

/** 插入后光标停在这里。只出现在模板源文里，插入前会去掉 */
export const CARET = "‸";

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

/* ---------------- 日期小工具 ---------------- */

const lines = (...rows: (string | false)[]) => rows.filter((row) => row !== false).join("\n");

/** 「9/28」 */
function shortDate(date: ISODate): string {
  const d = fromISODate(date);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 复盘节点：还没过去的才排进日历 */
const upcoming = (ctx: TemplateContext, date: ISODate) => date >= ctx.today;

/** 这一天、这一周、这个月、这一年 —— 选择器标题上的那一小段 */
export function scopeLabel(ctx: TemplateContext): string {
  if (ctx.scope === "day") return formatDayEyebrowCN(ctx.date);
  if (ctx.scope === "week") return `第 ${isoWeekNumber(ctx.date)} 周`;
  if (ctx.scope === "month") return formatMonthCN(ctx.date);
  return `${formatYear(ctx.date)} 年`;
}

/** 一个月里的每一周（周一开头），首尾两周截在月内 */
function weeksOfMonth(monthStart: ISODate): { week: number; from: ISODate; to: ISODate }[] {
  const last = periodEndOf("month", monthStart);
  const weeks: { week: number; from: ISODate; to: ISODate }[] = [];
  for (let monday = startOfWeek(monthStart); monday <= last; monday = addDays(monday, 7)) {
    const sunday = addDays(monday, 6);
    weeks.push({
      week: isoWeekNumber(monday),
      from: monday < monthStart ? monthStart : monday,
      to: sunday > last ? last : sunday,
    });
  }
  return weeks;
}

/* ---------------- 模板 ----------------
   写法上的约定：
   - 一个模板只在主标题上放一个动态表情，满屏都在动就不是点缀了
   - 计划类用 `##`，复盘类整块挂在一个 `##` 下面（常常是追加在计划后面的）
   - 表格是主体的模板，光标停在标题末尾：光标在表格里时表格显示成源码 */

export const TEMPLATES: readonly DocTemplate[] = [
  /* ---------- 某一天 ---------- */
  {
    id: "day-plan",
    scope: "day",
    name: "今日计划",
    description: "一条主线、三件要事、随手记",
    icon: ListTodo,
    build: () =>
      lines(
        "> [!今日主线]",
        `> ${CARET}`,
        "",
        "## :odea_target: 最重要的三件事",
        "",
        "- [ ] ",
        "- [ ] ",
        "- [ ] ",
        "",
        "## 顺手做",
        "",
        "- [ ] ",
        "",
        "## 随手记",
        "",
        "- ",
      ),
  },
  {
    id: "day-timeblock",
    scope: "day",
    name: "时间块",
    description: "一天切成块，计划对照实际",
    icon: Clock,
    build: () =>
      lines(
        `## :odea_hourglass: 时间块${CARET}`,
        "",
        "| 时间 | 计划 | 实际 |",
        "|:---|:---|:---|",
        "| 09:00 – 11:00 | 深度工作：最重要的那件事 |  |",
        "| 11:00 – 12:00 | 沟通、回消息 |  |",
        "| 12:00 – 13:30 | 午饭、休息 |  |",
        "| 13:30 – 15:30 | 深度工作 |  |",
        "| 15:30 – 17:00 | 会议、杂事 |  |",
        "| 17:00 – 17:30 | 收尾，写明天的计划 |  |",
        "| 19:30 – 21:00 | 学习 / 运动 |  |",
      ),
  },
  {
    id: "day-review",
    scope: "day",
    name: "晚间复盘",
    description: "打个分、写四句，五分钟收尾",
    icon: Moon,
    build: () =>
      lines(
        "## :odea_moon: 晚间复盘",
        "",
        "| 精力 /5 | 专注 /5 | 心情 /5 |",
        "|:---:|:---:|:---:|",
        "|  |  |  |",
        "",
        `- **做成了**：${CARET}`,
        "- **卡住了**：",
        "- **学到了**：",
        "- **明天先做**：",
      ),
  },
  {
    id: "day-journal",
    scope: "day",
    name: "三行日记",
    description: "不顺的、开心的、明天的目标",
    icon: PenLine,
    build: () =>
      lines(
        "## :odea_write: 三行日记",
        "",
        `1. **今天最不顺的事**：${CARET}`,
        "2. **今天最开心的事**：",
        "3. **明天的目标**：",
      ),
  },

  /* ---------- 周 ---------- */
  {
    id: "week-plan",
    scope: "week",
    name: "周计划",
    description: "三个重点，每天一件事进日历",
    icon: CalendarRange,
    build: (ctx) => {
      const days = Array.from({ length: 7 }, (_, index) => addDays(ctx.date, index));
      const sunday = days[6]!;
      return lines(
        "> [!本周主题]",
        `> ${CARET}`,
        "",
        "## :odea_target: 三个重点",
        "",
        "- [ ] ",
        "- [ ] ",
        "- [ ] ",
        "",
        "## 每天一件事",
        "",
        // 在日期后面写上事情（可以先写时间：`@… 14:00 开会`），它就出现在日历的那一天；
        // 空着的不会（没写事情的任务不进日历）。日期放前面、末尾留空格：点在行尾接着打就行，
        // 不用瞄准勾选框和日期中间那个空格
        ...days.flatMap((day) => [`- **周${formatWeekdayCN(day)}**`, `  - [ ] @${day} `]),
        "",
        "## 本周不做",
        "",
        "- ",
        ...(upcoming(ctx, sunday)
          ? ["", "## 收尾", "", `- [ ] 周复盘 @${sunday} 20:00 #复盘`]
          : []),
      );
    },
  },
  {
    id: "week-review",
    scope: "week",
    name: "周复盘",
    description: "先清空再回顾，打分和调整",
    icon: History,
    build: () =>
      lines(
        "## :odea_flag: 本周复盘",
        "",
        "### 先过一遍",
        "",
        "- [ ] 清空随手记，要做的写成任务",
        "- [ ] 翻一遍日历：这周漏了什么，下周有什么",
        "- [ ] 没做完的事：挪到下周，或者划掉",
        "",
        "### 打分",
        "",
        "| 重点完成 /3 | 精力 /5 | 满意度 /5 |",
        "|:---:|:---:|:---:|",
        "|  |  |  |",
        "",
        "### 做成了",
        "",
        `- ${CARET}`,
        "",
        "### 没做成，为什么",
        "",
        "- ",
        "",
        "### 下周",
        "",
        "- **继续**：",
        "- **调整**：",
      ),
  },
  {
    id: "week-habits",
    scope: "week",
    name: "习惯打卡",
    description: "七天打卡表，日期已填好",
    icon: CalendarCheck,
    build: (ctx) => {
      const days = Array.from({ length: 7 }, (_, index) => addDays(ctx.date, index));
      const header = days.map((day) => `${formatWeekdayCN(day)} ${fromISODate(day).getDate()}`);
      const row = (habit: string) => `| ${habit} |${"  |".repeat(7)}`;
      return lines(
        `## :odea_sprout: 习惯打卡${CARET}`,
        "",
        `| 习惯 | ${header.join(" | ")} |`,
        `|:---|${":---:|".repeat(7)}`,
        row("运动 30 分钟"),
        row("阅读 20 页"),
        row("23:30 前睡觉"),
        row(""),
      );
    },
  },

  /* ---------- 月 ---------- */
  {
    id: "month-plan",
    scope: "month",
    name: "月度目标",
    description: "目标和衡量标准，拆到每一周",
    icon: Goal,
    build: (ctx) => {
      const last = periodEndOf("month", ctx.date);
      return lines(
        `> [!${formatMonthCN(ctx.date)}的主题]`,
        `> ${CARET}`,
        "",
        "## :odea_target: 目标",
        "",
        "| 目标 | 怎样算完成 | 进度 |",
        "|:---|:---|:---:|",
        "|  |  |  |",
        "|  |  |  |",
        "|  |  |  |",
        "",
        "## 每周节奏",
        "",
        ...weeksOfMonth(ctx.date).map(
          (week) => `- **第 ${week.week} 周** ${shortDate(week.from)} – ${shortDate(week.to)}：`,
        ),
        "",
        "## 本月不做",
        "",
        "- ",
        ...(upcoming(ctx, last) ? ["", "## 收尾", "", `- [ ] 月度复盘 @${last} 20:00 #复盘`] : []),
      );
    },
  },
  {
    id: "month-review",
    scope: "month",
    name: "月度复盘",
    description: "对照目标：继续、停止、开始",
    icon: History,
    build: (ctx) =>
      lines(
        `## :odea_flag: ${formatMonthCN(ctx.date)}复盘`,
        "",
        "### 目标对照",
        "",
        "| 目标 | 结果 | 原因 |",
        "|:---|:---:|:---|",
        "|  |  |  |",
        "|  |  |  |",
        "|  |  |  |",
        "",
        "### 高光时刻",
        "",
        `- ${CARET}`,
        "",
        "### 学到的教训",
        "",
        "- ",
        "",
        "### 下个月",
        "",
        "- **继续**：",
        "- **停止**：",
        "- **开始**：",
      ),
  },

  /* ---------- 年 ---------- */
  {
    id: "year-plan",
    scope: "year",
    name: "年度目标",
    description: "六个方面、季度拆解、回顾节点",
    icon: Mountain,
    build: (ctx) => {
      const year = formatYear(ctx.date);
      const checkpoints: [ISODate, string][] = [
        [`${year}-03-31`, "第一季度回顾"],
        [`${year}-06-30`, "年中回顾"],
        [`${year}-09-30`, "第三季度回顾"],
        [`${year}-12-31`, "年度复盘"],
      ];
      const ahead = checkpoints.filter(([date]) => upcoming(ctx, date));
      return lines(
        `> [!${year} 年的关键词]`,
        `> ${CARET}`,
        "",
        "## :odea_rocket: 六个方面",
        "",
        "| 方面 | 年底想看到的样子 | 怎么衡量 |",
        "|:---|:---|:---|",
        ...["事业", "学习", "健康", "关系", "财务", "爱好"].map((area) => `| ${area} |  |  |`),
        "",
        "## 季度拆解",
        "",
        "- **Q1** 1–3 月：",
        "- **Q2** 4–6 月：",
        "- **Q3** 7–9 月：",
        "- **Q4** 10–12 月：",
        "",
        "## 今年不做",
        "",
        "- ",
        ...(ahead.length
          ? ["", "## 回顾节点", "", ...ahead.map(([date, name]) => `- [ ] ${name} @${date} #复盘`)]
          : []),
      );
    },
  },
  {
    id: "year-review",
    scope: "year",
    name: "年度复盘",
    description: "三个词、做成的事、明年的取舍",
    icon: Sparkles,
    build: (ctx) =>
      lines(
        `## :odea_star: ${formatYear(ctx.date)} 年复盘`,
        "",
        "### 用三个词形容这一年",
        "",
        CARET,
        "",
        "### 做成的事",
        "",
        "1. ",
        "2. ",
        "3. ",
        "",
        "### 没做成的，为什么",
        "",
        "- ",
        "",
        "### 最重要的一课",
        "",
        "- ",
        "",
        "### 想感谢的人",
        "",
        "- ",
        "",
        "### 明年",
        "",
        "- **继续**：",
        "- **停止**：",
        "- **开始**：",
      ),
  },
];

export function templatesFor(scope: TemplateScope): DocTemplate[] {
  return TEMPLATES.filter((template) => template.scope === scope);
}

/** 空文档里的占位提示：告诉人可以从模板开始 */
export function templatePlaceholder(scope: TemplateScope): string {
  return scope === "day"
    ? "写下今天要做的事，或输入 /模板 从模板开始"
    : "写下这个周期的目标，或输入 /模板 从模板开始";
}
