// @vitest-environment happy-dom

import { history, redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { collab, isCollabSync } from "./binding";
import { LoopbackHub, type LoopbackMember, ManualScheduler } from "./loopback";
import { peerColor } from "./session";

/* ============================================================
   收敛模糊测试（docs/协同编辑.md §13）。

   每一轮：3–5 个副本，各一个真的 EditorView（带 history），随机打字、删除、粘贴、撤销、
   重做、挪光标、组字；网络每条消息随机延迟 0–300ms，更新乱序到、重复投递，光标丢包，
   随机断线重连（主持人也会断）。最后所有人重连、消息都到齐，每个编辑器的文档和它的
   正文逐字相等，所有人之间也相等。

   默认跑 150 轮。完整的一万轮：
     COLLAB_FUZZ_ROUNDS=10000 pnpm exec vitest run src/collab/convergence
   失败时打出种子，COLLAB_FUZZ_SEED=<种子> 只重放那一轮；再加 COLLAB_FUZZ_DEBUG=1，
   失败信息里带上每个副本的版本向量（缺的是谁的第几个改动）。
   ============================================================ */

const ROUNDS = Number(process.env.COLLAB_FUZZ_ROUNDS ?? 150);
const ONLY_SEED = process.env.COLLAB_FUZZ_SEED ? Number(process.env.COLLAB_FUZZ_SEED) : null;

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 汉字、字母、标点、换行，外加 emoji（代理对：位置不能落在中间） */
const ALPHABET = [..."的一是在不了有和人这中大为上个国我以要他时来用们abcxyz ，。#*-[]`\n"];
const EMOJI = ["😀", "🎉", "👍🏽", "🇨🇳"];

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** 挪开代理对中间：编辑器自己的命令不会停在那里 */
function safe(doc: string, position: number): number {
  if (position > 0 && position < doc.length) {
    if (isHigh(doc.charCodeAt(position - 1)) && isLow(doc.charCodeAt(position)))
      return position - 1;
  }
  return position;
}

interface Replica {
  member: LoopbackMember;
  view: EditorView;
  /** 正在组字：起点、现在的拼音长度 */
  composing: { from: number; length: number } | null;
}

async function runRound(seed: number) {
  const random = mulberry32(seed);
  const int = (n: number) => Math.floor(random() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
  const word = (length: number) => {
    let text = "";
    for (let index = 0; index < length; index += 1) {
      text += random() < 0.05 ? pick(EMOJI) : pick(ALPHABET);
    }
    return text;
  };

  const scheduler = new ManualScheduler();
  const hub = new LoopbackHub({
    scheduler,
    latency: () => (random() < 0.3 ? 0 : int(300)),
    reorder: random() < 0.5,
    duplicate: 0.05,
    dropCursor: 0.2,
    random,
  });
  const count = 3 + int(3);
  const members = [hub.host({ id: "p0", name: "p0", color: peerColor("p0") }, word(int(80)))];
  for (let index = 1; index < count; index += 1) {
    const id = `p${index}`;
    members.push(hub.join({ id, name: id, color: peerColor(id) }));
  }
  const replicas: Replica[] = members.map((member) => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const replica = { member, composing: null } as unknown as Replica;
    // 组字期间别的行的远端改动当场进来（§20.10）：组字的位置跟着挪，和真的输入法一样
    const follow = EditorView.updateListener.of((update) => {
      if (!replica.composing || !update.docChanged) return;
      for (const transaction of update.transactions) {
        if (isCollabSync(transaction))
          replica.composing.from = transaction.changes.mapPos(replica.composing.from, 1);
      }
    });
    replica.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: member.session.toString(),
        extensions: [history(), collab(member.session), follow],
      }),
    });
    return replica;
  });

  const fire = (view: EditorView, type: "compositionstart" | "compositionend") =>
    view.contentDOM.dispatchEvent(new CompositionEvent(type, { bubbles: true }));

  const endComposition = (replica: Replica) => {
    const composing = replica.composing!;
    replica.composing = null;
    fire(replica.view, "compositionend");
    // 最后一次组字改动在 compositionend 之后才读进来：拼音换成上屏的字
    replica.view.dispatch({
      changes: {
        from: composing.from,
        to: composing.from + composing.length,
        insert: word(1 + int(3)),
      },
      userEvent: "input.type.compose",
    });
  };

  const steps = 20 + int(50);
  for (let step = 0; step < steps; step += 1) {
    const replica = pick(replicas);
    const { view } = replica;
    const doc = view.state.doc.toString();
    const roll = random();

    if (replica.composing) {
      if (roll < 0.6) {
        // 接着打拼音
        const { from, length } = replica.composing;
        view.dispatch({
          changes: { from, to: from + length, insert: "pinyin".slice(0, length + 1) },
          userEvent: "input.type.compose",
        });
        replica.composing.length = Math.min(length + 1, 6);
      } else {
        endComposition(replica);
      }
    } else if (roll < 0.3) {
      const at = safe(doc, int(doc.length + 1));
      view.dispatch({
        changes: { from: at, insert: word(1 + int(5)) },
        userEvent: "input.type",
      });
    } else if (roll < 0.45 && doc.length) {
      const from = safe(doc, int(doc.length));
      const to = safe(doc, Math.min(doc.length, from + 1 + int(8)));
      if (to > from) view.dispatch({ changes: { from, to }, userEvent: "delete" });
    } else if (roll < 0.52) {
      const at = safe(doc, int(doc.length + 1));
      view.dispatch({
        changes: { from: at, insert: word(20 + int(180)) },
        userEvent: "input.paste",
      });
    } else if (roll < 0.62) {
      undo(view);
    } else if (roll < 0.67) {
      redo(view);
    } else if (roll < 0.77) {
      const anchor = safe(doc, int(doc.length + 1));
      const head = safe(doc, int(doc.length + 1));
      view.dispatch({ selection: EditorSelection.range(anchor, head), userEvent: "select" });
    } else if (roll < 0.85) {
      const at = safe(doc, int(doc.length + 1));
      fire(view, "compositionstart");
      view.dispatch({ changes: { from: at, insert: "p" }, userEvent: "input.type.compose" });
      replica.composing = { from: at, length: 1 };
    } else if (roll < 0.93) {
      const member = replica.member;
      if (member.connected) hub.disconnect(member);
      else hub.reconnect(member);
    }
    // 两步之间过一会儿：有时同一帧，有时隔几百毫秒
    await scheduler.advance(random() < 0.4 ? 0 : int(400));
  }

  for (const replica of replicas) if (replica.composing) endComposition(replica);
  // 主持人先回来，访客再重连
  const host = replicas[0]!.member;
  if (!host.connected) hub.reconnect(host);
  for (const replica of replicas) if (!replica.member.connected) hub.reconnect(replica.member);
  for (let wait = 0; wait < 40 && (hub.pending > 0 || wait < 2); wait += 1) {
    await scheduler.advance(400);
  }

  const texts = replicas.map((replica) => replica.view.state.doc.toString());
  const failures: string[] = [];
  replicas.forEach((replica, index) => {
    if (replica.member.session.toString() !== texts[index]) {
      failures.push(`p${index} 的编辑器和正文不一致`);
    }
    // 状态向量不一样 = 有更新没送到（网络层丢了又没补）；一样而正文不一样才是合并的问题
    if (texts[index] !== texts[0]) {
      const same =
        replica.member.session.stateVector().join() ===
        replicas[0]!.member.session.stateVector().join();
      failures.push(`p${index} 和 p0 不一致（${same ? "状态向量相同" : "缺更新"}）`);
      if (process.env.COLLAB_FUZZ_DEBUG) {
        const vv = (r: Replica) =>
          JSON.stringify(Object.fromEntries(r.member.session.doc.oplogVersion().toJSON()));
        failures.push(`p${index}: ${vv(replica)} / p0: ${vv(replicas[0]!)}`);
        failures.push(`peers: ${replicas.map((r) => r.member.session.doc.peerIdStr).join(",")}`);
      }
    }
  });

  for (const replica of replicas) replica.view.destroy();
  hub.destroy();
  document.body.replaceChildren();
  return failures;
}

describe("收敛模糊测试", () => {
  it(
    `${ONLY_SEED === null ? ROUNDS : 1} 轮随机编辑 + 坏网络之后所有副本逐字一致`,
    async () => {
      const seeds =
        ONLY_SEED === null ? Array.from({ length: ROUNDS }, (_, index) => index + 1) : [ONLY_SEED];
      for (const seed of seeds) {
        const failures = await runRound(seed);
        // 让出一次宏任务：happy-dom 的 requestAnimationFrame 才跑得到。不让的话 CodeMirror 图层排下的
        // 测量请求一轮轮攒着，连着已经销毁的编辑器都放不掉，一万轮能把堆撑到 4GB（真浏览器每帧都清）
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (failures.length) {
          throw new Error(`种子 ${seed}：${failures.join("；")}（COLLAB_FUZZ_SEED=${seed} 重放）`);
        }
      }
      expect(seeds.length).toBeGreaterThan(0);
    },
    ROUNDS > 500 ? 3_600_000 : 120_000,
  );
});
