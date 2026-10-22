/* ============================================================
团队仓库里成员之间自动连上（docs/协同编辑.md §22.2、§22.4）。照 collab/ 的规矩不依赖 tauri，
命令在 commands.rs 的「团队」一节。

- 端点：一个应用一个（团队的设备密钥 team-device-key，和会话式协作那把分开），几个团队仓库共用；
  有团队仓库的窗口开着就开着。ALPN `odea/team/1`，mDNS 服务名 `odea-team`（广播里只有公钥）
- 网状：名单（.odea/devices）里每一台都去拨，20 秒试一次没连上的，谁都能接。一对设备、一个团队一条连接；
  两边同时互拨出两条时留拨号一方公钥小的那条（P10.3 的 share/service.rs 拿回来的）
- 认人：两头都查对方的公钥在不在自己手里这份名单里（名单随 git 走，只有能推仓库的人加得进去）。
  不在的话先重读一遍名单（可能刚同步下来）
- 在哪：连上以后互发地址表（自己的、自己连着的人的）：A 连得上 B、B 连得上 C，A 下次能直接拨 C。
  记在应用数据目录的 team-places.json
- Presence：我开着哪几篇、主持着哪几篇，变了就发。谁当主持人由前端按 Presence 定（§22.4 的规矩），
  这里只认「这一篇我在主持」（host）：在主持的才接 Open，别的回 DocErr
- 每一篇是一棵树：访客开一条文档流连主持人（第一帧 Open{文档 id}），主持人把一位访客的更新、光标
  转给这一篇的其他访客。光标数据报里带着是谁的，转过去别人也认得出
- 经 B 转（设计 §22.4）：做客的那位也能接别人开来的这一篇（前端 host 了它），连不上主持人的 C 就经他。
  这台设备把上下游的改动、光标两头转：上游（主持人）来的转给下游，下游来的转给上游和别的下游；
  Sync2 也按更新转（重复收到没关系，CRDT 认得出）。不会转成环：不接自己上游开来的流，也不往自己的
  下游开流

CRDT 在前端，这里只搬字节。一个团队一个事件通道（登记它的那个窗口）：文档的字节、谁在线变了、
一篇的流断了（DocClosed：主持人不给、不主持了、断线；主持人这边是这位访客走了）
============================================================ */

mod wire;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use iroh::endpoint::{presets, Connection, IdleTimeout, QuicTransportConfig, RecvStream, SendStream, VarInt};
use iroh::{Endpoint, EndpointAddr, PublicKey, SecretKey, TransportAddr};
use iroh_mdns_address_lookup::MdnsAddressLookup;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Notify};
use tokio::task::JoinHandle;

use crate::collab::protocol as frames;
use crate::collab::{relays, Relay, SyncKind};
pub use wire::PresenceDoc;
use wire::{kind, Hello, Place, Places, Presence, Refusal};

/// 多久试着拨一次没连上的成员
const DIAL_EVERY: Duration = Duration::from_secs(20);
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
/// 连接断了以后多久重拨
const REDIAL_AFTER: Duration = Duration::from_secs(3);
/// 文档流的第一帧最多等多久
const OPEN_TIMEOUT: Duration = Duration::from_secs(10);
/// mDNS 的服务名：局域网里按公钥找到同一个团队的成员
const MDNS_SERVICE: &str = "odea-team";

/// 名单里的一台设备（vault/team.rs 读出来的那一行）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    pub key: [u8; 32],
    pub account: String,
    pub name: String,
}

impl Device {
    /// vault/team.rs 的一行：公钥不对的是 None
    pub fn from_row(row: &crate::vault::team::Device) -> Option<Device> {
        let key = data_encoding::HEXLOWER.decode(row.key.as_bytes()).ok()?.try_into().ok()?;
        Some(Device {
            key,
            account: row.account.clone(),
            name: row.name.clone(),
        })
    }
}

pub struct TeamOptions {
    pub key: SecretKey,
    /// 用户自己配的中继
    pub relays: Vec<Relay>,
    /// 局域网发现（测试里关掉）
    pub mdns: bool,
    /// 地址表落盘的位置（测试里不落）
    pub places_file: Option<PathBuf>,
}

/// 一个团队仓库（一个窗口）登记进来的
pub struct TeamSpec {
    /// 团队 id（仓库标记里的）
    pub id: String,
    pub name: String,
    pub account: String,
    pub devices: Vec<Device>,
    /// 设备名单在哪个仓库里：每轮拨号前重读（git 同步拉来了新成员）。测试里没有
    pub root: Option<PathBuf>,
}

