import { ActionMenu } from "@/components/RowMenu";
import { backend } from "@/data/backend";
import { messageOf, useData } from "@/data/store";
import type { DocumentRef, VaultChange } from "@/data/types";
import { cn } from "@/lib/cn";
import { focusedDocument } from "@/lib/liveDocuments";
import {
  Braces,
  Calendar,
  CalendarClock,
  Check,
  Code,
  CornerDownRight,
  Hash,
  List,
  type LucideIcon,
  Plus,
  SquareCheck,
  Tags,
  Type,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type DocProps,
  cachedProperties,
  invalidateCatalog,
  loadCatalog,
  primeProperties,
  propKey,
  setPropertySource,
  setRecordedTypes,
  useAddRequest,
  useCatalog,
  usePropertyView,
} from "./store";
import {
  type Entry,
  KINDS,
  type Kind,
  MANAGED,
  appendEntry,
  convertValue,
  entryLines,
  isListKind,
  kindOf,
  parse,
  removeEntry,
  renameEntry,
  replaceEntry,
} from "./yaml";

/* ============================================================
   属性面板（docs/提醒与属性.md §3）：标题下面，属性块里用户自己的那几行画成一张表。

   - 一行一条：类型图标（点开换类型，记进仓库的 types.json）、键（点了改名）、值（按类型给编辑器）、删除
   - 改一条只换它自己那几行（yaml.ts），别的字节不动；写回走 Rust（doc_set_properties），正文一个字不碰
   - 提示从整个仓库来：加属性时提示出现过的键，填值时提示这个键出现过的值
   - 没有属性时不占地方；命令面板「添加属性」（Ctrl+;）、或者底下的「添加属性」加第一条
   - 「源码」：直接改 YAML（嵌套的、多行的在这里改）
   动效照 docs/PITFALLS/动效.md：提示列表、删除按钮都是直接出现或者只淡颜色，不位移、不缩放
   ============================================================ */

const KIND_META: Record<Kind, { label: string; icon: LucideIcon }> = {
  text: { label: "文字", icon: Type },
  multitext: { label: "列表", icon: List },
  number: { label: "数字", icon: Hash },
  checkbox: { label: "勾选", icon: SquareCheck },
  date: { label: "日期", icon: Calendar },
  datetime: { label: "日期和时间", icon: CalendarClock },
  tags: { label: "标签", icon: Tags },
  aliases: { label: "别名", icon: CornerDownRight },
};

const WIKILINK = /^\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|[^\]]*)?\]\]$/;

function touches(change: VaultChange, target: DocumentRef): boolean {
  if (target.type === "note") return change.notes.includes(target.key);
  return change.docs.some((doc) => doc.type === target.type && doc.key === target.key);
}

