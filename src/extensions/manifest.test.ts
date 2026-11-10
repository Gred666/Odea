import { describe, expect, it } from "vitest";
import { OFFICIAL_PLUGINS } from "./catalog";
import {
  type ManifestContext,
  ManifestError,
  isColorValue,
  isScripted,
  parseManifestText,
  rangeOf,
  satisfies,
  validateManifest,
} from "./manifest";

/* 清单（schemaVersion 2，docs/插件与跨端.md §5.2）：写坏了要报出是哪个字段（P14.2 的验收） */

const context: ManifestContext = {
  navIds: ["notes", "today", "goal", "calendar", "archive", "extensions"],
  templateScopes: ["note", "day", "week", "month", "year"],
};

const base = {
  schemaVersion: 2,
  id: "someone.callouts-cn",
  name: "中文提示块",
  version: "0.1.0",
  author: "someone",
  summary: "加几种中文的提示块。",
  category: "appearance",
  api: "^1.0",
  contributes: {
    callouts: [
      { label: "灵感", kind: "tip", icon: "lightbulb" },
      { label: "风险", kind: "warning" },
    ],
  },
};

/** 抓住清单报的错：字段路径和整句 */
function failure(value: unknown, ctx: ManifestContext = context) {
  try {
    validateManifest(value, ctx);
  } catch (error) {
    if (error instanceof ManifestError) return { field: error.field, message: error.message };
    throw error;
  }
  throw new Error("应该报错");
}

const withContributes = (contributes: unknown) => ({ ...base, contributes });

