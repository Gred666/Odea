import { CALLOUT_ICONS, type CalloutKind } from "@/editor/callout";

/* ============================================================
   插件清单（docs/插件与跨端.md §5.2），schemaVersion 2。

   没有 main 的是 L0：纯声明、不带代码。贡献点四样（§5.3）：
   - callouts：几种提示块标签，配色只能是已有的 kind，图标只能从 editor/callout.ts 的 CALLOUT_ICONS 里挑
   - templates：Markdown 模板，加 `{{date}}` 这类占位符（TEMPLATE_PLACEHOLDERS）
   - theme：只能改 globals.css 里已有的颜色 token（THEME_TOKENS），值按颜色格式校验
   - navOrder：窄栏上几项的先后，只能调顺序

   带 main 的是 L1（P14.3）：脚本跑在沙箱里（plugins/sandbox/），只能经宿主做 capabilities 里申请了、
   用户也同意了的事。多两个贡献点，都要有脚本才有意义：
   - commands：命令面板里的几条，点了交给脚本
   - documentSlots：正文后面的一段，脚本交一棵声明式的组件树（plugins/sandbox/views.ts），宿主来画
   activation 是什么时候启动脚本（§5.2）：startup、command:<id>、slot:<id>；不写就是用到哪个贡献点时

   清单是用户选的任意 JSON，也可能是团队仓库里别人推荐的，所以每个字段都先看类型、再看范围；
   写坏了的报出是哪个字段（「清单里 contributes.callouts[1].kind 不对：……」），不装一半。
   不认识的字段也报：同一个 api 版本下字段是定死的，拼错了的字段悄悄不起作用，比报错更难查。
   ============================================================ */

/** 清单格式的版本 */
export const MANIFEST_VERSION = 2;
/**
 * 这个版本的 Odea 提供的插件 API。清单的 api 写的范围要容得下它。
 * 1.0：L0 的四个贡献点（P14.2）；1.1：带脚本的插件（L1，P14.3），多了 main、activation、capabilities、
 * commands、documentSlots
 */
export const PLUGIN_API = "1.1";

export type ExtensionCategory = "editor" | "appearance" | "productivity" | "integration";
export const CATEGORIES: readonly ExtensionCategory[] = [
  "editor",
  "appearance",
  "productivity",
  "integration",
];

export type Platform = "desktop" | "mobile";
const PLATFORMS: readonly Platform[] = ["desktop", "mobile"];

/** 提示块能用的配色：就是编辑器里已有的那几种 */
export const CALLOUT_KINDS: readonly CalloutKind[] = [
  "note",
  "tip",
  "important",
  "warning",
  "caution",
  "generic",
];

