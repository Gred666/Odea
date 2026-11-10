import type { PluginManifest } from "./manifest";
import docTidyCode from "./official/doc-tidy/main.js?raw";
import docTidyManifest from "./official/doc-tidy/manifest.json";

/* ============================================================
   官方目录：跟着应用一起发的插件（docs/插件与跨端.md §5.1）。还没有网上的目录服务，
   「安装」就是把这份清单（带脚本的连同脚本）拷进这台设备（extensions/installed.ts），再在当前仓库里开上。
   带脚本的（L1）照样跑在沙箱里、装之前照样问权限：官方的只是不用自己去找文件。

   以前这里还列着「数学公式」「Mermaid 图表」两项、能「下载」一份清单：那两样是跟着编辑器一起编译的
   内置功能（L2），一直开着，不是能装的插件，P14.2 拿掉了。
   ============================================================ */

/**
 * 增强 Callout：多认九种提示块。标签和 Obsidian 的类型对得上（`> [!summary]`、`> [!todo]`……），
 * 从 Obsidian 搬过来的笔记不再都是中性的灰色。停用后正文一个字不改，这些标签回到中性的样子
 */
const callouts: PluginManifest = {
  schemaVersion: 2,
  id: "odea.callouts",
  name: "增强 Callout",
  version: "1.0.0",
  author: "Odea",
  summary: "多认九种提示块：摘要、待办、完成、问题、失败、缺陷、例子、引用、灵感，各有图标和配色。",
  description:
    "中英文标签都认，和 Obsidian 的提示块类型对得上：`> [!summary]`、`> [!todo]`、`> [!question]` 这些不再都是灰的。停用后正文一个字不改，这些标签回到中性的样子。",
  category: "appearance",
  api: "^1.0",
  platforms: ["desktop", "mobile"],
  contributes: {
    callouts: [
      {
        label: "摘要",
        aliases: ["abstract", "summary", "tldr", "总结", "概要"],
        kind: "note",
        icon: "clipboard-list",
      },
      { label: "待办", aliases: ["todo"], kind: "note", icon: "circle-check" },
      { label: "完成", aliases: ["success", "check", "done", "成功"], kind: "tip", icon: "check" },
      {
        label: "问题",
        aliases: ["question", "help", "faq", "疑问"],
        kind: "warning",
        icon: "circle-help",
      },
      { label: "失败", aliases: ["failure", "fail", "missing"], kind: "caution", icon: "x" },
      { label: "缺陷", aliases: ["bug"], kind: "caution", icon: "bug" },
      { label: "例子", aliases: ["example", "示例", "举例"], kind: "important", icon: "list" },
      { label: "引用", aliases: ["quote", "cite", "引文"], kind: "generic", icon: "quote" },
      { label: "灵感", aliases: ["idea", "想法"], kind: "tip", icon: "sparkles" },
    ],
  },
};

/** 笔记模板：在笔记里一行只写 `/模板`，插入会议记录、读书笔记、复盘 */
const noteTemplates: PluginManifest = {
  schemaVersion: 2,
  id: "odea.note-templates",
  name: "笔记模板",
  version: "1.0.0",
  author: "Odea",
  summary: "在笔记里输入 /模板，插入会议记录、读书笔记、复盘。",
  description:
    "模板是 Markdown 加占位符：{{date}}、{{time}}、{{weekday}} 插入时换成当时的日期、时间、星期，{{cursor}} 是插入后光标停的地方。",
  category: "productivity",
  api: "^1.0",
  contributes: {
    templates: [
      {
        name: "会议记录",
        scope: "note",
        description: "时间、参会、议题、结论、待办",
        body: "**时间**：{{date:YYYY年M月D日}} {{weekday}} {{time}}\n**参会**：{{cursor}}\n\n## 议题\n\n## 结论\n\n## 待办\n\n- [ ] ",
      },
      {
        name: "读书笔记",
        scope: "note",
        description: "书名、一句话、摘抄、想法",
        body: "**书名**：{{cursor}}\n**作者**：\n**读完**：{{date}}\n\n## 一句话\n\n## 摘抄\n\n> \n\n## 想法\n",
      },
      {
        name: "复盘",
        scope: "note",
        description: "发生了什么、做得好的、可以更好的、下一步",
        body: "## 发生了什么\n\n{{cursor}}\n\n## 做得好的\n\n## 可以更好的\n\n## 下一步\n\n- [ ] ",
      },
    ],
  },
};

/**
 * 文档整理（L1）：正文后面列出行尾空格、多余的空行、跳级的标题，点一下改好。
 * 清单和脚本就是 official/doc-tidy/ 里那两个文件，拿去「从文件安装」也一样
 */
const docTidy = docTidyManifest as unknown as PluginManifest;

export const OFFICIAL_PLUGINS: readonly PluginManifest[] = [callouts, noteTemplates, docTidy];

/** 官方插件的脚本（带脚本的才有） */
const OFFICIAL_CODE: Readonly<Record<string, string>> = { [docTidy.id]: docTidyCode };

export function officialPlugin(id: string): PluginManifest | undefined {
  return OFFICIAL_PLUGINS.find((manifest) => manifest.id === id);
}

export function officialCode(id: string): string | undefined {
  return OFFICIAL_CODE[id];
}

/** 清单文件最大多少：L0 只是一份 JSON，模板再多也到不了这么大 */
export const MAX_MANIFEST_BYTES = 1024 * 1024;
/** 脚本最大多少：存在 localStorage 里，几个插件加起来也不能把它撑满 */
export const MAX_CODE_BYTES = 1024 * 1024;
