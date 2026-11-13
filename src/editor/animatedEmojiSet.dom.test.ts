// @vitest-environment happy-dom

import { ANIMATED_EMOJI_FALLBACK, animatedEmojiText } from "@/lib/emojiText";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANIMATED_EMOJIS,
  AUTO_PLAY_LIMIT,
  EMOJI_PART_CSS,
  EMOJI_VIEWBOX,
  EmojiPlayer,
  LOOP_GAP,
  animateWhileVisible,
  animatedEmojiFor,
  inlineAnimatedEmoji,
  keyframesOf,
  motionLength,
  motionReduced,
  resetAnimationBudget,
  resolvePoses,
  stopAnimating,
} from "./animatedEmoji";
import { ANIMATED_EMOJI_DESIGNS, EMOJI_GROUPS, EMOJI_HUES } from "./animatedEmojiSet";

/** EMOJI_PART_CSS 里有样式的类；拼错一个字母就是一块没颜色的图 */
const KNOWN_CLASSES = new Set([
  "o",
  "t",
  "k",
  "p",
  "i",
  "ik",
  "face",
  "rich",
  "blush",
  "shine",
  "shade",
  "road",
  "bold",
  "thin",
  "draw",
  "dash",
  "fx",
  ...EMOJI_HUES.map((hue) => `hue-${hue}`),
]);

function parse(svg: string): Element {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">${svg}</svg>`,
    "image/svg+xml",
  );
  expect(doc.querySelector("parsererror")).toBeNull();
  return doc.documentElement;
}

afterEach(() => {
  document.documentElement.removeAttribute("data-reduce-motion");
  vi.restoreAllMocks();
});

describe("动态表情设计稿的规矩", () => {
  it("styles every class the designs are allowed to use", () => {
    for (const name of KNOWN_CLASSES) {
      expect(EMOJI_PART_CSS, `.${name}`).toMatch(new RegExp(`\\.${name}(?![\\w-])`));
    }
  });

  it("ids are unique, short-code safe and every one has a Unicode fallback", () => {
    const ids = ANIMATED_EMOJI_DESIGNS.map((design) => design.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9_]+$/);
    // 主包里的小表和设计稿必须一一对应
    expect(Object.keys(ANIMATED_EMOJI_FALLBACK).sort()).toEqual([...ids].sort());
    for (const emoji of ANIMATED_EMOJIS) expect(emoji.fallback).not.toBe("");
  });

  it("fills every picker group with exactly one row of six", () => {
    for (const group of EMOJI_GROUPS) {
      expect(ANIMATED_EMOJI_DESIGNS.filter((design) => design.group === group.id)).toHaveLength(6);
    }
  });

  for (const design of ANIMATED_EMOJI_DESIGNS) {
    describe(design.id, () => {
      const root = parse(design.svg);

      it("has a name, keywords and a known hue", () => {
        expect(design.name.trim()).not.toBe("");
        expect(design.keywords.split(" ").length).toBeGreaterThan(3);
        expect(EMOJI_HUES).toContain(design.hue);
      });

      it("only uses classes the stylesheet knows", () => {
        for (const element of root.querySelectorAll("[class]")) {
          for (const name of element.getAttribute("class")!.split(/\s+/)) {
            expect(KNOWN_CLASSES, `${design.id}: .${name}`).toContain(name);
          }
        }
      });

      it("pairs every animated part with a motion and vice versa", () => {
        const parts = [...root.querySelectorAll("[data-a]")].map((el) => el.getAttribute("data-a"));
        expect(new Set(parts).size).toBe(parts.length);
        expect([...parts].sort()).toEqual(Object.keys(design.motion).sort());
      });

      it("never puts a transform attribute on an animated part (CSS transform would erase it)", () => {
        for (const part of root.querySelectorAll("[data-a]")) {
          expect(part.hasAttribute("transform"), part.getAttribute("data-a")!).toBe(false);
        }
      });

      it("only hides parts that an animation brings back", () => {
        for (const hidden of root.querySelectorAll(".fx")) {
          const name = hidden.getAttribute("data-a");
          expect(name, "fx 部件必须自己带 data-a").toBeTruthy();
          const steps = design.motion[name!]!.steps;
          expect(steps.some(([, pose]) => (pose.o ?? 0) > 0)).toBe(true);
        }
      });

      it("draws strokes only on normalised paths", () => {
        for (const [name, motion] of Object.entries(design.motion)) {
          if (!motion.steps.some(([, pose]) => pose.d !== undefined)) continue;
          const part = root.querySelector(`[data-a="${name}"]`)!;
          expect(part.getAttribute("pathLength")).toBe("1");
          expect(/\b(draw|dash)\b/.test(part.getAttribute("class") ?? "")).toBe(true);
        }
      });

      it("keeps steps ordered inside one iteration", () => {
        for (const motion of Object.values(design.motion)) {
          const offsets = motion.steps.map(([offset]) => offset);
          expect(offsets[0]).toBe(0);
          for (let i = 1; i < offsets.length; i += 1) {
            expect(offsets[i]!).toBeGreaterThan(offsets[i - 1]!);
          }
          expect(offsets.at(-1)!).toBeLessThanOrEqual(1);
          expect(motion.duration).toBeGreaterThanOrEqual(300);
          expect(motion.duration).toBeLessThanOrEqual(2000);
        }
        // 一轮不超过 2.5 秒：它是正文里的一个字，不是一段视频
        expect(motionLength(design)).toBeLessThanOrEqual(2500);
      });

      it("ends every motion on its resting pose, so nothing jumps when it stops", () => {
        for (const [name, motion] of Object.entries(design.motion)) {
          const last = resolvePoses(motion.steps).at(-1)!;
          const hidden = root.querySelector(`[data-a="${name}"]`)!.classList.contains("fx");
          expect(last.o, `${name} 的透明度`).toBe(hidden ? 0 : 1);
          // 粒子、泪滴最后是透明的，停在哪儿都看不见；其余部件必须回到原位
          if (hidden || motion.seamless) continue;
          expect(
            { x: last.x, y: last.y, r: last.r, sx: last.sx, sy: last.sy, kx: last.kx, ky: last.ky },
            name,
          ).toEqual({ x: 0, y: 0, r: 0, sx: 1, sy: 1, kx: 0, ky: 0 });
          expect(last.d, `${name} 的描边`).toBe(0);
        }
      });
    });
  }
});