export function PropertiesPanel({
  target,
  readOnly = false,
  onWikiLink,
}: {
  target: DocumentRef;
  readOnly?: boolean;
  onWikiLink?: (title: string, heading?: string, newTab?: boolean) => void;
}) {
  const key = propKey(target);
  const [doc, setDoc] = useState<DocProps | null>(() => cachedProperties(target));
  const [adding, setAdding] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const source = usePropertyView((s) => s.source);
  const [sourceOpen, setSourceOpen] = useState(false);
  const catalog = useCatalog((s) => s.catalog);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const targetRef = useRef(target);
  targetRef.current = target;

  // 换了一篇：先用缓存里的（取笔记时一起来的），再去取一遍最新的。只跟着 key 走：
  // target 每次渲染都是新对象，用 targetRef 读最新的那个
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上
  useEffect(() => {
    setDoc(cachedProperties(targetRef.current));
    setAdding(false);
    setSourceOpen(false);
    setError(null);
    let alive = true;
    const refetch = async () => {
      try {
        const fresh = await (await backend()).docProperties(targetRef.current);
        if (!alive) return;
        primeProperties(targetRef.current, fresh.text, fresh.editable);
        setDoc(fresh);
      } catch {
        /* 取不到（还没写过的某一天）：当没有属性 */
        if (alive) setDoc((current) => current ?? { text: "", editable: false });
      }
    };
    void refetch();
    const stop = backend().then((api) =>
      api.onVaultChanged((change) => {
        if (touches(change, targetRef.current)) {
          invalidateCatalog();
          void refetch();
        }
      }),
    );
    return () => {
      alive = false;
      void stop.then((unlisten) => unlisten());
    };
  }, [key]);

  // 「添加属性」：命令面板、Ctrl+; 要的是这一篇
  const addRequest = useAddRequest();
  useEffect(() => {
    if (addRequest.key === key && addRequest.at > 0 && !readOnly) {
      setAdding(true);
      void loadCatalog();
    }
  }, [addRequest, key, readOnly]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== ";" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey)
        return;
      // 开着好几篇（分屏、弹出窗口）：正在写的那一篇才接
      const focused = focusedDocument();
      if (readOnly || !focused || propKey(focused.ref) !== key) return;
      event.preventDefault();
      setAdding(true);
      void loadCatalog();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, readOnly]);

  const text = doc?.text ?? "";
  const parsed = useMemo(() => parse(text), [text]);
  const editable = !readOnly && (doc?.editable ?? false);
  const recorded = catalog?.types ?? {};
  const usual = useMemo(() => {
    const map = new Map<string, { kind: string; values: string[] }>();
    for (const item of catalog?.keys ?? []) map.set(item.key, item);
    return map;
  }, [catalog]);

  /** 写回去：先改界面，Rust 写好了再对一遍；失败了退回去、说为什么。一次一次排着写 */
  const commit = useCallback(
    (next: string) => {
      const before = doc;
      const at = targetRef.current;
      setDoc((current) => ({ text: next, editable: current?.editable ?? true }));
      setError(null);
      writes.current = writes.current.then(async () => {
        try {
          const saved = await (await backend()).docSetProperties(at, next);
          primeProperties(at, saved.text, saved.editable);
          if (propKey(targetRef.current) === propKey(at)) setDoc(saved);
          invalidateCatalog();
        } catch (cause) {
          if (propKey(targetRef.current) === propKey(at)) {
            setDoc(before);
            setError(messageOf(cause));
          } else {
            useData.setState({ error: messageOf(cause) });
          }
        }
      });
    },
    [doc],
  );

  const changeKind = async (entry: Entry, from: Kind, to: Kind) => {
    if (from === to) return;
    commit(
      replaceEntry(
        parsed,
        entry,
        entryLines(entry.key, to, convertValue(entry, from, to), entry.flow),
      ),
    );
    try {
      setRecordedTypes(await (await backend()).setPropertyType(entry.key, to));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const hasEntries = parsed.entries.length > 0;
  const unreadable = !hasEntries && text.trim() !== "";
  const showSource =
    (source || sourceOpen || unreadable) && (hasEntries || unreadable || sourceOpen);
  if (!doc || (!hasEntries && !adding && !showSource && !unreadable)) return null;

  return (
    <section
      aria-label="属性"
      className="group/props mt-5 -mx-2 flex flex-col"
      onFocusCapture={() => void loadCatalog()}
      onMouseEnter={() => void loadCatalog()}
    >
      {showSource ? (
        <SourceEditor
          text={text}
          editable={editable}
          // 点「源码」打开的：光标直接进去（Esc、Ctrl+Enter 马上能用）；偏好就是源码的不抢焦点
          autoFocus={sourceOpen}
          onCommit={(next) => {
            commit(next);
            setSourceOpen(false);
          }}
          onCancel={() => setSourceOpen(false)}
        />
      ) : (
        parsed.entries.map((entry, index) => {
          const kind: Kind | "complex" =
            entry.shape === "complex"
              ? "complex"
              : kindOf(entry, recorded, usual.get(entry.key)?.kind);
          return (
            <PropertyRow
              // 键可能重名（手写的），加上位置
              key={`${entry.key}\u0000${index}`}
              entry={entry}
              kind={kind}
              editable={editable}
              autoFocus={focusKey === entry.key}
              suggestions={usual.get(entry.key)?.values ?? []}
              onFocused={() => setFocusKey(null)}
              onCommitValue={(value) => {
                if (kind === "complex") return;
                commit(replaceEntry(parsed, entry, entryLines(entry.key, kind, value, entry.flow)));
              }}
              onRename={(name) => {
                const trimmed = name.trim();
                if (!trimmed || trimmed === entry.key) return;
                if (MANAGED.includes(trimmed)) {
                  setError(`「${trimmed}」由 Odea 自己管，换个名字吧`);
                  return;
                }
                commit(renameEntry(parsed, entry, trimmed));
              }}
              onKind={(to) => kind !== "complex" && void changeKind(entry, kind, to)}
              onRemove={() => commit(removeEntry(parsed, entry))}
              onSource={() => setSourceOpen(true)}
              onWikiLink={onWikiLink}
            />
          );
        })
      )}

      {adding && editable && !showSource && (
        <AddRow
          existing={parsed.entries.map((entry) => entry.key)}
          onCancel={() => setAdding(false)}
          onAdd={(name) => {
            setAdding(false);
            if (parsed.entries.some((entry) => entry.key === name)) {
              setFocusKey(name);
              return;
            }
            const kind =
              (recorded[name] as Kind | undefined) ??
              (usual.get(name)?.kind as Kind | undefined) ??
              "text";
            const lowered = name.toLowerCase();
            const resolved: Kind =
              lowered === "tags"
                ? "tags"
                : lowered === "aliases"
                  ? "aliases"
                  : KINDS.includes(kind)
                    ? kind
                    : "text";
            commit(appendEntry(parsed, entryLines(name, resolved, isListKind(resolved) ? [] : "")));
            setFocusKey(name);
          }}
          onError={setError}
        />
      )}

      {error && (
        <p role="alert" className="px-2 pt-1 text-[12px] leading-5 text-danger">
          {error}
        </p>
      )}

      {editable && !showSource && (
        <div className="flex h-8 items-center gap-1 px-1">
          {!adding && (
            <FooterButton
              icon={Plus}
              onClick={() => {
                setAdding(true);
                void loadCatalog();
              }}
            >
              添加属性
            </FooterButton>
          )}
          <span className="flex-1" />
          <FooterButton icon={Code} onClick={() => setSourceOpen(true)} title="直接改 YAML">
            源码
          </FooterButton>
        </div>
      )}
      {showSource && editable && source && (
        <div className="flex h-8 items-center px-1">
          <span className="flex-1" />
          <FooterButton icon={Code} onClick={() => setPropertySource(false)} title="一行一条地看">
            显示成面板
          </FooterButton>
        </div>
      )}
    </section>
  );
}

/** 底下的小按钮：平时很淡，指到属性这一块时清楚一点（只淡颜色，不进合成层） */
function FooterButton({
  icon: Icon,
  onClick,
  title,
  children,
}: {
  icon: LucideIcon;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-transparent transition-colors duration-[140ms]
                 group-hover/props:text-faint group-focus-within/props:text-faint
                 hover:bg-raised hover:text-ink! focus-visible:text-ink"
    >
      <Icon size={12} strokeWidth={2} />
      {children}
    </button>
  );
}

/* ---------------- 一行 ---------------- */

function PropertyRow({
  entry,
  kind,
  editable,
  autoFocus,
  suggestions,
  onFocused,
  onCommitValue,
  onRename,
  onKind,
  onRemove,
  onSource,
  onWikiLink,
}: {
  entry: Entry;
  kind: Kind | "complex";
  editable: boolean;
  autoFocus: boolean;
  suggestions: string[];
  onFocused: () => void;
  onCommitValue: (value: string | string[]) => void;
  onRename: (name: string) => void;
  onKind: (kind: Kind) => void;
  onRemove: () => void;
  onSource: () => void;
  onWikiLink?: (title: string, heading?: string, newTab?: boolean) => void;
}) {
  const meta = kind === "complex" ? { label: "多行内容", icon: Braces } : KIND_META[kind];
  const Icon = meta.icon;
  const icon = (
    <button
      type="button"
      disabled={!editable || kind === "complex"}
      title={kind === "complex" ? "多行内容、嵌套的：在源码里改" : `${meta.label}（点了换类型）`}
      aria-label={`${entry.key}：${meta.label}`}
      className="grid h-[30px] w-6 shrink-0 place-items-center rounded-md text-faint transition-colors duration-[140ms]
                 enabled:hover:bg-raised enabled:hover:text-ink"
    >
      <Icon size={14} strokeWidth={1.9} />
    </button>
  );
  return (
    <div className="group/row flex min-h-[34px] items-start gap-1 rounded-md px-1 py-[2px] hover:bg-panel focus-within:bg-panel">
      {editable && kind !== "complex" ? (
        <ActionMenu
          align="start"
          trigger={icon}
          actions={KINDS.map((option) => ({
            id: option,
            label: KIND_META[option].label,
            icon: KIND_META[option].icon,
            checked: option === kind,
            onSelect: () => onKind(option),
          }))}
        />
      ) : (
        icon
      )}
      <KeyCell name={entry.key} editable={editable} onRename={onRename} />
      <div className="min-w-0 flex-1 py-[3px]">
        <ValueCell
          entry={entry}
          kind={kind}
          editable={editable}
          autoFocus={autoFocus}
          suggestions={suggestions}
          onFocused={onFocused}
          onCommit={onCommitValue}
          onSource={onSource}
          onWikiLink={onWikiLink}
        />
      </div>
      {editable && (
        <button
          type="button"
          aria-label={`删掉 ${entry.key}`}
          title="删掉这一条"
          onClick={onRemove}
          className="grid h-[30px] w-6 shrink-0 place-items-center rounded-md text-transparent transition-colors duration-[140ms]
                     group-hover/row:text-faint group-focus-within/row:text-faint hover:bg-raised hover:text-danger!"
        >
          <X size={12} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

function KeyCell({
  name,
  editable,
  onRename,
}: { name: string; editable: boolean; onRename: (name: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null) {
    return (
      <input
        // biome-ignore lint/a11y/noAutofocus: 点了键名才出现的输入框，要直接能改
        autoFocus
        value={draft}
        aria-label="属性名"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          onRename(draft);
          setDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur();
          if (event.key === "Escape") setDraft(null);
        }}
        className="mt-[3px] h-[26px] w-[132px] shrink-0 rounded-[5px] border border-accent bg-canvas px-1.5 text-[13px] text-ink outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      disabled={!editable}
      title={editable ? `${name}（点了改名）` : name}
      onClick={() => setDraft(name)}
      className="mt-[3px] h-[26px] w-[132px] shrink-0 truncate rounded-[5px] px-1.5 text-left text-[13px] text-muted
                 transition-colors duration-[140ms] enabled:hover:bg-raised enabled:hover:text-ink"
    >
      {name}
    </button>
  );
}

/* ---------------- 值 ---------------- */

const INPUT =
  "h-[26px] w-full min-w-0 rounded-[5px] border border-transparent bg-transparent px-1.5 text-[14px] text-body outline-none " +
  "placeholder:text-faint enabled:hover:border-line-strong focus:border-accent focus:bg-canvas";

function ValueCell({
  entry,
  kind,
  editable,
  autoFocus,
  suggestions,
  onFocused,
  onCommit,
  onSource,
  onWikiLink,
}: {
  entry: Entry;
  kind: Kind | "complex";
  editable: boolean;
  autoFocus: boolean;
  suggestions: string[];
  onFocused: () => void;
  onCommit: (value: string | string[]) => void;
  onSource: () => void;
  onWikiLink?: (title: string, heading?: string, newTab?: boolean) => void;
}) {
  switch (kind) {
    case "complex":
      return (
        <button
          type="button"
          onClick={onSource}
          disabled={!editable}
          className="h-[26px] px-1.5 text-left text-[13px] text-faint enabled:hover:text-ink"
        >
          多行内容 · {editable ? "在源码里改" : "只能看"}
        </button>
      );
    case "checkbox":
      return (
        <CheckboxValue
          checked={entry.value === "true"}
          editable={editable}
          autoFocus={autoFocus}
          onFocused={onFocused}
          onChange={(checked) => onCommit(checked ? "true" : "false")}
        />
      );
    case "date":
    case "datetime":
      return (
        <DateValue
          value={entry.value}
          withTime={kind === "datetime"}
          editable={editable}
          autoFocus={autoFocus}
          onFocused={onFocused}
          onCommit={onCommit}
        />
      );
    case "multitext":
    case "tags":
    case "aliases":
      return (
        <ListValue
          items={entry.shape === "list" ? entry.items : entry.value ? [entry.value] : []}
          tags={kind === "tags"}
          editable={editable}
          autoFocus={autoFocus}
          suggestions={suggestions}
          onFocused={onFocused}
          onCommit={onCommit}
          onWikiLink={onWikiLink}
        />
      );
    default:
      return (
        <TextValue
          value={entry.shape === "list" ? entry.items.join(", ") : entry.value}
          numeric={kind === "number"}
          editable={editable}
          autoFocus={autoFocus}
          suggestions={suggestions}
          onFocused={onFocused}
          onCommit={onCommit}
          onWikiLink={onWikiLink}
        />
      );
  }
}

/** 输入框下面的提示：按出现的次数排好的那些，打了字就筛。直接出现、直接消失 */
function useSuggestions(all: string[], query: string, exclude: string[] = []) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter((item) => !exclude.includes(item) && item !== query)
      .filter((item) => q === "" || item.toLowerCase().includes(q))
      .slice(0, 7);
  }, [all, query, exclude]);
  // 打的字变了：从第一条重新挑（只跟着字走，不跟着列表走）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上
  useEffect(() => setActive(0), [query]);
  return {
    open: open && items.length > 0,
    items,
    active,
    show: () => setOpen(true),
    hide: () => setOpen(false),
    /** ↑ ↓ 挑、Enter 选：选中了返回那一项 */
    key(event: ReactKeyboardEvent): string | null {
      if (!open || items.length === 0) return null;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((current) => (current + step + items.length) % items.length);
        return null;
      }
      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        const picked = items[active];
        if (picked !== undefined) {
          event.preventDefault();
          setOpen(false);
          return picked;
        }
      }
      if (event.key === "Escape") setOpen(false);
      return null;
    },
  };
}

