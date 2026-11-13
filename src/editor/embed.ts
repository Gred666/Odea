import { documentFolder, vaultFileSrc } from "@/data/attachments";
import { useData } from "@/data/store";
import { type EmbedTarget, sectionOf } from "@/lib/embeds";
import { MOD_KEY, isMac } from "@/lib/platform";
import { resolveVaultFile } from "@/lib/wikiFiles";
import { type StaticOptions, renderStaticHtml } from "@/render/staticHtml";
import "@/render/static.css";
import { Facet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { safeImageSource } from "./html";
import { OtwWidget, jumpToSource, positionOf } from "./widgets";

/* ============================================================
   `![[笔记]]`、`![[笔记#小节]]`：把另一篇（或它的一节）嵌在正文里，只读。认目标、取一节在 lib/embeds.ts。

   一行里只有它的时候才嵌（Obsidian 的嵌入一般也单独一行）；夹在一段字里的照旧是 `!` 加一个双链。

   和图片一样（widgets.ts 的 ImageWidget）：替身插在源码前面，光标碰到这一行时源码在卡片下面露出来，
   没碰到时藏掉。点卡片 = 光标放到源码上（选了卡片里的字就不跳，好复制）；按住 Ctrl 再点 = 打开那一篇。

   卡片里画的是那一篇现在的正文：数据层的正文缓存（bodies）换了、列表里它的「上次更新」变了就重画，
   在这里存的、外部改的、同步过来的都跟得上。用的是静态渲染（render/staticHtml.ts，导出也用它）：
   图片（相对那一篇所在的文件夹，`![[图.png]]` 按名字在仓库里找）、公式、图表、代码高亮都画；
   嵌进来的那一篇里再写 `![[…]]` 不展开（画成双链）：不会一层套一层，自己嵌自己也就一层。
   卡片里的链接不跳走（这是编辑器的页面），可以收起的 callout 点标题行开合
   ============================================================ */

export interface EmbedHost {
  /** 标题（去掉两头空白、转小写）→ 笔记 id。只认得这些；做客的那一篇这里是 null，不嵌 */
  ids: ReadonlyMap<string, string>;
  /** 按住 Ctrl 点卡片：打开那一篇（和 Ctrl+点双链同一条路） */
  open: (title: string, heading: string | undefined, newTab: boolean) => void;
}

/** MarkdownEditor 按 linkTargets 给；没给（浏览器的实验台、做客）就不嵌，照旧显示源码 */
export const embedHost = Facet.define<EmbedHost | null, EmbedHost | null>({
  combine: (values) => values[0] ?? null,
});

export const embedKey = (title: string) => title.trim().toLowerCase();

/**
 * 盯着一篇笔记的正文：先给一次，之后变了再给（笔记没了给 undefined）。返回取消。
 * 正文缓存里有就用它（在这里存的、外部改了的都会换掉它）；缓存里没有（被挤掉了），
 * 就看列表里它的「上次更新」，变了再取一次
 */
export function watchNoteBody(
  id: string,
  listener: (markdown: string | undefined) => void,
): () => void {
  let stopped = false;
  let last: string | undefined | null = null;
  const deliver = (markdown: string | undefined) => {
    if (stopped || markdown === last) return;
    last = markdown;
    listener(markdown);
  };
  const load = () => {
    void useData.getState().loadBody(id).then(deliver);
  };
  const versionOf = (state: ReturnType<typeof useData.getState>) =>
    (state.notes.find((note) => note.id === id) ?? state.archived.find((note) => note.id === id))
      ?.updatedAt;
  let version = versionOf(useData.getState());
  load();
  const unsubscribe = useData.subscribe((state, previous) => {
    const body = state.bodies[id];
    if (body !== undefined && body !== previous.bodies[id]) {
      deliver(body);
      return;
    }
    const next = versionOf(state);
    if (next === version) return;
    version = next;
    load();
  });
  return () => {
    stopped = true;
    unsubscribe();
  };
}

/**
 * 卡片里那一篇怎么画：图片相对它自己所在的文件夹（不是嵌它的这一篇），`![[图.png]]` 从它的位置找起
 */
export function embedOptions(id: string): StaticOptions {
  const { vaultRoot, notes, archived, attachments } = useData.getState();
  const relPath = (notes.find((note) => note.id === id) ?? archived.find((note) => note.id === id))
    ?.relPath;
  const folder = documentFolder(vaultRoot, relPath);
  return {
    image: (source) => safeImageSource(source, folder),
    wikiImage: (name) => {
      const rel = resolveVaultFile(name, relPath ?? null, attachments);
      return rel ? vaultFileSrc(vaultRoot, rel) : null;
    },
    math: true,
    diagrams: true,
    highlight: true,
    idPrefix: `embed-${id}-`,
  };
}

const FILE_ICON =
  "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8";

/** 卡片对那一篇的订阅：替身拆掉时收 */
const live = new WeakMap<HTMLElement, () => void>();

export class EmbedWidget extends OtwWidget {
  constructor(
    private readonly target: EmbedTarget,
    /** 那一篇的 id；null = 还没有这一篇 */
    private readonly id: string | null,
    /** 光标在这一行上：源码在卡片下面露出来 */
    private readonly open: boolean,
  ) {
    super();
  }

  eq(other: EmbedWidget) {
    return (
      other.target.title === this.target.title &&
      other.target.heading === this.target.heading &&
      other.id === this.id &&
      other.open === this.open
    );
  }

  protected override heightKey() {
    return this.id === null ? null : `embed:${this.id}#${this.target.heading ?? ""}`;
  }

  protected override guessHeight() {
    return 120;
  }

  toDOM(view: EditorView) {
    const doc = view.dom.ownerDocument;
    const element = (tag: string, className: string) => {
      const node = doc.createElement(tag);
      node.className = className;
      return node;
    };
    const { title, heading } = this.target;

    // 外层管留白（padding，见 widgets.ts 文件头），里层是卡片
    const frame = element("span", `cm-odea-embed-frame${this.open ? " is-open" : ""}`);
    const card = element("span", "cm-odea-embed");
    const head = element("span", "cm-odea-embed-head");
    const icon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("class", "cm-odea-embed-icon");
    icon.setAttribute("aria-hidden", "true");
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", FILE_ICON);
    icon.append(path);
    const name = element("span", "cm-odea-embed-title");
    name.textContent = title;
    head.append(icon, name);
    if (heading) {
      const section = element("span", "cm-odea-embed-section");
      section.textContent = `› ${heading}`;
      head.append(section);
    }
    head.dataset.odeaTip = "";
    head.dataset.odeaTipHint = this.id === null ? "还没有这篇笔记" : `${MOD_KEY}+点击打开`;
    const body = element("div", "cm-odea-embed-body odea-static");
    card.append(head, body);
    frame.append(card);

    const note = (text: string) => {
      const span = doc.createElement("span");
      span.className = "cm-odea-embed-note";
      span.textContent = text;
      return span;
    };
    // 内容到了、图片和公式的字体加载完，这一行就变高了：CodeMirror 只在上次更新 75ms 以后才理会尺寸变化，叫它重新量
    const remeasure = () => {
      queueMicrotask(() => {
        if (frame.isConnected) view.requestMeasure();
      });
    };
    body.addEventListener("load", remeasure, true);
    if (this.id === null) {
      body.append(note(`还没有「${title}」这篇笔记`));
    } else {
      const id = this.id;
      /** 第几次重画：正文接连变了几次，只用最后一次排出来的 */
      let run = 0;
      const stop = watchNoteBody(id, (markdown) => {
        const shown = markdown === undefined || !heading ? markdown : sectionOf(markdown, heading);
        const message =
          markdown === undefined
            ? `找不到「${title}」这篇笔记`
            : shown === null
              ? `「${title}」里没有「${heading}」这一节`
              : !shown?.trim()
                ? "（这一篇还是空的）"
                : null;
        const mine = ++run;
        if (message !== null) {
          body.replaceChildren(note(message));
          remeasure();
          return;
        }
        void renderStaticHtml(shown ?? "", embedOptions(id)).then((html) => {
          if (mine !== run) return;
          // 排出来的是静态渲染器自己生成的标记：用户的字都转义过，HTML 按白名单重建过（render/staticHtml.ts）
          body.innerHTML = html;
          remeasure();
        });
      });
      live.set(frame, stop);
    }

    const modifier = (event: MouseEvent) => (isMac ? event.metaKey : event.ctrlKey);
    frame.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || !modifier(event) || this.id === null) return;
      event.preventDefault();
      view.state.facet(embedHost)?.open(title, heading, event.shiftKey);
    });
    frame.addEventListener("click", (event) => {
      if (event.button !== 0 || modifier(event)) return;
      const target = event.target as Element | null;
      // 卡片里的链接、目录、脚注不跳走：这是编辑器的页面
      if (target?.closest("a")) event.preventDefault();
      // 点可以收起的 callout 的标题行：开合，不跳到源码
      if (target?.closest("summary")) return;
      // 在卡片里拖着选了字：是要复制，不跳
      const selection = doc.getSelection();
      if (selection && !selection.isCollapsed && frame.contains(selection.anchorNode)) return;
      // 光标放进 `![[` 里面：双链的方括号跟着露出来，源码是完整的 `![[笔记]]`，好改
      jumpToSource(view, positionOf(view, frame) + 3);
    });
    frame.addEventListener("toggle", remeasure, true);
    return this.settle(frame);
  }

  override destroy(dom: HTMLElement) {
    super.destroy(dom);
    const stop = live.get(dom);
    if (!stop) return;
    live.delete(dom);
    stop();
  }

  override ignoreEvent() {
    return true;
  }
}
