import { ANIMATED_EMOJI_FALLBACK } from "@/lib/emojiText";
import {
  ANIMATED_EMOJI_DESIGNS,
  type AnimatedEmojiDesign,
  EMOJI_HUES,
  type EmojiMotion,
  type Pose,
  type Step,
} from "./animatedEmojiSet";

/* ============================================================
   动态表情：`:otw_fire:` 这类短码 → 自己画的 SVG 动画。

   为什么不是 GIF / Lottie：这套图是我们自己画的线稿，SVG + Web Animations
   API 就够了 —— 矢量、任意缩放都清晰、颜色跟主题变量走、能精确控制
   「看得见就循环、滚出去就停」、减少动效时停在静止帧，而且不用引 WASM、
   不用改 CSP。以后要接外部的彩色动画表情，再上 Lottie。

   Markdown 源文里始终只是短码。别的编辑器打开看到的是 `:otw_fire:`，
   摘要里换成对应的 Unicode 表情（lib/emojiText.ts）。

   这个文件不依赖 CodeMirror：选择器和编辑器替身（widgets.ts）共用它。
   ============================================================ */

export type AnimatedEmoji = AnimatedEmojiDesign & {
  /** 完整短码，带冒号：`:otw_fire:` */
  readonly shortcode: string;
  /** 对应的 Unicode 表情：摘要、纯文本、复制到别处时用它 */
  readonly fallback: string;
};

export const SHORTCODE_PREFIX = "otw_";

export const ANIMATED_EMOJIS: readonly AnimatedEmoji[] = ANIMATED_EMOJI_DESIGNS.map((design) => ({
  ...design,
  shortcode: `:${SHORTCODE_PREFIX}${design.id}:`,
  fallback: ANIMATED_EMOJI_FALLBACK[design.id] ?? "",
}));

const byName = new Map(ANIMATED_EMOJIS.map((emoji) => [`${SHORTCODE_PREFIX}${emoji.id}`, emoji]));

/** `:otw_fire:` / `otw_fire` → 表情；不是这套里的返回 null。大小写不敏感，和 emojiFor 一致。 */
export function animatedEmojiFor(shortcode: string): AnimatedEmoji | null {
  const name = shortcode.replace(/^:|:$/g, "").toLowerCase();
  return byName.get(name) ?? null;
}

/* ---------------- 关键帧 ---------------- */

const IDENTITY: Required<Pose> = { x: 0, y: 0, r: 0, s: 1, sx: 1, sy: 1, kx: 0, ky: 0, o: 1, d: 0 };

const round = (value: number) => Math.round(value * 1000) / 1000;

/** 把 steps 展开成完整姿态：没写的量沿用上一帧，第一帧从静止态出发。 */
export function resolvePoses(steps: readonly Step[]): Array<Required<Pose>> {
  const poses: Array<Required<Pose>> = [];
  let current = { ...IDENTITY };
  for (const [, pose] of steps) {
    const next = { ...current, ...pose };
    // 只给 s 时它同时决定两个方向；单独给 sx / sy 时覆盖对应方向
    if (pose.s !== undefined) {
      next.sx = pose.sx ?? pose.s;
      next.sy = pose.sy ?? pose.s;
    }
    poses.push(next);
    current = next;
  }
  return poses;
}

/**
 * steps → Web Animations 关键帧。
 * transform 每一帧都写成同样的函数序列，浏览器就逐项插值，
 * 不会退化成矩阵分解（那样旋转和缩放一起动时会走弯路）。
 */
