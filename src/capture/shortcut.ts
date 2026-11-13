/* ============================================================
   全局快捷键的写法（global-hotkey 认的那种）：`Ctrl+Alt+N`、`Ctrl+Shift+Space`、`Super+Alt+F5`。
   设置里按下一组键录成这种写法（fromKeyboard），显示的时候换成给人看的（label）
   ============================================================ */

export const DEFAULT_SHORTCUT = "Ctrl+Alt+N";

const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
]);

export type Recorded =
  /** 录好了 */
  | { kind: "shortcut"; shortcut: string }
  /** 只按了修饰键，还在等 */
  | { kind: "waiting" }
  /** 不行：没带修饰键、按的键认不得 */
  | { kind: "invalid"; message: string };

type KeyLike = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/** 一次按键 → 快捷键的写法。至少带一个 Ctrl / Alt / ⌘（只带 Shift 的会挡住打大写字母） */
export function fromKeyboard(event: KeyLike): Recorded {
  if (MODIFIER_CODES.has(event.code)) return { kind: "waiting" };
  const key = /^Key[A-Z]$/.test(event.code)
    ? event.code.slice(3)
    : /^Digit\d$/.test(event.code)
      ? event.code.slice(5)
      : /^(?:F\d{1,2}|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|Insert|Delete|Numpad\d)$/.test(
            event.code,
          )
        ? event.code
        : null;
  if (!key) return { kind: "invalid", message: "这个键不能当快捷键" };
  const mods = [
    event.ctrlKey && "Ctrl",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    event.metaKey && "Super",
  ].filter(Boolean) as string[];
  if (!event.ctrlKey && !event.altKey && !event.metaKey) {
    return { kind: "invalid", message: "要带上 Ctrl、Alt 或者 ⌘ 里的至少一个" };
  }
  return { kind: "shortcut", shortcut: [...mods, key].join("+") };
}

/** 给人看的：`Ctrl + Alt + N`；macOS 上 `Control + Option + N`、`Command` */
export function shortcutLabel(shortcut: string, mac: boolean): string {
  const names: Record<string, string> = mac
    ? {
        CTRL: "Control",
        CONTROL: "Control",
        ALT: "Option",
        OPTION: "Option",
        SHIFT: "Shift",
        SUPER: "Command",
        CMD: "Command",
        COMMAND: "Command",
        COMMANDORCONTROL: "Command",
      }
    : {
        CTRL: "Ctrl",
        CONTROL: "Ctrl",
        ALT: "Alt",
        SHIFT: "Shift",
        SUPER: "Win",
        CMD: "Win",
        COMMAND: "Win",
        COMMANDORCONTROL: "Ctrl",
      };
  return shortcut
    .split("+")
    .map((part) => {
      const trimmed = part.trim();
      const known = names[trimmed.toUpperCase()];
      if (known) return known;
      if (/^Key[A-Z]$/i.test(trimmed)) return trimmed.slice(3).toUpperCase();
      if (/^Digit\d$/i.test(trimmed)) return trimmed.slice(5);
      if (/^Arrow/i.test(trimmed)) return trimmed.replace(/^Arrow/i, "方向键");
      return trimmed;
    })
    .join(" + ");
}
