/* ============================================================
一个共享仓库在这台设备上跑起来的样子（docs/协同编辑.md §20.3–§20.8）：仓库窗口开着就在后台连、
后台合并、后台写盘。

- 端点：每个共享仓库一个 iroh 端点、一把自己的设备密钥（存在应用数据目录里，不在仓库里；
  和会话式协作的端点分开 —— 同一把密钥起两个端点，中继那边会互相顶掉）
- 网状：成员表里每一位都去拨（上次在哪记在 places.json，局域网 mDNS 按公钥找），谁都能接。
  两边同时互拨出两条连接时留拨号一方公钥小的那条
- 后台任务（tick）：本机的变化进 CRDT、别人的改动停手 400ms 写盘、附件清单、日程开关、落盘
- 前端：打开一篇时拿快照建自己的 Loro 副本，之后两边互发增量（open_doc / push）；
  这一篇的远端改动、磁盘上的改动经 Sink 推给前端
锁的顺序：仓库 → 副本 → 桥（只有 tick 一次拿三把）；网络那边只拿副本或者桥，不嵌套
============================================================ */

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use iroh::endpoint::{presets, Connection, IdleTimeout, QuicTransportConfig, RecvStream, SendStream, VarInt};
use iroh::{Endpoint, EndpointAddr, PublicKey, SecretKey, TransportAddr};
use iroh_mdns_address_lookup::MdnsAddressLookup;
use serde::{Deserialize, Serialize};
use tokio::sync::{oneshot, Notify};

use super::bridge::{hash_of, Bridge};
use super::members::{first_roster_ok, Member, Role, Roster};
use super::replica::{DocKind, DocMeta, Replica, Summary, Target, Update, Version};
use super::wire::{self, kind, Hello, Refusal, ShareInvite, UpdateMsg, Where};
use super::{hex, ShareInfo, ShareMember, ShareRequest, ShareState, Sink};
use crate::collab::protocol as frames;
use crate::collab::{relays, Relay};
use crate::vault::{fsio, layout, Vault};

/// 多久试着拨一次没连上的成员
const DIAL_EVERY: Duration = Duration::from_secs(20);
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
/// 改过的 CRDT 多久落一次盘
const SAVE_EVERY: Duration = Duration::from_secs(2);
/// 多久扫一次附件
const FILES_EVERY: Duration = Duration::from_secs(10);
/// 要一个附件最多等多久（50MB 经中继也够了）
const BLOB_TIMEOUT: Duration = Duration::from_secs(90);
/// 连接断了以后多久重拨
const REDIAL_AFTER: Duration = Duration::from_secs(3);
/// 打开一篇时还没对完第一遍账（前端认这句话，过一会儿再打开）
pub const NOT_READY: &str = "共享仓库还在准备（读笔记、对账），稍等";
/// 谁都没有的附件过多久再要
const FETCH_RETRY: Duration = Duration::from_secs(30);
/// mDNS 的服务名：局域网里按公钥找到同一个共享的成员（广播里只有公钥）
const MDNS_SERVICE: &str = "odea-share";

pub struct ShareOptions {
    /// 这个共享仓库在这台设备上的密钥
    pub key: SecretKey,
    pub name: String,
    /// 用户自己配的中继
    pub relays: Vec<Relay>,
    /// 局域网发现（测试里关掉）
    pub mdns: bool,
}

/* ---------------- 落盘的设置 ---------------- */

/// .odea/share/share.json
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    /// 共享 id（十六进制）
    share: String,
    /// 仓库名（邀请链接里带着）
    name: String,
    /// 成员表（postcard 再 base64）。还没加入的是 None
    #[serde(default)]
    roster: Option<String>,
    /// 我发出去的邀请（管理员）
    #[serde(default)]
    invite: Option<OwnInvite>,
    /// 正在加入：拿着的邀请链接
    #[serde(default)]
    joining: Option<String>,
    /// 被移出了
    #[serde(default)]
    removed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OwnInvite {
    secret: String,
    role: Role,
}