export function keyframesOf(steps: readonly Step[]): Keyframe[] {
  const poses = resolvePoses(steps);
  const uses = (keys: Array<keyof Pose>) =>
    steps.some(([, pose]) => keys.some((key) => key in pose));
  const moves = uses(["x", "y", "r", "s", "sx", "sy", "kx", "ky"]);
  const fades = uses(["o"]);
  const draws = uses(["d"]);
  // 最后一步不在 1 上时补一帧原地停住。不补的话浏览器会拿静止值当隐含的末帧，
  // 从最后一步一路插值回去 —— 转了 72° 的星星又会慢慢转回来。
  const last = steps.at(-1);
  const padded: readonly Step[] =
    last && last[0] < 1 ? [...steps.slice(0, -1), [last[0], last[1]], [1, {}]] : steps;
  const held = last && last[0] < 1 ? [...poses, poses.at(-1)!] : poses;
  return padded.map(([offset, , easing], index) => {
    const pose = held[index]!;
    const frame: Keyframe = { offset };
    if (moves) {
      frame.transform =
        `translate(${round(pose.x)}px, ${round(pose.y)}px) rotate(${round(pose.r)}deg) ` +
        `skewX(${round(pose.kx)}deg) skewY(${round(pose.ky)}deg) scale(${round(pose.sx)}, ${round(pose.sy)})`;
    }
    if (fades) frame.opacity = round(pose.o);
    if (draws) frame.strokeDashoffset = String(round(pose.d));
    if (easing) frame.easing = easing;
    return frame;
  });
}

/** 一个表情播完一轮要多久（含各部件的延迟和重复），循环的周期据此来定。 */
export function motionLength(emoji: AnimatedEmojiDesign): number {
  return Math.max(
    0,
    ...Object.values(emoji.motion).map(
      (motion: EmojiMotion) => (motion.delay ?? 0) + motion.duration * (motion.iterations ?? 1),
    ),
  );
}

/* ---------------- 部件样式 ----------------
   配色类的样式放在这里而不是 globals.css：同一份规则要用两次 —— 注入到页面给
   动起来的 SVG 用，再原样嵌进静止帧的图片里（图片是独立文档，看不到页面的样式表）。
   色相变量 --ae-* 和纸色、墨色仍然是 globals.css 里的主题 token。 */

export const EMOJI_PART_CSS = [
  ".otw-ae-svg{--h:var(--ae-amber)}",
  ...EMOJI_HUES.map(
    (hue) => `.otw-ae-svg.hue-${hue},.otw-ae-svg .hue-${hue}{--h:var(--ae-${hue})}`,
  ),
  ".otw-ae-svg .o{fill:none;stroke:var(--h)}",
  ".otw-ae-svg .t{fill:color-mix(in srgb,var(--h) 22%,var(--ae-paper));stroke:var(--h)}",
  // 笑脸的底色要更「黄」一点，不然看着是米色
  ".otw-ae-svg .t.face{fill:color-mix(in srgb,var(--h) 34%,var(--ae-paper))}",
  // 更浓的一档：西瓜瓤、柠檬这种本身颜色就饱满的东西
  ".otw-ae-svg .t.rich{fill:color-mix(in srgb,var(--h) 48%,var(--ae-paper))}",
  ".otw-ae-svg .k{fill:var(--h);stroke:none}",
  ".otw-ae-svg .p{fill:var(--ae-paper);stroke:var(--h)}",
  // 五官：色相混进墨色，亮色下偏深、暗色下偏亮
  ".otw-ae-svg .i{fill:none;stroke:color-mix(in srgb,var(--h) 45%,var(--color-ink))}",
  ".otw-ae-svg .ik{fill:color-mix(in srgb,var(--h) 45%,var(--color-ink));stroke:none}",
  ".otw-ae-svg .blush{fill:var(--ae-pink);stroke:none;opacity:.32}",
  ".otw-ae-svg .shine{fill:none;stroke:var(--ae-paper);stroke-width:1.4;opacity:.85}",
  ".otw-ae-svg .shade{fill:var(--h);stroke:none;opacity:.28}",
  ".otw-ae-svg .road{fill:none;stroke:color-mix(in srgb,var(--h) 22%,var(--ae-paper));stroke-width:4.2}",
  ".otw-ae-svg .bold{stroke-width:2.1}",
  ".otw-ae-svg .thin{stroke-width:1.3}",
  ".otw-ae-svg .draw{stroke-dasharray:1 1}",
  ".otw-ae-svg .dash{stroke-dasharray:.1 .08}",
  ".otw-ae-svg .fx{opacity:0}",
  ".otw-ae-svg [data-a],.otw-ae-svg .otw-ae-body{transform-box:fill-box;transform-origin:center}",
].join("\n");

let stylesInjected = false;

function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.dataset.otwAnimatedEmoji = "";
  style.textContent = EMOJI_PART_CSS;
  document.head.append(style);
}

/* ---------------- SVG 模板 ---------------- */

