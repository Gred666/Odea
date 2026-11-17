// @vitest-environment happy-dom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = {
  syncAccounts: vi.fn(),
  syncLoginCancel: vi.fn(),
  syncGithubLoginStart: vi.fn(),
  syncGithubLoginWait: vi.fn(),
  syncRepos: vi.fn(),
  syncInspect: vi.fn(),
  syncEnable: vi.fn(),
  syncProxy: vi.fn(),
  syncNow: vi.fn(),
};

vi.mock("@/data/backend", () => ({ backend: async () => api }));

const { useApp } = await import("@/app/store");
const { useData } = await import("@/data/store");
const { registerEditorFlush } = await import("@/editor/saveBus");
const { SyncDialog } = await import("./SyncDialog");

let container: HTMLDivElement;
let root: Root;
const order: string[] = [];

beforeEach(() => {
  order.length = 0;
  for (const fn of Object.values(api)) fn.mockReset();
  api.syncLoginCancel.mockResolvedValue(undefined);
  api.syncProxy.mockResolvedValue({ configured: null, effective: null });
  api.syncAccounts.mockResolvedValue([]);
  useData.setState({
    syncStatus: {
      state: "off",
      remote: null,
      lastSyncedAt: null,
      unpushed: 0,
      message: null,
      oversized: [],
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useApp.getState().setSyncOpen(false));
});

const settle = async (ms = 20) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

const openDialog = async () => {
  act(() => useApp.getState().setSyncOpen(true));
  act(() => root.render(<SyncDialog />));
  await settle();
};

const CODE = {
  userCode: "ABCD-1234",
  verificationUri: "https://github.com/login/device",
  expiresIn: 900,
};

describe("开启同步", () => {
  it("下载并切换之前先存编辑器（换过去要整页重载）", async () => {
    api.syncAccounts.mockResolvedValue([{ provider: "github", login: "you" }]);
    api.syncRepos.mockResolvedValue([
      {
        fullName: "you/notes",
        cloneUrl: "https://github.com/you/notes.git",
        private: true,
        updatedAt: null,
        owner: "you",
      },
    ]);
    api.syncInspect.mockResolvedValue({
      connectHere: false,
      cloneTarget: "D:/x",
      localNotes: false,
    });
    api.syncEnable.mockImplementation(async () => {
      order.push("enable");
      return false;
    });
    const off = registerEditorFlush(async () => {
      order.push("flush");
    });
    await openDialog();
    act(() => button("GitHub")?.click());
    await settle();
    act(() => button("you/notes")?.click());
    await settle();
    act(() => button("下载并切换")?.click());
    await settle();
    off();
    expect(order).toEqual(["flush", "enable"]);
  });
});

describe("GitHub 登录", () => {
  it("等确认时出错：回到选托管方、说原因，不停在「等你确认」", async () => {
    api.syncGithubLoginStart.mockResolvedValue(CODE);
    api.syncGithubLoginWait.mockRejectedValue(new Error("验证码过期了"));
    await openDialog();
    act(() => button("GitHub")?.click());
    await settle();
    expect(container.textContent).not.toContain("等你在浏览器里确认");
    expect(container.textContent).not.toContain(CODE.userCode);
    expect(container.querySelector("[role=alert]")?.textContent).toBe("验证码过期了");
    expect(button("Gitee")?.disabled).toBe(false);
  });

  it("领码时关了对话框：码回来就收回，不去等", async () => {
    let give: (code: typeof CODE) => void = () => {};
    api.syncGithubLoginStart.mockReturnValue(
      new Promise((resolve) => {
        give = resolve;
      }),
    );
    await openDialog();
    act(() => button("GitHub")?.click());
    await settle();
    act(() => useApp.getState().setSyncOpen(false));
    await settle(400);
    api.syncLoginCancel.mockClear();
    give(CODE);
    await settle();
    expect(api.syncGithubLoginWait).not.toHaveBeenCalled();
    expect(api.syncLoginCancel).toHaveBeenCalledTimes(1);
  });
});

describe("登录失效时重新登录", () => {
  const auth = () =>
    useData.setState({
      syncStatus: {
        state: "auth",
        remote: "github.com/you/notes",
        lastSyncedAt: null,
        unpushed: 0,
        message: null,
        oversized: [],
      },
    });

  it("领码时说一声、按钮不能连点；等确认出错回到状态页", async () => {
    auth();
    let give: (code: typeof CODE) => void = () => {};
    api.syncGithubLoginStart.mockReturnValue(
      new Promise((resolve) => {
        give = resolve;
      }),
    );
    api.syncGithubLoginWait.mockRejectedValue(new Error("你在 GitHub 上拒绝了授权"));
    await openDialog();
    act(() => button("重新登录")?.click());
    await settle();
    expect(container.textContent).toContain("正在向 GitHub 要验证码…");
    expect(button("重新登录")?.disabled).toBe(true);
    give(CODE);
    await settle();
    expect(api.syncGithubLoginStart).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("等你在浏览器里确认");
    expect(button("重新登录")?.disabled).toBe(false);
    expect(container.querySelector("[role=alert]")?.textContent).toBe("你在 GitHub 上拒绝了授权");
  });

  it("Gitee 的重新登录能取消", async () => {
    useData.setState({
      syncStatus: {
        state: "auth",
        remote: "gitee.com/you/notes",
        lastSyncedAt: null,
        unpushed: 0,
        message: null,
        oversized: [],
      },
    });
    await openDialog();
    act(() => button("重新登录")?.click());
    expect(container.querySelector("input[type=password]")).not.toBeNull();
    act(() => button("取消")?.click());
    expect(container.querySelector("input[type=password]")).toBeNull();
    expect(button("重新登录")).toBeDefined();
  });
});
