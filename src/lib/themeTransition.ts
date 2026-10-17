/* ============================================================
   换主题：日落 / 日出。

   切到暗色是日落：夜色从天顶往下落，交界处一道晚霞（靛蓝 → 玫瑰 → 橘），
   底下一团夕阳的余晖跟着沉下去；暗下来的地方亮起几颗星，落定前隐去。
   切回亮色是日出：光从地平线往上漫，交界处一道晨光（金 → 桃 → 淡紫），
   一团朝阳从底下升起来；夜里的星星在光到之前一颗颗隐去。

   做法：新主题从第一帧起就是真实页面 —— 字一直是清楚的，照样能点、能打字。
   上面盖一份旧主题的副本（克隆整页 DOM，钉住旧的颜色变量），用一道很宽的羽化遮罩
   把它擦掉；晚霞、余晖、星星画在最上面一层，只是几块渐变和几个点，不碰任何字。
   不用 View Transitions：那是把新旧两页都拍成图片来动，结束那一下才换回真实页面，
   字会在最后从发灰跳到清楚。
   ============================================================ */

/** 整段日落 / 日出的时长（毫秒）。主题开关上的太阳月亮按它对齐 */
export const THEME_TRANSITION_MS = 1500;

/**
 * 遮罩羽化的宽度（占窗口高度的比例）。羽化带里新旧两页的字叠在一起，深字压浅字是一片灰 ——
 * 太宽的话一大块字同时发灰。天色的柔和交给上面那层晚霞 / 晨光，这里只留一道窄的
 */
const FEATHER = 0.22;
const STAR_COUNT = 26;

type Listener = (event: { toDark: boolean; duration: number; finished: Promise<void> }) => void;
const listeners = new Set<Listener>();

/** 每次开始播日落 / 日出时通知一下（主题开关借这个让太阳落下、月亮升起） */
export function onThemeTransition(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let running: { finish: () => void } | null = null;

/**
 * 换到 toDark 指定的主题，apply 负责真正写进 <html>。
 * 明暗没变、关了动效、或者内核不支持遮罩时直接换，返回 false；播了动画返回 true。
 */
export function transitionTheme(toDark: boolean, apply: () => void): boolean {
  running?.finish();
  const fromDark = document.documentElement.dataset.theme === "dark";
  if (fromDark === toDark || motionReduced() || !CSS.supports?.("mask-image", "none")) {
    switchInstantly(apply);
    return false;
  }

  const fixups: (() => void)[] = [];
  const ghost = buildGhost(fixups);
  const sky = buildSky(toDark);
  document.body.append(ghost, sky.layer);
  for (const fixup of fixups) fixup();
  switchInstantly(apply);

  const start = performance.now();
  let frame = 0;
  let settle: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const finish = () => {
    cancelAnimationFrame(frame);
    ghost.remove();
    sky.layer.remove();
    if (running?.finish === finish) running = null;
    settle();
  };
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / THEME_TRANSITION_MS);
    paint(t, toDark, ghost, sky);
    if (t < 1) frame = requestAnimationFrame(tick);
    else finish();
  };
  paint(0, toDark, ghost, sky);
  frame = requestAnimationFrame(tick);
  running = { finish };
  for (const listener of listeners) {
    listener({ toDark, duration: THEME_TRANSITION_MS, finished });
  }
  return true;
}

/** 换掉主题的这一下不让任何元素自己做颜色过渡：整页在同一帧里就是新主题 */
function switchInstantly(apply: () => void) {
  const root = document.documentElement;
  root.classList.add("odea-theme-instant");
  apply();
  void document.body.offsetHeight;
  requestAnimationFrame(() => root.classList.remove("odea-theme-instant"));
}

/* ---------------- 旧主题的副本 ---------------- */

/** fixups：副本挂进页面之后才能做的事（滚动位置、动画进度），收在这里等挂上再跑 */
function buildGhost(fixups: (() => void)[]): HTMLElement {
  const root = document.documentElement;
  const ghost = document.createElement("div");
  ghost.className = "odea-theme-ghost";
  ghost.dataset.ghostTheme = root.dataset.theme === "dark" ? "dark" : "light";
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  // 颜色全是 <html> 上的变量：把这一刻的值钉在副本上，<html> 换了主题副本也不跟着变
  pinVariables(getComputedStyle(root), ghost.style);

  const playing = runningAnimations();
  for (const child of document.body.children) {
    if (child.tagName === "SCRIPT" || child.hasAttribute("data-ghost-skip")) continue;
    if (
      child.classList.contains("odea-theme-ghost") ||
      child.classList.contains("odea-theme-sky")
    ) {
      continue;
    }
    const copy = child.cloneNode(true) as HTMLElement;
    pairUp(child, copy, playing, fixups);
    // 克隆出来的不能带 id（下面统一去掉），#root 的满高靠 id 选择器给的，这里补上
    if (child.id === "root") copy.style.cssText += ";height:100%;overflow:hidden";
    ghost.append(copy);
  }
  // 弹层（命令面板、菜单…）不进副本：它们正要关掉，留在旧主题里会多挂一秒多
  for (const skipped of ghost.querySelectorAll("[data-ghost-skip]")) skipped.remove();
  return ghost;
}

