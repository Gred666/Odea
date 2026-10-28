import { commonmarkLanguage, markdown } from "@codemirror/lang-markdown";
import type { LanguageDescription } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import {
  type BlockContext,
  Emoji,
  GFM,
  type InlineContext,
  type LeafBlock,
  type LeafBlockParser,
  type Line,
  type MarkdownConfig,
  type MarkdownExtension,
  parser as baseParser,
} from "@lezer/markdown";

/* ============================================================
   解析器配置。

   在 CommonMark + GFM 之上自己拼，而不是直接用 lang-markdown 的
   markdownLanguage —— 那一套把单个 `~` 给了 Pandoc 下标，`~x~` 永远
   不可能是删除线。这里按 GitHub 的规矩来：一个或两个 `~` 都是删除线，
   下标改走 `<sub>` 标签。

   另外加了 `$…$` / `$$…$$` 数学公式的节点：公式必须在解析阶段就被整块
   认下来，否则 `$a*b$ 和 $c*d$` 里的两个 `*` 会被当成一对强调标记。

   上标 `^x^` 也是自己的：lezer 自带的那个会吞掉中文句子里的脚注，见下面。
   ============================================================ */

const DOLLAR = 36;
const TILDE = 126;
const BACKSLASH = 92;
const NEWLINE = 10;
const CARET = 94;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;

const isSpace = (code: number) => code === 32 || code === 9 || code === NEWLINE;
const isDigit = (code: number) => code >= 48 && code <= 57;
const PUNCTUATION = /[\p{P}\p{S}]/u;

/**
 * 行内公式：`$x$`，或写在同一行里的 `$$x$$`。
 * 按 Pandoc 的规矩：开头的 `$` 后面不能是空白，结尾的 `$` 前面不能是空白、
 * 后面不能紧跟数字 —— 这样「$5 和 $10」不会被当成公式。
 */
function parseInlineMath(cx: InlineContext, next: number, pos: number): number {
  if (next !== DOLLAR) return -1;
  const display = cx.char(pos + 1) === DOLLAR;
  const open = display ? 2 : 1;
  const start = pos + open;
  if (start >= cx.end) return -1;
  if (!display && (isSpace(cx.char(start)) || cx.char(start) === DOLLAR)) return -1;

  for (let i = start; i < cx.end; i += 1) {
    const code = cx.char(i);
    if (code === BACKSLASH) {
      i += 1;
      continue;
    }
    if (code === NEWLINE) return -1;
    if (code !== DOLLAR) continue;
    if (display) {
      if (cx.char(i + 1) !== DOLLAR || i === start) continue;
      return cx.addElement(
        cx.elt("InlineMath", pos, i + 2, [
          cx.elt("MathMark", pos, start),
          cx.elt("MathMark", i, i + 2),
        ]),
      );
    }
    if (i === start || isSpace(cx.char(i - 1)) || isDigit(cx.char(i + 1))) continue;
    return cx.addElement(
      cx.elt("InlineMath", pos, i + 1, [
        cx.elt("MathMark", pos, start),
        cx.elt("MathMark", i, i + 1),
      ]),
    );
  }
  return -1;
}

const startsMathBlock = (line: Line) =>
  line.next === DOLLAR && line.text.charCodeAt(line.pos + 1) === DOLLAR;

/**
 * 这一行还处在多少层容器块（引用、列表）里。运行时有、类型里没导出 ——
 * FencedCode 自己就是拿它和 cx.depth 比来判断围栏有没有被容器截断的。
 */
const lineDepth = (line: Line) => (line as unknown as { depth: number }).depth;

/**
 * 公式块：`$$` 起头，到某一行以 `$$` 结尾为止（可以是同一行）。
 * 没闭合就一直到文档末尾 —— 和围栏代码一个脾气。
 */
function parseMathBlock(cx: BlockContext, line: Line): boolean {
  if (!startsMathBlock(line)) return false;
  const from = cx.lineStart + line.pos;
  const marks = [cx.elt("MathMark", from, from + 2)];

  const rest = line.text.slice(line.pos + 2).trimEnd();
  if (rest.length >= 2 && rest.endsWith("$$")) {
    const to = from + 2 + rest.length;
    marks.push(cx.elt("MathMark", to - 2, to));
    cx.nextLine();
    cx.addElement(cx.elt("MathBlock", from, to, marks));
    return true;
  }

  while (cx.nextLine() && lineDepth(line) >= cx.depth) {
    const text = line.text.slice(line.pos).trimEnd();
    if (!text.endsWith("$$")) continue;
    const to = cx.lineStart + line.pos + text.length;
    marks.push(cx.elt("MathMark", to - 2, to));
    cx.nextLine();
    cx.addElement(cx.elt("MathBlock", from, to, marks));
    return true;
  }
  cx.addElement(cx.elt("MathBlock", from, cx.prevLineEnd(), marks));
  return true;
}

