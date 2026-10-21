/* ============================================================
访客（docs/协同编辑.md §7.3、§8）。

按邀请链接里的公钥、地址、中继拨主持人 → 控制流上发 Hello（带邀请证明）→ 等主持人确认
→ Welcome 之后开文档流 → 叫前端发 Sync1，之后实时收发。

连不上（设计 §8.5）：3 秒还没连上就给结论（diagnose.rs：哪几条路、卡在哪、怎么办），不无限转圈。
但不算结束：后台每 8 秒再试一次（换了网络会自己连上），同时等着主持人按回连链接拨过来。
回连链接（§8.4）：访客能被连进来（公网 IPv6、端口映射、自己配的中继）时生成，发给主持人。
主持人拨过来的连接只认链接里主持人的公钥，之后和自己拨过去的一样：访客开控制流、发 Hello。
「附近」点进来的（nearby）：没有链接，Hello 里会话 id 全 0、不带证明，主持人照样确认。
附件（设计 §7.2）：正文里相对路径的图片向主持人要（Attachments::fetch），粘贴的文件交给主持人存
（Attachments::put）。一个请求一条双向流，按键的更新不会排在大图后面。

断线：QUIC 12 秒没动静认出来，状态变「重新连接中」，本地照常编辑；按链接里的地址
（和 mDNS、中继）退避重连，也等主持人往回拨。重连上了双方再互发一次 Sync1 / Sync2，
断线期间各自的改动就补齐了。主持人允许过的人重连不再问。
替别人转发（设计 §20.9）：连不上主持人的人拿我的转发链接连我，我替他把流接到主持人那边（文件末尾）。
============================================================ */

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use iroh::endpoint::{Connection, RecvStream, VarInt};
use iroh::{Endpoint, PublicKey, SecretKey, Watcher};
use iroh_mdns_address_lookup::{DiscoveryEvent, MdnsAddressLookup};
use n0_future::StreamExt;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::diagnose::{self, Diagnosis, Facts, RelayFact};
use super::endpoint::{self, Bound};
use super::protocol::{
    self, kind, AttachPut, Forward, ForwardStream, Hello, Member, Permission, Reject, RejectReason,
    Welcome,
};
use super::reach::{self, Mapper, Portmap, Reach, RelayState};
use super::relays::Relay;
use super::{
    clean_name, spawn_writer, Callback, Control, EndReason, Event, Events, Invite, MemberInfo,
    Status, SyncKind,
};

/// 拨一次最多等多久
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
/// 多久还没连上就给结论
pub const DIAGNOSE_AFTER: Duration = Duration::from_secs(3);
/// 还没进去、连不上时多久再试一次
const RETRY: Duration = Duration::from_secs(8);
/// 进去过以后断了：重连的间隔 1、2、4、8 秒，之后一直 8 秒
const BACKOFF_MAX: Duration = Duration::from_secs(8);
/// 中继还没回话、又过了这么久：当它连不上
const RELAY_LATE: Duration = Duration::from_secs(6);
/// 要一个附件最多等多久（50MB 经中继也够了）
const ATTACH_TIMEOUT: Duration = Duration::from_secs(90);
/// 替人转发时握手每一步最多等多久（主持人确认不算）
const FORWARD_HANDSHAKE: Duration = Duration::from_secs(10);

pub struct GuestOptions {
    pub secret_key: SecretKey,
    pub name: String,
    pub invite: Invite,
    pub mdns: bool,
    /// 用不用链接里主持人的中继（访客可以选「只直连，不经中继」，设计 §6.5）
    pub use_host_relay: bool,
    /// 自己配的中继：回连链接里带上，主持人经它拨过来
    pub relays: Vec<Relay>,
    /// 生成回连链接时问路由器要公网端口（单测里关掉）
    pub portmap: bool,
    /// 从「附近」点进来的：链接里没有会话 id 和邀请密钥
    pub nearby: bool,
}

pub struct Guest {
    shared: Arc<Shared>,
    endpoint: Endpoint,
    _mdns: Option<MdnsAddressLookup>,
    /// 端口映射：要回连链接的时候才开（平时访客不去碰路由器）
    mapper: Arc<tokio::sync::Mutex<Option<Mapper>>>,
    tasks: Vec<JoinHandle<()>>,
}

/// 生成回连链接的把手：不借用 Guest（命令层不必拿着会话的锁等那几秒）
pub struct Callbacks {
    shared: Arc<Shared>,
    endpoint: Endpoint,
    mapper: Arc<tokio::sync::Mutex<Option<Mapper>>>,
}

