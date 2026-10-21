import { useApp } from "@/app/store";
import { backend } from "@/data/backend";
import { messageOf, useData } from "@/data/store";
import type { JournalPage, JournalVault } from "@/data/types";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, NotebookPen, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/* ============================================================
   日程切换器（docs/协同编辑.md §22.6）：今日TODO、目标、日历那一行日期后面。

   团队仓库的日程是团队的，个人的日程在个人仓库。这台电脑上开着日程的仓库有两个以上时出现：
   点另一个，那个仓库的窗口提到前面（没开着就打开）、摆在这个窗口的位置和大小上、停在同一页同一天 ——
   一个窗口一个仓库（仓库与启动器.md §4），看着像同一个窗口里换了内容。
   命令面板「切换日程…」、Ctrl+Alt+J 轮着切到下一个（journalSwitchNext）。
   ============================================================ */

const PAGES: JournalPage[] = ["today", "goal", "calendar"];

/** 现在停在日程的哪一页（不在日程里是 null） */
export function journalPageOf(workspace: string): JournalPage | null {
  return (PAGES as string[]).includes(workspace) ? (workspace as JournalPage) : null;
}

/** 跳到 vault 的日程：同一页、同一天 */
async function switchTo(vault: JournalVault) {
  const { workspace, selectedDate, todayDate } = useApp.getState();
  const page = journalPageOf(workspace) ?? "today";
  try {
    await (await backend()).journalSwitch(
      vault.path,
      page,
      page === "calendar" ? selectedDate : todayDate,
    );
  } catch (error) {
    useData.setState({ error: messageOf(error) });
  }
}

/** 轮到下一个开着日程的仓库（命令面板、Ctrl+Alt+J）。只有这一个就说一声 */
export async function journalSwitchNext(): Promise<void> {
  const vaults = await (await backend()).journalVaults();
  const at = vaults.findIndex((vault) => vault.current);
  const next = vaults[(at + 1) % Math.max(vaults.length, 1)];
  if (!next || next.current || vaults.length < 2) {
    useData.setState({
      error: "这台电脑上只有这一个仓库开着日程。别的仓库在仓库菜单里「启用日程」",
    });
    return;
  }
  await switchTo(next);
}

export function JournalSwitcher() {
  const [vaults, setVaults] = useState<JournalVault[]>([]);
  const refresh = useCallback(() => {
    void backend()
      .then((api) => api.journalVaults())
      .then(setVaults)
      .catch(() => setVaults([]));
  }, []);
  useEffect(() => {
    refresh();
    // 别的窗口开了日程、新加了仓库：回到这个窗口时重取
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const current = vaults.find((vault) => vault.current);
  if (vaults.length < 2 || !current) return null;

  return (
    <DropdownMenu.Root modal={false} onOpenChange={(open) => open && refresh()}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-journal-switcher
          title="切换到别的仓库的日程（Ctrl+Alt+J）"
          className="-my-0.5 flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium
                     text-muted outline-none transition-colors duration-[140ms] hover:bg-raised/70 hover:text-ink
                     focus-visible:ring-2 focus-visible:ring-accent/50 data-[state=open]:bg-raised/70"
        >
          {current.team ? (
            <Users size={12} strokeWidth={2} className="shrink-0" />
          ) : (
            <NotebookPen size={12} strokeWidth={2} className="shrink-0" />
          )}
          <span className="max-w-[160px] truncate">{current.name}</span>
          <ChevronDown size={12} strokeWidth={2} className="shrink-0 text-faint" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="odea-menu z-50 min-w-[220px] overflow-hidden rounded-lg bg-canvas p-1 shadow-float
                     outline-none ring-1 ring-line-strong"
        >
          <p className="px-2 pt-1 pb-1.5 text-[11.5px] text-faint">谁的日程</p>
          {vaults.map((vault) => (
            <DropdownMenu.Item
              key={vault.path}
              data-journal-vault
              onSelect={() => {
                if (!vault.current) void switchTo(vault);
              }}
              className="flex cursor-default select-none items-center gap-2 rounded-md px-2 py-[6px] text-[13px]
                         text-body outline-none transition-colors duration-[110ms]
                         data-[highlighted]:bg-raised data-[highlighted]:text-ink"
            >
              {vault.team ? (
                <Users size={13} strokeWidth={1.9} className="shrink-0 text-muted" />
              ) : (
                <NotebookPen size={13} strokeWidth={1.9} className="shrink-0 text-muted" />
              )}
              <span className="min-w-0 flex-1 truncate">{vault.name}</span>
              <span className="text-[11.5px] text-faint">{vault.team ? "团队" : "个人"}</span>
              <Check
                size={13}
                strokeWidth={2.2}
                className={vault.current ? "shrink-0 text-accent" : "shrink-0 opacity-0"}
              />
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
