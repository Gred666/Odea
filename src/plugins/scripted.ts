import { backend } from "@/data/backend";
import { folderOf } from "@/data/folders";
import { saveKeyOf, useData } from "@/data/store";
import { NOTE, noteRef } from "@/data/types";
import {
  type Grants,
  type InstalledPlugin,
  pluginCode,
  undecided,
  useInstalled,
} from "@/extensions/installed";
import {
  type Capability,
  type CommandContribution,
  type PluginManifest,
  type SlotContribution,
  isScripted,
} from "@/extensions/manifest";
import { fingerprint } from "@/lib/fingerprint";
import {
  type VisibleDocument,
  focusedDocument,
  liveEditor,
  onDocumentTouched,
  onVisibleChange,
  visibleDocument,
  visibleDocuments,
} from "@/lib/liveDocuments";
import { create } from "zustand";
import { documentType } from "./registry";
import { createSandbox, sandboxFrames } from "./sandbox/host";
import type { Port } from "./sandbox/protocol";
import {
  type DocInfo,
  LIMITS,
  PluginRuntime,
  type RuntimeHost,
  type RuntimeStatus,
  type SandboxFactory,
} from "./sandbox/runtime";
import type { ViewNode } from "./sandbox/views";

/* ============================================================
   带脚本的插件（L1，docs/插件与跨端.md §5.4、§5.5）的管家，和 L0 的 declared.ts 并排。

   生效的 = 这台设备装着的 ∩ 这个仓库开着的 ∩ 平台对得上的。每一个生效的插件一个 PluginRuntime
   （sandbox/runtime.ts），但不急着起：
   - 清单里申请的能力这台设备上还有没问过的（新装、升级多要了、团队仓库里开着但这台没同意过）：
     等用户在扩展页里点「授权」，之前不启动（§6.4「先信任，再执行」）
   - activation 里有 startup 的，仓库一打开就起；其余的用到哪个贡献点时才起：
     点了它的命令（command:<id>），或者有文档显示着、要画它的槽位（slot:<id>）
   装、卸、开、关、改了授权、升级（脚本换了），都整个对一遍：不再生效的停掉，换了的重启。

   槽位：每一篇显示着的文档，每个插件的每个槽位交一棵视图（或者 null）。显示出来、打字停下来、
   插件重启、点了按钮之后都重新要一次。要回来之前接着显示上一棵，不先空一下（「中间不闪一帧」）；
   切走又切回来的那一篇先显示记着的那一棵。插件停了、出错了，它的那几段就撤掉。
   ============================================================ */

/** 一个 L1 插件在这个窗口里的样子；consent 是还有能力没问过、等授权 */
export type PluginState = RuntimeStatus | { state: "consent" };

export interface PluginLogEntry {
  at: number;
  level: "error" | "warn";
  message: string;
}

/** 某一篇上，某个插件的某个槽位交来的那一棵 */
export interface SlotView {
  plugin: string;
  pluginName: string;
  slot: string;
  title: string;
  tree: ViewNode;
}

interface ScriptedState {
  plugins: Record<string, { state: PluginState; log: PluginLogEntry[] }>;
  /** 文档的键（saveKeyOf）→ 那一篇上的几段，按插件装上的先后、槽位声明的先后 */
  slots: Record<string, SlotView[]>;
}

export const useScripted = create<ScriptedState>(() => ({ plugins: {}, slots: {} }));

/** 这台设备是哪一种：手机端还没做（P14.5） */
const PLATFORM = "desktop";
/** 记着几篇文档上的槽位（切回来先显示记着的） */
const SLOT_CACHE = 40;
/** 扩展页上每个插件留几条最近的报错 */
const LOG_KEEP = 8;

interface Entry {
  plugin: InstalledPlugin;
  /** 脚本、授权都没变就是同一个运行时 */
  stamp: string;
  runtime: PluginRuntime | null;
}

const entries = new Map<string, Entry>();
/** 每个（插件 / 槽位 / 文档）正在要、要完了还得再要一次 */
const rendering = new Map<string, { dirty: boolean }>();
let sandboxFactory: SandboxFactory = async (manifest) => {
  const sandbox = await createSandbox({
    plugin: manifest.id,
    limits: { messagesPerSecond: LIMITS.messagesPerSecond },
  });
  // MessagePort 的 onmessage 收的是 MessageEvent，协议那边只用到 data
  return { port: sandbox.port as unknown as Port, dispose: sandbox.dispose };
};

