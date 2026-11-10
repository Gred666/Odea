/**
 * `> [!标签]` 形式的 callout。
 *
 * 标签既可以是 GitHub 那五种（NOTE / TIP / IMPORTANT / WARNING / CAUTION），
 * 也可以是任意中文短语（原型里的「核心判断」「当时的结论」）。
 * 前者按语义配色，后者一律走中性的主色边条。
 *
 * 也认 Obsidian 的两种变体：`[!标签]-` / `[!标签]+` 是可折叠的（减号默认收起），
 * `[!标签] 自定义标题` 在徽章后面跟一段标题文字。
 *
 * 插件（L0 的贡献点 callouts，docs/插件与跨端.md §5.3）能再登记几种标签：配色只能是已有的这几种 kind，
 * 图标只能从 CALLOUT_ICONS 里挑（§6.4：L0 不执行代码，只接受现有的那几样）。插件关掉，标签又回到中性的样子，
 * 正文一个字都不动
 */
export type CalloutKind = "note" | "tip" | "important" | "warning" | "caution" | "generic";

/** 引用块首行是否是 callout 标签行；捕获组 1 是 `>` 前缀，2 是标签，3 是折叠符，4 是标题。 */
export const CALLOUT_HEAD_RE = /^(\s*(?:>\s*)+)\[!([^\]\n]+)\]([+-]?)(?:[ \t]+(\S.*?))?[ \t]*$/;

export interface CalloutHead {
  /** 标签原文，如 `TIP` / `核心判断` */
  label: string;
  kind: CalloutKind;
  /** 插件给这个标签挑的图标（CALLOUT_ICONS 里的名字）；没有就按 kind 画 */
  icon?: string;
  /** `-` 默认收起、`+` 默认展开、空串不可折叠 */
  fold: "-" | "+" | "";
  /** 徽章后面的自定义标题；没写就是空串 */
  title: string;
  /** `[!` 在行内的偏移 */
  labelOffset: number;
  /** `]` 之后的位置：折叠符（如果有）就在这里 */
  foldOffset: number;
}

export function parseCalloutHead(line: string): CalloutHead | null {
  const match = CALLOUT_HEAD_RE.exec(line);
  if (!match) return null;
  const label = match[2]!.trim();
  const labelOffset = match[1]!.length;
  const declared = declaredCallouts.get(labelKey(label));
  return {
    label,
    kind: declared?.kind ?? calloutKind(label),
    ...(declared?.icon ? { icon: declared.icon } : {}),
    fold: (match[3] ?? "") as CalloutHead["fold"],
    title: match[4]?.trim() ?? "",
    labelOffset,
    foldOffset: labelOffset + 2 + match[2]!.length + 1,
  };
}

const KIND_BY_LABEL: Record<string, CalloutKind> = {
  note: "note",
  info: "note",
  笔记: "note",
  说明: "note",
  备注: "note",
  tip: "tip",
  hint: "tip",
  提示: "tip",
  技巧: "tip",
  建议: "tip",
  important: "important",
  重要: "important",
  关键: "important",
  warning: "warning",
  warn: "warning",
  注意: "warning",
  警告: "warning",
  caution: "caution",
  danger: "caution",
  error: "caution",
  危险: "caution",
  错误: "caution",
};

const labelKey = (label: string) => label.trim().toLowerCase();

export function calloutKind(label: string): CalloutKind {
  const key = labelKey(label);
  return declaredCallouts.get(key)?.kind ?? KIND_BY_LABEL[key] ?? "generic";
}

/** 内置认得的标签（GitHub 的五种、几个中文同义词）：插件登记同一个标签时以插件的为准 */
export function builtinCalloutLabel(label: string): boolean {
  return labelKey(label) in KIND_BY_LABEL;
}

/* ---------------- 插件登记的标签（plugins/declared.ts 交来） ---------------- */

/** 插件声明的一种提示块：标签（和它的别名）、配色、图标 */
export interface DeclaredCallout {
  label: string;
  aliases?: readonly string[];
  kind: CalloutKind;
  icon?: string;
}

let declaredCallouts = new Map<string, { kind: CalloutKind; icon?: string }>();
let declaredVersion = 0;
const declaredListeners = new Set<() => void>();

