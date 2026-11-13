import { CALLOUT_ICONS } from "@/editor/callout";
import { cn } from "@/lib/cn";
import { tween } from "@/lib/motion";
import type {
  FormField,
  ListItem,
  Tone,
  TreeItem,
  ViewButton,
  ViewNode,
} from "@/plugins/sandbox/views";
import { type SlotView, runSlotAction, useScripted } from "@/plugins/scripted";
import { Puzzle } from "lucide-react";
import { motion } from "motion/react";
import { createElement, useState } from "react";

/* ============================================================
   带脚本的插件（L1）填在正文后面的那几段（贡献点 documentSlots，docs/插件与跨端.md §5.6）。

   插件交来的是一棵纯数据的组件树（plugins/sandbox/views.ts 校验过），这里用 Odea 自己的样子画：
   字号、颜色、间距、按钮都是宿主的，插件只能在几档里挑（tone、primary）。动效只有整段第一次出来时
   淡一下透明度（docs/PITFALLS/动效.md「先对齐再动」），内容换了直接换，不闪。描边用 border。

   点了按钮、提交了表单：交给插件（scripted.ts 的 runSlotAction），做完马上重画这一段；
   这期间这一段的按钮都灰着，免得连点两下改两次。
   ============================================================ */

type Act = (action: string, value?: unknown, form?: Record<string, unknown>) => void;

