import type { CollabScheduler } from "@/collab/session";
import { type DocumentRef, NOTE, noteRef } from "@/data/types";
import { describe, expect, it, vi } from "vitest";
import { TeamController, type TeamIO, type TeamSnapshot } from "./controller";
import { type MockTeamHub, createMockTeamHub } from "./mockNet";

/* 团队仓库里同一篇谁主持、谁做客（docs/协同编辑.md §22.4）：一个进程里起几台设备（mockNet 的 hub），
   每台一个 controller、一块自己的「磁盘」。打字不经编辑器，直接改会话 */

const DOC = "笔记/周会.md";
const TARGET: DocumentRef = noteRef("n1");
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
  /** 另存的冲突副本：存的时候说了照着哪一版（seen），磁盘上又不是那一版（后端 keep_unseen_edits 的规矩） */
  copies: string[];
  external: Set<(disk: string) => void>;
}

function device(hub: MockTeamHub, id: string, name: string, text = ORIGINAL): Device {
  const { net, self } = hub.device(id, name);
  const out = {
    disk: new Map([["n1", text]]),
    saves: 0,
    copies: [] as string[],
    external: new Set<(disk: string) => void>(),
  } as Device;
  const io: TeamIO = {
    flush: async () => {},
    load: async (target) => (target.type === NOTE ? out.disk.get(target.key) : undefined),
    save: async (target, text, seen) => {
      if (target.type === NOTE) {
        const disk = out.disk.get(target.key);
        if (seen !== undefined && disk !== undefined && disk !== seen && disk !== text)
          out.copies.push(disk);
        out.disk.set(target.key, text);
      }
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

  it("没有 base、本机和对方不一样：本机那一版不进会话，接手主持把会话存回来之前另存一份冲突副本", async () => {
    const hub = createMockTeamHub();
    const hostText = `${ORIGINAL}\n- 张三那边写的`;
    const localText = `${ORIGINAL}\n- 李四这边写的（还没进 git）`;
    const a = device(hub, "a1", "张三", hostText);
    const b = device(hub, "b2", "李四", localText);
    // b2 的 git 里没有这一篇（新建的、改了名还没提交）：team_base 是 null
    open(a);
    open(b);
    await until("李四加入了", () => sessionOf(b)?.remote === true);
    // 没有 base 合不了：会话是对方那一版；做客不存，本机的那一版还在自己磁盘上
    expect(textOf(b)).toBe(hostText);
    expect(b.disk.get("n1")).toBe(localText);
    expect(b.copies).toEqual([]);

    // 主持人走了，李四接手：会话的正文存回本机 —— 磁盘上那一版会话从没见过，先另存
    a.controller.view(null);
    await until(
      "李四接手、存盘",
      () => sessionOf(b)?.remote === false && b.disk.get("n1") === hostText,
    );
    expect(b.copies).toEqual([localText]);
    // 之后照常存，不再另存
    append(b, "\n- 接手以后写的");
    await until("又存了一次", () => b.disk.get("n1")?.endsWith("接手以后写的") === true);
    expect(b.copies).toEqual([localText]);
  });

  it("有 base、本机的改动和对方撞在同一行（三方合跳过了）：接手时也另存；全合进去的不另存", async () => {
    const hub = createMockTeamHub();
    const hostText = ORIGINAL.replace("- 李四：界面", "- 李四：界面和文档");
    const localText = ORIGINAL.replace("- 李四：界面", "- 李四：界面（周三前）");
    const a = device(hub, "a1", "张三", hostText);
    const b = device(hub, "b2", "李四", localText);
    hub.setBase("b2", TARGET, ORIGINAL);
    open(a);
    open(b);
    await until("李四加入了", () => sessionOf(b)?.remote === true);
    expect(textOf(b)).toBe(hostText);
    a.controller.view(null);
    await until(
      "李四接手、存盘",
      () => sessionOf(b)?.remote === false && b.disk.get("n1") === hostText,
    );
    expect(b.copies).toEqual([localText]);

    // 本机的改动全合进去了：会话里都有，接手时照常存
    const hub2 = createMockTeamHub();
    const c = device(hub2, "a1", "张三", ORIGINAL.replace("- 发版", "- 发版\n- 张三补的"));
    const d = device(hub2, "b2", "李四", localText);
    hub2.setBase("b2", TARGET, ORIGINAL);
    open(c);
    open(d);
    await until(
      "合好了",
      () => textOf(d)?.includes("（周三前）") === true && textOf(d)?.includes("张三补的") === true,
    );
    c.controller.view(null);
    await until(
      "李四接手、存盘",
      () => sessionOf(d)?.remote === false && d.disk.get("n1") === textOf(d),
    );
    expect(d.copies).toEqual([]);
  });

  it("本机那一版没合进去：快照里只带主持人的名字，正文要看时再取；关掉以后不带，接手存成冲突副本以后都没了（§28）", async () => {
    // 没有 base
    const hub = createMockTeamHub();
    const hostText = `${ORIGINAL}\n- 张三那边写的`;
    const localText = `${ORIGINAL}\n- 李四这边写的（还没进 git）`;
    const a = device(hub, "a1", "张三", hostText);
    const b = device(hub, "b2", "李四", localText);
    open(a);
    open(b);
    await until("李四加入了", () => sessionOf(b)?.remote === true);
    expect(sessionOf(b)?.unseenFrom).toBe("张三");
    expect(b.controller.unseenText(DOC)).toBe(localText);
    // 主持人那边没有这回事；快照里没有正文
    expect(sessionOf(a)?.unseenFrom).toBeUndefined();
    expect(JSON.stringify({ ...sessionOf(b), session: null })).not.toContain("李四这边写的");
    // 关掉：快照不带了，正文还在（接手时照旧另存）
    b.controller.hideUnseen(DOC);
    expect(sessionOf(b)?.unseenFrom).toBeUndefined();
    expect(b.controller.unseenText(DOC)).toBe(localText);
    a.controller.view(null);
    await until("李四接手、存盘", () => b.disk.get("n1") === hostText);
    expect(b.copies).toEqual([localText]);
    expect(b.controller.unseenText(DOC)).toBeNull();

    // 有 base、三方合撞上：一样带；接手存成冲突副本以后快照里没了
    const hub2 = createMockTeamHub();
    const hostText2 = ORIGINAL.replace("- 李四：界面", "- 李四：界面和文档");
    const localText2 = ORIGINAL.replace("- 李四：界面", "- 李四：界面（周三前）");
    const c = device(hub2, "a1", "张三", hostText2);
    const d = device(hub2, "b2", "李四", localText2);
    hub2.setBase("b2", TARGET, ORIGINAL);
    open(c);
    open(d);
    await until("李四加入了", () => sessionOf(d)?.remote === true);
    expect(sessionOf(d)?.unseenFrom).toBe("张三");
    expect(d.controller.unseenText(DOC)).toBe(localText2);
    c.controller.view(null);
    await until("李四接手、存盘", () => d.disk.get("n1") === hostText2);
    await until("快照里没了", () => sessionOf(d)?.remote === false && !sessionOf(d)?.unseenFrom);
    expect(d.copies).toEqual([localText2]);

    // 合得进去的：没有
    const hub3 = createMockTeamHub();
    const e = device(hub3, "a1", "张三", ORIGINAL.replace("- 发版", "- 发版\n- 张三补的"));
    const f = device(hub3, "b2", "李四", localText2);
    hub3.setBase("b2", TARGET, ORIGINAL);
    open(e);
    open(f);
    await until("合好了", () => textOf(f)?.includes("（周三前）") === true);
    expect(sessionOf(f)?.unseenFrom).toBeUndefined();
    expect(f.controller.unseenText(DOC)).toBeNull();
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

  it("看着几篇（分屏、弹出窗口）：每一篇各自进会话；对端一次只报一篇（0.9.0 那样）照样连上（§29.3）", async () => {
    const hub = createMockTeamHub();
    const a = device(hub, "a1", "张三");
    const b = device(hub, "b2", "李四");
    const PLAN = "笔记/计划.md";
    const PLAN_TARGET = noteRef("n2");
    for (const each of [a, b]) each.disk.set("n2", "# 计划\n\n- 第一步");
    const both = [
      { doc: DOC, target: TARGET },
      { doc: PLAN, target: PLAN_TARGET },
    ];
    a.controller.views(both);
    // 李四只报一篇（0.9.0 只会这样报，Presence 的格式没变）
    b.controller.view({ doc: PLAN, target: PLAN_TARGET });
    await until(
      "李四进了张三的《计划》",
      () =>
        b.snapshot.sessions[PLAN]?.remote === true && a.snapshot.sessions[PLAN]?.remote === false,
    );
    // 张三看着的另一篇没别人开：照旧一个人编辑，不建会话
    expect(sessionOf(a)).toBeUndefined();
    // 「也在看」：李四那边看到张三开着两篇
    await until("李四看到张三开着两篇", () => {
      const docs = b.snapshot.peers.find((peer) => peer.id === "a1")?.docs.map((item) => item.doc);
      return docs?.includes(DOC) === true && docs.includes(PLAN);
    });

    // 李四换到《周会》：张三那边这一篇也进会话，《计划》没人一起看了，过一会儿收掉
    b.controller.view({ doc: DOC, target: TARGET });
    await until(
      "李四进了张三的《周会》",
      () => sessionOf(b)?.remote === true && sessionOf(a)?.remote === false,
    );
    append(b, "\n- 李四在分屏的另一边写的");
    await until("张三存下", () => a.disk.get("n1")?.endsWith("李四在分屏的另一边写的") === true);
    await until("《计划》收掉了", () => a.snapshot.sessions[PLAN] === undefined);

    // 张三关掉放《周会》的那个窗格（只剩《计划》）：和主持人切走一样，李四接手
    a.controller.views([{ doc: PLAN, target: PLAN_TARGET }]);
    await until("李四接手了", () => sessionOf(b)?.remote === false);
    expect(a.disk.get("n2")).toBe("# 计划\n\n- 第一步");
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

  it("定时器比 Date.now() 早一点到：被拒以后照样再试，主持人断线照样有人接手", async () => {
    // 2026-10-22：主持人断线，李四、王五先按旧的 Presence 去连他、被拒，40ms 后再试；定时器偶尔比 Date.now()
    // 早一两毫秒到，一看「还没到」就返回、没再排，两边都卡在 orphan。这里让 Date.now() 只走一半的速度，每次都早到
    const realNow = Date.now.bind(Date);
    const start = realNow();
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => start + Math.floor((realNow() - start) * 0.5));
    try {
      const hub = createMockTeamHub();
      const a = device(hub, "a1", "张三");
      const b = device(hub, "b2", "李四");
      const c = device(hub, "c3", "王五");
      open(a);
      open(b);
      open(c);
      await until("都进来了", () => sessionOf(b)?.remote === true && sessionOf(c)?.remote === true);
      hub.setOnline("a1", false);
      await until("李四接手", () => sessionOf(b)?.remote === false);
      await until("王五连他", () => sessionOf(c)?.remote === true);
    } finally {
      clock.mockRestore();
    }
    // Date.now() 慢一半，until 的 3 秒是 6 秒：等不到时报的是卡在哪一步，不是测试超时
  }, 10_000);

  it("协作借着的不让给另一份会话的主持人（也不会一直空转）", async () => {
    // 让不了（yieldTo 里直接返回）还每次都去让：做完马上再判断、又去让，微任务一直转，页面卡死
    const hub = createMockTeamHub();
    const a = device(hub, "a1", "张三");
    const b = device(hub, "b2", "李四");
    hub.setOnline("b2", false);
    // 各自借给协作：一个人也主持一份
    const held = await Promise.all([
      a.controller.hold({ doc: DOC, target: TARGET }),
      b.controller.hold({ doc: DOC, target: TARGET }),
    ]);
    expect(held.every(Boolean)).toBe(true);
    hub.setOnline("b2", true);
    await until("互相看到对方在主持", () =>
      b.snapshot.peers.some((peer) => peer.id === "a1" && peer.docs.some((item) => item.hosting)),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sessionOf(a)?.remote).toBe(false);
    expect(sessionOf(b)?.remote).toBe(false);
    a.controller.release(DOC);
    b.controller.release(DOC);
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
    // 李四转给王五的同时自己也收着，前端那边可能晚一拍
    await until("李四和张三一样", () => textOf(b) === textOf(a));
    expect(c.saves).toBe(0);

    // 李四走了：王五谁都连不上（看不到张三），自己接手、存盘 —— 张三那边还在写同一篇，git 同步时再合
    b.controller.view(null);
    await until("王五接手", () => sessionOf(c)?.remote === false);
    append(c, "\n接手以后");
    await until("王五存盘", () => c.disk.get("n1")?.endsWith("接手以后") === true);
  });

  it("主持人走了，公钥最小的那位正经我转：他断开我、自己接手，我改连他", async () => {
    // 2026-10-22 发 0.4.1 时 CI 偶发卡住：主持人刚断，李四看到王五过时的 Presence（还连着张三），经王五接上；
    // 王五随后也丢了主持人，等公钥最小的李四接手，李四在他下面做客、不知道要接手 —— 两边一直等
    const hub = createMockTeamHub();
    const a = device(hub, "a1", "张三");
    const b = device(hub, "b2", "李四");
    const c = device(hub, "c3", "王五");
    hub.block("a1", "b2");
    open(a);
    open(c);
    await until("王五加入了", () => sessionOf(c)?.remote === true);
    // 李四先看到王五在张三的会话里再开（不然他看不到张三、也看不到会话，自己主持一份）
    await until("李四看到王五连着张三", () =>
      b.snapshot.peers.some(
        (peer) => peer.id === "c3" && peer.docs.some((item) => item.root === "a1"),
      ),
    );
    open(b);
    await until("李四经王五加入", () => sessionOf(b)?.remote === true);
    hub.setOnline("a1", false);
    await until(
      "李四接手、王五连他",
      () => sessionOf(b)?.remote === false && sessionOf(c)?.remote === true,
    );
    append(c, "\n接手以后");
    await until("李四存盘", () => b.disk.get("n1")?.endsWith("接手以后") === true);
    expect(c.saves).toBe(0);
  });

  it("看不到主持人、先自己主持了一份：看到经转发能到的会话、根的公钥更小，就不主持、经转发加入", async () => {
    const hub = createMockTeamHub();
    const a = device(hub, "a1", "张三");
    const b = device(hub, "b2", "李四");
    const c = device(hub, "c3", "王五");
    hub.block("a1", "b2");
    // 张三、李四先开：互相看不到，各自一个人。王五一开，两边都看到他、都是公钥最小的，都主持；
    // 王五加入公钥更小的张三 —— 李四先自己主持了一份
    open(a);
    open(b);
    await new Promise((resolve) => setTimeout(resolve, 100));
    open(c);
    await until("王五加入张三", () => sessionOf(c)?.remote === true);
    await until("李四经王五加入", () => sessionOf(b)?.remote === true);
    // 不主持之前自己那份先存过一次；加入以后不再存
    const saves = b.saves;
    append(b, "\n李四写的");
    await until("张三存下李四写的", () => a.disk.get("n1")?.endsWith("李四写的") === true);
    expect(b.saves).toBe(saves);
  });
});
