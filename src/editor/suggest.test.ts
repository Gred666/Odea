import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { markdownSupport } from "./markdownParser";
import { type WikiCandidate, slashItems, suggestTrigger, wikiItems } from "./suggest";

/** 光标放在 `§` 处（去掉它）的状态，语法树解析完。不用 `|`：双链的别名就是它 */
function stateAt(markdown: string): EditorState {
  const head = markdown.indexOf("§");
  const state = EditorState.create({
    doc: markdown.replace("§", ""),
    selection: EditorSelection.cursor(head),
    extensions: [markdownSupport()],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

describe("suggestTrigger", () => {
  it("opens the insert menu for a slash at the start of a line", () => {
    expect(suggestTrigger(stateAt("前一段\n\n/§"))).toEqual({
      kind: "slash",
      from: 5,
      to: 6,
      query: "",
    });
    expect(suggestTrigger(stateAt("  /bg§"))).toMatchObject({
      kind: "slash",
      from: 2,
      query: "bg",
    });
    // 中文输入法下的 `/` 是 `、`
    expect(suggestTrigger(stateAt("、表§"))).toMatchObject({ kind: "slash", query: "表" });
  });

  it("stays out of the way of ordinary slashes", () => {
    expect(suggestTrigger(stateAt("10/7 开会§"))).toBeNull();
    expect(suggestTrigger(stateAt("见 /§"))).toBeNull();
    // 已有的一行开头插了个 `/`：不是要插入一块
    expect(suggestTrigger(stateAt("/§已经写好的字"))).toBeNull();
    // 打了空格就是在写字了
    expect(suggestTrigger(stateAt("/a b§"))).toBeNull();
    // `/模板` 归模板选择器
    expect(suggestTrigger(stateAt("/模板§"))).toBeNull();
    // 代码里的不算
    expect(suggestTrigger(stateAt("```\n/§\n```"))).toBeNull();
  });

  it("opens the note menu after [[ and keeps the typed filter", () => {
    expect(suggestTrigger(stateAt("见 [[秋季§"))).toEqual({
      kind: "wiki",
      from: 2,
      to: 6,
      query: "秋季",
    });
    expect(suggestTrigger(stateAt("[[§"))).toMatchObject({ kind: "wiki", query: "" });
    // 已经写完的链接后面、别名和小节里都不弹
    expect(suggestTrigger(stateAt("[[秋季]] §"))).toBeNull();
    expect(suggestTrigger(stateAt("[[秋季|别名§"))).toBeNull();
    expect(suggestTrigger(stateAt("[[秋季#小节§"))).toBeNull();
    expect(suggestTrigger(stateAt("`[[代码§`"))).toBeNull();
  });

  it("needs a single empty selection", () => {
    const state = EditorState.create({
      doc: "/",
      selection: EditorSelection.single(0, 1),
    });
    expect(suggestTrigger(state)).toBeNull();
  });
});

describe("slashItems", () => {
  const ids = (query: string, templates = false) =>
    slashItems(query, templates).map(({ item }) => item.id);

  it("lists every block in a fixed order without a filter", () => {
    expect(ids("")[0]).toBe("h1");
    expect(ids("")).not.toContain("template");
    expect(ids("", true)).toContain("template");
  });

  it("finds blocks by name, alias and pinyin initials", () => {
    expect(ids("表格")[0]).toBe("table");
    expect(ids("table")[0]).toBe("table");
    expect(ids("bg")[0]).toBe("table");
    expect(ids("待办")[0]).toBe("todo");
    expect(ids("gs")).toContain("math");
    expect(ids("mb", true)).toContain("template");
    expect(ids("没有这一项")).toEqual([]);
  });
});

describe("wikiItems", () => {
  const notes: WikiCandidate[] = [
    { id: "a", title: "周末采购", folder: "", archived: false },
    { id: "b", title: "秋季项目复盘", folder: "工作", archived: false },
    { id: "c", title: "春季项目复盘", folder: "", archived: true },
  ];

  it("keeps the given (recent first) order without a filter", () => {
    expect(wikiItems("", notes).map(({ item }) => item.kind === "note" && item.note.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("ranks matches, archived ones last, and offers a link to a note that does not exist yet", () => {
    const found = wikiItems("项目复盘", notes);
    expect(found.map(({ item }) => (item.kind === "note" ? item.note.id : item.kind))).toEqual([
      "b",
      "c",
      "new",
    ]);
    expect(found[0]?.ranges).toEqual([[2, 6]]);
    expect(found.at(-1)?.item).toEqual({ kind: "new", title: "项目复盘" });
  });

  it("does not offer a new note when one with that exact title exists", () => {
    expect(wikiItems("周末采购", notes).map(({ item }) => item.kind)).toEqual(["note"]);
  });

  // 两篇同名：选哪一行插进去的都是 `[[样张]]`，点开的是没归档的、最近改过的那篇 —— 只列它，说一句同名几篇（审查 2026-11-13 §5.11）
  it("lists same-titled notes once: the one the link opens, with how many share the title", () => {
    const twins: WikiCandidate[] = [
      { id: "old", title: "样张", folder: "", archived: true },
      { id: "new", title: "样张", folder: "排版", archived: false },
      { id: "x", title: "别的", folder: "", archived: false },
      { id: "other", title: "样张 ", folder: "", archived: false },
    ];
    const all = wikiItems("", twins);
    expect(all.map(({ item }) => item.kind === "note" && item.note.id)).toEqual(["new", "x"]);
    expect(all[0]?.item).toEqual({ kind: "note", note: twins[1], twins: 2 });
    const found = wikiItems("样张", twins);
    expect(found.map(({ item }) => (item.kind === "note" ? item.note.id : item.kind))).toEqual([
      "new",
    ]);
  });
});
