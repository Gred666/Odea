export type ExtensionCategory = "editor" | "appearance" | "productivity" | "integration";

export interface ExtensionManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  author: string;
  summary: string;
  description?: string;
  category: ExtensionCategory;
  icon?: string;
  homepage?: string;
  permissions?: string[];
  verified?: boolean;
  downloads?: number;
  updatedAt?: string;
}

export interface CatalogExtension extends ExtensionManifest {
  source: "official" | "local";
  packageText?: string;
}

/**
 * 扩展目录边界。以后接上传审核服务/CDN时实现同一接口，页面无需改动。
 */
export interface ExtensionCatalogProvider {
  list(): Promise<CatalogExtension[]>;
  importPackage(file: File): Promise<CatalogExtension>;
  removeLocal(id: string): Promise<void>;
  download(extension: CatalogExtension): Promise<void>;
}

const STORAGE_KEY = "odea.extension-catalog.v1";
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

const officialExtensions: CatalogExtension[] = [
  {
    schemaVersion: 1,
    id: "official.math",
    name: "数学公式",
    version: "0.1.0",
    author: "Odea",
    summary: "在 Markdown 中渲染行内公式与公式块。",
    description: "计划支持 $...$ 与 $$...$$，并提供可替换的公式渲染器。",
    category: "editor",
    permissions: [],
    verified: true,
    downloads: 0,
    updatedAt: "2026-09-02",
    source: "official",
  },
  {
    schemaVersion: 1,
    id: "official.mermaid",
    name: "Mermaid 图表",
    version: "0.1.0",
    author: "Odea",
    summary: "把 Mermaid 代码块渲染为流程图、时序图与关系图。",
    category: "editor",
    permissions: [],
    verified: true,
    downloads: 0,
    updatedAt: "2026-09-02",
    source: "official",
  },
  {
    schemaVersion: 1,
    id: "official.callouts",
    name: "增强 Callout",
    version: "0.1.0",
    author: "Odea",
    summary: "注册自定义提示块类型、图标和配色。",
    category: "appearance",
    permissions: [],
    verified: true,
    downloads: 0,
    updatedAt: "2026-09-02",
    source: "official",
  },
];

const CATEGORIES: readonly ExtensionCategory[] = [
  "editor",
  "appearance",
  "productivity",
  "integration",
];

/**
 * 校验导入的清单。清单是用户选的任意 JSON 文件，每个字段都要先看类型：
 * 以前 `name: 5` 会在 `.trim()` 上抛出一个看不懂的 TypeError，`id: 7` 被正则
 * 转成字符串后直接通过、以数字存了下来，`permissions` 里什么都能塞。
 */
export function validateExtensionManifest(value: unknown): ExtensionManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("扩展包必须是 JSON 对象");
  }
  const manifest = value as Record<string, unknown>;
  /** 必填 / 选填的字符串字段：类型不对就报出字段名；选填的空串当作没填 */
  const text = (field: string, required: boolean): string | undefined => {
    const raw = manifest[field];
    if (raw === undefined || raw === null) {
      if (required) throw new Error(`扩展缺少 ${field}`);
      return undefined;
    }
    if (typeof raw !== "string") throw new Error(`扩展的 ${field} 必须是字符串`);
    const trimmed = raw.trim();
    if (required && !trimmed) throw new Error(`扩展缺少 ${field}`);
    return trimmed || undefined;
  };

  if (manifest.schemaVersion !== 1) throw new Error("暂不支持此扩展清单版本");
  if (typeof manifest.id !== "string" || !ID_PATTERN.test(manifest.id)) {
    throw new Error("扩展 id 格式不正确");
  }
  const name = text("name", true)!;
  const version = text("version", true)!;
  const author = text("author", true)!;
  const summary = text("summary", true)!;
  const description = text("description", false);
  const icon = text("icon", false);
  const homepage = text("homepage", false);
  if (homepage && !/^https?:\/\//i.test(homepage)) {
    throw new Error("扩展 homepage 只能是 http(s) 地址");
  }
  if (!CATEGORIES.includes(manifest.category as ExtensionCategory)) {
    throw new Error("扩展 category 不受支持");
  }
  const permissions = manifest.permissions ?? [];
  if (!Array.isArray(permissions) || !permissions.every((item) => typeof item === "string")) {
    throw new Error("扩展 permissions 必须是字符串数组");
  }

  return {
    schemaVersion: 1,
    id: manifest.id,
    name,
    version,
    author,
    summary,
    description,
    category: manifest.category as ExtensionCategory,
    icon,
    homepage,
    permissions,
  };
}

export function serializeExtensionPackage(extension: CatalogExtension): string {
  const { source: _source, packageText: _packageText, ...manifest } = extension;
  return JSON.stringify(manifest, null, 2);
}

function loadLocal(): CatalogExtension[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as CatalogExtension[];
    return Array.isArray(value) ? value.filter((item) => item.source === "local") : [];
  } catch {
    return [];
  }
}

function saveLocal(items: CatalogExtension[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const localExtensionCatalog: ExtensionCatalogProvider = {
  async list() {
    return [...officialExtensions, ...loadLocal()];
  },

  async importPackage(file) {
    if (file.size > MAX_PACKAGE_BYTES) throw new Error("扩展清单不能超过 2 MB");
    const packageText = await file.text();
    const manifest = validateExtensionManifest(JSON.parse(packageText));
    if (officialExtensions.some((item) => item.id === manifest.id)) {
      throw new Error("不能覆盖官方扩展");
    }
    const extension: CatalogExtension = { ...manifest, source: "local", packageText };
    const local = loadLocal();
    saveLocal([extension, ...local.filter((item) => item.id !== extension.id)]);
    return extension;
  },

  async removeLocal(id) {
    saveLocal(loadLocal().filter((item) => item.id !== id));
  },

  async download(extension) {
    const text = extension.packageText ?? serializeExtensionPackage(extension);
    downloadText(`${extension.id}-${extension.version}.odeax.json`, text);
  },
};
