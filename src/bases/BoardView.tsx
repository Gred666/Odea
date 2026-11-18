import { openDocument } from "@/app/navigate";
import { messageOf } from "@/data/store";
import { cn } from "@/lib/cn";
import { usePaneWindow } from "@/lib/paneWindow";
import { isListKind } from "@/properties/yaml";
import { Plus } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { ValueView } from "./ValueView";
import { type CellContext, NameCell, editing } from "./cells";
import type { BaseConfig, ViewConfig } from "./config";
import { type Group, type Row, type ViewResult, propLabel, propRef } from "./query";
import { writeProperty } from "./write";

/* ============================================================
   看板（docs/视图文件.md §3.6）：按 groupBy 分列，列的顺序照 groupOrder（只显示写了的那几列，
   同 Obsidian），没写的按值排、「没有」放最后。

   拖卡片：按住移 4px 才算拖（点一下还是打开）；跟手的是这张卡片的一张图（只动 transform），
   原处留一个空位；放到别的列，改那一篇的分组属性（bases/write.ts，只动那一行）。
   按文件的属性、公式分的拖不了（Obsidian 也是：值不是写在笔记里的）
   ============================================================ */

/** 一列先画多少张：再多的点「再显示」，几千篇的看板也不一次画完 */
const PAGE = 120;
const DRAG_SLOP = 4;

interface Drag {
  row: Row;
  from: string | null;
  /** 按下时指针在卡片里的位置 */
  dx: number;
  dy: number;
  width: number;
  x: number;
  y: number;
  /** 指针下面是哪一列（列的 key，`\u0000` 是「没有」） */
  over: string | undefined;
}

const NONE = "\u0000";
const colId = (key: string | null) => (key === null ? NONE : key);

