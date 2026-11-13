import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * 围栏代码的语法高亮。
 *
 * 只给「代码里才会出现」的 tag 配色：关键字、字符串、注释、数字……
 * Markdown 自己的 tag（heading / emphasis / link / processingInstruction /
 * labelName / atom）刻意不在这里 —— 那些由装饰层负责，两边都染会打架。
 *
 * 颜色全部走 CSS 变量（globals.css 的 `--code-*`），亮暗主题各一套，
 * 这里只发类名。
 */
/** 静态渲染（render/staticHtml.ts）也用它给代码块上色：同一套 tok-* 类名 */
export const codeHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], class: "tok-keyword" },
  { tag: [t.definitionKeyword, t.moduleKeyword], class: "tok-keyword" },
  { tag: [t.string, t.special(t.string), t.character, t.regexp], class: "tok-string" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "tok-comment" },
  { tag: [t.number, t.integer, t.float, t.bool, t.null], class: "tok-number" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: "tok-function" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], class: "tok-definition" },
  { tag: [t.typeName, t.className, t.namespace, t.macroName], class: "tok-type" },
  { tag: [t.propertyName, t.attributeName], class: "tok-property" },
  { tag: [t.tagName, t.angleBracket], class: "tok-tag" },
  {
    tag: [t.operator, t.arithmeticOperator, t.logicOperator, t.compareOperator],
    class: "tok-operator",
  },
  {
    tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace, t.squareBracket],
    class: "tok-punct",
  },
  { tag: [t.meta, t.annotation], class: "tok-meta" },
  { tag: [t.invalid], class: "tok-invalid" },
]);

export const codeHighlight = syntaxHighlighting(codeHighlightStyle);
