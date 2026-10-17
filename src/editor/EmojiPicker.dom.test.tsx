// @vitest-environment happy-dom

import { MotionGlobalConfig } from "motion/react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EmojiPicker,
  gridRows,
  loadRecent,
  moveInGrid,
  pickerSections,
  pinnedEdge,
  placePicker,
  rememberRecent,
  searchEmojis,
} from "./EmojiPicker";
import { ANIMATED_EMOJIS, animatedEmojiFor } from "./animatedEmoji";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom 里 Motion 取消原生动画会留下没人接的 AbortError；这里测的是逻辑，不是动效
MotionGlobalConfig.skipAnimations = true;

const emoji = (id: string) => animatedEmojiFor(`:odea_${id}:`)!;
const ids = (list: { id: string }[]) => list.map((item) => item.id);

beforeEach(() => localStorage.clear());

describe("搜索", () => {
  it("matches Chinese names, synonyms, pinyin, English and the glyph itself", () => {
    expect(ids(searchEmojis("冲"))).toContain("fire");
    expect(ids(searchEmojis("火"))).toContain("fire");
    expect(ids(searchEmojis("huo"))).toContain("fire");
    expect(ids(searchEmojis("FIRE"))).toEqual(["fire"]);
    expect(ids(searchEmojis("🔥"))).toEqual(["fire"]);
    expect(ids(searchEmojis("晚安"))).toEqual(["moon"]);
  });

  it("accepts the short code the way people type it", () => {
    expect(ids(searchEmojis(":odea_fire"))).toEqual(["fire"]);
    expect(ids(searchEmojis(":odea_fire:"))).toEqual(["fire"]);
    // 改名前的写法也认
    expect(ids(searchEmojis(":otw_fire"))).toEqual(["fire"]);
  });

  it("returns everything for a blank query and nothing for nonsense", () => {
    expect(searchEmojis("  ")).toHaveLength(ANIMATED_EMOJIS.length);
    expect(searchEmojis("zzzqqq")).toEqual([]);
  });
});

describe("分区与网格", () => {
  it("puts recents first, then every group in order", () => {
    const sections = pickerSections("", [emoji("fire"), emoji("done")]);
    expect(sections.map((section) => section.id)).toEqual([
      "recent",
      "mood",
      "drive",
      "way",
      "daily",
      "work",
      "meme",
      "react",
      "animal",
    ]);
    expect(ids(sections[0]!.items)).toEqual(["fire", "done"]);
  });

  it("collapses to a single result section while searching", () => {
    expect(pickerSections("星", []).map((section) => section.id)).toEqual(["search"]);
    expect(pickerSections("zzzqqq", [])).toEqual([]);
  });

  it("walks the grid by row and column even when the recent row is short", () => {
    const rows = gridRows(pickerSections("", [emoji("fire"), emoji("done")]));
    expect(rows[0]).toEqual([0, 1]);
    expect(rows[1]).toEqual([2, 3, 4, 5, 6, 7]);
    // 从第二行第 5 列往上：最近那行只有两个，落到它最后一个
    expect(moveInGrid(rows, 6, "ArrowUp")).toBe(1);
    expect(moveInGrid(rows, 1, "ArrowDown")).toBe(3);
    expect(moveInGrid(rows, 1, "ArrowRight")).toBe(2);
    expect(moveInGrid(rows, 0, "ArrowLeft")).toBe(rows.flat().length - 1);
    // 已经在第一行 / 最后一行：上下不动
    expect(moveInGrid(rows, 0, "ArrowUp")).toBe(0);
    const last = rows.flat().length - 1;
    expect(moveInGrid(rows, last, "ArrowDown")).toBe(last);
    expect(moveInGrid([], 0, "ArrowDown")).toBe(0);
  });
});

