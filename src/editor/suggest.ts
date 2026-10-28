import { type Range, matchKeywords, matchText } from "@/lib/paletteSearch";
import { MOD_KEY, isMac } from "@/lib/platform";
import { sameTitle } from "@/lib/wikilinks";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import {
  Archive,
  Code,
  FilePlus2,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  LayoutTemplate,
  Link,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  ListTree,
  type LucideIcon,
  MessageSquareWarning,
  Minus,
  Quote,
  Sigma,
  Smile,
  Table,
  Workflow,
} from "lucide-react";
import { frontMatterRange } from "./frontMatter";
import { isTemplateTrigger } from "./templates";

/* ============================================================
   编辑器里打字触发的两种补全菜单（界面在 SuggestMenu.tsx）：

   - `/`：一行开头打 `/`（中文输入法下是 `、`），列出能插入的块 —— 标题、待办、表格、
     提示块、公式、图表…… 接着打字筛选，回车插入。表格、公式这些以前只能靠记语法
   - `[[`：列出笔记标题，接着打字筛选，回车补全成 `[[标题]]`。没有这篇就是「链接到
     还没有的笔记」，Ctrl+点击时再新建

   焦点一直留在正文里，像自动补全；触发词不在了（退格、挪光标）菜单自己收起。
   `/模板` 留给模板选择器（templates.ts），这里让开。
   ============================================================ */

export type SuggestKind = "slash" | "wiki";

export interface SuggestTrigger {
  kind: SuggestKind;
  /** `/` 或 `[[` 的位置：插入时从这里换到光标 */
  from: number;
  to: number;
  query: string;
}

