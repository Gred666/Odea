import { snapToDevicePixels } from "@/lib/devicePixels";
import { wikiFileTarget } from "@/lib/wikiFiles";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { glideTo, scrollParent } from "./glide";

/* ============================================================
   卡片里的录音、视频滚远了接着放（docs/技术方案.md §11.4.6，实验和设计都在那一节）。

   「一边听录音一边在下面记」：卡片滚出视口一千多像素，CodeMirror 把替身的 DOM 拆了，里面的
   <audio> 从文档里拿下来，内核在下一个任务里查到它不在文档里就暂停 —— 滚回来是一张新卡片、从头、停着。

   这里替 attachmentEmbed.ts 的卡片管播放器（一个编辑器一份，跟着 attachmentHost 这个 facet 来）：
   - 卡片 toDOM 时先向这里要：藏着同一个地址的拿回来（放进还没挂上的新卡片，CodeMirror 同一个任务里
     就挂上，不停），没有才新建
   - 卡片被拆（destroy，那一刻 DOM 还在文档里）时，正在放的、放到一半暂停着的同一个任务里挪进这一栏
     [data-swap-host] 里一个 display: none 的格子（滚动区外面，换篇的快照克隆不到它）；
     同一次重画里刚建的、同一个地址、还没碰过的新卡片，直接换进去（整张重画，比如改了 `|别名`）
   - 没放过的、放完了的不留；暂停藏着的最多 3 个；编辑器拆了（换篇、关这一栏）全部停掉、放掉
   - 正在放的那一个不在眼前时，这一栏底部出一条播放条

   不放东西时只有元素自己身上那几个监听和这个没有 update 的插件：格子、条、IntersectionObserver
   都是第一次要用时才建，用完拆掉
   ============================================================ */

/** 卡片交给这里的：哪个文件、条上显示什么 */
export interface MediaCard {
  /** 附件的地址（VaultFile.src）：藏着的播放器按它认回去 */
  src: string;
  /** 写的名字（`![[录音.m4a]]` 里的「录音.m4a」）：「回到卡片」按它在正文里找那一行 */
  name: string;
  /** 条上显示的名字：别名优先 */
  title: string;
  kind: "audio" | "video";
  /** 类型图标（24×24 的 SVG path，和卡片上的同一个） */
  icon: string;
  /** 卡片多高（量过的；没量过是估计的）：「回到卡片」让整张卡片停在正中 */
  height(): number;
}

interface Entry {
  readonly media: HTMLMediaElement;
  card: MediaCard;
  /** 现在在哪张卡片里；藏在保管处是 null */
  frame: HTMLElement | null;
  /** 最近一次开始放（play 事件）的序号：条上放最近开始的那一个；0 = 没放过 */
  startedAt: number;
  /** 最近一次开始放或暂停的序号：暂停藏着的超过上限时，先放掉最久没放过的 */
  activeAt: number;
  /** IntersectionObserver 报的：卡片里的播放器有一半以上在这一栏的可视区里 */
  visible: boolean;
  /** 上次量到的卡片位置：「回到卡片」在几张同一个文件的卡片里挑离它最近的 */
  pos: number;
}

/** 暂停藏着的最多几个：留着的是缓冲的数据和解码器，视频尤其占 */
const PAUSED_LIMIT = 3;
/** 条离这一栏底边多远、多高（和 globals.css 的 .odea-media-bar 一致）；光标停在它上面再留一点 */
const BAR_BOTTOM = 12;
const BAR_HEIGHT = 40;
const BAR_CLEARANCE = 8;
/** 进度条上 ← / → 一下几秒 */
const SEEK_STEP = 5;
/** 淡出（globals.css 里 100ms）等不到 transitionend 时，最多等多久就拿掉 */
const FADE_OUT_FALLBACK_MS = 600;

/** 事件的先后：同一毫秒里的几次 play / pause 也分得出 */
let sequence = 0;

/** 卡片的 DOM 是哪个保管处管的（destroy(dom) 只给 DOM，找不到编辑器） */
const owners = new WeakMap<HTMLElement, MediaKeeper>();

