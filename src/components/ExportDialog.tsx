import { type ExportDialogState, useApp } from "@/app/store";
import { UNSORTED, folderLabel, isLogical, rootLabel, smartQuery } from "@/data/folders";
import { useData } from "@/data/store";
import {
  type Align,
  DEFAULT_PAGE_SETUP,
  MARGINS,
  type MarginId,
  PAPERS,
  type PageSetup,
  type PaperId,
  TOKENS,
  loadPageSetup,
  marginPreview,
  marginsOf,
  paperSize,
  savePageSetup,
  today,
} from "@/export/pageSetup";
import { cn } from "@/lib/cn";
import { popoverCard, tween } from "@/lib/motion";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  FileDown,
  FolderOutput,
  type LucideIcon,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DialogLead, usePaletteBack } from "./PaletteBack";
import { Segmented } from "./Segmented";

/* ============================================================
   导出对话框，两种（app/store 的 exportDialog）：

   - 页面设置（命令面板「PDF 页面设置…」、状态栏导出菜单）：纸张、方向、页边距、页眉、页脚，
     改了就记下（export/pageSetup.ts，记在本机），以后导出 PDF 都按它。右边一张小样张跟着变
   - 导出整个文件夹（文件夹的菜单、命令面板）：PDF 合成一份（每篇另起一页、前面有目录），
     或者网页（一个文件夹，每篇一页，外加 index.html）；选 PDF 时页面设置就在下面

   外壳和回收站一样：遮罩 + 从上往下展开的实心卡片（popoverCard）
   ============================================================ */

const HEADER = 52;

