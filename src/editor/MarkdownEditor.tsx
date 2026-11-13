import { collab as collabBinding } from "@/collab/binding";
import type { CollabSession } from "@/collab/session";
import type { Attachment, MatchAnchor, OutlineItem } from "@/data/types";
import { registerEditorCommands } from "@/lib/editorCommands";
import { registerLiveEditor, touched } from "@/lib/liveDocuments";
import { usePaneWindow } from "@/lib/paneWindow";
import { rememberSpot, spotOf } from "@/lib/viewMemory";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { languages } from "@codemirror/language-data";
import { closeSearchPanel, search, searchPanelOpen, setSearchQuery } from "@codemirror/search";
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  Prec,
  Transaction,
} from "@codemirror/state";
import { EditorView, type ViewUpdate, keymap, placeholder } from "@codemirror/view";
import { Link2, Plus } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { EmojiPicker, type EmojiPickerAnchor } from "./EmojiPicker";
import { SuggestMenu, type SuggestMenuHandle, type SuggestRow } from "./SuggestMenu";
import { TemplatePicker, type TemplatePickerHandle } from "./TemplatePicker";
import { type AnimatedEmoji, forgetDetachedEmoji, primeIntro } from "./animatedEmoji";
import { type AttachmentHost, attachmentHost } from "./attachmentEmbed";
import { type AttachHooks, attachmentHandlers, watchDesktopFileDrops } from "./attachments";
import { onCalloutsChange } from "./callout";
import { codeHighlight } from "./codeHighlight";
import { type DebouncedSaver, createDebouncedSaver } from "./debouncedSave";
import { NO_TITLES, knownWikiTitles, wikiKey } from "./decorationKit";
import { type EmbedHost, embedHost, embedKey } from "./embed";
import { frontMatterRange } from "./frontMatter";
import { glideTo, isGliding } from "./glide";
import {
  foldAllHeadings,
  foldMarks,
  headingFolds,
  restoreFolds,
  unfoldAllHeadings,
} from "./headingFold";
import { hoverCard } from "./hoverCard";
import { type ImageBase, type WikiImageResolver, imageBaseDir, wikiImages } from "./html";
import { linkTargetAt, modKeyCursor, openExternal, splitWikiTarget, wikiTargetAt } from "./links";
import { markdownKeymap } from "./markdownKeymap";
import { markdownSupport } from "./markdownParser";
import { createRevisionLog, rebaseEdit, recordRevision, revisionOf } from "./pluginEdits";
import { readingLine, sectionAt } from "./readingLine";
import { revealIdle, trackEditing } from "./reveal";
import { registerEditorFlush } from "./saveBus";
import { createSearchPanel, matchOnLine, queryOfAnchor, scrollToMatch } from "./searchPanel";
import { selectionLayer } from "./selectionLayer";
import { smoothCaret } from "./smoothCaret";
import { isPinnedState } from "./statePins";
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
import { tablePasteHandler } from "./tableClipboard";
import { insertEmptyTable } from "./tableWidget";
import {
  type DocTemplate,
  NOTE_PLACEHOLDER,
  type TemplateContext,
  type TemplateMode,
  applyTemplate,
  carriedTasks,
  hasOtherContent,
  onTemplatesChange,
  templateTrigger,
  templatesFor,
  templatesRevisionOf,
} from "./templates";
import { typoraDecorations } from "./typoraDecorations";

/**
 * Typora 式 Markdown 编辑器。
 *
 * 文档始终是 Markdown 源文；非当前语法范围只隐藏标记并施加排版样式，光标进入
 * 后标记在原位置重新出现，所以 `#`、`**`、链接等都能直接修改，不存在富文本
 * AST 与 Markdown 互转导致的输入跳行或内容漂移。
 */

/** 外部内容回填产生的事务，不该被当成用户输入去触发保存。 */
const externalSync = Annotation.define<boolean>();

