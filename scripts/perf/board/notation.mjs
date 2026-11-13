// 白板的文件记法（docs/白板.md §4）的原型：读、写、按对象三方合并。
// 只是实验用的：正式实现要用编辑器那套 Lezer 解析器认注释块，这里按行扫。
//
// 三种写法（variant）：
//   "tight"  注释紧挨着内容（调研稿 §4.1 的草案）
//   "loose"  注释和内容之间空一行
//   "tail"   内容前面只留一个不变的锚点，位置收在文件末尾的一个注释块里（一行一个对象，按 id 排）
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARK = /^<!--\s*@(card|frame|ink|edge|shape)\s+(\S+)(.*?)-->\s*$/;
const FENCE = /^(\s{0,3})(`{3,}|~{3,})/;

/** `40,80 320x200 label="对照"` → { x, y, w, h, rest } */
function parseProps(text) {
  const props = { rest: [] };
  for (const token of text.trim().match(/[^\s"]+="[^"]*"|\S+/g) ?? []) {
    let m = /^(-?\d+),(-?\d+)$/.exec(token);
    if (m) {
      props.x = Number(m[1]);
      props.y = Number(m[2]);
      continue;
    }
    m = /^(\d+)(?:x(\d+))?$/.exec(token);
    if (m) {
      props.w = Number(m[1]);
      if (m[2]) props.h = Number(m[2]);
      continue;
    }
    m = /^([^>\s]+)>([^>\s]+)$/.exec(token);
    if (m) {
      props.from = m[1];
      props.to = m[2];
      continue;
    }
    props.rest.push(token);
  }
  return props;
}

function propsText(item) {
  const out = [];
  if (item.from) out.push(`${item.from}>${item.to}`);
  if (item.x !== undefined) out.push(`${item.x},${item.y}`);
  if (item.w !== undefined) out.push(item.h !== undefined ? `${item.w}x${item.h}` : `${item.w}`);
  out.push(...(item.rest ?? []));
  return out.join(" ");
}

const trimBlank = (lines) => {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === "") a++;
  while (b > a && lines[b - 1].trim() === "") b--;
  return lines.slice(a, b);
};

/**
 * 读：返回 { pre, items, notes }。
 * pre 是第一个标记之前的东西（属性块、没有标记的正文）；notes 记下修掉了什么（重复的 id、没有位置的）。
 * 什么都不丢：认不出来的标记当正文留着。
 */
export function parseBoard(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const notes = [];
  const items = [];
  const seen = new Set();
  let pre = [];
  let current = null;
  let fence = null;
  /** tail 写法：文件末尾 `<!-- @layout` 到 `-->` 之间，一行一个对象 */
  let layout = null;
  const tail = new Map();

  for (const line of lines) {
    if (layout) {
      if (line.trim() === "-->") layout = null;
      else {
        const m = /^(\S+)\s+(.*)$/.exec(line.trim());
        if (m) tail.set(m[1], parseProps(m[2]));
      }
      continue;
    }
    const f = FENCE.exec(line);
    if (f) {
      if (!fence) fence = f[2][0];
      else if (f[2][0] === fence) fence = null;
    }
    if (!fence && line.trim() === "<!-- @layout") {
      layout = true;
      continue;
    }
    const m = fence ? null : MARK.exec(line);
    if (!m) {
      (current ? current.lines : pre).push(line);
      continue;
    }
    let id = m[2];
    if (seen.has(id)) {
      // 复制粘贴出来的第二份：换一个 id，内容留着
      const fresh = `${id}-${seen.size}`;
      notes.push(`重复的 id ${id} → ${fresh}`);
      id = fresh;
    }
    seen.add(id);
    current = { kind: m[1], id, ...parseProps(m[3]), lines: [] };
    items.push(current);
  }
  for (const item of items) {
    const at = tail.get(item.id);
    if (at) Object.assign(item, { ...at, rest: [...(item.rest ?? []), ...at.rest] });
    item.body = trimBlank(item.lines).join("\n");
    delete item.lines;
    if (item.kind !== "edge" && item.x === undefined) notes.push(`${item.id} 没有位置：自动排`);
  }
  return { pre: trimBlank(pre).join("\n"), items, notes };
}

/** 写。variant 见文件开头 */
export function serializeBoard(board, variant = "loose") {
  const out = [];
  if (board.pre) out.push(board.pre, "");
  for (const item of board.items) {
    const props = variant === "tail" ? "" : propsText(item);
    out.push(`<!-- @${item.kind} ${item.id}${props ? ` ${props}` : ""} -->`);
    if (item.body) {
      if (variant !== "tight") out.push("");
      out.push(item.body);
    }
    out.push("");
  }
  if (variant === "tail") {
    out.push("<!-- @layout");
    for (const item of [...board.items].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      out.push(`${item.id} ${propsText(item)}`);
    }
    out.push("-->", "");
  }
  return out.join("\n");
}

/* ---------------- 合并 ---------------- */

let tmp = null;
/** git 的逐行三方合并（`git merge-file`，和 git merge 合单个文件用的是同一套）：{ text, conflicts } */
export function mergeLines(base, ours, theirs) {
  tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "odea-board-merge-"));
  const file = (name, text) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, text);
    return p;
  };
  const args = ["merge-file", "-p", file("ours", ours), file("base", base), file("theirs", theirs)];
  try {
    return { text: execFileSync("git", args, { encoding: "utf8" }), conflicts: 0 };
  } catch (error) {
    if (typeof error.status === "number" && error.status > 0 && error.status < 128) {
      return { text: error.stdout, conflicts: error.status };
    }
    throw error;
  }
}
export function cleanup() {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
}

const FIELDS = ["kind", "x", "y", "w", "h", "from", "to"];

/** 顺序的三方合并：谁动过原有对象的先后就用谁的当骨架，另一边新加的插到它在那边的前一个后面 */
function mergeOrder(base, ours, theirs, alive) {
  const inBase = new Set(base);
  const kept = (ids) => ids.filter((id) => inBase.has(id) && alive.has(id));
  const same = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
  const baseKept = kept(base);
  const oursMoved = !same(kept(ours), baseKept.filter((id) => ours.includes(id)));
  const theirsMoved = !same(kept(theirs), baseKept.filter((id) => theirs.includes(id)));
  const [spine, other] = theirsMoved && !oursMoved ? [theirs, ours] : [ours, theirs];
  const out = spine.filter((id) => alive.has(id));
  for (const [index, id] of other.entries()) {
    if (!alive.has(id) || out.includes(id)) continue;
    let after = -1;
    for (let i = index - 1; i >= 0 && after < 0; i--) after = out.indexOf(other[i]);
    out.splice(after + 1, 0, id);
  }
  return out;
}

/**
 * 按对象三方合并：位置、大小按属性合，内容按行合，先后单独合。
 * 同一个属性两边都改了取 ours；同一张卡片的内容两边改到了一处，留 ours、theirs 另放一张卡片在旁边。
 * 返回 { text, layoutConflicts, forked }
 */
export function mergeBoards(baseText, oursText, theirsText, variant = "loose") {
  const [base, ours, theirs] = [baseText, oursText, theirsText].map(parseBoard);
  const index = (board) => new Map(board.items.map((item) => [item.id, item]));
  const [B, O, T] = [index(base), index(ours), index(theirs)];
  const changed = (a, b) => !a || !b || a.body !== b.body || FIELDS.some((f) => a[f] !== b[f]);
  let layoutConflicts = 0;
  const forked = [];
  const merged = new Map();

  for (const id of new Set([...O.keys(), ...T.keys()])) {
    const [b, o, t] = [B.get(id), O.get(id), T.get(id)];
    if (!b) {
      // 一边新加的（两边碰巧同一个 id 的，留 ours）
      merged.set(id, { ...(o ?? t) });
      continue;
    }
    // 一边删了：另一边没动过就删，动过就留着
    if (!o && !changed(b, t)) continue;
    if (!t && !changed(b, o)) continue;
    if (!o || !t) {
      merged.set(id, { ...(o ?? t) });
      continue;
    }
    const item = { ...o };
    for (const field of FIELDS) {
      if (o[field] === b[field]) item[field] = t[field];
      else if (t[field] !== b[field] && t[field] !== o[field]) layoutConflicts++;
    }
    if (o.body === b.body) item.body = t.body;
    else if (t.body !== b.body && t.body !== o.body) {
      const lines = mergeLines(`${b.body}\n`, `${o.body}\n`, `${t.body}\n`);
      if (lines.conflicts === 0) item.body = lines.text.replace(/\n$/, "");
      else {
        // 内容撞了：留本机的，对方的另放一张，谁的字都不丢
        const copy = { ...t, id: `${id}~`, x: (t.x ?? 0) + 24, y: (t.y ?? 0) + 24 };
        merged.set(copy.id, copy);
        forked.push(id);
      }
    }
    merged.set(id, item);
  }

  const order = mergeOrder(
    base.items.map((item) => item.id),
    ours.items.map((item) => item.id),
    theirs.items.map((item) => item.id),
    new Set(merged.keys()),
  );
  for (const id of forked) order.splice(order.indexOf(id) + 1, 0, `${id}~`);
  const pre =
    ours.pre === base.pre ? theirs.pre : theirs.pre === base.pre ? ours.pre : ours.pre;
  const text = serializeBoard({ pre, items: order.map((id) => merged.get(id)) }, variant);
  return { text, layoutConflicts, forked };
}