/// .odea/share/places.json 里的一项：一位成员上次在哪
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Place {
    addrs: Vec<SocketAddr>,
    relay: Option<Relay>,
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(text: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(text).ok()
}

impl Config {
    fn load(dir: &Path) -> Option<Self> {
        serde_json::from_str(&std::fs::read_to_string(dir.join("share.json")).ok()?).ok()
    }

    fn save(&self, dir: &Path) {
        if let Ok(text) = serde_json::to_string_pretty(self) {
            if let Err(error) = fsio::write_atomic(&dir.join("share.json"), &text) {
                eprintln!("共享仓库：share.json 写不进去：{error}");
            }
        }
    }

    fn share_id(&self) -> [u8; 16] {
        data_encoding::HEXLOWER
            .decode(self.share.as_bytes())
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .unwrap_or([0; 16])
    }

    fn roster(&self) -> Option<Roster> {
        postcard::from_bytes(&unb64(self.roster.as_deref()?)?).ok()
    }

    fn set_roster(&mut self, roster: &Roster) {
        self.roster = Some(b64(&postcard::to_allocvec(roster).expect("成员表编码不会失败")));
    }

    fn invite_secret(&self) -> Option<[u8; 32]> {
        let invite = self.invite.as_ref()?;
        data_encoding::HEXLOWER.decode(invite.secret.as_bytes()).ok()?.try_into().ok()
    }
}

/// 这个文件夹是不是共享仓库（有 .odea/share/share.json）
pub fn is_shared(root: &Path) -> bool {
    share_dir(root).join("share.json").is_file()
}

pub fn share_dir(root: &Path) -> PathBuf {
    fsio::abs(root, ".odea/share")
}

/// 共享 id（十六进制）：应用数据目录里按它存这个共享的设备密钥
pub fn share_key_name(root: &Path) -> Option<String> {
    Config::load(&share_dir(root)).map(|config| config.share)
}

/// 加入之前：在一个空文件夹里摆好仓库（仓库标记照邀请人的摆法、空的清单、拿着的链接）。
/// 之后照常打开这个仓库，后台任务拿着链接去拨邀请人
pub fn prepare_join(root: &Path, invite: &ShareInvite, link: &str) -> crate::error::Result<()> {
    std::fs::create_dir_all(share_dir(root))?;
    let mut marker = layout::new_marker(true, true, crate::db::now_ms());
    if let Ok(serde_json::Value::Object(folders)) = serde_json::from_str::<serde_json::Value>(&invite.folders) {
        marker["folders"] = serde_json::Value::Object(folders);
    }
    let marker = layout::marker_with_journal(Some(marker), invite.journal);
    fsio::write_atomic(&fsio::abs(root, layout::VAULT_MARKER), &serde_json::to_string_pretty(&marker)?)?;
    // 空的清单：不然第一次打开时会按文件夹结构建一棵，和别人的树叠在一起
    let tree = fsio::abs(root, crate::vault::tree::TREE_FILE);
    if !tree.is_file() {
        fsio::write_atomic(&tree, "# Odea 逻辑目录（共享仓库，加入中）\n")?;
    }
    Config {
        share: data_encoding::HEXLOWER.encode(&invite.share),
        name: invite.name.clone(),
        roster: None,
        invite: None,
        joining: Some(link.to_string()),
        removed: false,
    }
    .save(&share_dir(root));
    Ok(())
}

/* ---------------- 服务 ---------------- */

struct Link {
    serial: u64,
    conn: Connection,
    tx: tokio::sync::mpsc::UnboundedSender<(u8, Vec<u8>)>,
    /// 谁拨的这条
    dialer: [u8; 32],
}

struct Request {
    request: u32,
    device: [u8; 32],
    name: String,
    answer: Option<oneshot::Sender<Option<Role>>>,
}

struct Inner {
    root: PathBuf,
    dir: PathBuf,
    vault: Arc<Mutex<Vault>>,
    replica: Mutex<Replica>,
    bridge: Mutex<Bridge>,
    config: Mutex<Config>,
    places: Mutex<HashMap<String, Place>>,
    key: SecretKey,
    me: [u8; 32],
    name: Mutex<String>,
    endpoint: Endpoint,
    relays: Vec<Relay>,
    _mdns: Option<MdnsAddressLookup>,
    links: Mutex<HashMap<[u8; 32], Link>>,
    dialing: Mutex<HashSet<[u8; 32]>>,
    fetching: Mutex<HashSet<String>>,
    /// 谁都没有的附件：过一阵再要
    fetch_failed: Mutex<HashMap<String, Instant>>,
    requests: Mutex<Vec<Request>>,
    state: Mutex<ShareState>,
    /// 前端开着的那几篇：它们的改动推给前端
    open: Mutex<HashSet<String>>,
    sink: Arc<dyn Sink>,
    wake: Notify,
    redial: Notify,
    started: AtomicBool,
    stopped: AtomicBool,
    /// 下一轮就扫附件（文件监听处理完一批时）
    scan_now: AtomicBool,
    serial: AtomicU64,
    next_request: AtomicU32,
    last_save: Mutex<Instant>,
}

pub struct Share {
    inner: Arc<Inner>,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

/// 回一个 Reject、等对方收到再断开
async fn refuse(mut send: SendStream, conn: &Connection, reason: Refusal) {
    let _ = frames::write_frame(&mut send, kind::REJECT, &frames::encode(&reason)).await;
    let _ = send.finish();
    let _ = tokio::time::timeout(Duration::from_millis(500), send.stopped()).await;
    conn.close(VarInt::from_u32(0), b"rejected");
}

async fn bind(key: SecretKey, relays: &[Relay], mdns: bool) -> Result<(Endpoint, Option<MdnsAddressLookup>), String> {
    let idle = IdleTimeout::try_from(Duration::from_secs(12)).map_err(|error| error.to_string())?;
    let transport = QuicTransportConfig::builder()
        .keep_alive_interval(Duration::from_secs(5))
        .max_idle_timeout(Some(idle))
        .build();
    let pins = relays::pins(relays);
    let endpoint = Endpoint::builder(presets::Minimal)
        .secret_key(key)
        .alpns(vec![wire::ALPN.to_vec()])
        .relay_mode(relays::relay_mode(relays))
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
                eprintln!("共享仓库：mDNS 起不来：{error}");
                None
            }
        }
    } else {
        None
    };
    Ok((endpoint, mdns))
}

impl Share {
    /// 把一个已有的仓库共享出去：没写 id 的笔记写上、每篇读进 CRDT（都算这台设备写的）、我是管理员
    pub async fn create(
        vault: Arc<Mutex<Vault>>,
        root: &Path,
        name: &str,
        options: ShareOptions,
        sink: Arc<dyn Sink>,
    ) -> Result<Share, String> {
        let dir = share_dir(root);
        let me = *options.key.public().as_bytes();
        let key = options.key.clone();
        let (vault_name, member_name) = (name.to_string(), options.name.clone());
        let (vault_for, dir_for) = (vault.clone(), dir.clone());
        let root_for = root.to_path_buf();
        let (replica, bridge, config) = tokio::task::spawn_blocking(move || -> Result<_, String> {
            let mut vault = vault_for.lock().map_err(|_| "仓库锁坏了")?;
            if !vault.layout().logical {
                return Err("只有逻辑目录的仓库能共享，先转成逻辑目录".into());
            }
            if !vault.indexed_all() {
                return Err("还在读取笔记，读完再共享".into());
            }
            std::fs::create_dir_all(&dir_for).map_err(|error| error.to_string())?;
            let mut replica = Replica::open(&dir_for, &hex(&me))?;
            let mut bridge = Bridge::new(&root_for);
            vault.set_shared(true);
            let adopted = bridge
                .adopt(&mut vault, &mut replica)
                .map_err(|error| error.to_string())
                .and_then(|()| replica.save());
            if let Err(error) = adopted {
                // 没建成：还是一个普通的仓库（编辑器存的正文照常写）
                vault.set_shared(false);
                let _ = std::fs::remove_dir_all(&dir_for);
                return Err(error);
            }
            let share: [u8; 16] = crate::collab::random_bytes();
            let mut config = Config {
                share: data_encoding::HEXLOWER.encode(&share),
                name: vault_name,
                invite: Some(OwnInvite {
                    secret: data_encoding::HEXLOWER.encode(&crate::collab::random_bytes::<32>()),
                    role: Role::Edit,
                }),
                ..Config::default()
            };
            config.set_roster(&Roster::first(share, &key, &member_name));
            config.save(&dir_for);
            Ok((replica, bridge, config))
        })
        .await
        .map_err(|error| error.to_string())??;
        Self::start(vault, root, options, sink, replica, bridge, config, true).await
    }

    /// 打开一个共享仓库（仓库窗口打开它的时候）
    pub async fn open(
        vault: Arc<Mutex<Vault>>,
        root: &Path,
        options: ShareOptions,
        sink: Arc<dyn Sink>,
    ) -> Result<Share, String> {
        let dir = share_dir(root);
        let config = Config::load(&dir).ok_or("这个仓库不是共享仓库")?;
        let me = hex(options.key.public().as_bytes());
        let (dir_for, root_for) = (dir.clone(), root.to_path_buf());
        let (replica, bridge) = tokio::task::spawn_blocking(move || -> Result<_, String> {
            Ok((Replica::open(&dir_for, &me)?, Bridge::new(&root_for)))
        })
        .await
        .map_err(|error| error.to_string())??;
        if let Ok(mut vault) = vault.lock() {
            vault.set_shared(true);
        }
        Self::start(vault, root, options, sink, replica, bridge, config, false).await
    }

