// 表格格子里用输入法打字（editor/cellEditor.ts 的子编辑器，docs/表格.md P13.3）
//
//   pnpm dev                                                # 先把开发服务器开着
//   node scripts/perf/table-ime.mjs [地址] [轮数] [same]    # 默认 http://localhost:1420/、30 轮
//   node scripts/perf/table-ime.mjs [地址] [轮数] below     # 表格下面紧贴的那一行组字（docs/表格.md §13）
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
//
// 加 below：主持人真鼠标点表格下面紧贴的那个空行，在那里一个词一个词地组（机器人打在「写在这里」那一格的最前面，
// 组字期间表格自己也在变）。查：上屏的词连成一片、落在和表格隔着一个空行的那一行（`…| 乙 | 另一格 |\n\n词…\n后面一行。`）；
// 访客没看到拼音、也从没看到词进了表格；两边一致；主持人这边表格的替身一次都没被换掉、没塌成源码（每个拼音字母之后都看）
import { launch, sleep } from "./cdp.mjs";

const BASE = process.argv[2] ?? "http://localhost:1420/";
const ROUNDS = Number(process.argv[3] ?? 30);
const SAME = process.argv[4] === "same";
const BELOW = process.argv[4] === "below";
const WORDS = [
  ["nihao", "你好"],
  ["biaoge", "表格"],
  ["gezi", "格子"],
  ["zhongwen", "中文"],
  ["shurufa", "输入法"],
];
const DOC =
  "# 表格组字\n\n| 名字 | 备注 |\n|---|---|\n| 甲 | 写在这里： |\n| 乙 | 另一格 |\n\n后面一行。\n";

