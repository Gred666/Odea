// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { typoraDecorations } from "./MarkdownEditor";
import { type AttachmentHost, attachmentHost } from "./attachmentEmbed";
import { markdownSupport } from "./markdownParser";

const views: EditorView[] = [];

function mount(doc: string, host: AttachmentHost | null, anchor = doc.length) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdownSupport(), typoraDecorations, attachmentHost.of(host)],
    }),
  });
  views.push(view);
  return { parent, view };
}

const FILES: Record<string, string> = {
  "说明书.pdf": "附件/说明书.pdf",
  "录音.m4a": "附件/录音.m4a",
  "季度/报表.xlsx": "笔记/季度/报表.xlsx",
  "访谈.m4a": "附件/访谈.m4a",
  "讲座.m4a": "附件/讲座.m4a",
  "周会.m4a": "附件/周会.m4a",
  "复盘.m4a": "附件/复盘.m4a",
  "演示.mp4": "附件/演示.mp4",
};

function host(open = vi.fn(), remote = false): AttachmentHost {
  return {
    resolve: (name) => {
      const rel = FILES[name];
      return rel ? { rel, src: `asset://${rel}` } : null;
    },
    open,
    remote,
  };
}

const cards = (parent: HTMLElement) => [...parent.querySelectorAll<HTMLElement>(".cm-odea-file")];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe("![[说明书.pdf]] 附件卡片", () => {
  it("draws a card for an attachment on its own line, and leaves everything else alone", () => {
    const doc = [
      "![[说明书.pdf]]",
      "",
      "![[季度/报表.xlsx|三季度报表]]",
      "",
      "夹在字里的 ![[说明书.pdf]] 不画卡片",
      "",
      "![[找不到.docx]]",
      "",
      "![[周报]]",
      "",
      "末尾",
    ].join("\n");
    const { parent } = mount(doc, host());
    const [pdf, sheet, missing, ...rest] = cards(parent);
    expect(rest).toHaveLength(0);
    expect(pdf?.classList.contains("is-pdf")).toBe(true);
    expect(pdf?.querySelector(".cm-odea-file-name")?.textContent).toBe("说明书.pdf");
    expect(pdf?.querySelector(".cm-odea-file-meta")?.textContent).toBe("PDF 文档 · 附件");
    // 写了 `|别名` 的显示别名
    expect(sheet?.querySelector(".cm-odea-file-name")?.textContent).toBe("三季度报表");
    expect(sheet?.querySelector(".cm-odea-file-meta")?.textContent).toBe("Excel 表格 · 笔记/季度");
    expect(missing?.classList.contains("is-missing")).toBe(true);
    expect(missing?.textContent).toContain("仓库里找不到「找不到.docx」");
    expect(missing?.querySelector("button")).toBeNull();
    // 源码收着：那一行只剩卡片
    expect(parent.querySelector(".cm-odea-embed-line")?.textContent).not.toContain("![[");
  });

  it("opens the file and reveals it from the card's buttons", () => {
    const open = vi.fn();
    const { parent, view } = mount("![[说明书.pdf]]\n\n末尾", host(open));
    const [openButton, revealButton] = [...parent.querySelectorAll<HTMLButtonElement>("button")];
    openButton!.click();
    revealButton!.click();
    expect(open.mock.calls).toEqual([
      ["说明书.pdf", false],
      ["说明书.pdf", true],
    ]);
    // 点按钮不挪光标
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it("plays audio and video in the card", () => {
    const { parent } = mount("![[录音.m4a]]\n\n末尾", host());
    const audio = parent.querySelector("audio");
    expect(audio?.getAttribute("src")).toBe("asset://附件/录音.m4a");
    expect(audio?.controls).toBe(true);
  });

  it("keeps the same player when the cursor comes onto the line and leaves again", () => {
    const { parent, view } = mount("![[录音.m4a]]\n\n末尾", host());
    const audio = parent.querySelector("audio");
    expect(audio).not.toBeNull();
    // 光标进这一行（点卡片空白处、方向键路过）：源码露出来，但播放器还是那一个 —— 换一个新的，正在放的就断了
    view.dispatch({ selection: { anchor: 3 } });
    expect(parent.querySelector(".cm-odea-embed-source")?.textContent).toContain("录音.m4a]]");
    expect(parent.querySelector(".cm-odea-file-frame")?.classList.contains("is-open")).toBe(true);
    expect(parent.querySelector("audio")).toBe(audio);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(parent.querySelector(".cm-odea-file-frame")?.classList.contains("is-open")).toBe(false);
    expect(parent.querySelector("audio")).toBe(audio);
    // 换了文件才换卡片
    view.dispatch({ changes: { from: 3, to: 5, insert: "说明书.pdf]]\n\n![[录音" } });
    expect(parent.querySelector(".cm-odea-file.is-pdf")).not.toBeNull();
  });

  it("shows the source under the card when the cursor is on that line", () => {
    const { parent } = mount("![[说明书.pdf]]\n\n末尾", host(), 3);
    expect(cards(parent)).toHaveLength(1);
    expect(parent.querySelector(".cm-odea-embed-source")?.textContent).toContain("说明书.pdf]]");
  });

  it("asks the host for a guest's attachment and has no reveal button", () => {
    const open = vi.fn();
    const guest: AttachmentHost = {
      resolve: (name) => ({ rel: name, src: "" }),
      open,
      remote: true,
    };
    const { parent } = mount("![[录音.m4a]]\n\n末尾", guest);
    expect(parent.querySelector(".cm-odea-file-meta")?.textContent).toBe("音频 · 在主持人那边");
    // 主持人那边的音视频要先整个要过来，卡片里不放
    expect(parent.querySelector("audio")).toBeNull();
    const buttons = [...parent.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons).toHaveLength(1);
    buttons[0]!.click();
    expect(open).toHaveBeenCalledWith("录音.m4a", false);
  });

  it("stays source without a host (the browser lab)", () => {
    const { parent } = mount("![[说明书.pdf]]\n\n末尾", null);
    expect(cards(parent)).toHaveLength(0);
  });
});

/* ---------- 滚远了接着放（editor/mediaKeeper.ts，docs/技术方案.md §11.4.6） ----------
   happy-dom 的 HTMLMediaElement：play() / pause() 同步改 paused、同步发 play / pause 事件；currentTime
   就是个能写的数（不会自己走、不发 timeupdate）；duration 是 NaN、ended 是 false，都只读。
   内核的那一条它不管：Chrome 在「从文档里拿下来以后的下一个任务」查一遍，还不在文档里的就暂停。
   这里补上（kernel）。IntersectionObserver 是个不报的空壳，换成能手动报的（FakeObserver） */

const playing = new Set<HTMLMediaElement>();
const realPlay = HTMLMediaElement.prototype.play;

/** 等 CodeMirror 量完、重画完（它在 requestAnimationFrame 里量），再过一个任务，照 Chrome 把不在文档里的停掉 */
async function kernel() {
  await new Promise((resolve) => setTimeout(resolve, 40));
  for (const media of playing) if (!media.isConnected && !media.paused) media.pause();
}

/** 滚到文末：开头的卡片出了 CodeMirror 画的那一段，DOM 被拆掉 */
async function far(view: EditorView) {
  view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.length) });
  await kernel();
}

