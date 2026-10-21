import type { Cause, Diagnosis, Reach } from "@/lib/bindings";
import { describe, expect, it } from "vitest";
import {
  audienceOf,
  callbackVerdict,
  diagnosisText,
  forwardVerdict,
  reachRemedy,
  reachRows,
  reachSummary,
  relayCheckText,
} from "./reach";

/* 「谁能加入」「为什么连不上」的说法（reach.ts）。事实由 Rust 给（collab/reach.rs、diagnose.rs，
   那边有自己的测试），这里只管拼出来的话对不对 */

const base: Reach = {
  checking: false,
  lan: ["192.168.1.23"],
  ipv6: [],
  publicV4: [],
  portmap: { state: "unavailable" },
  relays: [],
  firewall: { state: "unknown" },
};

describe("谁能加入", () => {
  it("中继连上了、端口映射到了、有公网地址：都算互联网上的人能进来", () => {
    expect(audienceOf(null)).toBe("checking");
    expect(audienceOf({ ...base, checking: true })).toBe("checking");
    const relayed: Reach = {
      ...base,
      checking: true,
      relays: [
        { url: "https://r/", label: "公司的中继", state: { state: "connected", latency: 35 } },
      ],
    };
    // 中继已经连上：不用等端口映射查完
    expect(audienceOf(relayed)).toBe("everyone");
    expect(reachSummary(relayed)).toBe("同一网络和互联网上的人都能加入（经由 公司的中继）");
    const mapped: Reach = { ...base, portmap: { state: "mapped", addr: "58.33.10.2:7000" } };
    expect(reachSummary(mapped)).toContain("路由器给了公网端口");
    expect(reachRemedy(mapped)).toBeNull();
  });

  it("只有 IPv6、只有局域网、没有网：说清楚，给办法", () => {
    expect(audienceOf({ ...base, ipv6: ["2408::1"] })).toBe("ipv6");
    expect(audienceOf(base)).toBe("lan");
    expect(reachSummary(base)).toBe("现在只有同一网络里的人能加入");
    expect(reachRemedy(base)).toContain("手机热点");
    expect(reachRemedy(base)).toContain("中继");
    expect(audienceOf({ ...base, lan: [] })).toBe("offline");
    // 路由器给了 100.64 的地址：外面还是进不来
    const shared: Reach = { ...base, portmap: { state: "shared", addr: "100.72.3.4:7000" } };
    expect(audienceOf(shared)).toBe("lan");
    const portmapRow = reachRows(shared).find((row) => row.key === "portmap")!;
    expect(portmapRow.state).toBe("no");
    expect(portmapRow.detail).toContain("运营商的 NAT");
  });

  it("Windows 防火墙挡着：谁都连不进来，中继除外；明细里多一行", () => {
    const blocked: Reach = { ...base, firewall: { state: "blocked", public: true } };
    expect(audienceOf(blocked)).toBe("blocked");
    expect(reachSummary(blocked)).toBe(
      "现在谁都连不进来：Windows 防火墙在这个「公用」网络上挡着 Odea",
    );
    expect(reachRemedy(blocked)).toContain("允许应用通过防火墙");
    // 端口映射到了也没用：入站的都被挡
    expect(audienceOf({ ...blocked, portmap: { state: "mapped", addr: "1.2.3.4:5" } })).toBe(
      "blocked",
    );
    // 中继是往外连的
    expect(
      audienceOf({
        ...blocked,
        relays: [{ url: "https://r/", label: "r", state: { state: "connected", latency: 9 } }],
      }),
    ).toBe("everyone");
    const row = reachRows(blocked).find((item) => item.key === "firewall")!;
    expect(row).toMatchObject({ state: "no", label: "防火墙" });
    const asked = reachRows({ ...base, firewall: { state: "notAsked", public: false } });
    expect(asked.find((item) => item.key === "firewall")?.detail).toContain("「专用」");
    expect(callbackVerdict(blocked, "林夕").ok).toBe(false);
  });

  it("明细：还没结果时行就占好，配了中继的每台一行", () => {
    expect(reachRows(null).map((row) => row.state)).toEqual(["wait", "wait", "wait", "wait"]);
    expect(reachRows(base).map((row) => row.key)).toEqual(["lan", "ipv6", "portmap", "relay"]);
    const rows = reachRows({
      ...base,
      lan: ["192.168.1.23", "10.0.0.5"],
      relays: [
        { url: "https://a/", label: "a", state: { state: "denied", reason: "x" } },
        { url: "https://b/", label: "b", state: { state: "connected", latency: null } },
      ],
    });
    expect(rows[0]!.detail).toBe("192.168.1.23 等 2 个");
    expect(rows.slice(3).map((row) => [row.state, row.detail])).toEqual([
      ["no", "a 不收这个令牌"],
      ["ok", "b"],
    ]);
  });
});

const diagnosis = (cause: Cause, extra: Partial<Diagnosis> = {}): Diagnosis => ({
  lan: ["192.168.7.5"],
  ipv6: [],
  ipv4: [],
  relay: null,
  sameNetwork: false,
  seenNearby: false,
  hasIpv6: false,
  cause,
  ...extra,
});

