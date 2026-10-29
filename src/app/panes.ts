/* ============================================================
   笔记区的窗格和标签（docs/标签页与分屏.md）：一排左右并排的窗格，每个窗格一排标签。

   这里都是纯函数：拿一份布局、返回新的一份（没变就原样返回同一个对象）。app/store 把结果放进去，
   顺手把 selectedNoteId 换成「正在写的那个窗格的当前标签」—— 列表高亮、命令面板里的「这一篇」、
   团队视图都只看它（不变式，见 selectedOf）。

   只有左右分：标签栏长在窗口最上面那条拖动区里，上下分的话下面那个窗格的标签栏没处放，
   得在正文里另起一行，就是 Obsidian 那种又重又挤的样子（设计 §12）。
   ============================================================ */

export interface NoteTab {
  id: string;
  noteId: string;
  /** 在这个标签里看过的、往回走能回到的（最近的在最后） */
  back: string[];
  forward: string[];
}

export interface NotePane {
  id: string;
  tabs: NoteTab[];
  activeTab: string;
  /** 占的比例（flex-grow），几个窗格加起来不必是 1 */
  size: number;
}

export interface PaneLayout {
  panes: NotePane[];
  activePane: string;
}

/** 最多几栏：一栏再窄就放不下正文了（窗口 1440、列表栏开着时一栏 358） */
export const MAX_PANES = 3;
/** 一个标签里往回走最多记几步 */
const HISTORY_LIMIT = 50;

let seq = 0;
export const newTab = (noteId: string, back: string[] = [], forward: string[] = []): NoteTab => ({
  id: `tab-${++seq}`,
  noteId,
  back,
  forward,
});
export const newPane = (tabs: NoteTab[], size = 1, active = tabs[0]!.id): NotePane => ({
  id: `pane-${++seq}`,
  tabs,
  activeTab: active,
  size,
});

/** 只有一个空标签的布局（新仓库，列表栏会选上第一篇） */
export function emptyLayout(noteId = ""): PaneLayout {
  const pane = newPane([newTab(noteId)]);
  return { panes: [pane], activePane: pane.id };
}

export const focusedPane = (layout: PaneLayout): NotePane =>
  layout.panes.find((pane) => pane.id === layout.activePane) ?? layout.panes[0]!;

export const activeTabOf = (pane: NotePane): NoteTab =>
  pane.tabs.find((tab) => tab.id === pane.activeTab) ?? pane.tabs[0]!;

/** 正在写的那个窗格里当前那一篇 —— 就是 selectedNoteId */
export const selectedOf = (layout: PaneLayout): string => activeTabOf(focusedPane(layout)).noteId;

export const paneOfTab = (layout: PaneLayout, tabId: string): NotePane | undefined =>
  layout.panes.find((pane) => pane.tabs.some((tab) => tab.id === tabId));

/** 所有窗格里开着的笔记 */
export const openNotes = (layout: PaneLayout): string[] =>
  layout.panes.flatMap((pane) => pane.tabs.map((tab) => tab.noteId)).filter(Boolean);

function withPane(layout: PaneLayout, pane: NotePane, focus = true): PaneLayout {
  return {
    panes: layout.panes.map((other) => (other.id === pane.id ? pane : other)),
    activePane: focus ? pane.id : layout.activePane,
  };
}

/* ---------------- 打开 ---------------- */

/** 单击列表里的一篇：正在写的窗格里已经开着就切过去，没有就换掉当前标签里的那一篇（记进往回走） */
export function navigate(layout: PaneLayout, noteId: string): PaneLayout {
  const pane = focusedPane(layout);
  const open = pane.tabs.find((tab) => tab.noteId === noteId);
  if (open)
    return open.id === pane.activeTab ? layout : withPane(layout, { ...pane, activeTab: open.id });
  const current = activeTabOf(pane);
  const back = current.noteId
    ? [...current.back, current.noteId].slice(-HISTORY_LIMIT)
    : current.back;
  const tab = { ...current, noteId, back, forward: [] };
  return withPane(layout, {
    ...pane,
    tabs: pane.tabs.map((other) => (other === current ? tab : other)),
  });
}

