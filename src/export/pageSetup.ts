/* ============================================================
   导出 PDF 的页面设置：纸张、方向、页边距、页眉、页脚。记在本机（localStorage 的 odea.pageSetup），
   和字号、行宽一样是这台电脑的偏好，不跟着仓库走。

   排版全靠页面自己的 `@page`（pageCss）：纸张大小、页边距，页眉页脚画在页边框盒子里
   （`@top-left` … `@bottom-right`，Chromium 131 起支持；WebView2 跟着 Edge 走）。Windows 上
   WebView2 的 PrintToPdf 另外要一个纸张尺寸（print.rs），由 paperSize 给，和 `@page size` 是同一个。

   页眉、页脚是一行字，里面可以写：{标题}、{日期}、{页码}、{总页数}。空的就是不要。
   ============================================================ */

export type PaperId = "A4" | "A3" | "A5" | "B5" | "16K" | "Letter" | "Legal";
export type MarginId = "narrow" | "normal" | "wide";
export type Align = "left" | "center" | "right";

export interface PageSetup {
  paper: PaperId;
  landscape: boolean;
  margin: MarginId;
  header: string;
  headerAlign: Align;
  footer: string;
  footerAlign: Align;
}

/** 纸张：毫米，竖着放的宽 × 高 */
export const PAPERS: { id: PaperId; label: string; size: [number, number] }[] = [
  { id: "A4", label: "A4", size: [210, 297] },
  { id: "A3", label: "A3", size: [297, 420] },
  { id: "A5", label: "A5", size: [148, 210] },
  { id: "B5", label: "B5", size: [176, 250] },
  { id: "16K", label: "16 开", size: [185, 260] },
  { id: "Letter", label: "Letter", size: [215.9, 279.4] },
  { id: "Legal", label: "Legal", size: [215.9, 355.6] },
];

/** 页边距：毫米，上 右 下 左。「标准」是以前写死的那一档 */
export const MARGINS: { id: MarginId; label: string; mm: [number, number, number, number] }[] = [
  { id: "narrow", label: "窄", mm: [12.7, 12.7, 12.7, 12.7] },
  { id: "normal", label: "标准", mm: [20, 18, 22, 18] },
  { id: "wide", label: "宽", mm: [25.4, 31.8, 25.4, 31.8] },
];

/** 页眉页脚里能写的几样 */
export const TOKENS = ["{标题}", "{日期}", "{页码}", "{总页数}"] as const;

export const DEFAULT_PAGE_SETUP: PageSetup = {
  paper: "A4",
  landscape: false,
  margin: "normal",
  header: "",
  headerAlign: "left",
  footer: "{页码} / {总页数}",
  footerAlign: "center",
};

const LS_KEY = "odea.pageSetup";
const ALIGNS: Align[] = ["left", "center", "right"];

const isPaper = (value: unknown): value is PaperId => PAPERS.some((paper) => paper.id === value);
const isMargin = (value: unknown): value is MarginId =>
  MARGINS.some((margin) => margin.id === value);
const isAlign = (value: unknown): value is Align => ALIGNS.includes(value as Align);
/** 页眉页脚一行字，太长的截掉（纸上本来也放不下） */
const line = (value: unknown, fallback: string) =>
  typeof value === "string" ? value.replace(/[\r\n]+/g, " ").slice(0, 200) : fallback;

/** 读出来的东西一样样认，认不出的用默认值（以前的版本、手改坏了） */
export function normalizePageSetup(raw: unknown): PageSetup {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<
    Record<keyof PageSetup, unknown>
  >;
  const fallback = DEFAULT_PAGE_SETUP;
  return {
    paper: isPaper(value.paper) ? value.paper : fallback.paper,
    landscape: value.landscape === true,
    margin: isMargin(value.margin) ? value.margin : fallback.margin,
    header: line(value.header, fallback.header),
    headerAlign: isAlign(value.headerAlign) ? value.headerAlign : fallback.headerAlign,
    footer: line(value.footer, fallback.footer),
    footerAlign: isAlign(value.footerAlign) ? value.footerAlign : fallback.footerAlign,
  };
}

export function loadPageSetup(): PageSetup {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? normalizePageSetup(JSON.parse(raw)) : DEFAULT_PAGE_SETUP;
  } catch {
    return DEFAULT_PAGE_SETUP;
  }
}

export function savePageSetup(setup: PageSetup): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(setup));
  } catch {
    // 存不下（隐私模式）：这次照样按它导出，下次回到默认
  }
}

/** 纸张实际的宽 × 高（毫米，横着放的已经换过来） */
export function paperSize(setup: PageSetup): [number, number] {
  const [width, height] = (PAPERS.find((paper) => paper.id === setup.paper) ?? PAPERS[0]!).size;
  return setup.landscape ? [height, width] : [width, height];
}

export function marginsOf(setup: PageSetup): [number, number, number, number] {
  return (MARGINS.find((margin) => margin.id === setup.margin) ?? MARGINS[1]!).mm;
}

/** 今天的日期，页眉页脚的 {日期}：2026-11-11 */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** CSS 字符串：反斜杠、引号转义；换行、控制字符去掉 */
const cssString = (text: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要去掉控制字符
  `"${text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/**
 * 页眉 / 页脚的一行 → 页边框盒子的 content：`"第 " counter(page) " 页"`。空的返回 null（不画）。
 * {标题}、{日期} 换成字，{页码}、{总页数} 换成计数器
 */
export function marginContent(template: string, title: string, date: string): string | null {
  if (!template.trim()) return null;
  const parts: string[] = [];
  for (const piece of template.split(/(\{标题\}|\{日期\}|\{页码\}|\{总页数\})/)) {
    if (!piece) continue;
    if (piece === "{页码}") parts.push("counter(page)");
    else if (piece === "{总页数}") parts.push("counter(pages)");
    else parts.push(cssString(piece === "{标题}" ? title : piece === "{日期}" ? date : piece));
  }
  return parts.join(" ");
}

/** 预览里显示的样子：{页码} 写成 1，{总页数} 写成 3 */
export function marginPreview(template: string, title: string, date: string): string {
  return template
    .replaceAll("{标题}", title)
    .replaceAll("{日期}", date)
    .replaceAll("{页码}", "1")
    .replaceAll("{总页数}", "3");
}

const MARGIN_STYLE = `color: #91918a;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif;
    font-size: 9pt;`;

/** 这份设置的 `@page`：纸张、页边距、页眉页脚。title 是 {标题} 换成的字 */
export function pageCss(setup: PageSetup, title: string, date = today()): string {
  const [width, height] = paperSize(setup);
  const [top, right, bottom, left] = marginsOf(setup);
  const boxes: string[] = [];
  const header = marginContent(setup.header, title, date);
  const footer = marginContent(setup.footer, title, date);
  // 页边框盒子在页边距那一条里上下居中；只写选的那一格，另外两格空着
  if (header) {
    boxes.push(`  @top-${setup.headerAlign} {
    content: ${header};
    ${MARGIN_STYLE}
  }`);
  }
  if (footer) {
    boxes.push(`  @bottom-${setup.footerAlign} {
    content: ${footer};
    ${MARGIN_STYLE}
  }`);
  }
  return `@page {
  size: ${width}mm ${height}mm;
  margin: ${top}mm ${right}mm ${bottom}mm ${left}mm;
${boxes.join("\n")}
}`;
}
