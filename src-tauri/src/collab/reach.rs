/* ============================================================
能不能被连进来（docs/协同编辑.md §5.3、§8.5「分享之前先查」）。

一个端点能被别人找到的路：
- 局域网地址（私有 IPv4、IPv6 的 ULA）：同一个网络里的人
- 公网 IPv6：对方也有 IPv6、路由器又放行的话能直连。放不放行这边测不出来（没有第三台机器帮忙看）
- 端口映射：问自家路由器要一个公网端口（UPnP / NAT-PMP / PCP）。iroh 1.3 只在配了中继时才去要
  （socket.rs 里中继表为空就整段跳过），所以这里自己驱动 portmapper，拿到的地址 add_external_addr
  进端点，邀请链接里就带上了。拿到的「公网」地址如果是 100.64.x.x 或私有地址：路由器自己也在
  运营商的 NAT 后面，外面还是连不进来（Shared）
- 网卡上直接就是公网 IPv4（少见）
- 中继：配了的话，连上了谁都能经它进来

主持人开始协作时就查，变了（端口映射到了、中继连上了、换了网络）就再报一次，邀请链接跟着更新。
访客生成回连链接之前也查一遍。界面上那一句「谁能加入」由前端按这份 Reach 拼（collab/reach.ts）。
============================================================ */

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4};
use std::num::NonZeroU16;
use std::time::{Duration, Instant};

use iroh::{Endpoint, RelayUrl, TransportAddr, Watcher};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::firewall::Firewall;
use super::relays::{self, Relay};

/// 端口映射、中继最多「查」多久，之后没结果就当没有（结果晚到了照样更新）
pub const CHECK_TIME: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddrKind {
    Loopback,
    /// 链路本地（169.254、fe80::）：跨机器用不上（IPv6 的还得带本机的网卡编号）
    LinkLocal,
    /// 私有 IPv4、IPv6 的 ULA（fc00::/7）
    Lan,
    /// 运营商级 NAT 的共享地址（100.64.0.0/10）
    Shared,
    PublicV4,
    PublicV6,
    Other,
}

pub fn classify(ip: IpAddr) -> AddrKind {
    match ip {
        IpAddr::V4(ip) => classify_v4(ip),
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return classify_v4(v4);
            }
            let first = ip.segments()[0];
            if ip.is_loopback() {
                AddrKind::Loopback
            } else if first & 0xffc0 == 0xfe80 {
                AddrKind::LinkLocal
            } else if first & 0xfe00 == 0xfc00 {
                AddrKind::Lan
            } else if first & 0xe000 == 0x2000 && !is_documentation_v6(ip) {
                AddrKind::PublicV6
            } else {
                AddrKind::Other
            }
        }
    }
}

fn classify_v4(ip: Ipv4Addr) -> AddrKind {
    let [a, b, ..] = ip.octets();
    if ip.is_loopback() {
        AddrKind::Loopback
    } else if ip.is_link_local() {
        AddrKind::LinkLocal
    } else if ip.is_private() {
        AddrKind::Lan
    } else if a == 100 && (b & 0xc0) == 64 {
        AddrKind::Shared
    } else if ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        // 198.18.0.0/15 留给基准测试（RFC 2544），公网上没有。Clash / Mihomo、Surge、sing-box
        // 的 TUN 网卡和 fake-ip 都用这一段：开着它们的电脑网卡上有 198.18.0.1，不能当公网地址报
        // 「互联网上的人都能加入」（2026-10-18 桌面端实测撞上的）
        || (a == 198 && (b & 0xfe) == 18)
        || a == 0
        || a >= 240
    {
        AddrKind::Other
    } else {
        AddrKind::PublicV4
    }
}

fn is_documentation_v6(ip: Ipv6Addr) -> bool {
    let [a, b, ..] = ip.segments();
    a == 0x2001 && b == 0x0db8
}

