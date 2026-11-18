import { cn } from "@/lib/cn";
import {
  ArrowDownUp,
  ChevronDown,
  ChevronUp,
  Code,
  Columns3,
  Filter,
  Group as GroupIcon,
  Plus,
  X,
} from "lucide-react";
import { type ReactNode, forwardRef, useEffect, useState } from "react";
import { Popover } from "./Popover";
import {
  type BaseConfig,
  type BaseEdit,
  type Direction,
  type FilterNode,
  type SortSpec,
  type ViewConfig,
  setFilters,
  setSort,
  setViewKey,
} from "./config";
import { ExprError, parseExpr } from "./expr";
import {
  OP_LABELS,
  type Simple,
  type SimpleOp,
  buildExpr,
  needsValue,
  opsFor,
  toSimple,
} from "./filterRows";
import { type Group, propLabel, propRef } from "./query";

/* ============================================================
   视图的工具条（docs/视图文件.md §3.6）：几篇、筛选、排序、分组、属性、源码。
   每个点开是贴着按钮的小面板，改了马上写回 .base（file.ts 排着写）
   ============================================================ */

const TOOL =
  "flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors duration-[140ms] " +
  "hover:bg-raised hover:text-ink data-[state=open]:bg-raised data-[state=open]:text-ink";

const ToolButton = forwardRef<
  HTMLButtonElement,
  { icon: typeof Filter; label: string; active?: boolean; count?: number; children?: ReactNode }
>(function ToolButton({ icon: Icon, label, active, count, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      {...rest}
      className={cn(TOOL, active ? "text-ink" : "text-muted")}
    >
      <Icon size={14} strokeWidth={1.9} />
      <span className="hidden @min-[640px]:inline">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="rounded bg-accent-wash px-1 text-[11px] tabular-nums text-accent">
          {count}
        </span>
      )}
    </button>
  );
});

const SELECT =
  "h-7 min-w-0 rounded-md border border-line-strong bg-canvas px-1.5 text-[13px] text-body outline-none focus:border-accent";
const INPUT =
  "h-7 min-w-0 rounded-md border border-line-strong bg-canvas px-2 text-[13px] text-body outline-none placeholder:text-faint focus:border-accent";
const SMALL =
  "grid h-7 w-7 shrink-0 place-items-center rounded-md text-faint transition-colors duration-[140ms] hover:bg-raised hover:text-ink disabled:opacity-40";
const ADD =
  "flex h-7 items-center gap-1.5 self-start rounded-md px-1.5 text-[13px] text-muted transition-colors duration-[140ms] hover:bg-raised hover:text-ink";

export interface ToolbarProps {
  config: BaseConfig;
  view: ViewConfig;
  viewIndex: number;
  /** 属性的候选（列、筛选、排序、分组）：文件的几项、仓库里的键、公式 */
  candidates: string[];
  /** 一个属性多半是什么类型（筛选写值时数字不加引号、日期包 date()） */
  kindOf: (raw: string) => string | undefined;
  /** 现在的这几组（分组面板里排列的顺序、显示哪几组） */
  groups: Group[] | null;
  /** 显示着的列 / 卡片上的几项 */
  fields: string[];
  total: number;
  shown: number;
  text: string;
  edit: (edit: BaseEdit) => void;
  replace: (text: string) => void;
  kanban: boolean;
}

