// @vitest-environment happy-dom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 「提醒设置…」是日程插件的命令（审查 §6.4）：和核心的对话框一样，从命令面板开的标题栏左边是「返回命令面板」，
 * Esc 回到面板、面板里还是刚才打的字、焦点在输入框里；从别处开的不带返回，Esc 整个关掉。
 * 插件的命令靠 PaletteCommand.dialog 说自己开的是哪个对话框（docs/插件与跨端.md 贡献点 commands）。
 */

// 命令面板打开时取插件的文档、打了字去搜正文：这里都给空的
vi.mock("@/data/backend", () => ({
  backend: async () => new Proxy({}, { get: () => async () => [] }),
}));

const { useApp } = await import("@/app/store");
const { useData } = await import("@/data/store");
const { registerPlugin } = await import("@/plugins/registry");
const { CommandPalette } = await import("@/components/CommandPalette");
const { journalPlugin } = await import("./index");
const { ReminderSettingsDialog, openReminderSettings } = await import("./ReminderSettings");

registerPlugin(journalPlugin);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useApp.setState({ paletteOpen: false, paletteBack: null, paletteRestore: null, findOpen: false });
  useData.setState({ layout: { ...useData.getState().layout, plugins: [journalPlugin.id] } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <>
        <CommandPalette />
        <ReminderSettingsDialog />
      </>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** 等一帧（面板在入场动画的第一帧之后才聚焦输入框）再把挂着的异步走完 */
const frame = () =>
  act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const pressEscape = () =>
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
const paletteInput = () => document.querySelector<HTMLInputElement>('input[role="combobox"]');
const reminderDialog = () => document.querySelector('[role="dialog"][aria-label="提醒"]');
const backButton = () => reminderDialog()?.querySelector('button[aria-label="返回命令面板"]');

function type(input: HTMLInputElement, text: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("提醒设置：从命令面板开的能回到面板", () => {
  it("Ctrl+K 打「提醒」开「提醒设置…」：左边是返回，Esc 回到面板，字还在、焦点在输入框里", async () => {
    act(() => useApp.getState().setPaletteOpen(true));
    await frame();
    const input = paletteInput();
    expect(input).not.toBeNull();
    type(input as HTMLInputElement, "提醒");
    await frame();

    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (node) => node.textContent?.includes("提醒设置…"),
    );
    expect(option).toBeDefined();
    act(() => option?.click());
    await frame();

    expect(useApp.getState().paletteOpen).toBe(false);
    expect(reminderDialog()).not.toBeNull();
    expect(backButton()).not.toBeNull();

    await pressEscape();
    await frame();

    expect(useApp.getState().paletteOpen).toBe(true);
    expect(useApp.getState().paletteBack).toBeNull();
    const back = paletteInput();
    expect(back?.value).toBe("提醒");
    expect(document.activeElement).toBe(back);
    // 能接着打
    type(back as HTMLInputElement, "提醒设");
    await frame();
    expect(paletteInput()?.value).toBe("提醒设");
  });

  it("点左边的返回也一样回到面板", async () => {
    act(() => useApp.getState().setPaletteOpen(true));
    await frame();
    type(paletteInput() as HTMLInputElement, "提醒");
    await frame();
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (node) => node.textContent?.includes("提醒设置…"),
    );
    act(() => option?.click());
    await frame();

    act(() => (backButton() as HTMLButtonElement | null)?.click());
    await frame();
    expect(useApp.getState().paletteOpen).toBe(true);
    expect(paletteInput()?.value).toBe("提醒");
  });

  it("从别处开的（不经过命令面板）：左边是图标，Esc 整个关掉", async () => {
    act(() => openReminderSettings());
    await frame();
    expect(reminderDialog()).not.toBeNull();
    expect(backButton()).toBeNull();

    await pressEscape();
    await frame();
    expect(useApp.getState().paletteOpen).toBe(false);
    expect(paletteInput()).toBeNull();
  });
});
