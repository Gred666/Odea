import { ActionMenu } from "@/components/RowMenu";
import { WinButton } from "@/components/TitleBar";
import { DOT, LOGO_VIEWBOX_ATTR, STROKES, STROKE_WIDTH } from "@/components/logoGeometry";
import { cn } from "@/lib/cn";
import { useLingering } from "@/lib/lingering";
import { tween } from "@/lib/motion";
import { isTauri, win } from "@/lib/tauri";
import { FolderOpen, FolderTree, MoreVertical, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { version as APP_VERSION } from "../../package.json";
import { ClonePanel } from "./ClonePanel";
import { type VaultEntry, type VaultLink, launcherApi as api, parseVaultLink } from "./api";
import { Button, FIELD, PanelHeader } from "./parts";

/* ============================================================
   启动器（docs/仓库与启动器.md §3）：左边是用过的仓库，右边是新建 / 打开文件夹 / 从同步仓库拉一份 /
   加入协同编辑。新建时选真实文件夹还是逻辑目录（§7、§15），默认真实文件夹；加入协同编辑开一个
   不带仓库的访客窗口。
   新装第一次打开、已经在运行时再双击图标、仓库窗口里「打开别的仓库…」时出现。
   打开了一个仓库，新窗口画出来以后它自己关掉（Rust 那边关）。

   动效守 CLAUDE.md 的规矩：右边几屏之间只淡 opacity，不位移、不缩放。
   ============================================================ */

type Panel = "home" | "create" | "clone" | "join";

export function Launcher() {
  const [vaults, setVaults] = useState<VaultEntry[] | null>(null);
  const [panel, setPanel] = useState<Panel>("home");
  const [busy, setBusy] = useState(false);
  // 连点挡在这里（同一帧里的第二下读到的 busy 还是 false）
  const running = useRef(false);
  // 按钮变灰、「正在…」过一会儿还没完才露出来：点了已经开着的仓库，Rust 那边几十毫秒就把启动器
  // 藏起来了，立刻变灰的话关掉之前右边整排按钮先闪一下半透明（2026-10-28 用户说「关闭的时候会掉帧」，
  // 实测点下去到藏起来之间按钮半透明画了 20ms，60Hz 的屏上一两帧）
  const pending = useLingering(busy, 200);
  const [error, setError] = useState<string | null>(null);
  // 点团队仓库的链接（odea://vault/）打开的：直接到「从同步仓库拉一份」、停在那个仓库
  const [vaultLink, setVaultLink] = useState<VaultLink | null>(null);

  const refresh = useCallback(() => {
    api
      .vaults()
      .then(setVaults)
      .catch(() => setVaults([]));
  }, []);
  useEffect(refresh, []);
  useEffect(() => {
    const take = (text: string | null) => {
      const link = text ? parseVaultLink(text) : null;
      if (!link) return;
      setVaultLink(link);
      setError(null);
      setPanel("clone");
    };
    void api
      .takeLink()
      .then(take)
      .catch(() => {});
    const unlisten = api.onLink(take);
    return () => void unlisten.then((stop) => stop());
  }, []);
  // 别的窗口开了、关了仓库：回到这个窗口时列表上的「已打开」要对
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  /** 跑一个会打开窗口的操作：期间按钮都不能点，出错了就地说 */
  const run = async (action: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      refresh();
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const go = (next: Panel) => {
    setError(null);
    setPanel(next);
  };

  return (
    <div className="flex h-full w-full select-none overflow-hidden bg-canvas text-body">
      <LauncherTitleBar />

      {/* ---------- 左：用过的仓库 ---------- */}
      <aside className="flex h-full w-[272px] shrink-0 flex-col bg-rail pt-[38px]">
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {vaults !== null && vaults.length === 0 && (
            <p className="px-3 pt-2 text-[13px] leading-[1.6] text-muted">用过的仓库会列在这里</p>
          )}
          {vaults?.map((vault) => (
            <VaultRow
              key={vault.path}
              vault={vault}
              disabled={pending}
              onOpen={() => void run(() => api.open(vault.path))}
              onReveal={() => void api.reveal(vault.path).catch(() => {})}
              onForget={() =>
                void api
                  .forget(vault.path)
                  .then(setVaults)
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              }
            />
          ))}
        </div>
      </aside>

      {/* ---------- 右：Logo 和操作 ---------- */}
      <main className="relative flex h-full min-w-0 flex-1 flex-col items-center pt-[38px]">
        <div className="flex flex-col items-center pt-9">
          <LauncherLogo />
          <p className="mt-2 text-[13px] text-muted">版本 {APP_VERSION}</p>
        </div>

        <div className="mt-6 w-full max-w-[440px] px-6">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={panel}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={tween.fast}
            >
              {panel === "home" && (
                <div className="overflow-hidden rounded-xl bg-panel ring-1 ring-line-strong">
                  <ActionRow
                    title="新建仓库"
                    detail="建一个新文件夹，里面放好使用指南。"
                    button="新建"
                    primary
                    disabled={pending}
                    onClick={() => go("create")}
                  />
                  <ActionRow
                    title="打开文件夹"
                    detail="已有的文件夹，比如 Obsidian 的库。"
                    button="打开"
                    disabled={pending}
                    onClick={() =>
                      void run(async () => {
                        await api.openFolder();
                      })
                    }
                  />
                  <ActionRow
                    title="从同步仓库拉一份"
                    detail="换了电脑：把同步过的笔记拉到这台上。"
                    button="拉取"
                    disabled={pending}
                    onClick={() => go("clone")}
                  />
                  <ActionRow
                    title="加入协同编辑"
                    detail="粘贴别人发来的邀请链接，不用先开仓库。"
                    button="加入"
                    disabled={pending}
                    onClick={() => go("join")}
                  />
                </div>
              )}
              {panel === "create" && (
                <CreatePanel
                  first={vaults?.length === 0}
                  busy={pending}
                  onBack={() => go("home")}
                  onCreate={(parent, name, logical) =>
                    void run(() => api.create(parent, name, logical))
                  }
                />
              )}
              {panel === "clone" && (
                <ClonePanel
                  key={vaultLink?.fullName ?? ""}
                  target={vaultLink}
                  busy={pending}
                  onBack={() => go("home")}
                  onClone={(provider, url, parent, name) =>
                    void run(() => api.clone(provider, url, parent, name))
                  }
                />
              )}
              {panel === "join" && (
                <JoinPanel
                  busy={pending}
                  onBack={() => go("home")}
                  onJoin={(link) => void run(() => api.join(link))}
                />
              )}
            </motion.div>
          </AnimatePresence>

          <p
            role={error ? "alert" : undefined}
            className="mt-3 min-h-[20px] text-[13px] leading-[1.6] text-danger"
          >
            {error}
          </p>
        </div>
      </main>
    </div>
  );
}

/* ---------------- 左边的一条 ---------------- */

function VaultRow({
  vault,
  disabled,
  onOpen,
  onReveal,
  onForget,
}: {
  vault: VaultEntry;
  disabled: boolean;
  onOpen: () => void;
  onReveal: () => void;
  onForget: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      className={cn(
        "relative flex items-center rounded-lg transition-colors duration-[120ms]",
        menuOpen ? "bg-raised" : "hover:bg-raised",
      )}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onOpen}
        title={vault.missing ? `找不到这个文件夹了：${vault.path}` : vault.path}
        className="min-w-0 flex-1 px-3 py-2.5 text-left disabled:cursor-default"
      >
        <span className="flex items-center gap-2">
          <span
            className={cn(
              "truncate text-[14px] font-medium",
              vault.missing ? "text-faint" : "text-ink",
            )}
          >
            {vault.name}
          </span>
          {vault.logical && (
            <FolderTree
              size={14}
              strokeWidth={1.9}
              aria-label="逻辑目录"
              className="shrink-0 text-faint"
            />
          )}
          {vault.open && <Tag>已打开</Tag>}
          {vault.missing && <Tag>找不到</Tag>}
        </span>
        <span className="mt-0.5 block truncate text-[12px] text-muted">{vault.path}</span>
      </button>
      <div className="pr-1.5">
        <ActionMenu
          onOpenChange={setMenuOpen}
          actions={[
            { id: "reveal", label: "在资源管理器中显示", icon: FolderOpen, onSelect: onReveal },
            { id: "forget", label: "从列表里移除（不删文件）", icon: X, onSelect: onForget },
          ]}
          trigger={
            // 一直看得见（Obsidian 的库列表也是）：不做悬停淡入，就没有淡入那一下的图层问题
            <button
              type="button"
              aria-label="更多操作"
              className={cn(
                "grid h-7 w-7 place-items-center rounded-md transition-colors duration-[120ms]",
                "hover:bg-canvas hover:text-ink",
                menuOpen ? "bg-canvas text-ink" : "text-faint",
              )}
            >
              <MoreVertical size={16} strokeWidth={1.9} />
            </button>
          }
        />
      </div>
    </div>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded px-1.5 py-px text-[11px] leading-[1.5] text-muted ring-1 ring-line-strong">
      {children}
    </span>
  );
}

/* ---------------- 右边的几屏 ---------------- */

function ActionRow({
  title,
  detail,
  button,
  primary,
  disabled,
  onClick,
}: {
  title: string;
  detail: string;
  button: string;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center gap-4 border-line border-b px-5 py-4 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium text-ink">{title}</p>
        <p className="mt-0.5 text-[13px] leading-[1.55] text-muted">{detail}</p>
      </div>
      <Button primary={primary} disabled={disabled} onClick={onClick}>
        {button}
      </Button>
    </div>
  );
}

/**
 * 新建的仓库里文件夹怎么摆（docs/仓库与启动器.md §15）。两样的区别当场说清楚、让用户选：
 * 真实文件夹换别的编辑器打开结构不变；逻辑目录能手动排序、随便拖，但硬盘上笔记是平放的
 */
const LAYOUTS = [
  {
    logical: false,
    title: "真实文件夹",
    detail: "树就是硬盘上的文件夹，换别的编辑器打开也一样",
  },
  {
    logical: true,
    title: "逻辑目录",
    detail: "文件夹只在 Odea 里，能手动排序；硬盘上笔记平放",
  },
] as const;

function CreatePanel({
  first,
  busy,
  onBack,
  onCreate,
}: {
  /** 一个仓库都还没有（新装）：名字先填好「Odea」，直接点「创建」就行 */
  first: boolean;
  busy: boolean;
  onBack: () => void;
  onCreate: (parent: string, name: string, logical: boolean) => void;
}) {
  const [name, setName] = useState(first ? "Odea" : "");
  const [parent, setParent] = useState("");
  const [logical, setLogical] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void api.defaultParent().then((dir) => setParent((now) => now || dir));
    nameInput.current?.focus();
  }, []);
  const separator = parent.includes("/") && !parent.includes("\\") ? "/" : "\\";
  const target =
    parent && name.trim() ? `${parent.replace(/[\\/]+$/, "")}${separator}${name.trim()}` : "";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (target && !busy) onCreate(parent, name.trim(), logical);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onBack();
      }}
    >
      <PanelHeader title="新建仓库" onBack={onBack} />
      <label className="block text-[13px] text-muted" htmlFor="launcher-name">
        名字
      </label>
      <input
        id="launcher-name"
        ref={nameInput}
        value={name}
        onChange={(e) => setName(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        placeholder="给仓库起个名字"
        className={cn(FIELD, "mt-1.5")}
      />
      <p className="mt-4 text-[13px] text-muted">位置</p>
      <div className="mt-1.5 flex gap-2">
        <p className={cn(FIELD, "flex items-center truncate text-body")} title={parent}>
          {parent}
        </p>
        <Button
          disabled={busy}
          onClick={() =>
            void api.pickParent(parent).then((picked) => {
              if (picked) setParent(picked);
            })
          }
        >
          换个位置…
        </Button>
      </div>
      <p className="mt-4 text-[13px] text-muted" id="launcher-layout">
        文件夹
      </p>
      {/* 选中只换底色和描边，直接换上（描边是 box-shadow，不做过渡，CLAUDE.md 规矩 2） */}
      <div
        role="radiogroup"
        aria-labelledby="launcher-layout"
        className="mt-1.5 grid grid-cols-2 gap-2"
      >
        {LAYOUTS.map((option) => {
          const checked = option.logical === logical;
          return (
            <button
              key={option.title}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={busy}
              onClick={() => setLogical(option.logical)}
              className={cn(
                "rounded-lg px-3 py-2 text-left ring-1 transition-colors duration-[120ms]",
                checked
                  ? "bg-accent/[0.07] ring-accent"
                  : "bg-canvas ring-line-strong hover:bg-raised",
              )}
            >
              <span className="block text-[13px] font-medium text-ink">{option.title}</span>
              <span className="mt-0.5 block text-[12px] leading-[1.5] text-muted">
                {option.detail}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-5 flex items-center gap-3">
        <p className="min-w-0 flex-1 truncate text-[12px] text-muted" title={target}>
          {target ? `会建在 ${target}` : ""}
        </p>
        <Button type="submit" primary disabled={busy || !target}>
          {busy ? "正在创建…" : "创建"}
        </Button>
      </div>
    </form>
  );
}

function JoinPanel({
  busy,
  onBack,
  onJoin,
}: {
  busy: boolean;
  onBack: () => void;
  onJoin: (link: string) => void;
}) {
  const [link, setLink] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (link.trim() && !busy) onJoin(link.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onBack();
      }}
    >
      <PanelHeader title="加入协同编辑" onBack={onBack} />
      <input
        ref={input}
        value={link}
        onChange={(e) => setLink(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        placeholder="odea://join/…"
        aria-label="邀请链接"
        className={cn(FIELD, "font-mono")}
      />
      <p className="mt-2 text-[12px] leading-[1.6] text-muted">
        协作的那一篇在单独的一个窗口里打开，不用开仓库，也不会存进仓库；想留着就在那里「存一份到我的笔记」。
      </p>
      <div className="mt-5 flex justify-end">
        <Button type="submit" primary disabled={busy || !link.trim()}>
          {busy ? "正在加入…" : "加入"}
        </Button>
      </div>
    </form>
  );
}

/* ---------------- Logo、标题栏 ---------------- */

/** 侧栏 Logo 的字标，放大一号：五笔按书写顺序写一遍、停住（只动描边，原地重画，不进合成层） */
function LauncherLogo() {
  return (
    <svg
      viewBox={LOGO_VIEWBOX_ATTR}
      className="h-[64px] w-[114px] overflow-visible text-ink"
      role="img"
      aria-label="Odea"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {STROKES.map((d, i) => (
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: 静态常量数组，笔画顺序即身份
            key={i}
            d={d}
            pathLength="1"
            className="odea-logo-stroke-once"
            style={{ animationDelay: `${(i * 0.22).toFixed(2)}s` }}
          />
        ))}
      </g>
      <circle cx={DOT.cx} cy={DOT.cy} r={DOT.r} className="fill-accent" />
    </svg>
  );
}

/** 无边框窗口的拖动带和最小化 / 关闭（启动器不能改大小，没有最大化） */
function LauncherTitleBar() {
  if (!isTauri) return null;
  return (
    <div
      className="fixed inset-x-0 top-0 z-40 flex h-[38px] items-stretch justify-end"
      onMouseDown={(event) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
        void win.startDragging();
      }}
    >
      <WinButton label="最小化" onClick={() => void win.minimize()}>
        <rect x="3.5" y="7.5" width="9" height="1" rx="0.5" />
      </WinButton>
      <WinButton label="关闭" danger corner onClick={() => void win.close()}>
        <path d="M4 4l8 8M12 4l-8 8" strokeWidth="1.3" strokeLinecap="round" fill="none" />
      </WinButton>
    </div>
  );
}
