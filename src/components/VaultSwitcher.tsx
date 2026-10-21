import { backend } from "@/data/backend";
import { useData } from "@/data/store";
import { type VaultEntry, launcherApi } from "@/launcher/api";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/tauri";
import { useShare } from "@/share/store";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  CalendarCheck,
  CalendarOff,
  ChevronsUpDown,
  FolderOpen,
  FolderOutput,
  FolderPlus,
  FolderSearch,
  FolderTree,
  type LucideIcon,
  Users,
} from "lucide-react";
import { useState } from "react";

/* ============================================================
   列表栏底下的「仓库名 ⌄」（docs/仓库与启动器.md §3.2、§6；Obsidian 也放在这里）。

   点开往上弹一个菜单：最近用过的别的仓库（点了在它自己的窗口里开，已经开着就提到前面）、
   打开别的仓库…（启动器）、开 / 关日程、转成逻辑目录 / 导出成真实文件夹（§7）、共享（docs/协同编辑.md §20）、
   在文件夹中显示。共享仓库在仓库名后面带一个小标记：几个人在线（静态，不做动画）。
   菜单只淡入淡出（.odea-menu），和别的下拉菜单一样不挂 modal（见 RowMenu）。
   ============================================================ */

/** 菜单里最多列几个别的仓库，再多的去启动器里找 */
const OTHERS_SHOWN = 6;

/** 路径比较：Windows 上不分大小写、斜杠方向不论 */
const pathKey = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** 文件夹名就是仓库名（和启动器一样，不另存） */
const folderName = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || path;

export function VaultSwitcher() {
  const root = useData((s) => s.vaultRoot);
  const journal = useData((s) => s.layout.journal);
  const setJournal = useData((s) => s.setJournal);
  const logical = useData((s) => s.layout.logical);
  const makeLogical = useData((s) => s.makeLogical);
  const exportTree = useData((s) => s.exportTree);
  const openVaultFolder = useData((s) => s.openVaultFolder);
  const [others, setOthers] = useState<VaultEntry[] | null>(null);
  const share = useShare((s) => s.info);
  const online = share ? share.members.filter((member) => member.online && !member.me).length : 0;
  // 浏览器预览里没有仓库文件夹
  const name = root ? folderName(root) : "Odea";

  const fail = (error: unknown) =>
    useData.setState({ error: error instanceof Error ? error.message : String(error) });

  const onOpenChange = (open: boolean) => {
    if (!open) return;
    // 每次打开现取：别的窗口可能刚开了、关了一个仓库
    launcherApi
      .vaults()
      .then((vaults) =>
        setOthers(
          vaults
            .filter((vault) => !root || pathKey(vault.path) !== pathKey(root))
            .slice(0, OTHERS_SHOWN),
        ),
      )
      .catch(() => setOthers([]));
  };

  return (
    <div className="w-[300px] shrink-0 border-t border-r border-line-strong/60 px-3 py-2">
      <DropdownMenu.Root modal={false} onOpenChange={onOpenChange}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            title={root ?? undefined}
            className="group flex h-9 w-full items-center gap-2 rounded-lg pr-2 pl-[7px] text-left outline-none
                       transition-colors duration-[140ms] hover:bg-raised/55 focus-visible:ring-2
                       focus-visible:ring-accent/50 data-[state=open]:bg-raised/55"
          >
            <span
              aria-hidden="true"
              className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md bg-raised text-[12px]
                         font-semibold text-muted"
            >
              {[...name][0]?.toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink/90">
              {name}
            </span>
            {share && (
              <span
                data-share-badge
                title={
                  share.state.state === "ready"
                    ? `共享仓库 · ${online ? `${online} 人在线` : "现在没有别人在线"}`
                    : "共享仓库 · 还没加入好"
                }
                className={cn(
                  "flex shrink-0 items-center gap-0.5 text-[12px] tabular-nums",
                  online ? "text-accent" : "text-faint",
                )}
              >
                <Users size={12} strokeWidth={2} />
                {online > 0 && online}
              </span>
            )}
            <ChevronsUpDown
              size={13}
              strokeWidth={1.9}
              className="shrink-0 text-faint transition-colors duration-[140ms] group-hover:text-muted"
            />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="top"
            align="start"
            sideOffset={6}
            onCloseAutoFocus={(event) => event.preventDefault()}
            className="odea-menu z-50 w-[276px] overflow-hidden rounded-lg bg-canvas p-1 shadow-float
                       outline-none ring-1 ring-line-strong"
          >
            {others && others.length > 0 && (
              <>
                <DropdownMenu.Label className="px-2 pt-1.5 pb-1 text-[12px] text-faint">
                  切换仓库
                </DropdownMenu.Label>
                {others.map((vault) => (
                  <DropdownMenu.Item
                    key={vault.path}
                    disabled={vault.missing}
                    onSelect={() => void launcherApi.open(vault.path).catch(fail)}
                    title={vault.path}
                    className={cn(ITEM, "data-[disabled]:opacity-50")}
                  >
                    <span
                      aria-hidden="true"
                      className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] bg-raised
                                 text-[11px] font-semibold text-muted"
                    >
                      {[...vault.name][0]?.toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{vault.name}</span>
                    {(vault.open || vault.missing) && (
                      <span className="shrink-0 text-[12px] text-faint">
                        {vault.missing ? "找不到" : "已打开"}
                      </span>
                    )}
                  </DropdownMenu.Item>
                ))}
              </>
            )}
            <MenuItem
              icon={FolderSearch}
              label="打开别的仓库…"
              onSelect={() => void backend().then((api) => api.showLauncher().catch(fail))}
            />
            <DropdownMenu.Separator className="mx-1 my-1 h-px bg-line" />
            <MenuItem
              icon={journal ? CalendarOff : CalendarCheck}
              label={journal ? "关闭日程" : "启用日程"}
              hint={journal ? "日记、目标的文件都留着" : "今日TODO、目标、日历、归档"}
              onSelect={() => void setJournal(!journal)}
            />
            {logical ? (
              <MenuItem
                icon={FolderOutput}
                label="导出成真实文件夹…"
                hint="按树的结构拷一份，原来的不动"
                onSelect={() => void exportTree()}
              />
            ) : (
              <MenuItem
                icon={FolderTree}
                label="转成逻辑目录…"
                hint="树自己摆、手动排序，文件不动"
                onSelect={() => void makeLogical()}
              />
            )}
            <MenuItem
              icon={Users}
              label={share ? "共享仓库…" : "共享这个仓库…"}
              hint={share ? "成员、邀请链接、谁在线" : "和别人、和自己的别的设备一直同步"}
              onSelect={() => useShare.getState().openDialog()}
            />
            <MenuItem
              icon={FolderPlus}
              label="加入共享仓库…"
              onSelect={() => useShare.getState().openJoin()}
            />
            {isTauri && (
              <MenuItem
                icon={FolderOpen}
                label="在文件夹中显示"
                onSelect={() => void openVaultFolder()}
              />
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

const ITEM =
  "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-[6px] text-[13px] text-body outline-none " +
  "transition-colors duration-[110ms] data-[highlighted]:bg-raised data-[highlighted]:text-ink";

function MenuItem({
  icon: Icon,
  label,
  hint,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  /** 第二行灰字：这一项会动到什么 */
  hint?: string;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item onSelect={onSelect} className={cn(ITEM, hint && "items-start")}>
      <Icon size={13} strokeWidth={1.9} className={cn("shrink-0", hint && "mt-[3px]")} />
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {hint && <span className="block text-[12px] text-faint">{hint}</span>}
      </span>
    </DropdownMenu.Item>
  );
}
