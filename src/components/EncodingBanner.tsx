import { useData } from "@/data/store";
import type { DocumentRef, LegacyText } from "@/data/types";
import { Lock } from "lucide-react";
import { useState } from "react";
import { BannerButton } from "./ConflictBanner";

/* ============================================================
   文件不是 UTF-8 时标题上方的横幅（docs/1110审查与研究.md §5.1）。

   这样的文件只能看：读出来时认不出的字换成了 �，拿它写回去原文就没了，所以后端拒绝一切写回。
   横幅说清楚为什么，再给一条路 —— 转成 UTF-8：
   1. 先按认出来的编码（GBK / UTF-16）解一遍给人看。认错了（比如其实是别的编码）就是满屏乱码，
      这一眼不能省，所以不直接转
   2. 字对了再转。原文按原字节另存在旁边（`周报 (GBK 原文).txt`，不是 .md、不进列表），
      转错了还找得回来
   转完后端通知这一篇变了，列表、正文、编辑器跟着换，横幅随之消失。

   不是出错，用和归档横幅一样的中性底色；不做进出动画，随整块正文一起换。
   ============================================================ */

export function EncodingBanner({ target }: { target: DocumentRef | undefined }) {
  const legacyText = useData((s) => s.legacyText);
  const convertToUtf8 = useData((s) => s.convertToUtf8);
  const [legacy, setLegacy] = useState<LegacyText | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  const look = () =>
    run(async () => {
      if (target) setLegacy(await legacyText(target));
    });
  const convert = () =>
    run(async () => {
      if (target && legacy && (await convertToUtf8(target, legacy.fingerprint))) setLegacy(null);
    });

  return (
    <div role="note" className="mb-7 rounded-xl bg-raised/70 px-4 py-3.5">
      <div className="flex items-start gap-2.5">
        <Lock size={14} strokeWidth={1.9} className="mt-[3px] shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-[1.6] text-ink">
            这篇不是 UTF-8 编码，只能看
          </p>
          <p className="mt-0.5 text-[12px] leading-[1.65] text-muted">
            多半是 GBK 这类老编码，认不出的字显示成了 �。为了不把原文写坏，Odea 不改它；转成 UTF-8
            以后就能改了。
          </p>

          {!legacy && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <BannerButton disabled={busy || !target} onClick={() => void look()}>
                转成 UTF-8…
              </BannerButton>
            </div>
          )}

          {legacy?.encoding && (
            <>
              <p className="mt-3 text-[12px] leading-[1.65] text-body">
                按 {legacy.encoding} 认出来是这样，看看字对不对：
              </p>
              <pre
                data-legacy-preview
                className="scroll-none mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap break-words
                           rounded-lg bg-canvas px-3 py-2.5 font-sans text-[12px] leading-[1.65] text-body"
              >
                {legacy.preview || "（空的）"}
              </pre>
              <p className="mt-2 text-[12px] leading-[1.65] text-muted">
                转了以后，原来的文件另存为「{legacy.backup}
                」，放在同一个文件夹里；确认没问题再删掉它。
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <BannerButton strong disabled={busy} onClick={() => void convert()}>
                  字对，转成 UTF-8
                </BannerButton>
                <BannerButton disabled={busy} onClick={() => setLegacy(null)}>
                  算了
                </BannerButton>
              </div>
            </>
          )}

          {legacy && !legacy.encoding && (
            <>
              <p className="mt-3 text-[12px] leading-[1.65] text-body">
                认不出是什么编码（试过 GBK、UTF-16）。用别的编辑器另存成 UTF-8 以后再打开。
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <BannerButton onClick={() => setLegacy(null)}>知道了</BannerButton>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