/** 主题能改的颜色 token（globals.css 里 `--color-` 后面那一段）。亮、暗两套里都有的才放进来 */
export const THEME_TOKENS = [
  "ink",
  "body",
  "muted",
  "faint",
  "canvas",
  "panel",
  "rail",
  "raised",
  "line",
  "line-strong",
  "control-edge",
  "accent",
  "accent-hover",
  "accent-ink",
  "accent-wash",
  "accent-wash-2",
  "accent-line",
  "success",
  "danger",
  "warning",
  "callout-important",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

/** 模板里认得的占位符（插入时现算，plugins/declared.ts 的 expandTemplate） */
export const TEMPLATE_PLACEHOLDERS = [
  "{{date}}",
  "{{date:YYYY年M月D日}}",
  "{{time}}",
  "{{weekday}}",
  "{{title}}",
  "{{cursor}}",
] as const;
const PLACEHOLDER_NAMES = new Set(["date", "time", "weekday", "title", "cursor"]);
/** `{{名字}}` 或 `{{名字:格式}}`；名字前后可以有空格 */
export const PLACEHOLDER_RE = /\{\{\s*([A-Za-z]+)\s*(?::([^{}]*))?\}\}/g;

export interface CalloutContribution {
  label: string;
  aliases?: string[];
  kind: CalloutKind;
  icon?: string;
}

export interface TemplateContribution {
  name: string;
  description?: string;
  /** 用在哪一种文档上：`note`，或者内置插件的模板槽位（日程的 day / week / month / year） */
  scope: string;
  body: string;
}

export type ThemeTokens = Partial<Record<ThemeToken, string>>;

export interface ThemeContribution {
  light?: ThemeTokens;
  dark?: ThemeTokens;
}

/** 命令面板里的一条（L1）：点了交给脚本里 odea.commands.register 登记的那个处理函数 */
export interface CommandContribution {
  id: string;
  title: string;
  keywords?: string;
}

/** 文档里给插件留的地方：现在只有正文后面那一段 */
export const SLOT_PLACES = ["afterBody"] as const;
export type SlotPlace = (typeof SLOT_PLACES)[number];

/** 文档槽位（L1）：脚本给每一篇交一棵声明式的组件树（或者什么都不交），宿主画在那个地方 */
export interface SlotContribution {
  id: string;
  slot: SlotPlace;
  /** 那一段上方的小标题 */
  title: string;
}

export interface Contributions {
  callouts?: CalloutContribution[];
  templates?: TemplateContribution[];
  theme?: ThemeContribution;
  /** 导航项的 id，排在前面的先出现；没列出来的照原来的先后跟在后面 */
  navOrder?: string[];
  commands?: CommandContribution[];
  documentSlots?: SlotContribution[];
}

/* ---------------- 能力（L1） ---------------- */

/**
 * 脚本能经宿主做的事，每一样带一个范围（§5.2「一个能力加一个范围」）：
 * - documents.read：current 是正在看的文档（窗格里开着的那几篇），vault 是仓库里所有的笔记和日程
 * - documents.edit：只有 current。改的是编辑器里开着的那一篇，和用户打字走同一条路（撤销、协作、存盘都照旧）
 */
export const CAPABILITIES = {
  "documents.read": ["current", "vault"],
  "documents.edit": ["current"],
} as const;
export type CapabilityName = keyof typeof CAPABILITIES;

export interface Capability {
  name: CapabilityName;
  scope: string;
  /** 为什么要它：授权时给人看 */
  reason?: string;
}

/** 设计稿里有、这个版本还没做的能力：报「还没有」，不报「不认识」 */
const LATER_CAPABILITIES = new Set([
  "documents.create",
  "documents.delete",
  "net.fetch",
  "clipboard.read",
  "clipboard.write",
  "notifications",
  "storage",
]);

/** 同一样能力、同一个范围算同一项（授权按它记） */
export const capabilityKey = (capability: Pick<Capability, "name" | "scope">) =>
  `${capability.name}:${capability.scope}`;

/** 授权时给人看的说法（按 capabilityKey） */
export const CAPABILITY_TEXT: Readonly<Record<string, { label: string; detail: string }>> = {
  "documents.read:current": {
    label: "读正在看的文档",
    detail: "窗格里开着的那几篇：标题和正文",
  },
  "documents.read:vault": {
    label: "读仓库里所有的笔记和日程",
    detail: "标题、所在的文件夹、正文",
  },
  "documents.edit:current": {
    label: "改正在看的文档",
    detail: "和你打字一样：进撤销历史、自动存盘、协作时发给别人",
  },
};

export interface PluginManifest {
  schemaVersion: 2;
  id: string;
  name: string;
  version: string;
  author: string;
  summary: string;
  description?: string;
  category: ExtensionCategory;
  homepage?: string;
  /** 要的插件 API 版本范围：`^1.0` */
  api: string;
  /** 能在哪几种设备上用；没写是都能 */
  platforms?: Platform[];
  /** L1：脚本的文件名（main.js）。没有就是 L0 */
  main?: string;
  /** L1：什么时候启动脚本；没写就是用到哪个贡献点时（校验时补上） */
  activation?: string[];
  /** L1：要经宿主做的事。只是申请，授权记在这台设备上（extensions/installed.ts） */
  capabilities?: Capability[];
  contributes: Contributions;
}

/** 带脚本的（L1） */
export const isScripted = (manifest: PluginManifest): boolean => !!manifest.main;

/** 校验时要知道的这台 Odea 的情况：有哪些导航项、哪些模板槽位，id 能不能用 `odea.` 开头（只有官方的能） */
export interface ManifestContext {
  navIds: readonly string[];
  templateScopes: readonly string[];
  /** 官方目录里的清单：可以用保留的 `odea.` 前缀 */
  official?: boolean;
}

/** 清单哪里不对：field 是字段的路径（`contributes.callouts[1].kind`），message 是给人看的整句 */
export class ManifestError extends Error {
  constructor(
    readonly field: string,
    problem: string,
  ) {
    super(field ? `清单里 ${field} 不对：${problem}` : problem);
    this.name = "ManifestError";
  }
}

/** 插件 id 的写法，和 Rust 的 vault/layout.rs extension_id_ok 一致 */
export const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const VERSION_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,32})?$/;
const API_RE = /^\^?(\d{1,4})(?:\.(\d{1,4}))?$/;
const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** 颜色函数：括号里只许数字、空白、`, / % . + -` 和单位、`none` 这类字母；没有括号、分号、引号，塞不进别的 CSS */
const COLOR_FN_RE = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[-+0-9.,%/\sa-z]*\)$/i;
/** 保留给官方的前缀；内置插件（odea.journal）也在这底下 */
const RESERVED_PREFIX = "odea.";

