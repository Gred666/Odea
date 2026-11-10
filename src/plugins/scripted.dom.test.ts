// @vitest-environment happy-dom

import type { Backend } from "@/data/backend";
import { useData } from "@/data/store";
import { noteRef } from "@/data/types";
import { officialCode, officialPlugin } from "@/extensions/catalog";
import { initInstalled, installPlugin, useInstalled } from "@/extensions/installed";
import { validateManifest } from "@/extensions/manifest";
import { type EditOutcome, registerLiveEditor, registerVisibleDocument } from "@/lib/liveDocuments";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inProcessSandbox, until } from "./sandbox/testkit";
import {
  initScriptedPlugins,
  resetScriptedForTest,
  runScriptedCommand,
  runSlotAction,
  scriptedCommands,
  useScripted,
} from "./scripted";

/*
 * 带脚本的插件的管家（plugins/scripted.ts）：生效的 = 装着的 ∩ 这个仓库开着的；没问过权限的不起；
 * 有文档显示着才起用到槽位的插件，画好的那一段放进 useScripted；停用后它画的、它的运行时都不留
 */

vi.mock("@/data/backend", () => ({ backend: async () => ({}) as unknown as Backend }));

const context = () => ({ navIds: ["notes"], templateScopes: ["note"] });
const manifest = validateManifest(officialPlugin("odea.doc-tidy"), {
  ...context(),
  official: true,
});
const code = officialCode("odea.doc-tidy")!;
const KEY = "note:n1";
const GRANTED = { granted: ["documents.read:current", "documents.edit:current"], denied: [] };

let sandbox = inProcessSandbox();
const cleanups: (() => void)[] = [];

/** 一个假的编辑器：按修订号改 */
function liveEditor(initial: string) {
  let text = initial;
  let revision = 0;
  const edits: unknown[] = [];
  const dispose = registerLiveEditor(KEY, {
    text: () => text,
    revision: () => `r.${revision}`,
    edit(base, changes): EditOutcome {
      edits.push(changes);
      if (base !== `r.${revision}`) return { ok: false, code: "stale", message: "过时了" };
      for (const change of [...changes].sort((a, b) => b.from - a.from)) {
        text = text.slice(0, change.from) + change.insert + text.slice(change.to);
      }
      revision += 1;
      return { ok: true, revision: `r.${revision}` };
    },
  });
  cleanups.push(dispose);
  return { text: () => text, edits };
}

function show(text: string) {
  const handle = registerVisibleDocument({
    ref: noteRef("n1"),
    key: KEY,
    title: "乱",
    focused: true,
    bodyMd: text,
  });
  cleanups.push(handle.dispose);
}

function enable(on: boolean) {
  useData.setState((state) => ({
    layout: { ...state.layout, extensions: on ? [{ id: manifest.id, version: "^1" }] : [] },
  }));
}

beforeAll(() => {
  initInstalled(context);
  initScriptedPlugins();
});

beforeEach(() => {
  localStorage.clear();
  sandbox = inProcessSandbox();
  resetScriptedForTest(sandbox.factory);
  // resetScriptedForTest 把 started 清了：订阅还在（beforeAll 订的），这里不再订一遍
  useInstalled.setState({ plugins: [], broken: [] });
  enable(false);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  enable(false);
});

describe("带脚本的插件的管家", () => {
  it("开着、授了权、有文档显示着：起来，正文后面那一段放进 useScripted", async () => {
    show("a   \nb");
    installPlugin(manifest, "official", code, GRANTED);
    enable(true);
    await until(() => !!useScripted.getState().slots[KEY]);
    expect(useScripted.getState().plugins[manifest.id]?.state).toEqual({ state: "running" });
    expect(useScripted.getState().slots[KEY]).toMatchObject([
      { plugin: manifest.id, slot: "tidy", title: "可以整理的地方", pluginName: "文档整理" },
    ]);
    expect(sandbox.stats.created).toBe(1);
  });

  it("点了按钮：改的是编辑器里那一篇，改完马上重画（整齐了，那一段就没了）", async () => {
    const editor = liveEditor("a   \nb");
    show("a   \nb");
    installPlugin(manifest, "official", code, GRANTED);
    enable(true);
    await until(() => !!useScripted.getState().slots[KEY]);
    await runSlotAction({ plugin: manifest.id, slot: "tidy" }, KEY, "all");
    expect(editor.text()).toBe("a\nb");
    await until(() => !useScripted.getState().slots[KEY]);
  });

  it("命令面板里列着它的命令，跑起来照样改正在看的那一篇", async () => {
    const editor = liveEditor("x\n\n\n\ny");
    show("x\n\n\n\ny");
    installPlugin(manifest, "official", code, GRANTED);
    enable(true);
    expect(scriptedCommands()).toMatchObject([
      { plugin: manifest.id, command: { id: "tidy.all", title: "整理这篇文档" } },
    ]);
    await runScriptedCommand(manifest.id, "tidy.all");
    expect(editor.text()).toBe("x\n\ny");
    await until(() => useData.getState().notice?.includes("改了 2 处") ?? false);
  });

  it("权限还没问过：不起，等授权", async () => {
    show("a   \nb");
    installPlugin(manifest, "official", code);
    enable(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(useScripted.getState().plugins[manifest.id]?.state).toEqual({ state: "consent" });
    expect(sandbox.stats.created).toBe(0);
    await runScriptedCommand(manifest.id, "tidy.all");
    expect(useData.getState().notice).toContain("还没授权");
  });

  it("停用：运行时拆掉、那一段撤掉、状态也不留", async () => {
    show("a   \nb");
    installPlugin(manifest, "official", code, GRANTED);
    enable(true);
    await until(() => !!useScripted.getState().slots[KEY]);
    enable(false);
    await until(() => sandbox.stats.disposed === 1);
    expect(useScripted.getState()).toEqual({ plugins: {}, slots: {} });
    expect(scriptedCommands()).toEqual([]);
  });

  it("这个仓库没开它：装着也不起", async () => {
    show("a   \nb");
    installPlugin(manifest, "official", code, GRANTED);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sandbox.stats.created).toBe(0);
    expect(useScripted.getState().plugins).toEqual({});
  });
});