const playing = (media: HTMLMediaElement) => !media.paused && !media.ended;
/** 值得留：正在放，或者放到一半暂停着（读到一半停下来记笔记，滚回去还在那一秒） */
const worthKeeping = (media: HTMLMediaElement) =>
  !media.ended && (!media.paused || media.currentTime > 0);

/** 停下、去掉地址、load() 一下放掉解码器和缓冲 */
function release(media: HTMLMediaElement) {
  media.pause();
  media.removeAttribute("src");
  media.load();
}

class MediaKeeper {
  /** 这个编辑器建过、还管着的所有播放器（卡片里的和藏着的） */
  private readonly entries = new Map<HTMLMediaElement, Entry>();
  /** 卡片 DOM → 里面那个播放器 */
  private readonly frames = new WeakMap<HTMLElement, Entry>();
  /** 这一次重画里刚建、还没碰过的：整张重画时旧卡片里正在放的换进来 */
  private fresh: Entry[] = [];
  private slot: HTMLElement | null = null;
  private bar: MediaBar | null = null;
  private observer: IntersectionObserver | null = null;
  /** 观察器正在看的 */
  private observed = new WeakSet<HTMLMediaElement>();
  /** 条上的那一个 */
  private shown: Entry | null = null;
  private refreshQueued = false;
  private destroyed = false;

  constructor(private readonly view: EditorView) {}

  /** 卡片 toDOM：把播放器放进 holder。藏着同一个地址的拿回来，没有才用 create 新建 */
  mount(frame: HTMLElement, holder: HTMLElement, card: MediaCard, create: () => HTMLMediaElement) {
    owners.set(frame, this);
    const kept = this.parked(card.src);
    if (kept) {
      kept.card = card;
      kept.frame = frame;
      this.frames.set(frame, kept);
      // 从保管处挪进还没挂上的新卡片：CodeMirror 在同一个任务里把卡片挂进文档，内核来不及停它
      holder.append(kept.media);
      this.tidySlot();
      queueMicrotask(() => this.remember(kept));
      this.schedule();
      return;
    }
    const entry: Entry = {
      media: create(),
      card,
      frame,
      startedAt: 0,
      activeAt: 0,
      visible: true,
      pos: -1,
    };
    this.entries.set(entry.media, entry);
    this.frames.set(frame, entry);
    this.listen(entry);
    holder.append(entry.media);
    // 「这一次重画」到微任务为止：CodeMirror 的一次更新是同步跑完的
    if (!this.fresh.length) {
      queueMicrotask(() => {
        this.fresh = [];
      });
    }
    this.fresh.push(entry);
  }

  /** 卡片 destroy：DOM 还在文档里。值得留的挪走，不值得的放掉 */
  drop(frame: HTMLElement) {
    const entry = this.frames.get(frame);
    this.frames.delete(frame);
    // 已经换进别的卡片里了（整张重画）
    if (!entry || entry.frame !== frame || this.destroyed) return;
    entry.frame = null;
    if (!this.entries.has(entry.media)) return;
    if (!worthKeeping(entry.media)) {
      this.forget(entry);
      return;
    }
    const twin = this.fresh.find(
      (other) =>
        other !== entry &&
        other.frame !== null &&
        other.card.src === entry.card.src &&
        other.startedAt === 0 &&
        other.media.paused &&
        other.media.currentTime === 0 &&
        this.entries.has(other.media),
    );
    if (twin?.frame) {
      // 整张重画：新卡片已经建好、还没挂上，正在放的直接换进去，新建的那个不要了
      const target = twin.frame;
      this.fresh = this.fresh.filter((other) => other !== twin);
      twin.media.replaceWith(entry.media);
      twin.frame = null;
      this.forget(twin);
      entry.card = twin.card;
      entry.frame = target;
      this.frames.set(target, entry);
      queueMicrotask(() => this.remember(entry));
      return;
    }
    this.ensureSlot().append(entry.media);
    this.limitParked();
    this.schedule();
  }

  /** 条显示着时，光标停在条上面（打字、方向键滚过去时 CodeMirror 按这个留边） */
  margins() {
    return this.shown ? { bottom: BAR_BOTTOM + BAR_HEIGHT + BAR_CLEARANCE } : null;
  }

