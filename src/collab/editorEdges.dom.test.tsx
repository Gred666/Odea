// @vitest-environment happy-dom

import { MarkdownEditor, clearEditorStateCache, typoraDecorations } from "@/editor/MarkdownEditor";
import { foldedHeads, setFoldedHeadings } from "@/editor/headingFold";
import { markdownSupport } from "@/editor/markdownParser";
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MotionGlobalConfig } from "motion/react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { collab } from "./binding";
import { LoopbackHub, type LoopbackMember, ManualScheduler } from "./loopback";
import { CollabSession, type Peer, peerColor } from "./session";

/* ============================================================
   协作和编辑器现有机制的交界（docs/协同编辑.md §4.3 的表、§13「编辑器边角」）。
   组字、撤销、远端光标在 binding.dom.test.ts；外部改动在 external.dom.test.ts。
   ============================================================ */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
MotionGlobalConfig.skipAnimations = true;

const peer = (id: string): Peer => ({ id, name: id, color: peerColor(id) });
const hubs: LoopbackHub[] = [];
const views: EditorView[] = [];
const roots: { root: Root; container: HTMLElement }[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  for (const hub of hubs.splice(0)) hub.destroy();
  clearEditorStateCache();
  document.body.replaceChildren();
});

function room(text: string) {
  const scheduler = new ManualScheduler();
  const hub = new LoopbackHub({ scheduler });
  hubs.push(hub);
  return { scheduler, hub, host: hub.host(peer("host"), text), guest: hub.join(peer("guest")) };
}

/** 和真编辑器一样带 Markdown 解析、块级装饰、撤销 */
function mount(member: LoopbackMember) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: member.session.toString(),
      selection: { anchor: member.session.toString().length },
      extensions: [markdownSupport(), typoraDecorations, history(), collab(member.session)],
    }),
  });
  views.push(view);
  return { parent, view };
}

describe("标题收起", () => {
  it("别人改了你收起的那一节：照样收着，位置跟着挪", async () => {
    const { scheduler, host, guest } = room("# 一\n\n第一节的正文\n\n# 二\n\n第二节");
    const a = mount(host);
    const b = mount(guest);
    a.view.dispatch({ effects: setFoldedHeadings.of([0]) });
    expect(foldedHeads(a.view.state)).toEqual([0]);

    // 访客在收起的那一节里改字
    const inside = b.view.state.doc.toString().indexOf("的正文");
    b.view.dispatch({ changes: { from: inside, insert: "（访客改）" }, userEvent: "input.type" });
    await scheduler.advance(20);
    expect(a.view.state.doc.toString()).toContain("第一节（访客改）的正文");
    expect(foldedHeads(a.view.state)).toEqual([0]);

    // 访客在最前面加了一段：收起的标题跟着往后挪，还是收着
    b.view.dispatch({ changes: { from: 0, insert: "前言\n\n" }, userEvent: "input.type" });
    await scheduler.advance(20);
    expect(foldedHeads(a.view.state)).toEqual([4]);
    expect(a.view.state.doc.sliceString(4, 7)).toBe("# 一");
  });
});

