import { cn } from "@/lib/cn";
import { usePaneWindow } from "@/lib/paneWindow";
import {
  type ReactElement,
  type ReactNode,
  cloneElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/* ============================================================
   视图工具条上的小面板（筛选、排序、分组、属性、源码）：贴着按钮出现，点外面、Esc 收起。
   里面有输入框、下拉框，不能用 ActionMenu（Radix 的菜单：方向键归它、字母键跳到那一项）。

   挂在这个窗格所在窗口的 body 上（弹出窗口里也对，lib/paneWindow）。只淡入，不位移（docs/PITFALLS/动效.md）。
   收起时焦点回到按钮（键盘用户不迷路）；点外面收起的不抢焦点
   ============================================================ */

export function Popover({
  trigger,
  children,
  label,
  width = 360,
  open: controlled,
  onOpenChange,
}: {
  /** 触发按钮：会接上 ref、onClick、aria-expanded */
  trigger: ReactElement<Record<string, unknown>>;
  children: ReactNode | ((close: () => void) => ReactNode);
  label: string;
  width?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = (next: boolean) => {
    setOwn(next);
    onOpenChange?.(next);
  };
  const button = useRef<HTMLElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const { doc, win } = usePaneWindow();
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  // 摆在按钮下面，右边对齐按钮的右边；出了窗口就往回收
  useLayoutEffect(() => {
    if (!open) {
      setAt(null);
      return;
    }
    const place = () => {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return;
      const left = Math.max(8, Math.min(rect.right - width, win.innerWidth - width - 8));
      setAt({ top: rect.bottom + 6, left });
    };
    place();
    win.addEventListener("resize", place);
    return () => win.removeEventListener("resize", place);
  }, [open, width, win]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setOpen 每次渲染是新的，只跟着开关走
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || button.current?.contains(target)) return;
      // 面板里开出来的下拉菜单（Radix）挂在 body 上：点它不算点外面
      if ((target as Element).closest?.("[data-radix-popper-content-wrapper]")) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    doc.addEventListener("pointerdown", onDown, true);
    doc.addEventListener("keydown", onKey);
    return () => {
      doc.removeEventListener("pointerdown", onDown, true);
      doc.removeEventListener("keydown", onKey);
    };
  }, [open, doc]);

  // 开了焦点进面板的第一个能填的地方
  useEffect(() => {
    if (!open || !at) return;
    const first = panel.current?.querySelector<HTMLElement>(
      "input, select, textarea, button:not([disabled])",
    );
    first?.focus({ preventScroll: true });
  }, [open, at]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <>
      {cloneElement(trigger, {
        ref: button,
        "aria-expanded": open,
        "aria-haspopup": "dialog",
        "data-state": open ? "open" : "closed",
        onClick: () => setOpen(!open),
      })}
      {open &&
        at &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-label={label}
            className={cn(
              "odea-menu fixed z-50 max-h-[min(560px,calc(100vh-80px))] overflow-y-auto rounded-lg bg-canvas p-2",
              "shadow-float outline-none ring-1 ring-line-strong",
            )}
            data-state="open"
            style={{ top: at.top, left: at.left, width }}
          >
            {typeof children === "function" ? children(close) : children}
          </div>,
          doc.body,
        )}
    </>
  );
}
