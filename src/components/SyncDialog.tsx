import { useApp } from "@/app/store";
import { backend } from "@/data/backend";
import { messageOf, useData } from "@/data/store";
import type {
  SyncAccount,
  SyncDeviceCode,
  SyncPlan,
  SyncProviderKey,
  SyncProxy,
  SyncRemoteRepo,
  SyncStatus,
} from "@/data/types";
import { openExternal } from "@/editor/links";
import { cn } from "@/lib/cn";
import { popoverCard, tween } from "@/lib/motion";
import { describeSync, formatBytes, formatSyncedAt } from "@/lib/syncText";
import { ChevronLeft, Cloud, Copy, Github, Globe, LoaderCircle, Lock, Plus, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

/* ============================================================
   同步对话框（技术方案 §5.9.7、§5.9.9）。导航栏的同步那一行、命令面板「同步…」打开它。

   没开同步时是开启的几步：选托管方 → 登录（GitHub 设备码 / Gitee 私人令牌）→
   选一个仓库或新建一个 → 看一眼云端，说清楚接下来会发生什么 → 开启。
   开了之后是同步状态：上次同步、没推的改动、太大没同步的文件、出了什么错；
   立即同步、断开同步；登录失效时就地重新登录。

   外壳和命令面板一样：模糊遮罩 + 从标题栏往下展开的实心卡片（popoverCard），
   里面的字不缩放、不变透明。
   ============================================================ */

const HEADER = 52;

const PROVIDERS: Record<SyncProviderKey, { label: string; note: string }> = {
  github: { label: "GitHub", note: "国内访问可能要开代理" },
  gitee: { label: "Gitee", note: "国内直连。免费仓库最多 500 MB，单个文件 50 MB" },
};

const GITEE_TOKEN_PAGE = "https://gitee.com/profile/personal_access_tokens/new";

export function SyncDialog() {
  const open = useApp((s) => s.syncOpen);
  const setOpen = useApp((s) => s.setSyncOpen);

  // 关掉对话框时，正在等浏览器确认的 GitHub 登录也停掉（没有在等的话什么都不做）
  useEffect(() => {
    if (!open) void backend().then((api) => api.syncLoginCancel());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* 遮罩和面板分开：见 CommandPalette 里的说明（backdrop-filter 和 opacity 的坑） */}
          <motion.button
            key="scrim"
            type="button"
            data-ghost-skip
            aria-label="关闭同步"
            onClick={() => setOpen(false)}
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
              aria-label="同步"
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
                <Cloud size={15} strokeWidth={2} className="shrink-0 text-faint" />
                <p className="flex-1 text-[14px] font-medium text-ink">同步</p>
                <button
                  type="button"
                  aria-label="关闭"
                  onClick={() => setOpen(false)}
                  className="grid h-7 w-7 place-items-center rounded-md text-muted
                             transition-colors duration-[140ms] hover:bg-raised hover:text-ink"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </div>
              <div className="scroll-thin max-h-[62vh] overflow-y-auto px-5 py-4">
                <SyncBody />
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

function SyncBody() {
  const status = useData((s) => s.syncStatus);
  return status.state === "off" ? <SetupFlow /> : <StatusView status={status} />;
}

/* ---------------- 开启同步 ---------------- */

/**
 * GitHub 设备码登录：领一个码（交给 onCode 显示）→ 等用户在浏览器里确认。
 * 在点击里调，不放进 effect：StrictMode 下 effect 会跑两次，第二次去等时那次登录已经被第一次拿走了
 */
async function githubLogin(onCode: (code: SyncDeviceCode) => void): Promise<SyncAccount> {
  const api = await backend();
  const code = await api.syncGithubLoginStart();
  onCode(code);
  return api.syncGithubLoginWait();
}

/** 等登录时被取消（点了返回、关了对话框、又开始了一次新的）：不算错 */
const cancelled = (message: string) => message.includes("取消");

type Step =
  | { kind: "provider" }
  | { kind: "github"; code: SyncDeviceCode }
  | { kind: "gitee" }
  | { kind: "repos"; account: SyncAccount }
  | { kind: "confirm"; account: SyncAccount; repo: SyncRemoteRepo; plan: SyncPlan };

function SetupFlow() {
  const [step, setStep] = useState<Step>({ kind: "provider" });
  const [accounts, setAccounts] = useState<SyncAccount[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void backend()
      .then((api) => api.syncAccounts())
      .then(setAccounts)
      .catch(() => {});
  }, []);

  /** 跑一件要等的事：期间显示 `label`，出错显示原因 */
  const run = useCallback(async (label: string, task: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  const loggedIn = (account: SyncAccount) => {
    setAccounts((list) => [...list.filter((a) => a.provider !== account.provider), account]);
    setStep({ kind: "repos", account });
  };

  const choose = (provider: SyncProviderKey) => {
    const account = accounts.find((a) => a.provider === provider);
    if (account) {
      setStep({ kind: "repos", account });
    } else if (provider === "gitee") {
      setError(null);
      setStep({ kind: "gitee" });
    } else {
      setBusy("正在向 GitHub 要验证码…");
      setError(null);
      githubLogin((code) => {
        setBusy(null);
        setStep({ kind: "github", code });
      })
        .then(loggedIn)
        .catch((cause) => {
          setBusy(null);
          const message = messageOf(cause);
          if (!cancelled(message)) setError(message);
        });
    }
  };

  const back = () => {
    setError(null);
    if (step.kind === "github") void backend().then((api) => api.syncLoginCancel());
    setStep({ kind: "provider" });
  };

  return (
    <div>
      {step.kind !== "provider" && (
        <button
          type="button"
          onClick={back}
          className="-ml-1 mb-3 flex items-center gap-0.5 rounded-md px-1 py-0.5 text-[12px] text-muted
                     transition-colors duration-[140ms] hover:bg-raised hover:text-ink"
        >
          <ChevronLeft size={13} strokeWidth={2} />
          换个托管方
        </button>
      )}

      {step.kind === "provider" && (
        <ProviderStep accounts={accounts} busy={busy} onChoose={choose} />
      )}
      {step.kind === "github" && <GitHubLogin code={step.code} />}
      {step.kind === "gitee" && <GiteeLogin busy={busy} run={run} onDone={loggedIn} />}
      {step.kind === "repos" && (
        <RepoStep
          account={step.account}
          busy={busy}
          run={run}
          onLogout={() => {
            setAccounts((list) => list.filter((a) => a.provider !== step.account.provider));
            setStep({ kind: "provider" });
          }}
          onPick={(repo, plan) => setStep({ kind: "confirm", account: step.account, repo, plan })}
        />
      )}
      {step.kind === "confirm" && (
        <ConfirmStep
          account={step.account}
          repo={step.repo}
          plan={step.plan}
          busy={busy}
          run={run}
          onBack={() => setStep({ kind: "repos", account: step.account })}
        />
      )}

      {error && <ErrorBox>{error}</ErrorBox>}
      {step.kind === "provider" && <ProxyLine />}
    </div>
  );
}

function ProviderStep({
  accounts,
  busy,
  onChoose,
}: {
  accounts: SyncAccount[];
  busy: string | null;
  onChoose: (provider: SyncProviderKey) => void;
}) {
  return (
    <div>
      <p className="text-[13px] leading-[1.7] text-body">
        {"把整个笔记文件夹（包括附件）同步到你自己账号下的一个私有仓库。" +
          "每台电脑上的应用都连同一个仓库，改动会自动合并；两边改了同一处时，另一版另存成冲突副本，不会丢。"}
      </p>
      <div className="mt-4 grid grid-cols-2 gap-2.5">
        {(Object.keys(PROVIDERS) as SyncProviderKey[]).map((key) => {
          const account = accounts.find((a) => a.provider === key);
          return (
            <button
              key={key}
              type="button"
              disabled={!!busy}
              onClick={() => onChoose(key)}
              className="flex flex-col items-start gap-1 rounded-xl border border-line-strong px-3.5 py-3
                         text-left transition-colors duration-[140ms] hover:border-accent-line
                         hover:bg-accent-wash disabled:opacity-60"
            >
              <span className="flex items-center gap-1.5 text-[14px] font-medium text-ink">
                {key === "github" ? (
                  <Github size={14} strokeWidth={2} />
                ) : (
                  <Globe size={14} strokeWidth={2} />
                )}
                {PROVIDERS[key].label}
              </span>
              {/* 固定两行高：账号是异步读的，读到后「已登录 xxx」只有一行，卡片不能跟着变矮
                  （展开动画已经按读到之前的高度量好了，见下面 ProxyLine 的说明） */}
              <span className="min-h-[3.2em] text-[12px] leading-[1.6] text-muted">
                {account ? `已登录 ${account.login}` : PROVIDERS[key].note}
              </span>
            </button>
          );
        })}
      </div>
      {busy && <Working>{busy}</Working>}
    </div>
  );
}

/** 设备码和「复制并打开 GitHub」。等确认的那一步在 githubLogin 里，确认了上层自己往下走 */
function GitHubLogin({ code }: { code: SyncDeviceCode }) {
  const [copied, setCopied] = useState(false);

  const openGitHub = async () => {
    try {
      await navigator.clipboard.writeText(code.userCode);
      setCopied(true);
    } catch {
      // 复制不了就让用户照着抄
    }
    await openExternal(code.verificationUri);
  };

  return (
    <div>
      <p className="text-[13px] leading-[1.7] text-body">
        {"在浏览器里登录 GitHub，输入下面的验证码，再点「Authorize」同意。"}
      </p>
      <p className="mt-1.5 text-[12px] leading-[1.65] text-muted">
        {"授权页上会写能读写你的私有仓库 —— GitHub 的权限没法只给一个仓库。" +
          "应用只会用它同步你选的那一个；令牌只存在这台电脑的系统钥匙串里。"}
      </p>
      <div className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-raised/50 py-4">
        <span className="select-all font-mono text-[24px] font-semibold tracking-[0.12em] text-ink">
          {code.userCode}
        </span>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <PrimaryButton onClick={() => void openGitHub()}>
          <Copy size={13} strokeWidth={2} />
          {copied ? "已复制，再开一次 GitHub" : "复制验证码并打开 GitHub"}
        </PrimaryButton>
      </div>
      <Working>等你在浏览器里确认…（验证码 {Math.round(code.expiresIn / 60)} 分钟内有效）</Working>
    </div>
  );
}

function GiteeLogin({
  busy,
  run,
  onDone,
}: {
  busy: string | null;
  run: (label: string, task: () => Promise<void>) => Promise<void>;
  onDone: (account: SyncAccount) => void;
}) {
  const [token, setToken] = useState("");
  const submit = () =>
    void run("正在验证令牌…", async () => {
      onDone(await (await backend()).syncGiteeLogin(token));
    });
  return (
    <div>
      <p className="text-[13px] leading-[1.7] text-body">
        {"在 Gitee 的「设置 → 私人令牌」里生成一个令牌（权限勾上 "}
        <b className="font-medium">projects</b>
        {"），粘贴到这里。令牌只存在这台电脑的系统钥匙串里。"}
      </p>
      <div className="mt-3">
        <SecondaryButton onClick={() => void openExternal(GITEE_TOKEN_PAGE)}>
          打开 Gitee 私人令牌页面
        </SecondaryButton>
      </div>
      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim()) submit();
        }}
      >
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="粘贴私人令牌"
          aria-label="Gitee 私人令牌"
          autoComplete="off"
          spellCheck={false}
          className="h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-canvas px-3 text-[13px]
                     text-ink outline-none placeholder:text-faint focus:border-accent"
        />
        <PrimaryButton type="submit" disabled={!token.trim() || !!busy}>
          登录
        </PrimaryButton>
      </form>
      {busy && <Working>{busy}</Working>}
    </div>
  );
}

function RepoStep({
  account,
  busy,
  run,
  onLogout,
  onPick,
}: {
  account: SyncAccount;
  busy: string | null;
  run: (label: string, task: () => Promise<void>) => Promise<void>;
  onLogout: () => void;
  onPick: (repo: SyncRemoteRepo, plan: SyncPlan) => void;
}) {
  const [repos, setRepos] = useState<SyncRemoteRepo[] | null>(null);
  const [name, setName] = useState("ontheway-notes");
  const label = PROVIDERS[account.provider].label;

  useEffect(() => {
    void run(`正在读取 ${label} 上的仓库…`, async () => {
      setRepos(await (await backend()).syncRepos(account.provider));
    });
  }, [account.provider, label, run]);

  const inspect = (repo: SyncRemoteRepo) =>
    run("正在看看云端…", async () => {
      onPick(repo, await (await backend()).syncInspect(account.provider, repo.cloneUrl));
    });

  return (
    <div>
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <span>
          已登录 {label} · <span className="text-body">{account.login}</span>
        </span>
        <button
          type="button"
          onClick={() =>
            void run("正在退出…", async () => {
              await (await backend()).syncLogout(account.provider);
              onLogout();
            })
          }
          className="rounded px-1 text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          换个账号
        </button>
      </div>

      <p className="mt-4 text-[12px] font-medium text-muted">新建一个私有仓库</p>
      <form
        className="mt-1.5 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run("正在新建仓库…", async () => {
            const repo = await (await backend()).syncCreateRepo(account.provider, name);
            onPick(repo, await (await backend()).syncInspect(account.provider, repo.cloneUrl));
          });
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="新仓库的名字"
          spellCheck={false}
          className="h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-canvas px-3 font-mono
                     text-[13px] text-ink outline-none focus:border-accent"
        />
        <PrimaryButton type="submit" disabled={!name.trim() || !!busy}>
          <Plus size={13} strokeWidth={2.2} />
          新建
        </PrimaryButton>
      </form>

      <p className="mt-5 text-[12px] font-medium text-muted">或者选一个已有的</p>
      <div className="mt-1.5 overflow-hidden rounded-xl border border-line-strong">
        {repos === null ? (
          <p className="px-3.5 py-3 text-[13px] text-faint">读取中…</p>
        ) : repos.length === 0 ? (
          <p className="px-3.5 py-3 text-[13px] text-faint">这个账号下还没有仓库</p>
        ) : (
          <div className="scroll-thin max-h-[208px] overflow-y-auto">
            {repos.map((repo) => (
              <button
                key={repo.cloneUrl}
                type="button"
                disabled={!!busy}
                onClick={() => void inspect(repo)}
                className="flex w-full items-center gap-2 border-b border-line px-3.5 py-2.5 text-left
                           transition-colors duration-[140ms] last:border-b-0 hover:bg-raised/55
                           disabled:opacity-60"
              >
                {repo.private ? (
                  <Lock size={12} strokeWidth={2} className="shrink-0 text-faint" />
                ) : (
                  <Globe size={12} strokeWidth={2} className="shrink-0 text-warning" />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">
                  {repo.fullName}
                </span>
                {!repo.private && <span className="text-[12px] text-warning">公开</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {busy && <Working>{busy}</Working>}
    </div>
  );
}

function ConfirmStep({
  account,
  repo,
  plan,
  busy,
  run,
  onBack,
}: {
  account: SyncAccount;
  repo: SyncRemoteRepo;
  plan: SyncPlan;
  busy: string | null;
  run: (label: string, task: () => Promise<void>) => Promise<void>;
  onBack: () => void;
}) {
  const [bringLocal, setBringLocal] = useState(false);
  const enable = () =>
    run(plan.connectHere ? "正在开启同步…" : "正在下载云端的笔记…", async () => {
      const switched = await (await backend()).syncEnable(
        account.provider,
        repo.cloneUrl,
        bringLocal,
      );
      // clone 到了新文件夹、换了仓库：和「更换笔记文件夹」一样整页重载
      if (switched) window.location.reload();
    });

  return (
    <div>
      <p className="font-mono text-[13px] text-ink">{repo.fullName}</p>
      {plan.connectHere ? (
        <p className="mt-2 text-[13px] leading-[1.7] text-body">
          {"把这台电脑上的笔记推到这个仓库。以后在别的电脑上登录同一个账号、选这个仓库，就能拿到这些笔记。" +
            "第一次要上传所有文件，可能要等一会儿。"}
        </p>
      ) : (
        <>
          <p className="mt-2 text-[13px] leading-[1.7] text-body">
            这个仓库里已经有笔记了。会把它们下载到一个新文件夹，再切换过去；现在的笔记文件夹原样留着。
          </p>
          <p className="mt-1.5 break-all rounded-lg bg-raised/50 px-3 py-2 font-mono text-[12px] text-muted">
            {plan.cloneTarget}
          </p>
          {plan.localNotes && (
            <label className="mt-3 flex cursor-pointer items-start gap-2 text-[13px] leading-[1.6] text-body">
              <input
                type="checkbox"
                checked={bringLocal}
                onChange={(e) => setBringLocal(e.target.checked)}
                className="mt-[3px] accent-[var(--color-accent)]"
              />
              <span>
                把这台电脑上现在的笔记也合并进去
                <span className="block text-[12px] text-muted">
                  同名的两份都留着；新装的应用里只有示例笔记的话，不用勾
                </span>
              </span>
            </label>
          )}
        </>
      )}
      {!repo.private && (
        <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-[12px] leading-[1.6] text-warning">
          这是一个公开仓库，所有人都能看到你的笔记。建议换成私有仓库。
        </p>
      )}
      <div className="mt-4 flex items-center gap-2">
        <PrimaryButton disabled={!!busy} onClick={() => void enable()}>
          {plan.connectHere ? "开始同步" : "下载并切换"}
        </PrimaryButton>
        <SecondaryButton disabled={!!busy} onClick={onBack}>
          换个仓库
        </SecondaryButton>
      </div>
      {busy && <Working>{busy}</Working>}
    </div>
  );
}

/* ---------------- 同步状态 ---------------- */

function StatusView({ status }: { status: SyncStatus }) {
  const [now, setNow] = useState(() => Date.now());
  const [confirmOff, setConfirmOff] = useState(false);
  const [relogin, setRelogin] = useState<SyncDeviceCode | "gitee" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setSyncStatus = useCallback(
    (syncStatus: SyncStatus) => useData.setState({ syncStatus }),
    [],
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const run = useCallback(async (label: string, task: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  const { label, detail } = describeSync(status, now);
  const provider: SyncProviderKey | null = status.remote?.startsWith("gitee.com")
    ? "gitee"
    : status.remote?.startsWith("github.com")
      ? "github"
      : null;
  const reloggedIn = useCallback(() => {
    setRelogin(null);
    void backend().then((api) => api.syncNow());
  }, []);

  if (relogin === "gitee") {
    return (
      <div>
        <GiteeLogin busy={busy} run={run} onDone={reloggedIn} />
        {error && <ErrorBox>{error}</ErrorBox>}
      </div>
    );
  }
  if (relogin) {
    return (
      <div>
        <GitHubLogin code={relogin} />
        <SecondaryButton
          onClick={() => {
            setRelogin(null);
            void backend().then((api) => api.syncLoginCancel());
          }}
        >
          取消
        </SecondaryButton>
        {error && <ErrorBox>{error}</ErrorBox>}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <p
          className={cn(
            "text-[14px] font-medium",
            status.state === "auth" || status.state === "error"
              ? "text-danger"
              : status.state === "offline"
                ? "text-warning"
                : "text-ink",
          )}
        >
          {label}
        </p>
        {status.state === "syncing" && (
          <LoaderCircle size={13} strokeWidth={2.2} className="animate-spin text-muted" />
        )}
      </div>
      {status.remote && (
        <button
          type="button"
          onClick={() => void openExternal(`https://${status.remote}`)}
          className="mt-1 font-mono text-[13px] text-muted underline-offset-2 hover:text-accent hover:underline"
        >
          {status.remote}
        </button>
      )}

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        <dt className="text-muted">上次同步</dt>
        <dd className="text-body">
          {status.lastSyncedAt ? formatSyncedAt(status.lastSyncedAt, now) : "还没有"}
        </dd>
        <dt className="text-muted">没推上去的改动</dt>
        <dd className="text-body">{status.unpushed > 0 ? `${status.unpushed} 次` : "没有"}</dd>
      </dl>

      {(status.state === "offline" || status.state === "error" || status.state === "auth") && (
        <p className="mt-3 rounded-lg bg-raised/50 px-3 py-2 text-[12px] leading-[1.6] text-body">
          {status.state === "auth" ? detail : (status.message ?? detail)}
        </p>
      )}

      {status.oversized.length > 0 && (
        <div className="mt-4">
          <p className="text-[12px] font-medium text-muted">这些文件太大，没有同步</p>
          <ul className="mt-1.5 space-y-1">
            {status.oversized.map((file) => (
              <li key={file.rel} className="flex items-center gap-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate font-mono text-body">{file.rel}</span>
                <span className="shrink-0 text-muted">{formatBytes(file.bytes)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {status.state === "auth" && provider ? (
          <PrimaryButton
            disabled={!!busy}
            onClick={() =>
              provider === "gitee"
                ? setRelogin("gitee")
                : void githubLogin((code) => setRelogin(code))
                    .then(reloggedIn)
                    .catch((cause) => {
                      const message = messageOf(cause);
                      if (!cancelled(message)) setError(message);
                    })
            }
          >
            重新登录
          </PrimaryButton>
        ) : (
          <PrimaryButton
            disabled={status.state === "syncing"}
            onClick={() => void backend().then((api) => api.syncNow())}
          >
            立即同步
          </PrimaryButton>
        )}
        {confirmOff ? (
          <span className="flex items-center gap-1.5 rounded-lg bg-warning/10 py-1 pl-2.5 pr-1">
            <span className="text-[12px] text-body">不再自动同步，笔记和历史都留在本机</span>
            <SecondaryButton
              danger
              disabled={!!busy}
              onClick={() =>
                void run("正在断开…", async () => {
                  setSyncStatus(await (await backend()).syncDisable());
                })
              }
            >
              断开
            </SecondaryButton>
            <SecondaryButton onClick={() => setConfirmOff(false)}>取消</SecondaryButton>
          </span>
        ) : (
          <SecondaryButton onClick={() => setConfirmOff(true)}>断开同步</SecondaryButton>
        )}
      </div>
      {busy && <Working>{busy}</Working>}
      {error && <ErrorBox>{error}</ErrorBox>}
      <ProxyLine />
    </div>
  );
}

/* ---------------- 网络（代理） ----------------
   对话框是按第一帧的内容量好高度、再往下展开的（popoverCard）。这一行在桌面端要等 IPC 回来才有，
   以前读到之前是 null：展开量的是没有它的高度，展开一结束卡片被它撑高 52px，看着就是跳一下
   （浏览器里 mock 同步返回，赶在量之前，所以只有桌面端跳）。现在读到之前先把这一行的位置占住，
   读到过一次就记下来，再打开第一帧就是对的。 */

/** 上次读到的代理设置 */
let lastProxy: SyncProxy | null = null;

function ProxyLine() {
  const [proxy, setProxy] = useState<SyncProxy | null>(lastProxy);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void backend()
      .then((api) => api.syncProxy())
      .then((next) => {
        lastProxy = next;
        setProxy(next);
      })
      .catch(() => {});
  }, []);

  const save = async (value: string | null) => {
    const next = await (await backend()).syncSetProxy(value);
    lastProxy = next;
    setProxy(next);
    setEditing(false);
  };

  if (!proxy) {
    return (
      <div aria-hidden="true" className="mt-5 border-t border-line pt-3 text-[12px]">
        <p className="invisible">网络：</p>
      </div>
    );
  }
  const how = proxy.configured
    ? `用你填的代理 ${proxy.configured}`
    : proxy.effective
      ? `用系统代理 ${proxy.effective}`
      : "直连，没有代理";

  return (
    <div className="mt-5 border-t border-line pt-3 text-[12px] text-muted">
      {editing ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void save(draft.trim() || null);
          }}
        >
          <span className="shrink-0">代理</span>
          <input
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="http://127.0.0.1:7890，空着就用系统代理"
            spellCheck={false}
            className="h-7 min-w-0 flex-1 rounded-md border border-line-strong bg-canvas px-2 font-mono
                       text-[12px] text-ink outline-none placeholder:text-faint focus:border-accent"
          />
          <SecondaryButton type="submit">保存</SecondaryButton>
          <SecondaryButton onClick={() => setEditing(false)}>取消</SecondaryButton>
        </form>
      ) : (
        <p>
          网络：{how}
          <button
            type="button"
            onClick={() => {
              setDraft(proxy.configured ?? "");
              setEditing(true);
              requestAnimationFrame(() => input.current?.focus());
            }}
            className="ml-1.5 text-muted underline underline-offset-2 hover:text-ink"
          >
            改
          </button>
        </p>
      )}
    </div>
  );
}

/* ---------------- 小零件 ---------------- */

function PrimaryButton({
  children,
  onClick,
  disabled,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[13px] font-medium
                 text-accent-ink transition-colors duration-[140ms] hover:bg-accent-hover disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  children,
  onClick,
  disabled,
  danger,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-7 shrink-0 items-center rounded-md px-2.5 text-[12px] transition-colors duration-[140ms]",
        "disabled:opacity-50",
        danger ? "font-medium text-danger hover:bg-danger/10" : "text-body hover:bg-raised",
      )}
    >
      {children}
    </button>
  );
}

function Working({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 flex items-center gap-1.5 text-[12px] text-muted">
      <LoaderCircle size={12} strokeWidth={2.2} className="animate-spin" />
      {children}
    </p>
  );
}

function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] leading-[1.6] text-danger"
    >
      {children}
    </p>
  );
}