export function ExportDialog() {
  const state = useApp((s) => s.exportDialog);
  const setState = useApp((s) => s.setExportDialog);
  const open = state !== null;
  const close = () => setState(null);
  const back = usePaletteBack("export", open, close);
  // 收起动画那 0.2 秒里还画关之前的样子
  const [shown, setShown] = useState<ExportDialogState | null>(state);
  if (state && state !== shown) setShown(state);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        if (back) back();
        else setState(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setState, back]);

  const folderMode = shown?.kind === "folder";
  const title = folderMode ? "导出文件夹" : "PDF 页面设置";
  return (
    <AnimatePresence>
      {open && shown && (
        <>
          {/* 遮罩和面板分开：见 CommandPalette 里的说明（backdrop-filter 和 opacity 的坑） */}
          <motion.button
            key="scrim"
            type="button"
            data-ghost-skip
            aria-label={`关闭${title}`}
            onClick={close}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={tween.base}
            className="fixed inset-0 z-50 cursor-default bg-ink/[0.14] backdrop-blur-[3px]"
          />
          <div
            key="panel"
            data-ghost-skip
            className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label={title}
              custom={HEADER}
              variants={popoverCard}
              initial="hidden"
              animate="shown"
              exit="gone"
              className="pointer-events-auto relative flex max-h-[80vh] w-[600px] max-w-[calc(100vw-48px)]
                         flex-col overflow-clip rounded-2xl bg-canvas shadow-modal ring-1 ring-line-strong"
            >
              <div
                className="flex shrink-0 items-center gap-2.5 border-b border-line px-4"
                style={{ height: HEADER }}
              >
                <DialogLead icon={folderMode ? FolderOutput : FileDown} back={back} />
                <p className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{title}</p>
                <button
                  type="button"
                  aria-label="关闭"
                  onClick={close}
                  className="grid h-7 w-7 place-items-center rounded-md text-muted
                             transition-colors duration-[140ms] hover:bg-raised hover:text-ink"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </div>
              {shown.kind === "folder" ? (
                <FolderBody initial={shown.folder} onDone={close} />
              ) : (
                <PageBody onDone={close} />
              )}
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

/** 页面设置：改了就存 */
function usePageSetup(): [PageSetup, (patch: Partial<PageSetup>) => void, () => void] {
  const [setup, setSetup] = useState(loadPageSetup);
  const update = (patch: Partial<PageSetup>) => {
    setSetup((current) => {
      const next = { ...current, ...patch };
      savePageSetup(next);
      return next;
    });
  };
  const reset = () => {
    savePageSetup(DEFAULT_PAGE_SETUP);
    setSetup(DEFAULT_PAGE_SETUP);
  };
  return [setup, update, reset];
}

function PageBody({ onDone }: { onDone: () => void }) {
  const [setup, update, reset] = usePageSetup();
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <PageSetupFields setup={setup} update={update} sampleTitle="笔记的标题" />
      </div>
      <Footer>
        <TextButton onClick={reset}>恢复默认</TextButton>
        <span className="flex-1" />
        <PrimaryButton onClick={onDone}>完成</PrimaryButton>
      </Footer>
    </>
  );
}

function FolderBody({ initial, onDone }: { initial: string; onDone: () => void }) {
  const folders = useData((s) => s.folders);
  const notes = useData((s) => s.notes);
  const [folder, setFolder] = useState(initial);
  const [format, setFormat] = useState<"pdf" | "html">("pdf");
  const [toc, setToc] = useState(true);
  const [setup, update] = usePageSetup();
  // 可选的文件夹：树根、真的文件夹（智能文件夹是筛选，不导出）、逻辑目录的「未整理」
  const choices = useMemo(
    () => [
      "",
      ...folders.filter((path) => smartQuery(path) === undefined),
      ...(isLogical() ? [UNSORTED] : []),
    ],
    [folders],
  );
  // 有几篇（连同子文件夹）：export/document.ts 的 folderNotes，用到才加载
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    void notes;
    void import("@/export/document").then((module) => {
      if (alive) setCount(module.folderNotes(folder).length);
    });
    return () => {
      alive = false;
    };
  }, [folder, notes]);

  const start = () => {
    onDone();
    void import("@/export/document").then((module) => module.exportFolder({ folder, format, toc }));
  };

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="flex flex-col gap-3">
          <Field label="文件夹">
            <select
              aria-label="导出哪个文件夹"
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              className={SELECT}
            >
              {choices.map((path) => (
                <option key={path} value={path}>
                  {path === "" ? rootLabel() : folderLabel(path)}
                </option>
              ))}
            </select>
            <span className="text-[12px] text-muted">
              {count === null ? "" : count ? `${count} 篇，连同子文件夹里的` : "这里还没有笔记"}
            </span>
          </Field>
          <Field label="格式">
            <Segmented
              group="export-format"
              size="sm"
              value={format}
              onChange={setFormat}
              options={[
                { value: "pdf", label: "PDF" },
                { value: "html", label: "网页" },
              ]}
            />
          </Field>
          <p className="pl-[68px] text-[12px] leading-[1.6] text-muted">
            {format === "pdf"
              ? "合成一份 PDF：每篇另起一页，篇和篇之间的双链能点过去"
              : "一个文件夹：每篇一个网页，子文件夹照原样；打开 index.html 是目录，篇和篇之间的双链能点过去"}
          </p>
          {format === "pdf" && (
            <label className="flex cursor-pointer items-center gap-2 pl-[68px] text-[13px] text-body">
              <input
                type="checkbox"
                checked={toc}
                onChange={(event) => setToc(event.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              开头放一页目录
            </label>
          )}
        </div>
        {format === "pdf" && (
          <div className="mt-4 border-t border-line pt-4">
            <PageSetupFields
              setup={setup}
              update={update}
              sampleTitle={folder === "" ? rootLabel() : folderLabel(folder)}
            />
          </div>
        )}
      </div>
      <Footer>
        <span className="flex-1" />
        <TextButton onClick={onDone}>取消</TextButton>
        <PrimaryButton onClick={start} disabled={!count}>
          导出…
        </PrimaryButton>
      </Footer>
    </>
  );
}

const SELECT =
  "h-8 rounded-md border border-line-strong bg-canvas px-2 text-[13px] text-body outline-none focus-visible:border-accent";

const ALIGNS: { value: Align; icon: LucideIcon; title: string }[] = [
  { value: "left", icon: AlignLeft, title: "靠左" },
  { value: "center", icon: AlignCenter, title: "居中" },
  { value: "right", icon: AlignRight, title: "靠右" },
];

/** 纸张、方向、页边距、页眉、页脚，右边一张小样张 */
function PageSetupFields({
  setup,
  update,
  sampleTitle,
}: {
  setup: PageSetup;
  update: (patch: Partial<PageSetup>) => void;
  /** 样张上 {标题} 显示成什么 */
  sampleTitle: string;
}) {
  const headerRef = useRef<HTMLInputElement>(null);
  const footerRef = useRef<HTMLInputElement>(null);
  /** 「插入」点的是上次在哪一行里 */
  const lastField = useRef<"header" | "footer">("footer");

  const insert = (token: string) => {
    // 按钮按下时不抢焦点（onMouseDown），焦点还在哪一行就插在哪一行；都不在就是上次在的那一行
    const active = headerRef.current?.ownerDocument.activeElement;
    const which =
      active === headerRef.current
        ? "header"
        : active === footerRef.current
          ? "footer"
          : lastField.current;
    lastField.current = which;
    const input = (which === "header" ? headerRef : footerRef).current;
    const value = setup[which];
    const from = input?.selectionStart ?? value.length;
    const to = input?.selectionEnd ?? value.length;
    update({ [which]: value.slice(0, from) + token + value.slice(to) });
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(from + token.length, from + token.length);
    });
  };

  const marginLine = (which: "header" | "footer") => {
    const alignKey = which === "header" ? "headerAlign" : "footerAlign";
    return (
      <Field label={which === "header" ? "页眉" : "页脚"}>
        <input
          ref={which === "header" ? headerRef : footerRef}
          value={setup[which]}
          placeholder="不要"
          spellCheck={false}
          onFocus={() => {
            lastField.current = which;
          }}
          onChange={(event) => update({ [which]: event.target.value })}
          className="h-8 min-w-0 flex-1 rounded-md border border-line-strong bg-canvas px-2 text-[13px]
                     text-body outline-none placeholder:text-faint focus-visible:border-accent"
        />
        <Segmented
          group={`export-${which}-align`}
          size="sm"
          value={setup[alignKey]}
          onChange={(value) => update({ [alignKey]: value })}
          options={ALIGNS.map(({ value, icon: Icon, title }) => ({
            value,
            title,
            label: <Icon size={14} strokeWidth={2} aria-label={title} />,
          }))}
        />
      </Field>
    );
  };

  return (
    <div className="flex gap-5">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <Field label="纸张">
          <select
            aria-label="纸张"
            value={setup.paper}
            onChange={(event) => update({ paper: event.target.value as PaperId })}
            className={SELECT}
          >
            {PAPERS.map((paper) => (
              <option key={paper.id} value={paper.id}>
                {`${paper.label}（${paper.size[0]} × ${paper.size[1]} 毫米）`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="方向">
          <Segmented
            group="export-orientation"
            size="sm"
            value={setup.landscape ? "landscape" : "portrait"}
            onChange={(value) => update({ landscape: value === "landscape" })}
            options={[
              { value: "portrait", label: "纵向" },
              { value: "landscape", label: "横向" },
            ]}
          />
        </Field>
        <Field label="页边距">
          <Segmented
            group="export-margin"
            size="sm"
            value={setup.margin}
            onChange={(value: MarginId) => update({ margin: value })}
            options={MARGINS.map((margin) => ({
              value: margin.id,
              label: margin.label,
              title: `上 ${margin.mm[0]}、左右 ${margin.mm[1]}、下 ${margin.mm[2]} 毫米`,
            }))}
          />
        </Field>
        {marginLine("header")}
        {marginLine("footer")}
        <div className="flex flex-wrap items-center gap-1.5 pl-[68px] text-[12px] text-muted">
          <span>可以写：</span>
          {TOKENS.map((token) => (
            <button
              key={token}
              type="button"
              // 按下不抢输入框的焦点：插在光标那里
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insert(token)}
              className="rounded border border-line-strong px-1.5 py-px text-[12px] text-body
                         transition-colors duration-[120ms] hover:bg-raised"
            >
              {token}
            </button>
          ))}
        </div>
      </div>
      <PaperPreview setup={setup} title={sampleTitle} />
    </div>
  );
}

/** 小样张：纸的比例、页边距、页眉页脚在哪、写的什么（{页码} 写成 1） */
function PaperPreview({ setup, title }: { setup: PageSetup; title: string }) {
  const [width, height] = paperSize(setup);
  const [top, right, bottom, left] = marginsOf(setup);
  const scale = 168 / Math.max(width, height);
  const px = (mm: number) => Math.round(mm * scale);
  const date = today();
  const header = marginPreview(setup.header, title, date);
  const footer = marginPreview(setup.footer, title, date);
  const text = (value: string, align: Align, edge: "top" | "bottom") =>
    value.trim() && (
      <span
        className="absolute truncate text-[7px] leading-none text-muted"
        style={{
          left: px(left),
          right: px(right),
          textAlign: align,
          [edge]: Math.max(2, Math.round((px(edge === "top" ? top : bottom) - 7) / 2)),
        }}
      >
        {value}
      </span>
    );
  return (
    <div className="flex w-[176px] shrink-0 items-start justify-center pt-1" aria-hidden="true">
      <div
        className="relative border border-line-strong bg-white"
        style={{ width: px(width), height: px(height) }}
      >
        {text(header, setup.headerAlign, "top")}
        <div
          className="absolute flex flex-col gap-[5px] overflow-hidden"
          style={{ top: px(top), right: px(right), bottom: px(bottom), left: px(left) }}
        >
          <span className="h-[5px] w-2/3 rounded-sm bg-[#d6d6ce]" />
          {Array.from({ length: 40 }, (_, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: 样张上一排排灰条，没有身份
              key={index}
              className="h-[3px] shrink-0 rounded-sm bg-[#ececE6]"
              style={{ width: index % 6 === 5 ? "55%" : "100%" }}
            />
          ))}
        </div>
        {text(footer, setup.footerAlign, "bottom")}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2">
      <span className="w-[60px] shrink-0 text-[13px] text-muted">{label}</span>
      {children}
    </div>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">
      {children}
    </div>
  );
}

function TextButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-8 rounded-md px-3 text-[13px] text-muted transition-colors duration-[120ms] hover:bg-raised hover:text-ink"
    >
      {children}
    </button>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "h-8 rounded-md bg-accent px-4 text-[13px] font-medium text-accent-ink",
        "transition-colors duration-[120ms] hover:bg-accent-hover disabled:opacity-50",
      )}
    >
      {children}
    </button>
  );
}