const MAX = {
  callouts: 50,
  aliases: 10,
  label: 24,
  templates: 50,
  templateName: 40,
  templateDescription: 80,
  templateBody: 64 * 1024,
  navOrder: 20,
  commands: 50,
  slots: 4,
  capabilities: 10,
  activation: 60,
  text: 200,
  description: 2000,
};

const TOP_LEVEL = new Set([
  "$schema",
  "schemaVersion",
  "id",
  "name",
  "version",
  "author",
  "summary",
  "description",
  "category",
  "icon",
  "homepage",
  "api",
  "platforms",
  "main",
  "activation",
  "capabilities",
  "contributes",
]);
const CONTRIBUTION_KEYS = new Set([
  "callouts",
  "templates",
  "theme",
  "navOrder",
  "commands",
  "documentSlots",
]);
/** 只有带脚本的插件（L1）才有意义的贡献点：没有脚本，谁来接 */
const SCRIPTED_CONTRIBUTIONS = new Set(["commands", "documentSlots"]);
/** 设计稿里有、这个版本还没做的贡献点：报「还不支持」，不报「不认识」 */
const LATER_CONTRIBUTIONS = new Set([
  "documentTypes",
  "nav",
  "fenceRenderers",
  "importers",
  "exporters",
  "syncTargets",
]);

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);

const show = (value: unknown) => {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 40 ? `${text.slice(0, 40)}…` : text;
};

/** 一个对象里不认识的键：报第一个 */
function unknownKeys(object: Json, known: ReadonlySet<string>, path: string) {
  for (const key of Object.keys(object)) {
    if (!known.has(key)) throw new ManifestError(join(path, key), "不认识这个字段");
  }
}

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

/** 字符串字段：类型不对、空的、太长都报；选填的没写（或空串）是 undefined */
function text(object: Json, key: string, path: string, required: boolean, max = MAX.text) {
  const field = join(path, key);
  const raw = object[key];
  if (raw === undefined || raw === null) {
    if (required) throw new ManifestError("", `清单里缺 ${field}`);
    return undefined;
  }
  if (typeof raw !== "string") throw new ManifestError(field, `要是字符串，写的是 ${show(raw)}`);
  const trimmed = raw.trim();
  if (!trimmed) {
    if (required) throw new ManifestError("", `清单里缺 ${field}`);
    return undefined;
  }
  if (trimmed.length > max) throw new ManifestError(field, `太长了（最多 ${max} 个字）`);
  return trimmed;
}

function list(object: Json, key: string, path: string, max: number): unknown[] | undefined {
  const raw = object[key];
  if (raw === undefined || raw === null) return undefined;
  const field = join(path, key);
  if (!Array.isArray(raw)) throw new ManifestError(field, `要是数组，写的是 ${show(raw)}`);
  if (raw.length > max) throw new ManifestError(field, `太多了（最多 ${max} 项）`);
  return raw;
}

/** 解析清单文件的文字：不是 JSON 也报得出在哪 */
export function parseManifestText(textValue: string, context: ManifestContext): PluginManifest {
  let value: unknown;
  try {
    value = JSON.parse(textValue);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ManifestError("", `清单不是合法的 JSON：${detail}`);
  }
  return validateManifest(value, context);
}

