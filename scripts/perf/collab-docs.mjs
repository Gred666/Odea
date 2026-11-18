/* ============================================================
   协作时一篇 Loro 文档的内存、开一篇的耗时、编辑历史有多大（docs/协同编辑.md §29）。
   node 直接跑真的 loro-crdt（和 WebView2 里同一份 wasm），不起界面：

     node --expose-gc scripts/perf/collab-docs.mjs [篇数=2000]

   1. 开 N 篇：主持人照 .md 建一份、访客导入主持人的快照（Sync2 一样），量 wasm 线性内存涨多少、每篇平均
   2. 全关掉再开 N 篇：wasm 的线性内存只涨不缩，关掉的那些腾出来的给后开的用
   3. 开一篇的耗时：已经开着 0 篇、N 篇时各开 200 篇，比中位数
   4. 继续上次的访客：N 篇落盘的状态全导一遍要多久
   5. 一篇长时间编辑：两个人交替打 2 万个字（夹着删），内存、完整快照、浅快照各多大，导出、导入多久；
      重新载入（导出快照、新开一份导入）以后接着打 2000 下又涨多少 —— 看「定时重新载入」压不压得住内存
   正文是造的（种子固定）：一篇 0.3–40 KB，中位 2.5 KB 上下，中英文混排、标题、列表、代码块
   ============================================================ */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LoroDoc, __wasm } from "loro-crdt";

if (process.argv[2] === "--load") {
  const bytes = readFileSync(process.argv[3]);
  const edits = Number(process.argv[4] ?? 0);
  const start = __wasm.memory.buffer.byteLength;
  const docs = Array.from({ length: edits ? 8 : 100 }, () => {
    const doc = new LoroDoc();
    doc.import(bytes);
    doc.getText("body").toString();
    return doc;
  });
  const loaded = __wasm.memory.buffer.byteLength;
  // 接着打字（和协作时一样每下 commit、导出这一下的增量）：只报打字涨的
  for (const doc of docs) {
    const text = doc.getText("body");
    for (let key = 0; key < edits; key += 1) {
      text.insert(Math.floor(Math.random() * text.length), "协");
      const from = doc.oplogVersion();
      doc.commit();
      doc.export({ mode: "update", from });
      from.free();
    }
    text.free();
  }
  const end = __wasm.memory.buffer.byteLength;
  console.log(((edits ? end - loaded : loaded - start) / docs.length).toFixed(0));
  process.exit(0);
}

const N = Number(process.argv[2] ?? 2000);
const wasmBytes = () => __wasm.memory.buffer.byteLength;
// FinalizationRegistry 的回调在 gc 之后的任务里才跑：让一轮再量
const gc = async () => {
  globalThis.gc?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  globalThis.gc?.();
};
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
const median = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const p95 = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length * 0.95)];

let seed = 20261118;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const WORDS = [
  "协作",
  "笔记",
  "主持人",
  "访客",
  "同步",
  "文档",
  "the",
  "note",
  "sync",
  "loro",
  "会话",
  "附件",
];
function paragraph(chars) {
  let out = "";
  while (out.length < chars)
    out += WORDS[Math.floor(random() * WORDS.length)] + (random() < 0.2 ? "，" : " ");
  return out;
}
function note() {
  // 对数正态：大多数两三 KB，少数几十 KB
  const target = Math.min(
    40000,
    Math.max(300, Math.round(Math.exp(6.2 + random() * 1.4 + random() * 1.2))),
  );
  let text = `# ${paragraph(12)}\n\n`;
  while (text.length < target) {
    const pick = random();
    if (pick < 0.15) text += `## ${paragraph(10)}\n\n`;
    else if (pick < 0.35) text += `- ${paragraph(30)}\n- ${paragraph(24)}\n\n`;
    else if (pick < 0.42) text += "```ts\nconst x = 1;\n```\n\n";
    else text += `${paragraph(120)}\n\n`;
  }
  return text;
}

function hostDoc(text) {
  const doc = new LoroDoc();
  doc.getText("body").insert(0, text);
  doc.commit();
  return doc;
}
function guestDoc(host) {
  const doc = new LoroDoc();
  doc.import(host.export({ mode: "snapshot" }));
  return doc;
}

const notes = Array.from({ length: N }, note);
const textBytes = notes.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
console.log(
  `${N} 篇，正文合计 ${mb(textBytes)} MB，中位 ${(median(notes.map((t) => Buffer.byteLength(t))) / 1024).toFixed(1)} KB`,
);

// 1. 开 N 篇
await gc();
const base = wasmBytes();
const heapBase = process.memoryUsage().heapUsed;
let open = notes.map((text) => {
  const host = hostDoc(text);
  return { host, guest: guestDoc(host) };
});
await gc();
const grown = wasmBytes() - base;
const heap = process.memoryUsage().heapUsed - heapBase;
console.log(
  `开 ${N} 篇（两边各一份）：wasm 线性内存 +${mb(grown)} MB，一篇一边平均 ${(grown / N / 2 / 1024).toFixed(0)} KB；JS 堆 +${mb(heap)} MB`,
);

