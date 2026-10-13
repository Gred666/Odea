import { useApp } from "@/app/store";
import { backend } from "@/data/backend";
import { conflictOriginalContent, conflictOriginalTitle } from "@/data/conflicts";
import { messageOf, useData } from "@/data/store";
import type { DocHistory, DocVersion, DocumentSaveTarget } from "@/data/types";
import { cn } from "@/lib/cn";
import { formatRelativeTime, formatTimestampFull } from "@/lib/date";
import { diffLines, diffStats } from "@/lib/lineDiff";
import { popoverCard, tween } from "@/lib/motion";
import { isTauri } from "@/lib/tauri";
import { History, LoaderCircle, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DiffView } from "./DiffView";
import { Segmented } from "./Segmented";

/* ============================================================
   历史版本（技术方案 §5.9.11）。状态栏的时钟按钮、命令面板「历史版本…」打开它。

   同步用的 git 仓库里，每次改过这篇的提交就是一版（停笔一分钟同步一次，差不多一分钟一版）。
   左边是版本列表，新的在前：什么时候、哪台设备、当时的标题（笔记改过标题的话）；
   右边是选中那一版和现在的正文差在哪，也能看那一版的全文。「恢复这一版」把正文换成它，
   底部提示条可以撤销。

   没开同步时没有历史，说明一下、给开启同步的入口。
   外壳和同步对话框一样：模糊遮罩 + 从标题栏往下展开的实心卡片（popoverCard）。

   先取历史、再打开：popoverCard 按第一帧的内容量好高度往下展开，以前第一帧是一行「正在翻历史…」，
   历史晚一步从 IPC 回来，展开到头那一下卡片猛地变高（没开同步 +50px，有历史 +260px）。
   现在点了先取（没开同步是瞬间的事，有历史一般也就几十毫秒），取到了再打开，第一帧就是最终的样子；
   超过 OPEN_ANYWAY 还没取到（历史很长）就先打开，这时卡片一开始就是完整版式的高度，
   转圈、提示、版本列表都在这个高度里，打开以后不再变。
   ============================================================ */

const HEADER = 52;
/** 历史取得慢，最多等这么久就先打开 */
const OPEN_ANYWAY = 250;
/** 有历史时的版式高度；先打开再等历史时，什么内容都占这么高 */
const BODY_HEIGHT = "h-[min(560px,66vh)]";

/** 打开时要的东西都在这：历史、已经读出来的几版正文、先选中哪一版 */
type Loaded = { history: DocHistory; texts: Record<string, string>; selected: number };
type Result = { loaded: Loaded } | { error: string };

/** 取历史；第一版（最近一次同步）一般就是现在的正文，那就先选中上一版 —— 打开是想看以前的。选中那一版的正文也先读好 */
async function loadHistory(target: DocumentSaveTarget): Promise<Result> {
  try {
    const api = await backend();
    const history = await api.docHistory(target);
    const texts: Record<string, string> = {};
    let selected = 0;
    const first = history.versions[0];
    if (first && history.versions.length > 1) {
      texts[first.blob] = await api.docVersionText(first.blob);
      if (texts[first.blob] === conflictOriginalContent(target, useData.getState())) selected = 1;
    }
    const pick = history.versions[selected];
    if (pick && texts[pick.blob] === undefined) {
      texts[pick.blob] = await api.docVersionText(pick.blob);
    }
    return { loaded: { history, texts, selected } };
  } catch (cause) {
    return { error: messageOf(cause) };
  }
}

/** 卡片上那一篇：取好了的话 ready 有值；先打开的话是 null，正文自己等 pending */
interface Opening {
  target: DocumentSaveTarget;
  pending: Promise<Result>;
  ready: Result | null;
}

const keyOf = (target: DocumentSaveTarget) => JSON.stringify(target);