const MathExtension: MarkdownConfig = {
  defineNodes: [
    { name: "InlineMath", style: t.special(t.content) },
    { name: "MathBlock", block: true, style: t.special(t.content) },
    { name: "MathMark", style: t.processingInstruction },
  ],
  parseInline: [{ name: "InlineMath", parse: parseInlineMath, before: "Emphasis" }],
  parseBlock: [
    {
      name: "MathBlock",
      parse: parseMathBlock,
      // `$$` 可以直接打断段落，不用先空一行
      endLeaf: (_cx, line) => startsMathBlock(line),
      before: "LinkReference",
    },
  ],
};

/* ---------------- Setext 标题：比 CommonMark 收紧两条 ----------------
   - 下划线至少三个 `=` / `-`。CommonMark 一个就算：在一段字的下一行刚敲一个 `-`（要写列表，
     或者 `- - -` 分隔线的头一个字），上面那段立刻变成二级标题，再敲一个空格又变回来；
     敲 `==` 开个高亮也一样，闪成一级标题
   - 标题只能是一行。CommonMark 里一整段都会变成标题：在几行字和下面的 `---` 中间插一行
     （比如敲 `/` 叫出插入菜单），整段突然成了二级标题（编辑器只给第一行上了标题样式，
     看着就是最上面那行莫名其妙变大）。这时按分隔线算：段落到此为止，`---` 是分隔线

   做法：lezer 自带的 Setext 解析器留在列表里 —— 分隔线判断「这一行是不是 Setext 下划线、
   该不该让给它」认的就是它本身，拿掉了 `标题\n---` 就永远是分隔线 —— 只是每一段开头
   把它那一份换成这里的。 */

const EQUALS = 61;
const DASH = 45;
/** 至少几个 `=` / `-` 才算下划线 */
const MIN_UNDERLINE = 3;

/** lezer 自带的 Setext 解析器的类：没导出，从基础解析器上拿它的工厂造一个看看 */
const DefaultSetextParser = (() => {
  const internals = baseParser as unknown as {
    blockNames: string[];
    leafBlockParsers: Array<((cx: unknown, leaf: unknown) => LeafBlockParser | null) | undefined>;
  };
  const factory = internals.leafBlockParsers?.[internals.blockNames?.indexOf("SetextHeading")];
  return factory?.(null, null)?.constructor as (abstract new () => LeafBlockParser) | undefined;
})();

/** Setext 下划线：一串 `=` 或 `-`（中间不夹空格），后面只能是空白。返回那串有几个，不是返回 -1 */
function underlineLength(line: Line): number {
  if ((line.next !== EQUALS && line.next !== DASH) || line.indent >= line.baseIndent + 4) return -1;
  let pos = line.pos + 1;
  while (pos < line.text.length && line.text.charCodeAt(pos) === line.next) pos += 1;
  const end = pos;
  while (pos < line.text.length && isSpace(line.text.charCodeAt(pos))) pos += 1;
  return pos === line.text.length ? end - line.pos : -1;
}

class StrictSetextParser implements LeafBlockParser {
  nextLine(cx: BlockContext, line: Line, leaf: LeafBlock): boolean {
    if (lineDepth(line) < cx.depth) return false;
    const length = underlineLength(line);
    if (length < 0) return false;
    const dash = line.next === DASH;
    if (length >= MIN_UNDERLINE && !leaf.content.includes("\n")) {
      const from = cx.lineStart + line.pos;
      const mark = cx.elt("HeaderMark", from, from + length);
      cx.nextLine();
      cx.addLeafElement(
        leaf,
        cx.elt(dash ? "SetextHeading2" : "SetextHeading1", leaf.start, cx.prevLineEnd(), [
          ...cx.parser.parseInline(leaf.content, leaf.start),
          mark,
        ]),
      );
      return true;
    }
    // 多行的段落下面的 `---`：段落到此为止，这一行留给下一轮当分隔线（和分隔线打断段落一个走法）
    if (dash && length >= MIN_UNDERLINE) {
      (cx as unknown as { finishLeaf(leaf: LeafBlock): void }).finishLeaf(leaf);
      return true;
    }
    // 一两个 `-` / `=`，或者多行段落下面的 `===`：就是段落里的一行字
    return false;
  }

