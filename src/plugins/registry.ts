import type {
  DocumentModel,
  DocumentRef,
  TemplateContext,
  VaultChange,
  VaultLayout,
} from "@/data/types";
import { NOTE, ODEA_LAYOUT } from "@/data/types";
import { toISODate } from "@/lib/date";
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

   P14.2 起还有 L0（纯声明的插件，清单在 extensions/manifest.ts，plugins/declared.ts 把开着的那几个的声明交到这里）：
   模板（setDeclaredTemplates）、导航顺序（setDeclaredNavOrder）；提示块在 editor/callout.ts，主题直接落在样式上。
   L1 沙箱留给 P14.3
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
  /**
   * 全局快捷键速记（app/quickCapture.ts）交来的一行：记下来（日程：进今日TODO）。没记上抛出原因。
   * 开着的插件里只有一个会接（先装的那个）
   */
  capture?(text: string): Promise<void>;
  /** 浏览器预览（data/mock.ts）里它的那一份：搜索、反链、历史版本都要看到它的文档 */
  loadMock?(): Promise<void>;
  /**
   * 它的文档填的模板槽位（DocumentModel.templates 的 scope：日程的 day / week / month / year）。
   * L0 插件的模板可以指定用在这几种上（清单的 templates[].scope），校验清单时认它
   */
  templateScopes?: readonly string[];
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

/* ---------------- 导航顺序 ---------------- */

/** 核心的导航项：「文件」在最前；归档、扩展页在最后 */
const CORE_NAV_FIRST = ["notes"];
const CORE_NAV_LAST = ["archive", "extensions"];

/** 开着的 L0 插件调过的顺序（清单的 navOrder）：排在前面的先出现，没列的照原来的先后跟在后面 */
let declaredNavOrder: readonly string[] = [];

export function setDeclaredNavOrder(order: readonly string[]): void {
  declaredNavOrder = order;
}

/** 窄栏上每一项（不管插件开没开）原来的先后：文件、插件的按 order、归档、扩展页 */
export function defaultNavIds(): string[] {
  return [...CORE_NAV_FIRST, ...pluginNavItems().map((item) => item.id), ...CORE_NAV_LAST];
}

/** 窄栏上的先后（插件调过的）：切换时主内容往哪个方向挪也按它（app/store 的 navOrder） */
export function navIds(): string[] {
  const all = defaultNavIds();
  const first = declaredNavOrder.filter((id) => all.includes(id));
  return [...first, ...all.filter((id) => !first.includes(id))];
}

/** 校验 L0 插件的清单时要知道的：有哪些导航项、哪些模板槽位（extensions/manifest.ts 的 ManifestContext） */
export function manifestContext(): { navIds: string[]; templateScopes: string[] } {
  return {
    navIds: defaultNavIds(),
    templateScopes: [NOTE, ...plugins.flatMap((plugin) => plugin.templateScopes ?? [])],
  };
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
   列出来（editor/templates.ts 管触发、插入）。这里只有登记，模板本身不进编辑器分包。
   L0 的模板是 Markdown 加占位符（plugins/declared.ts 换成 DocTemplate 交来），排在 L2 的后面；笔记的 scope 是 `note` */

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

/** 笔记的空白正文里显示的提示（笔记的模板槽位用它；某一天、某个周期的用插件自己的） */
export const NOTE_PLACEHOLDER = "写点什么…　输入 / 插入标题、待办、表格，[[ 链接到别的笔记";

/**
 * 笔记的模板槽位：开着的 L0 插件里 scope 是 `note` 的模板，在笔记里一行只写 `/模板` 插入。
 * 一个都没有时编辑器不弹、`/` 菜单里也不列「模板」
 */
export function noteTemplateContext(title: string): TemplateContext {
  const day = toISODate(new Date());
  return { scope: NOTE, date: day, today: day, label: title, placeholder: NOTE_PLACEHOLDER, title };
}

/** 开着的 L0 插件的模板（插件开关了整个换掉） */
let declaredTemplates: readonly DocTemplate[] = [];
let templatesRevision = 0;
const templateListeners = new Set<() => void>();

export function setDeclaredTemplates(list: readonly DocTemplate[]): void {
  declaredTemplates = list;
  templatesRevision += 1;
  for (const listener of templateListeners) listener();
}

/** 模板换过几次：编辑器的模板菜单据此重取（useSyncExternalStore） */
export function templatesRevisionOf(): number {
  return templatesRevision;
}

export function onTemplatesChange(listener: () => void): () => void {
  templateListeners.add(listener);
  return () => {
    templateListeners.delete(listener);
  };
}

export function templatesFor(scope: string): DocTemplate[] {
  return [...templates, ...declaredTemplates].filter((template) => template.scope === scope);
}
