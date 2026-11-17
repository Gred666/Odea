// @vitest-environment happy-dom

import { useApp } from "@/app/store";
import type { CollabScheduler } from "@/collab/session";
import { useCurrentDocument } from "@/data/adapter";
import { useData } from "@/data/store";
import { NOTE, type NoteSummary, isShared, noteRef } from "@/data/types";
import { TeamController } from "@/team/controller";
import { createMockTeamHub } from "@/team/mockNet";
import { initTeam, resetTeam, setTeamView, teamDocId, useTeam } from "@/team/store";
import { MotionGlobalConfig } from "motion/react";
import { act, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamUnseenBanner } from "./TeamUnseenBanner";

/* ============================================================
   团队里加入一篇、本机那一版没合进会话时标题上方的提示（docs/协同编辑.md §28，审查 2026-11-15 §5.2）。

   真的数据层、真的 useCurrentDocument、真的 team/store（initTeam 接 mockNet 的 hub）；
   对面（张三，公钥小，主持）是一个 TeamController 和一块自己的磁盘。这边是李四
   ============================================================ */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
MotionGlobalConfig.skipAnimations = true;

const DOC = "笔记/周会.md";
const BASE = "# 周会\n\n- 张三：接口\n- 李四：界面";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const scheduler: CollabScheduler = {
  now: () => Date.now(),
  frame: (callback) => void setTimeout(callback, 0),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

async function until(what: string, check: () => boolean, ms = 4000) {
  for (let waited = 0; waited < ms; waited += 10) {
    if (check()) return;
    await act(() => sleep(10));
  }
  throw new Error(`等不到：${what}`);
}

let saved: string[];
let copied: string[];
let originalData: ReturnType<typeof useData.getState>;
let container: HTMLDivElement;
let root: Root | null = null;
let host: TeamController | null = null;

/** 这一台磁盘上的那一版是 local；对面主持着 hostText。base 不给 = 这一台的 git 里没有这一篇（team_base 是 null） */
async function join(local: string, hostText: string, base?: string) {
  useData.setState({ bodies: { n1: local } });
  const hub = createMockTeamHub();
  const other = hub.device("a1", "张三");
  const disk = new Map([["n1", hostText]]);
  const controller = new TeamController(
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
    { saveDelay: 10, aloneGrace: 100000, syncWait: 10 },
    scheduler,
  );
  host = controller;
  void other.net.openPipe((frame) => controller.receive(frame));
  void other.net.onControl((control) => controller.control(control));
  const mine = hub.device("b2", "李四");
  // setBase 要在这台登记以后
  if (base !== undefined) hub.setBase("b2", noteRef("n1"), base);
  await initTeam(mine.net);
  root = createRoot(container);
  act(() => root!.render(<Window />));
  controller.view({ doc: DOC, target: noteRef("n1") });
  await until("李四加入了", () => useTeam.getState().sessions[DOC]?.remote === true);
  // 加入以后那一帧的渲染
  await act(() => sleep(20));
}

/** 窗口里正文那一栏：和 Shell 一样告诉团队在看哪篇，和 DocumentView 一样把这一篇交给横幅 */
function Window() {
  const doc = useCurrentDocument();
  const target = doc.editor?.target;
  const id = teamDocId(doc);
  useEffect(() => {
    if (id && target && !isShared(target)) setTeamView({ doc: id, target });
  }, [id, target]);
  return <TeamUnseenBanner doc={doc} />;
}

const banner = () => container.querySelector<HTMLElement>("[data-team-unseen]");
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
const click = async (text: string) => {
  const found = button(text);
  expect(found, text).toBeTruthy();
  await act(async () => {
    found!.click();
  });
};

beforeEach(() => {
  originalData = useData.getState();
  saved = [];
  copied = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async (text: string) => {
        copied.push(text);
      }),
    },
  });
  const note = { id: "n1", title: "周会", relPath: DOC } as NoteSummary;
  useData.setState({
    notes: [note],
    bodies: {},
    externalRevisions: {},
    loadBody: vi.fn(async (id: string) => useData.getState().bodies[id]),
    saveDocument: vi.fn(async (target, text) => {
      if (target.type !== NOTE) return;
      saved.push(text);
      useData.setState((state) => ({ bodies: { ...state.bodies, [target.key]: text } }));
    }),
  });
  useApp.setState({ workspace: "notes", selectedNoteId: "n1" });
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
  await host?.destroy();
  host = null;
  await resetTeam();
  useData.setState(originalData, true);
});

