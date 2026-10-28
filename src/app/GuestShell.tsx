import { useApp } from "@/app/store";
import { hostNameOf, sessionName, useCollab } from "@/collab/store";
import { CollabDialog, PeerAvatar, SharedTree } from "@/components/CollabDialog";
import { DocumentView } from "@/components/DocumentView";
import { EmptyState } from "@/components/EmptyArt";
import { ErrorToast, NoticeToast } from "@/components/ErrorToast";
import { RelayDialog } from "@/components/RelayDialog";
import { TitleBar } from "@/components/TitleBar";
import { useCurrentDocument } from "@/data/adapter";
import { cn } from "@/lib/cn";
import { MotionConfig } from "motion/react";
import { useShallow } from "zustand/react/shallow";

/* ============================================================
   协作的访客窗口（docs/仓库与启动器.md §13，P11.4）：不开仓库，只有别人共享的那一篇。
   启动器「加入协同编辑」、一个仓库窗口都没开着时点的邀请链接，开的都是它。

   - 一开就是加入对话框（链接已经填好：collab/store 的 openLink）；进去了正文区就是共享的那一篇，
     和仓库窗口里做客时一模一样（data/adapter 给的是同一个 shared 文档）
   - 共享的是一个文件夹、整个仓库（docs/协同编辑.md §22.5）：左边是主持人给的树，点哪篇开哪篇。
     同时在好几个人那里做客（§25）：左边按会话分开，一次一段（主持人、共享的是什么，下面是那棵树或者那一篇）
   - 「存一份到我的笔记」交给最近用过的仓库窗口去存（collab/store 的 saveCopy），那个窗口打开它
   - 离开了、对方停止了，那一篇照旧留着，还能存一份；关窗口就是离开（Rust 的 win_force_close）
   ============================================================ */

export function GuestShell() {
  const reduceMotion = useApp((s) => s.reduceMotion);
  const doc = useCurrentDocument();
  const shared = doc.editor?.target.kind === "shared";
  // 进去了的几个做客的会话
  const guests = useCollab(
    useShallow((s) =>
      s.order.filter((id) => s.sessions[id]?.role === "guest" && s.sessions[id]?.phase === "guest"),
    ),
  );
  const folders = useCollab((s) =>
    guests.some((id) => {
      const scope = s.sessions[id]?.scope;
      return !!scope && scope.kind !== "doc";
    }),
  );
  // 一个文件夹 / 整个仓库，或者同时在好几个人那里：左边一栏
  const sidebar = folders || guests.length > 1;

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
      <div className="relative flex h-full w-full overflow-hidden bg-canvas">
        <TitleBar />
        {sidebar && (
          <aside
            className={cn(
              "flex h-full w-[248px] shrink-0 flex-col gap-3 border-r border-line bg-rail px-2 pt-[46px] pb-3",
              guests.length > 1 && "scroll-thin overflow-y-auto",
            )}
          >
            {guests.map((id) => (
              <GuestSection key={id} id={id} fill={guests.length === 1} />
            ))}
          </aside>
        )}
        <div className="relative min-w-0 flex-1">
          {shared ? (
            // 共享的那一篇不经这里存（会话自己同步、主持人那边落盘）：给个空的，编辑器才挂得上
            <DocumentView doc={doc} onToggleTask={noop} onSaveDocument={done} onSaveTitle={done} />
          ) : (
            <Waiting />
          )}
          <div className="pointer-events-none absolute inset-x-0 bottom-[72px] z-40 flex flex-col items-center gap-2 px-6">
            <ErrorToast />
            <NoticeToast />
          </div>
        </div>
        <CollabDialog />
        {/* 在协作对话框之上：连不上时从协作对话框里「配中继…」打开 */}
        <RelayDialog />
      </div>
    </MotionConfig>
  );
}

/** 左边一栏里的一个会话：谁共享的、共享的是什么；文件夹、整个仓库下面是树，一篇的就是那一篇 */
function GuestSection({ id, fill }: { id: number; fill: boolean }) {
  const session = useCollab((s) => s.sessions[id]);
  const shownHere = useCollab((s) => s.showShared && s.shownSession === id);
  const setShowShared = useCollab((s) => s.setShowShared);
  const openSession = useCollab((s) => s.openSession);
  if (!session) return null;
  const host = session.members.find((member) => member.host);
  const single = session.scope?.kind === "doc";
  const ended = session.status?.state === "ended";
  return (
    <section className={cn("flex flex-col", fill && !single && "min-h-0 flex-1")}>
      <button
        type="button"
        onClick={() => openSession(id)}
        title="这次协作"
        className="flex h-8 items-center gap-2 rounded-md px-2 text-left transition-colors duration-[140ms] hover:bg-raised/60"
      >
        {host && <PeerAvatar id={host.id} name={host.name} />}
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
          {hostNameOf(session)}
          <span className="font-normal text-faint">{ended ? " · 已结束" : ""}</span>
        </span>
      </button>
      {single ? (
        <button
          type="button"
          onClick={() => setShowShared(true, id)}
          className={cn(
            "flex h-8 w-full items-center rounded-md px-2 text-left text-[13px] transition-colors duration-[140ms]",
            shownHere ? "bg-raised text-ink" : "text-body hover:bg-raised/60",
          )}
        >
          <span className="min-w-0 truncate">{sessionName(session)}</span>
        </button>
      ) : (
        <>
          <p className="truncate px-2 pb-1 text-[11.5px] text-faint" title={session.scope?.name}>
            {sessionName(session)}
          </p>
          <SharedTree id={id} compact />
        </>
      )}
    </section>
  );
}

const noop = () => {};
const done = () => Promise.resolve();

/** 还没进去：正在加入，或者对话框被关了（再点一下打开）；进了文件夹、还没开哪一篇 */
function Waiting() {
  const openDialog = useCollab((s) => s.openDialog);
  const joining = useCollab((s) => s.order.some((id) => s.sessions[id]?.phase === "joining"));
  const browsing = useCollab((s) =>
    s.order.some((id) => {
      const session = s.sessions[id];
      return session?.phase === "guest" && session.scope?.kind !== "doc";
    }),
  );
  const inside = useCollab((s) => s.order.some((id) => s.sessions[id]?.phase === "guest"));
  // 进了一个文件夹、还没开哪一篇（或者收起了正在看的那篇）：左边挑
  if (browsing || inside) {
    return (
      <div className="flex h-full items-center justify-center px-8">
        <EmptyState
          art="notes"
          title="挑一篇打开"
          hint="左边是对方共享的笔记。这些不会存进哪个仓库，想留着就打开它「存一份到我的笔记」。"
        />
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center px-8">
      <EmptyState
        art="notes"
        title={joining ? "正在加入…" : "加入别人的协作"}
        hint="粘贴别人发来的邀请链接。这一篇不会存进哪个仓库，想留着就「存一份到我的笔记」。"
        action={joining ? undefined : { label: "粘贴邀请链接", onClick: () => openDialog("") }}
      />
    </div>
  );
}