  /** 编辑器拆了（换篇、关这一栏、关窗口）：全部停下、放掉；条淡出 */
  destroy() {
    this.destroyed = true;
    for (const media of this.entries.keys()) release(media);
    this.entries.clear();
    this.fresh = [];
    this.slot?.remove();
    this.slot = null;
    this.unwatchAll();
    this.shown = null;
    this.bar?.hide(true);
    this.bar = null;
  }

  /* ---------- 播放器 ---------- */

  /** 监听只在新建时挂一次，挂在元素自己身上（跟着它进出卡片） */
  private listen(entry: Entry) {
    const { media } = entry;
    const alive = () => !this.destroyed && this.entries.get(media) === entry;
    // 视频的尺寸要等元数据到了才知道：这一行变高了，叫 CodeMirror 重新量
    media.addEventListener("loadedmetadata", () => {
      if (alive() && entry.frame?.isConnected) this.view.requestMeasure();
    });
    media.addEventListener("play", () => {
      if (!alive()) return;
      entry.startedAt = entry.activeAt = ++sequence;
      this.remember(entry);
      this.watch(entry);
      this.schedule();
    });
    media.addEventListener("pause", () => {
      if (!alive()) return;
      entry.activeAt = ++sequence;
      if (entry.frame === null) this.limitParked();
      this.schedule();
    });
    media.addEventListener("ended", () => {
      if (!alive()) return;
      // 放完了：藏着的放掉，卡片里的留着（和以前一样）
      if (entry.frame === null) this.forget(entry);
      this.schedule();
    });
    const progress = () => {
      if (alive() && this.shown === entry) this.bar?.progress(media);
    };
    media.addEventListener("timeupdate", progress);
    media.addEventListener("durationchange", progress);
  }

  /** 藏着的、这个地址的那一个（几个就拿最近放过的） */
  private parked(src: string): Entry | null {
    let best: Entry | null = null;
    for (const entry of this.entries.values()) {
      if (entry.frame !== null || entry.card.src !== src) continue;
      if (!best || entry.activeAt > best.activeAt) best = entry;
    }
    return best;
  }

  /** 不管了：停下、放掉，从保管处拿走 */
  private forget(entry: Entry) {
    this.entries.delete(entry.media);
    this.observer?.unobserve(entry.media);
    this.observed.delete(entry.media);
    release(entry.media);
    if (entry.frame === null) entry.media.remove();
    if (this.shown === entry) this.shown = null;
    this.tidySlot();
    this.schedule();
  }

  /** 暂停藏着的超过上限：先放掉最久没放过的（条上那一个不动） */
  private limitParked() {
    const parked = [...this.entries.values()]
      .filter((entry) => entry.frame === null && entry.media.paused)
      .sort((a, b) => a.activeAt - b.activeAt);
    let excess = parked.length - PAUSED_LIMIT;
    for (const entry of parked) {
      if (excess <= 0) break;
      if (entry === this.shown) continue;
      this.forget(entry);
      excess--;
    }
  }

  /** 卡片在正文里的位置（还在 DOM 里时才量得到） */
  private remember(entry: Entry) {
    const { frame } = entry;
    if (this.destroyed || !frame?.isConnected || !this.view.contentDOM.contains(frame)) return;
    entry.pos = this.view.posAtDOM(frame);
  }

