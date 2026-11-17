import { describe, expect, it } from "vitest";
import { type InstalledPlugin, carriedGrants } from "./installed";

/* 装一份清单时之前的授权带不带过去（views/ExtensionsView.tsx 的 install 用它定问哪几项） */

const plugin = (source: InstalledPlugin["source"]): InstalledPlugin =>
  ({
    manifest: { id: "odea.word-count", name: "字数", version: "1.0.0" },
    source,
    installedAt: 0,
    updatedAt: 0,
    grants: { granted: ["doc.read"], denied: ["net"] },
  }) as unknown as InstalledPlugin;

describe("升级时的授权", () => {
  it("同一个来源的升级：之前同意的、拒绝的照旧算数，只问多要的", () => {
    const before = plugin("official");
    expect(carriedGrants(before, "official")).toBe(before.grants);
    const file = plugin("file");
    expect(carriedGrants(file, "file")).toBe(file.grants);
  });

  it("官方目录装的、又从文件装了同一个 id：脚本换了人写，之前的授权一项不带（全部重问）", () => {
    expect(carriedGrants(plugin("official"), "file")).toEqual({ granted: [], denied: [] });
    expect(carriedGrants(plugin("file"), "official")).toEqual({ granted: [], denied: [] });
  });

  it("新装的：没有可带的", () => {
    expect(carriedGrants(undefined, "file")).toEqual({ granted: [], denied: [] });
  });
});