function SuggestionList({
  items,
  active,
  onPick,
  render,
}: {
  items: string[];
  active: number;
  onPick: (item: string) => void;
  render?: (item: string) => ReactNode;
}) {
  return (
    <div
      role="listbox"
      // 焦点留在输入框里（↑ ↓ 在那边挑），列表本身不进 Tab 顺序
      tabIndex={-1}
      className="absolute top-full left-0 z-30 mt-1 flex min-w-[180px] max-w-[320px] flex-col rounded-lg bg-canvas p-1 shadow-float ring-1 ring-line-strong"
    >
      {items.map((item, index) => (
        <button
          key={item}
          type="button"
          role="option"
          aria-selected={index === active}
          // 按下时不让输入框失焦：失焦会先把没打完的字存掉
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(item)}
          className={cn(
            "flex h-7 items-center gap-2 truncate rounded-md px-2 text-left text-[13px]",
            index === active ? "bg-raised text-ink" : "text-body hover:bg-raised",
          )}
        >
          {render ? render(item) : item}
        </button>
      ))}
    </div>
  );
}

function wikiTarget(value: string): { title: string; heading?: string } | null {
  const match = WIKILINK.exec(value.trim());
  return match?.[1] ? { title: match[1].trim(), heading: match[2]?.trim() } : null;
}