/** 行首（只允许前面有空白）的 `/` 或 `、`，后面跟着不带空格的筛选词 */
const SLASH_RE = /^(\s*)[/、]([^\s/、]{0,16})$/;
/** 光标前最近的 `[[`，中间还没有 `]` `|` `#` 和换行 */
const WIKI_RE = /\[\[([^[\]\n|#^]{0,60})$/;

/** 这些节点里打的字是字面量（代码、公式、HTML），不弹菜单 */
const LITERAL = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "CodeText",
  "HTMLBlock",
  "CommentBlock",
  "InlineMath",
  "MathBlock",
]);

function insideLiteral(state: EditorState, pos: number): boolean {
  const front = frontMatterRange(state.doc);
  if (front && pos >= front.from && pos <= front.to) return true;
  for (
    let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(
      pos,
      -1,
    );
    node;
    node = node.parent
  ) {
    if (LITERAL.has(node.name)) return true;
  }
  return false;
}

/** 光标（单个、空选区）前面是不是一个触发词 */
export function suggestTrigger(state: EditorState): SuggestTrigger | null {
  const { ranges, main } = state.selection;
  if (ranges.length !== 1 || !main.empty) return null;
  const head = main.head;
  const line = state.doc.lineAt(head);
  const before = line.text.slice(0, head - line.from);

  const wiki = WIKI_RE.exec(before);
  if (wiki && !insideLiteral(state, head)) {
    return { kind: "wiki", from: line.from + wiki.index, to: head, query: wiki[1]! };
  }

  const slash = SLASH_RE.exec(before);
  if (
    slash &&
    // 光标后面这一行还有字：是在已有的一行开头插了个 `/`，不是要插入一块
    !line.text.slice(head - line.from).trim() &&
    !isTemplateTrigger(line.text) &&
    !insideLiteral(state, head)
  ) {
    return { kind: "slash", from: line.from + slash[1]!.length, to: head, query: slash[2]! };
  }
  return null;
}

/* ---------------- `/` 插入菜单 ---------------- */

/** 插入一段文字；`|` 处是光标（或 [起, 止) 选中一段） */
export type SlashAction =
  | {
      type: "snippet";
      text: string;
      /** 相对 text 开头的光标 / 选区 */
      select: [number, number];
      /** 块级的（表格、分隔线…）：上一行有字的话先空一行，免得被吃进上一段 */
      block?: boolean;
    }
  | { type: "emoji" | "wiki" | "template" };

export interface SlashItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** 右边的小字：快捷键或语法 */
  hint: string;
  keywords: string;
  action: SlashAction;
  /** 只在某一天 / 某个周期的文档里有 */
  templatesOnly?: boolean;
}

const snippet = (text: string, block = false): SlashAction => {
  const caret = text.indexOf("|");
  const clean = caret >= 0 ? text.slice(0, caret) + text.slice(caret + 1) : text;
  const at = caret >= 0 ? caret : clean.length;
  return { type: "snippet", text: clean, select: [at, at], block };
};

const selected = (text: string, word: string, block = false): SlashAction => {
  const at = text.indexOf(word);
  return { type: "snippet", text, select: [at, at + word.length], block };
};

export const SLASH_ITEMS: SlashItem[] = [
  {
    id: "h1",
    label: "一级标题",
    icon: Heading1,
    hint: `${MOD_KEY}+1`,
    keywords: "h1 heading title biaoti bt 标题1 大标题",
    action: snippet("# "),
  },
  {
    id: "h2",
    label: "二级标题",
    icon: Heading2,
    hint: `${MOD_KEY}+2`,
    keywords: "h2 heading title biaoti bt 标题2",
    action: snippet("## "),
  },
  {
    id: "h3",
    label: "三级标题",
    icon: Heading3,
    hint: `${MOD_KEY}+3`,
    keywords: "h3 heading title biaoti bt 标题3 小标题",
    action: snippet("### "),
  },
  {
    id: "todo",
    label: "待办",
    icon: ListTodo,
    hint: "- [ ]",
    keywords: "todo task check daiban db renwu rw 任务 勾选 清单",
    action: snippet("- [ ] "),
  },
  {
    id: "bullet",
    label: "无序列表",
    icon: List,
    hint: isMac ? "-" : `${MOD_KEY}+Shift+]`,
    keywords: "list bullet ul liebiao lb wuxu wx 列表",
    action: snippet("- "),
  },
  {
    id: "ordered",
    label: "有序列表",
    icon: ListOrdered,
    hint: isMac ? "1." : `${MOD_KEY}+Shift+[`,
    keywords: "list ordered ol number liebiao lb youxu yx 编号 列表",
    action: snippet("1. "),
  },
  {
    id: "quote",
    label: "引用",
    icon: Quote,
    hint: isMac ? ">" : `${MOD_KEY}+Shift+Q`,
    keywords: "quote blockquote yinyong yy",
    action: snippet("> "),
  },
  {
    id: "callout",
    label: "提示块",
    icon: MessageSquareWarning,
    hint: "> [!提示]",
    keywords: "callout note tip warning tishi ts zhuyi 注意 警告 提醒 标注",
    action: snippet("> [!提示]\n> "),
  },
  {
    id: "table",
    label: "表格",
    icon: Table,
    hint: isMac ? `${MOD_KEY}+Alt+T` : `${MOD_KEY}+T`,
    keywords: "table biaoge bg 表",
    action: selected("| 标题 | 标题 |\n| --- | --- |\n| 内容 | 内容 |", "标题", true),
  },
  {
    id: "code",
    label: "代码块",
    icon: Code,
    hint: `${MOD_KEY}+Alt+C`,
    keywords: "code fence daima dm 代码",
    action: snippet("```\n|\n```", true),
  },
  {
    id: "math",
    label: "公式",
    icon: Sigma,
    hint: "$$",
    keywords: "math latex katex formula gongshi gs 数学",
    action: snippet("$$\n|\n$$", true),
  },
  {
    id: "mermaid",
    label: "流程图",
    icon: Workflow,
    hint: "mermaid",
    keywords: "mermaid diagram chart flow liucheng lct tubiao 图表 时序图",
    action: selected("```mermaid\ngraph TD\n  A[开始] --> B[结束]\n```", "开始", true),
  },
  {
    id: "divider",
    label: "分隔线",
    icon: Minus,
    hint: "---",
    keywords: "divider hr rule line fengexian fgx 横线",
    action: snippet("---\n", true),
  },
  {
    id: "toc",
    label: "目录",
    icon: ListTree,
    hint: "[TOC]",
    keywords: "toc contents mulu ml 大纲",
    action: snippet("[TOC]\n", true),
  },
  {
    id: "link",
    label: "网页链接",
    icon: Link,
    hint: `${MOD_KEY}+Shift+K`,
    keywords: "link url href lianjie lj 网址",
    action: selected("[链接文字](https://)", "链接文字"),
  },
  {
    id: "wiki",
    label: "链接到笔记",
    icon: Link2,
    hint: "[[",
    keywords: "wiki link note shuanglian sl lianjie lj 双链 引用笔记",
    action: { type: "wiki" },
  },
  {
    id: "emoji",
    label: "动态表情",
    icon: Smile,
    hint: `${MOD_KEY}+E`,
    keywords: "emoji biaoqing bq 表情",
    action: { type: "emoji" },
  },
  {
    id: "template",
    label: "模板",
    icon: LayoutTemplate,
    hint: "/模板",
    keywords: "template muban mb model tpl",
    action: { type: "template" },
    templatesOnly: true,
  },
];

export interface Ranked<T> {
  item: T;
  ranges?: Range[];
}

/** 按筛选词排出来的插入项；没有筛选词时按原来的顺序 */
export function slashItems(query: string, withTemplates: boolean): Ranked<SlashItem>[] {
  const pool = SLASH_ITEMS.filter((item) => withTemplates || !item.templatesOnly);
  const q = query.trim();
  if (!q) return pool.map((item) => ({ item }));
  const scored: { item: SlashItem; ranges?: Range[]; score: number }[] = [];
  for (const item of pool) {
    const hit = matchText(item.label, q);
    if (hit) scored.push({ item, ranges: hit.ranges, score: hit.score });
    else if (matchKeywords(item.keywords, q)) scored.push({ item, score: 50 });
    else if (item.keywords.split(" ").some((word) => word.startsWith(q.toLowerCase()))) {
      scored.push({ item, score: 45 });
    }
  }
  return scored.sort((a, b) => b.score - a.score).map(({ item, ranges }) => ({ item, ranges }));
}

/* ---------------- `[[` 笔记链接 ---------------- */

/** 能链过去的一篇笔记 */
export interface WikiCandidate {
  id: string;
  title: string;
  /** 所在文件夹的显示名（树根这一层直接放着的是空串） */
  folder: string;
  archived: boolean;
}

export type WikiItem =
  | { kind: "note"; note: WikiCandidate }
  /** 还没有这篇：照样写进链接，Ctrl+点击时新建 */
  | { kind: "new"; title: string };

const WIKI_LIMIT = 30;

/** 有筛选词按命中程度排（归档的靠后），没有就是传进来的顺序（最近改过的在前） */
export function wikiItems(query: string, candidates: WikiCandidate[]): Ranked<WikiItem>[] {
  const q = query.trim();
  if (!q) {
    return candidates
      .slice(0, WIKI_LIMIT)
      .map((note) => ({ item: { kind: "note" as const, note } }));
  }
  const scored: { note: WikiCandidate; ranges: Range[]; score: number }[] = [];
  for (const note of candidates) {
    const hit = matchText(note.title, q);
    if (hit) scored.push({ note, ranges: hit.ranges, score: hit.score - (note.archived ? 10 : 0) });
  }
  scored.sort((a, b) => b.score - a.score);
  const out: Ranked<WikiItem>[] = scored
    .slice(0, WIKI_LIMIT)
    .map(({ note, ranges }) => ({ item: { kind: "note", note }, ranges }));
  if (!candidates.some((note) => sameTitle(note.title, q))) {
    out.push({ item: { kind: "new", title: q } });
  }
  return out;
}

/** 列表里那一行的图标 */
export function wikiIcon(item: WikiItem): LucideIcon {
  if (item.kind === "new") return FilePlus2;
  return item.note.archived ? Archive : FileText;
}
