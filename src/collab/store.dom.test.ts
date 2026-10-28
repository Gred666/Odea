// @vitest-environment happy-dom

import { useData } from "@/data/store";
import type { NoteSummary } from "@/data/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MockNet, createMockNet } from "./mockNet";
import { PIPE, decodeFrame, encodeFrame } from "./net";
import { resetRelaysForTest, useRelays } from "./relayStore";
import {
  type CollabSessionState,
  endText,
  handleControl,
  linkKind,
  overlapOf,
  resetCollabForTest,
  useCollab,
} from "./store";

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

const store = () => useCollab.getState();
/** 最近开始的那个会话 */
function latest(): CollabSessionState | undefined {
  const { order, sessions } = store();
  const id = order.at(-1);
  return id === undefined ? undefined : sessions[id];
}
/** 最近开始的那个会话（一定有） */
const one = () => latest()!;
/** 最近开始的那个会话在哪一步；一个都没有是 idle */
const phase = () => latest()?.phase ?? "idle";
/** 这个会话现在的样子 */
const sessionOf = (id: number) => store().sessions[id]!;

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
  for (const id of [...store().order]) await store().stop(id);
  resetCollabForTest(null);
  useData.setState(originalData, true);
});

describe("帧", () => {
  it("类型、会话号、成员号、哪一篇、内容来回一致", () => {
    const frame = encodeFrame(PIPE.cursor, 7, 513, "周报-1", new Uint8Array([1, 2, 3]));
    const back = decodeFrame(frame.buffer as ArrayBuffer);
    expect(back).toMatchObject({ kind: PIPE.cursor, session: 7, member: 513, doc: "周报-1" });
    expect([...back!.payload]).toEqual([1, 2, 3]);
    expect(decodeFrame(new Uint8Array([1]))).toBeNull();
    // 说文档 id 有 9 个字节，后面只有 2 个
    expect(decodeFrame(new Uint8Array([1, 0, 0, 0, 0, 9, 65, 66]))).toBeNull();
  });
});

