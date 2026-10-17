import { useData } from "@/data/store";
import { FolderOpen } from "lucide-react";
import { useState } from "react";
import { BannerButton } from "./ConflictBanner";

/* ============================================================
   新装第一次打开时，标题上方的横幅：笔记存在哪，要不要换个位置（技术方案 §5.7）。

   默认放在「文档」里，Windows 上就是 C 盘；很多人想放到别的盘，却不知道命令面板里能换。
   「换个位置…」不再问三选一，直接搬过去（同盘改名、跨盘复制核对后原来的进回收站），
   换成了整页重载；「就放这里」只是收起，以后不再出（Rust 那边只给一次）。
   和指南的横幅一样用中性的主色。
   ============================================================ */

export function VaultPlaceBanner({ root }: { root: string }) {
  const changeVaultRoot = useData((s) => s.changeVaultRoot);
  const dismiss = useData((s) => s.dismissFirstRun);
  const [busy, setBusy] = useState(false);

  const move = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // 换成了会整页重载；取消了、出错了（提示条里说）横幅留着
      await changeVaultRoot("move");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-7 rounded-xl border border-accent/25 bg-accent-wash/60 px-4 py-3.5">
      <div className="flex items-start gap-2.5">
        <FolderOpen size={14} strokeWidth={1.9} className="mt-[3px] shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-[1.6] text-ink">你的笔记存在这个文件夹里</p>
          <p className="mt-0.5 break-all font-mono text-[12px] leading-[1.65] text-body">{root}</p>
          <p className="mt-1 text-[12px] leading-[1.65] text-muted">
            想放到别的盘，现在就可以换：笔记会一起搬过去，原来的文件夹放进回收站。以后也能在命令面板里「更换笔记文件夹…」。
          </p>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <BannerButton disabled={busy} onClick={() => void move()}>
              换个位置…
            </BannerButton>
            <BannerButton disabled={busy} onClick={dismiss}>
              就放这里
            </BannerButton>
          </div>
        </div>
      </div>
    </div>
  );
}