/** 校验一份清单，交回整理过的（字符串去掉两头空白、选填的空串去掉、模板补上 scope） */
export function validateManifest(value: unknown, context: ManifestContext): PluginManifest {
  if (!isObject(value)) throw new ManifestError("", "清单要是一个 JSON 对象");
  const manifest = value;

  const schema = manifest.schemaVersion;
  if (schema === undefined) throw new ManifestError("", "清单里缺 schemaVersion");
  if (schema === 1) {
    throw new ManifestError(
      "schemaVersion",
      "1 是旧格式，没有 contributes，装上也不起作用；照 schemaVersion 2 改写",
    );
  }
  if (schema !== MANIFEST_VERSION) {
    throw new ManifestError("schemaVersion", `这个版本的 Odea 只认 2，写的是 ${show(schema)}`);
  }

  if ("permissions" in manifest) {
    throw new ManifestError(
      "permissions",
      "这是 schemaVersion 1 的写法；2 里换成了 capabilities，只给带脚本的插件",
    );
  }
  unknownKeys(manifest, TOP_LEVEL, "");

  const id = manifest.id;
  if (id === undefined) throw new ManifestError("", "清单里缺 id");
  if (typeof id !== "string" || !ID_PATTERN.test(id) || id.length > 64) {
    throw new ManifestError(
      "id",
      `只能用小写字母、数字，段之间用一个 . _ - 隔开（someone.callouts-cn），写的是 ${show(id)}`,
    );
  }
  if (id.startsWith(RESERVED_PREFIX) && !context.official) {
    throw new ManifestError("id", `${RESERVED_PREFIX} 开头的留给 Odea 自己的插件`);
  }

  const name = text(manifest, "name", "", true, 40)!;
  const version = text(manifest, "version", "", true, 64)!;
  if (!VERSION_RE.test(version)) {
    throw new ManifestError("version", `要写成 1.2.3 这样的三段版本号，写的是 ${show(version)}`);
  }
  const author = text(manifest, "author", "", true, 60)!;
  const summary = text(manifest, "summary", "", true)!;
  const description = text(manifest, "description", "", false, MAX.description);
  text(manifest, "icon", "", false);
  const homepage = text(manifest, "homepage", "", false);
  if (homepage && !/^https?:\/\//i.test(homepage)) {
    throw new ManifestError("homepage", "只能是 http(s) 地址");
  }
  const category = manifest.category;
  if (category === undefined) throw new ManifestError("", "清单里缺 category");
  if (!CATEGORIES.includes(category as ExtensionCategory)) {
    throw new ManifestError(
      "category",
      `只能是 ${CATEGORIES.join("、")}，写的是 ${show(category)}`,
    );
  }

  const api = text(manifest, "api", "", true, 16)!;
  const range = API_RE.exec(api);
  if (!range) throw new ManifestError("api", `要写成 ^1.0 这样的范围，写的是 ${show(api)}`);
  const [hostMajor, hostMinor] = PLUGIN_API.split(".").map(Number) as [number, number];
  if (Number(range[1]) !== hostMajor || Number(range[2] ?? 0) > hostMinor) {
    throw new ManifestError("api", `要的是插件 API ${api}，这个版本的 Odea 是 ${PLUGIN_API}`);
  }

  const platforms = list(manifest, "platforms", "", PLATFORMS.length);
  if (platforms) {
    if (!platforms.length) throw new ManifestError("platforms", "不能是空的（不写就是都能用）");
    platforms.forEach((platform, index) => {
      if (!PLATFORMS.includes(platform as Platform)) {
        throw new ManifestError(
          `platforms[${index}]`,
          `只能是 ${PLATFORMS.join("、")}，写的是 ${show(platform)}`,
        );
      }
    });
  }

  // 脚本（L1）：文件名只能是同一个文件夹里的一个 .js，不许带路径
  const main = text(manifest, "main", "", false, 64);
  if (main !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(main)) {
    throw new ManifestError(
      "main",
      `要是一个 .js 文件名（main.js），不带路径，写的是 ${show(main)}`,
    );
  }
  for (const key of ["activation", "capabilities"]) {
    if (main === undefined && manifest[key] !== undefined) {
      throw new ManifestError(key, "只有带脚本（main）的插件才写这一项");
    }
  }

  const contributes = validateContributions(manifest.contributes, context, main !== undefined);
  const capabilities = main === undefined ? undefined : validateCapabilities(manifest.capabilities);
  const activation = main === undefined ? undefined : validateActivation(manifest, contributes);

  return {
    schemaVersion: MANIFEST_VERSION,
    id,
    name,
    version,
    author,
    summary,
    ...(description ? { description } : {}),
    category: category as ExtensionCategory,
    ...(homepage ? { homepage } : {}),
    api,
    ...(platforms ? { platforms: [...new Set(platforms as Platform[])] } : {}),
    ...(main !== undefined ? { main, activation, capabilities } : {}),
    contributes,
  };
}