export function Toolbar(props: ToolbarProps) {
  const { config, view, viewIndex, total, shown, edit } = props;
  const filterCount = countLeaves(config.filters) + countLeaves(view.filters);
  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <span className="mr-1.5 shrink-0 text-[12px] tabular-nums text-faint">
        {shown < total ? `${shown} / ${total} 篇` : `${total} 篇`}
      </span>
      <Popover
        label="筛选"
        width={520}
        trigger={
          <ToolButton icon={Filter} label="筛选" active={filterCount > 0} count={filterCount} />
        }
      >
        <section className="flex flex-col gap-3 p-1">
          <FilterGroup
            title="所有视图"
            config={config}
            node={config.filters}
            candidates={props.candidates}
            kindOf={props.kindOf}
            onChange={(node) => edit(setFilters(null, node))}
          />
          <div className="h-px bg-line" />
          <FilterGroup
            title={`这个视图（${view.name}）`}
            config={config}
            node={view.filters}
            candidates={props.candidates}
            kindOf={props.kindOf}
            onChange={(node) => edit(setFilters(viewIndex, node))}
          />
        </section>
      </Popover>
      <Popover
        label="排序"
        trigger={
          <ToolButton
            icon={ArrowDownUp}
            label="排序"
            active={view.sort.length > 0}
            count={view.sort.length}
          />
        }
      >
        <SortPanel
          config={config}
          sort={view.sort}
          candidates={props.candidates}
          onChange={(sort) => edit(setSort(viewIndex, sort))}
        />
      </Popover>
      <Popover
        label={props.kanban ? "分列" : "分组"}
        trigger={
          <ToolButton
            icon={GroupIcon}
            label={props.kanban ? "分列" : "分组"}
            active={!!view.groupBy}
          />
        }
      >
        <GroupPanel {...props} />
      </Popover>
      <Popover
        label={props.kanban ? "卡片上显示" : "显示的列"}
        trigger={<ToolButton icon={Columns3} label="属性" />}
      >
        <FieldsPanel
          config={config}
          fields={props.fields}
          candidates={props.candidates}
          onChange={(order) => edit(setViewKey(viewIndex, "order", order))}
        />
      </Popover>
      <Popover label="源码" width={560} trigger={<ToolButton icon={Code} label="源码" />}>
        {(close) => (
          <SourcePanel
            text={props.text}
            onSave={(text) => {
              props.replace(text);
              close();
            }}
            onCancel={close}
          />
        )}
      </Popover>
    </div>
  );
}

function countLeaves(node: FilterNode | null): number {
  if (!node) return 0;
  if ("expr" in node) return 1;
  return node.items.reduce((sum, item) => sum + countLeaves(item), 0);
}

/* ---------------- 属性选择 ---------------- */

function PropSelect({
  config,
  value,
  candidates,
  onChange,
  label,
  empty,
}: {
  config: BaseConfig;
  value: string;
  candidates: string[];
  onChange: (raw: string) => void;
  label: string;
  /** 「不分组」这样的空选项 */
  empty?: string;
}) {
  // 文件里写的不在候选里（拼错的、别的工具加的）也列出来，不然下拉框里看不到现在的值
  const list = value && !candidates.includes(value) ? [value, ...candidates] : candidates;
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(SELECT, "w-[150px]")}
    >
      {empty !== undefined && <option value="">{empty}</option>}
      {list.map((raw) => (
        <option key={raw} value={raw}>
          {propLabel(config, raw)}
          {propRef(raw).ns === "file"
            ? "（文件）"
            : propRef(raw).ns === "formula"
              ? "（公式）"
              : ""}
        </option>
      ))}
    </select>
  );
}

/* ---------------- 筛选 ---------------- */

const MODES: { op: "and" | "or" | "not"; label: string }[] = [
  { op: "and", label: "全部满足" },
  { op: "or", label: "任一满足" },
  { op: "not", label: "都不满足" },
];

function FilterGroup({
  title,
  config,
  node,
  candidates,
  kindOf,
  onChange,
}: {
  title: string;
  config: BaseConfig;
  node: FilterNode | null;
  candidates: string[];
  kindOf: (raw: string) => string | undefined;
  onChange: (node: FilterNode | null) => void;
}) {
  // 一行表达式也当成「全部满足」的一组：加条件时自然变成 and
  const group: { op: "and" | "or" | "not"; items: FilterNode[] } =
    node === null ? { op: "and", items: [] } : "expr" in node ? { op: "and", items: [node] } : node;
  const set = (items: FilterNode[], op = group.op) => onChange(items.length ? { op, items } : null);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-7 items-center gap-2">
        <span className="text-[12px] font-medium text-muted">{title}</span>
        {group.items.length > 1 && (
          <select
            aria-label={`${title}：条件之间`}
            value={group.op}
            onChange={(event) => set(group.items, event.target.value as "and" | "or" | "not")}
            className={SELECT}
          >
            {MODES.map((mode) => (
              <option key={mode.op} value={mode.op}>
                {mode.label}
              </option>
            ))}
          </select>
        )}
        {group.items.length === 1 && group.op === "not" && (
          <span className="text-[12px] text-muted">（不满足）</span>
        )}
      </div>
      {group.items.map((item, index) => (
        <FilterItem
          // biome-ignore lint/suspicious/noArrayIndexKey: 条件没有身份，位置就是身份
          key={index}
          item={item}
          config={config}
          candidates={candidates}
          kindOf={kindOf}
          onChange={(next) => set(group.items.map((other, i) => (i === index ? next : other)))}
          onRemove={() => set(group.items.filter((_, i) => i !== index))}
        />
      ))}
      <button
        type="button"
        className={ADD}
        onClick={() =>
          set([
            ...group.items,
            {
              expr: buildExpr({
                prop: candidates.find((raw) => propRef(raw).ns === "note") ?? "file.name",
                op: "!empty",
                value: "",
              }),
            },
          ])
        }
      >
        <Plus size={14} strokeWidth={2} />
        添加条件
      </button>
    </div>
  );
}

