import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASES, parseChangelog, releaseOf, releasesBetween } from "./changelog";
import { newerThan } from "./guide";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const SAMPLE = `<!--
## 9.9.9 · 注释里的不算
-->

## 0.3.0 · 2026-11-02

- 第三版

## v0.2.1

- 修了一个问题

## 0.2.0 · 2026-10-20

- 第二版
  - 缩进的也留着

## 0.1.5

`;

describe("更新说明", () => {
  it("按版本切开，注释和空的节不算", () => {
    expect(parseChangelog(SAMPLE)).toEqual([
      { version: "0.3.0", date: "2026-11-02", body: "- 第三版" },
      { version: "0.2.1", date: null, body: "- 修了一个问题" },
      { version: "0.2.0", date: "2026-10-20", body: "- 第二版\n  - 缩进的也留着" },
    ]);
  });

  it("升级后看的是旧版之后、到这一版为止的几节", () => {
    const releases = parseChangelog(SAMPLE);
    const versions = (from: string | null, to: string) =>
      releasesBetween(from, to, releases).map((release) => release.version);
    expect(versions("0.1.0", "0.3.0")).toEqual(["0.3.0", "0.2.1", "0.2.0"]);
    expect(versions("0.2.0", "0.2.1")).toEqual(["0.2.1"]);
    // 记版本号之前的老版本：只看这一版
    expect(versions(null, "0.3.0")).toEqual(["0.3.0"]);
    // 这一版没写说明：什么都不给看
    expect(versions("0.2.0", "0.2.5")).toEqual(["0.2.1"]);
    expect(versions(null, "0.2.5")).toEqual([]);
    expect(releaseOf("0.2.1", releases)?.body).toBe("- 修了一个问题");
  });

  it("changelog.md 里的版本从新到旧排、不重复，不比应用的版本新", () => {
    const pkg = JSON.parse(read("package.json")).version as string;
    for (let i = 1; i < RELEASES.length; i++) {
      expect(newerThan(RELEASES[i - 1]!.version, RELEASES[i]!.version)).toBe(true);
    }
    for (const release of RELEASES) expect(newerThan(release.version, pkg)).toBe(false);
  });
});

describe("版本号", () => {
  // 三处得一样：前端（package.json）、Rust 和安装包（Cargo.toml，tauri.conf.json 不写版本就用它）。
  // 对不上的话，检查更新拿错的版本比、升级后的更新说明也认错版本。改版本号用 pnpm bump <版本>
  it("package.json、Cargo.toml、Cargo.lock 写的是同一个版本", () => {
    const pkg = JSON.parse(read("package.json")).version as string;
    const cargo = /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(read("src-tauri/Cargo.toml"));
    const lock = /^name = "ontheway"\r?\nversion = "([^"]+)"/m.exec(read("src-tauri/Cargo.lock"));
    expect(cargo?.[1]).toBe(pkg);
    expect(lock?.[1]).toBe(pkg);
    expect(JSON.parse(read("src-tauri/tauri.conf.json")).version).toBeUndefined();
  });
});
