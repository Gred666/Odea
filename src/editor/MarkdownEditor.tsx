import type { Attachment, MatchAnchor, OutlineItem } from "@/data/types";
import { registerEditorCommands } from "@/lib/editorCommands";
import { MOD_KEY } from "@/lib/platform";
import { rememberSpot, spotOf } from "@/lib/viewMemory";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { closeSearchPanel, search, searchPanelOpen, setSearchQuery } from "@codemirror/search";
import {
  Annotation,
  type ChangeSet,
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  Facet,
  Prec,
  StateField,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  type WidgetType,
  keymap,
  placeholder,
} from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { Link2, Plus } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EmojiPicker, type EmojiPickerAnchor } from "./EmojiPicker";
import { SuggestMenu, type SuggestMenuHandle, type SuggestRow } from "./SuggestMenu";
import { TemplatePicker, type TemplatePickerHandle } from "./TemplatePicker";
import {
  type AnimatedEmoji,
  animatedEmojiFor,
  forgetDetachedEmoji,
  primeIntro,
} from "./animatedEmoji";
import { type AttachHooks, attachmentHandlers, watchDesktopFileDrops } from "./attachments";
import { type CalloutHead, parseCalloutHead } from "./callout";
import { codeHighlight } from "./codeHighlight";
import { type DebouncedSaver, createDebouncedSaver } from "./debouncedSave";
import { DiagramWidget } from "./diagram";
import { emojiFor } from "./emoji";
import { decodeEntity } from "./entities";
import { type FrontMatterRange, frontMatterRange } from "./frontMatter";
import { glideTo } from "./glide";
import {
  FoldedSectionWidget,
  HeadingGutterWidget,
  foldAllHeadings,
  foldMarks,
  foldedHeads,
  foldsOnlyMoved,
  headingFoldExtension,
  headingFolds,
  isFoldableHeading,
  outermostSections,
  restoreFolds,
  unfoldAllHeadings,
} from "./headingFold";
import { abbrTip, hoverCard } from "./hoverCard";
import {
  INLINE_HTML_TAGS,
  imageBaseDir,
  inlineStyleOf,
  parseTag,
  resolveImageSource,
  safeHref,
  safeImageSource,
} from "./html";
import { inlinePlainText } from "./inlineDom";
import {
  linkTargetAt,
  modKeyCursor,
  normalizeLabel,
  openExternal,
  splitWikiTarget,
  wikiTargetAt,
} from "./links";
import { markdownKeymap } from "./markdownKeymap";
import { markdownSupport } from "./markdownParser";
import {
  hiddenMarkerNodes,
  markdownSourceStyleRules,
  rulesByNode,
  selectionEntersRange,
  selectionOpensRange,
  selectionTouchesRange,
  widgetByNode,
} from "./markdownStyleRegistry";
import { type MarkdownTableModel, parseDelimitedTable, parseMarkdownTable } from "./markdownTable";
import { MathWidget } from "./math";
import { revealField, revealIdle, revealRanges, trackEditing } from "./reveal";
import { registerEditorFlush } from "./saveBus";
import { createSearchPanel, matchOnLine, queryOfAnchor, scrollToMatch } from "./searchPanel";
import { selectionLayer } from "./selectionLayer";
import { smoothCaret } from "./smoothCaret";
import {
  type SlashItem,
  type SuggestKind,
  type SuggestTrigger,
  type WikiCandidate,
  type WikiItem,
  slashItems,
  suggestTrigger,
  wikiIcon,
  wikiItems,
} from "./suggest";
import { TableWidget } from "./tableWidget";
import {
  type DocTemplate,
  type TemplateContext,
  type TemplateMode,
  applyTemplate,
  carriedTasks,
  hasOtherContent,
  templatePlaceholder,
  templateTrigger,
  templatesFor,
} from "./templates";
import {
  AnimatedEmojiWidget,
  CalloutBadgeWidget,
  CalloutFoldWidget,
  CodeFenceWidget,
  CodeInfoWidget,
  CommentWidget,
  FootnoteWidget,
  FrontMatterFenceWidget,
  GlyphWidget,
  HardBreakWidget,
  HorizontalRuleWidget,
  HtmlBlockWidget,
  type ImageSpec,
  type ImageSyntax,
  ImageWidget,
  LineBreakWidget,
  ListMarkerWidget,
  OtwWidget,
  TaskWidget,
  type TocEntry,
  TocWidget,
} from "./widgets";

/**
 * Typora 式 Markdown 编辑器。
 *
 * 文档始终是 Markdown 源文；非当前语法范围只隐藏标记并施加排版样式，光标进入
 * 后标记在原位置重新出现，所以 `#`、`**`、链接等都能直接修改，不存在富文本
 * AST 与 Markdown 互转导致的输入跳行或内容漂移。
 */

/** 外部内容回填产生的事务，不该被当成用户输入去触发保存。 */
const externalSync = Annotation.define<boolean>();

/* ---------------- 按文档缓存编辑器状态 ----------------
   建一个编辑器最贵的是 EditorState.create：同步解析全文的语法树（ensureSyntaxTree）
   再算一遍块级装饰。66KB 的「语法全览」生产包里要 110ms，切换笔记就卡这一下。

   EditorState 是不可变的值，里面有解析好的语法树、装饰、撤销历史。切走时把它存起来，
   切回来时直接拿它建视图：不用再解析，撤销历史也还在。

   状态里有一截配置握着上一个编辑器实例的闭包（保存器、React 的 setState）——
   那一截放在 session 这个 compartment 里，复用时换成新实例的。其余扩展是整个
   状态的一部分，原样沿用。 */

const session = new Compartment();
/** 这篇文档所在的文件夹（相对图片路径的基准）：改名、仓库路径晚到时单独换掉 */
const imageBaseSlot = new Compartment();
/** 有哪些笔记标题：新建、改名、删掉笔记时单独换掉 */
const wikiTitlesSlot = new Compartment();

/**
 * 所有笔记的标题（trim + 小写，和 lib/wikilinks 的 sameTitle 同一个口径）。
 * 链到不存在的笔记的 `[[双链]]` 画成虚线，提示 Ctrl+点击新建。null 是不知道，都当存在。
 */
export const knownWikiTitles = Facet.define<ReadonlySet<string> | null, ReadonlySet<string> | null>(
  { combine: (values) => values[0] ?? null },
);

const wikiKey = (title: string) => title.trim().toLowerCase();

/** 笔记的空白正文里显示的提示（某一天 / 某个周期的用 templatePlaceholder） */
const NOTE_PLACEHOLDER = "写点什么…　输入 / 插入标题、待办、表格，[[ 链接到别的笔记";
/** 最近切走的这么多篇留着。大文档一篇的状态有几 MB，不能无限留 */
const STATE_CACHE_LIMIT = 12;
const stateCache = new Map<string, EditorState>();

function rememberState(key: string, state: EditorState) {
  stateCache.delete(key);
  stateCache.set(key, state);
  while (stateCache.size > STATE_CACHE_LIMIT) {
    const oldest = stateCache.keys().next().value;
    if (oldest === undefined) break;
    stateCache.delete(oldest);
  }
}

/** 拿出这篇的缓存。正文和现在要显示的不一样（切走期间被外部改过、保存失败换成了草稿）就不用了 */
function takeState(key: string, markdown: string): EditorState | null {
  const cached = stateCache.get(key);
  stateCache.delete(key);
  if (!cached || cached.doc.length !== markdown.length) return null;
  return cached.doc.toString() === markdown ? cached : null;
}

/** 测试用：清空缓存 */
export function clearEditorStateCache() {
  stateCache.clear();
}

/** 查找面板（searchPanel.ts）和跳转到行的中文文案。@codemirror/search 的默认标签是英文的。 */
const searchPhrases = EditorState.phrases.of({
  "Go to line": "跳转到行",
  go: "跳转",
  Find: "查找",
  Replace: "替换为",
  next: "下一个",
  previous: "上一个",
  "match case": "区分大小写 (Alt+C)",
  "by word": "全词匹配 (Alt+W)",
  regexp: "正则表达式 (Alt+R)",
  replace: "替换",
  "replace all": "全部替换",
  "Toggle replace": "替换",
  "No results": "无结果",
  "Invalid regexp": "正则有误",
  close: "关闭",
  "current match": "当前匹配",
  "on line": "位于行",
});

