// @vitest-environment happy-dom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CalendarPanel, dayByKey } from "./CalendarView";
import { useJournal } from "./store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 日历的键盘（docs/REVIEWS/2026-11-13-全项目审查.md §4.53）：
 * 以前 42 格个个进 Tab 顺序、没有方向键，用键盘的人要按 44 下才出得了日历
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  useJournal.setState({
    selectedDate: "2026-11-14",
    todayDate: "2026-11-14",
    marks: { written: new Set(), open: new Set() },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<CalendarPanel />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const cell = (date: string) => container.querySelector<HTMLButtonElement>(`[data-date="${date}"]`);

async function press(key: string) {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
  // 换月的那一下：月份在 effect 里跟过去，新网格再挂上
  await act(async () => {});
}

describe("CalendarPanel keyboard", () => {
  it("puts only the selected day in the Tab order", () => {
    const stops = [...container.querySelectorAll<HTMLButtonElement>("[data-date]")].filter(
      (button) => button.tabIndex === 0,
    );
    expect(stops.map((button) => button.dataset.date)).toEqual(["2026-11-14"]);
  });

  it("moves the day and the focus with the arrow keys, across months too", async () => {
    await act(async () => cell("2026-11-14")!.focus());
    await press("ArrowRight");
    expect(useJournal.getState().selectedDate).toBe("2026-11-15");
    expect(document.activeElement).toBe(cell("2026-11-15"));
    expect(cell("2026-11-15")!.tabIndex).toBe(0);
    // 11 月 29 日往下一周是 12 月 6 日：网格换成 12 月，焦点跟到新网格里那一格，不掉在 body 上
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(useJournal.getState().selectedDate).toBe("2026-12-06");
    // 11 月那张网格最后一格也是 12 月 6 日（退场时还挂着）：接焦点的是 12 月网格里能 Tab 的那一格
    const active = document.activeElement as HTMLButtonElement;
    expect(active.dataset.date).toBe("2026-12-06");
    expect(active.closest<HTMLElement>("[data-month]")?.dataset.month).toBe("2026-12");
  });
});

describe("dayByKey", () => {
  it("steps by day, week, the ends of the week and month", () => {
    expect(dayByKey("2026-11-14", "ArrowLeft")).toBe("2026-11-13");
    expect(dayByKey("2026-11-14", "ArrowUp")).toBe("2026-11-07");
    expect(dayByKey("2026-11-14", "Home")).toBe("2026-11-09");
    expect(dayByKey("2026-11-14", "End")).toBe("2026-11-15");
    expect(dayByKey("2026-01-31", "PageDown")).toBe("2026-02-28");
    expect(dayByKey("2026-11-14", "Enter")).toBeNull();
  });
});
