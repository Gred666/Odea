// GitHub Release 里的 latest.json 换成不限流的下载地址：node scripts/github-latest.mjs <latest.json> <owner/repo> <tag>
//
// tauri-action v1 写的是 api.github.com 的接口地址，不登录每个 IP 每小时只能调 60 次（国内很多人共用一个出口 IP）。
// CI 在正式发布前跑它（.github/workflows/release.yml），原地改写那个文件，再传回 Release。
// 怎么认文件、怎么换，和镜像到 Gitee 是同一套（scripts/gitee-release.mjs 的 resolveNames / mirrorLatest）
import { readFileSync, writeFileSync } from "node:fs";
import { githubDownloads, mirrorLatest, resolveNames } from "./gitee-release.mjs";

const [file, repo, tag] = process.argv.slice(2);
if (!file || !repo || !tag) {
  console.error("用法：node scripts/github-latest.mjs <latest.json> <owner/repo> <tag>");
  process.exit(1);
}
const latest = JSON.parse(readFileSync(file, "utf8"));
const rewritten = mirrorLatest(latest, await resolveNames(latest), {}, githubDownloads(repo, tag));
writeFileSync(file, `${JSON.stringify(rewritten, null, 2)}\n`);
for (const [platform, entry] of Object.entries(rewritten.platforms)) console.log(`${platform.padEnd(24)} ${entry.url}`);
