import { afterEach, describe, expect, it } from "vitest";
import { folderOf, relPathIn, renamedRelPath, setTreeLayout } from "./folders";
import { ODEA_LAYOUT } from "./types";

/* 树根不同时（docs/仓库与启动器.md §6），一篇笔记算在树上哪个文件夹。和 Rust 的 Layout::folder_of_dir 一样 */

const at = (relPath: string) => folderOf({ relPath });

afterEach(() => setTreeLayout(ODEA_LAYOUT));

describe("树根是「笔记」（Odea 建的仓库）", () => {
  it("相对「笔记」；不在它底下的算在最上面一层", () => {
    expect(at("笔记/周报.md")).toBe("");
    expect(at("笔记/工作/周报/第 40 周.md")).toBe("工作/周报");
    expect(at("随手记.md")).toBe("");
    expect(at("别的工具/一篇.md")).toBe("");
    expect(at("日记/2026/杂记.md")).toBe("");
  });

  it("挪进去、改名都按「笔记」拼", () => {
    expect(relPathIn({ relPath: "笔记/周报.md", title: "周报" }, "工作")).toBe("笔记/工作/周报.md");
    expect(relPathIn({ relPath: "笔记/工作/周报.md", title: "周报" }, "")).toBe("笔记/周报.md");
    expect(renamedRelPath("笔记/工作/周报.md", "工作", "上班")).toBe("笔记/上班/周报.md");
  });
});

describe("树根是整个仓库（没开日程，比如打开的 Obsidian 库）", () => {
  it("文件夹就是仓库里的目录", () => {
    setTreeLayout({ notesDir: "", hiddenDirs: [] });
    expect(at("随手记.md")).toBe("");
    expect(at("工作/周报.md")).toBe("工作");
    expect(at("日记/2026/2026-10-20.md")).toBe("日记/2026");
    expect(relPathIn({ relPath: "工作/周报.md", title: "周报" }, "")).toBe("周报.md");
    expect(relPathIn({ relPath: "周报.md", title: "周报" }, "读书/2026")).toBe("读书/2026/周报.md");
    expect(renamedRelPath("工作/周报.md", "工作", "上班")).toBe("上班/周报.md");
    expect(renamedRelPath("工作区/周报.md", "工作", "上班")).toBe("工作区/周报.md");
  });

  it("开了日程：日记、目标、归档不在树上，里面不是日期的笔记算在最上面一层", () => {
    setTreeLayout({ notesDir: "", hiddenDirs: ["Daily", "目标", "归档"] });
    expect(at("Daily/随便.md")).toBe("");
    expect(at("Daily/2026/随便.md")).toBe("");
    expect(at("Daily本/随便.md")).toBe("Daily本");
    expect(at("工作/周报.md")).toBe("工作");
  });
});