  /** 卡片在哪一行：卡片还画着就问 CodeMirror；拆了就在正文里找写着这个文件的那几行，挑离上次最近的 */
  private locate(entry: Entry): number | null {
    if (entry.frame?.isConnected && this.view.contentDOM.contains(entry.frame)) {
      return this.view.posAtDOM(entry.frame);
    }
    let best: number | null = null;
    let pos = 0;
    for (const text of this.view.state.doc.iterLines()) {
      if (text.includes("![[")) {
        const inner = /^!\[\[([^\]]+)\]\]$/.exec(text.trim())?.[1];
        const target = inner === undefined ? null : wikiFileTarget(inner);
        if (
          target?.name === entry.card.name &&
          (best === null || Math.abs(pos - entry.pos) < Math.abs(best - entry.pos))
        ) {
          best = pos;
        }
      }
      pos += text.length + 1;
    }
    return best;
  }

  /* ---------- 在不在眼前 ---------- */

  /** 开始放了才看它在不在可视区；root 是这一栏的滚动区 */
  private watch(entry: Entry) {
    if (typeof IntersectionObserver === "undefined" || this.observed.has(entry.media)) return;
    // 没在看的时候 visible 是旧的（比如上回藏在保管处时报的「不在」）：在卡片里就先当看得见，
    // 观察器开始看的那一下会报一次真的。不然在卡片上一按播放，条先闪出来一下
    if (entry.frame) entry.visible = true;
    if (!this.observer) {
      const root = this.view.dom.closest<HTMLElement>("[data-doc-scroller]");
      this.observer = new IntersectionObserver(
        (records) => {
          for (const record of records) {
            const watched = this.entries.get(record.target as HTMLMediaElement);
            if (!watched) continue;
            watched.visible = record.isIntersecting && record.intersectionRatio >= 0.5;
          }
          this.schedule();
        },
        { root, threshold: 0.5 },
      );
    }
    this.observer.observe(entry.media);
    this.observed.add(entry.media);
  }

  private unwatchAll() {
    this.observer?.disconnect();
    this.observer = null;
    this.observed = new WeakSet();
  }

  private inView(entry: Entry) {
    return entry.frame !== null && entry.visible;
  }

  /* ---------- 播放条 ---------- */

  /** 几件事常常一起来（拆卡片、pause 事件、观察器）：攒到微任务里算一次 */
  private schedule() {
    if (this.refreshQueued || this.destroyed) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (!this.destroyed) this.refresh();
    });
  }

  /**
   * 条上放哪一个：最近开始放的、正在放的那一个，不在眼前才出条。条显示着的那一个在条上（或系统的媒体键）
   * 暂停了，条留着 —— 不然一按暂停条就没了；它回到眼前、放完、按 ×，或者后来又有别的开始放了，才让
   */
  private pick(): Entry | null {
    let newest: Entry | null = null;
    for (const entry of this.entries.values()) {
      if (playing(entry.media) && (!newest || entry.startedAt > newest.startedAt)) newest = entry;
    }
    const held = this.shown;
    if (
      held &&
      this.entries.has(held.media) &&
      !held.media.ended &&
      !this.inView(held) &&
      (playing(held.media) || !newest || newest.startedAt < held.startedAt)
    ) {
      return held;
    }
    return newest && !this.inView(newest) ? newest : null;
  }

  private refresh() {
    const target = this.pick();
    this.shown = target;
    if (target) {
      this.bar ??= new MediaBar(this.host(), {
        toggle: () => this.toggle(),
        seek: (time) => this.seek(time),
        back: (keyboard) => this.back(keyboard),
        close: () => this.close(),
        hidden: () => this.barHidden(),
        editor: () => this.view.focus(),
      });
      this.bar.show(target.card, target.media);
    } else {
      this.bar?.hide(false);
    }
    // 都停了、条也收了：不再看
    if (!target && this.observer && !this.anyPlaying()) this.unwatchAll();
  }

  private anyPlaying() {
    for (const media of this.entries.keys()) if (playing(media)) return true;
    return false;
  }

  /** 条淡出完了：没有要显示的、也没有在放的，就从页面上拿掉（下次要用再建） */
  private barHidden() {
    if (this.shown || !this.bar || this.anyPlaying()) return;
    this.bar.remove();
    this.bar = null;
  }

  private toggle() {
    const media = this.shown?.media;
    if (!media) return;
    if (media.paused) {
      media.play().catch((error) => console.warn("播放不了", error));
    } else {
      media.pause();
    }
    this.bar?.progress(media);
  }

  private seek(time: number) {
    const media = this.shown?.media;
    if (!media) return;
    const end = Number.isFinite(media.duration) ? media.duration : Number.POSITIVE_INFINITY;
    media.currentTime = Math.max(0, Math.min(end, time));
    this.bar?.progress(media);
  }

  /** 「回到卡片」：滑过去，不动光标；键盘按的，到了以后焦点进卡片里的播放器 */
  private back(keyboard: boolean) {
    const entry = this.shown;
    if (!entry) return;
    const pos = this.locate(entry);
    if (pos === null) return;
    const scroller = scrollParent(this.view);
    const win = this.view.dom.ownerDocument.defaultView ?? window;
    // glideTo 量的是卡片后面源码那一处（卡片底边）：可视区整个往下挪半张卡片，停下来整张卡片在正中
    const shift = entry.card.height() / 2;
    glideTo(this.view, pos, {
      y: "center",
      band: () => {
        const box = scroller?.getBoundingClientRect();
        return {
          top: Math.max(box?.top ?? 0, 0) + shift,
          bottom: Math.min(box?.bottom ?? win.innerHeight, win.innerHeight) + shift,
        };
      },
      onArrive: () => {
        if (keyboard) this.focusCard(entry, 12);
      },
    });
  }

  /** 减少动效时一下子跳过去，卡片要等 CodeMirror 下一轮画出来：等几帧 */
  private focusCard(entry: Entry, frames: number) {
    if (this.destroyed || !this.entries.has(entry.media)) return;
    if (entry.frame?.isConnected) {
      entry.media.focus({ preventScroll: true });
      return;
    }
    if (frames > 0) requestAnimationFrame(() => this.focusCard(entry, frames - 1));
  }

  /** ×：暂停、条收起（进度照「放到一半暂停着」留着）；还有别的在放（不在眼前）就换成那一个 */
  private close() {
    const entry = this.shown;
    if (!entry) return;
    this.shown = null;
    entry.media.pause();
    this.refresh();
  }

  /* ---------- 保管处 ---------- */

  /** 这一栏的可视区（DocumentView 的 [data-swap-host]：不滚动、换篇的快照放在这一层）；单独挂的编辑器就是它的父元素 */
  private host(): HTMLElement {
    const dom = this.view.dom;
    return dom.closest<HTMLElement>("[data-swap-host]") ?? dom.parentElement ?? dom;
  }

  private ensureSlot(): HTMLElement {
    if (this.slot) return this.slot;
    const slot = this.view.dom.ownerDocument.createElement("div");
    slot.className = "odea-media-keep";
    slot.setAttribute("aria-hidden", "true");
    // 视频藏着只出声音：display: none 的 <video> 照样放，画面不解码到屏幕上（§11.4.6 的实验）
    slot.style.display = "none";
    this.host().append(slot);
    this.slot = slot;
    return slot;
  }

  private tidySlot() {
    if (this.slot && !this.slot.firstChild) {
      this.slot.remove();
      this.slot = null;
    }
  }
}