describe("插件清单", () => {
  it("设计稿里 L0 的那个例子照样能装，字符串去掉两头空白", () => {
    const manifest = validateManifest(
      { ...base, name: "  中文提示块  ", platforms: ["desktop", "mobile"] },
      context,
    );
    expect(manifest).toMatchObject({
      id: "someone.callouts-cn",
      name: "中文提示块",
      platforms: ["desktop", "mobile"],
      contributes: {
        callouts: [{ label: "灵感", kind: "tip", icon: "lightbulb" }, { label: "风险" }],
      },
    });
  });

  it("官方目录里的每一份都校验得过（官方可以用 odea. 前缀）", () => {
    for (const manifest of OFFICIAL_PLUGINS) {
      expect(validateManifest(manifest, { ...context, official: true })).toEqual(manifest);
    }
    expect(failure(OFFICIAL_PLUGINS[0]).field).toBe("id");
  });

  it.each([
    // 顶层
    [[base], "", "JSON 对象"],
    [{ ...base, schemaVersion: undefined }, "", "缺 schemaVersion"],
    [{ ...base, schemaVersion: 1 }, "schemaVersion", "旧格式"],
    [{ ...base, schemaVersion: 3 }, "schemaVersion", "只认 2"],
    [{ ...base, id: "Bad ID" }, "id", "小写字母"],
    [{ ...base, id: 7 }, "id", "写的是 7"],
    [{ ...base, id: "odea.mine" }, "id", "留给 Odea"],
    [{ ...base, name: 5 }, "name", "要是字符串"],
    [{ ...base, summary: "  " }, "", "缺 summary"],
    [{ ...base, version: "1.0" }, "version", "三段版本号"],
    [{ ...base, category: "theme" }, "category", "只能是 editor"],
    [{ ...base, homepage: "javascript:alert(1)" }, "homepage", "http(s)"],
    [{ ...base, api: "latest" }, "api", "^1.0 这样的范围"],
    [{ ...base, api: "^2.0" }, "api", "这个版本的 Odea 是 1.1"],
    [{ ...base, api: "^1.3" }, "api", "这个版本的 Odea 是 1.1"],
    [{ ...base, platforms: [] }, "platforms", "不能是空的"],
    [{ ...base, platforms: ["ios"] }, "platforms[0]", "只能是 desktop、mobile"],
    [{ ...base, contribute: {} }, "contribute", "不认识这个字段"],
    // 带了脚本、却没有命令也没有槽位：什么时候都不会启动
    [{ ...base, main: "main.js" }, "activation", "什么时候都不会启动"],
    [{ ...base, capabilities: [] }, "capabilities", "只有带脚本（main）的插件"],
    [{ ...base, activation: ["startup"] }, "activation", "只有带脚本（main）的插件"],
    [{ ...base, permissions: ["notes:read"] }, "permissions", "schemaVersion 1"],
    // 贡献点
    [{ ...base, contributes: undefined }, "", "缺 contributes"],
    [withContributes([]), "contributes", "要是一个对象"],
    [withContributes({}), "contributes", "什么都不加"],
    [withContributes({ callouts: [] }), "contributes", "什么都不加"],
    [withContributes({ commands: [] }), "contributes.commands", "要带脚本（main）"],
    [withContributes({ documentSlots: [] }), "contributes.documentSlots", "要带脚本（main）"],
    [withContributes({ importers: [] }), "contributes.importers", "还不支持"],
    [withContributes({ widgets: [] }), "contributes.widgets", "不认识这个字段"],
    // 提示块
    [withContributes({ callouts: {} }), "contributes.callouts", "要是数组"],
    [withContributes({ callouts: ["灵感"] }), "contributes.callouts[0]", "要是一个对象"],
    [
      withContributes({
        callouts: [
          { label: "灵感", kind: "tip" },
          { label: "x", kind: "red" },
        ],
      }),
      "contributes.callouts[1].kind",
      "只能是 note、tip",
    ],
    [withContributes({ callouts: [{ label: "灵感" }] }), "", "缺 contributes.callouts[0].kind"],
    [
      withContributes({ callouts: [{ label: "a]b", kind: "tip" }] }),
      "contributes.callouts[0].label",
      "方括号",
    ],
    [
      withContributes({ callouts: [{ label: "灵感", kind: "tip", icon: "rocket-ship" }] }),
      "contributes.callouts[0].icon",
      "没有叫",
    ],
    [
      withContributes({
        callouts: [
          { label: "灵感", kind: "tip" },
          { label: "想法", aliases: ["灵感"], kind: "tip" },
        ],
      }),
      "contributes.callouts[1].aliases[0]",
      "和 contributes.callouts[0].label 重复了",
    ],
    [
      withContributes({ callouts: [{ label: "灵感", kind: "tip", color: "red" }] }),
      "contributes.callouts[0].color",
      "不认识这个字段",
    ],
    // 模板
    [
      withContributes({ templates: [{ name: "周会", body: "{{date}} {{foo}}" }] }),
      "contributes.templates[0].body",
      "不认识 {{foo}}",
    ],
    [
      withContributes({ templates: [{ name: "周会", body: "{{time:HH}}" }] }),
      "contributes.templates[0].body",
      "不认识 {{time:HH}}",
    ],
    [
      withContributes({ templates: [{ name: "周会", body: "{{cursor}}{{cursor}}" }] }),
      "contributes.templates[0].body",
      "只能有一个",
    ],
    [
      withContributes({ templates: [{ name: "周会", scope: "page", body: "x" }] }),
      "contributes.templates[0].scope",
      "只能是 note、day",
    ],
    [withContributes({ templates: [{ name: "周会" }] }), "", "缺 contributes.templates[0].body"],
    [
      withContributes({ templates: [{ name: "周会", body: "  " }] }),
      "contributes.templates[0].body",
      "不能是空的",
    ],
    [
      withContributes({
        templates: [
          { name: "周会", body: "a" },
          { name: "周会", body: "b" },
        ],
      }),
      "contributes.templates[1].name",
      "重复了",
    ],
    // 主题
    [
      withContributes({ theme: { light: { "font-sans": "#fff" } } }),
      "contributes.theme.light.font-sans",
      "没有这个颜色 token",
    ],
    [
      withContributes({ theme: { dark: { accent: "red; } body { display: none" } } }),
      "contributes.theme.dark.accent",
      "要是颜色",
    ],
    [
      withContributes({ theme: { dark: { accent: "url(https://x.example/a.png)" } } }),
      "contributes.theme.dark.accent",
      "要是颜色",
    ],
    [withContributes({ theme: { sepia: {} } }), "contributes.theme.sepia", "不认识这个字段"],
    // 导航顺序
    [
      withContributes({ navOrder: ["calendar", "inbox"] }),
      "contributes.navOrder[1]",
      '没有叫 "inbox" 的导航项',
    ],
    [withContributes({ navOrder: ["today", "today"] }), "contributes.navOrder[1]", "重复了"],
  ])("写坏了报出字段：%j", (value, field, message) => {
    const result = failure(value);
    expect(result.field).toBe(field);
    expect(result.message).toContain(message);
    if (field) expect(result.message).toContain(`清单里 ${field} 不对`);
  });

  it("不是 JSON 的清单文件也说得清", () => {
    expect(() => parseManifestText("{ schemaVersion: 2 }", context)).toThrow("不是合法的 JSON");
    expect(parseManifestText(JSON.stringify(base), context).id).toBe(base.id);
  });

  it("四样贡献点都整理好交回来", () => {
    const manifest = validateManifest(
      withContributes({
        callouts: [{ label: " 灵感 ", aliases: ["idea"], kind: "tip" }],
        templates: [{ name: "日报", scope: "day", body: "{{ date:YYYY年M月D日 }} {{cursor}}" }],
        theme: { light: { accent: "#0a7d5a", "accent-wash": "rgb(10 125 90 / 0.08)" }, dark: {} },
        navOrder: ["calendar", "notes"],
      }),
      context,
    );
    expect(manifest.contributes).toEqual({
      callouts: [{ label: "灵感", aliases: ["idea"], kind: "tip" }],
      templates: [{ name: "日报", scope: "day", body: "{{ date:YYYY年M月D日 }} {{cursor}}" }],
      theme: { light: { accent: "#0a7d5a", "accent-wash": "rgb(10 125 90 / 0.08)" } },
      navOrder: ["calendar", "notes"],
    });
    // 模板没写 scope 就是笔记的
    const note = validateManifest(
      withContributes({ templates: [{ name: "会议", body: "x" }] }),
      context,
    );
    expect(note.contributes.templates?.[0]?.scope).toBe("note");
  });

  it("颜色只放过十六进制和颜色函数", () => {
    for (const ok of [
      "#fff",
      "#2f63d8",
      "#2f63d8cc",
      "rgb(47 99 216)",
      "rgba(0,0,0,.5)",
      "oklch(62% 0.19 260)",
      "hsl(220deg 70% 50% / 50%)",
    ]) {
      expect(isColorValue(ok), ok).toBe(true);
    }
    for (const bad of [
      "red",
      "#12345",
      "var(--x)",
      "rgb(1 2 3);",
      "rgb(1 2 3)) x",
      "calc(1px)",
      "rgb(url(x))",
    ]) {
      expect(isColorValue(bad), bad).toBe(false);
    }
  });
});

