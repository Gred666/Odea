import { type PaletteDialog, useApp } from "@/app/store";
import { ArrowLeft, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 从命令面板打开的对话框（历史版本、回收站、同步、协作……）能回到命令面板：
 * 标题栏最左边的图标换成「←」，Esc 也是回去，面板里还是刚才打的字、高亮停在刚才选的那一项。
 * 以前不想要了只能关掉、再按一遍 Ctrl+K、重新打字（2026-10-28 用户反馈）。
 * 点遮罩、点 ×、做完了照旧整个关掉。
 *
 * 返回 null：不是从命令面板来的（侧栏、快捷键、别的对话框里打开的）。
 * 「是不是从面板来的」在打开的那一刻定下来：点了返回、面板那边已经清了记录，
 * 这边收起动画那 0.2 秒里标题栏左边还是箭头，不跟着跳回图标
 */
export function usePaletteBack(
  dialog: PaletteDialog,
  open: boolean,
  close: () => void,
): (() => void) | null {
  const fromPalette = useApp((s) => s.paletteBack?.dialog === dialog);
  const [shown, setShown] = useState(fromPalette);
  if (open && fromPalette !== shown) setShown(fromPalette);

  // 关掉了（返回、×、点遮罩、做完了）：不再记着，下回从别处打开的不带返回
  useEffect(() => {
    if (open) return;
    const { paletteBack, setPaletteBack } = useApp.getState();
    if (paletteBack?.dialog === dialog) setPaletteBack(null);
  }, [open, dialog]);

  const closeRef = useRef(close);
  closeRef.current = close;
  const back = useCallback(() => {
    useApp.getState().backToPalette();
    closeRef.current();
  }, []);
  return shown ? back : null;
}

/** 对话框标题栏最左边：平时是这个对话框的图标，从命令面板来的换成返回按钮，占的宽度一样 */
export function DialogLead({
  icon: Icon,
  back,
  className = "text-faint",
}: {
  icon: LucideIcon;
  back: (() => void) | null;
  /** 图标的颜色 */
  className?: string;
}) {
  if (!back) return <Icon size={16} strokeWidth={2} className={`shrink-0 ${className}`} />;
  return (
    <button
      type="button"
      aria-label="返回命令面板"
      title="返回命令面板（Esc）"
      onClick={back}
      // 28 宽的按钮左右各收 6px，占的还是图标那 16px：标题不挪
      className="-mx-1.5 grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted
                 transition-colors duration-[140ms] hover:bg-raised hover:text-ink"
    >
      <ArrowLeft size={16} strokeWidth={2} />
    </button>
  );
}