describe("主持人", () => {
  it("开始、有人来、允许、对方打的字存进这篇、移出、停止", async () => {
    await net.onControl(handleControl);
    await store().startHosting("n1", "周会");
    expect(one()).toMatchObject({ phase: "hosting", role: "host", noteId: "n1" });
    expect(one().link).toMatch(/^odea:\/\/join\//);
    const id = one().id;
    const session = store().hostedDocs.n1!;
    expect(store().hostedIn.n1).toBe(id);
    expect(session.toString()).toBe("第一行\n第二行\n第三行");

    await until("加入请求", () => one().requests.length === 1);
    expect(one().requests[0]).toMatchObject({ name: "Alex", invited: true });
    await store().answer(id, 1, "edit");
    await until("两个人", () => one().members.length === 2);
    expect(one().requests).toHaveLength(0);
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

    await store().kick(id, 1);
    expect(one().members).toHaveLength(1);

    expect(store().dialogOpen).toBe(true);
    await store().stop(id);
    expect(phase()).toBe("idle");
    expect(store().hostedDocs).toEqual({});
    // 对话框跟着关，不会变成「加入协作」那一页
    expect(store().dialogOpen).toBe(false);
  });

  it("协作中改名字：成员表里自己那一行跟着换", async () => {
    await net.onControl(handleControl);
    await store().startHosting("n1", "周会");
    await store().setName("另一台");
    await until("成员表换了", () =>
      one().members.some((member) => member.host && member.name === "另一台"),
    );
    expect(store().identity?.name).toBe("另一台");
  });

  it("记住的人下次进来不问，权限跟着改过的；移出了就忘掉", async () => {
    const guest = () => one().members.find((member) => !member.host)!;
    await net.onControl(handleControl);
    await store().startHosting("n1", "周会");
    await until("加入请求", () => one().requests.length === 1);
    await store().answer(one().id, one().requests[0]!.request, "read");
    await until("进来了", () => one().members.length === 2);
    await store().remember(guest());
    expect(store().trusted).toEqual([{ id: guest().id, name: "Alex", permission: "read" }]);
    await store().setPermission(one().id, guest().member, "edit");
    expect(store().trusted[0]!.permission).toBe("edit");

    // 下一次主持：Alex 直接进来，不问，按记住的权限
    await store().stop(one().id);
    await store().startHosting("n1", "周会");
    await until("直接进来", () => one().members.length === 2);
    expect(one().requests).toHaveLength(0);
    expect(guest().permission).toBe("edit");
    expect(store().trusted).toHaveLength(1);

    // 移出：忘掉
    await store().kick(one().id, guest().member);
    expect(store().trusted).toEqual([]);
  });

  it("文件被别的程序改了：合进会话，不整篇替换，对方也看到", async () => {
    await net.onControl(handleControl);
    await store().startHosting("n1", "周会");
    const session = store().hostedDocs.n1!;
    await until("加入请求", () => one().requests.length === 1);
    await store().answer(one().id, 1, "edit");
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
    await store().startHosting("n1", "周会");
    const session = store().hostedDocs.n1!;
    await until("加入请求", () => one().requests.length === 1);
    await store().answer(one().id, 1, "read");
    await until("对方拿到正文", () => net.remoteText() === session.toString());
    net.remoteType("（偷偷改）");
    await sleep(80);
    expect(session.toString()).not.toContain("偷偷改");
  });

  it("拒绝：请求收起，没人进来", async () => {
    await net.onControl(handleControl);
    await store().startHosting("n1", "周会");
    await until("加入请求", () => one().requests.length === 1);
    await store().answer(one().id, 1, null);
    await sleep(30);
    expect(one().requests).toHaveLength(0);
    expect(one().members).toHaveLength(1);
  });
});

describe("访客", () => {
  it("加入、等确认、进来以后显示共享的那篇、双向同步", async () => {
    await net.onControl(handleControl);
    const seen: string[] = [];
    const stopWatching = useCollab.subscribe(() => {
      const current = latest()?.status?.state;
      if (current && seen.at(-1) !== current) seen.push(current);
    });
    store().openDialog("odea://join/abcdefghijklmnop");
    await store().join(store().joinLink);
    expect(phase()).toBe("joining");
    await until("进来了", () => phase() === "guest");
    stopWatching();
    expect(seen).toEqual(["connecting", "waiting", "connected"]);
    expect(one()).toMatchObject({ title: "周会记录", permission: "edit", role: "guest" });
    expect(store()).toMatchObject({ showShared: true, dialogOpen: false, shownSession: one().id });
    await until("会话接上", () => !!store().session);
    const session = store().session!;
    await until("同步到主持人的正文", () => session.toString().startsWith("# 周会记录"));
    expect(one().members.map((member) => member.name)).toEqual(["林夕", "我"]);

    session.insertText(session.text.length, "访客写的");
    await until("主持人那边有了", () => net.remoteText().endsWith("访客写的"));
    net.remoteType("（林夕）");
    await until("主持人打的字", () => session.toString().includes("（林夕）"));
  });

  it("主持人停止了：那一篇留着，可以存一份到自己的笔记", async () => {
    await net.onControl(handleControl);
    await store().join("odea://join/abcdefghijklmnop");
    await until("进来了", () => phase() === "guest" && !!store().session);
    const session = store().session!;
    await until("同步到正文", () => session.toString().startsWith("# 周会记录"));
    // 正文里有一张主持人的图片，要到了；还有一张要不到的（主持人电脑上的绝对路径）
    session.insertText(session.text.length, "\n![](附件/图.png)\n![](C:/主持人/x.png)");
    await until("要到了图片", () => store().images?.resolve("附件/图.png") !== "");

    const id = one().id;
    handleControl(id, {
      type: "status",
      status: { state: "ended", reason: { kind: "hostStopped" } },
    });
    expect(one().status).toEqual({ state: "ended", reason: { kind: "hostStopped" } });
    expect(store().session).toBe(session);

    const copied = await store().saveCopy();
    expect(copied).toBe("copy-1");
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

  it("上一次做客结束了：「加入协作…」打开的是加入那一页，结束的那次还在会话条里", async () => {
    await net.onControl(handleControl);
    await store().join("odea://join/abcdefghijklmnop");
    await until("进来了", () => phase() === "guest");
    const id = one().id;
    handleControl(id, {
      type: "status",
      status: { state: "ended", reason: { kind: "hostStopped" } },
    });
    // 点协作标签（不带链接）：还是那次结束的样子，可以存一份
    store().openDialog();
    expect(store().focus).toBe(id);
    store().closeDialog();
    // 命令面板「加入协作…」：加入那一页；结束的那一次留着（还能存一份），关掉它才没
    store().openDialog("");
    expect(store()).toMatchObject({ dialogOpen: true, focus: null });
    expect(store().order).toEqual([id]);
  });

  it("认不出的链接当场说清楚，不去连", async () => {
    await store().join("https://example.com/x");
    expect(phase()).toBe("idle");
    expect(store().error).toBe("这不是 Odea 的协作链接");
  });

  it("没进去就被拒：对话框里说为什么", async () => {
    await net.onControl(handleControl);
    await store().join("odea://join/abcdefghijklmnop");
    handleControl(one().id, {
      type: "status",
      status: { state: "ended", reason: { kind: "rejected", reason: "declined" } },
    });
    expect(store().error).toBe("主持人没有同意你加入");
  });
});

describe("互联网上（P10.2）", () => {
  it("主持人：分享前自检报出来，链接跟着它更新", async () => {
    await net.onControl(handleControl);
    await store().startHosting("n1", "周会");
    await until("自检有结果", () => one().reach?.checking === false);
    const { reach, link } = one();
    expect(reach?.lan).toEqual(["192.168.1.23"]);
    expect(link).toMatch(/^odea:\/\/join\//);
  });

  it("主持人：打开访客发来的回连链接，拨通了照样先问", async () => {
    await net.onControl(handleControl);
    await store().startHosting("n1", "周会");
    const id = one().id;
    await until("Alex 的请求", () => one().requests.length === 1);
    await store().answer(id, 1, null);

    store().openLink("<odea://back/mockeeeeffffgggghhhh>");
    await until("在拨", () => sessionOf(id).dialBack !== null);
    expect(store().focus).toBe(id);
    await until("拨通", () => sessionOf(id).dialBack?.state === "ok");
    await until("Sam 的请求", () => one().requests.length === 1);
    expect(one().requests[0]).toMatchObject({ name: "Sam", invited: true });
    await store().answer(id, 2, "edit");
    await until("两个人", () => one().members.length === 2);
  });

  it("没在主持时点了回连链接：说清楚要怎么用", () => {
    store().openLink("odea://back/mockeeeeffffgggghhhh");
    expect(store()).toMatchObject({ dialogOpen: true, focus: null });
    expect(store().error).toContain("要在主持协作时打开");
  });

  it("粘错了链接：回连链接、中继码不当邀请链接去连", async () => {
    await store().join("odea://back/mockeeeeffffgggghhhh");
    expect(store().error).toContain("回连链接");
    await store().join("odea://relay/mockaaaabbbbcccc");
    expect(store().error).toContain("中继码");
    expect(phase()).toBe("idle");
  });

  it("访客：链接带着主持人的中继，加入前说一声，可以只直连", async () => {
    const join = vi.spyOn(net, "join");
    await net.onControl(handleControl);
    store().openDialog("odea://join/relayaaaabbbbccccdddd");
    await until("看出带着中继", () => store().joinRelay === "relay.example.com");
    store().setDirectOnly(true);
    await store().join(store().joinLink);
    expect(join).toHaveBeenCalledWith(
      expect.any(Number),
      "odea://join/relayaaaabbbbccccdddd",
      true,
    );
    // 换一个不带中继的链接：提示收起
    store().setJoinLink("odea://join/plainaaaabbbbccccdddd");
    await sleep(20);
    expect(store().joinRelay).toBeNull();
  });

  it("访客：连不上先给结论，生成回连链接，主持人拨过来以后进去", async () => {
    await net.onControl(handleControl);
    await store().join("odea://join/faraaaabbbbccccdddd");
    await until("连不上的结论", () => one().status?.state === "unreachable");
    expect(phase()).toBe("joining");
    const status = one().status;
    expect(status?.state === "unreachable" && status.diagnosis.cause).toEqual({
      kind: "differentNetwork",
    });

    await store().makeCallback(one().id);
    expect(one().callback?.link).toMatch(/^odea:\/\/back\//);
    expect(one().callback?.reach.ipv6).toEqual(["2408:8207:1234::5"]);
    await until("主持人拨过来、进去了", () => phase() === "guest");
    expect(one().relayed).toBe(false);
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
    store().openLink("odea://relay/mockaaaabbbbccccdddd");
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
    store().startNearby();
    expect(store().nearby).toEqual([]);
    await until("列表", () => (store().nearby?.length ?? 0) === 2);
    expect(start).toHaveBeenCalledTimes(1);
    expect(store().nearby?.map((host) => host.name)).toEqual(["林夕", "Sam"]);
    await store().joinNearby("mock-linxi");
    // 加入时列表收起（Rust 那边顺手把端点关了，这边不再多关一次）
    expect(store().nearby).toBeNull();
    expect(stopScan).not.toHaveBeenCalled();
    await until("进来了", () => phase() === "guest");
    // 关了以后晚到的列表不收
    handleControl(null, { type: "nearby", hosts: [{ id: "x", name: "晚到的" }] });
    expect(store().nearby).toBeNull();
  });

  it("落盘：主持时定时交状态；崩了重启以后「继续协作」，正文接着上次的，磁盘上后来的改动合进来", async () => {
    await net.onControl(handleControl);
    const save = vi.spyOn(net, "saveState");
    await store().startHosting("n1", "周会");
    // 一开始就落一次
    expect(save).toHaveBeenCalled();
    const session = store().hostedDocs.n1!;
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
    expect(resume.hosts).toHaveLength(1);
    expect(resume.hosts[0]).toMatchObject({ note: "n1", title: "周会" });
    const key = resume.hosts[0]!.key;
    useCollab.setState({ resume });
    const host = vi.spyOn(net, "host");
    await store().resumeHost(key);
    expect(phase()).toBe("hosting");
    expect(store().resume).toBeNull();
    // 用同一个会话重新起来
    expect(host).toHaveBeenCalledWith(
      one().id,
      "周会",
      "edit",
      "n1",
      { kind: "doc", doc: "n1", name: "周会" },
      key,
    );
    expect(store().hostedDocs.n1!.toString()).toBe("第一行\n第二行\n第三行\n第四行\n磁盘上后来的");
  });

  it("落盘：不接着来了就删掉", async () => {
    await net.onControl(handleControl);
    await store().join("odea://join/abcdefghijklmnop");
    await until("进来了", () => phase() === "guest");
    net.simulateCrash();
    resetCollabForTest(net);
    const resume = await net.resumeInfo();
    expect(resume.guests[0]).toMatchObject({ hostName: "林夕" });
    const key = resume.guests[0]!.key;
    useCollab.setState({ resume });
    const discard = vi.spyOn(net, "discardResume");
    await store().discardResume(false, key);
    expect(discard).toHaveBeenCalledWith(false, key);
    expect(store().resume).toBeNull();
    expect((await net.resumeInfo()).guests).toEqual([]);
  });

  it("落盘：访客「重新加入」用上次的状态建会话", async () => {
    await net.onControl(handleControl);
    await store().join("odea://join/abcdefghijklmnop");
    await until("进来了", () => phase() === "guest" && !!store().session);
    const session = store().session!;
    await until("同步到正文", () => session.toString().startsWith("# 周会记录"));
    session.insertText(session.text.length, "访客断线前写的");
    // 落盘是停下两秒后：等不了那么久，直接交一份
    net.saveState(one().id, "mock-doc", session.encodeState());
    net.simulateCrash();
    resetCollabForTest(net);
    const resume = await net.resumeInfo();
    useCollab.setState({ resume });
    const rejoin = vi.spyOn(net, "rejoin");
    await store().resumeGuest(resume.guests[0]!.key);
    expect(rejoin).toHaveBeenCalledTimes(1);
    // 会话一建好就有上次写的（还没连上主持人）
    expect(store().session!.toString()).toContain("访客断线前写的");
    await until("又进来了", () => phase() === "guest");
  });

  it("附件：主持人把正文里引用的图片交给 Rust，正文变了换一份", async () => {
    useData.setState({
      notes: [{ id: "n1", title: "周会", relPath: "笔记/工作/周会.md" } as NoteSummary],
      bodies: { n1: "![](../../附件/a.png) ![](https://x/y.png)" },
    });
    await net.onControl(handleControl);
    await store().startHosting("n1", "周会");
    await until("引用表", () => net.attachmentRefs().length === 1);
    expect(net.attachmentRefs()).toEqual([{ path: "../../附件/a.png", vaultPath: "附件/a.png" }]);
    const session = store().hostedDocs.n1!;
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
    await store().join("odea://join/abcdefghijklmnop");
    await until("进来了", () => phase() === "guest" && !!store().images);
    const before = store().images!;
    expect(before.resolve("附件/图.png")).toBe("");
    net.remoteType("\n![](附件/图.png)");
    await until("要到了", () => store().images?.resolve("附件/图.png") !== "");
    expect(store().images).not.toBe(before);
    expect(store().images!.resolve("附件/图.png")).toMatch(/^data:image\/svg\+xml/);

    const file = new File([new Uint8Array([1, 2, 3])], "截图.png", { type: "image/png" });
    const put = vi.spyOn(net, "putAttachment");
    const attached = await store().attachFiles([file]);
    expect(attached).toEqual([{ link: "附件/截图.png", name: "截图.png", isImage: true }]);
    expect(put).toHaveBeenCalledWith(one().id, "mock-doc", "截图.png", "AQID");
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
    await store().startHostingScope({ kind: "folder", folder: "项目", name: "项目" });
    expect(one()).toMatchObject({
      phase: "hosting",
      noteId: null,
      scope: { kind: "folder", doc: "项目" },
    });
    const id = one().id;
    // 树：只有「项目」里的那篇
    const tree = JSON.parse(setTree.mock.calls.at(-1)![1]);
    expect(tree.docs).toEqual([{ id: "n1", title: "周会", folder: "" }]);
    // 还没人要：一篇会话都没有
    expect(store().hostedDocs).toEqual({});

    await until("加入请求", () => one().requests.length === 1);
    await store().answer(id, 1, "edit");
    // Alex 要开树里的第一篇：给了，建起这一篇的会话
    await until("建了 n1 的会话", () => !!store().hostedDocs.n1);
    expect(answerDoc).toHaveBeenCalledWith(id, 100, null);
    await until("对方同步到", () => net.remoteText() === "第一行\n第二行");
    net.remoteType("（Alex 写的）");
    await until("存进 n1", () =>
      saved.some((item) => item.id === "n1" && item.text.includes("Alex 写的")),
    );

    // 文件夹外的：不给，说为什么
    handleControl(id, { type: "docOpen", request: 777, member: 1, doc: "n2" });
    await until("回了不给", () => answerDoc.mock.calls.some((call) => call[1] === 777));
    expect(answerDoc).toHaveBeenCalledWith(id, 777, "这一篇不在共享的文件夹里");
    expect(store().hostedDocs.n2).toBeUndefined();
  });

  it("进一个文件夹：拿到树，开哪篇显示哪篇，新建的打开它，开不了的说为什么", async () => {
    await net.onControl(handleControl);
    await store().join("odea://join/folderabcdefghijklmn");
    await until("进来了", () => phase() === "guest");
    const id = one().id;
    expect(one().scope).toMatchObject({ kind: "folder", name: "项目" });
    expect(one().tree?.docs.map((doc) => doc.title)).toEqual(["周会记录", "下季度计划"]);
    // 文件夹的范围：对话框留着挑一篇，正文区还没有
    expect(one().current).toBeNull();

    await store().openShared(id, "mock-plan");
    await until("同步到计划", () => (store().session?.toString() ?? "").startsWith("# 下季度计划"));
    expect(one()).toMatchObject({ current: "mock-plan", title: "下季度计划" });
    expect(store().showShared).toBe(true);
    await store().openShared(id, "mock-weekly");
    await until("换成周会", () => (store().session?.toString() ?? "").startsWith("# 周会记录"));
    expect(one().openDocs).toEqual(["mock-plan", "mock-weekly"]);

    // 关掉正在看的：换到还开着的那一篇
    await store().closeShared(id, "mock-weekly");
    expect(one()).toMatchObject({ current: "mock-plan", openDocs: ["mock-plan"] });

    // 新建：主持人那边建好，树上有了，打开它
    await store().createShared(id, "计划", "复盘");
    await until("开着新的", () => one().current === "mock-new-3");
    expect(one().tree?.docs.some((doc) => doc.title === "复盘")).toBe(true);

    // 主持人不给的
    await store().openShared(id, "nope");
    await until("说为什么", () => !!store().error);
    expect(store().error).toContain("不在共享的文件夹里");
    expect(one().openDocs).not.toContain("nope");
  });
});

describe("同时好几个协作（设计 §25）", () => {
  beforeEach(() => {
    useData.setState({
      notes: [
        { id: "n1", title: "周会", relPath: "笔记/项目/周会.md" } as NoteSummary,
        { id: "n2", title: "计划", relPath: "笔记/私事/计划.md" } as NoteSummary,
      ],
      bodies: { n1: "周会的正文", n2: "计划的正文" },
    });
  });

  it("两篇各请各的人：各自同步、各存各的，停一个另一个照常", async () => {
    await net.onControl(handleControl);
    await store().startHosting("n1", "周会");
    const weekly = one().id;
    await store().startHosting("n2", "计划");
    const plan = one().id;
    expect(weekly).not.toBe(plan);
    expect(store().order).toEqual([weekly, plan]);
    expect(store().hostedIn).toEqual({ n1: weekly, n2: plan });
    // 对话框看着刚开始的那个
    expect(store().focus).toBe(plan);

    // 两边各来一位：周会是 Alex，计划是 Mia
    await until("两边都有人敲门", () =>
      [weekly, plan].every((id) => sessionOf(id).requests.length === 1),
    );
    expect(sessionOf(weekly).requests[0]!.name).toBe("Alex");
    expect(sessionOf(plan).requests[0]!.name).toBe("Mia");
    await store().answer(weekly, 1, "edit");
    await store().answer(plan, 1, "edit");
    await until(
      "各自同步到",
      () =>
        net.remoteText(undefined, weekly) === "周会的正文" &&
        net.remoteText(undefined, plan) === "计划的正文",
    );

    // Mia 在计划里打字：只存进 n2
    net.remoteType("（Mia）", 0, undefined, plan);
    await until("存进 n2", () =>
      saved.some((item) => item.id === "n2" && item.text.includes("Mia")),
    );
    expect(saved.some((item) => item.id === "n1")).toBe(false);
    expect(store().hostedDocs.n1!.toString()).toBe("周会的正文");

    // 停掉周会：计划照常，对话框换去看计划
    store().openSession(weekly);
    await store().stop(weekly);
    expect(store().order).toEqual([plan]);
    expect(store().focus).toBe(plan);
    expect(store().dialogOpen).toBe(true);
    expect(store().hostedDocs.n1).toBeUndefined();
    net.remoteType("（又一句）", 0, undefined, plan);
    await until("计划照常", () => store().hostedDocs.n2!.toString().includes("又一句"));
  });

  it("一篇只在一个协作里：再请这一篇、请它所在的文件夹、请整个仓库，都打开已经在的那一次", async () => {
    const host = vi.spyOn(net, "host");
    await net.onControl(handleControl);
    await store().startHosting("n1", "周会");
    const weekly = one().id;
    store().closeDialog();

    await store().startHosting("n1", "周会");
    expect(store()).toMatchObject({ dialogOpen: true, focus: weekly });
    expect(store().notice).toContain("已经在这次协作里");
    await store().startHostingScope({ kind: "folder", folder: "项目", name: "项目" });
    await store().startHostingScope({ kind: "vault", name: "Odea" });
    expect(store().order).toEqual([weekly]);
    expect(host).toHaveBeenCalledTimes(1);
    expect(overlapOf({ kind: "folder", folder: "私事", name: "私事" })).toBeNull();

    // 别的文件夹不重叠：照常开
    await store().startHostingScope({ kind: "folder", folder: "私事", name: "私事" });
    expect(store().order).toHaveLength(2);
    // 文件夹套文件夹也算重叠
    expect(overlapOf({ kind: "folder", folder: "私事/子", name: "子" })).toBe(one().id);
  });

  it("笔记后来挪进了另一个在协作的文件夹：访客来要时说它在别的协作里", async () => {
    const answerDoc = vi.spyOn(net, "answerDoc");
    await net.onControl(handleControl);
    await store().startHosting("n2", "计划");
    const plan = one().id;
    await store().startHostingScope({ kind: "folder", folder: "项目", name: "项目" });
    const folder = one().id;
    // n2 被挪进了「项目」
    useData.setState((state) => ({
      notes: state.notes.map((note) =>
        note.id === "n2" ? { ...note, relPath: "笔记/项目/计划.md" } : note,
      ),
    }));
    handleControl(folder, { type: "docOpen", request: 900, member: 1, doc: "n2" });
    await until("回了不给", () => answerDoc.mock.calls.some((call) => call[1] === 900));
    expect(answerDoc).toHaveBeenCalledWith(folder, 900, "这一篇正在另一个协作里");
    expect(store().hostedIn.n2).toBe(plan);
  });

  it("一边主持一边做客：正文区是做客的那篇，主持的那篇照样同步、存盘", async () => {
    await net.onControl(handleControl);
    await store().startHosting("n1", "周会");
    const weekly = one().id;
    await until("敲门", () => sessionOf(weekly).requests.length === 1);
    await store().answer(weekly, 1, "edit");

    await store().join("odea://join/abcdefghijklmnop");
    const guest = one().id;
    await until("进来了", () => sessionOf(guest).phase === "guest" && !!store().session);
    expect(store().shownSession).toBe(guest);
    expect(store().session).not.toBe(store().hostedDocs.n1);
    await until("同步到对面的正文", () => store().session!.toString().startsWith("# 周会记录"));

    // 主持的那篇：Alex 打的字照样存进 n1
    await until("Alex 拿到正文", () => net.remoteText(undefined, weekly) === "周会的正文");
    net.remoteType("（Alex）", 0, undefined, weekly);
    await until("存进 n1", () =>
      saved.some((item) => item.id === "n1" && item.text.includes("Alex")),
    );
    // 离开做客的：主持的不受影响
    await store().stop(guest);
    expect(store().order).toEqual([weekly]);
    expect(store().session).toBeNull();
    expect(store().hostedDocs.n1).toBeDefined();
  });

  it("「附近」进来、主持着好几个：挑进哪一个，按挑的权限", async () => {
    const answerNearby = vi.spyOn(net, "answerNearby");
    await net.onControl(handleControl);
    await store().startHosting("n1", "周会");
    await store().startHosting("n2", "计划");
    const plan = one().id;
    handleControl(null, { type: "nearbyKnock", request: 5, id: "mock-sam", name: "Sam" });
    expect(store().knocks).toEqual([{ request: 5, id: "mock-sam", name: "Sam" }]);
    await store().answerKnock(5, plan, "read");
    expect(answerNearby).toHaveBeenCalledWith(5, plan, "read");
    expect(store().knocks).toEqual([]);
    // 他自己走了：卡片收起
    handleControl(null, { type: "nearbyKnock", request: 6, id: "mock-leo", name: "Leo" });
    handleControl(null, { type: "nearbyKnockDone", request: 6 });
    expect(store().knocks).toEqual([]);
  });
});