/* ---------------- 带脚本的插件（L1，P14.3） ---------------- */

const scripted = {
  ...base,
  id: "someone.tidy",
  name: "整理",
  category: "editor",
  api: "^1.1",
  main: "main.js",
  capabilities: [
    { name: "documents.read", scope: "current", reason: "看看哪里能整理" },
    { name: "documents.edit", scope: "current" },
  ],
  contributes: {
    commands: [{ id: "tidy.all", title: "整理这篇" }],
    documentSlots: [{ id: "tidy", slot: "afterBody", title: "可以整理的地方" }],
  },
};

describe("带脚本的插件的清单", () => {
  it("命令、槽位、能力都整理好交回来；没写 activation 就是用到哪个贡献点时", () => {
    const manifest = validateManifest(scripted, context);
    expect(isScripted(manifest)).toBe(true);
    expect(manifest.main).toBe("main.js");
    expect(manifest.activation).toEqual(["command:tidy.all", "slot:tidy"]);
    expect(manifest.capabilities).toEqual([
      { name: "documents.read", scope: "current", reason: "看看哪里能整理" },
      { name: "documents.edit", scope: "current" },
    ]);
    expect(manifest.contributes.documentSlots).toEqual([
      { id: "tidy", slot: "afterBody", title: "可以整理的地方" },
    ]);
    expect(isScripted(validateManifest(base, context))).toBe(false);
  });

  it("写了 activation 的照写的；只有 startup 也行（不带贡献点也能一直跑）", () => {
    expect(
      validateManifest({ ...scripted, activation: ["startup", "slot:tidy"] }, context).activation,
    ).toEqual(["startup", "slot:tidy"]);
    const daemon = validateManifest(
      {
        ...scripted,
        activation: ["startup"],
        contributes: { callouts: base.contributes.callouts },
      },
      context,
    );
    expect(daemon.activation).toEqual(["startup"]);
  });

  it("L1 要 api 1.1：设计稿里写 ^1.0 的照样认（1.0 是 1.1 的一部分）", () => {
    expect(validateManifest({ ...scripted, api: "^1.0" }, context).api).toBe("^1.0");
  });

  it.each([
    [{ ...scripted, main: "../evil.js" }, "main", "不带路径"],
    [{ ...scripted, main: "src/main.js" }, "main", "不带路径"],
    [{ ...scripted, main: "main.ts" }, "main", ".js 文件名"],
    [{ ...scripted, capabilities: {} }, "capabilities", "要是数组"],
    [{ ...scripted, capabilities: ["documents.read"] }, "capabilities[0]", "{ name, scope }"],
    [
      { ...scripted, capabilities: [{ name: "net.fetch", hosts: ["x.example"] }] },
      "capabilities[0].name",
      "还没有 net.fetch",
    ],
    [
      { ...scripted, capabilities: [{ name: "documents.read", scope: "vault", why: "x" }] },
      "capabilities[0].why",
      "不认识这个字段",
    ],
    [
      { ...scripted, capabilities: [{ name: "net.fetch", scope: "x.example" }] },
      "capabilities[0].name",
      "还没有 net.fetch",
    ],
    [
      { ...scripted, capabilities: [{ name: "files.write", scope: "vault" }] },
      "capabilities[0].name",
      "只能是 documents.read、documents.edit",
    ],
    [
      { ...scripted, capabilities: [{ name: "toString", scope: "vault" }] },
      "capabilities[0].name",
      "只能是",
    ],
    [
      { ...scripted, capabilities: [{ name: "documents.edit", scope: "vault" }] },
      "capabilities[0].scope",
      "documents.edit 的范围只能是 current",
    ],
    [{ ...scripted, capabilities: [{ name: "documents.read" }] }, "", "缺 capabilities[0].scope"],
    [
      {
        ...scripted,
        capabilities: [
          { name: "documents.read", scope: "vault" },
          { name: "documents.read", scope: "vault" },
        ],
      },
      "capabilities[1]",
      "重复了",
    ],
    [{ ...scripted, activation: [] }, "activation", "不能是空的"],
    [{ ...scripted, activation: ["command:nope"] }, "activation[0]", "声明过"],
    [{ ...scripted, activation: ["onStartup"] }, "activation[0]", "只能是 startup"],
    [{ ...scripted, activation: ["startup", "startup"] }, "activation[1]", "重复了"],
    [
      { ...scripted, contributes: { commands: [{ id: "Bad Id", title: "x" }] } },
      "contributes.commands[0].id",
      "小写字母",
    ],
    [
      {
        ...scripted,
        contributes: {
          commands: [
            { id: "a", title: "x" },
            { id: "a", title: "y" },
          ],
        },
      },
      "contributes.commands[1].id",
      "重复了",
    ],
    [
      { ...scripted, contributes: { commands: [{ id: "a" }] } },
      "",
      "缺 contributes.commands[0].title",
    ],
    [
      { ...scripted, contributes: { documentSlots: [{ id: "a", slot: "sidebar", title: "x" }] } },
      "contributes.documentSlots[0].slot",
      "只能是 afterBody",
    ],
    [
      {
        ...scripted,
        contributes: { documentSlots: [{ id: "a", slot: "afterBody", title: "x", html: "<b>" }] },
      },
      "contributes.documentSlots[0].html",
      "不认识这个字段",
    ],
  ])("写坏了报出字段：%j", (value, field, message) => {
    const result = failure(value);
    expect(result.field).toBe(field);
    expect(result.message).toContain(message);
  });

  it("提示块的图标不认原型链上的名字", () => {
    expect(
      failure(withContributes({ callouts: [{ label: "x", kind: "tip", icon: "constructor" }] }))
        .field,
    ).toBe("contributes.callouts[0].icon");
  });
});

describe("版本范围", () => {
  it("装上时记 ^主.次（0.x）或 ^主", () => {
    expect(rangeOf("0.1.3")).toBe("^0.1");
    expect(rangeOf("1.2.0")).toBe("^1");
    expect(rangeOf("2.0.0-beta.1")).toBe("^2");
  });

  it.each([
    ["0.1.5", "^0.1", true],
    ["0.2.0", "^0.1", false],
    ["0.0.9", "^0.1", false],
    ["1.4.0", "^1", true],
    ["2.0.0", "^1", false],
    ["1.2.9", "~1.2.3", true],
    ["1.2.2", "~1.2.3", false],
    ["1.3.0", "~1.2.3", false],
    ["1.0.7", "1.0", true],
    ["1.0.7", "1.0.7", true],
    ["1.0.8", "1.0.7", false],
    ["1.0.0", "什么都行", true],
  ])("%s 合不合 %s", (version, range, ok) => {
    expect(satisfies(version, range)).toBe(ok);
  });
});
