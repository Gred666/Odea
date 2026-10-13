import { useData } from "@/data/store";
import type { GuideUpdate } from "@/data/types";
import { cn } from "@/lib/cn";
import { diffLines, diffStats } from "@/lib/lineDiff";
import { tween } from "@/lib/motion";
import { BookOpen, ChevronRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { BannerButton } from "./ConflictBanner";
import { DiffView } from "./DiffView";

/* ============================================================
   使用指南有新版、而用户改过这一篇时，标题上方的横幅（src-tauri/src/vault/guide.rs）。

   没改过的指南升级时直接换成新版，走不到这里。改过的不能悄悄覆盖：给三个动作 ——
   看看新版差在哪、换成新版（底部提示条可以撤销）、留着自己的（到下一次升级前不再问）。
   不是出错，用中性的主色，不用冲突副本那种黄。
   ============================================================ */

export function GuideUpdateBanner({ update }: { update: GuideUpdate }) {
  const current = useData(
    (s) =>
      s.notes.find((note) => note.id === update.id)?.contentMd ??
      s.archived.find((note) => note.id === update.id)?.contentMd,
  );
  const adopt = useData((s) => s.adoptGuideUpdate);
  const keep = useData((s) => s.keepGuide);
  const [showDiff, setShowDiff] = useState(false);
  const [busy, setBusy] = useState(false);

  const diff = useMemo(
    () => (current !== undefined ? diffLines(current, update.body) : null),
    [current, update.body],
  );
  const stats = diff ? diffStats(diff) : null;

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-7 rounded-xl border border-accent/25 bg-accent-wash/60 px-4 py-3.5">
      <div className="flex items-start gap-2.5">
        <BookOpen size={14} strokeWidth={1.9} className="mt-[3px] shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-[1.6] text-ink">这篇使用指南有新版本</p>
          <p className="mt-0.5 text-[12px] leading-[1.65] text-muted">
            你改过这一篇，所以新版没有直接换上来。看看改了什么，再决定换不换。
          </p>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <BannerButton onClick={() => setShowDiff((value) => !value)}>
              <ChevronRight
                size={12}
                strokeWidth={2.2}
                className={cn("transition-transform duration-[160ms]", showDiff && "rotate-90")}
              />
              看看改了什么
              {stats && (
                <>
                  <span className="font-mono text-[10.5px] text-success">+{stats.added}</span>
                  <span className="font-mono text-[10.5px] text-danger">−{stats.removed}</span>
                </>
              )}
            </BannerButton>
            <BannerButton disabled={busy} onClick={() => void run(() => adopt(update.id))}>
              换成新版
            </BannerButton>
            <BannerButton disabled={busy} onClick={() => void run(() => keep(update.id))}>
              留着我的
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
                <DiffView
                  lines={diff}
                  removedLabel="只在你这一版里"
                  addedLabel="只在新版里"
                  tooLong="两版都很长，没法逐行对比。"
                  className="mt-3 max-h-[300px]"
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
