import { cn } from "@/lib/cn";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, MoreHorizontal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { type ReactElement, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuAction {
  id: string;
  label: string;
  icon: LucideIcon;
  danger?: boolean;
  /**
   * 单选菜单（排序）里的当前项。只要任一项给了这个字段，整个菜单就按
   * 单选渲染：右侧留出勾选位，选中项打勾。
   */
  checked?: boolean;
  onSelect: () => void;
}

/**
 * 通用下拉菜单：任意触发元素 + 一列动作。
 * 用 Radix 拿焦点管理、键盘导航和定位；进出场是 globals.css 里的 .otw-menu
 * 关键帧，靠 Radix 自己的 data-state 驱动 —— 收起时它会等 animationend 再卸载，
 * 不需要 AnimatePresence。为什么不用 Motion 见那段 CSS 的注释（逐帧栅格化）。
 *
 * modal={false}：默认的 modal 模式会在打开时给 body 挂 pointer-events:none、
 * 用 react-remove-scroll 锁滚动（要同步量一次滚动条宽度 —— 强制排版整页，
 * 编辑器一长就是几十毫秒的卡顿）、再给页面其它部分逐个打 aria-hidden；关闭时
 * 全部撤销。这些开销都落在弹出/收起的那一帧上，正是「出现和消失有点卡」的
 * 来源。行内菜单不需要这些：点外面就关，底下的内容照常可交互。
 */
export function ActionMenu({
  trigger,
  actions,
  align = "end",
  defaultOpen = false,
  onOpenChange,
}: {
  /** 触发元素。会以 asChild 方式接管，必须能接受 ref 和事件 props */
  trigger: ReactElement;
  actions: MenuAction[];
  align?: "start" | "center" | "end";
  /** 一挂上就是开着的（RowMenu 在挂上菜单之前就被点了） */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂上时告诉一次
  useEffect(() => {
    if (defaultOpen) onOpenChange?.(true);
  }, []);
  const radio = actions.some((a) => a.checked !== undefined);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  const itemClass = (a: MenuAction) =>
    cn(
      "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-[6px]",
      "text-[12.5px] outline-none transition-colors duration-[110ms]",
      a.danger
        ? "text-danger data-[highlighted]:bg-danger/10"
        : "text-body data-[highlighted]:bg-raised data-[highlighted]:text-ink",
    );

  const itemBody = (a: MenuAction) => {
    const Icon = a.icon;
    return (
      <>
        <Icon size={13} strokeWidth={1.9} className="shrink-0" />
        <span className="flex-1">{a.label}</span>
        {radio && (
          <Check
            size={12}
            strokeWidth={2.4}
            aria-hidden="true"
            className={cn("ml-3 shrink-0 text-ink", a.checked ? "opacity-100" : "opacity-0")}
          />
        )}
      </>
    );
  };

  return (
    <DropdownMenu.Root open={open} onOpenChange={handleOpenChange} modal={false}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={5}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="otw-menu z-50 min-w-[142px] overflow-hidden rounded-lg bg-canvas p-1
                     shadow-float outline-none ring-1 ring-line-strong"
        >
          {radio ? (
            <DropdownMenu.RadioGroup value={actions.find((a) => a.checked)?.id}>
              {actions.map((a) => (
                <DropdownMenu.RadioItem
                  key={a.id}
                  value={a.id}
                  onSelect={a.onSelect}
                  className={itemClass(a)}
                >
                  {itemBody(a)}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          ) : (
            actions.map((a) => (
              <DropdownMenu.Item key={a.id} onSelect={a.onSelect} className={itemClass(a)}>
                {itemBody(a)}
              </DropdownMenu.Item>
            ))
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * 列表行右上角的「…」菜单。
 *
 * 笔记列表里几百行，每行挂一整套 Radix 下拉菜单（Root、Trigger、Popper 锚点、集合……）
 * 在启动和整列重渲染时都不便宜。所以先画一个长得一模一样的普通按钮，指针移上来、
 * 键盘焦点进来（或者没移上来就点了）才换成真的菜单。
 */
export function RowMenu({
  actions,
  alwaysVisible,
  onOpenChange,
}: {
  actions: MenuAction[];
  /** 选中行的「…」常驻显示，其余悬停才出现 */
  alwaysVisible?: boolean;
  /** 打开期间行本身要保持悬停态（指针在菜单上时行已经失去 hover） */
  onOpenChange?: (open: boolean) => void;
}) {
  const [armed, setArmed] = useState<"no" | "yes" | "open">("no");
  const button = useRef<HTMLButtonElement>(null);
  /** 焦点在占位按钮上时换成了真的：焦点要跟到新按钮上 */
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (armed === "no" || !refocus.current) return;
    refocus.current = false;
    button.current?.focus();
  }, [armed]);

  const trigger = (
    <button
      ref={button}
      type="button"
      aria-label="更多操作"
      onClick={(e) => {
        e.stopPropagation();
        if (armed === "no") setArmed("open");
      }}
      onPointerEnter={armed === "no" ? () => setArmed("yes") : undefined}
      onFocus={
        armed === "no"
          ? () => {
              refocus.current = true;
              setArmed("yes");
            }
          : undefined
      }
      className={cn(
        "grid h-5 w-5 place-items-center rounded text-faint",
        "transition-[background-color,color,opacity] duration-[150ms] hover:bg-raised hover:text-ink",
        "data-[state=open]:bg-raised data-[state=open]:text-ink data-[state=open]:opacity-100",
        alwaysVisible ? "opacity-100" : "opacity-0 group-hover:opacity-100",
      )}
    >
      <MoreHorizontal size={13} strokeWidth={2} />
    </button>
  );
  if (armed === "no") return trigger;
  return (
    <ActionMenu
      actions={actions}
      defaultOpen={armed === "open"}
      onOpenChange={onOpenChange}
      trigger={trigger}
    />
  );
}
