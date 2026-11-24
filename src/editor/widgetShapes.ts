/* ============================================================
   编辑器里替身的形状：列表符号格多宽、圆点换哪个、勾选框和复制按钮的图标。
   编辑器的替身（widgets.ts、inlineDecorations.ts）和静态渲染器「照编辑器的排法」画的白板卡片
   （render/staticHtml.ts 的 layout: "editor"，docs/白板.md §13.7）用同一份：点进卡片编辑，符号、字不挪。
   不引 CodeMirror：静态渲染器、导出也要用它
   ============================================================ */

export const BULLET_GLYPHS = ["•", "◦", "▪"];
/* 列表符号格的宽度，单位是正文字号（globals.css「列表的几何」）。任务项的宽度和
   .cm-odea-task 左右的空加起来要相等；有序列表按最大编号的位数加宽 */
export const LIST_BULLET_WIDTH = 1.55;
export const LIST_TASK_WIDTH = 1.8;
export const LIST_ORDERED_WIDTH = 1;
export const LIST_DIGIT_WIDTH = 0.56;
export const listUnits = (value: number) =>
  `calc(var(--odea-body-size) * ${Math.round(value * 1000) / 1000})`;

/** 勾选框里的对勾（viewBox 0 0 16 16） */
export const TASK_CHECK_ICON = "M3.5 8.5l3 3 6-6.5";
/** 代码块封口上的「复制」、复制好了的对勾（viewBox 0 0 20 20） */
export const COPY_ICON =
  "M8 4H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-2M8 4V3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1M8 4h6a2 2 0 0 1 2 2v6";
export const DONE_ICON = "M4 9.5l3.5 3.5L15 5";