const stampOf = (plugin: InstalledPlugin) =>
  `${plugin.updatedAt}|${plugin.grants.granted.join(",")}|${plugin.grants.denied.join(",")}`;

/** 生效的 L1 插件：装着、这个仓库开着、平台对得上 */
export function activeScripted(): InstalledPlugin[] {
  const wanted = new Set(useData.getState().layout.extensions.map((entry) => entry.id));
  return useInstalled
    .getState()
    .plugins.filter(
      (plugin) =>
        isScripted(plugin.manifest) &&
        wanted.has(plugin.manifest.id) &&
        (!plugin.manifest.platforms || plugin.manifest.platforms.includes(PLATFORM)),
    );
}

/* ---------------- 状态 ---------------- */

function setState(id: string, state: PluginState) {
  useScripted.setState((current) => ({
    plugins: { ...current.plugins, [id]: { state, log: current.plugins[id]?.log ?? [] } },
  }));
}

function log(id: string, level: "error" | "warn", message: string) {
  if (import.meta.env.DEV) console[level](`[插件 ${id}]`, message);
  useScripted.setState((current) => {
    const entry = current.plugins[id];
    if (!entry) return current;
    const next = [...entry.log, { at: Date.now(), level, message }].slice(-LOG_KEEP);
    return { plugins: { ...current.plugins, [id]: { ...entry, log: next } } };
  });
}

function forget(id: string) {
  useScripted.setState((current) => {
    const { [id]: _gone, ...plugins } = current.plugins;
    return { plugins, slots: withoutPlugin(current.slots, id) };
  });
}

function withoutPlugin(slots: ScriptedState["slots"], id: string): ScriptedState["slots"] {
  let changed = false;
  const next: ScriptedState["slots"] = {};
  for (const [key, views] of Object.entries(slots)) {
    const kept = views.filter((view) => view.plugin !== id);
    if (kept.length !== views.length) changed = true;
    if (kept.length) next[key] = kept;
  }
  return changed ? next : slots;
}

/** 换上某一篇上某个槽位的那一棵（null 是拿掉）。按插件装上的先后、槽位声明的先后排 */
function putSlot(
  key: string,
  manifest: PluginManifest,
  slot: SlotContribution,
  tree: ViewNode | null,
) {
  useScripted.setState((current) => {
    const views = current.slots[key] ?? [];
    const others = views.filter((view) => !(view.plugin === manifest.id && view.slot === slot.id));
    const next = tree
      ? [
          ...others,
          {
            plugin: manifest.id,
            pluginName: manifest.name,
            slot: slot.id,
            title: slot.title,
            tree,
          },
        ]
      : others;
    const order = activeScripted().map((plugin) => plugin.manifest.id);
    const slotOrder = (view: SlotView) =>
      (entries.get(view.plugin)?.plugin.manifest.contributes.documentSlots ?? []).findIndex(
        (item) => item.id === view.slot,
      );
    next.sort(
      (a, b) => order.indexOf(a.plugin) - order.indexOf(b.plugin) || slotOrder(a) - slotOrder(b),
    );
    const slots = { ...current.slots };
    if (next.length) slots[key] = next;
    else delete slots[key];
    // 只记最近的几篇：看得见的留着
    const keys = Object.keys(slots);
    if (keys.length > SLOT_CACHE) {
      const shown = new Set(visibleDocuments().map((doc) => doc.key));
      for (const old of keys) {
        if (Object.keys(slots).length <= SLOT_CACHE) break;
        if (!shown.has(old)) delete slots[old];
      }
    }
    return { slots };
  });
}

/* ---------------- 运行时接到应用上 ---------------- */

function infoOf(doc: VisibleDocument): DocInfo {
  const editor = liveEditor(doc.key);
  return {
    ref: doc.ref,
    title: doc.title,
    revision: editor?.revision() ?? `saved:${fingerprint(doc.bodyMd)}`,
  };
}

