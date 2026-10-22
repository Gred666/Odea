// @vitest-environment happy-dom

import { useApp } from "@/app/store";
import type { CollabScheduler } from "@/collab/session";
import { useCurrentDocument } from "@/data/adapter";
import { useData } from "@/data/store";
import type { DocumentModel, NoteSummary } from "@/data/types";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamController } from "./controller";
import { createMockTeamHub } from "./mockNet";
import { initTeam, resetTeam, setTeamView, teamDocId, useTeam } from "./store";

/* 团队仓库这个窗口（store.ts）：真的数据层、真的 useCurrentDocument，接 mockNet 的 hub。
   对面那台只是一个 controller 和一块磁盘 */

const DOC = "笔记/周会.md";
const TEXT = "# 周会\n\n- 张三：接口";

const scheduler: CollabScheduler = {
  now: () => Date.now(),
  frame: (callback) => void setTimeout(callback, 0),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

async function until(what: string, check: () => boolean) {
  for (let waited = 0; waited < 3000; waited += 10) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等不到：${what}`);
}

let saved: string[];
let originalData: ReturnType<typeof useData.getState>;
let root: Root | null = null;

beforeEach(() => {
  originalData = useData.getState();
  saved = [];
  const note = { id: "n1", title: "周会", relPath: DOC } as NoteSummary;
  useData.setState({
    notes: [note],
    bodies: { n1: TEXT },
    externalRevisions: {},
    loadBody: vi.fn(async (id: string) => useData.getState().bodies[id]),
    saveDocument: vi.fn(async (target, text) => {
      if (target.kind !== "note") return;
      saved.push(text);
      useData.setState((state) => ({ bodies: { ...state.bodies, [target.id]: text } }));
    }),
  });
  useApp.setState({ workspace: "notes", selectedNoteId: "n1" });
});

afterEach(async () => {
  if (root) act(() => root!.unmount());
  root = null;
  await resetTeam();
  useData.setState(originalData, true);
});

describe("团队仓库的窗口", () => {
  it("文档 id：笔记是相对路径，某一天、目标按日期；做客的那篇没有", () => {
    const base = { key: "k", title: "", bodyMd: "", statusParts: [] } as unknown as DocumentModel;
    expect(
      teamDocId({
        ...base,
        relPath: DOC,
        editor: { target: { kind: "note", id: "n1" }, titleEditable: true },
      }),
    ).toBe(DOC);
    expect(
      teamDocId({
        ...base,
        editor: { target: { kind: "day", id: "2026-10-22" }, titleEditable: false },
      }),
    ).toBe("day-2026-10-22");
    expect(
      teamDocId({
        ...base,
        editor: {
          target: { kind: "goal", horizon: "week", periodStart: "2026-10-19" },
          titleEditable: false,
        },
      }),
    ).toBe("goal-week-2026-10-19");
    expect(
      teamDocId({ ...base, editor: { target: { kind: "shared", id: "s" }, titleEditable: false } }),
    ).toBeNull();
    // 正文还没取回来（没有 editor）的不算开着
    expect(teamDocId({ ...base, relPath: DOC })).toBeNull();
  });

  it("别人在主持这一篇：编辑器拿到的文档带着会话、不存盘；对面打的字到这边", async () => {
    const hub = createMockTeamHub();
    // 对面公钥小：他主持
    const other = hub.device("a1", "张三");
    const disk = new Map([["n1", TEXT]]);
    const host = new TeamController(
      other.net,
      other.self(),
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
    const hostSnapshot = () => host.snapshot().sessions[DOC];
    void other.net.openPipe((frame) => host.receive(frame));
    void other.net.onControl((control) => host.control(control));

    const mine = hub.device("b2", "李四");
    await initTeam(mine.net);
    expect(useTeam.getState()).toMatchObject({ active: true, me: "b2" });

    // 窗口里的编辑器：渲染 useCurrentDocument，把它算出来的那篇交给团队（Shell 里做的事）
    let shown: DocumentModel | null = null;
    function Probe() {
      const doc = useCurrentDocument();
      shown = doc;
      const id = teamDocId(doc);
      const target = doc.editor?.target;
      if (id && target && target.kind !== "shared") setTeamView({ doc: id, target });
      return null;
    }
    const container = document.createElement("div");
    root = createRoot(container);
    act(() => root!.render(createElement(Probe)));
    host.view({ doc: DOC, target: { kind: "note", id: "n1" } });

    await until("编辑器拿到会话", () => !!(shown as DocumentModel | null)?.collab);
    expect((shown as unknown as DocumentModel).collab).toMatchObject({
      readOnly: false,
      remote: true,
    });
    expect(useTeam.getState().sessions[DOC]?.remote).toBe(true);

    const hostSession = hostSnapshot()?.session;
    expect(hostSession).toBeDefined();
    hostSession!.insertText(hostSession!.toString().length, "\n- 张三补的");
    await until(
      "对面的字到了",
      () => useTeam.getState().sessions[DOC]?.session.toString().endsWith("张三补的") === true,
    );
    // 存盘的是对面；这边一次都没存
    await until("对面存盘", () => disk.get("n1")?.endsWith("张三补的") === true);
    expect(saved).toEqual([]);
    await host.destroy();
  });
});