const SVG_NS = "http://www.w3.org/2000/svg";
/** 画布：24×24。活的 SVG 和静止帧的外框都用它，和优化前逐像素一致。 */
export const EMOJI_VIEWBOX = "0 0 24 24";
/**
 * 静止帧那张图自己的画布：四周各多留 3 个单位。图片会裁掉自身 viewBox 以外的
 * 部分，留出余量才装得下贴边的描边；这张图在外框里放在 (-3, -3)，大小 30，
 * 外框 overflow: visible，画出来和活的 SVG 落在同一套坐标上。
 */
const STILL_VIEWBOX = "-3 -3 30 30";
const templates = new Map<string, SVGSVGElement>();

/** 解析一次设计稿，之后每个实例 cloneNode —— 一屏几十个表情也只解析一遍。 */
function templateFor(emoji: AnimatedEmoji): SVGSVGElement {
  const cached = templates.get(emoji.id);
  if (cached) return cached;
  // 标签之间的换行缩进会变成空白文本节点，混进 textContent（目录、复制）里，先去掉
  const markup = emoji.svg.replace(/>\s+</g, "><").trim();
  const parsed = new DOMParser().parseFromString(
    `<svg xmlns="${SVG_NS}">${markup}</svg>`,
    "image/svg+xml",
  ).documentElement;
  const root = document.createElementNS(SVG_NS, "svg");
  root.setAttribute("viewBox", EMOJI_VIEWBOX);
  root.setAttribute("class", `otw-ae-svg otw-ae-live hue-${emoji.hue}`);
  root.setAttribute("aria-hidden", "true");
  root.setAttribute("focusable", "false");
  root.setAttribute("fill", "none");
  root.setAttribute("stroke-width", "1.7");
  root.setAttribute("stroke-linecap", "round");
  root.setAttribute("stroke-linejoin", "round");
  // 外面再包一层：插入时整个表情「啵」地弹出来，动的是这一层
  const body = document.createElementNS(SVG_NS, "g");
  body.setAttribute("class", "otw-ae-body");
  for (const child of Array.from(parsed.childNodes)) body.append(document.importNode(child, true));
  root.append(body);
  for (const part of root.querySelectorAll<SVGElement>("[data-a]")) {
    const motion = emoji.motion[part.dataset.a ?? ""];
    if (!motion) continue;
    if (motion.box === "view") part.style.setProperty("transform-box", "view-box");
    if (motion.origin) part.style.setProperty("transform-origin", motion.origin);
  }
  templates.set(emoji.id, root);
  return root;
}

/* ---------------- 静止帧：一张图 ----------------
   只有看得见的表情在动；CodeMirror 在视口上下多渲染的那些、排队等名额的那些
   都是静止的。一个活的 SVG 大约 10 个元素，每个都要算样式；一屏几百个时光
   样式重算就上百毫秒。静止时换成一张图：同一份 SVG 连同当前主题解析好的
   颜色序列化成 data: 图片，每个表情每套主题只生成一次，同一张图在页面里画
   多少遍都只解析一次。动起来的时候才把活的 SVG 叠上去。

   图不用 <img> 画，而是放进一个和活的 SVG 同框同 viewBox 的小 <svg> 里用
   <image> 画：<img> 的落点会被吸附到整设备像素，而行内 SVG 按亚像素位置
   绘制，表情在一行字里的位置几乎总是小数 —— 用 <img> 的话静止帧和动起来
   的第一帧会差出半个像素，一播放就「抖」一下。外框也保持优化前的尺寸和
   viewBox：换了框（哪怕数学上等价），浏览器的像素吸附会让整个表情挪一个
   设备像素。 */

/** 静止帧要用到的主题变量：色相、纸色（画布）、墨色 */
const PALETTE_VARS = [
  ...EMOJI_HUES.map((hue) => `--ae-${hue}`),
  "--color-canvas",
  "--color-ink",
] as const;

let palette: string | null = null;
const stillUrls = new Map<string, string>();
let themeWatcher: MutationObserver | null = null;

/**
 * 当前主题下的颜色声明。样式表还没加载（或者在没有样式的测试环境里）时拿不到
 * 颜色，返回 null —— 那就不用图片，静止帧直接用活的 SVG；null 不缓存，
 * 样式表一到下一个表情就能用上图片。
 */
