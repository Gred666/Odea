// 实验 5（docs/白板.md §9）：文件记法经不经得起往返、两边各改各的合不合得上。
//
//   node scripts/perf/board/notation-check.mjs
//
// 1. 往返：写出去再读回来一样；标记被删、写坏、重复、在代码块里，内容都还在
// 2. 合并：十种两边同时改的情形，三种写法各用 git 的逐行合并（git merge-file）跑一遍，
//    再用按对象的合并（notation.mjs 的 mergeBoards）跑一遍
import { cleanup, mergeBoards, mergeLines, parseBoard, serializeBoard } from "./notation.mjs";
import { BASE, card } from "./sample.mjs";

const clone = (board) => structuredClone(board);

const at = (board, id) => board.items.find((item) => item.id === id);
const move = (id, x, y) => (board) => Object.assign(at(board, id), { x, y });
const edit = (id, from, to) => (board) => {
  const item = at(board, id);
  if (!item.body.includes(from)) throw new Error(`${id} 里没有「${from}」`);
  item.body = item.body.replace(from, to);
};
const addAfter = (after, item) => (board) => {
  board.items.splice(board.items.findIndex((it) => it.id === after) + 1, 0, item);
};
const addEnd = (item) => (board) => board.items.push(item);
const remove = (id) => (board) => {
  board.items = board.items.filter((item) => item.id !== id);
};
const reorder = (id, before) => (board) => {
  const item = at(board, id);
  board.items = board.items.filter((it) => it !== item);
  board.items.splice(board.items.findIndex((it) => it.id === before), 0, item);
};

/** [说明, 甲做的, 乙做的, 合完应该成立的] */
const SCENARIOS = [
  ["各挪各的卡片", move("c1", 60, 100), move("c2", 500, 90), (m) => at(m, "c1").x === 60 && at(m, "c2").x === 500],
  [
    "甲挪卡片，乙改它的第一行字",
    move("c1", 60, 100),
    edit("c1", "导出很慢", "导出 PDF 很慢"),
    (m) => at(m, "c1").x === 60 && at(m, "c1").body.includes("导出 PDF 很慢"),
  ],
  [
    "甲挪卡片，乙改它后面的一行",
    move("c1", 60, 100),
    edit("c1", "先看图片那一段", "先看图片和公式"),
    (m) => at(m, "c1").x === 60 && at(m, "c1").body.includes("和公式"),
  ],
  [
    "各在不同的地方加一张",
    addAfter("c3", card("k7q", 420, 360, "也可能是磁盘。")),
    addEnd(card("p2m", 1460, 360, "先量再改。")),
    (m) => at(m, "k7q") && at(m, "p2m"),
  ],
  [
    "都在最后加一张",
    addEnd(card("k7q", 420, 360, "也可能是磁盘。")),
    addEnd(card("p2m", 1460, 360, "先量再改。")),
    (m) => at(m, "k7q") && at(m, "p2m"),
  ],
  ["都挪同一张（真的撞了）", move("c1", 60, 100), move("c1", 300, 300), (m) => at(m, "c1").x === 60 || at(m, "c1").x === 300],
  ["甲删一张，乙挪它", remove("c2"), move("c2", 500, 90), (m) => at(m, "c2")?.x === 500],
  [
    "同一张卡片里各改一行（隔着别的行）",
    edit("c3", "图片读成 data: 太慢", "图片读成 data: 太慢（30 MB 的图）"),
    edit("c3", "排版是串行的", "排版是串行的，一篇一篇来"),
    (m) => at(m, "c3").body.includes("30 MB") && at(m, "c3").body.includes("一篇一篇来"),
  ],
  [
    "各加一条连线",
    addEnd({ kind: "edge", id: "h4x", from: "c4", to: "c5", body: "" }),
    addEnd({ kind: "edge", id: "b9d", from: "c2", to: "c1", body: "" }),
    (m) => at(m, "h4x") && at(m, "b9d"),
  ],
  [
    "甲调阅读顺序，乙改被挪的那张的字",
    reorder("c3", "c1"),
    edit("c3", "排版是串行的", "排版是串行的，一篇一篇来"),
    (m) =>
      m.items.findIndex((it) => it.id === "c3") < m.items.findIndex((it) => it.id === "c1") &&
      at(m, "c3").body.includes("一篇一篇来"),
  ],
  [
    "同一行两边改得不一样（内容真的撞了）",
    edit("c4", "限 4 路", "限 8 路"),
    edit("c4", "限 4 路", "限 2 路"),
    (m) => m.items.some((it) => it.body.includes("限 8 路")) && m.items.some((it) => it.body.includes("限 2 路")),
  ],
];

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
};

/* ---------------- 1. 往返 ---------------- */