/** 开在新标签里（默认正在写的那个窗格，当前标签右边）；那个窗格里已经开着就切过去 */
export function openTab(
  layout: PaneLayout,
  noteId: string,
  paneId = layout.activePane,
): PaneLayout {
  const pane = layout.panes.find((other) => other.id === paneId) ?? focusedPane(layout);
  const open = pane.tabs.find((tab) => tab.noteId === noteId);
  if (open) return withPane(layout, { ...pane, activeTab: open.id });
  const current = activeTabOf(pane);
  // 当前标签还是空的（新仓库还没选上哪一篇）：就开在它里面
  if (!current.noteId) {
    const tabs = pane.tabs.map((tab) => (tab === current ? { ...tab, noteId } : tab));
    return withPane(layout, { ...pane, tabs });
  }
  const tab = newTab(noteId);
  const tabs = [...pane.tabs];
  tabs.splice(tabs.indexOf(current) + 1, 0, tab);
  return withPane(layout, { ...pane, tabs, activeTab: tab.id });
}

export function switchTab(layout: PaneLayout, tabId: string): PaneLayout {
  const pane = paneOfTab(layout, tabId);
  if (!pane || (pane.activeTab === tabId && layout.activePane === pane.id)) return layout;
  return withPane(layout, { ...pane, activeTab: tabId });
}

export function focusPane(layout: PaneLayout, paneId: string): PaneLayout {
  if (layout.activePane === paneId || !layout.panes.some((pane) => pane.id === paneId))
    return layout;
  return { ...layout, activePane: paneId };
}

/** 当前标签往回 / 往前走一步；那一篇不在了（alive）、或者这个窗格别的标签里开着的跳过 */
export function walkHistory(
  layout: PaneLayout,
  step: -1 | 1,
  alive: (noteId: string) => boolean,
): PaneLayout {
  const pane = focusedPane(layout);
  const tab = activeTabOf(pane);
  const back = [...tab.back];
  const forward = [...tab.forward];
  // 往回走：从 back 里取，现在这一篇放进 forward；往前走反过来
  const from = step < 0 ? back : forward;
  const to = step < 0 ? forward : back;
  while (from.length) {
    const noteId = from.pop()!;
    if (!alive(noteId) || pane.tabs.some((other) => other !== tab && other.noteId === noteId)) {
      continue;
    }
    if (tab.noteId) to.push(tab.noteId);
    const next = { ...tab, noteId, back, forward };
    return withPane(layout, {
      ...pane,
      tabs: pane.tabs.map((other) => (other === tab ? next : other)),
    });
  }
  return layout;
}

/* ---------------- 关 ---------------- */

export interface Closed {
  noteId: string;
  index: number;
}

/**
 * 去掉一批标签：当前那个没了切到它右边还在的那个，没有就左边的；窗格空了就去掉（它占的地方给旁边的），
 * 全空了留一个空标签。closed 是这次关掉的（Ctrl+Shift+T 用）
 */
export function dropTabs(
  layout: PaneLayout,
  gone: (tab: NoteTab, pane: NotePane) => boolean,
): { layout: PaneLayout; closed: Closed[] } {
  const closed: Closed[] = [];
  let changed = false;
  const panes: NotePane[] = [];
  const emptied: NotePane[] = [];
  for (const pane of layout.panes) {
    const kept = pane.tabs.filter((tab) => !gone(tab, pane));
    if (kept.length === pane.tabs.length) {
      panes.push(pane);
      continue;
    }
    changed = true;
    pane.tabs.forEach((tab, index) => {
      if (tab.noteId && !kept.includes(tab)) closed.push({ noteId: tab.noteId, index });
    });
    if (!kept.length) {
      emptied.push(pane);
      continue;
    }
    const index = pane.tabs.findIndex((tab) => tab.id === pane.activeTab);
    const active =
      kept.find((tab) => tab.id === pane.activeTab) ??
      pane.tabs.slice(index + 1).find((tab) => kept.includes(tab)) ??
      [...pane.tabs.slice(0, index)].reverse().find((tab) => kept.includes(tab)) ??
      kept[0]!;
    panes.push({ ...pane, tabs: kept, activeTab: active.id });
  }
  if (!changed) return { layout, closed };
  if (!panes.length) return { layout: emptyLayout(), closed };
  return { layout: withoutPanes(layout, panes, emptied), closed };
}

