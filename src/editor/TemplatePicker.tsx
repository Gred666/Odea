import { cn } from "@/lib/cn";
import { animatedEmojiText } from "@/lib/emojiText";
import { renderMarkdown } from "@/lib/markdown";
import { layoutIds, popoverCard, spring, tween } from "@/lib/motion";
import { ArrowDown, ArrowUp, CornerDownLeft, LayoutTemplate } from "lucide-react";
import { motion, useIsPresent } from "motion/react";
import {
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type EmojiPickerAnchor,
  type Placement,
  pinnedEdge,
  placePicker,
  samePlacement,
  viewportSize,
} from "./EmojiPicker";
import {
  CARET,
  type DocTemplate,
  type TemplateContext,
  type TemplateMode,
  scopeLabel,
} from "./templates";

/* ============================================================
   模板选择器（在一行里输入 `/模板`）。

   和动态表情选择器不同，焦点一直留在正文里 —— 像自动补全：触发词是在编辑器里
   打出来的，接着打字、退格、点到别处，选择器自己就收起（MarkdownEditor 盯着触发词
   那一行）。方向键、回车、Esc 由编辑器的按键转过来（TemplatePickerHandle）；
   中文输入法组字时的按键不转。

   左边是这篇文档能用的模板，右边是当前那一个的缩略预览（按今天的日期现算）。
   ============================================================ */

export interface TemplatePickerHandle {
  move: (step: 1 | -1) => void;
  pick: (mode: TemplateMode) => void;
}

/** 列表 + 预览那一块的高度。矮窗口里放不下时会被压矮（placePicker） */
const BODY_HEIGHT = 252;
/** 面板尺寸（和类名一致：w-[540px]，标题栏 36 + 主体 + 底栏 32） */
const PANEL_WIDTH = 540;
const HEADER_HEIGHT = 36;
const FOOTER_HEIGHT = 32;
const PANEL_HEIGHT = HEADER_HEIGHT + BODY_HEIGHT + FOOTER_HEIGHT;
const NUDGE = 12;
/** 预览按这个比例缩小，像一页纸的缩略图 */
const PREVIEW_SCALE = 0.6;

