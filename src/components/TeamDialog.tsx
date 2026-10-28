import { useApp } from "@/app/store";
import { inviteText, useTeam } from "@/data/team";
import type { TeamAccess, TeamPerson } from "@/data/types";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/date";
import { popoverCard, tween } from "@/lib/motion";
import { Check, Copy, LoaderCircle, Users, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { BannerButton } from "./ConflictBanner";

/* ============================================================
   团队成员（docs/协同编辑.md §22.3）：仓库菜单 / 命令面板「邀请成员… / 团队成员…」。

   上面是邀请：填对方在 GitHub 上的用户名 → 发邀请 → 复制链接发给他；下面是成员：
   我、能写的、等他接受邀请的、已经没有权限的（名单里还留着他的设备）。没开同步时先说要开同步。
   外壳和协作中继一样：遮罩 + 从标题栏往下展开的实心卡片（popoverCard）。
   ============================================================ */

const HEADER = 52;

export function TeamDialog() {
  const open = useTeam((s) => s.open);
  const close = useTeam((s) => s.close);
  const team = useTeam((s) => s.info?.team ?? false);

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

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            key="scrim"
            type="button"
            data-ghost-skip
            aria-label="关闭团队成员"
            onClick={close}
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
              aria-label="团队成员"
              data-team-dialog
              custom={HEADER}
              variants={popoverCard}
              initial="hidden"
              animate="shown"
              exit="gone"
              className="pointer-events-auto relative w-[480px] max-w-[calc(100vw-48px)]
                         overflow-clip rounded-2xl bg-canvas shadow-modal ring-1 ring-line-strong"
            >
              <div
                className="flex items-center gap-2.5 border-b border-line px-4"
                style={{ height: HEADER }}
              >
                <Users size={16} strokeWidth={2} className="shrink-0 text-faint" />
                <p className="flex-1 text-[14px] font-medium text-ink">
                  {team ? "团队成员" : "邀请成员"}
                </p>
                <button
                  type="button"
                  aria-label="关闭"
                  onClick={close}
                  className="grid h-7 w-7 place-items-center rounded-md text-muted
                             transition-colors duration-[140ms] hover:bg-raised hover:text-ink"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </div>
              <div className="scroll-thin max-h-[64vh] overflow-y-auto px-5 py-4">
                <TeamBody />
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

function TeamBody() {
  const info = useTeam((s) => s.info);
  const loading = useTeam((s) => s.loading);
  const error = useTeam((s) => s.error);

  // 第一次取成员（要问 GitHub）：先占着一行
  if (!info) {
    return error ? (
      <p className="text-[13px] text-danger">{error}</p>
    ) : (
      <p className="flex items-center gap-2 py-2 text-[13px] text-muted">
        <LoaderCircle size={14} strokeWidth={2} className="animate-spin" />
        正在看这个仓库有谁…
      </p>
    );
  }
  if (!info.provider || !info.repo) return <NeedSync />;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] leading-[1.7] text-body">
        {`邀请的人能读写这个同步仓库（${info.repo}），在 GitHub 上是它的协作者。他在 Odea 里点你发的链接，就能拉一份下来；之后大家的改动经同步合在一起，谁改的写在历史版本里。`}
      </p>
      {info.provider === "github" ? (
        <InviteForm />
      ) : (
        <p className="rounded-lg bg-raised px-3 py-2.5 text-[13px] leading-[1.65] text-body">
          Gitee 的仓库请在 Gitee 网页上的「仓库成员管理」里添加成员；对方在 Odea
          的启动器「从同步仓库拉一份」里就能看到这个仓库。
        </p>
      )}
      <Invited />
      {error && <p className="text-[12px] text-danger">{error}</p>}
      <section>
        <p className="mb-1.5 flex items-center gap-1.5 text-[12px] text-muted">
          成员 · {info.people.length}
          {loading && <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />}
        </p>
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {info.people.map((person) => (
            <PersonRow key={person.login} person={person} />
          ))}
        </ul>
        {info.remoteError && (
          <p className="mt-1.5 text-[12px] leading-[1.6] text-warning">
            GitHub 那边问不到（{info.remoteError}）：上面只是仓库里记着的设备，谁有权限看不出来
          </p>
        )}
      </section>
    </div>
  );
}