describe("关键帧", () => {
  it("carries unspecified values forward and lets s drive both axes", () => {
    const poses = resolvePoses([
      [0, { x: 2 }],
      [0.5, { s: 1.2 }],
      [1, { sy: 0.8 }],
    ]);
    expect(poses.map(({ x, sx, sy }) => ({ x, sx, sy }))).toEqual([
      { x: 2, sx: 1, sy: 1 },
      { x: 2, sx: 1.2, sy: 1.2 },
      { x: 2, sx: 1.2, sy: 0.8 },
    ]);
  });

  it("writes the same transform function list on every frame", () => {
    const frames = keyframesOf([
      [0, {}],
      [0.5, { r: 10 }, "ease-in"],
      [1, {}],
    ]);
    expect(frames).toHaveLength(3);
    expect(frames[1]).toMatchObject({ offset: 0.5, easing: "ease-in" });
    const shape = (frame: Keyframe) => String(frame.transform).replace(/-?[\d.]+/g, "N");
    expect(new Set(frames.map(shape)).size).toBe(1);
    expect(frames[0]!.opacity).toBeUndefined();
  });

  it("holds the last pose until the end instead of sliding back to rest", () => {
    // 星星转到 72° 停在 0.62：不补末帧的话浏览器会从 72° 慢慢转回 0°
    const frames = keyframesOf([
      [0, { r: 0 }],
      [0.62, { r: 72 }],
    ]);
    expect(frames.map((frame) => frame.offset)).toEqual([0, 0.62, 1]);
    expect(frames[2]!.transform).toBe(frames[1]!.transform);
  });

  it("animates opacity and stroke only when a motion asks for them", () => {
    const [first] = keyframesOf([
      [0, { o: 0, d: 1 }],
      [1, { o: 1, d: 0 }],
    ]);
    expect(first).toMatchObject({ opacity: 0, strokeDashoffset: "1" });
    expect(first!.transform).toBeUndefined();
  });
});