export function TemplatePicker({
  anchor,
  context,
  templates,
  replaceable,
  carried,
  handleRef,
  onPick,
  onClose,
}: {
  anchor: EmojiPickerAnchor;
  context: TemplateContext;
  templates: DocTemplate[];
  /** 触发词之外正文里还有内容：可以「替换全文」 */
  replaceable: boolean;
  /** 替换全文时会带进「待续」的未完成任务数 */
  carried: number;
  handleRef: React.RefObject<TemplatePickerHandle | null>;
  onPick: (template: DocTemplate, mode: TemplateMode) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(0);
  // 第一帧就摆在最终位置：入场方向只在挂载时取一次（同表情选择器）
  const [place, setPlace] = useState<Placement>(() => {
    const viewport = viewportSize();
    return placePicker(anchor, {
      width: Math.min(PANEL_WIDTH, viewport.width - 16),
      height: PANEL_HEIGHT,
      grid: BODY_HEIGHT,
      viewport,
      nudge: NUDGE,
    });
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const current = templates[active];

  const pick = (template: DocTemplate | undefined, mode: TemplateMode) => {
    if (template) onPick(template, replaceable ? mode : "insert");
  };

  useImperativeHandle(handleRef, () => ({
    move: (step) => setActive((index) => (index + step + templates.length) % templates.length),
    pick: (mode) => pick(templates[active], mode),
  }));

  // 贴着触发词摆：下面放不下就翻到上面，都放不下就把列表压矮。按量到的尺寸校正，
  // 和常量算的一样就不动；在绘制之前跑，看不到挪动
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const content = contentRef.current;
    if (!panel || !content) return;
    // 高度量里面的内容：面板自己这时还是入场第一帧那一窄条
    const measured = placePicker(anchor, {
      width: panel.offsetWidth,
      height: content.offsetHeight,
      grid: bodyRef.current?.offsetHeight ?? 0,
      viewport: viewportSize(),
      nudge: NUDGE,
    });
    setPlace((current) => (samePlacement(current, measured) ? current : measured));
  }, [anchor]);

  // 点到外面、滚动、缩放、窗口失焦：锚点已经不对了，收起。
  // 滚动只看滚轮 / 触摸 —— 编辑器为了让刚打的字露出来自己也会滚一下，那不算。
  const present = useIsPresent();
  useEffect(() => {
    if (!present) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && !!panelRef.current?.contains(target);
    const onOutside = (event: Event) => {
      if (!inside(event.target)) onClose();
    };
    document.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("wheel", onOutside, { capture: true, passive: true });
    window.addEventListener("touchmove", onOutside, { capture: true, passive: true });
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", onOutside, true);
      window.removeEventListener("wheel", onOutside, true);
      window.removeEventListener("touchmove", onOutside, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose, present]);

  return (
    // 从触发词那条边展开，里面的字不缩放、不变透明（同表情选择器，lib/motion.ts 的 popoverCard）
    <motion.div
      ref={panelRef}
      role="dialog"
      aria-label="插入模板"
      // 第一帧露出贴着触发词的那一栏：往下开是标题栏，往上开是底栏
      custom={place.above ? FOOTER_HEIGHT : HEADER_HEIGHT}
      variants={popoverCard}
      initial="hidden"
      animate="shown"
      exit="gone"
      // 点在面板上不能让正文失焦：失焦会收起选择器，键盘也就接不上了
      onMouseDown={(event) => event.preventDefault()}
      style={{ ...pinnedEdge(anchor, place), pointerEvents: present ? undefined : "none" }}
      className={cn(
        "odea-template-picker fixed z-50 flex w-[540px] max-w-[calc(100vw-16px)] flex-col overflow-clip",
        "rounded-xl bg-canvas shadow-float ring-1 ring-line-strong",
        place.above && "justify-end",
      )}
    >
      <div ref={contentRef} className="shrink-0">
        <div className="flex h-[36px] items-center gap-2 border-b border-line px-3.5">
          <LayoutTemplate size={13} strokeWidth={1.9} className="shrink-0 text-faint" />
          <span className="text-[12px] font-medium text-body">模板</span>
          <span className="text-faint/60">·</span>
          <span className="truncate text-[12px] text-muted">{scopeLabel(context)}</span>
        </div>

        <div ref={bodyRef} className="flex" style={{ height: place.gridMax ?? BODY_HEIGHT }}>
          <div
            role="listbox"
            aria-label="模板"
            aria-activedescendant={current ? `odea-template-${current.id}` : undefined}
            // 焦点一直在正文里，按键由编辑器转过来；这里只是满足 listbox 可聚焦
            tabIndex={-1}
            className="scroll-thin w-[240px] shrink-0 overflow-y-auto overscroll-contain border-r
                     border-line p-1.5"
          >
            {templates.map((template, index) => {
              const selected = index === active;
              const Icon = template.icon;
              return (
                <button
                  key={template.id}
                  id={`odea-template-${template.id}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  data-template={template.id}
                  onMouseMove={() => {
                    if (!selected) setActive(index);
                  }}
                  onClick={(event) => pick(template, event.shiftKey ? "replace" : "insert")}
                  className="relative flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-left"
                >
                  {/* 退场时撤掉：带 layoutId 的元素会让 Motion 把整个面板多留一会儿 */}
                  {selected && present && (
                    <motion.span
                      layoutId={layoutIds.templateCursor}
                      className="absolute inset-0 rounded-lg bg-accent-wash"
                      transition={spring.snappy}
                    />
                  )}
                  <span
                    className={cn(
                      "relative z-10 grid h-7 w-7 shrink-0 place-items-center rounded-md ring-1",
                      "transition-colors duration-[140ms]",
                      selected
                        ? "bg-canvas text-accent ring-accent-line"
                        : "bg-panel text-muted ring-line-strong",
                    )}
                  >
                    <Icon size={14} strokeWidth={1.9} />
                  </span>
                  <span className="relative z-10 min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-[13px] leading-[18px]",
                        selected ? "font-medium text-ink" : "text-body",
                      )}
                    >
                      {template.name}
                    </span>
                    <span className="block truncate text-[12px] leading-[16px] text-faint">
                      {template.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="relative min-w-0 flex-1 overflow-hidden bg-panel" aria-hidden="true">
            {current && (
              <TemplatePreview
                template={current}
                context={context}
                // 打开时预览和面板一起实心露出来，换模板时才淡入
                fadeIn={current !== templates[0]}
              />
            )}
          </div>
        </div>

        <div className="flex h-[32px] items-center gap-2 border-t border-line px-3.5 text-[12px] text-faint">
          {/* 按键画成图标，不用 ↑↓ ↵ ⇧：正文字体里没有这些字，第一次画它们浏览器要把系统
            字体挨个找一遍，打开选择器就卡一下（表情选择器踩过，见 EmojiPicker） */}
          <span className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap">
            <ArrowUp size={10.5} strokeWidth={2} aria-label="上" />
            <ArrowDown size={10.5} strokeWidth={2} aria-label="下" />
            选择 ·
            <CornerDownLeft size={10.5} strokeWidth={2} aria-label="回车" />
            插入
            {replaceable && (
              <span className="flex items-center gap-1 text-muted">
                · Shift+
                <CornerDownLeft size={10.5} strokeWidth={2} aria-label="回车" />
                <span>
                  替换全文
                  {carried > 0 && <span className="text-faint">，带上 {carried} 项未完成</span>}
                </span>
              </span>
            )}
          </span>
          <span className="ml-auto shrink-0">Esc 关闭</span>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * 当前模板的缩略预览：按这篇文档的日期现算出来，用占位渲染器排成一页纸再缩小。
 * 动态表情短码换成 Unicode（预览里不需要动）。
 */
const TemplatePreview = memo(function TemplatePreview({
  template,
  context,
  fadeIn,
}: {
  template: DocTemplate;
  context: TemplateContext;
  fadeIn: boolean;
}) {
  const body = useMemo(
    () =>
      renderMarkdown(
        animatedEmojiText(template.build(context).replace(CARET, "")),
        `tpl-${template.id}`,
      ),
    [template, context],
  );
  return (
    <motion.div
      key={template.id}
      initial={fadeIn ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={tween.fast}
      className="odea-template-sheet absolute bottom-0 left-4 right-0 top-4 overflow-hidden rounded-tl-lg
                 bg-canvas px-4 pt-3.5 shadow-card ring-1 ring-line-strong"
    >
      <div
        className="prose-doc"
        style={{
          width: `${100 / PREVIEW_SCALE}%`,
          transform: `scale(${PREVIEW_SCALE})`,
          transformOrigin: "0 0",
        }}
      >
        {body}
      </div>
    </motion.div>
  );
});
