import type { CollabScheduler } from "@/collab/session";
import type { DocumentSaveTarget } from "@/data/types";
import { describe, expect, it } from "vitest";
import { TeamController, type TeamIO, type TeamSnapshot } from "./controller";
import { type MockTeamHub, createMockTeamHub } from "./mockNet";

/* 团队仓库里同一篇谁主持、谁做客（docs/协同编辑.md §22.4）：一个进程里起几台设备（mockNet 的 hub），
   每台一个 controller、一块自己的「磁盘」。打字不经编辑器，直接改会话 */

const DOC = "笔记/周会.md";
const TARGET: DocumentSaveTarget = { kind: "note", id: "n1" };
const ORIGINAL = "# 周会\n\n- 张三：接口\n- 李四：界面\n\n## 下周\n- 发版";

const scheduler: CollabScheduler = {
  now: () => Date.now(),
  frame: (callback) => void setTimeout(callback, 0),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Device {
  controller: TeamController;
  snapshot: TeamSnapshot;
  disk: Map<string, string>;
  saves: number;
  external: Set<(disk: string) => void>;
}

function device(hub: MockTeamHub, id: string, name: string, text = ORIGINAL): Device {
  const { net, self } = hub.device(id, name);
  const out = {
    disk: new Map([["n1", text]]),
    saves: 0,
    external: new Set<(disk: string) => void>(),
  } as Device;
  const io: TeamIO = {
    flush: async () => {},
    load: async (target) => (target.kind === "note" ? out.disk.get(target.id) : undefined),
    save: async (target, text) => {
      if (target.kind === "note") out.disk.set(target.id, text);
      out.saves += 1;
    },
    onExternal: (_target, listener) => {
      out.external.add(listener);
      return () => out.external.delete(listener);
    },
  };
  out.snapshot = { peers: [], sessions: {} };
  out.controller = new TeamController(
    net,
    self(),
    io,
    (snapshot) => {
      out.snapshot = snapshot;
    },
    {
      joinTimeout: 2000,
      dropGrace: 150,
      aloneGrace: 150,
      saveDelay: 10,
      syncWait: 30,
      retryAfter: 40,
      relayGrace: 60,
    },
    scheduler,
  );
  void net.openPipe((frame) => out.controller.receive(frame));
  void net.onControl((control) => out.controller.control(control));
  return out;
}

async function until(what: string, check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等不到：${what}`);
}

const sessionOf = (device: Device) => device.snapshot.sessions[DOC];
const textOf = (device: Device) => sessionOf(device)?.session.toString();
const append = (device: Device, text: string) => {
  const session = sessionOf(device)!.session;
  session.insertText(session.toString().length, text);
};
const open = (device: Device) => device.controller.view({ doc: DOC, target: TARGET });

describe("团队：同一篇谁主持（设计 §22.4）", () => {
  it("一个人开着不建会话；两台开着：公钥小的主持，另一台加入，只有主持人存盘", async () => {
    const hub = createMockTeamHub();
    const a = device(hub, "a1", "张三");
    const b = device(hub, "b2", "李四");
    open(a);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sessionOf(a)).toBeUndefined();

    open(b);
    await until(
      "李四加入了张三的会话",
      () => sessionOf(b)?.remote === true && sessionOf(a)?.remote === false,
    );
    expect(textOf(b)).toBe(ORIGINAL);

    append(b, "\n- 写更新说明");
    await until("张三那边收到、存盘", () => a.disk.get("n1")?.endsWith("- 写更新说明") === true);
    expect(textOf(a)).toBe(textOf(b));
    // 访客不存这一篇
    expect(b.disk.get("n1")).toBe(ORIGINAL);
    expect(b.saves).toBe(0);
  });

  it("加入时本机没提交的改动三方合进会话", async () => {
    const hub = createMockTeamHub();
    const hostText = ORIGINAL.replace("- 发版", "- 发版\n- 张三补的");
    const localText = ORIGINAL.replace("- 李四：界面", "- 李四：界面（周三前）");
    const a = device(hub, "a1", "张三", hostText);
    const b = device(hub, "b2", "李四", localText);
    hub.setBase("b2", TARGET, ORIGINAL);
    open(a);
    open(b);
    await until("合好了", () => {
      const text = textOf(a) ?? "";
      return text.includes("（周三前）") && text.includes("张三补的");
    });
    await until("两边一样", () => textOf(a) === textOf(b));
    expect(textOf(a)!.split("\n- 李四").length).toBe(2);
  });

  it("三台：访客之间经主持人看到彼此的字", async () => {
    const hub = createMockTeamHub();
    const a = device(hub, "a1", "张三");
    const b = device(hub, "b2", "李四");
    const c = device(hub, "c3", "王五");
    open(a);
    open(b);
    open(c);
    await until("都进来了", () => sessionOf(b)?.remote === true && sessionOf(c)?.remote === true);
    append(c, "\n王五写的");
    await until("李四看到王五的", () => textOf(b)?.endsWith("王五写的") === true);
    append(b, "\n李四写的");
    await until("王五看到李四的", () => textOf(c)?.endsWith("李四写的") === true);
    await until(
      "张三存下了两位的",
      () => a.disk.get("n1")?.endsWith("王五写的\n李四写的") === true,
    );
  });

  it("主持人切走：先推一轮 git，访客接手、接着存盘，会话还是那一份", async () => {
    const hub = createMockTeamHub();
    const a = device(hub, "a1", "张三");
    const b = device(hub, "b2", "李四");
    open(a);
    open(b);
    await until("李四加入了", () => sessionOf(b)?.remote === true);
    const session = sessionOf(b)!.session;
    a.controller.view(null);
    await until("李四接手了", () => sessionOf(b)?.remote === false);
    expect(hub.syncs("a1")).toBeGreaterThan(0);
    expect(hub.syncs("b2")).toBeGreaterThan(0);
    expect(sessionOf(b)!.session).toBe(session);
    append(b, "\n接手以后写的");
    await until("李四存盘", () => b.disk.get("n1")?.endsWith("接手以后写的") === true);
    // 身边没人了：过一会儿收掉会话
    await until("回到一个人", () => sessionOf(b) === undefined);
  });

  it("主持人断线：不在线了就接手；他回来了、还在主持（同一份会话），让给公钥小的", async () => {
    const hub = createMockTeamHub();
    const a = device(hub, "a1", "张三");
    const b = device(hub, "b2", "李四");
    const c = device(hub, "c3", "王五");
    open(a);
    open(b);
    open(c);
    await until("都进来了", () => sessionOf(b)?.remote === true && sessionOf(c)?.remote === true);
    hub.setOnline("a1", false);
    // 李四（剩下的人里公钥最小）接手，王五连他
    await until("李四接手", () => sessionOf(b)?.remote === false, 3000);
    append(c, "\n断线以后写的");
    await until("李四收到、存盘", () => b.disk.get("n1")?.endsWith("断线以后写的") === true);
    // 张三回来了：他那边还以为自己在主持。两个主持人、同一份会话：公钥大的（李四）让，大家连张三
    append(a, "\n张三断线时写的");
    hub.setOnline("a1", true);
    await until(
      "又都连着张三",
      () => sessionOf(b)?.remote === true && sessionOf(c)?.remote === true,
    );
    await until("三边一样", () => {
      const text = textOf(a);
      return !!text && text === textOf(b) && text === textOf(c);
    });
    const text = textOf(a)!;
    expect(text).toContain("断线以后写的");
    expect(text).toContain("张三断线时写的");
    expect(text.split("# 周会").length).toBe(2);
  });

  it("访客走了：主持人那边过一会儿收掉会话", async () => {
    const hub = createMockTeamHub();
    const a = device(hub, "a1", "张三");
    const b = device(hub, "b2", "李四");
    open(a);
    open(b);
    await until("李四加入了", () => sessionOf(b)?.remote === true);
    b.controller.view(null);
    await until("张三回到一个人", () => sessionOf(a) === undefined);
    expect(sessionOf(b)).toBeUndefined();
  });

  it("连不上主持人：经一位连着他的成员转；他走了，自己接手", async () => {
    const hub = createMockTeamHub();
    const a = device(hub, "a1", "张三");
    const b = device(hub, "b2", "李四");
    const c = device(hub, "c3", "王五");
    // 王五和张三之间连不上（隔着 NAT），都连得上李四
    hub.block("a1", "c3");
    open(a);
    open(b);
    await until("李四加入了", () => sessionOf(b)?.remote === true);
    open(c);
    await until("王五经李四加入", () => sessionOf(c)?.remote === true);
    append(c, "\n王五写的");
    await until("张三存下王五写的", () => a.disk.get("n1")?.endsWith("王五写的") === true);
    append(a, "\n张三写的");
    await until("王五看到张三的", () => textOf(c)?.endsWith("张三写的") === true);
    expect(textOf(b)).toBe(textOf(a));
    expect(c.saves).toBe(0);

    // 李四走了：王五谁都连不上（看不到张三），自己接手、存盘 —— 张三那边还在写同一篇，git 同步时再合
    b.controller.view(null);
    await until("王五接手", () => sessionOf(c)?.remote === false);
    append(c, "\n接手以后");
    await until("王五存盘", () => c.disk.get("n1")?.endsWith("接手以后") === true);
  });
});