/** 去掉空了的窗格：它占的地方给左边那个（最左边的给右边），正在写的是它的话换成拿到地方的那个 */
function withoutPanes(layout: PaneLayout, kept: NotePane[], emptied: NotePane[]): PaneLayout {
  if (!emptied.length) {
    const active = kept.some((pane) => pane.id === layout.activePane)
      ? layout.activePane
      : kept[0]!.id;
    return { panes: kept, activePane: active };
  }
  const sizes = new Map(kept.map((pane) => [pane.id, pane.size]));
  let activePane = layout.activePane;
  for (const gone of emptied) {
    const index = layout.panes.indexOf(gone);
    const heir =
      [...layout.panes.slice(0, index)].reverse().find((pane) => sizes.has(pane.id)) ??
      layout.panes.slice(index + 1).find((pane) => sizes.has(pane.id))!;
    sizes.set(heir.id, sizes.get(heir.id)! + gone.size);
    if (activePane === gone.id) activePane = heir.id;
  }
  return {
    panes: kept.map((pane) => ({ ...pane, size: sizes.get(pane.id)! })),
    activePane: kept.some((pane) => pane.id === activePane) ? activePane : kept[0]!.id,
  };
}

/** 关一个标签。窗格里只剩它：有别的窗格就把这个窗格关掉，没有就不关（窗口里至少一个标签） */
export function closeTab(
  layout: PaneLayout,
  tabId: string,
): { layout: PaneLayout; closed: Closed[] } {
  const pane = paneOfTab(layout, tabId);
  if (!pane || (pane.tabs.length < 2 && layout.panes.length < 2)) return { layout, closed: [] };
  return dropTabs(layout, (tab) => tab.id === tabId);
}

/** 关掉同一个窗格里别的标签 */
export function closeOthers(layout: PaneLayout, tabId: string) {
  const pane = paneOfTab(layout, tabId);
  if (!pane) return { layout, closed: [] };
  const result = dropTabs(layout, (tab, owner) => owner === pane && tab.id !== tabId);
  return { ...result, layout: switchTab(result.layout, tabId) };
}

/** 关掉同一个窗格里它右边的 */
export function closeRight(layout: PaneLayout, tabId: string) {
  const pane = paneOfTab(layout, tabId);
  if (!pane) return { layout, closed: [] };
  const index = pane.tabs.findIndex((tab) => tab.id === tabId);
  const right = new Set(pane.tabs.slice(index + 1).map((tab) => tab.id));
  return dropTabs(layout, (tab) => right.has(tab.id));
}

export function closePane(layout: PaneLayout, paneId: string) {
  if (layout.panes.length < 2) return { layout, closed: [] };
  return dropTabs(layout, (_tab, pane) => pane.id === paneId);
}

/* ---------------- 挪、拆 ---------------- */

/** 挪到某个窗格的第 index 个（同一个窗格里是排顺序）。那个窗格里已经开着这一篇：切到那个，原来的关掉 */
export function moveTab(
  layout: PaneLayout,
  tabId: string,
  paneId: string,
  index: number,
): PaneLayout {
  const from = paneOfTab(layout, tabId);
  const to = layout.panes.find((pane) => pane.id === paneId);
  if (!from || !to) return layout;
  const tab = from.tabs.find((other) => other.id === tabId)!;
  if (from === to) {
    const tabs = from.tabs.filter((other) => other !== tab);
    tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, tab);
    if (tabs.every((other, i) => other === from.tabs[i])) return layout;
    return withPane(layout, { ...from, tabs }, false);
  }
  const same = to.tabs.find((other) => !!tab.noteId && other.noteId === tab.noteId);
  const dropped = dropTabs(layout, (other) => other.id === tabId).layout;
  const target = dropped.panes.find((pane) => pane.id === paneId);
  if (!target) return layout;
  if (same) return withPane(dropped, { ...target, activeTab: same.id });
  const tabs = [...target.tabs];
  tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, tab);
  return withPane(dropped, { ...target, tabs, activeTab: tab.id });
}

