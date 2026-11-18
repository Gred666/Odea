import { vaultFileSrc } from "@/data/attachments";
import { useData } from "@/data/store";
import { cn } from "@/lib/cn";
import { IMAGE_FILE_RE, resolveVaultFile } from "@/lib/wikiFiles";
import { useState } from "react";
import { Card } from "./BoardView";
import { ValueView } from "./ValueView";
import { NameCell } from "./cells";
import type { BaseConfig, ViewConfig } from "./config";
import { BLink, type Value, toText } from "./expr";
import { type Group, type Row, type ViewResult, propLabel } from "./query";

/* ============================================================
   卡片、列表（docs/视图文件.md §3.6）：和表格同一份结果，换个排法。分组时每组一段。
   先画一页，多的点「再显示」：几千张卡片不一次画完
   ============================================================ */

const PAGE = 200;

function useCover(row: Row, value: Value): string | null {
  const vaultRoot = useData((s) => s.vaultRoot);
  const attachments = useData((s) => s.attachments);
  const first = Array.isArray(value) ? value[0] : value;
  if (first === null || first === undefined) return null;
  const name = first instanceof BLink ? first.target : toText(first).replace(/^!?\[\[|\]\]$/g, "");
  if (/^https?:\/\//.test(name)) return name;
  if (!IMAGE_FILE_RE.test(name)) return null;
  const rel = resolveVaultFile(name, row.source.path, attachments);
  return rel ? vaultFileSrc(vaultRoot, rel) : null;
}

function Cover({ row, image, result }: { row: Row; image: string; result: ViewResult }) {
  const src = useCover(row, result.cell(row, image).value);
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <div className="h-[120px] rounded-t-lg bg-panel" />;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setBroken(true)}
      className="h-[120px] w-full rounded-t-lg object-cover"
    />
  );
}

function Sections({
  result,
  config,
  view,
  children,
}: {
  result: ViewResult;
  config: BaseConfig;
  view: ViewConfig;
  children: (rows: Row[]) => React.ReactNode;
}) {
  const [shown, setShown] = useState(PAGE);
  const groups: Group[] = result.groups ?? [{ key: "", value: null, rows: result.rows }];
  let budget = shown;
  const total = result.rows.length;
  return (
    <div className="flex flex-col gap-6 pb-10">
      {groups.map((group) => {
        const rows = group.rows.slice(0, Math.max(0, budget));
        budget -= rows.length;
        if (result.groups && rows.length === 0 && group.rows.length > 0) return null;
        return (
          <section key={group.key ?? "\u0000"} className="flex flex-col gap-2">
            {result.groups && (
              <h3 className="flex h-7 items-center gap-1.5 text-[13px] font-medium text-ink">
                {group.key === null ? (
                  <span className="text-muted">
                    没有{propLabel(config, view.groupBy?.property ?? "")}
                  </span>
                ) : (
                  <ValueView value={group.value ?? group.key} />
                )}
                <span className="text-[12px] font-normal tabular-nums text-faint">
                  {group.rows.length}
                </span>
              </h3>
            )}
            {children(rows)}
          </section>
        );
      })}
      {total > shown && (
        <button
          type="button"
          onClick={() => setShown((current) => current + PAGE)}
          className="h-9 self-start rounded-md px-3 text-[13px] text-muted ring-1 ring-line-strong hover:bg-raised hover:text-ink"
        >
          再显示 {Math.min(PAGE, total - shown)} 篇（还有 {total - shown} 篇）
        </button>
      )}
    </div>
  );
}

export function CardsView({
  result,
  config,
  view,
  fields,
}: {
  result: ViewResult;
  config: BaseConfig;
  view: ViewConfig;
  fields: string[];
}) {
  return (
    <Sections result={result} config={config} view={view}>
      {(rows) => (
        <ul
          className="grid gap-3"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
        >
          {rows.map((row) => (
            <li
              key={row.key}
              className="flex min-w-0 flex-col overflow-hidden rounded-lg bg-canvas shadow-card ring-1 ring-line"
              style={{ contentVisibility: "auto", containIntrinsicSize: "auto 160px" }}
            >
              {view.image && <Cover row={row} image={view.image} result={result} />}
              <div className="px-3 py-2.5">
                <Card row={row} fields={fields} config={config} result={result} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Sections>
  );
}

export function ListView({
  result,
  config,
  view,
  fields,
}: {
  result: ViewResult;
  config: BaseConfig;
  view: ViewConfig;
  fields: string[];
}) {
  const rest = fields.filter((raw) => raw !== "file.name" && raw !== "file.basename");
  return (
    <Sections result={result} config={config} view={view}>
      {(rows) => (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <li
              key={row.key}
              className={cn("flex h-9 min-w-0 items-center gap-2 border-b border-line text-[14px]")}
              style={{ contentVisibility: "auto", containIntrinsicSize: "auto 36px" }}
            >
              <span aria-hidden="true" className="h-1 w-1 shrink-0 rounded-full bg-faint" />
              <NameCell row={row} className="shrink-0" />
              {rest.map((raw) => {
                const cell = result.cell(row, raw);
                if (cell.value === null && !cell.error) return null;
                return (
                  <span
                    key={raw}
                    className="flex min-w-0 items-center gap-2 text-[13px] text-muted"
                  >
                    <span aria-hidden="true" className="text-faint">
                      ·
                    </span>
                    <ValueView value={cell.value} error={cell.error} />
                  </span>
                );
              })}
            </li>
          ))}
        </ul>
      )}
    </Sections>
  );
}
