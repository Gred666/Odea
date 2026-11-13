// 实验 2 的页面（cards.html）。不进产品的包：只在开发服务器里由 cards.mjs 打开。
import "/src/styles/globals.css";
import "/src/render/static.css";
import { type StaticOptions, renderStaticHtml } from "/src/render/staticHtml";
import { type FunctionComponent, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";

const BODIES = [
  (i: number) =>
    `## 导出为什么慢 ${i}\n\n两千篇笔记导出成 PDF 要 40 秒，其中一半花在把图片读成 \`data:\` 上。\n\n- [ ] 量一下卡在哪 @2026-11-20\n- [x] 问问别人\n- 先看图片那一段`,
  () => "猜测：\n\n1. 图片读成 data: 太慢\n2. 公式的字体每篇都嵌一遍\n3. 排版是串行的\n\n> 先量再改。",
  () =>
    "见 [[性能基线]] 和 [导出的说明](https://example.com)。\n\n| 篇数 | 秒 |\n|---|---|\n| 500 | 9 |\n| 2000 | 40 |",
  () => "```js\nawait Promise.all(pages.map(render))\n```\n\n限 4 路并行。==字体只嵌一次==，后面的篇引用它。",
  (i: number) =>
    `第 ${i} 张。WebView2 的 PrintToPdf 一次只能排一页，排版本身是串行的，这一步省不掉；能省的是读图片和嵌字体。*先分区*，分区里先上后下、再左后右。`,
];

interface Card {
  id: string;
  /** 这张卡片的内容在整篇正文里的范围 */
  from: number;
  to: number;
  el: HTMLElement;
}

const world = document.getElementById("world") as HTMLElement;
const options: StaticOptions = {
  image: () => null,
  wikiImage: () => null,
  math: false,
  diagrams: false,
  highlight: false,
};
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
const MARK = /^<!-- @card (\S+) (-?\d+),(-?\d+) (\d+) -->$/gm;

let doc = "";
let cards: Card[] = [];
let editing: { index: number; root: Root } | null = null;
let Editor: FunctionComponent<Record<string, unknown>> | null = null;
const writeBackMs: number[] = [];

function build(count: number): string {
  const out = ["---", "id: 0199f3c2-0000-7000-8000-000000000002", "board: 1", "---", ""];
  for (let i = 0; i < count; i++) {
    const x = 40 + (i % 10) * 340;
    const y = 40 + Math.floor(i / 10) * 300;
    out.push(`<!-- @card c${i} ${x},${y} 300 -->`, "", BODIES[i % BODIES.length]!(i), "");
  }
  return out.join("\n");
}

/** 认出每张卡片和它的内容在正文里的范围 */
function parse(text: string) {
  const found: { id: string; x: number; y: number; from: number; to: number }[] = [];
  MARK.lastIndex = 0;
  for (let m = MARK.exec(text); m; m = MARK.exec(text)) {
    const last = found.at(-1);
    if (last) last.to = m.index - 2;
    found.push({ id: m[1]!, x: Number(m[2]), y: Number(m[3]), from: m.index + m[0].length + 2, to: text.length });
  }
  const last = found.at(-1);
  if (last) last.to = text.replace(/\n+$/, "").length;
  return found;
}

const bodyOf = (index: number) => doc.slice(cards[index]!.from, cards[index]!.to);

/** 开一张白板：认卡片、每张用静态渲染器排出来、挂上去、等一帧 */
async function open(count: number) {
  editing?.root.unmount();
  editing = null;
  world.textContent = "";
  doc = build(count);
  const t0 = performance.now();
  const parsed = parse(doc);
  const t1 = performance.now();
  const html = await Promise.all(parsed.map((card) => renderStaticHtml(doc.slice(card.from, card.to), options)));
  const t2 = performance.now();
  const fragment = document.createDocumentFragment();
  cards = parsed.map((card, i) => {
    const el = document.createElement("div");
    el.className = "lab-card odea-static";
    el.style.left = `${card.x}px`;
    el.style.top = `${card.y}px`;
    el.innerHTML = html[i]!;
    fragment.append(el);
    return { id: card.id, from: card.from, to: card.to, el };
  });
  world.append(fragment);
  world.getBoundingClientRect();
  await frame();
  const t3 = performance.now();
  return {
    cards: cards.length,
    docChars: doc.length,
    parseMs: t1 - t0,
    renderMs: t2 - t1,
    mountMs: t3 - t2,
    nodes: world.querySelectorAll("*").length,
  };
}

/** 卡片里的字变了：换掉整篇正文里的那一段，后面的卡片的范围跟着挪 */
function writeBack(index: number, markdown: string) {
  const start = performance.now();
  const card = cards[index]!;
  const delta = markdown.length - (card.to - card.from);
  doc = doc.slice(0, card.from) + markdown + doc.slice(card.to);
  card.to += delta;
  for (let i = index + 1; i < cards.length; i++) {
    cards[i]!.from += delta;
    cards[i]!.to += delta;
  }
  writeBackMs.push(performance.now() - start);
}

async function editorComponent() {
  if (!Editor) {
    const module = await import("/src/editor/MarkdownEditor");
    Editor = module.MarkdownEditor as unknown as FunctionComponent<Record<string, unknown>>;
  }
  return Editor;
}

function mount(host: HTMLElement, markdown: string, onChange: (markdown: string) => void): Root {
  const root = createRoot(host);
  root.render(
    createElement(Editor!, {
      initialMarkdown: markdown,
      onSave: async () => {},
      outlineItems: [],
      onOutlineHandle: () => {},
      onDocumentChange: onChange,
      fill: false,
    }),
  );
  return root;
}

async function untilEditor(host: HTMLElement) {
  for (let i = 0; i < 400 && !host.querySelector(".cm-content"); i++) await new Promise((r) => setTimeout(r, 5));
  await frame();
}

/** 点一张卡片开始编辑：上一张换回静态的，这一张挂上编辑器。返回从开始到画出来的毫秒 */
async function edit(index: number) {
  await editorComponent();
  const start = performance.now();
  if (editing) {
    const previous = editing.index;
    editing.root.unmount();
    cards[previous]!.el.innerHTML = await renderStaticHtml(bodyOf(previous), options);
    cards[previous]!.el.classList.add("odea-static");
  }
  const card = cards[index]!;
  card.el.classList.remove("odea-static");
  card.el.textContent = "";
  editing = { index, root: mount(card.el, bodyOf(index), (markdown) => writeBack(index, markdown)) };
  await untilEditor(card.el);
  const ms = performance.now() - start;
  focusEnd(card.el);
  return ms;
}

function focusEnd(host: HTMLElement, where = 1) {
  // biome-ignore lint/suspicious/noExplicitAny: 实验脚本，直接拿 CodeMirror 挂在节点上的视图
  const view = (host.querySelector(".cm-content") as any).cmTile.view;
  const line = view.state.doc.lineAt(Math.floor(view.state.doc.length * where));
  view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true });
  view.focus();
}