/** 正在播的 CSS 动画（手写 Logo、动态表情…）：元素 → 动画名 → 播到哪了 */
function runningAnimations(): Map<Element, Map<string, number>> {
  const playing = new Map<Element, Map<string, number>>();
  for (const animation of document.getAnimations()) {
    if (!(animation instanceof CSSAnimation)) continue;
    const effect = animation.effect as KeyframeEffect | null;
    const time = animation.currentTime;
    if (!effect?.target || effect.pseudoElement || typeof time !== "number") continue;
    const names = playing.get(effect.target) ?? new Map<string, number>();
    names.set(animation.animationName, time);
    playing.set(effect.target, names);
  }
  return playing;
}

/** 副本里每个元素都要和原件对上的东西：输入框的值、编辑器的语法色、滚动位置、动画进度 */
function pairUp(
  original: Element,
  copy: Element,
  playing: Map<Element, Map<string, number>>,
  fixups: (() => void)[],
) {
  const originals = [original, ...original.querySelectorAll("*")];
  const copies = [copy, ...copy.querySelectorAll("*")];
  originals.forEach((element, index) => {
    const twin = copies[index];
    if (!twin) return;
    const { scrollTop, scrollLeft } = element;
    if (scrollTop || scrollLeft) {
      fixups.push(() => {
        twin.scrollTop = scrollTop;
        twin.scrollLeft = scrollLeft;
      });
    }
    // 副本默认不播动画（克隆出来会从头再播一遍）；原件正播着的，副本接着它的进度一起播，
    // 擦过去的时候两边是同一笔、同一帧
    const names = playing.get(element);
    if (names) {
      twin.setAttribute("data-ghost-anim", "");
      fixups.push(() => {
        for (const animation of twin.getAnimations()) {
          const time = animation instanceof CSSAnimation && names.get(animation.animationName);
          if (typeof time === "number") animation.currentTime = time;
        }
      });
    }
    // 输入框里的当前值在属性之外，cloneNode 带不过去
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      (twin as HTMLInputElement | HTMLTextAreaElement).value = element.value;
    }
    // 语法高亮的颜色写在 .odea-editor 自己身上（按 <html> 的主题选），也得钉住
    if (element.classList.contains("odea-editor") && twin instanceof HTMLElement) {
      pinVariables(getComputedStyle(element), twin.style, "--code-");
    }
    if (twin.id) twin.removeAttribute("id");
  });
}

function pinVariables(from: CSSStyleDeclaration, to: CSSStyleDeclaration, prefix = "--") {
  for (let i = 0; i < from.length; i++) {
    const name = from[i]!;
    if (name.startsWith(prefix)) to.setProperty(name, from.getPropertyValue(name));
  }
}

/* ---------------- 天色：晚霞 / 晨光、太阳的余晖、星星 ---------------- */

interface Star {
  node: HTMLElement;
  /** 在窗口里的位置（0–1） */
  y: number;
  peak: number;
  phase: number;
}

interface Sky {
  layer: HTMLElement;
  band: HTMLElement;
  sun: HTMLElement;
  stars: Star[];
}

/** 晚霞从上往下：上面是已经入夜的靛蓝，交界处玫瑰和橘，往下一点暖金洒在还亮着的页面上 */
const DUSK = `linear-gradient(to bottom,
  rgb(40 38 110 / 0) 0%,
  rgb(52 46 130 / 0.12) 20%,
  rgb(118 70 150 / 0.14) 36%,
  rgb(214 96 112 / 0.16) 48%,
  rgb(250 140 84 / 0.17) 58%,
  rgb(255 186 110 / 0.09) 72%,
  rgb(255 205 140 / 0) 90%)`;

/** 晨光从下往上：下面是已经亮了的页面上一层暖金，交界处桃色，再往上是黎明前的淡紫 */
const DAWN = `linear-gradient(to top,
  rgb(255 222 160 / 0) 0%,
  rgb(255 212 148 / 0.14) 24%,
  rgb(255 186 112 / 0.32) 42%,
  rgb(250 146 124 / 0.24) 54%,
  rgb(176 124 206 / 0.16) 68%,
  rgb(80 84 180 / 0.07) 84%,
  rgb(40 40 120 / 0) 100%)`;

