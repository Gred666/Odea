import { isTauri } from "@/lib/tauri";
import { Facet } from "@codemirror/state";
import { convertFileSrc } from "@tauri-apps/api/core";

/* ============================================================
   笔记里的 HTML。

   原则不变：永远不把用户写的字符串交给 innerHTML。行内标签只在装饰层
   映射成样式类（`<b>` 和 `**` 走同一个类），块级 HTML 先用 DOMParser 解析到
   一份惰性文档里，再按白名单一个节点一个节点地重建 —— 脚本、事件属性、
   javascript: 地址、外部样式表在重建时全部丢掉。
   ============================================================ */

/** 行内标签 → 装饰类。`<b>` 和 `**` 长得一样，不另起一套样式。 */
export const INLINE_HTML_TAGS: Readonly<Record<string, string>> = {
  b: "cm-odea-strong",
  strong: "cm-odea-strong",
  i: "cm-odea-emphasis",
  em: "cm-odea-emphasis",
  cite: "cm-odea-emphasis",
  var: "cm-odea-emphasis",
  s: "cm-odea-strike",
  del: "cm-odea-strike",
  strike: "cm-odea-strike",
  u: "cm-odea-underline",
  ins: "cm-odea-underline",
  mark: "cm-odea-highlight",
  sub: "cm-odea-sub",
  sup: "cm-odea-sup",
  kbd: "cm-odea-kbd",
  code: "cm-odea-code",
  samp: "cm-odea-code",
  small: "cm-odea-small",
  big: "cm-odea-big",
  span: "cm-odea-span",
  font: "cm-odea-span",
  a: "cm-odea-link",
  abbr: "cm-odea-abbr",
};

/** 单标签：没有闭合，行内直接换成替身。 */
export const VOID_HTML_TAGS = new Set(["br", "img", "hr", "wbr"]);

export interface ParsedTag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: Record<string, string>;
}

const TAG_RE =
  /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>`]+))?)*)\s*(\/?)>$/;
const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;

/** 解析一个标签字面量（`<span style="…">` / `</span>` / `<br/>`）。不是标签返回 null。 */
export function parseTag(source: string): ParsedTag | null {
  const match = TAG_RE.exec(source.trim());
  if (!match) return null;
  const attrs: Record<string, string> = {};
  for (const attr of (match[3] ?? "").matchAll(ATTR_RE)) {
    attrs[attr[1]!.toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? "";
  }
  return {
    name: match[2]!.toLowerCase(),
    closing: match[1] === "/",
    selfClosing: match[4] === "/",
    attrs,
  };
}

/* ---------------- 样式白名单 ---------------- */

const COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([\d\s.,%/]+\)|[a-z]+)$/i;
const LENGTH = /^\d+(?:\.\d+)?(?:px|em|rem|%|pt)$/i;

const STYLE_RULES: Readonly<Record<string, RegExp>> = {
  color: COLOR,
  "background-color": COLOR,
  background: COLOR,
  "font-size": LENGTH,
  "font-weight": /^(?:[1-9]00|bold|normal|bolder|lighter)$/i,
  "font-style": /^(?:italic|normal|oblique)$/i,
  "font-family": /^[\w\s,'"-]+$/,
  "text-decoration":
    /^(?:underline|line-through|overline|none)(?:\s+(?:underline|line-through|overline|wavy|dotted|dashed|solid|double))*$/i,
  "text-align": /^(?:left|center|right|justify)$/i,
  "vertical-align": /^(?:sub|super|baseline|middle|top|bottom)$/i,
};

/** `<font size>` 的 1–7 档对应的字号。 */
const FONT_SIZES = ["0.63em", "0.82em", "1em", "1.13em", "1.5em", "2em", "3em"];

/** 只放行颜色、字号、粗细这几样排版属性；`position` / `url()` 之类一律丢掉。 */
export function sanitizeStyle(style: string | undefined): string | null {
  if (!style) return null;
  const kept: string[] = [];
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    const rule = STYLE_RULES[property];
    if (rule?.test(value)) kept.push(`${property}: ${value}`);
  }
  return kept.length ? kept.join("; ") : null;
}

/** 一个行内标签自带的样式：`style=` 过滤后，再把 `<font color size>` 折算进去。 */
export function inlineStyleOf(tag: ParsedTag): string | null {
  const parts: string[] = [];
  const style = sanitizeStyle(tag.attrs.style);
  if (style) parts.push(style);
  if (tag.name === "font") {
    if (tag.attrs.color && COLOR.test(tag.attrs.color)) parts.push(`color: ${tag.attrs.color}`);
    const size = Number(tag.attrs.size);
    if (size >= 1 && size <= 7) parts.push(`font-size: ${FONT_SIZES[size - 1]}`);
  }
  return parts.length ? parts.join("; ") : null;
}

/* ---------------- 地址 ---------------- */

/** `<a href>` 只放行能用系统浏览器打开的那几种协议。 */
export function safeHref(url: string | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  return /^(?:https?:\/\/|mailto:|tel:)/i.test(trimmed) ? trimmed : null;
}

const LOCAL_PATH_RE = /^(?:[a-zA-Z]:[\\/]|\/(?!\/)|\\\\)/;
/** 带协议的地址（http:、data:、asset: …）和锚点：不是相对路径 */
const SCHEME_RE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|#)/;

/**
 * 自己解析图片地址：做客时（协作，collab/attachments.ts）图片在主持人那台，要来缓存在本机。
 * 每次要到新图片换一个新的对象，编辑器按引用比较，换了才重画
 */
export interface ImageResolver {
  /** 正文里写的地址 → <img> 用的；空串 = 还没有（显示占位） */
  resolve(source: string): string;
}

/** 文件夹（绝对路径），或者自己解析的 */
export type ImageBase = string | ImageResolver | null;

/**
 * 这篇文档所在的文件夹（绝对路径，正斜杠）。正文里的相对图片路径（附件，
 * `../附件/截图.png`）以它为基准 —— 和 Typora、Obsidian、VS Code 的解析一样。
 * 由 MarkdownEditor 按文档配置；浏览器预览里没有仓库文件夹，是 null。做客的那一篇是解析器
 */
export const imageBaseDir = Facet.define<ImageBase, ImageBase>({
  combine: (values) => values[0] ?? null,
});

/**
 * 图片地址。桌面端把本机绝对路径（`C:\…`、`/…`、`file://…`）和相对这篇文档的
 * 路径转成 asset 协议，WebView 才读得到；网络地址和 data: 原样返回。
 * 没有基准目录（浏览器预览、HTML 块里的 <img>）时相对路径只能原样交给 <img>。
 */
