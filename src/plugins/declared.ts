import { useData } from "@/data/store";
import type { TemplateContext } from "@/data/types";
import { type DeclaredCallout, setDeclaredCallouts } from "@/editor/callout";
import { initInstalled, useInstalled } from "@/extensions/installed";
import {
  PLACEHOLDER_RE,
  type Platform,
  type PluginManifest,
  type ThemeTokens,
} from "@/extensions/manifest";
import { formatWeekdayCN, fromISODate, isoWeekNumber, toISODate } from "@/lib/date";
import { FileText } from "lucide-react";
import { create } from "zustand";
import {
  CARET,
  type DocTemplate,
  manifestContext,
  setDeclaredNavOrder,
  setDeclaredTemplates,
} from "./registry";

/* ============================================================
   L0 插件（纯声明，docs/插件与跨端.md §5.1、§5.3）的「运行时」：不执行任何插件代码，只把开着的那几个的声明
   交给用到它的地方。

   生效的 = 这台设备装着的（extensions/installed.ts）∩ 这个仓库开着的（仓库标记的 plugins，VaultLayout.extensions）
   ∩ 平台对得上的。装、卸、开、关、别的窗口改了，都整个重算一遍：
   - 提示块 → editor/callout.ts（编辑器的装饰层看版本号重画）
   - 模板 → registry 的 setDeclaredTemplates（编辑器的模板菜单订阅 registry 的 onTemplatesChange 重取）
   - 主题 → <head> 里一个 <style>，只改 globals.css 已有的颜色 token；弹出窗口抄 <head> 的样式，跟着变
   - 导航顺序 → registry 的 setDeclaredNavOrder（窄栏看 useDeclared 的 navOrder 重画）

   停用、卸载：上面四样都撤掉，文档一个字不动。提示块回到中性的样子，模板菜单里少了那几个。

   桌面端在第一帧之前就取到了仓库的摆法（main.tsx 等 initialize），装着的清单是同步读的，
   所以主题色、提示块的样子第一帧就是对的，不先画默认的再变。
   ============================================================ */

interface DeclaredState {
  /** 这个仓库里生效的 L0 插件，按装上的先后 */
  active: readonly PluginManifest[];
  /** 开着的插件调过的导航顺序（没有是空的） */
  navOrder: readonly string[];
}

export const useDeclared = create<DeclaredState>(() => ({ active: [], navOrder: [] }));

/** 这台设备是哪一种：手机端还没做（P14.5），现在都是桌面 */
const PLATFORM: Platform = "desktop";

const STYLE_ID = "odea-plugin-theme";

/** 生效的 L0 插件：装着、这个仓库开着、平台对得上 */
export function activeManifests(): PluginManifest[] {
  const wanted = new Set(useData.getState().layout.extensions.map((entry) => entry.id));
  return useInstalled
    .getState()
    .plugins.map((plugin) => plugin.manifest)
    .filter(
      (manifest) =>
        wanted.has(manifest.id) && (!manifest.platforms || manifest.platforms.includes(PLATFORM)),
    );
}

let started = false;

/** main.tsx 在内置插件装上以后、取仓库之前调一次 */
export function initDeclaredPlugins(): void {
  if (started) return;
  started = true;
  initInstalled(manifestContext);
  useInstalled.subscribe(apply);
  useData.subscribe((state, before) => {
    if (state.layout.extensions !== before.layout.extensions) apply();
  });
  apply();
}

let lastKey = "";

function apply() {
  const active = activeManifests();
  // 同一份就不动：storage 事件、摆法换了但插件没变时不重画编辑器
  const key = JSON.stringify(active);
  if (key === lastKey) return;
  lastKey = key;

  setDeclaredCallouts(active.flatMap((manifest) => calloutsOf(manifest)));
  setDeclaredTemplates(active.flatMap((manifest) => templatesOf(manifest)));
  applyTheme(active);
  // 后开的插件说了算（和主题一样）
  const navOrder =
    [...active].reverse().find((manifest) => manifest.contributes.navOrder)?.contributes.navOrder ??
    [];
  setDeclaredNavOrder(navOrder);
  useDeclared.setState({ active, navOrder });
}

