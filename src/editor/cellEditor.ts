import { commonEnds } from "@/lib/lineDiff";
import { defaultKeymap } from "@codemirror/commands";
import { Language, LanguageSupport, defineLanguageFacet } from "@codemirror/language";
import {
  Annotation,
  ChangeSet,
  EditorSelection,
  EditorState,
  type Extension,
  Facet,
  Prec,
  Text,
  Transaction,
} from "@codemirror/state";
import { EditorView, type KeyBinding, keymap } from "@codemirror/view";
import { parser as baseParser } from "@lezer/markdown";
import { escapeBlockTags } from "./htmlTable";
import { clearMarkdownFormat, insertLink, wrapMarkdown } from "./markdownCommands";
import { markdownExtensions } from "./markdownParser";
import { type TableFormat, gfmCellSource } from "./markdownTable";
import { selectionLayer } from "./selectionLayer";
import { smoothCaret } from "./smoothCaret";

/* ============================================================
   表格格子里的子编辑器（docs/表格.md §7、P13.3）。

   只给正在改的那一格建一个 CodeMirror，装正文的行内装饰层：光标碰到的 `**` 才露出来，
   光标、选区是自己画的，和正文一个手感。文档是这一格的源码，换了两处写法：
   - `<br>` 是真的换行（一格里的几行就是几行，↑↓ 先在格子里走）
   - `\|` 还原成 `|`（写回时再转义，和以前一样打 `|` 不用管）

   改动不进子编辑器自己的历史：每改一次按差异写回正文（只换变了的那几个字，协同靠它），
   撤销走正文的历史，正文变了再按差异跟过来，光标跟着改动挪。

   组字（输入法）时不写回：拼音不进正文、不发给协作的人；别人这时改了这一格也先不跟，
   免得打断输入法。组完字一起写回，期间别人改的按 ChangeSet 合到一起（`rebase`），谁的字都不丢。
   ============================================================ */

/** 正文提供给子编辑器的扩展（行内装饰层、双链标题、图片目录），按正文现在的状态给 */
export const cellEditorExtensions = Facet.define<(main: EditorState) => Extension>();

/** 子编辑器里「正文跟过来」的改动：不再写回 */
const cellSync = Annotation.define<boolean>();

/* ---------------- 格子的写法 ↔ 子编辑器里的文字 ---------------- */

const BREAK_RE = /<br\s*\/?>/gi;

/** 一格的源码（TableData 里的样子）→ 子编辑器里的文字 */
export function cellToEditor(source: string, format: TableFormat): string {
  if (format === "markdown") return source.replace(BREAK_RE, "\n").replace(/\\\|/g, "|");
  // HTML 源码里的换行只是空白；`<br>` 才是格子里的换行
  if (format === "html") return source.replace(/\s*\n\s*/g, " ").replace(BREAK_RE, "\n");
  return source;
}

/**
 * 子编辑器里的文字 → 这一格的源码：GFM 换行写成 `<br>`、`|` 补转义、两头空白去掉；
 * 整格只有 `<`、`^` 的写成 `\<`、`\^`（不然成了合并记号，见 tableGrid.ts）。
 * HTML 的格子里打出来的块级标签写成字（htmlTable.ts 的 escapeBlockTags）
 */
export function cellFromEditor(text: string, format: TableFormat): string {
  if (format === "markdown") return gfmCellSource(text);
  if (format === "html") {
    const flat = escapeBlockTags(text.replace(/\r?\n/g, "<br>").trim());
    return flat === "<" || flat === "^" ? `\\${flat}` : flat;
  }
  return text.trim();
}

/* ---------------- 语言：格子里只有行内语法 ---------------- */

/** 块级的写法在格子里都是普通字：`# x`、`- x`、`> x` 不是标题、列表、引用 */
const BLOCK_PARSERS = [
  "LinkReference",
  "IndentedCode",
  "FencedCode",
  "Blockquote",
  "HorizontalRule",
  "BulletList",
  "OrderedList",
  "ATXHeading",
  "HTMLBlock",
  "SetextHeading",
  "StrictSetextHeading",
  "Table",
  "TaskList",
  "MathBlock",
];

