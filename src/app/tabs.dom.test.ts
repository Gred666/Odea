// @vitest-environment happy-dom

import { useData } from "@/data/store";
import { beforeEach, describe, expect, it } from "vitest";
import { openDocument, selectNeighbor } from "./navigate";
import { emptyLayout, newPane } from "./panes";
import { initPreferences, restoreVaultSession, useApp } from "./store";

/*
 * 笔记的窗格和标签（docs/标签页与分屏.md §4、§6、§12）：正在写的窗格的当前标签就是 selectedNoteId；
 * 点列表换当前标签里的那一篇，Ctrl+点击开新标签，一个窗格里不重复；关、开回来、拆分、挪、往回走、
 * 对账、按仓库记在本机。
 */

/** 每个窗格的笔记，当前标签带 *，正在写的窗格带 > */
const layout = () => {
  const { notePanes, activePane } = useApp.getState();
  return notePanes.map(
    (pane) =>
      (pane.id === activePane ? ">" : "") +
      pane.tabs.map((tab) => tab.noteId + (tab.id === pane.activeTab ? "*" : "")).join(" "),
  );
};
const selected = () => {
  const { notePanes, activePane, selectedNoteId } = useApp.getState();
  const pane = notePanes.find((other) => other.id === activePane)!;
  // 不变式：正在写的窗格的当前标签就是选中的那篇
  expect(pane.tabs.find((tab) => tab.id === pane.activeTab)?.noteId).toBe(selectedNoteId);
  return selectedNoteId;
};
const tabOf = (noteId: string, paneIndex = 0) =>
  useApp.getState().notePanes[paneIndex]!.tabs.find((tab) => tab.noteId === noteId)!;
const paneId = (index: number) => useApp.getState().notePanes[index]!.id;

/** 一个窗格，依次开着这几篇，当前是最后一篇 */
function start(...ids: string[]) {
  const [first, ...rest] = ids;
  const fresh = emptyLayout(first ?? "");
  useApp.setState({
    workspace: "notes",
    notePanes: fresh.panes,
    activePane: fresh.activePane,
    selectedNoteId: first ?? "",
    popouts: [],
    activePopout: null,
  });
  for (const id of rest) useApp.getState().openNoteTab(id);
}

/** 弹出窗口里的笔记，当前标签带 *，正在写的那个带 > */
const popouts = () => {
  const { popouts: panes, activePopout } = useApp.getState();
  return panes.map(
    (pane) =>
      (pane.id === activePopout ? ">" : "") +
      pane.tabs.map((tab) => tab.noteId + (tab.id === pane.activeTab ? "*" : "")).join(" "),
  );
};
/** 像 app/popout.ts 那样：主窗口里的这一篇拆成弹出窗口，返回弹出窗口的窗格 id */
const popOut = (noteId: string) => {
  const tab = tabOf(noteId);
  const pane = newPane([tab]);
  useApp.getState().addPopout(pane, tab.id);
  return pane.id;
};
const popTab = (noteId: string, index = 0) =>
  useApp.getState().popouts[index]!.tabs.find((tab) => tab.noteId === noteId)!;

beforeEach(() => {
  start("a");
});

