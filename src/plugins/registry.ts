import type {
  DocumentModel,
  DocumentRef,
  TemplateContext,
  VaultChange,
  VaultLayout,
} from "@/data/types";
import { NOTE, ODEA_LAYOUT } from "@/data/types";
import type { LucideIcon } from "lucide-react";
import type { TargetAndTransition } from "motion/react";
import type { ComponentType } from "react";

/* ============================================================
   插件的注册表（docs/插件与跨端.md §5）：核心通过这里认插件，不认识任何一个具体的插件。

   P14.1 只有 L2（跟着应用一起编译的内置插件，src/plugins/index.ts 装上），贡献点是这几样：
   - documentTypes：一种文档（日程的某一天、某个周期的目标）。路径规则在 Rust 那一半；这里是前端要的：
     缓存、取、存、改标题、跳过去、团队里认同一篇的 id、索引里的 id（冲突副本的 conflictOf 认它）
   - nav：窄栏上的一项（今日TODO、目标、日历），带列表栏（日历的月格子）
   - 文档槽位：插件的页显示哪一篇（useDocument），DocumentModel 里的眉题、分段、正文后面的一段、模板
   - commands：命令面板里的命令；toggle：开 / 关这个插件的那一条
   - templates：带逻辑的模板（日程那几套）

   插件关着的时候核心里没有它的一行代码在跑：它的导航项不出现、它的文档类型 Rust 那边不认（文件当笔记）。
   清单（schemaVersion 2）、L0 声明、L1 沙箱留给 P14.2、P14.3
   ============================================================ */

/** 插件声明的一种文档（贡献点 documentTypes，§5.3、§6.1） */
export interface DocumentType {
  /** 类型 id，带命名空间：`journal.day`。也是 DocumentRef 的 type */
  id: string;
  /** 哪个插件的 */
  plugin: string;
  icon: LucideIcon;
  /** 命令面板里这一组叫什么：「日记与目标」 */
  group: string;
  /**
   * 这一篇的 id：索引里的 id（`day:2026-11-03`）。冲突副本的 conflictOf、记住看到哪的键（viewMemory）都是它，
   * 落在盘上，不能改
   */
  idOf(key: string): string;
  /** 反过来：不是这一种的 id 返回 null */
  keyOf(id: string): string | null;
  /** 团队协作里认同一篇的 id（docs/协同编辑.md §22.4）：和老版本一字不差，否则认不出是同一篇 */
  teamId(key: string): string;
  /** 给人看的标题（冲突横幅、留底）：「10月7日」「第 39 周目标」 */
  title(key: string): string;
  /** 缓存里的正文；还没取回来是 undefined */
  body(key: string): string | undefined;
  /** 取回来放进缓存（取过的不再取） */
  load(key: string): Promise<void>;
  /**
   * 存正文。base 算出带给后端的那个指纹（照着哪一版改的，data/store 的 baseOf），交给它的是缓存里现在的正文。
   * 返回 false：还没取回来、什么都没写；true：库里已经是这一版了（刚写的，或者本来就一样）
   */
  save(key: string, contentMd: string, base: (current: string) => string | null): Promise<boolean>;
  /** 改标题；没有就是标题改不了（目标的标题由周期决定）。和存正文排在同一条队里（data/store） */
  rename?(key: string, title: string, base: (current: string) => string | null): Promise<void>;
  /** 打开它：切到能看到它的那一页。返回那一篇的 DocumentModel.key（跳过去要滚到的地方认它） */
  open(key: string): string;
}

/** 窄栏上的一项（贡献点 nav） */
export interface NavItem {
  /** 导航项的 id。本机记的「上次停在哪」（odea.session）里存的就是它，不能改 */
  id: string;
  /** 哪个插件的 */
  plugin: string;
  label: string;
  icon: LucideIcon;
  /** 窄栏上的顺序：核心的「文件」是 0、「归档」是 90 */
  order: number;
  /** 命令面板里搜它的词 */
  keywords: string;
  /** 切到这一页时图标播一次的「签名动作」（components/Sidebar.tsx）：只动 transform */
  motion: { to: TargetAndTransition; origin: string };
  /** 中间那一栏（列表栏）放什么。没有就是两栏的页（今日TODO、目标） */
  List?: ComponentType;
}

