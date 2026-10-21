import { create } from "zustand";
import { backend } from "./backend";
import { messageOf, useData } from "./store";
import type { TeamInfo } from "./types";

/* ============================================================
   团队仓库的成员（docs/协同编辑.md §22.3）：仓库菜单 / 命令面板「邀请成员… / 团队成员…」打开。

   - 邀请：填对方在 GitHub 上的用户名 → 后端在 GitHub 上拉他当协作者（他会收到一封邀请）、
     把这个仓库标成团队仓库 → 给一个 odea://vault/ 链接，复制发给他。他点开，在启动器里拉一份
   - 成员：仓库里设备名单上的人（按账号合起来），对上 GitHub 那边谁有权限、谁还没接受邀请
   - 移出：GitHub 上去掉他的权限（没接受的邀请撤回），名单里他的设备也去掉
   ============================================================ */

export interface InvitedLink {
  login: string;
  link: string;
  /** 他本来就有权限，不用等他接受邀请 */
  already: boolean;
}

interface TeamState {
  open: boolean;
  info: TeamInfo | null;
  /** 正在取成员（要问 GitHub，一两秒） */
  loading: boolean;
  /** 正在邀请 / 移出 */
  busy: boolean;
  error: string | null;
  /** 刚邀请完的那位：给他的链接 */
  invited: InvitedLink | null;
  openDialog: () => void;
  close: () => void;
  refresh: () => Promise<void>;
  invite: (login: string) => Promise<boolean>;
  remove: (login: string) => Promise<void>;
}

/** 复制给对方的那段话：链接 + 怎么用 + 还没装的去哪下 */
export function inviteText(link: string): string {
  return `${link}\n用 Odea 打开这个链接，拉一份我们的团队仓库（先在 GitHub 上接受邀请，Odea 里也能接受）。还没装 Odea：https://github.com/Gred666/Odea/releases/latest`;
}

export const useTeam = create<TeamState>((set, get) => ({
  open: false,
  info: null,
  loading: false,
  busy: false,
  error: null,
  invited: null,

  openDialog: () => {
    set({ open: true, error: null, invited: null });
    void get().refresh();
  },
  close: () => set({ open: false }),

  refresh: async () => {
    set({ loading: true });
    try {
      const info = await (await backend()).teamInfo();
      set({ info, loading: false });
      useData.setState({ team: info.team });
    } catch (error) {
      set({ error: messageOf(error), loading: false });
    }
  },

  invite: async (raw) => {
    const login = raw.trim().replace(/^@/, "");
    if (!login || get().busy) return false;
    set({ busy: true, error: null, invited: null });
    try {
      const result = await (await backend()).teamInvite(login);
      set({ busy: false, invited: { login, link: result.link, already: result.already } });
      useData.setState({ team: true });
      void get().refresh();
      return true;
    } catch (error) {
      set({ busy: false, error: messageOf(error) });
      return false;
    }
  },

  remove: async (login) => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      await (await backend()).teamRemove(login);
      set({ busy: false });
      await get().refresh();
    } catch (error) {
      set({ busy: false, error: messageOf(error) });
    }
  },
}));