describe("团队里加入一篇，本机那一版被换掉（§28）", () => {
  it("没有 base：出来、写着主持人的名字；「看我的那一版」是本机那一版，能切到差异、能复制", async () => {
    const local = `${BASE}\n- 李四这边写的`;
    const hostText = `${BASE}\n- 张三那边写的`;
    await join(local, hostText);
    // 编辑器里现在是对面那一版
    expect(useTeam.getState().sessions[DOC]?.session.toString()).toBe(hostText);

    const shown = banner();
    expect(shown).toBeTruthy();
    const status = shown!.querySelector('[role="status"]');
    expect(status?.textContent).toContain("你这边的版本和 张三 正在编辑的不一样");
    expect(status?.textContent).toContain("现在显示的是 张三 的；你这边的那一版还留着，不会丢。");

    const toggle = button("看我的那一版")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click("看我的那一版");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // 全文：本机那一版，只读、能选
    const full = shown!.querySelector<HTMLElement>("[data-team-unseen-text]");
    expect(full?.textContent).toBe(local);
    expect(full?.tagName).toBe("PRE");
    // 展开的那一块不在 role=status 里：展开时不把全文读一遍
    expect(status?.contains(full!)).toBe(false);

    await click("复制");
    expect(copied).toEqual([local]);
    expect(button("已复制")).toBeTruthy();

    const diffTab = [...shown!.querySelectorAll('[role="tab"]')].find(
      (tab) => tab.textContent === "差异",
    ) as HTMLElement;
    await act(async () => diffTab.click());
    const text = shown!.textContent ?? "";
    expect(text).toContain("只在你这一版里");
    expect(text).toContain("李四这边写的");
    expect(text).toContain("张三那边写的");

    // 收起
    await click("看我的那一版");
    await until(
      "收起了",
      () =>
        !shown!.querySelector("[data-team-unseen-text]") &&
        !shown!.textContent?.includes("只在你这一版里"),
    );
  });

  it("有 base、三方合撞上：也出，「看我的那一版」打开的是本机那一版", async () => {
    const local = BASE.replace("- 李四：界面", "- 李四：界面（周三前）");
    const hostText = BASE.replace("- 李四：界面", "- 李四：界面和文档");
    await join(local, hostText, BASE);
    expect(banner()?.textContent).toContain("你这边的版本和 张三 正在编辑的不一样");
    await click("看我的那一版");
    expect(banner()!.querySelector("[data-team-unseen-text]")?.textContent).toBe(local);
  });

  it("合得进去的加入：不出", async () => {
    // 两边改的地方隔开（挨着的两处改动三方合也当撞上）
    const base = `${BASE}\n\n## 下周\n- 发版`;
    const local = base.replace("- 李四：界面", "- 李四：界面（周三前）");
    await join(local, `${base}\n- 张三补的`, base);
    await until(
      "合好了",
      () => useTeam.getState().sessions[DOC]?.session.toString().includes("（周三前）") === true,
    );
    expect(banner()).toBeNull();
  });

  it("主持人走了、这边接手，本机那一版另存成冲突副本：提示收起", async () => {
    const local = `${BASE}\n- 李四这边写的`;
    const hostText = `${BASE}\n- 张三那边写的`;
    await join(local, hostText);
    expect(banner()).toBeTruthy();
    host!.view(null);
    await until("这边接手、存了会话的正文", () => saved.includes(hostText));
    await until("提示收起了", () => banner() === null);
    expect(useTeam.getState().sessions[DOC]?.remote).toBe(false);
  });

  it("「知道了」：这一次加入期间不再出；切走再回来、又加入一次，还会出", async () => {
    const local = `${BASE}\n- 李四这边写的`;
    const hostText = `${BASE}\n- 张三那边写的`;
    await join(local, hostText);
    await click("知道了");
    await until("关掉了", () => banner() === null);
    // 换一栏重新挂上（分屏换了一栏、切走又切回来那种重新渲染）：还是不出
    act(() => root!.unmount());
    root = createRoot(container);
    act(() => root!.render(<Window />));
    await act(() => sleep(30));
    expect(banner()).toBeNull();
    expect(useTeam.getState().sessions[DOC]?.remote).toBe(true);

    // 切走（会话收掉，磁盘没动）再回来：重新加入，本机那一版还是没合进去，再说一次
    setTeamView(null);
    await until("会话收掉了", () => !useTeam.getState().sessions[DOC]);
    setTeamView({ doc: DOC, target: noteRef("n1") });
    await until("又加入了", () => useTeam.getState().sessions[DOC]?.remote === true);
    await until("又出来了", () => banner() !== null);
  });
});