/**
 * 跟着 attachmentHost 这个 facet 来（有附件卡片的编辑器才有）。没有 update：
 * 不放东西时什么都不做
 */
export const mediaKeeper = ViewPlugin.fromClass(MediaKeeper, {
  provide: (plugin) =>
    EditorView.scrollMargins.of((view) => view.plugin(plugin)?.margins() ?? null),
});

/** 附件卡片 toDOM 时调：把播放器放进 holder（藏着的拿回来，没有新建） */
export function mountMedia(
  view: EditorView,
  frame: HTMLElement,
  holder: HTMLElement,
  card: MediaCard,
  create: () => HTMLMediaElement,
) {
  const keeper = view.plugin(mediaKeeper);
  if (keeper) keeper.mount(frame, holder, card, create);
  else holder.append(create());
}

/** 附件卡片 destroy 时调 */
export function dropMedia(frame: HTMLElement) {
  owners.get(frame)?.drop(frame);
  owners.delete(frame);
}

/* ============================================================
   播放条：叠在这一栏正文可视区的底部，居中对着正文栏。不进文档流：正文最后本来就留着
   64px + 72px 的空白，滚到底时条落在空白上，出现、消失都不改排版。
   样子是浮层那一套（canvas 底、line-strong 边、radius-lg、shadow-float）；只淡 opacity，
   will-change 一直在层上，每次淡之前对齐整物理像素（docs/PITFALLS/动效.md 规矩 1、3）
   ============================================================ */

interface BarActions {
  toggle(): void;
  seek(time: number): void;
  back(keyboard: boolean): void;
  close(): void;
  /** 淡出完了 */
  hidden(): void;
  /** 焦点在条上时条收起：还给正文 */
  editor(): void;
}

