import { relayCheckText } from "@/collab/reach";
import { isRelayCode, useRelays } from "@/collab/relayStore";
import { openExternal } from "@/editor/links";
import type { RelayInfo } from "@/lib/bindings";
import { cn } from "@/lib/cn";
import { popoverCard, tween } from "@/lib/motion";
import { refreshTeamRelays, shareTeamRelay, useTeam } from "@/team/store";
import { Check, Copy, LoaderCircle, Server, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { BannerButton } from "./ConflictBanner";
import { DialogLead, usePaletteBack } from "./PaletteBack";

/* ============================================================
   协作中继（docs/协同编辑.md §6.4）：命令面板「协作中继…」、点开中继码、连不上时的「配中继…」。

   - 粘中继码先确认：「添加中继 relay.example.com？」它决定了以后连接的元数据经过谁的机器
   - 也能手填：地址、令牌，自签名证书再填指纹
   - 每台：测试（延迟、令牌、UDP 7842）、复制中继码发给别人、删掉
   外壳和协作对话框一样：遮罩 + 从标题栏往下展开的实心卡片（popoverCard）。
   ============================================================ */

const HEADER = 52;
const GUIDE =
  "https://github.com/Gred666/Odea/blob/master/docs/%E8%87%AA%E5%BB%BA%E4%B8%AD%E7%BB%A7.md";

export function RelayDialog() {
  const open = useRelays((s) => s.open);
  const close = useRelays((s) => s.close);
  const back = usePaletteBack("relays", open, close);

  useEffect(() => {
    if (open) void refreshTeamRelays();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        (back ?? close)();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close, back]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            key="scrim"
            type="button"
            data-ghost-skip
            aria-label="关闭协作中继"
            onClick={close}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={tween.base}
            className="fixed inset-0 z-[55] cursor-default bg-ink/[0.14] backdrop-blur-[3px]"
          />
          <div
            key="panel"
            data-ghost-skip
            className="pointer-events-none fixed inset-0 z-[55] flex items-start justify-center pt-[14vh]"
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label="协作中继"
              data-relay-dialog
              custom={HEADER}
              variants={popoverCard}
              initial="hidden"
              animate="shown"
              exit="gone"
              className="pointer-events-auto relative w-[480px] max-w-[calc(100vw-48px)]
                         overflow-clip rounded-2xl bg-canvas shadow-modal ring-1 ring-line-strong"
            >
              <div
                className="flex items-center gap-2.5 border-b border-line px-4"
                style={{ height: HEADER }}
              >
                <DialogLead icon={Server} back={back} />
                <p className="flex-1 text-[14px] font-medium text-ink">协作中继</p>
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
              <div className="scroll-thin max-h-[64vh] overflow-y-auto px-5 py-4">
                <RelayBody />
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

function RelayBody() {
  const relays = useRelays((s) => s.relays);
  const pending = useRelays((s) => s.pending);
  const error = useRelays((s) => s.error);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] leading-[1.7] text-body">
        {
          "不在同一个网络的人，靠中继连上：打洞时它当介绍人，打不通时由它转发（只转发加密过的内容，看不到你们写了什么）。Odea 不提供中继：团队里有一个人架好，把中继码发给大家，每人添加一次。"
        }
      </p>
      {pending && <ConfirmCard info={pending.info} />}
      <section>
        <p className="mb-1.5 text-[12px] text-muted">
          {relays.length ? `配好的 · ${relays.length}` : "还没有配中继"}
        </p>
        {relays.length > 0 && (
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {relays.map((relay) => (
              <RelayRow key={relay.url} relay={relay} />
            ))}
          </ul>
        )}
      </section>
      <AddForm />
      {error && <p className="text-[12px] text-danger">{error}</p>}
      <DeviceId />
      <p className="border-t border-line pt-3 text-[12px] leading-[1.65] text-muted">
        自己架一台：一台有公网 IP 的小机器（1 核 1G 就够），跑官方的 iroh-relay。
        <button
          type="button"
          onClick={() => void openExternal(GUIDE)}
          className="ml-1 text-accent hover:underline"
        >
          看「自建中继」
        </button>
      </p>
    </div>
  );
}

/** 这台设备的公钥：中继只放行固定几台时（relay.toml 的 access.allowlist）要把它填进去 */
function DeviceId() {
  const deviceId = useRelays((s) => s.deviceId);
  const [copied, setCopied] = useState(false);
  if (!deviceId) return null;
  const copy = async () => {
    await navigator.clipboard.writeText(deviceId).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <section data-relay-device className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-[12px] text-muted">
          这台设备的公钥（中继只放行固定几台时，填进 access.allowlist）
        </p>
        <p className="truncate font-mono text-[12px] text-body" title={deviceId}>
          {deviceId}
        </p>
      </div>
      <BannerButton onClick={() => void copy()}>
        {copied ? <Check size={12} strokeWidth={2.2} /> : <Copy size={12} strokeWidth={2} />}
        {copied ? "已复制" : "复制"}
      </BannerButton>
    </section>
  );
}

/** 中继码要确认：以后连接的元数据经过这台机器 */
function ConfirmCard({ info }: { info: RelayInfo }) {
  const confirm = useRelays((s) => s.confirmPending);
  const cancel = useRelays((s) => s.cancelPending);
  const busy = useRelays((s) => s.busy);
  return (
    <div
      data-relay-confirm
      className="rounded-lg border border-accent-line bg-accent-wash px-3 py-2.5"
    >
      <p className="text-[13px] font-medium text-ink">添加中继 {info.host}？</p>
      <p className="mt-1 text-[13px] leading-[1.65] text-body">
        {[
          info.name ? `名字「${info.name}」` : "",
          info.hasToken ? "带着令牌" : "没有令牌",
          info.pinned ? "自签名证书（按指纹认）" : "",
        ]
          .filter(Boolean)
          .join("，")}
        。以后不在同一个网络时，你的连接元数据（IP
        地址、在和谁连）会经过这台机器。只添加你信得过的人给的。
      </p>
      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => void confirm()}
          className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-ink
                     transition-colors duration-[140ms] hover:bg-accent-hover disabled:opacity-50"
        >
          添加
        </button>
        <BannerButton onClick={cancel}>不添加</BannerButton>
      </div>
    </div>
  );
}