/** HTML 表格的格子是 HTML：`**`、反引号、`[链接]()` 都是字，只认标签和实体 */
const MARKDOWN_INLINE = [
  "Escape",
  "InlineCode",
  "Emphasis",
  "HardBreak",
  "Link",
  "Image",
  "LinkEnd",
  "Strikethrough",
  "SingleTildeStrikethrough",
  "Autolink",
  "Superscript",
  "Emoji",
  "InlineMath",
];

const languages = new Map<TableFormat, LanguageSupport>();

function cellLanguage(format: "markdown" | "html"): LanguageSupport {
  let support = languages.get(format);
  if (!support) {
    // 先配好全部扩展再去掉：去掉和加进来写在同一次 configure 里时，GFM 的表格是后加的，去不掉
    const parser = baseParser.configure(markdownExtensions).configure({
      remove: format === "html" ? [...BLOCK_PARSERS, ...MARKDOWN_INLINE] : BLOCK_PARSERS,
    });
    support = new LanguageSupport(new Language(defineLanguageFacet(), parser, [], "markdown"));
    languages.set(format, support);
  }
  return support;
}

/** 格子里的格式快捷键：GFM 包 Markdown 记号，HTML 包标签，CSV 没有格式 */
function formatKeys(format: TableFormat): KeyBinding[] {
  if (format === "markdown") {
    return [
      { key: "Mod-b", run: wrapMarkdown("**") },
      { key: "Mod-i", run: wrapMarkdown("*") },
      { key: "Mod-u", run: wrapMarkdown("<u>", "</u>") },
      { key: "Shift-Mod-`", run: wrapMarkdown("`") },
      { key: "Alt-Shift-5", mac: "Ctrl-Shift-`", run: wrapMarkdown("~~") },
      { key: "Shift-Mod-k", run: insertLink() },
      { key: "Mod-\\", run: clearMarkdownFormat() },
    ];
  }
  if (format === "html") {
    return [
      { key: "Mod-b", run: wrapMarkdown("<b>", "</b>") },
      { key: "Mod-i", run: wrapMarkdown("<i>", "</i>") },
      { key: "Mod-u", run: wrapMarkdown("<u>", "</u>") },
      { key: "Shift-Mod-`", run: wrapMarkdown("<code>", "</code>") },
      { key: "Alt-Shift-5", mac: "Ctrl-Shift-`", run: wrapMarkdown("<s>", "</s>") },
    ];
  }
  return [];
}

/* ---------------- 两边的改动合到一起 ---------------- */

/** before → after 的最少改动（掐头去尾）。文字里可以有换行（CSV 的格子） */
function diffChange(before: string, after: string): ChangeSet {
  const [head, tail] = commonEnds(before, after);
  return ChangeSet.of(
    before === after
      ? []
      : [{ from: head, to: before.length - tail, insert: after.slice(head, after.length - tail) }],
    before.length,
  );
}

/**
 * 同一份 base，这边改成了 ours、那边改成了 theirs：把这边的改动挪到那边的结果上。
 * 两边改的不是同一处时谁的都在；改了同一处时都留着，这边的插在后面
 */
export function rebase(base: string, ours: string, theirs: string): string {
  const mine = diffChange(base, ours);
  const other = diffChange(base, theirs);
  return mine
    .map(other)
    .apply(Text.of(theirs.split("\n")))
    .toString();
}

/* ---------------- 子编辑器 ---------------- */

export interface CellEditorOptions {
  /** 放进哪个格子（格子原来的内容先清掉） */
  parent: HTMLElement;
  /** 正文：行内装饰层、双链标题从它那里来 */
  main: EditorView;
  format: TableFormat;
  /** 这一格现在的源码（每次都现读：协同、撤销会改它） */
  read: () => string;
  /** 把这一格写成 next（调用方算出最少的源码改动写进正文） */
  write: (next: string) => void;
  /** 光标放在子编辑器文字的第几个字（"end" 是最后） */
  caret: number | "end";
  /** 表格的按键：比格子自己的（格式、移动光标）先拿到 */
  keys: KeyBinding[];
  /** 粘贴：返回 true 表示处理掉了（贴进来的是一块格子） */
  paste: (event: ClipboardEvent) => boolean;
  /** 只读（协作时只能看）：能放光标、选字、复制，不能改 */
  readOnly?: boolean;
}