    #[allow(clippy::too_many_arguments)]
    async fn start(
        vault: Arc<Mutex<Vault>>,
        root: &Path,
        options: ShareOptions,
        sink: Arc<dyn Sink>,
        replica: Replica,
        bridge: Bridge,
        config: Config,
        adopted: bool,
    ) -> Result<Share, String> {
        let dir = share_dir(root);
        let places: HashMap<String, Place> = std::fs::read_to_string(dir.join("places.json"))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        // 中继：自己配的，加上成员们上次用的、邀请链接里带的（经它们才找得到对方）
        let mut relays = options.relays.clone();
        let joining = config.joining.as_deref().and_then(|link| ShareInvite::parse(link).ok());
        for relay in places
            .values()
            .filter_map(|place| place.relay.clone())
            .chain(joining.as_ref().and_then(|invite| invite.relay.clone()))
        {
            if !relays.iter().any(|known| known.url == relay.url) {
                relays.push(relay);
            }
        }
        let (endpoint, mdns) = bind(options.key.clone(), &relays, options.mdns).await?;
        let me = *options.key.public().as_bytes();
        let state = if config.removed {
            ShareState::Removed
        } else if config.roster.is_none() {
            ShareState::Joining { waiting: false }
        } else {
            ShareState::Ready
        };
        let inner = Arc::new(Inner {
            root: root.to_path_buf(),
            dir,
            vault: vault.clone(),
            replica: Mutex::new(replica),
            bridge: Mutex::new(bridge),
            config: Mutex::new(config),
            places: Mutex::new(places),
            key: options.key,
            me,
            name: Mutex::new(options.name),
            endpoint,
            relays,
            _mdns: mdns,
            links: Mutex::new(HashMap::new()),
            dialing: Mutex::new(HashSet::new()),
            fetching: Mutex::new(HashSet::new()),
            fetch_failed: Mutex::new(HashMap::new()),
            requests: Mutex::new(Vec::new()),
            state: Mutex::new(state),
            open: Mutex::new(HashSet::new()),
            sink,
            wake: Notify::new(),
            redial: Notify::new(),
            started: AtomicBool::new(adopted),
            stopped: AtomicBool::new(false),
            scan_now: AtomicBool::new(false),
            serial: AtomicU64::new(1),
            next_request: AtomicU32::new(1),
            last_save: Mutex::new(Instant::now()),
        });
        // 仓库那边有文档进了 / 离开了索引：叫醒后台任务；前端副本开着的那几篇，编辑器存盘时的正文不用
        let weak = Arc::downgrade(&inner);
        let opened = Arc::downgrade(&inner);
        if let Ok(mut vault) = vault.lock() {
            vault.set_on_touch(Some(Arc::new(move || {
                if let Some(inner) = weak.upgrade() {
                    inner.wake.notify_one();
                }
            })));
            vault.set_body_owner(Some(Arc::new(move |doc: &str| {
                opened.upgrade().is_some_and(|inner| inner.open.lock().unwrap().contains(doc))
            })));
        }
        let tasks = vec![
            tokio::spawn(inner.clone().accept_loop()),
            tokio::spawn(inner.clone().tick_loop()),
            tokio::spawn(inner.clone().dial_loop()),
        ];
        Ok(Share {
            inner,
            tasks: Mutex::new(tasks),
        })
    }

    pub fn info(&self) -> ShareInfo {
        self.inner.info()
    }

    /// 设备公钥（十六进制）
    #[cfg(test)]
    pub fn me(&self) -> String {
        hex(&self.inner.me)
    }

    /// 邀请链接（管理员）
    pub fn invite_link(&self) -> Result<String, String> {
        self.inner.invite_link()
    }

    /// 重置邀请链接：以前发出去的作废
    pub fn reset_invite(&self, role: Role) -> Result<String, String> {
        {
            self.inner.require_admin()?;
            let mut config = self.inner.config.lock().unwrap();
            config.invite = Some(OwnInvite {
                secret: data_encoding::HEXLOWER.encode(&crate::collab::random_bytes::<32>()),
                role,
            });
            config.save(&self.inner.dir);
        }
        self.inner.invite_link()
    }

    /// 回答一个加入请求：Some(角色) 允许，None 拒绝
    pub fn answer(&self, request: u32, role: Option<Role>) -> bool {
        let answer = {
            let mut requests = self.inner.requests.lock().unwrap();
            requests
                .iter_mut()
                .find(|known| known.request == request)
                .and_then(|known| known.answer.take())
        };
        let answered = answer.is_some_and(|answer| answer.send(role).is_ok());
        self.inner.requests.lock().unwrap().retain(|known| known.request != request);
        self.inner.sink.changed();
        answered
    }

    /// 改一位成员的角色；None 是移出。至少要留一位管理员
    pub fn set_role(&self, device: &str, role: Option<Role>) -> Result<(), String> {
        self.inner.set_role(device, role)
    }

    /// 前端打开一篇：这一篇的整个状态、给前端用的 peer。先对一次账：磁盘上刚改的（刚建的笔记、
    /// 别的程序刚改的）先进 CRDT，快照才是最新的。还没对完第一遍账（索引没读全）的时候打不开 ——
    /// 这时的快照可能是空的，前端过一会儿再来
    pub async fn open_doc(&self, doc: &str) -> Result<(Vec<u8>, u64), String> {
        let inner = self.inner.clone();
        let (updates, _) = tokio::task::spawn_blocking(move || inner.tick(false))
            .await
            .map_err(|error| error.to_string())?;
        self.inner.publish_local(updates, true);
        if !self.inner.started.load(Ordering::SeqCst) {
            return Err(NOT_READY.into());
        }
        self.inner.open_doc(doc)
    }

    pub fn close_doc(&self, doc: &str) {
        self.inner.open.lock().unwrap().remove(doc);
    }

    /// 前端那份的改动
    pub fn push(&self, doc: &str, bytes: &[u8]) -> Result<(), String> {
        self.inner.push(doc, bytes)
    }

    pub fn send_cursor(&self, doc: &str, payload: &[u8]) {
        self.inner.send_cursor(doc, payload);
    }

    pub fn history(&self, doc: &str) -> Vec<Version> {
        self.inner.replica.lock().unwrap().history(doc)
    }

    /// 设备公钥 → 名字（成员表里的），历史版本显示用
    pub fn member_names(&self) -> HashMap<String, String> {
        self.inner
            .config
            .lock()
            .unwrap()
            .roster()
            .map(|roster| roster.members.iter().map(|member| (hex(&member.id), member.name.clone())).collect())
            .unwrap_or_default()
    }

    pub fn text_at(&self, doc: &str, frontiers: &[u8]) -> Result<String, String> {
        self.inner.replica.lock().unwrap().text_at(doc, frontiers)
    }

