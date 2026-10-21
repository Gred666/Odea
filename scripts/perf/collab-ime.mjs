// 协作时用输入法打字：一个字都不能丢、不能重复，对方也不该看到拼音（docs/协同编辑.md §4.3）
//
//   pnpm dev                                              # 先把开发服务器开着
//   node scripts/perf/collab-ime.mjs [地址] [轮数] [near] # 默认 http://localhost:1420/、40 轮
//
// 加 near：访客的光标放在主持人打字那一行的行首，机器人的字插在组字位置前面、同一行里 ——
// 最容易打断输入法的情况（远端改动碰到组字所在的那段 DOM，CodeMirror 只能重画这一行）。
//
// 打开协作实验台（/?lab=collab），访客的机器人每秒打 20 个字；主持人这边用 DevTools 协议的
// Input.imeSetComposition 真的走一遍输入法（compositionstart → 一个个拼音字母 → 上屏），
// 中间夹着随机的停顿，让远端的字正好在组字中途、组字刚结束那几毫秒里到。
// happy-dom 的单测模拟不了 CodeMirror 从 DOM 读组字改动的那条路，这里用真的 Chrome 补上。
//
// 查这几件事：
// 1. 上屏的词按顺序、连成一片地出现在主持人打字的地方，不多不少（吞字、重复上屏都会露馅）
// 2. 访客那边的正文从头到尾没出现过拼音字母串
// 3. 停下以后两边逐字一致
// 4. 组字期间别人的字进没进来（§20.10）：打在别的行（默认）的当场进来；同一行（near）的等上屏
import { launch, sleep } from "./cdp.mjs";

const BASE = process.argv[2] ?? "http://localhost:1420/";
const ROUNDS = Number(process.argv[3] ?? 40);
const NEAR = process.argv[4] === "near";
const WORDS = [
  ["nihao", "你好"],
  ["shijie", "世界"],
  ["women", "我们"],
  ["xiezuo", "协作"],
  ["bianji", "编辑"],
  ["zhongwen", "中文"],
  ["shurufa", "输入法"],
];

const page = await launch(9346);
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
  await send("Page.navigate", { url: new URL("?lab=collab&latency=20&bot=1", BASE).href });
  for (let i = 0; i < 150 && !(await evaluate("!!window.__collabLab")); i++) await sleep(100);
  await sleep(800);

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

  /** 某一边正文里某段字前后的屏幕坐标 */
  const spot = (peer, text, after) =>
    evaluate(`(() => {
      const pane = document.querySelector('[data-lab-peer="${peer}"] .cm-content');
      const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode()); ) {
        const i = node.data.indexOf(${JSON.stringify(text)});
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(node, i + (${after} ? ${text.length} : 0));
        const box = range.getBoundingClientRect();
        return { x: box.left + 1, y: box.top + box.height / 2 };
      }
    })()`);
  const click = async (point) => {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
    }
    await sleep(100);
  };
  // near：先点访客那边同一行的行首，机器人从那里往后打
  if (NEAR) await click(await spot("lab-guest-1", "组字的时候", false));
  // 主持人：点到「讨论」那段引用的末尾，开始打
  await click(await spot("lab-host", "一起进来。", true));
  await sleep(200);
  const hostText = () => evaluate("window.__collabLab.members[0].session.toString()");
  const before = await hostText();
  const anchor = before.indexOf("一起进来。") + 5;

  // 主持人编辑器里（不是正文）现在有多少字：组字期间别人的字进来了，这个数会长
  const hostShown = () =>
    evaluate(`document.querySelector('[data-lab-peer="lab-host"] .cm-content').textContent.length`);
  let grewWhileComposing = 0;
  let expected = "";
  for (let round = 0; round < ROUNDS; round++) {
    const [pinyin, word] = WORDS[round % WORDS.length];
    let first = 0;
    for (let length = 1; length <= pinyin.length; length++) {
      await send("Input.imeSetComposition", {
        text: pinyin.slice(0, length),
        selectionStart: length,
        selectionEnd: length,
      });
      if (length === 1) first = await hostShown();
      await sleep(10 + Math.random() * 50);
    }
    // 拼音从 1 个字母长到 n 个；多出来的是组字期间进来的别人的字
    if ((await hostShown()) - first - (pinyin.length - 1) > 0) grewWhileComposing += 1;
    await send("Input.insertText", { text: word });
    expected += word;
    // 有时马上接着打下一个词（远端的字正好卡在组字结束那几毫秒），有时停一会儿
    await sleep(Math.random() < 0.5 ? Math.random() * 8 : 30 + Math.random() * 150);
  }

  // 停下机器人，等两边一致
  await evaluate("document.querySelector('[data-lab-peer=\"lab-guest-1\"] [data-lab-bot]').click()");
  await sleep(1500);
  const result = await evaluate(`(() => {
    const [host, guest] = window.__collabLab.members.map((member) => member.session.toString());
    return { host, guest, pinyin: window.__pinyinSeen };
  })()`);

  // 机器人打在文档开头，主持人打在引用末尾：「一起进来。」后面紧跟着的应该正好是上屏的那串词
  const at = result.host.indexOf("一起进来。") + 5;
  const typed = result.host.slice(at, at + expected.length);
  const checks = [
    ["上屏的字一个不丢、不重复、连成一片", typed === expected, `期望「${expected}」\n实际「${typed}」`],
    ["访客从没看到拼音", result.pinyin.length === 0, `看到了：${[...new Set(result.pinyin)].join("、")}`],
    ["两边逐字一致", result.host === result.guest, `主持人 ${result.host.length} 字，访客 ${result.guest.length} 字`],
    [
      "主持人打字的地方前后没被动过",
      result.host.slice(at + expected.length).startsWith(before.slice(anchor)),
      "",
    ],
    NEAR
      ? ["组字那一行的远端改动等上屏才进来", grewWhileComposing === 0, `${grewWhileComposing} 个词的组字期间进来了`]
      : [
          "别的行的远端改动组字期间就进来了",
          grewWhileComposing >= ROUNDS / 2,
          `只有 ${grewWhileComposing} / ${ROUNDS} 个词的组字期间看到了`,
        ],
  ];
  console.log(`${ROUNDS} 个词，访客那边机器人每秒 20 个字（${NEAR ? "同一行、插在组字位置前面" : "打在文档开头"}），单程 20ms`);
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `\n  ${detail}`}`);
    if (!ok) failed = true;
  }
} finally {
  await page.close();
}
process.exit(failed ? 1 : 0);
