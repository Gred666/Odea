// @vitest-environment happy-dom

import { useData } from "@/data/store";
import type { NoteSummary } from "@/data/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MockNet, createMockNet } from "./mockNet";
import { PIPE, decodeFrame, encodeFrame } from "./net";
import { resetRelaysForTest, useRelays } from "./relayStore";
import { endText, handleControl, linkKind, resetCollabForTest, useCollab } from "./store";

/* 协作的状态（store.ts）接模拟网络（mockNet.ts，和 Rust 说同一套帧）。
   真网络那一半在 src-tauri/src/collab/tests.rs 里用真的 iroh 端点测 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等到条件成立（最多 2 秒） */
async function until(what: string, check: () => boolean) {
  for (let waited = 0; waited < 2000; waited += 10) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error(`等不到：${what}`);
}

let net: MockNet;
let saved: { id: string; text: string }[];
let originalData: ReturnType<typeof useData.getState>;

beforeEach(() => {
  originalData = useData.getState();
  net = createMockNet({ speed: 0.002, bots: false });
  resetCollabForTest(net);
  saved = [];
  const note = { id: "n1", title: "周会" } as NoteSummary;
  useData.setState({
    notes: [note],
    bodies: { n1: "第一行\n第二行\n第三行" },
    externalRevisions: {},
    saveDocument: vi.fn(async (target, text) => {
      if (target.kind !== "note") return;
      saved.push({ id: target.id, text });
      useData.setState((state) => ({ bodies: { ...state.bodies, [target.id]: text } }));
    }),
    createNote: vi.fn(async () => "copy-1"),
    saveTitle: vi.fn(async () => {}),
  });
});

afterEach(async () => {
  await useCollab.getState().stop();
  resetCollabForTest(null);
  useData.setState(originalData, true);
});

describe("帧", () => {
  it("类型、成员号、哪一篇、内容来回一致", () => {
    const frame = encodeFrame(PIPE.cursor, 513, "周报-1", new Uint8Array([1, 2, 3]));
    const back = decodeFrame(frame.buffer as ArrayBuffer);
    expect(back).toMatchObject({ kind: PIPE.cursor, member: 513, doc: "周报-1" });
    expect([...back!.payload]).toEqual([1, 2, 3]);
    expect(decodeFrame(new Uint8Array([1]))).toBeNull();
    // 说文档 id 有 9 个字节，后面只有 2 个
    expect(decodeFrame(new Uint8Array([1, 0, 0, 9, 65, 66]))).toBeNull();
  });
});

