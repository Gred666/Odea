/* ============================================================
访客连不上时 3 秒内给结论（docs/协同编辑.md §8.5）：哪几条路试过、卡在哪、下一步怎么做。
永远不出现无限转圈。

能知道的：
- 链接里主持人有哪些路：局域网地址、公网 IPv6、公网 IPv4（端口映射）、中继
- 我这边的网段（netwatch 读网卡的地址和前缀）：主持人的局域网地址在不在我的网段里
- mDNS 有没有在同一个网络里看到主持人（看到了却连不上，几乎一定是防火墙）
- 中继（链接里带了、没选「只直连」）：连上没有、令牌被拒没有

猜原因的顺序（conclude，纯函数，单测直接喂）：
1. 我这边没网
2. 中继：令牌被拒 / 连不上中继 / 中继连上了却找不到主持人（主持人关了、停止了协作，或者他那边连不上中继）
3. 在同一个网络里（网段对得上，或者 mDNS 看到了）却连不进去：主持人的防火墙（Windows 把这个网络
   标成了「公用」）或者 Wi-Fi 不允许设备互连（访客网络、酒店）。看到了的话防火墙排第一
4. 主持人只有公网 IPv6、我没有 IPv6
5. 主持人有公网地址却连不进去：他的路由器 / 防火墙不放行
6. 不在同一个网络、主持人又没有能从外面连进来的地址
给人看的句子和「下一步」由前端按 cause 拼（collab/reach.ts）。
============================================================ */

use std::net::{IpAddr, SocketAddr};

use serde::{Deserialize, Serialize};

use super::reach::{classify, AddrKind};
use super::ticket::Invite;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    /// 链接里主持人的路
    pub lan: Vec<String>,
    pub ipv6: Vec<String>,
    pub ipv4: Vec<String>,
    /// 中继（名字或主机名）；选了「只直连」的话不算
    pub relay: Option<String>,
    /// 主持人的局域网地址在我的网段里
    pub same_network: bool,
    /// mDNS 在同一个网络里看到了主持人
    pub seen_nearby: bool,
    /// 我这边有公网 IPv6
    pub has_ipv6: bool,
    pub cause: Cause,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Cause {
    /// 我这边没有网络
    Offline,
    /// 中继不收这个令牌
    RelayDenied {
        reason: String,
    },
    RelayDown {
        error: String,
    },
    /// 中继的版本和 Odea 不配套（§6.6）
    RelayOutdated,
    /// 中继连上了，但主持人不在上面
    HostAway,
    /// 同一个网络里却连不进去
    Blocked,
    /// 主持人只能经 IPv6 连，我这边没有
    NoIpv6,
    /// 主持人有公网地址，但他的路由器 / 防火墙不放行
    HostFirewalled,
    /// 不在同一个网络，主持人也没有能从外面连进来的地址
    DifferentNetwork,
}

/// 中继现在怎样（访客端点上看到的）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayFact {
    Connecting,
    Connected,
    Denied(String),
    /// 版本对不上（relays::upgrade_refused）
    Outdated,
    Failed(String),
}

#[derive(Debug, Clone, Default)]
pub struct Facts {
    /// 我的网段：地址 + 前缀长度（不含回环、链路本地）
    pub networks: Vec<(IpAddr, u8)>,
    pub seen_nearby: bool,
    /// 用了主持人的中继的话
    pub relay: Option<RelayFact>,
}