function currentPalette(): string | null {
  if (palette) return palette;
  watchTheme();
  const style = getComputedStyle(document.documentElement);
  const values = PALETTE_VARS.map((name) => [name, style.getPropertyValue(name).trim()] as const);
  palette = values.every(([, value]) => value)
    ? `${values.map(([name, value]) => `${name}:${value}`).join(";")};--ae-paper:var(--color-canvas)`
    : null;
  return palette;
}

/** 切换主题：重新取颜色，页面上所有静止帧换成新主题下的图 */
function watchTheme(): void {
  if (themeWatcher || typeof MutationObserver === "undefined") return;
  themeWatcher = new MutationObserver(() => {
    const before = palette;
    palette = null;
    if (currentPalette() === before) return;
    stillUrls.clear();
    for (const still of document.querySelectorAll<SVGSVGElement>("svg.otw-ae-still")) {
      // 换主题时盖在上面的旧主题副本（lib/themeTransition.ts）：留着旧颜色
      if (still.closest(".otw-theme-ghost")) continue;
      const emoji = byName.get(`${SHORTCODE_PREFIX}${still.dataset.emoji}`);
      const url = emoji && stillUrl(emoji);
      if (url) still.firstElementChild?.setAttribute("href", url);
    }
  });
  themeWatcher.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}

function stillUrl(emoji: AnimatedEmoji): string | null {
  const colors = currentPalette();
  if (!colors) return null;
  let url = stillUrls.get(emoji.id);
  if (!url) {
    const svg = templateFor(emoji).cloneNode(true) as SVGSVGElement;
    svg.setAttribute("xmlns", SVG_NS);
    svg.setAttribute("viewBox", STILL_VIEWBOX);
    const style = document.createElementNS(SVG_NS, "style");
    style.textContent = `svg{${colors}}\n${EMOJI_PART_CSS}`;
    svg.prepend(style);
    url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    stillUrls.set(emoji.id, url);
  }
  return url;
}

/** 静止帧：<svg viewBox="0 0 24 24"><image x=-3 y=-3 30×30/></svg>，和活的 SVG 同框同坐标 */
function stillElement(emoji: AnimatedEmoji, url: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", EMOJI_VIEWBOX);
  svg.setAttribute("class", "otw-ae-still");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.dataset.emoji = emoji.id;
  const image = document.createElementNS(SVG_NS, "image");
  const [x, y, size] = STILL_VIEWBOX.split(" ");
  image.setAttribute("x", x!);
  image.setAttribute("y", y!);
  image.setAttribute("width", size!);
  image.setAttribute("height", size!);
  image.setAttribute("href", url);
  svg.append(image);
  return svg;
}

/* ---------------- 播放 ---------------- */

