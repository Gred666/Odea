import { winOf } from "@/lib/paneWindow";
import { isTauri } from "@/lib/tauri";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";

/* ============================================================
   链接的点击行为。

   Mod + 点击打开（和 VS Code / Typora 一致）—— 普通点击得留给「把光标放进去
   改链接文字」。按住 Mod 时给链接换成手形光标，提示它此刻是可点的。
   ============================================================ */

/** 光标位置所在的链接的目标地址；不在链接里返回 null。 */
export function linkTargetAt(state: EditorState, position: number): string | null {
  let node = syntaxTree(state).resolveInner(position, 1);
  while (node.parent && !/^(?:Link|Autolink|URL|Image)$/.test(node.name)) node = node.parent;

  if (node.name === "URL") {
    // 裸 URL（GFM autolink）或链接定义里的地址
    const parent = node.parent;
    if (parent && /^(?:Link|Autolink|Image)$/.test(parent.name)) node = parent;
    else return state.sliceDoc(node.from, node.to);
  }
  if (!/^(?:Link|Autolink|Image)$/.test(node.name)) return null;

  const url = node.getChild("URL");
  if (url) return state.sliceDoc(url.from, url.to);

  // 引用式：[文字][标签] / [标签]，去文档里找 [标签]: 地址
  const label = node.getChild("LinkLabel") ?? node;
  const key = normalizeLabel(state.sliceDoc(label.from, label.to));
  if (!key) return null;
  let target: string | null = null;
  syntaxTree(state).iterate({
    enter(reference) {
      if (target || reference.name !== "LinkReference") return;
      const refLabel = reference.node.getChild("LinkLabel");
      const refUrl = reference.node.getChild("URL");
      if (refLabel && refUrl && normalizeLabel(state.sliceDoc(refLabel.from, refLabel.to)) === key)
        target = state.sliceDoc(refUrl.from, refUrl.to);
    },
  });
  return target;
}

export interface WikiTarget {
  /** 目标笔记的标题 */
  title: string;
  /** `[[标题#小节]]` 里的小节 */
  heading?: string;
  /** `[[标题^块id]]` 里的块 id（暂时只识别，不定位） */
  block?: string;
}

/** 把 `标题#小节` / `标题^块` 拆开；纯标题时 heading / block 都是 undefined。 */
export function splitWikiTarget(raw: string): WikiTarget {
  const hash = raw.indexOf("#");
  const caret = raw.indexOf("^");
  const cut = [hash, caret].filter((index) => index > 0).sort((a, b) => a - b)[0];
  if (cut === undefined) return { title: raw.trim() };
  const title = raw.slice(0, cut).trim();
  const rest = raw.slice(cut + 1).trim();
  return raw[cut] === "#"
    ? { title, heading: rest || undefined }
    : { title, block: rest || undefined };
}

/**
 * 光标位置所在的 `[[双链]]` 的目标标题（`[[目标|别名]]` 取目标）；不在双链里返回 null。
 * CommonMark 把 `[[x]]` 解析成夹在一对方括号文本里的短引用 Link，所以要看外面那两个括号。
 */
export function wikiTargetAt(state: EditorState, position: number): string | null {
  let node = syntaxTree(state).resolveInner(position, 1);
  while (node.parent && node.name !== "Link") node = node.parent;
  if (node.name !== "Link") return null;
  if (node.getChild("URL") || node.getChild("LinkLabel")) return null;
  if (state.sliceDoc(node.from - 1, node.from) !== "[") return null;
  if (state.sliceDoc(node.to, node.to + 1) !== "]") return null;
  const inner = state.sliceDoc(node.from + 1, node.to - 1);
  const target = (inner.split("|")[0] ?? "").trim();
  return target || null;
}

/** `[ Foo  Bar ]` → `foo bar`，CommonMark 的标签匹配规则。 */
export function normalizeLabel(label: string): string {
  return label
    .replace(/^\[|\]$/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** 只放行 http(s) / mailto / tel；本地路径和 javascript: 一律不开。 */
export function isOpenableUrl(url: string): boolean {
  return /^(?:https?:\/\/|mailto:|tel:)/i.test(url.trim());
}

/** 用系统浏览器打开。桌面端走 opener 插件，浏览器里退化成新标签页。 */
export async function openExternal(url: string): Promise<void> {
  if (!isOpenableUrl(url)) return;
  if (isTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url.trim());
    return;
  }
  window.open(url.trim(), "_blank", "noopener,noreferrer");
}

/**
 * 按住 Mod 时在内容区上打 `data-mod-key`，CSS 据此把链接换成手形光标。
 * 松开、失焦、窗口切走都要清掉，否则光标会卡在手形。
 */
export const modKeyCursor = ViewPlugin.fromClass(
  class {
    private readonly onKey = (event: KeyboardEvent) => this.sync(event.ctrlKey || event.metaKey);
    private readonly onClear = () => this.sync(false);

    /** 编辑器所在的那个窗口（弹出窗口里的编辑器，docs/标签页与分屏.md §16） */
    private readonly host: Window;

    constructor(private readonly view: EditorView) {
      this.host = winOf(view.dom);
      this.host.addEventListener("keydown", this.onKey);
      this.host.addEventListener("keyup", this.onKey);
      this.host.addEventListener("blur", this.onClear);
      this.host.document.addEventListener("visibilitychange", this.onClear);
    }

    private sync(held: boolean) {
      const { contentDOM } = this.view;
      if (held) contentDOM.dataset.modKey = "true";
      else delete contentDOM.dataset.modKey;
    }

    destroy() {
      this.host.removeEventListener("keydown", this.onKey);
      this.host.removeEventListener("keyup", this.onKey);
      this.host.removeEventListener("blur", this.onClear);
      this.host.document.removeEventListener("visibilitychange", this.onClear);
    }
  },
);