/* ---------------- 同一篇开在两个窗格（docs/标签页与分屏.md §14）----------------
   分屏时同一篇可以开在两个窗格里，各是一个编辑器（各自的光标、滚动、撤销历史）。
   在一边打的字原样转给另一边（CodeMirror 的 split 例子那样转事务），另一边当成「别人改的」：
   不进它的撤销历史、不由它存盘（打字的那一边存），也不算它和磁盘对上了 —— 对上没对上
   还是看存盘回来的那一版（syncedMarkdownRef），不然存盘回来一版旧的会把转过来的新字盖掉。
   后挂上的那个用先挂着的那个现在的正文建，不用 store 里的（那一版可能还差着没存的几个字）。
   协作中的不转：协作的绑定一个编辑器一份，正文以会话为准（窗格那边也只让一个窗格编辑它） */
const mirrorSync = Annotation.define<boolean>();
const liveEditors = new Map<string, Set<EditorView>>();

function twinsOf(key: string, view: EditorView): EditorView[] {
  return [...(liveEditors.get(key) ?? [])].filter((other) => other !== view);
}

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
/** `![[图.png]]` 怎么在仓库里找文件（html.ts 的 wikiImages）：仓库里的图片多了少了、这一篇挪了位置时换掉 */
const wikiImageSlot = new Compartment();
/** 有哪些笔记标题：新建、改名、删掉笔记时单独换掉 */
const wikiTitlesSlot = new Compartment();
/** `![[笔记]]` 嵌入认得哪些笔记（editor/embed.ts）：和上面一起换 */
const embedSlot = new Compartment();
/** `![[说明书.pdf]]` 这类附件按名字找、怎么打开（editor/attachmentEmbed.ts）：仓库里的附件多了少了时换掉 */
const attachmentSlot = new Compartment();
/** 协作会话（collab/binding.ts）：编辑器挂着时开始、结束协作，单独换上、换下 */
const collabSlot = new Compartment();
/** 只读（协作时主持人给的权限是「只读」；文件不是 UTF-8）：能选、能复制，不能改 */
const readOnlySlot = new Compartment();
/**
 * 只读时谁也不能改正文。EditorState.readOnly 只拦得住键盘输入，点一下就改源码的那些
 * （勾任务的方框、提示块的折叠箭头、加粗这类快捷键）照样 dispatch —— 改了又存不进去：
 * 不是 UTF-8 的文件后端拒绝写回（docs/1110审查与研究.md §5.1），协作的只读访客改了也传不出去。
 * 别处同步过来的（协作的对方、外部改动回填、另一个窗格转过来的）照常进来
 */
const readOnlyGuard = EditorState.transactionFilter.of((tr) =>
  tr.docChanged &&
  tr.startState.readOnly &&
  !tr.annotation(Transaction.remote) &&
  !tr.annotation(externalSync) &&
  !tr.annotation(mirrorSync)
    ? []
    : tr,
);
/**
 * 撤销历史。同一篇在另一个窗格里再开一个编辑器（向右拆分）时沿用那边的状态 —— 解析好的语法树、
 * 装饰都不用重来，长文省下二三十毫秒（docs/标签页与分屏.md §15.6）—— 历史要换成空的：
 * 两边各撤各的（§14）
 */
const historySlot = new Compartment();

/** 同一个状态，撤销历史换成空的（先拿掉再装回来：同一次里换，历史的字段会原样留着） */
function withFreshHistory(state: EditorState): EditorState {
  const bare = state.update({ effects: historySlot.reconfigure([]) }).state;
  return bare.update({ effects: historySlot.reconfigure(history()) }).state;
}

/** 最近切走的这么多篇留着。大文档一篇的状态有几 MB，不能无限留 */
const STATE_CACHE_LIMIT = 12;
/** 开着的标签那几篇另算（editor/statePins.ts），连它们在内总数到这么多再按最久没用的挤 */
const STATE_CACHE_HARD_LIMIT = 24;
const stateCache = new Map<string, EditorState>();

