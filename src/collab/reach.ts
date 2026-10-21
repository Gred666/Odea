import type { Diagnosis, Reach, RelayCheck, RelayReach } from "@/lib/bindings";

/* ============================================================
   「谁能加入」「为什么连不上」的说法（docs/协同编辑.md §8.5）。
   Rust 给事实（collab/reach.rs、diagnose.rs），这里拼成人话。纯函数，单测直接喂。

   - 主持人分享前：一行结论（谁能加入）+ 几行明细（局域网、IPv6、端口映射、中继、Windows 防火墙）
   - 访客连不上：卡在哪（一句）、为什么（一句）、下一步（几条）
   ============================================================ */

export type Audience =
  /** 还在查 */
  | "checking"
  /** 同一网络和互联网上的人都能加入 */
  | "everyone"
  /** 同一网络的人能；互联网上有 IPv6 的人多半也能 */
  | "ipv6"
  /** 只有同一网络里的人 */
  | "lan"
  /** Windows 防火墙在这个网络上挡着 Odea：谁都连不进来（中继除外） */
  | "blocked"
  /** 没有网络 */
  | "offline";

const connected = (relay: RelayReach) => relay.state.state === "connected";

export function audienceOf(reach: Reach | null): Audience {
  if (!reach) return "checking";
  // 经中继的连接是往外连的，防火墙挡不着
  if (reach.relays.some(connected)) return "everyone";
  if (reach.firewall.state === "blocked") return "blocked";
  if (reach.portmap.state === "mapped" || reach.publicV4.length) return "everyone";
  if (reach.checking) return "checking";
  if (reach.ipv6.length) return "ipv6";
  if (reach.lan.length) return "lan";
  return "offline";
}

/** 主持人那一行：谁能加入 */
export function reachSummary(reach: Reach | null): string {
  const audience = audienceOf(reach);
  switch (audience) {
    case "checking":
      return "正在看谁能加入…";
    case "everyone": {
      const relay = reach?.relays.find(connected);
      const how = relay
        ? `经由 ${relay.label}`
        : reach?.portmap.state === "mapped"
          ? "路由器给了公网端口"
          : "这台电脑有公网地址";
      return `同一网络和互联网上的人都能加入（${how}）`;
    }
    case "ipv6":
      return "同一网络里的人能加入；互联网上的人如果也有 IPv6，多半也能（看你的路由器放不放行）";
    case "lan":
      return "现在只有同一网络里的人能加入";
    case "blocked":
      return `现在谁都连不进来：Windows 防火墙在这个${networkKind(reach)}网络上挡着 Odea`;
    case "offline":
      return "现在没有网络：连上网络再邀请";
  }
}

/** 「公用」「专用」：Windows 给这个网络标的类型 */
function networkKind(reach: Reach | null): string {
  const firewall = reach?.firewall;
  if (!firewall || firewall.state === "unknown") return "";
  return firewall.public ? "「公用」" : "「专用」";
}

/** 怎么让 Windows 防火墙放行（主持人、访客生成回连链接时都用） */
export const FIREWALL_FIX =
  "在「Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙」里给 Odea 勾上「公用」和「专用」，或者把这个网络改成「专用网络」（设置 → 网络和 Internet → 属性）";

/** 不在同一个网络的人怎么办（只有局域网、只有 IPv6 时给） */
export function reachRemedy(reach: Reach | null): string | null {
  const audience = audienceOf(reach);
  if (audience === "blocked") return `${FIREWALL_FIX}。`;
  if (audience !== "lan" && audience !== "ipv6") return null;
  return "不在同一个网络的人：连同一个 Wi-Fi、一方开手机热点，或者配一台中继（一个人配好，全组都能用）。";
}

export type RowState = "ok" | "no" | "wait";

export interface ReachRow {
  key: string;
  label: string;
  state: RowState;
  detail: string;
}

/** 「多个地址」只写第一个 */
function first(list: string[]): string {
  return list.length > 1 ? `${list[0]} 等 ${list.length} 个` : (list[0] ?? "");
}