function buildSky(toDark: boolean): Sky {
  const layer = document.createElement("div");
  layer.className = "odea-theme-sky";
  layer.setAttribute("aria-hidden", "true");
  // 日出是光：用 screen 叠上去，暗处被照亮、发出光来（普通叠加在暗底上只是一层发灰的褐色）；
  // 亮处本来就亮，几乎不变。日落是暮色，普通叠加，暖色铺在还亮着的页面上
  if (!toDark) layer.style.mixBlendMode = "screen";

  const band = document.createElement("div");
  band.className = "odea-theme-sky-band";
  band.style.background = toDark ? DUSK : DAWN;

  const sun = document.createElement("div");
  sun.className = "odea-theme-sky-sun";
  sun.style.background = toDark
    ? "radial-gradient(closest-side, rgb(255 138 76 / 0.26), rgb(255 120 90 / 0.1) 55%, rgb(255 120 90 / 0))"
    : "radial-gradient(closest-side, rgb(255 210 130 / 0.5), rgb(255 180 110 / 0.2) 55%, rgb(255 180 110 / 0))";

  const stars = Array.from({ length: STAR_COUNT }, () => {
    const node = document.createElement("div");
    node.className = "odea-theme-star";
    const size = 1.4 + Math.random() * 1.6;
    node.style.width = node.style.height = `${size}px`;
    node.style.left = `${3 + Math.random() * 94}%`;
    // 星星多在上半边，越往下越稀
    const y = 0.03 + Math.random() ** 1.6 * (toDark ? 0.58 : 0.66);
    node.style.top = `${y * 100}%`;
    layer.append(node);
    return { node, y, peak: 0.45 + Math.random() * 0.45, phase: Math.random() };
  });

  layer.append(sun, band);
  return { layer, band, sun, stars };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => {
  const x = clamp01((v - a) / (b - a));
  return x * x * (3 - 2 * x);
};
/** 起步和收尾都慢，中段快：像天色变化，而不是一块幕布匀速拉过去 */
const easeInOut = (t: number) => 0.5 - Math.cos(Math.PI * t) / 2;

function paint(t: number, toDark: boolean, ghost: HTMLElement, sky: Sky) {
  const p = easeInOut(t);
  // 遮罩：从 a 开始由透明（露出新主题）过渡到不透明（还是旧主题），宽 FEATHER
  const a = -FEATHER + (1 + FEATHER) * p;
  const mask = `linear-gradient(${toDark ? "to bottom" : "to top"}, transparent ${(a * 100).toFixed(2)}%, #000 ${((a + FEATHER) * 100).toFixed(2)}%)`;
  ghost.style.maskImage = mask;
  ghost.style.webkitMaskImage = mask;

  const h = window.innerHeight;
  // 明暗交界的中线，从窗口顶上量
  const edge = toDark ? a + FEATHER / 2 : 1 - (a + FEATHER / 2);
  const glow = smooth(0, 0.14, t) * (1 - smooth(0.8, 1, t));

  const bandHeight = h * 1.15;
  sky.band.style.height = `${bandHeight}px`;
  sky.band.style.transform = `translate3d(0, ${edge * h - bandHeight / 2}px, 0)`;
  sky.band.style.opacity = glow.toFixed(3);

  // 太阳：日落时一团余晖压在地平线（窗口底边）上，跟着沉下去、变淡；日出时从底下升起来
  const sunRise = toDark ? 0.12 - 0.42 * p : -0.3 + 0.62 * smooth(0, 0.7, t);
  const sunLight = toDark
    ? 1 - smooth(0.25, 0.85, t)
    : smooth(0, 0.3, t) * (1 - smooth(0.55, 1, t));
  sky.sun.style.transform = `translate3d(-50%, ${-sunRise * h}px, 0)`;
  sky.sun.style.opacity = (sunLight * glow ** 0.5).toFixed(3);

  // 星星：只亮在已经暗下来的那一边；日落时随夜色出现，落定前隐去；日出时光到之前隐去
  const reach = FEATHER * 0.5;
  const settle = 1 - smooth(0.74, 1, t);
  for (const star of sky.stars) {
    // 交界线以上是夜（日落时夜色在上面往下走，日出时光从下面往上走，都一样）
    const dark = smooth(0, reach, edge - star.y);
    const appear = toDark ? 1 : smooth(0, 0.12, t);
    const twinkle = 0.72 + 0.28 * Math.sin((t * 2.2 + star.phase) * Math.PI * 2);
    star.node.style.opacity = (star.peak * dark * appear * settle * twinkle).toFixed(3);
  }
}

function motionReduced(): boolean {
  return (
    document.documentElement.dataset.reduceMotion === "true" ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}