export function resolveImageSource(source: string, base: ImageBase = null): string {
  const trimmed = source.trim();
  if (base && typeof base === "object") return base.resolve(trimmed);
  const fileUrl = /^file:\/\//i.test(trimmed);
  if (!fileUrl && !LOCAL_PATH_RE.test(trimmed)) {
    if (!base || !trimmed || SCHEME_RE.test(trimmed) || !isTauri) return trimmed;
    return convertFileSrc(joinPath(base, decodeFilePath(trimmed)));
  }
  if (!isTauri) return trimmed;
  return convertFileSrc(fileUrl ? filePathOf(trimmed) : trimmed);
}

/**
 * 基准目录 + 相对路径，`..` 和 `.` 就地消掉：`D:/仓库/笔记` + `../附件/a.png` →
 * `D:/仓库/附件/a.png`。不会退到盘符 / 根目录之上。
 */
export function joinPath(base: string, relative: string): string {
  const parts = base.replace(/\\/g, "/").split("/");
  const root = parts.shift() ?? "";
  const stack = parts.filter((part) => part && part !== ".");
  for (const part of relative.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return [root, ...stack].join("/");
}

/**
 * `file:///C:/a.png` → `C:/a.png`，`file:///Users/a.png` → `/Users/a.png`。
 * 以前是把 `file:///` 连同第三个斜杠一起去掉 —— Windows 盘符路径没事，
 * macOS / Linux 的绝对路径却丢了开头的 `/`，变成相对路径，图片永远加载不出来。
 */
function filePathOf(url: string): string {
  const path = decodeFilePath(url.replace(/^file:\/\/(?:localhost(?=\/))?/i, ""));
  // Windows 盘符前面那个斜杠不属于路径
  return /^\/[a-zA-Z]:[\\/]/.test(path) ? path.slice(1) : path;
}

/**
 * `file://` 地址里的百分号转义。`100%.png` 这种没编码的 `%` 会让 decodeURI 抛
 * URIError —— 这里是在装饰层里调用的，一抛整个行内装饰插件就崩了，整篇笔记
 * 退回裸 Markdown。解不开就按字面路径用。
 */
function decodeFilePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** `<img src>` 只放行图片能来的地方；不合规的返回 null，替身会显示 alt。 */
export function safeImageSource(source: string | undefined, base: ImageBase = null): string | null {
  if (!source) return null;
  const trimmed = source.trim();
  if (/^(?:javascript|vbscript):/i.test(trimmed)) return null;
  if (/^data:/i.test(trimmed) && !/^data:image\//i.test(trimmed)) return null;
  return resolveImageSource(trimmed, base);
}

/* ---------------- 块级 HTML 的净化重建 ---------------- */

const BLOCK_TAGS = new Set([
  "div",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "blockquote",
  "pre",
  "details",
  "summary",
  "hr",
  "br",
  "img",
  "figure",
  "figcaption",
  "center",
  "section",
  "article",
  "aside",
  "nav",
  "header",
  "footer",
  "main",
  "address",
  "dl",
  "dt",
  "dd",
]);

/** 整棵子树都不要的：脚本、样式表、嵌入内容、表单。 */
const DROP_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "link",
  "meta",
  "base",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "svg",
  "math",
  "template",
  "noscript",
  "video",
  "audio",
  "source",
  "track",
  "canvas",
  "dialog",
]);