function calloutsOf(manifest: PluginManifest): DeclaredCallout[] {
  return manifest.contributes.callouts ?? [];
}

function templatesOf(manifest: PluginManifest): DocTemplate[] {
  return (manifest.contributes.templates ?? []).map((template, index) => ({
    id: `${manifest.id}/${index}`,
    scope: template.scope,
    name: template.name,
    description: template.description ?? manifest.name,
    icon: FileText,
    build: (context) => expandTemplate(template.body, context),
  }));
}

/* ---------------- 模板的占位符 ---------------- */

const pad = (value: number) => String(value).padStart(2, "0");

/** `{{date:格式}}` 的格式：YYYY / YY 年，MM / M 月，DD / D 日，ww / w ISO 周数，别的字原样留着 */
function formatDate(iso: string, format: string): string {
  const date = fromISODate(iso);
  const week = isoWeekNumber(iso);
  return format.replace(/YYYY|YY|MM|M|DD|D|ww|w/g, (token) => {
    switch (token) {
      case "YYYY":
        return String(date.getFullYear());
      case "YY":
        return String(date.getFullYear()).slice(-2);
      case "MM":
        return pad(date.getMonth() + 1);
      case "M":
        return String(date.getMonth() + 1);
      case "DD":
        return pad(date.getDate());
      case "D":
        return String(date.getDate());
      case "ww":
        return pad(week);
      default:
        return String(week);
    }
  });
}

/**
 * 把模板里的占位符换成插入时的值。日期：某一天 / 某个周期的文档是它自己的那一天（周期的起点），笔记是今天；
 * 时间是现在。`{{cursor}}` 是插入后光标停的地方（CARET）
 */
export function expandTemplate(body: string, context: TemplateContext, now = new Date()): string {
  const date = context.scope === "note" ? toISODate(now) : context.date;
  return body.replaceAll(CARET, "").replace(PLACEHOLDER_RE, (whole, rawName: string, format) => {
    switch (rawName.toLowerCase()) {
      case "date":
        return formatDate(date, format?.trim() || "YYYY-MM-DD");
      case "time":
        return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      case "weekday":
        return `周${formatWeekdayCN(date)}`;
      case "title":
        return context.title ?? "";
      case "cursor":
        return CARET;
      default:
        return whole;
    }
  });
}

/* ---------------- 主题 ---------------- */

function themeRule(selector: string, tokens: ThemeTokens): string {
  const lines = Object.entries(tokens).map(([token, value]) => `  --color-${token}: ${value};`);
  return lines.length ? `${selector} {\n${lines.join("\n")}\n}` : "";
}

/**
 * 开着的插件改的颜色：一个 <style> 放在 <head> 最后，压过 globals.css 里同样写法的那几条
 * （`:root[data-theme]`，applyTheme 总会在 <html> 上落一个明确的 data-theme）。后开的插件说了算。
 * 值在校验清单时只放过颜色（extensions/manifest.ts 的 isColorValue），塞不进别的 CSS
 */
function applyTheme(active: readonly PluginManifest[]) {
  if (typeof document === "undefined") return;
  const light: ThemeTokens = {};
  const dark: ThemeTokens = {};
  for (const manifest of active) {
    Object.assign(light, manifest.contributes.theme?.light);
    Object.assign(dark, manifest.contributes.theme?.dark);
  }
  const css = [
    themeRule(':root[data-theme="light"]', light),
    themeRule(':root[data-theme="dark"]', dark),
  ]
    .filter(Boolean)
    .join("\n");
  let style = document.getElementById(STYLE_ID);
  if (!css) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.append(style);
  }
  if (style.textContent !== css) style.textContent = css;
}