export function MarkdownEditor({
  initialMarkdown,
  onSave,
  outlineItems,
  onOutlineHandle,
  onDocumentChange,
  onWikiLink,
  fill = true,
  cacheKey,
  externalRevision = 0,
  onExternalConflict,
  templateContext,
  imageBase = null,
  onAttachFiles,
  onAttachPaths,
  linkTargets,
  linkSelf,
  onExitTop,
}: {
  initialMarkdown: string;
  onSave: (markdown: string) => Promise<void>;
  outlineItems: OutlineItem[];
  onOutlineHandle: (handle: EditorOutlineHandle | null) => void;
  /** 正文变化时回调，供目录树跟着当前输入实时更新。 */
  onDocumentChange?: (markdown: string) => void;
  /** Mod + 点击 `[[双链]]` 时回调：目标标题，以及 `[[标题#小节]]` 里的小节（没有就是 undefined）。 */
  onWikiLink?: (title: string, heading?: string) => void;
  /**
   * 是否撑出一块最小高度（360px）并在末尾留 72px 空白。
   * 编辑器是页面最后一块内容时要这样，短文档也有地方可以点进去继续写；
   * 后面还跟着别的内容（日历的当日安排）时关掉，否则正文和任务之间会空出
   * 一大截，看起来像两个不相干的区域。
   */
  fill?: boolean;
  /**
   * 这篇文档的键（store 的 saveKeyOf）。给了就在卸载时缓存编辑器状态，
   * 下次同一篇挂上来直接复用，不再重新解析全文。
   */
  cacheKey?: string;
  /**
   * 这篇文档被外部改动（别的程序改了文件）刷新过几次。initialMarkdown 变了而它没变，
   * 是自己的保存回来了；它也变了，才是外部改动。
   */
  externalRevision?: number;
  /** 外部改动到的时候编辑器里正有没存的修改（编辑器里的留着，上层负责别丢了外部那一版） */
  onExternalConflict?: () => void;
  /**
   * 这篇是某一天 / 某个周期的文档：一行里只写 `/模板` 就弹出对应的模板（templates.ts），
   * 空文档里显示占位提示。笔记没有。
   */
  templateContext?: TemplateContext;
  /**
   * 这篇文档所在的文件夹（绝对路径）。正文里的相对图片路径（`../附件/截图.png`）
   * 以它为基准；浏览器预览里没有仓库文件夹，是 null。
   */
  imageBase?: string | null;
  /** 粘贴 / 拖进来的文件：存进「附件」，返回从这篇引用它们的路径（见 editor/attachments.ts） */
  onAttachFiles?: (files: File[]) => Promise<Attachment[]>;
  /** 桌面端从系统拖进窗口的文件（只有路径） */
  onAttachPaths?: (paths: string[]) => Promise<Attachment[]>;
  /**
   * 能用 `[[` 链过去的笔记，最近改过的在前。也用来认出链到不存在的笔记的双链。
   * 不给（单测）就不弹 `[[` 菜单、也不标虚线
   */
  linkTargets?: WikiCandidate[];
  /** 这一篇自己（是笔记的话）：`[[` 菜单里不列它 */
  linkSelf?: string;
  /** 光标在第一行时按 ↑：回到标题（只有能改标题的文档给） */
  onExitTop?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saverRef = useRef<DebouncedSaver | null>(null);
  const onSaveRef = useRef(onSave);
  const onDocumentChangeRef = useRef(onDocumentChange);
  const onWikiLinkRef = useRef(onWikiLink);
  const onExternalConflictRef = useRef(onExternalConflict);
  onExternalConflictRef.current = onExternalConflict;
  const externalRevisionRef = useRef(externalRevision);
  const cacheKeyRef = useRef(cacheKey);
  const initialMarkdownRef = useRef(initialMarkdown);
  /** 最近一次与外部（store）达成一致的正文，用来判断本地有没有未同步的编辑。 */
  const syncedMarkdownRef = useRef(initialMarkdown);
  const outlineItemsRef = useRef(outlineItems);
  outlineItemsRef.current = outlineItems;
  onSaveRef.current = onSave;
  onDocumentChangeRef.current = onDocumentChange;
  onWikiLinkRef.current = onWikiLink;
  const imageBaseRef = useRef(imageBase);
  /** 现取的附件回调：编辑器复用缓存的状态时，换的只是这一截闭包 */
  const attachRef = useRef<AttachHooks | null>(null);
  attachRef.current = onAttachFiles ? { files: onAttachFiles, paths: onAttachPaths } : null;
  /** 动态表情选择器（Mod-E）：开着时是光标的视口坐标 */
  const [emojiAnchor, setEmojiAnchor] = useState<EmojiPickerAnchor | null>(null);
  /** 每次打开换一个 key：上一个还在退场时再按快捷键，得到的是一个全新的选择器（重新定位、重新聚焦） */
  const [emojiSession, setEmojiSession] = useState(0);
  /** 打开选择器前清掉了折行方向的原选区；没插入就关掉时还原 */
  const savedSelectionRef = useRef<EditorSelection | null>(null);
  const templateContextRef = useRef(templateContext);
  templateContextRef.current = templateContext;
  /** 模板选择器：开着时是触发词那一行的视口坐标（见 TemplatePicker） */
  const [templateMenu, setTemplateMenu] = useState<TemplateMenu | null>(null);
  /** 给按键和 updateListener 同步读的「开着没有」，不用等 React 提交 */
  const templateOpenRef = useRef(false);
  const templatePickerRef = useRef<TemplatePickerHandle | null>(null);
  const templateSessionRef = useRef(0);
  const closeTemplateMenu = useCallback(() => {
    templateOpenRef.current = false;
    setTemplateMenu(null);
  }, []);

  /** `/` 插入菜单、`[[` 笔记链接菜单（见 suggest.ts）：开着时是触发词和它的视口坐标 */
  const [suggest, setSuggest] = useState<SuggestMenuState | null>(null);
  /** 给按键和 updateListener 同步读，不用等 React 提交 */
  const suggestRef = useRef<SuggestMenuState | null>(null);
  const suggestHandleRef = useRef<SuggestMenuHandle | null>(null);
  const suggestSessionRef = useRef(0);
  /** 按 Esc 关掉的那个触发词（起点）：接着打字不再弹，换一处再打才弹 */
  const suggestDismissedRef = useRef<number | null>(null);
  const linkTargetsRef = useRef(linkTargets);
  linkTargetsRef.current = linkTargets;
  const onExitTopRef = useRef(onExitTop);
  onExitTopRef.current = onExitTop;
  const closeSuggest = useCallback(() => {
    suggestRef.current = null;
    setSuggest(null);
  }, []);
  const knownTitles = useMemo(
    () => (linkTargets ? new Set(linkTargets.map((note) => wikiKey(note.title))) : null),
    [linkTargets],
  );
  const knownTitlesRef = useRef(knownTitles);

  /** 打开动态表情选择器：Mod-E，或者 `/` 菜单里的「动态表情」 */
  const openEmojiPicker = useCallback((view: EditorView) => {
    // 光标带着折行方向（assoc，按 End 或点在折行处会有）时，编辑器一失焦
    // CodeMirror 就会在下一次测量里 enforceCursorAssoc：改写 DOM 选区，
    // 顺手把焦点抢回正文 —— 选择器的输入框刚聚焦就丢了。先把方向清掉，
    // Esc 关闭时再还原。
    const main = view.state.selection.main;
    savedSelectionRef.current = null;
    if (main.empty && main.assoc) {
      savedSelectionRef.current = view.state.selection;
      view.dispatch({ selection: EditorSelection.cursor(main.head) });
    }
    // 光标坐标在 CodeMirror 的测量周期里量，也让已经排下的测量先跑完
    view.requestMeasure({
      read: caretAnchor,
      write: (anchor) => {
        setEmojiSession((session) => session + 1);
        setEmojiAnchor(anchor);
      },
    });
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const saver = createDebouncedSaver((markdown) => onSaveRef.current(markdown), 400);
    const unregisterFlush = registerEditorFlush(saver.flush);
    saverRef.current = saver;
    /** 这篇文档的键：缓存编辑器状态、记住看到哪都用它 */
    const key = cacheKeyRef.current;

    // 目录树不需要逐帧精确。每次按键都往上抛正文的话，
    // 上层要对整篇文档重扫一遍标题，长文档下这笔开销比排版本身还大。
    let outlineTimer: ReturnType<typeof setTimeout> | null = null;
    const notifyDocumentChange = (markdown: string) => {
      if (outlineTimer) clearTimeout(outlineTimer);
      outlineTimer = setTimeout(() => {
        outlineTimer = null;
        onDocumentChangeRef.current?.(markdown);
      }, 250);
    };

    /**
     * 这个 effect 里的闭包要用编辑器都从这里取，卸载时清空。不能直接闭包住下面的 view：
     * V8 里同一个作用域的闭包共用一份上下文，session 那一截的闭包会跟着状态一直留着
     * （缓存的状态、语法解析握着的旧状态），只要有一个闭包捕获了 view，旧编辑器连同整棵
     * DOM 就都放不掉。目录句柄也只经过它（见 createOutlineHandle）
     */
    const live: { view: EditorView | null } = { view: null };
    const listeners = new Set<(id: string) => void>();
    const { handle, notifyActive } = createOutlineHandle(live, outlineItemsRef, listeners);
    // 命令面板的「收起所有标题」「展开所有标题」交给最近获得焦点的这个编辑器
    const commands = registerEditorCommands((command) => {
      const view = live.view;
      if (!view) return false;
      return command === "fold-all" ? foldAllHeadings(view) : unfoldAllHeadings(view);
    });

    // 模板选择器：一行里只写着触发词（`/模板`）、光标在它末尾时打开。只认打字
    // （含输入法上屏），撤销回来的、外部回填的不算 —— 否则撤销一次模板又弹出来。
    // 坐标在 CodeMirror 的测量周期里量，量的时候再核对一次触发词还在不在。
    const openTemplateMenu = (view: EditorView) => {
      view.requestMeasure({
        read: (current) => {
          const trigger = templateTrigger(current.state);
          if (!trigger) return null;
          return {
            anchor: caretAnchor(current, trigger.from),
            replaceable: hasOtherContent(current.state, trigger),
            carried: carriedTasks(current.state, trigger).length,
          };
        },
        write: (measured) => {
          if (!measured || !templateContextRef.current) return;
          templateOpenRef.current = true;
          templateSessionRef.current += 1;
          setTemplateMenu({ ...measured, session: templateSessionRef.current });
        },
      });
    };

    /** 选择器开着时，把方向键 / 回车 / Esc 转给它；输入法组字时的按键是给候选框的 */
    const forwardToPicker =
      (action: (picker: TemplatePickerHandle) => void) => (view: EditorView) => {
        const picker = templatePickerRef.current;
        if (!templateOpenRef.current || !picker || view.composing) return false;
        action(picker);
        return true;
      };

    const templateExtensions: Extension[] = templateContextRef.current
      ? [
          placeholder(templatePlaceholder(templateContextRef.current.scope)),
          EditorView.updateListener.of((update) => {
            if (templateOpenRef.current) {
              // 接着打字、退格、光标挪走、点到别处：触发词不在了就收起
              const moved =
                (update.docChanged || update.selectionSet) && !templateTrigger(update.state);
              if (moved || (update.focusChanged && !update.view.hasFocus)) closeTemplateMenu();
              return;
            }
            if (!update.docChanged) return;
            if (!update.transactions.some((transaction) => transaction.isUserEvent("input.type")))
              return;
            if (templateTrigger(update.state)) openTemplateMenu(update.view);
          }),
          // 比列表续行（Enter）、缩进（Tab）都先拿到按键
          Prec.highest(
            keymap.of([
              { key: "ArrowDown", run: forwardToPicker((picker) => picker.move(1)) },
              { key: "ArrowUp", run: forwardToPicker((picker) => picker.move(-1)) },
              { key: "Tab", run: forwardToPicker((picker) => picker.move(1)) },
              { key: "Shift-Tab", run: forwardToPicker((picker) => picker.move(-1)) },
              { key: "Enter", run: forwardToPicker((picker) => picker.pick("insert")) },
              { key: "Shift-Enter", run: forwardToPicker((picker) => picker.pick("replace")) },
              { key: "Escape", run: forwardToPicker(() => closeTemplateMenu()) },
            ]),
          ),
        ]
      : [];

    // `/` 插入菜单、`[[` 笔记链接菜单（suggest.ts）。同模板选择器：只认打字弹出（撤销回来、
    // 外部回填的不算），接着打字是在筛选；触发词不在了、筛不出东西了、点到别处就收起。
    // 坐标在 CodeMirror 的测量周期里量，量的时候再核对一次触发词还在不在
    const openSuggest = (view: EditorView, trigger: SuggestTrigger) => {
      view.requestMeasure({
        read: (current) => {
          const now = suggestTrigger(current.state);
          if (!now || now.kind !== trigger.kind || now.from !== trigger.from) return null;
          return { ...now, anchor: caretAnchor(current, now.from) };
        },
        write: (measured) => {
          if (!measured || suggestRef.current) return;
          suggestSessionRef.current += 1;
          const next: SuggestMenuState = {
            kind: measured.kind,
            from: measured.from,
            query: measured.query,
            anchor: measured.anchor,
            session: suggestSessionRef.current,
          };
          suggestRef.current = next;
          setSuggest(next);
        },
      });
    };
    /** `/` 后面打的字一项都对不上，就是在写普通文字；没有笔记列表（单测）不弹 `[[` */
    const hasSuggestions = (trigger: SuggestTrigger) =>
      trigger.kind === "wiki"
        ? !!linkTargetsRef.current
        : slashItems(trigger.query, !!templateContextRef.current).length > 0;
    /** 菜单开着时，把方向键 / 回车 / Tab / Esc 转给它；输入法组字时的按键是给候选框的 */
    const forwardToSuggest =
      (action: (menu: SuggestMenuHandle) => boolean) => (view: EditorView) => {
        const menu = suggestHandleRef.current;
        if (!suggestRef.current || !menu || view.composing) return false;
        return action(menu);
      };

    const suggestExtensions: Extension[] = [
      EditorView.updateListener.of((update) => {
        const open = suggestRef.current;
        if (open && update.focusChanged && !update.view.hasFocus) {
          closeSuggest();
          return;
        }
        if (!update.docChanged && !update.selectionSet) return;
        const typed = update.transactions.some((transaction) =>
          transaction.isUserEvent("input.type"),
        );

        // 中文输入法下 `[` 是 `【`：连着打两个就当是 `[[`
        const head = update.state.selection.main.head;
        if (typed && !update.view.composing && update.state.sliceDoc(head - 2, head) === "【【") {
          const view = update.view;
          queueMicrotask(() => {
            if (view.state.sliceDoc(head - 2, head) !== "【【") return;
            view.dispatch({
              changes: { from: head - 2, to: head, insert: "[[" },
              userEvent: "input.type",
            });
          });
          return;
        }

        const trigger = suggestTrigger(update.state);
        if (open) {
          const same = trigger && trigger.kind === open.kind && trigger.from === open.from;
          if (same && hasSuggestions(trigger)) {
            if (trigger.query !== open.query) {
              const next = { ...open, query: trigger.query };
              suggestRef.current = next;
              setSuggest(next);
            }
            return;
          }
          closeSuggest();
        }
        if (!trigger) {
          suggestDismissedRef.current = null;
          return;
        }
        if (!update.docChanged || !typed || templateOpenRef.current) return;
        if (suggestDismissedRef.current === trigger.from || !hasSuggestions(trigger)) return;
        openSuggest(update.view, trigger);
      }),
      // 比模板选择器之外的一切按键（列表续行、缩进…）都先拿到
      Prec.highest(
        keymap.of([
          {
            key: "ArrowDown",
            run: forwardToSuggest((menu) => {
              menu.move(1);
              return true;
            }),
          },
          {
            key: "ArrowUp",
            run: forwardToSuggest((menu) => {
              menu.move(-1);
              return true;
            }),
          },
          { key: "Enter", run: forwardToSuggest((menu) => menu.pick()) },
          { key: "Tab", run: forwardToSuggest((menu) => menu.pick()) },
          {
            key: "Escape",
            run: forwardToSuggest(() => {
              suggestDismissedRef.current = suggestRef.current?.from ?? null;
              closeSuggest();
              return true;
            }),
          },
        ]),
      ),
      // 光标在第一行（折行的话是最上面那一截）时按 ↑：回到标题，和标题里按 ↓ 进正文对称
      Prec.high(
        keymap.of([
          {
            key: "ArrowUp",
            run: (view) => {
              const exit = onExitTopRef.current;
              const main = view.state.selection.main;
              if (!exit || !main.empty || view.state.doc.lineAt(main.head).number !== 1) {
                return false;
              }
              const here = view.coordsAtPos(main.head);
              const top = view.coordsAtPos(0);
              if (here && top && here.top - top.top > 2) return false;
              exit();
              return true;
            },
          },
        ]),
      ),
    ];

    // 这个编辑器实例自己的那一截：闭包里握着这次的保存器和 React 状态。
    // 复用缓存的状态时，换掉的就是这一截（见文件开头的说明）。
    const sessionExtensions: Extension[] = [
      ...templateExtensions,
      // 笔记的空白正文：告诉人 `/` 和 `[[` 能做什么（某一天 / 某个周期的提示在 templateExtensions 里）
      ...(templateContextRef.current ? [] : [placeholder(NOTE_PLACEHOLDER)]),
      ...suggestExtensions,
      imageBaseSlot.of(imageBaseDir.of(imageBaseRef.current)),
      wikiTitlesSlot.of(knownWikiTitles.of(knownTitlesRef.current)),
      attachmentHandlers(() => attachRef.current),
      linkClickHandler((title, heading) => onWikiLinkRef.current?.(title, heading)),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) {
          if (update.focusChanged && !update.view.hasFocus) saver.flushQuietly();
          return;
        }
        const markdown = update.state.doc.toString();
        notifyDocumentChange(markdown);
        // 外部回填不是用户输入，不能反过来触发一次保存。
        if (update.transactions.some((transaction) => transaction.annotation(externalSync))) {
          syncedMarkdownRef.current = markdown;
          return;
        }
        saver.schedule(markdown);
        if (update.focusChanged && !update.view.hasFocus) saver.flushQuietly();
      }),
      EditorView.updateListener.of((update) => {
        if (update.focusChanged && update.view.hasFocus) commands.focus();
        // 收起了哪些标题也记下来，下次打开还是收着的
        if (
          key &&
          update.startState.field(headingFolds, false) !== update.state.field(headingFolds, false)
        ) {
          rememberSpot(key, { folds: foldMarks(update.state) });
        }
        if (!update.selectionSet) return;
        notifyActive(update.state);
        // 光标在哪记下来：切回这篇、下次打开都回到这里（lib/viewMemory.ts）
        if (key) rememberSpot(key, { head: update.state.selection.main.head });
      }),
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: (view) => {
            saver.schedule(view.state.doc.toString());
            saver.flushQuietly();
            return true;
          },
        },
        {
          key: "Mod-e",
          preventDefault: true,
          run: (view) => {
            openEmojiPicker(view);
            return true;
          },
        },
      ]),
    ];

    const cached = key ? takeState(key, initialMarkdownRef.current) : null;
    // 上次在这篇看到哪、光标在哪（切回来、重新打开应用都回到那里）
    const spot = key ? spotOf(key) : undefined;
    const docLength = initialMarkdownRef.current.length;
    const restoredHead = spot ? Math.min(spot.head, docLength) : 0;
    const state = cached
      ? // 解析好的语法树、装饰、撤销历史原样沿用
        cached.update({
          effects: [session.reconfigure(sessionExtensions), ...revealIdle()],
          selection: EditorSelection.cursor(restoredHead),
        }).state
      : EditorState.create({
          doc: initialMarkdownRef.current,
          selection: EditorSelection.cursor(restoredHead),
          extensions: [
            // 围栏代码按语言名懒加载对应的解析器，配合 codeHighlight 上色
            markdownSupport(languages),
            codeHighlight,
            history(),
            search({ top: true, createPanel: createSearchPanel, scrollToMatch }),
            searchPhrases,
            keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
            typoraDecorations,
            // 焦点不在正文、鼠标正按着时不按光标展开源码（reveal.ts）
            trackEditing,
            selectionLayer,
            smoothCaret,
            hoverCard,
            modKeyCursor,
            EditorView.lineWrapping,
            EditorView.contentAttributes.of({
              "aria-label": "Markdown 正文编辑器",
              // 中文正文在 WebView2 里会被拼写检查画满红波浪线，得关掉。
              spellcheck: "false",
            }),
            session.of(sessionExtensions),
          ],
        });

    // 先在游离的 DOM 里建好再挂上去：CodeMirror 建完正文才给 contentDOM 设 contenteditable /
    // spellcheck 这些属性，挂在页面上时设一次要把整篇已经画出来的行过一遍（切一篇 4 倍降速下
    // 约 50ms），游离时几乎不花时间
    const view = new EditorView({ state });
    host.appendChild(view.dom);
    viewRef.current = view;
    live.view = view;
    // 切走时开着查找面板：回来时不该还开着（和以前每次新建编辑器一样）
    if (searchPanelOpen(view.state)) closeSearchPanel(view);
    // 上次收起的标题（缓存的状态里本来就带着）。在滚回上次的位置之前：那个位置是按收着的样子记的
    if (!cached) {
      const folds = restoreFolds(view.state, spot?.folds);
      if (folds.length) view.dispatch({ effects: folds });
    }

    // 回到上次看到的地方。上层换篇时已经把滚动容器拨回了顶上（DocumentView），
    // 这里在它之后跑。标题还露着时记的是 scrollTop（上面只有标题，高度是确定的）；
    // 滚进正文之后按行定位，交给 CodeMirror 量好了再滚（没画过的行只有估计高度）
    const scroller = host.closest<HTMLElement>("[data-doc-scroller]");
    if (spot && scroller) {
      if (spot.scrollTop !== null) {
        const top = spot.scrollTop;
        view.requestMeasure({ read: () => null, write: () => scroller.scrollTo({ top }) });
      } else if (spot.pos <= view.state.doc.length) {
        view.dispatch({
          effects: EditorView.scrollIntoView(spot.pos, { y: "start", yMargin: -spot.offset }),
        });
      }
    }
    // 滚到哪记下来。换篇的那一下上层把容器拨回顶上，那时这个编辑器已经从页面上摘下来了，
    // 不能把「顶上」记成这一篇的位置
    let spotFrame = 0;
    const recordScroll = () => {
      cancelAnimationFrame(spotFrame);
      spotFrame = requestAnimationFrame(() => {
        const view = live.view;
        if (!key || !scroller || !view || !host.isConnected) return;
        const above = scroller.getBoundingClientRect().top - view.documentTop;
        if (above <= 0) {
          rememberSpot(key, { scrollTop: scroller.scrollTop });
          return;
        }
        const block = view.lineBlockAtHeight(above);
        rememberSpot(key, { scrollTop: null, pos: block.from, offset: above - block.top });
      });
    };
    scroller?.addEventListener("scroll", recordScroll, { passive: true });

    onOutlineHandle(handle);
    host.dataset.editorReady = "true";
    // 它返回的闭包握着 view（同上），停掉后就扔掉
    let stopFileDrops: (() => void) | null = watchDesktopFileDrops(view, () => attachRef.current);

    return () => {
      const view = live.view;
      if (!view) return;
      stopFileDrops?.();
      stopFileDrops = null;
      scroller?.removeEventListener("scroll", recordScroll);
      cancelAnimationFrame(spotFrame);
      if (key) rememberSpot(key, { head: view.state.selection.main.head });
      setEmojiAnchor(null);
      closeTemplateMenu();
      closeSuggest();
      unregisterFlush();
      commands.dispose();
      if (outlineTimer) clearTimeout(outlineTimer);
      saver.flushQuietly();
      saverRef.current = null;
      viewRef.current = null;
      live.view = null;
      listeners.clear();
      onOutlineHandle(null);
      delete host.dataset.editorReady;
      if (key) rememberState(key, view.state);
      view.destroy();
      forgetDetachedEmoji();
    };
  }, [onOutlineHandle, closeTemplateMenu, closeSuggest, openEmojiPicker]);

  // 文档所在的文件夹变了（改名挪了位置、仓库路径刚取回来）：相对路径的图片按新基准重画
  useEffect(() => {
    imageBaseRef.current = imageBase;
    const view = viewRef.current;
    if (!view || view.state.facet(imageBaseDir) === imageBase) return;
    view.dispatch({ effects: imageBaseSlot.reconfigure(imageBaseDir.of(imageBase)) });
  }, [imageBase]);

  // 笔记新建、改名、删掉了：链到不存在的笔记的双链重新标
  useEffect(() => {
    knownTitlesRef.current = knownTitles;
    const view = viewRef.current;
    if (!view || view.state.facet(knownWikiTitles) === knownTitles) return;
    view.dispatch({ effects: wikiTitlesSlot.reconfigure(knownWikiTitles.of(knownTitles)) });
  }, [knownTitles]);

  // 外部正文变化时回填。
  //
  // 这是修 P0 的关键：日历某天的备注是异步加载的，编辑器往往先以空文档挂载，
  // 数据晚一步才到。以前 initialMarkdown 只在挂载时读一次，于是界面上是空的、
  // 用户一输入就把当天原有的备注整篇覆盖掉了。
  // 只有在本地没有未同步编辑时才回填，用户已经动过的内容永远优先。
  //
  // 本地有没同步的编辑、而这次变化又是外部改动（别的程序改了文件）：两边都改了。
  // 编辑器里的留着，告诉上层 —— 它负责在下次保存前把外部那一版另存一份。
  useEffect(() => {
    const view = viewRef.current;
    const external = externalRevision !== externalRevisionRef.current;
    externalRevisionRef.current = externalRevision;
    if (!view) return;
    const current = view.state.doc.toString();
    if (initialMarkdown === current) {
      syncedMarkdownRef.current = initialMarkdown;
      return;
    }
    if (current !== syncedMarkdownRef.current) {
      if (external) onExternalConflictRef.current?.();
      return;
    }
    syncedMarkdownRef.current = initialMarkdown;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: initialMarkdown },
      annotations: externalSync.of(true),
    });
  }, [initialMarkdown, externalRevision]);

  const closeEmojiPicker = useCallback((refocus: boolean) => {
    setEmojiAnchor(null);
    const view = viewRef.current;
    const saved = savedSelectionRef.current;
    savedSelectionRef.current = null;
    if (!view) return;
    // 先聚焦再还原：聚焦时 CodeMirror 可能从 DOM 选区回读一次，会把折行方向冲掉
    if (refocus) view.focus();
    if (saved && view.state.selection.main.head === saved.main.head) {
      view.dispatch({ selection: saved });
    }
  }, []);

  const pickEmoji = useCallback((emoji: AnimatedEmoji) => {
    setEmojiAnchor(null);
    savedSelectionRef.current = null;
    const view = viewRef.current;
    if (!view) return;
    insertAnimatedEmoji(view, emoji);
  }, []);

  // 按今天的日期现算模板，换掉触发词那一行（或整篇）。是一次普通的编辑：
  // 撤销一下就回到 `/模板`，自动保存照常
  const pickTemplate = useCallback(
    (template: DocTemplate, mode: TemplateMode) => {
      closeTemplateMenu();
      const view = viewRef.current;
      const context = templateContextRef.current;
      if (!view || !context) return;
      const trigger = templateTrigger(view.state);
      if (!trigger) return;
      view.dispatch(applyTemplate(view.state, trigger, template.build(context), mode));
      view.focus();
    },
    [closeTemplateMenu],
  );
  const templateScope = templateContext?.scope;
  const templates = useMemo(
    () => (templateScope ? templatesFor(templateScope) : []),
    [templateScope],
  );

  // `/` 菜单、`[[` 菜单里现在列着的项（和按键 pick 时取的是同一份）
  const withTemplates = !!templateContext;
  const suggestItems = useMemo((): SuggestEntry[] => {
    if (!suggest) return [];
    if (suggest.kind === "slash") {
      return slashItems(suggest.query, withTemplates).map(({ item, ranges }) => ({
        kind: "slash",
        item,
        row: { id: item.id, icon: item.icon, label: item.label, ranges, hint: item.hint },
      }));
    }
    const candidates = (linkTargets ?? []).filter((note) => note.id !== linkSelf);
    return wikiItems(suggest.query, candidates).map(({ item, ranges }) => ({
      kind: "wiki",
      item,
      row:
        item.kind === "note"
          ? {
              id: item.note.id,
              icon: wikiIcon(item),
              label: item.note.title,
              ranges,
              hint: item.note.archived ? "归档" : item.note.folder || undefined,
            }
          : {
              id: "new",
              icon: wikiIcon(item),
              label: `链接到「${item.title}」`,
              hint: "还没有这篇",
              muted: true,
            },
    }));
  }, [suggest, withTemplates, linkTargets, linkSelf]);
  const suggestItemsRef = useRef(suggestItems);
  suggestItemsRef.current = suggestItems;

  /** 选了 `/` 或 `[[` 菜单里的一项：换掉触发词。是一次普通的编辑，撤销一下就回到触发词 */
  const pickSuggestion = useCallback(
    (index: number) => {
      const open = suggestRef.current;
      const entry = suggestItemsRef.current[index];
      const view = viewRef.current;
      closeSuggest();
      if (!open || !entry || !view) return;
      const trigger = suggestTrigger(view.state);
      if (!trigger || trigger.kind !== open.kind || trigger.from !== open.from) return;
      if (entry.kind === "wiki") insertWikiLink(view, trigger, entry.item);
      else if (entry.item.action.type === "emoji") {
        view.dispatch({ changes: { from: trigger.from, to: trigger.to }, userEvent: "delete" });
        openEmojiPicker(view);
      } else insertSlashItem(view, trigger, entry.item);
      view.focus();
    },
    [closeSuggest, openEmojiPicker],
  );

  return (
    <>
      <div
        ref={hostRef}
        data-editor-stable-island
        className={fill ? "odea-editor mt-7 selectable" : "odea-editor is-compact mt-7 selectable"}
      />
      {createPortal(
        <>
          <AnimatePresence>
            {emojiAnchor && (
              <EmojiPicker
                key={emojiSession}
                anchor={emojiAnchor}
                onPick={pickEmoji}
                onClose={closeEmojiPicker}
              />
            )}
          </AnimatePresence>
          <AnimatePresence>
            {templateMenu && templateContext && templates.length > 0 && (
              <TemplatePicker
                key={templateMenu.session}
                anchor={templateMenu.anchor}
                context={templateContext}
                templates={templates}
                replaceable={templateMenu.replaceable}
                carried={templateMenu.carried}
                handleRef={templatePickerRef}
                onPick={pickTemplate}
                onClose={closeTemplateMenu}
              />
            )}
          </AnimatePresence>
          <AnimatePresence>
            {suggest && (
              <SuggestMenu
                key={suggest.session}
                anchor={suggest.anchor}
                title={suggest.kind === "slash" ? "插入" : "链接到笔记"}
                icon={suggest.kind === "slash" ? Plus : Link2}
                rows={suggestItems.map((entry) => entry.row)}
                empty={suggest.kind === "slash" ? "没有这一项" : "还没有别的笔记"}
                handleRef={suggestHandleRef}
                onPick={pickSuggestion}
                onClose={closeSuggest}
              />
            )}
          </AnimatePresence>
        </>,
        document.body,
      )}
    </>
  );
}

