import { tween } from "@/lib/motion";
import { usePaneWindow } from "@/lib/paneWindow";
import { type WindowControls, isTauri, win } from "@/lib/tauri";
import { motion } from "motion/react";
import { useEffect, useState } from "react";

/* ============================================================
   自定义标题栏（decorations: false 后系统按钮没了，自己接）。

   设计上它是「不存在的」——没有背景、没有边框，只是一条 38px 的
   可拖拽空白带，浮在内容之上。窗口按钮平时是极淡的灰点，
   悬停整条标题栏时才浮现。这样静止时界面干净，需要时又找得到。

   按钮看上去还是那几个小圆角块，但能点的范围铺满整条标题栏的高度、
   一直到窗口右边缘：鼠标甩到右上角就是「关闭」，不用瞄准。

   弹出窗口（docs/标签页与分屏.md §16）也用它：controls 换成那个窗口的，窗口大小变了听的是那个窗口
   ============================================================ */

export function TitleBar({ controls = win }: { controls?: WindowControls }) {
  const [maximized, setMaximized] = useState(false);
  const [hovered, setHovered] = useState(false);
  const host = usePaneWindow().win;

  // 最大化 / 还原不只来自这里的按钮：Win+↑、拖到屏幕顶上吸附、双击以外的系统操作
  // 都会改窗口大小。窗口一变就重新问一次，图标别和实际状态对不上
  useEffect(() => {
    if (!isTauri) return;
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void controls.isMaximized().then(setMaximized));
    };
    sync();
    host.addEventListener("resize", sync);
    return () => {
      cancelAnimationFrame(frame);
      host.removeEventListener("resize", sync);
    };
  }, [controls, host]);

  // 浏览器里调试时不渲染，免得占掉 38px 影响布局判断
  if (!isTauri) return null;

  return (
    <div
      className="fixed inset-x-0 top-0 z-40 flex h-[38px] items-stretch justify-end"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={(event) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
        if (event.detail === 2) void controls.toggleMaximize().then(setMaximized);
        else void controls.startDragging();
      }}
    >
      <motion.div
        className="flex items-stretch"
        animate={{ opacity: hovered ? 1 : 0.28 }}
        transition={tween.base}
      >
        <WinButton label="最小化" onClick={() => void controls.minimize()}>
          <rect x="3.5" y="7.5" width="9" height="1" rx="0.5" />
        </WinButton>

        <WinButton
          label={maximized ? "还原" : "最大化"}
          onClick={() => void controls.toggleMaximize().then(setMaximized)}
        >
          {maximized ? (
            <>
              <rect x="3" y="5" width="7" height="7" rx="1.3" fill="none" strokeWidth="1.2" />
              <path
                d="M6 5V4.2A1.2 1.2 0 0 1 7.2 3h4.6A1.2 1.2 0 0 1 13 4.2v4.6A1.2 1.2 0 0 1 11.8 10H11"
                fill="none"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </>
          ) : (
            <rect x="3.5" y="3.5" width="9" height="9" rx="1.4" fill="none" strokeWidth="1.2" />
          )}
        </WinButton>

        <WinButton label="关闭" danger corner onClick={() => void controls.close()}>
          <path d="M4 4l8 8M12 4l-8 8" strokeWidth="1.3" strokeLinecap="round" fill="none" />
        </WinButton>
      </motion.div>
    </div>
  );
}

export function WinButton({
  children,
  onClick,
  label,
  danger,
  corner,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  danger?: boolean;
  /** 最右边那一个：点的范围一直铺到窗口右边缘 */
  corner?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      // 按钮本身是整条标题栏高的一格；看得见的圆角块是里面那一层
      className={`group grid place-items-center pl-0.5 ${corner ? "pr-2" : "pr-0"}`}
    >
      <span
        className={`grid h-7 w-9 place-items-center rounded-md text-muted transition-colors
                    duration-[120ms] ${
                      danger
                        ? "group-hover:bg-danger group-hover:text-white"
                        : "group-hover:bg-raised group-hover:text-ink"
                    }`}
      >
        <svg
          viewBox="0 0 16 16"
          className="h-4 w-4"
          fill="currentColor"
          stroke="currentColor"
          aria-hidden="true"
        >
          {children}
        </svg>
      </span>
    </button>
  );
}
