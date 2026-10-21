import {
  type SyncAccount,
  type SyncDeviceCode,
  type SyncRemoteRepo,
  type VaultEntry,
  commands,
} from "@/lib/bindings";
import { isTauri } from "@/lib/tauri";

/* ============================================================
   启动器（docs/仓库与启动器.md §3）要的后端。
   桌面端走 IPC；浏览器预览（`/?launcher`）里是一份假的列表，调界面用。
   ============================================================ */

export type { SyncAccount, SyncDeviceCode, SyncRemoteRepo, VaultEntry };

/** 同步的托管方（和仓库窗口里的同步对话框一样） */
export type Provider = "github" | "gitee";

export interface LauncherApi {
  /** 用过的仓库，最近打开的在前 */
  vaults(): Promise<VaultEntry[]>;
  /** 打开（已经开着就提到前面）。新窗口画出来以后启动器自己关掉 */
  open(path: string): Promise<void>;
  /** 系统的选择文件夹对话框，选了就打开。取消了返回 false */
  openFolder(): Promise<boolean>;
  /** 新建默认放在哪（「文档」） */
  defaultParent(): Promise<string>;
  /** 换个位置。取消了返回 null */
  pickParent(from: string): Promise<string | null>;
  /** 在 parent 下面建一个叫 name 的文件夹，放使用指南，打开 */
  create(parent: string, name: string): Promise<void>;
  /** 从列表里拿掉（不碰文件），返回剩下的 */
  forget(path: string): Promise<VaultEntry[]>;
  reveal(path: string): Promise<void>;
  /** 加入协同编辑：开一个不带仓库的访客窗口去加入 */
  join(link: string): Promise<void>;
  /* ---- 从同步仓库拉一份（技术方案 §5.9.7）：账号是全应用的，和仓库窗口里的同步对话框同一套 ---- */
  /** 登录过的同步账号 */
  accounts(): Promise<SyncAccount[]>;
  /** GitHub 设备码登录：领一个码 */
  githubLoginStart(): Promise<SyncDeviceCode>;
  /** 等用户在浏览器里确认 */
  githubLoginWait(): Promise<SyncAccount>;
  loginCancel(): Promise<void>;
  giteeLogin(token: string): Promise<SyncAccount>;
  /** 这个账号的仓库，最近更新的在前 */
  repos(provider: Provider): Promise<SyncRemoteRepo[]>;
  /** clone 到 parent 下面叫 name 的新文件夹，打开（同步跟着开着）。新窗口画出来以后启动器自己关掉 */
  clone(provider: Provider, cloneUrl: string, parent: string, name: string): Promise<void>;
}

/** 后端的错误（AppError）只要那句话 */
function unwrap<T>(result: { status: "ok"; data: T } | { status: "error"; error: unknown }): T {
  if (result.status === "ok") return result.data;
  const error = result.error as { message?: unknown } | string;
  const message =
    typeof error === "string"
      ? error
      : typeof error?.message === "string"
        ? error.message
        : "出错了";
  throw new Error(message);
}

const tauriApi: LauncherApi = {
  vaults: async () => unwrap(await commands.launcherVaults()),
  open: async (path) => {
    unwrap(await commands.launcherOpen(path));
  },
  openFolder: async () => unwrap(await commands.launcherOpenFolder()),
  defaultParent: async () => unwrap(await commands.launcherDefaultParent()),
  pickParent: async (from) => unwrap(await commands.launcherPickParent(from)),
  create: async (parent, name) => {
    unwrap(await commands.launcherCreate(parent, name));
  },
  forget: async (path) => unwrap(await commands.launcherForget(path)),
  reveal: async (path) => {
    unwrap(await commands.launcherReveal(path));
  },
  join: async (link) => {
    unwrap(await commands.launcherJoin(link));
  },
  accounts: async () => unwrap(await commands.syncAccounts()),
  githubLoginStart: async () => unwrap(await commands.syncGithubLoginStart()),
  githubLoginWait: async () => unwrap(await commands.syncGithubLoginWait()),
  loginCancel: async () => {
    unwrap(await commands.syncLoginCancel());
  },
  giteeLogin: async (token) => unwrap(await commands.syncGiteeLogin(token)),
  repos: async (provider) => unwrap(await commands.syncRepos(provider)),
  clone: async (provider, cloneUrl, parent, name) => {
    unwrap(await commands.launcherClone(provider, cloneUrl, parent, name));
  },
};

