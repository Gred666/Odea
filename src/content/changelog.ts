import changelog from "./changelog.md?raw";
import { newerThan } from "./guide";

/* ============================================================
   更新说明（changelog.md）。随安装包一起带，不写进用户的笔记仓库。

   升级后第一次打开（Rust 那边记着上一次启动的版本，update.rs 的 app_upgrade），
   把旧版之后、到这一版为止的几节给用户看一次。CI 发版时取最上面一节写进 latest.json。
   ============================================================ */

export interface Release {
  version: string;
  /** 标题里「·」后面那段，没写就是空 */
  date: string | null;
  /** 这一节的正文（Markdown） */
  body: string;
}

const HEADING_RE = /^##\s+v?(\d+\.\d+\.\d+\S*)\s*(?:·\s*(.+?))?\s*$/;

/** 按「## 版本号 · 日期」切成一节一节，照文件里的顺序（新的在前）。开头的注释、第一节之前的字不算 */
export function parseChangelog(text: string): Release[] {
  const releases: Release[] = [];
  let current: { version: string; date: string | null; lines: string[] } | null = null;
  const finish = () => {
    if (current) {
      releases.push({
        version: current.version,
        date: current.date,
        body: current.lines.join("\n").trim(),
      });
    }
  };
  for (const line of text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n")) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      finish();
      current = { version: heading[1]!, date: heading[2] ?? null, lines: [] };
    } else {
      current?.lines.push(line);
    }
  }
  finish();
  return releases.filter((release) => release.body);
}

export const RELEASES: readonly Release[] = parseChangelog(changelog);

/**
 * 从 from 升到 to，要给用户看的那几节：比 from 新、不比 to 新，新的在前。
 * from 不知道（记版本号之前的老版本）时只看 to 那一节
 */
export function releasesBetween(
  from: string | null,
  to: string,
  releases: readonly Release[] = RELEASES,
): Release[] {
  return releases.filter((release) => {
    if (newerThan(release.version, to)) return false;
    if (from === null) return release.version === to;
    return newerThan(release.version, from);
  });
}

/** 某一版的那一节（命令面板「这一版的更新说明」） */
export function releaseOf(version: string, releases: readonly Release[] = RELEASES) {
  return releases.find((release) => release.version === version) ?? null;
}
