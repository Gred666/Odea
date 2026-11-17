import type { DocumentModel } from "@/data/types";
import { cn } from "@/lib/cn";
import { diffLines } from "@/lib/lineDiff";
import { tween } from "@/lib/motion";
import { hideTeamUnseen, teamDocId, teamUnseenText, useTeam } from "@/team/store";
import { ChevronRight, Copy, Users } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { BannerButton } from "./ConflictBanner";
import { DiffView } from "./DiffView";
import { Segmented } from "./Segmented";

/* ============================================================
   团队里加入一篇、本机那一版没合进会话时，标题上方的提示（docs/协同编辑.md §28）。

   没有 base、三方合撞上、文档太大合不了的时候，加入以后编辑器里是主持人的那一版：自己正在看的字突然
   变成别人的，第一反应是「我的字丢了」。数据其实在（本机磁盘上；这台要拿会话的正文盖它时先另存冲突副本，
   会话收了、磁盘没动的话 git 下一轮自己合），这里说一声，再让人看得到、复制得到自己那一版。

   快照里只有主持人的名字（controller 的 unseenFrom），正文点「看我的那一版」时才取（teamUnseenText）。
   不是出错，用不是 UTF-8 那种中性底；进出照归档横幅（换篇时随整块正文一起换，不单独播）。
   本机那一版另存成冲突副本、会话收了，controller 就不带名字了，这里跟着收起
   ============================================================ */

export function TeamUnseenBanner({ doc }: { doc: DocumentModel }) {
  const id = teamDocId(doc);
  const from = useTeam((s) => (id ? s.sessions[id]?.unseenFrom : undefined));
  return (
    <AnimatePresence initial={false}>
      {id && from && (
        <motion.div
          key={id}
          data-team-unseen
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={tween.base}
          className="mb-7 rounded-xl bg-raised/70 px-4 py-3.5"
        >
          <Body doc={id} from={from} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

type Copied = "idle" | "done" | "failed";

function Body({ doc, from }: { doc: string; from: string }) {
  const session = useTeam((s) => s.sessions[doc]?.session);
  // 展开时取的：我的那一版，和那一刻会话的正文（比差异用；之后别人又打的字不跟着重算）
  const [shown, setShown] = useState<{ mine: string; now: string } | null>(null);
  const [view, setView] = useState<"full" | "diff">("full");
  const [copied, setCopied] = useState<Copied>("idle");

  const toggle = () => {
    if (shown) {
      setShown(null);
      return;
    }
    const mine = teamUnseenText(doc);
    // 名字还在、正文没了：正好在这一下另存了副本，横幅马上就收起
    if (mine === null) return;
    setShown({ mine, now: session?.toString() ?? "" });
  };

  const diff = useMemo(
    () => (shown && view === "diff" ? diffLines(shown.now, shown.mine) : null),
    [shown, view],
  );

  const copy = async () => {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(shown.mine);
      setCopied("done");
    } catch {
      // 剪贴板不让写（没有焦点、权限）：说一声，全文本来就能选中复制
      setCopied("failed");
    }
  };
  useEffect(() => {
    if (copied === "idle") return;
    const timer = setTimeout(() => setCopied("idle"), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="flex items-start gap-2.5">
      <Users size={14} strokeWidth={1.9} className="mt-[3px] shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        {/* 不挡人的通知：出现时读一遍。按钮和展开的正文不在里面，展开时不把全文读一遍 */}
        <div role="status">
          <p className="text-[13px] font-medium leading-[1.6] text-ink">
            你这边的版本和 {from} 正在编辑的不一样
          </p>
          <p className="mt-0.5 text-[12px] leading-[1.65] text-muted">
            现在显示的是 {from} 的；你这边的那一版还留着，不会丢。
          </p>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <BannerButton expanded={!!shown} onClick={toggle}>
            <ChevronRight
              size={12}
              strokeWidth={2.2}
              className={cn("transition-transform duration-[160ms]", shown && "rotate-90")}
            />
            看我的那一版
          </BannerButton>
          <BannerButton onClick={() => hideTeamUnseen(doc)}>知道了</BannerButton>
        </div>

        <AnimatePresence initial={false}>
          {shown && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={tween.fast}
            >
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <Segmented
                  group="team-unseen"
                  size="sm"
                  value={view}
                  onChange={setView}
                  options={[
                    { value: "full", label: "全文" },
                    { value: "diff", label: "差异" },
                  ]}
                />
                <BannerButton onClick={() => void copy()}>
                  <Copy size={12} strokeWidth={2} />
                  {copied === "done"
                    ? "已复制"
                    : copied === "failed"
                      ? "复制不了，在全文里选中复制吧"
                      : "复制"}
                </BannerButton>
              </div>
              {view === "full" ? (
                <pre
                  data-team-unseen-text
                  className="scroll-thin mt-2 max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded-lg
                             border border-line bg-canvas px-3 py-2.5 font-mono text-[12px] leading-[1.7] text-body"
                >
                  {shown.mine || "（这一版是空的）"}
                </pre>
              ) : (
                <DiffView
                  lines={diff}
                  removedLabel="只在现在的正文里"
                  addedLabel="只在你这一版里"
                  tooLong="两版都很长，没法逐行对比。切到「全文」看你这一版吧。"
                  className="mt-2 max-h-[300px]"
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
