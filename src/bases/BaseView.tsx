import { useApp } from "@/app/store";
import { OverlayScrollbar } from "@/components/OverlayScrollbar";
import { ActionMenu } from "@/components/RowMenu";
import { backend } from "@/data/backend";
import { messageOf, useData } from "@/data/store";
import { noteRef } from "@/data/types";
import { cn } from "@/lib/cn";
import { announceProperties, loadCatalog, useCatalog } from "@/properties/store";
import { KINDS, type Kind, isListKind, kindOfValue } from "@/properties/yaml";
import {
  Copy,
  FileQuestion,
  Kanban,
  LayoutGrid,
  List,
  MoreHorizontal,
  PenLine,
  Plus,
  Table2,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { BoardView } from "./BoardView";
import { CardsView, ListView } from "./GalleryView";
import { TableView } from "./TableView";
import { Toolbar } from "./Toolbar";
import type { CellContext } from "./cells";
import { type ViewConfig, addView, duplicateView, removeView, setSort, setViewKey } from "./config";
import { holdBaseDocs, refreshBaseDocs, useBaseDocs } from "./docs";
import { useBaseFile } from "./file";
import { baseTitle } from "./ids";
import {
  FILE_PROPS,
  type KindHints,
  baseSource,
  buildRows,
  compileView,
  defaultOrder,
  propRef,
  runView,
} from "./query";
import { withValue } from "./write";

/* ============================================================
   一个视图文件（docs/视图文件.md §3.6）：页头（文件名、视图的切换）、工具条、正文（表格 / 看板 / 卡片 / 列表）。
   正文撑满这个窗格的宽度，自己滚；最上面 38px 是拖动区（标签栏在那里），表头贴在它下面
   ============================================================ */

const VIEW_TYPES = [
  { type: "table", label: "表格", icon: Table2 },
  { type: "kanban", label: "看板", icon: Kanban },
  { type: "cards", label: "卡片", icon: LayoutGrid },
  { type: "list", label: "列表", icon: List },
] as const;

const iconOf = (type: string) =>
  VIEW_TYPES.find((item) => item.type === type)?.icon ?? FileQuestion;

/** 每个视图文件上次看的是第几个视图（本机，换标签回来还在） */
const LS_KEY = "odea.bases.view";
function rememberedView(relPath: string): number {
  try {
    const all = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as Record<string, number>;
    return all[relPath] ?? 0;
  } catch {
    return 0;
  }
}
function rememberView(relPath: string, index: number) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as Record<string, number>;
    all[relPath] = index;
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {
    /* 隐私模式：这一次记着就行 */
  }
}

/** 文件里一个视图都没写（空文件、刚建的）：先当它有一个表格 */
const FALLBACK: ViewConfig = {
  type: "table",
  name: "表格",
  filters: null,
  order: null,
  sort: [],
  groupBy: null,
  groupOrder: null,
  limit: null,
  image: null,
  columnSize: {},
};