describe("短码", () => {
  it("resolves case-insensitively, with or without colons", () => {
    expect(animatedEmojiFor(":odea_fire:")?.id).toBe("fire");
    expect(animatedEmojiFor("ODEA_Fire")?.id).toBe("fire");
    expect(animatedEmojiFor(":fire:")).toBeNull();
    expect(animatedEmojiFor(":odea_nope:")).toBeNull();
    // 纯数字的短码也是合法的 lezer Emoji 语法
    expect(animatedEmojiFor(":odea_666:")?.id).toBe("666");
  });

  it("turns short codes into Unicode for plain-text surfaces", () => {
    expect(animatedEmojiText("冲 :odea_fire: 好 :ODEA_DONE:")).toBe("冲 🔥 好 ✅");
    expect(animatedEmojiText("留着 :odea_nope: 和 :smile:")).toBe("留着 :odea_nope: 和 :smile:");
    expect(animatedEmojiText("没有短码")).toBe("没有短码");
    expect(animatedEmojiText("太强了 :odea_666: 摸鱼:odea_fish:")).toBe("太强了 666 摸鱼🐟");
  });

  it("still knows the :otw_ codes written before the rename", () => {
    expect(animatedEmojiFor(":otw_fire:")?.id).toBe("fire");
    expect(animatedEmojiFor(":otw_fire:")?.shortcode).toBe(":odea_fire:");
    expect(animatedEmojiText("旧的 :otw_fire: 新的 :odea_done:")).toBe("旧的 🔥 新的 ✅");
  });
});

