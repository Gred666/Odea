// 实验用的一张白板：两个分区、六张卡片、两条连线（notation-check.mjs、roundtrip-editors.mjs 共用）
const card = (id, x, y, body) => ({ kind: "card", id, x, y, w: 320, body });

export const BASE = {
  pre: "---\nid: 0199f3c2-0000-7000-8000-000000000001\nboard: 1\n---",
  items: [
    { kind: "frame", id: "f1", x: 0, y: 0, w: 960, h: 640, body: "## 问题" },
    card(
      "c1",
      40,
      80,
      "导出很慢，**两千篇**要 40 秒。\n\n- [ ] 量一下卡在哪 @2026-11-20\n- [ ] 问问别人\n\n先看图片那一段。",
    ),
    card("c2", 420, 80, "![[性能基线]]"),
    card("c3", 40, 360, "猜测：\n\n1. 图片读成 data: 太慢\n2. 公式的字体每篇都嵌一遍\n3. 排版是串行的"),
    { kind: "frame", id: "f2", x: 1040, y: 0, w: 960, h: 640, body: "## 办法" },
    card("c4", 1080, 80, "图片并行读，限 4 路。"),
    card("c5", 1460, 80, "字体只嵌一次，后面的篇引用它。"),
    card("c6", 1080, 360, "```js\n<!-- @card 不是标记 1,1 1 -->\nawait Promise.all(pages)\n```"),
    { kind: "edge", id: "e1", from: "c1", to: "c3", body: "" },
    { kind: "edge", id: "e2", from: "c3", to: "c4", rest: ['label="所以"'], body: "" },
  ],
};

export { card };
