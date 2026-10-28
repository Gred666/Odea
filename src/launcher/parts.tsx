import { cn } from "@/lib/cn";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";

/* 启动器右边几屏共用的小东西：按钮、输入框的样子、带返回的标题 */

export function Button({
  children,
  primary,
  disabled,
  onClick,
  type = "button",
}: {
  children: ReactNode;
  primary?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      disabled={disabled}
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