const page = await launch(9347);
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
  await send("Page.navigate", { url: new URL("?lab=collab&latency=20", BASE).href });
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

  // 访客那边：正文每变一次都看一眼有没有拼音、词有没有进表格（紧贴表格最后一行的那一行有字）
  await evaluate(`(() => {
    const guest = window.__collabLab.members[1].session;
    window.__pinyinSeen = [];
    window.__guestInTable = 0;
    const pinyin = ${JSON.stringify(WORDS.map(([py]) => py.slice(0, 3)))};
    guest.onChange(() => {
      const text = guest.toString();
      for (const py of pinyin) if (text.includes(py)) window.__pinyinSeen.push(py);
      const at = text.indexOf('| 乙 | 另一格 |\\n');
      if (at >= 0 && !'\\n'.includes(text.charAt(at + 12) || '\\n')) window.__guestInTable += 1;
    });
  })()`);

  // 真鼠标点进主持人那边「写在这里：」那一格的最后（below：点表格下面紧贴的那个空行）
  const point = await evaluate(`(() => {
    const host = document.querySelector('[data-lab-peer="lab-host"]');
    const target = ${BELOW}
      ? host.querySelector('.cm-odea-table-block').nextElementSibling
      : [...host.querySelectorAll('.cm-odea-table-widget td')].find((td) => td.textContent.includes('写在这里'));
    const box = target.getBoundingClientRect();
    return { x: ${BELOW} ? box.left + 30 : box.right - 16, y: box.top + box.height / 2 };
  })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
  }
  await sleep(300);
  // 主持人的编辑器；below：表格的替身被换掉了几次（MutationObserver），每个拼音字母之后看一眼塌没塌成源码
  await evaluate(`(() => {
    const host = document.querySelector('[data-lab-peer="lab-host"]');
    window.__hostView = host.querySelector('.cm-content').cmTile.root.view;
    window.__blockRemoved = 0;
    window.__sourceSeen = 0;
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.removedNodes)
          if (node.nodeType === 1 && (node.matches('.cm-odea-table-block') || node.querySelector('.cm-odea-table-block')))
            window.__blockRemoved += 1;
    }).observe(host.querySelector('.cm-content'), { childList: true, subtree: true });
  })()`);
  /** below：光标在表格下面隔着一个空行的那一行（「| 乙 | 另一格 |」、空行、这一行） */
  const belowTable = (placed) => `(() => {
    const view = window.__hostView;
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    const above = (n) => (line.number > n ? view.state.doc.line(line.number - n).text : null);
    return ${placed} ? line.text === '' && above(1) === '| 乙 | 另一格 |'
      : !document.querySelector('[data-lab-peer="lab-host"] .is-editing') && above(1) === '' && above(2) === '| 乙 | 另一格 |';
  })()`;
  const editing = () =>
    evaluate(
      BELOW
        ? belowTable(false)
        : `(() => {
      const cell = document.querySelector('[data-lab-peer="lab-host"] .cm-odea-table-widget .is-editing');
      return !!cell && cell.contains(document.activeElement) && cell.textContent.includes('写在这里');
    })()`,
    );
  const collapsed = () =>
    evaluate(`(() => {
      const host = document.querySelector('[data-lab-peer="lab-host"]');
      if (!host.querySelector('.cm-odea-table-block') || host.querySelector('.cm-line.cm-odea-table')) window.__sourceSeen += 1;
    })()`);
  if (BELOW ? !(await evaluate(belowTable(true))) : !(await editing()))
    throw new Error(BELOW ? "没点到表格下面紧贴的那一行" : "没点进格子");

  // 访客的机器人：打在另一行的格子里，或者这一格的最前面
  await evaluate(`(() => {
    const guest = window.__collabLab.members[1].session.toString();
    const at = guest.indexOf(${JSON.stringify(SAME || BELOW ? "写在这里" : "另一格")});
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
      if (BELOW) await collapsed();
      await sleep(10 + Math.random() * 50);
    }
    await send("Input.insertText", { text: word });
    expected += word;
    if (BELOW) await collapsed();
    if (!(await editing())) interrupted += 1;
    // 有时马上接着打下一个词（远端的字正好卡在组字结束那几毫秒），有时停一会儿
    await sleep(Math.random() < 0.5 ? Math.random() * 8 : 30 + Math.random() * 150);
  }
  await evaluate("window.__collabLab.stopHeadless()");
  await sleep(1500);

  const result = await evaluate(`(() => {
    const [host, guest] = window.__collabLab.members.map((member) => member.session.toString());
    const cell = document.querySelector('[data-lab-peer="lab-host"] .cm-odea-table-widget .is-editing');
    return { host, guest, pinyin: window.__pinyinSeen, stillEditing: !!cell && cell.contains(document.activeElement),
      guestInTable: window.__guestInTable, blockRemoved: window.__blockRemoved, sourceSeen: window.__sourceSeen };
  })()`);
  const lines = result.host.split("\n");
  const row = lines.find((line) => line.includes("写在这里")) ?? "";
  const at = row.indexOf("写在这里：") + 5;
  const typed = row.slice(at, at + expected.length);
  const below = result.host.slice(result.host.indexOf("| 乙 | 另一格 |"));
  const checks = BELOW
    ? [
        [
          "上屏的词连成一片，落在和表格隔着一个空行的那一行",
          below === `| 乙 | 另一格 |\n\n${expected}\n后面一行。\n`,
          `期望 ${JSON.stringify(`| 乙 | 另一格 |\n\n${expected}\n后面一行。\n`)}\n实际 ${JSON.stringify(below.slice(0, 200))}`,
        ],
        [
          "访客从没看到拼音",
          result.pinyin.length === 0,
          `看到了：${[...new Set(result.pinyin)].join("、")}`,
        ],
        ["访客从没看到词进了表格", result.guestInTable === 0, `${result.guestInTable} 次`],
        [
          "两边逐字一致",
          result.host === result.guest,
          `主持人 ${result.host.length} 字，访客 ${result.guest.length} 字`,
        ],
        [
          "表格还是那张表，主持人这边的替身没被换掉、没塌成源码",
          lines.filter((line) => line.startsWith("|")).length === 4 &&
            result.blockRemoved === 0 &&
            result.sourceSeen === 0,
          `换掉 ${result.blockRemoved} 次，源码 ${result.sourceSeen} 次`,
        ],
        ["一直在那一行里打字", interrupted === 0, `${interrupted} 个词之后不在那一行了`],
        ["机器人打在格子里的字都在", row.indexOf("写在这里") > row.indexOf("| 甲 | ") + 6, row],
      ]
    : [
        [
          "上屏的字一个不丢、不重复、连成一片",
          typed === expected,
          `期望「${expected}」\n实际「${typed}」`,
        ],
        [
          "访客从没看到拼音",
          result.pinyin.length === 0,
          `看到了：${[...new Set(result.pinyin)].join("、")}`,
        ],
        [
          "两边逐字一致",
          result.host === result.guest,
          `主持人 ${result.host.length} 字，访客 ${result.guest.length} 字`,
        ],
        [
          "表格还是那张表",
          lines.filter((line) => line.startsWith("|")).length === 4 &&
            row.startsWith("| 甲 |") &&
            row.split(" | ").length === 2,
          row,
        ],
        [
          "一直在那一格里编辑",
          interrupted === 0 && result.stillEditing,
          `${interrupted} 个词之后不在编辑了`,
        ],
        [
          SAME ? "机器人打在这一格最前面的字都在" : "机器人打在另一格的字都在",
          SAME
            ? row.indexOf("写在这里") > row.indexOf("| 甲 | ") + 6
            : !lines.some((line) => line === "| 乙 | 另一格 |"),
          SAME ? row : "",
        ],
      ];
  console.log(
    BELOW
      ? `${ROUNDS} 个词，表格下面紧贴的那一行；访客的机器人每秒 20 个字（「写在这里」那一格的最前面），单程 20ms`
      : `${ROUNDS} 个词，访客的机器人每秒 20 个字（${SAME ? "同一格的最前面" : "另一行的格子"}），单程 20ms`,
  );
  console.log(
    BELOW
      ? `表格下面：${JSON.stringify(below.slice(0, 160))}`
      : `格子那一行：${row.slice(0, 160)}${row.length > 160 ? "…" : ""}`,
  );
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `\n  ${detail}`}`);
    if (!ok) failed = true;
  }
} finally {
  await page.close();
}
process.exit(failed ? 1 : 0);