struct Shared {
    events: Events,
    invite: Invite,
    /// 协作中途能改（Guest::set_name）：重连时的 Hello 用改过的
    name: Mutex<String>,
    use_host_relay: bool,
    /// 这次端点上的中继：自己配的在前，主持人的（没选只直连的话）在后
    relays: Vec<Relay>,
    bound_at: Instant,
    link: Mutex<Option<Link>>,
    leaving: AtomicBool,
    /// mDNS 在同一个网络里看到了主持人
    seen_nearby: AtomicBool,
    nearby: bool,
    /// 我的网段：加入时就在后台读好（Windows 上读一次网卡要两秒多，等到 3 秒再读就晚了）
    networks: Mutex<Option<Vec<(std::net::IpAddr, u8)>>>,
    portmap: bool,
    /// 经我转发的人：成员号 → 他连我的那条连接（主持人发给他的数据报从这里转过去）
    forwarding: Mutex<std::collections::HashMap<u16, Connection>>,
}

/// 现在连着的那一条
struct Link {
    conn: Connection,
    doc: mpsc::UnboundedSender<(u8, Vec<u8>)>,
    control: mpsc::UnboundedSender<(u8, Vec<u8>)>,
    writers: Vec<JoinHandle<()>>,
}

enum Outcome {
    /// 结束了，不再重连
    Ended(EndReason),
    /// 断了（连上过）：重连
    Lost,
}

/// 生成的回连链接和这时自己能不能被连进来（界面上说「主持人能不能拨到你」）
pub struct CallbackLink {
    pub link: String,
    pub reach: Reach,
}

impl Guest {
    /// 加入：马上返回，进展从 events 里出来（Connecting → Waiting → Connected，
    /// 连不上是 Unreachable，被拒、被移出是 Ended）
    pub async fn join(options: GuestOptions, events: Events) -> Result<Guest, String> {
        let mut relays = options.relays;
        if options.use_host_relay {
            if let Some(relay) = &options.invite.relay {
                if !relays.iter().any(|mine| mine.url == relay.url) {
                    relays.push(relay.clone());
                }
            }
        }
        let Bound { endpoint, mdns, .. } =
            endpoint::bind(options.secret_key, None, options.mdns, &relays, &[]).await?;
        let host = PublicKey::from_bytes(&options.invite.host)
            .map_err(|_| "链接里的主持人公钥不对".to_string())?;
        let shared = Arc::new(Shared {
            events,
            invite: options.invite,
            name: Mutex::new(clean_name(&options.name)),
            use_host_relay: options.use_host_relay,
            relays,
            bound_at: Instant::now(),
            link: Mutex::new(None),
            leaving: AtomicBool::new(false),
            seen_nearby: AtomicBool::new(false),
            nearby: options.nearby,
            networks: Mutex::new(None),
            portmap: options.portmap,
            forwarding: Mutex::new(std::collections::HashMap::new()),
        });
        let (incoming_tx, incoming_rx) = mpsc::unbounded_channel();
        let mut tasks = vec![
            tokio::spawn(accept_host(
                endpoint.clone(),
                host,
                incoming_tx,
                shared.clone(),
            )),
            tokio::spawn(run(shared.clone(), endpoint.clone(), incoming_rx)),
            tokio::spawn(refresh_networks(shared.clone(), endpoint.clone())),
        ];
        if let Some(mdns) = &mdns {
            tasks.push(tokio::spawn(watch_nearby(
                mdns.clone(),
                host,
                shared.clone(),
            )));
        }
        Ok(Guest {
            shared,
            endpoint,
            _mdns: mdns,
            mapper: Arc::new(tokio::sync::Mutex::new(None)),
            tasks,
        })
    }

    /// 改了名字：连着的话告诉主持人（他换掉成员表里的、再广播）；断着的话重连时 Hello 里就是新的
    pub fn set_name(&self, name: &str) {
        if name.trim().is_empty() {
            return;
        }
        let name = clean_name(name);
        *self.shared.name.lock().unwrap() = name.clone();
        if let Some(link) = self.shared.link.lock().unwrap().as_ref() {
            let _ = link.control.send((kind::NAME, name.into_bytes()));
        }
    }

    pub fn send_update(&self, bytes: Vec<u8>) {
        // 断着的时候发不出去也没关系：前端的 文档 里都在，重连后同步补齐
        if let Some(link) = self.shared.link.lock().unwrap().as_ref() {
            let _ = link.doc.send((kind::UPDATE, bytes));
        }
    }

    pub fn send_cursor(&self, payload: &[u8]) {
        if let Some(link) = self.shared.link.lock().unwrap().as_ref() {
            let _ = link.conn.send_datagram(Bytes::copy_from_slice(payload));
        }
    }

    /// 只有主持人（成员 0）一个对象
    pub fn send_sync(&self, kind: SyncKind, bytes: Vec<u8>) {
        if let Some(link) = self.shared.link.lock().unwrap().as_ref() {
            let _ = link.doc.send((kind.frame(), bytes));
        }
    }

    /// 端点绑在哪些本机地址上（单测拿它拼本机回环的回连链接）
    #[cfg(test)]
    pub fn bound_sockets(&self) -> Vec<std::net::SocketAddr> {
        self.endpoint.bound_sockets()
    }

    /// 附件的把手：不借用 Guest（命令层不必拿着会话的锁等文件传完）
    pub fn attachments(&self) -> Attachments {
        Attachments {
            shared: self.shared.clone(),
        }
    }

