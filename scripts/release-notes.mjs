// 发版前的检查，顺便取出这一版的更新说明：node scripts/release-notes.mjs 0.2.0
//
// CI（.github/workflows/release.yml）打 tag 后先跑它：
// - tag 的版本、package.json、Cargo.toml、Cargo.lock 得是同一个（改版本号用 pnpm bump）
// - src/content/changelog.md 最上面那一节得是这一版，而且写了东西
// 都对的话把那一节的正文打到标准输出：它就是 GitHub Release 的说明，也是 latest.json 里的 notes
// （应用里「新版本」卡片显示的就是它）。切法和 src/content/changelog.ts 一样，release-notes.test.mjs 对过。
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const HEADING_RE = /^##\s+v?(\d+\.\d+\.\d+\S*)\s*(?:·\s*(.+?))?\s*$/;

/** changelog.md 按「## 版本号 · 日期」切开，新的在前；注释、空的节不算 */
export function releases(text) {
  const out = [];
  let current = null;
  const finish = () => {
    if (!current) return;
    const body = current.lines.join("\n").trim();
    if (body) out.push({ version: current.version, date: current.date, body });
  };
  for (const line of text.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n").split("\n")) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      finish();
      current = { version: heading[1], date: heading[2] ?? null, lines: [] };
    } else {
      current?.lines.push(line);
    }
  }
  finish();
  return out;
}

/** 发这一版之前该对上的都对一遍，返回不对的地方（空数组 = 都对） */
export function problems(version, files) {
  const found = [];
  const pkg = JSON.parse(files.packageJson).version;
  const cargo = /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(files.cargoToml)?.[1];
  const lock = /^name = "odea"\r?\nversion = "([^"]+)"/m.exec(files.cargoLock)?.[1];
  for (const [file, value] of [
    ["package.json", pkg],
    ["src-tauri/Cargo.toml", cargo],
    ["src-tauri/Cargo.lock", lock],
  ]) {
    if (value !== version) found.push(`${file} 里的版本是 ${value ?? "（没找到）"}，tag 是 ${version}。先 pnpm bump ${version}`);
  }
  const top = releases(files.changelog)[0];
  if (!top) found.push(`src/content/changelog.md 里还没有更新说明：在最上面加一节「## ${version} · 日期」`);
  else if (top.version !== version) {
    found.push(`src/content/changelog.md 最上面那一节是 ${top.version}，要发的是 ${version}`);
  }
  return found;
}

function main() {
  const version = process.argv[2]?.replace(/^v/, "");
  if (!version) {
    console.error("用法：node scripts/release-notes.mjs <版本号>");
    process.exit(1);
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  const read = (file) => readFileSync(root + file, "utf8");
  const files = {
    packageJson: read("package.json"),
    cargoToml: read("src-tauri/Cargo.toml"),
    cargoLock: read("src-tauri/Cargo.lock"),
    changelog: read("src/content/changelog.md"),
  };
  const found = problems(version, files);
  if (found.length) {
    for (const problem of found) console.error(`✗ ${problem}`);
    process.exit(1);
  }
  process.stdout.write(`${releases(files.changelog)[0].body}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