/** 一个条件：简单的样子拆成三格，别的一行表达式，嵌套的组只说一句 */
function FilterItem({
  item,
  config,
  candidates,
  kindOf,
  onChange,
  onRemove,
}: {
  item: FilterNode;
  config: BaseConfig;
  candidates: string[];
  kindOf: (raw: string) => string | undefined;
  onChange: (next: FilterNode) => void;
  onRemove: () => void;
}) {
  if (!("expr" in item)) return <NestedRow node={item} onRemove={onRemove} />;
  const simple = toSimple(item.expr);
  if (!simple) {
    return <ExprRow expr={item.expr} onChange={(expr) => onChange({ expr })} onRemove={onRemove} />;
  }
  return (
    <SimpleRow
      simple={simple}
      config={config}
      candidates={candidates}
      kindOf={kindOf}
      onChange={(expr) => onChange({ expr })}
      onRemove={onRemove}
    />
  );
}

function SimpleRow({
  simple,
  config,
  candidates,
  kindOf,
  onChange,
  onRemove,
}: {
  simple: Simple;
  config: BaseConfig;
  candidates: string[];
  kindOf: (raw: string) => string | undefined;
  onChange: (expr: string) => void;
  onRemove: () => void;
}) {
  const [value, setValue] = useState(simple.value);
  useEffect(() => setValue(simple.value), [simple.value]);
  const commit = (next: Simple) => onChange(buildExpr(next, kindOf(next.prop)));
  const ops = opsFor(simple.prop);
  return (
    <div className="flex items-center gap-1.5">
      <PropSelect
        config={config}
        label="属性"
        value={simple.prop}
        candidates={candidates}
        onChange={(prop) => {
          const allowed = opsFor(prop);
          commit({ prop, op: allowed.includes(simple.op) ? simple.op : allowed[0]!, value });
        }}
      />
      <select
        aria-label="怎么比"
        value={simple.op}
        onChange={(event) => commit({ ...simple, op: event.target.value as SimpleOp, value })}
        className={cn(SELECT, "w-[104px]")}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {OP_LABELS[op]}
          </option>
        ))}
      </select>
      {needsValue(simple.op) ? (
        <input
          aria-label="值"
          value={value}
          placeholder="值"
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => value !== simple.value && commit({ ...simple, value })}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing)
              commit({ ...simple, value });
          }}
          className={cn(INPUT, "flex-1")}
        />
      ) : (
        <span className="flex-1" />
      )}
      <button
        type="button"
        aria-label="删掉这个条件"
        title="删掉"
        onClick={onRemove}
        className={SMALL}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

/** 不是简单样子的条件：一行表达式，直接改字。写错了标红、说为什么 */
function ExprRow({
  expr,
  onChange,
  onRemove,
}: { expr: string; onChange: (expr: string) => void; onRemove: () => void }) {
  const [draft, setDraft] = useState(expr);
  useEffect(() => setDraft(expr), [expr]);
  let problem: string | null = null;
  try {
    parseExpr(draft);
  } catch (error) {
    problem = error instanceof ExprError ? error.message : String(error);
  }
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <input
          aria-label="条件（表达式）"
          aria-invalid={problem ? true : undefined}
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => draft.trim() && draft !== expr && onChange(draft.trim())}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && draft.trim())
              onChange(draft.trim());
          }}
          className={cn(INPUT, "flex-1 font-mono text-[12px]", problem && "border-danger")}
        />
        <button
          type="button"
          aria-label="删掉这个条件"
          title="删掉"
          onClick={onRemove}
          className={SMALL}
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      {problem && <p className="px-1 text-[12px] text-danger">{problem}</p>}
    </div>
  );
}

