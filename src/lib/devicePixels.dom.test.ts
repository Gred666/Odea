// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { snapToDevicePixels } from "./devicePixels";

function at(left: number, top: number) {
  const element = document.createElement("div");
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: left, y: top, width: 50, height: 20 }),
  );
  return element;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("snapToDevicePixels", () => {
  it("nudges an element sitting between physical pixels onto the nearest one", () => {
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(1.5);
    const element = at(100.5, 40);
    snapToDevicePixels(element);
    // 100.5 × 1.5 = 150.75 物理像素 → 挪到 151，补 0.25 / 1.5 ≈ 0.167px；40 × 1.5 = 60 正好
    expect(element.style.translate).toBe("0.167px 0px");
  });

  it("leaves an element that is already on whole physical pixels alone", () => {
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
    const element = at(100.5, 40);
    element.style.translate = "1px 1px";
    snapToDevicePixels(element);
    expect(element.style.translate).toBe("");
  });

  it("skips elements that are not laid out (display: none)", () => {
    const element = document.createElement("div");
    snapToDevicePixels(element);
    expect(element.style.translate).toBe("");
  });
});
