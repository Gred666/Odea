import { openDocument } from "@/app/navigate";
import { backend } from "@/data/backend";
import { useData } from "@/data/store";
import type { Backlink } from "@/data/types";
import { cn } from "@/lib/cn";
import { tween } from "@/lib/motion";
import { sameTitle, splitWikiSegments, wikiDisplayText, wikiTargetTitle } from "@/lib/wikilinks";
import { CalendarDays, FileText, Link2, Target } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

/* ============================================================
   反向链接：别的文档里写了 `[[这篇的标题]]` 的地方，列在正文后面。

   在后端算（Rust 的 Vault::backlinks，扫的是索引里所有文档的正文，没打开过的
   某一天、目标也算）。任何一篇存了（笔记 / 某一天 / 目标在 store 里换了一份），
   半秒后重取一次 —— 刚在别的文档里写下的链接，切回来就能看到。

   点标题打开那一篇，点某一行打开并滚到那一行。
   ============================================================ */

const ICONS = { note: FileText, day: CalendarDays, goal: Target } as const;

export function Backlinks({ noteId, title }: { noteId: string; title: string }) {
  const [links, setLinks] = useState<Backlink[] | null>(null);
  const loadedOnce = useRef(false);
  // 任何文档存了都会换掉这几样中的一个：拿它们当「仓库里的正文变了」的信号
  const notes = useData((s) => s.notes);
  const archived = useData((s) => s.archived);
  const dayDocs = useData((s) => s.dayDocs);
  const goals = useData((s) => s.goals);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 那几样只是重取的信号
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(
      async () => {
        try {
          const result = await (await backend()).noteBacklinks(noteId);
          if (alive) setLinks(result);
        } catch {
          // 取不到就当没有：反向链接是附加信息，不该为它弹错误提示
          if (alive) setLinks((current) => current ?? []);
        }
        loadedOnce.current = true;
      },
      loadedOnce.current ? 500 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [noteId, title, notes, archived, dayDocs, goals]);

  // 第一次还没取回来、或者没有别的文档链过来：什么都不画。以前没有时也画一块
  // 「还没有别的文档链接到这里…」，每篇笔记底下都挂着同一段说明，只是噪音
  if (!links || links.length === 0) return null;

  return (
    <motion.section
      aria-label="反向链接"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={tween.base}
      className="mt-14"
    >
      <div className="mb-2.5 flex items-center gap-2">
        <Link2 size={14} strokeWidth={2} className="text-faint" />
        <h2 className="text-[12px] font-semibold tracking-[0.04em] text-muted">反向链接</h2>
        <span className="rounded-full bg-raised px-1.5 text-[11px] leading-[17px] text-muted tabular-nums">
          {links.length}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {links.map((link) => (
          <BacklinkCard key={keyOf(link)} link={link} title={title} />
        ))}
      </div>
    </motion.section>
  );
}

function BacklinkCard({ link, title }: { link: Backlink; title: string }) {
  const Icon = ICONS[link.kind];
  const open = (line?: number) => openDocument(link.target, line ? { line } : undefined);

  return (
    <div className="rounded-lg border border-line bg-canvas px-1.5 py-1.5">
      <button
        type="button"
        onClick={() => open(link.lines[0] ? link.lines[0].line + 1 : undefined)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors
                   duration-[140ms] hover:bg-raised/60"
      >
        <Icon size={14} strokeWidth={1.9} className="shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink/90">
          {link.title}
        </span>
        {link.archived && <span className="shrink-0 text-[12px] text-muted">已归档</span>}
        {link.count > 1 && (
          <span className="shrink-0 font-mono text-[12px] text-muted tabular-nums">
            {link.count} 处
          </span>
        )}
      </button>
      {link.lines.map((line) => (
        <button
          key={line.line}
          type="button"
          onClick={() => open(line.line + 1)}
          title="打开并跳到这一行"
          className="block w-full rounded-md px-2 py-1 pl-[29px] text-left text-[13px] leading-[1.6]
                     text-muted transition-colors duration-[140ms] hover:bg-raised/60 hover:text-body"
        >
          <span className="line-clamp-2">
            <LineText text={line.text} title={title} />
          </span>
        </button>
      ))}
    </div>
  );
}

/** 一行原文：双链画成小块（链到这一篇的用主色），其余的强调符号去掉 */
function LineText({ text, title }: { text: string; title: string }) {
  return (
    <>
      {splitWikiSegments(text).map((part, index) =>
        part.kind === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 一行之内的片段顺序固定
          <span key={index}>{part.text.replace(/\*\*|__|~~|==/g, "")}</span>
        ) : (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: 同上
            key={index}
            className={cn(
              "rounded-[4px] px-1 py-px",
              sameTitle(wikiTargetTitle(part.inner), title)
                ? "bg-accent-wash text-accent"
                : "bg-raised text-body",
            )}
          >
            {wikiDisplayText(part.inner)}
          </span>
        ),
      )}
    </>
  );
}

function keyOf(link: Backlink): string {
  const target = link.target;
  return target.kind === "goal"
    ? `goal:${target.horizon}:${target.periodStart}`
    : `${target.kind}:${target.id}`;
}