describe("表格格子", () => {
  const source = "| 名字 | 状态 |\n|---|---|\n| 甲 | ok |\n\n后";
  const cellAt = (parent: HTMLElement, row: number, col: number) =>
    parent.querySelector<HTMLTableCellElement>(`[data-row="${row}"][data-col="${col}"]`)!;
  /** 格子里的子编辑器（editor/cellEditor.ts） */
  const fieldOf = (cell: HTMLElement) =>
    EditorView.findFromDOM(cell.querySelector<HTMLElement>(".cm-editor")!)!;
  const textOf = (cell: HTMLElement) => fieldOf(cell).state.doc.toString();
  const offsetIn = (cell: HTMLElement) => fieldOf(cell).state.selection.main.head;
  const place = (cell: HTMLElement, offset: number) =>
    fieldOf(cell).dispatch({ selection: { anchor: offset } });
  /** 焦点在这一格里（子编辑器的可编辑区） */
  const focusedIn = (cell: HTMLElement) => cell.contains(document.activeElement);
  const typeIn = (cell: HTMLElement, text: string) => {
    const field = fieldOf(cell);
    field.dispatch({
      changes: { from: 0, to: field.state.doc.length, insert: text },
      selection: { anchor: text.length },
      userEvent: "input.type",
    });
  };

  it("格子里正在编辑时别人改了同一张表：不丢焦点，光标按改动挪", async () => {
    const { scheduler, host, guest } = room(source);
    const a = mount(host);
    const b = mount(guest);
    const cell = cellAt(a.parent, 1, 0);
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(cell.classList.contains("is-editing")).toBe(true);
    typeIn(cell, "甲乙丙");
    place(cell, 1);
    await scheduler.advance(20);

    // 访客改了同一行的另一格
    const ok = b.view.state.doc.toString().indexOf("ok");
    b.view.dispatch({ changes: { from: ok, to: ok + 2, insert: "完成" }, userEvent: "input.type" });
    await scheduler.advance(20);
    expect(a.view.state.doc.line(3).text).toBe("| 甲乙丙 | 完成 |");
    expect(cell.classList.contains("is-editing")).toBe(true);
    expect(focusedIn(cell)).toBe(true);
    expect(textOf(cell)).toBe("甲乙丙");
    expect(offsetIn(cell)).toBe(1);

    // 访客在这一格的最前面加了字：光标跟着往后挪一格，还在「甲」后面
    const at = b.view.state.doc.toString().indexOf("甲乙丙");
    b.view.dispatch({ changes: { from: at, insert: "零" }, userEvent: "input.type" });
    await scheduler.advance(20);
    expect(textOf(cell)).toBe("零甲乙丙");
    expect(offsetIn(cell)).toBe(2);
    expect(focusedIn(cell)).toBe(true);
  });

  it("格子里打一个字只发这一个字：别人同时在这格里打的字不会被整格覆盖", async () => {
    const { scheduler, host, guest } = room(source);
    const a = mount(host);
    const b = mount(guest);
    const cell = cellAt(a.parent, 1, 0);
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    const received: string[] = [];
    const before = b.view.state.doc.length;
    typeIn(cell, "甲！");
    // 同一时刻访客在这一格最前面打了一个字（还没到主持人那边）
    const at = b.view.state.doc.toString().indexOf("甲");
    b.view.dispatch({ changes: { from: at, insert: "零" }, userEvent: "input.type" });
    await scheduler.advance(50);
    received.push(a.view.state.doc.line(3).text, b.view.state.doc.line(3).text);
    expect(received).toEqual(["| 零甲！ | ok |", "| 零甲！ | ok |"]);
    expect(b.view.state.doc.length).toBe(before + 2);
  });

  it("正在编辑的格子上面别人插了一行 / 删了一行：格子跟着自己那一行走，不变成别的行", async () => {
    const two = "| 名字 | 状态 |\n|---|---|\n| 甲 | ok |\n| 乙 | 待定 |\n\n后";
    const { scheduler, host, guest } = room(two);
    const a = mount(host);
    const b = mount(guest);
    const cell = cellAt(a.parent, 2, 0);
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(textOf(cell)).toBe("乙");
    place(cell, 1);

    // 访客在「甲」上面插了一行：正在编辑的「乙」挪到第 3 行，还是同一个格子、还在编辑
    const first = b.view.state.doc.line(3).from;
    b.view.dispatch({ changes: { from: first, insert: "| 丙 | 新 |\n" }, userEvent: "input.type" });
    await scheduler.advance(20);
    expect(a.view.state.doc.line(5).text).toBe("| 乙 | 待定 |");
    expect(cellAt(a.parent, 3, 0)).toBe(cell);
    expect(textOf(cell)).toBe("乙");
    expect(cell.classList.contains("is-editing")).toBe(true);
    expect(focusedIn(cell)).toBe(true);
    expect(offsetIn(cell)).toBe(1);
    expect(cellAt(a.parent, 1, 0).textContent).toBe("丙");
    expect(cellAt(a.parent, 2, 0).textContent).toBe("甲");
    // 接着打字：改的是「乙」那一行
    typeIn(cell, "乙二");
    await scheduler.advance(20);
    expect(b.view.state.doc.line(5).text).toBe("| 乙二 | 待定 |");
    expect(b.view.state.doc.line(4).text).toBe("| 甲 | ok |");

    // 访客把「丙」那一行删了：格子跟着回到第 2 行
    const line = b.view.state.doc.line(3);
    b.view.dispatch({ changes: { from: line.from, to: line.to + 1 }, userEvent: "delete" });
    await scheduler.advance(20);
    expect(cellAt(a.parent, 2, 0)).toBe(cell);
    expect(textOf(cell)).toBe("乙二");
    expect(focusedIn(cell)).toBe(true);
    expect(cellAt(a.parent, 1, 0).textContent).toBe("甲");
  });

  it("正在编辑的格子左边别人插了一列：格子跟着自己那一列走", async () => {
    const { scheduler, host, guest } = room(source);
    const a = mount(host);
    const b = mount(guest);
    const cell = cellAt(a.parent, 1, 1);
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(textOf(cell)).toBe("ok");
    // 访客把表改成三列：最前面加了一列「序号」
    const doc = b.view.state.doc;
    b.view.dispatch({
      changes: [
        { from: doc.line(1).from, insert: "| 序号 " },
        { from: doc.line(2).from, insert: "|---" },
        { from: doc.line(3).from, insert: "| 1 " },
      ],
      userEvent: "input.type",
    });
    await scheduler.advance(20);
    expect(a.view.state.doc.line(3).text).toBe("| 1 | 甲 | ok |");
    expect(cellAt(a.parent, 1, 2)).toBe(cell);
    expect(textOf(cell)).toBe("ok");
    expect(focusedIn(cell)).toBe(true);
    expect(cellAt(a.parent, 1, 0).textContent).toBe("1");
  });

  // 格子里的子编辑器（editor/cellEditor.ts）组字时不写回正文：拼音不发给别人；
  // 别人这时改了同一格也先不跟（免得打断输入法），组完字两边的改动合到一起
  it("格子里组字：拼音不进正文；别人同时改了这一格，组完字两边的字都在", async () => {
    const { scheduler, host, guest } = room(source);
    const a = mount(host);
    const b = mount(guest);
    const cell = cellAt(a.parent, 1, 0);
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    const field = fieldOf(cell);
    field.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(field.compositionStarted).toBe(true);
    // 输入法往「甲」后面写拼音
    field.dispatch({
      changes: { from: 1, insert: "ni" },
      selection: { anchor: 3 },
      userEvent: "input.type.compose",
    });
    await scheduler.advance(20);
    expect(a.view.state.doc.line(3).text).toBe("| 甲 | ok |");
    expect(b.view.state.doc.line(3).text).toBe("| 甲 | ok |");

    // 访客这时在这一格最前面打了字：正文里有了，格子里先不动
    const at = b.view.state.doc.toString().indexOf("甲");
    b.view.dispatch({ changes: { from: at, insert: "零" }, userEvent: "input.type" });
    await scheduler.advance(20);
    expect(a.view.state.doc.line(3).text).toBe("| 零甲 | ok |");
    expect(textOf(cell)).toBe("甲ni");

    // 上屏，组字结束：两边的字都在，光标还在刚打的字后面
    field.dispatch({
      changes: { from: 1, to: 3, insert: "你" },
      selection: { anchor: 2 },
      userEvent: "input.type.compose",
    });
    field.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await scheduler.advance(20);
    expect(a.view.state.doc.line(3).text).toBe("| 零甲你 | ok |");
    expect(b.view.state.doc.line(3).text).toBe("| 零甲你 | ok |");
    expect(textOf(cell)).toBe("零甲你");
    expect(offsetIn(cell)).toBe(3);
  });
});