/** 应用内开关或系统偏好要求减少动效。 */
export function motionReduced(): boolean {
  if (document.documentElement.dataset.reduceMotion === "true") return true;
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** 插入时整个表情先弹出来，本体动作晚这么多再开始。 */
const INTRO_LEAD = 180;
const INTRO_FRAMES: Keyframe[] = [
  { transform: "scale(0.2) rotate(-18deg)", opacity: 0, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  { transform: "scale(1.14) rotate(4deg)", opacity: 1, offset: 0.6, easing: "ease-in-out" },
  { transform: "scale(1) rotate(0deg)", opacity: 1 },
];

/* ---------------- 循环 ----------------
   一轮动作做完停一会儿，再从头来。停顿期间所有部件的动画都已经结束（fill 只有
   backwards），SVG 就是一张不动的图，浏览器不用每帧重算它的样式 —— 设计稿里
   部件平均约三分之一的时间是停着的（等 delay、做完了等别的部件、两轮之间的
   停顿），这段时间一概不占帧。代价是每轮一个计时器，几十个表情每秒也就几十次。 */

/** 两轮之间停多久。 */
export const LOOP_GAP = 700;

const keyframeCache = new Map<string, Map<string, Keyframe[]>>();

function keyframesFor(emoji: AnimatedEmoji): Map<string, Keyframe[]> {
  let frames = keyframeCache.get(emoji.id);
  if (!frames) {
    frames = new Map(
      Object.entries(emoji.motion).map(([part, motion]) => [part, keyframesOf(motion.steps)]),
    );
    keyframeCache.set(emoji.id, frames);
  }
  return frames;
}

/**
 * 一个表情实例。静止时宿主里只有一张图（拿不到主题颜色时退回活的 SVG）；
 * 循环期间把活的 SVG 叠上去、把图藏起来（display: none，不卸载，图片资源还在，换回来不会闪），
 * stop() 再摘掉。两者同一个 viewBox、同一个框，静止帧像素一致。
 */
export class EmojiPlayer {
  private host: HTMLElement | null = null;
  private still: SVGSVGElement | null = null;
  private live: SVGSVGElement | null = null;
  private running: Animation[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private looping = false;

  constructor(readonly emoji: AnimatedEmoji) {}

  /**
   * 放进宿主（一个 .otw-ae 框）。
   *
   * image: false —— 静止帧也用活的 SVG，不用图。图省的是「同一个表情画很多遍」：同一张
   * 图全页只解析一次。可每张不同的 data: SVG 图，浏览器都要为它单独建一个隔离的 SVG
   * 文档（IsolatedSVGDocumentHost，同步发生在布局里），而且再插一次 <image> 还得再建。
   * 选择器里 48 个表情各不相同、各出现一次：用图的话每次打开都要建 48 个文档，
   * 4 倍降速 + 2x 屏上首次打开主线程卡 0.65 秒、之后每次 0.2–0.3 秒；换成活的 SVG
   * 只多算几百个元素的样式。
   */
  mount(host: HTMLElement, { image = true }: { image?: boolean } = {}): void {
    injectStyles();
    this.host = host;
    const url = image ? stillUrl(this.emoji) : null;
    this.still = url ? stillElement(this.emoji, url) : this.liveElement();
    host.prepend(this.still);
  }

  /** 当前显示的活 SVG（还没开始或已经停下时为 null，退回模式下就是静止帧本身） */
  get liveSvg(): SVGSVGElement | null {
    return this.live?.isConnected ? this.live : null;
  }

  get playing(): boolean {
    return this.looping;
  }

  /**
   * 一直循环（两轮之间停 gap 毫秒），直到 stop()。减少动效时什么也不做 —— 静止态
   * 本身就是一张完整的图。
   * - wait：先停在静止帧等这么久再开始第一轮。自动播放用它把同屏的表情错开。
   * - intro：先整个弹出来再做动作（刚插入时用）。
   */
  loop(options: { gap?: number; wait?: number; intro?: boolean } = {}): void {
    this.stop();
    if (motionReduced() || !this.host) return;
    this.looping = true;
    const period = motionLength(this.emoji) + (options.gap ?? LOOP_GAP);
    const cycle = (intro: boolean) => {
      if (!this.looping) return;
      this.timer = setTimeout(() => cycle(false), period + (intro ? INTRO_LEAD : 0));
      this.playRound(intro);
    };
    if (options.intro || !options.wait) cycle(!!options.intro);
    else this.timer = setTimeout(() => cycle(false), options.wait);
  }

  /** 停下并回到静止态。 */
  stop(): void {
    this.looping = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.cancel();
    this.hideLive();
  }

  /** 从头做一轮动作。上一轮的动画这时都已经结束，取消掉只是释放对象。 */
  private playRound(intro: boolean): void {
    this.cancel();
    const svg = this.showLive();
    if (typeof svg.animate !== "function") {
      this.stop();
      return;
    }
    const lead = intro ? INTRO_LEAD : 0;
    if (intro) {
      const body = svg.querySelector<SVGGElement>(".otw-ae-body");
      if (body) this.running.push(body.animate(INTRO_FRAMES, { duration: 420, fill: "backwards" }));
    }
    const frames = keyframesFor(this.emoji);
    for (const part of svg.querySelectorAll<SVGElement>("[data-a]")) {
      const name = part.dataset.a ?? "";
      const motion = this.emoji.motion[name];
      const keyframes = frames.get(name);
      if (!motion || !keyframes) continue;
      this.running.push(
        part.animate(keyframes, {
          duration: motion.duration,
          delay: lead + (motion.delay ?? 0),
          iterations: motion.iterations ?? 1,
          // 带延迟的部件（彩纸、泪滴）在开始前就得处于第一帧，不然会先闪一下静止态。
          // 只要 backwards：做完以后回到底下的静止样式，和最后一帧一样（单测守着），
          // 而且结束了的动画不再每帧参与样式计算
          fill: "backwards",
        }),
      );
    }
  }

  private cancel(): void {
    const running = this.running;
    this.running = [];
    for (const animation of running) animation.cancel();
  }

  private liveElement(): SVGSVGElement {
    this.live ??= templateFor(this.emoji).cloneNode(true) as SVGSVGElement;
    return this.live;
  }

  private showLive(): SVGSVGElement {
    const svg = this.liveElement();
    if (svg === this.still) return svg;
    if (!svg.isConnected) this.host?.prepend(svg);
    // display: none：动画期间静止帧不参与布局和绘制；元素和图片资源都留着，换回来不用重新加载
    if (this.still) this.still.style.display = "none";
    return svg;
  }

  private hideLive(): void {
    if (!this.live || this.live === this.still) return;
    this.live.remove();
    if (this.still) this.still.style.display = "";
  }
}

/* ---------------- 看得见才动 ----------------
   正文里的表情露出视口就一直循环，滚出去就停回静止帧（一张图，几乎没有成本）。
   CodeMirror 会把视口上下一段距离内的行都渲染出来，挂载 ≠ 看得见，所以用一个
   全局共享的 IntersectionObserver 盯着；上下各多看一点，滚进来的时候已经在动了。

   同时在动的有上限：满屏几百个表情一起动（小字号、整篇都是表情的极端文档），
   软件渲染下会掉帧。超出的先停在静止帧排队，前面有滚出去的就依次补上。
   悬停、点击、刚插入这些用户自己触发的不受限。 */

export const AUTO_PLAY_LIMIT = 48;

interface Watched {
  player: EmojiPlayer;
  visible: boolean;
  /** 占着一个名额 */
  counted: boolean;
}

const watched = new Map<Element, Watched>();
/** 露出来了但名额满了，按先来后到排队 */
const waiting = new Set<Element>();
let animating = 0;
let observer: IntersectionObserver | null = null;
let motionWatcher: (() => void) | null = null;

function visibilityObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const state = watched.get(entry.target);
        if (!state) continue;
        state.visible = entry.isIntersecting;
        if (state.visible) start(entry.target, state);
        else halt(entry.target, state);
      }
      sweep();
    },
    { rootMargin: "64px 0px" },
  );
  return observer;
}

