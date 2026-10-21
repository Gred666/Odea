import { openExternal } from "@/editor/links";
import { cn } from "@/lib/cn";
import { Copy, Github, Globe, LoaderCircle, Lock } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Provider,
  type SyncAccount,
  type SyncDeviceCode,
  type SyncRemoteRepo,
  launcherApi as api,
} from "./api";
import { Button, FIELD, PanelHeader } from "./parts";

/* ============================================================
   启动器的「从同步仓库拉一份」（docs/仓库与启动器.md §3.2，技术方案 §5.9.7）：换了电脑时最常用。
   选托管方 → 登录（GitHub 设备码 / Gitee 私人令牌，账号是全应用的，登录过的直接用）→ 选一个仓库 →
   起名字、选位置 → clone 到新文件夹、打开（同步跟着开着）。

   和仓库窗口里的同步对话框是同一套登录（SyncDialog）；这里只有「拉下来」，不在现有的仓库上接
   ============================================================ */

const PROVIDERS: Record<Provider, { label: string; note: string }> = {
  github: { label: "GitHub", note: "国内访问可能要开代理" },
  gitee: { label: "Gitee", note: "国内直连" },
};

const GITEE_TOKEN_PAGE = "https://gitee.com/profile/personal_access_tokens/new";

type Step =
  | { kind: "provider" }
  | { kind: "github"; code: SyncDeviceCode }
  | { kind: "gitee" }
  | { kind: "repos"; account: SyncAccount }
  | { kind: "place"; account: SyncAccount; repo: SyncRemoteRepo };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function ClonePanel({
  busy,
  onBack,
  onClone,
}: {
  /** 正在拉（启动器的 run 管着） */
  busy: boolean;
  onBack: () => void;
  onClone: (provider: Provider, cloneUrl: string, parent: string, name: string) => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "provider" });
  const [accounts, setAccounts] = useState<SyncAccount[]>([]);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .accounts()
      .then(setAccounts)
      .catch(() => {});
    // 退出这一屏（返回、启动器关了）：正在等浏览器确认的 GitHub 登录也停掉
    return () => void api.loginCancel().catch(() => {});
  }, []);

  const run = useCallback(async (label: string, task: () => Promise<void>) => {
    setWorking(label);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setWorking(null);
    }
  }, []);

  const loggedIn = (account: SyncAccount) => {
    setAccounts((list) => [...list.filter((a) => a.provider !== account.provider), account]);
    setStep({ kind: "repos", account });
  };

  const choose = (provider: Provider) => {
    const account = accounts.find((a) => a.provider === provider);
    setError(null);
    if (account) return setStep({ kind: "repos", account });
    if (provider === "gitee") return setStep({ kind: "gitee" });
    // 在点击里调，不放进 effect：StrictMode 下 effect 会跑两次（同 SyncDialog 的 githubLogin）
    setWorking("正在向 GitHub 要验证码…");
    void api
      .githubLoginStart()
      .then((code) => {
        setWorking(null);
        setStep({ kind: "github", code });
        return api.githubLoginWait();
      })
      .then(loggedIn)
      .catch((cause) => {
        setWorking(null);
        const message = messageOf(cause);
        if (!message.includes("取消")) setError(message);
      });
  };

  const back = () => {
    setError(null);
    if (step.kind === "github") void api.loginCancel().catch(() => {});
    if (step.kind === "provider") return onBack();
    setStep(
      step.kind === "place" ? { kind: "repos", account: step.account } : { kind: "provider" },
    );
  };

  return (
    <div
      onKeyDown={(event) => {
        if (event.key === "Escape") back();
      }}
    >
      <PanelHeader title="从同步仓库拉一份" onBack={back} />

      {step.kind === "provider" && (
        <>
          <p className="text-[12.5px] leading-[1.65] text-muted">
            在别的电脑上开过同步的话，把那个仓库拉到这台上，以后两边自动同步。
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            {(Object.keys(PROVIDERS) as Provider[]).map((key) => {
              const account = accounts.find((a) => a.provider === key);
              return (
                <button
                  key={key}
                  type="button"
                  disabled={!!working || busy}
                  onClick={() => choose(key)}
                  className="flex flex-col items-start gap-1 rounded-xl border border-line-strong px-3.5 py-3 text-left
                             transition-colors duration-[140ms] hover:border-accent-line hover:bg-accent-wash disabled:opacity-60"
                >
                  <span className="flex items-center gap-1.5 text-[14px] font-medium text-ink">
                    {key === "github" ? (
                      <Github size={14} strokeWidth={2} />
                    ) : (
                      <Globe size={14} strokeWidth={2} />
                    )}
                    {PROVIDERS[key].label}
                  </span>
                  <span className="text-[12px] leading-[1.6] text-muted">
                    {account ? `已登录 ${account.login}` : PROVIDERS[key].note}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {step.kind === "github" && <GitHubCode code={step.code} />}

      {step.kind === "gitee" && (
        <GiteeToken
          disabled={!!working}
          onLogin={(token) =>
            void run("正在验证令牌…", async () => {
              loggedIn(await api.giteeLogin(token));
            })
          }
        />
      )}

      {step.kind === "repos" && (
        <RepoList
          account={step.account}
          run={run}
          onPick={(repo) => setStep({ kind: "place", account: step.account, repo })}
        />
      )}

      {step.kind === "place" && (
        <Place
          repo={step.repo}
          busy={busy}
          onClone={(parent, name) =>
            onClone(step.account.provider as Provider, step.repo.cloneUrl, parent, name)
          }
        />
      )}

      {working && (
        <p className="mt-3 flex items-center gap-1.5 text-[12.5px] text-muted">
          <LoaderCircle size={13} strokeWidth={2} className="animate-spin" />
          {working}
        </p>
      )}
      {error && <p className="mt-3 text-[12.5px] leading-[1.6] text-danger">{error}</p>}
    </div>
  );
}

function GitHubCode({ code }: { code: SyncDeviceCode }) {
  const [copied, setCopied] = useState(false);
  const open = async () => {
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
      <p className="text-[12.5px] leading-[1.65] text-muted">
        在浏览器里登录
        GitHub，输入下面的验证码，再点「Authorize」同意。令牌只存在这台电脑的系统钥匙串里。
      </p>
      <p className="mt-3 rounded-xl bg-raised/50 py-3 text-center font-mono text-[22px] font-semibold tracking-[0.12em] text-ink select-all">
        {code.userCode}
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Button primary onClick={() => void open()}>
          <span className="flex items-center gap-1.5">
            <Copy size={13} strokeWidth={2} />
            {copied ? "再开一次 GitHub" : "复制验证码并打开 GitHub"}
          </span>
        </Button>
        <span className="flex items-center gap-1.5 text-[12px] text-faint">
          <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />
          等你在浏览器里确认…
        </span>
      </div>
    </div>
  );
}

function GiteeToken({
  disabled,
  onLogin,
}: {
  disabled: boolean;
  onLogin: (token: string) => void;
}) {
  const [token, setToken] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (token.trim()) onLogin(token.trim());
      }}
    >
      <p className="text-[12.5px] leading-[1.65] text-muted">
        在 Gitee 的「设置 → 私人令牌」里生成一个（权限勾上 projects），粘贴到这里。{" "}
        <button
          type="button"
          onClick={() => void openExternal(GITEE_TOKEN_PAGE)}
          className="text-accent underline-offset-2 hover:underline"
        >
          打开令牌页面
        </button>
      </p>
      <div className="mt-3 flex gap-2">
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="粘贴私人令牌"
          aria-label="Gitee 私人令牌"
          autoComplete="off"
          spellCheck={false}
          className={FIELD}
        />
        <Button type="submit" primary disabled={disabled || !token.trim()}>
          登录
        </Button>
      </div>
    </form>
  );
}

function RepoList({
  account,
  run,
  onPick,
}: {
  account: SyncAccount;
  run: (label: string, task: () => Promise<void>) => Promise<void>;
  onPick: (repo: SyncRemoteRepo) => void;
}) {
  const [repos, setRepos] = useState<SyncRemoteRepo[] | null>(null);
  const label = PROVIDERS[account.provider as Provider]?.label ?? account.provider;
  useEffect(() => {
    void run(`正在读取 ${label} 上的仓库…`, async () => {
      setRepos(await api.repos(account.provider as Provider));
    });
  }, [account.provider, label, run]);
  return (
    <div>
      <p className="text-[12.5px] text-muted">
        已登录 {label} · <span className="text-body">{account.login}</span>　选一个开过同步的仓库：
      </p>
      <div className="mt-2 overflow-hidden rounded-xl border border-line-strong">
        {repos === null ? (
          <p className="px-3.5 py-3 text-[13px] text-faint">读取中…</p>
        ) : repos.length === 0 ? (
          <p className="px-3.5 py-3 text-[13px] text-faint">这个账号下还没有仓库</p>
        ) : (
          <div className="scroll-thin max-h-[168px] overflow-y-auto">
            {repos.map((repo) => (
              <button
                key={repo.cloneUrl}
                type="button"
                onClick={() => onPick(repo)}
                className="flex w-full items-center gap-2 border-line border-b px-3.5 py-2.5 text-left
                           transition-colors duration-[140ms] last:border-b-0 hover:bg-raised/55"
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
    </div>
  );
}

function Place({
  repo,
  busy,
  onClone,
}: {
  repo: SyncRemoteRepo;
  busy: boolean;
  onClone: (parent: string, name: string) => void;
}) {
  const [name, setName] = useState(repo.fullName.split("/").pop() ?? "Odea");
  const [parent, setParent] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void api.defaultParent().then((dir) => setParent((now) => now || dir));
    input.current?.focus();
  }, []);
  const separator = parent.includes("/") && !parent.includes("\\") ? "/" : "\\";
  const target =
    parent && name.trim() ? `${parent.replace(/[\\/]+$/, "")}${separator}${name.trim()}` : "";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (target && !busy) onClone(parent, name.trim());
      }}
    >
      <p className="text-[12.5px] text-muted">
        <span className="font-mono text-body">{repo.fullName}</span> 拉到这台电脑的
      </p>
      <label className="mt-3 block text-[12.5px] text-muted" htmlFor="clone-name">
        文件夹名
      </label>
      <input
        id="clone-name"
        ref={input}
        value={name}
        onChange={(event) => setName(event.target.value)}
        spellCheck={false}
        autoComplete="off"
        className={cn(FIELD, "mt-1.5")}
      />
      <div className="mt-3 flex gap-2">
        <p className={cn(FIELD, "flex items-center truncate text-body")} title={parent}>
          {parent}
        </p>
        <Button
          disabled={busy}
          onClick={() =>
            void api.pickParent(parent).then((picked) => {
              if (picked) setParent(picked);
            })
          }
        >
          换个位置…
        </Button>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <p className="min-w-0 flex-1 truncate text-[12px] text-faint" title={target}>
          {busy ? "正在拉取，笔记多的话要一会儿…" : target ? `会放在 ${target}` : ""}
        </p>
        <Button type="submit" primary disabled={busy || !target}>
          {busy ? "正在拉取…" : "拉下来"}
        </Button>
      </div>
    </form>
  );
}