describe("主持人", () => {
  it("开始、有人来、允许、对方打的字存进这篇、移出、停止", async () => {
    const store = useCollab.getState();
    await net.onControl(handleControl);
    await store.startHosting("n1", "周会");
    expect(useCollab.getState()).toMatchObject({ phase: "hosting", noteId: "n1" });
    expect(useCollab.getState().link).toMatch(/^odea:\/\/join\//);
    const session = useCollab.getState().session!;
    expect(session.toString()).toBe("第一行\n第二行\n第三行");

    await until("加入请求", () => useCollab.getState().requests.length === 1);
    expect(useCollab.getState().requests[0]).toMatchObject({ name: "Alex", invited: true });
    await useCollab.getState().answer(1, "edit");
    await until("两个人", () => useCollab.getState().members.length === 2);
    expect(useCollab.getState().requests).toHaveLength(0);
    // 对方同步到了整篇
    await until("对方拿到正文", () => net.remoteText() === session.toString());

    // 对方打字：主持人的会话里有了，400ms 后存进这篇笔记
    net.remoteType("（Alex 补充）", 3);
    await until("远端的字", () => session.toString().includes("（Alex 补充）"));
    await until("存盘", () => saved.some((item) => item.text.includes("（Alex 补充）")));
    expect(saved.at(-1)).toEqual({ id: "n1", text: "第一行（Alex 补充）\n第二行\n第三行" });

    // 主持人自己打字：对方也看到
    session.insertText(session.text.length, "\n主持人加的");
    await until("对方看到主持人的字", () => net.remoteText().endsWith("主持人加的"));

    await useCollab.getState().kick(1);
    expect(useCollab.getState().members).toHaveLength(1);

    expect(useCollab.getState().dialogOpen).toBe(true);
    await useCollab.getState().stop();
    expect(useCollab.getState().phase).toBe("idle");
    expect(useCollab.getState().session).toBeNull();
    // 对话框跟着关，不会变成「加入协作」那一页
    expect(useCollab.getState().dialogOpen).toBe(false);
  });

  it("协作中改名字：成员表里自己那一行跟着换", async () => {
    await net.onControl(handleControl);
    await useCollab.getState().startHosting("n1", "周会");
    await useCollab.getState().setName("另一台");
    await until("成员表换了", () =>
      useCollab.getState().members.some((member) => member.host && member.name === "另一台"),
    );
    expect(useCollab.getState().identity?.name).toBe("另一台");
  });

  it("记住的人下次进来不问，权限跟着改过的；移出了就忘掉", async () => {
    const store = () => useCollab.getState();
    const guest = () => store().members.find((member) => !member.host)!;
    await net.onControl(handleControl);
    await store().startHosting("n1", "周会");
    await until("加入请求", () => store().requests.length === 1);
    await store().answer(store().requests[0]!.request, "read");
    await until("进来了", () => store().members.length === 2);
    await store().remember(guest());
    expect(store().trusted).toEqual([{ id: guest().id, name: "Alex", permission: "read" }]);
    await store().setPermission(guest().member, "edit");
    expect(store().trusted[0]!.permission).toBe("edit");

    // 下一次主持：Alex 直接进来，不问，按记住的权限
    await store().stop();
    await store().startHosting("n1", "周会");
    await until("直接进来", () => store().members.length === 2);
    expect(store().requests).toHaveLength(0);
    expect(guest().permission).toBe("edit");
    expect(store().trusted).toHaveLength(1);

    // 移出：忘掉
    await store().kick(guest().member);
    expect(store().trusted).toEqual([]);
  });

  it("文件被别的程序改了：合进会话，不整篇替换，对方也看到", async () => {
    await net.onControl(handleControl);
    await useCollab.getState().startHosting("n1", "周会");
    const session = useCollab.getState().session!;
    await until("加入请求", () => useCollab.getState().requests.length === 1);
    await useCollab.getState().answer(1, "edit");
    await until("对方拿到正文", () => net.remoteText() === session.toString());

    // 会话里刚改了还没存（防抖期间），外部程序改了第三行
    session.insertText(3, "（没存的）");
    useData.setState((state) => ({
      bodies: { ...state.bodies, n1: "第一行\n第二行\n第三行（外部）" },
      externalRevisions: { ...state.externalRevisions, "note:n1": 1 },
    }));
    await until("合进来", () => session.toString().includes("（外部）"));
    expect(session.toString()).toBe("第一行（没存的）\n第二行\n第三行（外部）");
    await until("对方也看到", () => net.remoteText() === session.toString());
    await until("合完存盘", () => saved.at(-1)?.text === session.toString());
  });

  it("只读的人打的字不进来", async () => {
    await net.onControl(handleControl);
    await useCollab.getState().startHosting("n1", "周会");
    const session = useCollab.getState().session!;
    await until("加入请求", () => useCollab.getState().requests.length === 1);
    await useCollab.getState().answer(1, "read");
    await until("对方拿到正文", () => net.remoteText() === session.toString());
    net.remoteType("（偷偷改）");
    await sleep(80);
    expect(session.toString()).not.toContain("偷偷改");
  });

  it("拒绝：请求收起，没人进来", async () => {
    await net.onControl(handleControl);
    await useCollab.getState().startHosting("n1", "周会");
    await until("加入请求", () => useCollab.getState().requests.length === 1);
    await useCollab.getState().answer(1, null);
    await sleep(30);
    expect(useCollab.getState().requests).toHaveLength(0);
    expect(useCollab.getState().members).toHaveLength(1);
  });
});

describe("访客", () => {
  it("加入、等确认、进来以后显示共享的那篇、双向同步", async () => {
    await net.onControl(handleControl);
    const seen: string[] = [];
    const stopWatching = useCollab.subscribe((state) => {
      const current = state.status?.state;
      if (current && seen.at(-1) !== current) seen.push(current);
    });
    useCollab.getState().openDialog("odea://join/abcdefghijklmnop");
    await useCollab.getState().join(useCollab.getState().joinLink);
    expect(useCollab.getState().phase).toBe("joining");
    await until("进来了", () => useCollab.getState().phase === "guest");
    stopWatching();
    expect(seen).toEqual(["connecting", "waiting", "connected"]);
    expect(useCollab.getState()).toMatchObject({
      title: "周会记录",
      showShared: true,
      dialogOpen: false,
      permission: "edit",
    });
    const session = useCollab.getState().session!;
    await until("同步到主持人的正文", () => session.toString().startsWith("# 周会记录"));
    expect(useCollab.getState().members.map((member) => member.name)).toEqual(["林夕", "我"]);

    session.insertText(session.text.length, "访客写的");
    await until("主持人那边有了", () => net.remoteText().endsWith("访客写的"));
    net.remoteType("（林夕）");
    await until("主持人打的字", () => session.toString().includes("（林夕）"));
  });

  it("主持人停止了：那一篇留着，可以存一份到自己的笔记", async () => {
    await net.onControl(handleControl);
    await useCollab.getState().join("odea://join/abcdefghijklmnop");
    await until("进来了", () => useCollab.getState().phase === "guest");
    const session = useCollab.getState().session!;
    await until("同步到正文", () => session.toString().startsWith("# 周会记录"));
    // 正文里有一张主持人的图片，要到了；还有一张要不到的（主持人电脑上的绝对路径）
    session.insertText(session.text.length, "\n![](附件/图.png)\n![](C:/主持人/x.png)");
    await until("要到了图片", () => useCollab.getState().images?.resolve("附件/图.png") !== "");

    handleControl({ type: "status", status: { state: "ended", reason: { kind: "hostStopped" } } });
    expect(useCollab.getState().status).toEqual({
      state: "ended",
      reason: { kind: "hostStopped" },
    });
    expect(useCollab.getState().session).toBe(session);

    const id = await useCollab.getState().saveCopy();
    expect(id).toBe("copy-1");
    expect(useData.getState().saveTitle).toHaveBeenCalledWith(
      { kind: "note", id: "copy-1" },
      "周会记录",
    );
    // 要来的图片存进了自己的附件（浏览器预览里是 data: 地址），正文里换成新的；别的照原样
    const copy = saved.at(-1)!;
    expect(copy.id).toBe("copy-1");
    expect(copy.text).not.toContain("](附件/图.png)");
    expect(copy.text).toMatch(
      /!\[\]\(data:image\/[a-z+]+;base64,[^)]+\)\n!\[\]\(C:\/主持人\/x\.png\)$/,
    );
    expect(copy.text.split("\n![](")[0]).toBe(session.toString().split("\n![](")[0]);
    expect(useData.getState().error).toBeNull();
  });

  it("上一次做客结束了：「加入协作…」打开的是加入那一页，不是那次结束的样子", async () => {
    await net.onControl(handleControl);
    await useCollab.getState().join("odea://join/abcdefghijklmnop");
    await until("进来了", () => useCollab.getState().phase === "guest");
    handleControl({ type: "status", status: { state: "ended", reason: { kind: "hostStopped" } } });
    // 点协作标签（不带链接）：还是那次结束的样子，可以存一份
    useCollab.getState().openDialog();
    expect(useCollab.getState().phase).toBe("guest");
    useCollab.getState().closeDialog();
    // 命令面板「加入协作…」：收掉那一次，打开加入
    useCollab.getState().openDialog("");
    await until(
      "回到加入那一页",
      () => useCollab.getState().phase === "idle" && useCollab.getState().dialogOpen,
    );
    expect(useCollab.getState().session).toBeNull();
  });

  it("认不出的链接当场说清楚，不去连", async () => {
    await useCollab.getState().join("https://example.com/x");
    expect(useCollab.getState().phase).toBe("idle");
    expect(useCollab.getState().error).toBe("这不是 Odea 的协作链接");
  });

  it("没进去就被拒：对话框里说为什么", async () => {
    await net.onControl(handleControl);
    await useCollab.getState().join("odea://join/abcdefghijklmnop");
    handleControl({
      type: "status",
      status: { state: "ended", reason: { kind: "rejected", reason: "declined" } },
    });
    expect(useCollab.getState().error).toBe("主持人没有同意你加入");
  });
});