pub fn conclude(invite: &Invite, facts: &Facts, use_relay: bool) -> Diagnosis {
    let mut diagnosis = Diagnosis {
        lan: Vec::new(),
        ipv6: Vec::new(),
        ipv4: Vec::new(),
        relay: invite
            .relay
            .as_ref()
            .filter(|_| use_relay)
            .map(|relay| relay.label()),
        same_network: false,
        seen_nearby: facts.seen_nearby,
        has_ipv6: facts
            .networks
            .iter()
            .any(|(ip, _)| classify(*ip) == AddrKind::PublicV6),
        cause: Cause::DifferentNetwork,
    };
    let mut loopback = false;
    for addr in &invite.addrs {
        let text = addr.ip().to_string();
        match classify(addr.ip()) {
            AddrKind::Lan | AddrKind::Shared => diagnosis.lan.push(text),
            AddrKind::PublicV6 => diagnosis.ipv6.push(text),
            AddrKind::PublicV4 => diagnosis.ipv4.push(text),
            AddrKind::Loopback => loopback = true,
            _ => {}
        }
    }
    // 同一台电脑上试（链接里有本机回环）也算同一个网络
    diagnosis.same_network = loopback
        || invite
            .addrs
            .iter()
            .any(|addr| in_my_networks(addr, &facts.networks));

    let online = !facts.networks.is_empty();
    diagnosis.cause = if !online {
        Cause::Offline
    } else if let Some(cause) = match facts.relay.as_ref().filter(|_| diagnosis.relay.is_some()) {
        Some(RelayFact::Denied(reason)) => Some(Cause::RelayDenied {
            reason: reason.clone(),
        }),
        Some(RelayFact::Outdated) => Some(Cause::RelayOutdated),
        Some(RelayFact::Failed(error)) => Some(Cause::RelayDown {
            error: error.clone(),
        }),
        Some(RelayFact::Connected) => Some(Cause::HostAway),
        // 还在连中继：先按直连的情况说
        Some(RelayFact::Connecting) | None => None,
    } {
        cause
    } else if diagnosis.same_network || diagnosis.seen_nearby {
        Cause::Blocked
    } else if !diagnosis.ipv6.is_empty() && diagnosis.ipv4.is_empty() && !diagnosis.has_ipv6 {
        Cause::NoIpv6
    } else if !diagnosis.ipv6.is_empty() || !diagnosis.ipv4.is_empty() {
        Cause::HostFirewalled
    } else {
        Cause::DifferentNetwork
    };
    diagnosis
}

/// 这个地址在不在我的某个网段里（同一种地址、前缀对得上）
fn in_my_networks(addr: &SocketAddr, networks: &[(IpAddr, u8)]) -> bool {
    let ip = addr.ip();
    if !matches!(classify(ip), AddrKind::Lan | AddrKind::Shared) {
        return false;
    }
    networks
        .iter()
        .any(|(mine, prefix)| same_prefix(ip, *mine, *prefix))
}

fn same_prefix(a: IpAddr, b: IpAddr, prefix: u8) -> bool {
    match (a, b) {
        (IpAddr::V4(a), IpAddr::V4(b)) => {
            let prefix = u32::from(prefix.min(32));
            let mask = if prefix == 0 {
                0
            } else {
                u32::MAX << (32 - prefix)
            };
            u32::from(a) & mask == u32::from(b) & mask
        }
        (IpAddr::V6(a), IpAddr::V6(b)) => {
            let prefix = u32::from(prefix.min(128));
            let mask = if prefix == 0 {
                0
            } else {
                u128::MAX << (128 - prefix)
            };
            u128::from(a) & mask == u128::from(b) & mask
        }
        _ => false,
    }
}

/// 我的网段。读不到网卡（极少见）时退回到端点知道的地址，按常见的前缀猜
pub async fn my_networks(fallback: &[SocketAddr]) -> Vec<(IpAddr, u8)> {
    let state = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        netwatch::interfaces::State::new(),
    )
    .await;
    let mut networks: Vec<(IpAddr, u8)> = match state {
        Ok(state) => state
            .interfaces
            .values()
            .filter(|interface| interface.is_up())
            .flat_map(|interface| {
                interface.addrs().map(|net| match net {
                    netwatch::interfaces::IpNet::V4(net) => {
                        (IpAddr::V4(net.addr()), net.prefix_len())
                    }
                    netwatch::interfaces::IpNet::V6 { net, .. } => {
                        (IpAddr::V6(net.addr()), net.prefix_len())
                    }
                })
            })
            .collect(),
        Err(_) => return guess_networks(fallback),
    };
    networks.retain(|(ip, _)| usable(*ip));
    networks
}

/// 只有地址、没有前缀时按常见的猜：IPv4 /24、IPv6 /64
pub fn guess_networks(addrs: &[SocketAddr]) -> Vec<(IpAddr, u8)> {
    addrs
        .iter()
        .map(|addr| (addr.ip(), if addr.is_ipv4() { 24 } else { 64 }))
        .filter(|(ip, _)| usable(*ip))
        .collect()
}

fn usable(ip: IpAddr) -> bool {
    !matches!(
        classify(ip),
        AddrKind::Loopback | AddrKind::LinkLocal | AddrKind::Other
    )
}