/// 写进链接的直连地址：去掉链路本地的；公网的在前，局域网的其次，本机回环最后
/// （同一台电脑上试的时候用）。iroh 是所有地址一起试的，顺序只关系到链接太长时截掉谁：
/// 虚拟网卡（Hyper-V、WSL、VPN）多的电脑上局域网地址一大串，不能把端口映射拿到的那个挤掉
pub fn link_addrs(addrs: impl IntoIterator<Item = SocketAddr>) -> Vec<SocketAddr> {
    let rank = |addr: &SocketAddr| match classify(addr.ip()) {
        AddrKind::PublicV4 => 0,
        AddrKind::PublicV6 => 1,
        AddrKind::Lan if addr.is_ipv4() => 2,
        AddrKind::Lan => 3,
        AddrKind::Shared | AddrKind::Other => 4,
        AddrKind::Loopback => 5,
        AddrKind::LinkLocal => 6,
    };
    let mut addrs: Vec<SocketAddr> = addrs
        .into_iter()
        .filter(|addr| classify(addr.ip()) != AddrKind::LinkLocal)
        .collect();
    addrs.sort_by_key(|addr| (rank(addr), addr.ip().to_string(), addr.port()));
    addrs.dedup();
    addrs
}

/// 端点现在的直连地址
pub fn endpoint_addrs(endpoint: &Endpoint) -> Vec<SocketAddr> {
    link_addrs(endpoint.addr().addrs.iter().filter_map(|addr| match addr {
        TransportAddr::Ip(ip) => Some(*ip),
        _ => None,
    }))
}