/** 开着的 `/` / `[[` 菜单 */
interface SuggestMenuState {
  kind: SuggestKind;
  /** 触发词起点：菜单只认这一处，换了地方就是另一个菜单 */
  from: number;
  query: string;
  anchor: EmojiPickerAnchor;
  /** 每次打开换一个 key：上一个还在退场时又打开，得到的是全新的菜单 */
  session: number;
}

/** 菜单里的一项和它那一行怎么画 */
type SuggestEntry =
  | { kind: "slash"; item: SlashItem; row: SuggestRow }
  | { kind: "wiki"; item: WikiItem; row: SuggestRow };

/**
 * `/` 菜单里选的那一块换掉 `/筛选词`。块级的（表格、分隔线、代码…）上一行有字时先空一行：
 * 不然 `---` 会把上一段变成二级标题、表格会被当成上一段的续行。
 */
function insertSlashItem(view: EditorView, trigger: SuggestTrigger, item: SlashItem) {
  const action = item.action;
  const replace = { from: trigger.from, to: trigger.to };
  if (action.type === "wiki" || action.type === "template") {
    // 换成 `[[` / `/模板`，当作是打出来的：笔记链接菜单、模板选择器接着弹出来
    const insert = action.type === "wiki" ? "[[" : "/模板";
    view.dispatch({
      changes: { ...replace, insert },
      selection: { anchor: trigger.from + insert.length },
      userEvent: "input.type",
    });
    return;
  }
  if (action.type !== "snippet") return;
  const line = view.state.doc.lineAt(trigger.from);
  const previous = line.number > 1 ? view.state.doc.line(line.number - 1).text : "";
  const gap = action.block && previous.trim() ? "\n" : "";
  const start = trigger.from + gap.length;
  view.dispatch({
    changes: { ...replace, insert: gap + action.text },
    selection: { anchor: start + action.select[0], head: start + action.select[1] },
    userEvent: "input.complete",
    scrollIntoView: true,
  });
}

