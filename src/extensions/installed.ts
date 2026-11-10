import { create } from "zustand";
import {
  type Capability,
  type ManifestContext,
  type PluginManifest,
  capabilityKey,
  isScripted,
  validateManifest,
} from "./manifest";

/* ============================================================
   这台设备装了哪些插件（docs/插件与跨端.md §6.3）。

   「仓库想用哪些」记在仓库标记 .odea/vault.json 的 plugins 里，跟着仓库同步；插件本身（L0 就是一份清单）
   装在每台设备上，不跟着仓库走。两边都有的才生效（plugins/declared.ts、plugins/scripted.ts）。

   清单存在 localStorage：它就在应用自己的数据目录里，按设备分；一个窗口装了、卸了，别的窗口收到
   storage 事件跟着换。读出来的每一份都再校验一次：存储被改坏了、这个版本的 Odea 不再认它（比如导航项
   换了名字），就列在「装着但用不了」里，不生效、也不删，用户自己决定卸不卸。

   带脚本的（L1，P14.3）多两样，也只在这台设备上：
   - 脚本本身：单独一个键（odea.plugins.code.<id>），用到时才读，不放进状态里
   - 授权（§5.2「授权记在这台设备上，不写进仓库」）：清单里申请的每一项，用户同意了的、没同意的。
     没问过的（新装、升级时多要了）要先问，问过之前插件不启动。卸载时连同脚本一起删掉
   ============================================================ */

const KEY = "odea.plugins.installed";
const CODE_PREFIX = "odea.plugins.code.";

/** official：从官方目录装的；file：从清单文件装的 */
export type InstallSource = "official" | "file";

/** 这台设备上对一个插件的授权：同意了的、没同意的（都是 capabilityKey） */
export interface Grants {
  granted: string[];
  denied: string[];
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  source: InstallSource;
  installedAt: number;
  /** 最近一次装（升级、重装）的时间：脚本换了，开着的那一份要重启（同一版重装，清单一样也算） */
  updatedAt: number;
  grants: Grants;
}

/** 装着、但这个版本校验不过的：不生效，扩展页里列出来 */
export interface BrokenPlugin {
  id: string;
  name: string;
  error: string;
}

interface Stored {
  manifest: unknown;
  source: InstallSource;
  installedAt: number;
  updatedAt?: number;
  grants?: Grants;
}

interface InstalledState {
  /** 按装上的先后：同一个提示块标签两个插件都登记了，先装的那个说了算 */
  plugins: InstalledPlugin[];
  broken: BrokenPlugin[];
}

export const useInstalled = create<InstalledState>(() => ({ plugins: [], broken: [] }));

let contextOf: () => ManifestContext = () => ({ navIds: [], templateScopes: ["note"] });

const NO_GRANTS: Grants = { granted: [], denied: [] };

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function readStored(): Stored[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is Stored =>
        !!entry &&
        typeof entry === "object" &&
        (entry.source === "official" || entry.source === "file") &&
        typeof entry.installedAt === "number",
    );
  } catch {
    return [];
  }
}

function writeStored(list: Stored[]) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

const field = (manifest: unknown, key: string) =>
  manifest &&
  typeof manifest === "object" &&
  typeof (manifest as Record<string, unknown>)[key] === "string"
    ? ((manifest as Record<string, unknown>)[key] as string)
    : "";

/** 存着的授权里只留这一版还在申请的（升级后不再要的那几项就不算了） */
function grantsFor(manifest: PluginManifest, raw: unknown): Grants {
  const wanted = new Set((manifest.capabilities ?? []).map(capabilityKey));
  const value = (raw ?? {}) as Partial<Grants>;
  return {
    granted: stringList(value.granted).filter((key) => wanted.has(key)),
    denied: stringList(value.denied).filter((key) => wanted.has(key)),
  };
}

