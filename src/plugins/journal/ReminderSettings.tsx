import { DialogLead } from "@/components/PaletteBack";
import { Segmented } from "@/components/Segmented";
import { messageOf } from "@/data/store";
import { type ReminderSettings, type ReminderState, commands } from "@/lib/bindings";
import { cn } from "@/lib/cn";
import { popoverCard, tween } from "@/lib/motion";
import { isTauri } from "@/lib/tauri";
import { Bell, Play, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { create } from "zustand";

/* ============================================================
   提醒设置（命令面板「提醒设置…」，docs/提醒与属性.md §1.2）：开关、提前量、提示音（每个都能试听）、
   发一条试试。存在本机（数据目录的 reminders.json），Rust 的计时线程每次醒来都照它的。
   ============================================================ */

const HEADER = 52;

const useDialog = create<{ open: boolean }>(() => ({ open: false }));

export function openReminderSettings(): void {
  useDialog.setState({ open: true });
}

const LEADS: { value: string; label: string }[] = [
  { value: "0", label: "准点" },
  { value: "5", label: "5 分钟" },
  { value: "10", label: "10 分钟" },
  { value: "15", label: "15 分钟" },
  { value: "30", label: "30 分钟" },
  { value: "60", label: "1 小时" },
];

const SOUNDS = [
  { value: "chime", name: "清泉", detail: "两个音往上走，像碰了一下玻璃杯" },
  { value: "marimba", name: "木铃", detail: "三个音的木琴，暖一点" },
  { value: "system", name: "系统提示音", detail: "Windows 自己的提醒声，勿扰由系统管" },
  { value: "off", name: "不响", detail: "只弹通知" },
] as const;

const PREVIEW: ReminderState = {
  settings: { enabled: true, leadMinutes: 0, sound: "chime" },
  quiet: false,
  actions: true,
};

export function ReminderSettingsDialog() {
  const open = useDialog((s) => s.open);
  const close = () => useDialog.setState({ open: false });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        useDialog.setState({ open: false });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            key="scrim"
            type="button"
            data-ghost-skip
            aria-label="关闭提醒设置"
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
              aria-label="提醒"
              custom={HEADER}
              variants={popoverCard}
              initial="hidden"
              animate="shown"
              exit="gone"
              className="pointer-events-auto relative flex w-[560px] max-w-[calc(100vw-48px)] flex-col
                         overflow-clip rounded-2xl bg-canvas shadow-modal ring-1 ring-line-strong"
            >
              <div
                className="flex shrink-0 items-center gap-2.5 border-b border-line px-4"
                style={{ height: HEADER }}
              >
                <DialogLead icon={Bell} back={null} />
                <p className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">提醒</p>
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
              <ReminderBody />
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

function ReminderBody() {
  const [state, setState] = useState<ReminderState | null>(null);
  const [status, setStatus] = useState<{ text: string; tone: "muted" | "danger" } | null>(null);

  useEffect(() => {
    if (!isTauri) {
      setState(PREVIEW);
      return;
    }
    void commands.reminderSettings().then((result) => {
      if (result.status === "ok") setState(result.data);
      else setStatus({ text: messageOf(result.error), tone: "danger" });
    });
  }, []);

  if (!state) return <div className="h-[420px]" />;
  const { settings } = state;

  const save = async (next: ReminderSettings) => {
    setState({ ...state, settings: next });
    if (!isTauri) return;
    const result = await commands.reminderConfigure(next);
    if (result.status === "ok") setState(result.data);
    else setStatus({ text: messageOf(result.error), tone: "danger" });
  };

  const preview = (sound: string) => {
    if (isTauri) void commands.reminderPreview(sound);
  };

  const test = async () => {
    if (!isTauri) {
      setStatus({ text: "浏览器预览里弹不了系统通知，桌面版里才行", tone: "muted" });
      return;
    }
    const result = await commands.reminderTest();
    setStatus(
      result.status === "ok"
        ? { text: "发了一条，看看屏幕右下角", tone: "muted" }
        : { text: messageOf(result.error), tone: "danger" },
    );
  };

  const sounds = SOUNDS.filter((sound) => sound.value !== "system" || state.actions);
  const off = !settings.enabled;

  return (
    <div className="flex flex-col gap-5 px-5 pt-4 pb-5">
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) => void save({ ...settings, enabled: event.target.checked })}
          className="mt-[3px] accent-[var(--color-accent)]"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px] text-ink">到点提醒我</span>
          <span className="text-[12px] leading-[1.6] text-muted">
            任务后面写了几点，到点弹一条通知、响一声。应用开着才会提醒，窗口最小化了也行。
          </span>
        </span>
      </label>

      <div
        className={cn("flex flex-col gap-5", off && "pointer-events-none opacity-45")}
        aria-disabled={off}
      >
        <div className="flex items-center gap-3">
          <span className="w-[52px] shrink-0 text-[13px] text-muted">提前</span>
          <Segmented
            group="reminder-lead"
            size="sm"
            options={LEADS}
            value={String(settings.leadMinutes)}
            onChange={(value) => void save({ ...settings, leadMinutes: Number(value) })}
          />
        </div>

        <div className="flex items-start gap-3">
          <span className="w-[52px] shrink-0 pt-2 text-[13px] text-muted">声音</span>
          <div
            className="grid min-w-0 flex-1 grid-cols-2 gap-2"
            role="radiogroup"
            aria-label="提示音"
          >
            {sounds.map((sound) => {
              const active = settings.sound === sound.value;
              return (
                <div
                  key={sound.value}
                  className={cn(
                    "group relative flex min-h-[60px] rounded-lg border transition-colors duration-[140ms]",
                    active
                      ? "border-accent bg-accent-wash"
                      : "border-line-strong bg-canvas hover:bg-panel",
                  )}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => {
                      void save({ ...settings, sound: sound.value });
                      preview(sound.value);
                    }}
                    className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-lg px-3 py-2.5 text-left"
                  >
                    <span className={cn("text-[13px]", active ? "text-ink" : "text-body")}>
                      {sound.name}
                    </span>
                    <span className="text-[12px] leading-[1.5] text-muted">{sound.detail}</span>
                  </button>
                  {sound.value !== "off" && (
                    <button
                      type="button"
                      aria-label={`试听${sound.name}`}
                      title="试听"
                      onClick={() => preview(sound.value)}
                      className={cn(
                        "absolute top-2 right-2 grid h-6 w-6 place-items-center rounded-full",
                        "transition-colors duration-[140ms]",
                        active
                          ? "text-accent hover:bg-accent/10"
                          : "text-faint hover:bg-raised hover:text-ink",
                      )}
                    >
                      <Play size={12} strokeWidth={2.2} className="translate-x-[0.5px]" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-start gap-3">
          <span className="w-[52px] shrink-0 pt-2 text-[13px] text-muted">写法</span>
          <dl className="grid min-w-0 flex-1 grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1.5 rounded-lg bg-panel px-3.5 py-3 text-[12px]">
            <dt className="font-mono text-body">- [ ] 交周报 @2026-11-12 18:00</dt>
            <dd className="text-muted">
              18:00{settings.leadMinutes ? `（提前 ${settings.leadMinutes} 分钟）` : ""}响
            </dd>
            <dt className="font-mono text-body">- [ ] 交周报 @2026-11-13 ⏰ 17:30</dt>
            <dd className="text-muted">就这个时刻响</dd>
            <dt className="font-mono text-body">- [ ] 健身 @2026-11-12 下午</dt>
            <dd className="text-muted">不响</dd>
          </dl>
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-line pt-4">
        <p
          role="status"
          className={cn(
            "min-w-0 flex-1 text-[12px] leading-5",
            status?.tone === "danger" ? "text-danger" : "text-muted",
          )}
        >
          {status?.text ??
            (state.quiet && settings.enabled
              ? "现在开着勿扰或者有程序全屏：通知照常，提示音先不响"
              : state.actions
                ? "通知上能直接点「完成」「10 分钟后」「打开」"
                : "这个系统上的通知没有按钮，点开应用再勾")}
        </p>
        <button
          type="button"
          disabled={off}
          onClick={() => void test()}
          className="h-8 shrink-0 rounded-md border border-line-strong bg-canvas px-3 text-[13px] text-body
                     transition-colors duration-[140ms] hover:bg-panel disabled:opacity-45"
        >
          发一条试试
        </button>
      </div>
    </div>
  );
}