console.log("== 往返");
for (const variant of ["tight", "loose", "tail"]) {
  const text = serializeBoard(BASE, variant);
  const again = serializeBoard(parseBoard(text), variant);
  check(`${variant}：写 → 读 → 写，一个字不差`, again === text);
  const parsed = parseBoard(text);
  check(
    `${variant}：对象数、位置读回来一样`,
    parsed.items.length === BASE.items.length &&
      parsed.items.every((item, i) => item.x === BASE.items[i].x && item.body === BASE.items[i].body),
  );
}
const loose = serializeBoard(BASE, "loose");
{
  // 代码块里长得像标记的那一行不算标记
  const parsed = parseBoard(loose);
  check("代码块里长得像标记的一行留在正文里", at(parsed, "c6").body.includes("@card 不是标记") && parsed.items.length === 10);
}
{
  // 标记被别的工具删了：内容并进上一张，一个字不丢
  const text = loose.replace("<!-- @card c2 420,80 320 -->\n", "");
  const parsed = parseBoard(text);
  check("删掉一个标记：内容并进上一张，还在", !at(parsed, "c2") && at(parsed, "c1").body.includes("![[性能基线]]"));
}
{
  const text = loose.replace("<!-- @card c3 40,360 320 -->", "<!-- @card c3 -->");
  const parsed = parseBoard(text);
  check("位置被删掉：对象还在，标成自动排", at(parsed, "c3").x === undefined && parsed.notes.some((n) => n.includes("c3")));
}
{
  const block = "<!-- @card c4 1080,80 320 -->\n\n图片并行读，限 4 路。\n";
  const parsed = parseBoard(loose.replace(block, block + "\n" + block));
  check("复制出来的同一个 id：第二份换 id，两份都在", parsed.items.length === 11 && parsed.notes.some((n) => n.includes("重复")));
}
{
  const parsed = parseBoard(loose.replace(/\n/g, "\r\n"));
  check("CRLF 的文件照样读", parsed.items.length === 10 && at(parsed, "c1").x === 40);
}
{
  const parsed = parseBoard("# 一篇普通笔记\n\n没有任何标记。\n");
  check("没有标记的笔记：全在 pre 里，没有对象", parsed.items.length === 0 && parsed.pre.includes("没有任何标记"));
}
const bytes = Buffer.byteLength(loose);
const layoutBytes = loose.split("\n").filter((line) => line.startsWith("<!-- @")).join("\n").length;
console.log(`   这份样本 ${bytes} 字节，其中标记行 ${layoutBytes} 字节（${Math.round((layoutBytes / bytes) * 100)}%）`);

/* ---------------- 2. 合并 ---------------- */

console.log("\n== 合并：git 的逐行合并，三种写法");
console.log("情形".padEnd(22, "　") + ["tight", "loose", "tail"].map((v) => v.padEnd(8)).join(""));
const lineResults = { tight: 0, loose: 0, tail: 0 };
for (const [name, a, b, holds] of SCENARIOS) {
  const cells = [];
  for (const variant of ["tight", "loose", "tail"]) {
    const [ours, theirs] = [clone(BASE), clone(BASE)];
    a(ours);
    b(theirs);
    const merged = mergeLines(
      serializeBoard(BASE, variant),
      serializeBoard(ours, variant),
      serializeBoard(theirs, variant),
    );
    let cell = "冲突";
    if (merged.conflicts === 0) {
      cell = holds(parseBoard(merged.text)) ? "合上了" : "合错了";
      if (cell === "合上了") lineResults[variant]++;
    }
    cells.push(cell);
  }
  console.log(name.padEnd(22, "　") + cells.map((c) => c.padEnd(6, "　")).join(""));
}
console.log(
  `合上的：tight ${lineResults.tight}、loose ${lineResults.loose}、tail ${lineResults.tail}（共 ${SCENARIOS.length} 种）`,
);

console.log("\n== 合并：按对象合（loose 写法）");
for (const [name, a, b, holds] of SCENARIOS) {
  const [ours, theirs] = [clone(BASE), clone(BASE)];
  a(ours);
  b(theirs);
  const merged = mergeBoards(
    serializeBoard(BASE, "loose"),
    serializeBoard(ours, "loose"),
    serializeBoard(theirs, "loose"),
  );
  const board = parseBoard(merged.text);
  const notes = [
    merged.layoutConflicts ? `位置撞了 ${merged.layoutConflicts} 处，取本机的` : "",
    merged.forked.length ? `内容撞了：${merged.forked.join("、")} 另放一张` : "",
  ].filter(Boolean);
  check(name, holds(board) && !/^[<>=]{7}/m.test(merged.text), notes.join("；"));
}

cleanup();
console.log(failed ? `\n${failed} 项没过` : "\n都过了");
process.exitCode = failed ? 1 : 0;
