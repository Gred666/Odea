// 发版时把 GitHub Release 镜像到 Gitee（国内）。只在 CI 里跑（.github/workflows/release.yml）：
//
//   node scripts/gitee-release.mjs check     试打包时：令牌能不能推这个仓库
//   node scripts/gitee-release.mjs publish   打 tag 发版时：建发行版、传安装包、换 latest.json、删旧版
//
// 环境变量：GITEE_TOKEN（GitHub Secrets）、GITEE_REPO（owner/name）；publish 还要 TAG、SHA、
// NOTES_FILE（这一版的更新说明）、ASSETS_DIR（从 GitHub Release 下下来的安装包和 latest.json）。
//
// Gitee 的规矩（2026-10 实测 / 帮助文档）：
// - 公开仓库的发行版附件不登录就能下（跳两次到 foruda.gitee.com）
// - 单个附件不超过 100 MB，一个仓库所有附件加起来不超过 1 GB：每版一百多 MB，只留最近两版
// - 没有 GitHub 那种 releases/latest/download/…：最新的 latest.json 放在一个固定的发行版 `updater` 里，
//   应用查 https://gitee.com/<仓库>/releases/download/updater/latest.json（tauri.conf.json 的第一个地址）
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const API = "https://gitee.com/api/v5";
/** Gitee 单个附件的上限 */
export const MAX_ATTACHMENT = 100 * 1024 * 1024;
/** 放 latest.json 的那个发行版 */
export const UPDATER_TAG = "updater";
/** Gitee 上留几版的安装包（不算 updater） */
export const KEEP_RELEASES = 2;

const INSTALLER = /\.(exe|msi|dmg|app\.tar\.gz|AppImage|deb|rpm)$/;

/** 要传到 Gitee 的：安装包和更新包；签名（.sig）不传（签名写在 latest.json 里），超过上限的跳过 */
export function pickUploads(files) {
  const upload = [];
  const skipped = [];
  for (const file of files) {
    if (!INSTALLER.test(file.name)) continue;
    if (file.size > MAX_ATTACHMENT) {
      skipped.push({ ...file, reason: `超过 Gitee 单个附件 100 MB 的上限` });
    } else upload.push(file);
  }
  return { upload, skipped };
}

/** latest.json 里的下载地址换成 Gitee 上的（传上去了的那些）；没传上去的照旧指向 GitHub */
export function mirrorLatest(latest, giteeUrls) {
  const copy = structuredClone(latest);
  for (const platform of Object.values(copy.platforms ?? {})) {
    const name = decodeURIComponent(new URL(platform.url).pathname.split("/").pop() ?? "");
    if (giteeUrls[name]) platform.url = giteeUrls[name];
  }
  return copy;
}

/** 要删掉的旧发行版：updater 以外、最新的 keep 个以外的（按发布时间） */
export function releasesToPrune(releases, keep = KEEP_RELEASES) {
  return releases
    .filter((release) => release.tag_name !== UPDATER_TAG)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(keep);
}

/* ---------------- Gitee API ---------------- */

function client(token, repo) {
  const call = async (method, route, { query = {}, form } = {}) => {
    const url = new URL(`${API}/repos/${repo}${route}`);
    url.searchParams.set("access_token", token);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(url, { method, body: form });
      const text = await response.text();
      if (response.ok) return text ? JSON.parse(text) : null;
      // 上传大文件偶尔断：再来两次
      if (attempt < 3 && (response.status >= 500 || response.status === 429)) {
        await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
        continue;
      }
      throw new Error(`${method} ${route} → ${response.status} ${text.slice(0, 300)}`);
    }
  };
  const fields = (values) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(values)) form.set(key, String(value));
    return form;
  };
  return {
    repo: () => call("GET", ""),
    releaseByTag: (tag) => call("GET", `/releases/tags/${encodeURIComponent(tag)}`),
    releases: () => call("GET", "/releases", { query: { per_page: 100, direction: "desc" } }),
    createRelease: (values) => call("POST", "/releases", { form: fields(values) }),
    deleteRelease: (id) => call("DELETE", `/releases/${id}`),
    attachments: (id) => call("GET", `/releases/${id}/attach_files`, { query: { per_page: 100 } }),
    deleteAttachment: (id, fileId) => call("DELETE", `/releases/${id}/attach_files/${fileId}`),
    upload: (id, name, bytes) => {
      const form = new FormData();
      form.set("file", new Blob([bytes]), name);
      return call("POST", `/releases/${id}/attach_files`, { form });
    },
  };
}