/**
 * 换上开着的插件登记的那几种（先登记的优先：同一个标签两个插件都登记了，用先装的那个）。
 * 编辑器据 calloutsVersion() 重画（MarkdownEditor 的装饰层、onCalloutsChange）
 */
export function setDeclaredCallouts(list: readonly DeclaredCallout[]): void {
  const next = new Map<string, { kind: CalloutKind; icon?: string }>();
  for (const callout of list) {
    const style = { kind: callout.kind, ...(callout.icon ? { icon: callout.icon } : {}) };
    for (const label of [callout.label, ...(callout.aliases ?? [])]) {
      const key = labelKey(label);
      if (key && !next.has(key)) next.set(key, style);
    }
  }
  const same =
    next.size === declaredCallouts.size &&
    [...next].every(([key, style]) => {
      const old = declaredCallouts.get(key);
      return old?.kind === style.kind && old.icon === style.icon;
    });
  if (same) return;
  declaredCallouts = next;
  declaredVersion += 1;
  for (const listener of declaredListeners) listener();
}

/** 插件登记的标签换过几次：装饰层记着它，变了就整个重画 */
export function calloutsVersion(): number {
  return declaredVersion;
}

export function onCalloutsChange(listener: () => void): () => void {
  declaredListeners.add(listener);
  return () => {
    declaredListeners.delete(listener);
  };
}

/** 24×24 的 lucide 线稿，只取 path 数据，widget 里自己拼 SVG。 */
const ICON_PATHS: Record<CalloutKind, string> = {
  note: "M12 16v-4M12 8h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z",
  tip: "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1.3.5 2.6 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4",
  important: "M7.9 20A9 9 0 1 0 4 16.1L2 22ZM12 8v4M12 16h.01",
  warning:
    "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3ZM12 9v4M12 17h.01",
  caution:
    "M12 16h.01M12 8v4M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z",
  generic: "M4 20h16M4 12h16M4 4h10",
};

type IconNode = readonly (readonly [string, Readonly<Record<string, string>>])[];

/**
 * 插件能挑的图标（lucide 的名字，线稿从 lucide-react 0.475 抄来）。插件不交 SVG：不执行代码的 L0 也不该塞进
 * 任意的标记。要加就往这里加
 */
