// 发版以后核对两边：node scripts/verify-release.mjs 0.1.0
//
// 只用公开地址、不带令牌 —— 用户的应用看到的就是这些：
// - GitHub Release 正式发布了（不是草稿）
// - 两个 latest.json（应用依次查的地址，tauri.conf.json 的 endpoints）都是这一版，签名一样
// - Gitee 那份里，传到 Gitee 的更新包（Windows、Mac）地址指向 gitee.com —— 0.1.0 第一次就是这里全指着 GitHub、
//   Gitee 上一个文件都没有，旧的核对脚本没看出来
// - 每个下载地址都像应用那样下得动（Accept: application/octet-stream），下来的是文件、不是网页或 JSON
import { readFileSync } from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
if (!version) {
  console.error("用法：node scripts/verify-release.mjs <版本号>");
  process.exit(1);
}
const tag = `v${version}`;
const GITHUB = "Gred666/OnTheWay";
const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const endpoints = config.plugins.updater.endpoints;
/** 只放 GitHub 的（和 scripts/gitee-release.mjs 一致）：Gitee 那份里它们照旧指向 GitHub */
const GITHUB_ONLY = /^linux-/;

let failures = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${what}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
};

/** 像 tauri-plugin-updater 那样下：只读第一块，看是不是文件 */
async function downloadable(url) {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/octet-stream", "User-Agent": "tauri-plugin-updater/2.12.0" },
      redirect: "follow",
    });
    const reader = response.body.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const first = String.fromCharCode(value?.[0] ?? 0);
    return { ok: response.ok && first !== "<" && first !== "{", host: new URL(response.url).hostname };
  } catch (error) {
    return { ok: false, host: error.message };
  }
}

const release = await (
  await fetch(`https://api.github.com/repos/${GITHUB}/releases/tags/${tag}`, {
    headers: { "User-Agent": "ontheway-release" },
  })
).json();
check(release.tag_name === tag && !release.draft && !release.prerelease, `GitHub Release ${tag} 正式发布了`, release.html_url ?? "");

const feeds = [];
for (const url of endpoints) {
  const host = new URL(url).hostname;
  try {
    const feed = await (await fetch(url, { headers: { "User-Agent": "tauri-plugin-updater/2.12.0" } })).json();
    check(feed.version === version, `${host} 的 latest.json 是 ${version}`, `（是 ${feed.version}）`);
    feeds.push({ host, feed });
  } catch (error) {
    check(false, `${host} 的 latest.json 取得到`, error.message);
  }
}

const gitee = feeds.find((entry) => entry.host === "gitee.com")?.feed;
const github = feeds.find((entry) => entry.host === "github.com")?.feed;
if (gitee && github) {
  const same = Object.keys(github.platforms).every(
    (platform) => gitee.platforms[platform]?.signature === github.platforms[platform].signature,
  );
  check(same, "两份 latest.json 的平台和签名一样");
  for (const [platform, entry] of Object.entries(gitee.platforms)) {
    const onGitee = new URL(entry.url).hostname === "gitee.com";
    check(onGitee !== GITHUB_ONLY.test(platform), `Gitee 那份的 ${platform} 指向 ${onGitee ? "Gitee" : "GitHub"}`);
  }
}

for (const { host, feed } of feeds) {
  for (const [platform, entry] of Object.entries(feed.platforms)) {
    const result = await downloadable(entry.url);
    check(result.ok, `${host} 那份的 ${platform} 下得动`, `（从 ${result.host}）`);
  }
}

console.log(failures ? `\n${failures} 项不对` : "\n全部对上了");
process.exit(failures ? 1 : 0);
