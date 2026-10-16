import { cn } from "@/lib/cn";
import { type DiffLine, diffHunks } from "@/lib/lineDiff";

/* ============================================================
   两版正文的逐行差异（lib/lineDiff）：冲突副本横幅的「查看差异」、历史版本对话框共用。
   只列改动的地方，前后各带一行没变的作上下文；隔得远的改动之间画一道虚线。
   ============================================================ */

export function DiffView({
  lines,
  removedLabel,
  addedLabel,
  tooLong,
  className,
}: {
  /** null：两版都太长，没比 */
  lines: DiffLine[] | null;
  /** 图例：「−」那边是什么（只在旧的 / 原文 / 现在的版本里） */
  removedLabel: string;
  /** 图例：「+」那边是什么 */
  addedLabel: string;
  /** 没比的时候说什么 */
  tooLong: string;
  className?: string;
}) {
  if (!lines) {
    return <p className={cn("text-[12px] text-faint", className)}>{tooLong}</p>;
  }
  const hunks = diffHunks(lines);
  return (
    <div
      className={cn(
        "scroll-thin overflow-y-auto rounded-lg border border-line bg-canvas py-1.5 font-mono text-[12px] leading-[1.7]",
        className,
      )}
    >
      <div className="flex gap-3 px-3 pb-1.5 text-[12px] text-faint">
        <span>
          <span className="text-danger">−</span> {removedLabel}
        </span>
        <span>
          <span className="text-success">+</span> {addedLabel}
        </span>
      </div>
      {hunks.map((hunk, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: 差异段按位置排，不会重排
          key={index}
          className={cn(index > 0 && "mt-1.5 border-t border-dashed border-line pt-1.5")}
        >
          {hunk.lines.map((line, lineIndex) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: 同上
              key={lineIndex}
              className={cn(
                "flex gap-2 whitespace-pre-wrap break-words px-3",
                line.kind === "added" && "bg-success/10 text-body",
                line.kind === "removed" && "bg-danger/10 text-body",
                line.kind === "same" && "text-faint",
              )}
            >
              <span
                className={cn(
                  "w-2 shrink-0 select-none",
                  line.kind === "added" && "text-success",
                  line.kind === "removed" && "text-danger",
                )}
              >
                {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}
              </span>
              <span className="min-w-0">{line.text || " "}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
