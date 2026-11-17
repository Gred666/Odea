import { buildOutline } from "@/lib/markdown";
import { makeExcerpt } from "@/lib/plainText";
import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { frontMatterRange, isFrontMatterKey } from "./frontMatter";

// 键是中文、日文的属性块也认（docs/提醒与属性.md §3.3）。同一组样例 Rust 那边
// src-tauri/src/domain/search.rs（keys_may_start_with_any_letter）、vault/frontmatter.rs
// （blocks_whose_keys_are_not_english_are_recognised）也测，结论要一样
// 两组的后半截是刁钻的：带声调的拼音、全角字母、々（Lm）算；全角数字开头、emoji、零宽空格（Cf）不算
// （2026-11-15 复审加的，Rust 那边同一组）。
// 组合符号在字母后面的算（2026-11-17 放宽）：拆开写的重音 e + U+0301、印地文 kya（带半音符 U+094D）、
// 泰文 chue（带声调号 U+0E48）、NFD 写的 タグ（ク + 浊点 U+3099）；组合符号开头的不算
const chars = (...codes: number[]) => String.fromCharCode(...codes);
const ZWSP = chars(0x200b);
const ACUTE = chars(0x301);
const KEYS = [
  "标签: 旅行",
  "截止: 2026-11-20",
  "_x: 1",
  "タグ: a",
  "status: 草稿",
  "my-key : x",
  "é: x",
  "nǚ-ér: x",
  "Ａｂｃ: x",
  "a１: x",
  "々: x",
  "key-名_2: x",
  `e${ACUTE}: x`,
  `${chars(0x915, 0x94d, 0x92f, 0x93e)}: 1`,
  `${chars(0xe0a, 0xe37, 0xe48, 0xe2d)}: a`,
  `${chars(0x30bf, 0x30af, 0x3099)}: a`,
];
const NOT_KEYS = [
  "标签：旅行",
  "1a: x",
  "- 列表项",
  "my key: x",
  "  缩进: x",
  ": x",
  "１a: x",
  "😀: x",
  "a😀: x",
  `${ZWSP}key: x`,
  `ke${ZWSP}y: x`,
  `${ACUTE}e: x`,
];

const block = (line: string) => `---\n${line}\n---\n正文`;

describe("属性块的键", () => {
  it.each(KEYS)("%s 算", (line) => {
    expect(isFrontMatterKey(line)).toBe(true);
    expect(frontMatterRange(Text.of(block(line).split("\n")))).toMatchObject({ closeLine: 3 });
    expect(makeExcerpt(block(line), 200)).toBe("正文");
  });

  it.each(NOT_KEYS)("%s 不算", (line) => {
    expect(isFrontMatterKey(line)).toBe(false);
    expect(frontMatterRange(Text.of(block(line).split("\n")))).toBeNull();
    expect(makeExcerpt(block(line), 200)).not.toBe("正文");
  });

  it("目录不收属性块里的行（以前 `标签: 旅行` 加下面的 `---` 被当成一个 Setext 标题）", () => {
    const outline = (md: string) => buildOutline(md).map((item) => item.text);
    expect(outline("---\n标签: 旅行\n---\n\n## 行程")).toEqual(["概览", "行程"]);
    expect(outline("---\n标签：旅行\n---\n\n## 行程")).toEqual(["概览", "标签：旅行", "行程"]);
  });
});
