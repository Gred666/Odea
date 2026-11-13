import { FILE_EXTENSIONS, noteEmbedTarget } from "@/lib/embeds";
import { MOD_KEY } from "@/lib/platform";
import { wikiFileTarget } from "@/lib/wikiFiles";
import { syntaxTree } from "@codemirror/language";
import { ChangeSet } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { animatedEmojiFor } from "./animatedEmoji";
import { AttachmentWidget, attachmentHost } from "./attachmentEmbed";
import { typoraBlockDecorations } from "./blockDecorations";
import { type CalloutHead, calloutsVersion, parseCalloutHead } from "./callout";
import {
  BLOCK_START_RE,
  BULLET_GLYPHS,
  CALLOUT_LABEL_RE,
  DEFINITION_RE,
  type DecorationRange,
  FOOTNOTE_DEF_RE,
  FOOTNOTE_RE,
  HEADING_RE,
  LIST_BULLET_WIDTH,
  LIST_DIGIT_WIDTH,
  LIST_ORDERED_WIDTH,
  LIST_TASK_WIDTH,
  RULE_LINE_RE,
  SMART_GLYPHS,
  SMART_RE,
  freshness,
  knownWikiTitles,
  listUnits,
  literalNodes,
  markFreshness,
  selectionTouches,
  toDecorationSet,
  wikiKey,
} from "./decorationKit";
import { EmbedWidget, embedHost, embedKey } from "./embed";
import { emojiFor } from "./emoji";
import { decodeEntity } from "./entities";
import { HeadingGutterWidget, foldedHeads, headingFolds, isFoldableHeading } from "./headingFold";
import { abbrTip } from "./hoverCard";
import {
  INLINE_HTML_TAGS,
  imageBaseDir,
  inlineStyleOf,
  parseTag,
  safeHref,
  safeImageSource,
  wikiImages,
} from "./html";
import { resolveImage, wikiImage } from "./images";
import { linkTargetAt, normalizeLabel, splitWikiTarget } from "./links";
import {
  hiddenMarkerNodes,
  markdownSourceStyleRules,
  rulesByNode,
  selectionEntersRange,
  selectionOpensRange,
  widgetByNode,
} from "./markdownStyleRegistry";
import { MathWidget } from "./math";
import { revealRanges } from "./reveal";
import {
  AnimatedEmojiWidget,
  CalloutBadgeWidget,
  CodeInfoWidget,
  CommentWidget,
  FootnoteWidget,
  GlyphWidget,
  HardBreakWidget,
  type ImageSpec,
  type ImageSyntax,
  ImageWidget,
  LineBreakWidget,
  ListMarkerWidget,
  TaskWidget,
} from "./widgets";

/* 行内装饰层（从 MarkdownEditor.tsx 挪出来，docs/1110审查与研究.md §6.2） */

