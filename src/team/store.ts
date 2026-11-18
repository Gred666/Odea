import { keepGuestCopy } from "@/collab/keep";
import { errorText } from "@/collab/net";
import { FIREWALL_FIX } from "@/collab/reach";
import type { CollabSession } from "@/collab/session";
import { conflictOriginalTitle } from "@/data/conflicts";
import { saveKeyOf, useData } from "@/data/store";
import { type DocumentModel, type DocumentRef, NOTE, isShared, vaultRef } from "@/data/types";
import { flushEditorsComposed, registerBeforeClose } from "@/editor/saveBus";
import { type Firewall, type TeamPeer, type TeamRelay, commands } from "@/lib/bindings";
import { isTauri } from "@/lib/tauri";
import { documentType } from "@/plugins/registry";
import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { TeamController, TeamDocSession, TeamIO, TeamView } from "./controller";
import { type TeamNet, tauriTeamNet } from "./net";

/* ============================================================
   这个仓库窗口里的团队（docs/协同编辑.md §22.4）：团队仓库打开时起团队端点、登记（initTeam），
   每个窗格（主窗口的、弹出窗口的）显示着哪一篇告诉 controller（useTeamView），controller 定的会话交给
   data/adapter 绑到编辑器上。
   团队的中继（仓库里的 .odea/relays）：没用过的问一句（TeamRelayToast），自己的中继可以给团队用（中继对话框）。
   第一次起团队端点时 Windows 会问防火墙：先说一句；挡着的话说怎么改

   controller 和 Loro 都在单独的分包里：个人仓库、浏览器预览里一行都不加载
   ============================================================ */

interface TeamState {
  /** 这是团队仓库、端点起来了 */
  active: boolean;
  /** 我（设备公钥）：「也在看」里不算自己 */
  me: string | null;
  peers: TeamPeer[];
  /** 文档 id → 会话（主持着的、做客的） */
  sessions: Record<string, TeamDocSession>;
  /** 仓库里写着的中继 */
  relays: TeamRelay[];
}

export const useTeam = create<TeamState>(() => ({
  active: false,
  me: null,
  peers: [],
  sessions: {},
  relays: [],
}));

async function unwrap<T>(
  request: Promise<{ status: "ok"; data: T } | { status: "error"; error: unknown }>,
): Promise<T> {
  const result = await request;
  if (result.status === "error") throw new Error(errorText(result.error));
  return result.data;
}

/** 重读仓库里写着的中继（同步拉来的可能变了） */
export async function refreshTeamRelays(): Promise<void> {
  if (!isTauri || !useTeam.getState().active) return;
  const relays = await unwrap(commands.teamRelays()).catch(() => null);
  if (relays) useTeam.setState({ relays });
}

/** 「这个团队仓库用中继 X，要用吗」 */
export async function answerTeamRelay(url: string, accept: boolean): Promise<void> {
  try {
    useTeam.setState({ relays: await unwrap(commands.teamRelayAnswer(url, accept)) });
  } catch (error) {
    useData.setState({ error: `中继没加上：${errorText(error)}` });
  }
}

/** 我的一台中继给不给团队用（写进仓库，随下一轮同步给成员） */
export async function shareTeamRelay(url: string, share: boolean): Promise<void> {
  try {
    useTeam.setState({ relays: await unwrap(commands.teamRelayShare(url, share)) });
  } catch (error) {
    useData.setState({ error: errorText(error) });
  }
}

/** 第一次起团队端点：Windows 防火墙还没问过的话马上会弹窗，先说一句；挡着的话说怎么改 */
function firewallNotice(firewall: Firewall): string | null {
  const kind = "public" in firewall && firewall.public ? "「公用」" : "「专用」";
  if (firewall.state === "notAsked") {
    return "团队仓库在后台和成员连着：Windows 马上会问要不要让 Odea 用网络，「专用」「公用」两个都勾上";
  }
  if (firewall.state === "blocked") {
    return `Windows 防火墙在这个${kind}网络上挡着 Odea：别的成员连不进来（你去连他们不受影响）。${FIREWALL_FIX}`;
  }
  return null;
}

