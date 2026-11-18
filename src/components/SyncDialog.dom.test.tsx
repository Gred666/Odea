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
  syncSetProxy: vi.fn(),
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

describe("同步对话框里小的几处（审查 2026-11-13 §5.9）", () => {
  it("看云端的时候点了「换个托管方」：结果回来不再把人拽到确认那一步", async () => {
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
    let inspected: (plan: unknown) => void = () => {};
    api.syncInspect.mockImplementation(
      () =>
        new Promise((resolve) => {
          inspected = resolve;
        }),
    );
    await openDialog();
    act(() => button("GitHub")?.click());
    await settle();
    act(() => button("you/notes")?.click());
    await settle();
    act(() => button("换个托管方")?.click());
    await settle();
    // 回去以后又进了仓库列表：旧的那次看完了也不算数
    act(() => button("GitHub")?.click());
    await settle();
    expect(button("you/notes")).toBeDefined();
    inspected({ connectHere: false, cloneTarget: "D:/x", localNotes: false });
    await settle();
    expect(button("下载并切换")).toBeUndefined();
    expect(button("you/notes")).toBeDefined();
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("代理保存失败：框留着、说原因", async () => {
    api.syncSetProxy.mockRejectedValue(new Error("写不进 config.json"));
    await openDialog();
    act(() => button("改")?.click());
    await settle();
    const field = container.querySelector<HTMLInputElement>(
      'input[placeholder^="http://127.0.0.1"]',
    )!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(field, "http://127.0.0.1:7890");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => button("保存")?.click());
    await settle();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("写不进 config.json");
    expect(container.querySelector('input[placeholder^="http://127.0.0.1"]')).not.toBeNull();
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