/** 对照：整篇正文（两百张卡片，连标记一起）放进一个编辑器，文档视图就是这样 */
async function full() {
  await editorComponent();
  editing?.root.unmount();
  editing = null;
  const layer = document.getElementById("full") as HTMLElement;
  const host = document.getElementById("full-host") as HTMLElement;
  layer.style.display = "block";
  const start = performance.now();
  mount(host, doc, () => {});
  await untilEditor(host);
  const ms = performance.now() - start;
  focusEnd(host, 0.5);
  return ms;
}

/** 反例：一张卡片一个编辑器，一口气挂 count 个 */
async function editMany(count: number) {
  await editorComponent();
  const start = performance.now();
  const roots: Root[] = [];
  for (let i = 0; i < count; i++) {
    const card = cards[i]!;
    card.el.textContent = "";
    roots.push(mount(card.el, bodyOf(i), () => {}));
  }
  await untilEditor(cards[count - 1]!.el);
  const ms = performance.now() - start;
  const nodes = world.querySelectorAll("*").length;
  for (const root of roots) root.unmount();
  return { ms, nodes };
}

/**
 * 写回一次多久：编辑器的 onDocumentChange 不是每键都叫（给目录树用的，攒着叫），打字时量不到，
 * 这里单独对中间那张卡片连着写 rounds 次，返回平均每次的毫秒
 */
function writeBackBench(rounds: number) {
  const index = Math.floor(cards.length / 2);
  const body = bodyOf(index);
  const start = performance.now();
  for (let i = 0; i < rounds; i++) writeBack(index, i % 2 ? body : `${body}字`);
  writeBackMs.length = 0;
  return (performance.now() - start) / rounds;
}

Object.assign(window, {
  lab: { ready: true, open, edit, full, editMany, writeBackBench, writeBackMs, doc: () => doc, bodyOf },
});