const TONE: Record<Tone, string> = {
  default: "text-body",
  muted: "text-muted",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

/** 这一篇上插件填的那几段 */
export function PluginSlots({ docKey }: { docKey: string }) {
  const views = useScripted((state) => state.slots[docKey]);
  if (!views?.length) return null;
  return (
    <>
      {views.map((view) => (
        <SlotSection key={`${view.plugin}/${view.slot}`} view={view} docKey={docKey} />
      ))}
    </>
  );
}

function SlotSection({ view, docKey }: { view: SlotView; docKey: string }) {
  const [busy, setBusy] = useState(false);
  const act: Act = (action, value, form) => {
    if (busy) return;
    setBusy(true);
    void runSlotAction(view, docKey, action, value, form).finally(() => setBusy(false));
  };
  return (
    <motion.section
      aria-label={view.title}
      data-plugin-slot={`${view.plugin}/${view.slot}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={tween.base}
      className="mt-14"
    >
      <div className="mb-2.5 flex items-center gap-2">
        <Puzzle size={14} strokeWidth={2} className="text-faint" />
        <h2 className="text-[12px] font-semibold tracking-[0.04em] text-muted">{view.title}</h2>
        <span className="truncate text-[12px] text-faint">{view.pluginName}</span>
      </div>
      <div className="rounded-lg border border-line bg-canvas px-3.5 py-3">
        <Node node={view.tree} act={act} busy={busy} />
      </div>
    </motion.section>
  );
}

function Node({ node, act, busy }: { node: ViewNode; act: Act; busy: boolean }) {
  switch (node.type) {
    case "stack":
      return (
        <div className="flex flex-col gap-3">
          {node.children.map((child, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 插件交来的树没有 key，按位置认
            <Node key={index} node={child} act={act} busy={busy} />
          ))}
        </div>
      );
    case "heading":
      return <h3 className="text-[13px] font-semibold text-ink">{node.text}</h3>;
    case "text":
      return (
        <p
          className={cn(
            "selectable whitespace-pre-line text-[13px] leading-[1.7]",
            TONE[node.tone ?? "default"],
          )}
        >
          {node.text}
        </p>
      );
    case "stats":
      return (
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          {node.items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 同上
            <div key={index} className="flex items-baseline gap-1.5">
              <dt className="order-2 text-[12px] text-muted">{item.label}</dt>
              <dd
                className={cn(
                  "text-[15px] font-semibold tabular-nums",
                  item.tone ? TONE[item.tone] : "text-ink",
                )}
              >
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      );
    case "list":
      return (
        <ul className="-mx-1.5 flex flex-col">
          {node.items.map((item) => (
            <ListRow key={item.id} item={item} act={act} busy={busy} />
          ))}
        </ul>
      );
    case "tree":
      return <Tree items={node.items} depth={0} />;
    case "buttons":
      return (
        <div className="flex flex-wrap gap-1.5">
          {node.buttons.map((button, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 同上
            <Button key={index} button={button} act={act} busy={busy} />
          ))}
        </div>
      );
    case "empty":
      return (
        <div className="py-3 text-center">
          <p className="text-[13px] text-muted">{node.title}</p>
          {node.hint && <p className="mt-1 text-[12px] text-faint">{node.hint}</p>}
        </div>
      );
    case "form":
      return (
        <Form
          // 插件给的初始值变了就重新来（用户填了一半的不留）
          key={`${node.id}\n${JSON.stringify(node.fields)}`}
          form={node}
          act={act}
          busy={busy}
        />
      );
    case "divider":
      return <hr className="border-line" />;
  }
}

function Icon({ name }: { name: string }) {
  const nodes = Object.hasOwn(CALLOUT_ICONS, name) ? CALLOUT_ICONS[name] : undefined;
  if (!nodes) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="mt-[3px] shrink-0"
    >
      {/* 图标的线稿是定死的，按位置认 */}
      {nodes.map(([tag, attributes], index) => createElement(tag, { key: index, ...attributes }))}
    </svg>
  );
}

function ListRow({ item, act, busy }: { item: ListItem; act: Act; busy: boolean }) {
  return (
    <li className="flex items-start gap-2 rounded-md px-1.5 py-1.5">
      {item.icon && (
        <span className={item.tone ? TONE[item.tone] : "text-faint"}>
          <Icon name={item.icon} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "selectable text-[13px] leading-[1.6]",
            item.tone ? TONE[item.tone] : "text-ink/90",
          )}
        >
          {item.title}
        </p>
        {item.description && (
          <p className="selectable text-[12px] leading-[1.6] text-muted">{item.description}</p>
        )}
      </div>
      {item.actions && (
        <div className="flex shrink-0 gap-1">
          {item.actions.map((button, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 同上
            <Button key={index} button={button} act={act} busy={busy} small />
          ))}
        </div>
      )}
    </li>
  );
}

function Tree({ items, depth }: { items: TreeItem[]; depth: number }) {
  return (
    <ul className={cn("flex flex-col", depth > 0 && "ml-3.5 border-l border-line pl-2.5")}>
      {items.map((item) => (
        <li key={item.id} className="py-0.5">
          <p className="selectable text-[13px] leading-[1.6] text-ink/90">{item.title}</p>
          {item.description && (
            <p className="selectable text-[12px] leading-[1.6] text-muted">{item.description}</p>
          )}
          {item.children && <Tree items={item.children} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

function Button({
  button,
  act,
  busy,
  small,
  form,
}: {
  button: ViewButton;
  act: Act;
  busy: boolean;
  small?: boolean;
  /** 表单的提交按钮：交上表单里填的 */
  form?: () => Record<string, unknown>;
}) {
  return (
    <button
      type="button"
      disabled={busy || button.disabled}
      onClick={() => act(button.action, button.value, form?.())}
      className={cn(
        "flex shrink-0 items-center rounded-md font-medium transition-colors duration-[140ms] disabled:opacity-50",
        small ? "h-6 px-2 text-[12px]" : "h-7 px-2.5 text-[12px]",
        button.primary
          ? "bg-accent text-accent-ink hover:bg-accent-hover"
          : button.tone === "danger"
            ? "bg-danger/10 text-danger hover:bg-danger/15"
            : "bg-raised text-ink hover:bg-line-strong",
      )}
    >
      {button.label}
    </button>
  );
}

function initialValue(field: FormField): string | boolean {
  if (field.type === "checkbox") return field.value ?? false;
  if (field.type === "select") return field.value ?? field.options[0]?.value ?? "";
  return field.value ?? "";
}

function Form({
  form,
  act,
  busy,
}: {
  form: Extract<ViewNode, { type: "form" }>;
  act: Act;
  busy: boolean;
}) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(form.fields.map((field) => [field.name, initialValue(field)])),
  );
  const set = (name: string, value: string | boolean) =>
    setValues((current) => ({ ...current, [name]: value }));
  return (
    <div className="flex flex-col gap-2.5">
      {form.fields.map((field) => (
        <FieldInput
          key={field.name}
          field={field}
          value={values[field.name] ?? initialValue(field)}
          onChange={(value) => set(field.name, value)}
        />
      ))}
      <div className="flex">
        <Button button={form.submit} act={act} busy={busy} form={() => ({ ...values })} />
      </div>
    </div>
  );
}

const INPUT = "h-8 rounded-md border border-line-strong bg-canvas px-2 text-[13px] text-ink";

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
}) {
  if (field.type === "checkbox") {
    return (
      <label className="flex items-center gap-2 text-[13px] text-body">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          className="h-3.5 w-3.5 accent-[var(--color-accent)]"
        />
        {field.label}
      </label>
    );
  }
  if (field.type === "select") {
    return (
      <label className="flex flex-col gap-1 text-[12px] text-muted">
        {field.label}
        <select
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          className={INPUT}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="flex flex-col gap-1 text-[12px] text-muted">
      {field.label}
      <input
        type="text"
        value={String(value)}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={INPUT}
      />
    </label>
  );
}