describe("MarkdownEditor", () => {
  // 回调要稳定：onOutlineHandle 在编辑器那个 effect 的依赖里，换一个就整个重建（真应用里也是稳定的）
  const onOutlineHandle = () => {};
  const onSave = async () => {};
  const outlineItems: never[] = [];
  const linkTargets = [{ id: "n1", title: "周会记录", folder: "", archived: false }];
  function render(
    props: Partial<Parameters<typeof MarkdownEditor>[0]> & { initialMarkdown: string },
  ) {
    let entry = roots[0];
    if (!entry) {
      const container = document.createElement("div");
      document.body.append(container);
      entry = { root: createRoot(container), container };
      roots.push(entry);
    }
    act(() =>
      entry!.root.render(
        <MarkdownEditor
          onSave={onSave}
          outlineItems={outlineItems}
          onOutlineHandle={onOutlineHandle}
          {...props}
        />,
      ),
    );
    const editor = entry.container.querySelector<HTMLElement>(".cm-editor")!;
    return EditorView.findFromDOM(editor)!;
  }

  it("协作中：正文以会话为准，外部回填不管，切走不进缓存", async () => {
    const { scheduler, host, guest } = room("会话里的正文");
    let view = render({ initialMarkdown: "旧的", cacheKey: "note:x", collab: host.session });
    expect(view.state.doc.toString()).toBe("会话里的正文");
    // 上层把 initialMarkdown 换了（外部改动回填）：协作中不整篇替换
    view = render({
      initialMarkdown: "外部的",
      cacheKey: "note:x",
      externalRevision: 1,
      collab: host.session,
    });
    expect(view.state.doc.toString()).toBe("会话里的正文");

    // 切走期间访客改了；切回来是会话现在的正文（没用缓存里的旧状态）
    act(() => roots[0]!.root.render(null));
    guest.session.insertText(0, "访客：");
    await scheduler.advance(20);
    view = render({ initialMarkdown: "会话里的正文", cacheKey: "note:x", collab: host.session });
    expect(view.state.doc.toString()).toBe("访客：会话里的正文");
  });

  it("编辑器开着时开始协作：之前的撤销记录还在，撤销也同步出去", async () => {
    let view = render({ initialMarkdown: "正文" });
    view.dispatch({ changes: { from: 2, insert: "，写了一句" }, userEvent: "input.type" });
    // 主持人点「邀请协作」：拿编辑器里现在的正文建会话
    const scheduler = new ManualScheduler();
    const hub = new LoopbackHub({ scheduler });
    hubs.push(hub);
    const host = hub.host(peer("host"), view.state.doc.toString());
    const guest = hub.join(peer("guest"));
    view = render({ initialMarkdown: "正文", collab: host.session });
    undo(view);
    await scheduler.advance(20);
    expect(view.state.doc.toString()).toBe("正文");
    expect(guest.session.toString()).toBe("正文");

    // 结束协作：编辑器照常用
    view = render({ initialMarkdown: "正文", collab: null });
    view.dispatch({ changes: { from: 2, insert: "！" }, userEvent: "input.type" });
    await scheduler.advance(20);
    expect(guest.session.toString()).toBe("正文");
  });

  it("「[[」菜单开着时别人在前面加了字：菜单还是这一个，不收起", async () => {
    const { scheduler, host, guest } = room("前面一段\n\n");
    const view = render({
      initialMarkdown: "",
      collab: host.session,
      linkTargets,
    });
    view.focus();
    const end = view.state.doc.length;
    act(() => {
      view.dispatch({
        changes: { from: end, insert: "[[" },
        selection: { anchor: end + 2 },
        userEvent: "input.type",
      });
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    guest.session.insertText(0, "访客在最前面加了一行\n");
    await act(() => scheduler.advance(20));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(view.state.doc.toString()).toBe("访客在最前面加了一行\n前面一段\n\n[[");
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    // 接着打字是在筛选：菜单认的还是挪过去的那个触发词
    act(() => {
      const at = view.state.doc.length;
      view.dispatch({
        changes: { from: at, insert: "周" },
        selection: { anchor: at + 1 },
        userEvent: "input.type",
      });
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain("周会记录");
  });
});

// 单独建的会话（不经模拟网络）也能挂编辑器：主持人开始协作前没有任何访客
it("没有访客时会话照样能挂编辑器", () => {
  const session = new CollabSession({
    self: peer("solo"),
    initialText: "一个人",
    transport: { sendUpdate: () => {}, sendCursor: () => {} },
  });
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: session.toString(), extensions: [collab(session)] }),
  });
  views.push(view);
  view.dispatch({ changes: { from: 3, insert: "写" } });
  expect(session.toString()).toBe("一个人写");
  session.destroy();
});
