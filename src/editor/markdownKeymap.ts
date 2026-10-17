import { indentLess, indentMore, indentWithTab, selectLine } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import type { KeyBinding } from "@codemirror/view";
import { foldSectionAtCursor, unfoldSectionAtCursor } from "./headingFold";
import {
  changeHeadingLevel,
  clearMarkdownFormat,
  indentListItem,
  insertFencedBlock,
  insertLink,
  insertTable,
  listItemHome,
  setHeading,
  toggleLinePrefix,
  wrapMarkdown,
} from "./markdownCommands";

/**
 * 与 Typora 对齐的编辑快捷键；文件/窗口命令由应用壳层负责。
 *
 * 注意 Mod-K 不在这里：它是全局命令面板的入口，编辑器抢走之后
 * 用户在正文里就再也打不开面板了。插入链接改用 Shift-Mod-K，
 * 插入代码块让位到 Mod-Alt-C（原本就是 mac 上的绑定）。
 */
export const markdownKeymap: readonly KeyBinding[] = [
  ...Array.from({ length: 7 }, (_, level) => ({ key: `Mod-${level}`, run: setHeading(level) })),
  { key: "Mod-=", run: changeHeadingLevel(1) },
  { key: "Mod--", run: changeHeadingLevel(-1) },
  { key: "Mod-b", run: wrapMarkdown("**") },
  { key: "Mod-i", run: wrapMarkdown("*") },
  { key: "Mod-u", run: wrapMarkdown("<u>", "</u>") },
  { key: "Shift-Mod-`", run: wrapMarkdown("`") },
  { key: "Alt-Shift-5", mac: "Ctrl-Shift-`", run: wrapMarkdown("~~") },
  { key: "Shift-Mod-k", run: insertLink() },
  { key: "Mod-l", run: selectLine },
  { key: "Shift-Mod-i", mac: "Ctrl-Mod-i", run: insertLink(true) },
  { key: "Mod-Alt-c", run: insertFencedBlock() },
  {
    key: "Shift-Mod-q",
    mac: "Alt-Mod-q",
    run: toggleLinePrefix("> ", /^\s*>\s?/),
  },
  {
    key: "Shift-Mod-[",
    mac: "Alt-Mod-o",
    run: toggleLinePrefix("1. ", /^\s*\d+[.)]\s+/),
  },
  {
    key: "Shift-Mod-]",
    mac: "Alt-Mod-u",
    run: toggleLinePrefix("- ", /^\s*[-+*]\s+/),
  },
  // 和 VS Code / JetBrains 一致：右方括号加缩进，左方括号减缩进。
  // 列表项里先按层级挪整项（indentListItem），别的地方照旧缩进行
  { key: "Mod-]", run: (view) => indentListItem(1)(view) || indentMore(view) },
  { key: "Mod-[", run: (view) => indentListItem(-1)(view) || indentLess(view) },
  { key: "Tab", run: indentListItem(1), shift: indentListItem(-1) },
  indentWithTab,
  { key: "Home", run: listItemHome(false), shift: listItemHome(true) },
  { mac: "Mod-ArrowLeft", run: listItemHome(false), shift: listItemHome(true) },
  { key: "Mod-t", mac: "Alt-Mod-t", run: insertTable() },
  // 收起 / 展开光标所在的这一节（headingFold.ts）。Shift-Mod-[ / ] 已经是列表（和 Typora 一样），
  // 所以没用 CodeMirror 自带的 foldKeymap
  { key: "Mod-Alt-[", run: foldSectionAtCursor },
  { key: "Mod-Alt-]", run: unfoldSectionAtCursor },
  { key: "Mod-\\", run: clearMarkdownFormat() },
  ...searchKeymap,
];