  finish() {
    return false;
  }
}

const StrictSetextHeading: MarkdownConfig = {
  parseBlock: [
    {
      name: "StrictSetextHeading",
      // 排在自带的 Setext 后面：轮到这里时它那一份已经放进 leaf.parsers 了
      leaf(_cx, leaf) {
        const index = DefaultSetextParser
          ? leaf.parsers.findIndex((parser) => parser instanceof DefaultSetextParser)
          : -1;
        if (index >= 0) leaf.parsers[index] = new StrictSetextParser();
        return null;
      },
      after: "SetextHeading",
    },
  ],
};

/** 单个 `~` 的删除线。复用 GFM 的节点名，装饰层不用知道它是一个还是两个波浪线。 */
const SingleTildeDelimiter = { resolve: "Strikethrough", mark: "StrikethroughMark" };

const SingleTildeStrikethrough: MarkdownConfig = {
  parseInline: [
    {
      name: "SingleTildeStrikethrough",
      after: "Strikethrough",
      parse(cx, next, pos) {
        if (next !== TILDE || cx.char(pos + 1) === TILDE || cx.char(pos - 1) === TILDE) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 1, pos + 2);
        const spaceBefore = /\s|^$/.test(before);
        const spaceAfter = /\s|^$/.test(after);
        const punctBefore = PUNCTUATION.test(before);
        const punctAfter = PUNCTUATION.test(after);
        return cx.addDelimiter(
          SingleTildeDelimiter,
          pos,
          pos + 1,
          !spaceAfter && (!punctAfter || spaceBefore || punctBefore),
          !spaceBefore && (!punctBefore || spaceAfter || punctAfter),
        );
      },
    },
  ],
};

/**
 * 上标 `^x^`。节点名和 lezer 自带的 Superscript 一样，只多两条限制：
 * - 紧跟在 `[` 后面的 `^` 不开上标 —— 那是脚注 `[^id]`；
 * - 往后找闭合的 `^` 时，碰到 `[` / `]` 就放弃，上标不跨方括号。
 *
 * 自带的那个只在碰到空白时放弃。中文句子不带空格，于是
 * 「正文[^1]，接着写[^2]」里的 `^1]，接着写[^` 整段被认成上标，
 * 两个脚注都不见了；`[[标题^块]]` 后面再出现一个 `^` 也是同样下场。
 */
function parseSuperscript(cx: InlineContext, next: number, pos: number): number {
  if (next !== CARET || cx.char(pos + 1) === CARET || cx.char(pos - 1) === OPEN_BRACKET) {
    return -1;
  }
  const marks = [cx.elt("SuperscriptMark", pos, pos + 1)];
  for (let i = pos + 1; i < cx.end; i += 1) {
    const code = cx.char(i);
    if (code === CARET) {
      return cx.addElement(
        cx.elt("Superscript", pos, i + 1, [...marks, cx.elt("SuperscriptMark", i, i + 1)]),
      );
    }
    if (code === BACKSLASH) {
      marks.push(cx.elt("Escape", i, i + 2));
      i += 1;
      continue;
    }
    if (isSpace(code) || code === OPEN_BRACKET || code === CLOSE_BRACKET) return -1;
  }
  return -1;
}

const SuperscriptExtension: MarkdownConfig = {
  defineNodes: [
    { name: "Superscript", style: t.special(t.content) },
    { name: "SuperscriptMark", style: t.processingInstruction },
  ],
  parseInline: [{ name: "Superscript", parse: parseSuperscript }],
};

/** 编辑器用的全部 Markdown 解析扩展；单测直接拿它配到 commonmark 上。 */
export const markdownExtensions: MarkdownExtension = [
  GFM,
  StrictSetextHeading,
  SingleTildeStrikethrough,
  SuperscriptExtension,
  Emoji,
  MathExtension,
];

/** 编辑器的语言支持。围栏代码按语言名懒加载对应解析器。 */
export function markdownSupport(codeLanguages?: readonly LanguageDescription[]) {
  return markdown({ base: commonmarkLanguage, extensions: markdownExtensions, codeLanguages });
}
