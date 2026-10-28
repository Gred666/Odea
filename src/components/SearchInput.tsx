import { cn } from "@/lib/cn";
import { spring, tween } from "@/lib/motion";
import { Search, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRef, useState } from "react";

export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  return (
    <div
      className={cn(
        "relative flex h-9 items-center gap-2 rounded-lg px-2.5",
        "transition-colors duration-[160ms]",
        // 聚焦只做「底色提亮 + 一圈中性描边」。原来这里是 ring-accent-line，
        // 那圈蓝色比输入的文字还抢眼，看着像报错或者选中状态。
        focused ? "bg-canvas ring-1 ring-line-strong" : "bg-raised/55 hover:bg-raised/80",
      )}
    >
      <motion.span
        animate={{ scale: focused ? 1.06 : 1 }}
        transition={spring.snappy}
        className={cn("shrink-0 transition-colors", focused ? "text-muted" : "text-faint")}
      >
        <Search size={14} strokeWidth={2} />
      </motion.span>

      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            onChange("");
          }
        }}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none
                   placeholder:text-faint selection:bg-accent/20"
      />

      <AnimatePresence>
        {value && (
          <motion.button
            type="button"
            aria-label="清空搜索"
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={tween.fast}
            onClick={() => {
              onChange("");
              ref.current?.focus();
            }}
            className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-muted
                       transition-colors hover:bg-raised hover:text-body"
          >
            <X size={12} strokeWidth={2.4} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