export const CALLOUT_ICONS: Readonly<Record<string, IconNode>> = {
  info: [["path", { d: ICON_PATHS.note }]],
  "triangle-alert": [["path", { d: ICON_PATHS.warning }]],
  "octagon-alert": [["path", { d: ICON_PATHS.caution }]],
  "message-circle-warning": [["path", { d: ICON_PATHS.important }]],
  lightbulb: [
    [
      "path",
      {
        d: "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5",
      },
    ],
    ["path", { d: "M9 18h6" }],
    ["path", { d: "M10 22h4" }],
  ],
  sparkles: [
    [
      "path",
      {
        d: "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
      },
    ],
    ["path", { d: "M20 3v4" }],
    ["path", { d: "M22 5h-4" }],
    ["path", { d: "M4 17v2" }],
    ["path", { d: "M5 18H3" }],
  ],
  star: [
    [
      "path",
      {
        d: "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",
      },
    ],
  ],
  flag: [
    ["path", { d: "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" }],
    ["line", { x1: "4", x2: "4", y1: "22", y2: "15" }],
  ],
  bookmark: [["path", { d: "m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" }]],
  pin: [
    ["path", { d: "M12 17v5" }],
    [
      "path",
      {
        d: "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
      },
    ],
  ],
  check: [["path", { d: "M20 6 9 17l-5-5" }]],
  "circle-check": [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "m9 12 2 2 4-4" }],
  ],
  "circle-x": [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "m15 9-6 6" }],
    ["path", { d: "m9 9 6 6" }],
  ],
  x: [
    ["path", { d: "M18 6 6 18" }],
    ["path", { d: "m6 6 12 12" }],
  ],
  "circle-help": [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" }],
    ["path", { d: "M12 17h.01" }],
  ],
  "clipboard-list": [
    ["rect", { width: "8", height: "4", x: "8", y: "2", rx: "1", ry: "1" }],
    ["path", { d: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" }],
    ["path", { d: "M12 11h4" }],
    ["path", { d: "M12 16h4" }],
    ["path", { d: "M8 11h.01" }],
    ["path", { d: "M8 16h.01" }],
  ],
  list: [
    ["path", { d: "M3 12h.01" }],
    ["path", { d: "M3 18h.01" }],
    ["path", { d: "M3 6h.01" }],
    ["path", { d: "M8 12h13" }],
    ["path", { d: "M8 18h13" }],
    ["path", { d: "M8 6h13" }],
  ],
  "list-todo": [
    ["rect", { x: "3", y: "5", width: "6", height: "6", rx: "1" }],
    ["path", { d: "m3 17 2 2 4-4" }],
    ["path", { d: "M13 6h8" }],
    ["path", { d: "M13 12h8" }],
    ["path", { d: "M13 18h8" }],
  ],
  bug: [
    ["path", { d: "m8 2 1.88 1.88" }],
    ["path", { d: "M14.12 3.88 16 2" }],
    ["path", { d: "M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" }],
    ["path", { d: "M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" }],
    ["path", { d: "M12 20v-9" }],
    ["path", { d: "M6.53 9C4.6 8.8 3 7.1 3 5" }],
    ["path", { d: "M6 13H2" }],
    ["path", { d: "M3 21c0-2.1 1.7-3.9 3.8-4" }],
    ["path", { d: "M20.97 5c0 2.1-1.6 3.8-3.5 4" }],
    ["path", { d: "M22 13h-4" }],
    ["path", { d: "M17.2 17c2.1.1 3.8 1.9 3.8 4" }],
  ],
  quote: [
    [
      "path",
      {
        d: "M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z",
      },
    ],
    [
      "path",
      {
        d: "M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z",
      },
    ],
  ],
  flame: [
    [
      "path",
      {
        d: "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z",
      },
    ],
  ],
  zap: [
    [
      "path",
      {
        d: "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z",
      },
    ],
  ],
  heart: [
    [
      "path",
      {
        d: "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z",
      },
    ],
  ],
  pencil: [
    [
      "path",
      {
        d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
      },
    ],
    ["path", { d: "m15 5 4 4" }],
  ],
  "book-open": [
    ["path", { d: "M12 7v14" }],
    [
      "path",
      {
        d: "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",
      },
    ],
  ],
  target: [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["circle", { cx: "12", cy: "12", r: "6" }],
    ["circle", { cx: "12", cy: "12", r: "2" }],
  ],
  calendar: [
    ["path", { d: "M8 2v4" }],
    ["path", { d: "M16 2v4" }],
    ["rect", { width: "18", height: "18", x: "3", y: "4", rx: "2" }],
    ["path", { d: "M3 10h18" }],
  ],
  clock: [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["polyline", { points: "12 6 12 12 16 14" }],
  ],
  link: [
    ["path", { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" }],
    ["path", { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" }],
  ],
  "message-circle": [["path", { d: "M7.9 20A9 9 0 1 0 4 16.1L2 22Z" }]],
  megaphone: [
    ["path", { d: "m3 11 18-5v12L3 14v-3z" }],
    ["path", { d: "M11.6 16.8a3 3 0 1 1-5.8-1.6" }],
  ],
  "shield-alert": [
    [
      "path",
      {
        d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
      },
    ],
    ["path", { d: "M12 8v4" }],
    ["path", { d: "M12 16h.01" }],
  ],
  "thumbs-up": [
    ["path", { d: "M7 10v12" }],
    [
      "path",
      {
        d: "M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z",
      },
    ],
  ],
  trophy: [
    ["path", { d: "M6 9H4.5a2.5 2.5 0 0 1 0-5H6" }],
    ["path", { d: "M18 9h1.5a2.5 2.5 0 0 0 0-5H18" }],
    ["path", { d: "M4 22h16" }],
    ["path", { d: "M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" }],
    ["path", { d: "M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" }],
    ["path", { d: "M18 2H6v7a6 6 0 0 0 12 0V2Z" }],
  ],
  rocket: [
    [
      "path",
      {
        d: "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z",
      },
    ],
    [
      "path",
      {
        d: "m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z",
      },
    ],
    ["path", { d: "M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" }],
    ["path", { d: "M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" }],
  ],
};

export function calloutIcon(kind: CalloutKind, icon?: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const nodes = icon ? CALLOUT_ICONS[icon] : undefined;
  for (const [tag, attributes] of nodes ?? [["path", { d: ICON_PATHS[kind] }] as const]) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    svg.append(element);
  }
  return svg;
}
