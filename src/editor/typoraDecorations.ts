import type { Extension } from "@codemirror/state";
import { typoraBlockDecorations } from "./blockDecorations";
import { cellEditorExtensions } from "./cellEditor";
import { knownWikiTitles } from "./decorationKit";
import { headingFoldExtension } from "./headingFold";
import { imageBaseDir, wikiImages } from "./html";
import { cellInlineDecorations, typoraInlineDecorations } from "./inlineDecorations";
import { longRuns } from "./longRuns";
import { revealField } from "./reveal";

/* 编辑器要的完整装饰扩展（从 MarkdownEditor.tsx 挪出来，docs/1110审查与研究.md §6.2） */

/**
 * 编辑器要的完整装饰扩展：块级 StateField + 行内 ViewPlugin，外加两层共用的「算数的选区」
 * （reveal.ts）和标题收起的状态（headingFold.ts）。表格格子里的子编辑器（cellEditor.ts）
 * 从这里拿行内装饰层，双链认得哪些标题、图片的相对路径跟着正文走
 */
export const typoraDecorations: Extension = [
  revealField,
  headingFoldExtension,
  typoraBlockDecorations,
  typoraInlineDecorations,
  longRuns,
  cellEditorExtensions.of((main) => [
    revealField,
    cellInlineDecorations,
    knownWikiTitles.of(main.facet(knownWikiTitles)),
    imageBaseDir.of(main.facet(imageBaseDir)),
    wikiImages.of(main.facet(wikiImages)),
  ]),
];