describe("互联网上（P10.2）", () => {
  it("主持人：分享前自检报出来，链接跟着它更新", async () => {
    await net.onControl(handleControl);
    await useCollab.getState().startHosting("n1", "周会");
    await until("自检有结果", () => useCollab.getState().reach?.checking === false);
    const { reach, link } = useCollab.getState();
    expect(reach?.lan).toEqual(["192.168.1.23"]);
    expect(link).toMatch(/^odea:\/\/join\//);
  });

  it("主持人：打开访客发来的回连链接，拨通了照样先问", async () => {
    await net.onControl(handleControl);
    await useCollab.getState().startHosting("n1", "周会");
    await until("Alex 的请求", () => useCollab.getState().requests.length === 1);
    await useCollab.getState().answer(1, null);

    useCollab.getState().openLink("<odea://back/mockeeeeffffgggghhhh>");
    expect(useCollab.getState().dialBack).toEqual({ state: "dialing", detail: null });
    await until("拨通", () => useCollab.getState().dialBack?.state === "ok");
    await until("Sam 的请求", () => useCollab.getState().requests.length === 1);
    expect(useCollab.getState().requests[0]).toMatchObject({ name: "Sam", invited: true });
    await useCollab.getState().answer(2, "edit");
    await until("两个人", () => useCollab.getState().members.length === 2);
  });

  it("没在主持时点了回连链接：说清楚要怎么用", () => {
    useCollab.getState().openLink("odea://back/mockeeeeffffgggghhhh");
    expect(useCollab.getState()).toMatchObject({ dialogOpen: true, phase: "idle" });
    expect(useCollab.getState().error).toContain("要在主持协作时打开");
  });

  it("粘错了链接：回连链接、中继码不当邀请链接去连", async () => {
    await useCollab.getState().join("odea://back/mockeeeeffffgggghhhh");
    expect(useCollab.getState().error).toContain("回连链接");
    await useCollab.getState().join("odea://relay/mockaaaabbbbcccc");
    expect(useCollab.getState().error).toContain("中继码");
    expect(useCollab.getState().phase).toBe("idle");
  });

  it("访客：链接带着主持人的中继，加入前说一声，可以只直连", async () => {
    const join = vi.spyOn(net, "join");
    await net.onControl(handleControl);
    useCollab.getState().openDialog("odea://join/relayaaaabbbbccccdddd");
    await until("看出带着中继", () => useCollab.getState().joinRelay === "relay.example.com");
    useCollab.getState().setDirectOnly(true);
    await useCollab.getState().join(useCollab.getState().joinLink);
    expect(join).toHaveBeenCalledWith("odea://join/relayaaaabbbbccccdddd", true);
    // 换一个不带中继的链接：提示收起
    await useCollab.getState().stop();
    useCollab.getState().setJoinLink("odea://join/plainaaaabbbbccccdddd");
    await sleep(20);
    expect(useCollab.getState().joinRelay).toBeNull();
  });

  it("访客：连不上先给结论，生成回连链接，主持人拨过来以后进去", async () => {
    await net.onControl(handleControl);
    await useCollab.getState().join("odea://join/faraaaabbbbccccdddd");
    await until("连不上的结论", () => useCollab.getState().status?.state === "unreachable");
    expect(useCollab.getState().phase).toBe("joining");
    const status = useCollab.getState().status;
    expect(status?.state === "unreachable" && status.diagnosis.cause).toEqual({
      kind: "differentNetwork",
    });

    await useCollab.getState().makeCallback();
    expect(useCollab.getState().callback?.link).toMatch(/^odea:\/\/back\//);
    expect(useCollab.getState().callback?.reach.ipv6).toEqual(["2408:8207:1234::5"]);
    await until("主持人拨过来、进去了", () => useCollab.getState().phase === "guest");
    expect(useCollab.getState().relayed).toBe(false);
  });
});

describe("协作中继", () => {
  beforeEach(() => resetRelaysForTest(net));
  afterEach(() => resetRelaysForTest(null));

  it("中继码先确认再添加；测试、复制中继码、删除", async () => {
    const relays = useRelays.getState();
    relays.openRelays("odea://relay/mockaaaabbbbccccdddd");
    await until("等确认", () => useRelays.getState().pending !== null);
    expect(useRelays.getState().pending?.info.host).toBe("relay.example.com");
    // 确认之前一台都没加
    expect(useRelays.getState().relays).toEqual([]);
    await useRelays.getState().confirmPending();
    expect(useRelays.getState().relays.map((relay) => relay.host)).toEqual(["relay.example.com"]);
    expect(useRelays.getState().pending).toBeNull();

    const url = useRelays.getState().relays[0]!.url;
    const testing = useRelays.getState().test(url);
    expect(useRelays.getState().checks[url]).toBe("testing");
    await testing;
    expect(useRelays.getState().checks[url]).toMatchObject({ connected: true, latencyMs: 38 });
    expect(await useRelays.getState().code(url)).toMatch(/^odea:\/\/relay\//);

    await useRelays.getState().remove(url);
    expect(useRelays.getState().relays).toEqual([]);
    expect(useRelays.getState().checks[url]).toBeUndefined();
  });

  it("手填地址：不是中继码的当地址；地址不对说清楚；令牌被拒测得出来", async () => {
    expect(await useRelays.getState().inspect("relay.example.com")).toBe(false);
    expect(await useRelays.getState().addManual({ url: "http://x.example.com" })).toBe(false);
    expect(useRelays.getState().error).toContain("https://");
    expect(
      await useRelays.getState().addManual({ url: "bad.example.com", token: "t", name: "坏的" }),
    ).toBe(true);
    const relay = useRelays.getState().relays[0]!;
    expect(relay).toMatchObject({ host: "bad.example.com", name: "坏的", hasToken: true });
    await useRelays.getState().test(relay.url);
    expect(useRelays.getState().checks[relay.url]).toMatchObject({
      connected: false,
      denied: "token rejected",
    });
  });

  it("点开的中继码链接也走确认", async () => {
    useCollab.getState().openLink("odea://relay/mockaaaabbbbccccdddd");
    await until("中继对话框打开、等确认", () => useRelays.getState().pending !== null);
    expect(useRelays.getState().open).toBe(true);
  });
});

describe("链接的种类", () => {
  it("认得出三种，只粘票据的当邀请链接", () => {
    expect(linkKind(" <odea://join/abcdefghijklmnopqrst> ")).toBe("join");
    expect(linkKind("ODEA://BACK/abcdefgh")).toBe("back");
    expect(linkKind("odea://relay/abcdefgh")).toBe("relay");
    expect(linkKind("abcdefghijklmnopqrst")).toBe("join");
    expect(linkKind("https://example.com")).toBeNull();
  });
});

describe("P10.1 的遗留", () => {
  it("附近：开着加入表单时有列表，点一个不用链接就进去", async () => {
    await net.onControl(handleControl);
    const start = vi.spyOn(net, "nearbyStart");
    const stopScan = vi.spyOn(net, "nearbyStop");
    useCollab.getState().startNearby();
    expect(useCollab.getState().nearby).toEqual([]);
    await until("列表", () => (useCollab.getState().nearby?.length ?? 0) === 2);
    expect(start).toHaveBeenCalledTimes(1);
    expect(useCollab.getState().nearby?.map((host) => host.name)).toEqual(["林夕", "Sam"]);
    await useCollab.getState().joinNearby("mock-linxi");
    // 加入时列表收起（Rust 那边顺手把端点关了，这边不再多关一次）
    expect(useCollab.getState().nearby).toBeNull();
    expect(stopScan).not.toHaveBeenCalled();
    await until("进来了", () => useCollab.getState().phase === "guest");
    // 关了以后晚到的列表不收
    handleControl({ type: "nearby", hosts: [{ id: "x", name: "晚到的" }] });
    expect(useCollab.getState().nearby).toBeNull();
  });

  it("落盘：主持时定时交状态；崩了重启以后「继续协作」，正文接着上次的，磁盘上后来的改动合进来", async () => {
    await net.onControl(handleControl);
    const save = vi.spyOn(net, "saveState");
    await useCollab.getState().startHosting("n1", "周会");
    // 一开始就落一次
    expect(save).toHaveBeenCalled();
    const session = useCollab.getState().session!;
    session.insertText(session.text.length, "\n第四行");
    await until("存盘时连状态一起落", () => saved.some((item) => item.text.endsWith("第四行")));
    await until("交了状态", () => save.mock.calls.length >= 2);

    // 崩了：会话没了，落盘的留着；崩之前的最后几百毫秒，磁盘上又多了一行
    net.simulateCrash();
    resetCollabForTest(net);
    useData.setState((state) => ({
      bodies: { ...state.bodies, n1: "第一行\n第二行\n第三行\n第四行\n磁盘上后来的" },
    }));
    const resume = await net.resumeInfo();
    expect(resume.host).toMatchObject({ note: "n1", title: "周会" });
    useCollab.setState({ resume });
    const host = vi.spyOn(net, "host");
    await useCollab.getState().resumeHost();
    expect(useCollab.getState().phase).toBe("hosting");
    expect(useCollab.getState().resume).toBeNull();
    // 用同一个会话重新起来
    expect(host).toHaveBeenCalledWith(
      "周会",
      "edit",
      "n1",
      { kind: "doc", doc: "n1", name: "周会" },
      true,
    );
    expect(useCollab.getState().session!.toString()).toBe(
      "第一行\n第二行\n第三行\n第四行\n磁盘上后来的",
    );
  });

  it("落盘：不接着来了就删掉", async () => {
    await net.onControl(handleControl);
    await useCollab.getState().join("odea://join/abcdefghijklmnop");
    await until("进来了", () => useCollab.getState().phase === "guest");
    net.simulateCrash();
    resetCollabForTest(net);
    const resume = await net.resumeInfo();
    expect(resume.guest).toMatchObject({ hostName: "林夕" });
    useCollab.setState({ resume });
    const discard = vi.spyOn(net, "discardResume");
    await useCollab.getState().discardResume(false);
    expect(discard).toHaveBeenCalledWith(false);
    expect(useCollab.getState().resume).toBeNull();
    expect((await net.resumeInfo()).guest).toBeNull();
  });

  it("落盘：访客「重新加入」用上次的状态建会话", async () => {
    await net.onControl(handleControl);
    await useCollab.getState().join("odea://join/abcdefghijklmnop");
    await until("进来了", () => useCollab.getState().phase === "guest");
    const session = useCollab.getState().session!;
    await until("同步到正文", () => session.toString().startsWith("# 周会记录"));
    session.insertText(session.text.length, "访客断线前写的");
    // 落盘是停下两秒后：等不了那么久，直接交一份
    net.saveState("mock-doc", session.encodeState());
    net.simulateCrash();
    resetCollabForTest(net);
    useCollab.setState({ resume: await net.resumeInfo() });
    const rejoin = vi.spyOn(net, "rejoin");
    await useCollab.getState().resumeGuest();
    expect(rejoin).toHaveBeenCalledTimes(1);
    // 会话一建好就有上次写的（还没连上主持人）
    expect(useCollab.getState().session!.toString()).toContain("访客断线前写的");
    await until("又进来了", () => useCollab.getState().phase === "guest");
  });

  it("附件：主持人把正文里引用的图片交给 Rust，正文变了换一份", async () => {
    useData.setState({
      notes: [{ id: "n1", title: "周会", relPath: "笔记/工作/周会.md" } as NoteSummary],
      bodies: { n1: "![](../../附件/a.png) ![](https://x/y.png)" },
    });
    await net.onControl(handleControl);
    await useCollab.getState().startHosting("n1", "周会");
    await until("引用表", () => net.attachmentRefs().length === 1);
    expect(net.attachmentRefs()).toEqual([{ path: "../../附件/a.png", vaultPath: "附件/a.png" }]);
    const session = useCollab.getState().session!;
    session.insertText(
      session.text.length,
      '\n<img src="../../附件/b.gif"> ![](../../../越界.png)',
    );
    await until("新的引用表", () => net.attachmentRefs().length === 2);
    // 退到仓库外面的不进表
    expect(net.attachmentRefs().map((ref) => ref.vaultPath)).toEqual(["附件/a.png", "附件/b.gif"]);
  });

  it("附件：访客那边正文里的图片向主持人要；粘贴的交给主持人存", async () => {
    await net.onControl(handleControl);
    await useCollab.getState().join("odea://join/abcdefghijklmnop");
    await until("进来了", () => useCollab.getState().phase === "guest");
    const before = useCollab.getState().images!;
    expect(before.resolve("附件/图.png")).toBe("");
    net.remoteType("\n![](附件/图.png)");
    await until("要到了", () => useCollab.getState().images?.resolve("附件/图.png") !== "");
    expect(useCollab.getState().images).not.toBe(before);
    expect(useCollab.getState().images!.resolve("附件/图.png")).toMatch(/^data:image\/svg\+xml/);

    const file = new File([new Uint8Array([1, 2, 3])], "截图.png", { type: "image/png" });
    const put = vi.spyOn(net, "putAttachment");
    const attached = await useCollab.getState().attachFiles([file]);
    expect(attached).toEqual([{ link: "附件/截图.png", name: "截图.png", isImage: true }]);
    expect(put).toHaveBeenCalledWith("mock-doc", "截图.png", "AQID");
  });
});

describe("结束原因的说法", () => {
  it("每一种都是一句人话", () => {
    expect(endText({ kind: "hostStopped" }, "林夕")).toBe("林夕停止了协作，这篇不会再更新");
    expect(endText({ kind: "rejected", reason: "badInvite" })).toContain("链接已经失效");
    expect(endText({ kind: "rejected", reason: { version: { theirs: 2 } } })).toContain("版本");
    // 版本对不上：说清楚是谁的旧
    expect(endText({ kind: "outdated", hostOlder: true }, "林夕")).toBe(
      "林夕的 Odea 比你的旧，连不上：让对方升级到最新再试",
    );
    expect(endText({ kind: "outdated", hostOlder: false }, "林夕")).toBe(
      "你的 Odea 比林夕的旧，连不上：升级到最新再试",
    );
    expect(endText({ kind: "dropped" }, "林夕")).toContain("林夕那边就断开了");
  });
});

describe("一条连接里好几篇（设计 §22.5）", () => {
  it("主持一个文件夹：树里只有文件夹里的，访客要开哪篇才建哪篇的会话，文件夹外的不给", async () => {
    useData.setState({
      notes: [
        { id: "n1", title: "周会", relPath: "笔记/项目/周会.md" } as NoteSummary,
        { id: "n2", title: "日记草稿", relPath: "笔记/私事/草稿.md" } as NoteSummary,
      ],
      bodies: { n1: "第一行\n第二行", n2: "不给别人看" },
    });
    const setTree = vi.spyOn(net, "setTree");
    const answerDoc = vi.spyOn(net, "answerDoc");
    await net.onControl(handleControl);
    await useCollab.getState().startHostingScope({ kind: "folder", folder: "项目", name: "项目" });
    expect(useCollab.getState()).toMatchObject({
      phase: "hosting",
      noteId: null,
      scope: { kind: "folder", doc: "项目" },
    });
    // 树：只有「项目」里的那篇
    const tree = JSON.parse(setTree.mock.calls.at(-1)![0]);
    expect(tree.docs).toEqual([{ id: "n1", title: "周会", folder: "" }]);
    // 还没人要：一篇会话都没有
    expect(useCollab.getState().hostedDocs).toEqual({});

    await until("加入请求", () => useCollab.getState().requests.length === 1);
    await useCollab.getState().answer(1, "edit");
    // Alex 要开树里的第一篇：给了，建起这一篇的会话
    await until("建了 n1 的会话", () => !!useCollab.getState().hostedDocs.n1);
    expect(answerDoc).toHaveBeenCalledWith(100, null);
    await until("对方同步到", () => net.remoteText() === "第一行\n第二行");
    net.remoteType("（Alex 写的）");
    await until("存进 n1", () =>
      saved.some((item) => item.id === "n1" && item.text.includes("Alex 写的")),
    );

    // 文件夹外的：不给，说为什么
    handleControl({ type: "docOpen", request: 777, member: 1, doc: "n2" });
    await until("回了不给", () => answerDoc.mock.calls.some((call) => call[0] === 777));
    expect(answerDoc).toHaveBeenCalledWith(777, "这一篇不在共享的文件夹里");
    expect(useCollab.getState().hostedDocs.n2).toBeUndefined();
  });

  it("进一个文件夹：拿到树，开哪篇显示哪篇，新建的打开它，开不了的说为什么", async () => {
    await net.onControl(handleControl);
    await useCollab.getState().join("odea://join/folderabcdefghijklmn");
    await until("进来了", () => useCollab.getState().phase === "guest");
    const state = useCollab.getState();
    expect(state.scope).toMatchObject({ kind: "folder", name: "项目" });
    expect(state.tree?.docs.map((doc) => doc.title)).toEqual(["周会记录", "下季度计划"]);
    // 文件夹的范围：对话框留着挑一篇，正文区还没有
    expect(state.current).toBeNull();

    await useCollab.getState().openShared("mock-plan");
    await until("同步到计划", () =>
      (useCollab.getState().session?.toString() ?? "").startsWith("# 下季度计划"),
    );
    expect(useCollab.getState()).toMatchObject({
      current: "mock-plan",
      title: "下季度计划",
      showShared: true,
    });
    await useCollab.getState().openShared("mock-weekly");
    await until("换成周会", () =>
      (useCollab.getState().session?.toString() ?? "").startsWith("# 周会记录"),
    );
    expect(useCollab.getState().openDocs).toEqual(["mock-plan", "mock-weekly"]);

    // 关掉正在看的：换到还开着的那一篇
    await useCollab.getState().closeShared("mock-weekly");
    expect(useCollab.getState()).toMatchObject({ current: "mock-plan", openDocs: ["mock-plan"] });

    // 新建：主持人那边建好，树上有了，打开它
    await useCollab.getState().createShared("计划", "复盘");
    await until("开着新的", () => useCollab.getState().current === "mock-new-3");
    expect(useCollab.getState().tree?.docs.some((doc) => doc.title === "复盘")).toBe(true);

    // 主持人不给的
    await useCollab.getState().openShared("nope");
    await until("说为什么", () => !!useCollab.getState().error);
    expect(useCollab.getState().error).toContain("不在共享的文件夹里");
    expect(useCollab.getState().openDocs).not.toContain("nope");
  });
});