    /// 恢复到某一版（一次新的改动，别人那里也恢复）
    pub fn restore(&self, doc: &str, frontiers: &[u8]) -> Result<(), String> {
        self.inner.require_editor()?;
        let update = self.inner.replica.lock().unwrap().restore(doc, frontiers)?;
        if let Some(update) = update {
            self.inner.bridge.lock().unwrap().schedule_write(doc, Instant::now());
            self.inner.publish_local(vec![update], true);
            self.inner.wake.notify_one();
        }
        Ok(())
    }

    /// 我的名字改了（下次握手带着；成员表里的名字由管理员签，自己是管理员就顺手改掉）
    pub fn set_name(&self, name: &str) {
        *self.inner.name.lock().unwrap() = name.to_string();
        let _ = self.inner.rename_self(name);
    }

    /// 文件监听处理完一批：附件可能变了
    pub fn poke(&self) {
        self.inner.scan_now.store(true, Ordering::SeqCst);
        self.inner.wake.notify_one();
    }

    /// 关掉：落盘、断开、停后台任务
    pub async fn close(&self) {
        let inner = self.inner.clone();
        inner.stopped.store(true, Ordering::SeqCst);
        for task in self.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
        let saver = inner.clone();
        let _ = tokio::task::spawn_blocking(move || {
            if let Err(error) = saver.replica.lock().unwrap().save() {
                eprintln!("共享仓库：落盘失败：{error}");
            }
            if let Ok(mut vault) = saver.vault.lock() {
                vault.set_on_touch(None);
                vault.set_body_owner(None);
                vault.set_shared(false);
            }
        })
        .await;
        for link in inner.links.lock().unwrap().values() {
            link.conn.close(VarInt::from_u32(0), b"bye");
        }
        inner.endpoint.close().await;
    }