function validateContributions(
  value: unknown,
  context: ManifestContext,
  scripted: boolean,
): Contributions {
  if (value === undefined || value === null) throw new ManifestError("", "清单里缺 contributes");
  if (!isObject(value)) throw new ManifestError("contributes", "要是一个对象");
  for (const key of Object.keys(value)) {
    if (LATER_CONTRIBUTIONS.has(key)) {
      throw new ManifestError(`contributes.${key}`, "这个贡献点这个版本还不支持");
    }
  }
  unknownKeys(value, CONTRIBUTION_KEYS, "contributes");
  if (!scripted) {
    for (const key of Object.keys(value)) {
      if (SCRIPTED_CONTRIBUTIONS.has(key)) {
        throw new ManifestError(`contributes.${key}`, "要带脚本（main）的插件才能加这一样");
      }
    }
  }

  const result: Contributions = {};
  const callouts = list(value, "callouts", "contributes", MAX.callouts);
  if (callouts?.length) result.callouts = validateCallouts(callouts);
  const templates = list(value, "templates", "contributes", MAX.templates);
  if (templates?.length) result.templates = validateTemplates(templates, context);
  if (value.theme !== undefined && value.theme !== null) {
    const theme = validateTheme(value.theme);
    if (theme) result.theme = theme;
  }
  const navOrder = list(value, "navOrder", "contributes", MAX.navOrder);
  if (navOrder?.length) result.navOrder = validateNavOrder(navOrder, context);
  const commands = list(value, "commands", "contributes", MAX.commands);
  if (commands?.length) result.commands = validateCommands(commands);
  const slots = list(value, "documentSlots", "contributes", MAX.slots);
  if (slots?.length) result.documentSlots = validateSlots(slots);

  if (!Object.keys(result).length) {
    throw new ManifestError("contributes", "是空的：这个插件什么都不加");
  }
  return result;
}

/** 提示块的标签：写在 `> [!标签]` 里，不能有 `]`、换行 */
function calloutLabel(raw: unknown, field: string): string {
  if (typeof raw !== "string") throw new ManifestError(field, `要是字符串，写的是 ${show(raw)}`);
  const label = raw.trim();
  if (!label) throw new ManifestError(field, "不能是空的");
  if (label.length > MAX.label) throw new ManifestError(field, `太长了（最多 ${MAX.label} 个字）`);
  if (/[[\]\n\r]/.test(label)) throw new ManifestError(field, "不能有方括号、换行");
  return label;
}

function validateCallouts(items: unknown[]): CalloutContribution[] {
  const seen = new Map<string, string>();
  return items.map((item, index) => {
    const path = `contributes.callouts[${index}]`;
    if (!isObject(item)) throw new ManifestError(path, "要是一个对象");
    unknownKeys(item, new Set(["label", "aliases", "kind", "icon"]), path);
    const label = calloutLabel(item.label, `${path}.label`);
    const aliases = (list(item, "aliases", path, MAX.aliases) ?? []).map((alias, at) =>
      calloutLabel(alias, `${path}.aliases[${at}]`),
    );
    // 标签、别名在整份清单里不能重名（不分大小写，编辑器认标签也不分）
    const names = [
      { name: label, field: `${path}.label` },
      ...aliases.map((alias, at) => ({ name: alias, field: `${path}.aliases[${at}]` })),
    ];
    for (const { name: one, field } of names) {
      const key = one.toLowerCase();
      if (seen.has(key)) throw new ManifestError(field, `「${one}」和 ${seen.get(key)} 重复了`);
      seen.set(key, field);
    }
    const kind = item.kind;
    if (kind === undefined) throw new ManifestError("", `清单里缺 ${path}.kind`);
    if (!CALLOUT_KINDS.includes(kind as CalloutKind)) {
      throw new ManifestError(
        `${path}.kind`,
        `只能是 ${CALLOUT_KINDS.join("、")}，写的是 ${show(kind)}`,
      );
    }
    const icon = text(item, "icon", path, false, 40);
    if (icon && !Object.hasOwn(CALLOUT_ICONS, icon)) {
      throw new ManifestError(
        `${path}.icon`,
        `没有叫 ${show(icon)} 的图标（能用的：${Object.keys(CALLOUT_ICONS).join("、")}）`,
      );
    }
    return {
      label,
      ...(aliases.length ? { aliases } : {}),
      kind: kind as CalloutKind,
      ...(icon ? { icon } : {}),
    };
  });
}

