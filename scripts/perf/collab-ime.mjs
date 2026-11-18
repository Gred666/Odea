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
//
//   node scripts/perf/collab-ime.mjs [地址] [轮数] attach # 挂上的那一刻正在组字（docs/协同编辑.md §27），默认 8 轮
//
// 实验台开成 late=1：访客那一栏先一个人开着（编辑器照自己那份正文建的），打一个词，再加入
// （joinLate：记下正文、同步、三方合，300ms 后才把会话交给编辑器），这期间快快打完一个词、再慢慢组下一个 ——
// 会话挂上来时正在组字，之前上屏的那个词只在编辑器里。
// 一半的轮主持人的机器人打在同一行（挂上时要对齐的改动碰到组字那一行，得等上屏），一半打在文档开头。
// 查：访客打的词（加入前、挂上时正在组的、挂上后的）一个不丢不重复；主持人那边没看到过拼音；两边一致
//
//   node scripts/perf/collab-ime.mjs [地址] [轮数] joincompose # 加入（记本机正文）的那一刻正在组字（§27.5），默认 8 轮
//
// 和 attach 一样开 late=1，只是在组一个词的半路点加入：记本机正文、三方合要等组完字（flushEditorsComposed），
// 不然拼音当成本机那一版合进会话、主持人那边闪一下拼音。查的三样同 attach
import { launch, sleep } from "./cdp.mjs";

const BASE = process.argv[2] ?? "http://localhost:1420/";
const JOIN_COMPOSE = process.argv[4] === "joincompose";
const ATTACH = process.argv[4] === "attach" || JOIN_COMPOSE;
const ROUNDS = Number(process.argv[3] ?? (ATTACH ? 8 : 40));
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

// 调试端口：几个会话同时跑时用 CDP_PORT 错开
const page = await launch(Number(process.env.CDP_PORT ?? 9346));
const { send, evaluate } = page;
let failed = false;

/** 某一栏正文里某段字前后的屏幕坐标 */
const spotIn = (peer, text, after) =>
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
const clickAt = async (point) => {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
  }
  await sleep(100);
};

