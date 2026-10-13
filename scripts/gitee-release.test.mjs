import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ATTACHMENT,
  assetOf,
  githubDownloads,
  mirrorLatest,
  pickUploads,
  planAttachment,
  releasesToPrune,
  resolveNames,
} from "./gitee-release.mjs";

// 0.1.0 发版时 tauri-action v1 实际写出来的样子：下载地址是接口地址，路径里没有文件名
const API = "https://api.github.com/repos/Gred666/OnTheWay/releases/assets/";
const LATEST = {
  version: "0.1.0",
  notes: "- 第一版",
  pub_date: "2026-10-13T11:40:00Z",
  platforms: {
    "windows-x86_64": { signature: "sig-win", url: `${API}636831012` },
    "windows-x86_64-nsis": { signature: "sig-win", url: `${API}636831012` },
    "darwin-aarch64": { signature: "sig-arm", url: `${API}636833178` },
    "darwin-x86_64": { signature: "sig-x64", url: `${API}636830830` },
    "linux-x86_64": { signature: "sig-linux", url: `${API}636830399` },
    "linux-x86_64-deb": { signature: "sig-deb", url: `${API}636830273` },
  },
};
const ASSET_NAMES = {
  636831012: "OnTheWay_0.1.0_x64-setup.exe",
  636833178: "OnTheWay_0.1.0_aarch64.app.tar.gz",
  636830830: "OnTheWay_0.1.0_x64.app.tar.gz",
  636830399: "OnTheWay_0.1.0_amd64.AppImage",
  636830273: "OnTheWay_0.1.0_amd64.deb",
};

afterEach(() => vi.unstubAllGlobals());

describe("镜像到 Gitee", () => {
  it("认得出两种下载地址：接口地址要去问 GitHub，下载地址直接取文件名", () => {
    expect(assetOf(`${API}636831012`)).toEqual({ assetId: "636831012" });
    expect(
      assetOf("https://github.com/Gred666/OnTheWay/releases/download/v0.1.0/OnTheWay_0.1.0_x64-setup.exe"),
    ).toEqual({ name: "OnTheWay_0.1.0_x64-setup.exe" });
  });

  it("接口地址问 GitHub 拿到文件名，同一个地址只问一次", async () => {
    const fetch = vi.fn(async (url) => ({
      ok: true,
      json: async () => ({ name: ASSET_NAMES[String(url).split("/").pop()] }),
    }));
    vi.stubGlobal("fetch", fetch);
    const names = await resolveNames(LATEST);
    expect(names.get(`${API}636831012`)).toBe("OnTheWay_0.1.0_x64-setup.exe");
    expect(names.get(`${API}636833178`)).toBe("OnTheWay_0.1.0_aarch64.app.tar.gz");
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("只传 latest.json 指着的更新包：dmg、签名不传，AppImage / deb 只放 GitHub，超过 100 MB 的跳过", () => {
    const { upload, skipped } = pickUploads(
      [
        { name: "OnTheWay_0.1.0_x64-setup.exe", size: 8e6 },
        { name: "OnTheWay_0.1.0_x64-setup.exe.sig", size: 420 },
        { name: "OnTheWay_0.1.0_aarch64.app.tar.gz", size: 11e6 },
        { name: "OnTheWay_0.1.0_aarch64.dmg", size: 11e6 },
        { name: "OnTheWay_0.1.0_x64.app.tar.gz", size: MAX_ATTACHMENT + 1 },
        { name: "OnTheWay_0.1.0_amd64.AppImage", size: 90e6 },
        { name: "OnTheWay_0.1.0_amd64.deb", size: 10e6 },
        { name: "latest.json", size: 2000 },
      ],
      new Set(Object.values(ASSET_NAMES)),
    );
    expect(upload.map((file) => file.name)).toEqual([
      "OnTheWay_0.1.0_x64-setup.exe",
      "OnTheWay_0.1.0_aarch64.app.tar.gz",
    ]);
    expect(skipped.map((file) => file.name)).toEqual([
      "OnTheWay_0.1.0_x64.app.tar.gz",
      "OnTheWay_0.1.0_amd64.AppImage",
      "OnTheWay_0.1.0_amd64.deb",
    ]);
  });

  it("传到 Gitee 的换成 Gitee 地址，其余的换成 GitHub 的普通下载地址（接口地址限流），签名和别的字段不动", () => {
    const names = new Map(Object.entries(ASSET_NAMES).map(([id, name]) => [`${API}${id}`, name]));
    const gitee = "https://gitee.com/hyxzs111111/on-the-way/releases/download/v0.1.0/OnTheWay_0.1.0_x64-setup.exe";
    const base = githubDownloads("Gred666/OnTheWay", "v0.1.0");
    const out = mirrorLatest(LATEST, names, { "OnTheWay_0.1.0_x64-setup.exe": gitee }, base);
    expect(out.platforms["windows-x86_64"]).toEqual({ signature: "sig-win", url: gitee });
    expect(out.platforms["windows-x86_64-nsis"].url).toBe(gitee);
    expect(out.platforms["linux-x86_64"]).toEqual({
      signature: "sig-linux",
      url: "https://github.com/Gred666/OnTheWay/releases/download/v0.1.0/OnTheWay_0.1.0_amd64.AppImage",
    });
    expect(out.notes).toBe("- 第一版");
    // 只换 GitHub 的（发布前给 GitHub 自己那份用）：一个接口地址都不剩
    const githubOnly = mirrorLatest(LATEST, names, {}, base);
    expect(Object.values(githubOnly.platforms).every((p) => p.url.startsWith(base))).toBe(true);
    // 原来那份没被改
    expect(LATEST.platforms["windows-x86_64"].url).toMatch("api.github.com");
  });

  it("重跑是接着传：同名同大小的不再传，大小不对的先删再传，latest.json 每次都换", () => {
    const existing = [
      { id: 1, name: "a.exe", size: 100 },
      { id: 2, name: "b.dmg", size: 50 },
      { id: 3, name: "latest.json", size: 900 },
    ];
    expect(planAttachment(existing, { name: "a.exe", size: 100 })).toEqual({ skip: true, remove: [] });
    expect(planAttachment(existing, { name: "b.dmg", size: 60 })).toEqual({ skip: false, remove: [2] });
    expect(planAttachment(existing, { name: "c.deb", size: 10 })).toEqual({ skip: false, remove: [] });
    expect(planAttachment(existing, { name: "latest.json", size: 900 }, { force: true })).toEqual({
      skip: false,
      remove: [3],
    });
  });

  it("只留最近两版和 updater", () => {
    const releases = [
      { id: 1, tag_name: "v0.1.0", created_at: "2026-10-13T08:00:00+08:00" },
      { id: 2, tag_name: "updater", created_at: "2026-10-13T08:01:00+08:00" },
      { id: 3, tag_name: "v0.2.0", created_at: "2026-11-01T08:00:00+08:00" },
      { id: 4, tag_name: "v0.3.0", created_at: "2026-12-01T08:00:00+08:00" },
    ];
    expect(releasesToPrune(releases).map((release) => release.tag_name)).toEqual(["v0.1.0"]);
    expect(releasesToPrune(releases.slice(0, 3))).toEqual([]);
  });
});
