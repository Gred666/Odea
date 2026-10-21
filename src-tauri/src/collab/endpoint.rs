/* ============================================================
iroh 端点（docs/协同编辑.md §5.2）。

- 默认一台服务器都不连：presets::Minimal 就是「不连 n0 的中继、不用 n0 的 DNS、只配好 TLS」，
  没配中继时明写 RelayMode::Disabled。tests.rs 守着
- 用户自己配了中继（或者邀请链接里带了主持人的）：RelayMode::Custom，只有这几台（relays.rs）。
  证书校验换成认指纹的那一个（自签名证书的中继），其余的照常按 CA 根证书
- 只在会话期间开着：开始协作时起，结束时关。平时不占端口、不广播、不弹防火墙
- 局域网发现用 mDNS（自己的服务名，只看得到 Odea）。主持人广播，广播里只有昵称和公钥，
  不带文档标题；访客只听不广播
- QUIC 每 5 秒保活一次，12 秒没动静认出断了（设计 §7.3）
- 继续上次的协作（record.rs）时绑回原来的端口：访客手里链接里的地址才不作废。被占了就随便绑一个
============================================================ */

use std::net::SocketAddr;
use std::time::Duration;

use iroh::address_lookup::UserData;
use iroh::endpoint::{presets, BindOpts, IdleTimeout, QuicTransportConfig};
use iroh::{Endpoint, EndpointAddr, PublicKey, SecretKey, TransportAddr};
use iroh_mdns_address_lookup::MdnsAddressLookup;

use super::protocol::ALPN;
use super::relays::{self, Pins, Relay};

/// mDNS 的服务名：`<公钥>._odea-collab._udp.local`
pub const MDNS_SERVICE: &str = "odea-collab";

pub struct Bound {
    pub endpoint: Endpoint,
    /// 留着它：丢了就不广播、不发现了
    pub mdns: Option<MdnsAddressLookup>,
    /// 自签名证书中继的指纹（主持人按回连链接临时加中继时往里加）
    pub pins: Pins,
}

/// 起一个端点。advertise 是主持人的昵称（广播出去）；访客传 None，只听。
/// relays 是这次会话用的中继（空的话一台都不连）。ports 是想绑回的端口（IPv4、IPv6），
/// 绑不上就换随机的
pub async fn bind(
    secret_key: SecretKey,
    advertise: Option<&str>,
    mdns: bool,
    relays: &[Relay],
    ports: &[u16],
) -> Result<Bound, String> {
    if !ports.is_empty() {
        match bind_with(secret_key.clone(), advertise, mdns, relays, ports).await {
            Ok(bound) => return Ok(bound),
            Err(error) => eprintln!("协作：原来的端口绑不上，换一个：{error}"),
        }
    }
    bind_with(secret_key, advertise, mdns, relays, &[]).await
}

async fn bind_with(
    secret_key: SecretKey,
    advertise: Option<&str>,
    mdns: bool,
    relays: &[Relay],
    ports: &[u16],
) -> Result<Bound, String> {
    let idle = IdleTimeout::try_from(Duration::from_secs(12)).map_err(|error| error.to_string())?;
    let transport = QuicTransportConfig::builder()
        .keep_alive_interval(Duration::from_secs(5))
        .max_idle_timeout(Some(idle))
        .build();
    let pins = relays::pins(relays);
    let mut builder = Endpoint::builder(presets::Minimal)
        .secret_key(secret_key)
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(relays::relay_mode(relays))
        .ca_tls_config(relays::tls_config(pins.clone()))
        .transport_config(transport);
    if let Some(&v4) = ports.first().filter(|port| **port != 0) {
        builder = builder
            .bind_addr(SocketAddr::from((std::net::Ipv4Addr::UNSPECIFIED, v4)))
            .map_err(|error| error.to_string())?;
    }
    if let Some(&v6) = ports.get(1).filter(|port| **port != 0) {
        // IPv6 绑不上不算错（和 iroh 默认一样）
        builder = builder
            .bind_addr_with_opts(
                SocketAddr::from((std::net::Ipv6Addr::UNSPECIFIED, v6)),
                BindOpts::default().set_is_required(false),
            )
            .map_err(|error| error.to_string())?;
    }
    if let Some(name) = advertise.filter(|_| mdns) {
        // 广播里只有昵称（超长的截掉）
        let name: String = name.chars().take(40).collect();
        if let Ok(data) = UserData::try_from(name) {
            builder = builder.user_data_for_address_lookup(data);
        }
    }
    let endpoint = builder
        .bind()
        .await
        .map_err(|error| format!("打不开网络端口：{error}"))?;
    let mdns = if mdns {
        match MdnsAddressLookup::builder()
            .service_name(MDNS_SERVICE)
            .advertise(advertise.is_some())
            .build(endpoint.id())
        {
            Ok(lookup) => {
                if let Ok(services) = endpoint.address_lookup() {
                    services.add(lookup.clone());
                }
                Some(lookup)
            }
            // 局域网发现起不来（网卡都没有组播）不影响按链接里的地址直连
            Err(error) => {
                eprintln!("协作：mDNS 起不来：{error}");
                None
            }
        }
    } else {
        None
    };
    Ok(Bound {
        endpoint,
        mdns,
        pins,
    })
}

/// 按链接里的公钥、地址和中继拼出拨号用的地址（地址都失效了的话，mDNS 还能按公钥找）
pub fn dial_addr(
    peer: &[u8; 32],
    addrs: &[SocketAddr],
    relay: Option<&Relay>,
) -> Result<EndpointAddr, String> {
    let id = PublicKey::from_bytes(peer).map_err(|_| "链接里的公钥不对".to_string())?;
    let relay = relay.and_then(|relay| relay.relay_url().ok());
    Ok(EndpointAddr {
        id,
        addrs: addrs
            .iter()
            .copied()
            .map(TransportAddr::Ip)
            .chain(relay.map(TransportAddr::Relay))
            .collect(),
    })
}

/// 端点绑的端口：IPv4 的在前，IPv6 的（有的话）在后。落盘时记下来，继续协作时绑回去
pub fn ports(endpoint: &Endpoint) -> Vec<u16> {
    let sockets = endpoint.bound_sockets();
    let v4 = sockets
        .iter()
        .find(|addr| addr.is_ipv4())
        .map(|addr| addr.port());
    let v6 = sockets
        .iter()
        .find(|addr| addr.is_ipv6())
        .map(|addr| addr.port());
    match (v4, v6) {
        (Some(v4), Some(v6)) => vec![v4, v6],
        (Some(v4), None) => vec![v4],
        _ => Vec::new(),
    }
}

/// 公钥给前端看的样子（小写十六进制）：成员的 id、颜色都按它算
pub fn id_text(id: &[u8; 32]) -> String {
    data_encoding::HEXLOWER.encode(id)
}

pub fn random<const N: usize>() -> [u8; N] {
    use ring::rand::SecureRandom;
    let mut out = [0; N];
    ring::rand::SystemRandom::new()
        .fill(&mut out)
        .expect("系统随机数不可用");
    out
}
