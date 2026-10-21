/* ============================================================
局域网「附近」（docs/协同编辑.md §8.3）。

主持人开着分享时用 mDNS 广播（endpoint.rs：自己的服务名，广播里只有昵称和公钥，不带文档标题）。
这里是看的那一边：「加入协作」对话框开着时起一个只听不广播的端点，订阅 mDNS 的发现事件，
同一个网络里正在分享的人一变就整张表报给前端（Control::Nearby）。点一下就按他的公钥和
mDNS 给的地址拨过去，Hello 里不带会话 id 和邀请证明（guest.rs 的 nearby），主持人照样确认。

没有网也能用（只要在同一个局域网里）。开了客户端隔离的 Wi-Fi 上设备互相看不见，列表就是空的。
============================================================ */

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use iroh::{Endpoint, SecretKey};
use iroh_mdns_address_lookup::{DiscoveryEvent, MdnsAddressLookup};
use n0_future::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;

use super::endpoint::{self, Bound};
use super::protocol::Permission;
use super::{Control, Event, Events, Invite};

/// 列表里的一位
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NearbyHost {
    /// 设备公钥（十六进制）：点哪一个就按它拨，也按它挑颜色
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone)]
struct Found {
    name: String,
    addrs: Vec<SocketAddr>,
}

pub struct Nearby {
    endpoint: Endpoint,
    _mdns: Option<MdnsAddressLookup>,
    found: Arc<Mutex<BTreeMap<String, Found>>>,
    task: JoinHandle<()>,
}

impl Nearby {
    /// 开始看。建端点要两三秒（Windows 上枚举网卡），列表从 events 里出来
    pub async fn start(events: Events) -> Result<Nearby, String> {
        let Bound { endpoint, mdns, .. } =
            endpoint::bind(SecretKey::generate(), None, true, &[], &[]).await?;
        let Some(lookup) = mdns.clone() else {
            return Err("这台电脑上的局域网发现起不来（没有支持组播的网卡）".into());
        };
        let found = Arc::new(Mutex::new(BTreeMap::new()));
        let _ = events.send(Event::Control(Control::Nearby { hosts: Vec::new() }));
        let task = tokio::spawn(watch(lookup, found.clone(), events));
        Ok(Nearby {
            endpoint,
            _mdns: mdns,
            found,
            task,
        })
    }

    /// 点了列表里的一位：拼一个不带会话 id 和邀请密钥的链接（加入时 GuestOptions.nearby = true）
    pub fn invite(&self, id: &str) -> Option<Invite> {
        let found = self.found.lock().unwrap().get(id).cloned()?;
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
        self.task.abort();
        self.endpoint.close().await;
    }
}

async fn watch(
    lookup: MdnsAddressLookup,
    found: Arc<Mutex<BTreeMap<String, Found>>>,
    events: Events,
) {
    let mut stream = lookup.subscribe().await;
    while let Some(event) = stream.next().await {
        let changed = {
            let mut found = found.lock().unwrap();
            match event {
                DiscoveryEvent::Discovered { endpoint_info, .. } => {
                    let id = endpoint::id_text(endpoint_info.endpoint_id.as_bytes());
                    // 只有主持人广播昵称：没有昵称的不是在分享的人
                    let Some(name) = endpoint_info
                        .user_data()
                        .map(|data| data.as_ref().to_string())
                    else {
                        continue;
                    };
                    let next = Found {
                        name: super::clean_name(&name),
                        addrs: endpoint_info.ip_addrs().copied().collect(),
                    };
                    let changed = found
                        .get(&id)
                        .is_none_or(|old| old.name != next.name || old.addrs != next.addrs);
                    found.insert(id, next);
                    changed
                }
                DiscoveryEvent::Expired { endpoint_id } => found
                    .remove(&endpoint::id_text(endpoint_id.as_bytes()))
                    .is_some(),
                _ => false,
            }
        };
        if changed {
            let hosts = hosts_of(&found.lock().unwrap());
            let _ = events.send(Event::Control(Control::Nearby { hosts }));
        }
    }
}

fn hosts_of(found: &BTreeMap<String, Found>) -> Vec<NearbyHost> {
    let mut hosts: Vec<NearbyHost> = found
        .iter()
        .map(|(id, found)| NearbyHost {
            id: id.clone(),
            name: found.name.clone(),
        })
        .collect();
    hosts.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    hosts
}

/// 单测：不靠组播，直接放一位进列表
#[cfg(test)]
impl Nearby {
    pub fn insert_for_test(&self, id: &iroh::PublicKey, name: &str, addrs: Vec<SocketAddr>) {
        self.found.lock().unwrap().insert(
            endpoint::id_text(id.as_bytes()),
            Found {
                name: name.to_string(),
                addrs,
            },
        );
    }
}
