import type { GuideName } from "@/data/types";
import { version as APP_VERSION } from "../../../package.json";
import syntax from "./syntax.md?raw";
import welcome from "./welcome.md?raw";

/* ============================================================
   内置的使用指南。正文就是这两个 .md：桌面版由 Rust 编进程序（src-tauri/src/vault/guide.rs，
   新仓库里放一份、升级时管新旧），浏览器预览的 mock 用这里的同一份、同一套规矩。
   改了正文不用改版本号：新旧按正文的指纹认，谁是新版按写它的应用的版本认。
   ============================================================ */

export interface Guide {
  name: GuideName;
  title: string;
  /** 新放进去的时候置不置顶 */
  pinned: boolean;
  body: string;
}

export const GUIDES: readonly Guide[] = [
  { name: "welcome", title: "欢迎使用 Odea", pinned: true, body: welcome },
  { name: "syntax", title: "语法全览", pinned: false, body: syntax },
];

export { APP_VERSION };

/** 指南那篇笔记的 id 前缀（后面接一个随机 id） */
export const guideIdPrefix = (name: GuideName) => `guide-${name}-`;

/** 这篇笔记是哪一份指南 */
export function guideOf(id: string): Guide | undefined {
  return GUIDES.find((guide) => id.startsWith(guideIdPrefix(guide.name)));
}

/** 任务行的勾选框：`- [x] 事` → 框里那个字符的位置、勾没勾 */
function taskBox(line: string): { at: number; done: boolean } | null {
  const match = /^(\s*[-*+] \[)([ xX])\]/.exec(line);
  if (!match) return null;
  return { at: match[1]!.length, done: match[2] !== " " };
}

/** 正文的指纹：勾选框一律按没勾算（勾掉清单上的事不算改过指南） */
export function guideFingerprint(body: string): string {
  const normalized = body
    .trimEnd()
    .split("\n")
    .map((line) => {
      const box = taskBox(line);
      return box?.done ? `${line.slice(0, box.at)} ${line.slice(box.at + 1)}` : line;
    })
    .join("\n");
  // FNV-1a（32 位）：mock 里够用，不用和 Rust 那边的值一样，规矩一样就行
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 换成新版时，旧版里勾掉的事在新版里照样勾上（按那件事的文字认） */
export function carryChecks(old: string, next: string): string {
  const textOf = (line: string, at: number) => line.slice(at + 2).trim();
  const done = new Set(
    old.split("\n").flatMap((line) => {
      const box = taskBox(line);
      return box?.done ? [textOf(line, box.at)] : [];
    }),
  );
  return next
    .split("\n")
    .map((line) => {
      const box = taskBox(line);
      return box && !box.done && done.has(textOf(line, box.at))
        ? `${line.slice(0, box.at)}x${line.slice(box.at + 1)}`
        : line;
    })
    .join("\n");
}

/** `0.1.0` → [0, 1, 0]；认不出来是 null */
export function parseVersion(text: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** a 比 b 新 */
export function newerThan(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i]! !== y[i]!) return x[i]! > y[i]!;
  }
  return false;
}