function validateTemplates(items: unknown[], context: ManifestContext): TemplateContribution[] {
  const names = new Set<string>();
  return items.map((item, index) => {
    const path = `contributes.templates[${index}]`;
    if (!isObject(item)) throw new ManifestError(path, "要是一个对象");
    unknownKeys(item, new Set(["name", "description", "scope", "body"]), path);
    const name = text(item, "name", path, true, MAX.templateName)!;
    const key = name.toLowerCase();
    if (names.has(key)) throw new ManifestError(`${path}.name`, `「${name}」重复了`);
    names.add(key);
    const description = text(item, "description", path, false, MAX.templateDescription);
    const scope = text(item, "scope", path, false, 40) ?? "note";
    if (!context.templateScopes.includes(scope)) {
      throw new ManifestError(
        `${path}.scope`,
        `只能是 ${context.templateScopes.join("、")}，写的是 ${show(scope)}`,
      );
    }
    const body = item.body;
    if (body === undefined || body === null) throw new ManifestError("", `清单里缺 ${path}.body`);
    if (typeof body !== "string") {
      throw new ManifestError(`${path}.body`, `要是字符串，写的是 ${show(body)}`);
    }
    if (!body.trim()) throw new ManifestError(`${path}.body`, "不能是空的");
    if (body.length > MAX.templateBody) {
      throw new ManifestError(`${path}.body`, `太长了（最多 ${MAX.templateBody / 1024} KB）`);
    }
    let cursors = 0;
    for (const match of body.matchAll(PLACEHOLDER_RE)) {
      const placeholder = match[1]!.toLowerCase();
      if (
        !PLACEHOLDER_NAMES.has(placeholder) ||
        (match[2] !== undefined && placeholder !== "date")
      ) {
        throw new ManifestError(
          `${path}.body`,
          `不认识 ${match[0]}（能用的：${TEMPLATE_PLACEHOLDERS.join("、")}）`,
        );
      }
      if (placeholder === "cursor") cursors += 1;
    }
    if (cursors > 1) throw new ManifestError(`${path}.body`, "{{cursor}} 只能有一个");
    return { name, ...(description ? { description } : {}), scope, body };
  });
}

/** 颜色值：十六进制，或者 rgb() / hsl() / oklch() 这类颜色函数 */
export function isColorValue(value: string): boolean {
  return value.length <= 64 && (HEX_RE.test(value) || COLOR_FN_RE.test(value));
}

function validateTheme(value: unknown): ThemeContribution | null {
  if (!isObject(value)) throw new ManifestError("contributes.theme", "要是一个对象");
  unknownKeys(value, new Set(["light", "dark"]), "contributes.theme");
  const result: ThemeContribution = {};
  for (const mode of ["light", "dark"] as const) {
    const raw = value[mode];
    if (raw === undefined || raw === null) continue;
    const path = `contributes.theme.${mode}`;
    if (!isObject(raw)) throw new ManifestError(path, "要是一个对象（token → 颜色）");
    const tokens: ThemeTokens = {};
    for (const [token, color] of Object.entries(raw)) {
      const field = `${path}.${token}`;
      if (!(THEME_TOKENS as readonly string[]).includes(token)) {
        throw new ManifestError(field, `没有这个颜色 token（能改的：${THEME_TOKENS.join("、")}）`);
      }
      if (typeof color !== "string" || !isColorValue(color.trim())) {
        throw new ManifestError(
          field,
          `要是颜色（#2f63d8、rgb(47 99 216)、oklch(…) 这样），写的是 ${show(color)}`,
        );
      }
      tokens[token as ThemeToken] = color.trim();
    }
    if (Object.keys(tokens).length) result[mode] = tokens;
  }
  return result.light || result.dark ? result : null;
}