function NestedRow({ node, onRemove }: { node: FilterNode; onRemove: () => void }) {
  const count = countLeaves(node);
  const mode = "op" in node ? MODES.find((item) => item.op === node.op)?.label : "";
  return (
    <div className="flex items-center gap-1.5">
      <span className="flex h-7 flex-1 items-center rounded-md bg-panel px-2 text-[13px] text-muted">
        一组条件（{mode}，{count} 条）· 在源码里改
      </span>
      <button
        type="button"
        aria-label="删掉这组条件"
        title="删掉"
        onClick={onRemove}
        className={SMALL}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

/* ---------------- 排序 ---------------- */

function SortPanel({
  config,
  sort,
  candidates,
  onChange,
}: {
  config: BaseConfig;
  sort: SortSpec[];
  candidates: string[];
  onChange: (sort: SortSpec[]) => void;
}) {
  const set = (index: number, next: SortSpec) =>
    onChange(sort.map((spec, i) => (i === index ? next : spec)));
  return (
    <div className="flex flex-col gap-1.5 p-1">
      {sort.length === 0 && <p className="px-1 text-[13px] text-muted">没有排序：按名称排</p>}
      {sort.map((spec, index) => (
        <div key={`${spec.property}:${index}`} className="flex items-center gap-1.5">
          <PropSelect
            config={config}
            label="按哪个属性排"
            value={spec.property}
            candidates={candidates}
            onChange={(property) => set(index, { ...spec, property })}
          />
          <select
            aria-label="方向"
            value={spec.direction}
            onChange={(event) =>
              set(index, { ...spec, direction: event.target.value as Direction })
            }
            className={cn(SELECT, "flex-1")}
          >
            <option value="ASC">升序（小 → 大，早 → 晚）</option>
            <option value="DESC">降序（大 → 小，晚 → 早）</option>
          </select>
          <button
            type="button"
            aria-label="删掉这一条排序"
            title="删掉"
            onClick={() => onChange(sort.filter((_, i) => i !== index))}
            className={SMALL}
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className={ADD}
        onClick={() =>
          onChange([
            ...sort,
            {
              property:
                candidates.find((raw) => !sort.some((spec) => spec.property === raw)) ??
                "file.name",
              direction: "ASC",
            },
          ])
        }
      >
        <Plus size={14} strokeWidth={2} />
        添加排序
      </button>
    </div>
  );
}

/* ---------------- 分组 ---------------- */

function GroupPanel({ config, view, viewIndex, candidates, groups, edit, kanban }: ToolbarProps) {
  const by = view.groupBy;
  const keys = (groups ?? []).map((group) => group.key);
  const order = view.groupOrder;
  const setOrder = (next: (string | null)[] | undefined) =>
    edit(setViewKey(viewIndex, "groupOrder", next));
  return (
    <div className="flex flex-col gap-2 p-1">
      <div className="flex items-center gap-1.5">
        <PropSelect
          config={config}
          label={kanban ? "按哪个属性分列" : "按哪个属性分组"}
          value={by?.property ?? ""}
          candidates={candidates}
          empty={kanban ? "选一个属性" : "不分组"}
          onChange={(property) => {
            edit((doc) => {
              setViewKey(
                viewIndex,
                "groupBy",
                property ? { property, direction: by?.direction ?? "ASC" } : undefined,
              )(doc);
              // 换了分组的属性：原来的列顺序对不上了
              setViewKey(viewIndex, "groupOrder", undefined)(doc);
            });
          }}
        />
        {by && (
          <select
            aria-label="组的顺序"
            value={order ? "manual" : by.direction}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "manual") setOrder(keys);
              else
                edit((doc) => {
                  setViewKey(viewIndex, "groupBy", { property: by.property, direction: value })(
                    doc,
                  );
                  setViewKey(viewIndex, "groupOrder", undefined)(doc);
                });
            }}
            className={cn(SELECT, "flex-1")}
          >
            <option value="ASC">按值升序</option>
            <option value="DESC">按值降序</option>
            <option value="manual">手动排、选显示哪几组</option>
          </select>
        )}
      </div>
      {by && order && (
        <ul className="flex flex-col">
          {mergeKeys(order, keys).map((key) => {
            const at = order.indexOf(key);
            const shown = at >= 0;
            const label = key === null ? `没有${propLabel(config, by.property)}` : key;
            return (
              <li key={key ?? "\u0000"} className="flex h-8 items-center gap-1.5 px-1">
                <input
                  type="checkbox"
                  aria-label={`显示「${label}」`}
                  checked={shown}
                  onChange={() =>
                    setOrder(shown ? order.filter((item) => item !== key) : [...order, key])
                  }
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[13px]",
                    shown ? "text-body" : "text-faint",
                  )}
                >
                  {label}
                </span>
                <button
                  type="button"
                  aria-label={`「${label}」往前`}
                  disabled={!shown || at === 0}
                  onClick={() => setOrder(swap(order, at, at - 1))}
                  className={SMALL}
                >
                  <ChevronUp size={14} strokeWidth={2} />
                </button>
                <button
                  type="button"
                  aria-label={`「${label}」往后`}
                  disabled={!shown || at === order.length - 1}
                  onClick={() => setOrder(swap(order, at, at + 1))}
                  className={SMALL}
                >
                  <ChevronDown size={14} strokeWidth={2} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** groupOrder 里的在前（照它的顺序），现在有、它没写的跟在后面 */
function mergeKeys(order: (string | null)[], keys: (string | null)[]) {
  return [...order, ...keys.filter((key) => !order.includes(key))];
}

function swap<T>(list: T[], a: number, b: number): T[] {
  const next = [...list];
  [next[a], next[b]] = [next[b]!, next[a]!];
  return next;
}

/* ---------------- 显示哪几列 ---------------- */

function FieldsPanel({
  config,
  fields,
  candidates,
  onChange,
}: {
  config: BaseConfig;
  fields: string[];
  candidates: string[];
  onChange: (order: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const rest = candidates.filter((raw) => !fields.includes(raw));
  const match = (raw: string) =>
    !query ||
    propLabel(config, raw).toLowerCase().includes(query.toLowerCase()) ||
    raw.toLowerCase().includes(query.toLowerCase());
  return (
    <div className="flex flex-col gap-1 p-1">
      <input
        aria-label="找属性"
        placeholder="找属性"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className={INPUT}
      />
      <ul className="flex flex-col">
        {[...fields, ...rest].filter(match).map((raw) => {
          const at = fields.indexOf(raw);
          const shown = at >= 0;
          return (
            <li key={raw} className="flex h-8 items-center gap-1.5 px-1">
              <input
                type="checkbox"
                aria-label={`显示「${propLabel(config, raw)}」`}
                checked={shown}
                onChange={() =>
                  onChange(shown ? fields.filter((item) => item !== raw) : [...fields, raw])
                }
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[13px]",
                  shown ? "text-body" : "text-muted",
                )}
              >
                {propLabel(config, raw)}
                {propRef(raw).ns !== "note" && (
                  <span className="ml-1 text-[12px] text-faint">
                    {propRef(raw).ns === "file" ? "文件" : "公式"}
                  </span>
                )}
              </span>
              {shown && (
                <>
                  <button
                    type="button"
                    aria-label={`「${propLabel(config, raw)}」往前`}
                    disabled={at === 0}
                    onClick={() => onChange(swap(fields, at, at - 1))}
                    className={SMALL}
                  >
                    <ChevronUp size={14} strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    aria-label={`「${propLabel(config, raw)}」往后`}
                    disabled={at === fields.length - 1}
                    onClick={() => onChange(swap(fields, at, at + 1))}
                    className={SMALL}
                  >
                    <ChevronDown size={14} strokeWidth={2} />
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ---------------- 源码 ---------------- */

function SourcePanel({
  text,
  onSave,
  onCancel,
}: { text: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(text);
  return (
    <div className="flex flex-col gap-2 p-1">
      <textarea
        aria-label="视图文件的源码（YAML）"
        value={draft}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            onSave(draft);
          }
        }}
        className="h-[360px] resize-none rounded-md border border-line-strong bg-panel p-2.5 font-mono text-[12px] leading-[18px] text-body outline-none focus:border-accent"
      />
      <div className="flex items-center justify-end gap-1.5">
        <span className="mr-auto text-[12px] text-faint">Ctrl + Enter 保存</span>
        <button
          type="button"
          onClick={onCancel}
          className="h-7 rounded-md px-3 text-[13px] text-muted hover:bg-raised hover:text-ink"
        >
          取消
        </button>
        <button
          type="button"
          disabled={draft === text}
          onClick={() => onSave(draft)}
          className="h-7 rounded-md bg-accent px-3 text-[13px] text-accent-ink hover:bg-accent-hover disabled:opacity-50"
        >
          保存
        </button>
      </div>
    </div>
  );
}
