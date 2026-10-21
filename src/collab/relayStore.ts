import type { RelayCheck, RelayInfo } from "@/lib/bindings";
import { create } from "zustand";
import { type CollabNet, type RelayInput, collabNet, errorText } from "./net";

/* ============================================================
   自己配的协作中继（docs/协同编辑.md §6.4）：命令面板「协作中继…」打开。

   - 粘中继码（odea://relay/…）：先问一句「添加中继 relay.example.com？」—— 它决定了以后你的
     连接元数据（IP、和谁在连）经过谁的机器，必须用户确认。点开中继码链接也走这里
   - 手填：地址、令牌，自签名证书的话再填指纹
   - 每台可以「测试」（连一下：延迟、令牌对不对、UDP 7842 通不通）、复制中继码发给别人、删掉
   - 底下给这台设备的公钥：中继只放行固定几台时（relay.toml 的 access.allowlist）要填它
   令牌不出 Rust：这里只知道「带没带令牌」。
   ============================================================ */

export interface RelaysState {
  open: boolean;
  relays: RelayInfo[];
  /** 正在测的、测完的 */
  checks: Record<string, RelayCheck | "testing">;
  /** 粘进来的中继码，等用户确认 */
  pending: { code: string; info: RelayInfo } | null;
  error: string | null;
  busy: boolean;
  /** 这台设备的公钥（十六进制）：中继的 access.allowlist 填它 */
  deviceId: string | null;

  openRelays(code?: string): void;
  close(): void;
  /** 粘进来的东西：中继码就先拆开给用户看；不是中继码返回 false（当地址手填） */
  inspect(code: string): Promise<boolean>;
  confirmPending(): Promise<void>;
  cancelPending(): void;
  addManual(input: Extract<RelayInput, { url: string }>): Promise<boolean>;
  remove(url: string): Promise<void>;
  /** 中继码（带令牌）：发给团队里的其他人 */
  code(url: string): Promise<string | null>;
  test(url: string): Promise<void>;
}

let net: CollabNet | null = null;

async function ensureNet(): Promise<CollabNet> {
  net ??= await collabNet();
  return net;
}

export function isRelayCode(text: string): boolean {
  return /^\s*<?["']?odea:(\/\/)?relay\//i.test(text);
}

export const useRelays = create<RelaysState>((set, get) => ({
  open: false,
  relays: [],
  checks: {},
  pending: null,
  error: null,
  busy: false,
  deviceId: null,

  openRelays: (code) => {
    set({ open: true, error: null, pending: null });
    void ensureNet()
      .then((current) => current.relays())
      .then((relays) => set({ relays }))
      .catch((error) => set({ error: errorText(error) }));
    void ensureNet()
      .then((current) => current.identity())
      .then((identity) => set({ deviceId: identity.id }))
      .catch(() => {});
    if (code) void get().inspect(code);
  },
  close: () => set({ open: false, pending: null, error: null }),

  inspect: async (code) => {
    if (!isRelayCode(code)) return false;
    try {
      const info = await (await ensureNet()).relayInspect(code.trim());
      set({ pending: { code: code.trim(), info }, error: null });
    } catch (error) {
      set({ error: errorText(error), pending: null });
    }
    return true;
  },
  confirmPending: async () => {
    const pending = get().pending;
    if (!pending) return;
    set({ busy: true });
    try {
      const relays = await (await ensureNet()).relayAdd({ code: pending.code });
      set({ relays, pending: null, error: null });
    } catch (error) {
      set({ error: errorText(error) });
    } finally {
      set({ busy: false });
    }
  },
  cancelPending: () => set({ pending: null }),
  addManual: async (input) => {
    set({ busy: true });
    try {
      const relays = await (await ensureNet()).relayAdd(input);
      set({ relays, error: null });
      return true;
    } catch (error) {
      set({ error: errorText(error) });
      return false;
    } finally {
      set({ busy: false });
    }
  },
  remove: async (url) => {
    try {
      const relays = await (await ensureNet()).relayRemove(url);
      const { [url]: _, ...checks } = get().checks;
      set({ relays, checks });
    } catch (error) {
      set({ error: errorText(error) });
    }
  },
  code: async (url) => {
    try {
      return await (await ensureNet()).relayCode(url);
    } catch (error) {
      set({ error: errorText(error) });
      return null;
    }
  },
  test: async (url) => {
    set((state) => ({ checks: { ...state.checks, [url]: "testing" } }));
    try {
      const check = await (await ensureNet()).relayTest(url);
      set((state) => ({ checks: { ...state.checks, [url]: check } }));
    } catch (error) {
      set((state) => ({
        checks: {
          ...state.checks,
          [url]: {
            connected: false,
            latencyMs: null,
            denied: null,
            error: errorText(error),
            udp: null,
            outdated: null,
          },
        },
      }));
    }
  },
}));

/** 测试：换网络层、清状态 */
export function resetRelaysForTest(next: CollabNet | null): void {
  net = next;
  useRelays.setState({
    open: false,
    relays: [],
    checks: {},
    pending: null,
    error: null,
    busy: false,
    deviceId: null,
  });
}