function hostFor(manifest: PluginManifest): RuntimeHost {
  const slotOf = (id: string) =>
    (manifest.contributes.documentSlots ?? []).find((slot) => slot.id === id);
  return {
    current() {
      const doc = focusedDocument();
      return doc ? infoOf(doc) : null;
    },
    isVisible: (ref) => !!visibleDocument(saveKeyOf(ref)),
    async read(ref) {
      const shown = visibleDocument(saveKeyOf(ref));
      if (shown) {
        const editor = liveEditor(shown.key);
        return { ...infoOf(shown), text: editor ? editor.text() : shown.bodyMd };
      }
      if (ref.type === NOTE) {
        const note = await (await backend()).noteGet(ref.key).catch(() => null);
        if (!note) return null;
        return {
          ref,
          title: note.title,
          text: note.contentMd,
          revision: `saved:${fingerprint(note.contentMd)}`,
        };
      }
      const type = documentType(ref.type);
      if (!type) return null;
      await type.load(ref.key);
      const text = type.body(ref.key);
      if (text === undefined) return null;
      return { ref, title: type.title(ref.key), text, revision: `saved:${fingerprint(text)}` };
    },
    list() {
      const { notes, archived } = useData.getState();
      return [...notes, ...archived].map((note) => ({
        ref: noteRef(note.id),
        title: note.title,
        folder: folderOf(note),
        updatedAt: note.updatedAt,
        archived: note.isArchived,
      }));
    },
    edit(ref, base, changes) {
      const editor = liveEditor(saveKeyOf(ref));
      return editor ? editor.edit(base, changes as never, manifest.id) : null;
    },
    notify: (text) => useData.setState({ notice: text }),
    onCurrentChange(listener) {
      let last = focusedDocument()?.key ?? null;
      return onVisibleChange(() => {
        const doc = focusedDocument();
        const key = doc?.key ?? null;
        if (key === last) return;
        last = key;
        listener(doc ? infoOf(doc) : null);
      });
    },
    onDocumentChange(listener) {
      return onDocumentTouched((key) => {
        const doc = visibleDocument(key);
        if (doc) listener(infoOf(doc));
      });
    },
    pushSlot(slotId, ref, tree) {
      const slot = slotOf(slotId);
      if (slot) putSlot(saveKeyOf(ref), manifest, slot, tree);
    },
    slotTree(slotId, ref) {
      return (
        useScripted
          .getState()
          .slots[saveKeyOf(ref)]?.find(
            (view) => view.plugin === manifest.id && view.slot === slotId,
          )?.tree ?? null
      );
    },
  };
}

function createRuntime(plugin: InstalledPlugin): PluginRuntime | null {
  const { manifest } = plugin;
  const code = pluginCode(manifest.id);
  if (code === null) return null;
  // 停一个运行时是异步的（先问它一声）：停完那一下的状态晚到，那时它可能已经被换掉了（升级、停用）。
  // 不是现在这一个的就不认，免得把新的那一个的状态、画好的槽位冲掉，或者停用后又留下一条
  const current = () => entries.get(manifest.id)?.runtime === runtime;
  const runtime: PluginRuntime = new PluginRuntime(
    manifest,
    code,
    plugin.grants.granted,
    hostFor(manifest),
    sandboxFactory,
    {
      onStatus(status) {
        if (!current()) return;
        setState(manifest.id, status);
        if (status.state === "running") renderAll(manifest.id);
        else if (status.state !== "starting") {
          // 停了、出错了：它画的那几段撤掉，还在排队的不要了
          useScripted.setState((state) => ({ slots: withoutPlugin(state.slots, manifest.id) }));
          for (const key of [...rendering.keys()]) {
            if (
              key.startsWith(`${manifest.id}
`)
            )
              rendering.delete(key);
          }
        }
      },
      onLog(level, message) {
        if (current()) log(manifest.id, level, message);
      },
      onWarn(message) {
        if (current()) log(manifest.id, "warn", message);
        useData.setState({ notice: message });
      },
    },
  );
  return runtime;
}

/* ---------------- 对一遍 ---------------- */

