import { animatedEmojiFor, inlineAnimatedEmoji } from "./animatedEmoji";
import { emojiFor } from "./emoji";
import { decodeEntity } from "./entities";
import { INLINE_HTML_TAGS, inlineStyleOf, parseTag, safeHref } from "./html";

/**
 * 把一小段行内 Markdown 渲染成真实 DOM 节点。
 *
 * 给表格 widget 的单元格和目录 widget 用 —— 它们不在 CodeMirror 的装饰体系里，
 * 得自己画。永远只产出元素和文本节点，不走 innerHTML，所以没有注入面。
 * 覆盖：代码、粗体、斜体、删除线（一个或两个 `~`）、高亮、链接、双链、转义、
 * 实体、Emoji（动态表情画成悬停会动的小图），以及白名单里的行内 HTML 标签（`<b>` `<mark>` `<sub>` `<span style>`…）
 * 和 `<br>` 换行。
 */
const INLINE_RE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\3|(\*|_)(?=\S)([^*_\n]+?)(?<=\S)\5|(~~?)(?=\S)([\s\S]+?)(?<=\S)\7|==(?=\S)([\s\S]+?)(?<=\S)==|<br\s*\/?>|<([a-z][a-z0-9]*)((?:\s+[^>]*?)?)>([\s\S]*?)<\/\10\s*>|\[\[([^\]\n]+?)\]\]|\[([^\]\n]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)|\\([\\`*_{}[\]()#+\-.!~=<>|])|(&(?:#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);)|:([a-z0-9_+-]+):/gi;

export function renderInline(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index!;
    if (index > last) out.push(document.createTextNode(text.slice(last, index)));
    last = index + match[0].length;

    const [
      whole,
      ,
      code,
      ,
      strong,
      ,
      emphasis,
      ,
      strike,
      highlight,
      htmlTag,
      htmlAttrs,
      htmlInner,
      wiki,
      linkText,
      linkUrl,
      escaped,
      entity,
      emoji,
    ] = match;

    if (code !== undefined) {
      out.push(element("code", "cm-odea-code", [document.createTextNode(code.trim())]));
    } else if (strong !== undefined) {
      out.push(element("strong", "cm-odea-strong", renderInline(strong)));
    } else if (emphasis !== undefined) {
      out.push(element("em", "cm-odea-emphasis", renderInline(emphasis)));
    } else if (strike !== undefined) {
      out.push(element("del", "cm-odea-strike", renderInline(strike)));
    } else if (highlight !== undefined) {
      out.push(element("mark", "cm-odea-highlight", renderInline(highlight)));
    } else if (/^<br/i.test(whole)) {
      out.push(document.createElement("br"));
    } else if (htmlTag !== undefined) {
      out.push(renderHtmlTag(whole, htmlTag, htmlAttrs ?? "", htmlInner ?? ""));
    } else if (wiki !== undefined) {
      const [target, alias] = wiki.split("|");
      const node = element("span", "cm-odea-wikilink", [
        document.createTextNode((alias ?? target ?? "").trim()),
      ]);
      node.dataset.target = (target ?? "").trim();
      out.push(node);
    } else if (linkText !== undefined) {
      const node = element("span", "cm-odea-link", renderInline(linkText));
      node.dataset.href = linkUrl ?? "";
      node.title = linkUrl ?? "";
      out.push(node);
    } else if (escaped !== undefined) {
      out.push(document.createTextNode(escaped));
    } else if (entity !== undefined) {
      out.push(document.createTextNode(decodeEntity(entity) ?? entity));
    } else if (emoji !== undefined) {
      const animated = animatedEmojiFor(emoji);
      out.push(
        animated
          ? inlineAnimatedEmoji(animated)
          : document.createTextNode(emojiFor(emoji) ?? whole),
      );
    } else {
      out.push(document.createTextNode(whole));
    }
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

/** 白名单里的行内标签变成带样式的元素；不在白名单的标签原样当文字。 */
function renderHtmlTag(whole: string, tagName: string, attrs: string, inner: string): Node {
  const name = tagName.toLowerCase();
  const className = INLINE_HTML_TAGS[name];
  const tag = parseTag(`<${name}${attrs}>`);
  if (!className || !tag) return document.createTextNode(whole);
  // <font> 没有语义，用 span 承载它的颜色和字号
  const node = element(name === "font" ? "span" : name, className, renderInline(inner));
  const style = inlineStyleOf(tag);
  if (style) node.setAttribute("style", style);
  if (name === "a") {
    const href = safeHref(tag.attrs.href);
    if (href) {
      node.dataset.href = href;
      node.title = href;
    }
  }
  if (name === "abbr" && tag.attrs.title) {
    node.dataset.odeaTipLabel = node.textContent?.trim() ?? "";
    node.dataset.odeaTip = tag.attrs.title;
  }
  return node;
}

/**
 * 去掉行内标记后的纯文本，目录条目、tooltip 这类地方用。
 * 带缓存：块级层每次重建都要给全文的标题和脚注定义算一遍，长文档里几十上百次，
 * 而这些行几乎从不变。
 */
export function inlinePlainText(text: string): string {
  const cached = plainTextCache.get(text);
  if (cached !== undefined) return cached;
  const plain = renderInline(text)
    .map((node) => node.textContent ?? "")
    .join("");
  if (plainTextCache.size >= PLAIN_TEXT_CACHE_LIMIT) {
    const oldest = plainTextCache.keys().next().value;
    if (oldest !== undefined) plainTextCache.delete(oldest);
  }
  plainTextCache.set(text, plain);
  return plain;
}

const plainTextCache = new Map<string, string>();
const PLAIN_TEXT_CACHE_LIMIT = 2000;

function element(tag: string, className: string, children: Node[]): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...children);
  return node;
}