    /// 测试用：等到后台任务把该做的都做完（没有要写盘的、没有在要的附件）
    #[cfg(test)]
    pub async fn settle(&self) {
        for _ in 0..400 {
            let idle = self.inner.bridge.lock().unwrap().next_due().is_none()
                && self.inner.fetching.lock().unwrap().is_empty()
                && self.inner.started.load(Ordering::SeqCst);
            if idle {
                return;
            }
            self.inner.wake.notify_one();
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    #[cfg(test)]
    pub fn online(&self) -> usize {
        self.inner.links.lock().unwrap().len()
    }

    #[cfg(test)]
    pub fn text(&self, doc: &str) -> String {
        self.inner.replica.lock().unwrap().text(doc)
    }

    #[cfg(test)]
    pub fn addr(&self) -> EndpointAddr {
        EndpointAddr {
            id: self.inner.endpoint.id(),
            addrs: self
                .inner
                .endpoint
                .bound_sockets()
                .into_iter()
                .map(|addr| {
                    let ip = if addr.ip().is_unspecified() {
                        std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
                    } else {
                        addr.ip()
                    };
                    TransportAddr::Ip(SocketAddr::new(ip, addr.port()))
                })
                .filter(|addr| matches!(addr, TransportAddr::Ip(SocketAddr::V4(_))))
                .collect(),
        }
    }

    /// 测试用：告诉它某位成员在哪（不靠 mDNS）
    #[cfg(test)]
    pub fn learn(&self, device: &str, addr: &EndpointAddr) {
        let addrs = addr
            .addrs
            .iter()
            .filter_map(|addr| match addr {
                TransportAddr::Ip(ip) => Some(*ip),
                _ => None,
            })
            .collect();
        self.inner
            .places
            .lock()
            .unwrap()
            .insert(device.to_string(), Place { addrs, relay: None });
        self.inner.redial.notify_one();
    }
}

impl Inner {
    fn share_id(&self) -> [u8; 16] {
        self.config.lock().unwrap().share_id()
    }

    fn roster(&self) -> Option<Roster> {
        self.config.lock().unwrap().roster()
    }

    fn role_of(&self, device: &[u8; 32]) -> Option<Role> {
        self.roster()?.role_of(device)
    }

    fn require_admin(&self) -> Result<(), String> {
        match self.role_of(&self.me) {
            Some(Role::Admin) => Ok(()),
            _ => Err("只有管理员能这么做".into()),
        }
    }

    fn require_editor(&self) -> Result<(), String> {
        match self.role_of(&self.me) {
            Some(role) if role.can_edit() => Ok(()),
            _ => Err("你在这个共享仓库里是只读的".into()),
        }
    }

    fn set_state(&self, state: ShareState) {
        let changed = {
            let mut current = self.state.lock().unwrap();
            let changed = *current != state;
            *current = state;
            changed
        };
        if changed {
            self.sink.changed();
        }
    }

    fn info(&self) -> ShareInfo {
        let config = self.config.lock().unwrap().clone();
        let roster = config.roster();
        let online: HashSet<[u8; 32]> = self.links.lock().unwrap().keys().copied().collect();
        let members = roster
            .as_ref()
            .map(|roster| {
                roster
                    .members
                    .iter()
                    .map(|member| ShareMember {
                        id: hex(&member.id),
                        name: member.name.clone(),
                        role: member.role,
                        online: member.id == self.me || online.contains(&member.id),
                        me: member.id == self.me,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let requests = self
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| ShareRequest {
                request: request.request,
                id: hex(&request.device),
                name: request.name.clone(),
            })
            .collect();
        ShareInfo {
            id: config.share.clone(),
            name: config.name.clone(),
            me: hex(&self.me),
            role: roster.as_ref().and_then(|roster| roster.role_of(&self.me)),
            state: self.state.lock().unwrap().clone(),
            members,
            requests,
            can_invite: config.invite.is_some(),
        }
    }

    fn where_am_i(&self) -> Where {
        Where {
            addrs: crate::collab::reach::endpoint_addrs(&self.endpoint),
            relay: self.relays.first().cloned(),
        }
    }

    fn invite_link(&self) -> Result<String, String> {
        self.require_admin()?;
        let mut config = self.config.lock().unwrap();
        if config.invite.is_none() {
            config.invite = Some(OwnInvite {
                secret: data_encoding::HEXLOWER.encode(&crate::collab::random_bytes::<32>()),
                role: Role::Edit,
            });
            config.save(&self.dir);
        }
        let marker: Option<serde_json::Value> = std::fs::read_to_string(fsio::abs(&self.root, layout::VAULT_MARKER))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok());
        let folders = marker
            .as_ref()
            .and_then(|marker| marker.get("folders"))
            .map(|folders| folders.to_string())
            .unwrap_or_default();
        let place = self.where_am_i();
        Ok(ShareInvite {
            share: config.share_id(),
            name: config.name.clone(),
            inviter: self.me,
            addrs: place.addrs,
            relay: place.relay,
            secret: config.invite_secret().ok_or("邀请密钥坏了")?,
            role: config.invite.as_ref().map_or(Role::Edit, |invite| invite.role),
            journal: layout::Layout::load(&self.root).journal,
            folders,
        }
        .to_link())
    }

    /* ---------------- 前端那份 ---------------- */

    fn open_doc(&self, doc: &str) -> Result<(Vec<u8>, u64), String> {
        if Target::from_wire(doc).is_none() || doc.is_empty() {
            return Err("这一篇不能共享".into());
        }
        // 先登记再拿快照：中间到的改动推给前端，快照里也有，重复 import 没事
        self.open.lock().unwrap().insert(doc.to_string());
        let (snapshot, peer, updates) = {
            let mut replica = self.replica.lock().unwrap();
            let mut updates = Vec::new();
            // 某一天、目标是一打字才有的：元数据先记上（不然正文到了也不知道是什么、一直不写盘）
            let kind = if doc.starts_with("day-") {
                Some(DocKind::Day)
            } else if doc.starts_with("goal-") {
                Some(DocKind::Goal)
            } else {
                None
            };
            if let Some(kind) = kind.filter(|_| replica.meta(doc).is_none()) {
                updates.extend(replica.set_meta(
                    doc,
                    &DocMeta {
                        kind,
                        title: String::new(),
                        pinned: false,
                        archived: None,
                        category: None,
                        created: 0,
                        deleted: false,
                    },
                ));
            }
            let snapshot = replica.snapshot(doc);
            let (peer, registered) = replica.new_peer();
            updates.extend(registered);
            (snapshot, peer, updates)
        };
        self.publish_local(updates, false);
        Ok((snapshot, peer))
    }

    fn push(&self, doc: &str, bytes: &[u8]) -> Result<(), String> {
        self.require_editor()?;
        let target = Target::from_wire(doc).filter(|target| *target != Target::Vault).ok_or("不认识的文档")?;
        let changed = self.replica.lock().unwrap().import(&target, bytes)?;
        if changed {
            self.broadcast(
                &[Update {
                    target,
                    bytes: bytes.to_vec(),
                }],
                None,
            );
            self.bridge.lock().unwrap().schedule_write(doc, Instant::now());
            self.wake.notify_one();
        }
        Ok(())
    }

    fn send_cursor(&self, doc: &str, payload: &[u8]) {
        let Some(datagram) = wire::tag_cursor(doc, payload) else { return };
        let datagram = Bytes::from(datagram);
        for link in self.links.lock().unwrap().values() {
            let _ = link.conn.send_datagram(datagram.clone());
        }
    }

    /// 本机出的改动：发给所有连着的成员；正文的、前端开着那一篇的也推给前端（to_frontend）
    fn publish_local(&self, updates: Vec<Update>, to_frontend: bool) {
        if updates.is_empty() {
            return;
        }
        self.broadcast(&updates, None);
        if to_frontend {
            self.to_frontend(&updates);
        }
    }

    fn to_frontend(&self, updates: &[Update]) {
        let open = self.open.lock().unwrap().clone();
        for update in updates {
            if let Target::Doc(id) = &update.target {
                if open.contains(id) {
                    self.sink.doc_update(id, &update.bytes);
                }
            }
        }
    }

    fn broadcast(&self, updates: &[Update], except: Option<[u8; 32]>) {
        let links = self.links.lock().unwrap();
        for (device, link) in links.iter() {
            if Some(*device) == except {
                continue;
            }
            for update in updates {
                let message = UpdateMsg {
                    target: update.target.wire().to_string(),
                    bytes: update.bytes.clone(),
                };
                let _ = link.tx.send((kind::UPDATE, frames::encode(&message)));
            }
        }
    }

    /* ---------------- 后台任务：对账、写盘、落盘 ---------------- */

    async fn tick_loop(self: Arc<Self>) {
        let mut last_files = Instant::now() - FILES_EVERY;
        loop {
            if self.stopped.load(Ordering::SeqCst) {
                return;
            }
            let now = Instant::now();
            let due = self.bridge.lock().unwrap().next_due();
            let until = due.map_or(now + Duration::from_secs(1), |due| due.min(now + Duration::from_secs(1)));
            tokio::select! {
                _ = self.wake.notified() => {}
                _ = tokio::time::sleep_until(until.into()) => {}
            }
            let scan_files = self.scan_now.swap(false, Ordering::SeqCst) || last_files.elapsed() >= FILES_EVERY;
            if scan_files {
                last_files = Instant::now();
            }
            let me = self.clone();
            let Ok((updates, wanted)) = tokio::task::spawn_blocking(move || me.tick(scan_files)).await else {
                continue;
            };
            self.publish_local(updates, true);
            for (path, hash) in wanted {
                if self.fetching.lock().unwrap().insert(path.clone()) {
                    tokio::spawn(self.clone().fetch_file(path, hash));
                }
            }
        }
    }

    fn tick(&self, scan_files: bool) -> (Vec<Update>, Vec<(String, String)>) {
        let Ok(mut vault) = self.vault.lock() else { return (Vec::new(), Vec::new()) };
        // 还没加入（没有成员表）、被移出了：不动仓库
        let joined = matches!(*self.state.lock().unwrap(), ShareState::Ready);
        if !joined {
            vault.take_touched();
            return (Vec::new(), Vec::new());
        }
        let now = Instant::now();
        let mut replica = self.replica.lock().unwrap();
        let mut bridge = self.bridge.lock().unwrap();
        let mut out = Vec::new();
        if !self.started.load(Ordering::SeqCst) {
            // 索引没读全之前不对账：没读到的笔记会当成删了
            if !vault.indexed_all() {
                return (Vec::new(), Vec::new());
            }
            out.extend(bridge.start(&mut vault, &mut replica, now));
            self.started.store(true, Ordering::SeqCst);
        }
        out.extend(bridge.sync_journal(&mut vault, &mut replica));
        out.extend(bridge.absorb(&mut vault, &mut replica, now));
        out.extend(bridge.materialize(&mut vault, &mut replica, now));
        if scan_files {
            out.extend(bridge.scan_files(&mut replica));
        }
        let wanted = bridge.wanted_files(&replica);
        let mut last_save = self.last_save.lock().unwrap();
        if replica.has_unsaved() && last_save.elapsed() >= SAVE_EVERY {
            if let Err(error) = replica.save() {
                eprintln!("共享仓库：落盘失败：{error}");
            }
            *last_save = Instant::now();
        }
        let fetching = self.fetching.lock().unwrap();
        let mut failed = self.fetch_failed.lock().unwrap();
        failed.retain(|_, at| at.elapsed() < FETCH_RETRY);
        let wanted = wanted
            .into_iter()
            .filter(|(path, _)| !fetching.contains(path) && !failed.contains_key(path))
            .collect();
        (out, wanted)
    }

    /* ---------------- 连接 ---------------- */

    async fn dial_loop(self: Arc<Self>) {
        loop {
            if self.stopped.load(Ordering::SeqCst) {
                return;
            }
            self.dial_missing();
            tokio::select! {
                _ = tokio::time::sleep(DIAL_EVERY) => {}
                _ = self.redial.notified() => {}
            }
        }
    }

    fn dial_missing(self: &Arc<Self>) {
        let config = self.config.lock().unwrap().clone();
        if config.removed {
            return;
        }
        let targets: Vec<([u8; 32], Option<ShareInvite>)> = match config.roster() {
            Some(roster) => roster
                .members
                .iter()
                .filter(|member| member.id != self.me)
                .map(|member| (member.id, None))
                .collect(),
            None => match config.joining.as_deref().map(ShareInvite::parse) {
                // 被拒了就不再拨（界面上说清楚，用户换一个链接重新加入）
                Some(Ok(invite)) if !matches!(*self.state.lock().unwrap(), ShareState::Rejected { .. }) => {
                    vec![(invite.inviter, Some(invite))]
                }
                _ => Vec::new(),
            },
        };
        let links = self.links.lock().unwrap();
        let mut dialing = self.dialing.lock().unwrap();
        for (device, invite) in targets {
            if links.contains_key(&device) || !dialing.insert(device) {
                continue;
            }
            let me = self.clone();
            tokio::spawn(async move {
                if let Err(error) = me.clone().dial(device, invite).await {
                    eprintln!("共享仓库：连 {} 没连上：{error}", &hex(&device)[..8]);
                }
                me.dialing.lock().unwrap().remove(&device);
            });
        }
    }

    async fn dial(self: Arc<Self>, device: [u8; 32], invite: Option<ShareInvite>) -> Result<(), String> {
        let place = self.places.lock().unwrap().get(&hex(&device)).cloned();
        let (addrs, relay) = match (&place, &invite) {
            (Some(place), _) => (place.addrs.clone(), place.relay.clone()),
            (None, Some(invite)) => (invite.addrs.clone(), invite.relay.clone()),
            (None, None) => (Vec::new(), None),
        };
        let id = PublicKey::from_bytes(&device).map_err(|_| "公钥不对")?;
        let relay = relay.and_then(|relay| relay.relay_url().ok());
        let addr = EndpointAddr {
            id,
            addrs: addrs
                .into_iter()
                .map(TransportAddr::Ip)
                .chain(relay.map(TransportAddr::Relay))
                .collect(),
        };
        let conn = tokio::time::timeout(DIAL_TIMEOUT, self.endpoint.connect(addr, wire::ALPN))
            .await
            .map_err(|_| "连不上".to_string())?
            .map_err(|error| error.to_string())?;
        let (mut send, mut recv) = conn.open_bi().await.map_err(|error| error.to_string())?;
        let share = self.share_id();
        let proof = match &invite {
            Some(invite) => {
                let mut keying = [0u8; 32];
                conn.export_keying_material(&mut keying, wire::PROOF_LABEL, &share)
                    .map_err(|_| "导不出密钥材料".to_string())?;
                Some(frames::proof(&invite.secret, &keying))
            }
            None => None,
        };
        let hello = Hello {
            version: wire::VERSION,
            share,
            roster: self.roster().map_or(0, |roster| roster.version),
            name: self.name.lock().unwrap().clone(),
            proof,
        };
        frames::write_frame(&mut send, kind::HELLO, &frames::encode(&hello))
            .await
            .map_err(|error| error.to_string())?;
        loop {
            // 等管理员确认不设时限：他可能正在想
            let frame = tokio::select! {
                frame = frames::read_frame(&mut recv) => frame,
                _ = conn.closed() => return Err("对方断开了".into()),
            };
            match frame {
                Ok(Some((kind::HELLO, payload))) => {
                    let theirs: Hello = frames::decode(&payload).map_err(|error| error.to_string())?;
                    if theirs.share != share {
                        conn.close(VarInt::from_u32(1), b"wrong share");
                        return Err("对方不是这个共享仓库".into());
                    }
                    let me = self.me;
                    return self.clone().run_link(conn, send, recv, device, me, theirs).await;
                }
                Ok(Some((kind::WAIT, _))) => self.set_state(ShareState::Joining { waiting: true }),
                Ok(Some((kind::ROSTER, payload))) => {
                    if let Ok(roster) = frames::decode::<Roster>(&payload) {
                        self.on_roster(roster, Some(device));
                    }
                }
                Ok(Some((kind::REJECT, payload))) => {
                    let reason: Refusal = frames::decode(&payload).map_err(|error| error.to_string())?;
                    conn.close(VarInt::from_u32(0), b"rejected");
                    if self.roster().is_none() {
                        self.set_state(ShareState::Rejected { reason });
                    }
                    return Err(format!("被拒绝了：{reason:?}"));
                }
                Ok(Some(_)) => continue,
                _ => return Err("对方断开了".into()),
            }
        }
    }

    async fn accept_loop(self: Arc<Self>) {
        while let Some(incoming) = self.endpoint.accept().await {
            let me = self.clone();
            tokio::spawn(async move {
                let Ok(conn) = incoming.await else { return };
                if let Err(error) = me.accept(conn).await {
                    eprintln!("共享仓库：进来的连接：{error}");
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
        let share = self.share_id();
        if hello.version != wire::VERSION {
            refuse(send, &conn, Refusal::Version { theirs: wire::VERSION }).await;
            return Err("版本对不上".into());
        }
        if hello.share != share || self.config.lock().unwrap().removed {
            refuse(send, &conn, Refusal::UnknownShare).await;
            return Err("不是这个共享".into());
        }
        let Some(roster) = self.roster() else {
            refuse(send, &conn, Refusal::UnknownShare).await;
            return Err("我还没加入".into());
        };
        let mine = |roster: u64| Hello {
            version: wire::VERSION,
            share,
            roster,
            name: self.name.lock().unwrap().clone(),
            proof: None,
        };
        if roster.role_of(&device).is_some() {
            frames::write_frame(&mut send, kind::HELLO, &frames::encode(&mine(roster.version)))
                .await
                .map_err(|error| error.to_string())?;
            return self.run_link(conn, send, recv, device, device, hello).await;
        }
        // 不在成员表里：拿着邀请链接来的（证明对得上）等管理员确认
        let secret = self.config.lock().unwrap().invite_secret();
        let mut keying = [0u8; 32];
        conn.export_keying_material(&mut keying, wire::PROOF_LABEL, &share)
            .map_err(|_| "导不出密钥材料".to_string())?;
        let invited = matches!((secret, hello.proof), (Some(secret), Some(proof)) if frames::verify_proof(&secret, &keying, &proof));
        if !invited || self.role_of(&self.me) != Some(Role::Admin) {
            // 以前是成员的（说自己有成员表）：给他看新的成员表，他就知道自己被移出了
            if hello.roster > 0 {
                let _ = frames::write_frame(&mut send, kind::ROSTER, &frames::encode(&roster)).await;
            }
            refuse(send, &conn, Refusal::NotMember).await;
            return Err("不是成员".into());
        }
        frames::write_frame(&mut send, kind::WAIT, &[])
            .await
            .map_err(|error| error.to_string())?;
        let (tx, rx) = oneshot::channel();
        let request = self.next_request.fetch_add(1, Ordering::SeqCst);
        self.requests.lock().unwrap().push(Request {
            request,
            device,
            name: crate::collab::clean_name(&hello.name),
            answer: Some(tx),
        });
        self.sink.changed();
        let answer = tokio::select! {
            answer = rx => answer.ok().flatten(),
            _ = conn.closed() => {
                self.requests.lock().unwrap().retain(|known| known.request != request);
                self.sink.changed();
                return Err("等确认的时候对方走了".into());
            }
        };
        let Some(role) = answer else {
            refuse(send, &conn, Refusal::Declined).await;
            return Ok(());
        };
        let roster = self.admit(device, &crate::collab::clean_name(&hello.name), role)?;
        frames::write_frame(&mut send, kind::HELLO, &frames::encode(&mine(roster.version)))
            .await
            .map_err(|error| error.to_string())?;
        self.run_link(conn, send, recv, device, device, hello).await
    }

    /// 管理员同意了：签一张加上他的成员表、发给连着的人
    fn admit(&self, device: [u8; 32], name: &str, role: Role) -> Result<Roster, String> {
        let roster = {
            let mut config = self.config.lock().unwrap();
            let current = config.roster().ok_or("没有成员表")?;
            let roster = current.amended(&self.key, |members| {
                members.retain(|member| member.id != device);
                members.push(Member {
                    id: device,
                    name: name.to_string(),
                    role,
                });
            });
            config.set_roster(&roster);
            config.save(&self.dir);
            roster
        };
        self.send_roster(&roster, None);
        self.sink.changed();
        Ok(roster)
    }

    fn set_role(&self, device: &str, role: Option<Role>) -> Result<(), String> {
        self.require_admin()?;
        let id: [u8; 32] = data_encoding::HEXLOWER
            .decode(device.as_bytes())
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or("成员 id 不对")?;
        let roster = {
            let mut config = self.config.lock().unwrap();
            let current = config.roster().ok_or("没有成员表")?;
            let next = current.amended(&self.key, |members| match role {
                Some(role) => {
                    if let Some(member) = members.iter_mut().find(|member| member.id == id) {
                        member.role = role;
                    }
                }
                None => members.retain(|member| member.id != id),
            });
            if !next.members.iter().any(|member| member.role == Role::Admin) {
                return Err("至少要留一位管理员".into());
            }
            config.set_roster(&next);
            config.save(&self.dir);
            next
        };
        self.send_roster(&roster, None);
        self.after_roster(&roster);
        Ok(())
    }

    fn rename_self(&self, name: &str) -> Result<(), String> {
        self.require_admin()?;
        let roster = {
            let mut config = self.config.lock().unwrap();
            let current = config.roster().ok_or("没有成员表")?;
            if current.name_of(&self.me) == Some(name) {
                return Ok(());
            }
            let next = current.amended(&self.key, |members| {
                if let Some(member) = members.iter_mut().find(|member| member.id == self.me) {
                    member.name = name.to_string();
                }
            });
            config.set_roster(&next);
            config.save(&self.dir);
            next
        };
        self.send_roster(&roster, None);
        self.sink.changed();
        Ok(())
    }

    fn send_roster(&self, roster: &Roster, except: Option<[u8; 32]>) {
        let bytes = frames::encode(roster);
        for (device, link) in self.links.lock().unwrap().iter() {
            if Some(*device) != except {
                let _ = link.tx.send((kind::ROSTER, bytes.clone()));
            }
        }
    }

    /// 别人发来的成员表：比手里的新、签名对才换上
    fn on_roster(&self, roster: Roster, from: Option<[u8; 32]>) {
        let accepted = {
            let mut config = self.config.lock().unwrap();
            let ok = match config.roster() {
                Some(current) => current.accepts(&roster),
                None => config
                    .joining
                    .as_deref()
                    .and_then(|link| ShareInvite::parse(link).ok())
                    .is_some_and(|invite| first_roster_ok(&roster, &config.share_id(), &invite.inviter, &self.me)),
            };
            if ok {
                config.set_roster(&roster);
                if roster.role_of(&self.me).is_some() {
                    config.joining = None;
                } else {
                    config.removed = true;
                }
                config.save(&self.dir);
            }
            ok
        };
        if !accepted {
            return;
        }
        if roster.role_of(&self.me).is_none() {
            self.set_state(ShareState::Removed);
            for link in self.links.lock().unwrap().values() {
                link.conn.close(VarInt::from_u32(2), b"removed");
            }
            return;
        }
        if !matches!(*self.state.lock().unwrap(), ShareState::Ready) {
            self.set_state(ShareState::Ready);
            self.wake.notify_one();
        }
        self.send_roster(&roster, from);
        self.after_roster(&roster);
        self.redial.notify_one();
    }

    /// 成员表换了：移出的人断开。等一会儿再断 —— 新的成员表刚交给发送任务，马上断的话他可能收不到，
    /// 就不知道自己被移出了（他自己收到了也会断）
    fn after_roster(&self, roster: &Roster) {
        let removed: Vec<Connection> = self
            .links
            .lock()
            .unwrap()
            .iter()
            .filter(|(device, _)| roster.role_of(device).is_none())
            .map(|(_, link)| link.conn.clone())
            .collect();
        if !removed.is_empty() {
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                for conn in removed {
                    conn.close(VarInt::from_u32(2), b"removed");
                }
            });
        }
        self.sink.changed();
    }

    fn remember_place(&self, device: [u8; 32], place: Where) {
        let place = Place {
            addrs: crate::collab::reach::link_addrs(place.addrs),
            relay: place.relay,
        };
        let mut places = self.places.lock().unwrap();
        if places.get(&hex(&device)) == Some(&place) {
            return;
        }
        places.insert(hex(&device), place);
        if let Ok(text) = serde_json::to_string_pretty(&*places) {
            let _ = fsio::write_atomic(&self.dir.join("places.json"), &text);
        }
    }

    /// 握手完了的一条连接：对账、收发，直到断开
    async fn run_link(
        self: Arc<Self>,
        conn: Connection,
        send: SendStream,
        mut recv: RecvStream,
        device: [u8; 32],
        dialer: [u8; 32],
        theirs: Hello,
    ) -> Result<(), String> {
        let (tx, _writer) = crate::collab::spawn_writer(send);
        let serial = self.serial.fetch_add(1, Ordering::SeqCst);
        {
            let mut links = self.links.lock().unwrap();
            if let Some(existing) = links.get(&device) {
                // 两边同时互拨：留拨号一方公钥小的那条（两边挑的一样）。同一边拨的（断了重连）留新的
                let preferred = self.me.min(device);
                let keep_new = existing.dialer == dialer || dialer == preferred;
                if !keep_new {
                    conn.close(VarInt::from_u32(3), b"duplicate");
                    return Ok(());
                }
                existing.conn.close(VarInt::from_u32(3), b"duplicate");
            }
            links.insert(
                device,
                Link {
                    serial,
                    conn: conn.clone(),
                    tx: tx.clone(),
                    dialer,
                },
            );
        }
        self.sink.changed();
        if let Some(roster) = self.roster() {
            if roster.version > theirs.roster {
                let _ = tx.send((kind::ROSTER, frames::encode(&roster)));
            }
        }
        let _ = tx.send((kind::WHERE, frames::encode(&self.where_am_i())));
        let summary = self.replica.lock().unwrap().summary();
        let _ = tx.send((kind::SUMMARY, frames::encode(&summary)));
        let blobs = tokio::spawn(self.clone().serve_blobs(conn.clone()));
        let cursors = tokio::spawn(self.clone().read_cursors(conn.clone(), device));
        loop {
            let frame = tokio::select! {
                frame = frames::read_frame(&mut recv) => frame,
                _ = conn.closed() => break,
            };
            let Ok(Some((frame_kind, payload))) = frame else { break };
            match frame_kind {
                kind::ROSTER => {
                    if let Ok(roster) = frames::decode::<Roster>(&payload) {
                        self.on_roster(roster, Some(device));
                    }
                }
                kind::SUMMARY => {
                    if let Ok(summary) = frames::decode::<Summary>(&payload) {
                        let answers = self.replica.lock().unwrap().answer(&summary);
                        for update in answers {
                            let message = UpdateMsg {
                                target: update.target.wire().to_string(),
                                bytes: update.bytes,
                            };
                            let _ = tx.send((kind::UPDATE, frames::encode(&message)));
                        }
                    }
                }
                kind::UPDATE => {
                    if let Ok(message) = frames::decode::<UpdateMsg>(&payload) {
                        self.on_update(device, message);
                    }
                }
                kind::WHERE => {
                    if let Ok(place) = frames::decode::<Where>(&payload) {
                        self.remember_place(device, place);
                    }
                }
                _ => {}
            }
            if self.stopped.load(Ordering::SeqCst) {
                break;
            }
        }
        blobs.abort();
        cursors.abort();
        {
            let mut links = self.links.lock().unwrap();
            if links.get(&device).is_some_and(|link| link.serial == serial) {
                links.remove(&device);
            }
        }
        self.sink.changed();
        // 断了：过几秒就重拨（对方只是重启、换了网络的话很快能接上；被移出的话重拨时就知道了）
        if !self.stopped.load(Ordering::SeqCst) {
            let me = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(REDIAL_AFTER).await;
                me.redial.notify_one();
            });
        }
        Ok(())
    }

    /// 别人的改动：只收可编辑以上的成员发来的；带来了新东西才转给别人、写盘、推给前端
    fn on_update(&self, from: [u8; 32], message: UpdateMsg) {
        if !self.role_of(&from).is_some_and(Role::can_edit) {
            return;
        }
        let Some(target) = Target::from_wire(&message.target) else { return };
        let changed = match self.replica.lock().unwrap().import(&target, &message.bytes) {
            Ok(changed) => changed,
            Err(error) => {
                eprintln!("共享仓库：收到的改动读不进来：{error}");
                false
            }
        };
        if !changed {
            return;
        }
        let update = Update {
            target: target.clone(),
            bytes: message.bytes,
        };
        self.broadcast(std::slice::from_ref(&update), Some(from));
        {
            let mut bridge = self.bridge.lock().unwrap();
            match &target {
                Target::Vault => bridge.schedule_vault(Instant::now()),
                Target::Doc(id) => bridge.schedule_write(id, Instant::now()),
            }
        }
        self.to_frontend(std::slice::from_ref(&update));
        self.wake.notify_one();
    }

    async fn read_cursors(self: Arc<Self>, conn: Connection, from: [u8; 32]) {
        while let Ok(datagram) = conn.read_datagram().await {
            if let Some((doc, payload)) = wire::untag_cursor(&datagram) {
                if self.open.lock().unwrap().contains(doc) {
                    self.sink.cursor(doc, &hex(&from), payload);
                }
            }
        }
    }

    /* ---------------- 附件 ---------------- */

    async fn serve_blobs(self: Arc<Self>, conn: Connection) {
        while let Ok((mut send, mut recv)) = conn.accept_bi().await {
            let me = self.clone();
            tokio::spawn(async move {
                let Ok(Some((kind::WANT, payload))) = frames::read_frame(&mut recv).await else { return };
                let hash = String::from_utf8_lossy(&payload).into_owned();
                let path = me.bridge.lock().unwrap().file_with_hash(&hash);
                let bytes = match path {
                    Some(path) => tokio::task::spawn_blocking(move || std::fs::read(path).ok())
                        .await
                        .ok()
                        .flatten()
                        .filter(|bytes| hash_of(bytes) == hash),
                    None => None,
                };
                let _ = match bytes {
                    Some(bytes) => frames::write_frame(&mut send, kind::BLOB, &bytes).await,
                    None => frames::write_frame(&mut send, kind::NOPE, &[]).await,
                };
                let _ = send.finish();
                let _ = tokio::time::timeout(Duration::from_secs(5), send.stopped()).await;
            });
        }
    }

    /// 附件清单里有、本机没有的：挨个问连着的成员要
    async fn fetch_file(self: Arc<Self>, path: String, hash: String) {
        let conns: Vec<Connection> = self.links.lock().unwrap().values().map(|link| link.conn.clone()).collect();
        for conn in conns {
            let Ok((mut send, mut recv)) = conn.open_bi().await else { continue };
            if frames::write_frame(&mut send, kind::WANT, hash.as_bytes()).await.is_err() {
                continue;
            }
            let _ = send.finish();
            let reply = tokio::time::timeout(BLOB_TIMEOUT, frames::read_frame_up_to(&mut recv, frames::MAX_ATTACH_FRAME)).await;
            if let Ok(Ok(Some((kind::BLOB, bytes)))) = reply {
                let me = self.clone();
                let (file, sum) = (path.clone(), hash.clone());
                let stored = tokio::task::spawn_blocking(move || me.bridge.lock().unwrap().store_file(&file, &sum, &bytes))
                    .await
                    .unwrap_or(false);
                if stored {
                    self.fetching.lock().unwrap().remove(&path);
                    return;
                }
            }
        }
        self.fetch_failed.lock().unwrap().insert(path.clone(), Instant::now());
        self.fetching.lock().unwrap().remove(&path);
    }
}