export class CellEditor {
  readonly view: EditorView;
  /** 子编辑器上一次和正文对上时，这一格的源码 */
  private base: string;
  /** 正在把子编辑器的改动写回正文：这时正文变了不用跟 */
  private writing = false;
  /**
   * 子编辑器里有还没写回的改动（组字期间、刚组完字还没写回）。这时正文变了不能直接拿正文盖过来 ——
   * 那是吞字：组完字到写回之间别人的字先到了，刚上屏的词就没了（scripts/perf/table-ime.mjs same 抓到的）
   */
  private dirty = false;
  private pullQueued = false;
  /** 上一次 compositionend 的时刻 */
  private composedAt = Number.NEGATIVE_INFINITY;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(private readonly options: CellEditorOptions) {
    const { main, format } = options;
    const source = options.read();
    this.base = source;
    const text = cellToEditor(source, format);
    const caret = options.caret === "end" ? text.length : Math.min(options.caret, text.length);
    const rich = format === "markdown" || format === "html";
    const extensions: Extension[] = [
      EditorView.lineWrapping,
      EditorState.readOnly.of(!!options.readOnly),
      EditorView.editorAttributes.of({ class: `cm-odea-cell-editor is-${format}` }),
      EditorView.contentAttributes.of({ "aria-label": "表格格子" }),
      smoothCaret,
      selectionLayer,
      Prec.highest(keymap.of(options.keys)),
      Prec.highest(
        EditorView.domEventHandlers({
          paste: (event) => {
            if (!options.paste(event)) return false;
            event.preventDefault();
            return true;
          },
          // 拖进来的文件不进格子（CodeMirror 自己会把文本文件的内容整个插进来）；拖字照常
          drop: (event) => {
            if (!event.dataTransfer?.files.length) return false;
            event.preventDefault();
            return true;
          },
          // 组完字：CodeMirror 读进最后那一下之后一起写回（最后一下常常在 compositionend 之后的微任务里）
          compositionend: () => {
            this.composedAt = performance.now();
            this.settle();
            return false;
          },
        }),
      ),
      keymap.of([...formatKeys(format), ...defaultKeymap]),
    ];
    if (rich) {
      extensions.push(
        cellLanguage(format),
        main.state.facet(cellEditorExtensions).map((provide) => provide(main.state)),
      );
    }
    options.parent.replaceChildren();
    this.view = new EditorView({
      parent: options.parent,
      state: EditorState.create({
        doc: text,
        selection: EditorSelection.cursor(caret),
        extensions,
      }),
      dispatchTransactions: (transactions, view) => {
        view.update(transactions);
        if (
          transactions.some(
            (transaction) => transaction.docChanged && !transaction.annotation(cellSync),
          )
        ) {
          this.dirty = true;
          this.push();
        }
      },
    });
  }

  /** 子编辑器里的文字写成源码的样子 */
  get value(): string {
    return cellFromEditor(this.view.state.doc.toString(), this.options.format);
  }

  get composing(): boolean {
    return this.view.compositionStarted;
  }

  focus() {
    this.view.focus();
  }

  /**
   * 子编辑器里的字写回去就是这一格的源码：一模一样，或者只差写法（`<br/>` 和 `<br>`、空格子里的空格）。
   * 只差写法的不算改了 —— 不然点进格子什么都没改，收起时也把源码换成了自己的写法
   */
  private matches(source: string): boolean {
    const { format } = this.options;
    const value = this.value;
    return value === source || value === cellFromEditor(cellToEditor(source, format), format);
  }

  /** 子编辑器里改了：写回正文。force：收起子编辑器时，组字到一半也写回 */
  private push(force = false) {
    if (this.destroyed || (this.composing && !force)) return;
    const ours = this.value;
    const theirs = this.options.read();
    if (this.matches(theirs)) {
      this.base = theirs;
      this.dirty = false;
      return;
    }
    // 组字期间别人也改了这一格：两边合到一起再写，不把别人的字盖掉
    const next = this.base === theirs ? ours : rebase(this.base, ours, theirs);
    this.writing = true;
    try {
      this.options.write(next);
    } finally {
      this.writing = false;
    }
    this.dirty = false;
    if (this.destroyed) return;
    this.base = this.options.read();
    // 合过之后子编辑器里缺别人的那几个字：跟过来
    this.pull();
  }