/* ---------------- 浏览器预览 ---------------- */

const DAY = 24 * 3600 * 1000;
let mockVaults: VaultEntry[] = [
  {
    path: "C:\\Users\\你\\Documents\\Odea",
    name: "Odea",
    lastOpened: Date.now() - DAY / 2,
    open: true,
    missing: false,
    logical: true,
  },
  {
    path: "D:\\forGPT",
    name: "forGPT",
    lastOpened: Date.now() - 3 * DAY,
    open: false,
    missing: false,
    logical: false,
  },
  {
    path: "E:\\移动硬盘\\论文",
    name: "论文",
    lastOpened: Date.now() - 20 * DAY,
    open: false,
    missing: true,
    logical: false,
  },
];

const wait = () => new Promise((resolve) => setTimeout(resolve, 120));

const mockApi: LauncherApi = {
  vaults: async () => {
    await wait();
    return mockVaults;
  },
  open: async (path) => {
    await wait();
    if (mockVaults.find((vault) => vault.path === path)?.missing)
      throw new Error(`找不到这个文件夹了：${path}`);
    throw new Error("浏览器预览里打不开仓库，要在桌面端里试");
  },
  openFolder: async () => {
    await wait();
    return false;
  },
  defaultParent: async () => "C:\\Users\\你\\Documents",
  pickParent: async () => null,
  create: async (parent, name) => {
    await wait();
    if (mockVaults.some((vault) => vault.name === name))
      throw new Error(
        `「${parent}\\${name}」已经有了，里面还有东西。换个名字，或者用「打开文件夹」打开它`,
      );
    throw new Error("浏览器预览里建不了仓库，要在桌面端里试");
  },
  forget: async (path) => {
    await wait();
    mockVaults = mockVaults.filter((vault) => vault.path !== path);
    return mockVaults;
  },
  reveal: async () => {},
  join: async (link) => {
    await wait();
    if (!link.trim().startsWith("odea://join"))
      throw new Error("这不是 Odea 的邀请链接（应该以 odea://join/ 开头）");
    throw new Error("浏览器预览里加入不了协作，要在桌面端里试");
  },
  // 预览里：GitHub 没登录过，「登录」两秒后当成确认了；仓库是假的，拉不下来
  accounts: async () => {
    await wait();
    return mockAccounts;
  },
  githubLoginStart: async () => {
    await wait();
    return {
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
    };
  },
  githubLoginWait: async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const account = { provider: "github", login: "you" };
    mockAccounts = [...mockAccounts, account];
    return account;
  },
  loginCancel: async () => {},
  giteeLogin: async () => {
    await wait();
    throw new Error("浏览器预览里登录不了 Gitee，要在桌面端里试");
  },
  repos: async () => {
    await wait();
    return [
      {
        fullName: "you/odea-notes",
        cloneUrl: "https://github.com/you/odea-notes.git",
        private: true,
        updatedAt: null,
      },
      {
        fullName: "you/blog",
        cloneUrl: "https://github.com/you/blog.git",
        private: false,
        updatedAt: null,
      },
    ];
  },
  clone: async () => {
    await wait();
    throw new Error("浏览器预览里拉不了仓库，要在桌面端里试");
  },
};

let mockAccounts: SyncAccount[] = [];

export const launcherApi: LauncherApi = isTauri ? tauriApi : mockApi;
