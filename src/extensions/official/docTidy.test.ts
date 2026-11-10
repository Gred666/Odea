import { LIMITS, PluginRuntime } from "@/plugins/sandbox/runtime";
import { fakeHost, inProcessSandbox, until } from "@/plugins/sandbox/testkit";
import { describe, expect, it } from "vitest";
import { officialCode, officialPlugin } from "../catalog";
import { capabilityKey, validateManifest } from "../manifest";

/*
 * 官方的「文档整理」（L1 的示例插件，docs/插件与跨端.md §15）：跑在真的 odea 上（进程里的沙箱），
 * 正文后面列出能整理的地方，点了按钮改正文。代码块、属性块里的不动，行尾两个空格（换行）不动
 */

const manifest = validateManifest(officialPlugin("odea.doc-tidy"), {
  navIds: ["notes"],
  templateScopes: ["note"],
  official: true,
});
const code = officialCode("odea.doc-tidy")!;

const MESSY = [
  "---",
  "title: 留着   ",
  "---",
  "# 标题",
  "",
  "",
  "",
  "正文行尾有空格   ",
  "硬换行  ",
  "接着写",
  "",
  "### 跳了一级",
  "",
  "```js",
  "const x = 1;   ",
  "",
  "",
  "```",
  "",
].join("\n");

function setup(text: string) {
  const app = fakeHost({ a: { title: "乱", text } });
  const sandbox = inProcessSandbox();
  const runtime = new PluginRuntime(
    manifest,
    code,
    (manifest.capabilities ?? []).map(capabilityKey),
    app.host,
    sandbox.factory,
    { onStatus() {}, onLog() {}, onWarn() {} },
    { ...LIMITS, pingInterval: 1e9 },
  );
  const doc = () => ({ ...app.host.current()!, text: app.text("a") });
  return { app, runtime, doc };
}

describe("文档整理", () => {
  it("列出能整理的地方：属性块、代码块、硬换行都不算", async () => {
    const { runtime, doc } = setup(MESSY);
    await runtime.start();
    const tree = await runtime.renderSlot("tidy", doc());
    expect(tree).toMatchObject({
      type: "stack",
      children: [
        { type: "text", text: "这篇有 1 行行尾有空格、2 个多余的空行、1 个标题跳了级。" },
        {
          type: "list",
          items: [{ id: "h12", title: "第 12 行：跳了一级", actions: [{ label: "改成 2 级" }] }],
        },
        {
          type: "buttons",
          buttons: [{ action: "trailing" }, { action: "blank" }, { action: "all", primary: true }],
        },
      ],
    });
  });

  it("全部整理：一笔改完，没碰代码块和属性块", async () => {
    const { runtime, app, doc } = setup(MESSY);
    await runtime.start();
    await runtime.slotAction("tidy", doc(), "all");
    expect(app.text("a")).toBe(
      [
        "---",
        "title: 留着   ",
        "---",
        "# 标题",
        "",
        "正文行尾有空格",
        "硬换行  ",
        "接着写",
        "",
        "## 跳了一级",
        "",
        "```js",
        "const x = 1;   ",
        "",
        "",
        "```",
        "",
      ].join("\n"),
    );
    // 整理完了：那一段不出现
    expect(await runtime.renderSlot("tidy", doc())).toBeNull();
  });

  it("只改一个标题；整齐的文档什么都不画", async () => {
    const { runtime, app, doc } = setup("# 一\n\n#### 四\n");
    await runtime.start();
    await runtime.slotAction("tidy", doc(), "heading", 3);
    expect(app.text("a")).toBe("# 一\n\n## 四\n");
    expect(await runtime.renderSlot("tidy", doc())).toBeNull();
  });

  it("命令：整理正在看的那一篇，提示条里说改了几处", async () => {
    const { runtime, app } = setup("a  \t\nb\n\n\n\nc");
    await runtime.start();
    await runtime.runCommand("tidy.all");
    expect(app.text("a")).toBe("a\nb\n\nc");
    await until(() => app.notices.length === 1);
    expect(app.notices[0]).toBe("文档整理：「乱」整理好了，改了 3 处");
  });
});