  /**
   * 正文里这一格变了（撤销、协同、另一个窗格里改的）：跟过来，光标按改动挪。
   * inUpdate：在正文的 update 里调的（表格替身的 updateDOM）—— 这时不能写回正文，
   * 要写回的（自己还有没写回的、刚组完字）挪到这一轮之后
   */
  pull(inUpdate = false) {
    if (this.destroyed || this.writing || this.composing) return;
    if (this.dirty || this.justComposed()) {
      if (inUpdate) {
        this.pullSoon();
        return;
      }
      // 派发之前先把 DOM 里还没读进来的输入读完：派发会清掉没读的（collab/binding.ts 同一个坑）
      this.readPendingInput();
      if (this.destroyed || this.composing) return;
      // 自己还有没写回的：先合到一起写回（push 写完会再来一次 pull）
      if (this.dirty) {
        this.push();
        return;
      }
    }
    const source = this.options.read();
    if (this.matches(source)) {
      this.base = source;
      return;
    }
    const target = cellToEditor(source, this.options.format);
    const current = this.view.state.doc.toString();
    this.base = source;
    if (current === target) return;
    this.view.dispatch({
      changes: diffChange(current, target),
      annotations: [cellSync.of(true), Transaction.remote.of(true)],
    });
  }

  private pullSoon() {
    if (this.pullQueued) return;
    this.pullQueued = true;
    queueMicrotask(() => {
      this.pullQueued = false;
      this.pull();
    });
  }

  /** 刚组完一个词（CodeMirror 可能还没读进最后那一下） */
  private justComposed(): boolean {
    return performance.now() - this.composedAt < 200;
  }

  /**
   * CodeMirror 还没从 DOM 读进来的输入（组字刚结束，最后那一下排在微任务里）现在读：
   * 用的是内部接口 view.observer.flush（collab/binding.ts 的 readPendingInput 一样）；认不出来就算了
   */
  private readPendingInput() {
    const observer = (this.view as unknown as { observer?: { flush?: () => unknown } }).observer;
    if (typeof observer?.flush === "function") observer.flush();
  }

  /** compositionend 之后等这一轮事件过去：还在组下一个词就接着等 */
  private settle() {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.destroyed || this.composing) return;
      this.push();
      this.pull();
    }, 0);
  }

  /** 光标所在的这一行是不是格子里最上（下）面那一截：↑↓ 再走就出这一格了 */
  atVerticalEdge(forward: boolean): boolean {
    const { state } = this.view;
    const { main } = state.selection;
    if (!main.empty) return false;
    const line = state.doc.lineAt(main.head);
    if (forward ? line.number < state.doc.lines : line.number > 1) return false;
    // 一行折成了好几截：比一比光标和这一行头（尾）是不是在同一截上
    const here = this.view.coordsAtPos(main.head, forward ? -1 : 1);
    const edge = this.view.coordsAtPos(forward ? line.to : line.from, forward ? -1 : 1);
    if (!here || !edge) return true;
    return forward ? edge.bottom - here.bottom < 2 : here.top - edge.top < 2;
  }

  /** 光标在文字的最前（最后）面、没有选中东西 */
  atEdge(end: boolean): boolean {
    const { main } = this.view.state.selection;
    return main.empty && main.head === (end ? this.view.state.doc.length : 0);
  }

  /** 字全选中了（或者是空格子）：Mod+A 再按一下就选整张表 */
  get allSelected(): boolean {
    const { main } = this.view.state.selection;
    return main.from === 0 && main.to === this.view.state.doc.length;
  }

  /** 光标在子编辑器文字里的位置 */
  get caret(): number {
    return this.view.state.selection.main.head;
  }

  set caret(offset: number) {
    const anchor = Math.min(offset, this.view.state.doc.length);
    this.view.dispatch({ selection: { anchor }, annotations: cellSync.of(true) });
  }

  /** 选中的字（没选中是空串） */
  get selectedText(): string {
    const { main } = this.view.state.selection;
    return this.view.state.sliceDoc(main.from, main.to);
  }

  /** 在光标处插入文字（替换选中的；text 是空串就是删掉选中的） */
  insert(text: string, userEvent = "input") {
    this.view.dispatch(this.view.state.replaceSelection(text), {
      userEvent,
      scrollIntoView: true,
    });
  }

  destroy() {
    if (this.destroyed) return;
    // 还没写回的（组字到一半就点走了、Tab 到下一格）先写回
    this.push(true);
    this.destroyed = true;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.view.destroy();
  }
}