/** 装、卸、开、关、改授权、升级之后：不再生效的停掉，换了的重启，该起的起 */
function reconcile() {
  const active = activeScripted();
  const ids = new Set(active.map((plugin) => plugin.manifest.id));
  for (const [id, entry] of entries) {
    if (ids.has(id)) continue;
    entries.delete(id);
    void entry.runtime?.stop();
    forget(id);
  }
  for (const plugin of active) {
    const id = plugin.manifest.id;
    const stamp = stampOf(plugin);
    const entry = entries.get(id);
    if (entry && entry.stamp === stamp) {
      entry.plugin = plugin;
      continue;
    }
    if (entry) {
      void entry.runtime?.stop();
      useScripted.setState((current) => ({ slots: withoutPlugin(current.slots, id) }));
    }
    if (undecided(plugin).length) {
      entries.set(id, { plugin, stamp, runtime: null });
      setState(id, { state: "consent" });
      continue;
    }
    const runtime = createRuntime(plugin);
    entries.set(id, { plugin, stamp, runtime });
    if (!runtime) {
      setState(id, { state: "failed", message: "脚本不见了：卸掉再装一次" });
      continue;
    }
    setState(id, { state: "idle" });
    const activation = plugin.manifest.activation ?? [];
    if (activation.includes("startup")) void runtime.start().catch(() => {});
    else if (visibleDocuments().length) renderAll(id);
  }
}

/** 这个插件的这个槽位用到了能不能起它 */
const startsOnSlot = (manifest: PluginManifest, slot: SlotContribution) => {
  const activation = manifest.activation ?? [];
  return activation.includes("startup") || activation.includes(`slot:${slot.id}`);
};

/** 某个插件在所有看得见的文档上重新画一遍 */
function renderAll(id: string) {
  for (const doc of visibleDocuments()) renderDocument(id, doc);
}

function renderDocument(id: string, doc: VisibleDocument) {
  const entry = entries.get(id);
  const runtime = entry?.runtime;
  if (!entry || !runtime) return;
  for (const slot of entry.plugin.manifest.contributes.documentSlots ?? []) {
    void renderSlot(runtime, slot, doc.key);
  }
}

/** 要一次某一篇上某个槽位的视图；正在要的话，要完了再要一次（中间的改动都在那一次里） */
async function renderSlot(runtime: PluginRuntime, slot: SlotContribution, key: string) {
  const job = `${runtime.id}\n${slot.id}\n${key}`;
  const queued = rendering.get(job);
  if (queued) {
    queued.dirty = true;
    return;
  }
  const state = { dirty: false };
  rendering.set(job, state);
  try {
    do {
      state.dirty = false;
      const doc = visibleDocument(key);
      if (!doc) break;
      if (runtime.status.state !== "running") {
        if (runtime.status.state !== "idle" && runtime.status.state !== "starting") break;
        if (!startsOnSlot(runtime.manifest, slot)) break;
        await runtime.start();
      }
      const info: DocInfo & { text?: string } = infoOf(doc);
      // 能读这一篇的，正文跟着一起给（省一次来回）
      if (runtime.canRead(doc.ref)) info.text = liveEditor(doc.key)?.text() ?? doc.bodyMd;
      const tree = await runtime.renderSlot(slot.id, info);
      if (rendering.get(job) !== state) return;
      if (tree !== undefined && entries.get(runtime.id)?.runtime === runtime) {
        putSlot(key, runtime.manifest, slot, tree);
      }
    } while (state.dirty);
  } catch {
    // 超时、出错：runtime 那边已经记下了（犯规、日志），这一段照旧显示上一棵
  } finally {
    if (rendering.get(job) === state) rendering.delete(job);
  }
}

/* ---------------- 给界面的 ---------------- */

/** 命令面板里的那几条：生效的插件声明的命令（还没启动的也列，点了才起） */
export interface ScriptedCommand {
  plugin: string;
  pluginName: string;
  command: CommandContribution;
}

export function scriptedCommands(): ScriptedCommand[] {
  return activeScripted().flatMap((plugin) =>
    (plugin.manifest.contributes.commands ?? []).map((command) => ({
      plugin: plugin.manifest.id,
      pluginName: plugin.manifest.name,
      command,
    })),
  );
}