/** `[[筛选词` 补全成 `[[标题]]`，光标落在后面。后面已经有 `]]` 了就不再补 */
function insertWikiLink(view: EditorView, trigger: SuggestTrigger, item: WikiItem) {
  const title = item.kind === "note" ? item.note.title : item.title.trim();
  const closed = view.state.sliceDoc(trigger.to, trigger.to + 2) === "]]";
  const insert = `[[${title}${closed ? "" : "]]"}`;
  view.dispatch({
    changes: { from: trigger.from, to: trigger.to, insert },
    selection: { anchor: trigger.from + insert.length + (closed ? 2 : 0) },
    userEvent: "input.complete",
  });
}

/**
 * 选择器贴着主光标（模板选择器：触发词那一行的行首）弹出来。量不到坐标（不在渲染
 * 范围里）时，退到编辑区左上角 —— 宁可位置不那么贴，也不能按了快捷键没反应。
 */
function caretAnchor(view: EditorView, pos = view.state.selection.main.head): EmojiPickerAnchor {
  const coords = view.coordsAtPos(pos, 1) ?? view.coordsAtPos(pos, -1);
  if (coords) return { left: coords.left, top: coords.top, bottom: coords.bottom };
  const box = view.contentDOM.getBoundingClientRect();
  return { left: box.left, top: box.top, bottom: box.top };
}

