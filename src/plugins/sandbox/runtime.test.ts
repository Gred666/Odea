import { validateManifest } from "@/extensions/manifest";
import { describe, expect, it } from "vitest";
import { LIMITS, type Limits, PluginRuntime, type RuntimeStatus } from "./runtime";
import { fakeHost, inProcessSandbox, until } from "./testkit";

/*
 * 一个 L1 插件跑起来以后（docs/插件与跨端.md §5.4、§5.5）：宿主、协议、插件看到的 odea 都是真的，
 * 沙箱换成进程里的一对端口（testkit.ts）。P14.3 的验收里这几条在这里钉住：
 * - 示例插件能读选中的文档、交一笔编辑、出一张声明式视图
 * - 停用后不留残留（沙箱拆了、宿主这边的监听、订阅、计时器都撤了）
 * - 插件抛错、卡死都不挡住别的：启动失败只是这个插件失败；卡死的超时、两次就停下它
 */

const context = { navIds: ["notes"], templateScopes: ["note"] };

function manifestWith(capabilities: { name: string; scope: string }[] = [], extra = {}) {
  return validateManifest(
    {
      schemaVersion: 2,
      id: "someone.test",
      name: "测试插件",
      version: "1.0.0",
      author: "someone",
      summary: "测一测",
      category: "editor",
      api: "^1.1",
      main: "main.js",
      capabilities,
      contributes: {
        commands: [
          { id: "run", title: "跑" },
          { id: "hang", title: "卡住" },
        ],
        documentSlots: [{ id: "panel", slot: "afterBody", title: "面板" }],
      },
      ...extra,
    },
    context,
  );
}

const READ = { name: "documents.read", scope: "current" };
const EDIT = { name: "documents.edit", scope: "current" };
const VAULT = { name: "documents.read", scope: "vault" };

/** 假的端口每条消息都隔一个宏任务才到：正常的调用给足时间，卡死的用例再单独调短 */
const QUICK: Limits = {
  ...LIMITS,
  callTimeout: 1000,
  deactivateTimeout: 50,
  pingInterval: 1e9,
  callsPerMinute: 20,
};

