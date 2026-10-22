import { tween } from "@/lib/motion";
import { answerTeamRelay, useTeam } from "@/team/store";
import { Radio } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

/**
 * 团队仓库里写着一台还没用过的中继（docs/协同编辑.md §22.4）：问一句用不用。用了以后不在同一个网络的
 * 成员也连得上；说了不用就不再问（中继对话框里还能加）。出现、消失只淡（CLAUDE.md 动效规矩 1）
 */
export function TeamRelayToast() {
  const relay = useTeam((s) => s.relays.find((item) => item.state === "ask"));
  const [busy, setBusy] = useState(false);
  const answer = (accept: boolean) => {
    if (!relay) return;
    setBusy(true);
    void answerTeamRelay(relay.url, accept).finally(() => setBusy(false));
  };
  return (
    <AnimatePresence>
      {relay && (
        <motion.div
          key={relay.url}
          role="status"
          data-team-relay-ask
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: tween.fast }}
          transition={tween.slow}
          className="pointer-events-auto flex max-w-[600px] items-center gap-3 rounded-xl
                     bg-ink py-2 pl-3.5 pr-2 text-[13px] text-canvas shadow-float"
        >
          <Radio size={13} strokeWidth={2} className="shrink-0 text-accent" />
          <span
            className="min-w-0 truncate"
            title="经中继转的时候，它看得到你的 IP 地址，看不到内容"
          >
            这个团队仓库用中继「{relay.name ?? relay.host}」：用了以后不在同一个网络的成员也连得上
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => answer(true)}
            className="shrink-0 rounded-md px-2 py-1 font-semibold text-canvas
                       transition-colors duration-[140ms] hover:bg-canvas/15 disabled:opacity-60"
          >
            用
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => answer(false)}
            className="shrink-0 rounded-md px-2 py-1 text-canvas/75
                       transition-colors duration-[140ms] hover:bg-canvas/15 disabled:opacity-60"
          >
            不用
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