function start(
  target: Element,
  state: Watched,
  options: { force?: boolean; intro?: boolean } = {},
) {
  if (motionReduced()) return;
  if (state.player.playing && !options.intro) return;
  if (!options.force && !state.counted && animating >= AUTO_PLAY_LIMIT) {
    waiting.add(target);
    return;
  }
  waiting.delete(target);
  if (!state.counted) {
    state.counted = true;
    animating += 1;
  }
  // 自动开始的随机晚一点：同屏同时露出来的一排表情不会齐步走
  if (options.force) state.player.loop({ intro: options.intro });
  else state.player.loop({ wait: Math.random() * LOOP_GAP });
}

function halt(target: Element, state: Watched) {
  waiting.delete(target);
  state.player.stop();
  if (!state.counted) return;
  state.counted = false;
  animating -= 1;
  // 腾出一个名额：排队的里面第一个还看得见的补上
  for (const next of waiting) {
    if (animating >= AUTO_PLAY_LIMIT) break;
    const queued = watched.get(next);
    waiting.delete(next);
    if (queued?.visible && next.isConnected) start(next, queued);
  }
}

/**
 * 表格、目录里的表情没有 destroy 钩子，被整块换掉以后只是从文档里摘掉了。
 * 摘掉时如果它正看得见，观察器会报一次「看不见」，动画在那时就停了；这里再把
 * 已经不在文档里的清出名单。CodeMirror 的 widget 在 toDOM 时还没挂上去，
 * 所以只能在观察器回调里清（那时候该挂的都挂上了），不能在登记时清。
 */
function sweep() {
  for (const [target, state] of watched) {
    if (target.isConnected) continue;
    halt(target, state);
    watched.delete(target);
    observer?.unobserve(target);
  }
}

