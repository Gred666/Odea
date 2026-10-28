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
import {
  type CollabSessionState,
  type CollabTreeDoc,
  type JoinRequest,
  type NearbyKnock,
  endText,
  hostNameOf,
  linkKind,
  sessionName,
  useCollab,
} from "@/collab/store";
import { useData } from "@/data/store";
import type { Diagnosis, MemberInfo, Permission, Reach, Scope } from "@/lib/bindings";
import { cn } from "@/lib/cn";
import { popoverCard, tween } from "@/lib/motion";
import { IS_WINDOWS } from "@/lib/platform";
import {
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  FileText,
  Folder,
  Library,
  Link2,
  LoaderCircle,
  LogOut,
  Plus,
  RefreshCw,
  Users,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { BannerButton } from "./ConflictBanner";

/* ============================================================
   协作的界面（docs/协同编辑.md §8、§25）：
   - CollabDialog：顶上一排会话（主持的、做客的，同时好几个），点哪个看哪个；最后是「加入」。
     主持的一页是邀请链接、加入请求、成员；做客的一页是连接状态、离开；「加入」那一页是粘链接、附近
   - CollabRequests：有人想加入时底部的提示卡（对话框关着的时候）。几个会话的都在这里，写清楚要进哪一个；
     「附近」进来、主持着好几个时，卡片上挑进哪一个
   - CollabPresence：正文区右上角的协作标签（这一篇所在的那次协作谁在，点一下打开它）
   - CollabBanner：做客那一篇顶上的一行（重新连接中、只读、协作结束了）

   P10.1 的遗留：加入表单下面是「附近」（同一个网络里正在分享的人，点一下请求加入）；
   CollabResume 是重启后底部的「继续上次的协作」卡（上次没正常结束的，一次一张）。

   互联网上（P10.2，设计 §8.4、§8.5）：主持人的链接下面是分享前自检（谁能加入、局域网 / IPv6 /
   端口映射 / 中继各怎样，collab/reach.ts 拼的话）；访客连不上时 3 秒内给结论和下一步，能生成
   回连链接；主持人这边能粘访客发来的回连链接。中继的设置在 RelayDialog.tsx。

   外壳和同步对话框一样：遮罩 + 从标题栏往下展开的实心卡片（popoverCard）。展开时只量第一帧，
   所以「正在准备邀请链接」和链接本身占同样的高度（技术方案 §10.1 第 5 条）。
   会话条换一个看是当场换（只变底色、字色），不淡入不位移；提示卡、标签只淡 opacity（CLAUDE.md 动效规矩第 1 条）。
   ============================================================ */

const HEADER = 52;
const DOWNLOAD = "https://github.com/Gred666/Odea/releases/latest";

export function CollabDialog() {
  const open = useCollab((s) => s.dialogOpen);
  const close = useCollab((s) => s.closeDialog);
  const focused = useCollab((s) => (s.focus === null ? undefined : s.sessions[s.focus]));
  const any = useCollab((s) => s.order.length > 0);
  const notice = useCollab((s) => s.notice);

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

  const heading = !focused
    ? "加入协作"
    : focused.role === "host"
      ? "邀请协作"
      : focused.phase === "joining"
        ? "加入协作"
        : "协作";
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
              className="pointer-events-auto relative w-[480px] max-w-[calc(100vw-48px)]
                         overflow-clip rounded-2xl bg-canvas shadow-modal ring-1 ring-line-strong"
            >
              <div
                className="flex items-center gap-2.5 border-b border-line px-4"
                style={{ height: HEADER }}
              >
                <Users size={15} strokeWidth={2} className="shrink-0 text-faint" />
                <p className="flex-1 text-[14px] font-medium text-ink">{heading}</p>
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
              {any && <SessionStrip />}
              <div className="scroll-thin max-h-[64vh] overflow-y-auto px-5 py-4">
                {notice && (
                  <p data-collab-notice className="mb-3 text-[12.5px] leading-[1.6] text-accent">
                    {notice}
                  </p>
                )}
                <Knocks />
                {!focused ? (
                  <JoinForm />
                ) : focused.role === "host" ? (
                  <HostBody key={focused.id} id={focused.id} />
                ) : (
                  <GuestBody key={focused.id} id={focused.id} />
                )}
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

/* ---------------- 会话条 ---------------- */

/** 顶上一排：每个会话一格，最后是「加入」。多了横着滚 */
function SessionStrip() {
  const order = useCollab((s) => s.order);
  const focus = useCollab((s) => s.focus);
  const setFocus = useCollab((s) => s.setFocus);
  return (
    <div
      role="tablist"
      aria-label="正在进行的协作"
      data-collab-strip
      className="scroll-thin flex items-center gap-1 overflow-x-auto border-b border-line px-3 py-2"
    >
      {order.map((id) => (
        <SessionTab key={id} id={id} active={focus === id} />
      ))}
      <button
        type="button"
        role="tab"
        aria-selected={focus === null}
        data-collab-tab-join
        onClick={() => setFocus(null)}
        title="加入别人的协作"
        className={cn(
          "flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12.5px] transition-colors duration-[140ms]",
          focus === null ? "bg-raised text-ink" : "text-muted hover:bg-raised/60 hover:text-body",
        )}
      >
        <Plus size={13} strokeWidth={2} />
        加入
      </button>
    </div>
  );
}

function SessionTab({ id, active }: { id: number; active: boolean }) {
  const session = useCollab((s) => s.sessions[id]);
  const setFocus = useCollab((s) => s.setFocus);
  const noteTitle = useData((s) =>
    session?.noteId ? s.notes.find((note) => note.id === session.noteId)?.title : undefined,
  );
  if (!session) return null;
  const host = session.role === "guest" ? session.members.find((member) => member.host) : null;
  const name = sessionName(session, noteTitle);
  const waiting = session.requests.length > 0;
  const state = session.status?.state;
  const trouble = state === "reconnecting" || state === "unreachable";
  const ended = state === "ended";
  const Icon =
    session.scope?.kind === "folder"
      ? Folder
      : session.scope?.kind === "vault"
        ? Library
        : FileText;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-collab-tab={id}
      onClick={() => setFocus(id)}
      title={
        session.role === "guest" ? `在 ${hostNameOf(session)} 那里：${name}` : `你在主持：${name}`
      }
      className={cn(
        "flex h-7 max-w-[200px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[12.5px]",
        "transition-colors duration-[140ms]",
        active ? "bg-raised text-ink" : "text-muted hover:bg-raised/60 hover:text-body",
        ended && !active && "text-faint",
      )}
    >
      {host ? (
        <PeerAvatar id={host.id} name={host.name} />
      ) : session.role === "guest" ? (
        <LoaderCircle size={13} strokeWidth={2} className="shrink-0 animate-spin text-faint" />
      ) : (
        <Icon size={13} strokeWidth={2} className="shrink-0 opacity-80" />
      )}
      <span className="min-w-0 truncate">{name}</span>
      {/* 有人在等你同意 / 连接有问题：一个小点，静态出现 */}
      {(waiting || trouble) && (
        <span
          aria-label={waiting ? "有人想加入" : "连接有问题"}
          className={cn("size-[6px] shrink-0 rounded-full", waiting ? "bg-accent" : "bg-warning")}
        />
      )}
    </button>
  );
}

/* ---------------- 主持人 ---------------- */

/** 共享的是什么，放进一句话里：「周报」/ 文件夹「项目」/ 仓库「Odea」（设计 §22.5） */
function scopeText(scope: Scope | null, noteTitle: string): string {
  if (scope?.kind === "folder") return `文件夹「${scope.name}」`;
  if (scope?.kind === "vault") return `仓库「${scope.name}」`;
  return `「${noteTitle || scope?.name || ""}」`;
}

function HostBody({ id }: { id: number }) {
  const session = useCollab((s) => s.sessions[id]);
  const stop = useCollab((s) => s.stop);
  const resetInvite = useCollab((s) => s.resetInvite);
  const trustedCount = useCollab((s) => s.trusted.length);
  const noteTitle = useData(
    (s) => s.notes.find((note) => note.id === session?.noteId)?.title ?? "",
  );
  const [copied, setCopied] = useState(false);
  /** 复制出去的是哪一个：之后地址变了（端口映射到了、换了网络）提醒再复制一次 */
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  if (!session) return null;
  const { phase, link, requests, reach, outdated, scope } = session;
  const title = scopeText(scope, noteTitle);

  const copy = async () => {
    if (!link) return;
    setCopiedLink(link);
    // 附一句怎么打开：没装 Odea 的人点不开 odea:// 链接（没有网页兜底，那要服务器）
    await navigator.clipboard
      .writeText(`${link}\n用 Odea 打开这个链接，和我一起编辑${title}。还没装 Odea：${DOWNLOAD}`)
      .catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="flex flex-col gap-4">
      <section>
        <p className="text-[13px] text-body">
          把链接发给要一起编辑<span className="text-ink">{title}</span>的人
          {scope && scope.kind !== "doc" && (
            <span className="text-muted">：里面的哪一篇对方都能打开</span>
          )}
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

      <DialBackLine dialBack={session.dialBack} />
      {pasting && <CallbackField onDone={() => setPasting(false)} />}

      {requests.length > 0 && (
        <section className="flex flex-col gap-1.5">
          {requests.map((request) => (
            <RequestRow key={request.request} id={id} request={request} title={title} />
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

      <MemberList session={session} editable />

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
          <BannerButton onClick={() => void resetInvite(id)}>
            <RefreshCw size={12} strokeWidth={2} />
            换一个链接
          </BannerButton>
        )}
        <BannerButton danger onClick={() => void stop(id)}>
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
function DialBackLine({ dialBack }: { dialBack: CollabSessionState["dialBack"] }) {
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

function RequestRow({ id, request, title }: { id: number; request: JoinRequest; title: string }) {
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
      <AnswerButtons onAnswer={(allow) => void answer(id, request.request, allow)} />
    </div>
  );
}

/** 加入请求后半句：拿着链接的、「附近」点进来的、经别的访客转发来的（设计 §20.9） */
function requestText(request: JoinRequest, title: string): string {
  if (request.via) return ` 经由 ${request.via} 转发，想加入${title}`;
  return request.invited ? ` 想加入${title}` : ` 在同一个网络里，想加入${title}`;
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

/* ---------------- 「附近」进来、主持着好几个：挑进哪一个（设计 §25.1） ---------------- */

/** 对话框里：等着挑的那几位 */
function Knocks() {
  const knocks = useCollab((s) => s.knocks);
  if (!knocks.length) return null;
  return (
    <section className="mb-4 flex flex-col gap-1.5">
      {knocks.map((knock) => (
        <KnockCard key={knock.request} knock={knock} />
      ))}
    </section>
  );
}

/** 主持着的、已经准备好的几个（挑「附近」那位进哪一个） */
function useHostedSessions(): Array<{ id: number; name: string }> {
  const notes = useData((s) => s.notes);
  const sessions = useCollab(
    useShallow((s) =>
      s.order
        .map((id) => s.sessions[id])
        .filter(
          (session): session is CollabSessionState =>
            session?.role === "host" && session.phase === "hosting",
        ),
    ),
  );
  return sessions.map((session) => ({
    id: session.id,
    name: sessionName(session, notes.find((note) => note.id === session.noteId)?.title),
  }));
}

/**
 * 「附近」点进来一位、我主持着好几个：挑进哪一个（点了就进，按选的权限，不再问第二遍）。
 * inverted 是底部提示卡（深底白字）
 */
function KnockCard({ knock, inverted }: { knock: NearbyKnock; inverted?: boolean }) {
  const answerKnock = useCollab((s) => s.answerKnock);
  const hosted = useHostedSessions();
  const [permission, setPermission] = useState<Permission>("edit");
  const chip = (active: boolean) =>
    cn(
      "rounded-md px-2 py-1 text-[12px] transition-colors duration-[140ms]",
      inverted
        ? active
          ? "bg-canvas/20 text-canvas"
          : "text-canvas/60 hover:text-canvas"
        : active
          ? "bg-canvas text-ink shadow-[0_0_0_1px_var(--color-line)]"
          : "text-muted hover:text-body",
    );
  return (
    <div
      data-collab-knock
      className={cn(
        "flex flex-col gap-2 rounded-lg px-3 py-2.5",
        inverted ? "" : "border border-accent-line bg-accent-wash",
      )}
    >
      <div className="flex items-center gap-2">
        <PeerAvatar id={knock.id} name={knock.name} />
        <p className={cn("min-w-0 flex-1 truncate text-[13px]", inverted ? "" : "text-ink")}>
          {knock.name}
          <span className={inverted ? "opacity-70" : "text-muted"}>
            {" 在同一个网络里，想加入：进哪一个？"}
          </span>
        </p>
        <span
          className={cn(
            "flex shrink-0 items-center rounded-md p-0.5",
            inverted ? "bg-canvas/10" : "bg-raised",
          )}
        >
          <button
            type="button"
            aria-pressed={permission === "edit"}
            onClick={() => setPermission("edit")}
            className={chip(permission === "edit")}
          >
            可编辑
          </button>
          <button
            type="button"
            aria-pressed={permission === "read"}
            onClick={() => setPermission("read")}
            className={chip(permission === "read")}
          >
            只读
          </button>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-[26px]">
        {hosted.map((session) => (
          <button
            key={session.id}
            type="button"
            data-collab-knock-into={session.id}
            onClick={() => void answerKnock(knock.request, session.id, permission)}
            className={cn(
              "max-w-[200px] truncate rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors duration-[140ms]",
              inverted
                ? "bg-canvas text-ink hover:bg-canvas/85"
                : "bg-accent text-accent-ink hover:bg-accent-hover",
            )}
          >
            {session.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void answerKnock(knock.request, null, permission)}
          className={cn(
            "rounded-md px-2 py-1 text-[12px] transition-colors duration-[140ms]",
            inverted ? "text-canvas/70 hover:bg-canvas/15" : "text-muted hover:bg-raised",
          )}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

function MemberList({ session, editable }: { session: CollabSessionState; editable?: boolean }) {
  const identity = useCollab((s) => s.identity);
  const setPermission = useCollab((s) => s.setPermission);
  const kick = useCollab((s) => s.kick);
  const trusted = useCollab((s) => s.trusted);
  const remember = useCollab((s) => s.remember);
  const forget = useCollab((s) => s.forget);
  const notes = useData((s) => s.notes);
  const { id, members, scope } = session;
  if (!members.length) return null;
  /** 主持人这边：他开着哪几篇（一篇的范围不用说） */
  const viewing = (member: MemberInfo) =>
    editable && scope?.kind !== "doc"
      ? member.docs
          .map((doc) => notes.find((note) => note.id === doc)?.title)
          .filter(Boolean)
          .join("、")
      : "";
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
                {viewing(member) && (
                  <span data-collab-viewing className="text-[12px] text-faint">
                    {" "}
                    · 在看 {viewing(member)}
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
                      void setPermission(id, member.member, event.target.value as Permission)
                    }
                    className="rounded-md bg-transparent px-1 py-0.5 text-[12px] text-body hover:bg-raised"
                  >
                    <option value="edit">可编辑</option>
                    <option value="read">只读</option>
                  </select>
                  <BannerButton danger onClick={() => void kick(id, member.member)}>
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

function GuestBody({ id }: { id: number }) {
  const session = useCollab((s) => s.sessions[id]);
  const shownHere = useCollab((s) => s.showShared && s.shownSession === id);
  const setShowShared = useCollab((s) => s.setShowShared);
  const stop = useCollab((s) => s.stop);
  const close = useCollab((s) => s.closeDialog);
  if (!session) return null;
  const { status, members, title, permission, relayed, scope, current } = session;
  const host = hostNameOf(session);
  const many = !!scope && scope.kind !== "doc";

  if (status?.state === "unreachable") {
    return <Unreachable id={id} diagnosis={status.diagnosis} host={host} />;
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
            (many
              ? `${host} 共享了${scopeText(scope, "")}${permission === "read" ? "（只读）" : ""}：挑一篇打开`
              : permission === "read"
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
      {many && status?.state === "connected" && <SharedTree id={id} />}
      <MemberList session={session} />
      {status?.state === "connected" && <ForwardLink id={id} host={host} />}
      <div className="flex items-center gap-1.5 border-t border-line pt-3">
        <NameField />
        <span className="flex-1" />
        {(status?.state === "connected" || status?.state === "reconnecting") &&
          !shownHere &&
          current && (
            <BannerButton
              onClick={() => {
                setShowShared(true, id);
                close();
              }}
            >
              回到这篇
            </BannerButton>
          )}
        {/* 文件夹、整个仓库的范围存的是开着的那一篇：还没开就没有可存的 */}
        {members.length > 0 && current && <SaveCopyButton id={id} />}
        <BannerButton danger onClick={() => void stop(id)}>
          <LogOut size={12} strokeWidth={2} />
          {line.ended ? "关闭" : "离开"}
        </BannerButton>
      </div>
    </div>
  );
}

/**
 * 文件夹、整个仓库的范围（设计 §22.5）：主持人给的树，按文件夹分开列，点一篇就开它；能写的还能新建一篇。
 * 协作对话框里有，访客窗口的左边也是它（compact）
 */
export function SharedTree({ id, compact }: { id: number; compact?: boolean }) {
  const session = useCollab((s) => s.sessions[id]);
  const shownHere = useCollab((s) => s.shownSession === id);
  const openShared = useCollab((s) => s.openShared);
  const createShared = useCollab((s) => s.createShared);
  const [newTitle, setNewTitle] = useState("");
  if (!session) return null;
  const { tree, openDocs, permission } = session;
  const current = shownHere ? session.current : null;
  const docs = tree?.docs ?? [];
  const folders = [...new Set(docs.map((doc) => doc.folder))];
  const create = async () => {
    const title = newTitle.trim();
    if (!title) return;
    setNewTitle("");
    await createShared(id, "", title);
  };
  const row = (doc: CollabTreeDoc) => (
    <li key={doc.id}>
      <button
        type="button"
        data-collab-tree-doc
        onClick={() => void openShared(id, doc.id)}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-[140ms]",
          doc.id === current ? "bg-raised text-ink" : "text-body hover:bg-raised/60",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{doc.title || "无标题"}</span>
        {openDocs.includes(doc.id) && doc.id !== current && (
          <span className="text-[11.5px] text-faint">开着</span>
        )}
      </button>
    </li>
  );
  return (
    <section data-collab-tree className={compact ? "flex min-h-0 flex-col" : undefined}>
      {!compact && <p className="mb-1.5 text-[12px] text-faint">里面的笔记 · {docs.length}</p>}
      <div
        className={cn(
          compact
            ? "scroll-thin min-h-0 flex-1 overflow-y-auto"
            : "scroll-thin max-h-[240px] overflow-y-auto",
        )}
      >
        {docs.length === 0 ? (
          <p className="px-2 py-1.5 text-[12.5px] text-muted">
            {tree ? "这里面还没有笔记" : "正在拿主持人那边的目录…"}
          </p>
        ) : (
          folders.map((folder) => (
            <div key={folder || "/"} className="mb-1">
              {folder && (
                <p className="truncate px-2 pt-1.5 pb-0.5 text-[11.5px] text-faint" title={folder}>
                  {folder}
                </p>
              )}
              <ul className="flex flex-col">
                {docs.filter((doc) => doc.folder === folder).map(row)}
              </ul>
            </div>
          ))
        )}
      </div>
      {permission === "edit" && (
        <div className="mt-1.5 flex h-8 items-center gap-1.5 rounded-md bg-raised/60 pr-1 pl-2">
          <input
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) void create();
            }}
            placeholder="新建一篇：标题"
            aria-label="新建一篇的标题"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-faint"
          />
          <BannerButton disabled={!newTitle.trim()} onClick={() => void create()}>
            新建
          </BannerButton>
        </div>
      )}
    </section>
  );
}

/**
 * 转发链接（设计 §20.9）：有人连不上主持人、却连得上我（比如和我在同一个网络里，主持人只有我够得着），
 * 我把这个链接发给他，他经我加入。主持人照样确认、照样管他的权限；我这边只是一根管子
 */
function ForwardLink({ id, host }: { id: number; host: string }) {
  const forward = useCollab((s) => s.sessions[id]?.forward ?? null);
  const busy = useCollab((s) => s.sessions[id]?.forwardBusy ?? false);
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
        <BannerButton disabled={busy} onClick={() => void make(id)}>
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
function Unreachable({ id, diagnosis, host }: { id: number; diagnosis: Diagnosis; host: string }) {
  const stop = useCollab((s) => s.stop);
  const callback = useCollab((s) => s.sessions[id]?.callback ?? null);
  const busy = useCollab((s) => s.sessions[id]?.callbackBusy ?? false);
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
          <BannerButton disabled={busy} onClick={() => void makeCallback(id)}>
            {busy ? (
              <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />
            ) : (
              <Link2 size={12} strokeWidth={2} />
            )}
            {busy ? "正在看能不能被连进来…" : "生成回连链接"}
          </BannerButton>
        )}
        <BannerButton onClick={() => useRelays.getState().openRelays()}>配中继…</BannerButton>
        <BannerButton danger onClick={() => void stop(id)}>
          <LogOut size={12} strokeWidth={2} />
          离开
        </BannerButton>
      </div>
    </div>
  );
}

function SaveCopyButton({ id }: { id: number }) {
  const saveCopy = useCollab((s) => s.saveCopy);
  const [busy, setBusy] = useState(false);
  return (
    <BannerButton
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const note = await saveCopy(id);
          if (note) {
            useCollab.getState().setShowShared(false);
            useCollab.getState().closeDialog();
            openDocument({ kind: "note", id: note });
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

/** 几个会话里等着同意的人（每一位带着要进哪一个） */
function usePendingRequests(): Array<{ id: number; request: JoinRequest; title: string }> {
  const notes = useData((s) => s.notes);
  const sessions = useCollab(
    useShallow((s) =>
      s.order
        .map((id) => s.sessions[id])
        .filter(
          (session): session is CollabSessionState =>
            session?.role === "host" && session.requests.length > 0,
        ),
    ),
  );
  return sessions.flatMap((session) => {
    const title = scopeText(
      session.scope,
      notes.find((note) => note.id === session.noteId)?.title ?? "",
    );
    return session.requests.map((request) => ({ id: session.id, request, title }));
  });
}

export function CollabRequests() {
  const pending = usePendingRequests();
  const knocks = useCollab((s) => s.knocks);
  const dialogOpen = useCollab((s) => s.dialogOpen);
  const answer = useCollab((s) => s.answer);
  const shown = dialogOpen ? [] : pending.slice(0, 3);
  const shownKnocks = dialogOpen ? [] : knocks.slice(0, 2);
  return (
    <AnimatePresence initial={false}>
      {shownKnocks.map((knock) => (
        <motion.div
          key={`knock-${knock.request}`}
          role="alertdialog"
          aria-label={`${knock.name} 想加入`}
          data-collab-knock-toast
          // 只淡入：不位移、不缩放（CLAUDE.md 动效规矩第 1 条）
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: tween.fast }}
          transition={tween.base}
          className="pointer-events-auto w-[480px] max-w-[calc(100vw-48px)] rounded-xl bg-ink
                     text-canvas shadow-float"
        >
          <KnockCard knock={knock} inverted />
        </motion.div>
      ))}
      {shown.map(({ id, request, title }) => (
        <motion.div
          key={`${id}-${request.request}`}
          role="alertdialog"
          aria-label={`${request.name} 想加入`}
          data-collab-request-toast
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
          <AnswerButtons inverted onAnswer={(allow) => void answer(id, request.request, allow)} />
        </motion.div>
      ))}
    </AnimatePresence>
  );
}

/* ---------------- 重启后：继续上次没正常结束的协作 ---------------- */

/**
 * 上次协作时 Odea 崩了、被强退了：底部问一句，一次一张（最多三张）。主持人「继续协作」用同一个会话 id
 * 和端口重新起来，访客那边自己接上；访客「重新加入」用落盘的状态，断线期间各自写的同步时补齐。只淡 opacity
 */
export function CollabResume() {
  const resume = useCollab((s) => s.resume);
  const notes = useData((s) => s.notes);
  const items: Array<{ key: string; host: boolean; text: string; action: string }> = [];
  for (const host of resume?.hosts ?? []) {
    const note = notes.find((item) => item.id === host.note);
    const what =
      host.scope && host.scope.kind !== "doc"
        ? scopeText(host.scope, "")
        : `「${note?.title ?? host.title}」`;
    const who = host.guests ? `和 ${host.guests} 个人一起` : "";
    items.push({
      key: host.key,
      host: true,
      text: `上次${who}编辑${what}时 Odea 没有正常退出`,
      action: "继续协作",
    });
  }
  for (const guest of resume?.guests ?? []) {
    const host = guest.hostName || "主持人";
    const title = guest.title ? `「${guest.title}」` : "";
    items.push({
      key: guest.key,
      host: false,
      text: `上次在 ${host} 那里做客${title}时 Odea 没有正常退出`,
      action: "重新加入",
    });
  }
  return (
    <AnimatePresence initial={false}>
      {items.slice(0, 3).map((item) => (
        <motion.div
          key={`${item.host ? "host" : "guest"}-${item.key}`}
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
                ? useCollab.getState().resumeHost(item.key)
                : useCollab.getState().resumeGuest(item.key))
            }
            className="shrink-0 rounded-md bg-canvas px-2 py-1 text-[12px] font-medium text-ink
                       transition-colors duration-[140ms] hover:bg-canvas/85"
          >
            {item.action}
          </button>
          <button
            type="button"
            onClick={() => void useCollab.getState().discardResume(item.host, item.key)}
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

/** 正文区这一篇在哪个会话里：主持的笔记、做客显示的那一篇。不在协作里是 null */
function useSessionHere(docKey: string): number | null {
  return useCollab((s) => {
    if (docKey.startsWith("note-")) return s.hostedIn[docKey.slice(5)] ?? null;
    if (docKey.startsWith("shared-") && s.showShared) return s.shownSession;
    return null;
  });
}

/**
 * 协作中才有。正文区这一篇在一次协作里：显示谁在，点开那一次；看着别的笔记：只有一次协作时
 * 「协作中：标题」点一下回到那篇，好几次时「n 个协作」点一下打开对话框。静态出现，不做动画。
 * 放在标题上方那一行（路径 / 日期）的右端：比这一行高的部分用负外边距溢出去，不把这一行撑高
 */
export function CollabPresence({ docKey }: { docKey: string }) {
  const hereId = useSessionHere(docKey);
  const here = useCollab((s) => (hereId === null ? undefined : s.sessions[hereId]));
  const identity = useCollab((s) => s.identity);
  // 还在加入的不算（连上之前什么都没有）
  const live = useCollab(
    useShallow((s) => s.order.filter((id) => s.sessions[id]?.phase !== "joining")),
  );
  const only = useCollab((s) => (live.length === 1 ? s.sessions[live[0]!] : undefined));
  const onlyTitle = useData((s) =>
    only?.noteId ? s.notes.find((note) => note.id === only.noteId)?.title : undefined,
  );
  if (!here && !live.length) return null;

  const className = `-my-[5px] ml-auto flex h-[30px] shrink-0 items-center gap-2 rounded-lg px-2
                 text-[12px] text-muted transition-colors duration-[160ms] hover:bg-raised hover:text-ink`;

  if (here) {
    const others = here.members.filter((member) => member.id !== identity?.id);
    const state = here.status?.state;
    return (
      <button
        type="button"
        data-collab-presence
        onClick={() => useCollab.getState().openSession(here.id)}
        title="协作"
        className={className}
      >
        <span className="flex -space-x-1.5">
          {others.slice(0, 4).map((member) => (
            <PeerAvatar key={member.id} id={member.id} name={member.name} ring />
          ))}
        </span>
        <span>
          {state === "ended"
            ? "协作已结束"
            : // 访客断线重连中：成员表是断之前的，别再说「2 人在编辑」
              state === "reconnecting"
              ? "重新连接中…"
              : others.length
                ? `${here.members.length} 人在编辑`
                : "等人加入"}
        </span>
      </button>
    );
  }

  const onClick = () => {
    const collab = useCollab.getState();
    if (!only) {
      collab.openDialog();
      return;
    }
    // 只有一次：回到协作的那篇（主持一篇的、做客开着一篇的），不然打开它
    if (only.role === "host" && only.noteId) openDocument({ kind: "note", id: only.noteId });
    else if (only.role === "guest" && only.current) collab.setShowShared(true, only.id);
    else collab.openSession(only.id);
  };
  return (
    <button
      type="button"
      data-collab-presence
      onClick={onClick}
      title={only ? "回到协作的那篇" : "正在进行的协作"}
      className={className}
    >
      <Users size={13} strokeWidth={2} />
      <span className="max-w-[180px] truncate">
        {only ? `协作中：${sessionName(only, onlyTitle)}` : `${live.length} 个协作进行中`}
      </span>
    </button>
  );
}

/* ---------------- 做客那一篇顶上的一行 ---------------- */

export function CollabBanner() {
  const session = useCollab((s) =>
    s.shownSession === null ? undefined : s.sessions[s.shownSession],
  );
  const stop = useCollab((s) => s.stop);
  if (!session) return null;
  const { status, permission } = session;
  const host = hostNameOf(session);
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
          <SaveCopyButton id={session.id} />
          <BannerButton onClick={() => void stop(session.id)}>关闭</BannerButton>
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