function setup(code: string, capabilities = [READ, EDIT], limits: Limits = QUICK) {
  const manifest = manifestWith(capabilities);
  const app = fakeHost({
    a: { title: "甲", text: "一二三   \n" },
    b: { title: "乙", text: "看得见" },
    hidden: { title: "丙", text: "看不见", visible: false },
  });
  const sandbox = inProcessSandbox();
  const statuses: RuntimeStatus[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const runtime = new PluginRuntime(
    manifest,
    code,
    capabilities.map(({ name, scope }) => `${name}:${scope}`),
    app.host,
    sandbox.factory,
    {
      onStatus: (status) => statuses.push(status),
      onLog: (_level, message) => logs.push(message),
      onWarn: (message) => warnings.push(message),
    },
    limits,
  );
  return { runtime, app, sandbox, statuses, logs, warnings };
}

/** 插件把结果交给宿主的办法：ui.notify（提示条） */
const report = (expression: string) => `odea.ui.notify(JSON.stringify(${expression}))`;

describe("L1 插件的运行时", () => {
  it("读选中的文档、交一笔编辑、出一张声明式视图", async () => {
    const { runtime, app } = setup(`
      odea.commands.register("run", async () => {
        const current = await odea.documents.current();
        const doc = await odea.documents.read(current.ref);
        const at = doc.text.indexOf("   ");
        const result = await odea.documents.edit(doc.ref, doc.revision, [{ from: at, to: at + 3, insert: "" }]);
        ${report("{ title: doc.title, revision: result.revision, plugin: odea.plugin.id }")};
      });
      odea.slots.register("panel", {
        render(doc) {
          return { type: "stack", children: [
            { type: "text", text: doc.title + "：" + doc.text.length + " 字" },
            { type: "buttons", buttons: [{ action: "upper", label: "加感叹号" }] },
          ] };
        },
        async onAction({ action, doc }) {
          const read = await odea.documents.read(doc.ref);
          await odea.documents.edit(doc.ref, read.revision, [{ from: read.text.length, to: read.text.length, insert: "！" }]);
        },
      });
    `);
    await runtime.start();
    expect(runtime.status.state).toBe("running");

    await runtime.runCommand("run");
    expect(app.text("a")).toBe("一二三\n");
    await until(() => app.notices.length === 1);
    expect(JSON.parse(app.notices[0]!.replace(/^测试插件：/, ""))).toEqual({
      title: "甲",
      revision: "a.1",
      plugin: "someone.test",
    });

    const doc = { ref: { type: "note", key: "b" }, title: "乙", revision: "b.0" };
    const tree = await runtime.renderSlot("panel", { ...doc, text: "看得见" });
    expect(tree).toEqual({
      type: "stack",
      children: [
        { type: "text", text: "乙：3 字" },
        { type: "buttons", buttons: [{ action: "upper", label: "加感叹号" }] },
      ],
    });
    await runtime.slotAction("panel", doc, "upper");
    expect(app.text("b")).toBe("看得见！");
  });

  it("能力：没申请的、没同意的回 denied；current 只能读看得见的", async () => {
    const code = `
      odea.commands.register("run", async () => {
        const tries = {};
        const attempt = async (name, run) => {
          try { await run(); tries[name] = "ok"; } catch (error) { tries[name] = error.code; }
        };
        await attempt("看得见", () => odea.documents.read({ type: "note", key: "b" }));
        await attempt("看不见", () => odea.documents.read({ type: "note", key: "hidden" }));
        await attempt("列表", () => odea.documents.list());
        await attempt("改", () => odea.documents.edit({ type: "note", key: "b" }, "b.0", [{ from: 0, to: 0, insert: "x" }]));
        await attempt("乱写的引用", () => odea.documents.read("../../etc/passwd"));
        await attempt("没有的方法", () => new Promise((resolve, reject) => {
          // 绕开 odea 直接发：宿主照样只认它登记过的
          self.postMessage({ id: 999999, method: "fs.readFile", params: { path: "/" } });
          setTimeout(resolve, 20);
        }));
        ${report("tries")};
      });
    `;
    const readOnly = setup(code, [READ]);
    await readOnly.runtime.start();
    await readOnly.runtime.runCommand("run");
    await until(() => readOnly.app.notices.length === 1);
    expect(JSON.parse(readOnly.app.notices[0]!.replace(/^测试插件：/, ""))).toEqual({
      看得见: "ok",
      看不见: "denied",
      列表: "denied",
      改: "denied",
      乱写的引用: "invalid",
      没有的方法: "ok",
    });
    expect(readOnly.app.text("b")).toBe("看得见");

    // 申请了 vault、用户同意了：看不见的也能读，列表也有
    const vault = setup(code, [VAULT]);
    await vault.runtime.start();
    await vault.runtime.runCommand("run");
    await until(() => vault.app.notices.length === 1);
    expect(JSON.parse(vault.app.notices[0]!.replace(/^测试插件：/, ""))).toMatchObject({
      看不见: "ok",
      列表: "ok",
    });
  });

  it("照着旧的那一版改：stale，插件重新读一遍再改", async () => {
    const { runtime, app } = setup(`
      odea.commands.register("run", async () => {
        const first = await odea.documents.read({ type: "note", key: "a" });
        await odea.ui.notify("读好了");
        await new Promise((resolve) => setTimeout(resolve, 40));
        const codes = [];
        try {
          await odea.documents.edit(first.ref, first.revision, [{ from: 0, to: 1, insert: "壹" }]);
        } catch (error) {
          codes.push(error.code);
          const again = await odea.documents.read(first.ref);
          await odea.documents.edit(again.ref, again.revision, [{ from: 0, to: 1, insert: "壹" }]);
          codes.push("重试好了");
        }
        ${report("codes")};
      });
    `);
    await runtime.start();
    const running = runtime.runCommand("run");
    await until(() => app.notices.length === 1);
    app.type("a", "一二三四");
    await running;
    await until(() => app.notices.length === 2);
    expect(app.notices[1]).toContain('["stale","重试好了"]');
    expect(app.text("a")).toBe("壹二三四");
  });

  it("订阅：正文改了、换了一篇都推过来；退订以后不再推", async () => {
    const { runtime, app } = setup(`
      const seen = [];
      const change = odea.documents.onChange((doc) => seen.push("改了 " + doc.ref.key + " " + doc.revision));
      odea.documents.onCurrentChange((doc) => seen.push("换到 " + (doc ? doc.title : "无")));
      odea.commands.register("run", async () => {
        change.dispose();
        ${report("seen")};
      });
    `);
    await runtime.start();
    await until(() => app.listeners() === 2);
    app.type("b", "新的");
    app.focus("b");
    app.focus("hidden"); // 看不见的那一篇：插件只有 current，推过来的是 null
    await new Promise((resolve) => setTimeout(resolve, 30));
    await runtime.runCommand("run");
    await until(() => app.notices.length === 1);
    expect(app.notices[0]).toContain('["改了 b b.1","换到 乙","换到 无"]');
    await until(() => app.listeners() === 1);
  });

  it("槽位：主动换、JSON Patch 改；交来的不合规矩的不换上", async () => {
    const { runtime, app, logs } = setup(`
      odea.slots.register("panel", { render() { return { type: "script", src: "x" }; } });
      odea.commands.register("run", async () => {
        const ref = { type: "note", key: "b" };
        await odea.slots.update("panel", ref, { type: "stack", children: [{ type: "text", text: "一" }] });
        await odea.slots.patch("panel", ref, [{ op: "replace", path: "/children/0/text", value: "二" }]);
        let code = "";
        try { await odea.slots.update("panel", ref, { type: "iframe" }); } catch (error) { code = error.code; }
        try { await odea.slots.update("panel", { type: "note", key: "hidden" }, null); } catch (error) { code += "," + error.code; }
        ${report("code")};
      });
    `);
    await runtime.start();
    await runtime.runCommand("run");
    await until(() => app.notices.length === 1);
    expect(app.notices[0]).toContain('"invalid,unavailable"');
    expect(app.slots.get("panel\nb")).toEqual({
      type: "stack",
      children: [{ type: "text", text: "二" }],
    });
    const doc = { ref: { type: "note", key: "b" }, title: "乙", revision: "b.0" };
    expect(await runtime.renderSlot("panel", doc)).toBeUndefined();
    expect(logs.at(-1)).toContain("交来的视图不对");
  });

  it("停用：先问一声，再把它名下的东西一次撤掉（沙箱、订阅、监听），不留残留", async () => {
    const { runtime, app, sandbox, statuses } = setup(`
      odea.documents.onChange(() => {});
      odea.documents.onCurrentChange(() => {});
      odea.onDeactivate(async () => { await odea.ui.notify("收尾"); });
      odea.commands.register("run", () => new Promise(() => {}));
    `);
    await runtime.start();
    await until(() => app.listeners() === 2);
    const pending = runtime.runCommand("run").catch((error) => error.code);
    await runtime.stop();
    expect(app.notices).toEqual(["测试插件：收尾"]);
    expect(await pending).toBe("cancelled");
    expect(app.listeners()).toBe(0);
    expect(sandbox.stats).toEqual({ created: 1, disposed: 1 });
    expect(statuses.at(-1)).toEqual({ state: "idle" });
    // 停了以后再用到：重新起一个
    await runtime.start();
    expect(sandbox.stats.created).toBe(2);
  });

  it("插件抛错：启动失败，只是它自己失败；语法写错了也一样", async () => {
    const thrown = setup(`throw new Error("我坏了")`);
    await expect(thrown.runtime.start()).rejects.toThrow("我坏了");
    expect(thrown.runtime.status).toMatchObject({ state: "failed" });
    expect(thrown.sandbox.stats).toEqual({ created: 1, disposed: 1 });

    const syntax = setup(`odea.commands.register("run", () => {`);
    await expect(syntax.runtime.start()).rejects.toThrow("脚本出错了");

    // 命令里抛的错：这一次没做成，插件照常在跑
    const command = setup(
      `odea.commands.register("run", () => { throw new TypeError("参数不对"); })`,
    );
    await command.runtime.start();
    await expect(command.runtime.runCommand("run")).rejects.toMatchObject({
      code: "failed",
      message: "参数不对",
    });
    expect(command.runtime.status.state).toBe("running");
  });

  it("卡死：超时先警告，第二次就停下它；停下以后要重新启动才再起", async () => {
    const { runtime, app, sandbox, warnings } = setup(
      `
      odea.documents.onChange(() => {});
      odea.commands.register("hang", () => new Promise(() => {}));
      odea.commands.register("run", () => "好");
    `,
      [READ, EDIT],
      { ...QUICK, callTimeout: 150 },
    );
    await runtime.start();
    await expect(runtime.runCommand("hang")).rejects.toMatchObject({ code: "timeout" });
    expect(runtime.status.state).toBe("running");
    expect(warnings.at(-1)).toContain("再这样就停下它");
    await expect(runtime.runCommand("hang")).rejects.toMatchObject({ code: "timeout" });
    expect(runtime.status).toMatchObject({ state: "stopped" });
    expect(warnings.at(-1)).toContain("这次先停下了");
    expect(sandbox.stats.disposed).toBe(1);
    expect(app.listeners()).toBe(0);
    await expect(runtime.start()).rejects.toThrow("这次先停下了");
    await runtime.restart();
    await runtime.runCommand("run");
    expect(runtime.status.state).toBe("running");
  });

  it("心跳没回应：一样算卡住，两次就停下", async () => {
    const { runtime, sandbox, warnings } = setup(
      // 把消息循环换掉（宿主发来的什么都不回），模拟启动以后进了死循环
      `odea.commands.register("run", () => {});
       setTimeout(() => { self.onmessage = () => {}; });`,
      [READ],
      { ...QUICK, pingInterval: 40, callTimeout: 60 },
    );
    await runtime.start();
    expect(runtime.status.state).toBe("running");
    await until(() => runtime.status.state === "stopped", 3000);
    expect(warnings[0]).toContain("卡住了");
    expect(sandbox.stats.disposed).toBe(1);
  });

  it("调用太频繁：超了的回 budget，先警告，再超就停下", async () => {
    const { runtime, warnings, sandbox } = setup(
      `
      odea.commands.register("run", async () => {
        const codes = new Set();
        for (let i = 0; i < 30; i++) {
          await odea.documents.current().then(() => codes.add("ok"), (error) => codes.add(error.code));
        }
        await odea.ui.notify([...codes].join(",")).catch(() => {});
      });
      odea.commands.register("hang", () => new Promise(() => {}));
    `,
      [READ, EDIT],
      { ...QUICK, callTimeout: 2000 },
    );
    await runtime.start();
    await runtime.runCommand("run");
    await until(() => warnings.length === 1);
    expect(warnings[0]).toContain("一分钟里调用了 20 次以上");
    expect(runtime.status.state).toBe("running");
    await expect(runtime.runCommand("hang")).rejects.toMatchObject({ code: "timeout" });
    expect(runtime.status).toMatchObject({ state: "stopped" });
    expect(sandbox.stats.disposed).toBe(1);
  });

  it("提示条一分钟最多 5 条", async () => {
    const { runtime, app } = setup(`
      odea.commands.register("run", async () => {
        for (let i = 0; i < 8; i++) await odea.ui.notify("第 " + i + " 条").catch(() => {});
      });
    `);
    await runtime.start();
    await runtime.runCommand("run");
    expect(app.notices).toHaveLength(5);
  });
});