/** 从存储里读一遍（启动时、别的窗口改了的时候） */
export function loadInstalled(): void {
  const plugins: InstalledPlugin[] = [];
  const broken: BrokenPlugin[] = [];
  const context = contextOf();
  for (const entry of readStored()) {
    try {
      const manifest = validateManifest(entry.manifest, {
        ...context,
        official: entry.source === "official",
      });
      if (plugins.some((plugin) => plugin.manifest.id === manifest.id)) continue;
      if (isScripted(manifest) && pluginCode(manifest.id) === null) {
        throw new Error("脚本不见了（这台设备的存储被清过？）：卸掉再装一次");
      }
      plugins.push({
        manifest,
        source: entry.source,
        installedAt: entry.installedAt,
        updatedAt: entry.updatedAt ?? entry.installedAt,
        grants: isScripted(manifest) ? grantsFor(manifest, entry.grants) : NO_GRANTS,
      });
    } catch (error) {
      const id = field(entry.manifest, "id");
      broken.push({
        id,
        name: field(entry.manifest, "name") || id || "（没有名字）",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  useInstalled.setState({ plugins, broken });
}

let listening = false;

/** 启动时调一次（内置插件装上以后：校验清单要知道有哪些导航项、模板槽位） */
export function initInstalled(context: () => ManifestContext): void {
  contextOf = context;
  loadInstalled();
  if (listening || typeof window === "undefined") return;
  listening = true;
  // 别的窗口（别的仓库）装了、卸了、改了授权
  window.addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === null) loadInstalled();
  });
}

/** L1 的脚本：用到时才读（几百 KB，不放进状态里）。没有是 null */
export function pluginCode(id: string): string | null {
  try {
    return localStorage.getItem(CODE_PREFIX + id);
  } catch {
    return null;
  }
}

/**
 * 装上一份（已经校验过的）清单。装过同一个 id 的就换成这一份（升级），先后不变。
 * L1 要连同脚本（code）一起；授权照旧留着这一版还在申请的那几项，新多要的没问过，启动前要先问。
 * grants 给了就用它（从扩展页装：装之前已经问过了）
 */
export function installPlugin(
  manifest: PluginManifest,
  source: InstallSource,
  code?: string,
  grants?: Grants,
): void {
  const scripted = isScripted(manifest);
  if (scripted && typeof code !== "string") {
    throw new Error(`「${manifest.name}」带脚本，要连同 ${manifest.main} 一起装`);
  }
  const stored = readStored();
  const at = stored.findIndex((entry) => field(entry.manifest, "id") === manifest.id);
  const previous = at >= 0 ? stored[at] : undefined;
  const entry: Stored = {
    manifest,
    source,
    installedAt: previous?.installedAt ?? Date.now(),
    updatedAt: Date.now(),
    ...(scripted ? { grants: grantsFor(manifest, grants ?? previous?.grants) } : {}),
  };
  try {
    // 先写脚本、再写清单：中途失败的话，清单还是旧的那一份（或者没装上），不会有清单没脚本
    if (scripted) localStorage.setItem(CODE_PREFIX + manifest.id, code!);
    else localStorage.removeItem(CODE_PREFIX + manifest.id);
    if (at >= 0) stored[at] = entry;
    else stored.push(entry);
    writeStored(stored);
  } catch (error) {
    loadInstalled();
    throw new Error(
      `这台设备的存储放不下「${manifest.name}」了（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  loadInstalled();
}

/** 记下这台设备上对它的授权（扩展页的授权对话框） */
export function setGrants(id: string, grants: Grants): void {
  const stored = readStored();
  const entry = stored.find((item) => field(item.manifest, "id") === id);
  if (!entry) return;
  entry.grants = { granted: [...new Set(grants.granted)], denied: [...new Set(grants.denied)] };
  writeStored(stored);
  loadInstalled();
}

/** 清单里申请了、这台设备上还没问过的那几项：问过之前不启动 */
export function undecided(plugin: InstalledPlugin): Capability[] {
  const decided = new Set([...plugin.grants.granted, ...plugin.grants.denied]);
  return (plugin.manifest.capabilities ?? []).filter(
    (capability) => !decided.has(capabilityKey(capability)),
  );
}

/** 从这台设备上卸掉，连同脚本和授权（仓库里记的「想用它」不动：别的设备上可能还装着、开着） */
export function uninstallPlugin(id: string): void {
  writeStored(readStored().filter((entry) => field(entry.manifest, "id") !== id));
  try {
    localStorage.removeItem(CODE_PREFIX + id);
  } catch {
    // 存储读不了：清单那一项已经删了，脚本留着也不会再被读
  }
  loadInstalled();
}
