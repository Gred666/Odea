/* ============================================================
局域网「附近」（docs/协同编辑.md §8.3、§29.2）。

主持人开着分享时用 mDNS 广播（node.rs：自己的服务名，广播里只有昵称和公钥，不带文档标题）。
这里是看的那一边：「加入协作」对话框开着时起一个只听不广播的端点，订阅 mDNS 的发现事件，
同一个网络里正在分享的人一变就整张表报给前端（Control::Nearby）。点一下就按他的公钥和
mDNS 给的地址拨过去，Hello 里不带会话 id 和邀请证明（guest.rs 的 nearby），主持人照样确认。

经由 B（§20.9、§29.2）：只在一个会话里做客、直连着主持人的访客 B 在另一个服务名（VIA_SERVICE）上广播
「主持人公钥的前 16 位、主持人的名字、B 的名字」。列表里显示成「主持人 · 经由 B」，点了拨 B，
B 把 Hello 原样转给主持人（Forward，没有证明），主持人照样确认。主持人自己也看得到的话只列直连的那一条。

没有网也能用（只要在同一个局域网里）。开了客户端隔离的 Wi-Fi 上设备互相看不见，列表就是空的。
============================================================ */

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use iroh::address_lookup::UserData;
use iroh::{Endpoint, SecretKey};
use iroh_mdns_address_lookup::{DiscoveryEvent, MdnsAddressLookup};
use n0_future::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;

use super::endpoint::{self, Bound, VIA_SERVICE};
use super::protocol::Permission;
use super::{Control, Event, Events, Invite};

