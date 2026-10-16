import { afterEach, describe, expect, it, vi } from "vitest";
import { assetOf, githubDownloads, plainLatest, resolveNames } from "./github-latest.mjs";

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

describe("latest.json 换成 GitHub 的普通下载地址", () => {
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

  it("问 GitHub 失败就报错，不悄悄留着接口地址", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403 })),
    );
    await expect(resolveNames(LATEST)).rejects.toThrow("403");
  });

  it("每个平台都换成普通下载地址（一个接口地址都不剩），签名和别的字段不动", () => {
    const names = new Map(Object.entries(ASSET_NAMES).map(([id, name]) => [`${API}${id}`, name]));
    const base = githubDownloads("Gred666/OnTheWay", "v0.1.0");
    const out = plainLatest(LATEST, names, base);
    expect(out.platforms["windows-x86_64"]).toEqual({
      signature: "sig-win",
      url: "https://github.com/Gred666/OnTheWay/releases/download/v0.1.0/OnTheWay_0.1.0_x64-setup.exe",
    });
    expect(out.platforms["windows-x86_64-nsis"].url).toBe(out.platforms["windows-x86_64"].url);
    expect(Object.values(out.platforms).every((p) => p.url.startsWith(base))).toBe(true);
    expect(out.notes).toBe("- 第一版");
    // 原来那份没被改
    expect(LATEST.platforms["windows-x86_64"].url).toMatch("api.github.com");
  });
});
