import { cn } from "@/lib/cn";
import { usePaneWindow } from "@/lib/paneWindow";
import { tip } from "@/lib/tooltip";
import { ArrowDown, ArrowUp, ChevronRight } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ValueView } from "./ValueView";
import { CellBody, type CellContext, editing } from "./cells";
import type { BaseConfig, SortSpec, ViewConfig } from "./config";
import { type Group, type Row, type ViewResult, propLabel, propRef } from "./query";

/* ============================================================
   表格（docs/视图文件.md §3.6）：表头贴在顶上，第一列（名称）横着滚时贴在左边；行高固定，
   只画看得见的那些行（几千行也只有几十行 DOM）。分组时每组一个组头，点了收起。

   键盘：焦点在格子上时方向键走、Enter 进编辑（名称那一列是打开）、Esc 退出编辑回到格子；
   Tab 离开表格（一张表一个 Tab 停靠点，roving tabindex）
   ============================================================ */

const ROW = 36;
/** 多画上下几行：滚得快时边上不露白 */
const OVERSCAN = 8;
/** 表头贴在拖动区（窗口最上面那 38px）下面 */
export const STICKY_TOP = 38;

const DEFAULT_WIDTH = 168;
const NAME_WIDTH = 260;

type Item = { kind: "group"; group: Group; count: number } | { kind: "row"; row: Row };

