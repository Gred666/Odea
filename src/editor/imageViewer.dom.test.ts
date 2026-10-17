// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeImageViewer, openImageViewer } from "./imageViewer";

/** 正文里那张图：300 × 200 显示着，原图 1200 × 800 */
function sourceImage() {
  const image = document.createElement("img");
  image.alt = "截图";
  image.src = "https://x.dev/a.png";
  document.body.append(image);
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 100, y: 100, width: 300, height: 200 }),
  );
  Object.defineProperty(image, "naturalWidth", { value: 1200 });
  Object.defineProperty(image, "naturalHeight", { value: 800 });
  return image;
}

const viewer = () => document.querySelector<HTMLElement>(".odea-image-viewer");
const big = () => document.querySelector<HTMLImageElement>(".odea-image-viewer-image")!;
const px = (value: string) => Number.parseFloat(value);
const box = () => {
  const { left, top, width, height } = big().style;
  return { left: px(left), top: px(top), width: px(width), height: px(height) };
};
/** 缩放朝目标逼近是逐帧的；减少动效下一帧就到 */
const frame = () => new Promise((resolve) => setTimeout(resolve, 40));
const key = (name: string) =>
  document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));

beforeEach(() => {
  document.documentElement.dataset.reduceMotion = "true";
});

afterEach(async () => {
  await closeImageViewer();
  delete document.documentElement.dataset.reduceMotion;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("查看大图", () => {
  it("opens fitted to the window, hides the original and takes focus", () => {
    const source = sourceImage();
    openImageViewer(source);
    expect(viewer()).not.toBeNull();
    // 1024 × 768 的窗口四边留 48：按宽度缩到 928 / 1200
    expect(box().width).toBeCloseTo(928, 1);
    expect(box().left).toBeCloseTo(48, 1);
    expect(source.classList.contains("is-viewing")).toBe(true);
    expect(document.activeElement).toBe(viewer());
    expect(document.querySelector(".odea-image-viewer-button.is-zoom")?.textContent).toBe("77%");
  });

  it("zooms with the wheel around the pointer, keeping that spot still", async () => {
    openImageViewer(sourceImage());
    const before = box();
    // 竖直方向放大后还比窗口矮，按设计居中：鼠标放在竖直中线上，两个方向都该钉住
    const at = { x: 300, y: 384 };
    const spot = (b: typeof before) => [(at.x - b.left) / b.width, (at.y - b.top) / b.height];
    // happy-dom 的 WheelEvent 不认 clientX / clientY 的初始值，补在实例上
    const wheel = new WheelEvent("wheel", { deltaY: -100, cancelable: true });
    Object.defineProperties(wheel, { clientX: { value: at.x }, clientY: { value: at.y } });
    viewer()?.dispatchEvent(wheel);
    await frame();
    const after = box();
    expect(after.width).toBeGreaterThan(before.width);
    expect(spot(after)[0]).toBeCloseTo(spot(before)[0]!, 3);
    expect(spot(after)[1]).toBeCloseTo(spot(before)[1]!, 3);
  });

  it("toggles fit / 100% on double click, steps with + and -, and goes back with 0", async () => {
    openImageViewer(sourceImage());
    big().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 512, clientY: 384 }));
    await frame();
    expect(box().width).toBeCloseTo(1200, 1);
    key("+");
    await frame();
    expect(box().width).toBeCloseTo(1800, 1);
    key("-");
    await frame();
    expect(box().width).toBeCloseTo(1200, 1);
    key("0");
    await frame();
    expect(box().width).toBeCloseTo(928, 1);
  });

  it("pans by dragging once the image is bigger than the window", async () => {
    openImageViewer(sourceImage());
    key("+");
    await frame();
    expect(big().classList.contains("is-pannable")).toBe(true);
    const start = box().left;
    big().dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, clientX: 500, clientY: 400, pointerId: 1 }),
    );
    big().dispatchEvent(
      new PointerEvent("pointermove", { clientX: 440, clientY: 400, pointerId: 1 }),
    );
    big().dispatchEvent(
      new PointerEvent("pointerup", { clientX: 440, clientY: 400, pointerId: 1 }),
    );
    expect(box().left).toBeCloseTo(start - 60, 1);
  });

  it("closes with Escape, gives the original back and returns focus", async () => {
    const editor = document.createElement("button");
    document.body.append(editor);
    editor.focus();
    const source = sourceImage();
    openImageViewer(source);
    key("Escape");
    await vi.waitFor(() => expect(viewer()).toBeNull());
    expect(source.classList.contains("is-viewing")).toBe(false);
    expect(document.activeElement).toBe(editor);
  });
});
