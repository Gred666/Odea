// 表格格子里用输入法打字（editor/cellEditor.ts 的子编辑器，docs/表格.md P13.3）
//
//   pnpm dev                                                # 先把开发服务器开着
//   node scripts/perf/table-ime.mjs [地址] [轮数] [same]    # 默认 http://localhost:1420/、30 轮
//
// 打开协作实验台（/?lab=collab），正文换成一张表；主持人真鼠标点进一格，用 DevTools 协议的
// Input.imeSetComposition 真的走一遍输入法（拼音一个个字母长出来 → 上屏）。同时访客的机器人
// 每秒打 20 个字：默认打在另一行的格子里；加 same 打在主持人这一格的最前面 —— 组字期间
// 别人改了同一格，子编辑器先不跟（免得打断输入法），组完字两边的改动合到一起。
// happy-dom 的单测走不到 CodeMirror 从 DOM 读组字改动那条路，这里用真的 Chrome 补上。
//
// 查这几件事：
// 1. 上屏的词按顺序、连成一片地出现在格子里打字的地方，不多不少
// 2. 访客那边的正文从头到尾没出现过拼音字母串（组字时子编辑器不写回正文）
// 3. 停下以后两边逐字一致，表格还是那张表（行数、列数没乱）
// 4. 一直在那一格里编辑（没有被打断退回正文），光标在刚打的字后面
// 环境变量 CDP_ATTACH=端口：不起无头 Chrome，接到开着的外壳上（CEF 试验，docs/插件与跨端.md §7.4），
// 地址上带 `mock`，外壳里的前端才走浏览器预览那条路
import { attach, launch, sleep } from "./cdp.mjs";

const BASE = process.argv[2] ?? "http://localhost:1420/";
const ROUNDS = Number(process.argv[3] ?? 30);
const SAME = process.argv[4] === "same";
const WORDS = [
  ["nihao", "你好"],
  ["biaoge", "表格"],
  ["gezi", "格子"],
  ["zhongwen", "中文"],
  ["shurufa", "输入法"],
];
const DOC = "# 表格组字\n\n| 名字 | 备注 |\n|---|---|\n| 甲 | 写在这里： |\n| 乙 | 另一格 |\n\n后面一行。\n";

