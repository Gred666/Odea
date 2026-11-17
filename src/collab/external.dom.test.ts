// @vitest-environment happy-dom

import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { collab } from "./binding";
import { fineEdits, mergeExternal, snapshot, textEdits } from "./external";
import { LoopbackHub, ManualScheduler } from "./loopback";
import { type Peer, peerColor } from "./session";

const peer = (id: string): Peer => ({ id, name: id, color: peerColor(id) });

const hubs: LoopbackHub[] = [];
const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  for (const hub of hubs.splice(0)) hub.destroy();
  document.body.replaceChildren();
});

function room(text: string) {
  const scheduler = new ManualScheduler();
  const hub = new LoopbackHub({ scheduler });
  hubs.push(hub);
  const host = hub.host(peer("host"), text);
  const guest = hub.join(peer("guest"));
  return { scheduler, hub, host, guest };
}

function mount(session: Parameters<typeof collab>[0]) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: session.toString(),
      extensions: [history(), collab(session)],
    }),
  });
  views.push(view);
  return view;
}

const apply = (before: string, after: string) => {
  let text = before;
  for (const edit of textEdits(before, after).reverse()) {
    text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  }
  return text;
};

describe("磁盘上的改动拆成编辑", () => {
  it("隔得远的改动分开，中间没动的行一个字都不碰", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `第 ${index} 行`);
    const after = [...lines];
    after[2] = "第 2 行（改）";
    after[30] = "第 30 行（也改）";
    const edits = textEdits(lines.join("\n"), after.join("\n"));
    expect(edits).toHaveLength(2);
    // 细到字：只插了括号那几个字
    expect(edits.map((edit) => edit.insert)).toEqual(["（改）", "（也改）"]);
    expect(edits.every((edit) => edit.to === edit.from)).toBe(true);
  });

  it("加在末尾、删掉最后一行、整篇清空、从空开始、emoji 都对", () => {
    const cases: [string, string][] = [
      ["a\nb", "a\nb\nc"],
      ["a\nb\nc", "a\nb"],
      ["a\nb", ""],
      ["", "新的\n一篇"],
      ["表情😀在这", "表情😁在这"],
      ["x\n\n\ny", "x\ny"],
      ["同一行里\n改两处", "同一行里（一）\n改两处（二）"],
    ];
    for (const [before, after] of cases) expect(apply(before, after)).toBe(after);
  });

  it("随机改：把改动打回去总能得到磁盘上的正文", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const chars = [..."的一是ab 😀\n"];
    const pick = () => chars[Math.floor(random() * chars.length)]!;
    const word = () => Array.from({ length: Math.floor(random() * 6) }, pick).join("");
    for (let round = 0; round < 3000; round += 1) {
      const lines = Array.from({ length: Math.floor(random() * 12) }, word);
      const changedLines = lines
        .map((line) => (random() < 0.3 ? word() : line))
        .filter(() => random() > 0.1);
      if (random() < 0.3)
        changedLines.splice(Math.floor(random() * changedLines.length), 0, word());
      const before = lines.join("\n");
      const after = changedLines.join("\n");
      expect(apply(before, after)).toBe(after);
    }
  });
});

describe("细到字的改动（fineEdits，docs/协同编辑.md §27）", () => {
  const applyFine = (before: string, after: string) => {
    let text = before;
    for (const edit of fineEdits(before, after).reverse()) {
      text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
    }
    return text;
  };

  it("同一段里隔开的两处改动分开（textEdits 是一整个替换）", () => {
    const before = "今天开会讨论预算。";
    const after = "明天开会讨论人事。";
    expect(textEdits(before, after)).toHaveLength(1);
    expect(fineEdits(before, after)).toEqual([
      { from: 0, to: 1, insert: "明" },
      { from: 6, to: 8, insert: "人事" },
    ]);
  });

  it("不切开代理对：换了一个 emoji，改的是整个 emoji", () => {
    expect(fineEdits("表情😀在这", "表情😁在这")).toEqual([{ from: 2, to: 4, insert: "😁" }]);
    expect(fineEdits("a😀b😀c", "a😀Xb😀c")).toEqual([{ from: 3, to: 3, insert: "X" }]);
  });

  it("整句换掉：不拿碰巧一样的几个散字东拼西凑", () => {
    // LCS 只对得上一个「d」：夹在两大段改动中间，并进改动
    expect(fineEdits("abcdefgh", "xxdxxxxx")).toEqual([{ from: 0, to: 8, insert: "xxdxxxxx" }]);
    // 真的一样的一段（比两边的改动长）留着
    expect(fineEdits("甲，我们今天开会，乙", "丙，我们今天开会，丁")).toEqual([
      { from: 0, to: 1, insert: "丙" },
      { from: 9, to: 10, insert: "丁" },
    ]);
  });

  it("很多段整段改写的长文：逐字比有总量上限，超出的几处整处替换，打回去照样对", () => {
    let seed = 7;
    const paragraph = () =>
      Array.from({ length: 800 }, () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return String.fromCodePoint(0x4e00 + (seed % 2000));
      }).join("");
    // 60 段、段和段之间隔着空行，每段隔 40 个字改一个：textEdits 给 60 处，每处 800 × 800 个格子，
    // 加起来 3800 万（没有上限时主线程上算两三百毫秒）
    const paragraphs = Array.from({ length: 60 }, paragraph);
    const before = paragraphs.join("\n\n");
    const after = paragraphs.map((text) => text.replace(/(.{39})./gu, "$1改")).join("\n\n");
    const coarse = textEdits(before, after);
    expect(coarse).toHaveLength(60);
    const edits = fineEdits(before, after);
    expect(applyFine(before, after)).toBe(after);
    // 前面几处细分了（一段 20 处），用完以后的和 textEdits 一样是一整个替换
    expect(edits.slice(0, 20).every((edit) => edit.insert === "改")).toBe(true);
    expect(edits.at(-1)).toEqual(coarse.at(-1));
  });

  it("随机改：打回去总能得到改后的正文，改动按位置排好、不叠、不落在代理对中间", () => {
    let seed = 11;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const chars = [..."的一是ab 😀😁\n"];
    const pick = () => chars[Math.floor(random() * chars.length)]!;
    const word = () => Array.from({ length: Math.floor(random() * 10) }, pick).join("");
    const mutate = (text: string) => {
      const points = Array.from(text);
      for (let edits = Math.floor(random() * 4); edits > 0; edits -= 1) {
        const at = Math.floor(random() * (points.length + 1));
        const remove = random() < 0.5 ? Math.floor(random() * 3) : 0;
        points.splice(at, remove, ...Array.from(word()));
      }
      return points.join("");
    };
    const inside = (text: string, at: number) =>
      at > 0 && at < text.length && /[\uDC00-\uDFFF]/.test(text[at]!);
    for (let round = 0; round < 2000; round += 1) {
      const before = Array.from({ length: Math.floor(random() * 6) }, word).join("\n");
      const after = mutate(before);
      const edits = fineEdits(before, after);
      expect(applyFine(before, after)).toBe(after);
      for (const [index, edit] of edits.entries()) {
        expect(edit.from).toBeLessThanOrEqual(edit.to);
        if (index > 0) expect(edit.from).toBeGreaterThanOrEqual(edits[index - 1]!.to);
        expect(inside(before, edit.from) || inside(before, edit.to)).toBe(false);
      }
    }
  });
});