export interface TyporaInlineState {
  decorations: DecorationSet;
  atomic: DecorationSet;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildInlineDecorations(view: EditorView, changes: ChangeSet | null): TyporaInlineState {
  const { state } = view;
  const fresh = freshness(changes);
  const block = state.field(typoraBlockDecorations, false);
  const foldedLines = block?.foldedLines;
  const referenceLabels = block?.referenceLabels;
  const frontMatter = block?.frontMatter ?? null;
  const abbreviations = block?.abbreviations;
  const abbreviationLines = block?.abbreviationLines;
  const footnotes = block?.footnotes;
  const knownTitles = state.facet(knownWikiTitles);
  const embeds = state.facet(embedHost);
  const attachmentFiles = state.facet(attachmentHost);
  const folded = new Set(foldedHeads(state));
  const ranges: DecorationRange[] = [];
  const atomicRanges: DecorationRange[] = [];
  const lineRanges = new Set<string>();
  const literalRanges: Array<[number, number]> = [];
  /** 表格源码：`==` 之类的源码规则可以进，智能标点和缩写不行（分隔行全是 `---`）。 */
  const tableRanges: Array<[number, number]> = [];
  /** callout 标签所在行的行首；遇到那一行的 `[!标签]` 时换成徽章。 */
  const calloutHeads = new Map<number, CalloutHead>();
  const seenCalloutTitles = new Set<number>();
  /** 已经和开标签配成对、藏掉了的闭标签。 */
  const pairedTags = new Set<number>();
  /** 当前正在处理的可见区间，用来夹住跨区间的行装饰。 */
  let windowFrom = 0;
  let windowTo = state.doc.length;

  if (frontMatter) literalRanges.push([frontMatter.from, frontMatter.to]);

  const addMark = (
    from: number,
    to: number,
    className: string,
    attributes?: Record<string, string>,
  ) => {
    if (from < to)
      ranges.push({ from, to, value: Decoration.mark({ class: className, attributes }) });
  };
  const addReplacement = (from: number, to: number, value: Decoration) => {
    markFreshness(value.spec.widget, from, to, fresh);
    const range = { from, to, value };
    ranges.push(range);
    atomicRanges.push(range);
  };
  /**
   * 图片：替身是插在源码前面的一个点，不盖住源码 —— 光标碰到它时源码在图片下面露出来，
   * 没碰到时把源码藏掉。两种状态是同一个替身，图片原地不动（见 widgets.ts 的 ImageWidget）。
   * 图片独占一行时这一行标上 cm-odea-image-line（源码收着时不留空行，见 globals.css），
   * 露出来的源码画成一行图注
   */
  const addImage = (from: number, to: number, spec: ImageSpec, syntax: ImageSyntax): boolean => {
    // 选区整个包住图片时不算碰到（selectionOpensRange）：拖着选过去，源码不冒出来
    const open = selectionOpensRange(revealRanges(state), from, to);
    const raw = state.sliceDoc(from, to);
    const widget = new ImageWidget(spec, raw, syntax, open);
    markFreshness(widget, from, to, fresh);
    ranges.push({ from, to: from, value: Decoration.widget({ widget, side: -1 }) });
    const line = state.doc.lineAt(from);
    if (to <= line.to && line.text.trim() === raw) {
      addLines(
        line.from,
        line.to,
        open ? "cm-odea-image-line cm-odea-image-source" : "cm-odea-image-line",
      );
    }
    if (open) return true;
    addReplacement(from, to, Decoration.replace({}));
    return false;
  };
  /**
   * `![[笔记]]`、`![[笔记#小节]]` 单独占一行：嵌那一篇（editor/embed.ts）。和图片一样，卡片插在源码前面，
   * 光标碰到时源码在卡片下面露出来（返回 true，接着往里走，源码照常上色）。
   * 不是嵌入 —— 夹在一段字里、附件、块引用、不知道有哪些笔记（做客）—— 返回 null，照旧当图片 / 双链
   */
  const addEmbed = (from: number, to: number): boolean | null => {
    if (!embeds) return null;
    const raw = state.sliceDoc(from, to);
    const inner = /^!\[\[([^\]]+)\]\]$/.exec(raw)?.[1];
    const target = inner === undefined ? null : noteEmbedTarget(inner);
    const line = state.doc.lineAt(from);
    if (!target || to > line.to || line.text.trim() !== raw) return null;
    const open = selectionOpensRange(revealRanges(state), from, to);
    const widget = new EmbedWidget(target, embeds.ids.get(embedKey(target.title)) ?? null, open);
    markFreshness(widget, from, to, fresh);
    ranges.push({ from, to: from, value: Decoration.widget({ widget, side: -1 }) });
    addLines(
      line.from,
      line.to,
      open ? "cm-odea-embed-line cm-odea-embed-source" : "cm-odea-embed-line",
    );
    if (open) return true;
    addReplacement(from, to, Decoration.replace({}));
    return false;
  };
  /**
   * `![[说明书.pdf]]`、`![[录音.m4a]]` 单独占一行：画成附件卡片（editor/attachmentEmbed.ts），做法同上。
   * 不是（夹在一段字里、图片、笔记、没有 attachmentHost）返回 null，照旧当双链
   */
  const addAttachment = (from: number, to: number): boolean | null => {
    if (!attachmentFiles) return null;
    const raw = state.sliceDoc(from, to);
    const inner = /^!\[\[([^\]]+)\]\]$/.exec(raw)?.[1];
    const target = inner === undefined ? null : wikiFileTarget(inner);
    const line = state.doc.lineAt(from);
    if (!target || to > line.to || line.text.trim() !== raw) return null;
    const open = selectionOpensRange(revealRanges(state), from, to);
    const widget = new AttachmentWidget(
      target,
      attachmentFiles.resolve(target.name),
      open,
      attachmentFiles.remote,
    );
    markFreshness(widget, from, to, fresh);
    ranges.push({ from, to: from, value: Decoration.widget({ widget, side: -1 }) });
    addLines(
      line.from,
      line.to,
      open ? "cm-odea-embed-line cm-odea-embed-source" : "cm-odea-embed-line",
    );
    if (open) return true;
    addReplacement(from, to, Decoration.replace({}));
    return false;
  };
  const addSyntaxMarker = (
    from: number,
    to: number,
    visible: boolean,
    className = "cm-odea-syntax-marker",
  ) => {
    if (from >= to) return;
    if (!visible) {
      // Let CodeMirror own the source-to-DOM mapping while the inactive marker is folded.
      // When the range becomes active the real source characters return to normal flow,
      // matching Typora's focused-block editing behaviour.
      addReplacement(from, to, Decoration.replace({}));
      return;
    }
    ranges.push({ from, to, value: Decoration.mark({ class: className }) });
  };
  const addLines = (from: number, to: number, className: string) => {
    // 引用块 / 代码块可能远远长过视口，只给看得见的那几行加类。
    const start = state.doc.lineAt(Math.max(from, windowFrom)).number;
    const end = state.doc.lineAt(Math.min(Math.max(from, to - 1), windowTo)).number;
    for (let number = start; number <= end; number += 1) {
      const line = state.doc.line(number);
      if (foldedLines?.has(line.from)) continue;
      const key = `${line.from}:${className}`;
      if (lineRanges.has(key)) continue;
      lineRanges.add(key);
      ranges.push({ from: line.from, to: line.from, value: Decoration.line({ class: className }) });
    }
  };
  const insideAny = (list: Array<[number, number]>, position: number) =>
    list.some(([from, to]) => position >= from && position < to);

  /* ---------- 列表（几何见 globals.css「列表的几何」） ---------- */

  /** 行上的内联样式（列表的缩进）；一行只写一次 */
  const lineStyle = (from: number, style: string) => {
    const key = `${from}:style`;
    if (lineRanges.has(key)) return;
    lineRanges.add(key);
    ranges.push({ from, to: from, value: Decoration.line({ attributes: { style } }) });
  };

  /** 有序列表的起始编号和每一项是第几个。同一个列表里的项共用，算一次 */
  const orderedLists = new Map<number, { start: number; indexOf: Map<number, number> }>();
  const orderedInfo = (list: SyntaxNode) => {
    const known = orderedLists.get(list.from);
    if (known) return known;
    let start = 1;
    const indexOf = new Map<number, number>();
    for (let child = list.firstChild; child; child = child.nextSibling) {
      if (child.name !== "ListItem") continue;
      if (indexOf.size === 0) {
        const first = child.getChild("ListMark");
        start = first ? Number.parseInt(state.sliceDoc(first.from, first.to), 10) || 1 : 1;
      }
      indexOf.set(child.from, indexOf.size);
    }
    const info = { start, indexOf };
    orderedLists.set(list.from, info);
    return info;
  };

  /** 列表符号的显示文本：有序列表按位置编号，无序按深度换符号。 */
  const listMarkerText = (item: SyntaxNode, list: SyntaxNode, marker: string): string => {
    if (list.name === "OrderedList") {
      const { start, indexOf } = orderedInfo(list);
      return `${start + (indexOf.get(item.from) ?? 0)}${marker.endsWith(")") ? ")" : "."}`;
    }
    let depth = 0;
    for (let ancestor = list.parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.name === "BulletList" || ancestor.name === "OrderedList") depth += 1;
    }
    return BULLET_GLYPHS[depth % BULLET_GLYPHS.length]!;
  };

  /** 这一项开头的 `[ ]` / `[x]`（和列表符号在同一行才算） */
  const taskMarkerOf = (item: SyntaxNode): SyntaxNode | null => {
    const marker = item.getChild("Task")?.firstChild;
    if (marker?.name !== "TaskMarker") return null;
    return state.doc.lineAt(marker.from).from === state.doc.lineAt(item.from).from ? marker : null;
  };

  /**
   * 这一项的符号格多宽、正文那一栏从哪起，单位是正文字号。按语法树的层级算：
   * 子项的符号格接在上一级正文那一栏后面，源码里缩进了几个空格不影响
   */
  const listColumns = new Map<number, { width: number; column: number }>();
  /** 列表项后面只有缩进的那一行 → 它该对齐的正文那一栏（见 decorateListItem） */
  const blankAfterItems = new Map<number, number>();
  const listLayout = (item: SyntaxNode): { width: number; column: number } => {
    const known = listColumns.get(item.from);
    if (known) return known;
    const list = item.parent;
    let width = LIST_BULLET_WIDTH;
    if (taskMarkerOf(item)) {
      width = LIST_TASK_WIDTH;
    } else if (list?.name === "OrderedList") {
      // 同一个列表按最大的那个编号定宽，9 和 10 的点对得齐
      const { start, indexOf } = orderedInfo(list);
      width = LIST_ORDERED_WIDTH + String(start + indexOf.size - 1).length * LIST_DIGIT_WIDTH;
    }
    const parent = list?.parent;
    const outer = parent?.name === "ListItem" ? listLayout(parent).column : 0;
    const layout = { width, column: outer + width };
    listColumns.set(item.from, layout);
    return layout;
  };

  /**
   * 列表项的第一行：缩进格 + 符号格 + 正文，折行悬挂到正文那一栏。光标在符号上
   * （行首到正文开头之间）时圆点 / 勾选框换回源码，格子一样宽；光标在正文里时不换 ——
   * 以前一进这一项整行就露出 `- `，正文往左跳一下。
   */
  const decorateListItem = (item: SyntaxNode): void => {
    const mark = item.getChild("ListMark");
    const list = item.parent;
    if (!mark || !list) return;
    const line = state.doc.lineAt(mark.from);
    if (line.to < windowFrom || line.from > windowTo || foldedLines?.has(line.from)) return;
    const { width, column } = listLayout(item);
    const task = taskMarkerOf(item);
    let contentStart = (task ?? mark).to;
    while (contentStart < line.to && /[ \t]/.test(state.sliceDoc(contentStart, contentStart + 1))) {
      contentStart += 1;
    }
    lineStyle(line.from, `padding-left: ${listUnits(column)}; text-indent: ${listUnits(-column)}`);
    // 这一项后面紧跟的、只有缩进的一行（在列表项里插完图片光标落下的那一行）：缩进够得着
    // 这一项的正文那一栏，就还算这一项的，画在那一栏上。语法树里它不属于任何一项
    const last = state.doc.lineAt(item.to);
    if (last.number < state.doc.lines) {
      const next = state.doc.line(last.number + 1);
      const indent = (contentStart < line.to ? contentStart : mark.to + 1) - line.from;
      if (next.length >= indent && next.length > 0 && !next.text.trim()) {
        blankAfterItems.set(next.from, Math.max(column, blankAfterItems.get(next.from) ?? 0));
      }
    }
    if (mark.from > line.from) {
      addMark(line.from, mark.from, "cm-odea-list-indent", {
        style: `width: ${listUnits(column - width)}`,
      });
    }
    const box = `width: ${listUnits(width)}`;
    const active = revealRanges(state).some((range) =>
      range.empty
        ? range.head >= line.from && range.head < contentStart
        : range.from < contentStart &&
          range.to > line.from &&
          (range.from > line.from || range.to < contentStart),
    );
    if (active) {
      const className = task
        ? "cm-odea-list-marker is-source is-task"
        : "cm-odea-list-marker is-source";
      addMark(mark.from, contentStart, className, { style: box });
      return;
    }
    const widget = task
      ? new TaskWidget(/x/i.test(state.sliceDoc(task.from, task.to)), task.from - mark.from)
      : new ListMarkerWidget(listMarkerText(item, list, state.sliceDoc(mark.from, mark.to)), box);
    addReplacement(mark.from, contentStart, Decoration.replace({ widget }));
  };

  /** 同一项里第一行以后的段落、标题、图片：和第一行的正文对齐，行首的空格放进缩进格 */
  const decorateListContinuation = (block: SyntaxNode, item: SyntaxNode): void => {
    const { column } = listLayout(item);
    const first = state.doc.lineAt(item.from).number + 1;
    const start = state.doc.lineAt(Math.max(block.from, windowFrom)).number;
    const end = state.doc.lineAt(Math.min(block.to, windowTo)).number;
    for (let number = Math.max(start, first); number <= end; number += 1) {
      const line = state.doc.line(number);
      if (foldedLines?.has(line.from)) continue;
      const indent = /^[ \t]*/.exec(line.text)![0].length;
      if (indent === line.length) continue;
      if (!indent) {
        lineStyle(line.from, `padding-left: ${listUnits(column)}`);
        continue;
      }
      lineStyle(
        line.from,
        `padding-left: ${listUnits(column)}; text-indent: ${listUnits(-column)}`,
      );
      addMark(line.from, line.from + indent, "cm-odea-list-indent", {
        style: `width: ${listUnits(column)}`,
      });
    }
  };

  /**
   * 行内 HTML：`<b>`、`<mark>`、`<span style>` 这些白名单标签配对后映射成样式类，
   * 标签本身像 `**` 一样藏起来。找闭标签只在同一个父节点的兄弟里找 —— 跨段落
   * 的标签永远配不上对。
   */
  const decorateHtmlTag = (node: SyntaxNode, selfActive: boolean): void => {
    const source = state.sliceDoc(node.from, node.to);
    const tag = parseTag(source);
    if (!tag) {
      addMark(node.from, node.to, "cm-odea-html");
      return;
    }
    if (tag.name === "br" && !tag.closing) {
      if (selfActive) addMark(node.from, node.to, "cm-odea-html");
      else
        addReplacement(node.from, node.to, Decoration.replace({ widget: new LineBreakWidget() }));
      return;
    }
    if (tag.name === "img" && !tag.closing) {
      const source = safeImageSource(tag.attrs.src, state.facet(imageBaseDir));
      const spec: ImageSpec | null = source
        ? {
            alt: tag.attrs.alt ?? "",
            source,
            title: tag.attrs.title ?? "",
            width: Number(tag.attrs.width) || null,
            height: Number(tag.attrs.height) || null,
          }
        : null;
      if (!spec || addImage(node.from, node.to, spec, "html")) {
        addMark(node.from, node.to, "cm-odea-html");
      }
      return;
    }
    const className = INLINE_HTML_TAGS[tag.name];
    if (!className || tag.closing || tag.selfClosing) {
      addMark(node.from, node.to, "cm-odea-html");
      return;
    }
    // 往后找同名闭标签；中间再遇到同名开标签就要多配一个
    let depth = 0;
    let close: SyntaxNode | null = null;
    for (let sibling = node.nextSibling; sibling; sibling = sibling.nextSibling) {
      if (sibling.name !== "HTMLTag") continue;
      const other = parseTag(state.sliceDoc(sibling.from, sibling.to));
      if (!other || other.name !== tag.name || other.selfClosing) continue;
      if (!other.closing) {
        depth += 1;
        continue;
      }
      if (depth === 0) {
        close = sibling;
        break;
      }
      depth -= 1;
    }
    if (!close) {
      addMark(node.from, node.to, "cm-odea-html");
      return;
    }
    pairedTags.add(close.from);
    const attributes: Record<string, string> = {};
    const style = inlineStyleOf(tag);
    if (style) attributes.style = style;
    if (tag.name === "a") {
      const href = safeHref(tag.attrs.href);
      if (href) {
        attributes["data-href"] = href;
        attributes.title = `${href}\n${MOD_KEY}+点击打开`;
      }
    }
    if (tag.name === "abbr" && tag.attrs.title) {
      Object.assign(attributes, abbrTip(state.sliceDoc(node.to, close.from), tag.attrs.title));
    }
    addMark(node.to, close.from, className, attributes);
    const visible = selectionTouches(state, node.from, close.to);
    addSyntaxMarker(node.from, node.to, visible);
    addSyntaxMarker(close.from, close.to, visible);
  };

  /** 段落里的定义列表（`术语` 下一行 `: 释义`）和脚注定义行。 */
  const decorateParagraphLines = (node: SyntaxNode): void => {
    const first = state.doc.lineAt(Math.max(node.from, windowFrom)).number;
    const last = state.doc.lineAt(Math.min(node.to, windowTo)).number;
    for (let number = first; number <= last; number += 1) {
      const line = state.doc.line(number);
      if (foldedLines?.has(line.from)) continue;

      const footnote = FOOTNOTE_DEF_RE.exec(line.text);
      if (footnote) {
        addLines(line.from, line.to, "cm-odea-footnote-def");
        const labelTo = line.from + footnote[1]!.length + 3;
        if (selectionTouches(state, line.from, labelTo + 1)) {
          addMark(line.from, labelTo + 1, "cm-odea-footnote-source");
        } else {
          addReplacement(
            line.from,
            line.from + footnote[0].length,
            Decoration.replace({ widget: new FootnoteWidget(footnote[1]!, "def") }),
          );
        }
        continue;
      }

      const definition = DEFINITION_RE.exec(line.text);
      if (!definition || number === 1) continue;
      // 上一行是术语（中间隔一个空行也算，Markdown Extra 允许）；
      // 连续几行 `: ` 共用同一个术语，所以上一行本身是释义时不再标术语。
      let term = state.doc.line(number - 1);
      if (!term.text.trim() && number >= 3) term = state.doc.line(number - 2);
      const termInParagraph = term.from >= node.from;
      if (!term.text.trim() || (!termInParagraph && BLOCK_START_RE.test(term.text))) continue;
      if (!DEFINITION_RE.test(term.text) && !foldedLines?.has(term.from)) {
        addLines(term.from, term.to, "cm-odea-dt");
      }
      addLines(line.from, line.to, "cm-odea-dd");
      const markerTo = line.from + definition[0].length;
      addSyntaxMarker(line.from, markerTo, selectionTouches(state, line.from, line.to));
    }
  };

  for (const visible of view.visibleRanges) {
    windowFrom = visible.from;
    windowTo = visible.to;
    syntaxTree(state).iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        const { name } = node.type;
        if (frontMatter && name !== "Document" && node.from < frontMatter.to) return false;
        const line = state.doc.lineAt(node.from);
        // 所在行已被块级层整行折叠：行内标记、语言名等都不用再渲染。
        if (foldedLines?.has(line.from) && node.to <= line.to) return false;

        const owner = node.node.parent;
        const parentName = owner?.name;
        const syntaxActive = selectionTouches(
          state,
          owner?.from ?? node.from,
          owner?.to ?? node.to,
        );
        /** 节点自身是否被光标碰到。行内小构造（Emoji、转义、图片）只看自己。 */
        const selfActive = selectionTouches(state, node.from, node.to);

        if (literalNodes.has(name)) literalRanges.push([node.from, node.to]);
        if (name === "Table") tableRanges.push([node.from, node.to]);
        if (name === "CodeBlock") {
          // 缩进（四个空格）的代码块没有围栏封口：上下两条边由第一行、最后一行自己画
          const last = state.doc.lineAt(node.to);
          addLines(line.from, line.to, "cm-odea-code-edge is-top");
          addLines(last.from, last.to, "cm-odea-code-edge is-bottom");
        }
        // 围栏里挂着的是别的语言的语法树，交给 codeHighlight，这里不下探。
        if (name === "CodeText") {
          addMark(node.from, node.to, "cm-odea-code-text");
          return false;
        }

        const heading = HEADING_RE.exec(name);
        if (heading && !lineRanges.has(`${line.from}:heading`)) {
          lineRanges.add(`${line.from}:heading`);
          ranges.push({
            from: line.from,
            to: line.from,
            value: Decoration.line({ class: `cm-odea-h${heading[1]}` }),
          });
          // 行左边留白里的层级提示和收起箭头（headingFold.ts）
          const foldable = isFoldableHeading(node.node);
          ranges.push({
            from: line.from,
            to: line.from,
            value: Decoration.widget({
              widget: new HeadingGutterWidget(
                Number(heading[1]),
                foldable,
                foldable && folded.has(line.from),
              ),
              side: -1,
            }),
          });
        }

        if (name === "ListItem") decorateListItem(node.node);
        if (
          owner &&
          parentName === "ListItem" &&
          (name === "Paragraph" || name === "Task" || heading)
        ) {
          decorateListContinuation(node.node, owner);
        }

        if (name === "Paragraph") {
          decorateParagraphLines(node.node);
          return;
        }

        /* ---------- 引用块：普通引用按层级缩进；`> [!标签]` 起头的是 callout ---------- */
        if (name === "Blockquote") {
          const head = parseCalloutHead(line.text);
          if (head) {
            calloutHeads.set(line.from, head);
            addLines(node.from, node.to, `cm-odea-callout is-${head.kind}`);
            addLines(line.from, line.to, "cm-odea-callout-head");
            const tail = state.doc.lineAt(node.to);
            addLines(tail.from, tail.to, "cm-odea-callout-tail");
            // 正文被折叠时头行就是最后一行可见的行，圆角要落在它身上
            if (
              tail.number > line.number &&
              foldedLines?.has(state.doc.line(line.number + 1).from)
            ) {
              addLines(line.from, line.to, "cm-odea-callout-tail");
            }
            // 正文折叠会把可见区间切成两段，这个引用块可能被进入两次；标题只标一次
            // （行装饰有 lineRanges 去重，行内 mark 没有）
            if (head.title && !seenCalloutTitles.has(line.from)) {
              seenCalloutTitles.add(line.from);
              const titleFrom =
                line.to - head.title.length - (line.text.length - line.text.trimEnd().length);
              addMark(titleFrom, titleFrom + head.title.length, "cm-odea-callout-title");
            }
            return;
          }
          let depth = 1;
          for (let ancestor = owner; ancestor; ancestor = ancestor.parent) {
            if (ancestor.name === "Blockquote") depth += 1;
          }
          addLines(node.from, node.to, `cm-odea-quote cm-odea-quote-d${Math.min(depth, 4)}`);
          return;
        }

        const widget = widgetByNode.get(name);
        // 勾选框和列表符号是一格，在 decorateListItem 里一起处理
        if (widget === "task") return false;
        if (widget === "image") {
          // `![[笔记]]` 也是一个图片节点（`![` 加一个 `[笔记]` 的短引用）
          const embedded = addEmbed(node.from, node.to) ?? addAttachment(node.from, node.to);
          if (embedded === false) return false;
          const raw = state.sliceDoc(node.from, node.to);
          // Obsidian 的 `![[图.png]]`：按名字在仓库里找（嵌一篇笔记的 `![[笔记]]` 上面认过了）
          const image =
            (embedded === null ? wikiImage(raw, state.facet(wikiImages)) : null) ??
            resolveImage(state.doc.toString(), raw, state.facet(imageBaseDir));
          const syntax = raw.startsWith("![[") ? "wiki" : "markdown";
          // 源码没露出来就不用往里走了；露出来了照常给 `![`、`](` 这些标记上色
          if (image && !addImage(node.from, node.to, image, syntax)) return false;
        }
        if (widget === "emoji") {
          const source = state.sliceDoc(node.from, node.to);
          const animated = animatedEmojiFor(source);
          if (animated) {
            if (selectionEntersRange(revealRanges(state), node.from, node.to)) {
              addMark(node.from, node.to, "cm-odea-glyph-source");
            } else {
              addReplacement(
                node.from,
                node.to,
                Decoration.replace({ widget: new AnimatedEmojiWidget(animated, source) }),
              );
            }
            return false;
          }
          const glyph = emojiFor(source);
          if (glyph && !selfActive) {
            addReplacement(
              node.from,
              node.to,
              Decoration.replace({
                widget: new GlyphWidget("emoji", glyph, source),
              }),
            );
          } else {
            addMark(node.from, node.to, glyph ? "cm-odea-glyph-source" : "cm-odea-emoji-unknown");
          }
          return false;
        }
        if (widget === "entity") {
          const source = state.sliceDoc(node.from, node.to);
          const glyph = decodeEntity(source);
          if (glyph && !selfActive) {
            addReplacement(
              node.from,
              node.to,
              Decoration.replace({
                widget: new GlyphWidget("entity", glyph, source),
              }),
            );
          } else {
            addMark(node.from, node.to, "cm-odea-html");
          }
          return false;
        }
        if (widget === "hard-break") {
          // 节点末尾是换行符本身，替换范围必须停在它前面，否则两行会被拼成一行。
          const markerTo = node.to - 1;
          if (markerTo > node.from) {
            if (selectionTouches(state, node.from, markerTo)) {
              addMark(node.from, markerTo, "cm-odea-syntax-marker");
            } else {
              addReplacement(
                node.from,
                markerTo,
                Decoration.replace({ widget: new HardBreakWidget() }),
              );
            }
          }
          return false;
        }
        if (widget === "math") {
          const source = state.sliceDoc(node.from, node.to);
          if (selfActive) {
            addMark(node.from, node.to, "cm-odea-math-source");
            return;
          }
          const display = source.startsWith("$$");
          const tex = source.slice(display ? 2 : 1, display ? -2 : -1).trim();
          addReplacement(
            node.from,
            node.to,
            Decoration.replace({
              widget: new MathWidget(tex, false),
            }),
          );
          return false;
        }
        if (name === "MathMark") {
          addMark(node.from, node.to, "cm-odea-syntax-marker");
          return false;
        }
        if (widget === "html-tag") {
          if (pairedTags.has(node.from)) return false;
          decorateHtmlTag(node.node, selfActive);
          return false;
        }
        if (widget === "comment") {
          // 光标在这一行时露出源码，否则收成一个「注释」标记
          if (selectionTouches(state, line.from, state.doc.lineAt(node.to).to)) {
            addMark(node.from, node.to, "cm-odea-html");
          } else {
            addReplacement(
              node.from,
              node.to,
              Decoration.replace({ widget: new CommentWidget(false) }),
            );
          }
          return false;
        }
        if (name === "Escape") {
          // 只藏反斜杠，被转义的那个字符照常显示。
          addSyntaxMarker(node.from, node.from + 1, selfActive);
          return false;
        }
        // 表格和分隔线整行都归块级层管，这里不重复处理。

        if (name === "ListMark") return false;

        if (name === "CodeInfo" && !syntaxActive) {
          addReplacement(
            node.from,
            node.to,
            Decoration.replace({
              widget: new CodeInfoWidget(state.sliceDoc(node.from, node.to)),
            }),
          );
          return;
        }

        /* ---------- 方括号家族：callout 标签、脚注、双链，以及真正的引用链接 ---------- */
        if (name === "Link") {
          const text = state.sliceDoc(node.from, node.to);
          const shortcut = !node.node.getChild("URL") && !node.node.getChild("LinkLabel");
          if (shortcut) {
            const head = calloutHeads.get(line.from);
            const calloutLabel = head && CALLOUT_LABEL_RE.exec(text);
            if (head && calloutLabel) {
              const headActive = selectionTouches(state, line.from, line.to);
              // 折叠符离徽章开头多远（徽章从 `[` 起，折叠符紧跟在 `]` 后面）
              const foldOffset = head.fold ? line.from + head.foldOffset - node.from : null;
              if (headActive) {
                addMark(node.from, node.to, "cm-odea-callout-label");
                addSyntaxMarker(node.from, node.from + 2, true);
                addSyntaxMarker(node.to - 1, node.to + (head.fold ? 1 : 0), true);
              } else {
                addReplacement(
                  node.from,
                  node.to + (head.fold ? 1 : 0),
                  Decoration.replace({
                    widget: new CalloutBadgeWidget(head, foldOffset),
                  }),
                );
              }
              return false;
            }

            const footnote = FOOTNOTE_RE.exec(text);
            if (footnote) {
              // 行首的 `[^id]:` 是定义，段落那边已经处理过了
              if (node.from === line.from && state.sliceDoc(node.to, node.to + 1) === ":") {
                return false;
              }
              if (selfActive) {
                addMark(node.from, node.to, "cm-odea-footnote-source");
              } else {
                addReplacement(
                  node.from,
                  node.to,
                  Decoration.replace({
                    widget: new FootnoteWidget(
                      footnote[1]!,
                      "ref",
                      footnotes?.get(footnote[1]!) ?? "",
                    ),
                  }),
                );
              }
              return false;
            }

            const wiki =
              state.sliceDoc(node.from - 1, node.from) === "[" &&
              state.sliceDoc(node.to, node.to + 1) === "]";
            if (wiki) {
              const outerFrom = node.from - 1;
              const outerTo = node.to + 1;
              const inner = text.slice(1, -1);
              const pipe = inner.indexOf("|");
              const target = splitWikiTarget((pipe >= 0 ? inner.slice(0, pipe) : inner).trim());
              // `[[目标|别名]]`：不激活时只显示别名
              const displayFrom = pipe >= 0 ? node.from + 1 + pipe + 1 : node.from + 1;
              const active = selectionTouches(state, outerFrom, outerTo);
              addSyntaxMarker(outerFrom, displayFrom, active);
              addSyntaxMarker(node.to - 1, outerTo, active);
              const where = target.heading
                ? `${target.title} › ${target.heading}`
                : target.block
                  ? `${target.title} › ^${target.block}`
                  : target.title;
              // 链到还没有的笔记：画成虚线，Ctrl+点击新建（DocumentView 的 handleWikiLink）。
              // `[[图.png]]`、`[[说明书.pdf]]` 链的是附件，不是笔记
              const missing =
                !!knownTitles &&
                !knownTitles.has(wikiKey(target.title)) &&
                !FILE_EXTENSIONS.test(target.title);
              addMark(
                displayFrom,
                node.to - 1,
                missing ? "cm-odea-wikilink is-missing" : "cm-odea-wikilink",
                {
                  title: missing
                    ? `还没有「${target.title}」这篇笔记\n${MOD_KEY}+点击新建`
                    : `${where}\n${MOD_KEY}+点击打开`,
                },
              );
              return false;
            }

            // 普通的 `[文字]`：文档里有对应的 `[文字]: 地址` 才是链接，否则就是方括号文本。
            if (!referenceLabels?.has(normalizeLabel(text))) return false;
          }

          const url = linkTargetAt(state, node.from);
          addMark(
            node.from,
            node.to,
            "cm-odea-link",
            url ? { title: `${url}\n${MOD_KEY}+点击打开` } : undefined,
          );
          return;
        }

        if (name === "LinkReference") {
          // 脚注定义（`[^id]: 一个词`）会被解析成引用定义；走和段落一样的行处理
          decorateParagraphLines(node.node);
          const label = node.node.getChild("LinkLabel");
          if (label && FOOTNOTE_RE.test(state.sliceDoc(label.from, label.to))) return false;
        }

        const rule = rulesByNode.get(name);
        if (rule?.kind === "mark") addMark(node.from, node.to, rule.className);
        else if (rule?.kind === "line") addLines(node.from, node.to, rule.className);

        const inLink = parentName === "Link" || parentName === "Image";
        const hiddenLinkDestination = name === "URL" && inLink;
        const hiddenReferenceLabel = name === "LinkLabel" && inLink;
        // 标题跟在地址后面（`[文字](地址 "标题")`），和地址一起藏；单独出现时照藏。
        const hiddenLinkTitle =
          name === "LinkTitle" && inLink && node.node.prevSibling?.name !== "URL";
        if (
          (hiddenMarkerNodes.has(name) ||
            hiddenLinkDestination ||
            hiddenReferenceLabel ||
            hiddenLinkTitle) &&
          node.from < node.to
        ) {
          let markerTo = node.to;
          if (
            (name === "HeaderMark" || name === "QuoteMark") &&
            state.sliceDoc(node.to, node.to + 1) === " "
          ) {
            markerTo = node.to + 1;
          }
          if (hiddenLinkDestination && node.node.nextSibling?.name === "LinkTitle") {
            markerTo = node.node.nextSibling.to;
          }
          if (name === "QuoteMark") {
            // 引用的 `>` 只在光标碰到它自己时露出来，画在这一层竖线右边的留白里
            // （globals.css）—— 以前光标进引用块的任何地方，每一行都露出 `> `，整块字往右跳
            const level = state.sliceDoc(line.from, node.from).split(">").length;
            addSyntaxMarker(
              node.from,
              markerTo,
              selectionTouches(state, node.from, markerTo),
              `cm-odea-syntax-marker is-quote is-q${Math.min(level, 4)}`,
            );
            return;
          }
          addSyntaxMarker(
            node.from,
            markerTo,
            syntaxActive,
            name === "HeaderMark" ? "cm-odea-syntax-marker is-heading" : undefined,
          );
        }
      },
    });
  }
  for (const [from, column] of blankAfterItems) {
    if (lineRanges.has(`${from}:style`)) continue;
    lineStyle(from, `padding-left: ${listUnits(column)}; text-indent: ${listUnits(-column)}`);
    addMark(from, state.doc.lineAt(from).to, "cm-odea-list-indent", {
      style: `width: ${listUnits(column)}`,
    });
  }

  // 源码级规则放在语法树之后：需要先知道哪些区间是代码字面量。
  const insideLiteral = (position: number) => insideAny(literalRanges, position);
  const insideTable = (position: number) => insideAny(tableRanges, position);
  for (const visible of view.visibleRanges) {
    const source = state.sliceDoc(visible.from, visible.to);
    for (const rule of markdownSourceStyleRules) {
      const symmetric = rule.open === rule.close;
      let cursor = 0;
      while (cursor < source.length) {
        const open = source.indexOf(rule.open, cursor);
        if (open < 0) break;
        const contentFrom = open + rule.open.length;
        const docOpen = visible.from + open;
        // 开标记落在代码字面量里，或者整行都是 `=`（Setext 的下划线）：它根本不是
        // 标记，只跳过它自己。以前会把它和后面某个真标记配成一对、再把那个真标记
        // 吃掉，一条 `===` 下划线就让整屏之后的 ==高亮== 全部错位。
        if (insideLiteral(docOpen) || RULE_LINE_RE.test(state.doc.lineAt(docOpen).text)) {
          cursor = contentFrom;
          continue;
        }
        const close = source.indexOf(rule.close, contentFrom);
        if (close < 0) break;
        const content = source.slice(contentFrom, close);
        const docClose = visible.from + close;
        // 配不上对的开标记（内容为空 / 首尾是空白 / 闭标记在字面量里 / 中间隔了
        // 空行跨到别的段落）：从它后面重新找，别把闭标记也一起跳过。
        // `a == b == c` 这种普通文字就是靠「首尾不能是空白」挡下来的。
        if (
          (symmetric && (!content || /^\s|\s$/.test(content))) ||
          insideLiteral(docClose) ||
          /\n[ \t]*\n/.test(content)
        ) {
          cursor = contentFrom;
          continue;
        }
        cursor = close + rule.close.length;
        const docContent = visible.from + contentFrom;
        const docEnd = visible.from + cursor;
        addMark(docContent, docClose, rule.className);
        const markersVisible = selectionTouches(state, docOpen, docEnd);
        addSyntaxMarker(docOpen, docContent, markersVisible);
        addSyntaxMarker(docClose, docEnd, markersVisible);
      }
    }

    /* ---------- 智能标点：`--` `---` `...` (c) (r) (tm) 只在显示层替换 ---------- */
    for (const match of source.matchAll(SMART_RE)) {
      const from = visible.from + match.index;
      const to = from + match[0].length;
      const line = state.doc.lineAt(from);
      if (foldedLines?.has(line.from)) continue;
      if (insideLiteral(from) || insideTable(from) || RULE_LINE_RE.test(line.text)) continue;
      // `- --x` 这类列表符号、`--- ` 开头的 YAML 之类都不该动：只替换夹在文字里的
      if (selectionTouches(state, from, to)) continue;
      const glyph = SMART_GLYPHS[match[0].toLowerCase()]!;
      addReplacement(
        from,
        to,
        Decoration.replace({ widget: new GlyphWidget("smart", glyph, match[0]) }),
      );
    }

    /* ---------- 缩写：正文里出现 `*[缩写]: 全称` 定义过的词，加悬停提示 ---------- */
    if (abbreviations?.size) {
      for (const [abbreviation, expansion] of abbreviations) {
        const pattern = new RegExp(
          `(?<![\\p{L}\\p{N}_])${escapeRegExp(abbreviation)}(?![\\p{L}\\p{N}_])`,
          "gu",
        );
        for (const match of source.matchAll(pattern)) {
          const from = visible.from + match.index;
          const line = state.doc.lineAt(from);
          if (abbreviationLines?.has(line.from) || foldedLines?.has(line.from)) continue;
          if (insideLiteral(from) || insideTable(from)) continue;
          addMark(
            from,
            from + abbreviation.length,
            "cm-odea-abbr",
            abbrTip(abbreviation, expansion),
          );
        }
      }
    }
  }

  return { decorations: toDecorationSet(ranges), atomic: toDecorationSet(atomicRanges) };
}

