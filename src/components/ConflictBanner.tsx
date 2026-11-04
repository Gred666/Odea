import { openDocument } from "@/app/navigate";
import { conflictOriginalContent } from "@/data/conflicts";
import { useData } from "@/data/store";
import { type DocumentModel, NOTE } from "@/data/types";
import { cn } from "@/lib/cn";
import { diffLines, diffStats } from "@/lib/lineDiff";
import { tween } from "@/lib/motion";
import { documentType } from "@/plugins/registry";
import { ChevronRight, Copy } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { DiffView } from "./DiffView";

/* ============================================================
   冲突副本的横幅（标题上方）。

   这篇是另一篇的冲突副本：两台机器都改了同一篇，网盘同步时没法合并，把其中一版
   另存成了这一篇（或者本应用自己另存的 ——外部改动撞上了没存的修改）。
   给四个动作：看两版差在哪、打开原文、用这一版替换原文、删掉这份副本。
   删掉的副本进回收站，撤销提示条照常能撤。

   原文也可以是插件的一篇（某一天、某个周期的目标：两台设备都改了今日TODO，同步里最常见的冲突）：
   它们在插件的缓存里、按需取，横幅挂上时取一次，取回来之前「查看差异」说正在读。
   ============================================================ */

export function ConflictBanner({
  conflict,
}: {
  conflict: NonNullable<DocumentModel["conflict"]>;
}) {
  const target = conflict.original;
  // 副本就是正在看的这篇，正文一定在；原文是笔记的话打开副本时一起取了（data/adapter.ts）
  const copy = useData((s) => s.bodies[conflict.copyId]);
  const resolveConflict = useData((s) => s.resolveConflict);
  const loadBody = useData((s) => s.loadBody);

  // 原文是笔记：正文在 store 的 bodies 里（也可能被挤掉了，取一次）
  const noteId = target.type === NOTE ? target.key : null;
  const noteOriginal = useData((s) => (noteId ? conflictOriginalContent(target, s) : undefined));
  useEffect(() => {
    if (noteId && noteOriginal === undefined) void loadBody(noteId);
  }, [noteId, noteOriginal, loadBody]);

  // 原文是插件的一篇：在插件的缓存里，按需取（target 每次渲染都是新对象，按里面的值认）。
  // 插件的文档存了（typedTick）再读一次
  const typed = noteId ? null : `${target.type}\n${target.key}`;
  const typedTick = useData((s) => s.typedTick);
  const [typedOriginal, setTypedOriginal] = useState<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: typedTick 只是重读的信号
  useEffect(() => {
    if (!typed) return;
    const [kind = "", key = ""] = typed.split("\n");
    const type = documentType(kind);
    if (!type) return;
    let alive = true;
    setTypedOriginal(type.body(key));
    void type.load(key).then(() => {
      if (alive) setTypedOriginal(type.body(key));
    });
    return () => {
      alive = false;
    };
  }, [typed, typedTick]);
  const original = noteId ? noteOriginal : typedOriginal;
  const [showDiff, setShowDiff] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const diff = useMemo(
    () => (copy !== undefined && original !== undefined ? diffLines(original, copy) : null),
    [copy, original],
  );
  const stats = diff ? diffStats(diff) : null;
  const identical = !!stats && stats.added === 0 && stats.removed === 0;

  const resolve = async (keep: "copy" | "original") => {
    if (busy) return;
    setBusy(true);
    try {
      const opened = await resolveConflict(conflict.copyId, keep);
      if (opened) openDocument(opened);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="mb-7 rounded-xl border border-warning/30 bg-warning/[0.07] px-4 py-3.5">
      <div className="flex items-start gap-2.5">
        <Copy size={14} strokeWidth={1.9} className="mt-[3px] shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-[1.6] text-ink">
            这是「{conflict.originalTitle}」的冲突副本
          </p>
          <p className="mt-0.5 text-[12px] leading-[1.65] text-muted">
            {identical
              ? "两版内容一模一样，留着它没有用，可以直接删掉。"
              : "同一篇在两处都被改过，同步时没法自动合并，另一版就留成了这一篇。对比一下，留下要的那一版。"}
          </p>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {!identical && (
              <BannerButton onClick={() => setShowDiff((value) => !value)}>
                <ChevronRight
                  size={12}
                  strokeWidth={2.2}
                  className={cn("transition-transform duration-[160ms]", showDiff && "rotate-90")}
                />
                {stats ? (
                  <>
                    查看差异
                    <span className="font-mono text-[11px] text-success">+{stats.added}</span>
                    <span className="font-mono text-[11px] text-danger">−{stats.removed}</span>
                  </>
                ) : (
                  "查看差异"
                )}
              </BannerButton>
            )}
            <BannerButton onClick={() => openDocument(target)}>打开原文</BannerButton>
            {confirming ? (
              <span className="flex items-center gap-1.5 rounded-md bg-warning/10 py-0.5 pl-2 pr-0.5">
                <span className="text-[12px] text-body">原文现在的内容会被这一版覆盖</span>
                <BannerButton strong disabled={busy} onClick={() => void resolve("copy")}>
                  替换
                </BannerButton>
                <BannerButton onClick={() => setConfirming(false)}>取消</BannerButton>
              </span>
            ) : (
              !identical && (
                <BannerButton disabled={busy} onClick={() => setConfirming(true)}>
                  用这一版替换原文
                </BannerButton>
              )
            )}
            <BannerButton danger disabled={busy} onClick={() => void resolve("original")}>
              删掉这份副本
            </BannerButton>
          </div>

          <AnimatePresence initial={false}>
            {showDiff && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={tween.fast}
              >
                {original !== undefined ? (
                  <DiffView
                    lines={diff}
                    removedLabel="只在原文里"
                    addedLabel="只在这一版里"
                    tooLong="两版都很长，没法逐行对比。打开原文，两篇并排看吧。"
                    className="mt-3 max-h-[300px]"
                  />
                ) : (
                  <p className="mt-3 text-[12px] text-muted">正在读原文…</p>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

export function BannerButton({
  children,
  onClick,
  disabled,
  danger,
  strong,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  strong?: boolean;
  /** 悬停时多说一句 */
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex items-center gap-1 rounded-md px-2 py-[3px] text-[12px] transition-colors duration-[140ms]",
        "disabled:opacity-50",
        strong
          ? "bg-warning/20 font-medium text-ink hover:bg-warning/30"
          : danger
            ? "text-danger hover:bg-danger/10"
            : "text-body hover:bg-raised",
      )}
    >
      {children}
    </button>
  );
}
