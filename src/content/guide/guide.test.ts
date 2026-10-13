import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GUIDES,
  carryChecks,
  guideFingerprint,
  guideIdPrefix,
  guideOf,
  newerThan,
  parseVersion,
} from ".";

/*
 * 内置使用指南的正文（welcome.md / syntax.md）会写进每个新用户的仓库，升级时还会替换没改过的那一份。
 * 写错了就是在教用户做不存在的事 —— 这里把正文里说到的东西和代码对一遍：
 * 快捷键真有人接、命令面板里真有那一项、`/` 菜单里真有那几样、双链和小节真能跳过去。
 * 改了快捷键或者菜单却忘了改指南，这里会挂。
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const source = {
  keymap: read("src/editor/markdownKeymap.ts"),
  editor: read("src/editor/MarkdownEditor.tsx"),
  table: read("src/editor/tableWidget.ts"),
  palette: read("src/components/CommandPalette.tsx"),
  shell: read("src/app/Shell.tsx"),
  suggest: read("src/editor/suggest.ts"),
};
const welcome = GUIDES.find((guide) => guide.name === "welcome")!;
const syntax = GUIDES.find((guide) => guide.name === "syntax")!;

/** 「Ctrl+Shift+K」→ 代码里可能的写法：`Shift-Mod-k`、`Mod-Shift-k`…… */
function codeMirrorKeys(combo: string): string[] {
  const parts = combo.split("+");
  const key = parts.pop()!;
  const mods = parts.map((part) => (part === "Ctrl" ? "Mod" : part));
  const name = key.length === 1 ? key.toLowerCase() : key;
  const orders = (items: string[]): string[][] =>
    items.length <= 1
      ? [items]
      : items.flatMap((item, i) =>
          orders([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
        );
  return orders(mods).map((order) => [...order, name].join("-"));
}

/** 不在编辑器 keymap 里的那几个，是谁接的 */
const ELSEWHERE: Record<string, () => boolean> = {
  // Ctrl+0…6：keymap 里用循环生成
  ...Object.fromEntries(
    Array.from({ length: 7 }, (_, level) => [
      `Ctrl+${level}`,
      () =>
        source.keymap.includes("Array.from({ length: 7 }") &&
        source.keymap.includes("`Mod-${level}`"),
    ]),
  ),
  "Ctrl+F": () => source.keymap.includes("...searchKeymap"),
  "Ctrl+K": () =>
    /\(e\.metaKey \|\| e\.ctrlKey\) && e\.key\.toLowerCase\(\) === "k"/.test(source.palette),
  Tab: () => source.keymap.includes("indentWithTab") && source.table.includes('case "Tab":'),
  "Shift+Tab": () =>
    source.keymap.includes("indentWithTab") && source.table.includes("event.shiftKey"),
  "Shift+Enter": () => source.table.includes('case "Enter":') && source.table.includes("<br>"),
  "Ctrl+Enter": () => source.table.includes("else if (mod) insertRow"),
  Esc: () => source.table.includes('case "Escape":') && source.shell.includes('e.key !== "Escape"'),
};

function isBound(combo: string): boolean {
  const special = ELSEWHERE[combo];
  if (special) return special();
  // 源码里是带引号、转义过的字符串：Ctrl+\ 写成 "Mod-\\"
  return codeMirrorKeys(combo).some(
    (key) =>
      source.keymap.includes(JSON.stringify(key)) || source.editor.includes(JSON.stringify(key)),
  );
}

/** 正文里写成 `Ctrl+E` 这样的快捷键 */
function plainCombos(text: string): string[] {
  return [...text.matchAll(/\b((?:Ctrl|Alt|Shift)\+)+[A-Z0-9]\b/g)].map((match) => match[0]);
}

/** 快捷键表里 Windows 那一列：`<kbd>Ctrl</kbd> + <kbd>B</kbd> / <kbd>I</kbd>` → Ctrl+B、Ctrl+I */
function tableCombos(text: string): string[] {
  const entity: Record<string, string> = { "&#96;": "`", "&#92;": "\\" };
  const out: string[] = [];
  for (const row of text
    .split("\n")
    .filter((line) => line.startsWith("|") && line.includes("<kbd>"))) {
    const windows = row.split("|")[2] ?? "";
    for (const alternative of windows.split(/\s\/\s|，或\s/)) {
      const keys = [...alternative.matchAll(/<kbd>(.*?)<\/kbd>/g)].map((match) =>
        match[1]!.replace(/&#\d+;/g, (code) => entity[code] ?? code),
      );
      if (!keys.length) continue;
      // 「Ctrl + 点击」不是按键
      if (alternative.includes("点击")) {
        out.push([...keys, "点击"].join("+"));
        continue;
      }
      // `Ctrl + 1…6`：范围
      const range = /^(\d)…(\d)$/.exec(
        alternative
          .replace(/<\/?kbd>/g, "")
          .split("+")
          .pop()!
          .trim(),
      );
      // 「/ I」只写了最后一个键：沿用前一个组合的修饰键
      const previous = out.at(-1)?.split("+").slice(0, -1) ?? [];
      const combo =
        keys.length === 1 && previous.length && !/^(Tab|Esc|Enter)$/.test(keys[0]!)
          ? [...previous, keys[0]!]
          : keys;
      if (range || alternative.includes("…")) {
        const [from, to] = [Number(keys.at(-2)), Number(keys.at(-1))];
        for (let n = from; n <= to; n++) out.push([...combo.slice(0, -2), String(n)].join("+"));
        continue;
      }
      out.push(combo.join("+"));
    }
  }
  return out;
}

describe("指南里说到的快捷键都真有人接", () => {
  const combos = [
    ...plainCombos(welcome.body),
    ...plainCombos(syntax.body),
    ...tableCombos(syntax.body),
  ];

  it("找得到快捷键（解析没坏）", () => {
    expect(combos).toContain("Ctrl+K");
    expect(combos).toContain("Ctrl+Shift+K");
    expect(combos).toContain("Alt+Shift+5");
    expect(combos).toContain("Ctrl+6");
    expect(combos.length).toBeGreaterThan(25);
  });

  for (const combo of new Set(combos)) {
    // 「Ctrl + 点击」不是按键
    if (combo.endsWith("+点击")) continue;
    it(combo, () => {
      expect(isBound(combo)).toBe(true);
    });
  }
});

describe("指南里说到的命令和菜单都在", () => {
  it("命令面板里的那几项", () => {
    const named = [
      ...`${welcome.body}\n${syntax.body}`.matchAll(/命令面板[^「\n]*「([^」]+)」/g),
    ].map((match) => match[1]!);
    expect(named).toContain("使用指南");
    for (const label of named) expect(source.palette).toContain(`"${label}"`);
  });

  it("「/」菜单里的那几样", () => {
    const line = welcome.body.split("\n").find((item) => item.includes("行首输入 `/`"))!;
    const listed = /：(.+?)……/.exec(line)![1]!.split("、");
    expect(listed.length).toBeGreaterThan(3);
    for (const label of listed) {
      expect(source.suggest).toMatch(new RegExp(`label: "[^"]*${label}[^"]*"`));
    }
  });
});

describe("指南里的双链都能跳过去", () => {
  const titles = new Set(GUIDES.map((guide) => guide.title));
  const headings = (body: string) =>
    new Set(body.split("\n").flatMap((line) => /^#{1,6}\s+(.+)$/.exec(line)?.slice(1) ?? []));

  for (const guide of GUIDES) {
    it(guide.title, () => {
      // 代码块、行内代码里的是在讲语法，不算
      const prose = guide.body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
      for (const [, inner = ""] of prose.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
        if (inner === "TOC") continue;
        const [target = "", section] = inner.split("|")[0]!.split("#");
        expect(titles, `[[${inner}]]`).toContain(target.trim());
        if (section) {
          const linked = GUIDES.find((item) => item.title === target.trim())!;
          expect(headings(linked.body), `[[${inner}]]`).toContain(section.trim());
        }
      }
    });
  }
});

describe("指南是给用户看的", () => {
  for (const guide of GUIDES) {
    it(`${guide.title}：没有开发用的内容、不靠外网图片`, () => {
      expect(guide.body).not.toMatch(/压力测试|SQLite|CodeMirror|picsum/);
      expect(guide.body).not.toMatch(/!\[[^\]]*\]\(https?:/);
      // 标题由笔记的标题显示，正文里不再写一遍一级标题
      expect(guide.body).not.toMatch(/^# /m);
    });
  }

  it("指南里的待办都不带日期（不会出现在新用户的日历上）", () => {
    for (const guide of GUIDES) {
      const prose = guide.body.replace(/```[\s\S]*?```/g, "");
      const dated = prose
        .split("\n")
        .filter((line) => /^\s*[-*+] \[[ xX]\].*@\d{4}-\d{2}-\d{2}/.test(line));
      expect(dated, guide.title).toEqual([]);
    }
  });
});

describe("新旧", () => {
  it("勾选框不算改过", () => {
    const body = "说明\n- [ ] 第一件\n  - [X] 第二件\n";
    expect(guideFingerprint(body)).toBe(
      guideFingerprint(body.replace("[ ]", "[x]").replace("[X]", "[ ]")),
    );
    expect(guideFingerprint(body)).not.toBe(guideFingerprint("说明\n- [ ] 第一件改了\n"));
  });

  it("换成新版时勾过的照勾", () => {
    const next = carryChecks(
      "- [x] 第一件\n- [ ] 第二件\n- [x] 删掉了的一件",
      "- [ ] 第一件\n- [ ] 第二件\n- [ ] 新加的",
    );
    expect(next).toBe("- [x] 第一件\n- [ ] 第二件\n- [ ] 新加的");
  });

  it("按版本号认谁新", () => {
    expect(parseVersion("1.12.3-beta")).toEqual([1, 12, 3]);
    expect(newerThan("0.2.0", "0.1.9")).toBe(true);
    expect(newerThan("0.1.0", "0.1.0")).toBe(false);
    expect(newerThan("坏了", "0.1.0")).toBe(false);
  });

  it("认得出哪篇是指南", () => {
    expect(guideOf(`${guideIdPrefix("syntax")}0190-abc`)?.title).toBe("语法全览");
    expect(guideOf("0190-abc")).toBeUndefined();
  });
});
