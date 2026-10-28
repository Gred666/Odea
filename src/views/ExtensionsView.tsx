import { OverlayScrollbar } from "@/components/OverlayScrollbar";
import {
  type CatalogExtension,
  type ExtensionCategory,
  localExtensionCatalog,
} from "@/extensions/catalog";
import { cn } from "@/lib/cn";
import { Download, PackageOpen, Search, ShieldCheck, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const CATEGORY_LABEL: Record<"all" | ExtensionCategory, string> = {
  all: "全部",
  editor: "编辑器",
  appearance: "外观",
  productivity: "效率",
  integration: "集成",
};

export function ExtensionsView() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [extensions, setExtensions] = useState<CatalogExtension[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | ExtensionCategory>("all");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    setExtensions(await localExtensionCatalog.list());
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return extensions.filter(
      (extension) =>
        (category === "all" || extension.category === category) &&
        (!keyword ||
          extension.name.toLowerCase().includes(keyword) ||
          extension.summary.toLowerCase().includes(keyword) ||
          extension.author.toLowerCase().includes(keyword)),
    );
  }, [category, extensions, query]);

  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      const extension = await localExtensionCatalog.importPackage(file);
      await reload();
      setMessage(`已导入「${extension.name}」`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "扩展包导入失败");
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    // 和 DocumentView 用同一套：原生滚动条不画也不占位，滑块自己叠一个。
    // relative 必须在滚动容器这一层，滑块才贴得住它的右边缘。
    <div className="relative h-full bg-canvas">
      <div ref={scrollRef} className="scroll-none h-full overflow-y-auto">
        <main className="mx-auto w-full max-w-[1120px] px-14 pt-[58px] pb-16">
          <header className="flex items-start justify-between gap-8">
            <div>
              <h1 className="text-[38px] font-bold leading-tight tracking-[-0.025em] text-ink">
                扩展
              </h1>
              <p className="mt-2 text-[13px] text-muted">下载社区扩展，或导入待发布的扩展清单。</p>
            </div>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="flex h-9 items-center gap-2 rounded-lg bg-ink px-3.5 text-[13px]
                       font-medium text-canvas transition-opacity hover:opacity-85"
            >
              <Upload size={14} />
              上传扩展
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".json,.odeax,.otwx,application/json"
              className="hidden"
              onChange={(event) => void importFile(event.target.files?.[0])}
            />
          </header>

          <div className="mt-8 flex items-center gap-3 border-y border-line py-4">
            <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-panel px-3">
              <Search size={14} className="text-faint" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索扩展、作者或功能"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none"
              />
            </label>
            <div className="flex items-center gap-1 rounded-lg bg-panel p-1">
              {(Object.keys(CATEGORY_LABEL) as ("all" | ExtensionCategory)[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setCategory(value)}
                  className={cn(
                    "rounded-md px-2.5 py-1.5 text-[12px] transition-colors",
                    category === value
                      ? "bg-canvas font-medium text-ink shadow-card"
                      : "text-muted",
                  )}
                >
                  {CATEGORY_LABEL[value]}
                </button>
              ))}
            </div>
          </div>

          {message && (
            <button
              type="button"
              onClick={() => setMessage(null)}
              className="mt-4 w-full rounded-lg bg-accent-wash px-3 py-2 text-left text-[12px] text-accent"
            >
              {message}
            </button>
          )}

          {loading ? (
            <p className="py-16 text-center text-[13px] text-muted">正在加载扩展目录…</p>
          ) : visible.length === 0 ? (
            <div className="grid place-items-center py-20 text-center">
              <PackageOpen size={28} className="text-faint" />
              <p className="mt-3 text-[13px] text-muted">没有匹配的扩展</p>
            </div>
          ) : (
            <section className="mt-6 grid grid-cols-1 gap-3 lg:grid-cols-2">
              {visible.map((extension) => (
                <ExtensionCard
                  key={`${extension.source}-${extension.id}`}
                  extension={extension}
                  onDownload={() => void localExtensionCatalog.download(extension)}
                  onRemove={
                    extension.source === "local"
                      ? async () => {
                          await localExtensionCatalog.removeLocal(extension.id);
                          await reload();
                        }
                      : undefined
                  }
                />
              ))}
            </section>
          )}
        </main>
      </div>
      <OverlayScrollbar targetRef={scrollRef} />
    </div>
  );
}

function ExtensionCard({
  extension,
  onDownload,
  onRemove,
}: {
  extension: CatalogExtension;
  onDownload: () => void;
  onRemove?: () => Promise<void>;
}) {
  return (
    <article className="flex min-h-[174px] flex-col rounded-xl border border-line-strong bg-panel/55 p-5">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-wash text-accent">
          <PackageOpen size={20} strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold text-ink">{extension.name}</h2>
            {extension.verified && <ShieldCheck size={14} className="shrink-0 text-success" />}
          </div>
          <p className="mt-0.5 text-[12px] text-muted">
            {extension.author} · v{extension.version}
          </p>
        </div>
      </div>
      <p className="mt-4 line-clamp-2 text-[13px] leading-[1.7] text-muted">{extension.summary}</p>
      <div className="mt-auto flex items-end justify-between gap-3 pt-4">
        <span className="rounded bg-raised/60 px-2 py-1 text-[12px] text-muted">
          {CATEGORY_LABEL[extension.category]}
        </span>
        <div className="flex items-center gap-1.5">
          {onRemove && (
            <button
              type="button"
              aria-label="删除本地扩展"
              onClick={() => void onRemove()}
              className="grid h-8 w-8 place-items-center rounded-lg text-faint hover:bg-danger/10 hover:text-danger"
            >
              <Trash2 size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={onDownload}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-raised px-3 text-[12px]
                       font-medium text-ink hover:bg-line-strong"
          >
            <Download size={14} />
            下载
          </button>
        </div>
      </div>
    </article>
  );
}