    pub fn callbacks(&self) -> Callbacks {
        Callbacks {
            shared: self.shared.clone(),
            endpoint: self.endpoint.clone(),
            mapper: self.mapper.clone(),
        }
    }

    /// 离开：告诉主持人（Bye），断开，关端点
    pub async fn leave(self) {
        self.shared.leaving.store(true, Ordering::SeqCst);
        let link = self.shared.link.lock().unwrap().take();
        if let Some(link) = link {
            let _ = link.control.send((kind::BYE, Vec::new()));
            drop(link.doc);
            drop(link.control);
            let _ = tokio::time::timeout(Duration::from_millis(800), async {
                for writer in link.writers {
                    let _ = writer.await;
                }
            })
            .await;
            link.conn.close(VarInt::from_u32(0), b"bye");
        }
        for task in self.tasks {
            task.abort();
        }
        if let Some(mapper) = self.mapper.lock().await.take() {
            mapper.stop().await;
        }
        self.endpoint.close().await;
        let _ = self.shared.events.send(Event::Control(Control::Status {
            status: Status::Ended {
                reason: EndReason::Left,
            },
        }));
    }
}

/// 向主持人要附件、交粘贴的文件
#[derive(Clone)]
pub struct Attachments {
    shared: Arc<Shared>,
}

impl Attachments {
    /// 正文里写的相对路径 → 文件的字节
    pub async fn fetch(&self, path: &str) -> Result<Vec<u8>, String> {
        match self
            .request(kind::ATTACH_GET, path.as_bytes().to_vec())
            .await?
        {
            (kind::ATTACH_DATA, bytes) => Ok(bytes),
            (_, message) => Err(String::from_utf8_lossy(&message).into_owned()),
        }
    }

    /// 粘贴的文件交给主持人存进他仓库的「附件」，回从那篇引用它的路径
    pub async fn put(&self, name: &str, bytes: Vec<u8>) -> Result<String, String> {
        if bytes.len() > protocol::MAX_ATTACHMENT {
            return Err(format!(
                "文件太大了（{} MB），附件最多 {} MB",
                bytes.len() >> 20,
                protocol::MAX_ATTACHMENT >> 20
            ));
        }
        let payload = protocol::encode(&AttachPut {
            name: name.to_string(),
            bytes,
        });
        match self.request(kind::ATTACH_PUT, payload).await? {
            (kind::ATTACH_LINK, link) => Ok(String::from_utf8_lossy(&link).into_owned()),
            (_, message) => Err(String::from_utf8_lossy(&message).into_owned()),
        }
    }

    async fn request(&self, frame_kind: u8, payload: Vec<u8>) -> Result<(u8, Vec<u8>), String> {
        let conn = self
            .shared
            .link
            .lock()
            .unwrap()
            .as_ref()
            .map(|link| link.conn.clone())
            .ok_or_else(|| "现在没连着主持人".to_string())?;
        let exchange = async {
            let (mut send, mut recv) = conn.open_bi().await.map_err(|error| error.to_string())?;
            protocol::write_frame(&mut send, frame_kind, &payload)
                .await
                .map_err(|error| error.to_string())?;
            let _ = send.finish();
            match protocol::read_frame_up_to(&mut recv, protocol::MAX_ATTACH_FRAME).await {
                Ok(Some(frame)) => Ok(frame),
                Ok(None) => Err("主持人那边没回话".to_string()),
                Err(error) => Err(error.to_string()),
            }
        };
        tokio::time::timeout(ATTACH_TIMEOUT, exchange)
            .await
            .map_err(|_| "等太久了".to_string())?
    }
}

impl Callbacks {
    /// 转发链接（设计 §20.9）：一张指着我的邀请链接（会话 id、邀请密钥、默认权限照旧），
    /// 发给连不上主持人、却连得上我的人。和回连链接一样先看我能不能被连进来
    pub async fn forward_link(&self) -> CallbackLink {
        let reach = self.reach().await;
        let invite = &self.shared.invite;
        let link = Invite {
            host: *self.endpoint.id().as_bytes(),
            addrs: reach::endpoint_addrs(&self.endpoint),
            session: invite.session,
            secret: invite.secret,
            permission: invite.permission,
            relay: self.connected_relay(&reach),
        }
        .to_link();
        CallbackLink { link, reach }
    }

    /// 回连链接（设计 §8.4）：等端口映射、中继有个结果（最多 5 秒），把自己能被连进来的地址
    /// 打包发给主持人。之后主持人拨过来，这边照常握手
    pub async fn make(&self) -> CallbackLink {
        let reach = self.reach().await;
        let callback = Callback {
            guest: *self.endpoint.id().as_bytes(),
            addrs: reach::endpoint_addrs(&self.endpoint),
            session: self.shared.invite.session,
            relay: self.connected_relay(&reach),
        };
        CallbackLink {
            link: callback.to_link(),
            reach,
        }
    }