async function back(view: EditorView) {
  view.dispatch({ effects: EditorView.scrollIntoView(0) });
  await kernel();
}

class FakeObserver {
  static all: FakeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeObserver.all.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    FakeObserver.all = FakeObserver.all.filter((observer) => observer !== this);
  }
  takeRecords() {
    return [];
  }
  /** 报一次：target 在不在这一栏的可视区里 */
  static report(target: Element, visible: boolean) {
    for (const observer of FakeObserver.all) {
      if (!observer.targets.has(target)) continue;
      const record = {
        target,
        isIntersecting: visible,
        intersectionRatio: visible ? 1 : 0,
      } as unknown as IntersectionObserverEntry;
      observer.callback([record], observer as unknown as IntersectionObserver);
    }
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** 有几个观察器在看播放器（编辑器里别的替身也用 IntersectionObserver） */
const watchingMedia = () =>
  FakeObserver.all.filter((observer) =>
    [...observer.targets].some((target) => target instanceof HTMLMediaElement),
  ).length;
const LONG = (head: string) =>
  `${head}\n\n${Array.from({ length: 400 }, (_, i) => `第 ${i + 1} 段，一边听一边记。`).join("\n\n")}\n`;
const bar = () => document.querySelector<HTMLElement>(".odea-media-bar");
const barShown = () => bar()?.classList.contains("is-shown") === true;
const barButton = (label: string) =>
  [...(bar()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (node) => node.getAttribute("aria-label") === label,
  );
const slider = () => bar()?.querySelector<HTMLElement>("[role=slider]") ?? null;
const keptSlot = () => document.querySelector<HTMLElement>(".odea-media-keep");
const mediaOf = (parent: HTMLElement, name: string) =>
  [...parent.querySelectorAll<HTMLMediaElement>("audio, video")].find((media) =>
    media.getAttribute("src")?.endsWith(name),
  ) ?? null;
/** 条显示着时编辑器在底下留出的边距 */
const bottomMargin = (view: EditorView) =>
  Math.max(0, ...view.state.facet(EditorView.scrollMargins).map((f) => f(view)?.bottom ?? 0));

async function play(media: HTMLMediaElement, at = 0) {
  media.currentTime = at;
  await media.play();
  await settle();
}

function setDuration(media: HTMLMediaElement, seconds: number) {
  Object.defineProperty(media, "duration", { configurable: true, value: seconds });
  media.dispatchEvent(new Event("durationchange"));
}

describe("卡片里的录音、视频滚远了接着放", () => {
  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      playing.add(this);
      return realPlay.call(this);
    };
  });
  afterEach(() => {
    HTMLMediaElement.prototype.play = realPlay;
    playing.clear();
    FakeObserver.all = [];
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.reduceMotion;
  });

  it("keeps a playing recording going when its card is torn down far away, and hands the same one back", async () => {
    const { parent, view } = mount(LONG("![[录音.m4a]]"), host());
    const audio = parent.querySelector("audio")!;
    await play(audio, 3);

    await far(view);
    // 卡片拆了，播放器藏在这一栏的保管处：还在文档里、没被暂停、进度没动
    expect(parent.querySelector(".cm-odea-file")).toBeNull();
    expect(audio.isConnected).toBe(true);
    expect(view.contentDOM.contains(audio)).toBe(false);
    expect(keptSlot()?.contains(audio)).toBe(true);
    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBe(3);

    await back(view);
    // 滚回来：新画的卡片里是同一个元素，接着放
    expect(parent.querySelector("audio")).toBe(audio);
    expect(audio.closest(".cm-odea-file")).not.toBeNull();
    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBe(3);
    expect(keptSlot()).toBeNull();
  });

  it("keeps one paused halfway, but not one never played or played to the end", async () => {
    const doc = LONG("![[录音.m4a]]\n\n![[访谈.m4a]]\n\n![[讲座.m4a]]");
    const { parent, view } = mount(doc, host());
    const halfway = mediaOf(parent, "录音.m4a")!;
    const untouched = mediaOf(parent, "访谈.m4a")!;
    const finished = mediaOf(parent, "讲座.m4a")!;
    await play(halfway, 7);
    halfway.pause();
    await play(finished, 0);
    finished.currentTime = 60;
    finished.pause();
    Object.defineProperty(finished, "ended", { configurable: true, value: true });
    finished.dispatchEvent(new Event("ended"));
    await settle();

    await far(view);
    expect(keptSlot()?.contains(halfway)).toBe(true);
    // 没放过的、放完了的不留：放掉（去掉 src），回来是新的一个
    expect(untouched.isConnected).toBe(false);
    expect(untouched.getAttribute("src")).toBeNull();
    expect(finished.getAttribute("src")).toBeNull();

    await back(view);
    expect(mediaOf(parent, "录音.m4a")).toBe(halfway);
    expect(halfway.currentTime).toBe(7);
    expect(mediaOf(parent, "访谈.m4a")).not.toBe(untouched);
    expect(mediaOf(parent, "讲座.m4a")).not.toBe(finished);
  });

  it("parks at most three paused ones, letting go of the one paused longest ago", async () => {
    const names = ["录音.m4a", "访谈.m4a", "讲座.m4a", "周会.m4a", "复盘.m4a"];
    const { parent, view } = mount(LONG(names.map((name) => `![[${name}]]`).join("\n\n")), host());
    const media = names.map((name) => mediaOf(parent, name)!);
    for (const [index, element] of media.entries()) {
      await play(element, index + 1);
      element.pause();
    }
    await far(view);
    const kept = media.filter((element) => keptSlot()?.contains(element));
    expect(kept).toEqual(media.slice(2));
    expect(media[0]!.getAttribute("src")).toBeNull();
    expect(media[1]!.getAttribute("src")).toBeNull();
  });

  it("doesn't break when the whole card is redrawn (a new |alias)", async () => {
    const { parent, view } = mount("![[录音.m4a]]\n\n末尾", host());
    const audio = parent.querySelector("audio")!;
    await play(audio, 4);
    view.dispatch({ changes: { from: "![[录音.m4a".length, insert: "|周一的会" } });
    await kernel();
    expect(parent.querySelector(".cm-odea-file-name")?.textContent).toBe("周一的会");
    expect(parent.querySelector("audio")).toBe(audio);
    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBe(4);
    expect(keptSlot()).toBeNull();
  });

  it("shows a bar at the bottom while the playing one is out of sight", async () => {
    const { parent, view } = mount(LONG("![[录音.m4a|周一的会]]"), host());
    const audio = parent.querySelector("audio")!;
    await play(audio, 1);
    expect(barShown()).toBe(false);
    expect(bottomMargin(view)).toBe(0);

    // 卡片还在 DOM 里、滚出了可视区
    FakeObserver.report(audio, false);
    await settle();
    expect(barShown()).toBe(true);
    expect(bar()?.querySelector(".odea-media-bar-name")?.textContent).toBe("周一的会");
    // 打字、方向键把光标带到条上面
    expect(bottomMargin(view)).toBeGreaterThanOrEqual(52);
    FakeObserver.report(audio, true);
    await settle();
    expect(barShown()).toBe(false);
    expect(bar()?.inert).toBe(true);
    expect(bottomMargin(view)).toBe(0);

    // 卡片拆了、藏在保管处
    await far(view);
    expect(barShown()).toBe(true);
    await back(view);
    expect(barShown()).toBe(false);
  });

  it("shows no bar for one paused on its card and then scrolled away", async () => {
    const { parent, view } = mount(LONG("![[录音.m4a]]"), host());
    const audio = parent.querySelector("audio")!;
    await play(audio, 5);
    audio.pause();
    await far(view);
    expect(keptSlot()?.contains(audio)).toBe(true);
    expect(barShown()).toBe(false);
  });

  it("plays and pauses from the bar, and the bar stays while paused", async () => {
    const { parent, view } = mount(LONG("![[录音.m4a]]"), host());
    const audio = parent.querySelector("audio")!;
    await play(audio, 2);
    await far(view);
    const pause = barButton("暂停")!;
    // 按下不抢正文的焦点
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    pause.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    pause.click();
    await settle();
    expect(audio.paused).toBe(true);
    expect(barShown()).toBe(true);
    expect(barButton("暂停")).toBeUndefined();
    barButton("播放")!.click();
    await settle();
    expect(audio.paused).toBe(false);
    expect(barButton("暂停")).toBeDefined();
  });

  it("seeks with the progress slider: keyboard, click and drag", async () => {
    const { parent, view } = mount(LONG("![[录音.m4a]]"), host());
    const audio = parent.querySelector("audio")!;
    setDuration(audio, 100);
    await play(audio, 20);
    await far(view);
    const track = slider()!;
    expect(track.tabIndex).toBe(0);
    expect(track.getAttribute("aria-valuemin")).toBe("0");
    expect(track.getAttribute("aria-valuemax")).toBe("100");
    expect(track.getAttribute("aria-valuenow")).toBe("20");
    expect(track.getAttribute("aria-valuetext")).toBe("0:20 / 1:40");
    const key = (name: string) => {
      const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
      track.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(key("ArrowRight")).toBe(true);
    expect(audio.currentTime).toBe(25);
    key("ArrowLeft");
    key("ArrowLeft");
    expect(audio.currentTime).toBe(15);
    expect(track.getAttribute("aria-valuenow")).toBe("15");
    key("Home");
    expect(audio.currentTime).toBe(0);
    key("End");
    expect(audio.currentTime).toBe(100);
    key("Home");

    // 点哪跳哪、能拖；按下不抢焦点
    track.getBoundingClientRect = () => ({ left: 100, width: 200, top: 0, height: 28 }) as DOMRect;
    const pointer = (type: string, x: number) => {
      const event = new PointerEvent(type, {
        clientX: x,
        button: 0,
        pointerId: 1,
        bubbles: true,
        cancelable: true,
      });
      track.dispatchEvent(event);
      return event;
    };
    expect(pointer("pointerdown", 150).defaultPrevented).toBe(true);
    expect(audio.currentTime).toBe(25);
    pointer("pointermove", 250);
    expect(audio.currentTime).toBe(75);
    pointer("pointerup", 250);
    pointer("pointermove", 120);
    expect(audio.currentTime).toBe(75);
  });

  it("glides back to the card without moving the cursor", async () => {
    document.documentElement.dataset.reduceMotion = "true";
    const { parent, view } = mount(LONG("![[录音.m4a]]"), host());
    const audio = parent.querySelector("audio")!;
    await play(audio, 2);
    await far(view);
    const cursor = view.state.selection.main.head;
    barButton("回到卡片")!.click();
    await kernel();
    expect(view.state.selection.main.head).toBe(cursor);
    expect(parent.querySelector("audio")).toBe(audio);
    expect(audio.paused).toBe(false);
    expect(barShown()).toBe(false);

    // 键盘按的：到了以后焦点进卡片里的播放器
    await far(view);
    barButton("回到卡片")!.dispatchEvent(new MouseEvent("click", { detail: 0, bubbles: true }));
    await kernel();
    expect(document.activeElement).toBe(audio);
  });

  it("closes the bar: pauses, keeps the spot, and moves on to another one still playing", async () => {
    const { parent, view } = mount(LONG("![[录音.m4a]]\n\n![[访谈.m4a]]"), host());
    const first = mediaOf(parent, "录音.m4a")!;
    const second = mediaOf(parent, "访谈.m4a")!;
    await play(first, 3);
    await play(second, 8);
    await far(view);
    // 两个都在放；条上是最近开始放的那一个
    expect(first.paused).toBe(false);
    expect(second.paused).toBe(false);
    expect(bar()?.querySelector(".odea-media-bar-name")?.textContent).toBe("访谈.m4a");

    barButton("关掉")!.click();
    await settle();
    expect(second.paused).toBe(true);
    expect(keptSlot()?.contains(second)).toBe(true);
    expect(second.currentTime).toBe(8);
    expect(barShown()).toBe(true);
    expect(bar()?.querySelector(".odea-media-bar-name")?.textContent).toBe("录音.m4a");

    barButton("关掉")!.click();
    await settle();
    expect(first.paused).toBe(true);
    expect(barShown()).toBe(false);
  });

  it("doesn't flash the bar when one brought back is played again on its card", async () => {
    const { parent, view } = mount(LONG("![[录音.m4a]]"), host());
    const audio = parent.querySelector("audio")!;
    await play(audio, 2);
    await far(view);
    // 藏在保管处（display: none）时观察器报「不在」
    FakeObserver.report(audio, false);
    barButton("关掉")!.click();
    await settle();
    expect(barShown()).toBe(false);
    await back(view);
    expect(parent.querySelector("audio")).toBe(audio);
    // 都停了，观察器已经撤了：上回报的「不在」是旧的，在卡片上按播放不该出条
    await play(audio, audio.currentTime);
    expect(barShown()).toBe(false);
  });

  it("lets go of one that finishes while out of sight", async () => {
    const { parent, view } = mount(LONG("![[录音.m4a]]"), host());
    const audio = parent.querySelector("audio")!;
    await play(audio, 2);
    await far(view);
    expect(barShown()).toBe(true);
    audio.pause();
    Object.defineProperty(audio, "ended", { configurable: true, value: true });
    audio.dispatchEvent(new Event("ended"));
    await settle();
    expect(barShown()).toBe(false);
    expect(audio.getAttribute("src")).toBeNull();
    expect(keptSlot()).toBeNull();
  });

  it("stops everything when the editor goes away (switching notes)", async () => {
    const { parent, view } = mount(LONG("![[录音.m4a]]\n\n![[演示.mp4]]"), host());
    const audio = mediaOf(parent, "录音.m4a")!;
    const video = mediaOf(parent, "演示.mp4")!;
    expect(video.tagName).toBe("VIDEO");
    await play(audio, 2);
    await play(video, 6);
    FakeObserver.report(video, false);
    await settle();
    view.destroy();
    await settle();
    for (const media of [audio, video]) {
      expect(media.paused).toBe(true);
      expect(media.getAttribute("src")).toBeNull();
    }
    expect(keptSlot()).toBeNull();
    expect(barShown()).toBe(false);
    expect(bar() === null || bar()!.inert).toBe(true);
    expect(watchingMedia()).toBe(0);
  });

  it("costs nothing while nothing plays: no slot, no bar, no observer", async () => {
    const { parent, view } = mount(LONG("![[录音.m4a]]"), host());
    await far(view);
    await back(view);
    expect(parent.querySelector("audio")).not.toBeNull();
    expect(keptSlot()).toBeNull();
    expect(bar()).toBeNull();
    expect(watchingMedia()).toBe(0);
  });
});