/** 自检的明细：局域网、IPv6、端口映射、每台中继 */
export function reachRows(reach: Reach | null): ReachRow[] {
  const checking = !reach;
  const rows: ReachRow[] = [
    {
      key: "lan",
      label: "局域网",
      state: checking ? "wait" : reach.lan.length ? "ok" : "no",
      detail: checking ? "…" : reach.lan.length ? first(reach.lan) : "没有局域网地址",
    },
    {
      key: "ipv6",
      label: "公网 IPv6",
      state: checking ? "wait" : reach.ipv6.length ? "ok" : "no",
      detail: checking ? "…" : reach.ipv6.length ? first(reach.ipv6) : "没有",
    },
  ];
  const portmap = reach?.portmap ?? { state: "checking" as const };
  rows.push({
    key: "portmap",
    label: "端口映射",
    state: portmap.state === "mapped" ? "ok" : portmap.state === "checking" ? "wait" : "no",
    detail:
      portmap.state === "mapped"
        ? `路由器给了 ${portmap.addr}`
        : portmap.state === "shared"
          ? `路由器给了 ${portmap.addr}，但它也在运营商的 NAT 后面，外面进不来`
          : portmap.state === "checking"
            ? "正在问路由器…"
            : "路由器不支持（或者关了 UPnP）",
  });
  if (reach?.publicV4.length) {
    rows.push({ key: "v4", label: "公网 IPv4", state: "ok", detail: first(reach.publicV4) });
  }
  for (const relay of reach?.relays ?? []) {
    const state = relay.state;
    rows.push({
      key: `relay:${relay.url}`,
      label: "中继",
      state: state.state === "connected" ? "ok" : state.state === "connecting" ? "wait" : "no",
      detail:
        state.state === "connected"
          ? `${relay.label}${state.latency != null ? ` · ${state.latency}ms` : ""}`
          : state.state === "connecting"
            ? `正在连 ${relay.label}…`
            : state.state === "denied"
              ? `${relay.label} 不收这个令牌`
              : state.state === "outdated"
                ? `${relay.label} 拒了连接：多半是版本和 Odea 不配套`
                : `连不上 ${relay.label}`,
    });
  }
  const firewall = reach?.firewall;
  if (firewall && firewall.state !== "unknown") {
    const kind = firewall.public ? "「公用」" : "「专用」";
    rows.push({
      key: "firewall",
      label: "防火墙",
      state: firewall.state === "allowed" ? "ok" : firewall.state === "notAsked" ? "wait" : "no",
      detail:
        firewall.state === "allowed"
          ? `放行了（这个网络是${kind}）`
          : firewall.state === "notAsked"
            ? `Windows 会问是否允许 Odea 用网络：这个网络是${kind}，记得勾上它`
            : `这个网络是${kind}，Windows 防火墙挡着 Odea`,
    });
  }
  // 还没结果时也占一行：对话框展开时只量第一帧，之后行数尽量不变
  if (!reach) rows.push({ key: "relay", label: "中继", state: "wait", detail: "…" });
  else if (!reach.relays.length)
    rows.push({ key: "relay", label: "中继", state: "no", detail: "没配" });
  return rows;
}

export interface DiagnosisText {
  /** 卡在哪 */
  title: string;
  /** 为什么 */
  detail: string;
  /** 试过的路 */
  tried: string;
  /** 下一步 */
  steps: string[];
  /** 生成回连链接有没有可能管用 */
  callback: boolean;
}