const DIGITS = /^\d{1,4}$/;
const ALIGN = /^(?:left|center|right|justify)$/i;

/** 每种标签允许带的属性，以及怎么清洗它的值。 */
function sanitizeAttribute(tag: string, name: string, value: string): string | null {
  switch (name) {
    case "title":
      return value;
    case "style":
      return sanitizeStyle(value);
    case "align":
      return ALIGN.test(value) ? value.toLowerCase() : null;
    case "href":
      return tag === "a" ? safeHref(value) : null;
    case "src":
      return tag === "img" ? safeImageSource(value) : null;
    case "alt":
      return tag === "img" ? value : null;
    case "width":
    case "height":
      return (tag === "img" || tag === "td" || tag === "th" || tag === "table") &&
        DIGITS.test(value)
        ? value
        : null;
    case "colspan":
    case "rowspan":
      return (tag === "td" || tag === "th") && DIGITS.test(value) ? value : null;
    case "start":
      return tag === "ol" && DIGITS.test(value) ? value : null;
    case "open":
      return tag === "details" ? "" : null;
    case "color":
    case "size":
      return null; // <font> 在 rebuild 里折算成 style
    default:
      return null;
  }
}

function rebuild(source: Node, target: Node): void {
  for (const child of source.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(document.createTextNode(child.textContent ?? ""));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    const tag = element.tagName.toLowerCase();
    if (DROP_TAGS.has(tag)) continue;

    const allowed = BLOCK_TAGS.has(tag) || tag in INLINE_HTML_TAGS;
    if (!allowed) {
      // 不认识但也无害的标签：只留内容
      rebuild(element, target);
      continue;
    }

    // <font> 没有语义，落成带 style 的 span
    const node = document.createElement(tag === "font" ? "span" : tag);
    const styles: string[] = [];
    for (const attr of element.attributes) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) continue;
      const value = sanitizeAttribute(tag, name, attr.value);
      if (value === null) continue;
      if (name === "style") styles.push(value);
      else node.setAttribute(name, value);
    }
    if (tag === "font") {
      const style = inlineStyleOf({
        name: "font",
        closing: false,
        selfClosing: false,
        attrs: attrsOf(element),
      });
      if (style) styles.push(style);
    }
    if (styles.length) node.setAttribute("style", styles.join("; "));
    if (tag === "img") {
      node.setAttribute("loading", "lazy");
      node.setAttribute("decoding", "async");
    }
    rebuild(element, node);
    target.appendChild(node);
  }
}

function attrsOf(element: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of element.attributes) attrs[attr.name.toLowerCase()] = attr.value;
  return attrs;
}

/**
 * 把一段 HTML 源码变成可以直接挂进页面的节点。
 * DOMParser 解析出来的文档是惰性的（脚本不执行、资源不加载），我们只从里面
 * 按白名单抄节点出来，所以最终挂上去的树里不可能有脚本或事件属性。
 */
export function sanitizeHtml(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const parsed = new DOMParser().parseFromString(source, "text/html");
  rebuild(parsed.body, fragment);
  return fragment;
}

/** 块级 HTML 有没有值得渲染的东西；纯注释或空白就不用换替身了。 */
export function hasRenderableHtml(source: string): boolean {
  return /<[a-zA-Z]/.test(source);
}
