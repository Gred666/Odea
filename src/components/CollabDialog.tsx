import { openDocument } from "@/app/navigate";
import { peerColor } from "@/collab/colors";
import {
  type ReachRow,
  audienceOf,
  callbackVerdict,
  diagnosisText,
  forwardVerdict,
  reachRemedy,
  reachRows,
  reachSummary,
} from "@/collab/reach";
import { useRelays } from "@/collab/relayStore";
import { type JoinRequest, endText, linkKind, useCollab } from "@/collab/store";
import { useData } from "@/data/store";
import type { Diagnosis, MemberInfo, Permission, Reach } from "@/lib/bindings";
import { cn } from "@/lib/cn";
import { popoverCard, tween } from "@/lib/motion";
import { IS_WINDOWS } from "@/lib/platform";
import {
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  Link2,
  LoaderCircle,
  LogOut,
  RefreshCw,
  Users,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { BannerButton } from "./ConflictBanner";

/* ============================================================
   协作的界面（docs/协同编辑.md §8）：
   - CollabDialog：主持人的邀请链接、加入请求、成员；访客的加入、连接状态、离开
   - CollabRequests：有人想加入时底部的提示卡（对话框关着的时候）
   - CollabPresence：正文区右上角的协作标签（谁在、点一下回到协作的那篇 / 打开对话框）
   - CollabBanner：做客那一篇顶上的一行（重新连接中、只读、协作结束了）

   P10.1 的遗留：加入表单下面是「附近」（同一个网络里正在分享的人，点一下请求加入）；
   CollabResume 是重启后底部的「继续上次的协作」卡（上次没正常结束的）。

   互联网上（P10.2，设计 §8.4、§8.5）：主持人的链接下面是分享前自检（谁能加入、局域网 / IPv6 /
   端口映射 / 中继各怎样，collab/reach.ts 拼的话）；访客连不上时 3 秒内给结论和下一步，能生成
   回连链接；主持人这边能粘访客发来的回连链接。中继的设置在 RelayDialog.tsx。

   外壳和同步对话框一样：遮罩 + 从标题栏往下展开的实心卡片（popoverCard）。展开时只量第一帧，
   所以「正在准备邀请链接」和链接本身占同样的高度（技术方案 §10.1 第 5 条）。
   提示卡、标签只淡 opacity，不位移（CLAUDE.md 动效规矩第 1 条）。
   ============================================================ */

const HEADER = 52;
const DOWNLOAD = "https://github.com/Gred666/Odea/releases/latest";

export function CollabDialog() {
  const open = useCollab((s) => s.dialogOpen);
  const close = useCollab((s) => s.closeDialog);
  const phase = useCollab((s) => s.phase);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      // 上面叠着中继的对话框（「配中继…」打开的）：Esc 先关它
      if (event.key === "Escape" && !event.isComposing && !useRelays.getState().open) {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  const hosting = phase === "preparing" || phase === "hosting";
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            key="scrim"
            type="button"
            data-ghost-skip
            aria-label="关闭协作"
            onClick={close}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={tween.base}
            className="fixed inset-0 z-50 cursor-default bg-ink/[0.14] backdrop-blur-[3px]"
          />
          <div
            key="panel"
            data-ghost-skip
            className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center pt-[14vh]"
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label="协作"
              data-collab-dialog
              custom={HEADER}
              variants={popoverCard}
              initial="hidden"
              animate="shown"
              exit="gone"
              className="pointer-events-auto relative w-[460px] max-w-[calc(100vw-48px)]
                         overflow-clip rounded-2xl bg-canvas shadow-modal ring-1 ring-line-strong"
            >
              <div
                className="flex items-center gap-2.5 border-b border-line px-4"
                style={{ height: HEADER }}
              >
                <Users size={15} strokeWidth={2} className="shrink-0 text-faint" />
                <p className="flex-1 text-[14px] font-medium text-ink">
                  {hosting ? "邀请协作" : phase === "idle" ? "加入协作" : "协作"}
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
                {hosting ? <HostBody /> : phase === "idle" ? <JoinForm /> : <GuestBody />}
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

/* ---------------- 主持人 ---------------- */

function HostBody() {
  const phase = useCollab((s) => s.phase);
  const link = useCollab((s) => s.link);
  const members = useCollab((s) => s.members);
  const requests = useCollab((s) => s.requests);
  const noteId = useCollab((s) => s.noteId);
  const stop = useCollab((s) => s.stop);
  const resetInvite = useCollab((s) => s.resetInvite);
  const reach = useCollab((s) => s.reach);
  const trustedCount = useCollab((s) => s.trusted.length);
  const outdated = useCollab((s) => s.outdated);
  const title = useData((s) => s.notes.find((note) => note.id === noteId)?.title ?? "");
  const [copied, setCopied] = useState(false);
  /** 复制出去的是哪一个：之后地址变了（端口映射到了、换了网络）提醒再复制一次 */
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);

  const copy = async () => {
    if (!link) return;
    setCopiedLink(link);
    // 附一句怎么打开：没装 Odea 的人点不开 odea:// 链接（没有网页兜底，那要服务器）
    await navigator.clipboard
      .writeText(
        `${link}\n用 Odea 打开这个链接，和我一起编辑「${title}」。还没装 Odea：${DOWNLOAD}`,
      )
      .catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="flex flex-col gap-4">
      <section>
        <p className="text-[13px] text-body">
          把链接发给要一起编辑「<span className="text-ink">{title}</span>」的人
        </p>
        {/* 准备中和链接本身同样高：对话框展开时只量第一帧 */}
        <div className="mt-2 flex h-10 items-center gap-2 rounded-lg bg-raised pl-3 pr-1">
          {phase === "preparing" || !link ? (
            <>
              <LoaderCircle
                size={13}
                strokeWidth={2}
                className="shrink-0 animate-spin text-faint"
              />
              <span className="flex-1 truncate text-[12.5px] text-muted">正在准备邀请链接…</span>
            </>
          ) : (
            <>
              <span data-collab-link className="flex-1 truncate font-mono text-[12px] text-body">
                {link}
              </span>
              <button
                type="button"
                onClick={() => void copy()}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-accent px-2.5
                           text-[12.5px] font-medium text-accent-ink transition-colors
                           duration-[140ms] hover:bg-accent-hover"
              >
                {copied ? (
                  <Check size={13} strokeWidth={2.2} />
                ) : (
                  <Copy size={13} strokeWidth={2} />
                )}
                {copied ? "已复制" : "复制"}
              </button>
            </>
          )}
        </div>
        {copiedLink && link && copiedLink !== link && (
          <p className="mt-1.5 text-[12px] text-accent">
            网络情况变了，链接跟着变了：再复制一次发出去
          </p>
        )}
        <ReachPanel reach={phase === "preparing" ? null : reach} />
        <p className="mt-2 text-[12px] leading-[1.65] text-muted">
          {/* 一整句写在一个字符串里：JSX 换行会在两句中文之间多出一个空格 */}
          {trustedCount > 0
            ? "每个人进来之前都会先问你（记住的人除外）。"
            : "每个人进来之前都会先问你。"}
          {IS_WINDOWS && phase === "preparing" && (
            <span>Windows 可能会问是否允许 Odea 使用网络：勾上「专用网络」，别人才连得进来。</span>
          )}
        </p>
      </section>

      <DialBackLine />
      {pasting && <CallbackField onDone={() => setPasting(false)} />}

      {requests.length > 0 && (
        <section className="flex flex-col gap-1.5">
          {requests.map((request) => (
            <RequestRow key={request.request} request={request} title={title} />
          ))}
        </section>
      )}

      {outdated && (
        <p data-collab-outdated className="text-[12px] leading-[1.65] text-danger">
          {outdated.guestOlder
            ? `${outdated.name} 想加入，可是 ${outdated.name} 的 Odea 比你的旧，连不上：让对方升级到最新再试`
            : `${outdated.name} 想加入，可是你的 Odea 比 ${outdated.name} 的旧，连不上：升级到最新再试`}
        </p>
      )}

      <MemberList members={members} editable />

      <div className="flex items-center gap-1.5 border-t border-line pt-3">
        <NameField />
        <span className="flex-1" />
        {phase === "hosting" && !pasting && (
          <BannerButton onClick={() => setPasting(true)}>
            <Link2 size={12} strokeWidth={2} />
            粘回连链接
          </BannerButton>
        )}
        {phase === "hosting" && (
          <BannerButton onClick={() => void resetInvite()}>
            <RefreshCw size={12} strokeWidth={2} />
            换一个链接
          </BannerButton>
        )}
        <BannerButton danger onClick={() => void stop()}>
          停止协作
        </BannerButton>
      </div>
    </div>
  );
}

/** 分享前自检：一行谁能加入，几行明细。还没结果时就把行占好（对话框展开时只量第一帧） */
function ReachPanel({ reach }: { reach: Reach | null }) {
  const audience = audienceOf(reach);
  const remedy = reachRemedy(reach);
  const rows = reachRows(reach);
  return (
    <div data-collab-reach className="mt-3 rounded-lg border border-line px-3 py-2.5">
      <p className="flex items-start gap-2 text-[12.5px] leading-[1.6] text-ink">
        <span className="mt-[3px] shrink-0">
          {audience === "checking" ? (
            <LoaderCircle size={13} strokeWidth={2} className="animate-spin text-faint" />
          ) : audience === "everyone" ? (
            <CircleCheck size={13} strokeWidth={2} className="text-success" />
          ) : (
            <CircleAlert size={13} strokeWidth={2} className="text-warning" />
          )}
        </span>
        <span data-collab-reach-summary>{reachSummary(reach)}</span>
      </p>
      <ReachRows rows={rows} />
      {remedy && (
        <p className="mt-2 text-[12px] leading-[1.65] text-muted">
          {remedy}
          <button
            type="button"
            onClick={() => useRelays.getState().openRelays()}
            className="ml-1 text-accent hover:underline"
          >
            配中继…
          </button>
        </p>
      )}
    </div>
  );
}

function ReachRows({ rows }: { rows: ReachRow[] }) {
  return (
    <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-[3px] pl-[21px] text-[12px] leading-[1.55]">
      {rows.map((row) => (
        <div key={row.key} className="contents">
          <dt className="text-faint">{row.label}</dt>
          <dd
            className={cn(
              "min-w-0 truncate",
              row.state === "ok" ? "text-body" : row.state === "wait" ? "text-faint" : "text-muted",
            )}
            title={row.detail}
          >
            {row.state === "ok" && <span className="mr-1 text-success">✓</span>}
            {row.detail}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** 按回连链接往访客那边拨的进展 */
function DialBackLine() {
  const dialBack = useCollab((s) => s.dialBack);
  if (!dialBack) return null;
  return (
    <p
      data-collab-dialback
      className={cn(
        "-mt-1 flex items-center gap-2 text-[12.5px]",
        dialBack.state === "failed" ? "text-danger" : "text-body",
      )}
    >
      {dialBack.state === "dialing" && (
        <LoaderCircle size={13} strokeWidth={2} className="shrink-0 animate-spin text-faint" />
      )}
      {dialBack.state === "dialing"
        ? "正在按回连链接往对方那边拨…"
        : dialBack.state === "ok"
          ? "拨通了：对方进来之前照样会先问你"
          : `拨不通：${dialBack.detail ?? "原因不明"}。让对方换个网络，或者你们之中有人配一台中继`}
    </p>
  );
}

/** 主持人粘访客发来的回连链接（点链接打开的话不用这个） */
function CallbackField({ onDone }: { onDone: () => void }) {
  const dialBackTo = useCollab((s) => s.dialBackTo);
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const submit = () => {
    if (linkKind(value) !== "back") {
      setProblem("这不是回连链接（odea://back/…）");
      return;
    }
    void dialBackTo(value);
    onDone();
  };
  return (
    <div className="-mt-1">
      <div className="flex h-10 items-center gap-2 rounded-lg bg-raised pl-3 pr-1">
        <input
          // biome-ignore lint/a11y/noAutofocus: 点了「粘回连链接」就是要粘
          autoFocus
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setProblem(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) submit();
            if (event.key === "Escape") {
              event.stopPropagation();
              onDone();
            }
          }}
          placeholder="odea://back/…"
          aria-label="回连链接"
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-faint"
        />
        <button
          type="button"
          disabled={!value.trim()}
          onClick={submit}
          className="h-8 shrink-0 rounded-md bg-accent px-3 text-[12.5px] font-medium text-accent-ink
                     transition-colors duration-[140ms] hover:bg-accent-hover disabled:opacity-50"
        >
          拨过去
        </button>
      </div>
      <p className={cn("mt-1.5 text-[12px]", problem ? "text-danger" : "text-muted")}>
        {problem ?? "对方连不进来、自己能被连时会发这个给你：由你往对方那边拨"}
      </p>
    </div>
  );
}

function RequestRow({ request, title }: { request: JoinRequest; title: string }) {
  const answer = useCollab((s) => s.answer);
  return (
    <div
      data-collab-request
      className="flex items-center gap-2 rounded-lg border border-accent-line bg-accent-wash px-3 py-2"
    >
      <PeerAvatar id={request.id} name={request.name} />
      <p className="min-w-0 flex-1 truncate text-[13px] text-ink">
        {request.name}
        <span className="text-muted">{requestText(request, title)}</span>
      </p>
      <AnswerButtons onAnswer={(allow) => void answer(request.request, allow)} />
    </div>
  );
}

/** 加入请求后半句：拿着链接的、「附近」点进来的、经别的访客转发来的（设计 §20.9） */
function requestText(request: JoinRequest, title: string): string {
  if (request.via) return ` 经由 ${request.via} 转发，想加入「${title}」`;
  return request.invited ? ` 想加入「${title}」` : " 在同一个网络里，想加入";
}

function AnswerButtons({
  onAnswer,
  inverted,
}: { onAnswer: (allow: Permission | null) => void; inverted?: boolean }) {
  const base = "shrink-0 rounded-md px-2 py-1 text-[12px] transition-colors duration-[140ms]";
  return (
    <>
      <button
        type="button"
        data-collab-allow
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

function MemberList({ members, editable }: { members: MemberInfo[]; editable?: boolean }) {
  const identity = useCollab((s) => s.identity);
  const setPermission = useCollab((s) => s.setPermission);
  const kick = useCollab((s) => s.kick);
  const trusted = useCollab((s) => s.trusted);
  const remember = useCollab((s) => s.remember);
  const forget = useCollab((s) => s.forget);
  if (!members.length) return null;
  // 记住了、现在不在的人：主持时列在下面，能忘掉
  const away = editable ? trusted.filter((peer) => !members.some((m) => m.id === peer.id)) : [];
  return (
    <section>
      <p className="mb-1.5 text-[12px] text-faint">在这里的人 · {members.length}</p>
      <ul className="flex flex-col">
        {members.map((member) => {
          const me = member.id === identity?.id;
          const known = trusted.some((peer) => peer.id === member.id);
          return (
            <li key={member.id} data-collab-member className="flex h-9 items-center gap-2.5">
              <PeerAvatar id={member.id} name={member.name} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                {member.name}
                {me && <span className="text-faint">（你）</span>}
                {member.via !== null && (
                  <span className="text-[12px] text-faint">
                    {" "}
                    · 经由 {members.find((other) => other.member === member.via)?.name ?? "别人"}
                  </span>
                )}
              </span>
              {member.host ? (
                <span className="text-[12px] text-faint">主持人</span>
              ) : editable ? (
                <>
                  {/* 记住：下次拿着链接或者从「附近」进来不问（设计 §8.2）。静态切换，不做动画 */}
                  <button
                    type="button"
                    data-collab-remember
                    aria-pressed={known}
                    title={
                      known
                        ? "记住了：下次进来不用再问。点一下忘掉"
                        : "记住 TA：下次拿着链接或者在同一个网络里进来，不用再问"
                    }
                    onClick={() => void (known ? forget(member.id) : remember(member))}
                    className={cn(
                      "flex items-center gap-1 rounded-md px-1.5 py-[3px] text-[12px] transition-colors duration-[140ms]",
                      known ? "text-accent hover:bg-accent-wash" : "text-muted hover:bg-raised",
                    )}
                  >
                    {known && <Check size={12} strokeWidth={2.2} />}
                    {known ? "记住了" : "记住"}
                  </button>
                  <select
                    aria-label={`${member.name} 的权限`}
                    value={member.permission}
                    onChange={(event) =>
                      void setPermission(member.member, event.target.value as Permission)
                    }
                    className="rounded-md bg-transparent px-1 py-0.5 text-[12px] text-body hover:bg-raised"
                  >
                    <option value="edit">可编辑</option>
                    <option value="read">只读</option>
                  </select>
                  <BannerButton danger onClick={() => void kick(member.member)}>
                    移出
                  </BannerButton>
                </>
              ) : (
                <span className="text-[12px] text-faint">
                  {member.permission === "edit" ? "可编辑" : "只读"}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {away.length > 0 && (
        <>
          <p className="mt-2 mb-1.5 text-[12px] text-faint">
            记住的人 · {away.length}（进来不用再问）
          </p>
          <ul className="flex flex-col">
            {away.map((peer) => (
              <li key={peer.id} data-collab-trusted className="flex h-9 items-center gap-2.5">
                <PeerAvatar id={peer.id} name={peer.name} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-body">{peer.name}</span>
                <span className="text-[12px] text-faint">
                  {peer.permission === "edit" ? "可编辑" : "只读"}
                </span>
                <BannerButton onClick={() => void forget(peer.id)}>忘掉</BannerButton>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** 别人看到的我的名字（没有账号，在本地设） */
function NameField() {
  const identity = useCollab((s) => s.identity);
  const setName = useCollab((s) => s.setName);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  if (!identity) return null;
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(identity.name);
          setEditing(true);
        }}
        className="truncate rounded-md px-1.5 py-[3px] text-[12px] text-muted hover:bg-raised hover:text-body"
        title="别人看到的你的名字"
      >
        你叫「{identity.name}」 · 改
      </button>
    );
  }
  const commit = () => {
    setEditing(false);
    if (value.trim() && value.trim() !== identity.name) void setName(value);
  };
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: 点了「改」就是要改
      autoFocus
      value={value}
      maxLength={40}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) commit();
        if (event.key === "Escape") {
          event.stopPropagation();
          setEditing(false);
        }
      }}
      aria-label="你的名字"
      className="w-40 rounded-md bg-raised px-2 py-[3px] text-[12px] text-ink outline-none"
    />
  );
}

/* ---------------- 访客 ---------------- */

function JoinForm() {
  const joinLink = useCollab((s) => s.joinLink);
  const setJoinLink = useCollab((s) => s.setJoinLink);
  const join = useCollab((s) => s.join);
  const error = useCollab((s) => s.error);
  const joinRelay = useCollab((s) => s.joinRelay);
  const directOnly = useCollab((s) => s.directOnly);
  const setDirectOnly = useCollab((s) => s.setDirectOnly);
  const submit = () => {
    if (joinLink.trim()) void join(joinLink);
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-body">把别人发给你的协作链接粘到这里</p>
      <div className="flex h-10 items-center gap-2 rounded-lg bg-raised pl-3 pr-1">
        <input
          // biome-ignore lint/a11y/noAutofocus: 打开就是为了粘链接
          autoFocus
          value={joinLink}
          onChange={(event) => setJoinLink(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) submit();
          }}
          placeholder="odea://join/…"
          aria-label="协作链接"
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-faint"
        />
        <button
          type="button"
          data-collab-join
          disabled={!joinLink.trim()}
          onClick={submit}
          className="h-8 shrink-0 rounded-md bg-accent px-3 text-[12.5px] font-medium text-accent-ink
                     transition-colors duration-[140ms] hover:bg-accent-hover disabled:opacity-50"
        >
          加入
        </button>
      </div>
      {/* 出错的那一行先占着位置：对话框展开时只量第一帧 */}
      <p
        className={cn(
          "min-h-[20px] text-[12px] leading-[1.65]",
          error ? "text-danger" : "text-muted",
        )}
      >
        {error ?? "主持人同意以后就能一起编辑。连不上的话 3 秒内会说清楚卡在哪、怎么办。"}
      </p>
      {/* 访客要知情：这次经由谁的机器转发（设计 §6.5） */}
      {joinRelay && (
        <div data-collab-join-relay className="-mt-1 rounded-lg border border-line px-3 py-2.5">
          <p className="text-[12.5px] leading-[1.6] text-body">
            {`这次经由 ${joinRelay} 转发（主持人配置的）：那台机器看得到你的 IP 地址，看不到内容。`}
          </p>
          <label className="mt-1.5 flex cursor-pointer items-center gap-2 text-[12px] text-muted">
            <input
              type="checkbox"
              checked={directOnly}
              onChange={(event) => setDirectOnly(event.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            只直连，不经中继（不在同一个网络时多半就连不上了）
          </label>
        </div>
      )}
      <NearbyList />
      <div className="flex items-center border-t border-line pt-3">
        <NameField />
      </div>
    </div>
  );
}

/** 起「附近」的端点要两三秒，mDNS 再要一会儿：这么久以内列表空着算「正在找」 */
const NEARBY_SEARCHING_MS = 5000;

/** 同一个网络里正在分享的人（设计 §8.3）：加入表单开着时看，点一下请求加入（主持人照样确认） */
function NearbyList() {
  const nearby = useCollab((s) => s.nearby);
  const since = useCollab((s) => s.nearbySince);
  const error = useCollab((s) => s.nearbyError);
  const joinNearby = useCollab((s) => s.joinNearby);
  // 「正在找」过了时限要换成「没找到」：到点重画一次
  const [, setTick] = useState(0);
  useEffect(() => {
    const { startNearby, stopNearby } = useCollab.getState();
    startNearby();
    const timer = setTimeout(() => setTick(1), NEARBY_SEARCHING_MS);
    return () => {
      clearTimeout(timer);
      stopNearby();
    };
  }, []);
  const searching = !nearby?.length && since !== null && Date.now() - since < NEARBY_SEARCHING_MS;
  return (
    <section data-collab-nearby className="border-t border-line pt-3">
      <p className="mb-1.5 text-[12px] text-faint">附近：同一个网络里正在分享的人</p>
      {error ? (
        <p className="text-[12px] leading-[1.65] text-muted">{error}</p>
      ) : nearby?.length ? (
        <ul className="flex flex-col">
          {nearby.map((host) => (
            <li key={host.id} data-collab-nearby-host className="flex h-9 items-center gap-2.5">
              <PeerAvatar id={host.id} name={host.name} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{host.name}</span>
              <BannerButton onClick={() => void joinNearby(host.id)}>请求加入</BannerButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-2 text-[12px] leading-[1.65] text-muted">
          {searching && (
            <LoaderCircle size={12} strokeWidth={2} className="shrink-0 animate-spin text-faint" />
          )}
          {searching
            ? "正在找…"
            : "没找到。对方要先在那篇笔记上「邀请协作」。「附近」只看得到同一个网段里的人：学校、公司的大网络常分成好多段，开了客户端隔离的 Wi-Fi（酒店、咖啡馆、访客网络）上设备也互相看不见 —— 这些情况让对方直接发链接，多半照样连得上"}
        </p>
      )}
    </section>
  );
}

function GuestBody() {
  const status = useCollab((s) => s.status);
  const members = useCollab((s) => s.members);
  const title = useCollab((s) => s.title);
  const permission = useCollab((s) => s.permission);
  const showShared = useCollab((s) => s.showShared);
  const setShowShared = useCollab((s) => s.setShowShared);
  const stop = useCollab((s) => s.stop);
  const close = useCollab((s) => s.closeDialog);
  const relayed = useCollab((s) => s.relayed);
  const host = members.find((member) => member.host)?.name ?? "主持人";

  if (status?.state === "unreachable") {
    return <Unreachable diagnosis={status.diagnosis} host={host} />;
  }

  const line = (() => {
    switch (status?.state) {
      case "connecting":
        return { busy: true, text: "正在连接…" };
      case "waiting":
        return { busy: true, text: "已经连上了，等主持人同意…" };
      case "reconnecting":
        return { busy: true, text: "连接断了，正在重新连接。你可以接着写，连上后会自动合并" };
      case "ended":
        return { busy: false, text: endText(status.reason, host), ended: true };
      case "connected":
        return {
          busy: false,
          text:
            (permission === "read"
              ? `正在看 ${host} 的「${title}」（只读）`
              : `正在和 ${host} 一起编辑「${title}」`) +
            // 打洞没成、一直经中继转发：慢一点是正常的
            (relayed ? "，经由中继转发" : ""),
        };
      default:
        return { busy: true, text: "正在连接…" };
    }
  })();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex min-h-[40px] items-center gap-2.5 rounded-lg bg-raised px-3 py-2">
        {line.busy && (
          <LoaderCircle size={13} strokeWidth={2} className="shrink-0 animate-spin text-faint" />
        )}
        <p data-collab-status className="text-[13px] leading-[1.6] text-body">
          {line.text}
        </p>
      </div>
      <MemberList members={members} />
      {status?.state === "connected" && <ForwardLink host={host} />}
      <div className="flex items-center gap-1.5 border-t border-line pt-3">
        <NameField />
        <span className="flex-1" />
        {status?.state === "connected" && !showShared && (
          <BannerButton
            onClick={() => {
              setShowShared(true);
              close();
            }}
          >
            回到这篇
          </BannerButton>
        )}
        {members.length > 0 && <SaveCopyButton />}
        <BannerButton danger onClick={() => void stop()}>
          <LogOut size={12} strokeWidth={2} />
          {line.ended ? "关闭" : "离开"}
        </BannerButton>
      </div>
    </div>
  );
}

/**
 * 转发链接（设计 §20.9）：有人连不上主持人、却连得上我（比如和我在同一个网络里，主持人只有我够得着），
 * 我把这个链接发给他，他经我加入。主持人照样确认、照样管他的权限；我这边只是一根管子
 */
function ForwardLink({ host }: { host: string }) {
  const forward = useCollab((s) => s.forward);
  const busy = useCollab((s) => s.forwardBusy);
  const make = useCollab((s) => s.makeForwardLink);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!forward) return;
    await navigator.clipboard
      .writeText(
        `${forward.link}\n这是转发链接：连不上 ${host} 的话，用 Odea 打开它，经我加入（${host} 那边照样要同意）。`,
      )
      .catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  if (!forward) {
    return (
      <p className="flex items-center gap-2 text-[12px] leading-[1.65] text-muted">
        <span className="flex-1">有人连不上 {host}、却连得上你？发一个转发链接给他，经你加入</span>
        <BannerButton disabled={busy} onClick={() => void make()}>
          {busy ? (
            <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />
          ) : (
            <Link2 size={12} strokeWidth={2} />
          )}
          {busy ? "正在看能不能被连进来…" : "转发链接"}
        </BannerButton>
      </p>
    );
  }
  const verdict = forwardVerdict(forward.reach);
  return (
    <section>
      <p className="mb-1.5 text-[12px] text-faint">转发链接（经你加入，{host} 那边照样要同意）</p>
      <div className="flex h-10 items-center gap-2 rounded-lg bg-raised pl-3 pr-1">
        <span data-collab-forward className="flex-1 truncate font-mono text-[12px] text-body">
          {forward.link}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-accent px-2.5
                     text-[12.5px] font-medium text-accent-ink transition-colors
                     duration-[140ms] hover:bg-accent-hover"
        >
          {copied ? <Check size={13} strokeWidth={2.2} /> : <Copy size={13} strokeWidth={2} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <p
        className={cn(
          "mt-1.5 text-[12px] leading-[1.65]",
          verdict.ok ? "text-muted" : "text-warning",
        )}
      >
        {verdict.text}
      </p>
    </section>
  );
}

/** 连不上：卡在哪、为什么、下一步；能生成回连链接。不算结束：后台接着试 */
function Unreachable({ diagnosis, host }: { diagnosis: Diagnosis; host: string }) {
  const stop = useCollab((s) => s.stop);
  const callback = useCollab((s) => s.callback);
  const busy = useCollab((s) => s.callbackBusy);
  const makeCallback = useCollab((s) => s.makeCallback);
  const error = useCollab((s) => s.error);
  const [copied, setCopied] = useState(false);
  // 还没进去时不知道主持人叫什么（链接里没有名字），host 是「主持人」
  const text = diagnosisText(diagnosis, host);
  const verdict = callback ? callbackVerdict(callback.reach, host) : null;

  const copy = async () => {
    if (!callback) return;
    await navigator.clipboard
      .writeText(`${callback.link}\n这是回连链接：我连不上你那边，用 Odea 打开它，由你往我这边拨。`)
      .catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="flex flex-col gap-3">
      <div data-collab-unreachable className="rounded-lg bg-raised px-3 py-2.5">
        <p className="flex items-start gap-2 text-[13px] font-medium leading-[1.6] text-ink">
          <CircleAlert size={14} strokeWidth={2} className="mt-[3px] shrink-0 text-warning" />
          {text.title}
        </p>
        <p className="mt-1 pl-[22px] text-[12.5px] leading-[1.65] text-body">{text.detail}</p>
        <p className="mt-1 pl-[22px] text-[12px] text-faint">{text.tried}</p>
      </div>
      {text.steps.length > 0 && (
        <section>
          <p className="mb-1 text-[12px] text-faint">可以这样试</p>
          <ol className="flex list-decimal flex-col gap-0.5 pl-5 text-[12.5px] leading-[1.65] text-body">
            {text.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>
      )}
      {callback && (
        <section>
          <div className="flex h-10 items-center gap-2 rounded-lg bg-raised pl-3 pr-1">
            <span data-collab-callback className="flex-1 truncate font-mono text-[12px] text-body">
              {callback.link}
            </span>
            <button
              type="button"
              onClick={() => void copy()}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-accent px-2.5
                         text-[12.5px] font-medium text-accent-ink transition-colors
                         duration-[140ms] hover:bg-accent-hover"
            >
              {copied ? <Check size={13} strokeWidth={2.2} /> : <Copy size={13} strokeWidth={2} />}
              {copied ? "已复制" : "复制"}
            </button>
          </div>
          {verdict && (
            <p
              className={cn(
                "mt-1.5 text-[12px] leading-[1.65]",
                verdict.ok ? "text-muted" : "text-warning",
              )}
            >
              {verdict.text}
            </p>
          )}
        </section>
      )}
      {error && <p className="text-[12px] text-danger">{error}</p>}
      <p className="flex items-center gap-2 text-[12px] text-muted">
        <LoaderCircle size={12} strokeWidth={2} className="shrink-0 animate-spin text-faint" />
        还在后台接着试：换了网络会自己连上
      </p>
      <div className="flex items-center gap-1.5 border-t border-line pt-3">
        <NameField />
        <span className="flex-1" />
        {text.callback && !callback && (
          <BannerButton disabled={busy} onClick={() => void makeCallback()}>
            {busy ? (
              <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />
            ) : (
              <Link2 size={12} strokeWidth={2} />
            )}
            {busy ? "正在看能不能被连进来…" : "生成回连链接"}
          </BannerButton>
        )}
        <BannerButton onClick={() => useRelays.getState().openRelays()}>配中继…</BannerButton>
        <BannerButton danger onClick={() => void stop()}>
          <LogOut size={12} strokeWidth={2} />
          离开
        </BannerButton>
      </div>
    </div>
  );
}

function SaveCopyButton() {
  const saveCopy = useCollab((s) => s.saveCopy);
  const [busy, setBusy] = useState(false);
  return (
    <BannerButton
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const id = await saveCopy();
          if (id) {
            useCollab.getState().setShowShared(false);
            useCollab.getState().closeDialog();
            openDocument({ kind: "note", id });
          }
        } finally {
          setBusy(false);
        }
      }}
    >
      存一份到我的笔记
    </BannerButton>
  );
}

/* ---------------- 加入请求的提示卡（对话框关着的时候） ---------------- */

export function CollabRequests() {
  const requests = useCollab((s) => s.requests);
  const dialogOpen = useCollab((s) => s.dialogOpen);
  const noteId = useCollab((s) => s.noteId);
  const answer = useCollab((s) => s.answer);
  const title = useData((s) => s.notes.find((note) => note.id === noteId)?.title ?? "");
  const shown = dialogOpen ? [] : requests.slice(0, 3);
  return (
    <AnimatePresence initial={false}>
      {shown.map((request) => (
        <motion.div
          key={request.request}
          role="alertdialog"
          aria-label={`${request.name} 想加入`}
          data-collab-request-toast
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
            <span className="opacity-70">{requestText(request, title)}</span>
          </span>
          <AnswerButtons inverted onAnswer={(allow) => void answer(request.request, allow)} />
        </motion.div>
      ))}
    </AnimatePresence>
  );
}

/* ---------------- 重启后：继续上次没正常结束的协作 ---------------- */

/**
 * 上次协作时 Odea 崩了、被强退了：底部问一句。主持人「继续协作」用同一个会话 id 和端口重新起来，
 * 访客那边自己接上；访客「重新加入」用落盘的状态，断线期间各自写的同步时补齐。只淡 opacity
 */
export function CollabResume() {
  const resume = useCollab((s) => s.resume);
  const phase = useCollab((s) => s.phase);
  const notes = useData((s) => s.notes);
  const items: Array<{ key: string; host: boolean; text: string; action: string }> = [];
  if (resume?.host && phase === "idle") {
    const note = notes.find((item) => item.id === resume.host!.note);
    const title = note?.title ?? resume.host.title;
    const who = resume.host.guests ? `和 ${resume.host.guests} 个人一起` : "";
    items.push({
      key: "host",
      host: true,
      text: `上次${who}编辑「${title}」时 Odea 没有正常退出`,
      action: "继续协作",
    });
  }
  if (resume?.guest && phase === "idle") {
    const host = resume.guest.hostName || "主持人";
    const title = resume.guest.title ? `「${resume.guest.title}」` : "";
    items.push({
      key: "guest",
      host: false,
      text: `上次在 ${host} 那里做客${title}时 Odea 没有正常退出`,
      action: "重新加入",
    });
  }
  return (
    <AnimatePresence initial={false}>
      {items.map((item) => (
        <motion.div
          key={item.key}
          role="alertdialog"
          aria-label={item.text}
          data-collab-resume
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: tween.fast }}
          transition={tween.base}
          className="pointer-events-auto flex max-w-[520px] items-center gap-2.5 rounded-xl bg-ink
                     py-2 pl-3 pr-2 text-[13px] text-canvas shadow-float"
        >
          <Users size={14} strokeWidth={2} className="shrink-0 opacity-70" />
          <span className="min-w-0 flex-1">{item.text}</span>
          <button
            type="button"
            onClick={() =>
              void (item.host
                ? useCollab.getState().resumeHost()
                : useCollab.getState().resumeGuest())
            }
            className="shrink-0 rounded-md bg-canvas px-2 py-1 text-[12px] font-medium text-ink
                       transition-colors duration-[140ms] hover:bg-canvas/85"
          >
            {item.action}
          </button>
          <button
            type="button"
            onClick={() => void useCollab.getState().discardResume(item.host)}
            className="shrink-0 rounded-md px-2 py-1 text-[12px] text-canvas/70
                       transition-colors duration-[140ms] hover:bg-canvas/15"
          >
            不用了
          </button>
        </motion.div>
      ))}
    </AnimatePresence>
  );
}

/* ---------------- 正文区右上角的协作标签 ---------------- */

/**
 * 协作中才有。主持人正在看主持的那篇 / 访客正在看共享的那篇：显示谁在，点开对话框；
 * 看着别的笔记：「协作中：标题」，点一下回到那篇。静态出现，不做动画。
 * 放在标题上方那一行（路径 / 日期）的右端：比这一行高的部分用负外边距溢出去，不把这一行撑高
 */
export function CollabPresence({ docKey }: { docKey: string }) {
  const phase = useCollab((s) => s.phase);
  const members = useCollab((s) => s.members);
  const noteId = useCollab((s) => s.noteId);
  const showShared = useCollab((s) => s.showShared);
  const sharedTitle = useCollab((s) => s.title);
  const ended = useCollab((s) => s.status?.state === "ended");
  // 访客断线重连中：成员表是断之前的，别再说「2 人在编辑」
  const reconnecting = useCollab((s) => s.status?.state === "reconnecting");
  const hostedTitle = useData((s) => s.notes.find((note) => note.id === noteId)?.title ?? "");
  if (phase === "idle" || phase === "joining") return null;

  const hosting = phase === "preparing" || phase === "hosting";
  const here = hosting ? docKey === `note-${noteId}` : showShared;
  const onClick = () => {
    if (here) useCollab.getState().openDialog();
    else if (hosting && noteId) openDocument({ kind: "note", id: noteId });
    else useCollab.getState().setShowShared(true);
  };
  const others = members.filter((member) => member.id !== useCollab.getState().identity?.id);

  return (
    <button
      type="button"
      data-collab-presence
      onClick={onClick}
      title={here ? "协作" : "回到协作的那篇"}
      className="-my-[5px] ml-auto flex h-[30px] shrink-0 items-center gap-2 rounded-lg px-2
                 text-[12px] text-muted transition-colors duration-[160ms] hover:bg-raised hover:text-ink"
    >
      {here ? (
        <>
          <span className="flex -space-x-1.5">
            {others.slice(0, 4).map((member) => (
              <PeerAvatar key={member.id} id={member.id} name={member.name} ring />
            ))}
          </span>
          <span>
            {ended
              ? "协作已结束"
              : reconnecting
                ? "重新连接中…"
                : others.length
                  ? `${members.length} 人在编辑`
                  : "等人加入"}
          </span>
        </>
      ) : (
        <>
          <Users size={13} strokeWidth={2} />
          <span className="max-w-[180px] truncate">
            协作中：{hosting ? hostedTitle : sharedTitle}
          </span>
        </>
      )}
    </button>
  );
}

/* ---------------- 做客那一篇顶上的一行 ---------------- */

export function CollabBanner() {
  const status = useCollab((s) => s.status);
  const permission = useCollab((s) => s.permission);
  const members = useCollab((s) => s.members);
  const stop = useCollab((s) => s.stop);
  const host = members.find((member) => member.host)?.name ?? "主持人";
  let content: ReactNode = null;
  if (status?.state === "reconnecting") {
    content = (
      <p className="text-[13px] text-body">
        连接断了，正在重新连接。你可以接着写，连上后会自动合并。
      </p>
    );
  } else if (status?.state === "ended") {
    content = (
      <>
        <p className="text-[13px] text-body">{endText(status.reason, host)}。要接着写就存一份。</p>
        <div className="mt-2 flex gap-1.5">
          <SaveCopyButton />
          <BannerButton onClick={() => void stop()}>关闭</BannerButton>
        </div>
      </>
    );
  } else if (permission === "read") {
    content = <p className="text-[13px] text-body">{host} 让你只读：能看、能复制，不能改。</p>;
  }
  if (!content) return null;
  return (
    <div data-collab-banner className="mb-7 rounded-xl border border-line bg-raised px-4 py-3">
      {content}
    </div>
  );
}

/** 一个人的头像：自己颜色的实色圆，白字写名字的第一个字 */
export function PeerAvatar({ id, name, ring }: { id: string; name: string; ring?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        `odea-peer-${peerColor(id)} grid size-[18px] shrink-0 place-items-center rounded-full`,
        "text-[10px] font-semibold leading-none text-white",
        ring && "ring-2 ring-canvas",
      )}
      style={{ background: "var(--peer-label)" }}
    >
      {[...name.trim()][0]?.toUpperCase() ?? "?"}
    </span>
  );
}