export function BoardView({
  result,
  config,
  view,
  fields,
  context,
  onNew,
}: {
  result: ViewResult;
  config: BaseConfig;
  view: ViewConfig;
  /** 卡片上的几项：第一项是卡片标题 */
  fields: string[];
  context: CellContext;
  /** 列底下「新建」：带着这一列的值新建一篇 */
  onNew: (value: string | null) => void;
}) {
  const by = view.groupBy;
  const groups = result.groups ?? [];
  const ref = by ? propRef(by.property) : null;
  const movable = ref?.ns === "note";
  const { doc, win } = usePaneWindow();
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pages, setPages] = useState<Record<string, number>>({});
  const board = useRef<HTMLDivElement>(null);

  // 拖的时候整页是「抓着」的手形、不选字（同树上拖笔记，globals.css 的 body.odea-dragging）
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    doc.body.classList.add("odea-dragging");
    return () => doc.body.classList.remove("odea-dragging");
  }, [dragging, doc]);

  const drop = (row: Row, from: string | null, to: string | undefined) => {
    if (!by || !ref || to === undefined || to === colId(from)) return;
    const value = to === NONE ? null : to;
    const edit = editing(row, by.property, context);
    if (!edit) return;
    const list = isListKind(edit.kind);
    writeProperty(
      row.doc.target,
      ref.name,
      edit.kind,
      list ? (value === null ? [] : [value]) : (value ?? ""),
    ).catch((error) => context.onError(messageOf(error)));
  };

  const startPress = (event: ReactPointerEvent<HTMLElement>, row: Row, group: Group) => {
    if (event.button !== 0 || (event.target as Element).closest("button, a, input")) return;
    if (!movable || row.doc.notUtf8) return;
    const card = event.currentTarget;
    const rect = card.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    let current: Drag | null = null;
    const columnAt = (x: number, y: number) => {
      const element = doc.elementFromPoint(x, y)?.closest<HTMLElement>("[data-column]");
      return element?.dataset.column;
    };
    const move = (moveEvent: PointerEvent) => {
      if (!current) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_SLOP) return;
        card.setPointerCapture(moveEvent.pointerId);
      }
      current = {
        row,
        from: group.key,
        dx: startX - rect.left,
        dy: startY - rect.top,
        width: rect.width,
        x: moveEvent.clientX,
        y: moveEvent.clientY,
        over: columnAt(moveEvent.clientX, moveEvent.clientY),
      };
      setDrag(current);
    };
    const up = () => {
      card.removeEventListener("pointermove", move);
      card.removeEventListener("pointerup", up);
      card.removeEventListener("pointercancel", cancel);
      if (current) {
        drop(row, group.key, current.over);
        // 拖过的这一下不算点
        const swallow = (clickEvent: MouseEvent) => clickEvent.stopPropagation();
        card.addEventListener("click", swallow, { capture: true, once: true });
        win.setTimeout(() => card.removeEventListener("click", swallow, { capture: true }), 0);
      }
      setDrag(null);
    };
    const cancel = () => {
      current = null;
      up();
    };
    card.addEventListener("pointermove", move);
    card.addEventListener("pointerup", up);
    card.addEventListener("pointercancel", cancel);
  };

  if (!by) return null;

  return (
    <div ref={board} className="flex min-h-full items-start gap-3 pb-6">
      {groups.map((group) => {
        const id = colId(group.key);
        const shown = (pages[id] ?? 1) * PAGE;
        const target = drag && drag.over === id && colId(drag.from) !== id;
        return (
          <section
            key={id}
            data-column={id}
            aria-label={group.key === null ? `没有${propLabel(config, by.property)}` : group.key}
            className={cn(
              "flex w-[272px] shrink-0 flex-col rounded-xl bg-panel p-1.5 ring-1 transition-[box-shadow,background-color] duration-[140ms]",
              target ? "bg-accent-wash ring-accent-line" : "ring-line",
            )}
          >
            <header className="flex h-8 items-center gap-1.5 px-1.5">
              {group.key === null ? (
                <span className="text-[13px] font-medium text-muted">
                  没有{propLabel(config, by.property)}
                </span>
              ) : (
                <span className="min-w-0 truncate text-[13px] font-medium text-ink">
                  <ValueView value={group.value ?? group.key} />
                </span>
              )}
              <span className="text-[12px] tabular-nums text-faint">{group.rows.length}</span>
            </header>
            <ol className="flex flex-col gap-1.5">
              {group.rows.slice(0, shown).map((row) => {
                const dragging = drag?.row.key === row.key;
                return (
                  <li key={row.key}>
                    {/* 键盘打开在卡片标题上（名称那个按钮）；拖只有鼠标、指针 */}
                    <div
                      onPointerDown={(event) => startPress(event, row, group)}
                      title={
                        movable
                          ? undefined
                          : "按文件的属性、公式分的列，卡片拖不了：值不是写在笔记里的"
                      }
                      className={cn(
                        "rounded-lg bg-canvas px-2.5 py-2 shadow-card ring-1 ring-line transition-opacity duration-[120ms]",
                        movable && "cursor-grab",
                        dragging && "opacity-35",
                      )}
                    >
                      <Card row={row} fields={fields} config={config} result={result} />
                    </div>
                  </li>
                );
              })}
            </ol>
            {group.rows.length > shown && (
              <button
                type="button"
                onClick={() =>
                  setPages((current) => ({ ...current, [id]: (current[id] ?? 1) + 1 }))
                }
                className="mt-1.5 h-8 rounded-md text-[12px] text-muted hover:bg-raised hover:text-ink"
              >
                再显示 {Math.min(PAGE, group.rows.length - shown)} 篇（还有{" "}
                {group.rows.length - shown} 篇）
              </button>
            )}
            {movable && (
              <button
                type="button"
                onClick={() => onNew(group.key)}
                className="mt-1 flex h-8 items-center gap-1.5 rounded-md px-1.5 text-[13px] text-faint
                           transition-colors duration-[140ms] hover:bg-raised hover:text-ink"
              >
                <Plus size={14} strokeWidth={2} />
                新建
              </button>
            )}
          </section>
        );
      })}
      {drag && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed left-0 top-0 z-[60] rounded-lg bg-canvas px-2.5 py-2 shadow-float ring-1 ring-accent-line"
          style={{
            width: drag.width,
            transform: `translate(${drag.x - drag.dx}px, ${drag.y - drag.dy}px)`,
          }}
        >
          <Card row={drag.row} fields={fields} config={config} result={result} />
        </div>
      )}
    </div>
  );
}

/** 卡片里：第一项是标题（名称的话点了打开），下面几项小字 */
export function Card({
  row,
  fields,
  config,
  result,
}: {
  row: Row;
  fields: string[];
  config: BaseConfig;
  result: ViewResult;
}) {
  const [first, ...rest] = fields;
  const title = first ?? "file.name";
  const titleRef = propRef(title);
  const titleCell = result.cell(row, title);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 text-[14px] leading-[20px]">
        {titleRef.ns === "file" && (titleRef.name === "name" || titleRef.name === "basename") ? (
          <NameCell row={row} />
        ) : (
          <button
            type="button"
            onClick={(event) =>
              openDocument(row.doc.target, undefined, event.ctrlKey || event.metaKey)
            }
            className="min-w-0 truncate text-left font-medium text-ink hover:underline"
          >
            {titleCell.value === null || titleCell.value === "" ? (
              row.source.title
            ) : (
              <ValueView value={titleCell.value} error={titleCell.error} />
            )}
          </button>
        )}
      </div>
      {rest.map((raw) => {
        const cell = result.cell(row, raw);
        if (cell.value === null && !cell.error) return null;
        return (
          <div
            key={raw}
            className="flex min-w-0 items-center gap-2 text-[12px] leading-[20px] text-muted"
          >
            <span className="w-16 shrink-0 truncate text-faint">{propLabel(config, raw)}</span>
            <ValueView value={cell.value} error={cell.error} className="min-w-0 text-body" />
          </div>
        );
      })}
    </div>
  );
}
