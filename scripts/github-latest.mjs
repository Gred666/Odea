// GitHub Release 里的 latest.json 换成不限流的下载地址：node scripts/github-latest.mjs <latest.json> <owner/repo> <tag>
//
// tauri-action v1 写的是 api.github.com 的接口地址，不登录每个 IP 每小时只能调 60 次（国内很多人共用一个出口 IP）。
// CI 在正式发布前跑它（.github/workflows/release.yml），原地改写那个文件，再传回 Release。
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * latest.json 里的下载地址是哪个文件。tauri-action v1 写的是接口地址
 * `https://api.github.com/repos/<仓库>/releases/assets/<id>`，路径里没有文件名 —— 这种返回 { assetId }，
 * 得去问 GitHub；`…/releases/download/<tag>/<文件名>` 这种直接返回 { name }
 */
export function assetOf(url) {
  const { hostname, pathname } = new URL(url);
  const api = /^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/.exec(pathname);
  if (hostname === "api.github.com" && api) return { assetId: api[1] };
  return { name: decodeURIComponent(pathname.split("/").pop() ?? "") };
}

/** latest.json 里每个下载地址 → 文件名（接口地址去问 GitHub，带上 GH_TOKEN 免得被限流） */
export async function resolveNames(latest) {
  const names = new Map();
  for (const { url } of Object.values(latest.platforms ?? {})) {
    if (names.has(url)) continue;
    const asset = assetOf(url);
    if (asset.name) {
      names.set(url, asset.name);
      continue;
    }
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "ontheway-release" };
    if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`问 GitHub ${url} 是哪个文件 → ${response.status}`);
    names.set(url, (await response.json()).name);
  }
  return names;
}

/**
 * latest.json 里的下载地址换成 GitHub 的普通下载地址 `https://github.com/<仓库>/releases/download/<tag>/<文件名>`。
 *
 * 不留 tauri-action 写的 api.github.com 接口地址：不登录的话每个 IP 每小时只能调 60 次，
 * 国内很多人共用一个出口 IP（运营商的大 NAT、公司、学校），一起查更新就 403（2026-10-13 实测：
 * 额度用完以后接口地址 403，普通下载地址照样 302 到文件）。
 * names：原来的地址 → 文件名（resolveNames），githubBase：GitHub 的下载目录（githubDownloads）
 */
export function plainLatest(latest, names, githubBase) {
  const copy = structuredClone(latest);
  for (const platform of Object.values(copy.platforms ?? {})) {
    const name = names.get(platform.url);
    if (name) platform.url = `${githubBase}/${encodeURIComponent(name)}`;
  }
  return copy;
}

/** GitHub 上这一版的下载目录 */
export const githubDownloads = (repo, tag) => `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [file, repo, tag] = process.argv.slice(2);
  if (!file || !repo || !tag) {
    console.error("用法：node scripts/github-latest.mjs <latest.json> <owner/repo> <tag>");
    process.exit(1);
  }
  const latest = JSON.parse(readFileSync(file, "utf8"));
  const rewritten = plainLatest(latest, await resolveNames(latest), githubDownloads(repo, tag));
  writeFileSync(file, `${JSON.stringify(rewritten, null, 2)}\n`);
  for (const [platform, entry] of Object.entries(rewritten.platforms)) console.log(`${platform.padEnd(24)} ${entry.url}`);
}