describe("note tabs", () => {
  it("opens a clicked note in the current tab, or switches to the tab that has it", () => {
    useApp.getState().selectNote("b");
    expect(layout()).toEqual([">b*"]);
    useApp.getState().openNoteTab("c");
    useApp.getState().selectNote("b");
    expect(layout()).toEqual([">b* c"]);
    expect(selected()).toBe("b");
  });

  it("opens a new tab right after the current one and switches to it", () => {
    start("a", "b", "c");
    useApp.getState().switchTab(tabOf("a").id);
    useApp.getState().openNoteTab("d");
    expect(layout()).toEqual([">a d* b c"]);
    useApp.getState().openNoteTab("c");
    expect(layout()).toEqual([">a d b c*"]);
    expect(selected()).toBe("c");
  });

  it("fills the empty tab of a new vault instead of opening a second one", () => {
    start("");
    useApp.getState().openNoteTab("a");
    expect(layout()).toEqual([">a*"]);
    expect(selected()).toBe("a");
  });

  it("closes to the right neighbour, then the left, and never closes the last tab", () => {
    start("a", "b", "c");
    useApp.getState().switchTab(tabOf("b").id);
    useApp.getState().closeTab(tabOf("b").id);
    expect(layout()).toEqual([">a c*"]);
    useApp.getState().closeTab(tabOf("c").id);
    expect(layout()).toEqual([">a*"]);
    useApp.getState().closeTab(tabOf("a").id);
    expect(layout()).toEqual([">a*"]);
  });

  it("closes the others, or the ones to the right", () => {
    start("a", "b", "c", "d");
    useApp.getState().closeTabsToRight(tabOf("b").id);
    expect(layout()).toEqual([">a b*"]);
    useApp.getState().closeOtherTabs(tabOf("a").id);
    expect(layout()).toEqual([">a*"]);
  });

  it("reopens closed tabs where they were, skipping notes that are gone", () => {
    start("a", "b", "c");
    useApp.getState().closeTab(tabOf("b").id);
    useApp.getState().closeTab(tabOf("c").id);
    useApp.getState().reopenTab((id) => id !== "c");
    expect(layout()).toEqual([">a b*"]);
  });

  it("reorders inside a pane", () => {
    start("a", "b", "c");
    useApp.getState().moveTab(tabOf("c").id, paneId(0), 0);
    expect(layout()).toEqual([">c* a b"]);
  });

  it("drops tabs whose notes are gone and falls back to a neighbour", () => {
    start("a", "b", "c");
    useApp.getState().switchTab(tabOf("b").id);
    useApp.getState().pruneTabs(new Set(["a", "c"]));
    expect(layout()).toEqual([">a c*"]);
    useApp.getState().pruneTabs(new Set());
    expect(layout()).toEqual([">*"]);
    expect(selected()).toBe("");
  });

  it("closes the tab of a deleted note instead of moving to the list neighbour", () => {
    start("a", "b");
    selectNeighbor("b");
    expect(layout()).toEqual([">a*"]);
  });
});

