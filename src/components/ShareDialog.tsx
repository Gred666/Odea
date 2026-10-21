import type { Role, ShareInfo, ShareMember, ShareRequest } from "@/lib/bindings";
import { cn } from "@/lib/cn";
import { popoverCard, tween } from "@/lib/motion";
import { isShareLink, useShare } from "@/share/store";
import { Check, Copy, FolderPlus, LoaderCircle, RefreshCw, Users, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { PeerAvatar } from "./CollabDialog";

/* ============================================================
   共享仓库（docs/协同编辑.md §20）：命令面板「共享这个仓库…」「加入共享仓库…」、点开 odea://share/ 链接。

   ShareDialog（这个仓库）：
   - 没共享：说清楚是什么、要什么（逻辑目录、不开同步、不在网盘里），「共享这个仓库」
   - 共享了：邀请链接（管理员）、等确认的人、成员（在不在线、角色；管理员能改、能移出）、
     「这台设备不再共享」。加入中、被拒、被移出时顶上一句话说清楚
   ShareJoinDialog：粘贴链接 → 看一眼是哪个仓库、进去是什么角色 → 选放在哪（新窗口里打开）
   ShareRequests：对话框关着时，有人来敲门的卡片（和协作的一样，只淡 opacity）
   外壳和协作对话框一样：遮罩 + 从标题栏往下展开的实心卡片（popoverCard）。
   ============================================================ */

const HEADER = 52;

export const ROLE_TEXT: Record<Role, string> = {
  admin: "管理员",
  edit: "可编辑",
  read: "只读",
};

function useEscape(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);
}