let controller: TeamController | null = null;
let started = false;
/** 每个窗格报的「我这里显示着哪一篇」：窗格 id → 那一篇（docs/协同编辑.md §29.3） */
const views = new Map<string, TeamView>();

/** 文档 id 最长多少字节（Rust 那边 1 字节长度） */
const MAX_DOC_ID = 255;
const utf8 = new TextEncoder();

/**
 * 开着的那几篇上一次算出来的团队 id（按 keyOf(target)）。开着的时候不换：改了标题（文件跟着改名）、第一次存盘
 * 把 id 写进了属性块，都还是这一篇的那份会话 —— 换了 id 就成了另一篇，会话当场分成两份。
 * 以前只记一篇：分屏时两个窗格轮流算、互相挤掉，开着的那篇存一次盘 id 就变了。哪个窗格都不显示了才忘掉
 */
const openIds = new Map<string, string>();

/**
 * 这一篇在团队里的 id（docs/协同编辑.md §22.4）。笔记是属性块里的 id（`note-<id>`）：改名、挪位置都不变，
 * 每台设备上都一样（随 git 走）。属性块里没写 id 的（别的工具建的、扔进来的）退回相对路径 ——
 * 索引给它的 id 只在本机，换台设备就对不上；git 同步的仓库里两边路径一样。
 * 插件的文档照插件说的（某一天 `day-2026-11-03`、目标 `goal-week-2026-11-02`，和老版本一字不差）。做客的那篇没有
 */
export function teamDocId(doc: DocumentModel): string | null {
  const target = doc.editor?.target;
  // 文件不是 UTF-8 的只能看（docs/REVIEWS/2026-11-10-审查与竞品调研.md §5.1）：不进团队的会话，别人改的存不进去
  if (!target || isShared(target) || doc.notUtf8) return null;
  const key = keyOf(target);
  const known = openIds.get(key);
  if (known) return known;
  const id = teamIdOf(target, doc.relPath, doc.idInFile ?? false);
  if (id) openIds.set(key, id);
  return id;
}

function teamIdOf(
  target: DocumentRef,
  relPath: string | undefined,
  idInFile: boolean,
): string | null {
  const id =
    target.type === NOTE
      ? idInFile
        ? `note-${target.key}`
        : (relPath ?? null)
      : (documentType(target.type)?.teamId(target.key) ?? null);
  return id && utf8.encode(id).length <= MAX_DOC_ID ? id : null;
}

/**
 * 协作要主持团队仓库里的一篇（「邀请协作…」请外人，设计 §22.5 最后一段）：借团队那份会话。
 * 不是团队仓库、算不出 id、借不到是 null（协作照旧自己建一份）
 */
export async function holdTeamDoc(
  target: DocumentRef,
  note: { relPath: string; idInFile: boolean } | undefined,
): Promise<{ session: CollabSession; release: () => void } | null> {
  // 编辑器里正开着这一篇：用开着时定下的那个 id（和团队那边的会话对得上）
  const doc =
    openIds.get(keyOf(target)) ?? teamIdOf(target, note?.relPath, note?.idInFile ?? false);
  const owner = controller;
  if (!doc || !owner) return null;
  const session = await owner.hold({ doc, target });
  if (!session) return null;
  let released = false;
  return {
    session,
    release: () => {
      if (released) return;
      released = true;
      owner.release(doc);
    },
  };
}

/** 这一篇现在在团队的哪一份会话里（主持着的、做客的）；不在会话里是 undefined */
function teamSessionOf(target: DocumentRef): TeamDocSession | undefined {
  const note =
    target.type === NOTE
      ? [...useData.getState().notes, ...useData.getState().archived].find(
          (item) => item.id === target.key,
        )
      : undefined;
  const doc =
    openIds.get(keyOf(target)) ?? teamIdOf(target, note?.relPath, note?.idInFile ?? false);
  return doc ? useTeam.getState().sessions[doc] : undefined;
}

