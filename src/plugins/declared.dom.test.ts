// @vitest-environment happy-dom

import type { Backend } from "@/data/backend";
import { ODEA_LAYOUT, type TemplateContext, type VaultInfo, type VaultLayout } from "@/data/types";
import { calloutKind, calloutsVersion, parseCalloutHead } from "@/editor/callout";
import type { PluginManifest } from "@/extensions/manifest";
import { FileText } from "lucide-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CARET, navIds, registerPlugin, templatesFor } from "./registry";

/*
 * L0 插件的运行时（plugins/declared.ts，docs/插件与跨端.md §5.3）：
 * 生效的 = 这台设备装着的 ∩ 这个仓库开着的。开、关、装、卸都整个重算，停用后提示块、模板、主题、
 * 导航顺序撤得干干净净，文档一个字不动
 */

const api = { vaultSetExtension: vi.fn() };
vi.mock("@/data/backend", () => ({ backend: async () => api as unknown as Backend }));

// 一个假的内置插件：两个导航项，一个模板槽位
registerPlugin({
  id: "test.pages",
  name: "测试用的页",
  onByDefault: true,
  defaultDirs: [],
  documentTypes: [],
  nav: ["first", "second"].map((id, index) => ({
    id,
    plugin: "test.pages",
    label: id,
    icon: FileText,
    order: 10 + index,
    keywords: "",
    motion: { to: {}, origin: "50% 50%" },
  })),
  useDocument: () => null,
  templateScopes: ["page"],
});

const { useData } = await import("@/data/store");
const { installPlugin, uninstallPlugin, useInstalled } = await import("@/extensions/installed");
const { activeManifests, expandTemplate, initDeclaredPlugins, useDeclared } = await import(
  "./declared"
);

const manifest = (id: string, contributes: PluginManifest["contributes"]): PluginManifest => ({
  schemaVersion: 2,
  id,
  name: id,
  version: "0.1.0",
  author: "测试",
  summary: "测试用",
  category: "appearance",
  api: "^1.0",
  contributes,
});

const callouts = manifest("someone.callouts", {
  callouts: [{ label: "灵感", aliases: ["idea"], kind: "tip", icon: "sparkles" }],
});
const templates = manifest("someone.templates", {
  templates: [
    {
      name: "会议",
      scope: "note",
      body: "时间 {{date:YYYY年M月D日}} {{weekday}} {{time}}\n{{cursor}}",
    },
    { name: "页", scope: "page", body: "{{date}}" },
  ],
});
const theme = manifest("someone.theme", {
  theme: { light: { accent: "#0a7d5a" }, dark: { accent: "oklch(70% 0.1 160)" } },
});
const nav = manifest("someone.nav", { navOrder: ["second", "extensions"] });

/** 这个仓库开着哪几个（相当于仓库标记的 plugins） */
function wantInVault(...ids: string[]) {
  const layout: VaultLayout = {
    ...ODEA_LAYOUT,
    extensions: ids.map((id) => ({ id, version: "^0.1" })),
  };
  useData.setState({ layout });
}

const styleText = () => document.getElementById("odea-plugin-theme")?.textContent ?? null;

beforeEach(() => {
  localStorage.clear();
  initDeclaredPlugins();
  for (const plugin of useInstalled.getState().plugins) uninstallPlugin(plugin.manifest.id);
  wantInVault();
});

describe("L0 插件生效的条件", () => {
  it("装着、仓库也开着才生效；只装没开、只开没装都不算", () => {
    installPlugin(callouts, "file");
    expect(activeManifests()).toEqual([]);
    expect(calloutKind("灵感")).toBe("generic");

    wantInVault(callouts.id, "someone.missing");
    expect(activeManifests().map((m) => m.id)).toEqual([callouts.id]);
    expect(calloutKind("灵感")).toBe("tip");
    expect(calloutKind("IDEA")).toBe("tip");
    expect(parseCalloutHead("> [!灵感] 标题")).toMatchObject({ kind: "tip", icon: "sparkles" });

    // 停用（仓库里关掉）：标签回到中性的样子
    const before = calloutsVersion();
    wantInVault();
    expect(calloutKind("灵感")).toBe("generic");
    expect(parseCalloutHead("> [!灵感]")?.icon).toBeUndefined();
    expect(calloutsVersion()).toBeGreaterThan(before);
    // 内置认得的照旧
    expect(calloutKind("tip")).toBe("tip");
  });

  it("平台对不上的不生效", () => {
    installPlugin({ ...callouts, platforms: ["mobile"] }, "file");
    wantInVault(callouts.id);
    expect(activeManifests()).toEqual([]);
  });

  it("卸载以后不生效，仓库里记的不动", () => {
    installPlugin(callouts, "file");
    wantInVault(callouts.id);
    uninstallPlugin(callouts.id);
    expect(activeManifests()).toEqual([]);
    expect(useData.getState().layout.extensions.map((entry) => entry.id)).toEqual([callouts.id]);
  });

  it("存储里的清单读出来再校验一遍，坏了的列出来、不生效", () => {
    localStorage.setItem(
      "odea.plugins.installed",
      JSON.stringify([
        { manifest: callouts, source: "file", installedAt: 1 },
        {
          manifest: { ...nav, contributes: { navOrder: ["gone"] } },
          source: "file",
          installedAt: 2,
        },
      ]),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: "odea.plugins.installed" }));
    expect(useInstalled.getState().plugins.map((plugin) => plugin.manifest.id)).toEqual([
      callouts.id,
    ]);
    expect(useInstalled.getState().broken).toMatchObject([
      { id: nav.id, error: expect.stringContaining("contributes.navOrder[0]") },
    ]);
  });
});

