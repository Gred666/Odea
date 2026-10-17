// 改版本号：pnpm bump 0.2.0
//
// 版本号写在三个地方，得一起改：package.json（前端）、src-tauri/Cargo.toml（Rust 和安装包，
// tauri.conf.json 不写版本就用它）、src-tauri/Cargo.lock 里 odea 那一条。
// 对不上的话 src/content/changelog.test.ts 会挂。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("用法：pnpm bump <版本号>，比如 pnpm bump 0.2.0");
  process.exit(1);
}

const root = fileURLToPath(new URL("..", import.meta.url));
/** 把文件里第一个匹配的引号中间的版本号换掉（前后两段原样留着） */
const edit = (file, pattern) => {
  const path = root + file;
  const text = readFileSync(path, "utf8");
  if (!pattern.test(text)) throw new Error(`${file} 里没找到版本号`);
  writeFileSync(path, text.replace(pattern, (_, head, tail) => head + version + tail));
};

edit("package.json", /("version":\s*")[^"]+(")/);
edit("src-tauri/Cargo.toml", /(\[package\][^[]*?\nversion\s*=\s*")[^"]+(")/);
edit("src-tauri/Cargo.lock", /(name = "odea"\r?\nversion = ")[^"]+(")/);

console.log(`版本号改成了 ${version}。别忘了在 src/content/changelog.md 最上面写这一版的更新说明`);