function validateNavOrder(items: unknown[], context: ManifestContext): string[] {
  const seen = new Set<string>();
  return items.map((item, index) => {
    const field = `contributes.navOrder[${index}]`;
    if (typeof item !== "string" || !context.navIds.includes(item)) {
      throw new ManifestError(
        field,
        `没有叫 ${show(item)} 的导航项（有：${context.navIds.join("、")}）`,
      );
    }
    if (seen.has(item)) throw new ManifestError(field, `「${item}」重复了`);
    seen.add(item);
    return item;
  });
}

/* ---------------- L1：命令、槽位、能力、启动时机 ---------------- */

/** 命令、槽位的 id：和插件 id 一个写法 */
function contributionId(raw: unknown, field: string, seen: Set<string>): string {
  if (typeof raw !== "string" || !ID_PATTERN.test(raw) || raw.length > 64) {
    throw new ManifestError(
      field,
      `只能用小写字母、数字，段之间用一个 . _ - 隔开（tidy.all），写的是 ${show(raw)}`,
    );
  }
  if (seen.has(raw)) throw new ManifestError(field, `「${raw}」重复了`);
  seen.add(raw);
  return raw;
}

function validateCommands(items: unknown[]): CommandContribution[] {
  const seen = new Set<string>();
  return items.map((item, index) => {
    const path = `contributes.commands[${index}]`;
    if (!isObject(item)) throw new ManifestError(path, "要是一个对象");
    unknownKeys(item, new Set(["id", "title", "keywords"]), path);
    if (item.id === undefined) throw new ManifestError("", `清单里缺 ${path}.id`);
    const id = contributionId(item.id, `${path}.id`, seen);
    const title = text(item, "title", path, true, 40)!;
    const keywords = text(item, "keywords", path, false, 100);
    return { id, title, ...(keywords ? { keywords } : {}) };
  });
}

function validateSlots(items: unknown[]): SlotContribution[] {
  const seen = new Set<string>();
  return items.map((item, index) => {
    const path = `contributes.documentSlots[${index}]`;
    if (!isObject(item)) throw new ManifestError(path, "要是一个对象");
    unknownKeys(item, new Set(["id", "slot", "title"]), path);
    if (item.id === undefined) throw new ManifestError("", `清单里缺 ${path}.id`);
    const id = contributionId(item.id, `${path}.id`, seen);
    const slot = item.slot;
    if (slot === undefined) throw new ManifestError("", `清单里缺 ${path}.slot`);
    if (!SLOT_PLACES.includes(slot as SlotPlace)) {
      throw new ManifestError(
        `${path}.slot`,
        `只能是 ${SLOT_PLACES.join("、")}（正文后面那一段），写的是 ${show(slot)}`,
      );
    }
    const title = text(item, "title", path, true, 24)!;
    return { id, slot: slot as SlotPlace, title };
  });
}

function validateCapabilities(value: unknown): Capability[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ManifestError("capabilities", `要是数组，写的是 ${show(value)}`);
  }
  if (value.length > MAX.capabilities) {
    throw new ManifestError("capabilities", `太多了（最多 ${MAX.capabilities} 项）`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const path = `capabilities[${index}]`;
    if (!isObject(item)) throw new ManifestError(path, "要是一个对象（{ name, scope }）");
    const name = item.name;
    if (name === undefined) throw new ManifestError("", `清单里缺 ${path}.name`);
    // 先说「还没有这个能力」：设计稿里的 net.fetch 带 hosts，别报成「不认识 hosts」
    if (typeof name === "string" && LATER_CAPABILITIES.has(name)) {
      throw new ManifestError(`${path}.name`, `这个版本的 Odea 还没有 ${name} 这个能力`);
    }
    unknownKeys(item, new Set(["name", "scope", "reason"]), path);
    if (typeof name !== "string" || !Object.hasOwn(CAPABILITIES, name)) {
      throw new ManifestError(
        `${path}.name`,
        `只能是 ${Object.keys(CAPABILITIES).join("、")}，写的是 ${show(name)}`,
      );
    }
    const scopes: readonly string[] = CAPABILITIES[name as CapabilityName];
    const scope = item.scope;
    if (scope === undefined) throw new ManifestError("", `清单里缺 ${path}.scope`);
    if (typeof scope !== "string" || !scopes.includes(scope)) {
      throw new ManifestError(
        `${path}.scope`,
        `${name} 的范围只能是 ${scopes.join("、")}，写的是 ${show(scope)}`,
      );
    }
    const key = capabilityKey({ name: name as CapabilityName, scope });
    if (seen.has(key)) throw new ManifestError(path, `「${key}」重复了`);
    seen.add(key);
    const reason = text(item, "reason", path, false, 80);
    return { name: name as CapabilityName, scope, ...(reason ? { reason } : {}) };
  });
}