/**
 * 历史版本的「恢复」（data/store.ts 的 restoreVersion，审查 2026-11-13 §5.8）：团队仓库里别人在主持这一篇时，
 * 正文的真相是会话、存盘的是他 —— 只写自己的磁盘的话正文不动、别人看不到，git 下一轮还可能把别人后来的字合没。
 * 把「现在 → 旧版」当一个从会话现在的版本分叉出去的协作者合进会话（collab/external.ts，和外部改动一样），大家都看到。
 * 撤销从恢复后那一刻的版本分叉、把「恢复后 → 恢复前」合进去：只撤恢复那一下，之后谁打的字都还在；
 * 会话已经收掉了返回 false（调用方照一个人编辑时的做法换回去）。
 * 不是别人主持的（自己主持的外部改动本来就合进会话；没在会话里）返回 null：照旧写自己的磁盘
 */
export async function restoreInTeam(
  target: DocumentRef,
  body: string,
): Promise<{ before: string; undo: () => boolean } | null> {
  const shared = teamSessionOf(target);
  if (!shared?.remote) return null;
  const { mergeExternal, snapshot } = await import("@/collab/external");
  const { session } = shared;
  const before = session.toString();
  if (before !== body) mergeExternal(session, snapshot(session), body);
  const after = snapshot(session);
  return {
    before,
    undo: () => {
      if (teamSessionOf(target)?.session !== session) return false;
      mergeExternal(session, after, before);
      return true;
    },
  };
}

/** 数据层里这一篇现在的正文（插件的文档在插件的缓存里） */
async function bodyOf(target: DocumentRef): Promise<string | undefined> {
  if (target.type === NOTE) return useData.getState().loadBody(target.key);
  return documentType(target.type)?.body(target.key);
}

function bodyNow(target: DocumentRef): string | undefined {
  if (target.type === NOTE) return useData.getState().bodies[target.key];
  return documentType(target.type)?.body(target.key);
}

const keyOf = saveKeyOf;

const io: TeamIO = {
  // 加入、接手主持之前存：等组完字，不然拼音当本机那一版三方合进会话（docs/协同编辑.md §27.5）
  flush: flushEditorsComposed,
  load: bodyOf,
  save: (target, text, seen) => {
    // 会话没见过磁盘上的那一版（加入时没合进去）：照着 seen 存，磁盘上不是它就先另存冲突副本
    if (seen !== undefined) useData.getState().markConflict(target, seen);
    return useData.getState().saveDocument(target, text);
  },
  // 做客时主持人还没存下的字本机另留一份（docs/协同编辑.md §24）：放在应用数据目录，按仓库 + 文档认
  keep: (link, target, doc, host) => {
    const vault = useData.getState().vaultRoot;
    return keepGuestCopy(link, {
      key: `team:${vault ?? ""}:${doc}`,
      title: () => conflictOriginalTitle(target, useData.getState()) ?? doc,
      host,
      vault,
      target,
    });
  },
  onExternal: (target, listener) => {
    const key = keyOf(target);
    return useData.subscribe((state, previous) => {
      if (state.externalRevisions[key] === previous.externalRevisions[key]) return;
      const disk = bodyNow(target);
      if (disk !== undefined) listener(disk);
    });
  },
};