/**
 * 在每个选区处插入短码，光标落在它后面 —— 替身这时就显示成表情，
 * 并且因为刚 primeIntro 过，会整个弹出来。
 *
 * 两种情况先垫一个空格：
 * - 前面紧挨着 `:词`：`12:30` 后面直接接 `:odea_fire:`，Markdown 会先把 `:30:`
 *   认成短码，把我们的开头冒号吃掉；
 * - 前面紧挨着 `]`：行首的 `[标签]:odea_fire:` 是一条引用定义，不是表情。
 */
export function insertAnimatedEmoji(view: EditorView, emoji: AnimatedEmoji): void {
  const { state } = view;
  primeIntro(emoji);
  view.dispatch(
    state.changeByRange((range) => {
      const before = state.sliceDoc(Math.max(0, range.from - 64), range.from);
      const text = (/(?::[A-Za-z0-9_]+|\])$/.test(before) ? " " : "") + emoji.shortcode;
      return {
        changes: { from: range.from, to: range.to, insert: text },
        range: EditorSelection.cursor(range.from + text.length),
      };
    }),
    { userEvent: "input.emoji", scrollIntoView: true },
  );
  view.focus();
}

/** 开着的模板选择器 */
interface TemplateMenu {
  anchor: EmojiPickerAnchor;
  /** 触发词之外还有正文：可以「替换全文」 */
  replaceable: boolean;
  /** 替换全文时会带进「待续」的未完成任务数 */
  carried: number;
  /** 每次打开换一个 key：上一个还在退场时又打开，得到的是全新的选择器 */
  session: number;
}

export interface EditorOutlineHandle {
  /** 滚到某个目录条目；编辑器已卸载或条目不存在时返回 false */
  scrollTo: (id: string) => boolean;
  subscribe: (listener: (id: string) => void) => () => void;
  /**
   * 滚到第几行（从 1 开始）并把光标放在行尾；带着全局搜索的命中时改成选中它，篇内查找换成同一个条件。
   * 行号不存在或编辑器已卸载时返回 false
   */
  scrollToLine: (line: number, match?: MatchAnchor) => boolean;
  /** 光标放到正文开头并聚焦（标题里按回车 / ↓、新建了带标题的笔记）；编辑器已卸载时返回 false */
  focusStart: () => boolean;
}

/**
 * 编辑器的目录句柄，外加「光标进了哪一节」的通知。
 *
 * 句柄只能经过 `live` 这个格子够到编辑器，卸载时清空它。上层会在闭包里握着旧句柄
 * （DocumentView 按 target 记住的回调建在旧句柄还在 state 里的那一次渲染里），
 * 而 V8 里同一个作用域的闭包共用一份上下文：句柄要是直接闭包住 view，就是
 * 旧句柄 → 旧 effect 的作用域 → 旧组件的 ref → 上层的回调 → 更旧的句柄……
 * 打开过的每一篇都连着整棵 DOM 放不掉（2026-10-14 实测切 120 篇留着 122 个编辑器）。
 * 所以写在模块顶层，闭包里只有这几个参数。
 */
function createOutlineHandle(
  live: { view: EditorView | null },
  outlineItemsRef: { readonly current: OutlineItem[] },
  listeners: Set<(id: string) => void>,
) {
  const notifyActive = (state: EditorState) => {
    const line = state.doc.lineAt(state.selection.main.head).number;
    const active =
      [...outlineItemsRef.current].filter((item) => item.line <= line).at(-1) ??
      outlineItemsRef.current[0];
    if (active) for (const listener of listeners) listener(active.id);
  };
  const handle: EditorOutlineHandle = {
    scrollTo(id) {
      // 编辑器已经卸载（切换文档的那一帧上层还握着旧句柄）就当没这回事
      const view = live.view;
      if (!view) return false;
      const item = outlineItemsRef.current.find((entry) => entry.id === id);
      if (!item) return false;
      const line = view.state.doc.line(Math.min(item.line, view.state.doc.lines));
      view.dispatch({ selection: { anchor: line.from } });
      view.focus();
      // 平滑地滑过去（见 glide.ts）：顺带给路上没画过的内容留出画出来的时间，停得准
      glideTo(view, line.from, { y: "start", margin: 72 });
      for (const listener of listeners) listener(id);
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      if (live.view) notifyActive(live.view.state);
      return () => listeners.delete(listener);
    },
    scrollToLine(number, match) {
      const view = live.view;
      if (!view) return false;
      if (number < 1 || number > view.state.doc.lines) return false;
      const line = view.state.doc.line(number);
      const found = match ? matchOnLine(view.state, number, match) : null;
      if (match && found) {
        const query = queryOfAnchor(match);
        view.dispatch({
          selection: { anchor: found.from, head: found.to },
          // F3 / Mod-F 接着找同一个词（编辑器里的查找面板关着时也认这个条件）
          effects: query.valid ? setSearchQuery.of(query) : [],
        });
      } else {
        view.dispatch({ selection: { anchor: line.to } });
      }
      view.focus();
      glideTo(view, found?.from ?? line.from, { y: "center" });
      return true;
    },
    focusStart() {
      const view = live.view;
      if (!view) return false;
      // 属性块折着放在最前面：落到它后面，不然一聚焦整块 YAML 就展开了
      const front = frontMatterRange(view.state.doc);
      const at = front ? Math.min(view.state.doc.length, front.to + 1) : 0;
      view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
      view.focus();
      return true;
    },
  };
  return { handle, notifyActive };
}

/* ============================================================
   链接点击：Mod + 左键打开外链 / 跳转双链。普通点击照常放光标。
   ============================================================ */

function linkClickHandler(onWikiLink: (title: string, heading?: string) => void): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false;
      const target = (event.target as HTMLElement | null)?.closest?.(
        ".cm-odea-link, .cm-odea-wikilink",
      ) as HTMLElement | null;
      if (!target) return false;
      const position = view.posAtDOM(target);
      if (target.classList.contains("cm-odea-wikilink")) {
        const raw = wikiTargetAt(view.state, position);
        if (!raw) return false;
        event.preventDefault();
        const { title, heading } = splitWikiTarget(raw);
        onWikiLink(title, heading);
        return true;
      }
      // `<a href>` 的地址挂在装饰的 data-href 上，语法树里没有
      const url = target.dataset.href ?? linkTargetAt(view.state, position);
      if (!url) return false;
      event.preventDefault();
      void openExternal(url);
      return true;
    },
  });
}

/** 光标碰没碰到这一段（碰到了就露出源码）。选区不在编辑、鼠标按着时另算，见 reveal.ts */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return selectionTouchesRange(revealRanges(state), from, to);
}

type DecorationRange = { from: number; to: number; value: Decoration };

/**
 * 替身该不该播入场动画（见 widgets.ts 的 OtwWidget）：它盖住的源码是不是这一次才
 * 出现 / 改动的。changes 为 null 表示整篇初次构建（刚打开笔记），全都算新的；
 * 只动了光标、只滚了视口时 changes 是空的，谁都不算新。
 * 边界相接也算碰到：刚打完 `:smile:` 最后那个冒号，改动正好落在短码末尾。
 */