/**
 * 拆出一栏：在 paneId 那个窗格的左边 / 右边开一个新窗格，里面是这个标签（copy 时是同一篇的一个新标签，
 * 原来的留着 —— 「向右拆分」；拖过去是挪）。到了 MAX_PANES 就不拆
 */
export function split(
  layout: PaneLayout,
  tabId: string,
  paneId: string,
  side: "left" | "right",
  copy: boolean,
): PaneLayout {
  if (layout.panes.length >= MAX_PANES) return layout;
  const from = paneOfTab(layout, tabId);
  const target = layout.panes.find((pane) => pane.id === paneId);
  if (!from || !target) return layout;
  const tab = from.tabs.find((other) => other.id === tabId)!;
  // 把一个窗格里唯一的标签拖到自己边上：拆了等于没拆
  if (!copy && from === target && from.tabs.length < 2) return layout;
  const moved = copy ? newTab(tab.noteId) : tab;
  const base = copy ? layout : dropTabs(layout, (other) => other.id === tabId).layout;
  const anchor = base.panes.find((pane) => pane.id === paneId);
  if (!anchor) return layout;
  // 新的一栏分走它旁边那一栏的一半
  const half = anchor.size / 2;
  const pane = newPane([moved], half);
  const panes = base.panes.flatMap((other) => {
    if (other !== anchor) return [other];
    const kept = { ...other, size: half };
    return side === "left" ? [pane, kept] : [kept, pane];
  });
  return { panes, activePane: pane.id };
}

/** 拖分割条以后的比例 */
export function resize(layout: PaneLayout, sizes: number[]): PaneLayout {
  if (sizes.length !== layout.panes.length) return layout;
  return {
    ...layout,
    panes: layout.panes.map((pane, index) => ({ ...pane, size: sizes[index]! })),
  };
}

/* ---------------- 弹出窗口（§16） ----------------
   一个弹出窗口一个窗格，不在主窗口那一排里（selectedNoteId 的不变式只管主窗口）。改它的时候当成只有
   一栏的布局，用上面那些函数 */

export const asLayout = (pane: NotePane): PaneLayout => ({ panes: [pane], activePane: pane.id });

/**
 * 改完以后的那个窗格；关空了是 null（上面的函数关空了会换成一个空标签的新窗格）—— 弹出窗口跟着关。
 * 弹出窗口里不拆分，所以不会多出一栏
 */
export function popoutPane(before: NotePane, after: PaneLayout): NotePane | null {
  const pane = after.panes[0];
  return after.panes.length === 1 && pane?.id === before.id ? pane : null;
}

/** 弹出窗口里关一个标签：关的是最后一个就是关窗口（null），不像主窗口那样留一个 */
export function closeInPopout(pane: NotePane, tabId: string) {
  const { layout, closed } = dropTabs(asLayout(pane), (tab) => tab.id === tabId);
  return { pane: popoutPane(pane, layout), closed };
}

/** 拿一个标签出去开成弹出窗口：主窗口那一排里去掉它（不记进「最近关掉的」）。全拿走了留一个空标签 */
export function takeOut(layout: PaneLayout, tabId: string): PaneLayout {
  return dropTabs(layout, (tab) => tab.id === tabId).layout;
}

/**
 * 弹出窗口里的标签回到主窗口：放进正在写的那个窗格的最后，这个窗格里已经开着的不重复；不切过去
 * —— 关一个窗口，另一个窗口里正看着的不该跟着换。主窗口只剩一个空标签（唯一的标签被拖出去了）就换掉它
 */
export function bringBack(layout: PaneLayout, tabs: NoteTab[]): PaneLayout {
  const pane = focusedPane(layout);
  const kept: NoteTab[] = [];
  for (const tab of tabs) {
    if (!tab.noteId) continue;
    if ([...pane.tabs, ...kept].some((other) => other.noteId === tab.noteId)) continue;
    kept.push(tab);
  }
  if (!kept.length) return layout;
  const empty = pane.tabs.every((tab) => !tab.noteId);
  const next = empty
    ? { ...pane, tabs: kept, activeTab: kept[0]!.id }
    : { ...pane, tabs: [...pane.tabs, ...kept] };
  return withPane(layout, next, false);
}