/** 跑一条插件的命令：没起的先起；没做成在提示条里说 */
export async function runScriptedCommand(id: string, command: string): Promise<void> {
  const entry = entries.get(id);
  const name = entry?.plugin.manifest.name ?? id;
  const title =
    entry?.plugin.manifest.contributes.commands?.find((item) => item.id === command)?.title ??
    command;
  try {
    if (!entry) throw new Error("这个仓库没开它");
    if (!entry.runtime) throw new Error("还没授权：到扩展页里点「授权」");
    await entry.runtime.start();
    await entry.runtime.runCommand(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useData.setState({ notice: `${name}的「${title}」没做成：${message}` });
  }
}

/** 槽位里点了按钮、提交了表单：交给插件，做完马上重画那一段 */
export async function runSlotAction(
  view: Pick<SlotView, "plugin" | "slot">,
  key: string,
  action: string,
  value?: unknown,
  form?: Record<string, unknown>,
): Promise<void> {
  const entry = entries.get(view.plugin);
  const runtime = entry?.runtime;
  const doc = visibleDocument(key);
  const slot = entry?.plugin.manifest.contributes.documentSlots?.find(
    (item) => item.id === view.slot,
  );
  if (!runtime || !doc || !slot) return;
  try {
    await runtime.slotAction(slot.id, infoOf(doc), action, value, form);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useData.setState({ notice: `${entry.plugin.manifest.name}没做成：${message}` });
  }
  await renderSlot(runtime, slot, key);
}

/** 扩展页的「重新启动」 */
export async function restartScripted(id: string): Promise<void> {
  const runtime = entries.get(id)?.runtime;
  if (!runtime) return;
  await runtime.restart();
}

/* ---------------- 授权 ---------------- */

export interface ConsentRequest {
  manifest: PluginManifest;
  /** 要问的那几项 */
  capabilities: Capability[];
  /** install：装之前问；later：装着的插件还有没问过的（升级、团队仓库里开着） */
  mode: "install" | "later";
  resolve(grants: Grants | null): void;
}

export const useConsent = create<{ request: ConsentRequest | null }>(() => ({ request: null }));

/** 问用户同不同意（PluginConsent 对话框）。null 是取消了 */
export function askConsent(
  manifest: PluginManifest,
  capabilities: Capability[],
  mode: ConsentRequest["mode"],
): Promise<Grants | null> {
  useConsent.getState().request?.resolve(null);
  return new Promise((resolve) => {
    useConsent.setState({
      request: {
        manifest,
        capabilities,
        mode,
        resolve: (grants) => {
          useConsent.setState({ request: null });
          resolve(grants);
        },
      },
    });
  });
}

/* ---------------- 启动 ---------------- */

let started = false;

/** boot/vault.tsx 在 initDeclaredPlugins 之后调一次（装着的清单那时已经读好了） */
export function initScriptedPlugins(): void {
  if (started || typeof document === "undefined") return;
  started = true;
  useInstalled.subscribe((state, before) => {
    if (state.plugins !== before.plugins) reconcile();
  });
  useData.subscribe((state, before) => {
    if (state.layout.extensions !== before.layout.extensions) reconcile();
  });
  // 有文档显示出来了：画它上面的槽位（第一次显示时也是用到槽位的插件起来的时候）
  let shown = new Set<string>();
  onVisibleChange(() => {
    const now = visibleDocuments();
    const fresh = now.filter((doc) => !shown.has(doc.key));
    shown = new Set(now.map((doc) => doc.key));
    for (const doc of fresh) for (const id of entries.keys()) renderDocument(id, doc);
  });
  // 打字停下来了：重画那一篇上的槽位
  onDocumentTouched((key) => {
    const doc = visibleDocument(key);
    if (!doc) return;
    for (const id of entries.keys()) renderDocument(id, doc);
  });
  reconcile();
  if (import.meta.env.DEV && typeof window !== "undefined") {
    // scripts/perf/plugin-sandbox.mjs 看「停用后不留残留」用
    (window as unknown as Record<string, unknown>).__odeaPlugins = {
      entries,
      rendering,
      frames: sandboxFrames,
      state: () => useScripted.getState(),
    };
  }
}

/** 单测：换掉起沙箱的办法（在进程里跑 workerMain），清空 */
export function resetScriptedForTest(factory?: SandboxFactory): void {
  for (const entry of entries.values()) entry.runtime?.kill("单测重置");
  entries.clear();
  rendering.clear();
  useScripted.setState({ plugins: {}, slots: {} });
  if (factory) sandboxFactory = factory;
  started = false;
}

/** 单测：手动对一遍 */
export const reconcileForTest = reconcile;
