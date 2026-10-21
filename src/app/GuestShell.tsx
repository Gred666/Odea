import { useApp } from "@/app/store";
import { useCollab } from "@/collab/store";
import { CollabDialog } from "@/components/CollabDialog";
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
   - 「存一份到我的笔记」交给最近用过的仓库窗口去存（collab/store 的 saveCopy），那个窗口打开它
   - 离开了、对方停止了，那一篇照旧留着，还能存一份；关窗口就是离开（Rust 的 win_force_close）
   ============================================================ */

export function GuestShell() {
  const reduceMotion = useApp((s) => s.reduceMotion);
  const doc = useCurrentDocument();
  const shared = doc.editor?.target.kind === "shared";

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
      <div className="relative flex h-full w-full overflow-hidden bg-canvas">
        <TitleBar />
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