function RelayRow({ relay }: { relay: RelayInfo }) {
  // 团队仓库（docs/协同编辑.md §22.4）：这台给不给团队用（写进仓库，成员打开时问一句用不用）
  const teamActive = useTeam((s) => s.active);
  const forTeam = useTeam((s) => s.relays.some((item) => item.url === relay.url));
  const check = useRelays((s) => s.checks[relay.url]);
  const test = useRelays((s) => s.test);
  const remove = useRelays((s) => s.remove);
  const code = useRelays((s) => s.code);
  const [copied, setCopied] = useState(false);
  const result = check && check !== "testing" ? relayCheckText(check) : null;
  const copy = async () => {
    const text = await code(relay.url);
    if (!text) return;
    await navigator.clipboard
      .writeText(`${text}\n这是 Odea 的协作中继码：在命令面板「协作中继…」里粘贴添加。`)
      .catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <li data-relay-row className="px-3 py-2">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[13px] text-ink">
          {relay.name ?? relay.host}
          {relay.name && <span className="text-faint"> · {relay.host}</span>}
        </p>
        <BannerButton disabled={check === "testing"} onClick={() => void test(relay.url)}>
          {check === "testing" && (
            <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />
          )}
          测试
        </BannerButton>
        <BannerButton onClick={() => void copy()}>
          {copied ? <Check size={12} strokeWidth={2.2} /> : <Copy size={12} strokeWidth={2} />}
          {copied ? "已复制" : "中继码"}
        </BannerButton>
        {teamActive && (
          <BannerButton
            onClick={() => void shareTeamRelay(relay.url, !forTeam)}
            title={
              forTeam
                ? "团队仓库里写着这台：成员打开时会问用不用。点一下拿出来"
                : "写进这个团队仓库：成员打开时会问一句用不用（中继码里带着令牌，成员都能用）"
            }
          >
            {forTeam && <Check size={12} strokeWidth={2.2} />}
            {forTeam ? "团队在用" : "给团队用"}
          </BannerButton>
        )}
        <BannerButton danger onClick={() => void remove(relay.url)}>
          删除
        </BannerButton>
      </div>
      <p
        data-relay-check
        className={cn(
          "mt-0.5 text-[12px]",
          result ? (result.ok ? "text-success" : "text-danger") : "text-faint",
        )}
      >
        {check === "testing"
          ? "正在连…"
          : result
            ? result.text
            : [relay.hasToken ? "带令牌" : "没有令牌", relay.pinned ? "自签名证书" : ""]
                .filter(Boolean)
                .join(" · ")}
      </p>
    </li>
  );
}

/** 粘中继码，或者手填地址（填了地址再给令牌、指纹两栏） */
function AddForm() {
  const inspect = useRelays((s) => s.inspect);
  const addManual = useRelays((s) => s.addManual);
  const busy = useRelays((s) => s.busy);
  const [value, setValue] = useState("");
  const [manual, setManual] = useState(false);
  const [token, setToken] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [name, setName] = useState("");
  const submit = async () => {
    const text = value.trim();
    if (!text) return;
    if (isRelayCode(text)) {
      await inspect(text);
      setValue("");
      return;
    }
    if (!manual) {
      setManual(true);
      return;
    }
    const ok = await addManual({ url: text, token, fingerprint, name });
    if (ok) {
      setValue("");
      setToken("");
      setFingerprint("");
      setName("");
      setManual(false);
    }
  };
  const field =
    "h-9 min-w-0 rounded-lg bg-raised px-3 text-[13px] text-ink outline-none placeholder:text-faint";
  return (
    <section className="flex flex-col gap-2">
      <div className="flex h-10 items-center gap-2 rounded-lg bg-raised pl-3 pr-1">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) void submit();
          }}
          placeholder="粘贴中继码，或者填地址 relay.example.com"
          aria-label="中继码或地址"
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-faint"
        />
        <button
          type="button"
          data-relay-add
          disabled={!value.trim() || busy}
          onClick={() => void submit()}
          className="h-8 shrink-0 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-ink
                     transition-colors duration-[140ms] hover:bg-accent-hover disabled:opacity-50"
        >
          添加
        </button>
      </div>
      {manual && !isRelayCode(value) && (
        <div className="grid grid-cols-2 gap-2">
          <input
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="令牌（relay.toml 的 access.shared_token）"
            aria-label="令牌"
            className={cn(field, "col-span-2 font-mono")}
          />
          <input
            value={fingerprint}
            onChange={(event) => setFingerprint(event.target.value)}
            placeholder="证书指纹（自签名证书才填）"
            aria-label="证书指纹"
            className={cn(field, "font-mono")}
          />
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="名字（可不填）"
            aria-label="名字"
            className={field}
          />
        </div>
      )}
    </section>
  );
}
