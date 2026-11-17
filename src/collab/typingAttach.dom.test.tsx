// @vitest-environment happy-dom

import { useApp } from "@/app/store";
import { useCurrentDocument } from "@/data/adapter";
import { saveKeyOf, useData } from "@/data/store";
import { NOTE, type NoteSummary, isShared, noteRef } from "@/data/types";
import { MarkdownEditor, clearEditorStateCache } from "@/editor/MarkdownEditor";
import { TeamController, type TeamIO } from "@/team/controller";
import { createMockTeamHub } from "@/team/mockNet";
import { initTeam, resetTeam, setTeamView, teamDocId, useTeam } from "@/team/store";
import { EditorView } from "@codemirror/view";
import { MotionGlobalConfig } from "motion/react";
import { act, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MockNet, createMockNet } from "./mockNet";
import type { CollabScheduler } from "./session";
import { handleControl, resetCollabForTest, useCollab } from "./store";

/* ============================================================
   编辑器带着刚打的字挂上一份会话（docs/协同编辑.md §27，审查 2026-11-13 §4.36、§6.7）。

   真的数据层、真的 useCurrentDocument、真的 MarkdownEditor（doc.collab 出现时它自己换上绑定、
   注册 registerEditorFlush），团队那头是两个真的 TeamController 接 mockNet 的 hub，协作那头是
   collab/mockNet。加入、接手主持、主持一篇的那一会儿每 5ms 打一个字：一个都不能少，两边一致。
   ============================================================ */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
MotionGlobalConfig.skipAnimations = true;

const DOC = "笔记/周会.md";
const TEXT = "# 周会\n\n- 张三：接口";
const noop = () => {};
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

/** 窗口里正在写的那个编辑器：和 DocumentView 一样把 useCurrentDocument 交给 MarkdownEditor，和 Shell 一样告诉团队在看哪篇 */
function Editor() {
  const doc = useCurrentDocument();
  const editing = doc.editor?.target;
  const target = editing && !isShared(editing) ? editing : undefined;
  const id = teamDocId(doc);
  useEffect(() => {
    if (id && target) setTeamView({ doc: id, target });
  }, [id, target]);
  if (!target) return null;
  return (
    <MarkdownEditor
      initialMarkdown={doc.bodyMd}
      // 别人主持：他存，这边不存（DocumentView 的 onSave）
      onSave={(markdown) =>
        doc.collab?.remote ? Promise.resolve() : useData.getState().saveDocument(target, markdown)
      }
      outlineItems={[]}
      onOutlineHandle={noop}
      cacheKey={saveKeyOf(target)}
      collab={doc.collab?.session ?? null}
    />
  );
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function mountEditor(): EditorView {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<Editor />));
  const view = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  return view;
}

const typists: { stop(): void }[] = [];