describe("四样贡献点", () => {
  it("模板：按 scope 进模板菜单，排在内置插件的后面；停用就没了", () => {
    installPlugin(templates, "file");
    wantInVault(templates.id);
    expect(templatesFor("note").map((template) => template.name)).toEqual(["会议"]);
    expect(templatesFor("page").map((template) => template.name)).toEqual(["页"]);
    wantInVault();
    expect(templatesFor("note")).toEqual([]);
  });

  it("模板的占位符：笔记是今天，某一天的文档是那一天；{{cursor}} 是光标", () => {
    const now = new Date(2026, 10, 5, 9, 7);
    const note: TemplateContext = {
      scope: "note",
      date: "2020-01-01",
      today: "2020-01-01",
      label: "周会",
      placeholder: "",
      title: "周会",
    };
    expect(
      expandTemplate("{{date}} {{date:YYYY年M月D日 第ww周}} {{weekday}} {{time}}", note, now),
    ).toBe("2026-11-05 2026年11月5日 第45周 周四 09:07");
    expect(expandTemplate("# {{title}}\n{{cursor}}", note, now)).toBe(`# 周会\n${CARET}`);
    // 模板里本来就有的光标符号去掉，不然插入后光标停错地方
    expect(expandTemplate(`a${CARET}b{{cursor}}`, note, now)).toBe(`ab${CARET}`);
    const day = { ...note, scope: "page", date: "2026-10-07" };
    expect(expandTemplate("{{date}} {{weekday}}", day, now)).toBe("2026-10-07 周三");
  });

  it("主题：一个 <style> 改颜色 token，后开的说了算；停用就拿掉", () => {
    installPlugin(theme, "file");
    installPlugin(
      manifest("someone.theme2", { theme: { light: { accent: "#123456", danger: "#aa0000" } } }),
      "file",
    );
    wantInVault(theme.id, "someone.theme2");
    expect(styleText()).toBe(
      ':root[data-theme="light"] {\n  --color-accent: #123456;\n  --color-danger: #aa0000;\n}\n' +
        ':root[data-theme="dark"] {\n  --color-accent: oklch(70% 0.1 160);\n}',
    );
    // 放在 <head> 最后，压过 globals.css
    expect(document.head.lastElementChild?.id).toBe("odea-plugin-theme");
    wantInVault();
    expect(styleText()).toBeNull();
  });

  it("导航顺序：列出来的排前面，别的照原来的先后", () => {
    const original = navIds();
    expect(original).toEqual(["notes", "first", "second", "archive", "extensions"]);
    installPlugin(nav, "file");
    wantInVault(nav.id);
    expect(navIds()).toEqual(["second", "extensions", "notes", "first", "archive"]);
    expect(useDeclared.getState().navOrder).toEqual(["second", "extensions"]);
    wantInVault();
    expect(navIds()).toEqual(original);
  });
});

describe("在这个仓库里开关（data/store 的 setExtension）", () => {
  it("只改仓库标记、就地换上摆法，插件跟着生效", async () => {
    installPlugin(callouts, "file");
    const info = (layout: Partial<VaultLayout>): VaultInfo => ({
      root: "D:/仓库",
      notes: 0,
      archived: 0,
      docs: 0,
      team: false,
      layout: { ...ODEA_LAYOUT, ...layout },
    });
    api.vaultSetExtension.mockResolvedValueOnce(
      info({ extensions: [{ id: callouts.id, version: "^0.1" }] }),
    );
    await useData.getState().setExtension(callouts.id, true, "^0.1");
    expect(api.vaultSetExtension).toHaveBeenCalledWith(callouts.id, true, "^0.1");
    expect(calloutKind("灵感")).toBe("tip");

    api.vaultSetExtension.mockResolvedValueOnce(info({ extensions: [] }));
    await useData.getState().setExtension(callouts.id, false);
    expect(api.vaultSetExtension).toHaveBeenLastCalledWith(callouts.id, false, null);
    expect(calloutKind("灵感")).toBe("generic");
  });
});