export default function BaseView({ relPath }: { relPath: string }) {
  const base = useBaseFile(relPath);
  const config = base.file?.config;
  const views = config && config.views.length > 0 ? config.views : [FALLBACK];
  const [picked, setPicked] = useState(() => rememberedView(relPath));
  const viewIndex = Math.min(picked, views.length - 1);
  const view = views[viewIndex]!;
  const pick = (index: number) => {
    setPicked(index);
    rememberView(relPath, index);
  };
  const [problem, setProblem] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  /* ---------- 数据 ---------- */
  const compiled = useMemo(() => (config ? compileView(config, view) : null), [config, view]);
  const needsBody = compiled?.needsBody ?? false;
  useEffect(() => holdBaseDocs(needsBody), [needsBody]);
  const docs = useBaseDocs((s) => s.docs);
  const docsError = useBaseDocs((s) => s.error);
  const notes = useData((s) => s.notes);
  const archived = useData((s) => s.archived);
  const catalog = useCatalog((s) => s.catalog);
  useEffect(() => {
    void loadCatalog();
  }, []);
  const hints = useMemo<KindHints>(
    () => ({
      recorded: catalog?.types ?? {},
      usual: new Map((catalog?.keys ?? []).map((item) => [item.key, item.kind])),
    }),
    [catalog],
  );
  const live = useMemo(() => {
    const map = new Map<string, { title: string; updatedAt: number }>();
    for (const note of notes) map.set(note.id, note);
    for (const note of archived) map.set(note.id, note);
    return map;
  }, [notes, archived]);
  const rows = useMemo(() => (docs ? buildRows(docs, hints, live) : null), [docs, hints, live]);
  const self = useMemo(() => baseSource(relPath), [relPath]);
  // 「今天」按打开时算；过了零点换视图、改筛选时跟上（不为它起计时器）
  const result = useMemo(
    () => (compiled && rows ? runView(compiled, view, rows, self, Date.now()) : null),
    [compiled, rows, view, self],
  );

  const columns = useMemo(
    () =>
      view.order && view.order.length > 0 ? view.order : rows ? defaultOrder(rows) : ["file.name"],
    [view.order, rows],
  );
  const candidates = useMemo(() => {
    const keys = (catalog?.keys ?? []).map((item) => item.key);
    const formulas = Object.keys(config?.formulas ?? {}).map((name) => `formula.${name}`);
    const all = [...columns, ...FILE_PROPS, ...keys, ...formulas];
    const seen = new Set<string>();
    return all.filter((raw) => {
      const id = propRef(raw).id;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [catalog, config, columns]);

  const context = useMemo<CellContext>(
    () => ({
      hints,
      suggestions: (key) => catalog?.keys.find((item) => item.key === key)?.values ?? [],
      onError: setProblem,
    }),
    [hints, catalog],
  );

  /* ---------- 视图的增删改 ---------- */
  const newView = (type: string, label: string) => {
    const name = uniqueName(views, label);
    base.edit((doc) => {
      // 一个视图都没写的文件：先把界面上那个默认的表格写进去，新的排在它后面
      if (!config?.views.length) addView({ type: "table", name: "表格", order: columns })(doc);
      addView({
        type,
        name,
        order: columns,
        ...(type === "kanban"
          ? { groupBy: { property: guessGroup(candidates), direction: "ASC" } }
          : {}),
      })(doc);
    });
    pick(config?.views.length ? views.length : 1);
  };

  // 改名：就地变成输入框（双击小签、菜单里「改名」）
  const [renaming, setRenaming] = useState<number | null>(null);
  const renameView = (index: number, name: string) => {
    setRenaming(null);
    const clean = name.trim();
    if (clean && clean !== views[index]?.name) base.edit(setViewKey(index, "name", clean));
  };

  // 看板列底下「新建」：在视图文件所在的文件夹里建一篇，带着这一列的值，开在新标签里
  const onNew = async (value: string | null) => {
    const by = view.groupBy;
    if (!by) return;
    const id = await useData.getState().createNote(treeFolderOf(relPath));
    if (!id) return;
    if (value !== null) {
      const key = propRef(by.property).name;
      const hinted = hints.recorded[key] ?? hints.usual.get(key);
      const kind = KINDS.includes(hinted as Kind) ? (hinted as Kind) : kindOfValue(value);
      try {
        const api = await backend();
        const target = noteRef(id);
        const before = (await api.docProperties(target)).text;
        const saved = await api.docSetProperties(
          target,
          withValue(before, key, kind, isListKind(kind) ? [value] : value),
        );
        announceProperties(target, saved);
      } catch (error) {
        setProblem(messageOf(error));
      }
    }
    refreshBaseDocs(0);
    useApp.getState().openNoteTab(id);
  };

  /* ---------- 画 ---------- */
  const title = baseTitle(relPath);
  const fields = columns;
  const known = VIEW_TYPES.some((item) => item.type === view.type);
  const error = base.error ?? docsError ?? problem;

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col bg-canvas">
      {/* 最上面的拖动区（标签栏在这里）：底色盖住滚上去的内容 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 z-[28] h-[38px] bg-canvas"
      />
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          data-base-scroller
          className="@container scroll-none h-full overflow-auto bg-canvas"
        >
          <header className="px-8 pt-[52px] @min-[560px]:px-14">
            <p className="mb-2 min-h-[20px] truncate text-[12px] font-medium leading-[20px] tracking-[0.02em] text-muted">
              视图文件 · {folderLabelOf(relPath)}
            </p>
            <h1 className="-my-[0.05em] truncate font-display text-[30px] font-bold leading-[1.35] text-ink @min-[480px]:text-[38px]">
              {title}
            </h1>
            <div className="mt-5 flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line pb-2">
              <div
                role="tablist"
                aria-label="视图"
                className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5"
              >
                {views.map((item, index) => {
                  const Icon = iconOf(item.type);
                  const active = index === viewIndex;
                  return (
                    <div key={`${item.name}:${index}`} className="group/view flex items-center">
                      {renaming === index ? (
                        <input
                          // biome-ignore lint/a11y/noAutofocus: 点了改名才出现的输入框，要直接能打字
                          autoFocus
                          aria-label="视图的名字"
                          defaultValue={item.name}
                          onBlur={(event) => renameView(index, event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.nativeEvent.isComposing) return;
                            if (event.key === "Enter") event.currentTarget.blur();
                            if (event.key === "Escape") setRenaming(null);
                          }}
                          className="h-7 w-[140px] rounded-md border border-accent bg-canvas px-2 text-[13px] text-ink outline-none"
                        />
                      ) : (
                        <button
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => pick(index)}
                          onDoubleClick={() => config?.views.length && setRenaming(index)}
                          className={cn(
                            "flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors duration-[140ms]",
                            active
                              ? "bg-raised text-ink"
                              : "text-muted hover:bg-raised/60 hover:text-ink",
                          )}
                        >
                          <Icon size={14} strokeWidth={1.9} />
                          <span className="max-w-[160px] truncate">{item.name}</span>
                        </button>
                      )}
                      {active && config && config.views.length > 0 && (
                        <ActionMenu
                          align="start"
                          trigger={
                            <button
                              type="button"
                              aria-label={`「${item.name}」的更多操作`}
                              className="grid h-7 w-6 place-items-center rounded-md text-faint hover:bg-raised hover:text-ink data-[state=open]:bg-raised"
                            >
                              <MoreHorizontal size={14} strokeWidth={2} />
                            </button>
                          }
                          actions={[
                            {
                              id: "rename",
                              label: "改名",
                              icon: PenLine,
                              onSelect: () => setRenaming(index),
                            },
                            {
                              id: "copy",
                              label: "复制一份",
                              icon: Copy,
                              onSelect: () => {
                                base.edit(duplicateView(index, uniqueName(views, item.name)));
                                pick(index + 1);
                              },
                            },
                            ...(views.length > 1
                              ? [
                                  {
                                    id: "remove",
                                    label: "删掉这个视图",
                                    icon: Trash2,
                                    danger: true,
                                    onSelect: () => {
                                      base.edit(removeView(index));
                                      pick(Math.max(0, index - 1));
                                    },
                                  },
                                ]
                              : []),
                          ]}
                        />
                      )}
                    </div>
                  );
                })}
                <ActionMenu
                  align="start"
                  trigger={
                    <button
                      type="button"
                      aria-label="加一个视图"
                      title="加一个视图"
                      className="grid h-7 w-7 place-items-center rounded-md text-faint hover:bg-raised hover:text-ink data-[state=open]:bg-raised"
                    >
                      <Plus size={14} strokeWidth={2} />
                    </button>
                  }
                  actions={VIEW_TYPES.map((item) => ({
                    id: item.type,
                    label: item.label,
                    icon: item.icon,
                    onSelect: () => newView(item.type, item.label),
                  }))}
                />
              </div>
              {config && result && base.text !== null && (
                <Toolbar
                  config={config}
                  view={view}
                  viewIndex={viewIndex}
                  candidates={candidates}
                  kindOf={(raw) => {
                    const ref = propRef(raw);
                    if (ref.ns === "file")
                      return ["mtime", "ctime"].includes(ref.name)
                        ? "date"
                        : ref.name === "size"
                          ? "number"
                          : "text";
                    return hints.recorded[ref.name] ?? hints.usual.get(ref.name);
                  }}
                  groups={result.groups}
                  fields={fields}
                  total={result.total}
                  shown={result.rows.length}
                  text={base.text}
                  edit={(edit) => {
                    // 文件里一个视图都没写：先把界面上那个默认的表格写进去再改它
                    if (!config.views.length)
                      base.edit(addView({ type: "table", name: "表格", order: columns }));
                    base.edit(edit);
                  }}
                  replace={base.replace}
                  kanban={view.type === "kanban"}
                />
              )}
            </div>
            {error && (
              <div
                role="alert"
                className="mt-2 flex items-start gap-2 rounded-lg bg-danger/8 px-3 py-2 text-[13px] text-danger"
              >
                <TriangleAlert size={14} strokeWidth={2} className="mt-[3px] shrink-0" />
                <span className="min-w-0 flex-1">{error}</span>
                <button
                  type="button"
                  aria-label="知道了"
                  onClick={() => {
                    base.clearError();
                    setProblem(null);
                  }}
                  className="grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-danger/10"
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </div>
            )}
            {result && result.problems.length > 0 && (
              <ul className="mt-2 flex flex-col gap-0.5 rounded-lg bg-warning/8 px-3 py-2 text-[13px] text-warning">
                {result.problems.map((text) => (
                  <li key={text} className="flex items-start gap-2">
                    <TriangleAlert size={14} strokeWidth={2} className="mt-[3px] shrink-0" />
                    <span>这一条没算（结果里没有因为它少东西）：{text}</span>
                  </li>
                ))}
              </ul>
            )}
          </header>

          <div className="px-8 pt-3 @min-[560px]:px-14">
            {base.missing ? (
              <Empty title="这个视图文件不在了" hint="可能在别处删掉、挪走了。关掉这个标签就好。" />
            ) : base.file?.error ? (
              <Empty
                title="视图文件读不出来"
                hint={`${base.file.error}。点上面的「源码」改好就行。`}
              />
            ) : !known ? (
              <Empty
                title={`Odea 还不会画「${view.type}」这种视图`}
                hint="文件里它原样留着，在 Obsidian 里照样能看。换上面别的视图看。"
              />
            ) : !result ? (
              <div className="h-40" aria-busy="true" />
            ) : view.type === "kanban" && !view.groupBy ? (
              <Empty
                title="看板要按一个属性分列"
                hint="点右边的「分列」选一个属性（比如 status），每个值一列。"
              />
            ) : view.type === "kanban" ? (
              <BoardView
                result={result}
                config={config!}
                view={view}
                fields={fields}
                context={context}
                onNew={(value) => void onNew(value)}
              />
            ) : view.type === "cards" ? (
              <CardsView result={result} config={config!} view={view} fields={fields} />
            ) : view.type === "list" ? (
              <ListView result={result} config={config!} view={view} fields={fields} />
            ) : result.total === 0 ? (
              <Empty title="没有符合条件的笔记" hint="改一改筛选，或者给笔记加上要的属性。" />
            ) : (
              <TableView
                result={result}
                columns={columns}
                config={config!}
                view={view}
                context={context}
                scrollRef={scrollRef}
                onSort={(sort) => {
                  if (!config!.views.length)
                    base.edit(addView({ type: "table", name: "表格", order: columns }));
                  base.edit(setSort(viewIndex, sort));
                }}
              />
            )}
          </div>
          <div className="h-16" />
        </div>
        <OverlayScrollbar targetRef={scrollRef} />
      </div>
    </div>
  );
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-start gap-1 py-16">
      <p className="text-[15px] font-medium text-ink">{title}</p>
      <p className="max-w-[460px] text-[13px] leading-[22px] text-muted">{hint}</p>
    </div>
  );
}

function uniqueName(views: ViewConfig[], label: string): string {
  const names = new Set(views.map((view) => view.name));
  if (!names.has(label)) return label;
  for (let n = 2; ; n += 1) if (!names.has(`${label} ${n}`)) return `${label} ${n}`;
}

/** 看板默认按哪个属性分列：仓库里有 status / 状态 就用它，不然第一个笔记的属性 */
function guessGroup(candidates: string[]): string {
  const notes = candidates.filter((raw) => propRef(raw).ns === "note");
  return (
    notes.find((raw) => /^(status|状态|stage|阶段)$/i.test(propRef(raw).name)) ??
    notes[0] ??
    "file.folder"
  );
}

/** 视图文件所在的文件夹，给人看的（仓库根写「仓库根」） */
function folderLabelOf(relPath: string): string {
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  return dir || "仓库根";
}

/** 视图文件在树上的哪个文件夹（相对树根）：看板「新建」的笔记建在这里 */
function treeFolderOf(relPath: string): string {
  const file = useData.getState().files.find((item) => item.relPath === relPath);
  return file?.folder ?? "";
}