    /// 带上一台连上了的中继（自己配的在前）：对方经它连过来
    fn connected_relay(&self, reach: &Reach) -> Option<Relay> {
        reach
            .relays
            .iter()
            .find(|relay| matches!(relay.state, RelayState::Connected { .. }))
            .and_then(|connected| {
                self.shared
                    .relays
                    .iter()
                    .find(|relay| relay.url == connected.url)
                    .cloned()
            })
    }

    /// 我能不能被连进来：开端口映射，等它和中继有个结果（最多 5 秒），顺带查防火墙
    async fn reach(&self) -> Reach {
        let portmap = {
            let mut mapper = self.mapper.lock().await;
            if mapper.is_none() && self.shared.portmap {
                *mapper = Some(Mapper::start(&self.endpoint));
            }
            mapper.as_ref().map(Mapper::state)
        };
        let started = Instant::now();
        // 主持人拨过来是入站连接：这台的防火墙也得放行（真环境里才查，单测里不碰）
        let firewall = self
            .shared
            .portmap
            .then(|| tokio::task::spawn_blocking(super::firewall::check));
        let mut reach = loop {
            let current = portmap
                .as_ref()
                .map_or(Portmap::Unavailable, |state| state.borrow().clone());
            // 网卡地址加入时就在后台读好了（Shared::networks）
            let local: Option<Vec<std::net::IpAddr>> = self
                .shared
                .networks
                .lock()
                .unwrap()
                .as_ref()
                .map(|networks| networks.iter().map(|(ip, _)| *ip).collect());
            let reach = reach::snapshot(
                &self.endpoint,
                &current,
                &self.shared.relays,
                self.shared.bound_at,
                local.as_deref(),
            );
            if !reach.checking || started.elapsed() >= reach::CHECK_TIME {
                break reach;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        };
        if let Some(firewall) = firewall {
            reach.firewall = firewall.await.unwrap_or(super::firewall::Firewall::Unknown);
        }
        reach
    }
}

fn status(shared: &Shared, status: Status) {
    let _ = shared
        .events
        .send(Event::Control(Control::Status { status }));
}

/// 连到我这里的：主持人按回连链接拨过来的交给 run；别人是来找我转发的（我连着主持人时才转）
async fn accept_host(
    endpoint: Endpoint,
    host: PublicKey,
    incoming: mpsc::UnboundedSender<Connection>,
    shared: Arc<Shared>,
) {
    while let Some(attempt) = endpoint.accept().await {
        let Ok(conn) = attempt.await else { continue };
        if conn.remote_id() != host {
            if host_conn(&shared).is_some() {
                tokio::spawn(forward_for(shared.clone(), conn));
            } else {
                conn.close(VarInt::from_u32(5), b"not the host");
            }
            continue;
        }
        if incoming.send(conn).is_err() {
            return;
        }
    }
}

/// 同一个网络里有没有看到主持人（他广播着昵称和公钥）
async fn watch_nearby(mdns: MdnsAddressLookup, host: PublicKey, shared: Arc<Shared>) {
    let mut events = mdns.subscribe().await;
    while let Some(event) = events.next().await {
        if let DiscoveryEvent::Discovered { endpoint_info, .. } = event {
            if endpoint_info.endpoint_id == host {
                shared.seen_nearby.store(true, Ordering::SeqCst);
            }
        }
    }
}

/// 中继现在怎样（访客端点上看到的）
fn relay_fact(shared: &Shared, endpoint: &Endpoint) -> Option<RelayFact> {
    let relay = shared
        .invite
        .relay
        .as_ref()
        .filter(|_| shared.use_host_relay)?;
    let url = relay.relay_url().ok()?;
    let statuses = endpoint.home_relay_status().get();
    let late = shared.bound_at.elapsed() >= RELAY_LATE;
    Some(match statuses.iter().find(|status| status.url() == &url) {
        Some(status) if status.is_connected() => RelayFact::Connected,
        Some(status) if status.auth_denied_reason().is_some() => {
            RelayFact::Denied(status.auth_denied_reason().unwrap_or_default().to_string())
        }
        Some(status)
            if status.last_error().is_some_and(|error| {
                super::relays::upgrade_refused(&super::relays::error_text(error))
            }) =>
        {
            RelayFact::Outdated
        }
        Some(status) if status.last_error().is_some() && late => RelayFact::Failed(
            status
                .last_error()
                .map(|error| super::relays::error_text(error))
                .unwrap_or_default(),
        ),
        // 网络报告里量到了它（连上了只是还没轮到当 home relay）
        _ if late => match endpoint.net_report().get() {
            Some(report) if super::relays::latency_of(&report, &url).0.is_some() => {
                RelayFact::Connected
            }
            _ => RelayFact::Failed("连不上中继".into()),
        },
        _ => RelayFact::Connecting,
    })
}

/// 读一遍我的网段，存起来给下一次诊断用
async fn refresh_networks(shared: Arc<Shared>, endpoint: Endpoint) {
    let networks = diagnose::my_networks(&reach::endpoint_addrs(&endpoint)).await;
    *shared.networks.lock().unwrap() = Some(networks);
}

async fn diagnosis(shared: &Shared, endpoint: &Endpoint) -> Diagnosis {
    let known = shared.networks.lock().unwrap().clone();
    let networks = match known {
        Some(networks) => networks,
        // 还没读完：按端点知道的地址猜网段，不等
        None => diagnose::guess_networks(&reach::endpoint_addrs(endpoint)),
    };
    let facts = Facts {
        networks,
        seen_nearby: shared.seen_nearby.load(Ordering::SeqCst),
        relay: relay_fact(shared, endpoint),
    };
    diagnose::conclude(&shared.invite, &facts, shared.use_host_relay)
}

async fn run(
    shared: Arc<Shared>,
    endpoint: Endpoint,
    mut incoming: mpsc::UnboundedReceiver<Connection>,
) {
    let mut joined = false;
    let mut backoff = Duration::from_secs(1);
    // 已经给过「连不上」的结论：之后后台再试时不再闪「正在连接」
    let mut stuck: Option<Diagnosis> = None;
    let mut pending: Option<Connection> = None;
    loop {
        if stuck.is_none() {
            status(
                &shared,
                if joined {
                    Status::Reconnecting
                } else {
                    Status::Connecting
                },
            );
        }
        let conn = match pending.take() {
            Some(conn) => Ok(conn),
            None => {
                obtain(
                    &shared,
                    &endpoint,
                    &mut incoming,
                    !joined && stuck.is_none(),
                    &mut stuck,
                )
                .await
            }
        };
        if shared.leaving.load(Ordering::SeqCst) {
            return;
        }
        let result = match conn {
            Ok(conn) => {
                stuck = None;
                session(&shared, conn, &mut joined).await
            }
            Err(error) => Err(error),
        };
        if shared.leaving.load(Ordering::SeqCst) {
            return;
        }
        match result {
            Ok(Outcome::Ended(reason)) => {
                status(&shared, Status::Ended { reason });
                endpoint.close().await;
                return;
            }
            // 还没进去就被断开了（主持人那边出了事）：不重试，直说
            Ok(Outcome::Lost) if !joined => {
                status(
                    &shared,
                    Status::Ended {
                        reason: EndReason::Dropped,
                    },
                );
                endpoint.close().await;
                return;
            }
            Ok(Outcome::Lost) => {
                backoff = Duration::from_secs(1);
                status(&shared, Status::Reconnecting);
            }
            Err(_) if !joined => {
                // 还没进去：给结论（变了才报），过一会儿再试；主持人拨过来的话马上接
                let diagnosis = diagnosis(&shared, &endpoint).await;
                if stuck.as_ref() != Some(&diagnosis) {
                    status(
                        &shared,
                        Status::Unreachable {
                            diagnosis: diagnosis.clone(),
                        },
                    );
                    stuck = Some(diagnosis);
                }
                // 等下一次再试的工夫里重读网段：换了网络，下一次的结论按新的说
                tokio::spawn(refresh_networks(shared.clone(), endpoint.clone()));
                tokio::select! {
                    _ = tokio::time::sleep(RETRY) => {}
                    conn = incoming.recv() => pending = conn,
                }
                continue;
            }
            Err(_) => {}
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            conn = incoming.recv() => pending = conn,
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// 拿到一条到主持人的连接：自己拨过去，或者主持人按回连链接拨过来，谁先到用谁。
/// early = 第一次连：3 秒还没连上先给结论，接着等完这一次
async fn obtain(
    shared: &Arc<Shared>,
    endpoint: &Endpoint,
    incoming: &mut mpsc::UnboundedReceiver<Connection>,
    early: bool,
    stuck: &mut Option<Diagnosis>,
) -> Result<Connection, String> {
    let invite = &shared.invite;
    let relay = invite.relay.as_ref().filter(|_| shared.use_host_relay);
    let addr = endpoint::dial_addr(&invite.host, &invite.addrs, relay)?;
    let dial = tokio::time::timeout(DIAL_TIMEOUT, endpoint.connect(addr, protocol::ALPN));
    tokio::pin!(dial);
    let deadline = tokio::time::sleep(DIAGNOSE_AFTER);
    tokio::pin!(deadline);
    let mut reported = !early;
    loop {
        tokio::select! {
            result = &mut dial => {
                return match result {
                    Ok(Ok(conn)) => Ok(conn),
                    Ok(Err(error)) => Err(format!("连不上主持人：{error}")),
                    Err(_) => Err(format!("等了 {} 秒还连不上主持人", DIAL_TIMEOUT.as_secs())),
                };
            }
            Some(conn) = incoming.recv() => return Ok(conn),
            _ = &mut deadline, if !reported => {
                reported = true;
                let diagnosis = diagnosis(shared, endpoint).await;
                status(shared, Status::Unreachable { diagnosis: diagnosis.clone() });
                *stuck = Some(diagnosis);
            }
        }
    }
}

/// 一条连接：握手、收发，直到断开或者结束
async fn session(
    shared: &Arc<Shared>,
    conn: Connection,
    joined: &mut bool,
) -> Result<Outcome, String> {
    let invite = &shared.invite;
    let (mut control_send, mut control_recv) =
        conn.open_bi().await.map_err(|error| error.to_string())?;
    let mut keying = [0u8; 32];
    conn.export_keying_material(&mut keying, protocol::PROOF_LABEL, &invite.session)
        .map_err(|_| "导不出密钥材料".to_string())?;
    // 「附近」点进来的：不知道会话 id，也没有邀请密钥
    let hello = Hello {
        version: protocol::PROTOCOL_VERSION,
        features: protocol::FEATURES
            .iter()
            .map(|feature| feature.to_string())
            .collect(),
        session: if shared.nearby {
            [0; 16]
        } else {
            invite.session
        },
        proof: (!shared.nearby).then(|| protocol::proof(&invite.secret, &keying)),
        name: shared.name.lock().unwrap().clone(),
    };
    protocol::write_frame(&mut control_send, kind::HELLO, &protocol::encode(&hello))
        .await
        .map_err(|error| error.to_string())?;
    if !*joined {
        status(shared, Status::Waiting);
    }

    // 等主持人确认（不设时限：他可能正在想）
    let reply = tokio::select! {
        frame = protocol::read_frame(&mut control_recv) => frame,
        _ = conn.closed() => return Ok(Outcome::Lost),
    };
    let welcome = match reply {
        Ok(Some((kind::WELCOME, payload))) => {
            protocol::decode::<Welcome>(&payload).map_err(|error| error.to_string())?
        }
        Ok(Some((kind::REJECT, payload))) => {
            let reject = protocol::decode::<Reject>(&payload).map_err(|error| error.to_string())?;
            conn.close(VarInt::from_u32(0), b"rejected");
            return Ok(Outcome::Ended(match reject.reason {
                // 主持人回的是他的协议版本：比我的低是他旧；一样高还被拒是我缺了他要的特性，我旧
                RejectReason::Version { theirs } => EndReason::Outdated {
                    host_older: theirs < protocol::PROTOCOL_VERSION,
                },
                reason => EndReason::Rejected { reason },
            }));
        }
        _ => return Ok(Outcome::Lost),
    };
    *joined = true;
    let _ = shared.events.send(Event::Control(Control::Members {
        members: infos(&welcome.members),
    }));
    status(
        shared,
        Status::Connected {
            member: welcome.member,
            permission: welcome.permission,
            title: welcome.title.clone(),
        },
    );

    let (mut doc_send, doc_recv) = conn.open_bi().await.map_err(|error| error.to_string())?;
    protocol::write_frame(&mut doc_send, kind::OPEN, &[])
        .await
        .map_err(|error| error.to_string())?;
    let (doc, doc_writer) = spawn_writer(doc_send);
    let (control, control_writer) = spawn_writer(control_send);
    *shared.link.lock().unwrap() = Some(Link {
        conn: conn.clone(),
        doc,
        control,
        writers: vec![doc_writer, control_writer],
    });
    let _ = shared.events.send(Event::SyncStart { with: 0 });

    let readers = [
        tokio::spawn(read_doc(shared.clone(), doc_recv)),
        tokio::spawn(read_datagrams(shared.clone(), conn.clone())),
        tokio::spawn(watch_route(shared.clone(), conn.clone())),
    ];
    let outcome = tokio::select! {
        outcome = read_control(shared, &mut control_recv) => outcome,
        _ = conn.closed() => Outcome::Lost,
    };
    for reader in readers {
        reader.abort();
    }
    shared.link.lock().unwrap().take();
    conn.close(VarInt::from_u32(0), b"done");
    Ok(outcome)
}

/// 现在走的是直连还是中继：变了就报（先经中继、打洞成功后换成直连是常事）
async fn watch_route(shared: Arc<Shared>, conn: Connection) {
    let mut paths = conn.paths_stream();
    let mut last: Option<bool> = None;
    while let Some(list) = paths.next().await {
        let Some(selected) = list.iter().find(|path| path.is_selected()) else {
            continue;
        };
        let relayed = selected.is_relay();
        if last != Some(relayed) {
            last = Some(relayed);
            let _ = shared
                .events
                .send(Event::Control(Control::Route { relayed }));
        }
    }
}

async fn read_control(shared: &Shared, recv: &mut RecvStream) -> Outcome {
    loop {
        match protocol::read_frame(recv).await {
            Ok(Some((kind::MEMBERS, payload))) => {
                if let Ok(members) = protocol::decode::<Vec<Member>>(&payload) {
                    let _ = shared.events.send(Event::Control(Control::Members {
                        members: infos(&members),
                    }));
                }
            }
            Ok(Some((kind::PERMISSION, payload))) => {
                if let Ok(permission) = protocol::decode::<Permission>(&payload) {
                    let _ = shared
                        .events
                        .send(Event::Control(Control::Permission { permission }));
                }
            }
            Ok(Some((kind::KICK, _))) => return Outcome::Ended(EndReason::Kicked),
            Ok(Some((kind::BYE, _))) => return Outcome::Ended(EndReason::HostStopped),
            Ok(Some(_)) => {}
            // 流结束了 / 读错了：等连接真的断（或者主持人那边的 Bye 晚到）
            Ok(None) | Err(_) => {
                std::future::pending::<()>().await;
            }
        }
    }
}

async fn read_doc(shared: Arc<Shared>, mut recv: RecvStream) {
    while let Ok(Some((frame, payload))) = protocol::read_frame(&mut recv).await {
        match frame {
            kind::UPDATE | kind::SYNC2 => {
                let _ = shared.events.send(Event::Update {
                    from: 0,
                    bytes: payload,
                });
            }
            kind::SYNC1 => {
                let _ = shared.events.send(Event::SyncRequest {
                    from: 0,
                    vector: payload,
                });
            }
            // 主持人那边给我的积压丢掉了：重新发一次状态向量，他回一份补齐
            kind::RESYNC => {
                let _ = shared.events.send(Event::SyncStart { with: 0 });
            }
            _ => {}
        }
    }
}

async fn read_datagrams(shared: Arc<Shared>, conn: Connection) {
    while let Ok(datagram) = conn.read_datagram().await {
        // 主持人发给经我转发的那位的：拆掉外面那层，原样转给他
        if let Some((member, inner)) = protocol::unwrap_forwarded(&datagram) {
            let target = shared.forwarding.lock().unwrap().get(&member).cloned();
            if let Some(target) = target {
                let _ = target.send_datagram(Bytes::copy_from_slice(inner));
            }
            continue;
        }
        if let Some((member, payload)) = protocol::untag_cursor(&datagram) {
            let _ = shared.events.send(Event::Cursor {
                from: member,
                bytes: payload.to_vec(),
            });
        }
    }
}

fn infos(members: &[Member]) -> Vec<MemberInfo> {
    members
        .iter()
        .map(|member| MemberInfo {
            member: member.member,
            id: endpoint::id_text(&member.id),
            name: member.name.clone(),
            permission: member.permission,
            host: member.member == 0,
            via: member.via,
        })
        .collect()
}

/* ---------------- 替别人转发（设计 §20.9） ----------------
   连不上主持人、却连得上我的人（比如和我在同一个局域网，主持人只有我够得着的公网 IPv6）：
   他拿我的「转发链接」（就是一张邀请链接，公钥和地址换成我的，会话 id、邀请密钥照旧）连我。
   我核过他的证明，在自己到主持人的连接上替他开流（第一帧 Forward），之后原样搬字节；
   主持人照样问、照样管他的权限。我只是一根管子：他的改动我不碰，我的会话也不受影响 */

/// 我到主持人的那条连接（转发要用；断着就转不了）
fn host_conn(shared: &Shared) -> Option<Connection> {
    shared
        .link
        .lock()
        .unwrap()
        .as_ref()
        .map(|link| link.conn.clone())
}

/// 一位经我转发的人：从他连上我到离开
async fn forward_for(shared: Arc<Shared>, conn: Connection) {
    if let Err(error) = forward_session(&shared, &conn).await {
        eprintln!("协作：替人转发失败：{error}");
    }
    conn.close(VarInt::from_u32(0), b"done");
}

async fn forward_session(shared: &Arc<Shared>, conn: &Connection) -> Result<(), String> {
    let id = *conn.remote_id().as_bytes();
    let (mut control_send, mut control_recv) = tokio::time::timeout(FORWARD_HANDSHAKE, conn.accept_bi())
        .await
        .map_err(|_| "等 Hello 超时".to_string())?
        .map_err(|error| error.to_string())?;
    let hello = match tokio::time::timeout(FORWARD_HANDSHAKE, protocol::read_frame(&mut control_recv)).await {
        Ok(Ok(Some((kind::HELLO, payload)))) => {
            protocol::decode::<Hello>(&payload).map_err(|error| error.to_string())?
        }
        _ => return Err("对方没发 Hello".into()),
    };
    // 他的证明绑在他和我这条连接上，主持人核不了，我来核（我有邀请密钥的话；我自己是从「附近」进来的就没有）
    let invite = &shared.invite;
    let proven = match hello.proof {
        Some(proof) if !shared.nearby => {
            let mut keying = [0u8; 32];
            conn.export_keying_material(&mut keying, protocol::PROOF_LABEL, &invite.session)
                .map_err(|_| "导不出密钥材料".to_string())?;
            if !protocol::verify_proof(&invite.secret, &keying, &proof) {
                let _ = protocol::write_frame(
                    &mut control_send,
                    kind::REJECT,
                    &protocol::encode(&Reject {
                        reason: RejectReason::BadInvite,
                    }),
                )
                .await;
                let _ = control_send.finish();
                // 等他读到再断（不然他只看到连接断了，说不清为什么）
                let _ = tokio::time::timeout(Duration::from_secs(2), conn.closed()).await;
                return Ok(());
            }
            true
        }
        _ => false,
    };
    let host = host_conn(shared).ok_or_else(|| "我自己现在没连着主持人".to_string())?;
    let (mut host_send, mut host_recv) = host.open_bi().await.map_err(|error| error.to_string())?;
    let forward = Forward {
        id,
        stream: ForwardStream::Control,
        hello: Some(hello),
        proven,
    };
    protocol::write_frame(&mut host_send, kind::FORWARD, &protocol::encode(&forward))
        .await
        .map_err(|error| error.to_string())?;
    // 主持人回的第一帧（等他确认，不设时限）：Welcome 里认出他的成员号，原样交给他
    let first = tokio::select! {
        frame = protocol::read_frame(&mut host_recv) => frame.map_err(|error| error.to_string())?,
        _ = conn.closed() => return Ok(()),
        _ = host.closed() => return Err("主持人那边断了".into()),
    };
    let Some((frame_kind, payload)) = first else {
        return Err("主持人没回话".into());
    };
    protocol::write_frame(&mut control_send, frame_kind, &payload)
        .await
        .map_err(|error| error.to_string())?;
    if frame_kind != kind::WELCOME {
        let _ = control_send.finish();
        let _ = tokio::time::timeout(Duration::from_secs(2), conn.closed()).await;
        return Ok(());
    }
    let member = protocol::decode::<Welcome>(&payload)
        .map_err(|error| error.to_string())?
        .member;
    shared
        .forwarding
        .lock()
        .unwrap()
        .insert(member, conn.clone());

    let mut tasks = vec![
        tokio::spawn(pipe(control_recv, host_send)),
        tokio::spawn(pipe(host_recv, control_send)),
    ];
    // 他的文档流：他先发一个 OPEN 帧，主持人那边不要
    let doc = async {
        let (doc_send, mut doc_recv) = tokio::time::timeout(FORWARD_HANDSHAKE, conn.accept_bi())
            .await
            .map_err(|_| "等文档流超时".to_string())?
            .map_err(|error| error.to_string())?;
        let _ = protocol::read_frame(&mut doc_recv).await;
        let (mut up_send, up_recv) = host.open_bi().await.map_err(|error| error.to_string())?;
        let forward = Forward {
            id,
            stream: ForwardStream::Doc,
            hello: None,
            proven,
        };
        protocol::write_frame(&mut up_send, kind::FORWARD, &protocol::encode(&forward))
            .await
            .map_err(|error| error.to_string())?;
        Ok::<_, String>((doc_send, doc_recv, up_send, up_recv))
    };
    match doc.await {
        Ok((doc_send, doc_recv, up_send, up_recv)) => {
            tasks.push(tokio::spawn(pipe(doc_recv, up_send)));
            tasks.push(tokio::spawn(pipe(up_recv, doc_send)));
        }
        Err(error) => {
            shared.forwarding.lock().unwrap().remove(&member);
            for task in tasks {
                task.abort();
            }
            return Err(error);
        }
    }
    // 他后来开的附件流、发的光标
    tasks.push(tokio::spawn(forward_attachments(conn.clone(), host.clone(), id, proven)));
    tasks.push(tokio::spawn(forward_datagrams(conn.clone(), host.clone(), member)));
    tokio::select! {
        _ = conn.closed() => {}
        _ = host.closed() => {}
    }
    for task in tasks {
        task.abort();
    }
    let mut forwarding = shared.forwarding.lock().unwrap();
    if forwarding.get(&member).is_some_and(|current| current.stable_id() == conn.stable_id()) {
        forwarding.remove(&member);
    }
    Ok(())
}

/// 一条流原样搬到另一条：读到头了把那头也收尾
async fn pipe(mut from: RecvStream, mut to: iroh::endpoint::SendStream) {
    let _ = tokio::io::copy(&mut from, &mut to).await;
    let _ = to.finish();
}

/// 经我转发的人要附件：在我到主持人的连接上替他开一条（第一帧 Forward{Attach}），两头原样搬
async fn forward_attachments(conn: Connection, host: Connection, id: [u8; 32], proven: bool) {
    while let Ok((down_send, down_recv)) = conn.accept_bi().await {
        let host = host.clone();
        tokio::spawn(async move {
            let Ok((mut up_send, up_recv)) = host.open_bi().await else { return };
            let forward = Forward {
                id,
                stream: ForwardStream::Attach,
                hello: None,
                proven,
            };
            if protocol::write_frame(&mut up_send, kind::FORWARD, &protocol::encode(&forward))
                .await
                .is_err()
            {
                return;
            }
            let up = tokio::spawn(pipe(down_recv, up_send));
            pipe(up_recv, down_send).await;
            up.abort();
        });
    }
}

/// 他的光标：前面包上 FF FF 和他的成员号，转给主持人
async fn forward_datagrams(conn: Connection, host: Connection, member: u16) {
    while let Ok(datagram) = conn.read_datagram().await {
        let _ = host.send_datagram(Bytes::from(protocol::wrap_forwarded(member, &datagram)));
    }
}
