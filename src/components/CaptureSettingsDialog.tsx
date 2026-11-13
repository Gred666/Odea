import { useApp } from "@/app/store";
import { DEFAULT_SHORTCUT, fromKeyboard, shortcutLabel } from "@/capture/shortcut";
import { messageOf } from "@/data/store";
import { type CaptureSettings, commands } from "@/lib/bindings";
import { cn } from "@/lib/cn";
import { popoverCard, tween } from "@/lib/motion";
import { isMac } from "@/lib/platform";
import { isTauri } from "@/lib/tauri";
import { Keyboard, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { DialogLead, usePaletteBack } from "./PaletteBack";

/* ============================================================
   全局快捷键速记的设置（命令面板「速记快捷键…」）：开关、换快捷键。
   存在应用的配置里（不分仓库），Rust 那边立刻注销旧的、注册新的（src-tauri/src/quick_capture.rs）；
   注册不上（被别的程序占了）也照样存下，这里写着为什么
   ============================================================ */

const HEADER = 52;

export function CaptureSettingsDialog() {
  const open = useApp((s) => s.captureSettingsOpen);
  const setOpen = useApp((s) => s.setCaptureSettingsOpen);
  const close = () => setOpen(false);
  const back = usePaletteBack("capture", open, close);
  // 录快捷键时 Esc 是取消录，不关对话框（CaptureBody 自己接）
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!open || recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        if (back) back();
        else setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen, back, recording]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            key="scrim"
            type="button"
            data-ghost-skip
            aria-label="关闭速记设置"
            onClick={close}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={tween.base}
            className="fixed inset-0 z-50 cursor-default bg-ink/[0.14] backdrop-blur-[3px]"
          />
          <div
            key="panel"
            data-ghost-skip
            className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label="速记快捷键"
              custom={HEADER}
              variants={popoverCard}
              initial="hidden"
              animate="shown"
              exit="gone"
              className="pointer-events-auto relative flex w-[520px] max-w-[calc(100vw-48px)] flex-col
                         overflow-clip rounded-2xl bg-canvas shadow-modal ring-1 ring-line-strong"
            >
              <div
                className="flex shrink-0 items-center gap-2.5 border-b border-line px-4"
                style={{ height: HEADER }}
              >
                <DialogLead icon={Keyboard} back={back} />
                <p className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
                  速记快捷键
                </p>
                <button
                  type="button"
                  aria-label="关闭"
                  onClick={close}
                  className="grid h-7 w-7 place-items-center rounded-md text-muted
                             transition-colors duration-[140ms] hover:bg-raised hover:text-ink"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </div>
              <CaptureBody recording={recording} setRecording={setRecording} />
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

function CaptureBody({
  recording,
  setRecording,
}: {
  recording: boolean;
  setRecording: (value: boolean) => void;
}) {
  const [settings, setSettings] = useState<CaptureSettings | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri) {
      setSettings({ enabled: true, shortcut: DEFAULT_SHORTCUT, error: null });
      return;
    }
    void commands.captureSettings().then((result) => {
      if (result.status === "ok") setSettings(result.data);
    });
  }, []);

  const save = async (enabled: boolean, shortcut: string) => {
    if (!isTauri) {
      setSettings({ enabled, shortcut, error: null });
      return;
    }
    const result = await commands.captureConfigure(enabled, shortcut);
    if (result.status === "ok") setSettings(result.data);
    else setHint(messageOf(result.error));
  };

  // 录：下一次按键（带修饰键）就是新的快捷键；Esc 取消
  useEffect(() => {
    if (!recording || !settings) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(false);
        setHint(null);
        return;
      }
      const recorded = fromKeyboard(event);
      if (recorded.kind === "waiting") return;
      if (recorded.kind === "invalid") {
        setHint(recorded.message);
        return;
      }
      setRecording(false);
      setHint(null);
      void save(true, recorded.shortcut);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!settings) return <div className="h-[188px]" />;
  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <p className="text-[13px] leading-[1.7] text-body">
        应用开着（窗口在后台、最小化了都行）时按一下，屏幕上方弹出一个小窗：写一行、回车，记进最近用的那个仓库的今日TODO。
      </p>
      <label className="flex cursor-pointer items-center gap-2 text-[13px] text-body">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) => void save(event.target.checked, settings.shortcut)}
          className="accent-[var(--color-accent)]"
        />
        用快捷键弹出速记小窗
      </label>
      <div className="flex items-center gap-2">
        <span className="w-[60px] shrink-0 text-[13px] text-muted">快捷键</span>
        <button
          type="button"
          disabled={!settings.enabled}
          onClick={() => {
            setHint(null);
            setRecording(!recording);
          }}
          className={cn(
            "h-8 min-w-[180px] rounded-md border px-3 text-left text-[13px] disabled:opacity-50",
            recording
              ? "border-accent bg-accent-wash text-ink"
              : "border-line-strong bg-canvas text-body hover:bg-panel",
          )}
        >
          {recording ? "按下新的快捷键…（Esc 取消）" : shortcutLabel(settings.shortcut, isMac)}
        </button>
        {settings.shortcut !== DEFAULT_SHORTCUT && (
          <button
            type="button"
            disabled={!settings.enabled}
            onClick={() => void save(true, DEFAULT_SHORTCUT)}
            className="h-8 rounded-md px-3 text-[13px] text-muted transition-colors duration-[120ms]
                       hover:bg-raised hover:text-ink disabled:opacity-50"
          >
            恢复默认
          </button>
        )}
      </div>
      <p
        className={cn(
          "min-h-5 text-[12px] leading-5",
          hint || settings.error ? "text-danger" : "text-muted",
        )}
        role="status"
      >
        {hint ??
          settings.error ??
          (isTauri ? "" : "浏览器预览里注册不了系统的快捷键，桌面版里才行")}
      </p>
    </div>
  );
}