/** 访客连不上：一句卡在哪、一句为什么、几条下一步 */
export function diagnosisText(diagnosis: Diagnosis, host: string): DiagnosisText {
  const tried = [
    diagnosis.lan.length ? `局域网 ${first(diagnosis.lan)}` : "",
    diagnosis.ipv6.length ? `IPv6 ${first(diagnosis.ipv6)}` : "",
    diagnosis.ipv4.length ? `公网 ${first(diagnosis.ipv4)}` : "",
    diagnosis.relay ? `中继 ${diagnosis.relay}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const sameWifi = "连同一个 Wi-Fi，或者一方开手机热点给另一方";
  const callbackStep = `生成回连链接发给${host}：你这边能被连进来的话，由${host}往你这边拨`;
  const relayStep = "配一台中继（一个人配好，全组都能用）";
  const cause = diagnosis.cause;
  const base = { tried: tried ? `试过：${tried}` : "链接里没有能用的地址" };
  switch (cause.kind) {
    case "offline":
      return {
        ...base,
        title: "你这边没有网络",
        detail: "连上网络以后会自动再试。",
        steps: [],
        callback: false,
      };
    case "relayDenied":
      return {
        ...base,
        title: `中继 ${diagnosis.relay ?? ""} 不收这个令牌`,
        detail: `${host}可能换过中继的令牌（中继说：${cause.reason}）。`,
        steps: [`让${host}重新复制一次邀请链接发给你`, sameWifi],
        callback: false,
      };
    case "relayDown":
      return {
        ...base,
        title: `连不上中继 ${diagnosis.relay ?? ""}`,
        detail: `${cause.error}。有的公司网络、代理会挡这类连接。`,
        steps: [`问问${host}那台中继还通不通`, sameWifi, callbackStep],
        callback: true,
      };
    case "relayOutdated":
      return {
        ...base,
        title: `中继 ${diagnosis.relay ?? ""} 的版本和 Odea 不配套`,
        detail:
          "中继拒了连接：多半是它和 Odea 不是同一代 iroh，也可能是它前面的反向代理没转发 WebSocket（在「协作中继…」里点「测试」能分清）。",
        steps: [
          `让${host}照「自建中继」把中继换成配套的 iroh-relay，或者两边都升到最新的 Odea`,
          sameWifi,
          callbackStep,
        ],
        callback: true,
      };
    case "hostAway":
      return {
        ...base,
        title: `中继连上了，但在上面找不到${host}`,
        detail: `${host}可能已经停止了协作、关了 Odea，或者他那边连不上中继。`,
        steps: [`问问${host}协作还开着没有，再要一次邀请链接`],
        callback: false,
      };
    case "blocked":
      return {
        ...base,
        title: diagnosis.seenNearby
          ? `看得到${host}，但连不进去`
          : "你们在同一个网络里，但连不进去",
        detail: diagnosis.seenNearby
          ? `多半是${host}那边的防火墙：Windows 把这个网络当成了「公用网络」，只给「专用网络」放行了 Odea。`
          : `多半是${host}那边的防火墙；也可能是这个 Wi-Fi 不允许设备互连（访客网络、酒店、咖啡馆常这样）。`,
        steps: [
          `让${host}在「Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙」里给 Odea 勾上「公用」，或者把这个网络改成「专用网络」`,
          "换一个网络，或者一方开手机热点给另一方",
        ],
        callback: false,
      };
    case "noIpv6":
      return {
        ...base,
        title: `${host}只能经 IPv6 连进去，你这边没有 IPv6`,
        detail: "手机网络大多有 IPv6，很多家里的宽带也有，但这个网络没有。",
        steps: ["换一个有 IPv6 的网络（比如手机热点）", sameWifi, relayStep],
        callback: true,
      };
    case "hostFirewalled":
      return {
        ...base,
        title: `${host}的路由器不让外面连进去`,
        detail: "链接里有他的公网地址，但连过去没有回应。",
        steps: [callbackStep, sameWifi, relayStep],
        callback: true,
      };
    case "differentNetwork":
      return {
        ...base,
        title: "你们不在同一个网络里",
        detail: `${host}那边又不能被外面连进去（没有公网 IPv6，路由器也没给端口映射），没有第三台机器帮忙就连不上。`,
        steps: [callbackStep, sameWifi, relayStep],
        callback: true,
      };
  }
}

/** 访客生成回连链接时：主持人能不能拨到我 */
export function callbackVerdict(reach: Reach, host: string): { ok: boolean; text: string } {
  switch (audienceOf(reach)) {
    case "blocked":
      return {
        ok: false,
        text: `你这边的 Windows 防火墙挡着 Odea，${host}拨不进来：${FIREWALL_FIX}`,
      };
    case "everyone":
      return { ok: true, text: `${host}打开这个链接就能拨到你` };
    case "ipv6":
      return { ok: true, text: `${host}也有 IPv6 的话多半能拨到你（看你的路由器放不放行）` };
    case "checking":
      return { ok: true, text: `${host}打开这个链接后会往你这边拨` };
    default:
      return {
        ok: false,
        text: "你这边也连不进来（没有公网 IPv6，路由器也没给端口映射），这个链接多半没用：连同一个 Wi-Fi、开手机热点，或者配中继",
      };
  }
}

/**
 * 转发链接：谁能经我加入（设计 §20.9）。转发多半用在同一个网络里（主持人只有我够得着），
 * 那里本来就连得上；互联网上的人要看我这台能不能被连进来
 */
export function forwardVerdict(reach: Reach): { ok: boolean; text: string } {
  switch (audienceOf(reach)) {
    case "blocked":
      return {
        ok: false,
        text: `你这边的 Windows 防火墙挡着 Odea，别人连不进你这台：${FIREWALL_FIX}`,
      };
    case "everyone":
      return { ok: true, text: "同一个网络里的人、互联网上的人都能经你加入" };
    case "ipv6":
      return { ok: true, text: "同一个网络里的人能经你加入；有 IPv6 的人多半也行" };
    case "checking":
      return { ok: true, text: "同一个网络里的人能经你加入" };
    default:
      return { ok: true, text: "同一个网络里的人能经你加入（互联网上的人连不进你这台）" };
  }
}

/** 测试中继的结果，一句话 */
export function relayCheckText(check: RelayCheck): { ok: boolean; text: string } {
  if (check.connected) {
    const parts = ["连上了"];
    if (check.latencyMs != null) parts.push(`${check.latencyMs}ms`);
    if (check.udp === true) parts.push("UDP 7842 通");
    if (check.udp === false) parts.push("UDP 7842 不通：转发能用，但打洞没人介绍了");
    return { ok: true, text: parts.join(" · ") };
  }
  if (check.denied) return { ok: false, text: `令牌被拒：${check.denied}` };
  // 版本对不上（设计 §6.6）：直说，不当成泛泛的连不上
  if (check.outdated != null)
    return {
      ok: false,
      text: `中继的版本和 Odea 不配套${check.outdated ? `（它只认 ${check.outdated}）` : ""}：照「自建中继」换成配套的 iroh-relay，或者升级 Odea`,
    };
  return { ok: false, text: `连不上：${check.error ?? "原因不明"}` };
}