/** 每 5ms 在光标处打一个 k（像人打字：input.type） */
function typist(view: EditorView) {
  let typed = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const keys = {
    start() {
      timer ??= setInterval(() => {
        view.dispatch({ ...view.state.replaceSelection("k"), userEvent: "input.type" });
        typed += 1;
      }, 5);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    get typed() {
      return typed;
    },
  };
  typists.push(keys);
  return keys;
}

const ks = (text: string | undefined) => (text?.match(/k/g) ?? []).length;

let originalData: ReturnType<typeof useData.getState>;
/** 读正文慢一点（一次 IPC 的来回）：加入、主持的那一会儿才打得进几个字 */
let loadDelay = 0;
/** join / becomeHost / hostDoc 读正文的那一刻 */
let onLoad: (() => void) | null = null;

beforeEach(() => {
  originalData = useData.getState();
  loadDelay = 0;
  onLoad = null;
  const note = { id: "n1", title: "周会", relPath: DOC } as NoteSummary;
  useData.setState({
    notes: [note],
    bodies: { n1: TEXT },
    drafts: {},
    externalRevisions: {},
    // 读的是开始读那一刻的（IPC 的来回在后面）
    loadBody: vi.fn(async (id: string) => {
      onLoad?.();
      const body = useData.getState().bodies[id];
      if (loadDelay) await sleep(loadDelay);
      return body;
    }),
    saveDocument: vi.fn(async (target, text) => {
      if (target.type !== NOTE) return;
      useData.setState((state) => ({ bodies: { ...state.bodies, [target.key]: text } }));
    }),
  });
  useApp.setState({ workspace: "notes", selectedNoteId: "n1" });
});

afterEach(async () => {
  for (const keys of typists.splice(0)) keys.stop();
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  await resetTeam();
  // 上一条的 hub 还有没送到的 Presence（setTimeout 0）：team/store 收控制消息的回调认的是模块里的 controller，
  // 不等它们送完，下一条新起的 controller 会收到上一条那台主持人的 Presence
  await sleep(30);
  clearEditorStateCache();
  useData.setState(originalData, true);
});

/** 对面那台：一个 controller 和一块磁盘 */
function otherDevice(hub: ReturnType<typeof createMockTeamHub>, id: string, name: string) {
  const device = hub.device(id, name);
  const disk = new Map([["n1", TEXT]]);
  const io: TeamIO = {
    flush: async () => {},
    load: async () => disk.get("n1"),
    save: async (_target, text) => {
      disk.set("n1", text);
    },
    onExternal: () => () => {},
  };
  const controller = new TeamController(
    device.net,
    device.self(),
    io,
    () => {},
    { saveDelay: 10, aloneGrace: 100000 },
    scheduler,
  );
  void device.net.openPipe((frame) => controller.receive(frame));
  void device.net.onControl((control) => controller.control(control));
  return { controller, disk, session: () => controller.snapshot().sessions[DOC]?.session };
}

describe("团队仓库：我正打着字，同事开了同一篇（§4.36）", { timeout: 15000 }, () => {
  it("有 base：加入的那一会儿打的字一个不少，两边一致", async () => {
    const hub = createMockTeamHub();
    // 对面公钥小：他主持，我去加入
    const other = otherDevice(hub, "a1", "张三");
    const mine = hub.device("b2", "李四");
    hub.setBase("b2", noteRef("n1"), TEXT);
    await initTeam(mine.net);
    const view = mountEditor();
    const keys = typist(view);
    keys.start();
    await act(() => sleep(30));

    other.controller.view({ doc: DOC, target: noteRef("n1") });
    await until("做客、编辑器绑上会话", () => useTeam.getState().sessions[DOC]?.remote === true);
    await act(() => sleep(40));
    keys.stop();

    const mineSession = () => useTeam.getState().sessions[DOC]?.session;
    await until(
      "两边一致",
      () =>
        view.state.doc.toString() === mineSession()?.toString() &&
        view.state.doc.toString() === other.session()?.toString() &&
        other.disk.get("n1") === view.state.doc.toString(),
    );
    expect(keys.typed).toBeGreaterThan(10);
    expect(ks(view.state.doc.toString())).toBe(keys.typed);
    expect(view.state.doc.toString()).toBe(`${TEXT}${"k".repeat(keys.typed)}`);
    await other.controller.destroy();
  });

  it("没有 base（team_base 是 null）：加入的那一会儿打的字一个不少，两边一致", async () => {
    const hub = createMockTeamHub();
    const other = otherDevice(hub, "a1", "张三");
    const mine = hub.device("b2", "李四");
    await initTeam(mine.net);
    const view = mountEditor();
    const keys = typist(view);
    // 加入读本机正文的那一刻开始打（之前本机和对方一样：没有 base 也不用合）
    onLoad = () => keys.start();

    other.controller.view({ doc: DOC, target: noteRef("n1") });
    await until("做客、编辑器绑上会话", () => useTeam.getState().sessions[DOC]?.remote === true);
    await act(() => sleep(40));
    keys.stop();

    const mineSession = () => useTeam.getState().sessions[DOC]?.session;
    await until(
      "两边一致",
      () =>
        view.state.doc.toString() === mineSession()?.toString() &&
        view.state.doc.toString() === other.session()?.toString() &&
        other.disk.get("n1") === view.state.doc.toString(),
    );
    expect(keys.typed).toBeGreaterThan(10);
    expect(view.state.doc.toString()).toBe(`${TEXT}${"k".repeat(keys.typed)}`);
    await other.controller.destroy();
  });

  it("轮到我主持（becomeHost）：读正文到挂上会话之间打的字一个不少，对方也有", async () => {
    const hub = createMockTeamHub();
    // 我公钥小：我主持
    const mine = hub.device("a0", "李四");
    const other = otherDevice(hub, "b9", "张三");
    await initTeam(mine.net);
    const view = mountEditor();
    const keys = typist(view);
    loadDelay = 40;
    onLoad = () => keys.start();

    other.controller.view({ doc: DOC, target: noteRef("n1") });
    await until("主持、编辑器绑上会话", () => useTeam.getState().sessions[DOC]?.remote === false);
    await act(() => sleep(40));
    keys.stop();

    const mineSession = () => useTeam.getState().sessions[DOC]?.session;
    await until(
      "两边一致、存下了",
      () =>
        view.state.doc.toString() === mineSession()?.toString() &&
        view.state.doc.toString() === other.session()?.toString() &&
        useData.getState().bodies.n1 === view.state.doc.toString(),
    );
    expect(keys.typed).toBeGreaterThan(5);
    expect(view.state.doc.toString()).toBe(`${TEXT}${"k".repeat(keys.typed)}`);
    await other.controller.destroy();
  });
});

describe("挂上之前编辑器自己又防抖存了一次", { timeout: 15000 }, () => {
  it("接手主持时读正文很慢、中间停下来过（存了一次）：字一个不少、不重复，磁盘上是全的", async () => {
    const hub = createMockTeamHub();
    const mine = hub.device("a0", "李四");
    const other = otherDevice(hub, "b9", "张三");
    await initTeam(mine.net);
    const view = mountEditor();
    const keys = typist(view);
    const saveDocument = vi.mocked(useData.getState().saveDocument);
    loadDelay = 700;
    onLoad = () => {
      // 打几个、停下来（防抖 400ms 到点存一次）、再接着打
      keys.start();
      setTimeout(() => keys.stop(), 40);
      setTimeout(() => keys.start(), 520);
    };

    other.controller.view({ doc: DOC, target: noteRef("n1") });
    await until("主持、编辑器绑上会话", () => useTeam.getState().sessions[DOC]?.remote === false);
    await act(() => sleep(40));
    keys.stop();
    // 读正文以后、挂上之前，编辑器自己存过一次（不是会话存的）
    const before = saveDocument.mock.calls.length;
    expect(before).toBeGreaterThan(0);

    const mineSession = () => useTeam.getState().sessions[DOC]?.session;
    await until(
      "两边一致、存下了",
      () =>
        view.state.doc.toString() === mineSession()?.toString() &&
        view.state.doc.toString() === other.session()?.toString() &&
        useData.getState().bodies.n1 === view.state.doc.toString(),
    );
    expect(keys.typed).toBeGreaterThan(5);
    expect(view.state.doc.toString()).toBe(`${TEXT}${"k".repeat(keys.typed)}`);
    await other.controller.destroy();
  });
});

describe("邀请协作：访客来开我正在写的那篇（hostDoc）", { timeout: 15000 }, () => {
  let net: MockNet;

  beforeEach(() => {
    net = createMockNet({ speed: 0.002, bots: false });
    resetCollabForTest(net);
  });

  afterEach(async () => {
    const store = useCollab.getState();
    for (const id of [...store.order]) await store.stop(id);
    resetCollabForTest(null);
  });

  it("存盘、读正文到挂上会话之间打的字一个不少，访客也有", async () => {
    await net.onControl(handleControl);
    const view = mountEditor();
    const keys = typist(view);
    loadDelay = 40;
    onLoad = () => keys.start();

    const store = () => useCollab.getState();
    const started = store().startHosting("n1", "周会");
    await until("编辑器绑上会话", () => !!store().hostedDocs.n1);
    await started;
    await act(() => sleep(40));
    keys.stop();

    const id = store().order.at(-1)!;
    await until("加入请求", () => store().sessions[id]!.requests.length === 1);
    await store().answer(id, 1, "edit");
    const session = () => store().hostedDocs.n1;
    await until(
      "两边一致",
      () =>
        view.state.doc.toString() === session()?.toString() &&
        net.remoteText() === view.state.doc.toString(),
    );
    expect(keys.typed).toBeGreaterThan(5);
    expect(view.state.doc.toString()).toBe(`${TEXT}${"k".repeat(keys.typed)}`);
  });
});