/**
 * 行内装饰层。fresh：刚挂上时替身算不算新出现（正文照常播入场动画；表格格子里的子编辑器不播 ——
 * 点进格子时格子里的公式、表情是原来就在的，再淡入一次就是「闪一下」）
 */
const inlineDecorationsPlugin = (fresh: boolean) =>
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      atomic: DecorationSet;
      /** 插件登记的提示块是哪一版（徽章的配色、图标跟着它） */
      callouts = calloutsVersion();

      constructor(view: EditorView) {
        const built = buildInlineDecorations(
          view,
          fresh ? null : ChangeSet.empty(view.state.doc.length),
        );
        this.decorations = built.decorations;
        this.atomic = built.atomic;
      }

      update(update: ViewUpdate) {
        // 视口滚动同样要重算 —— 行内装饰只覆盖看得见的那一段；
        // 快速滚到还没解析的地方时，后台解析赶上来（语法树换了）也要重算一次。
        if (
          update.docChanged ||
          update.viewportChanged ||
          revealRanges(update.startState) !== revealRanges(update.state) ||
          syntaxTree(update.startState) !== syntaxTree(update.state) ||
          update.startState.field(headingFolds, false) !==
            update.state.field(headingFolds, false) ||
          update.startState.facet(imageBaseDir) !== update.state.facet(imageBaseDir) ||
          update.startState.facet(wikiImages) !== update.state.facet(wikiImages) ||
          update.startState.facet(knownWikiTitles) !== update.state.facet(knownWikiTitles) ||
          update.startState.facet(embedHost) !== update.state.facet(embedHost) ||
          update.startState.facet(attachmentHost) !== update.state.facet(attachmentHost) ||
          this.callouts !== calloutsVersion()
        ) {
          this.callouts = calloutsVersion();
          // 只动了光标 / 视口时 changes 是空的：这时重建出来的替身不再重放入场动画
          const built = buildInlineDecorations(update.view, update.changes);
          this.decorations = built.decorations;
          this.atomic = built.atomic;
        }
      }
    },
    {
      decorations: (value) => value.decorations,
      provide: (plugin) =>
        EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
    },
  );

export const typoraInlineDecorations = inlineDecorationsPlugin(true);
export const cellInlineDecorations = inlineDecorationsPlugin(false);