describe("定位", () => {
  const size = (height: number, viewportHeight: number) => ({
    width: 292,
    height,
    grid: 322,
    viewport: { width: 1440, height: viewportHeight },
  });
  const caret = (top: number) => ({ left: 600, top, bottom: top + 20 });

  it("opens below the caret when it fits", () => {
    expect(placePicker(caret(100), size(398, 900))).toEqual({
      left: 582,
      top: 126,
      above: false,
      gridMax: undefined,
    });
  });

  it("flips above when only the top has room", () => {
    const place = placePicker(caret(700), size(398, 900));
    expect(place.above).toBe(true);
    expect(place.top + 398).toBe(700 - 6);
    expect(place.gridMax).toBeUndefined();
  });

  it("shrinks the grid on the roomier side when neither side fits", () => {
    // 620 高的窗口，光标在中间：下面 286px、上面 266px
    const place = placePicker(caret(280), size(398, 620));
    expect(place.above).toBe(false);
    expect(place.top).toBe(306);
    const height = 398 - (322 - place.gridMax!);
    expect(place.top + height).toBeLessThanOrEqual(620 - 8);
    expect(place.gridMax).toBeGreaterThanOrEqual(120);
  });

  it("keeps the panel inside the window horizontally", () => {
    expect(placePicker({ left: 1430, top: 100, bottom: 120 }, size(398, 900)).left).toBe(
      1440 - 292 - 8,
    );
    expect(placePicker({ left: 2, top: 100, bottom: 120 }, size(398, 900)).left).toBe(8);
  });

  // 展开、收起时贴着光标的那条边不动：往下开钉上边，往上开钉下边
  it("pins the caret-side edge: top when below, bottom when above", () => {
    const viewport = { width: 1440, height: 900 };
    const below = placePicker(caret(100), size(398, 900));
    expect(pinnedEdge(caret(100), below, viewport, 1)).toEqual({ left: 582, top: 126 });
    const above = placePicker(caret(700), size(398, 900));
    expect(pinnedEdge(caret(700), above, viewport, 1)).toEqual({ left: 582, bottom: 900 - 694 });
  });

  it("snaps the pinned edge to whole device pixels", () => {
    // 1.5 倍屏：261.859 → 第 392.79 个物理像素 → 393 → 262
    const edge = pinnedEdge(
      { left: 716.0156, top: 240.859, bottom: 255.859 },
      { left: 698.0156, top: 261.859, above: false },
      { width: 1440, height: 900 },
      1.5,
    );
    expect(edge.top! * 1.5).toBe(Math.round(edge.top! * 1.5));
    expect(edge.left * 1.5).toBe(Math.round(edge.left * 1.5));
    expect(edge.top).toBeCloseTo(262, 5);
  });
});

describe("最近使用", () => {
  it("keeps the latest six, most recent first, without duplicates", () => {
    for (const id of ["fire", "done", "star", "sun", "moon", "rain", "party", "fire"]) {
      rememberRecent(emoji(id));
    }
    expect(ids(loadRecent())).toEqual(["fire", "party", "rain", "moon", "sun", "star"]);
  });

  it("survives broken or unavailable storage", () => {
    localStorage.setItem("odea.emoji.recent", "{not json");
    expect(loadRecent()).toEqual([]);
    localStorage.setItem("odea.emoji.recent", JSON.stringify(["gone", "fire"]));
    expect(ids(loadRecent())).toEqual(["fire"]);

    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => rememberRecent(emoji("sun"))).not.toThrow();
    spy.mockRestore();
  });
});

describe("<EmojiPicker>", () => {
  let root: Root | null = null;
  let host: HTMLElement;

  function open(props: Partial<Parameters<typeof EmojiPicker>[0]> = {}) {
    host = document.createElement("div");
    document.body.append(host);
    const onPick = vi.fn();
    const onClose = vi.fn();
    act(() => {
      root = createRoot(host);
      root.render(
        <EmojiPicker
          anchor={{ left: 100, top: 100, bottom: 120 }}
          onPick={onPick}
          onClose={onClose}
          {...props}
        />,
      );
    });
    const input = host.querySelector("input")!;
    const selected = () =>
      host.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.dataset.emoji;
    const key = (init: KeyboardEventInit) =>
      act(() => {
        input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
      });
    const type = (value: string) =>
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    return { input, selected, key, type, onPick, onClose };
  }

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
  });

  it("focuses the search box and highlights the first emoji", () => {
    const { input, selected } = open();
    expect(document.activeElement).toBe(input);
    expect(selected()).toBe("smile");
    expect(input.getAttribute("aria-activedescendant")).toMatch(/^odea-emoji-smile-/);
  });

  it("moves with the arrow keys and inserts with Enter", () => {
    const { selected, key, onPick } = open();
    key({ key: "ArrowDown" });
    key({ key: "ArrowRight" });
    expect(selected()).toBe("fire");
    key({ key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(emoji("fire"));
    expect(ids(loadRecent())).toEqual(["fire"]);
  });

  it("ignores Enter while an IME is composing", () => {
    const { key, onPick } = open();
    key({ key: "Enter", isComposing: true });
    key({ key: "Process", keyCode: 229 });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("filters as you type and shows an empty state", () => {
    const { selected, type, key, onPick } = open();
    type("rocket");
    expect(selected()).toBe("rocket");
    key({ key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(emoji("rocket"));

    type("zzzqqq");
    expect(host.textContent).toContain("没有找到");
    key({ key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("closes with Escape or the shortcut (refocusing the editor) and on outside clicks (not)", () => {
    const { key, onClose } = open();
    key({ key: "Escape" });
    expect(onClose).toHaveBeenLastCalledWith(true);
    key({ key: "e", ctrlKey: true });
    expect(onClose).toHaveBeenLastCalledWith(true);
    act(() => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenLastCalledWith(false);
  });

  it("picks with the mouse without stealing focus from the search box", () => {
    const { input, onPick } = open();
    const star = host.querySelector<HTMLElement>('[data-emoji="star"]')!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    star.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    act(() => star.click());
    expect(onPick).toHaveBeenCalledWith(emoji("star"));
    expect(document.activeElement).toBe(input);
  });
});
