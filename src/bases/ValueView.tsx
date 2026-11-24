import { openDocument } from "@/app/navigate";
import { useData } from "@/data/store";
import { noteRef } from "@/data/types";
import { cn } from "@/lib/cn";
import { MOD_KEY } from "@/lib/platform";
import { tip } from "@/lib/tooltip";
import { describeDate } from "@/properties/PropertiesPanel";
import { Check } from "lucide-react";
import { BDate, BDuration, BFile, BLink, BObject, type Value, formatDate, toText } from "./expr";

/* ============================================================
   一格的值画成什么（表格的格子、卡片上的几项、看板的卡片、组头）：
   日期写「11月20日 周五」、列表是小块、勾选是一个勾、双链是主色的标题（点了打开）。算不了的是「—」
   ============================================================ */

/** 按标题找一篇笔记打开（双链、`link()`）：找不到就说一句 */
export function openByTitle(title: string, newTab = false): void {
  const wanted = title.trim().toLowerCase();
  const note = useData
    .getState()
    .notes.find(
      (item) =>
        item.title.trim().toLowerCase() === wanted ||
        item.relPath.toLowerCase().endsWith(`/${wanted}.md`),
    );
  if (note) openDocument(noteRef(note.id), undefined, newTab);
  else useData.setState({ error: `仓库里没有「${title.trim()}」这一篇` });
}

function dateLabel(value: BDate): string {
  if (value.dateOnly) return describeDate(formatDate(value, "YYYY-MM-DD"), false).label;
  return describeDate(formatDate(value, "YYYY-MM-DDTHH:mm"), true).label;
}

const CHIP =
  "inline-flex h-[22px] max-w-full shrink-0 items-center truncate rounded-sm bg-raised/70 px-1.5 text-[12px] text-body";

export function ValueView({
  value,
  error,
  className,
}: {
  value: Value;
  error?: string | null;
  className?: string;
}) {
  if (error) {
    return (
      <span {...tip(error, { name: false })} className={cn("text-faint", className)}>
        —
      </span>
    );
  }
  if (value === null || value === "") return null;
  if (typeof value === "boolean") {
    return (
      <span
        role="img"
        aria-label={value ? "是" : "否"}
        className={cn(
          "grid h-4 w-4 shrink-0 place-items-center rounded-xs border",
          value ? "border-accent bg-accent text-accent-ink" : "border-faint",
          className,
        )}
      >
        {value && <Check size={12} strokeWidth={3} />}
      </span>
    );
  }
  if (typeof value === "number") {
    return <span className={cn("truncate tabular-nums", className)}>{toText(value)}</span>;
  }
  if (value instanceof BDate) {
    return (
      <span
        className={cn("truncate tabular-nums", className)}
        {...tip(toText(value), { name: false })}
      >
        {dateLabel(value)}
      </span>
    );
  }
  if (value instanceof BLink || value instanceof BFile) {
    const title = value instanceof BLink ? value.target : value.source.title;
    const shown = value instanceof BLink ? (value.display ?? value.target) : value.source.title;
    return (
      <button
        type="button"
        tabIndex={-1}
        {...tip(title, { detail: `点了打开，${MOD_KEY} + 点开在新标签`, name: false })}
        onClick={(event) => {
          event.stopPropagation();
          openByTitle(title, event.ctrlKey || event.metaKey);
        }}
        className={cn("min-w-0 truncate text-left text-accent hover:underline", className)}
      >
        {shown}
      </button>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return (
      <span className={cn("flex min-w-0 flex-wrap items-center gap-1 overflow-hidden", className)}>
        {value.map((item, index) => (
          // 列表里可能有重复的项
          // biome-ignore lint/suspicious/noArrayIndexKey: 位置就是身份
          <span key={index} className={CHIP}>
            {item instanceof BLink
              ? (item.display ?? item.target)
              : item instanceof BDate
                ? dateLabel(item)
                : toText(item)}
          </span>
        ))}
      </span>
    );
  }
  if (value instanceof BDuration || value instanceof BObject || value instanceof RegExp) {
    return <span className={cn("truncate", className)}>{toText(value)}</span>;
  }
  return (
    <span className={cn("truncate", className)} data-tip-overflow>
      {value}
    </span>
  );
}