function Shell({
  open,
  label,
  title,
  icon,
  onClose,
  children,
  data,
}: {
  open: boolean;
  label: string;
  title: string;
  icon: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  data: string;
}) {
  useEscape(open, onClose);
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            key="scrim"
            type="button"
            data-ghost-skip
            aria-label={`关闭${label}`}
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={tween.base}
            className="fixed inset-0 z-[55] cursor-default bg-ink/[0.14] backdrop-blur-[3px]"
          />
          <div
            key="panel"
            data-ghost-skip
            className="pointer-events-none fixed inset-0 z-[55] flex items-start justify-center pt-[14vh]"
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label={label}
              {...{ [data]: "" }}
              custom={HEADER}
              variants={popoverCard}
              initial="hidden"
              animate="shown"
              exit="gone"
              className="pointer-events-auto relative w-[500px] max-w-[calc(100vw-48px)]
                         overflow-clip rounded-2xl bg-canvas shadow-modal ring-1 ring-line-strong"
            >
              <div
                className="flex items-center gap-2.5 border-b border-line px-4"
                style={{ height: HEADER }}
              >
                {icon}
                <p className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{title}</p>
                <button
                  type="button"
                  aria-label="关闭"
                  onClick={onClose}
                  className="grid h-7 w-7 place-items-center rounded-md text-muted
                             transition-colors duration-[140ms] hover:bg-raised hover:text-ink"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </div>
              <div className="scroll-thin max-h-[64vh] overflow-y-auto px-5 py-4">{children}</div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

export function ShareDialog() {
  const open = useShare((s) => s.dialogOpen);
  const close = useShare((s) => s.closeDialog);
  const info = useShare((s) => s.info);
  return (
    <Shell
      open={open}
      label="共享仓库"
      data="data-share-dialog"
      title={info ? `共享仓库 · ${info.name}` : "共享这个仓库"}
      icon={<Users size={15} strokeWidth={2} className="shrink-0 text-faint" />}
      onClose={close}
    >
      {info ? <SharedBody info={info} /> : <NotSharedBody />}
    </Shell>
  );
}

function ErrorLine() {
  const error = useShare((s) => s.error);
  if (!error) return null;
  return <p className="text-[12.5px] leading-[1.7] text-danger">{error}</p>;
}

function NotSharedBody() {
  const create = useShare((s) => s.create);
  const busy = useShare((s) => s.busy);
  return (
    <div className="flex flex-col gap-3.5">
      <p className="text-[12.5px] leading-[1.75] text-body">
        整个仓库和别人、和自己的别的设备一直保持同步：谁改了哪篇、挪了哪个文件夹，连着的人那里马上跟着变；
        谁不在线，下次连上时补齐，同时改的地方逐字合在一起。不经过任何服务器，笔记还是这个文件夹里的
        .md 文件。
      </p>
      <ul className="flex flex-col gap-1 text-[12px] leading-[1.7] text-muted">
        <li>· 要是逻辑目录的仓库；开着同步（GitHub / Gitee）的先断开 —— 共享和同步二选一</li>
        <li>· 不能放在网盘的同步目录里</li>
        <li>· 你是管理员：发邀请链接、同意谁进来、给可编辑或只读</li>
        <li>· 大家不同时在线就合不上：放一台常开的设备当成员最省心</li>
      </ul>
      <ErrorLine />
      <div className="flex justify-end">
        <button
          type="button"
          data-share-create
          disabled={busy}
          onClick={() => void create()}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-medium
                     text-accent-ink transition-colors duration-[140ms] hover:bg-accent-hover disabled:opacity-60"
        >
          {busy && <LoaderCircle size={13} strokeWidth={2} className="animate-spin" />}
          {busy ? "正在把每一篇读进来…" : "共享这个仓库"}
        </button>
      </div>
    </div>
  );
}

function stateText(info: ShareInfo): { text: string; tone: "muted" | "warning" | "danger" } | null {
  switch (info.state.state) {
    case "joining":
      return info.state.waiting
        ? { text: "连上了邀请人，等他同意…", tone: "muted" }
        : { text: "正在连邀请人… 他得开着 Odea、打开着这个仓库", tone: "muted" };
    case "rejected": {
      const reason = info.state.reason;
      const text =
        reason === "declined"
          ? "对方拒绝了。要再试的话让他重新发一个邀请链接"
          : reason === "notMember"
            ? "邀请链接作废了（被重置过）。让对方重新发一个"
            : typeof reason === "object"
              ? "两边的 Odea 版本对不上，先都升级到最新"
              : "对方那里没有这个共享仓库了";
      return { text, tone: "danger" };
    }
    case "removed":
      return {
        text: "你被移出了这个共享仓库。这里的文件都还在，只是不再和大家同步",
        tone: "warning",
      };
    case "ready":
      return null;
  }
}

function SharedBody({ info }: { info: ShareInfo }) {
  const leave = useShare((s) => s.leave);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const notice = stateText(info);
  const admin = info.role === "admin";
  const online = info.members.filter((member) => member.online && !member.me).length;
  return (
    <div className="flex flex-col gap-4">
      {notice && (
        <p
          data-share-state
          className={cn(
            "rounded-lg px-3 py-2 text-[12.5px] leading-[1.7]",
            notice.tone === "danger"
              ? "bg-danger/10 text-danger"
              : notice.tone === "warning"
                ? "bg-warning/10 text-body"
                : "bg-raised text-body",
          )}
        >
          {info.state.state === "joining" && (
            <LoaderCircle
              size={12}
              strokeWidth={2}
              className="mr-1.5 inline animate-spin align-[-1px]"
            />
          )}
          {notice.text}
        </p>
      )}
      {info.state.state === "ready" && (
        <p className="text-[12.5px] leading-[1.7] text-muted">
          你是{ROLE_TEXT[info.role ?? "read"]}
          {online ? ` · ${online} 人在线` : " · 现在没有别人在线，改动先记在这台设备上"}
        </p>
      )}
      {admin && <InviteSection />}
      {admin && info.requests.length > 0 && <RequestList requests={info.requests} />}
      {info.members.length > 0 && <MemberList members={info.members} editable={admin} />}
      <ErrorLine />
      <div className="flex items-center gap-2 border-t border-line pt-3">
        <span className="flex-1 text-[12px] leading-[1.6] text-faint">
          {confirmLeave ? "这台设备不再同步，文件都留着。之后想回来要重新被邀请" : ""}
        </span>
        {confirmLeave ? (
          <>
            <button
              type="button"
              onClick={() => setConfirmLeave(false)}
              className="rounded-md px-2.5 py-1 text-[12.5px] text-body transition-colors duration-[140ms] hover:bg-raised"
            >
              取消
            </button>
            <button
              type="button"
              data-share-leave-confirm
              onClick={() => void leave()}
              className="rounded-md bg-danger/10 px-2.5 py-1 text-[12.5px] font-medium text-danger
                         transition-colors duration-[140ms] hover:bg-danger/15"
            >
              不再共享
            </button>
          </>
        ) : (
          <button
            type="button"
            data-share-leave
            onClick={() => setConfirmLeave(true)}
            className="rounded-md px-2.5 py-1 text-[12.5px] text-muted transition-colors duration-[140ms] hover:bg-raised"
          >
            这台设备不再共享…
          </button>
        )}
      </div>
    </div>
  );
}

function InviteSection() {
  const link = useShare((s) => s.inviteLink);
  const loadInvite = useShare((s) => s.loadInvite);
  const resetInvite = useShare((s) => s.resetInvite);
  const [copied, setCopied] = useState(false);
  const [role, setRole] = useState<Role>("edit");
  // biome-ignore lint/correctness/useExhaustiveDependencies: 打开时取一次
  useEffect(() => {
    if (!link) void loadInvite();
  }, []);
  const copy = async () => {
    if (!link) return;
    await navigator.clipboard
      .writeText(
        `${link}\n这是 Odea 共享仓库的邀请链接：用 Odea 打开它，选好放在哪就加入了（我这边要同意）。`,
      )
      .catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <section>
      <p className="mb-1.5 text-[12px] text-faint">邀请链接（拿着它的人来了还要你同意）</p>
      <div className="flex h-10 items-center gap-2 rounded-lg bg-raised pl-3 pr-1">
        <span data-share-link className="flex-1 truncate font-mono text-[12px] text-body">
          {link ?? "正在生成…"}
        </span>
        <button
          type="button"
          disabled={!link}
          onClick={() => void copy()}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-accent px-2.5
                     text-[12.5px] font-medium text-accent-ink transition-colors
                     duration-[140ms] hover:bg-accent-hover disabled:opacity-50"
        >
          {copied ? <Check size={13} strokeWidth={2.2} /> : <Copy size={13} strokeWidth={2} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[12px] text-muted">
        <span className="flex-1">发出去过的想作废：重置一个新的</span>
        <select
          aria-label="进来以后默认的角色"
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
          className="rounded-md bg-transparent px-1 py-0.5 text-[12px] text-body hover:bg-raised"
        >
          <option value="edit">默认可编辑</option>
          <option value="read">默认只读</option>
        </select>
        <button
          type="button"
          onClick={() => void resetInvite(role)}
          className="flex items-center gap-1 rounded-md px-1.5 py-[3px] text-[12px] text-body
                     transition-colors duration-[140ms] hover:bg-raised"
        >
          <RefreshCw size={11} strokeWidth={2} />
          重置
        </button>
      </div>
    </section>
  );
}

function AnswerButtons({
  onAnswer,
  inverted,
}: { onAnswer: (role: Role | null) => void; inverted?: boolean }) {
  const base = "shrink-0 rounded-md px-2 py-1 text-[12px] transition-colors duration-[140ms]";
  return (
    <>
      <button
        type="button"
        data-share-allow
        onClick={() => onAnswer("edit")}
        className={cn(
          base,
          "font-medium",
          inverted
            ? "bg-canvas text-ink hover:bg-canvas/85"
            : "bg-accent text-accent-ink hover:bg-accent-hover",
        )}
      >
        允许编辑
      </button>
      <button
        type="button"
        onClick={() => onAnswer("read")}
        className={cn(
          base,
          inverted ? "text-canvas hover:bg-canvas/15" : "text-body hover:bg-raised",
        )}
      >
        只读
      </button>
      <button
        type="button"
        onClick={() => onAnswer(null)}
        className={cn(
          base,
          inverted ? "text-canvas/70 hover:bg-canvas/15" : "text-muted hover:bg-raised",
        )}
      >
        拒绝
      </button>
    </>
  );
}

function RequestList({ requests }: { requests: ShareRequest[] }) {
  const answer = useShare((s) => s.answer);
  return (
    <section>
      <p className="mb-1.5 text-[12px] text-faint">想加入的人</p>
      <ul className="flex flex-col">
        {requests.map((request) => (
          <li key={request.request} data-share-request className="flex h-10 items-center gap-2.5">
            <PeerAvatar id={request.id} name={request.name} />
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{request.name}</span>
            <AnswerButtons onAnswer={(role) => void answer(request.request, role)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function MemberList({ members, editable }: { members: ShareMember[]; editable: boolean }) {
  const setRole = useShare((s) => s.setRole);
  return (
    <section>
      <p className="mb-1.5 text-[12px] text-faint">成员 · {members.length}</p>
      <ul className="flex flex-col">
        {members.map((member) => (
          <li key={member.id} data-share-member className="flex h-9 items-center gap-2.5">
            <span className="relative">
              <PeerAvatar id={member.id} name={member.name} />
              {/* 在线的小点：静态，不做动画 */}
              <span
                aria-hidden
                className={cn(
                  "absolute -bottom-px -right-px size-[7px] rounded-full ring-2 ring-canvas",
                  member.online ? "bg-success" : "bg-line-strong",
                )}
              />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
              {member.name}
              {member.me && <span className="text-faint">（这台设备）</span>}
              {!member.me && !member.online && (
                <span className="text-[12px] text-faint"> · 不在线</span>
              )}
            </span>
            {editable && !member.me ? (
              <>
                <select
                  aria-label={`${member.name} 的角色`}
                  value={member.role}
                  onChange={(event) => void setRole(member.id, event.target.value as Role)}
                  className="rounded-md bg-transparent px-1 py-0.5 text-[12px] text-body hover:bg-raised"
                >
                  <option value="admin">管理员</option>
                  <option value="edit">可编辑</option>
                  <option value="read">只读</option>
                </select>
                <button
                  type="button"
                  title="移出：他不再能连进来。他手里已有的那份收不回来，之前写的也留着"
                  onClick={() => void setRole(member.id, null)}
                  className="rounded-md px-1.5 py-[3px] text-[12px] text-muted transition-colors duration-[140ms] hover:bg-raised"
                >
                  移出
                </button>
              </>
            ) : (
              <span className="text-[12px] text-faint">{ROLE_TEXT[member.role]}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------------- 加入 ---------------- */

export function ShareJoinDialog() {
  const join = useShare((s) => s.join);
  const close = useShare((s) => s.closeJoin);
  const setLink = useShare((s) => s.setJoinLink);
  const joinNow = useShare((s) => s.joinNow);
  return (
    <Shell
      open={join.open}
      label="加入共享仓库"
      data="data-share-join"
      title="加入共享仓库"
      icon={<FolderPlus size={15} strokeWidth={2} className="shrink-0 text-faint" />}
      onClose={close}
    >
      <div className="flex flex-col gap-3">
        <p className="text-[12.5px] leading-[1.7] text-body">
          粘贴别人发来的邀请链接（odea://share/…）。加入以后整个仓库在你这里也有一份，在新窗口里打开，
          之后一直和大家同步。
        </p>
        <input
          aria-label="邀请链接"
          // biome-ignore lint/a11y/noAutofocus: 对话框就是为了粘链接打开的
          autoFocus
          value={join.link}
          placeholder="odea://share/…"
          onChange={(event) => setLink(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && join.preview)
              void joinNow();
          }}
          className="h-10 rounded-lg bg-raised px-3 font-mono text-[12px] text-ink outline-none
                     placeholder:text-faint focus:ring-2 focus:ring-accent/30"
        />
        {join.preview && (
          <p data-share-preview className="text-[12.5px] leading-[1.7] text-body">
            「{join.preview.name}」· 进去以后是{ROLE_TEXT[join.preview.role]}（对方同意时还能改）
          </p>
        )}
        {join.error && <p className="text-[12.5px] leading-[1.7] text-danger">{join.error}</p>}
        <div className="flex justify-end">
          <button
            type="button"
            data-share-join-now
            disabled={!join.preview || join.busy || !isShareLink(join.link)}
            onClick={() => void joinNow()}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-medium
                       text-accent-ink transition-colors duration-[140ms] hover:bg-accent-hover disabled:opacity-50"
          >
            {join.busy && <LoaderCircle size={13} strokeWidth={2} className="animate-spin" />}
            选好放在哪，加入
          </button>
        </div>
      </div>
    </Shell>
  );
}

/* ---------------- 有人来敲门 ---------------- */

export function ShareRequests() {
  const info = useShare((s) => s.info);
  const dialogOpen = useShare((s) => s.dialogOpen);
  const answer = useShare((s) => s.answer);
  const shown = dialogOpen || info?.role !== "admin" ? [] : (info?.requests ?? []).slice(0, 3);
  return (
    <AnimatePresence initial={false}>
      {shown.map((request) => (
        <motion.div
          key={request.request}
          role="alertdialog"
          aria-label={`${request.name} 想加入`}
          data-share-request-toast
          // 只淡入：不位移、不缩放（CLAUDE.md 动效规矩第 1 条）
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: tween.fast }}
          transition={tween.base}
          className="pointer-events-auto flex max-w-[480px] items-center gap-2.5 rounded-xl bg-ink
                     py-2 pl-3 pr-2 text-[13px] text-canvas shadow-float"
        >
          <PeerAvatar id={request.id} name={request.name} />
          <span className="min-w-0 flex-1 truncate">
            {request.name}
            <span className="opacity-70"> 想加入共享仓库「{info?.name}」</span>
          </span>
          <AnswerButtons inverted onAnswer={(role) => void answer(request.request, role)} />
        </motion.div>
      ))}
    </AnimatePresence>
  );
}
