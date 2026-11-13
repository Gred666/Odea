import { describe, expect, it } from "vitest";
import { noteEmbedTarget, sectionOf } from "./embeds";

describe("嵌入的目标", () => {
  it("reads the note and the section, ignoring an alias", () => {
    expect(noteEmbedTarget("周报")).toEqual({ title: "周报" });
    expect(noteEmbedTarget(" 周报 # 本周进展 ")).toEqual({ title: "周报", heading: "本周进展" });
    expect(noteEmbedTarget("周报|这周")).toEqual({ title: "周报" });
    expect(noteEmbedTarget("周报.md#结论")).toEqual({ title: "周报", heading: "结论" });
    expect(noteEmbedTarget("周报#项目#风险"), "取最后一段").toEqual({
      title: "周报",
      heading: "风险",
    });
    expect(noteEmbedTarget("v1.2 发布说明"), "标题里的点不是扩展名").toEqual({
      title: "v1.2 发布说明",
    });
  });

  it("leaves attachments, block references and empty targets alone", () => {
    expect(noteEmbedTarget("Pasted image 20261111.png")).toBeNull();
    expect(noteEmbedTarget("说明书.PDF")).toBeNull();
    expect(noteEmbedTarget("周报^abc123")).toBeNull();
    expect(noteEmbedTarget("周报#^abc123")).toBeNull();
    expect(noteEmbedTarget("#只有小节")).toBeNull();
    expect(noteEmbedTarget("  ")).toBeNull();
  });
});

describe("取一节", () => {
  const note = [
    "# 周报",
    "开头",
    "## 本周进展",
    "做完了两件事",
    "### 细节",
    "第一件",
    "```",
    "## 代码里的不算",
    "```",
    "## 下周计划",
    "还没想",
  ].join("\n");

  it("runs from the heading to the next heading of the same or a higher level", () => {
    expect(sectionOf(note, "本周进展")).toBe(
      "## 本周进展\n做完了两件事\n### 细节\n第一件\n```\n## 代码里的不算\n```",
    );
    expect(sectionOf(note, "细节")).toBe("### 细节\n第一件\n```\n## 代码里的不算\n```");
    expect(sectionOf(note, "下周计划")).toBe("## 下周计划\n还没想");
    expect(sectionOf(note, "周报"), "一级标题一直到最后").toBe(note);
  });

  it("matches headings loosely and says when there is none", () => {
    expect(sectionOf("## 本周  进展 ##\n内容", " 本周 进展")).toBe("## 本周  进展 ##\n内容");
    expect(sectionOf("## Plan\n内容", "plan")).toBe("## Plan\n内容");
    expect(sectionOf(note, "代码里的不算")).toBeNull();
    expect(sectionOf(note, "没有这一节")).toBeNull();
  });
});
