import { errorText } from "@/collab/net";
import { FIREWALL_FIX } from "@/collab/reach";
import type { CollabSession } from "@/collab/session";
import { useData } from "@/data/store";
import { type DocumentModel, type DocumentSaveTarget, goalKey } from "@/data/types";
import { flushAllEditors } from "@/editor/saveBus";
import { type Firewall, type TeamPeer, type TeamRelay, commands } from "@/lib/bindings";
import { isTauri } from "@/lib/tauri";
import { create } from "zustand";
import type { TeamController, TeamDocSession, TeamIO, TeamView } from "./controller";
import { type TeamNet, tauriTeamNet } from "./net";

/* ============================================================
   这个仓库窗口里的团队（docs/协同编辑.md §22.4）：团队仓库打开时起团队端点、登记（initTeam），
   编辑器里换了哪一篇告诉 controller（setTeamView），controller 定的会话交给 data/adapter 绑到编辑器上。
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
let pendingView: TeamView | null = null;

/** 文档 id 最长多少字节（Rust 那边 1 字节长度） */
const MAX_DOC_ID = 255;
const utf8 = new TextEncoder();

/** 这一篇在团队里的 id：笔记是相对路径（git 同步的仓库里两边一样），某一天、目标按日期。做客的那篇没有 */
export function teamDocId(doc: DocumentModel): string | null {
  const target = doc.editor?.target;
  if (!target || target.kind === "shared") return null;
  return teamIdOf(target, doc.relPath);
}

function teamIdOf(target: DocumentSaveTarget, relPath: string | undefined): string | null {
  const id =
    target.kind === "note"
      ? (relPath ?? null)
      : target.kind === "day"
        ? `day-${target.id}`
        : `goal-${target.horizon}-${target.periodStart}`;
  return id && utf8.encode(id).length <= MAX_DOC_ID ? id : null;
}

/**
 * 协作要主持团队仓库里的一篇（「邀请协作…」请外人，设计 §22.5 最后一段）：借团队那份会话。
 * 不是团队仓库、算不出 id、借不到是 null（协作照旧自己建一份）
 */
export async function holdTeamDoc(
  target: DocumentSaveTarget,
  relPath: string | undefined,
): Promise<{ session: CollabSession; release: () => void } | null> {
  const doc = teamIdOf(target, relPath);
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

/** 数据层里这一篇现在的正文 */
async function bodyOf(target: DocumentSaveTarget): Promise<string | undefined> {
  const data = useData.getState();
  if (target.kind === "note") return data.loadBody(target.id);
  if (target.kind === "day") return data.dayDocs.find((day) => day.date === target.id)?.noteMd;
  return data.goals[goalKey(target.horizon, target.periodStart)]?.contentMd;
}

function bodyNow(target: DocumentSaveTarget): string | undefined {
  const data = useData.getState();
  if (target.kind === "note") return data.bodies[target.id];
  if (target.kind === "day") return data.dayDocs.find((day) => day.date === target.id)?.noteMd;
  return data.goals[goalKey(target.horizon, target.periodStart)]?.contentMd;
}

const keyOf = (target: DocumentSaveTarget) =>
  target.kind === "goal"
    ? `goal:${goalKey(target.horizon, target.periodStart)}`
    : `${target.kind}:${target.id}`;

const io: TeamIO = {
  flush: flushAllEditors,
  load: bodyOf,
  save: (target, text) => useData.getState().saveDocument(target, text),
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
    controller = new TeamController(net, self, io, (snapshot) =>
      useTeam.setState({ peers: snapshot.peers, sessions: snapshot.sessions }),
    );
    await net.openPipe((frame) => controller?.receive(frame));
    await net.onControl((control) => controller?.control(control));
    useTeam.setState({ active: true, me: self.id, peers: self.peers });
    controller.view(pendingView);
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

/** 编辑器里现在是哪一篇（正文到了才算） */
export function setTeamView(view: TeamView | null): void {
  pendingView = view;
  controller?.view(view);
}

/** 测试：收掉 */
export async function resetTeam(): Promise<void> {
  await controller?.destroy();
  controller = null;
  started = false;
  pendingView = null;
  useTeam.setState({ active: false, me: null, peers: [], sessions: {}, relays: [] });
}