/** 命令面板里的一条（贡献点 commands） */
export interface PaletteCommand {
  id: string;
  /** 放在哪一组：「跳转」「文件」…… */
  group: string;
  icon: LucideIcon;
  label: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

/** 命令面板、仓库菜单里开 / 关这个插件的那一条。hint 在命令面板里，menuHint 在仓库菜单里（短一点） */
export interface PluginToggle {
  /** 开着时：「关闭日程」 */
  off: { label: string; hint: string; menuHint: string; icon: LucideIcon };
  /** 关着时：「启用日程」 */
  on: { label: string; hint: string; menuHint: string; icon: LucideIcon };
  keywords: string;
}

export interface Plugin {
  /** `odea.journal`：仓库标记 plugins 里的键 */
  id: string;
  /** 给人看的名字：日程 */
  name: string;
  /** Odea 自己建的仓库默认开着（取到仓库的摆法之前也当它开着，免得窄栏上先少几项再冒出来） */
  onByDefault: boolean;
  /** 默认开着时，不在文件树上的那几个文件夹（取到仓库的摆法之前用） */
  defaultDirs: string[];
  documentTypes: DocumentType[];
  nav: NavItem[];
  /**
   * 正文区显示哪一篇：page 是这个插件自己的导航项时给出那一篇，不是返回 null。
   * 这是 hook：data/adapter 每次渲染都按同样的顺序把每个装着的插件的都调一遍（插件在启动时就装好了）
   */
  useDocument(page: string): DocumentModel | null;
  /** 跟着主窗口一直挂着的副作用（按需取数据、零点翻页、快捷键、从别的窗口跳过来）。插件开着才挂 */
  Effects?: ComponentType;
  /** 命令面板里的命令（插件开着才有）。hook */
  useCommands?(): PaletteCommand[];
  toggle?: PluginToggle;
  /** 仓库里别处变了：插件的文档（change.docs）、插件在索引里另存的那一份（change.plugins） */
  applyChange?(change: VaultChange): Promise<void>;
  /** 开关、摆法换了：缓存都作废 */
  reset?(): void;
  /** 后台把文件读进索引读完了（第一次打开大文件夹）：读了一半时取的那些重取 */
  reindexed?(): Promise<void>;
  /** 浏览器预览（data/mock.ts）里它的那一份：搜索、反链、历史版本都要看到它的文档 */
  loadMock?(): Promise<void>;
}

const plugins: Plugin[] = [];
const types = new Map<string, DocumentType>();

/** 装上一个插件（src/plugins/index.ts 在启动时调） */
export function registerPlugin(plugin: Plugin): void {
  if (plugins.some((other) => other.id === plugin.id)) return;
  plugins.push(plugin);
  for (const type of plugin.documentTypes) types.set(type.id, type);
}

/** 装着的插件（开没开看仓库的摆法：VaultLayout.plugins） */
export function installedPlugins(): readonly Plugin[] {
  return plugins;
}

export function pluginOf(id: string): Plugin | undefined {
  return plugins.find((plugin) => plugin.id === id);
}

/** 这一种文档（装着的插件声明的）；笔记、没装的类型是 undefined */
export function documentType(type: string): DocumentType | undefined {
  return types.get(type);
}

/** 所有插件的导航项，按 order 排 */
export function pluginNavItems(): NavItem[] {
  return plugins.flatMap((plugin) => plugin.nav).sort((a, b) => a.order - b.order);
}

export function navItemOf(id: string): NavItem | undefined {
  for (const plugin of plugins) {
    const item = plugin.nav.find((nav) => nav.id === id);
    if (item) return item;
  }
  return undefined;
}

/**
 * 索引里的 id → 是哪一篇。冲突副本的 conflictOf 一般是另一篇笔记的 id，也可能是插件的一篇
 * （`day:2026-10-07`、`goal:week:2026-09-21`，data/conflicts.ts）
 */
export function refOfId(id: string): DocumentRef {
  for (const type of types.values()) {
    const key = type.keyOf(id);
    if (key !== null) return { type: type.id, key };
  }
  return { type: NOTE, key: id };
}

/** Odea 自己建的仓库的摆法：默认开着的插件补上（取到仓库的真实摆法之前先当它是这样） */
export function defaultLayout(): VaultLayout {
  const on = plugins.filter((plugin) => plugin.onByDefault);
  return {
    ...ODEA_LAYOUT,
    plugins: on.map((plugin) => plugin.id),
    hiddenDirs: [...on.flatMap((plugin) => plugin.defaultDirs), ...ODEA_LAYOUT.hiddenDirs],
  };
}

/* ---------------- 模板（贡献点 templates） ----------------
   L2 的模板带逻辑（按日期现算），由插件交来；编辑器在一行里只写 `/模板` 时按 DocumentModel.templates 的 scope
   列出来（editor/templates.ts 管触发、插入）。这里只有登记，模板本身不进编辑器分包 */

/** 插入后光标停在这里。只出现在模板源文里，插入前会去掉 */
export const CARET = "‸";

export interface DocTemplate {
  id: string;
  /** 哪一组：和 TemplateContext.scope 对上才列出来 */
  scope: string;
  name: string;
  /** 选择器里的一行说明 */
  description: string;
  icon: LucideIcon;
  /** 生成 Markdown；CARET 是插入后光标的位置 */
  build: (ctx: TemplateContext) => string;
}

const templates: DocTemplate[] = [];

export function registerTemplates(list: readonly DocTemplate[]): void {
  for (const template of list) {
    if (!templates.some((other) => other.id === template.id)) templates.push(template);
  }
}

export function templatesFor(scope: string): DocTemplate[] {
  return templates.filter((template) => template.scope === scope);
}
