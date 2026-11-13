import { events, type CaptureTarget, commands } from "@/lib/bindings";
import { cn } from "@/lib/cn";
import { thisWindow } from "@/lib/tauri";
import { Check, PenLine } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/* ============================================================
   全局快捷键速记的小窗（src-tauri/src/quick_capture.rs，窗口 `?capture`）：一个输入框，回车记进今日TODO。

   - 每次显示出来（CaptureShown）：清空、重新问记到哪个仓库、光标放进去
   - 回车：交给 Rust 转给仓库窗口去写，回话了说「记下了」，过一会儿自己收起来；没记上把原因写在下面，字留着
   - Esc、点到别处（窗口失焦）：收起来，写了一半的字留着（下次再按快捷键还在，记下了才清）
   - 小窗本身就是那张卡片：不另画外框、阴影（系统给窗口画），不做动画（Rust 那边关了系统的显示 / 隐藏过渡）
   ============================================================ */

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; vault: string }
  | { kind: "error"; message: string };

const errorText = (error: unknown) =>
  error && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);

export function CaptureApp() {
  const [text, setText] = useState("");
  const [target, setTarget] = useState<CaptureTarget | null | undefined>(undefined);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);

  const refresh = useCallback(() => {
    void commands.captureTarget().then((result) => {
      setTarget(result.status === "ok" ? result.data : null);
    });
    setStatus((current) => (current.kind === "saved" ? { kind: "idle" } : current));
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  useEffect(() => {
    refresh();
    const shown = events.captureShown(thisWindow()).listen(() => refresh());
    // 点到别处：收起来（正在记的那一下不算，等它回话）
    const onBlur = () => {
      if (!savingRef.current) void commands.captureHide();
    };
    window.addEventListener("blur", onBlur);
    return () => {
      void shown.then((off) => off());
      window.removeEventListener("blur", onBlur);
    };
  }, [refresh]);

  const submit = async () => {
    if (savingRef.current || !text.trim()) return;
    savingRef.current = true;
    setStatus({ kind: "saving" });
    const result = await commands.captureSubmit(text).catch((error: unknown) => ({
      status: "error" as const,
      error: { message: errorText(error) },
    }));
    savingRef.current = false;
    if (result.status === "ok") {
      setText("");
      setStatus({ kind: "saved", vault: result.data });
      // 看一眼「记下了」再收起来
      setTimeout(() => void commands.captureHide(), 650);
    } else {
      setStatus({ kind: "error", message: errorText(result.error) });
      inputRef.current?.focus();
    }
  };

  const hint =
    status.kind === "saved"
      ? `记下了：「${status.vault}」的今日TODO`
      : status.kind === "error"
        ? status.message
        : status.kind === "saving"
          ? "正在记…"
          : target === undefined
            ? " "
            : target === null
              ? "先打开一个仓库"
              : target.journal
                ? `存进「${target.name}」的今日TODO · 回车记下 · Esc 收起`
                : `「${target.name}」没开日程，没有今日TODO`;

  return (
    <div className="flex h-screen select-none flex-col justify-center bg-canvas px-5">
      <div className="flex items-center gap-3">
        {status.kind === "saved" ? (
          <Check size={20} strokeWidth={2.2} className="shrink-0 text-success" />
        ) : (
          <PenLine size={20} strokeWidth={2} className="shrink-0 text-faint" />
        )}
        <input
          ref={inputRef}
          value={text}
          spellCheck={false}
          placeholder="记一条待办…"
          aria-label="记一条待办"
          onChange={(event) => {
            setText(event.target.value);
            if (status.kind === "error" || status.kind === "saved") setStatus({ kind: "idle" });
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              void commands.captureHide();
            }
          }}
          className="h-11 min-w-0 flex-1 select-text bg-transparent text-[19px] text-ink outline-none
                     placeholder:text-faint focus-visible:outline-none"
        />
      </div>
      <p
        className={cn(
          "truncate pl-8 text-[12px] leading-5",
          status.kind === "error" || target === null || target?.journal === false
            ? "text-danger"
            : status.kind === "saved"
              ? "text-success"
              : "text-muted",
        )}
        role="status"
      >
        {hint}
      </p>
    </div>
  );
}