/// 列表里的一位
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NearbyHost {
    /// 设备公钥（十六进制）：点哪一个就按它拨，也按它挑颜色。经由别人的是转发那位的
    pub id: String,
    /// 主持人的名字
    pub name: String,
    /// 经由谁（替主持人转发的访客的名字）；主持人自己广播的是空
    pub via: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct Found {
    name: String,
    addrs: Vec<SocketAddr>,
    /// 经由别人的：主持人公钥的前 16 位（十六进制）、转发那位的名字
    via: Option<(String, String)>,
}

/// 「经由我」广播里主持人公钥留几位（十六进制）：只用来和直连的那一条去重
const HOST_PREFIX: usize = 16;
/// 广播里隔开几段的字符：名字过了 clean_name，没有控制字符
const SEP: char = '\u{1f}';

/// 「经由我」广播的那一串：主持人公钥的前 16 位、主持人的名字、我的名字。超长的名字截短（UserData 最多 245 字节）
pub(crate) fn via_data(host: &[u8; 32], host_name: &str, me: &str) -> String {
    let budget = (UserData::MAX_LENGTH - HOST_PREFIX - 2 * SEP.len_utf8()) / 2;
    let cut = |name: &str| -> String {
        let name = super::clean_name(name);
        let mut end = name.len().min(budget);
        while !name.is_char_boundary(end) {
            end -= 1;
        }
        name[..end].to_string()
    };
    let key = endpoint::id_text(host);
    format!("{}{SEP}{}{SEP}{}", &key[..HOST_PREFIX], cut(host_name), cut(me))
}

/// via_data 反过来：(主持人公钥前 16 位, 主持人的名字, 转发那位的名字)
fn parse_via(data: &str) -> Option<(String, String, String)> {
    let mut parts = data.split(SEP);
    let (key, host, via) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || key.len() != HOST_PREFIX || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some((key.to_ascii_lowercase(), super::clean_name(host), super::clean_name(via)))
}

/// 直连的和经由别人的分开记：同一台设备可能先主持、后来改成替人转发，两边各自过期
#[derive(Default)]
struct Seen {
    direct: BTreeMap<String, Found>,
    via: BTreeMap<String, Found>,
}

pub struct Nearby {
    endpoint: Endpoint,
    _mdns: Option<MdnsAddressLookup>,
    _via: MdnsAddressLookup,
    seen: Arc<Mutex<Seen>>,
    tasks: Vec<JoinHandle<()>>,
}

impl Nearby {
    /// 开始看。建端点要两三秒（Windows 上枚举网卡），列表从 events 里出来
    pub async fn start(events: Events) -> Result<Nearby, String> {
        let Bound { endpoint, mdns, .. } = endpoint::bind(SecretKey::generate(), None, true, &[], &[]).await?;
        let Some(lookup) = mdns.clone() else {
            return Err("这台电脑上的局域网发现起不来（没有支持组播的网卡）".into());
        };
        let via = MdnsAddressLookup::builder()
            .service_name(VIA_SERVICE)
            .advertise(false)
            .build(endpoint.id())
            .map_err(|error| format!("这台电脑上的局域网发现起不来：{error}"))?;
        let seen = Arc::new(Mutex::new(Seen::default()));
        let _ = events.send(Event::Control(Control::Nearby { hosts: Vec::new() }));
        let tasks = vec![
            tokio::spawn(watch(lookup, false, seen.clone(), events.clone())),
            tokio::spawn(watch(via.clone(), true, seen.clone(), events)),
        ];
        Ok(Nearby { endpoint, _mdns: mdns, _via: via, seen, tasks })
    }

    /// 点了列表里的一位：拼一个不带会话 id 和邀请密钥的链接（加入时 GuestOptions.nearby = true）。
    /// 经由别人的拨的是转发的那位
    pub fn invite(&self, id: &str) -> Option<Invite> {
        let found = {
            let seen = self.seen.lock().unwrap();
            seen.direct.get(id).or_else(|| seen.via.get(id)).cloned()?
        };
        let host = super::record::hex_array::<32>(id)?;
        Some(Invite {
            host,
            addrs: found.addrs,
            session: [0; 16],
            secret: [0; 32],
            permission: Permission::Edit,
            relay: None,
        })
    }

    pub async fn stop(self) {
        for task in self.tasks {
            task.abort();
        }
        self.endpoint.close().await;
    }
}

async fn watch(lookup: MdnsAddressLookup, via: bool, seen: Arc<Mutex<Seen>>, events: Events) {
    let mut stream = lookup.subscribe().await;
    while let Some(event) = stream.next().await {
        let hosts = {
            let mut seen = seen.lock().unwrap();
            let list = if via { &mut seen.via } else { &mut seen.direct };
            let changed = match event {
                DiscoveryEvent::Discovered { endpoint_info, .. } => {
                    let id = endpoint::id_text(endpoint_info.endpoint_id.as_bytes());
                    // 只有在分享的人才带着名字：没有的不列
                    let Some(data) = endpoint_info.user_data().map(|data| data.as_ref().to_string()) else {
                        continue;
                    };
                    let addrs = endpoint_info.ip_addrs().copied().collect();
                    let next = if via {
                        let Some((key, name, by)) = parse_via(&data) else { continue };
                        Found { name, addrs, via: Some((key, by)) }
                    } else {
                        Found { name: super::clean_name(&data), addrs, via: None }
                    };
                    let changed = list.get(&id) != Some(&next);
                    list.insert(id, next);
                    changed
                }
                DiscoveryEvent::Expired { endpoint_id } => {
                    list.remove(&endpoint::id_text(endpoint_id.as_bytes())).is_some()
                }
                _ => false,
            };
            changed.then(|| hosts_of(&seen))
        };
        if let Some(hosts) = hosts {
            let _ = events.send(Event::Control(Control::Nearby { hosts }));
        }
    }
}

/// 报给前端的那张表：按主持人的名字排；主持人自己也看得到的，经由别人的那几条不列
fn hosts_of(seen: &Seen) -> Vec<NearbyHost> {
    let direct =
        seen.direct.iter().map(|(id, found)| NearbyHost { id: id.clone(), name: found.name.clone(), via: None });
    let via = seen.via.iter().filter_map(|(id, found)| {
        let (key, by) = found.via.as_ref()?;
        if seen.direct.keys().any(|host| host.starts_with(key.as_str())) {
            return None;
        }
        Some(NearbyHost { id: id.clone(), name: found.name.clone(), via: Some(by.clone()) })
    });
    let mut hosts: Vec<NearbyHost> = direct.chain(via).collect();
    hosts.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.via.cmp(&b.via)).then_with(|| a.id.cmp(&b.id)));
    hosts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn via_broadcasts_round_trip_and_fit_in_user_data() {
        let host = [0xab; 32];
        let data = via_data(&host, "林夕", "Bea");
        assert_eq!(parse_via(&data), Some(("abababababababab".into(), "林夕".into(), "Bea".into())));
        // 名字再长（40 个四字节的字）也装得下，截在字的边界上
        let long = "😀".repeat(40);
        let data = via_data(&host, &long, &long);
        assert!(UserData::try_from(data.clone()).is_ok(), "{} 字节", data.len());
        let (_, name, by) = parse_via(&data).unwrap();
        assert!(name.starts_with("😀😀") && by.starts_with("😀😀"));
        // 主持人自己广播的昵称、坏的都不算
        assert_eq!(parse_via("林夕"), None);
        assert_eq!(parse_via("xyz\u{1f}a\u{1f}b"), None);
    }

    #[test]
    fn hosts_seen_directly_hide_their_via_entries() {
        let found = |name: &str, via: Option<(&str, &str)>| Found {
            name: name.into(),
            addrs: Vec::new(),
            via: via.map(|(key, by)| (key.into(), by.into())),
        };
        let mut seen = Seen::default();
        seen.direct.insert("aaaa000000000000ffff".into(), found("林夕", None));
        seen.via.insert("b1".into(), found("林夕", Some(("aaaa000000000000", "Bea"))));
        seen.via.insert("b2".into(), found("周会", Some(("cccc000000000000", "Bea"))));
        assert_eq!(
            hosts_of(&seen),
            vec![
                NearbyHost { id: "b2".into(), name: "周会".into(), via: Some("Bea".into()) },
                NearbyHost { id: "aaaa000000000000ffff".into(), name: "林夕".into(), via: None },
            ]
        );
    }
}
