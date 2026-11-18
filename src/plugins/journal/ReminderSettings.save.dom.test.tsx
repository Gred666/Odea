// @vitest-environment happy-dom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 提醒设置连着点两下（两档提前量）：两次 reminder_configure 各自异步。先发的结果后到会把界面换回去一下，
 * 两次写文件的先后也没保证（审查 2026-11-13 §5.3）。一次写完再发下一次，只认最后那一次的结果
 */

type Settings = { enabled: boolean; leadMinutes: number; sound: string };
const pending: { settings: Settings; resolve: () => void }[] = [];
const written: number[] = [];

vi.mock("@/lib/tauri", async (original) => ({
  ...(await original<typeof import("@/lib/tauri")>()),
  isTauri: true,
}));
vi.mock("@/lib/bindings", async (original) => ({
  ...(await original<typeof import("@/lib/bindings")>()),
  commands: {
    reminderSettings: async () => ({
      status: "ok",
      data: {
        settings: { enabled: true, leadMinutes: 0, sound: "chime" },
        quiet: false,
        actions: true,
      },
    }),
    reminderConfigure: (settings: Settings) =>
      new Promise((resolve) => {
        pending.push({
          settings,
          resolve: () => {
            written.push(settings.leadMinutes);
            resolve({ status: "ok", data: { settings, quiet: false, actions: true } });
          },
        });
      }),
  },
}));

const { ReminderSettingsDialog, openReminderSettings } = await import("./ReminderSettings");

let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
const lead = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(
    (button) => button.textContent === label,
  )!;
const selected = () =>
  document.querySelector('button[role="tab"][aria-selected="true"]')?.textContent;

it("two quick lead-time clicks are written in order and the earlier answer does not flip the choice back", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<ReminderSettingsDialog />));
  openReminderSettings();
  await settle();

  act(() => lead("5 分钟").click());
  await settle();
  expect(pending.map((call) => call.settings.leadMinutes)).toEqual([5]);
  act(() => lead("30 分钟").click());
  await settle();
  expect(selected()).toBe("30 分钟");
  // 第二次等第一次写完才发
  expect(pending.map((call) => call.settings.leadMinutes)).toEqual([5]);

  // 第一次的结果回来：界面不换回 5 分钟
  pending.shift()!.resolve();
  await settle();
  expect(selected()).toBe("30 分钟");
  expect(pending.map((call) => call.settings.leadMinutes)).toEqual([30]);
  pending.shift()!.resolve();
  await settle();
  expect(written).toEqual([5, 30]);
  expect(selected()).toBe("30 分钟");

  // 一次还在写，又连点两下：排着的那次不写，只写最后那次
  act(() => lead("5 分钟").click());
  await settle();
  act(() => lead("15 分钟").click());
  act(() => lead("1 小时").click());
  await settle();
  pending.shift()!.resolve();
  await settle();
  expect(pending.map((call) => call.settings.leadMinutes)).toEqual([60]);
  pending.shift()!.resolve();
  await settle();
  expect(written).toEqual([5, 30, 5, 60]);
  expect(selected()).toBe("1 小时");
});