const ATTACH = process.env.CDP_ATTACH;
const page = ATTACH ? await attach(Number(ATTACH)) : await launch(9347);
const { send, evaluate } = page;
let failed = false;
try {
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1400,
    height: 860,
    deviceScaleFactor: 1.5,
    mobile: false,
  });
  await send("Page.navigate", {
    url: new URL(`?lab=collab&latency=20${ATTACH ? "&mock" : ""}`, BASE).href,
  });
  for (let i = 0; i < 150 && !(await evaluate("!!window.__collabLab")); i++) await sleep(100);
  await sleep(800);

  // 主持人的正文换成一张表（会同步给访客）
  await evaluate(`(async () => {
    const { EditorView } = await import('/node_modules/.vite/deps/@codemirror_view.js');
    const view = EditorView.findFromDOM(document.querySelector('[data-lab-peer="lab-host"] .cm-editor'));
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(DOC)} },
      selection: { anchor: ${DOC.length} } });
  })()`);
  await sleep(600);

  // 访客那边：正文每变一次都看一眼有没有拼音
  await evaluate(`(() => {
    const guest = window.__collabLab.members[1].session;
    window.__pinyinSeen = [];
    const pinyin = ${JSON.stringify(WORDS.map(([py]) => py.slice(0, 3)))};
    guest.onChange(() => {
      const text = guest.toString();
      for (const py of pinyin) if (text.includes(py)) window.__pinyinSeen.push(py);
    });
  })()`);

  // 真鼠标点进主持人那边「写在这里：」那一格的最后
  const point = await evaluate(`(() => {
    const cell = [...document.querySelectorAll('[data-lab-peer="lab-host"] .cm-odea-table-widget td')]
      .find((td) => td.textContent.includes('写在这里'));
    const box = cell.getBoundingClientRect();
    return { x: box.right - 16, y: box.top + box.height / 2 };
  })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
  }
  await sleep(300);
  const editing = () =>
    evaluate(`(() => {
      const cell = document.querySelector('[data-lab-peer="lab-host"] .cm-odea-table-widget .is-editing');
      return !!cell && cell.contains(document.activeElement) && cell.textContent.includes('写在这里');
    })()`);
  if (!(await editing())) throw new Error("没点进格子");

  // 访客的机器人：打在另一行的格子里，或者这一格的最前面
  await evaluate(`(() => {
    const guest = window.__collabLab.members[1].session.toString();
    const at = guest.indexOf(${JSON.stringify(SAME ? "写在这里" : "另一格")});
    window.__collabLab.typeHeadless(1, at);
  })()`);

  const hostText = () => evaluate("window.__collabLab.members[0].session.toString()");
  let expected = "";
  let interrupted = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const [pinyin, word] = WORDS[round % WORDS.length];
    for (let length = 1; length <= pinyin.length; length++) {
      await send("Input.imeSetComposition", {
        text: pinyin.slice(0, length),
        selectionStart: length,
        selectionEnd: length,
      });
      await sleep(10 + Math.random() * 50);
    }
    await send("Input.insertText", { text: word });
    expected += word;
    if (!(await editing())) interrupted += 1;
    // 有时马上接着打下一个词（远端的字正好卡在组字结束那几毫秒），有时停一会儿
    await sleep(Math.random() < 0.5 ? Math.random() * 8 : 30 + Math.random() * 150);
  }
  await evaluate("window.__collabLab.stopHeadless()");
  await sleep(1500);

  const result = await evaluate(`(() => {
    const [host, guest] = window.__collabLab.members.map((member) => member.session.toString());
    const cell = document.querySelector('[data-lab-peer="lab-host"] .cm-odea-table-widget .is-editing');
    return { host, guest, pinyin: window.__pinyinSeen, stillEditing: !!cell && cell.contains(document.activeElement) };
  })()`);
  const lines = result.host.split("\n");
  const row = lines.find((line) => line.includes("写在这里")) ?? "";
  const at = row.indexOf("写在这里：") + 5;
  const typed = row.slice(at, at + expected.length);
  const checks = [
    ["上屏的字一个不丢、不重复、连成一片", typed === expected, `期望「${expected}」\n实际「${typed}」`],
    ["访客从没看到拼音", result.pinyin.length === 0, `看到了：${[...new Set(result.pinyin)].join("、")}`],
    ["两边逐字一致", result.host === result.guest, `主持人 ${result.host.length} 字，访客 ${result.guest.length} 字`],
    [
      "表格还是那张表",
      lines.filter((line) => line.startsWith("|")).length === 4 &&
        row.startsWith("| 甲 |") &&
        row.split(" | ").length === 2,
      row,
    ],
    ["一直在那一格里编辑", interrupted === 0 && result.stillEditing, `${interrupted} 个词之后不在编辑了`],
    [
      SAME ? "机器人打在这一格最前面的字都在" : "机器人打在另一格的字都在",
      SAME ? row.indexOf("写在这里") > row.indexOf("| 甲 | ") + 6 : !lines.some((line) => line === "| 乙 | 另一格 |"),
      SAME ? row : "",
    ],
  ];
  console.log(
    `${ROUNDS} 个词，访客的机器人每秒 20 个字（${SAME ? "同一格的最前面" : "另一行的格子"}），单程 20ms`,
  );
  console.log(`格子那一行：${row.slice(0, 160)}${row.length > 160 ? "…" : ""}`);
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `\n  ${detail}`}`);
    if (!ok) failed = true;
  }
} finally {
  await page.close();
}
process.exit(failed ? 1 : 0);