describe("外部改动进会话", () => {
  it("防抖期间没存的会话改动和外部改动都留着", async () => {
    const { scheduler, host, guest } = room("第一行\n第二行\n第三行");
    const base = snapshot(host.session);
    // 存完之后会话里又改了（还没存）
    host.session.insertText(3, "（会话里加的）");
    // 外部程序拿着上次存的那一版改了第三行
    expect(mergeExternal(host.session, base, "第一行\n第二行\n第三行（外部改的）")).toBe(true);
    await scheduler.advance(50);
    const expected = "第一行（会话里加的）\n第二行\n第三行（外部改的）";
    expect(host.session.toString()).toBe(expected);
    // 访客那边也看到了外部改动
    expect(guest.session.toString()).toBe(expected);
  });

  it("同一行里各改各的位置：两边都在", async () => {
    const { scheduler, host } = room("今天开会，讨论协作。");
    const base = snapshot(host.session);
    host.session.insertText(2, "下午");
    mergeExternal(host.session, base, "今天开会，讨论协作和同步。");
    await scheduler.advance(20);
    expect(host.session.toString()).toBe("今天下午开会，讨论协作和同步。");
  });

  it("两处外部改动中间别人正在打字：打的字不会被卷进去", async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `行${index}`);
    const { scheduler, host, guest } = room(lines.join("\n"));
    await scheduler.advance(20);
    const base = snapshot(host.session);
    // 访客在第 15 行打字，主持人这边已经收到了
    const at = guest.session.toString().indexOf("行15") + 3;
    guest.session.insertText(at, "（访客）");
    await scheduler.advance(20);
    const disk = [...lines];
    disk[3] = "行3（外部）";
    disk[27] = "行27（外部）";
    mergeExternal(host.session, base, disk.join("\n"));
    await scheduler.advance(50);
    const text = host.session.toString();
    expect(text).toContain("行15（访客）");
    expect(text).toContain("行3（外部）");
    expect(text).toContain("行27（外部）");
    expect(guest.session.toString()).toBe(text);
  });

  it("磁盘上和上次存的一样（自己存回去的那一次）：什么都不做", async () => {
    const { scheduler, host } = room("正文");
    const sent: number[] = [];
    host.session.onChange(() => sent.push(1));
    const base = snapshot(host.session);
    expect(mergeExternal(host.session, base, "正文")).toBe(false);
    await scheduler.advance(20);
    expect(sent).toHaveLength(0);
  });

  it("留的状态和正文对不上：宁可不合", () => {
    const { host } = room("正文");
    const base = { ...snapshot(host.session), text: "别的" };
    expect(mergeExternal(host.session, base, "别的（改）")).toBe(false);
    expect(host.session.toString()).toBe("正文");
  });

  it("编辑器挂着：外部改动进来不算自己的撤销记录；组字期间先排队", async () => {
    const { scheduler, host } = room("甲\n乙");
    const view = mount(host.session);
    view.dispatch({ changes: { from: 1, insert: "一" }, userEvent: "input.type" });
    const base = snapshot(host.session);

    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    view.dispatch({ changes: { from: 2, insert: "e" }, userEvent: "input.type.compose" });
    mergeExternal(host.session, base, "甲一\n乙（外部）");
    await scheduler.advance(20);
    // 正在组字：外部改动还没进来
    expect(view.state.doc.toString()).toBe("甲一e\n乙");

    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    view.dispatch({ changes: { from: 2, to: 3, insert: "二" }, userEvent: "input.type.compose" });
    await scheduler.advance(20);
    expect(view.state.doc.toString()).toBe("甲一二\n乙（外部）");
    expect(host.session.toString()).toBe("甲一二\n乙（外部）");

    // 撤销只撤自己打的字，外部改动留着
    undo(view);
    undo(view);
    await scheduler.advance(20);
    expect(view.state.doc.toString()).toBe("甲\n乙（外部）");
  });
});