/** 仓库窗口起来了、知道是团队仓库：起端点、登记。浏览器预览里没有团队端点 */
export async function initTeam(net: TeamNet = tauriTeamNet): Promise<void> {
  if (started || (!isTauri && net === tauriTeamNet)) return;
  started = true;
  try {
    const self = await net.start();
    if (!self) {
      started = false;
      return;
    }
    const [{ TeamController }] = await Promise.all([
      import("./controller"),
      import("@/collab/loro").then((loro) => loro.ensureLoro()),
    ]);
    const owner = new TeamController(net, self, io, (snapshot) =>
      useTeam.setState({ peers: snapshot.peers, sessions: snapshot.sessions }),
    );
    controller = owner;
    // 交给这一个 controller，不是「现在的那个」：收掉以后这条网络晚到的事件不会落到下一个 controller 身上
    await net.openPipe((frame) => owner.receive(frame));
    await net.onControl((control) => owner.control(control));
    // 起端点到开始听之间连上的人、发的 Presence 没听到：要一次现在的
    const peers = await net.peers().catch(() => null);
    if (peers) owner.control({ type: "peers", peers });
    useTeam.setState({ active: true, me: self.id, peers: owner.snapshot().peers });
    owner.views(currentViews());
    // 关窗口：主持着的先存、先说不主持了再断开 —— 别人马上接手，不用等 10 秒（当成断线）
    registerBeforeClose(() => owner.destroy());
    const notice = firewallNotice(self.firewall);
    if (notice) useData.setState({ notice });
    if (net === tauriTeamNet) {
      void refreshTeamRelays();
      // 同步完一轮：仓库里的中继可能变了（别人加了一台）
      useData.subscribe((state, previous) => {
        if (state.syncStatus.lastSyncedAt !== previous.syncStatus.lastSyncedAt)
          void refreshTeamRelays();
      });
    }
  } catch (error) {
    started = false;
    console.error("团队：起不来", error);
  }
}

/**
 * 加入这一篇时没合进会话的本机那一版（docs/协同编辑.md §28）：快照里只说有没有（`unseenFrom`），
 * 正文点「看我的那一版」时才从 controller 取。没有了（另存成冲突副本、会话收了）是 null
 */
export function teamUnseenText(doc: string): string | null {
  return controller?.unseenText(doc) ?? null;
}

/** 「知道了」：这一次加入期间不再提示 */
export function hideTeamUnseen(doc: string): void {
  controller?.hideUnseen(doc);
}

/** 现在显示着的那几篇（同一篇开在两个窗格里只算一次） */
function currentViews(): TeamView[] {
  return [...new Map([...views.values()].map((view) => [view.doc, view])).values()];
}

/** 攒到下一个任务再交给 controller（见 setTeamView） */
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 窗格 source 现在显示着哪一篇（正文到了才算；null：不是能协作的文档、窗格关了）。
 * 攒到下一个任务再交给 controller：一个窗格摘下又挂上（重新渲染）、一篇从一个窗格挪到另一个，中间那一下
 * 不算「不看了」—— 不然先退出会话、马上又加入一次
 */
export function setTeamView(source: string, view: TeamView | null): void {
  if (view) views.set(source, view);
  else views.delete(source);
  flushTimer ??= setTimeout(() => {
    flushTimer = null;
    // 哪个窗格都不显示了的那几篇：忘掉开着时定下的 id，下次打开重新算
    const open = new Set([...views.values()].map((each) => keyOf(each.target)));
    for (const key of openIds.keys()) if (!open.has(key)) openIds.delete(key);
    controller?.views(currentViews());
  }, 0);
}

/**
 * 窗格里显示着的这一篇报给团队（docs/协同编辑.md §22.4、§29.3）：别人也开着就进同一份会话，「也在看」里有我。
 * 主窗口的每个窗格、弹出窗口的每个窗格都报，不只正在写的那个；窗格关了撤掉
 */
export function useTeamView(source: string, doc: DocumentModel): void {
  const teamDoc = teamDocId(doc);
  const target = useRef(doc.editor?.target);
  target.current = doc.editor?.target;
  useEffect(() => {
    const ref = vaultRef(target.current);
    setTeamView(source, teamDoc && ref ? { doc: teamDoc, target: ref } : null);
  }, [source, teamDoc]);
  useEffect(() => () => setTeamView(source, null), [source]);
}

/** 测试：收掉 */
export async function resetTeam(): Promise<void> {
  await controller?.destroy();
  controller = null;
  started = false;
  views.clear();
  openIds.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  useTeam.setState({ active: false, me: null, peers: [], sessions: {}, relays: [] });
}
