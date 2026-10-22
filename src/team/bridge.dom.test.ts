// @vitest-environment happy-dom

import { type MockNet, createMockNet } from "@/collab/mockNet";
import type { CollabScheduler } from "@/collab/session";
import { handleControl, resetCollabForTest, useCollab } from "@/collab/store";
import { useData } from "@/data/store";
import type { NoteSummary } from "@/data/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamController } from "./controller";
import { createMockTeamHub } from "./mockNet";
import { initTeam, resetTeam, setTeamView, useTeam } from "./store";

/* 一份文档两条链路（docs/协同编辑.md §22.5 最后一段）：这台在团队会话里做客（张三主持），
   又用「邀请协作…」请了外人 Alex。协作借团队那份会话：Alex 打的字到张三那里、张三存盘；
   张三打的到 Alex 那里；这边一次都不存（团队里是张三主持） */

const DOC = "笔记/周会.md";
const TEXT = "第一行\n第二行\n第三行";

const scheduler: CollabScheduler = {
  now: () => Date.now(),
  frame: (callback) => void setTimeout(callback, 0),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

async function until(what: string, check: () => boolean) {
  for (let waited = 0; waited < 4000; waited += 10) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等不到：${what}`);
}

let net: MockNet;
let saved: string[];
let originalData: ReturnType<typeof useData.getState>;

beforeEach(() => {
  originalData = useData.getState();
  net = createMockNet({ speed: 0.002, bots: false });
  resetCollabForTest(net);
  saved = [];
  useData.setState({
    notes: [{ id: "n1", title: "周会", relPath: DOC } as NoteSummary],
    bodies: { n1: TEXT },
    externalRevisions: {},
    loadBody: vi.fn(async (id: string) => useData.getState().bodies[id]),
    saveDocument: vi.fn(async (target, text) => {
      if (target.kind !== "note") return;
      saved.push(text);
      useData.setState((state) => ({ bodies: { ...state.bodies, [target.id]: text } }));
    }),
    saveTitle: vi.fn(async () => {}),
  });
});

afterEach(async () => {
  await useCollab.getState().stop();
  resetCollabForTest(null);
  await resetTeam();
  useData.setState(originalData, true);
});

describe("一份文档两条链路", () => {
  it("团队里做客的这一篇请了外人：外人和团队的主持人互相看到，主持人存盘", async () => {
    const hub = createMockTeamHub();
    const zhang = hub.device("a1", "张三");
    const disk = new Map([["n1", TEXT]]);
    const host = new TeamController(
      zhang.net,
      zhang.self(),
      {
        flush: async () => {},
        load: async () => disk.get("n1"),
        save: async (_target, text) => {
          disk.set("n1", text);
        },
        onExternal: () => () => {},
      },
      () => {},
      { saveDelay: 10, aloneGrace: 100000 },
      scheduler,
    );
    void zhang.net.openPipe((frame) => host.receive(frame));
    void zhang.net.onControl((control) => host.control(control));
    host.view({ doc: DOC, target: { kind: "note", id: "n1" } });

    // 这个窗口：团队里做客
    const mine = hub.device("b2", "李四");
    await initTeam(mine.net);
    setTeamView({ doc: DOC, target: { kind: "note", id: "n1" } });
    await until("加入了张三的会话", () => useTeam.getState().sessions[DOC]?.remote === true);
    const teamSession = useTeam.getState().sessions[DOC]!.session;

    // 请外人：协作借的是团队那一份
    await net.onControl(handleControl);
    await useCollab.getState().startHosting("n1", "周会");
    expect(useCollab.getState().hostedDocs.n1).toBe(teamSession);
    await until("加入请求", () => useCollab.getState().requests.length === 1);
    await useCollab.getState().answer(useCollab.getState().requests[0]!.request, "edit");
    await until("Alex 拿到正文", () => net.remoteText() === TEXT);

    net.remoteType("（Alex 补充）", 3);
    await until("张三那边存下 Alex 的", () => disk.get("n1")?.includes("（Alex 补充）") === true);
    const zhangSession = host.snapshot().sessions[DOC]!.session;
    zhangSession.insertText(zhangSession.toString().length, "\n张三加的");
    await until("Alex 看到张三的", () => net.remoteText().endsWith("张三加的"));
    expect(teamSession.toString()).toBe(zhangSession.toString());
    // 团队里是张三主持：这边不存（协作借的会话也不存）
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(saved).toEqual([]);

    // 协作停了：团队那一份还在（这边还开着这一篇）
    await useCollab.getState().stop();
    expect(useTeam.getState().sessions[DOC]?.session).toBe(teamSession);
    await host.destroy();
  });
});