/** 什么时候启动：startup、command:<id>、slot:<id>（id 要是自己声明了的）；没写就是用到哪个贡献点时 */
function validateActivation(manifest: Json, contributes: Contributions): string[] {
  const commands = new Set((contributes.commands ?? []).map((command) => command.id));
  const slots = new Set((contributes.documentSlots ?? []).map((slot) => slot.id));
  const raw = list(manifest, "activation", "", MAX.activation);
  if (raw === undefined) {
    const derived = [
      ...[...commands].map((id) => `command:${id}`),
      ...[...slots].map((id) => `slot:${id}`),
    ];
    if (!derived.length) {
      throw new ManifestError(
        "activation",
        '这个插件没有命令、也没有文档槽位，什么时候都不会启动；要一直跑就写 ["startup"]',
      );
    }
    return derived;
  }
  if (!raw.length) throw new ManifestError("activation", "不能是空的（不写就是用到时再启动）");
  const seen = new Set<string>();
  return raw.map((event, index) => {
    const field = `activation[${index}]`;
    const at = typeof event === "string" ? event.indexOf(":") : -1;
    const kind = at > 0 ? (event as string).slice(0, at) : "";
    const id = at > 0 ? (event as string).slice(at + 1) : "";
    const ok =
      event === "startup" ||
      (kind === "command" && commands.has(id)) ||
      (kind === "slot" && slots.has(id));
    if (!ok) {
      throw new ManifestError(
        field,
        `只能是 startup、command:<命令 id>、slot:<槽位 id>（id 要在 contributes 里声明过），写的是 ${show(event)}`,
      );
    }
    if (seen.has(event as string)) throw new ManifestError(field, `「${event}」重复了`);
    seen.add(event as string);
    return event as string;
  });
}

/* ---------------- 版本 ---------------- */

/** 仓库里记的版本范围：装上时写 `^0.1` 这样的（主版本 0 时到次版本，否则到主版本） */
export function rangeOf(version: string): string {
  const [major = "0", minor = "0"] = version.split(/[.-]/);
  return major === "0" ? `^0.${minor}` : `^${major}`;
}

/** 装着的这一版合不合仓库要的范围（`^0.1`、`~1.2.3`、`1.0`；写不出来的当合） */
export function satisfies(version: string, range: string): boolean {
  const match = /^([\^~]?)(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range);
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match || !parts) return true;
  const [, op, ...wanted] = match;
  const want = wanted.map((part) => (part === undefined ? undefined : Number(part)));
  const have = parts.slice(1).map(Number) as [number, number, number];
  const compare = (a: number[], b: (number | undefined)[]) => {
    for (let index = 0; index < 3; index += 1) {
      const diff = a[index]! - (b[index] ?? 0);
      if (diff) return diff;
    }
    return 0;
  };
  if (compare(have, want) < 0) return false;
  if (op === "^") {
    // ^0.1 → 0.1.x；^1 / ^1.2 → 1.x
    if (want[0] === 0 && want[1] !== undefined) return have[0] === 0 && have[1] === want[1];
    return have[0] === want[0];
  }
  if (op === "~" || want[2] === undefined) {
    // ~1.2.3 / 1.2 → 1.2.x；1 → 1.x
    return want[1] === undefined ? have[0] === want[0] : have[0] === want[0] && have[1] === want[1];
  }
  return compare(have, want) === 0;
}