function freshness(changes: ChangeSet | null): (from: number, to: number) => boolean {
  if (!changes) return () => true;
  const touched: number[] = [];
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => touched.push(fromB, toB));
  if (!touched.length) return () => false;
  return (from, to) => {
    for (let index = 0; index < touched.length; index += 2) {
      if (touched[index]! <= to && touched[index + 1]! >= from) return true;
    }
    return false;
  };
}

/** 把替身放进文档前，按它盖住的范围定下要不要播入场动画。 */
function markFreshness(
  widget: WidgetType | undefined,
  from: number,
  to: number,
  fresh: (from: number, to: number) => boolean,
) {
  if (widget instanceof OtwWidget) widget.fresh = fresh(from, to);
}

const toDecorationSet = (items: DecorationRange[]) =>
  Decoration.set(
    items.map(({ from, to, value }) => value.range(from, to)),
    true,
  );

/** 这些节点内部的文本是字面量，源码级规则不能进去改动显示。 */
const literalNodes = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "HTMLBlock",
  "CommentBlock",
  "ProcessingInstructionBlock",
  "InlineMath",
  "MathBlock",
  "HTMLTag",
  "Comment",
  "URL",
  "Autolink",
]);

const FENCE_LINE_RE = /^\s{0,3}(?:`{3,}|~{3,})/;
const CLOSING_FENCE_RE = /^\s{0,3}(?:`{3,}|~{3,})\s*$/;
const SETEXT_UNDERLINE_RE = /^\s{0,3}(?:=+|-+)\s*$/;
const TOC_RE = /^\s*\[\[?toc\]?\]\s*$/i;
const FOOTNOTE_RE = /^\[\^([^\]\s]+)\]$/;
/** 行首的脚注定义：`[^id]:` 加后面的空白 */
const FOOTNOTE_DEF_RE = /^\[\^([^\]\s]+)\]:[ \t]*/;
const CALLOUT_LABEL_RE = /^\[!([^\]\n]+)\]$/;
const HEADING_RE = /^(?:ATX|Setext)Heading([1-6])$/;
/** 缩写定义：`*[HTML]: HyperText Markup Language` */
const ABBREVIATION_RE = /^\s{0,3}\*\[([^\]\n]+)\]:[ \t]+(\S.*?)\s*$/;
/** 定义列表里的定义行：`: 释义` */
const DEFINITION_RE = /^\s{0,3}:[ \t]+(?=\S)/;
/** 长得像块级语法开头的行，不能当定义列表的术语 */
const BLOCK_START_RE = /^\s{0,3}(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s|`{3,}|~{3,}|\||\$\$|<|\[\^)/;
/** 整行都是分隔符：分隔线、Setext 下划线 —— 智能标点不能碰 */
const RULE_LINE_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,}|={3,})\s*$/;
/** 智能标点：显示层替换，源码不动 */
const SMART_RE = /---|--|\.\.\.|\((?:c|r|tm)\)/gi;
const SMART_GLYPHS: Readonly<Record<string, string>> = {
  "---": "—",
  "--": "–",
  "...": "…",
  "(c)": "©",
  "(r)": "®",
  "(tm)": "™",
};
const BULLET_GLYPHS = ["•", "◦", "▪"];
/* 列表符号格的宽度，单位是正文字号（globals.css「列表的几何」）。任务项的宽度和
   .cm-odea-task 左右的空加起来要相等；有序列表按最大编号的位数加宽 */
const LIST_BULLET_WIDTH = 1.55;
const LIST_TASK_WIDTH = 1.8;
const LIST_ORDERED_WIDTH = 1;
const LIST_DIGIT_WIDTH = 0.56;
const listUnits = (value: number) =>
  `calc(var(--odea-body-size) * ${Math.round(value * 1000) / 1000})`;

/* ============================================================
   装饰分成两层，因为两层的成本量级完全不同。

   块级层（StateField）：折叠围栏行、Setext 下划线行、分隔线行、front matter
   的围栏行、[TOC] 行，以及把表格 / 图表 / 公式块 / HTML 块换成 widget ——
   这些会改变行结构，CodeMirror 要求必须来自 StateField（视口是在插件更新
   之前算出来的）。它遍历全文，但只下探可能藏着块级构造的容器，Paragraph 及
   其下所有行内节点整棵剪掉。

   行内层（ViewPlugin）：标记隐藏、加粗斜体、任务勾选框、列表符号、callout、
   脚注、双链、Emoji、行内 HTML、行内公式、缩写、智能标点等等。这些不改变
   行结构，因此只需要处理当前视口，成本与文档长度无关。

   拆分前是一个 StateField 对全文做深度遍历，每次按键、每次移动光标都要
   重来一遍，53KB 文档上单次 5.3ms；拆分后同一文档 0.57ms。
   ============================================================ */

/** 块级层的产物。 */
export interface TyporaBlockState {
  decorations: DecorationSet;
  atomic: DecorationSet;
  /** 整行被折叠掉的行首偏移；行内层据此跳过这些行。 */
  foldedLines: Set<number>;
  /**
   * 文档里定义过的引用标签（CommonMark 规范化后）。
   * 行内层据此区分 `[文字]` 到底是引用式链接还是普通的方括号文本。
   */
  referenceLabels: Set<string>;
  /** 文档开头的 YAML front matter；两层都要绕开它，不然 `title: x` 会被当成 H2。 */
  frontMatter: FrontMatterRange | null;
  /** `*[缩写]: 全称`；行内层给正文里的缩写加悬停提示。 */
  abbreviations: Map<string, string>;
  /** 缩写定义行的行首；正文里的缩写高亮要跳过它们自己。 */
  abbreviationLines: Set<number>;
  /** `[^id]: …` 的正文（纯文本，截断），给引用端的悬停预览。 */
  footnotes: Map<string, string>;
  /**
   * 构建时问过的每一句「光标碰没碰到这一段」：三个一组，起点、终点、答案（1 / 0）。
   * 块级层只通过这些问题依赖选区 —— 只动了光标时拿新选区再问一遍，答案全都一样，
   * 重建出来也是同一份，直接沿用（见 typoraBlockDecorations）。
   */
  probes: number[];
  /** 文档里有 `[TOC]`：标题的文字变了它也得跟着变（见 mapBlockState） */
  toc: boolean;
}

/** 块级构造只可能藏在这些容器里，浅层遍历仅下探它们。 */
const blockContainers = new Set([
  "Document",
  "BulletList",
  "OrderedList",
  "ListItem",
  "Blockquote",
]);

/**
 * 块级层用的语法树：尽量是全文的。
 *
 * CodeMirror 建状态时只同步解析开头约 3000 个字符，剩下的交给空闲时的后台解析。
 * 块级层以前直接拿 syntaxTree(state)，刚打开长文档时看到的是半棵树：[TOC] 只列出
 * 开头几节的标题，后面的表格、公式、代码块都还是源码 —— 要等点一下（选区变化触发
 * 重建）才「展开」。这里先同步把全文解析完（有时间预算，超大文档解析不完就退回
 * 现有的那半棵，后台解析推进时 update 里会再重建）。已经解析完的树直接返回，不花时间。
 */
const FULL_PARSE_BUDGET_MS = 80;

function blockTree(state: EditorState): Tree {
  return ensureSyntaxTree(state, state.doc.length, FULL_PARSE_BUDGET_MS) ?? syntaxTree(state);
}

/** [TOC] 需要的标题清单。只在文档里真的有 [TOC] 时才算。 */
function collectHeadings(
  state: EditorState,
  tree: Tree,
  frontMatter: FrontMatterRange | null,
): TocEntry[] {
  const entries: TocEntry[] = [];
  tree.iterate({
    enter(node) {
      // front matter 里的 `title: x` 会被解析成 Setext 标题，不能进目录
      if (frontMatter && node.type.name !== "Document" && node.from < frontMatter.to) return false;
      const match = HEADING_RE.exec(node.type.name);
      if (!match) return blockContainers.has(node.type.name);
      const line = state.doc.lineAt(node.from);
      const text = inlinePlainText(
        line.text
          .replace(/^\s{0,3}#{1,6}\s+/, "")
          .replace(/\s+#+\s*$/, "")
          .trim(),
      );
      if (text) entries.push({ level: Number(match[1]), text, from: node.from });
      return false;
    },
  });
  return entries;
}

/** 围栏的语言名：info 串的第一个词，小写。 */
const fenceLanguage = (info: string) => info.split(/\s+/)[0]?.toLowerCase() ?? "";

/**
 * 表格源码 → 解析结果。块级层每敲一个字都整篇重建一次，没改的表格不用每次再解析
 * （解析结果只读：表格替身改结构时先复制，见 tableWidget.ts 的 columnChanges）
 */
const parsedTables = new Map<string, MarkdownTableModel | null>();

function parsedTable(key: string, parse: () => MarkdownTableModel | null) {
  if (parsedTables.has(key)) {
    const table = parsedTables.get(key) ?? null;
    // 挪到最后：Map 按插入顺序，满了从最久没用的删
    parsedTables.delete(key);
    parsedTables.set(key, table);
    return table;
  }
  const table = parse();
  parsedTables.set(key, table);
  if (parsedTables.size > 200) parsedTables.delete(parsedTables.keys().next().value!);
  return table;
}

/** 段落里有没有可能是脚注定义（`[^id]:`）或缩写定义（`*[缩写]:`）的行 */
const DEFINITION_HINT_RE = /(?:^|\n)[^\S\n]{0,3}(?:\[\^|\*\[)/;

function buildBlockDecorations(state: EditorState, changes: ChangeSet | null): TyporaBlockState {
  const ranges: DecorationRange[] = [];
  const fresh = freshness(changes);
  const foldedLines = new Set<number>();
  const referenceLabels = new Set<string>();
  const abbreviations = new Map<string, string>();
  const abbreviationLines = new Set<number>();
  const footnotes = new Map<string, string>();
  const frontMatter = frontMatterRange(state.doc);
  const tree = blockTree(state);
  // 收起的标题下面那几节（headingFold.ts）：整段一个块级替换，里面不再生成别的块级装饰 ——
  // 替换套着替换时，和外层起点相同的那个可能先被画出来，也省得给看不见的东西建替身
  const hiddenSections = outermostSections(state);
  const hidden = (position: number) =>
    hiddenSections.some((section) => position >= section.from && position <= section.to);
  let headings: TocEntry[] | null = null;
  let toc = false;
  const probes: number[] = [];
  /** selectionTouches，顺便记下问了什么、答了什么（TyporaBlockState.probes） */
  const touches = (from: number, to: number) => {
    const hit = selectionTouches(state, from, to);
    probes.push(from, to, hit ? 1 : 0);
    return hit;
  };

  const foldLine = (from: number, to: number, widget?: WidgetType) => {
    if (to <= from || hidden(from)) return;
    markFreshness(widget, from, to, fresh);
    foldedLines.add(from);
    ranges.push({ from, to, value: Decoration.replace({ block: true, widget }) });
  };
  /** 整块折叠。范围一律撑到整行：块级替换不能只盖住半行。 */
  const foldRange = (from: number, to: number, widget?: WidgetType) => {
    if (to <= from || hidden(from)) return;
    const first = state.doc.lineAt(from);
    const last = state.doc.lineAt(to);
    markFreshness(widget, first.from, last.to, fresh);
    for (let number = first.number; number <= last.number; number += 1) {
      foldedLines.add(state.doc.line(number).from);
    }
    ranges.push({
      from: first.from,
      to: last.to,
      value: Decoration.replace({ block: true, widget }),
    });
  };
  const lineClass = (from: number, className: string) => {
    if (hidden(from)) return;
    ranges.push({ from, to: from, value: Decoration.line({ class: className }) });
  };
  const lineClasses = (from: number, to: number, className: string) => {
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;
    for (let number = first; number <= last; number += 1) {
      lineClass(state.doc.line(number).from, className);
    }
  };
  /** 一个段落 / 引用定义里的脚注定义行和缩写定义行。 */
  const scanDefinitionLines = (from: number, to: number) => {
    const start = state.doc.lineAt(from);
    // 绝大多数段落里根本没有定义：整段先看一眼，没有就不逐行取出来跑正则
    if (!DEFINITION_HINT_RE.test(state.sliceDoc(start.from, to))) return;
    const first = start.number;
    const last = state.doc.lineAt(to).number;
    for (let number = first; number <= last; number += 1) {
      const line = state.doc.line(number);
      const footnote = FOOTNOTE_DEF_RE.exec(line.text);
      if (footnote) {
        const body = inlinePlainText(line.text.slice(footnote[0].length));
        footnotes.set(footnote[1]!, body.replace(/\s+/g, " ").trim().slice(0, 240));
        continue;
      }
      const abbreviation = ABBREVIATION_RE.exec(line.text);
      if (abbreviation) {
        abbreviations.set(abbreviation[1]!.trim(), abbreviation[2]!.trim());
        abbreviationLines.add(line.from);
        lineClass(line.from, "cm-odea-abbr-def");
      }
    }
  };

  if (frontMatter) {
    const open = state.doc.line(frontMatter.openLine);
    const close = state.doc.line(frontMatter.closeLine);
    // 从 from + 1 起算：新挂载的编辑器光标停在 0，那不算「点进了属性块」，
    // 否则每篇带 front matter 的笔记一打开就是一坨展开的 YAML。
    const active = touches(frontMatter.from + 1, frontMatter.to);
    for (let number = open.number + 1; number < close.number; number += 1) {
      lineClass(state.doc.line(number).from, "cm-odea-frontmatter");
    }
    if (active) {
      // 和折叠时的封口一样高（globals.css「围栏的几何」），点进来时下面的正文不跳
      lineClass(open.from, "cm-odea-frontmatter cm-odea-frontmatter-fence-line is-open");
      lineClass(close.from, "cm-odea-frontmatter cm-odea-frontmatter-fence-line is-close");
    } else {
      foldLine(open.from, open.to, new FrontMatterFenceWidget("open"));
      foldLine(close.from, close.to, new FrontMatterFenceWidget("close"));
    }
  }

  tree.iterate({
    enter(node) {
      const { name } = node.type;
      // front matter 里的 `---` 会被解析成分隔线和 Setext 标题，整段绕开。
      if (frontMatter && name !== "Document" && node.from < frontMatter.to) return false;

      if (name === "FencedCode") {
        const open = state.doc.lineAt(node.from);
        const close = state.doc.lineAt(node.to);
        const opens = FENCE_LINE_RE.test(open.text);
        const closed = close.number > open.number && CLOSING_FENCE_RE.test(close.text);
        // 只有真的有代码内容时才折叠；空围栏折叠后就再也点不进去了。
        if (!touches(node.from, node.to) && close.number - open.number >= 2) {
          const info = open.text.replace(FENCE_LINE_RE, "").trim();
          const language = fenceLanguage(info);
          const code = state.sliceDoc(open.to + 1, Math.max(open.to + 1, close.from - 1));
          // 图表和 CSV 不是「代码」：整块换成图 / 表，点一下才回到源码
          if (closed && language === "mermaid") {
            foldRange(node.from, node.to, new DiagramWidget(code));
            return false;
          }
          if (closed && (language === "csv" || language === "tsv")) {
            const table = parsedTable(`${language}\u0000${code}`, () =>
              parseDelimitedTable(code, language === "csv" ? "," : "\t"),
            );
            if (table) {
              foldRange(
                node.from,
                node.to,
                new TableWidget(table, language, code, open.to + 1 - open.from),
              );
              return false;
            }
          }
          if (opens) foldLine(open.from, open.to, new CodeFenceWidget("open", info, code));
          if (closed) foldLine(close.from, close.to, new CodeFenceWidget("close", "", code));
          return false;
        }
        // 围栏露出源码时画成和封口同样大小的框（globals.css「围栏的几何」）。
        // 以前源码行比封口矮一截：一点进代码块，上面的围栏行缩下去，整块代码
        // 连同刚点的那一行一起往上跳。
        if (opens) lineClass(open.from, "cm-odea-fence-source is-open");
        if (closed) lineClass(close.from, "cm-odea-fence-source is-close");
        return false;
      }

      if (name === "MathBlock") {
        if (touches(node.from, node.to)) {
          lineClasses(node.from, node.to, "cm-odea-math-source");
        } else {
          const tex = state
            .sliceDoc(node.from, node.to)
            .replace(/^\$\$/, "")
            .replace(/\$\$$/, "")
            .trim();
          foldRange(node.from, node.to, new MathWidget(tex, true));
        }
        return false;
      }

      if (name === "HTMLBlock") {
        if (!touches(node.from, node.to)) {
          const source = state.sliceDoc(node.from, node.to);
          foldRange(node.from, node.to, new HtmlBlockWidget(source));
        }
        return false;
      }

      if (name === "CommentBlock") {
        if (!touches(node.from, node.to)) {
          foldRange(node.from, node.to, new CommentWidget(true));
        }
        return false;
      }

      if (name === "LinkReference") {
        const label = node.node.getChild("LinkLabel");
        if (label) referenceLabels.add(normalizeLabel(state.sliceDoc(label.from, label.to)));
        scanDefinitionLines(node.from, node.to);
        return false;
      }

      if (name === "Paragraph") {
        const line = state.doc.lineAt(node.from);
        if (line.to >= node.to && TOC_RE.test(line.text)) {
          toc = true;
          if (touches(line.from, line.to)) {
            lineClass(line.from, "cm-odea-toc-source");
          } else {
            headings ??= collectHeadings(state, tree, frontMatter);
            foldLine(line.from, line.to, new TocWidget(headings));
          }
          return false;
        }
        scanDefinitionLines(node.from, node.to);
        return false;
      }

      if (widgetByNode.get(name) === "table") {
        if (!touches(node.from, node.to)) {
          const tableSource = state.sliceDoc(node.from, node.to);
          const table = parsedTable(`md\u0000${tableSource}`, () =>
            parseMarkdownTable(tableSource),
          );
          const indent = node.from - state.doc.lineAt(node.from).from;
          if (table)
            foldRange(node.from, node.to, new TableWidget(table, "markdown", tableSource, indent));
        }
        return false;
      }

      if (widgetByNode.get(name) === "horizontal-rule") {
        const line = state.doc.lineAt(node.from);
        // 分隔线独占一行时整行替换，别让源码行留成一条空行。
        if (line.from === node.from && line.to === node.to) {
          if (!touches(node.from, node.to)) {
            foldLine(line.from, line.to, new HorizontalRuleWidget());
          } else {
            // 露出来的 `---` 和分隔线一样高，光标进出时下面的正文不跳
            lineClass(line.from, "cm-odea-hr-source");
          }
        }
        return false;
      }

      if (/^SetextHeading[12]$/.test(name)) {
        if (!touches(node.from, node.to)) {
          const underline = state.doc.lineAt(node.to);
          // 只藏掉 `===` 三个字符等于留下一条空行，得整行折叠。
          if (SETEXT_UNDERLINE_RE.test(underline.text)) foldLine(underline.from, underline.to);
        }
        return false;
      }

      if (name === "Blockquote") {
        // `> [!标签]-`：默认收起的 callout，正文整块折成一行「展开」
        const line = state.doc.lineAt(node.from);
        const head = parseCalloutHead(line.text);
        const last = state.doc.lineAt(node.to);
        if (head?.fold === "-" && last.number > line.number && !touches(node.from, node.to)) {
          const bodyFrom = state.doc.line(line.number + 1).from;
          foldRange(
            bodyFrom,
            node.to,
            new CalloutFoldWidget(last.number - line.number, head.kind, head.foldOffset),
          );
          return false;
        }
        return true;
      }

      return blockContainers.has(name);
    },
  });

  for (const section of hiddenSections) {
    const first = state.doc.lineAt(section.from).number;
    const last = state.doc.lineAt(section.to).number;
    for (let number = first; number <= last; number += 1) {
      foldedLines.add(state.doc.line(number).from);
    }
    ranges.push({ from: section.from, to: section.to, value: Decoration.replace({ block: true }) });
    ranges.push({
      from: section.headingEnd,
      to: section.headingEnd,
      value: Decoration.widget({ widget: new FoldedSectionWidget(section.lines), side: 1 }),
    });
  }

  const decorations = toDecorationSet(ranges);
  return {
    decorations,
    atomic: decorations,
    foldedLines,
    referenceLabels,
    frontMatter,
    abbreviations,
    abbreviationLines,
    footnotes,
    probes,
    toc,
  };
}

/** 换成新选区，构建时问过的那些「光标碰没碰到」是不是还是同样的答案 */
function sameTouches(probes: readonly number[], state: EditorState): boolean {
  const ranges = revealRanges(state);
  for (let index = 0; index < probes.length; index += 3) {
    const hit = selectionTouchesRange(ranges, probes[index]!, probes[index + 1]!);
    if (hit !== (probes[index + 2] === 1)) return false;
  }
  return true;
}

/** 一段里有没有哪一行是 `[TOC]`（块级层把单独一行的它换成目录） */
const TOC_LINE_RE = /^\s*\[\[?toc\]?\]\s*$/im;

/**
 * 改动落在哪个普通段落里（标题也算，文档里没有 `[TOC]` 的时候）：从改动处最里层的节点往外找，
 * 找到的那一块要把 [from, to] 整个包住，外面只隔着列表、引用。引用的第一行不算（那是 callout
 * 的标签行，`-` 结尾时正文整块折叠）；代码块、表格这些块级层要管的东西里的改动也不算。
 */
function plainBlockAround(
  state: EditorState,
  tree: Tree,
  from: number,
  to: number,
  headings: boolean,
): SyntaxNode | null {
  if (tree.length < to) return null;
  for (const side of [1, -1] as const) {
    let found: SyntaxNode | null = null;
    for (let node: SyntaxNode | null = tree.resolveInner(from, side); node; node = node.parent) {
      const { name } = node.type;
      if (!found) {
        if (name === "Paragraph" || (headings && /^ATXHeading[1-6]$/.test(name))) {
          if (node.from > from || node.to < to) break;
          found = node;
        }
        continue;
      }
      if (name === "Document") return found;
      if (name === "Blockquote" && state.doc.lineAt(node.from).to < from) continue;
      if (name !== "BulletList" && name !== "OrderedList" && name !== "ListItem") break;
    }
  }
  return null;
}

/** 这一块里没有块级层要收集的东西：脚注 / 缩写定义、单独一行的 `[TOC]` */
function plainText(state: EditorState, node: SyntaxNode): boolean {
  const text = state.sliceDoc(state.doc.lineAt(node.from).from, node.to);
  return !DEFINITION_HINT_RE.test(text) && !TOC_LINE_RE.test(text);
}

/**
 * 打字时多半不用整篇重建块级层：改动全落在普通段落里，段落的头尾正好跟着平移（没有合并、
 * 拆开，也没变成标题、表格、代码块），段落里外都没有块级层管的东西 —— 这时重建出来的
 * 和旧的一模一样，只是改动后面的位置挪了，把旧的映射过去就行。70KB 的长文 4 倍降速下
 * 每敲一个字省下约 10ms 的整篇遍历。不满足就返回 null，照旧整篇重建。
 * `markdownSyntax.dom.test.ts` 拿各处随手改的结果和整篇重建的比对着。
 */
function mapBlockState(value: TyporaBlockState, transaction: Transaction): TyporaBlockState | null {
  const { changes, startState, state } = transaction;
  const before = syntaxTree(startState);
  const after = syntaxTree(state);
  const frontMatter = frontMatterRange(state.doc);
  if (
    (frontMatter === null) !== (value.frontMatter === null) ||
    (frontMatter && value.frontMatter && frontMatter.to !== value.frontMatter.to)
  ) {
    return null;
  }
  let local = true;
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (!local) return;
    if (value.frontMatter && fromA <= value.frontMatter.to) {
      local = false;
      return;
    }
    const was = plainBlockAround(startState, before, fromA, toA, !value.toc);
    const now = plainBlockAround(state, after, fromB, toB, !value.toc);
    local =
      !!was &&
      !!now &&
      was.type === now.type &&
      changes.mapPos(was.from, -1) === now.from &&
      changes.mapPos(was.to, 1) === now.to &&
      plainText(startState, was) &&
      plainText(state, now);
    // 旧的装饰碰到了改动（比如一段折叠正文的边上）：不冒这个险
    if (local) {
      value.decorations.between(fromA, toA, () => {
        local = false;
        return false;
      });
    }
  });
  if (!local) return null;

  // 问过的那些块要么整个在改动前后（怎么映射都一样），要么就是包着这一段的列表、引用 ——
  // 在它最后一段的末尾打字，它跟着变长，所以终点取插入的右边
  const probes = value.probes.slice();
  for (let index = 0; index < probes.length; index += 3) {
    probes[index] = changes.mapPos(probes[index]!, -1);
    probes[index + 1] = changes.mapPos(probes[index + 1]!, 1);
  }
  // 光标进出了哪个块（选中一大段再打字把它替换掉）：得按新选区重建
  if (!sameTouches(probes, state)) return null;
  const mapLines = (lines: Set<number>) =>
    new Set([...lines].map((position) => changes.mapPos(position, 1)));
  const decorations = value.decorations.map(changes);
  return {
    ...value,
    decorations,
    atomic: decorations,
    foldedLines: mapLines(value.foldedLines),
    abbreviationLines: mapLines(value.abbreviationLines),
    probes,
  };
}

export const typoraBlockDecorations = StateField.define<TyporaBlockState>({
  // 初次构建（刚打开这篇）没有 changes：替身全都算新出现，照常播入场动画
  create: (state) => buildBlockDecorations(state, null),
  update(value, transaction) {
    // 收起 / 展开了标题（不只是跟着改动平移）：整篇重建
    if (!foldsOnlyMoved(transaction)) {
      return buildBlockDecorations(transaction.state, transaction.changes);
    }
    // 折叠与否取决于光标在不在块里，所以选区变化也要重算；
    // 后台解析往前推进了（语法树换了一棵）也要重算，不然解析得晚的那一段里的
    // 表格、公式、[TOC] 的标题要等下一次点击才出来。
    // 三样都没变时旧值里的位置依然有效，直接沿用。
    if (transaction.docChanged) {
      return (
        mapBlockState(value, transaction) ??
        buildBlockDecorations(transaction.state, transaction.changes)
      );
    }
    if (syntaxTree(transaction.startState) !== syntaxTree(transaction.state)) {
      return buildBlockDecorations(transaction.state, transaction.changes);
    }
    // 只动了光标：大多数时候光标还在原来那些块的里面 / 外面（在正文里上下走、
    // 在一段里左右挪），重建出来和现在一模一样。长文里每按一下方向键以前都要把
    // 整棵树走一遍（70KB 的文档 4 倍降速下约 10ms）。
    // 看的是 revealRanges 不是选区：鼠标拖选时选区在变、它不变；点进 / 点出正文时选区没变、它变了
    if (
      revealRanges(transaction.startState) !== revealRanges(transaction.state) &&
      !sameTouches(value.probes, transaction.state)
    ) {
      return buildBlockDecorations(transaction.state, transaction.changes);
    }
    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.from(field, (value) => () => value.atomic),
  ],
});

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
          const image = resolveImage(
            state.doc.toString(),
            state.sliceDoc(node.from, node.to),
            state.facet(imageBaseDir),
          );
          // 源码没露出来就不用往里走了；露出来了照常给 `![`、`](` 这些标记上色
          if (image && !addImage(node.from, node.to, image, "markdown")) return false;
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
              // 链到还没有的笔记：画成虚线，Ctrl+点击新建（DocumentView 的 handleWikiLink）
              const missing = !!knownTitles && !knownTitles.has(wikiKey(target.title));
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

const typoraInlineDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomic: DecorationSet;

    constructor(view: EditorView) {
      // 刚挂上：替身全都算新出现，照常播入场动画
      const built = buildInlineDecorations(view, null);
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
        update.startState.field(headingFolds, false) !== update.state.field(headingFolds, false) ||
        update.startState.facet(imageBaseDir) !== update.state.facet(imageBaseDir) ||
        update.startState.facet(knownWikiTitles) !== update.state.facet(knownWikiTitles)
      ) {
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

/**
 * 编辑器要的完整装饰扩展：块级 StateField + 行内 ViewPlugin，外加两层共用的「算数的选区」
 * （reveal.ts）和标题收起的状态（headingFold.ts）。
 */
export const typoraDecorations: Extension = [
  revealField,
  headingFoldExtension,
  typoraBlockDecorations,
  typoraInlineDecorations,
];

/**
 * `![alt](src "title")` / `![alt][ref]`，alt 里的 `|300` / `|300x200` 是 Obsidian 式尺寸。
 */
export function resolveImage(
  markdown: string,
  source: string,
  base: string | null = null,
): ImageSpec | null {
  const inline = /^!\[([^\]]*)\]\((\S+?)(?:\s+["'](.*)["'])?\)$/.exec(source);
  if (inline) return withSize(inline[1]!, inline[2]!, inline[3] ?? "", base);

  const reference = /^!\[([^\]]*)\]\[([^\]]*)\]$/.exec(source);
  if (!reference) return null;
  const label = (reference[2] || reference[1]!).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const definition = new RegExp(
    `^\\[${label}\\]:\\s*(?:<([^>]+)>|(\\S+))(?:\\s+["'(](.*?)["')])?`,
    "im",
  ).exec(markdown);
  const url = definition?.[1] ?? definition?.[2];
  return url ? withSize(reference[1]!, url, definition?.[3] ?? "", base) : null;
}

function withSize(rawAlt: string, source: string, title: string, base: string | null): ImageSpec {
  const size = /^(.*?)\|(\d+)(?:x(\d+))?$/.exec(rawAlt);
  return {
    alt: (size ? size[1]! : rawAlt).trim(),
    source: resolveImageSource(source, base),
    title,
    width: size ? Number(size[2]) : null,
    height: size?.[3] ? Number(size[3]) : null,
  };
}