/** 没开同步：团队仓库靠同步在成员之间传改动 */
function NeedSync() {
  const setSyncOpen = useApp((s) => s.setSyncOpen);
  const close = useTeam((s) => s.close);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] leading-[1.7] text-body">
        团队仓库靠同步在成员之间传改动：先把这个仓库同步到
        GitHub（一个私有仓库），再邀请别人当它的协作者。
      </p>
      <div>
        <button
          type="button"
          onClick={() => {
            close();
            setSyncOpen(true);
          }}
          className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink
                     transition-colors duration-[140ms] hover:bg-accent-hover"
        >
          开启同步…
        </button>
      </div>
    </div>
  );
}

function InviteForm() {
  const invite = useTeam((s) => s.invite);
  const busy = useTeam((s) => s.busy);
  const [login, setLogin] = useState("");
  const submit = async () => {
    if (await invite(login)) setLogin("");
  };
  return (
    <div className="flex h-10 items-center gap-2 rounded-lg bg-raised pl-3 pr-1">
      <input
        value={login}
        onChange={(event) => setLogin(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) void submit();
        }}
        placeholder="对方在 GitHub 上的用户名"
        aria-label="GitHub 用户名"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
      />
      <button
        type="button"
        data-team-invite
        disabled={!login.trim() || busy}
        onClick={() => void submit()}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium
                   text-accent-ink transition-colors duration-[140ms] hover:bg-accent-hover disabled:opacity-50"
      >
        {busy && <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />}
        邀请
      </button>
    </div>
  );
}

/** 刚邀请完：链接，复制发给他 */
function Invited() {
  const invited = useTeam((s) => s.invited);
  const [copied, setCopied] = useState(false);
  if (!invited) return null;
  const copy = async () => {
    await navigator.clipboard.writeText(inviteText(invited.link)).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div
      data-team-invited
      className="rounded-lg border border-accent-line bg-accent-wash px-3 py-2.5"
    >
      <p className="text-[13px] font-medium text-ink">
        {invited.already
          ? `${invited.login} 本来就有这个仓库的权限`
          : `邀请发给 ${invited.login} 了，等他在 GitHub 上接受`}
      </p>
      <p className="mt-1 text-[13px] leading-[1.65] text-body">
        把这个链接发给他，他用 Odea 打开就能拉一份下来：
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate font-mono text-[12px] text-body" title={invited.link}>
          {invited.link}
        </p>
        <BannerButton onClick={() => void copy()}>
          {copied ? <Check size={12} strokeWidth={2.2} /> : <Copy size={12} strokeWidth={2} />}
          {copied ? "已复制" : "复制链接"}
        </BannerButton>
      </div>
    </div>
  );
}

const ACCESS: Record<TeamAccess, string> = {
  member: "能读写",
  invited: "等他接受邀请",
  gone: "已经没有权限了",
  unknown: "",
};

function PersonRow({ person }: { person: TeamPerson }) {
  const remove = useTeam((s) => s.remove);
  const busy = useTeam((s) => s.busy);
  const [confirming, setConfirming] = useState(false);
  const devices = person.devices
    .map((device) =>
      device.this
        ? `${device.name}（这台）`
        : `${device.name} · ${formatRelativeTime(device.updated)}`,
    )
    .join("、");
  return (
    <li data-team-person className="px-3 py-2">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[13px] text-ink">
          {person.login}
          {person.me && <span className="text-faint"> · 你</span>}
          {ACCESS[person.access] && (
            <span
              className={cn(
                "ml-1.5 text-[12px]",
                person.access === "gone"
                  ? "text-danger"
                  : person.access === "invited"
                    ? "text-warning"
                    : "text-faint",
              )}
            >
              {ACCESS[person.access]}
            </span>
          )}
        </p>
        {!person.me &&
          (confirming ? (
            <>
              <BannerButton danger disabled={busy} onClick={() => void remove(person.login)}>
                确定移出
              </BannerButton>
              <BannerButton onClick={() => setConfirming(false)}>不了</BannerButton>
            </>
          ) : (
            <BannerButton danger onClick={() => setConfirming(true)}>
              {person.access === "invited" ? "撤回邀请" : "移出"}
            </BannerButton>
          ))}
      </div>
      <p className="mt-0.5 truncate text-[12px] text-muted" title={devices || undefined}>
        {confirming
          ? "GitHub 上去掉他的权限，名单里他的设备也去掉。他已经拉下来的那一份收不回来"
          : devices ||
            (person.access === "invited" ? "还没在 Odea 里打开过" : "名单里还没有他的设备")}
      </p>
    </li>
  );
}
