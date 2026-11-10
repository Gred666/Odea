import { OverlayScrollbar } from "@/components/OverlayScrollbar";
import { useData } from "@/data/store";
import type { WantedExtension } from "@/data/types";
import {
  MAX_CODE_BYTES,
  MAX_MANIFEST_BYTES,
  OFFICIAL_PLUGINS,
  officialCode,
  officialPlugin,
} from "@/extensions/catalog";
import {
  type BrokenPlugin,
  type Grants,
  type InstalledPlugin,
  installPlugin,
  setGrants,
  undecided,
  uninstallPlugin,
  useInstalled,
} from "@/extensions/installed";
import {
  CAPABILITY_TEXT,
  type Capability,
  type ExtensionCategory,
  type PluginManifest,
  capabilityKey,
  isScripted,
  parseManifestText,
  rangeOf,
  satisfies,
  validateManifest,
} from "@/extensions/manifest";
import { cn } from "@/lib/cn";
import { type Plugin, installedPlugins, manifestContext } from "@/plugins/registry";
import {
  type PluginLogEntry,
  type PluginState,
  askConsent,
  restartScripted,
  useScripted,
} from "@/plugins/scripted";
import {
  CircleAlert,
  FileCode2,
  type LucideIcon,
  PackageOpen,
  Palette,
  Puzzle,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

/* ============================================================
   扩展页（docs/插件与跨端.md §5、§6.3）：这台设备装了哪些插件、在这个仓库里开着哪些。

   - 装：从官方目录装（清单跟着应用一起发），或者从一份清单文件装。装上就在这个仓库里开着
   - 启用 / 停用：只改这个仓库的标记（.odea/vault.json 的 plugins，跟着仓库同步）
   - 卸载：只从这台设备上卸掉；仓库里记的「想用它」不动 —— 别的设备上可能还装着、开着。
     这样的插件列在最上面「这个仓库想用」里，可以装回来，或者点「不用了」在仓库里关掉
   - 内置的日程（L2）也在这里开关，和命令面板、仓库菜单里的「启用 / 关闭日程」是同一件事

   纯声明的（L0）装上就生效；带脚本的（L1，P14.3）装之前先问要的权限（components/PluginConsent.tsx），
   卡片上显示它在不在跑、启动失败或者被停下的原因、最近的报错，能「重新启动」。
   清单写坏了报出是哪个字段（extensions/manifest.ts）。从文件装带脚本的：清单和脚本（main.js）一起选。
   ============================================================ */

const CATEGORY_LABEL: Record<ExtensionCategory, string> = {
  editor: "编辑器",
  appearance: "外观",
  productivity: "效率",
  integration: "集成",
};

type Notice = { tone: "ok" | "error"; text: string };

const contextOf = (official: boolean) => ({ ...manifestContext(), official });

export function ExtensionsView() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const installed = useInstalled((s) => s.plugins);
  const scripted = useScripted((s) => s.plugins);
  const broken = useInstalled((s) => s.broken);
  const wanted = useData((s) => s.layout.extensions);
  const builtinOn = useData((s) => s.layout.plugins);
  const setExtension = useData((s) => s.setExtension);
  const setPlugin = useData((s) => s.setPlugin);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** 正在开关、安装的那一个（按钮先灰着，免得连点两下） */
  const [busy, setBusy] = useState<string | null>(null);

  const wantedOf = (id: string) => wanted.find((entry) => entry.id === id);
  const installedIds = new Set(installed.map((plugin) => plugin.manifest.id));
  const brokenIds = new Set(broken.map((plugin) => plugin.id));
  // 仓库开着、这台设备没装（也不是装着但坏了的）：列在最上面
  const missing = wanted.filter((entry) => !installedIds.has(entry.id) && !brokenIds.has(entry.id));
  const builtin = installedPlugins().filter((plugin) => plugin.toggle);
  // 官方目录：装着的在「已安装」里，仓库想用、没装的在最上面，都不再列一遍
  const catalog = OFFICIAL_PLUGINS.filter(
    (manifest) =>
      !installedIds.has(manifest.id) && !missing.some((entry) => entry.id === manifest.id),
  );

  const run = async (id: string, action: () => Promise<string | undefined>) => {
    setBusy(id);
    try {
      const text = await action();
      setNotice(text ? { tone: "ok", text } : null);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  /**
   * 装上（或者升级）一份清单，在这个仓库里开着。带脚本的先问权限：新装的问全部，
   * 升级的只问多要的那几项；点了取消就不装
   */
  const install = (manifest: PluginManifest, source: "official" | "file", code?: string) =>
    run(manifest.id, async () => {
      if (manifest.platforms && !manifest.platforms.includes("desktop")) {
        throw new Error(`「${manifest.name}」只能在手机上用，这台设备装不了`);
      }
      const before = installed.find((plugin) => plugin.manifest.id === manifest.id);
      const upgrade = !!before;
      let grants: Grants | undefined;
      if (isScripted(manifest)) {
        const decided = new Set([
          ...(before?.grants.granted ?? []),
          ...(before?.grants.denied ?? []),
        ]);
        const ask = (manifest.capabilities ?? []).filter(
          (capability) => !decided.has(capabilityKey(capability)),
        );
        if (ask.length || !upgrade) {
          const answer = await askConsent(manifest, ask, "install");
          if (!answer) return undefined;
          grants = {
            granted: [...(before?.grants.granted ?? []), ...answer.granted],
            denied: [...(before?.grants.denied ?? []), ...answer.denied],
          };
        }
      }
      installPlugin(manifest, source, code, grants);
      await setExtension(manifest.id, true, rangeOf(manifest.version));
      return upgrade
        ? `「${manifest.name}」更新到了 ${manifest.version}`
        : `已安装「${manifest.name}」，在这个仓库里开着`;
    });

  const installOfficial = (manifest: PluginManifest) =>
    install(validateManifest(manifest, contextOf(true)), "official", officialCode(manifest.id));

  /** 从文件装：选清单（.json）；带脚本的连同清单里 main 写的那个 .js 一起选 */
  const installFiles = async (list: FileList | null) => {
    const files = [...(list ?? [])];
    if (inputRef.current) inputRef.current.value = "";
    if (!files.length) return;
    try {
      const manifests = files.filter((file) => !/\.js$/i.test(file.name));
      if (manifests.length !== 1) {
        throw new Error(
          manifests.length ? "一次只能装一个插件：只选一份清单" : "没有清单：选插件的 .json 清单",
        );
      }
      const file = manifests[0]!;
      if (file.size > MAX_MANIFEST_BYTES) throw new Error("清单文件不能超过 1 MB");
      const manifest = parseManifestText(await file.text(), contextOf(false));
      let code: string | undefined;
      if (manifest.main) {
        const script = files.find((item) => item.name === manifest.main);
        if (!script) {
          throw new Error(
            `「${manifest.name}」带脚本：连同 ${manifest.main} 一起选（按住 Ctrl 多选）`,
          );
        }
        if (script.size > MAX_CODE_BYTES) {
          throw new Error(`${manifest.main} 不能超过 ${MAX_CODE_BYTES / 1024 / 1024} MB`);
        }
        code = await script.text();
      }
      await install(manifest, "file", code);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  /** 装着的插件还有没问过的权限（升级多要了、别的设备装的时候没问）：问一遍 */
  const authorize = (plugin: InstalledPlugin) =>
    run(plugin.manifest.id, async () => {
      const answer = await askConsent(plugin.manifest, undecided(plugin), "later");
      if (!answer) return undefined;
      setGrants(plugin.manifest.id, {
        granted: [...plugin.grants.granted, ...answer.granted],
        denied: [...plugin.grants.denied, ...answer.denied],
      });
      return `「${plugin.manifest.name}」的权限记下了`;
    });

  /** 改主意了：把同意过、没同意的都清掉，重新问一遍 */
  const reauthorize = (plugin: InstalledPlugin) =>
    run(plugin.manifest.id, async () => {
      const answer = await askConsent(plugin.manifest, plugin.manifest.capabilities ?? [], "later");
      if (!answer) return undefined;
      setGrants(plugin.manifest.id, answer);
      return `「${plugin.manifest.name}」的权限改好了`;
    });

  const restart = (manifest: PluginManifest) =>
    run(manifest.id, async () => {
      await restartScripted(manifest.id);
      return `「${manifest.name}」重新启动了`;
    });

  const toggle = (manifest: PluginManifest, on: boolean) =>
    run(manifest.id, async () => {
      await setExtension(manifest.id, on, on ? rangeOf(manifest.version) : undefined);
      return on
        ? `「${manifest.name}」在这个仓库里开着了`
        : `「${manifest.name}」在这个仓库里停用了，文档原样不变`;
    });

  const uninstall = (id: string, name: string) =>
    run(id, async () => {
      uninstallPlugin(id);
      return `已从这台设备上卸载「${name}」`;
    });

  const forget = (id: string) =>
    run(id, async () => {
      await setExtension(id, false);
      return `这个仓库不再用「${officialPlugin(id)?.name ?? id}」了`;
    });

  const toggleBuiltin = (plugin: Plugin, on: boolean) =>
    run(plugin.id, async () => {
      await setPlugin(plugin.id, on);
      return undefined;
    });

  return (
    // 和 DocumentView 用同一套：原生滚动条不画也不占位，滑块自己叠一个。
    // relative 必须在滚动容器这一层，滑块才贴得住它的右边缘。
    <div className="relative h-full bg-canvas">
      <div ref={scrollRef} className="scroll-none h-full overflow-y-auto">
        <main className="mx-auto w-full max-w-[1120px] px-14 pt-[58px] pb-16">
          <header className="flex items-start justify-between gap-8">
            <div>
              <h1 className="text-[38px] font-bold leading-tight tracking-[-0.025em] text-ink">
                扩展
              </h1>
              <p className="mt-2 text-[13px] text-muted">
                插件装在这台设备上，在这个仓库里开着的才生效；开没开记在仓库里，跟着仓库同步。
              </p>
            </div>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="flex h-9 shrink-0 items-center gap-2 rounded-lg bg-ink px-3.5 text-[13px]
                       font-medium text-canvas transition-opacity hover:opacity-85"
            >
              <Upload size={14} />
              从文件安装
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".json,.js,.odeax,.otwx,application/json,text/javascript"
              multiple
              className="hidden"
              aria-label="选择插件清单文件（带脚本的连同脚本一起选）"
              onChange={(event) => void installFiles(event.target.files)}
            />
          </header>

          {notice && (
            <button
              type="button"
              onClick={() => setNotice(null)}
              className={cn(
                "mt-6 w-full rounded-lg px-3 py-2 text-left text-[12px] leading-[1.6]",
                notice.tone === "ok" ? "bg-accent-wash text-accent" : "bg-danger/10 text-danger",
              )}
            >
              {notice.text}
            </button>
          )}

          {missing.length > 0 && (
            <Section title="这个仓库想用" hint="仓库里开着，这台设备上还没装">
              {missing.map((entry) => (
                <MissingCard
                  key={entry.id}
                  entry={entry}
                  busy={busy === entry.id}
                  onInstall={(manifest) => void installOfficial(manifest)}
                  onForget={() => void forget(entry.id)}
                />
              ))}
            </Section>
          )}

          <Section title="已安装">
            {builtin.map((plugin) => {
              const on = builtinOn.includes(plugin.id);
              return (
                <Card
                  key={plugin.id}
                  icon={plugin.nav[0]?.icon ?? Puzzle}
                  name={plugin.name}
                  meta="内置"
                  verified
                  summary={plugin.toggle!.on.hint}
                  status={on ? "on" : "off"}
                >
                  <ToggleButton
                    on={on}
                    busy={busy === plugin.id}
                    onClick={() => void toggleBuiltin(plugin, !on)}
                  />
                </Card>
              );
            })}
            {installed.map((plugin) => {
              const { manifest, source } = plugin;
              const entry = wantedOf(manifest.id);
              const on = !!entry;
              const official = source === "official" ? officialPlugin(manifest.id) : undefined;
              const newer = official && official.version !== manifest.version ? official : null;
              const runtime = on && isScripted(manifest) ? scripted[manifest.id] : undefined;
              return (
                <Card
                  key={manifest.id}
                  icon={iconOf(manifest)}
                  name={manifest.name}
                  meta={`${manifest.author} · v${manifest.version}`}
                  verified={source === "official"}
                  summary={manifest.summary}
                  details={contributionsOf(manifest)}
                  status={on ? "on" : "off"}
                  warning={
                    entry?.version && !satisfies(manifest.version, entry.version)
                      ? `仓库要的是 ${entry.version}，这台设备装的是 ${manifest.version}（照样生效）`
                      : undefined
                  }
                  extra={
                    isScripted(manifest) ? (
                      <ScriptedDetails
                        plugin={plugin}
                        state={runtime?.state}
                        log={runtime?.log ?? []}
                        busy={busy === manifest.id}
                        onAuthorize={() => void authorize(plugin)}
                        onReauthorize={() => void reauthorize(plugin)}
                        onRestart={() => void restart(manifest)}
                      />
                    ) : undefined
                  }
                >
                  <UninstallButton
                    busy={busy === manifest.id}
                    onClick={() => void uninstall(manifest.id, manifest.name)}
                  />
                  {newer && (
                    <ActionButton
                      busy={busy === manifest.id}
                      onClick={() => void installOfficial(newer)}
                    >
                      更新到 {newer.version}
                    </ActionButton>
                  )}
                  <ToggleButton
                    on={on}
                    busy={busy === manifest.id}
                    onClick={() => void toggle(manifest, !on)}
                  />
                </Card>
              );
            })}
            {broken.map((plugin) => (
              <BrokenCard
                key={`broken-${plugin.id}`}
                plugin={plugin}
                busy={busy === plugin.id}
                onUninstall={() => void uninstall(plugin.id, plugin.name)}
              />
            ))}
          </Section>

          {catalog.length > 0 && (
            <Section title="官方插件" hint="跟着 Odea 一起发的">
              {catalog.map((manifest) => (
                <Card
                  key={manifest.id}
                  icon={iconOf(manifest)}
                  name={manifest.name}
                  meta={`${manifest.author} · v${manifest.version} · ${CATEGORY_LABEL[manifest.category]}`}
                  verified
                  summary={manifest.summary}
                  details={contributionsOf(manifest)}
                >
                  <ActionButton
                    primary
                    busy={busy === manifest.id}
                    onClick={() => void installOfficial(manifest)}
                  >
                    安装
                  </ActionButton>
                </Card>
              ))}
            </Section>
          )}
        </main>
      </div>
      <OverlayScrollbar targetRef={scrollRef} />
    </div>
  );
}

/** 卡片上那一行小字：这个插件加了什么 */
function contributionsOf(manifest: PluginManifest): string[] {
  const { callouts, templates, theme, navOrder, commands, documentSlots } = manifest.contributes;
  return [
    isScripted(manifest) ? "带脚本" : "",
    callouts?.length ? `提示块 ${callouts.length} 种` : "",
    templates?.length ? `模板 ${templates.length} 个` : "",
    theme ? "主题色" : "",
    navOrder?.length ? "导航顺序" : "",
    commands?.length ? `命令 ${commands.length} 条` : "",
    documentSlots?.length ? "正文后面的一段" : "",
  ].filter(Boolean);
}

function iconOf(manifest: PluginManifest): LucideIcon {
  if (isScripted(manifest)) return FileCode2;
  return manifest.contributes.theme && !manifest.contributes.callouts ? Palette : PackageOpen;
}

const STATE_TEXT: Record<PluginState["state"], string> = {
  idle: "用到时启动",
  starting: "正在启动",
  running: "在跑",
  failed: "启动失败",
  stopped: "停下了",
  consent: "等你授权",
};

/** 带脚本的插件：在不在跑、要的权限、最近的报错 */
function ScriptedDetails({
  plugin,
  state,
  log,
  busy,
  onAuthorize,
  onReauthorize,
  onRestart,
}: {
  plugin: InstalledPlugin;
  /** 这个仓库没开它时没有 */
  state: PluginState | undefined;
  log: PluginLogEntry[];
  busy: boolean;
  onAuthorize: () => void;
  onReauthorize: () => void;
  onRestart: () => void;
}) {
  const capabilities = plugin.manifest.capabilities ?? [];
  const granted = new Set(plugin.grants.granted);
  const denied = new Set(plugin.grants.denied);
  const pending = undecided(plugin).length > 0;
  const broken = state?.state === "failed" || state?.state === "stopped";
  const recent = log.slice(-3).reverse();
  return (
    <div className="mt-3 flex flex-col gap-2">
      {state && (
        <p
          className={cn(
            "flex items-center gap-1.5 text-[12px]",
            broken ? "text-danger" : state.state === "consent" ? "text-warning" : "text-muted",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              state.state === "running"
                ? "bg-success"
                : broken
                  ? "bg-danger"
                  : state.state === "consent"
                    ? "bg-warning"
                    : "bg-faint",
            )}
          />
          <span className="min-w-0">
            {STATE_TEXT[state.state]}
            {"message" in state ? `：${state.message}` : ""}
          </span>
        </p>
      )}
      {capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {capabilities.map((capability: Capability) => {
            const key = capabilityKey(capability);
            const mark = granted.has(key) ? "✓" : denied.has(key) ? "✕" : "?";
            return (
              <span
                key={key}
                title={CAPABILITY_TEXT[key]?.detail ?? key}
                className={cn(
                  "rounded px-2 py-1 text-[12px]",
                  granted.has(key) ? "bg-success/10 text-success" : "bg-raised/60 text-muted",
                )}
              >
                {mark} {CAPABILITY_TEXT[key]?.label ?? key}
              </span>
            );
          })}
        </div>
      )}
      {recent.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {recent.map((entry) => (
            <li
              key={`${entry.at}-${entry.message}`}
              className={cn(
                "line-clamp-2 text-[12px] leading-[1.6]",
                entry.level === "error" ? "text-danger" : "text-warning",
              )}
            >
              {entry.message}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-1.5">
        {pending ? (
          <ActionButton primary busy={busy} onClick={onAuthorize}>
            授权…
          </ActionButton>
        ) : (
          capabilities.length > 0 && (
            <ActionButton busy={busy} onClick={onReauthorize}>
              改权限…
            </ActionButton>
          )
        )}
        {broken && (
          <ActionButton busy={busy} onClick={onRestart}>
            重新启动
          </ActionButton>
        )}
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="flex items-baseline gap-2 text-[13px] font-semibold text-ink">
        {title}
        {hint && <span className="text-[12px] font-normal text-muted">{hint}</span>}
      </h2>
      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">{children}</div>
    </section>
  );
}

function Card({
  icon: Icon,
  name,
  meta,
  verified,
  summary,
  details,
  status,
  warning,
  extra,
  children,
}: {
  icon: LucideIcon;
  name: string;
  meta: string;
  verified?: boolean;
  summary: string;
  details?: string[];
  /** 在这个仓库里开没开；missing：仓库开着、这台设备没装；目录里还没装的没有 */
  status?: "on" | "off" | "missing";
  warning?: string;
  /** 卡片中间多出来的一块（带脚本的插件的状态、权限） */
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className="flex min-h-[164px] flex-col rounded-xl border border-line-strong bg-panel/55 p-5">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-xl",
            status === "off" || status === "missing"
              ? "bg-raised/60 text-muted"
              : "bg-accent-wash text-accent",
          )}
        >
          <Icon size={20} strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[15px] font-semibold text-ink">{name}</h3>
            {verified && (
              <ShieldCheck size={14} className="shrink-0 text-success" aria-label="官方" />
            )}
          </div>
          <p className="mt-0.5 text-[12px] text-muted">{meta}</p>
        </div>
        {status && (
          <span
            className={cn(
              "shrink-0 rounded px-2 py-1 text-[12px]",
              status === "on"
                ? "bg-success/10 text-success"
                : status === "missing"
                  ? "bg-warning/10 text-warning"
                  : "bg-raised/60 text-muted",
            )}
          >
            {status === "on"
              ? "这个仓库开着"
              : status === "missing"
                ? "这台设备没装"
                : "这个仓库没开"}
          </span>
        )}
      </div>
      <p className="mt-4 line-clamp-2 text-[13px] leading-[1.7] text-muted">{summary}</p>
      {warning && (
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-warning">
          <CircleAlert size={12} className="shrink-0" />
          {warning}
        </p>
      )}
      {extra}
      <div className="mt-auto flex items-end justify-between gap-3 pt-4">
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {details?.map((detail) => (
            <span key={detail} className="rounded bg-raised/60 px-2 py-1 text-[12px] text-muted">
              {detail}
            </span>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">{children}</div>
      </div>
    </article>
  );
}

function ActionButton({
  primary,
  busy,
  onClick,
  children,
}: {
  primary?: boolean;
  busy?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium transition-colors disabled:opacity-50",
        primary
          ? "bg-accent text-accent-ink hover:bg-accent-hover"
          : "bg-raised text-ink hover:bg-line-strong",
      )}
    >
      {children}
    </button>
  );
}

function ToggleButton({ on, busy, onClick }: { on: boolean; busy: boolean; onClick: () => void }) {
  return (
    <ActionButton primary={!on} busy={busy} onClick={onClick}>
      {on ? "停用" : "启用"}
    </ActionButton>
  );
}

function UninstallButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="从这台设备上卸载"
      title="从这台设备上卸载"
      disabled={busy}
      onClick={onClick}
      className="grid h-8 w-8 place-items-center rounded-lg text-faint transition-colors
                 hover:bg-danger/10 hover:text-danger disabled:opacity-50"
    >
      <Trash2 size={14} />
    </button>
  );
}

function MissingCard({
  entry,
  busy,
  onInstall,
  onForget,
}: {
  entry: WantedExtension;
  busy: boolean;
  onInstall: (manifest: PluginManifest) => void;
  onForget: () => void;
}) {
  const official = officialPlugin(entry.id);
  return (
    <Card
      icon={Puzzle}
      name={official?.name ?? entry.id}
      meta={entry.version ? `${entry.id} · 要 ${entry.version}` : entry.id}
      verified={!!official}
      summary={
        official
          ? official.summary
          : "这台设备上没有它。拿到它的清单文件以后，用右上角的「从文件安装」装上；不想要了点「不用了」，在这个仓库里关掉它。"
      }
      status="missing"
    >
      <ActionButton busy={busy} onClick={onForget}>
        不用了
      </ActionButton>
      {official && (
        <ActionButton primary busy={busy} onClick={() => onInstall(official)}>
          安装
        </ActionButton>
      )}
    </Card>
  );
}

function BrokenCard({
  plugin,
  busy,
  onUninstall,
}: {
  plugin: BrokenPlugin;
  busy: boolean;
  onUninstall: () => void;
}) {
  return (
    <article className="flex min-h-[164px] flex-col rounded-xl border border-danger/30 bg-panel/55 p-5">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-danger/10 text-danger">
          <CircleAlert size={20} strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold text-ink">{plugin.name}</h3>
          <p className="mt-0.5 text-[12px] text-muted">装着，但这个版本用不了 · 不生效</p>
        </div>
      </div>
      <p className="mt-4 text-[13px] leading-[1.7] text-danger">{plugin.error}</p>
      <div className="mt-auto flex justify-end pt-4">
        <UninstallButton busy={busy} onClick={onUninstall} />
      </div>
    </article>
  );
}
