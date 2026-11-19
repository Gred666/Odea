import { useApp } from "@/app/store";
import { useData } from "@/data/store";
import { cn } from "@/lib/cn";
import { tween } from "@/lib/motion";
import { AlertTriangle, Info, LoaderCircle, RefreshCw, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

/** 停留多久。指针停在上面时暂停计时。 */
const ERROR_WINDOW_MS = 8000;

/**
 * 保存以外的操作失败时的提示：启动加载、某天 / 某周期的文档、置顶、归档、恢复、
 * 删除、勾选任务、新建笔记。
 *
 * 这些失败以前只写进 store 的 `error`，界面上没人读 —— 置顶失败就是图钉悄悄弹回去，
 * 某天的文档取不回来就一直停在「载入中…」，用户完全不知道发生了什么。
 * 保存失败不走这里，显示在那篇文档自己的状态栏里（saveError）。
 */
export function ErrorToast() {
  const error = useData((s) => s.error);
  const initialized = useData((s) => s.initialized);
  const clearError = useData((s) => s.clearError);
  const [hovered, setHovered] = useState(false);

  // 启动都没成功时不自动消失：界面是空的，得让人看见原因、能重试
  const sticky = !initialized;
  useEffect(() => {
    if (!error || hovered || sticky) return;
    const timer = setTimeout(clearError, ERROR_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [error, hovered, sticky, clearError]);

  const retry = () => {
    clearError();
    void useData.getState().initialize();
  };

  return (
    <AnimatePresence>
      {error && (
        <motion.div
          key={error}
          role="alert"
          // 不缩放：提示条里是字，缩放会让字在动画里发虚、停下那一帧再跳清楚。
          // tween 不用 spring：spring 收尾时差不到半个像素就直接跳到终点
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8, transition: tween.fast }}
          transition={tween.slow}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          className="pointer-events-auto flex max-w-[520px] items-center gap-3 rounded-xl
                     bg-ink py-2 pl-3.5 pr-2 text-[13px] text-canvas shadow-float"
        >
          <AlertTriangle size={14} strokeWidth={2} className="shrink-0 text-danger" />
          <span className="min-w-0 truncate" title={error}>
            {initialized ? "操作失败" : "加载失败"}：{error}
          </span>
          {!initialized && (
            <button
              type="button"
              onClick={retry}
              className="shrink-0 rounded-md px-2 py-1 font-semibold text-canvas
                         transition-colors duration-[140ms] hover:bg-canvas/15"
            >
              重试
            </button>
          )}
          <button
            type="button"
            aria-label="关闭提示"
            onClick={clearError}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-canvas/70
                       transition-colors duration-[140ms] hover:bg-canvas/15 hover:text-canvas"
          >
            <X size={12} strokeWidth={2.2} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * 导入一个文件夹的进度（docs/仓库与启动器.md §21）：选好文件夹以后一直在，导完换成「导入了……」的提示。
 * 先拷文件、再读进索引，进度条每一段从头走一遍（换段时不倒着退回去）。「取消」把拷进来的都收回去。
 * 宽度固定、数字等宽：数字一直在跳，宽度跟着变的话整条在底下左右晃
 */
export function ImportToast() {
  const importing = useData((s) => s.importing);
  const cancelImport = useData((s) => s.cancelImport);
  const reduce = useApp((s) => s.reduceMotion);
  const [cancelling, setCancelling] = useState(false);

  // 下一次导入从「没在取消」开始
  useEffect(() => {
    if (!importing) setCancelling(false);
  }, [importing]);

  const step = importing
    ? importing.phase === "copy"
      ? `复制 ${importing.done} / ${importing.total} 个文件`
      : `读取笔记 ${importing.done} / ${importing.total}`
    : "";
  const ratio =
    importing && importing.total > 0 ? Math.min(1, importing.done / importing.total) : 0;

  return (
    <AnimatePresence>
      {importing && (
        <motion.div
          key="import"
          role="status"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8, transition: tween.fast }}
          transition={tween.slow}
          className="pointer-events-auto flex w-[440px] max-w-full flex-col gap-2 rounded-xl bg-ink py-2
                     pl-3.5 pr-2 text-[13px] text-canvas shadow-float"
        >
          <div className="flex items-center gap-3">
            {/* 转的是图标（SVG），不是字 */}
            <LoaderCircle
              size={14}
              strokeWidth={2}
              className={cn(
                "shrink-0 text-accent",
                !reduce && "animate-spin [animation-duration:1.6s]",
              )}
            />
            <span className="min-w-0 flex-1 truncate" title={importing.name}>
              正在导入「{importing.name}」
            </span>
            <span className="shrink-0 tabular-nums text-canvas/70">
              {cancelling ? "正在取消…" : step}
            </span>
            <button
              type="button"
              disabled={cancelling}
              onClick={() => {
                setCancelling(true);
                void cancelImport();
              }}
              className="shrink-0 rounded-md px-2 py-1 font-semibold text-canvas
                         transition-colors duration-[140ms] hover:bg-canvas/15 disabled:opacity-60"
            >
              取消
            </button>
          </div>
          {/* 读屏器读上面那行字（role=status），这条只给眼睛看 */}
          <div aria-hidden className="mr-1.5 h-[3px] overflow-hidden rounded-full bg-canvas/15">
            {/* 换段时整条换一个（key），新的一段从 0 开始，不会倒着动画回去；只动 transform */}
            <div
              key={importing.phase}
              className={cn(
                "h-full origin-left rounded-full bg-accent",
                !reduce && "transition-transform duration-200 ease-out",
              )}
              style={{ transform: `scaleX(${ratio})` }}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** 提示停留多久（比失败长一点：通常要看清另存成了什么名字） */
const NOTICE_WINDOW_MS = 10000;

/**
 * 不是失败、但得让人知道的事。现在只有一种：别的程序改了正在编辑的文档，
 * 和编辑器里没存的修改撞上了 —— 编辑器里的照常保存，外部那一版另存成冲突副本。
 */
export function NoticeToast() {
  const notice = useData((s) => s.notice);
  const clearNotice = useData((s) => s.clearNotice);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (!notice || hovered) return;
    const timer = setTimeout(clearNotice, NOTICE_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [notice, hovered, clearNotice]);

  return (
    <AnimatePresence>
      {notice && (
        <motion.div
          key={notice}
          role="status"
          // 不缩放：提示条里是字，缩放会让字在动画里发虚、停下那一帧再跳清楚。
          // tween 不用 spring：spring 收尾时差不到半个像素就直接跳到终点
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8, transition: tween.fast }}
          transition={tween.slow}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          className="pointer-events-auto flex max-w-[560px] items-center gap-3 rounded-xl
                     bg-ink py-2 pl-3.5 pr-2 text-[13px] text-canvas shadow-float"
        >
          <Info size={14} strokeWidth={2} className="shrink-0 text-accent" />
          <span className="min-w-0 truncate" title={notice}>
            {notice}
          </span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={clearNotice}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-canvas/70
                       transition-colors duration-[140ms] hover:bg-canvas/15 hover:text-canvas"
          >
            <X size={12} strokeWidth={2.2} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * 别的设备开关了日程、转成了逻辑目录，同步过来了（VaultChange.layout）。要按新的摆法重新认文件、
 * 整页重载，用户可能正在打字：不自己换，常驻一条提示，点「切换过去」才换（重载前先存掉编辑器里的）
 */
export function LayoutChangeToast() {
  const changed = useData((s) => s.layoutChanged);
  const dismiss = useData((s) => s.dismissLayoutChange);
  const apply = useData((s) => s.applyLayoutChange);
  const [busy, setBusy] = useState(false);

  return (
    <AnimatePresence>
      {changed && (
        <motion.div
          role="status"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8, transition: tween.fast }}
          transition={tween.slow}
          className="pointer-events-auto flex max-w-[560px] items-center gap-3 rounded-xl
                     bg-ink py-2 pl-3.5 pr-2 text-[13px] text-canvas shadow-float"
        >
          <RefreshCw size={14} strokeWidth={2} className="shrink-0 text-accent" />
          <span className="min-w-0 truncate">
            这个仓库的设置在别的设备上改了（开了哪些插件、目录的样子）
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void apply().finally(() => setBusy(false));
            }}
            className="shrink-0 rounded-md px-2 py-1 font-semibold text-canvas
                       transition-colors duration-[140ms] hover:bg-canvas/15 disabled:opacity-60"
          >
            切换过去
          </button>
          <button
            type="button"
            aria-label="先不切换"
            title="先不切换（下次打开这个仓库时会换过去）"
            onClick={dismiss}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-canvas/70
                       transition-colors duration-[140ms] hover:bg-canvas/15 hover:text-canvas"
          >
            <X size={12} strokeWidth={2.2} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