const PLAY_ICON = "M6 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L7.5 3.64A1 1 0 0 0 6 4.5z";
const PAUSE_ICON =
  "M7 4h2.5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M14.5 4H17a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-2.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z";
const BACK_ICON =
  "M2 12h3 M19 12h3 M12 2v3 M12 19v3 M12 5a7 7 0 1 0 0 14a7 7 0 1 0 0-14 M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6";
const CLOSE_ICON = "M18 6 6 18 M6 6l12 12";

function svg(doc: Document, d: string, className: string) {
  const node = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("class", className);
  node.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  node.append(path);
  return { node, path };
}

/** 83 → 1:23；一小时以上 1:02:03 */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

class MediaBar {
  private readonly dom: HTMLElement;
  private readonly kind: SVGPathElement;
  private readonly name: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly toggleIcon: SVGPathElement;
  private readonly track: HTMLElement;
  private readonly time: HTMLElement;
  private media: HTMLMediaElement | null = null;
  private shown = false;
  /** 正在淡出：取消它（又要显示了、要拿掉了） */
  private cancelHide: (() => void) | null = null;

  constructor(
    host: HTMLElement,
    private readonly actions: BarActions,
  ) {
    const doc = host.ownerDocument;
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) => {
      const node = doc.createElement(tag);
      node.className = className;
      return node;
    };
    const button = (label: string, d: string, onClick: (keyboard: boolean) => void) => {
      const node = element("button", "odea-media-bar-button");
      node.type = "button";
      node.setAttribute("aria-label", label);
      node.title = label;
      const icon = svg(doc, d, "odea-media-bar-icon");
      node.append(icon.node);
      // 按下不抢正文的焦点（同查找面板）：点完接着打字，光标还在原处
      node.addEventListener("mousedown", (event) => event.preventDefault());
      // 键盘按的（Enter / 空格）click 的 detail 是 0
      node.addEventListener("click", (event) => onClick(event.detail === 0));
      return { node, path: icon.path };
    };

    this.dom = element("div", "odea-media-bar");
    this.dom.setAttribute("role", "group");
    this.dom.inert = true;

    const kind = svg(doc, "", "odea-media-bar-kind");
    this.kind = kind.path;
    this.name = element("span", "odea-media-bar-name");
    const toggle = button("暂停", PAUSE_ICON, () => this.actions.toggle());
    this.toggle = toggle.node;
    this.toggleIcon = toggle.path;
    this.toggleIcon.parentElement?.classList.add("is-solid");

    this.track = element("span", "odea-media-bar-track");
    this.track.setAttribute("role", "slider");
    this.track.setAttribute("aria-label", "播放进度");
    this.track.setAttribute("aria-valuemin", "0");
    this.track.tabIndex = 0;
    this.track.append(
      element("span", "odea-media-bar-rail"),
      element("span", "odea-media-bar-thumb"),
    );
    this.listenTrack();

    this.time = element("span", "odea-media-bar-time");
    this.time.setAttribute("aria-hidden", "true");
    const back = button("回到卡片", BACK_ICON, (keyboard) => this.actions.back(keyboard));
    const close = button("关掉", CLOSE_ICON, () => this.actions.close());

