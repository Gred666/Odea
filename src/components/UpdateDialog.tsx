import { useIntro } from "@/app/intro";
import { useApp } from "@/app/store";
import { type Release, releaseOf, releasesBetween } from "@/content/changelog";
import { useData } from "@/data/store";
import type { UpdateInfo } from "@/data/types";
import { openExternal } from "@/editor/links";
import { formatMonthDayCN } from "@/lib/date";
import { renderMarkdown } from "@/lib/markdown";
import { popoverCard, tween } from "@/lib/motion";
import { CircleFadingArrowUp, LoaderCircle, ScrollText, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type MouseEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { version as APP_VERSION } from "../../package.json";

/* ============================================================
   新版本卡片（技术方案 §14.4）。两种：

   - 等着装的新版本：导航栏「新版本」那一行、命令面板打开。版本号、发布日期、更新说明，
     「稍后」和「重启并更新」。新版本是在后台下好、验过签的，点了只等重启
   - 升级后的更新说明：升级后第一次打开时自己弹一次（开场动画落地之后），也能从命令面板打开

   不弹「新版本」卡片：写东西的时候突然盖上来一张卡片太打扰，导航栏里那一行就够了。
   外壳和同步对话框一样：模糊遮罩 + 从标题栏往下展开的实心卡片（popoverCard），字不缩放、不变透明。
   内容在打开前就都在 store 里，展开时量到的就是最终高度（不会展开到一半再长一截）。
   ============================================================ */

const HEADER = 52;
/** 升级后的更新说明：开场动画落地之后再等这么久才弹，让人先看清自己回到了哪 */
const NOTES_DELAY = 700;

export function UpdateDialog() {
  const mode = useApp((s) => s.updateDialog);
  const setMode = useApp((s) => s.setUpdateDialog);
  const update = useData((s) => s.update);
  const upgrade = useData((s) => s.upgrade);
  const clearUpgrade = useData((s) => s.clearUpgrade);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");

  // 升级上来的：开场动画落地、窗口出来了，弹一次更新说明。这一版没写说明就不弹
  const introPhase = useIntro((s) => s.phase);
  const shown = useIntro((s) => s.shown);
  useEffect(() => {
    if (!upgrade || !shown || introPhase === "cover") return;
    if (releasesBetween(upgrade.from, upgrade.to).length === 0) {
      clearUpgrade();
      return;
    }
    const timer = setTimeout(() => {
      if (!useApp.getState().updateDialog) setMode("notes");
    }, NOTES_DELAY);
    return () => clearTimeout(timer);
  }, [upgrade, shown, introPhase, clearUpgrade, setMode]);

  // 卡片上是哪一种、哪几节，打开的那一刻定下来：关的时候 mode 先变回 null、upgrade 也清了，
  // 收起动画那 0.2 秒里内容不能跟着换成别的
  const [prevMode, setPrevMode] = useState(mode);
  const [view, setView] = useState<{ mode: "update" | "notes"; releases: Release[] } | null>(null);
  if (mode !== prevMode) {
    setPrevMode(mode);
    if (mode) {
      const releases = upgrade
        ? releasesBetween(upgrade.from, upgrade.to)
        : [releaseOf(APP_VERSION)].filter((release) => release !== null);
      setView({ mode, releases: mode === "notes" ? releases : [] });
    }
  }

  const open = mode === "notes" || (mode === "update" && !!update);
  const close = () => {
    if (installing) return;
    setMode(null);
    setError("");
    // 看过了：之后从命令面板打开的是这一版自己的那一节
    if (mode === "notes") clearUpgrade();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const install = async () => {
    setInstalling(true);
    setError("");
    // 装上了就不会回来（进程结束 / 重启）；回来了就是没装上
    const reason = await useData.getState().installUpdate();
    setInstalling(false);
    setError(reason || "没能装上新版本");
  };

  const notes = view?.mode === "notes";
  const title = notes ? "更新说明" : "新版本";
  const Icon = notes ? ScrollText : CircleFadingArrowUp;

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* 遮罩和面板分开：见 CommandPalette 里的说明（backdrop-filter 和 opacity 的坑） */}
          <motion.button
            key="scrim"
            type="button"
            data-ghost-skip
            aria-label={`关闭${title}`}
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
              aria-label={title}
              custom={HEADER}
              variants={popoverCard}
              initial="hidden"
              animate="shown"
              exit="gone"
              className="pointer-events-auto relative w-[440px] max-w-[calc(100vw-48px)]
                         overflow-clip rounded-2xl bg-canvas shadow-modal ring-1 ring-line-strong"
            >
              <div
                className="flex items-center gap-2.5 border-b border-line px-4"
                style={{ height: HEADER }}
              >
                <Icon
                  size={16}
                  strokeWidth={2}
                  className={notes ? "shrink-0 text-faint" : "shrink-0 text-accent"}
                />
                <p className="flex-1 text-[14px] font-medium text-ink">{title}</p>
                <button
                  type="button"
                  aria-label="关闭"
                  onClick={close}
                  disabled={installing}
                  className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors
                             duration-[140ms] hover:bg-raised hover:text-ink disabled:opacity-40"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </div>
              {notes ? (
                <NotesBody releases={view.releases} onDone={close} />
              ) : (
                update && (
                  <UpdateBody
                    update={update}
                    installing={installing}
                    error={error}
                    onLater={close}
                    onInstall={() => void install()}
                  />
                )
              )}
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

/* ---------------- 等着装的新版本 ---------------- */

function UpdateBody({
  update,
  installing,
  error,
  onLater,
  onInstall,
}: {
  update: UpdateInfo;
  installing: boolean;
  error: string;
  onLater: () => void;
  onInstall: () => void;
}) {
  const released = update.date ? `${dateLabel(update.date)}发布 · ` : "";
  return (
    <>
      <div className="scroll-thin max-h-[56vh] overflow-y-auto px-5 pb-5 pt-4">
        <p className="text-[19px] font-semibold leading-[1.4] text-ink">Odea {update.version}</p>
        <p className="mt-0.5 text-[13px] text-muted">
          {released}现在用的是 {update.current}
        </p>
        {update.notes && <Notes markdown={update.notes} ns="update" />}
        {error && (
          <p
            role="alert"
            className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12px] leading-[1.6] text-danger"
          >
            {error}
          </p>
        )}
      </div>
      <Footer
        hint={
          update.manual
            ? "这个版本要到下载页下载安装"
            : installing
              ? "正在保存，马上重启…"
              : "正在写的会先存好，重启后回到原处"
        }
      >
        <FooterButton onClick={onLater} disabled={installing}>
          稍后
        </FooterButton>
        {update.manual ? (
          <FooterButton primary onClick={() => void openExternal(update.manual!)}>
            去下载
          </FooterButton>
        ) : (
          <FooterButton primary onClick={onInstall} disabled={installing}>
            {installing && <LoaderCircle size={14} strokeWidth={2.2} className="animate-spin" />}
            重启并更新
          </FooterButton>
        )}
      </Footer>
    </>
  );
}

/* ---------------- 升级后的更新说明 ---------------- */

function NotesBody({ releases, onDone }: { releases: Release[]; onDone: () => void }) {
  const [latest, ...earlier] = releases;
  return (
    <>
      <div className="scroll-thin max-h-[56vh] overflow-y-auto px-5 pb-5 pt-4">
        {latest ? (
          <>
            <p className="text-[19px] font-semibold leading-[1.4] text-ink">
              {latest.version === APP_VERSION ? "已更新到" : "Odea"} {latest.version}
            </p>
            {latest.date && (
              <p className="mt-0.5 text-[13px] text-muted">{dateLabel(latest.date)}发布</p>
            )}
            <Notes markdown={latest.body} ns={`notes-${latest.version}`} />
            {earlier.map((release) => (
              <section key={release.version} className="mt-6 border-t border-line pt-4">
                <p className="text-[14px] font-semibold text-ink">
                  {release.version}
                  {release.date && (
                    <span className="ml-2 font-normal text-muted">{dateLabel(release.date)}</span>
                  )}
                </p>
                <Notes markdown={release.body} ns={`notes-${release.version}`} />
              </section>
            ))}
          </>
        ) : (
          <p className="text-[13px] text-muted">这一版（{APP_VERSION}）没有写更新说明。</p>
        )}
      </div>
      <Footer>
        <FooterButton primary onClick={onDone}>
          知道了
        </FooterButton>
      </Footer>
    </>
  );
}

/* ---------------- 小零件 ---------------- */

/** 更新说明的正文。链接用系统浏览器打开，不在应用的窗口里跳走 */
function Notes({ markdown, ns }: { markdown: string; ns: string }) {
  const body = useMemo(() => renderMarkdown(markdown, ns), [markdown, ns]);
  const onClick = (e: MouseEvent) => {
    const link = (e.target as HTMLElement).closest("a");
    if (!link) return;
    e.preventDefault();
    void openExternal(link.getAttribute("href") ?? "");
  };
  // 只是拦下正文里链接的点击，链接自己能用键盘触发
  return (
    <div className="prose-doc prose-notes mt-3.5" onClick={onClick}>
      {body}
    </div>
  );
}

function Footer({ hint, children }: { hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-t border-line px-4 py-3">
      <p className="min-w-0 flex-1 truncate text-[12px] text-muted">{hint}</p>
      {children}
    </div>
  );
}

function FooterButton({
  children,
  onClick,
  disabled,
  primary,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        primary
          ? "flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[13px] font-medium text-accent-ink transition-colors duration-[140ms] hover:bg-accent-hover disabled:opacity-60"
          : "flex h-8 shrink-0 items-center rounded-lg px-3 text-[13px] text-body transition-colors duration-[140ms] hover:bg-raised disabled:opacity-50"
      }
    >
      {children}
    </button>
  );
}

/** `2026-10-20` → 「10月20日」；不是这种写法的原样给 */
function dateLabel(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? formatMonthDayCN(date) : date;
}