function TextValue({
  value,
  numeric,
  editable,
  autoFocus,
  suggestions,
  onFocused,
  onCommit,
  onWikiLink,
}: {
  value: string;
  numeric: boolean;
  editable: boolean;
  autoFocus: boolean;
  suggestions: string[];
  onFocused: () => void;
  onCommit: (value: string) => void;
  onWikiLink?: (title: string, heading?: string, newTab?: boolean) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  // 别处改了（另一个窗口、外部程序）：没在打字时跟上
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);
  const hints = useSuggestions(numeric ? [] : suggestions, draft);
  const link = !focused ? wikiTarget(value) : null;

  const save = (next: string) => {
    const trimmed = next.trim();
    if (numeric && trimmed !== "" && !/^-?\d+(\.\d+)?$/.test(trimmed)) {
      setDraft(value);
      return;
    }
    if (trimmed !== value) onCommit(trimmed);
  };

  return (
    <div className="relative">
      <input
        // biome-ignore lint/a11y/noAutofocus: 刚加的那一条，光标直接进值里
        autoFocus={autoFocus}
        // 双链不在改的时候只显示标题，点进去才露出 [[ ]]（和正文里的双链一样）
        value={link ? link.title : draft}
        disabled={!editable}
        inputMode={numeric ? "decimal" : undefined}
        placeholder={editable ? "空" : ""}
        aria-label="值"
        onFocus={() => {
          setFocused(true);
          hints.show();
          onFocused();
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          hints.show();
        }}
        onBlur={() => {
          setFocused(false);
          hints.hide();
          save(draft);
        }}
        onMouseDown={(event) => {
          // Ctrl / ⌘ + 点双链：打开那一篇
          if (link && onWikiLink && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            onWikiLink(link.title, link.heading, event.shiftKey);
          }
        }}
        onKeyDown={(event) => {
          const picked = hints.key(event);
          if (picked !== null) {
            setDraft(picked);
            save(picked);
            return;
          }
          if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
        title={link ? "Ctrl + 点击打开" : undefined}
        className={cn(INPUT, numeric && "tabular-nums", link && "text-accent")}
      />
      {hints.open && (
        <SuggestionList
          items={hints.items}
          active={hints.active}
          onPick={(item) => {
            setDraft(item);
            save(item);
            hints.hide();
          }}
        />
      )}
    </div>
  );
}

function ListValue({
  items,
  tags,
  editable,
  autoFocus,
  suggestions,
  onFocused,
  onCommit,
  onWikiLink,
}: {
  items: string[];
  tags: boolean;
  editable: boolean;
  autoFocus: boolean;
  suggestions: string[];
  onFocused: () => void;
  onCommit: (items: string[]) => void;
  onWikiLink?: (title: string, heading?: string, newTab?: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const hints = useSuggestions(suggestions, draft, items);
  const add = (raw: string) => {
    const value = (tags ? raw.replace(/^#/, "") : raw).trim();
    setDraft("");
    if (value && !items.includes(value)) onCommit([...items, value]);
  };
  return (
    <div className="relative flex min-h-[26px] flex-wrap items-center gap-1 px-1">
      {items.map((item, index) => {
        const link = wikiTarget(item);
        return (
          <span
            // 手写的列表里可能有重复的项：加上位置
            // biome-ignore lint/suspicious/noArrayIndexKey: 见上
            key={`${item}\u0000${index}`}
            className={cn(
              "inline-flex h-[22px] max-w-full items-center gap-0.5 rounded-[5px] pl-2 text-[13px]",
              editable ? "pr-0.5" : "pr-2",
              tags ? "bg-accent-wash text-accent" : "bg-raised text-body",
            )}
          >
            {link && onWikiLink ? (
              <button
                type="button"
                className="truncate hover:underline"
                onClick={(event) =>
                  onWikiLink(link.title, link.heading, event.ctrlKey || event.metaKey)
                }
              >
                {link.title}
              </button>
            ) : (
              <span className="truncate">{tags ? `#${item}` : item}</span>
            )}
            {editable && (
              <button
                type="button"
                aria-label={`去掉 ${item}`}
                onClick={() => onCommit(items.filter((_, at) => at !== index))}
                className="grid h-[18px] w-[18px] place-items-center rounded-[4px] opacity-60 hover:bg-canvas/60 hover:opacity-100"
              >
                <X size={12} strokeWidth={2.2} />
              </button>
            )}
          </span>
        );
      })}
      {editable && (
        <input
          // biome-ignore lint/a11y/noAutofocus: 刚加的那一条，光标直接进值里
          autoFocus={autoFocus}
          value={draft}
          aria-label="加一项"
          placeholder={items.length === 0 ? "空" : "加一项"}
          onFocus={() => {
            hints.show();
            onFocused();
          }}
          onChange={(event) => {
            const value = event.target.value;
            // 打了逗号就是一项（中文逗号也算）
            if (/[,，]$/.test(value)) add(value.slice(0, -1));
            else setDraft(value);
            hints.show();
          }}
          onBlur={() => {
            hints.hide();
            if (draft.trim()) add(draft);
          }}
          onKeyDown={(event) => {
            const picked = hints.key(event);
            if (picked !== null) {
              add(picked);
              return;
            }
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (draft.trim()) add(draft);
            } else if (event.key === "Backspace" && draft === "" && items.length > 0) {
              onCommit(items.slice(0, -1));
            } else if (event.key === "Escape") {
              setDraft("");
              event.currentTarget.blur();
            }
          }}
          className="h-[22px] min-w-[72px] flex-1 bg-transparent px-1 text-[13px] text-body outline-none placeholder:text-faint"
        />
      )}
      {hints.open && (
        <SuggestionList
          items={hints.items}
          active={hints.active}
          onPick={(item) => add(item)}
          render={(item) => (tags ? `#${item}` : item)}
        />
      )}
    </div>
  );
}

function CheckboxValue({
  checked,
  editable,
  autoFocus,
  onFocused,
  onChange,
}: {
  checked: boolean;
  editable: boolean;
  autoFocus: boolean;
  onFocused: () => void;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <div className="flex h-[26px] items-center px-1.5">
      <button
        ref={ref}
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label="勾选"
        disabled={!editable}
        onFocus={onFocused}
        onClick={() => onChange(!checked)}
        className={cn(
          "grid h-4 w-4 place-items-center rounded-[4px] border transition-colors duration-[120ms]",
          checked
            ? "border-accent bg-accent text-accent-ink"
            : "border-faint bg-canvas text-transparent",
        )}
      >
        <Check size={12} strokeWidth={3} />
      </button>
    </div>
  );
}

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

/** 「11月20日 周五 · 还有 8 天」：今年的不写年份；离今天近的说还有几天 / 过了几天 */
export function describeDate(
  value: string,
  withTime: boolean,
  today = new Date(),
): { label: string; hint: string } {
  const [datePart = "", timePart] = value.split(/[T ]/);
  const [y = 0, m = 1, d = 1] = datePart.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  if (Number.isNaN(date.getTime()) || !y) return { label: value, hint: "" };
  const sameYear = y === today.getFullYear();
  const label = `${sameYear ? "" : `${y}年`}${m}月${d}日 周${WEEK[date.getDay()]}${withTime && timePart ? ` ${timePart.slice(0, 5)}` : ""}`;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((date.getTime() - start.getTime()) / 86_400_000);
  const hint =
    days === 0
      ? "今天"
      : days === 1
        ? "明天"
        : days === -1
          ? "昨天"
          : days > 0 && days <= 30
            ? `还有 ${days} 天`
            : days < 0 && days >= -30
              ? `过了 ${-days} 天`
              : "";
  return { label, hint };
}

function DateValue({
  value,
  withTime,
  editable,
  autoFocus,
  onFocused,
  onCommit,
}: {
  value: string;
  withTime: boolean;
  editable: boolean;
  autoFocus: boolean;
  onFocused: () => void;
  onCommit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(autoFocus);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) return;
    const input = ref.current;
    input?.focus();
    try {
      input?.showPicker?.();
    } catch {
      /* 有的内核要用户手势才给开：光标在框里也能直接打 */
    }
  }, [editing]);

  if (editing && editable) {
    const inputValue = withTime ? value.replace(" ", "T").slice(0, 16) : value.slice(0, 10);
    return (
      <input
        ref={ref}
        type={withTime ? "datetime-local" : "date"}
        defaultValue={inputValue}
        aria-label={withTime ? "日期和时间" : "日期"}
        onFocus={onFocused}
        onBlur={(event) => {
          setEditing(false);
          const next = event.target.value;
          if (next !== inputValue) onCommit(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setEditing(false);
        }}
        className={cn(INPUT, "w-auto tabular-nums")}
      />
    );
  }
  const { label, hint } = value ? describeDate(value, withTime) : { label: "", hint: "" };
  return (
    <button
      type="button"
      disabled={!editable}
      onClick={() => setEditing(true)}
      className="flex h-[26px] max-w-full items-center gap-2 rounded-[5px] border border-transparent px-1.5 text-left text-[14px]
                 tabular-nums text-body enabled:hover:border-line-strong"
    >
      {value ? <span className="truncate">{label}</span> : <span className="text-faint">空</span>}
      {hint && <span className="shrink-0 text-[12px] text-faint">{hint}</span>}
    </button>
  );
}

/* ---------------- 加一条 ---------------- */

function AddRow({
  existing,
  onAdd,
  onCancel,
  onError,
}: {
  existing: string[];
  onAdd: (name: string) => void;
  onCancel: () => void;
  onError: (message: string | null) => void;
}) {
  const [draft, setDraft] = useState("");
  const catalog = useCatalog((s) => s.catalog);
  const keys = useMemo(
    () =>
      (catalog?.keys ?? []).filter((item) => !MANAGED.includes(item.key)).map((item) => item.key),
    [catalog],
  );
  const hints = useSuggestions(keys, draft, existing);
  const kinds = useMemo(
    () => new Map((catalog?.keys ?? []).map((item) => [item.key, item.kind])),
    [catalog],
  );
  const counts = useMemo(
    () => new Map((catalog?.keys ?? []).map((item) => [item.key, item.count])),
    [catalog],
  );

  const submit = (raw: string) => {
    const name = raw.trim().replace(/:$/, "");
    if (!name) {
      onCancel();
      return;
    }
    if (MANAGED.includes(name)) {
      onError(`「${name}」由 Odea 自己管，换个名字吧`);
      return;
    }
    onError(null);
    onAdd(name);
  };

  return (
    <div className="flex min-h-[34px] items-start gap-1 rounded-md bg-panel px-1 py-[2px]">
      <span className="grid h-[30px] w-6 shrink-0 place-items-center text-faint">
        <Plus size={14} strokeWidth={1.9} />
      </span>
      <div className="relative mt-[3px]">
        <input
          // biome-ignore lint/a11y/noAutofocus: 点了「添加属性」就是要打名字
          autoFocus
          value={draft}
          placeholder="属性名"
          aria-label="新属性的名字"
          onFocus={hints.show}
          onChange={(event) => {
            setDraft(event.target.value);
            hints.show();
          }}
          onBlur={() => {
            hints.hide();
            if (draft.trim()) submit(draft);
            else onCancel();
          }}
          onKeyDown={(event) => {
            const picked = hints.key(event);
            if (picked !== null) {
              submit(picked);
              return;
            }
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit(draft);
            }
            if (event.key === "Escape") onCancel();
          }}
          className="h-[26px] w-[200px] rounded-[5px] border border-accent bg-canvas px-1.5 text-[13px] text-ink outline-none placeholder:text-faint"
        />
        {hints.open && (
          <SuggestionList
            items={hints.items}
            active={hints.active}
            onPick={submit}
            render={(item) => {
              const kind = (kinds.get(item) ?? "text") as Kind;
              const Icon = (KIND_META[kind] ?? KIND_META.text).icon;
              return (
                <>
                  <Icon size={12} strokeWidth={1.9} className="shrink-0 text-faint" />
                  <span className="min-w-0 flex-1 truncate">{item}</span>
                  <span className="shrink-0 text-[11px] text-faint tabular-nums">
                    {counts.get(item)}
                  </span>
                </>
              );
            }}
          />
        )}
      </div>
    </div>
  );
}

/* ---------------- 源码 ---------------- */

function SourceEditor({
  text,
  editable,
  autoFocus,
  onCommit,
  onCancel,
}: {
  text: string;
  editable: boolean;
  autoFocus: boolean;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const rows = Math.max(2, draft.split("\n").length);
  return (
    <div className="flex flex-col gap-1.5 px-2">
      <textarea
        // biome-ignore lint/a11y/noAutofocus: 点了「源码」就是要改
        autoFocus={autoFocus}
        value={draft}
        readOnly={!editable}
        rows={rows}
        spellCheck={false}
        aria-label="属性（YAML）"
        placeholder="status: 进行中"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            onCommit(draft);
          }
          if (event.key === "Escape") {
            setDraft(text);
            onCancel();
          }
        }}
        className="w-full resize-none rounded-lg border border-line-strong bg-panel px-3 py-2 font-mono text-[13px] leading-[1.7]
                   text-body outline-none focus:border-accent"
      />
      {editable && (
        <div className="flex items-center gap-2 text-[12px] text-faint">
          <span className="flex-1">Ctrl + Enter 存，Esc 不改了</span>
          <button
            type="button"
            onClick={() => {
              setDraft(text);
              onCancel();
            }}
            className="h-7 rounded-md px-2.5 text-muted hover:bg-raised hover:text-ink"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onCommit(draft)}
            disabled={draft === text}
            className="h-7 rounded-md border border-line-strong bg-canvas px-2.5 text-body hover:bg-panel disabled:opacity-50"
          >
            存好
          </button>
        </div>
      )}
    </div>
  );
}
