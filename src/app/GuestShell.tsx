import { useApp } from "@/app/store";
import { useCollab } from "@/collab/store";
import { CollabDialog, SharedTree } from "@/components/CollabDialog";
import { DocumentView } from "@/components/DocumentView";
import { EmptyState } from "@/components/EmptyArt";
import { ErrorToast, NoticeToast } from "@/components/ErrorToast";
import { RelayDialog } from "@/components/RelayDialog";
import { TitleBar } from "@/components/TitleBar";
import { useCurrentDocument } from "@/data/adapter";
import { MotionConfig } from "motion/react";

/* ============================================================
   协作的访客窗口（docs/仓库与启动器.md §13，P11.4）：不开仓库，只有别人共享的那一篇。
   启动器「加入协同编辑」、一个仓库窗口都没开着时点的邀请链接，开的都是它。

   - 一开就是加入对话框（链接已经填好：collab/store 的 openLink）；进去了正文区就是共享的那一篇，
     和仓库窗口里做客时一模一样（data/adapter 给的是同一个 shared 文档）
   - 共享的是一个文件夹、整个仓库（docs/协同编辑.md §22.5）：左边是主持人给的树，点哪篇开哪篇
   - 「存一份到我的笔记」交给最近用过的仓库窗口去存（collab/store 的 saveCopy），那个窗口打开它
   - 离开了、对方停止了，那一篇照旧留着，还能存一份；关窗口就是离开（Rust 的 win_force_close）
   ============================================================ */

export function GuestShell() {
  const reduceMotion = useApp((s) => s.reduceMotion);
  const doc = useCurrentDocument();
  const shared = doc.editor?.target.kind === "shared";
  const scope = useCollab((s) => s.scope);
  const phase = useCollab((s) => s.phase);
  const many = phase === "guest" && !!scope && scope.kind !== "doc";

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
      <div className="relative flex h-full w-full overflow-hidden bg-canvas">
        <TitleBar />
        {many && (
          <aside className="flex h-full w-[248px] shrink-0 flex-col border-r border-line bg-rail px-2 pt-[46px] pb-3">
            <p className="truncate px-2 pb-2 text-[12.5px] font-medium text-ink" title={scope.name}>
              {scope.name}
            </p>
            <SharedTree compact />
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

const noop = () => {};
const done = () => Promise.resolve();

/** 还没进去：正在加入，或者对话框被关了（再点一下打开） */
function Waiting() {
  const phase = useCollab((s) => s.phase);
  const openDialog = useCollab((s) => s.openDialog);
  const scope = useCollab((s) => s.scope);
  // 进了一个文件夹、还没开哪一篇：左边挑
  if (phase === "guest" && scope && scope.kind !== "doc") {
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
        title={phase === "joining" ? "正在加入…" : "加入别人的协作"}
        hint="粘贴别人发来的邀请链接。这一篇不会存进哪个仓库，想留着就「存一份到我的笔记」。"
        action={
          phase === "joining" ? undefined : { label: "粘贴邀请链接", onClick: () => openDialog() }
        }
      />
    </div>
  );
}
