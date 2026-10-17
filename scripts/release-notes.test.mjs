import { describe, expect, it } from "vitest";
import { parseChangelog } from "../src/content/changelog";
import { problems, releases } from "./release-notes.mjs";

const SAMPLE = `<!--
## 9.9.9 · 注释里的不算
-->

## 0.3.0 · 2026-11-02

- 第三版

## v0.2.1

- 修了一个问题

## 0.2.0

`;

const files = (version, changelog = SAMPLE) => ({
  packageJson: JSON.stringify({ name: "odea", version }),
  cargoToml: `[package]\nname = "odea"\nversion = "${version}"\n\n[dependencies]\nserde = { version = "1" }\n`,
  cargoLock: `[[package]]\nname = "odea"\nversion = "${version}"\n`,
  changelog,
});

describe("发版前的检查", () => {
  it("CI 和应用切更新说明的办法一样", () => {
    expect(releases(SAMPLE)).toEqual(parseChangelog(SAMPLE));
  });

  it("版本、更新说明都对上了就没问题", () => {
    expect(problems("0.3.0", files("0.3.0"))).toEqual([]);
  });

  it("版本号没改、更新说明不是这一版，都拦下来", () => {
    expect(problems("0.4.0", files("0.3.0"))).toHaveLength(4);
    expect(problems("0.3.0", files("0.3.0", "<!-- 只有注释 -->\n"))[0]).toMatch("还没有更新说明");
    // 最上面那一节是空的不算：0.2.0 没写东西，最上面的就是 0.2.1
    expect(problems("0.2.1", files("0.2.1", SAMPLE.slice(SAMPLE.indexOf("## v0.2.1"))))).toEqual(
      [],
    );
  });
});
