// @vitest-environment happy-dom

import { linkKind } from "@/collab/store";
import { parseVaultLink } from "@/launcher/api";
import { beforeEach, describe, expect, it } from "vitest";
import { useData } from "./store";
import { inviteText, useTeam } from "./team";

/* 团队仓库的成员（docs/协同编辑.md §22.3），接浏览器预览的 mock 后端 */

describe("团队成员", () => {
  beforeEach(() => {
    localStorage.clear();
    useTeam.setState({ open: false, info: null, busy: false, error: null, invited: null });
    useData.setState({ team: false });
  });

  it("邀请过人就成了团队仓库，给一个发给他的链接；撤回以后他不在了", async () => {
    useTeam.getState().openDialog();
    await useTeam.getState().refresh();
    expect(useTeam.getState().info?.team).toBe(false);
    expect(useTeam.getState().info?.people.map((p) => p.login)).toEqual(["you"]);

    expect(await useTeam.getState().invite(" @xiaowang ")).toBe(true);
    const invited = useTeam.getState().invited;
    expect(invited).toEqual({
      login: "xiaowang",
      link: "odea://vault/github/you/odea-notes",
      already: false,
    });
    expect(useData.getState().team).toBe(true);
    await useTeam.getState().refresh();
    const people = useTeam.getState().info?.people ?? [];
    expect(people.map((p) => [p.login, p.access])).toEqual([
      ["you", "member"],
      ["xiaowang", "invited"],
    ]);
    // 复制出去的那段话：链接在第一行，后面是怎么用
    expect(inviteText(invited!.link).split("\n")[0]).toBe("odea://vault/github/you/odea-notes");

    await useTeam.getState().remove("xiaowang");
    expect(useTeam.getState().info?.people.map((p) => p.login)).toEqual(["you"]);
  });

  it("自己的账号、空的用户名邀请不了", async () => {
    expect(await useTeam.getState().invite("you")).toBe(false);
    expect(useTeam.getState().error).toContain("你自己的账号");
    expect(await useTeam.getState().invite("  ")).toBe(false);
  });
});

describe("团队仓库的链接", () => {
  it("认得出托管方和仓库，别的链接不认", () => {
    expect(parseVaultLink("odea://vault/github/xiaowang/team-notes")).toEqual({
      provider: "github",
      fullName: "xiaowang/team-notes",
    });
    expect(parseVaultLink(" <ODEA://vault/Gitee/a.b/c_d.git/> ")).toEqual({
      provider: "gitee",
      fullName: "a.b/c_d",
    });
    expect(parseVaultLink("odea://vault/gitlab/a/b")).toBeNull();
    expect(parseVaultLink("odea://vault/github/a/b/c")).toBeNull();
    expect(parseVaultLink("odea://join/abc")).toBeNull();
    expect(linkKind("odea://vault/github/a/b")).toBe("vault");
  });
});