// 2. 全关掉再开 N 篇
for (const pair of open) {
  pair.host.free();
  pair.guest.free();
}
open = [];
await gc();
const afterClose = wasmBytes();
open = notes.map((text) => {
  const host = hostDoc(text);
  return { host, guest: guestDoc(host) };
});
await gc();
console.log(
  `全关掉：wasm 线性内存还是 ${mb(afterClose - base)} MB（不缩）；再开 ${N} 篇：又涨 ${mb(wasmBytes() - afterClose)} MB`,
);

// 3. 开一篇的耗时：开着 N 篇时 vs 关掉以后
function timeOpens(count) {
  const times = [];
  const made = [];
  for (let index = 0; index < count; index += 1) {
    const text = notes[index % notes.length];
    const start = performance.now();
    const host = hostDoc(text);
    const guest = guestDoc(host);
    times.push(performance.now() - start);
    made.push(host, guest);
  }
  for (const doc of made) doc.free();
  return times;
}
const busy = timeOpens(200);
for (const pair of open) {
  pair.host.free();
  pair.guest.free();
}
const states = notes.map((text) => hostDoc(text).export({ mode: "snapshot" }));
open = [];
await gc();
const idle = timeOpens(200);
console.log(
  `开一篇（主持人建 + 导出快照 + 访客导入）：开着 ${N} 篇时中位 ${median(busy).toFixed(2)} ms、p95 ${p95(busy).toFixed(2)}；都关掉时中位 ${median(idle).toFixed(2)} ms、p95 ${p95(idle).toFixed(2)}`,
);

// 4. 继续上次的访客：N 篇落盘的状态全导一遍
{
  const start = performance.now();
  const docs = states.map((state) => {
    const doc = new LoroDoc();
    doc.import(state);
    return doc;
  });
  const took = performance.now() - start;
  console.log(
    `继续上次的访客：导入 ${N} 篇落盘的状态 ${took.toFixed(0)} ms（还没算每篇一次 IPC 读文件）`,
  );
  for (const doc of docs) doc.free();
}

// 5. 一篇长时间编辑
{
  await gc();
  const before = wasmBytes();
  const a = hostDoc(notes[0]);
  const b = guestDoc(a);
  const KEYS = 20000;
  for (let key = 0; key < KEYS; key += 1) {
    const [doc, other] = key % 400 < 200 ? [a, b] : [b, a];
    const text = doc.getText("body");
    const at = Math.floor(random() * text.length);
    if (random() < 0.15 && text.length > 10) text.delete(at, 1);
    else text.insert(at, WORDS[key % WORDS.length][0]);
    const from = other.oplogVersion();
    doc.commit();
    other.import(doc.export({ mode: "update", from }));
  }
  await gc();
  const time = (fn) => {
    const start = performance.now();
    const value = fn();
    return [value, performance.now() - start];
  };
  const [full, fullMs] = time(() => a.export({ mode: "snapshot" }));
  const [shallow, shallowMs] = time(() =>
    a.export({ mode: "shallow-snapshot", frontiers: a.oplogFrontiers() }),
  );
  const [, importFullMs] = time(() => new LoroDoc().import(full));
  const [, importShallowMs] = time(() => new LoroDoc().import(shallow));
  // 空出来的内存会被复用：在新的进程里导入 100 份、留着，按涨了多少平摊
  const loaded = (bytes, edits = 0) => {
    const file = join(tmpdir(), `odea-collab-docs-${process.pid}.bin`);
    writeFileSync(file, bytes);
    const out = execFileSync(process.execPath, [
      fileURLToPath(import.meta.url),
      "--load",
      file,
      String(edits),
    ]);
    rmSync(file);
    return Number(String(out).trim());
  };
  const fullMem = loaded(full);
  const shallowMem = loaded(shallow);
  const fullThenTyped = loaded(full, 2000);
  const shallowThenTyped = loaded(shallow, 2000);
  console.log(
    `一篇 ${(Buffer.byteLength(notes[0]) / 1024).toFixed(1)} KB 的笔记两人交替打 ${KEYS} 下：两份文档 wasm +${mb(wasmBytes() - before)} MB；` +
      `完整快照 ${(full.length / 1024).toFixed(0)} KB（导出 ${fullMs.toFixed(1)} ms、导入 ${importFullMs.toFixed(1)} ms），` +
      `浅快照 ${(shallow.length / 1024).toFixed(0)} KB（导出 ${shallowMs.toFixed(1)} ms、导入 ${importShallowMs.toFixed(1)} ms）；` +
      `新开一份导入完整快照占 ${mb(fullMem)} MB、导入浅快照占 ${mb(shallowMem)} MB；` +
      `导入以后接着打 2000 下：完整快照的又涨 ${mb(fullThenTyped)} MB、浅快照的又涨 ${mb(shallowThenTyped)} MB`,
  );
}