describe("播放器", () => {
  const fire = animatedEmojiFor(":odea_fire:")!;
  const parts = Object.keys(fire.motion).sort();

  /** 让 animate 返回可控的假动画：finish() 让这一轮播完 */
  function fakeAnimations() {
    const finishers: Array<() => void> = [];
    const started: string[] = [];
    const cancelled: string[] = [];
    const options: Array<KeyframeAnimationOptions> = [];
    const spy = vi.spyOn(Element.prototype, "animate").mockImplementation(function (
      this: Element,
      _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      timing?: number | KeyframeAnimationOptions,
    ) {
      const name = (this as SVGElement).dataset?.a ?? "body";
      started.push(name);
      options.push(typeof timing === "object" ? timing : {});
      let done!: () => void;
      let state = "running";
      const finished = new Promise<void>((resolve) => {
        done = () => {
          state = "finished";
          resolve();
        };
      });
      finishers.push(() => done());
      return {
        get playState() {
          return state;
        },
        finished,
        cancel: () => {
          cancelled.push(name);
          done();
        },
      } as unknown as Animation;
    });
    const finishAll = async () => {
      for (const finish of finishers.splice(0)) finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { spy, started, cancelled, options, finishAll };
  }

  const mounted = (emoji = fire) => {
    const host = document.createElement("span");
    host.className = "odea-ae";
    document.body.append(host);
    const player = new EmojiPlayer(emoji);
    player.mount(host);
    return { host, player };
  };

  it("falls back to a live SVG when the theme colours are not available", () => {
    const { host } = mounted();
    const svg = host.querySelector("svg.odea-ae-svg")!;
    expect(svg).not.toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(svg.getAttribute("viewBox")).toBe(EMOJI_VIEWBOX);
    expect(svg.classList.contains("hue-orange")).toBe(true);
    expect(svg.querySelectorAll("[data-a]")).toHaveLength(parts.length);
  });

  it("injects the part styles once", () => {
    mounted();
    mounted();
    const styles = document.head.querySelectorAll("style[data-odea-animated-emoji]");
    expect(styles).toHaveLength(1);
    expect(styles[0]!.textContent).toBe(EMOJI_PART_CSS);
  });

  it("stays still when motion is reduced", () => {
    document.documentElement.dataset.reduceMotion = "true";
    expect(motionReduced()).toBe(true);
    const { spy } = fakeAnimations();
    const { player } = mounted();
    player.loop();
    expect(spy).not.toHaveBeenCalled();
    expect(player.playing).toBe(false);
  });

  it("plays one round per part, rests for the gap, then goes again until stopped", () => {
    vi.useFakeTimers();
    try {
      const { started, cancelled, options } = fakeAnimations();
      const { player } = mounted();
      player.loop();
      expect(player.playing).toBe(true);
      expect([...started].sort()).toEqual(parts);
      // 一轮就是设计稿里的一轮：各部件自己的时长、延迟和重复次数
      for (const [index, name] of started.entries()) {
        const motion = fire.motion[name]!;
        expect(options[index]).toMatchObject({
          duration: motion.duration,
          delay: motion.delay ?? 0,
          iterations: motion.iterations ?? 1,
          fill: "backwards",
        });
      }
      const period = motionLength(fire) + LOOP_GAP;
      vi.advanceTimersByTime(period - 1);
      expect(started).toHaveLength(parts.length);
      vi.advanceTimersByTime(1);
      expect(started).toHaveLength(parts.length * 2);
      player.stop();
      expect(player.playing).toBe(false);
      vi.advanceTimersByTime(period * 3);
      expect(started).toHaveLength(parts.length * 2);
      expect(cancelled.length).toBeGreaterThanOrEqual(parts.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can wait on the still frame before the first round", () => {
    vi.useFakeTimers();
    try {
      const { started } = fakeAnimations();
      const { player } = mounted();
      player.loop({ wait: 300 });
      expect(player.playing).toBe(true);
      expect(started).toEqual([]);
      vi.advanceTimersByTime(299);
      expect(started).toEqual([]);
      vi.advanceTimersByTime(1);
      expect([...started].sort()).toEqual(parts);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("看得见才动", () => {
    /** 可控的 IntersectionObserver：show / hide 手动报告可见性 */
    class FakeObserver {
      static current: FakeObserver | null = null;
      readonly targets = new Set<Element>();
      constructor(private readonly callback: IntersectionObserverCallback) {
        FakeObserver.current = this;
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
      report(isIntersecting: boolean, targets: Element[]) {
        this.callback(
          targets.map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry),
          this as unknown as IntersectionObserver,
        );
      }
    }
    const show = (...targets: Element[]) => FakeObserver.current!.report(true, targets);
    const hide = (...targets: Element[]) => FakeObserver.current!.report(false, targets);

    beforeEach(() => {
      resetAnimationBudget();
      vi.stubGlobal("IntersectionObserver", FakeObserver);
    });
    afterEach(() => {
      resetAnimationBudget();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it("loops while visible and goes back to the still frame when scrolled away", () => {
      fakeAnimations();
      const { host, player } = mounted();
      animateWhileVisible(host, player);
      // 挂上了但还没露出来：静止
      expect(player.playing).toBe(false);
      show(host);
      expect(player.playing).toBe(true);
      hide(host);
      expect(player.playing).toBe(false);
      show(host);
      expect(player.playing).toBe(true);
      stopAnimating(host);
      expect(player.playing).toBe(false);
      expect(FakeObserver.current!.targets.has(host)).toBe(false);
    });

    it("treats everything as visible when there is no IntersectionObserver", () => {
      vi.stubGlobal("IntersectionObserver", undefined);
      fakeAnimations();
      const { host, player } = mounted();
      animateWhileVisible(host, player);
      expect(player.playing).toBe(true);
    });

    it("caps how many loop at once and hands a freed slot to the next in line", () => {
      fakeAnimations();
      const all = Array.from({ length: AUTO_PLAY_LIMIT + 3 }, () => {
        const { host, player } = mounted();
        animateWhileVisible(host, player);
        return { host, player };
      });
      show(...all.map(({ host }) => host));
      expect(all.filter(({ player }) => player.playing)).toHaveLength(AUTO_PLAY_LIMIT);
      hide(all[0]!.host);
      expect(all[AUTO_PLAY_LIMIT]!.player.playing).toBe(true);
      expect(all.filter(({ player }) => player.playing)).toHaveLength(AUTO_PLAY_LIMIT);
      // 排队的滚出去了就不再排，名额留给还看得见的
      hide(all[AUTO_PLAY_LIMIT + 1]!.host);
      stopAnimating(all[1]!.host);
      expect(all[AUTO_PLAY_LIMIT + 2]!.player.playing).toBe(true);
      expect(all[AUTO_PLAY_LIMIT + 1]!.player.playing).toBe(false);
    });

    it("pops a freshly inserted emoji straight away, even over the cap", () => {
      const { started } = fakeAnimations();
      const crowd = Array.from({ length: AUTO_PLAY_LIMIT }, () => {
        const { host, player } = mounted();
        animateWhileVisible(host, player);
        return host;
      });
      show(...crowd);
      started.length = 0;
      const { host, player } = mounted();
      animateWhileVisible(host, player, { intro: true });
      expect(player.playing).toBe(true);
      expect(started).toContain("body");
      // 观察器随后报告「看得见」：接着转，不从头再弹一次
      const restart = vi.spyOn(player, "loop");
      show(host);
      expect(restart).not.toHaveBeenCalled();
    });

    it("forgets emoji that were taken out of the document", () => {
      fakeAnimations();
      const { host, player } = mounted();
      animateWhileVisible(host, player);
      show(host);
      host.remove();
      hide(host);
      expect(player.playing).toBe(false);
      expect(FakeObserver.current!.targets.has(host)).toBe(false);
    });

    it("goes still when reduced motion is switched on and resumes when it is off", async () => {
      fakeAnimations();
      const { host, player } = mounted();
      animateWhileVisible(host, player);
      show(host);
      document.documentElement.dataset.reduceMotion = "true";
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(player.playing).toBe(false);
      delete document.documentElement.dataset.reduceMotion;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(player.playing).toBe(true);
    });
  });

  it("renders a static inline copy whose text is the Unicode fallback", () => {
    const node = inlineAnimatedEmoji(fire);
    expect(node.querySelector(".odea-ae-live, .odea-ae-still")).not.toBeNull();
    expect(node.textContent).toBe("🔥");
    expect(node.getAttribute("aria-label")).toBe(fire.name);
  });

  describe("静止帧是一张图", () => {
    const light: Record<string, string> = {
      "--ae-red": "#e5484d",
      "--ae-orange": "#f0701f",
      "--ae-amber": "#e3a008",
      "--ae-green": "#2f9e62",
      "--ae-blue": "#2f63d8",
      "--ae-sky": "#3a8fd6",
      "--ae-purple": "#7c5cd6",
      "--ae-pink": "#e0569a",
      "--ae-brown": "#9a6440",
      "--ae-slate": "#6f7b8c",
      "--color-canvas": "#ffffff",
      "--color-ink": "#1a1a18",
    };
    const setPalette = (values: Record<string, string>) => {
      for (const [name, value] of Object.entries(values)) {
        document.documentElement.style.setProperty(name, value);
      }
    };
    /** 静止帧：<svg class="odea-ae-still"><image href="data:…"/></svg> */
    const stillOf = (host: Element) => host.querySelector<SVGSVGElement>("svg.odea-ae-still")!;
    const decode = (still: SVGSVGElement) =>
      decodeURIComponent(
        (still.querySelector("image")?.getAttribute("href") ?? "").replace(
          /^data:image\/svg\+xml;charset=utf-8,/,
          "",
        ),
      );

    it("draws the resting frame as one image carrying its own colours and styles", () => {
      setPalette(light);
      const { host } = mounted();
      const still = stillOf(host);
      expect(still).not.toBeNull();
      // 静止时框里只有这一个小 SVG，里面只有一张图
      expect(host.children).toHaveLength(1);
      expect(still.querySelectorAll("*")).toHaveLength(1);
      // 外框和活的 SVG 同一个 viewBox；图自己的画布四周多留 3 个单位，放在 (-3, -3)
      expect(still.getAttribute("viewBox")).toBe(EMOJI_VIEWBOX);
      const image = still.querySelector("image")!;
      expect(["x", "y", "width", "height"].map((name) => image.getAttribute(name))).toEqual([
        "-3",
        "-3",
        "30",
        "30",
      ]);
      const svg = decode(still);
      expect(svg).toContain('viewBox="-3 -3 30 30"');
      expect(svg).toContain("--ae-orange:#f0701f");
      expect(svg).toContain("--color-canvas:#ffffff");
      expect(svg).toContain(EMOJI_PART_CSS.split("\n")[5]!);
      // 同一个表情的所有实例共用同一张图
      expect(decode(stillOf(mounted().host))).toBe(svg);
    });

    it("lays the live SVG over the image only while it loops", () => {
      fakeAnimations();
      const { host, player } = mounted();
      const still = stillOf(host);
      player.loop();
      expect(player.liveSvg).not.toBeNull();
      expect(host.querySelector("svg.odea-ae-live")).toBe(player.liveSvg);
      expect(still.style.display).toBe("none");
      expect(still.isConnected).toBe(true);
      player.stop();
      expect(player.liveSvg).toBeNull();
      expect(host.querySelector("svg.odea-ae-live")).toBeNull();
      expect(still.style.display).toBe("");
    });

    it("keeps the same live SVG when the loop restarts", () => {
      fakeAnimations();
      const { player } = mounted();
      player.loop();
      const live = player.liveSvg;
      player.loop({ intro: true });
      expect(player.liveSvg).toBe(live);
      expect(player.playing).toBe(true);
    });

    it("recolours every resting image when the theme changes", async () => {
      const { host } = mounted();
      const still = stillOf(host);
      setPalette({ "--ae-orange": "#ff8d4a", "--color-canvas": "#1e1e1c" });
      document.documentElement.dataset.theme = "dark";
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(decode(still)).toContain("--ae-orange:#ff8d4a");
      expect(decode(still)).toContain("--color-canvas:#1e1e1c");
      // 新挂的也是新颜色
      expect(decode(stillOf(mounted().host))).toContain("--ae-orange:#ff8d4a");
    });
  });
});