/* ---------------- 给界面看的 ---------------- */

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Reach {
    /// 还在查（端口映射要等路由器回话，中继要连一下）
    pub checking: bool,
    /// 局域网地址（私有 IPv4、ULA）
    pub lan: Vec<String>,
    /// 公网 IPv6
    pub ipv6: Vec<String>,
    /// 网卡上直接就是公网 IPv4（没有 NAT）
    pub public_v4: Vec<String>,
    pub portmap: Portmap,
    pub relays: Vec<RelayReach>,
    /// Windows 防火墙在当前网络上放不放行（主持人；别的系统、访客是 Unknown）
    pub firewall: Firewall,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum Portmap {
    Checking,
    /// 路由器给了一个公网端口
    Mapped {
        addr: String,
    },
    /// 路由器给了，但它自己也在运营商的 NAT 后面（100.64.x.x / 私有地址）：外面还是进不来
    Shared {
        addr: String,
    },
    /// 路由器不支持、或者关了 UPnP / NAT-PMP / PCP
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RelayReach {
    pub url: String,
    /// 名字（没起名字的是主机名）
    pub label: String,
    pub state: RelayState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum RelayState {
    Connecting,
    /// latency：到它的延迟（毫秒，网络报告量的）
    Connected {
        latency: Option<u32>,
    },
    /// 令牌被拒
    Denied {
        reason: String,
    },
    /// 中继的版本和 Odea 不配套（§6.6，relays::upgrade_refused）：error 是 iroh 给的原话
    Outdated {
        error: String,
    },
    Failed {
        error: String,
    },
}

/// 按地址分好类的那一半（纯函数，单测直接喂地址）
/// local：这台电脑网卡上的地址（读出来之前是 None）。端点的地址里还有中继看到的出口地址
/// （QAD：NAT 外面那一侧，比如 125.84.x.x），它也是公网地址，但只是路由器的出口、外面连不进来 ——
/// 「网卡上直接就是公网 IPv4」只算真在网卡上的（2026-10-18 配了中继实测撞上的）
pub fn sort_addrs(addrs: &[SocketAddr], reach: &mut Reach, local: Option<&[IpAddr]>) {
    reach.lan.clear();
    reach.ipv6.clear();
    reach.public_v4.clear();
    let mapped = match &reach.portmap {
        Portmap::Mapped { addr } => Some(addr.clone()),
        _ => None,
    };
    for addr in addrs {
        let text = addr.ip().to_string();
        let list = match classify(addr.ip()) {
            AddrKind::Lan => &mut reach.lan,
            AddrKind::PublicV6 => &mut reach.ipv6,
            // 端口映射拿到的那个已经在 portmap 里了；不在网卡上的是出口地址，不算
            AddrKind::PublicV4
                if Some(addr.to_string()) != mapped
                    && local.is_some_and(|local| local.contains(&addr.ip())) =>
            {
                &mut reach.public_v4
            }
            _ => continue,
        };
        if !list.contains(&text) {
            list.push(text);
        }
    }
}

/* ---------------- 端口映射 ---------------- */

/// 问路由器要一个公网端口，映射到端点的 IPv4 端口上。拿到了就加进端点的地址（链接里带上）。
/// 丢掉时把映射还给路由器
pub struct Mapper {
    client: portmapper::Client,
    state: watch::Receiver<Portmap>,
    task: JoinHandle<()>,
}

impl Mapper {
    pub fn start(endpoint: &Endpoint) -> Mapper {
        let (sender, state) = watch::channel(Portmap::Checking);
        let client = portmapper::Client::new(portmapper::Config::default());
        let port = endpoint
            .bound_sockets()
            .into_iter()
            .find(|addr| addr.is_ipv4())
            .and_then(|addr| NonZeroU16::new(addr.port()));
        let task = match port {
            Some(port) => {
                client.update_local_port(port);
                client.procure_mapping();
                tokio::spawn(drive(client.clone(), endpoint.clone(), sender))
            }
            None => {
                let _ = sender.send(Portmap::Unavailable);
                tokio::spawn(async {})
            }
        };
        Mapper {
            client,
            state,
            task,
        }
    }

    pub fn state(&self) -> watch::Receiver<Portmap> {
        self.state.clone()
    }

    /// 把映射还给路由器（等它一小会儿，不然 client 一丢，还映射的那个任务也跟着停了）
    pub async fn stop(self) {
        self.task.abort();
        self.client.deactivate();
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn drive(client: portmapper::Client, endpoint: Endpoint, state: watch::Sender<Portmap>) {
    let mut external = client.watch_external_address();
    let mut probe = client.probe();
    let mut probed = false;
    // 路由器三种协议（UPnP / NAT-PMP / PCP）一种都不支持的话不用等到超时
    let mut supported = true;
    let mut added: Option<SocketAddr> = None;
    let deadline = tokio::time::sleep(CHECK_TIME);
    tokio::pin!(deadline);
    loop {
        let current: Option<SocketAddrV4> = *external.borrow_and_update();
        let next = match current {
            Some(addr) if classify_v4(*addr.ip()) == AddrKind::PublicV4 => Portmap::Mapped {
                addr: addr.to_string(),
            },
            Some(addr) => Portmap::Shared {
                addr: addr.to_string(),
            },
            None if !supported || deadline.is_elapsed() => Portmap::Unavailable,
            None => Portmap::Checking,
        };
        let wanted = match (&next, current) {
            (Portmap::Mapped { .. }, Some(addr)) => Some(SocketAddr::V4(addr)),
            _ => None,
        };
        if wanted != added {
            if let Some(old) = added.take() {
                endpoint.remove_external_addr(&old).await;
            }
            if let Some(new) = wanted {
                endpoint.add_external_addr(new).await;
                added = Some(new);
            }
        }
        state.send_if_modified(|value| {
            let changed = *value != next;
            *value = next;
            changed
        });
        tokio::select! {
            changed = external.changed() => if changed.is_err() { return },
            result = &mut probe, if !probed => {
                probed = true;
                supported = matches!(result, Ok(Ok(output)) if output.upnp || output.pcp || output.nat_pmp);
            }
            _ = &mut deadline, if !deadline.is_elapsed() => {}
        }
    }
}

/* ---------------- 汇总，变了就报 ---------------- */

/// 盯着端点的地址、中继、网络报告、端口映射和防火墙，变了就算一份新的 Reach 交给 notify
pub fn watch_reach(
    endpoint: Endpoint,
    portmap: Option<watch::Receiver<Portmap>>,
    firewall: Option<watch::Receiver<Firewall>>,
    relays: Vec<Relay>,
    notify: impl Fn(Reach) + Send + 'static,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let started = Instant::now();
        let mut addrs = endpoint.watch_addr();
        let mut status = endpoint.home_relay_status();
        let mut reports = endpoint.net_report();
        // 没有端口映射（访客平时不要）：给一个不会变的
        let (_keep, idle) = watch::channel(Portmap::Unavailable);
        let mut portmap = portmap.unwrap_or(idle);
        let mut portmap_open = true;
        let (_keep_firewall, unknown) = watch::channel(Firewall::Unknown);
        let mut firewall = firewall.unwrap_or(unknown);
        let mut firewall_open = true;
        let mut last: Option<Reach> = None;
        let deadline = tokio::time::sleep(CHECK_TIME + Duration::from_millis(200));
        tokio::pin!(deadline);
        // 网卡上的地址：Windows 上读一次要两秒多，后台读；网络变了（地址变了）再读
        let (local_sender, mut local) = watch::channel::<Option<Vec<IpAddr>>>(None);
        let reader = {
            let endpoint = endpoint.clone();
            tokio::spawn(async move {
                let mut addrs = endpoint.watch_addr();
                loop {
                    let ips = super::diagnose::my_networks(&[])
                        .await
                        .into_iter()
                        .map(|(ip, _)| ip)
                        .collect();
                    if local_sender.send(Some(ips)).is_err() || addrs.updated().await.is_err() {
                        return;
                    }
                }
            })
        };
        let _reader = AbortOnDrop(reader);
        loop {
            let current = local.borrow_and_update().clone();
            let mut reach = snapshot(
                &endpoint,
                &portmap.borrow_and_update(),
                &relays,
                started,
                current.as_deref(),
            );
            reach.firewall = firewall.borrow_and_update().clone();
            if last.as_ref() != Some(&reach) {
                notify(reach.clone());
                last = Some(reach);
            }
            tokio::select! {
                _ = endpoint.closed() => return,
                changed = addrs.updated() => if changed.is_err() { return },
                changed = status.updated() => if changed.is_err() { return },
                changed = reports.updated() => if changed.is_err() { return },
                changed = portmap.changed(), if portmap_open => portmap_open = changed.is_ok(),
                changed = firewall.changed(), if firewall_open => firewall_open = changed.is_ok(),
                changed = local.changed() => if changed.is_err() { return },
                _ = &mut deadline, if !deadline.is_elapsed() => {}
            }
        }
    })
}

/// 盯梢的任务结束（主持人停了、端点关了）时把读网卡的那个也收掉
struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// local：网卡上的地址（还没读出来是 None，这时算「还在查」）
pub fn snapshot(
    endpoint: &Endpoint,
    portmap: &Portmap,
    relays: &[Relay],
    started: Instant,
    local: Option<&[IpAddr]>,
) -> Reach {
    let mut reach = Reach {
        checking: false,
        lan: Vec::new(),
        ipv6: Vec::new(),
        public_v4: Vec::new(),
        portmap: portmap.clone(),
        relays: relay_states(endpoint, relays, started.elapsed() >= CHECK_TIME),
        firewall: Firewall::Unknown,
    };
    sort_addrs(&endpoint_addrs(endpoint), &mut reach, local);
    reach.checking = local.is_none()
        || matches!(reach.portmap, Portmap::Checking)
        || reach
            .relays
            .iter()
            .any(|relay| relay.state == RelayState::Connecting);
    reach
}

fn relay_states(endpoint: &Endpoint, relays: &[Relay], late: bool) -> Vec<RelayReach> {
    let status = endpoint.home_relay_status().get();
    let report = endpoint.net_report().get();
    relays
        .iter()
        .map(|relay| {
            let url: Option<RelayUrl> = relay.relay_url().ok();
            let current = url
                .as_ref()
                .and_then(|url| status.iter().find(|status| status.url() == url));
            let state = match current {
                Some(status) if status.is_connected() => RelayState::Connected {
                    latency: url.as_ref().and_then(|url| {
                        report
                            .as_ref()
                            .and_then(|report| relays::latency_of(report, url).0)
                    }),
                },
                Some(status) if status.auth_denied_reason().is_some() => RelayState::Denied {
                    reason: status.auth_denied_reason().unwrap_or_default().to_string(),
                },
                // 版本对不上：再等也连不上，不用等到「晚了」才说
                Some(status)
                    if status.last_error().is_some_and(|error| {
                        relays::upgrade_refused(&relays::error_text(error))
                    }) =>
                {
                    RelayState::Outdated {
                        error: status
                            .last_error()
                            .map(|error| relays::error_text(error))
                            .unwrap_or_default(),
                    }
                }
                Some(status) if late => RelayState::Failed {
                    error: status
                        .last_error()
                        .map(|error| relays::error_text(error))
                        .unwrap_or_else(|| "连不上".into()),
                },
                // 还没轮到它当 home relay（iroh 只连延迟最低的那台）：看网络报告里量没量到
                None if late => match url.as_ref().zip(report.as_ref()) {
                    Some((url, report)) if relays::latency_of(report, url).0.is_some() => {
                        RelayState::Connected {
                            latency: relays::latency_of(report, url).0,
                        }
                    }
                    _ => RelayState::Failed {
                        error: "连不上".into(),
                    },
                },
                _ => RelayState::Connecting,
            };
            RelayReach {
                url: relay.url.clone(),
                label: relay.label(),
                state,
            }
        })
        .collect()
}
