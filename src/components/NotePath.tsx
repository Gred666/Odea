import { useApp } from "@/app/store";
import { nameOf, rootLabel } from "@/data/folders";
import { Folder } from "lucide-react";
import { Fragment } from "react";

/**
 * 笔记标题上方那一行：这篇放在哪个文件夹 —— `工作 / 周报`，放在最上层的是树根（「笔记」）。
 *
 * 列表栏退回上层以后，藏在深处的那篇在列表里就看不见了，正文这边得自己说清楚是哪一篇、
 * 在哪。和日历某天的日期占同一个位置（标题上方的小字），笔记和日历的标题落在同一高度；
 * 最上层的笔记也显示一段，换篇时标题不会因为这一篇在不在文件夹里而上下跳。
 *
 * 每一段都能点：列表栏换到那个文件夹，这一篇在那一层的话滚出来。悬停看文件的相对路径。
 * 窗口最上面那条里也有一份（DocumentView 的 TitleStrip）：给鼠标用的，tabIndex -1 不进 Tab 顺序
 */
export function NotePath({
  folder,
  relPath,
  tabIndex,
}: { folder: string; relPath?: string; tabIndex?: number }) {
  const openNoteFolder = useApp((s) => s.openNoteFolder);
  const parts = folder ? folder.split("/") : [];
  const paths = folder ? parts.map((_, i) => parts.slice(0, i + 1).join("/")) : [""];
  return (
    <nav
      aria-label="所在文件夹"
      title={relPath}
      className="flex min-w-0 items-center text-[12px] font-medium leading-[20px] tracking-[0.02em] text-muted"
    >
      <Folder size={12} strokeWidth={2} className="mr-px shrink-0 text-faint" />
      {paths.map((path, i) => (
        <Fragment key={path || "/"}>
          {i > 0 && (
            <span aria-hidden="true" className="shrink-0 text-faint/70">
              /
            </span>
          )}
          <button
            type="button"
            tabIndex={tabIndex}
            onClick={() => openNoteFolder(path)}
            className="h-5 min-w-0 max-w-[220px] truncate rounded-md px-[5px] transition-colors duration-[140ms]
                       hover:bg-raised/60 hover:text-ink"
          >
            {path ? nameOf(path) : rootLabel()}
          </button>
        </Fragment>
      ))}
    </nav>
  );
}