function rememberState(key: string, state: EditorState) {
  stateCache.delete(key);
  stateCache.set(key, state);
  // Map 按放进去的先后排，最久没用的在前面
  const loose = [...stateCache.keys()].filter((other) => !isPinnedState(other));
  for (const oldest of loose.slice(0, Math.max(0, loose.length - STATE_CACHE_LIMIT))) {
    stateCache.delete(oldest);
  }
  while (stateCache.size > STATE_CACHE_HARD_LIMIT) {
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
  wikiImage: wikiImageResolver = null,
  attachments = null,
  linksMissing = false,
  onAttachFiles,
  onAttachPaths,
  linkTargets,
  linkSelf,
  onExitTop,
  collab = null,
  readOnly = false,
}: {
  initialMarkdown: string;
  onSave: (markdown: string) => Promise<void>;
  outlineItems: OutlineItem[];
  onOutlineHandle: (handle: EditorOutlineHandle | null) => void;
  /** 正文变化时回调，供目录树跟着当前输入实时更新。 */
  onDocumentChange?: (markdown: string) => void;
  /** Mod + 点击 `[[双链]]` 时回调：目标标题，以及 `[[标题#小节]]` 里的小节（没有就是 undefined）。 */
  /** Mod + 点击双链；再按着 Shift 是要开在新标签里（docs/标签页与分屏.md §4.1） */
  onWikiLink?: (title: string, heading?: string, newTab?: boolean) => void;
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
  imageBase?: ImageBase;
  /**
   * Obsidian 的 `![[图.png]]`：写的名字 → 仓库里的哪个文件。没给（浏览器的实验台、做客）就画成找不到
   */
  wikiImage?: WikiImageResolver | null;
  /**
   * `![[说明书.pdf]]` 这类图片以外的附件：单独一行时画成卡片（editor/attachmentEmbed.ts）。没给（浏览器的实验台）
   * 就照旧显示源码
   */
  attachments?: AttachmentHost | null;
  /**
   * 双链一律按「不存在」画：做客的那一篇里的双链指向的是主持人的笔记，这边没有
   * （没有 linkTargets 时平时是不判断存不存在）
   */
  linksMissing?: boolean;
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
  /**
   * 这篇正在协作（docs/协同编辑.md）：正文以会话的为准，编辑器挂上时用它的内容建，
   * initialMarkdown 的变化（外部改动回填）不管 —— 外部改动由上层合进会话（collab/external.ts）。
   * 协作中的文档不进、也不取编辑器状态缓存：切走期间别人还在改
   */
  collab?: CollabSession | null;
  /** 只读：能选、能复制，不能改（协作时被给了「只读」） */
  readOnly?: boolean;
}) {
  const paneDoc = usePaneWindow().doc;
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
  const wikiImageRef = useRef(wikiImageResolver);
  const attachmentsRef = useRef(attachments);
  const collabRef = useRef(collab);
  const readOnlyRef = useRef(readOnly);
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
  /** 这篇现在有没有能用的模板（下面按 templates 算了填进来）：打字弹模板菜单、`/` 菜单要不要列「模板」看它 */
  const hasTemplatesRef = useRef(false);
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
    () =>
      linkTargets
        ? new Set(linkTargets.map((note) => wikiKey(note.title)))
        : linksMissing
          ? NO_TITLES
          : null,
    [linkTargets, linksMissing],
  );
  const knownTitlesRef = useRef(knownTitles);
  // `![[笔记]]` 嵌入（editor/embed.ts）：认得哪些笔记、Ctrl+点卡片打开。做客的那一篇没有 linkTargets，不嵌
  const embeds = useMemo<EmbedHost | null>(
    () =>
      linkTargets
        ? {
            ids: new Map(linkTargets.map((note) => [embedKey(note.title), note.id])),
            open: (title, heading, newTab) => onWikiLinkRef.current?.(title, heading, newTab),
          }
        : null,
    [linkTargets],
  );
  const embedsRef = useRef(embeds);

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
          // 这篇能用的模板一个都没有（笔记、没开带模板的插件）：不弹
          if (!measured || !templateContextRef.current || !hasTemplatesRef.current) return;
          templateOpenRef.current = true;
          templateSessionRef.current += 1;
          setTemplateMenu({ ...measured, session: templateSessionRef.current });
        },
      });
    };

    /** 选择器开着时，触发词那一行被别人的改动挪了位置：重新量，选择器跟着字走（不重新打开） */
    const remeasureTemplateMenu = (view: EditorView) => {
      view.requestMeasure({
        read: (current) => {
          const trigger = templateTrigger(current.state);
          return trigger ? caretAnchor(current, trigger.from) : null;
        },
        write: (anchor) => {
          if (!anchor || !templateOpenRef.current) return;
          setTemplateMenu((menu) => (menu ? { ...menu, anchor } : menu));
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
          placeholder(templateContextRef.current.placeholder),
          EditorView.updateListener.of((update) => {
            if (templateOpenRef.current) {
              // 接着打字、退格、光标挪走、点到别处：触发词不在了就收起
              const moved =
                (update.docChanged || update.selectionSet) && !templateTrigger(update.state);
              if (moved || (update.focusChanged && !update.view.hasFocus)) closeTemplateMenu();
              // 别人（协同）在上面加了几行：触发词那一行在页面上挪了，选择器跟过去
              else if (update.docChanged && remoteChange(update))
                remeasureTemplateMenu(update.view);
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
    /** 菜单开着时被别人的改动挪了位置：重新量，菜单跟着字走 */
    const remeasureSuggest = (view: EditorView, session: number) => {
      view.requestMeasure({
        read: (current) => {
          const open = suggestRef.current;
          return open?.session === session ? caretAnchor(current, open.from) : null;
        },
        write: (anchor) => {
          const open = suggestRef.current;
          if (!anchor || open?.session !== session) return;
          const next = { ...open, anchor };
          suggestRef.current = next;
          setSuggest(next);
        },
      });
    };
    /** `/` 后面打的字一项都对不上，就是在写普通文字；没有笔记列表（单测）不弹 `[[` */
    const hasSuggestions = (trigger: SuggestTrigger) =>
      trigger.kind === "wiki"
        ? !!linkTargetsRef.current
        : slashItems(trigger.query, hasTemplatesRef.current).length > 0;
    /** 菜单开着时，把方向键 / 回车 / Tab / Esc 转给它；输入法组字时的按键是给候选框的 */
    const forwardToSuggest =
      (action: (menu: SuggestMenuHandle) => boolean) => (view: EditorView) => {
        const menu = suggestHandleRef.current;
        if (!suggestRef.current || !menu || view.composing) return false;
        return action(menu);
      };

    const suggestExtensions: Extension[] = [
      EditorView.updateListener.of((update) => {
        let open = suggestRef.current;
        if (open && update.focusChanged && !update.view.hasFocus) {
          closeSuggest();
          return;
        }
        if (!update.docChanged && !update.selectionSet) return;
        // 触发词的起点跟着改动映射：别人（协同）在前面加了字，菜单还是这一个，不收起；
        // 在页面上的位置也变了，重新量一次
        if (update.docChanged) {
          if (open) {
            const from = update.changes.mapPos(open.from, 1);
            if (from !== open.from) {
              open = { ...open, from };
              suggestRef.current = open;
              setSuggest(open);
            }
            if (remoteChange(update)) remeasureSuggest(update.view, open.session);
          }
          if (suggestDismissedRef.current !== null) {
            suggestDismissedRef.current = update.changes.mapPos(suggestDismissedRef.current, 1);
          }
        }
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

    // 插件（L1）改正文按修订号来（editor/pluginEdits.ts）：这个编辑器里每改一笔都记下来，
    // 谁改的都算（打字、撤销、另一个窗格转过来的、协作别人的、外部回填的）
    const revisions = createRevisionLog();

    // 这个编辑器实例自己的那一截：闭包里握着这次的保存器和 React 状态。
    // 复用缓存的状态时，换掉的就是这一截（见文件开头的说明）。
    const sessionExtensions: Extension[] = [
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        recordRevision(revisions, update.changes);
        if (key) touched(key);
      }),
      ...templateExtensions,
      // 笔记的空白正文：告诉人 `/` 和 `[[` 能做什么（某一天 / 某个周期的提示在 templateExtensions 里）
      ...(templateContextRef.current ? [] : [placeholder(NOTE_PLACEHOLDER)]),
      ...suggestExtensions,
      imageBaseSlot.of(imageBaseDir.of(imageBaseRef.current)),
      wikiImageSlot.of(wikiImages.of(wikiImageRef.current)),
      collabSlot.of(collabRef.current ? collabBinding(collabRef.current) : []),
      readOnlySlot.of(EditorState.readOnly.of(readOnlyRef.current)),
      readOnlyGuard,
      wikiTitlesSlot.of(knownWikiTitles.of(knownTitlesRef.current)),
      embedSlot.of(embedHost.of(embedsRef.current)),
      attachmentSlot.of(attachmentHost.of(attachmentsRef.current)),
      // 整个剪贴板就是一张表（Excel、网页、从表格里复制的一片）：变成 Markdown 表格
      tablePasteHandler,
      attachmentHandlers(() => attachRef.current),
      linkClickHandler((title, heading, newTab) => onWikiLinkRef.current?.(title, heading, newTab)),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) {
          if (update.focusChanged && !update.view.hasFocus) saver.flushQuietly();
          return;
        }
        const markdown = update.state.doc.toString();
        notifyDocumentChange(markdown);
        // 另一个窗格里打的字转过来的：那边存盘，这边不存
        if (update.transactions.some((transaction) => transaction.annotation(mirrorSync))) return;
        // 外部回填不是用户输入，不能反过来触发一次保存。
        if (update.transactions.some((transaction) => transaction.annotation(externalSync))) {
          syncedMarkdownRef.current = markdown;
          return;
        }
        // 同一篇开在别的窗格里：这边打的字转过去
        if (key && !collabRef.current) {
          for (const twin of twinsOf(key, update.view)) {
            twin.dispatch({
              changes: update.changes,
              annotations: [mirrorSync.of(true), Transaction.addToHistory.of(false)],
            });
          }
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

    const shared = collabRef.current;
    // 同一篇已经在别的窗格里开着：用它现在的正文（两边从同一份开始，转过来的改动才对得上位置）
    const twin = key && !shared ? [...(liveEditors.get(key) ?? [])][0] : undefined;
    const initialDoc = shared
      ? shared.toString()
      : twin
        ? twin.state.doc.toString()
        : initialMarkdownRef.current;
    const cached = key && !shared ? takeState(key, initialDoc) : null;
    // 没有缓存、另一个窗格里开着这一篇：从它现在的状态接着用（历史清空）
    const reused = cached ?? (twin ? withFreshHistory(twin.state) : null);
    // 上次在这篇看到哪、光标在哪（切回来、重新打开应用都回到那里）
    const spot = key ? spotOf(key) : undefined;
    const docLength = initialDoc.length;
    const restoredHead = spot ? Math.min(spot.head, docLength) : 0;
    const state = reused
      ? // 解析好的语法树、装饰、撤销历史原样沿用
        reused.update({
          effects: [session.reconfigure(sessionExtensions), ...revealIdle()],
          selection: EditorSelection.cursor(restoredHead),
        }).state
      : EditorState.create({
          doc: initialDoc,
          selection: EditorSelection.cursor(restoredHead),
          extensions: [
            // 围栏代码按语言名懒加载对应的解析器，配合 codeHighlight 上色
            markdownSupport(languages),
            codeHighlight,
            historySlot.of(history()),
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
    // 挂在弹出窗口里（docs/标签页与分屏.md §16）：游离时建的编辑器认的是主窗口的文档，
    // 焦点、选区、窗口事件、样式都要换成它实际在的那个，不然光标画不出来、打的字落在别处
    if (host.ownerDocument !== document) view.setRoot(host.ownerDocument);
    viewRef.current = view;
    live.view = view;
    if (key) {
      const views = liveEditors.get(key) ?? new Set<EditorView>();
      views.add(view);
      liveEditors.set(key, views);
    }
    // 切走时开着查找面板：回来时不该还开着（和以前每次新建编辑器一样）
    if (searchPanelOpen(view.state)) closeSearchPanel(view);
    // 上次收起的标题（缓存的、另一个窗格的状态里本来就带着）。在滚回上次的位置之前：那个位置是按收着的样子记的
    if (!reused) {
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

    // 插件（L1）够到这一篇的地方（lib/liveDocuments.ts）：实时正文、修订号、改它的入口。
    // 插件的改动和打字走同一条路：进撤销历史、转给另一个窗格、经协作发给别人、自动存盘
    const unregisterLive = key
      ? registerLiveEditor(key, {
          text: () => live.view?.state.doc.toString() ?? "",
          revision: () => revisionOf(revisions),
          edit(base, changes) {
            const view = live.view;
            if (!view) return { ok: false, code: "stale", message: "这篇已经关了" };
            if (view.state.readOnly) {
              return { ok: false, code: "readonly", message: "这篇现在只读" };
            }
            // 输入法正在组字时改正文会打断它（候选框里的字没了）
            if (view.composing) {
              return { ok: false, code: "busy", message: "正在用输入法打字，等一下再改" };
            }
            const rebased = rebaseEdit(revisions, base, changes, view.state.doc.length);
            if (!rebased.ok) return rebased;
            view.dispatch({ changes: rebased.changes, userEvent: "plugin.edit" });
            return { ok: true, revision: revisionOf(revisions) };
          },
        })
      : null;

    return () => {
      const view = live.view;
      if (!view) return;
      unregisterLive?.();
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
      const views = key ? liveEditors.get(key) : undefined;
      views?.delete(view);
      if (key && views && !views.size) liveEditors.delete(key);
      // 协作中的不缓存：切走期间别人还在改，回来时以会话的正文为准。
      // 别的窗格里还开着同一篇：也不缓存，那边卸载时缓存它的（那份是最新的）
      if (key && !collabRef.current && !views?.size) rememberState(key, view.state);
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

  // 仓库里的图片多了少了、这一篇挪了位置：`![[图.png]]` 重新找
  useEffect(() => {
    wikiImageRef.current = wikiImageResolver;
    const view = viewRef.current;
    if (!view || view.state.facet(wikiImages) === wikiImageResolver) return;
    view.dispatch({ effects: wikiImageSlot.reconfigure(wikiImages.of(wikiImageResolver)) });
  }, [wikiImageResolver]);

  // 仓库里的附件多了少了、这一篇挪了位置：`![[说明书.pdf]]` 的卡片重新找
  useEffect(() => {
    attachmentsRef.current = attachments;
    const view = viewRef.current;
    if (!view || view.state.facet(attachmentHost) === attachments) return;
    view.dispatch({ effects: attachmentSlot.reconfigure(attachmentHost.of(attachments)) });
  }, [attachments]);

  // 编辑器挂着时开始 / 结束协作：换上、换下绑定。开始时会话是拿编辑器里现在的正文建的，
  // 两边一致；撤销历史留着（主持人的历史都是自己的改动）
  useEffect(() => {
    if (collabRef.current === collab) return;
    collabRef.current = collab;
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: collabSlot.reconfigure(collab ? collabBinding(collab) : []) });
  }, [collab]);

  useEffect(() => {
    if (readOnlyRef.current === readOnly) return;
    readOnlyRef.current = readOnly;
    viewRef.current?.dispatch({
      effects: readOnlySlot.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  // 开关了带提示块的插件（L0，plugins/declared.ts）：空跑一笔事务，两层装饰看到版本变了整篇重画
  useEffect(() => onCalloutsChange(() => viewRef.current?.dispatch({})), []);

  // 笔记新建、改名、删掉了：链到不存在的笔记的双链重新标
  useEffect(() => {
    knownTitlesRef.current = knownTitles;
    const view = viewRef.current;
    if (!view || view.state.facet(knownWikiTitles) === knownTitles) return;
    view.dispatch({ effects: wikiTitlesSlot.reconfigure(knownWikiTitles.of(knownTitles)) });
  }, [knownTitles]);

  // 同上：嵌进来的那一篇新建了、改名了、删掉了，卡片跟着换
  useEffect(() => {
    embedsRef.current = embeds;
    const view = viewRef.current;
    if (!view || view.state.facet(embedHost) === embeds) return;
    view.dispatch({ effects: embedSlot.reconfigure(embedHost.of(embeds)) });
  }, [embeds]);

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
    // 协作中：正文的真相是会话。整篇替换 = 在 CRDT 里删光再插一遍，所有人的光标塌到一处
    if (!view || collabRef.current) return;
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
  // 开关了带模板的插件（L0）：模板换了，重取
  const templatesRevision = useSyncExternalStore(onTemplatesChange, templatesRevisionOf);
  // biome-ignore lint/correctness/useExhaustiveDependencies: templatesRevision 变了就是模板换了
  const templates = useMemo(
    () => (templateScope ? templatesFor(templateScope) : []),
    [templateScope, templatesRevision],
  );
  hasTemplatesRef.current = templates.length > 0;

  // `/` 菜单、`[[` 菜单里现在列着的项（和按键 pick 时取的是同一份）。
  // 「模板」那一项只在这篇有模板可用时列出来（笔记要开了带模板的插件才有）
  const withTemplates = templates.length > 0;
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
      else if (entry.item.action.type === "table") {
        // 光标进了表格的第一格，别再把焦点拉回正文
        insertEmptyTable(view, trigger);
        return;
      } else if (entry.item.action.type === "emoji") {
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
        // 弹出窗口里的编辑器（docs/标签页与分屏.md §16）：补全、表情、模板挂在那个窗口的 body 上
        paneDoc.body,
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
/** 这次更新里有别人（协同）的改动 */
const remoteChange = (update: ViewUpdate) =>
  update.transactions.some(
    (transaction) => transaction.docChanged && transaction.annotation(Transaction.remote),
  );

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
  /** 光标进了哪一节（光标一动就通知，订阅时先给一次） */
  subscribe: (listener: (id: string) => void) => () => void;
  /**
   * 跟着滚动：可视区（窗口坐标的上下边）里现在读到哪一节，规则见 readingLine。
   * atEnd：滚动容器已经滚到底了。编辑器已卸载、没有目录时返回 null
   */
  readingAt: (band: { top: number; bottom: number }, atEnd: boolean) => string | null;
  /** 正在滑过去（点了目录、查找跳转、脚注）：滑的路上不算读到了哪 */
  gliding: () => boolean;
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
    const active = sectionAt(outlineItemsRef.current, line);
    if (active) for (const listener of listeners) listener(active.id);
  };
  const handle: EditorOutlineHandle = {
    readingAt(band, atEnd) {
      const view = live.view;
      if (!view || outlineItemsRef.current.length === 0) return null;
      const { state } = view;
      const head = state.selection.main.head;
      // 光标那一处在窗口里的位置；不在画出来的范围里（滚远了）是 null，当它不在屏幕上
      const caret = view.coordsAtPos(head);
      const documentTop = view.documentTop;
      const line = readingLine({
        caret: caret && {
          line: state.doc.lineAt(head).number,
          top: caret.top,
          bottom: caret.bottom,
        },
        band,
        atEnd,
        lineAtY: (y) =>
          state.doc.lineAt(view.lineBlockAtHeight(Math.max(0, y - documentTop)).from).number,
      });
      return sectionAt(outlineItemsRef.current, line)?.id ?? null;
    },
    gliding() {
      return !!live.view && isGliding(live.view);
    },
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

function linkClickHandler(
  onWikiLink: (title: string, heading: string | undefined, newTab: boolean) => void,
): Extension {
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
        onWikiLink(title, heading, event.shiftKey);
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

// 装饰层在 blockDecorations.ts / inlineDecorations.ts，拼起来是 typoraDecorations.ts；
// 测试和别处还从这里引，照旧转出去
export { knownWikiTitles } from "./decorationKit";
export { type TyporaBlockState, typoraBlockDecorations } from "./blockDecorations";
export { typoraDecorations } from "./typoraDecorations";
export { resolveImage } from "./images";
