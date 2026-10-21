// @vitest-environment happy-dom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClonePanel } from "./ClonePanel";
import { launcherApi } from "./api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 启动器「从同步仓库拉一份」接团队仓库（docs/协同编辑.md §22.3）：点别人发来的 odea://vault/ 链接打开时，
 * 登录过就直接到仓库列表，邀请标出来，接受了就到「放在哪」；别人的仓库标「团队」。接浏览器预览的假接口
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const settle = async (ms = 300) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

/** 等到 ready() 为真（最多两秒）：假接口每次要等 120ms */
const until = async (ready: () => boolean) => {
  for (let i = 0; i < 40 && !ready(); i++) await settle(50);
};

describe("从同步仓库拉一份：团队仓库", () => {
  it("没登录时先说要拉的是哪个仓库", async () => {
    vi.spyOn(launcherApi, "accounts").mockResolvedValue([]);
    act(() =>
      root.render(
        <ClonePanel
          target={{ provider: "github", fullName: "xiaowang/team-notes" }}
          busy={false}
          onBack={() => {}}
          onClone={() => {}}
        />,
      ),
    );
    await settle();
    expect(container.querySelector("[data-clone-target]")?.textContent).toContain(
      "xiaowang/team-notes",
    );
  });

  it("登录过：直接到列表，邀请标出来，接受以后到「放在哪」", async () => {
    vi.spyOn(launcherApi, "accounts").mockResolvedValue([{ provider: "github", login: "you" }]);
    const accept = vi.spyOn(launcherApi, "acceptInvitation");
    act(() =>
      root.render(
        <ClonePanel
          target={{ provider: "github", fullName: "xiaowang/team-notes" }}
          busy={false}
          onBack={() => {}}
          onClone={() => {}}
        />,
      ),
    );
    await settle();
    await until(() => !!container.querySelector("[data-clone-invitation]"));
    const invitation = container.querySelector("[data-clone-invitation]");
    expect(invitation?.textContent).toContain("xiaowang 邀请你加入");
    // 链接指着的就是它：高亮
    expect(invitation?.className).toContain("bg-accent-wash");
    const button = [...(invitation?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "接受",
    );
    act(() => button?.click());
    await until(() => !container.querySelector("[data-clone-invitation]"));
    expect(accept).toHaveBeenCalledWith("github", "7");
    // 到了「放在哪」：名字默认是仓库名
    expect(container.textContent).toContain("team-notes");
    expect(container.querySelector("[data-clone-invitation]")).toBeNull();
  });

  it("别人的仓库标「团队」，自己的不标", async () => {
    vi.spyOn(launcherApi, "accounts").mockResolvedValue([{ provider: "github", login: "you" }]);
    vi.spyOn(launcherApi, "invitations").mockResolvedValue([]);
    vi.spyOn(launcherApi, "repos").mockResolvedValue([
      {
        fullName: "you/notes",
        cloneUrl: "https://github.com/you/notes.git",
        private: true,
        updatedAt: null,
        owner: "you",
      },
      {
        fullName: "lab/team",
        cloneUrl: "https://github.com/lab/team.git",
        private: true,
        updatedAt: null,
        owner: "lab",
      },
    ]);
    act(() =>
      root.render(
        <ClonePanel
          target={{ provider: "github", fullName: "nobody/missing" }}
          busy={false}
          onBack={() => {}}
          onClone={() => {}}
        />,
      ),
    );
    await settle();
    const rows = [...container.querySelectorAll("button")].filter((b) =>
      b.textContent?.includes("/"),
    );
    expect(rows.map((row) => row.textContent?.includes("团队"))).toEqual([false, true]);
    // 链接里的仓库这个账号看不到
    expect(container.textContent).toContain("这个账号还看不到 nobody/missing");
  });
});