describe("note panes", () => {
  it("splits a copy of the current note to the right and focuses it", () => {
    start("a", "b");
    useApp.getState().splitTab(tabOf("b").id, paneId(0), "right", true);
    expect(layout()).toEqual(["a b*", ">b*"]);
    expect(selected()).toBe("b");
    // 新的一栏分走一半
    expect(useApp.getState().notePanes.map((pane) => pane.size)).toEqual([0.5, 0.5]);
  });

  it("moves a dragged tab into a new pane, and closes the pane it left empty", () => {
    start("a", "b");
    useApp.getState().splitTab(tabOf("b").id, paneId(0), "left", false);
    expect(layout()).toEqual([">b*", "a*"]);
    // 一个窗格里唯一的标签拖到自己边上：不拆
    useApp.getState().splitTab(tabOf("b").id, paneId(0), "right", false);
    expect(layout()).toEqual([">b*", "a*"]);
    // 挪进另一个窗格：空了的窗格关掉，地方给旁边的
    useApp.getState().moveTab(tabOf("b").id, paneId(1), 1);
    expect(layout()).toEqual([">a b*"]);
    expect(useApp.getState().notePanes[0]!.size).toBe(1);
  });

  it("opens a clicked note in the pane being written in", () => {
    start("a");
    useApp.getState().splitTab(tabOf("a").id, paneId(0), "right", true);
    useApp.getState().focusPane(paneId(0));
    useApp.getState().selectNote("c");
    expect(layout()).toEqual([">c*", "a*"]);
    expect(selected()).toBe("c");
    // 别的窗格里开着 a，这个窗格里没有：照样在这里打开（同一篇可以开在两个窗格里）
    useApp.getState().selectNote("a");
    expect(layout()).toEqual([">a*", "a*"]);
  });

  it("closing the last tab of a pane closes the pane", () => {
    start("a");
    useApp.getState().splitTab(tabOf("a").id, paneId(0), "right", true);
    useApp.getState().closeTab(tabOf("a", 1).id);
    expect(layout()).toEqual([">a*"]);
  });

  it("stops at three panes", () => {
    start("a");
    for (let i = 0; i < 4; i++) {
      useApp.getState().splitTab(tabOf("a").id, paneId(0), "right", true);
    }
    expect(useApp.getState().notePanes).toHaveLength(3);
  });

  it("walks back and forward inside a tab", () => {
    start("a");
    useApp.getState().selectNote("b");
    useApp.getState().selectNote("c");
    const alive = () => true;
    useApp.getState().walkTab(-1, alive);
    expect(selected()).toBe("b");
    useApp.getState().walkTab(-1, alive);
    expect(selected()).toBe("a");
    useApp.getState().walkTab(-1, alive);
    expect(selected()).toBe("a");
    useApp.getState().walkTab(1, alive);
    expect(selected()).toBe("b");
    // 往回走到一半又点了别的：往前的那一截没了
    useApp.getState().selectNote("d");
    useApp.getState().walkTab(1, alive);
    expect(selected()).toBe("d");
    // 删掉了的跳过
    useApp.getState().walkTab(-1, (id) => id !== "b");
    expect(selected()).toBe("a");
  });

  it("remembers the panes per vault and brings them back", () => {
    initPreferences();
    restoreVaultSession("D:/库", false);
    start("a", "b");
    useApp.getState().splitTab(tabOf("b").id, paneId(0), "right", true);
    useApp.getState().resizePanes([0.6, 0.4]);
    useApp.getState().focusPane(paneId(0));
    const raw = localStorage.getItem("odea.session:D:/库") ?? "{}";
    const saved = JSON.parse(raw);
    expect(saved.noteId).toBe("b");
    expect(saved.layout).toEqual({
      panes: [
        { tabs: ["a", "b"], active: 1, size: 0.6 },
        { tabs: ["b"], active: 0, size: 0.4 },
      ],
      pane: 0,
    });

    // 下次打开窗口：从记下的那份恢复
    start("x");
    localStorage.setItem("odea.session:D:/库", raw);
    restoreVaultSession("D:/库", false);
    expect(layout()).toEqual([">a b*", "b*"]);
    expect(selected()).toBe("b");
  });

  it("reads the tabs P12.1 wrote as one pane", () => {
    initPreferences();
    restoreVaultSession("D:/旧", false);
    start("x");
    localStorage.setItem(
      "odea.session:D:/旧",
      JSON.stringify({ workspace: "notes", noteId: "b", tabs: ["a", "b", "c"] }),
    );
    restoreVaultSession("D:/旧", false);
    expect(layout()).toEqual([">a b* c"]);
  });
});

