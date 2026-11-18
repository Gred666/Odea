import { openDocument } from "@/app/navigate";
import { messageOf } from "@/data/store";
import { cn } from "@/lib/cn";
import { KIND_META, ValueCell } from "@/properties/PropertiesPanel";
import { type Entry, fitsKind, isListKind } from "@/properties/yaml";
import { type KeyboardEvent as ReactKeyboardEvent, useRef } from "react";
import { ValueView } from "./ValueView";
import type { Cell, KindHints, PropRef, Row } from "./query";
import { kindOfEntry, propRef } from "./query";
import { writeProperty } from "./write";

/* ============================================================
   一格（表格、卡片、列表共用）：看的时候画值，能改的点一下进属性面板的那个编辑器（ValueCell）。
   改完经 bases/write.ts 写回那一篇属性块里的那一行
   ============================================================ */

export interface CellContext {
  hints: KindHints;
  /** 整个仓库这个键常见的值（提示） */
  suggestions: (key: string) => string[];
  onError: (message: string) => void;
}

/** 空着的格子：按记着的 / 仓库里多半的类型给编辑器 */
function emptyEntry(key: string): Entry {
  return { key, start: 0, end: 0, shape: "scalar", value: "", items: [], flow: false };
}

/** 这一格能不能改、按什么类型改 */
export function editing(row: Row, raw: string, context: CellContext) {
  const ref = propRef(raw);
  if (ref.ns !== "note" || row.doc.notUtf8) return null;
  const entry = row.parsed.entries.find((item) => item.key === ref.name) ?? emptyEntry(ref.name);
  // 空着的格子（这一篇没写这一条）：kindOf 看记着的、仓库里多半的
  const kind = kindOfEntry(entry, context.hints);
  if (kind === "complex") return null;
  return { ref, entry, kind, mismatch: !fitsKind(entry, kind) };
}

/** 名称那一列：标题，点了打开（Ctrl / 中键开新标签） */
export function NameCell({ row, className }: { row: Row; className?: string }) {
  const open = (newTab: boolean) => openDocument(row.doc.target, undefined, newTab);
  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={(event) => {
        event.stopPropagation();
        open(event.ctrlKey || event.metaKey);
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        open(true);
      }}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      title={`${row.source.path}（Ctrl + 点开在新标签）`}
      className={cn(
        "min-w-0 truncate text-left font-medium text-ink decoration-line-strong underline-offset-[3px] hover:underline",
        className,
      )}
    >
      {row.source.title}
    </button>
  );
}

const isName = (ref: PropRef) =>
  ref.ns === "file" && (ref.name === "name" || ref.name === "basename");

/**
 * 一格：看的时候画值；editingNow 时换成属性面板的编辑器。done：编辑结束（存了、Esc、点到别处）
 */
export function CellBody({
  row,
  raw,
  cell,
  context,
  editingNow,
  onEdit,
  onDone,
}: {
  row: Row;
  raw: string;
  cell: Cell;
  context: CellContext;
  editingNow: boolean;
  onEdit: () => void;
  onDone: (refocus: boolean) => void;
}) {
  const ref = propRef(raw);
  const box = useRef<HTMLDivElement>(null);
  if (isName(ref)) return <NameCell row={row} />;
  const edit = editing(row, raw, context);
  const commit = (value: string | string[]) => {
    if (!edit) return;
    // 类型不符的那一格按文字改，写回时 write.ts 照值读不读得了决定写法
    writeProperty(row.doc.target, edit.ref.name, edit.kind, value).catch((error) =>
      context.onError(messageOf(error)),
    );
  };
  if (edit && editingNow) {
    return (
      <div
        ref={box}
        className="relative z-10 -mx-1.5 min-w-0 flex-1"
        onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (next && box.current?.contains(next)) return;
          // 失焦到别处（点了别的）不抢焦点；Enter / Esc 以后焦点落在 body 上，还给这一格
          onDone(next === null);
        }}
        onKeyDown={(event: ReactKeyboardEvent) => event.stopPropagation()}
      >
        <ValueCell
          entry={edit.entry}
          kind={edit.kind}
          misfit={edit.mismatch ? `类型不符：这个值不是${KIND_META[edit.kind].label}` : ""}
          editable
          autoFocus
          suggestions={context.suggestions(edit.ref.name)}
          onFocused={() => {}}
          onCommit={commit}
          onSource={() => {}}
        />
      </div>
    );
  }
  // 勾选：直接点一下就换，不进编辑
  if (edit && edit.kind === "checkbox" && !edit.mismatch) {
    const checked = cell.value === true;
    return (
      <button
        type="button"
        tabIndex={-1}
        role="checkbox"
        aria-checked={checked}
        aria-label={edit.ref.name}
        onClick={(event) => {
          event.stopPropagation();
          commit(checked ? "false" : "true");
        }}
        className="grid h-6 w-6 place-items-center rounded-md hover:bg-raised"
      >
        <ValueView value={checked} />
      </button>
    );
  }
  return (
    // 键盘进编辑归整张表管（Enter，见 TableView 的 onKeyDown）；这里只接鼠标
    // biome-ignore lint/a11y/useKeyWithClickEvents: 同上
    <div
      className={cn(
        "flex h-full min-w-0 flex-1 items-center",
        edit ? "cursor-text" : "cursor-default",
        isListKind(edit?.kind ?? "text") && "overflow-hidden",
      )}
      onClick={edit ? onEdit : undefined}
    >
      <ValueView value={cell.value} error={cell.error} />
    </div>
  );
}