/** 减少动效的开关随时可能拨动：拨上时全部停回静止帧，拨回来时看得见的接着动。 */
function watchMotionPreference() {
  if (motionWatcher) return;
  const recheck = () => {
    const reduced = motionReduced();
    for (const [target, state] of watched) {
      if (reduced) halt(target, state);
      else if (state.visible) start(target, state);
    }
  };
  const attributes = typeof MutationObserver === "undefined" ? null : new MutationObserver(recheck);
  attributes?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-reduce-motion"],
  });
  const media =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  media?.addEventListener?.("change", recheck);
  motionWatcher = () => {
    attributes?.disconnect();
    media?.removeEventListener?.("change", recheck);
  };
}

/**
 * 露出视口时一直循环、滚出去停下。intro：刚插入的，立刻整个弹出来（不等观察器、不占排队）。
 * 没有 IntersectionObserver 的环境（测试）直接当作看得见。
 */
export function animateWhileVisible(
  target: HTMLElement,
  player: EmojiPlayer,
  options: { intro?: boolean } = {},
): void {
  const state: Watched = { player, visible: false, counted: false };
  watched.set(target, state);
  watchMotionPreference();
  if (options.intro) start(target, state, { force: true, intro: true });
  const io = visibilityObserver();
  if (io) {
    io.observe(target);
  } else {
    state.visible = true;
    start(target, state);
  }
}

/** 用户碰了它（点击）：从头再来一遍，不管名额。 */
export function replay(target: Element): void {
  const state = watched.get(target);
  if (state) start(target, state, { force: true });
}

/** 悬停：排队中的（名额满了还没动的）先动起来。 */
export function wake(target: Element): void {
  const state = watched.get(target);
  if (state && !state.player.playing) start(target, state, { force: true });
}

/**
 * 整个编辑器拆掉以后清一遍名单。观察器只为摘掉时还看得见的表情报信，滚在视口外的
 * 表格、目录里的那些要等别的表情露面才清得掉，一直等不来的话，名单经由它们握着
 * 整个旧编辑器（表格的事件处理闭包住了 view）。
 */
export function forgetDetachedEmoji(): void {
  sweep();
}

/** 不再盯着它，停回静止帧（widget 销毁时）。 */
export function stopAnimating(target: Element): void {
  const state = watched.get(target);
  if (!state) return;
  halt(target, state);
  watched.delete(target);
  observer?.unobserve(target);
}

/** 测试用：清空所有登记，名额归零，下次登记时重新创建观察器。 */
export function resetAnimationBudget(): void {
  for (const target of [...watched.keys()]) stopAnimating(target);
  waiting.clear();
  animating = 0;
  observer?.disconnect();
  observer = null;
  motionWatcher?.();
  motionWatcher = null;
}

/* ---------------- 刚从选择器插入的那一个 ----------------
   插入时想要「啵」地弹出来，但 widget 只看得到自己的短码。选择器插入前
   在这里记一笔，接下来一小段时间里第一个挂载的同名 widget 把它领走。 */

let primed: { id: string; until: number } | null = null;

export function primeIntro(emoji: AnimatedEmoji): void {
  primed = { id: emoji.id, until: Date.now() + 1000 };
}

export function takeIntro(emoji: AnimatedEmoji): boolean {
  if (!primed || primed.id !== emoji.id || Date.now() > primed.until) return false;
  primed = null;
  return true;
}

/**
 * 表格单元格、[TOC] 这类自己画 DOM 的地方用的版本：和正文里一样，看得见就一直动。
 * 里面藏一个 Unicode 替身，textContent / 复制都能拿到正常的表情。
 */
export function inlineAnimatedEmoji(emoji: AnimatedEmoji): HTMLElement {
  const node = document.createElement("span");
  node.className = "otw-ae";
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", emoji.name);
  node.title = emoji.name;
  const player = new EmojiPlayer(emoji);
  const alt = document.createElement("span");
  alt.className = "otw-ae-alt";
  alt.textContent = emoji.fallback;
  node.append(alt);
  player.mount(node);
  animateWhileVisible(node, player);
  node.addEventListener("pointerenter", () => wake(node));
  return node;
}