describe("popout windows", () => {
  it("takes the tab out of the main window; the main window keeps showing what it showed", () => {
    start("a", "b", "c");
    useApp.getState().switchTab(tabOf("a").id);
    popOut("b");
    expect(layout()).toEqual([">a* c"]);
    expect(popouts()).toEqual([">b*"]);
    expect(selected()).toBe("a");
  });

  it("routes tab actions to the window the tab is in; closing its last tab closes the window", () => {
    start("a", "b");
    const pane = popOut("b");
    useApp.getState().openNoteTab("c", pane);
    useApp.getState().openNoteTab("d", pane);
    expect(popouts()).toEqual([">b c d*"]);
    useApp.getState().switchTab(popTab("b").id);
    useApp.getState().moveTab(popTab("d").id, pane, 0);
    expect(popouts()).toEqual([">d b* c"]);
    useApp.getState().closeOtherTabs(popTab("b").id);
    expect(popouts()).toEqual([">b*"]);
    // 跨窗口挪、在弹出窗口里拆分：不动
    useApp.getState().moveTab(popTab("b").id, paneId(0), 0);
    useApp.getState().splitTab(popTab("b").id, pane, "right", true);
    expect(popouts()).toEqual([">b*"]);
    expect(layout()).toEqual([">a*"]);
    useApp.getState().closeTab(popTab("b").id);
    expect(popouts()).toEqual([]);
    expect(useApp.getState().activePopout).toBeNull();
    expect(layout()).toEqual([">a*"]);
    // 关掉的照样能开回来：开在正在写的那个窗口里（这时是主窗口），放在它在原来那一排里的位置
    useApp.getState().reopenTab(() => true);
    expect(layout()).toEqual([">b* a"]);
  });

  it("opens notes from the popout's own text in the popout, and walks back there", () => {
    start("a", "b");
    useData.setState({ bodies: { a: "", b: "", c: "" }, archived: [] });
    popOut("b");
    openDocument({ kind: "note", id: "c" });
    expect(popouts()).toEqual([">c*"]);
    expect(layout()).toEqual([">a*"]);
    useApp.getState().walkTab(-1, () => true, useApp.getState().activePopout!);
    expect(popouts()).toEqual([">b*"]);
    // 回到主窗口：列表、搜索打开的照旧在主窗口
    useApp.getState().setActivePopout(null);
    openDocument({ kind: "note", id: "c" });
    expect(layout()).toEqual([">c*"]);
    expect(popouts()).toEqual(["b*"]);
  });

  it("closing the window brings its tabs back without switching the main window", () => {
    start("a", "b", "c");
    useApp.getState().switchTab(tabOf("a").id);
    const pane = popOut("b");
    useApp.getState().openNoteTab("a", pane);
    useApp.getState().openNoteTab("d", pane);
    useApp.getState().removePopout(pane, true);
    // a 主窗口里已经开着，不重复
    expect(layout()).toEqual([">a* c b d"]);
    expect(popouts()).toEqual([]);
    expect(selected()).toBe("a");
  });

  it("the only tab of the main window can go; its tabs come back into the empty main window", () => {
    start("a");
    const pane = popOut("a");
    expect(layout()).toEqual([">*"]);
    useApp.getState().removePopout(pane, true);
    expect(layout()).toEqual([">a*"]);
    expect(selected()).toBe("a");
  });

  it("moves one tab back to the main window and switches to it there", () => {
    start("a", "b", "c");
    const pane = popOut("c");
    useApp.getState().openNoteTab("d", pane);
    useApp.getState().tabToMain(popTab("d").id);
    expect(layout()).toEqual([">a b d*"]);
    expect(popouts()).toEqual([">c*"]);
    useApp.getState().tabToMain(popTab("c").id);
    expect(popouts()).toEqual([]);
    expect(layout()).toEqual([">a b d c*"]);
  });

  it("drops popout tabs of notes that are gone, and the window when nothing is left", () => {
    start("a", "b", "c");
    const pane = popOut("b");
    useApp.getState().openNoteTab("c", pane);
    useApp.getState().pruneTabs(new Set(["a", "b"]));
    expect(popouts()).toEqual([">b*"]);
    useApp.getState().pruneTabs(new Set(["a"]));
    expect(popouts()).toEqual([]);
    expect(layout()).toEqual([">a*"]);
  });

  it("remembers popout tabs as main-window tabs", () => {
    initPreferences();
    restoreVaultSession("D:/弹出", false);
    start("a", "b");
    useApp.getState().switchTab(tabOf("a").id);
    popOut("b");
    const saved = JSON.parse(localStorage.getItem("odea.session:D:/弹出")!);
    expect(saved.noteId).toBe("a");
    expect(saved.layout).toEqual({ panes: [{ tabs: ["a", "b"], active: 0, size: 1 }], pane: 0 });
  });
});