    this.dom.append(
      kind.node,
      this.name,
      this.toggle,
      this.track,
      this.time,
      back.node,
      close.node,
    );
    host.append(this.dom);
  }

  show(card: MediaCard, media: HTMLMediaElement) {
    this.cancelHide?.();
    this.media = media;
    this.dom.classList.toggle("is-video", card.kind === "video");
    this.dom.setAttribute("aria-label", `播放条：${card.title}`);
    this.kind.setAttribute("d", card.icon);
    if (this.name.textContent !== card.title) {
      this.name.textContent = card.title;
      this.name.title = card.title;
    }
    this.progress(media);
    if (this.shown) return;
    this.shown = true;
    this.dom.inert = false;
    // 先对齐到整物理像素再淡（量一次布局，也让「透明」的那一帧先算出来，过渡才有起点）
    snapToDevicePixels(this.dom);
    this.dom.classList.add("is-shown");
  }

  /** 淡出；淡完通知一声。now：编辑器拆了，淡完直接拿掉 */
  hide(now: boolean) {
    if (!this.shown) {
      if (now) this.remove();
      else if (!this.cancelHide) this.actions.hidden();
      return;
    }
    this.shown = false;
    const doc = this.dom.ownerDocument;
    if (this.dom.contains(doc.activeElement)) {
      if (now) (doc.activeElement as HTMLElement).blur();
      else this.actions.editor();
    }
    // 淡出时不接点击
    this.dom.inert = true;
    if (this.dom.isConnected) snapToDevicePixels(this.dom);
    this.dom.classList.remove("is-shown");
    // 淡完才拿掉。不按钟点算：换篇那一下主线程要排新的一篇，过渡晚几十毫秒才开始，
    // 按 100ms 算会把最后一截截掉（无头 Chrome 里量到还剩 0.15 就没了）
    const finish = () => {
      cancel();
      if (now) this.remove();
      else this.actions.hidden();
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === this.dom && event.propertyName === "opacity") finish();
    };
    // 过渡没跑（不在页面上、窗口藏着）也得收尾
    const timer = setTimeout(finish, FADE_OUT_FALLBACK_MS);
    const cancel = () => {
      clearTimeout(timer);
      this.dom.removeEventListener("transitionend", onEnd);
      this.cancelHide = null;
    };
    this.dom.addEventListener("transitionend", onEnd);
    this.cancelHide = cancel;
  }

  remove() {
    this.cancelHide?.();
    this.dom.remove();
  }

  /** 播放 / 暂停的样子、进度、时间 */
  progress(media: HTMLMediaElement) {
    if (media !== this.media) return;
    const label = media.paused ? "播放" : "暂停";
    if (this.toggle.getAttribute("aria-label") !== label) {
      this.toggle.setAttribute("aria-label", label);
      this.toggle.title = label;
      this.toggleIcon.setAttribute("d", media.paused ? PLAY_ICON : PAUSE_ICON);
    }
    const duration = Number.isFinite(media.duration) ? media.duration : 0;
    const now = media.currentTime;
    const ratio = duration > 0 ? Math.min(1, Math.max(0, now / duration)) : 0;
    const text = duration > 0 ? `${clock(now)} / ${clock(duration)}` : clock(now);
    this.track.style.setProperty("--progress", String(ratio));
    this.track.setAttribute("aria-valuemax", String(Math.round(duration)));
    this.track.setAttribute("aria-valuenow", String(Math.round(Math.min(now, duration || now))));
    this.track.setAttribute("aria-valuetext", text);
    if (this.time.textContent !== text) this.time.textContent = text;
  }

  /** 进度条：能拖、点哪跳哪；←/→（↑/↓）5 秒，Home / End。按下不抢正文的焦点 */
  private listenTrack() {
    const track = this.track;
    const seekAt = (x: number) => {
      const media = this.media;
      if (!media || !Number.isFinite(media.duration)) return;
      const box = track.getBoundingClientRect();
      if (!box.width) return;
      this.actions.seek(((x - box.left) / box.width) * media.duration);
    };
    let dragging: number | null = null;
    track.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = event.pointerId;
      track.setPointerCapture(event.pointerId);
      seekAt(event.clientX);
    });
    track.addEventListener("pointermove", (event) => {
      if (dragging === event.pointerId) seekAt(event.clientX);
    });
    const stop = (event: PointerEvent) => {
      if (dragging !== event.pointerId) return;
      dragging = null;
      if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
    };
    track.addEventListener("pointerup", stop);
    track.addEventListener("pointercancel", stop);
    track.addEventListener("mousedown", (event) => event.preventDefault());
    track.addEventListener("keydown", (event) => {
      const media = this.media;
      if (!media || event.altKey || event.ctrlKey || event.metaKey) return;
      const now = media.currentTime;
      const target =
        event.key === "ArrowRight" || event.key === "ArrowUp"
          ? now + SEEK_STEP
          : event.key === "ArrowLeft" || event.key === "ArrowDown"
            ? now - SEEK_STEP
            : event.key === "Home"
              ? 0
              : event.key === "End" && Number.isFinite(media.duration)
                ? media.duration
                : null;
      if (target === null) return;
      event.preventDefault();
      this.actions.seek(target);
    });
  }
}