/* ---------------- 对账 ---------------- */

/** 笔记列表变了：指着已经不在的笔记的标签关掉（往回走的记录里的也去掉） */
export function prune(layout: PaneLayout, alive: ReadonlySet<string>): PaneLayout {
  const dropped = dropTabs(layout, (tab) => !!tab.noteId && !alive.has(tab.noteId)).layout;
  const clean = (ids: string[]) => ids.filter((id) => alive.has(id));
  let changed = dropped !== layout;
  const panes = dropped.panes.map((pane) => {
    let touched = false;
    const tabs = pane.tabs.map((tab) => {
      const back = clean(tab.back);
      const forward = clean(tab.forward);
      if (back.length === tab.back.length && forward.length === tab.forward.length) return tab;
      touched = true;
      return { ...tab, back, forward };
    });
    if (!touched) return pane;
    changed = true;
    return { ...pane, tabs };
  });
  return changed ? { ...dropped, panes } : layout;
}

/** 笔记的 id 整个换了（开关日程以后按路径认回来）：认不回来的、认回来在同一个窗格里撞成同一篇的关掉 */
export function remap(layout: PaneLayout, map: (noteId: string) => string | undefined): PaneLayout {
  const mapIds = (ids: string[]) => ids.map(map).filter((id): id is string => !!id);
  const mapped: PaneLayout = {
    ...layout,
    panes: layout.panes.map((pane) => ({
      ...pane,
      tabs: pane.tabs.map((tab) => ({
        ...tab,
        noteId: map(tab.noteId) ?? "",
        back: mapIds(tab.back),
        forward: mapIds(tab.forward),
      })),
    })),
  };
  const gone = new Set<string>();
  for (const pane of mapped.panes) {
    const seen = new Set<string>();
    for (const tab of pane.tabs) {
      if (!tab.noteId || seen.has(tab.noteId)) gone.add(tab.id);
      seen.add(tab.noteId);
    }
  }
  return dropTabs(mapped, (tab) => gone.has(tab.id)).layout;
}

/* ---------------- 记在本机 ---------------- */

/** 记下来的样子：每个窗格的笔记 id、当前是第几个、占多宽；正在写的是第几个窗格 */
export interface StoredLayout {
  panes: { tabs: string[]; active: number; size: number }[];
  pane: number;
}

export function storeLayout(layout: PaneLayout): StoredLayout | null {
  const single = layout.panes.length === 1 && layout.panes[0]!.tabs.length < 2;
  if (single) return null;
  return {
    panes: layout.panes.map((pane) => ({
      tabs: pane.tabs.map((tab) => tab.noteId),
      active: pane.tabs.findIndex((tab) => tab.id === pane.activeTab),
      size: Math.round(pane.size * 1000) / 1000,
    })),
    pane: layout.panes.findIndex((pane) => pane.id === layout.activePane),
  };
}

/** 读回来；坏了的、空的去掉。selected 是记下的「上次停在哪一篇」，对不上时以它为准开在正在写的窗格里 */
export function restoreLayout(raw: unknown, selected: string): PaneLayout {
  const stored = raw as Partial<StoredLayout> | undefined;
  const panes: NotePane[] = [];
  let activePane = "";
  if (stored && Array.isArray(stored.panes)) {
    stored.panes.slice(0, MAX_PANES).forEach((entry, index) => {
      if (!entry || !Array.isArray(entry.tabs)) return;
      const ids = [
        ...new Set(entry.tabs.filter((id): id is string => typeof id === "string" && !!id)),
      ];
      if (!ids.length) return;
      const tabs = ids.map((id) => newTab(id));
      const active = tabs[Math.min(Math.max(0, Number(entry.active) || 0), tabs.length - 1)]!;
      const size = Number(entry.size) > 0 ? Number(entry.size) : 1;
      const pane = newPane(tabs, size, active.id);
      panes.push(pane);
      if (index === stored.pane) activePane = pane.id;
    });
  }
  if (!panes.length) return emptyLayout(selected);
  const layout = { panes, activePane: activePane || panes[0]!.id };
  return selected && selectedOf(layout) !== selected ? navigate(layout, selected) : layout;
}
