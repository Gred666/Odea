import { CAPABILITY_TEXT, capabilityKey } from "@/extensions/manifest";
import { popoverCard, tween } from "@/lib/motion";
import { type ConsentRequest, useConsent } from "@/plugins/scripted";
import { ShieldCheck, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

/* ============================================================
   带脚本的插件（L1）要的权限（docs/插件与跨端.md §5.2、§6.4）：装之前、升级多要了、团队仓库里开着
   但这台设备没同意过的时候问一次。每一项能单独不同意：插件照样起，用到那一样时回 denied
   （§5.2「只关掉用到它的那部分」）。授权记在这台设备上，不跟着仓库同步。

   外壳和更新说明一样：模糊遮罩 + 从上往下展开的实心卡片（popoverCard），字不缩放。
   ============================================================ */

const HEADER = 52;

export function PluginConsent() {
  const request = useConsent((s) => s.request);
  // 关的时候 request 先变回 null：收起动画那 0.2 秒里内容不能跟着没了
  const [shown, setShown] = useState<ConsentRequest | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [prev, setPrev] = useState(request);
  if (request !== prev) {
    setPrev(request);
    if (request) {
      setShown(request);
      setChecked(new Set(request.capabilities.map(capabilityKey)));
    }
  }

  const cancel = () => request?.resolve(null);
  const allow = () => {
    if (!request) return;
    const keys = request.capabilities.map(capabilityKey);
    request.resolve({
      granted: keys.filter((key) => checked.has(key)),
      denied: keys.filter((key) => !checked.has(key)),
    });
  };

  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        request.resolve(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [request]);

  const manifest = shown?.manifest;
  const install = shown?.mode === "install";

  return (
    <AnimatePresence>
      {request && manifest && (
        <>
          <motion.button
            key="scrim"
            type="button"
            data-ghost-skip
            aria-label="取消"
            onClick={cancel}
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
              aria-label={`「${manifest.name}」要的权限`}
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
                <ShieldCheck size={16} strokeWidth={2} className="shrink-0 text-accent" />
                <p className="flex-1 truncate text-[14px] font-medium text-ink">
                  {install ? `安装「${manifest.name}」` : `「${manifest.name}」要的权限`}
                </p>
                <button
                  type="button"
                  aria-label="关闭"
                  onClick={cancel}
                  className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors
                             duration-[140ms] hover:bg-raised hover:text-ink"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </div>
              <div className="px-5 pb-5 pt-4">
                <p className="text-[13px] text-muted">
                  {manifest.author} · v{manifest.version}
                </p>
                <p className="mt-3 text-[13px] leading-[1.7] text-body">
                  这是带脚本的插件。它的代码跑在隔离的沙箱里：碰不到你的文件、网络和 Odea
                  本身，只能经 Odea 做下面这几件事。不同意的那几项，用到时插件会被拒掉。
                </p>
                <ul className="mt-4 flex flex-col gap-1">
                  {shown.capabilities.map((capability) => {
                    const key = capabilityKey(capability);
                    const text = CAPABILITY_TEXT[key];
                    return (
                      <li key={key}>
                        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 transition-colors duration-[140ms] hover:bg-raised/60">
                          <input
                            type="checkbox"
                            checked={checked.has(key)}
                            onChange={(event) =>
                              setChecked((current) => {
                                const next = new Set(current);
                                if (event.target.checked) next.add(key);
                                else next.delete(key);
                                return next;
                              })
                            }
                            className="mt-[3px] h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]"
                          />
                          <span className="min-w-0">
                            <span className="block text-[13px] font-medium text-ink">
                              {text?.label ?? key}
                            </span>
                            <span className="block text-[12px] leading-[1.6] text-muted">
                              {capability.reason ?? text?.detail ?? key}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                  {shown.capabilities.length === 0 && (
                    <li className="px-2 py-2 text-[13px] text-muted">它不要任何权限。</li>
                  )}
                </ul>
                <p className="mt-3 text-[12px] leading-[1.6] text-faint">
                  授权记在这台设备上，不跟着仓库同步；卸载时一起删掉。
                </p>
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={cancel}
                    className="h-8 rounded-lg bg-raised px-3 text-[12px] font-medium text-ink
                               transition-colors duration-[140ms] hover:bg-line-strong"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={allow}
                    className="h-8 rounded-lg bg-accent px-3 text-[12px] font-medium text-accent-ink
                               transition-colors duration-[140ms] hover:bg-accent-hover"
                  >
                    {install ? "安装" : "好"}
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