/** 这个 tag 的发行版，没有就建一个 */
async function ensureRelease(gitee, values) {
  return (await gitee.releaseByTag(values.tag_name)) ?? (await gitee.createRelease(values));
}

/** 传一个附件；同名的旧附件先删掉（重跑发版不会传出两份） */
async function replaceAttachment(gitee, release, existing, name, bytes) {
  for (const old of existing.filter((file) => file.name === name)) {
    await gitee.deleteAttachment(release.id, old.id);
  }
  const uploaded = await gitee.upload(release.id, name, bytes);
  console.log(`  ↑ ${name}（${(bytes.length / 1024 / 1024).toFixed(1)} MB）`);
  return uploaded;
}

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺环境变量 ${name}`);
  return value;
}

async function check() {
  const repo = env("GITEE_REPO");
  const info = await client(env("GITEE_TOKEN"), repo).repo();
  if (!info?.permission?.push) throw new Error(`令牌没有 ${repo} 的推送权限`);
  console.log(`Gitee 令牌可用：${info.full_name}（${info.public ? "公开" : "私有"}）`);
  if (!info.public) throw new Error("Gitee 仓库得是公开的：私有仓库的附件不登录下不了，应用拿不到");
}

async function publish() {
  const repo = env("GITEE_REPO");
  const tag = env("TAG");
  const sha = env("SHA");
  const dir = env("ASSETS_DIR");
  const notes = readFileSync(env("NOTES_FILE"), "utf8").trim();
  const gitee = client(env("GITEE_TOKEN"), repo);

  const files = readdirSync(dir).map((name) => ({ name, size: statSync(path.join(dir, name)).size }));
  const latest = JSON.parse(readFileSync(path.join(dir, "latest.json"), "utf8"));
  const { upload, skipped } = pickUploads(files);
  for (const file of skipped) console.warn(`  跳过 ${file.name}：${file.reason}，latest.json 里它还指向 GitHub`);

  console.log(`发行版 ${tag}`);
  const release = await ensureRelease(gitee, {
    tag_name: tag,
    name: `OnTheWay ${tag.replace(/^v/, "")}`,
    body: notes,
    target_commitish: sha,
    prerelease: false,
  });
  const existing = (await gitee.attachments(release.id)) ?? [];
  const giteeUrls = {};
  for (const file of upload) {
    const uploaded = await replaceAttachment(gitee, release, existing, file.name, readFileSync(path.join(dir, file.name)));
    giteeUrls[file.name] =
      uploaded?.browser_download_url ??
      `https://gitee.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file.name)}`;
  }

  // latest.json 换成 Gitee 的地址，放进固定的 updater 发行版
  const mirrored = mirrorLatest(latest, giteeUrls);
  const out = path.join(dir, "latest.gitee.json");
  writeFileSync(out, `${JSON.stringify(mirrored, null, 2)}\n`);
  console.log(`发行版 ${UPDATER_TAG}（应用查更新的固定地址）`);
  const updater = await ensureRelease(gitee, {
    tag_name: UPDATER_TAG,
    name: "自动更新",
    body: "应用检查更新用的，里面只放最新一版的 latest.json。下载安装包请看其它发行版。",
    target_commitish: sha,
    prerelease: true,
  });
  await replaceAttachment(gitee, updater, (await gitee.attachments(updater.id)) ?? [], "latest.json", readFileSync(out));

  // 只留最近几版：一个仓库的附件总共 1 GB
  for (const old of releasesToPrune((await gitee.releases()) ?? [])) {
    for (const file of (await gitee.attachments(old.id)) ?? []) await gitee.deleteAttachment(old.id, file.id);
    await gitee.deleteRelease(old.id);
    console.log(`  删掉旧版 ${old.tag_name}`);
  }
  console.log(`完成：https://gitee.com/${repo}/releases/tag/${tag}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const command = process.argv[2];
  const run = command === "check" ? check : command === "publish" ? publish : null;
  if (!run) {
    console.error("用法：node scripts/gitee-release.mjs check|publish");
    process.exit(1);
  }
  run().catch((error) => {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  });
}
