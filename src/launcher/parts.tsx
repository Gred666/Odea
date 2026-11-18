import { cn } from "@/lib/cn";
import { ChevronLeft } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { launcherApi } from "./api";

/* 启动器右边几屏共用的小东西：按钮、输入框的样子、带返回的标题 */

export function Button({
  children,
  primary,
  disabled,
  autoFocus,
  onClick,
  type = "button",
}: {
  children: ReactNode;
  primary?: boolean;
  disabled?: boolean;
  /** 挂上时接焦点（启动器从别的屏回到首页，焦点回到打开那一屏的按钮） */
  autoFocus?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      // biome-ignore lint/a11y/noAutofocus: 只在从别的屏返回时给，把焦点还给打开那一屏的按钮
      autoFocus={autoFocus}
      onClick={onClick}
      className={cn(
        "h-8 min-w-[72px] shrink-0 rounded-md px-3.5 text-[13px] font-medium transition-colors duration-[120ms]",
        "disabled:cursor-default disabled:opacity-50",
        primary
          ? "bg-accent text-accent-ink hover:bg-accent-hover"
          : "bg-canvas text-ink ring-1 ring-line-strong hover:bg-raised",
      )}
    >
      {children}
    </button>
  );
}

export function PanelHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="mb-4 flex items-center gap-1">
      <button
        type="button"
        onClick={onBack}
        aria-label="返回"
        data-panel-back
        className="-ml-2 grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink"
      >
        <ChevronLeft size={18} strokeWidth={1.8} />
      </button>
      <p className="text-[15px] font-semibold text-ink">{title}</p>
    </div>
  );
}

export const FIELD =
  "h-9 w-full min-w-0 rounded-lg border border-line-strong bg-canvas px-3 text-[13px] text-ink " +
  "outline-none focus:border-accent";

/**
 * 仓库放在哪（新建、拉一份共用）：一打开先取默认位置（「文档」文件夹），「换个位置…」开系统的选文件夹。
 * 两样都可能出错（「文档」被重定向到不存在的盘、对话框起不来）：以前没人接，位置一栏空着、「创建」一直灰着，
 * 什么都不说（审查 2026-11-13 §5.9）。现在在这一栏下面说一句
 */
export function useParentFolder() {
  const [parent, setParent] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    launcherApi
      .defaultParent()
      .then((dir) => setParent((now) => now || dir))
      .catch((error) =>
        setProblem(`没找到默认的位置（${errorMessage(error)}），点「换个位置…」选一个`),
      );
  }, []);
  const pick = () => {
    launcherApi
      .pickParent(parent)
      .then((picked) => {
        if (!picked) return;
        setParent(picked);
        setProblem(null);
      })
      .catch((error) => setProblem(`选位置的对话框没打开：${errorMessage(error)}`));
  };
  return { parent, pick, problem };
}

export function ParentField({
  parent,
  problem,
  busy,
  onPick,
  className,
}: {
  parent: string;
  problem: string | null;
  busy: boolean;
  onPick: () => void;
  className?: string;
}) {
  return (
    <>
      <div className={cn("flex gap-2", className)}>
        <p className={cn(FIELD, "flex items-center truncate text-body")} title={parent}>
          {parent}
        </p>
        <Button disabled={busy} onClick={onPick}>
          换个位置…
        </Button>
      </div>
      {problem && (
        <p role="alert" className="mt-1.5 text-[12px] leading-[1.6] text-danger">
          {problem}
        </p>
      )}
    </>
  );
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
