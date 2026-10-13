import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENT,
  mirrorLatest,
  pickUploads,
  planAttachment,
  releasesToPrune,
} from "./gitee-release.mjs";

describe("镜像到 Gitee", () => {
  it("只传 latest.json 指着的更新包：dmg、签名不传，AppImage / deb 只放 GitHub，超过 100 MB 的跳过", () => {
    const github = "https://github.com/Gred666/OnTheWay/releases/download/v0.1.0/";
    const latest = {
      platforms: {
        "windows-x86_64": { signature: "s", url: `${github}OnTheWay_0.1.0_x64-setup.exe` },
        "darwin-aarch64": { signature: "s", url: `${github}OnTheWay_0.1.0_aarch64.app.tar.gz` },
        "darwin-x86_64": { signature: "s", url: `${github}OnTheWay_0.1.0_x64.app.tar.gz` },
        "linux-x86_64": { signature: "s", url: `${github}OnTheWay_0.1.0_amd64.AppImage` },
        "linux-x86_64-deb": { signature: "s", url: `${github}OnTheWay_0.1.0_amd64.deb` },
      },
    };
    const { upload, skipped } = pickUploads(
      [
        { name: "OnTheWay_0.1.0_x64-setup.exe", size: 8e6 },
        { name: "OnTheWay_0.1.0_x64-setup.exe.sig", size: 420 },
        { name: "OnTheWay_0.1.0_aarch64.app.tar.gz", size: 11e6 },
        { name: "OnTheWay_0.1.0_aarch64.dmg", size: 11e6 },
        { name: "OnTheWay_0.1.0_x64.app.tar.gz", size: MAX_ATTACHMENT + 1 },
        { name: "OnTheWay_0.1.0_amd64.AppImage", size: 86e6 },
        { name: "OnTheWay_0.1.0_amd64.deb", size: 10e6 },
        { name: "latest.json", size: 2000 },
      ],
      latest,
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

  it("latest.json 只换传上去了的那些地址，签名和别的字段不动", () => {
    const latest = {
      version: "0.1.0",
      notes: "- 第一版",
      pub_date: "2026-10-13T08:00:00Z",
      platforms: {
        "windows-x86_64": {
          signature: "sig-win",
          url: "https://github.com/Gred666/OnTheWay/releases/download/v0.1.0/OnTheWay_0.1.0_x64-setup.exe",
        },
        "linux-x86_64": {
          signature: "sig-linux",
          url: "https://github.com/Gred666/OnTheWay/releases/download/v0.1.0/OnTheWay_0.1.0_amd64.AppImage",
        },
      },
    };
    const gitee = "https://gitee.com/hyxzs111111/on-the-way/releases/download/v0.1.0/OnTheWay_0.1.0_x64-setup.exe";
    const out = mirrorLatest(latest, { "OnTheWay_0.1.0_x64-setup.exe": gitee });
    expect(out.platforms["windows-x86_64"]).toEqual({ signature: "sig-win", url: gitee });
    expect(out.platforms["linux-x86_64"].url).toBe(latest.platforms["linux-x86_64"].url);
    expect(out.notes).toBe("- 第一版");
    // 原来那份没被改
    expect(latest.platforms["windows-x86_64"].url).toMatch("github.com");
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