/** 挂上的那一刻正在组字（attach）：每轮重开一次实验台 */
async function attachRounds() {
  let ok = true;
  let composingAtAttach = 0;
  for (let round = 0; round < ROUNDS; round++) {
    // joincompose 不打同一行：主持人也改了那一行时三方合跳过、本机那一版不进会话（另有提示，§28），测不出拼音
    const near = !JOIN_COMPOSE && round % 2 === 1;
    await send("Page.navigate", { url: new URL("?lab=collab&late=1&latency=20", BASE).href });
    for (let i = 0; i < 150 && !(await evaluate("!!window.__collabLab")); i++) await sleep(100);
    await sleep(600);
    await evaluate(`(() => {
      const host = window.__collabLab.members[0].session;
      window.__pinyinSeen = [];
      const pinyin = ${JSON.stringify(WORDS.map(([py]) => py.slice(0, 3)))};
      host.onChange(() => {
        const text = host.toString();
        for (const py of pinyin) if (text.includes(py)) window.__pinyinSeen.push(py);
      });
    })()`);
    await clickAt(await spotIn("lab-guest-1", "一起进来。", true));
    const typed = [];
    const typeWord = async ([pinyin, word], gap) => {
      for (let length = 1; length <= pinyin.length; length++) {
        await send("Input.imeSetComposition", {
          text: pinyin.slice(0, length),
          selectionStart: length,
          selectionEnd: length,
        });
        await sleep(gap ?? 10 + Math.random() * 30);
      }
      await send("Input.insertText", { text: word });
      typed.push(word);
    };
    // 加入之前一个人打的（加入时三方合进会话）。同一行的那一半不打：主持人也改了那一行，三方合会跳过（让 git 合）
    if (!near) await typeWord(WORDS[round % WORDS.length]);
    // 主持人的机器人：near 打在同一行（「组字的时候」前面），不然打在文档开头
    await evaluate(`(() => {
      const lab = window.__collabLab;
      const text = lab.members[0].session.toString();
      lab.typeHeadless(0, ${near} ? text.indexOf("组字的时候") : 0);
    })()`);
    if (JOIN_COMPOSE) {
      // 组一个词的半路点加入：记本机正文要等这个词组完
      const [pinyin, word] = WORDS[(round + 1) % WORDS.length];
      // 拼音组到第三个字母（主持人那边认拼音看的是前三个字母）再点加入
      for (let length = 1; length <= 3; length++) {
        await send("Input.imeSetComposition", { text: pinyin.slice(0, length), selectionStart: length, selectionEnd: length });
        await sleep(20);
      }
      await evaluate(`(() => {
        const view = document.querySelector('[data-lab-peer="lab-guest-1"] .cm-content').cmTile?.view;
        window.__attachedComposing = !!view?.compositionStarted;
        window.__collabLab.joinLate(300);
      })()`);
      for (let length = 4; length <= pinyin.length; length++) {
        await send("Input.imeSetComposition", { text: pinyin.slice(0, length), selectionStart: length, selectionEnd: length });
        await sleep(120);
      }
      await send("Input.insertText", { text: word });
      typed.push(word);
      await sleep(500);
      await typeWord(WORDS[(round + 2) % WORDS.length]);
    } else {
    // 加入：300ms 后会话交给编辑器。这期间先快快打完一个词（记下正文以后、挂上之前上屏的，靠 origin 对齐），
    // 再慢慢组下一个词，挂上的那一刻正组着
    await evaluate(`(() => {
      const content = document.querySelector('[data-lab-peer="lab-guest-1"] .cm-content');
      const view = content.cmTile?.view;
      window.__attachedComposing = null;
      window.__collabLab.joinLate(300).then(() => {
        window.__attachedComposing = !!view?.compositionStarted;
      });
    })()`);
    await typeWord(WORDS[(round + 1) % WORDS.length], 8);
    await typeWord(WORDS[(round + 2) % WORDS.length], 70);
    await typeWord(WORDS[(round + 3) % WORDS.length]);
    }
    await evaluate("window.__collabLab.stopHeadless()");
    await sleep(1500);
    const result = await evaluate(`(() => {
      const [host, guest] = window.__collabLab.members.map((member) => member.session.toString());
      const shown = document.querySelector('[data-lab-peer="lab-guest-1"] .cm-content').cmTile?.view.state.doc.toString();
      return { host, guest, shown, pinyin: window.__pinyinSeen, composing: window.__attachedComposing };
    })()`);
    if (result.composing) composingAtAttach += 1;
    const expected = typed.join("");
    const at = result.guest.indexOf("一起进来。") + 5;
    const got = result.guest.slice(at, at + expected.length);
    const checks = [
      ["访客打的词一个不丢、不重复、连成一片", got === expected, `期望「${expected}」\n  实际「${got}」`],
      ["主持人从没看到拼音", result.pinyin.length === 0, `看到了：${[...new Set(result.pinyin)].join("、")}`],
      [
        "两边逐字一致、编辑器和正文一致",
        result.host === result.guest && result.shown === result.guest,
        `主持人 ${result.host.length} 字，访客 ${result.guest.length} 字，访客编辑器 ${result.shown?.length} 字`,
      ],
    ];
    const bad = checks.filter(([, pass]) => !pass);
    console.log(
      `第 ${round + 1} 轮（${near ? "同一行" : "别的行"}，${JOIN_COMPOSE ? "点加入" : "挂上"}时${result.composing ? "正在组字" : "没在组字"}）：${bad.length ? "✗" : "✓"}`,
    );
    for (const [name, , detail] of bad) console.log(`  ✗ ${name}\n  ${detail}`);
    if (bad.length) ok = false;
  }
  console.log(`${ROUNDS} 轮里 ${composingAtAttach} 轮${JOIN_COMPOSE ? "点加入" : "挂上"}的那一刻正在组字`);
  if (composingAtAttach < ROUNDS / 2) {
    console.log("✗ 挂上时正在组字的轮太少，没测到");
    ok = false;
  }
  return ok;
}

if (ATTACH) {
  try {
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1400,
      height: 860,
      deviceScaleFactor: 1.5,
      mobile: false,
    });
    failed = !(await attachRounds());
  } finally {
    await page.close();
  }
  process.exit(failed ? 1 : 0);
}

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