/// 给界面看的一台设备
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamPeer {
    /// 这台设备在管道帧里的编号（会话的成员号，前端按它认人）
    pub member: u16,
    /// 设备公钥（十六进制）
    pub id: String,
    pub account: String,
    pub name: String,
    pub online: bool,
    /// 他开着的那几篇（在线才有）
    pub docs: Vec<PresenceDoc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TeamEvent {
    /// 别人的文档更新（Update 和 Sync2 都是它）
    Update { from: u16, doc: String, bytes: Vec<u8> },
    Cursor { from: u16, doc: String, bytes: Vec<u8> },
    /// 别人发来了状态向量：前端回他缺的
    SyncRequest { from: u16, doc: String, vector: Vec<u8> },
    /// 和这位接上了这一篇：前端把自己的状态向量发给他
    SyncStart { with: u16, doc: String },
    /// 谁在线、谁开着哪几篇变了：命令层取 peers() 交给前端
    Peers,
    /// 一篇的流断了。访客这边：主持人不给（refused 是他说的话）、不主持了、断线；
    /// 主持人这边：这位访客走了
    DocClosed { doc: String, member: u16, refused: Option<String> },
}

pub type Events = mpsc::UnboundedSender<TeamEvent>;

type Tx = mpsc::UnboundedSender<(u8, Vec<u8>)>;

struct Link {
    serial: u64,
    conn: Connection,
    tx: Tx,
    /// 谁拨的这条
    dialer: [u8; 32],
    hello: Hello,
    presence: Presence,
}

/// 主持人这边：一位访客开着的一篇
struct GuestStream {
    serial: u64,
    tx: Tx,
}

/// 访客这边：我连着主持人的一篇
struct Attached {
    host: [u8; 32],
    serial: u64,
    /// 流开好之前是 None（这期间发的丢掉：前端等 SyncStart 才开始发）
    tx: Option<Tx>,
    reader: Option<JoinHandle<()>>,
}

struct Team {
    name: String,
    account: String,
    root: Option<PathBuf>,
    devices: HashMap<[u8; 32], Device>,
    events: Events,
    presence: Presence,
    links: HashMap<[u8; 32], Link>,
    dialing: HashSet<[u8; 32]>,
    /// 公钥 → 管道帧里的编号。名单里的都有，进程里不变
    numbers: HashMap<[u8; 32], u16>,
    /// 我在主持的那几篇（接 Open）
    hosted: HashSet<String>,
    /// 主持人这边：文档 → 开着它的访客
    guests: HashMap<String, HashMap<[u8; 32], GuestStream>>,
    /// 访客这边：文档 → 我连着的主持人
    attached: HashMap<String, Attached>,
}

impl Team {
    fn number(&mut self, key: &[u8; 32]) -> u16 {
        let next = self.numbers.len() as u16 + 1;
        *self.numbers.entry(*key).or_insert(next)
    }

    fn key_of(&self, member: u16) -> Option<[u8; 32]> {
        self.numbers.iter().find(|(_, number)| **number == member).map(|(key, _)| *key)
    }

    fn set_devices(&mut self, devices: Vec<Device>) -> bool {
        let next: HashMap<[u8; 32], Device> = devices.into_iter().map(|device| (device.key, device)).collect();
        if next == self.devices {
            return false;
        }
        self.devices = next;
        let keys: Vec<[u8; 32]> = self.devices.keys().copied().collect();
        for key in keys {
            self.number(&key);
        }
        true
    }

    fn emit(&self, event: TeamEvent) {
        let _ = self.events.send(event);
    }

    /// 这一篇的更新发给两头：下游的访客、上游的主持人（我在做客的话）。except 是它从哪来的
    fn relay_update(&self, doc: &str, bytes: &[u8], except: Option<[u8; 32]>) {
        if let Some(guests) = self.guests.get(doc) {
            for (key, stream) in guests {
                if Some(*key) != except {
                    let _ = stream.tx.send((kind::UPDATE, bytes.to_vec()));
                }
            }
        }
        if let Some(attached) = self.attached.get(doc).filter(|attached| Some(attached.host) != except) {
            if let Some(tx) = &attached.tx {
                let _ = tx.send((kind::UPDATE, bytes.to_vec()));
            }
        }
    }

    /// 光标数据报：同上，两头都发
    fn relay_cursor(&self, doc: &str, datagram: &Bytes, except: Option<[u8; 32]>) {
        let mut to: Vec<[u8; 32]> = self
            .guests
            .get(doc)
            .map(|guests| guests.keys().copied().collect())
            .unwrap_or_default();
        to.extend(self.attached.get(doc).map(|attached| attached.host));
        for key in to.into_iter().filter(|key| Some(*key) != except) {
            if let Some(link) = self.links.get(&key) {
                let _ = link.conn.send_datagram(datagram.clone());
            }
        }
    }
}

/// team-places.json 里的一项
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredPlace {
    addrs: Vec<SocketAddr>,
    relay: Option<Relay>,
}

struct Inner {
    me: [u8; 32],
    endpoint: Endpoint,
    /// 用着的中继（起端点时的，加上后来加的：团队的中继、自己新配的）
    relays: Mutex<Vec<Relay>>,
    /// 自签名证书中继的指纹（后来加的中继也往里放）
    pins: relays::Pins,
    _mdns: Option<MdnsAddressLookup>,
    teams: Mutex<HashMap<String, Team>>,
    places: Mutex<HashMap<[u8; 32], Place>>,
    places_file: Option<PathBuf>,
    redial: Notify,
    stopped: AtomicBool,
    serial: AtomicU64,
}

pub struct TeamNet {
    inner: Arc<Inner>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

fn hex(key: &[u8; 32]) -> String {
    data_encoding::HEXLOWER.encode(key)
}

async fn bind(
    key: SecretKey,
    relays: &[Relay],
    pins: relays::Pins,
    mdns: bool,
) -> Result<(Endpoint, Option<MdnsAddressLookup>), String> {
    // 和会话式一样 5 秒保活、12 秒认出断了（接手要快）。空闲时的流量大头是 iroh 自己的多路径探测，
    // 保活拉长到 15 秒几乎不变（docs/协同编辑.md §23.5）
    let idle = IdleTimeout::try_from(Duration::from_secs(12)).map_err(|error| error.to_string())?;
    let transport = QuicTransportConfig::builder()
        .keep_alive_interval(Duration::from_secs(5))
        .max_idle_timeout(Some(idle))
        .build();
    let endpoint = Endpoint::builder(presets::Minimal)
        .secret_key(key)
        .alpns(vec![wire::ALPN.to_vec()])
        // 一台都没配时也用「自己的中继表」（空的）：后来加的中继（insert_relay）才接得上；默认一台都不连
        .relay_mode(match relays::relay_mode(relays) {
            iroh::RelayMode::Disabled => iroh::RelayMode::Custom(iroh::RelayMap::empty()),
            mode => mode,
        })
        .ca_tls_config(relays::tls_config(pins))
        .transport_config(transport)
        .bind()
        .await
        .map_err(|error| format!("打不开网络端口：{error}"))?;
    let mdns = if mdns {
        match MdnsAddressLookup::builder()
            .service_name(MDNS_SERVICE)
            .advertise(true)
            .build(endpoint.id())
        {
            Ok(lookup) => {
                if let Ok(services) = endpoint.address_lookup() {
                    services.add(lookup.clone());
                }
                Some(lookup)
            }
            Err(error) => {
                eprintln!("团队：mDNS 起不来：{error}");
                None
            }
        }
    } else {
        None
    };
    Ok((endpoint, mdns))
}

fn load_places(file: Option<&PathBuf>) -> HashMap<[u8; 32], Place> {
    let Some(text) = file.and_then(|file| std::fs::read_to_string(file).ok()) else {
        return HashMap::new();
    };
    let stored: HashMap<String, StoredPlace> = serde_json::from_str(&text).unwrap_or_default();
    stored
        .into_iter()
        .filter_map(|(key, place)| {
            let key: [u8; 32] = data_encoding::HEXLOWER.decode(key.as_bytes()).ok()?.try_into().ok()?;
            Some((
                key,
                Place {
                    key,
                    addrs: place.addrs,
                    relay: place.relay,
                },
            ))
        })
        .collect()
}

impl TeamNet {
    pub async fn start(options: TeamOptions) -> Result<TeamNet, String> {
        let me = *options.key.public().as_bytes();
        let pins = relays::pins(&options.relays);
        let (endpoint, mdns) = bind(options.key, &options.relays, pins.clone(), options.mdns).await?;
        let inner = Arc::new(Inner {
            me,
            endpoint,
            relays: Mutex::new(options.relays),
            pins,
            _mdns: mdns,
            teams: Mutex::new(HashMap::new()),
            places: Mutex::new(load_places(options.places_file.as_ref())),
            places_file: options.places_file,
            redial: Notify::new(),
            stopped: AtomicBool::new(false),
            serial: AtomicU64::new(1),
        });
        let tasks = vec![
            tokio::spawn(inner.clone().accept_loop()),
            tokio::spawn(inner.clone().dial_loop()),
        ];
        Ok(TeamNet {
            inner,
            tasks: Mutex::new(tasks),
        })
    }

    /// 加一台中继（团队的中继选了「用」、自己新配了一台）：当场接上，拨号时也带着它
    pub async fn add_relay(&self, relay: Relay) {
        if self.inner.relays.lock().unwrap().iter().any(|known| known.url == relay.url) {
            return;
        }
        relays::add_pin(&self.inner.pins, &relay);
        if let (Ok(url), Some(config)) = (relay.relay_url(), relay.config()) {
            self.inner.endpoint.insert_relay(url, Arc::new(config)).await;
        }
        self.inner.relays.lock().unwrap().push(relay);
        self.inner.redial.notify_one();
    }

    /// 这台设备的公钥（十六进制）
    pub fn me(&self) -> String {
        hex(&self.inner.me)
    }

    /// 登记一个团队仓库（一个窗口打开了它）。同一个团队再登记一次（窗口重新载入）：之前的连接都断开重连，
    /// 前端那边的会话都没了
    pub fn join(&self, spec: TeamSpec, events: Events) {
        let mut team = Team {
            name: crate::collab::clean_name(&spec.name),
            account: spec.account,
            root: spec.root,
            devices: HashMap::new(),
            events,
            presence: Presence::default(),
            links: HashMap::new(),
            dialing: HashSet::new(),
            numbers: HashMap::new(),
            hosted: HashSet::new(),
            guests: HashMap::new(),
            attached: HashMap::new(),
        };
        team.set_devices(spec.devices);
        let old = self.inner.teams.lock().unwrap().insert(spec.id, team);
        if let Some(old) = old {
            for link in old.links.values() {
                link.conn.close(VarInt::from_u32(0), b"reload");
            }
        }
        self.inner.redial.notify_one();
    }

    /// 窗口关了、换了仓库
    pub fn leave(&self, team: &str) {
        let old = self.inner.teams.lock().unwrap().remove(team);
        if let Some(old) = old {
            for link in old.links.values() {
                link.conn.close(VarInt::from_u32(0), b"bye");
            }
        }
    }

    /// 还有没有登记着的团队（都走了就关端点）
    pub fn is_idle(&self) -> bool {
        self.inner.teams.lock().unwrap().is_empty()
    }

    /// 我开着哪几篇、主持着哪几篇：发给连着的每一位
    pub fn set_presence(&self, team: &str, docs: Vec<PresenceDoc>) {
        let mut teams = self.inner.teams.lock().unwrap();
        let Some(team) = teams.get_mut(team) else { return };
        let presence = Presence { docs };
        if team.presence == presence {
            return;
        }
        let bytes = frames::encode(&presence);
        team.presence = presence;
        for link in team.links.values() {
            let _ = link.tx.send((kind::PRESENCE, bytes.clone()));
        }
    }

    /// 我改名字了：之后连上的人看到新的（已经连着的下次重连时）
    pub fn set_name(&self, team: &str, name: &str) {
        if let Some(team) = self.inner.teams.lock().unwrap().get_mut(team) {
            team.name = crate::collab::clean_name(name);
        }
    }

    /// 名单里的其他设备：在不在线、开着哪几篇
    pub fn peers(&self, team: &str) -> Vec<TeamPeer> {
        let teams = self.inner.teams.lock().unwrap();
        let Some(team) = teams.get(team) else { return Vec::new() };
        let mut peers: Vec<TeamPeer> = team
            .devices
            .values()
            .filter(|device| device.key != self.inner.me)
            .map(|device| {
                let link = team.links.get(&device.key);
                TeamPeer {
                    member: team.numbers.get(&device.key).copied().unwrap_or(0),
                    id: hex(&device.key),
                    account: link.map_or_else(|| device.account.clone(), |link| link.hello.account.clone()),
                    name: link.map_or_else(|| device.name.clone(), |link| link.hello.name.clone()),
                    online: link.is_some(),
                    docs: link.map(|link| link.presence.docs.clone()).unwrap_or_default(),
                }
            })
            .collect();
        peers.sort_by_key(|peer| peer.member);
        peers
    }

    /// 我的编号（光标、会话里认自己）
    pub fn my_member(&self, team: &str) -> u16 {
        let mut teams = self.inner.teams.lock().unwrap();
        teams.get_mut(team).map_or(0, |team| team.number(&self.inner.me))
    }

    /// 开始 / 不再主持一篇。不再主持时，开着它的访客的流都收尾（他们那边是 DocClosed）
    pub fn host(&self, team: &str, doc: &str, on: bool) {
        let mut teams = self.inner.teams.lock().unwrap();
        let Some(team) = teams.get_mut(team) else { return };
        if on {
            team.hosted.insert(doc.to_string());
        } else {
            team.hosted.remove(doc);
            // 丢掉写手的发送端：流收尾，访客读到结束
            team.guests.remove(doc);
        }
    }

    /// 开一篇：连这一篇的主持人（编号 member）。连上以后是 SyncStart，不给、断了是 DocClosed
    pub fn open(&self, team_id: &str, doc: &str, member: u16) -> Result<(), String> {
        if doc.is_empty() || doc.len() > frames::MAX_DOC_ID {
            return Err("这一篇的 id 太长".into());
        }
        let serial = self.inner.serial.fetch_add(1, Ordering::SeqCst);
        let (conn, host) = {
            let mut teams = self.inner.teams.lock().unwrap();
            let team = teams.get_mut(team_id).ok_or("这个团队仓库没开着")?;
            let host = team.key_of(member).ok_or("不认识这台设备")?;
            let conn = team.links.get(&host).map(|link| link.conn.clone()).ok_or("他不在线")?;
            // 他正连着我看这一篇（我是他的上游）：再连过去就成了环
            if team.guests.get(doc).is_some_and(|guests| guests.contains_key(&host)) {
                return Err("他这一篇是连着我的".into());
            }
            if let Some(old) = team.attached.insert(
                doc.to_string(),
                Attached {
                    host,
                    serial,
                    tx: None,
                    reader: None,
                },
            ) {
                if let Some(reader) = old.reader {
                    reader.abort();
                }
            }
            (conn, host)
        };
        let task = tokio::spawn(self.inner.clone().attach(team_id.to_string(), doc.to_string(), conn, host, member, serial));
        let mut teams = self.inner.teams.lock().unwrap();
        match teams
            .get_mut(team_id)
            .and_then(|team| team.attached.get_mut(doc))
            .filter(|attached| attached.serial == serial)
        {
            Some(attached) => attached.reader = Some(task),
            // 已经关掉、换掉了
            None => task.abort(),
        }
        Ok(())
    }

    /// 不再连着主持人看这一篇（关掉了、换成自己主持）
    pub fn close(&self, team: &str, doc: &str) {
        let old = self
            .inner
            .teams
            .lock()
            .unwrap()
            .get_mut(team)
            .and_then(|team| team.attached.remove(doc));
        if let Some(reader) = old.and_then(|old| old.reader) {
            reader.abort();
        }
    }

    /// 前端的一个更新：主持着的发给这一篇的每位访客，做客的发给主持人
    pub fn send_update(&self, team: &str, doc: &str, bytes: Vec<u8>) {
        let teams = self.inner.teams.lock().unwrap();
        if let Some(team) = teams.get(team) {
            team.relay_update(doc, &bytes, None);
        }
    }

    /// 前端回给某一位的同步消息
    pub fn send_sync(&self, team: &str, member: u16, doc: &str, sync: SyncKind, bytes: Vec<u8>) {
        let frame = match sync {
            SyncKind::Vector => kind::SYNC1,
            SyncKind::Reply => kind::SYNC2,
        };
        let teams = self.inner.teams.lock().unwrap();
        let Some(team) = teams.get(team) else { return };
        let Some(key) = team.key_of(member) else { return };
        if let Some(guest) = team.guests.get(doc).and_then(|guests| guests.get(&key)) {
            let _ = guest.tx.send((frame, bytes));
        } else if let Some(attached) = team.attached.get(doc).filter(|attached| attached.host == key) {
            if let Some(tx) = &attached.tx {
                let _ = tx.send((frame, bytes));
            }
        }
    }

    pub fn send_cursor(&self, team: &str, doc: &str, payload: &[u8]) {
        let Some(datagram) = wire::tag_cursor(doc, &self.inner.me, payload) else { return };
        let datagram = Bytes::from(datagram);
        let teams = self.inner.teams.lock().unwrap();
        if let Some(team) = teams.get(team) {
            team.relay_cursor(doc, &datagram, None);
        }
    }

    /// 关掉：断开、停后台任务
    pub async fn stop(&self) {
        self.inner.stopped.store(true, Ordering::SeqCst);
        for task in self.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
        let teams: Vec<Team> = self.inner.teams.lock().unwrap().drain().map(|(_, team)| team).collect();
        for team in &teams {
            for link in team.links.values() {
                link.conn.close(VarInt::from_u32(0), b"bye");
            }
        }
        self.inner.endpoint.close().await;
    }

    /* ---------------- 测试用 ---------------- */

    #[cfg(test)]
    pub fn addr(&self) -> EndpointAddr {
        EndpointAddr {
            id: self.inner.endpoint.id(),
            addrs: self
                .inner
                .endpoint
                .bound_sockets()
                .into_iter()
                .filter(SocketAddr::is_ipv4)
                .map(|addr| {
                    let ip = if addr.ip().is_unspecified() {
                        std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
                    } else {
                        addr.ip()
                    };
                    TransportAddr::Ip(SocketAddr::new(ip, addr.port()))
                })
                .collect(),
        }
    }

    /// 测试用：告诉它某台设备在哪（不靠 mDNS）
    #[cfg(test)]
    pub fn learn(&self, addr: &EndpointAddr) {
        let key = *addr.id.as_bytes();
        let addrs = addr
            .addrs
            .iter()
            .filter_map(|addr| match addr {
                TransportAddr::Ip(ip) => Some(*ip),
                _ => None,
            })
            .collect();
        self.inner.places.lock().unwrap().insert(key, Place { key, addrs, relay: None });
        self.inner.redial.notify_one();
    }

    #[cfg(test)]
    pub fn key(&self) -> [u8; 32] {
        self.inner.me
    }

    /// 测试用：这个团队的连接一共发出去多少字节（UDP 层，含保活、重传）
    #[cfg(test)]
    pub fn sent_bytes(&self, team: &str) -> u64 {
        self.inner
            .teams
            .lock()
            .unwrap()
            .get(team)
            .map_or(0, |team| team.links.values().map(|link| link.conn.stats().udp_tx.bytes).sum())
    }

    #[cfg(test)]
    pub fn online(&self, team: &str) -> usize {
        self.inner.teams.lock().unwrap().get(team).map_or(0, |team| team.links.len())
    }

    #[cfg(test)]
    pub fn set_devices(&self, team: &str, devices: Vec<Device>) {
        if let Some(team) = self.inner.teams.lock().unwrap().get_mut(team) {
            team.set_devices(devices);
        }
        self.inner.redial.notify_one();
    }
}

impl Inner {
    fn emit(&self, team: &str, event: TeamEvent) {
        if let Some(team) = self.teams.lock().unwrap().get(team) {
            team.emit(event);
        }
    }

    fn where_am_i(&self) -> Place {
        // 我连着的那台中继（home relay）；还没连上就报第一台
        let home = self.endpoint.addr().addrs.iter().find_map(|addr| match addr {
            TransportAddr::Relay(url) => Some(url.to_string()),
            _ => None,
        });
        let relays = self.relays.lock().unwrap();
        let relay = home
            .and_then(|home| relays.iter().find(|relay| relay.relay_url().is_ok_and(|url| url.to_string() == home)))
            .or_else(|| relays.first())
            .cloned();
        Place {
            key: self.me,
            addrs: crate::collab::reach::endpoint_addrs(&self.endpoint),
            relay,
        }
    }

    /* ---------------- 拨号 ---------------- */

    async fn dial_loop(self: Arc<Self>) {
        loop {
            if self.stopped.load(Ordering::SeqCst) {
                return;
            }
            self.clone().dial_missing().await;
            tokio::select! {
                _ = tokio::time::sleep(DIAL_EVERY) => {}
                _ = self.redial.notified() => {}
            }
        }
    }

    async fn dial_missing(self: Arc<Self>) {
        // 名单在仓库里：重读一遍（git 同步拉来了新成员、有人被移出了）
        let roots: Vec<(String, PathBuf)> = self
            .teams
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(id, team)| team.root.clone().map(|root| (id.clone(), root)))
            .collect();
        let read = tokio::task::spawn_blocking(move || {
            roots
                .into_iter()
                .map(|(id, root)| {
                    let devices: Vec<Device> = crate::vault::team::read(&root).iter().filter_map(Device::from_row).collect();
                    (id, devices)
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        let mut targets = Vec::new();
        {
            let mut teams = self.teams.lock().unwrap();
            for (id, devices) in read {
                if let Some(team) = teams.get_mut(&id) {
                    if team.set_devices(devices) {
                        // 不在名单里了的断开
                        let gone: Vec<[u8; 32]> = team.links.keys().filter(|key| !team.devices.contains_key(*key)).copied().collect();
                        for key in gone {
                            if let Some(link) = team.links.get(&key) {
                                link.conn.close(VarInt::from_u32(2), b"removed");
                            }
                        }
                        team.emit(TeamEvent::Peers);
                    }
                }
            }
            for (id, team) in teams.iter_mut() {
                let keys: Vec<[u8; 32]> = team.devices.keys().copied().collect();
                for key in keys {
                    if key == self.me || team.links.contains_key(&key) || !team.dialing.insert(key) {
                        continue;
                    }
                    targets.push((id.clone(), key));
                }
            }
        }
        for (team, key) in targets {
            let me = self.clone();
            tokio::spawn(async move {
                // 不在线的成员每 20 秒拨一次，连不上不算错，不打日志
                let _ = me.clone().dial(&team, key).await;
                if let Some(team) = me.teams.lock().unwrap().get_mut(&team) {
                    team.dialing.remove(&key);
                }
            });
        }
    }

    fn hello(&self, team: &str) -> Option<Hello> {
        let teams = self.teams.lock().unwrap();
        let state = teams.get(team)?;
        Some(Hello {
            version: wire::VERSION,
            team: team.to_string(),
            account: state.account.clone(),
            name: state.name.clone(),
        })
    }

    async fn dial(self: Arc<Self>, team: &str, device: [u8; 32]) -> Result<(), String> {
        let place = self.places.lock().unwrap().get(&device).cloned();
        // 他上次在哪：直连地址、他连着的中继；再加上我这边的每一台中继（他可能连着其中一台）。
        // 都不知道的话靠 mDNS 按公钥找
        let (addrs, mut relays) = match place {
            Some(place) => (place.addrs, place.relay.into_iter().collect::<Vec<_>>()),
            None => (Vec::new(), Vec::new()),
        };
        for relay in self.relays.lock().unwrap().iter() {
            if !relays.iter().any(|known| known.url == relay.url) {
                relays.push(relay.clone());
            }
        }
        let id = PublicKey::from_bytes(&device).map_err(|_| "公钥不对")?;
        let addr = EndpointAddr {
            id,
            addrs: addrs
                .into_iter()
                .map(TransportAddr::Ip)
                .chain(
                    relays
                        .iter()
                        .filter_map(|relay| relay.relay_url().ok())
                        .map(TransportAddr::Relay),
                )
                .collect(),
        };
        let conn = tokio::time::timeout(DIAL_TIMEOUT, self.endpoint.connect(addr, wire::ALPN))
            .await
            .map_err(|_| "连不上".to_string())?
            .map_err(|error| error.to_string())?;
        let (mut send, mut recv) = conn.open_bi().await.map_err(|error| error.to_string())?;
        let hello = self.hello(team).ok_or("团队仓库关了")?;
        frames::write_frame(&mut send, kind::HELLO, &frames::encode(&hello))
            .await
            .map_err(|error| error.to_string())?;
        let reply = tokio::time::timeout(DIAL_TIMEOUT, frames::read_frame(&mut recv))
            .await
            .map_err(|_| "等不到握手".to_string())?;
        match reply {
            Ok(Some((kind::HELLO, payload))) => {
                let theirs: Hello = frames::decode(&payload).map_err(|error| error.to_string())?;
                if theirs.team != team || theirs.version != wire::VERSION {
                    conn.close(VarInt::from_u32(1), b"wrong team");
                    return Err("对方不是这个团队".into());
                }
                let me = self.me;
                self.run_link(team.to_string(), conn, send, recv, device, me, theirs).await;
                Ok(())
            }
            Ok(Some((kind::REJECT, payload))) => {
                let reason: Refusal = frames::decode(&payload).map_err(|error| error.to_string())?;
                conn.close(VarInt::from_u32(0), b"rejected");
                Err(format!("被拒绝了：{reason:?}"))
            }
            _ => Err("对方断开了".into()),
        }
    }

    /* ---------------- 接 ---------------- */

    async fn accept_loop(self: Arc<Self>) {
        while let Some(incoming) = self.endpoint.accept().await {
            let me = self.clone();
            tokio::spawn(async move {
                let Ok(conn) = incoming.await else { return };
                if let Err(error) = me.accept(conn).await {
                    eprintln!("团队：进来的连接：{error}");
                }
            });
        }
    }

    async fn accept(self: Arc<Self>, conn: Connection) -> Result<(), String> {
        let device = *conn.remote_id().as_bytes();
        let (mut send, mut recv) = tokio::time::timeout(DIAL_TIMEOUT, conn.accept_bi())
            .await
            .map_err(|_| "等不到握手".to_string())?
            .map_err(|error| error.to_string())?;
        let hello: Hello = match tokio::time::timeout(DIAL_TIMEOUT, frames::read_frame(&mut recv)).await {
            Ok(Ok(Some((kind::HELLO, payload)))) => frames::decode(&payload).map_err(|error| error.to_string())?,
            _ => return Err("握手不对".into()),
        };
        if hello.version != wire::VERSION {
            refuse(send, &conn, Refusal::Version { theirs: wire::VERSION }).await;
            return Err("版本对不上".into());
        }
        let known = self
            .teams
            .lock()
            .unwrap()
            .get(&hello.team)
            .map(|team| (team.devices.contains_key(&device), team.root.clone()));
        let Some((mut member, root)) = known else {
            refuse(send, &conn, Refusal::UnknownTeam).await;
            return Err("没开着这个团队仓库".into());
        };
        if !member {
            // 可能是刚同步下来的新成员：重读一遍名单
            if let Some(root) = root {
                let devices = tokio::task::spawn_blocking(move || {
                    crate::vault::team::read(&root).iter().filter_map(Device::from_row).collect::<Vec<_>>()
                })
                .await
                .unwrap_or_default();
                let mut teams = self.teams.lock().unwrap();
                if let Some(team) = teams.get_mut(&hello.team) {
                    if team.set_devices(devices) {
                        team.emit(TeamEvent::Peers);
                    }
                    member = team.devices.contains_key(&device);
                }
            }
        }
        if !member {
            refuse(send, &conn, Refusal::NotMember).await;
            return Err(format!("{} 不在名单里", &hex(&device)[..8]));
        }
        let mine = self.hello(&hello.team).ok_or("团队仓库关了")?;
        frames::write_frame(&mut send, kind::HELLO, &frames::encode(&mine))
            .await
            .map_err(|error| error.to_string())?;
        let team = hello.team.clone();
        self.run_link(team, conn, send, recv, device, device, hello).await;
        Ok(())
    }

    /* ---------------- 一条连接 ---------------- */

    #[allow(clippy::too_many_arguments)]
    async fn run_link(
        self: Arc<Self>,
        team_id: String,
        conn: Connection,
        send: SendStream,
        mut recv: RecvStream,
        device: [u8; 32],
        dialer: [u8; 32],
        theirs: Hello,
    ) {
        let (tx, _writer) = crate::collab::spawn_writer(send);
        let serial = self.serial.fetch_add(1, Ordering::SeqCst);
        let presence = {
            let mut teams = self.teams.lock().unwrap();
            let Some(team) = teams.get_mut(&team_id) else {
                conn.close(VarInt::from_u32(0), b"bye");
                return;
            };
            if let Some(existing) = team.links.get(&device) {
                // 两边同时互拨：留拨号一方公钥小的那条（两边挑的一样）。同一边拨的（断了重连）留新的
                let preferred = self.me.min(device);
                let keep_new = existing.dialer == dialer || dialer == preferred;
                if !keep_new {
                    conn.close(VarInt::from_u32(3), b"duplicate");
                    return;
                }
                existing.conn.close(VarInt::from_u32(3), b"duplicate");
            }
            team.number(&device);
            team.links.insert(
                device,
                Link {
                    serial,
                    conn: conn.clone(),
                    tx: tx.clone(),
                    dialer,
                    hello: Hello {
                        name: crate::collab::clean_name(&theirs.name),
                        ..theirs
                    },
                    presence: Presence::default(),
                },
            );
            team.emit(TeamEvent::Peers);
            team.presence.clone()
        };
        let _ = tx.send((kind::PRESENCE, frames::encode(&presence)));
        let _ = tx.send((kind::PLACES, frames::encode(&self.places_for(&team_id, device))));
        let docs = tokio::spawn(self.clone().accept_docs(team_id.clone(), conn.clone(), device));
        let cursors = tokio::spawn(self.clone().read_cursors(team_id.clone(), conn.clone(), device));
        loop {
            let frame = tokio::select! {
                frame = frames::read_frame(&mut recv) => frame,
                _ = conn.closed() => break,
            };
            let Ok(Some((frame_kind, payload))) = frame else { break };
            match frame_kind {
                kind::PRESENCE => {
                    if let Ok(presence) = frames::decode::<Presence>(&payload) {
                        let mut teams = self.teams.lock().unwrap();
                        if let Some(team) = teams.get_mut(&team_id) {
                            if let Some(link) = team.links.get_mut(&device).filter(|link| link.serial == serial) {
                                link.presence = presence;
                                team.emit(TeamEvent::Peers);
                            }
                        }
                    }
                }
                kind::PLACES => {
                    if let Ok(places) = frames::decode::<Places>(&payload) {
                        self.learn_places(&team_id, places);
                    }
                }
                _ => {}
            }
            if self.stopped.load(Ordering::SeqCst) {
                break;
            }
        }
        docs.abort();
        cursors.abort();
        {
            let mut teams = self.teams.lock().unwrap();
            if let Some(team) = teams.get_mut(&team_id) {
                if team.links.get(&device).is_some_and(|link| link.serial == serial) {
                    team.links.remove(&device);
                    team.emit(TeamEvent::Peers);
                }
            }
        }
        conn.close(VarInt::from_u32(0), b"bye");
        // 断了：过几秒就重拨（对方只是重启、换了网络的话很快能接上）
        if !self.stopped.load(Ordering::SeqCst) {
            let me = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(REDIAL_AFTER).await;
                me.redial.notify_one();
            });
        }
    }

    /// 发给这位的地址表：我自己的，加上我连着的、他名单里也有的人的
    fn places_for(&self, team: &str, to: [u8; 32]) -> Places {
        let mut entries = vec![self.where_am_i()];
        let linked: Vec<[u8; 32]> = self
            .teams
            .lock()
            .unwrap()
            .get(team)
            .map(|team| team.links.keys().copied().filter(|key| *key != to).collect())
            .unwrap_or_default();
        let places = self.places.lock().unwrap();
        entries.extend(linked.iter().filter_map(|key| places.get(key).cloned()));
        Places { entries }
    }

    /// 别人发来的地址表：名单里有的记下来、落盘，再拨一轮没连上的
    fn learn_places(&self, team: &str, places: Places) {
        let known: HashSet<[u8; 32]> = self
            .teams
            .lock()
            .unwrap()
            .get(team)
            .map(|team| team.devices.keys().copied().collect())
            .unwrap_or_default();
        let mut changed = false;
        {
            let mut stored = self.places.lock().unwrap();
            for mut place in places.entries {
                if place.key == self.me || !known.contains(&place.key) {
                    continue;
                }
                place.addrs = crate::collab::reach::link_addrs(place.addrs);
                if stored.get(&place.key) != Some(&place) {
                    stored.insert(place.key, place);
                    changed = true;
                }
            }
            if changed {
                if let Some(file) = &self.places_file {
                    let out: HashMap<String, StoredPlace> = stored
                        .iter()
                        .map(|(key, place)| {
                            (
                                hex(key),
                                StoredPlace {
                                    addrs: place.addrs.clone(),
                                    relay: place.relay.clone(),
                                },
                            )
                        })
                        .collect();
                    if let Ok(text) = serde_json::to_string_pretty(&out) {
                        let _ = crate::collab::record::write_atomic(file, text.as_bytes());
                    }
                }
            }
        }
        if changed {
            self.redial.notify_one();
        }
    }

    /* ---------------- 文档流 ---------------- */

    /// 主持人这边：别人开来的文档流
    async fn accept_docs(self: Arc<Self>, team: String, conn: Connection, guest: [u8; 32]) {
        while let Ok((send, recv)) = conn.accept_bi().await {
            tokio::spawn(self.clone().serve_doc(team.clone(), guest, send, recv));
        }
    }

    async fn serve_doc(self: Arc<Self>, team_id: String, guest: [u8; 32], mut send: SendStream, mut recv: RecvStream) {
        let doc = match tokio::time::timeout(OPEN_TIMEOUT, frames::read_frame(&mut recv)).await {
            Ok(Ok(Some((kind::OPEN, payload)))) => match String::from_utf8(payload) {
                Ok(doc) if !doc.is_empty() => doc,
                _ => return,
            },
            _ => return,
        };
        // 在主持（或者在做客、接下游）的才接；我连着他看这一篇的不接（成了环）
        let hosted = |me: &Inner| {
            me.teams.lock().unwrap().get(&team_id).is_some_and(|team| {
                team.hosted.contains(&doc) && !team.attached.get(&doc).is_some_and(|attached| attached.host == guest)
            })
        };
        if !hosted(&self) {
            let _ = frames::write_frame(&mut send, kind::DOC_ERR, "这一篇不是他在主持".as_bytes()).await;
            let _ = send.finish();
            let _ = tokio::time::timeout(Duration::from_millis(500), send.stopped()).await;
            return;
        }
        let serial = self.serial.fetch_add(1, Ordering::SeqCst);
        let (tx, _writer) = crate::collab::spawn_writer(send);
        let member = {
            let mut teams = self.teams.lock().unwrap();
            // 刚才看的时候在主持，这会儿不主持了：tx 丢掉，流收尾
            let Some(team) = teams.get_mut(&team_id).filter(|team| team.hosted.contains(&doc)) else { return };
            team.guests
                .entry(doc.clone())
                .or_default()
                .insert(guest, GuestStream { serial, tx });
            let member = team.number(&guest);
            team.emit(TeamEvent::SyncStart { with: member, doc: doc.clone() });
            member
        };
        loop {
            let Ok(Some((frame_kind, payload))) = frames::read_frame(&mut recv).await else { break };
            let mut teams = self.teams.lock().unwrap();
            let Some(team) = teams.get_mut(&team_id) else { break };
            // 不主持了（流收尾的那一刻）
            if !team.guests.get(&doc).is_some_and(|guests| guests.get(&guest).is_some_and(|stream| stream.serial == serial)) {
                break;
            }
            match frame_kind {
                kind::SYNC1 => team.emit(TeamEvent::SyncRequest {
                    from: member,
                    doc: doc.clone(),
                    vector: payload,
                }),
                kind::SYNC2 | kind::UPDATE => {
                    // 转给这一篇的其他访客、我的上游（我也在做客的话）
                    team.relay_update(&doc, &payload, Some(guest));
                    team.emit(TeamEvent::Update {
                        from: member,
                        doc: doc.clone(),
                        bytes: payload,
                    });
                }
                _ => {}
            }
        }
        let mut teams = self.teams.lock().unwrap();
        if let Some(team) = teams.get_mut(&team_id) {
            let mine = team.guests.get(&doc).is_some_and(|guests| guests.get(&guest).is_some_and(|stream| stream.serial == serial));
            if mine {
                let guests = team.guests.get_mut(&doc).expect("刚看过");
                guests.remove(&guest);
                if guests.is_empty() {
                    team.guests.remove(&doc);
                }
                team.emit(TeamEvent::DocClosed {
                    doc,
                    member,
                    refused: None,
                });
            }
        }
    }

    /// 访客这边：开一条文档流连主持人，收他发来的
    async fn attach(self: Arc<Self>, team_id: String, doc: String, conn: Connection, host: [u8; 32], member: u16, serial: u64) {
        let opened = async {
            let (mut send, recv) = conn.open_bi().await.ok()?;
            frames::write_frame(&mut send, kind::OPEN, doc.as_bytes()).await.ok()?;
            Some((send, recv))
        }
        .await;
        let mut refused = None;
        if let Some((send, mut recv)) = opened {
            let (tx, _writer) = crate::collab::spawn_writer(send);
            let still = {
                let mut teams = self.teams.lock().unwrap();
                match teams
                    .get_mut(&team_id)
                    .and_then(|team| team.attached.get_mut(&doc))
                    .filter(|attached| attached.serial == serial && attached.host == host)
                {
                    Some(attached) => {
                        attached.tx = Some(tx);
                        true
                    }
                    None => false,
                }
            };
            if !still {
                return;
            }
            self.emit(&team_id, TeamEvent::SyncStart { with: member, doc: doc.clone() });
            loop {
                let Ok(Some((frame_kind, payload))) = frames::read_frame(&mut recv).await else { break };
                let event = match frame_kind {
                    kind::SYNC1 => TeamEvent::SyncRequest {
                        from: member,
                        doc: doc.clone(),
                        vector: payload,
                    },
                    kind::SYNC2 | kind::UPDATE => {
                        // 上游来的转给我的下游
                        if let Some(team) = self.teams.lock().unwrap().get(&team_id) {
                            team.relay_update(&doc, &payload, Some(host));
                        }
                        TeamEvent::Update {
                            from: member,
                            doc: doc.clone(),
                            bytes: payload,
                        }
                    }
                    kind::DOC_ERR => {
                        refused = Some(String::from_utf8_lossy(&payload).into_owned());
                        break;
                    }
                    _ => continue,
                };
                self.emit(&team_id, event);
            }
        }
        let mut teams = self.teams.lock().unwrap();
        if let Some(team) = teams.get_mut(&team_id) {
            if team.attached.get(&doc).is_some_and(|attached| attached.serial == serial) {
                team.attached.remove(&doc);
                team.emit(TeamEvent::DocClosed { doc, member, refused });
            }
        }
    }

    /// 光标数据报：访客发来的转给这一篇的其他访客；主持人发来的（他的、他转来的）交给前端
    async fn read_cursors(self: Arc<Self>, team_id: String, conn: Connection, from: [u8; 32]) {
        while let Ok(datagram) = conn.read_datagram().await {
            let Some((doc, origin, payload)) = wire::untag_cursor(&datagram) else { continue };
            let mut teams = self.teams.lock().unwrap();
            let Some(team) = teams.get_mut(&team_id) else { return };
            let from_guest = team.guests.get(doc).is_some_and(|guests| guests.contains_key(&from));
            let from_host = team.attached.get(doc).is_some_and(|attached| attached.host == from);
            // 只认这一篇上下游来的、名单里的人的（经 B 转来的光标是 C 的，不是 B 的）
            if !(from_guest || from_host) || origin == self.me || !team.devices.contains_key(&origin) {
                continue;
            }
            team.relay_cursor(doc, &datagram, Some(from));
            let member = team.number(&origin);
            team.emit(TeamEvent::Cursor {
                from: member,
                doc: doc.to_string(),
                bytes: payload.to_vec(),
            });
        }
    }
}

/// 回一个 Reject、等对方收到再断开
async fn refuse(mut send: SendStream, conn: &Connection, reason: Refusal) {
    let _ = frames::write_frame(&mut send, kind::REJECT, &frames::encode(&reason)).await;
    let _ = send.finish();
    let _ = tokio::time::timeout(Duration::from_millis(500), send.stopped()).await;
    conn.close(VarInt::from_u32(0), b"rejected");
}
