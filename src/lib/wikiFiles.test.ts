import { describe, expect, it } from "vitest";
import {
  attachmentKind,
  attachmentLabel,
  resolveVaultFile,
  wikiFileTarget,
  wikiImageTarget,
} from "./wikiFiles";

describe("![[图.png]] 的写法", () => {
  it("reads the name, a size or a caption", () => {
    expect(wikiImageTarget("图.png")).toEqual({
      name: "图.png",
      alt: "图.png",
      width: null,
      height: null,
    });
    expect(wikiImageTarget(" 附件/图.PNG | 300 ")).toEqual({
      name: "附件/图.PNG",
      alt: "图.PNG",
      width: 300,
      height: null,
    });
    expect(wikiImageTarget("图.jpg|300x200")).toMatchObject({ width: 300, height: 200 });
    expect(wikiImageTarget("图.webp|流程图")).toMatchObject({ alt: "流程图", width: null });
  });

  it("is not an image for notes and other attachments", () => {
    expect(wikiImageTarget("周报")).toBeNull();
    expect(wikiImageTarget("说明书.pdf")).toBeNull();
    expect(wikiImageTarget("v1.2 发布说明")).toBeNull();
  });
});

describe("![[说明书.pdf]] 这类附件的写法", () => {
  it("reads the name and an alias; a size or a page is not an alias", () => {
    expect(wikiFileTarget("说明书.pdf")).toEqual({ name: "说明书.pdf", label: "" });
    expect(wikiFileTarget(" 附件/报表.XLSX | 三季度 ")).toEqual({
      name: "附件/报表.XLSX",
      label: "三季度",
    });
    expect(wikiFileTarget("说明书.pdf#page=3")).toEqual({ name: "说明书.pdf", label: "" });
    expect(wikiFileTarget("演示.mp4|400")).toEqual({ name: "演示.mp4", label: "" });
  });

  it("is not an attachment for images, notes and files that could run", () => {
    expect(wikiFileTarget("图.png")).toBeNull();
    expect(wikiFileTarget("周报")).toBeNull();
    expect(wikiFileTarget("安装.exe")).toBeNull();
    expect(wikiFileTarget("脚本.bat")).toBeNull();
    expect(wikiFileTarget("页面.html")).toBeNull();
  });

  it("knows what to draw and what to call it", () => {
    expect(attachmentKind("a.PDF")).toBe("pdf");
    expect(attachmentKind("录音.m4a")).toBe("audio");
    expect(attachmentKind("演示.webm")).toBe("video");
    // WebView 放不了 mkv：当普通文件
    expect(attachmentKind("电影.mkv")).toBe("file");
    expect(attachmentLabel("报表.xlsx")).toBe("Excel 表格");
    expect(attachmentLabel("录音.flac")).toBe("音频");
    expect(attachmentLabel("设计.psd")).toBe("PSD 文件");
  });
});

describe("按名字在仓库里找文件", () => {
  const files = [
    "附件/图.png",
    "笔记/工作/图.png",
    "笔记/工作/流程.svg",
    "封面.PNG",
    "笔记/深/很/深/封面.png",
  ];

  it("takes a path from the vault root first, then one beside the note", () => {
    expect(resolveVaultFile("附件/图.png", "笔记/工作/周报.md", files)).toBe("附件/图.png");
    expect(resolveVaultFile("./流程.svg", "笔记/工作/周报.md", files)).toBe("笔记/工作/流程.svg");
    expect(resolveVaultFile("../工作/流程.svg", "笔记/生活/日记.md", files)).toBe(
      "笔记/工作/流程.svg",
    );
  });

  it("matches the name anywhere, preferring the note's folder, then the shortest path", () => {
    expect(resolveVaultFile("图.png", "笔记/工作/周报.md", files)).toBe("笔记/工作/图.png");
    expect(resolveVaultFile("图.png", "笔记/生活/日记.md", files)).toBe("附件/图.png");
    expect(resolveVaultFile("封面.png", null, files), "根上那个，不分大小写").toBe("封面.PNG");
    expect(resolveVaultFile("工作/图.png", null, files), "半截路径").toBe("笔记/工作/图.png");
    expect(resolveVaultFile("流程.SVG", "周报.md", files)).toBe("笔记/工作/流程.svg");
  });

  it("finds nothing outside the vault or for unknown names", () => {
    expect(resolveVaultFile("没有.png", "周报.md", files)).toBeNull();
    expect(resolveVaultFile("../../外面.png", "笔记/周报.md", files)).toBeNull();
    expect(resolveVaultFile("图.png", "周报.md", [])).toBeNull();
    expect(resolveVaultFile("  ", "周报.md", files)).toBeNull();
    // 「作/图.png」不是「工作/图.png」的结尾那几段
    expect(resolveVaultFile("作/图.png", null, files)).toBeNull();
  });
});