export function TableView({
  result,
  columns,
  config,
  view,
  context,
  scrollRef,
  onSort,
}: {
  result: ViewResult;
  columns: string[];
  config: BaseConfig;
  view: ViewConfig;
  context: CellContext;
  scrollRef: RefObject<HTMLDivElement | null>;
  onSort: (sort: SortSpec[]) => void;
}) {
  const { win } = usePaneWindow();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const items = useMemo<Item[]>(() => {
    if (!result.groups) return result.rows.map((row) => ({ kind: "row", row }));
    const out: Item[] = [];
    for (const group of result.groups) {
      out.push({ kind: "group", group, count: group.rows.length });
      if (!collapsed.has(groupId(group)))
        for (const row of group.rows) out.push({ kind: "row", row });
    }
    return out;
  }, [result, collapsed]);

  const widths = columns.map(
    (raw) =>
      view.columnSize[raw] ??
      (propRef(raw).ns === "file" && propRef(raw).name === "name" ? NAME_WIDTH : DEFAULT_WIDTH),
  );
  const template = `${widths.map((width) => `${width}px`).join(" ")} minmax(0, 1fr)`;
  const total = widths.reduce((sum, width) => sum + width, 0);

  /* ---------- 只画看得见的 ---------- */
  const body = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: 40 });
  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    const host = body.current;
    if (!scroller || !host) return;
    const top =
      host.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const from = Math.floor((scroller.scrollTop - top) / ROW) - OVERSCAN;
    const to = Math.ceil((scroller.scrollTop - top + scroller.clientHeight) / ROW) + OVERSCAN;
    const start = Math.max(0, from);
    const end = Math.max(start, to);
    setRange((current) =>
      current.start === start && current.end === end ? current : { start, end },
    );
  }, [scrollRef]);
  useLayoutEffect(() => {
    measure();
    const scroller = scrollRef.current;
    if (!scroller) return;
    let frame = 0;
    const onScroll = () => {
      if (!frame)
        frame = win.requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(onScroll);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (frame) win.cancelAnimationFrame(frame);
    };
  }, [measure, scrollRef, win]);
  // 行数变了（筛选、收起一组）：可见范围重算
  // biome-ignore lint/correctness/useExhaustiveDependencies: items 变了要重量
  useLayoutEffect(measure, [items.length, measure]);
  const start = Math.min(range.start, items.length);
  const end = Math.min(range.end, items.length);

  /* ---------- 键盘 ---------- */
  const [active, setActive] = useState({ row: 0, col: 0 });
  const [editingAt, setEditingAt] = useState<{ key: string; col: number } | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const focusCell = useCallback(
    (row: number, col: number) => {
      const scroller = scrollRef.current;
      const host = body.current;
      if (scroller && host) {
        const top =
          host.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop;
        const y = top + row * ROW;
        const visibleTop = scroller.scrollTop + STICKY_TOP + ROW;
        if (y < visibleTop) scroller.scrollTop = y - STICKY_TOP - ROW;
        else if (y + ROW > scroller.scrollTop + scroller.clientHeight)
          scroller.scrollTop = y + ROW - scroller.clientHeight;
      }
      // 画出来以后再聚焦
      win.requestAnimationFrame(() => {
        grid.current
          ?.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`)
          ?.focus({ preventScroll: true });
      });
    },
    [scrollRef, win],
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (editingAt || event.nativeEvent.isComposing) return;
    const move = (row: number, col: number) => {
      event.preventDefault();
      const r = Math.max(0, Math.min(items.length - 1, row));
      const c = Math.max(0, Math.min(columns.length - 1, col));
      setActive({ row: r, col: c });
      focusCell(r, c);
    };
    switch (event.key) {
      case "ArrowDown":
        return move(active.row + 1, active.col);
      case "ArrowUp":
        return move(active.row - 1, active.col);
      case "ArrowRight":
        return move(active.row, active.col + 1);
      case "ArrowLeft":
        return move(active.row, active.col - 1);
      case "Home":
        return move(event.ctrlKey ? 0 : active.row, 0);
      case "End":
        return move(event.ctrlKey ? items.length - 1 : active.row, columns.length - 1);
      case "PageDown":
        return move(active.row + 10, active.col);
      case "PageUp":
        return move(active.row - 10, active.col);
      case "Enter":
      case "F2": {
        const item = items[active.row];
        if (!item) return;
        event.preventDefault();
        if (item.kind === "group") return toggleGroup(item.group);
        const raw = columns[active.col];
        if (!raw) return;
        const edit = editing(item.row, raw, context);
        if (edit && edit.kind !== "checkbox") {
          setEditingAt({ key: item.row.key, col: active.col });
          return;
        }
        // 名称、勾选、双链：按 Enter 就是点它
        grid.current
          ?.querySelector<HTMLElement>(`[data-cell="${active.row}:${active.col}"] button`)
          ?.click();
        return;
      }
    }
  };

  const toggleGroup = (group: Group) =>
    setCollapsed((current) => {
      const next = new Set(current);
      const id = groupId(group);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const latest = useRef({ focusCell, toggleGroup });
  latest.current = { focusCell, toggleGroup };
  const actions = useMemo<RowActions>(
    () => ({
      focus: (row, col) =>
        setActive((current) =>
          current.row === row && current.col === col ? current : { row, col },
        ),
      edit: (key, row, col) => {
        setActive({ row, col });
        setEditingAt({ key, col });
      },
      done: (row, col, refocus) => {
        setEditingAt(null);
        if (refocus) latest.current.focusCell(row, col);
      },
      toggle: (group) => latest.current.toggleGroup(group),
    }),
    [],
  );

  /* ---------- 表头：点一下按这一列排（升 → 降 → 不排） ---------- */
  const primary = view.sort[0];
  const sortBy = (raw: string) => {
    if (primary?.property === raw) {
      if (primary.direction === "ASC")
        onSort([{ property: raw, direction: "DESC" }, ...view.sort.slice(1)]);
      else onSort(view.sort.slice(1));
    } else {
      onSort([
        { property: raw, direction: "ASC" },
        ...view.sort.filter((spec) => spec.property !== raw),
      ]);
    }
  };

  return (
    <div
      ref={grid}
      role="grid"
      aria-rowcount={items.length + 1}
      aria-colcount={columns.length}
      className="relative min-w-full text-[14px] text-body"
      style={{ width: total + 48 }}
      onKeyDown={onKeyDown}
    >
      {/* 表头 */}
      <div
        role="row"
        tabIndex={-1}
        className="sticky z-20 grid h-9 border-b border-line-strong bg-canvas"
        style={{ top: STICKY_TOP, gridTemplateColumns: template }}
      >
        {columns.map((raw, index) => {
          const sorted = view.sort.find((spec) => spec.property === raw);
          const isPrimary = primary?.property === raw;
          return (
            <div
              key={raw}
              role="columnheader"
              aria-sort={
                isPrimary ? (primary.direction === "ASC" ? "ascending" : "descending") : undefined
              }
              className={cn(
                "group/head flex min-w-0 items-center border-line",
                index === 0 && "sticky left-0 z-10 bg-canvas",
                index > 0 && "border-l",
              )}
            >
              <button
                type="button"
                onClick={() => sortBy(raw)}
                {...tip(`按「${propLabel(config, raw)}」排序`, { name: false })}
                className="flex h-full min-w-0 flex-1 items-center gap-1 px-2.5 text-left text-[12px] font-medium text-muted
                           transition-colors duration-[140ms] hover:bg-panel hover:text-ink"
              >
                <span className="truncate">{propLabel(config, raw)}</span>
                {sorted &&
                  (sorted.direction === "ASC" ? (
                    <ArrowUp
                      size={12}
                      strokeWidth={2}
                      className={isPrimary ? "text-ink" : "text-faint"}
                    />
                  ) : (
                    <ArrowDown
                      size={12}
                      strokeWidth={2}
                      className={isPrimary ? "text-ink" : "text-faint"}
                    />
                  ))}
              </button>
            </div>
          );
        })}
        <div />
      </div>

      {/* 行 */}
      <div ref={body} className="relative" style={{ height: items.length * ROW }}>
        {items.slice(start, end).map((item, offset) => {
          const index = start + offset;
          if (item.kind === "group") {
            return (
              <GroupRow
                key={`g:${groupId(item.group)}`}
                group={item.group}
                count={item.count}
                index={index}
                open={!collapsed.has(groupId(item.group))}
                active={active.row === index}
                label={propLabel(config, view.groupBy?.property ?? "")}
                actions={actions}
              />
            );
          }
          return (
            <TableRow
              key={item.row.key}
              row={item.row}
              index={index}
              columns={columns}
              template={template}
              activeCol={active.row === index ? active.col : -1}
              editingCol={editingAt?.key === item.row.key ? editingAt.col : -1}
              cell={result.cell}
              context={context}
              actions={actions}
            />
          );
        })}
      </div>
    </div>
  );
}

/** 行要调的：身份不变（refs 转发），memo 的行滚动时不跟着重画 */
interface RowActions {
  focus: (row: number, col: number) => void;
  edit: (key: string, row: number, col: number) => void;
  done: (row: number, col: number, refocus: boolean) => void;
  toggle: (group: Group) => void;
}

const TableRow = memo(function TableRow({
  row,
  index,
  columns,
  template,
  activeCol,
  editingCol,
  cell,
  context,
  actions,
}: {
  row: Row;
  index: number;
  columns: string[];
  template: string;
  /** 键盘停在这一行的哪一格（不在这一行是 -1） */
  activeCol: number;
  editingCol: number;
  cell: ViewResult["cell"];
  context: CellContext;
  actions: RowActions;
}) {
  return (
    <div
      role="row"
      tabIndex={-1}
      className="group/row absolute inset-x-0 grid border-b border-line hover:bg-panel/70"
      style={{ top: index * ROW, height: ROW, gridTemplateColumns: template }}
    >
      {columns.map((raw, col) => {
        const editingNow = editingCol === col;
        return (
          <div
            key={raw}
            role="gridcell"
            data-cell={`${index}:${col}`}
            tabIndex={activeCol === col ? 0 : -1}
            onFocus={(event) => {
              if (event.target === event.currentTarget) actions.focus(index, col);
            }}
            className={cn(
              "flex min-w-0 items-center px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40",
              col === 0 && "sticky left-0 z-10 bg-canvas group-hover/row:bg-panel",
              col > 0 && "border-l border-line",
              editingNow && "overflow-visible bg-canvas ring-2 ring-inset ring-accent",
            )}
          >
            <CellBody
              row={row}
              raw={raw}
              cell={cell(row, raw)}
              context={context}
              editingNow={editingNow}
              onEdit={() => actions.edit(row.key, index, col)}
              onDone={(refocus) => actions.done(index, col, refocus)}
            />
          </div>
        );
      })}
      <div />
    </div>
  );
});

const GroupRow = memo(function GroupRow({
  group,
  count,
  index,
  open,
  active,
  label,
  actions,
}: {
  group: Group;
  count: number;
  index: number;
  open: boolean;
  active: boolean;
  /** 分组的属性叫什么（「没有状态」） */
  label: string;
  actions: RowActions;
}) {
  return (
    <div
      role="row"
      tabIndex={-1}
      aria-expanded={open}
      className="absolute inset-x-0 flex items-end border-b border-line"
      style={{ top: index * ROW, height: ROW }}
    >
      {/* 键盘收起、展开归整张表（Enter，见 onKeyDown） */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: 同上 */}
      <div
        role="gridcell"
        data-cell={`${index}:0`}
        tabIndex={active ? 0 : -1}
        onFocus={() => actions.focus(index, 0)}
        onClick={() => actions.toggle(group)}
        className="sticky left-0 flex h-[30px] cursor-default items-center gap-1.5 rounded-md px-1.5 text-[13px] font-medium text-ink outline-none
                   hover:bg-panel focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <ChevronRight
          size={14}
          strokeWidth={2}
          className={cn("text-faint transition-transform duration-[160ms]", open && "rotate-90")}
        />
        {group.key === null ? (
          <span className="text-muted">没有{label}</span>
        ) : (
          <ValueView value={group.value ?? group.key} />
        )}
        <span className="ml-1 text-[12px] font-normal tabular-nums text-faint">{count}</span>
      </div>
    </div>
  );
});

const groupId = (group: Group) => (group.key === null ? "\u0000" : group.key);
