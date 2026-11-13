import { describe, expect, it } from "vitest";
import { fromKeyboard, shortcutLabel } from "./shortcut";

const press = (
  code: string,
  mods: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>>,
) => ({
  code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta,
});

describe("速记的快捷键", () => {
  it("records a key with its modifiers the way global-hotkey reads it", () => {
    expect(fromKeyboard(press("KeyN", { ctrl: true, alt: true }))).toEqual({
      kind: "shortcut",
      shortcut: "Ctrl+Alt+N",
    });
    expect(fromKeyboard(press("Space", { ctrl: true, shift: true }))).toEqual({
      kind: "shortcut",
      shortcut: "Ctrl+Shift+Space",
    });
    expect(fromKeyboard(press("Digit1", { meta: true, alt: true }))).toEqual({
      kind: "shortcut",
      shortcut: "Alt+Super+1",
    });
  });

  it("waits while only modifiers are down, and refuses keys that would get in the way", () => {
    expect(fromKeyboard(press("ControlLeft", { ctrl: true }))).toEqual({ kind: "waiting" });
    expect(fromKeyboard(press("KeyN", {})).kind).toBe("invalid");
    expect(fromKeyboard(press("KeyN", { shift: true })).kind).toBe("invalid");
    expect(fromKeyboard(press("Enter", { ctrl: true })).kind).toBe("invalid");
  });

  it("shows it the way each system names the keys", () => {
    expect(shortcutLabel("Ctrl+Alt+N", false)).toBe("Ctrl + Alt + N");
    expect(shortcutLabel("Ctrl+Alt+N", true)).toBe("Control + Option + N");
    expect(shortcutLabel("Super+Shift+KeyK", true)).toBe("Command + Shift + K");
    expect(shortcutLabel("CommandOrControl+Space", false)).toBe("Ctrl + Space");
  });
});
