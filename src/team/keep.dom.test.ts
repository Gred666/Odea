// @vitest-environment happy-dom

import { keepGuestCopy, listGuestCopies, useGuestCopies } from "@/collab/keep";
import type { CollabScheduler } from "@/collab/session";
import type { DocumentSaveTarget } from "@/data/types";
import { beforeEach, describe, expect, it } from "vitest";
import { TeamController, type TeamIO, type TeamSnapshot } from "./controller";
import { type MockTeamHub, createMockTeamHub } from "./mockNet";

/* 做客时主持人还没存下的字本机另留一份（collab/keep.ts，docs/协同编辑.md §24）：
   一个进程里起两台设备（mockNet 的 hub），访客那台接 keepGuestCopy，看它什么时候留、什么时候删 */

const DOC = "note-n1";
const TARGET: DocumentSaveTarget = { kind: "note", id: "n1" };
const ORIGINAL = "# 周会\n\n- 张三：接口";

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
  /** 存盘卡住（主持人那边存不下去） */
  stuck: boolean;
  saves: number;
}

function device(hub: MockTeamHub, id: string, name: string): Device {
  const { net, self } = hub.device(id, name);
  const out = { disk: new Map([["n1", ORIGINAL]]), stuck: false, saves: 0 } as Device;
  const io: TeamIO = {
    flush: async () => {},
    load: async () => out.disk.get("n1"),
    save: async (_target, text) => {
      if (out.stuck) throw new Error("磁盘只读");
      out.disk.set("n1", text);
      out.saves += 1;
    },
    onExternal: () => () => {},
    keep: (link, target, doc, host) =>
      keepGuestCopy(link, {
        key: `team:${id}:${doc}`,
        title: () => "周会",
        host,
        vault: `仓库-${id}`,
        target,
        delay: 20,
      }),
  };
  out.snapshot = { peers: [], sessions: {} };
  out.controller = new TeamController(
    net,
    self(),
    io,
    (snapshot) => {
      out.snapshot = snapshot;
    },
    { joinTimeout: 2000, dropGrace: 150, aloneGrace: 150, saveDelay: 10, syncWait: 30 },
    scheduler,
  );
  void net.openPipe((frame) => out.controller.receive(frame));
  void net.onControl((control) => out.controller.control(control));
  return out;
}

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等不到：${what}`);
}

const sessionOf = (device: Device) => device.snapshot.sessions[DOC];
const append = (device: Device, text: string) => {
  const session = sessionOf(device)!.session;
  session.insertText(session.toString().length, text);
};
const stateOf = (device: Device) => {
  const session = sessionOf(device)?.session;
  return session ? useGuestCopies.getState().states.get(session) : undefined;
};
const copies = () => listGuestCopies();

beforeEach(() => {
  localStorage.clear();
  useGuestCopies.setState({ states: new Map() });
});

describe("做客时本机留一份（docs/协同编辑.md §24）", () => {
  it("主持人还没存下的字留在本机，存下了（他发来的版本向量盖住了）就删掉", async () => {
    const hub = createMockTeamHub();
    const a = device(hub, "a1", "张三");
    const b = device(hub, "b2", "李四");
    a.controller.view({ doc: DOC, target: TARGET });
    b.controller.view({ doc: DOC, target: TARGET });
    await until("李四在做客", () => sessionOf(b)?.remote === true);
    await until("刚加入、什么都没打：算同步好了", () => stateOf(b) === "synced");
    expect(await copies()).toEqual([]);

    // 主持人那边卡住存不下去：访客打的字只在内存里，本机留一份
    a.stuck = true;
    append(b, "\n- 李四：界面");
    await until("本机留着", async () => (await copies()).length === 1);
    const [kept] = await copies();
    expect(kept).toMatchObject({ title: "周会", host: "张三", vault: "仓库-b2", target: TARGET });
    expect(kept?.text.endsWith("- 李四：界面")).toBe(true);
    expect(stateOf(b)).toBe("kept");

    // 主持人存下去了：发来存的那一刻的版本向量，盖住了这边的全部 —— 删掉
    a.stuck = false;
    append(a, "\n- 张三：发版");
    await until("主持人存下了", () => a.disk.get("n1")?.includes("李四：界面") === true);
    await until("本机那份删了", async () => (await copies()).length === 0);
    await until("状态栏：已同步给主持人", () => stateOf(b) === "synced");
    // 存完发版本向量、访客回一个（空的）Sync2：不会又触发一次存盘，来回转个不停
    const saves = a.saves;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(a.saves).toBe(saves);

    await a.controller.destroy();
    await b.controller.destroy();
  });

  it("主持人没存下就断了：访客离开时最后的样子留在本机", async () => {
    const hub = createMockTeamHub();
    const a = device(hub, "a1", "张三");
    const b = device(hub, "b2", "李四");
    a.controller.view({ doc: DOC, target: TARGET });
    b.controller.view({ doc: DOC, target: TARGET });
    await until("李四在做客", () => sessionOf(b)?.remote === true);
    a.stuck = true;
    append(b, "\n- 最后几个字");
    // 节流还没到就关了窗口：离开时当场写
    await b.controller.destroy();
    await until("留着", async () => (await copies()).length === 1);
    expect((await copies())[0]?.text.endsWith("- 最后几个字")).toBe(true);
    await a.controller.destroy();
  });

  it("接手当了主持人、自己存下了：本机那份不用留", async () => {
    const hub = createMockTeamHub();
    const a = device(hub, "a1", "张三");
    const b = device(hub, "b2", "李四");
    a.controller.view({ doc: DOC, target: TARGET });
    b.controller.view({ doc: DOC, target: TARGET });
    await until("李四在做客", () => sessionOf(b)?.remote === true);
    a.stuck = true;
    append(b, "\n- 李四：界面");
    await until("本机留着", async () => (await copies()).length === 1);

    // 主持人关掉了：李四接手、自己存盘
    a.stuck = false;
    await a.controller.destroy();
    await until("李四接手存下了", () => b.disk.get("n1")?.includes("李四：界面") === true);
    await until("本机那份删了", async () => (await copies()).length === 0);
    await b.controller.destroy();
  });
});