describe("连不上的说法", () => {
  it("每一种原因：一句卡在哪、试过哪些路、有下一步", () => {
    const causes: Cause[] = [
      { kind: "offline" },
      { kind: "relayDenied", reason: "token rejected" },
      { kind: "relayDown", error: "timed out" },
      { kind: "relayOutdated" },
      { kind: "hostAway" },
      { kind: "blocked" },
      { kind: "noIpv6" },
      { kind: "hostFirewalled" },
      { kind: "differentNetwork" },
    ];
    for (const cause of causes) {
      const text = diagnosisText(diagnosis(cause, { relay: "r.example.com" }), "林夕");
      expect(text.title, cause.kind).not.toBe("");
      expect(text.detail, cause.kind).not.toBe("");
      expect(text.tried).toBe("试过：局域网 192.168.7.5 · 中继 r.example.com");
      if (cause.kind !== "offline") expect(text.steps.length, cause.kind).toBeGreaterThan(0);
    }
  });

  it("看到了却连不进去：防火墙排第一", () => {
    const seen = diagnosisText(diagnosis({ kind: "blocked" }, { seenNearby: true }), "林夕");
    expect(seen.title).toBe("看得到林夕，但连不进去");
    expect(seen.detail).toContain("公用网络");
    expect(seen.steps[0]).toContain("允许应用通过防火墙");
    const unseen = diagnosisText(diagnosis({ kind: "blocked" }), "林夕");
    expect(unseen.detail).toContain("不允许设备互连");
    // 同一个网络里：回连链接帮不上
    expect(seen.callback).toBe(false);
  });

  it("对方连不进来的几种：先提回连链接", () => {
    for (const kind of ["hostFirewalled", "differentNetwork"] as const) {
      const text = diagnosisText(diagnosis({ kind }), "林夕");
      expect(text.callback).toBe(true);
      expect(text.steps[0]).toContain("回连链接");
    }
    expect(
      diagnosisText(diagnosis({ kind: "relayDenied", reason: "x" }), "林夕").steps[0],
    ).toContain("重新复制一次邀请链接");
  });

  it("回连链接管不管用：看自己能不能被连进来", () => {
    expect(callbackVerdict({ ...base, ipv6: ["2408::5"] }, "林夕").ok).toBe(true);
    expect(
      callbackVerdict({ ...base, portmap: { state: "mapped", addr: "1.2.3.4:5" } }, "林夕").text,
    ).toBe("林夕打开这个链接就能拨到你");
    const useless = callbackVerdict(base, "林夕");
    expect(useless.ok).toBe(false);
    expect(useless.text).toContain("多半没用");
  });

  it("转发链接：同一个网络里的人总能经你加入，互联网上的要看你能不能被连进来", () => {
    const lan = forwardVerdict(base);
    expect(lan.ok).toBe(true);
    expect(lan.text).toContain("互联网上的人连不进你这台");
    expect(
      forwardVerdict({ ...base, portmap: { state: "mapped", addr: "1.2.3.4:5" } }).text,
    ).toContain("互联网上的人都能经你加入");
  });
});

describe("测试中继的结果", () => {
  it("连上了带延迟和 UDP；被拒、连不上说原因", () => {
    expect(
      relayCheckText({
        connected: true,
        latencyMs: 35,
        denied: null,
        error: null,
        udp: true,
        outdated: null,
      }),
    ).toEqual({ ok: true, text: "连上了 · 35ms · UDP 7842 通" });
    expect(
      relayCheckText({
        connected: true,
        latencyMs: null,
        denied: null,
        error: null,
        udp: false,
        outdated: null,
      }).text,
    ).toContain("打洞没人介绍了");
    expect(
      relayCheckText({
        connected: false,
        latencyMs: null,
        denied: "bad",
        error: null,
        udp: null,
        outdated: null,
      }),
    ).toEqual({ ok: false, text: "令牌被拒：bad" });
    expect(
      relayCheckText({
        connected: false,
        latencyMs: null,
        denied: null,
        error: "超时",
        udp: null,
        outdated: null,
      }).text,
    ).toBe("连不上：超时");
  });

  it("中继的版本和 Odea 不配套：直说，问得出来的话带上它认的版本", () => {
    const base = { connected: false, latencyMs: null, denied: null, error: null, udp: null };
    expect(relayCheckText({ ...base, outdated: "iroh-relay-v3" }).text).toBe(
      "中继的版本和 Odea 不配套（它只认 iroh-relay-v3）：照「自建中继」换成配套的 iroh-relay，或者升级 Odea",
    );
    expect(relayCheckText({ ...base, outdated: "" }).text).toMatch(/^中继的版本和 Odea 不配套：/);
    expect(
      diagnosisText(diagnosis({ kind: "relayOutdated" }, { relay: "r.example.com" }), "林夕").title,
    ).toBe("中继 r.example.com 的版本和 Odea 不配套");
  });
});