export function HistoryDialog() {
  const requested = useApp((s) => s.historyFor);
  const setTarget = useApp((s) => s.setHistoryFor);
  const close = () => setTarget(null);
  const [opening, setOpening] = useState<Opening | null>(null);

  useEffect(() => {
    if (!requested) {
      setOpening(null);
      return;
    }
    let alive = true;
    const pending = loadHistory(requested);
    const timer = setTimeout(() => {
      if (alive) setOpening({ target: requested, pending, ready: null });
    }, OPEN_ANYWAY);
    void pending.then((ready) => {
      if (!alive) return;
      clearTimeout(timer);
      // 已经先打开了的，正文自己在等 pending，这里不动它
      setOpening((now) => now ?? { target: requested, pending, ready });
    });
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [requested]);

  useEffect(() => {
    if (!requested) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        setTarget(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [requested, setTarget]);

  const shown = requested && opening && keyOf(opening.target) === keyOf(requested) ? opening : null;
  const target = shown?.target;
  const title = useData((s) => (target ? conflictOriginalTitle(target, s) : undefined));

  return (
    <AnimatePresence>
      {shown && target && (
        <>
          {/* 遮罩和面板分开：见 CommandPalette 里的说明（backdrop-filter 和 opacity 的坑） */}
          <motion.button
            key="scrim"
            type="button"
            data-ghost-skip
            aria-label="关闭历史版本"
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
            className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label="历史版本"
              custom={HEADER}
              variants={popoverCard}
              initial="hidden"
              animate="shown"
              exit="gone"
              className="pointer-events-auto relative flex w-[780px] max-w-[calc(100vw-48px)] flex-col
                         overflow-clip rounded-2xl bg-canvas shadow-modal ring-1 ring-line-strong"
            >
              <div
                className="flex shrink-0 items-center gap-2.5 border-b border-line px-4"
                style={{ height: HEADER }}
              >
                <History size={15} strokeWidth={2} className="shrink-0 text-faint" />
                <p className="min-w-0 flex-1 truncate text-[14px] text-ink">
                  <span className="font-medium">历史版本</span>
                  {title && <span className="text-muted"> · {title}</span>}
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
              <HistoryBody key={keyOf(target)} opening={shown} onDone={close} />
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

function HistoryBody({ opening, onDone }: { opening: Opening; onDone: () => void }) {
  const { target, pending, ready } = opening;
  const current = useData((s) => conflictOriginalContent(target, s));
  const currentTitle = useData((s) => conflictOriginalTitle(target, s));
  const restoreVersion = useData((s) => s.restoreVersion);
  const setSyncOpen = useApp((s) => s.setSyncOpen);

  const first = ready && "loaded" in ready ? ready.loaded : null;
  const [history, setHistory] = useState<DocHistory | null>(first?.history ?? null);
  const [error, setError] = useState<string | null>(ready && "error" in ready ? ready.error : null);
  const [selected, setSelected] = useState(first?.selected ?? 0);
  const [texts, setTexts] = useState<Record<string, string>>(first?.texts ?? {});
  const [view, setView] = useState<"diff" | "full">("diff");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // 没等到历史就打开了：卡片一开始就是完整版式的高度，之后什么内容都在这个高度里
  const [tall] = useState(ready === null);

  useEffect(() => {
    if (ready) return;
    let alive = true;
    void pending.then((result) => {
      if (!alive) return;
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setTexts((known) => ({ ...result.loaded.texts, ...known }));
      setSelected(result.loaded.selected);
      setHistory(result.loaded.history);
    });
    return () => {
      alive = false;
    };
  }, [pending, ready]);

  const versions = history?.versions ?? [];
  const version: DocVersion | undefined = versions[selected];
  const text = version ? texts[version.blob] : undefined;

  // 选中的那一版还没取过正文：取一次
  useEffect(() => {
    if (!version || texts[version.blob] !== undefined) return;
    let alive = true;
    void backend()
      .then((api) => api.docVersionText(version.blob))
      .then((body) => {
        if (alive) setTexts((known) => ({ ...known, [version.blob]: body }));
      })
      .catch((cause) => {
        if (alive) setError(messageOf(cause));
      });
    return () => {
      alive = false;
    };
  }, [version, texts]);

  // 换一版就收起确认
  // biome-ignore lint/correctness/useExhaustiveDependencies: 跟着选中的那一版重置
  useEffect(() => setConfirming(false), [selected]);

  const diff = useMemo(
    () => (text !== undefined && current !== undefined ? diffLines(current, text) : null),
    [text, current],
  );
  const stats = diff ? diffStats(diff) : null;
  const same = text !== undefined && text === current;

  const restore = async () => {
    if (!version || text === undefined || busy) return;
    setBusy(true);
    try {
      await restoreVersion(target, text, formatRelativeTime(version.time));
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const listRef = useRef<HTMLDivElement>(null);
  const onListKey = (event: React.KeyboardEvent) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step || !versions.length) return;
    event.preventDefault();
    const next = Math.min(versions.length - 1, Math.max(0, selected + step));
    setSelected(next);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-version="${next}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  if (error) {
    return <Message tall={tall}>{error}</Message>;
  }
  if (!history) {
    return (
      <Message tall={tall}>
        <LoaderCircle size={14} strokeWidth={2} className="mr-2 inline animate-spin align-[-2px]" />
        正在翻历史…
      </Message>
    );
  }
  if (history.unavailable) {
    return (
      <Message tall={tall}>
        <span className="block">{history.unavailable}</span>
        {isTauri && (
          <button
            type="button"
            onClick={() => {
              onDone();
              setSyncOpen(true);
            }}
            className="mt-4 rounded-lg bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-canvas
                       transition-opacity duration-[140ms] hover:opacity-90"
          >
            开启同步…
          </button>
        )}
      </Message>
    );
  }
  if (!versions.length) {
    return (
      <Message tall={tall}>
        这一篇还没有同步过。停笔一分钟会自动同步一次，之后这里就有第一版了。
      </Message>
    );
  }

  return (
    <div className={cn("flex min-h-0", BODY_HEIGHT)}>
      {/* ---------- 版本列表 ---------- */}
      <div
        ref={listRef}
        role="listbox"
        aria-label="版本"
        tabIndex={0}
        onKeyDown={onListKey}
        className="scroll-thin w-[236px] shrink-0 overflow-y-auto border-r border-line p-1.5 outline-none"
      >
        {versions.map((item, index) => {
          const active = index === selected;
          const renamed =
            target.kind === "note" && item.title && currentTitle && item.title !== currentTitle;
          return (
            <button
              key={item.blob + item.time}
              type="button"
              role="option"
              aria-selected={active}
              data-version={index}
              onClick={() => setSelected(index)}
              className={cn(
                "block w-full rounded-lg px-2.5 py-2 text-left transition-colors duration-[120ms]",
                active ? "bg-raised" : "hover:bg-raised/60",
              )}
            >
              <span
                className={cn(
                  "flex items-center gap-1.5 text-[13px]",
                  active ? "font-medium text-ink" : "text-body",
                )}
              >
                {formatRelativeTime(item.time)}
                {texts[item.blob] !== undefined && texts[item.blob] === current && (
                  <span className="rounded bg-ink/[0.06] px-1 text-[10.5px] font-normal text-muted">
                    和现在一样
                  </span>
                )}
              </span>
              <span className="mt-0.5 block truncate text-[11.5px] text-faint">
                {item.mine ? "这台电脑" : item.device}
                {renamed && ` · 当时叫「${item.title}」`}
              </span>
            </button>
          );
        })}
        {history.more && (
          <p className="px-2.5 py-2 text-[11px] leading-[1.6] text-faint">更早的版本没有列出来</p>
        )}
      </div>

      {/* ---------- 选中的那一版 ---------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px] text-body">
              {version && formatTimestampFull(version.time)}
              <span className="text-faint"> · {version?.mine ? "这台电脑" : version?.device}</span>
            </p>
            <p className="mt-0.5 font-mono text-[10.5px] text-faint">
              {text === undefined ? (
                "正在读这一版…"
              ) : same ? (
                "和现在的正文一样"
              ) : stats ? (
                <>
                  恢复它：<span className="text-success">+{stats.added}</span>{" "}
                  <span className="text-danger">−{stats.removed}</span> 行
                </>
              ) : (
                "两版都很长，没法逐行对比"
              )}
            </p>
          </div>
          <Segmented
            group="history-view"
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "diff", label: "差异" },
              { value: "full", label: "全文" },
            ]}
          />
          {confirming ? (
            <span className="flex items-center gap-1.5 rounded-lg bg-warning/10 py-1 pl-2.5 pr-1">
              <span className="text-[11.5px] text-body">现在的正文会换成这一版，可以撤销</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void restore()}
                className="rounded-md bg-warning/20 px-2 py-[3px] text-[12px] font-medium text-ink
                           transition-colors duration-[140ms] hover:bg-warning/30 disabled:opacity-50"
              >
                恢复
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-md px-2 py-[3px] text-[12px] text-body
                           transition-colors duration-[140ms] hover:bg-raised"
              >
                取消
              </button>
            </span>
          ) : (
            <button
              type="button"
              disabled={text === undefined || same}
              onClick={() => setConfirming(true)}
              className="rounded-lg bg-ink px-3 py-1.5 text-[12.5px] font-medium text-canvas
                         transition-opacity duration-[140ms] hover:opacity-90 disabled:opacity-35"
            >
              恢复这一版
            </button>
          )}
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {text === undefined ? null : view === "full" ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.75] text-body">
              {text || "（这一版是空的）"}
            </pre>
          ) : same ? (
            <p className="text-[12px] text-faint">这一版和现在的正文一模一样。</p>
          ) : (
            <DiffView
              lines={diff}
              removedLabel="只在现在的正文里"
              addedLabel="只在这一版里"
              tooLong="两版都很长，没法逐行对比。切到「全文」看这一版吧。"
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** tall：先打开、再等历史的时候，提示也占完整版式的高度（居中），打开以后卡片不再变高变矮 */
function Message({ tall, children }: { tall: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "px-8 py-14 text-center text-[13px] leading-[1.75] text-muted",
        tall && cn("flex flex-col items-center justify-center", BODY_HEIGHT),
      )}
    >
      {children}
    </div>
  );
}
