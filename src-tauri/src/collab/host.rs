/* ============================================================
主持人（docs/协同编辑.md §5.4、§7.3、§8.2）。

- 有人连进来：控制流上读 Hello，核对会话 id、协议版本、邀请证明 → 问主持人（JoinRequest）
  → Welcome 或 Reject。这次会话里允许过的人断线重连不再问，还是原来的成员号和权限；
  「记住」过的人（设计 §8.2，按公钥记在 config.json）也不问，链接和证明照样要对
- 星形转发：访客的更新交给前端，同时转给其他访客。Loro 的更新可以原样转发，重复收到也没关系
- 只读成员的更新直接丢（光标照转，同步请求照回）
- 踢人：发 Kick、断开，这次会话里拉黑这把公钥
- 「重置邀请链接」换掉邀请密钥：旧链接作废，已经在里面的人不受影响
- 分享前自检（reach.rs）：开始协作就要端口映射、看公网 IPv6、连中继，变了就报，邀请链接跟着更新
- 回连（设计 §8.4）：访客连不进来、自己能被连时发回连链接，主持人往访客那边拨。连上以后角色不变：
  访客照样开控制流发 Hello（而且必须带邀请证明），主持人照样确认。断了主持人接着往回拨
- 「附近」（设计 §8.3）：从局域网列表里点进来的没有链接，Hello 里会话 id 是全 0、不带证明。照样问主持人
- 慢的访客（§5.4）：发给每位访客的文档流自己排队（queue.rs），积压了换成一次补齐
- 附件（§7.2）：访客开的附件流，要文件 / 传粘贴的文件。主持人这边只转成事件交给命令层
  （读仓库、查「正文里引用了没有」都在那边），等它回话
- 落盘（record.rs）：会话 id、邀请密钥、允许过谁、端口一变就写；继续上次的协作时照它重新起来
============================================================ */

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use iroh::endpoint::{Connection, ConnectionError, RecvStream, SendStream, VarInt};
use iroh::{Endpoint, SecretKey, TransportAddr};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::endpoint::{self, Bound};
use super::protocol::{
    self, kind, AttachPut, Forward, ForwardStream, Hello, Member, Permission, Reject, RejectReason,
    Welcome,
};
use super::queue::{spawn_queue_writer, DocQueue};
use super::reach::{self, Mapper};
use super::record::{self, ApprovedRecord, HostRecord, Role};
use super::relays::{self, Pins, Relay};
use super::{
    clean_name, spawn_writer, AttachReply, Callback, Control, EndReason, Event, Events, Invite,
    MemberInfo, Status, SyncKind,
};

/// 握手每一步最多等多久（主持人确认不算）
const HANDSHAKE: Duration = Duration::from_secs(10);
const HOST_MEMBER: u16 = 0;
/// 按回连链接拨一次最多等多久
const DIAL_BACK: Duration = Duration::from_secs(10);
/// 回连上的人断了以后，往回拨的间隔（1、2、4、8 秒……）和最多拨多久（对方关了 Odea 就别一直拨）
const DIAL_BACK_BACKOFF: Duration = Duration::from_secs(8);
const DIAL_BACK_GIVE_UP: Duration = Duration::from_secs(10 * 60);
/// 附件请求等命令层回话最多等多久（读一个 50MB 的文件也够了）
const ATTACH_ANSWER: Duration = Duration::from_secs(30);
/// 一位访客同时最多开几条附件流（一篇里几十张图也是排着要）
const ATTACH_STREAMS: u32 = 8;

pub struct HostOptions {
    pub secret_key: SecretKey,
    pub name: String,
    pub title: String,
    /// 邀请链接里默认的权限
    pub permission: Permission,
    /// 局域网广播（单测里关掉）
    pub mdns: bool,
    /// 自己配的中继（空的话一台都不连）
    pub relays: Vec<Relay>,
    /// 问路由器要公网端口（单测里关掉：不去碰本机的路由器）
    pub portmap: bool,
    /// 查 Windows 防火墙放不放行（单测里关掉）
    pub firewall: bool,
    /// 主持的是哪篇笔记（前端的笔记 id，只是记进落盘的记录里）
    pub note: String,
    /// 落盘到哪个目录（应用数据目录的 collab/）；None 就不落盘
    pub record: Option<PathBuf>,
    /// 继续上次的协作：照这份记录重新起来（同一个会话 id、邀请密钥、端口，允许过的人不再问）
    pub resume: Option<HostRecord>,
    /// 「记住」的人（设计 §8.2）：拿着这次的链接、或者从「附近」进来时不问，权限照记住的。
    /// 链接、证明照样要对：记住的是人，不是让旧链接一直有效
    pub trusted: HashMap<[u8; 32], Permission>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow(Permission),
    Reject,
}

pub struct Host {
    shared: Arc<Shared>,
    endpoint: Endpoint,
    _mdns: Option<iroh_mdns_address_lookup::MdnsAddressLookup>,
    mapper: Option<Mapper>,
    pins: Pins,
    tasks: Vec<JoinHandle<()>>,
}

struct Shared {
    events: Events,
    session: [u8; 16],
    id: [u8; 32],
    permission: Permission,
    relays: Vec<Relay>,
    endpoint: Endpoint,
    note: String,
    record: Option<PathBuf>,
    state: Mutex<State>,
}

struct State {
    secret: [u8; 32],
    /// 主持人自己的名字（协作中途能改，Host::set_name）
    name: String,
    title: String,
    next_member: u16,
    next_request: u32,
    members: BTreeMap<u16, Slot>,
    pending: HashMap<u32, oneshot::Sender<Decision>>,
    /// 这次会话里允许过的人：公钥 → 成员号、权限
    approved: HashMap<[u8; 32], (u16, Permission)>,
    banned: HashSet<[u8; 32]>,
    /// 记住的人：公钥 → 进来时给的权限（HostOptions::trusted，会话中途记住、忘掉跟着改）
    trusted: HashMap<[u8; 32], Permission>,
    ended: bool,
    /// 每接上一条连接加一：同一个人重连时，旧连接收尾不能把新的那条摘掉
    generation: u64,
    /// 正在按回连链接拨的人（公钥）：同一个链接点两次不拨两遍
    dialing: HashSet<[u8; 32]>,
    dial_tasks: Vec<JoinHandle<()>>,
    next_attach: u32,
    /// 附件请求：等命令层回话
    attach_pending: HashMap<u32, oneshot::Sender<Result<AttachReply, String>>>,
    /// 经访客转发的人，允许以后等转发那位开他的文档流：(转发那位的成员号, 他的公钥) → 交给 serve_forwarded
    forward_docs: HashMap<(u16, [u8; 32]), oneshot::Sender<(SendStream, RecvStream)>>,
}

struct Slot {
    id: [u8; 32],
    name: String,
    permission: Permission,
    route: Route,
    doc: Arc<DocQueue>,
    control: mpsc::UnboundedSender<(u8, Vec<u8>)>,
    writers: Vec<JoinHandle<()>>,
    generation: u64,
}

/// 一位成员是怎么连着的：自己连上来的，或者经另一位访客转发的（设计 §20.9）
#[derive(Clone)]
enum Route {
    Direct(Connection),
    /// 转发他的那位访客的成员号和连接：他的流都开在这条连接上，数据报包一层再发
    Via { member: u16, conn: Connection },
}

impl Route {
    #[cfg(test)]
    fn conn(&self) -> &Connection {
        match self {
            Route::Direct(conn) | Route::Via { conn, .. } => conn,
        }
    }

    fn via(&self) -> Option<u16> {
        match self {
            Route::Direct(_) => None,
            Route::Via { member, .. } => Some(*member),
        }
    }

    /// 发给成员 to 的数据报（已经带好了是谁的光标）
    fn send_datagram(&self, to: u16, datagram: &Bytes) {
        let _ = match self {
            Route::Direct(conn) => conn.send_datagram(datagram.clone()),
            Route::Via { conn, .. } => {
                conn.send_datagram(Bytes::from(protocol::wrap_forwarded(to, datagram)))
            }
        };
    }

    /// 断开这一位：自己连上来的关连接；转发的只能不再给他东西（连接是转发那位的），
    /// 他那边读到 Kick / 流结束自己会走
    fn close(&self, code: u32, reason: &[u8]) {
        if let Route::Direct(conn) = self {
            conn.close(VarInt::from_u32(code), reason);
        }
    }
}

/// 一位访客走了（断开、被移出、被新的连接顶掉、主持人停了）：文档流的写手把排着的写完就收尾。
/// 不关的话写手一直等在空队列上，攥着那条流 —— 连接、端口都放不掉
impl Drop for Slot {
    fn drop(&mut self) {
        self.doc.close();
    }
}

impl Host {
    /// 开始协作：起端点、等人来，同时查能不能被连进来（Reach 事件）。要在 tokio 运行时里调
    pub async fn start(options: HostOptions, events: Events) -> Result<Host, String> {
        let resume = options.resume.as_ref();
        let Bound {
            endpoint,
            mdns,
            pins,
        } = endpoint::bind(
            options.secret_key,
            Some(&options.name),
            options.mdns,
            &options.relays,
            resume.map_or(&[][..], |record| &record.ports),
        )
        .await?;
        // 继续上次的：会话 id、邀请密钥、允许过谁、拉黑了谁都照旧
        let session = resume
            .and_then(HostRecord::session_bytes)
            .unwrap_or_else(endpoint::random);
        let secret = resume
            .and_then(HostRecord::secret_bytes)
            .unwrap_or_else(endpoint::random);
        let approved: HashMap<[u8; 32], (u16, Permission)> = resume
            .map(|record| {
                record
                    .approved
                    .iter()
                    .filter_map(|item| {
                        Some((record::hex_array(&item.id)?, (item.member, item.permission)))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let banned: HashSet<[u8; 32]> = resume
            .map(|record| {
                record
                    .banned
                    .iter()
                    .filter_map(|id| record::hex_array(id))
                    .collect()
            })
            .unwrap_or_default();
        let next_member = resume
            .map(|record| {
                record.next_member.max(
                    approved
                        .values()
                        .map(|(member, _)| member + 1)
                        .max()
                        .unwrap_or(1),
                )
            })
            .unwrap_or(1);
        let shared = Arc::new(Shared {
            events,
            session,
            id: *endpoint.id().as_bytes(),
            permission: options.permission,
            relays: options.relays,
            endpoint: endpoint.clone(),
            note: options.note,
            record: options.record,
            state: Mutex::new(State {
                secret,
                name: clean_name(&options.name),
                title: options.title,
                next_member,
                next_request: 1,
                members: BTreeMap::new(),
                pending: HashMap::new(),
                approved,
                banned,
                trusted: options.trusted,
                ended: false,
                generation: 0,
                dialing: HashSet::new(),
                dial_tasks: Vec::new(),
                next_attach: 1,
                attach_pending: HashMap::new(),
                forward_docs: HashMap::new(),
            }),
        });
        persist(&shared);
        let accept = {
            let shared = shared.clone();
            let endpoint = endpoint.clone();
            tokio::spawn(async move {
                while let Some(incoming) = endpoint.accept().await {
                    let shared = shared.clone();
                    tokio::spawn(async move {
                        let result = match incoming.await {
                            Ok(conn) => serve(shared, conn, false).await.map(|_| ()),
                            Err(error) => Err(error.to_string()),
                        };
                        if let Err(error) = result {
                            eprintln!("协作：接入失败：{error}");
                        }
                    });
                }
            })
        };
        let mapper = options.portmap.then(|| Mapper::start(&endpoint));
        let (firewall, firewall_task) = match options.firewall {
            true => {
                let (state, task) = super::firewall::watch();
                (Some(state), Some(task))
            }
            false => (None, None),
        };
        let watch = {
            let shared = shared.clone();
            reach::watch_reach(
                endpoint.clone(),
                mapper.as_ref().map(Mapper::state),
                firewall,
                shared.relays.clone(),
                move |reach| {
                    let link = invite_of(&shared).to_link();
                    let _ = shared.events.send(Event::Control(Control::Reach {
                        reach,
                        link: Some(link),
                    }));
                },
            )
        };
        Ok(Host {
            shared,
            endpoint,
            _mdns: mdns,
            mapper,
            pins,
            tasks: [accept, watch].into_iter().chain(firewall_task).collect(),
        })
    }

    /// 现在的邀请链接（地址每次现取：换了网络、端口映射到了都是新的）
    pub fn invite(&self) -> Invite {
        invite_of(&self.shared)
    }

    /// 换掉邀请密钥：旧链接作废，已经在里面的人不受影响
    pub fn reset_invite(&self) -> Invite {
        self.shared.state.lock().unwrap().secret = endpoint::random();
        persist(&self.shared);
        self.invite()
    }

    /// 命令层对附件请求的回话（AttachGet / AttachPut 事件）。请求已经不在了（超时、对方走了）返回 false
    pub fn answer_attachment(&self, request: u32, reply: Result<AttachReply, String>) -> bool {
        let sender = self
            .shared
            .state
            .lock()
            .unwrap()
            .attach_pending
            .remove(&request);
        sender.is_some_and(|sender| sender.send(reply).is_ok())
    }

    /// 按回连链接往访客那边拨（设计 §8.4）。马上返回；拨的结果是 DialBack 事件，
    /// 拨通了接着就是那位的加入请求（照样要主持人确认）
    pub fn dial_back(&self, callback: Callback) -> Result<(), String> {
        if callback.session != self.shared.session {
            return Err(
                "这个回连链接不是这一次协作的（可能是上一次的），让对方用这次的邀请链接再生成一个"
                    .into(),
            );
        }
        if callback.guest == self.shared.id {
            return Err("这是你自己的回连链接".into());
        }
        let mut state = self.shared.state.lock().unwrap();
        if state.banned.contains(&callback.guest) {
            return Err("这个人已经被移出了这次协作".into());
        }
        // 已经在拨、或者已经连着了：不拨第二遍
        if !state.dialing.insert(callback.guest) {
            return Ok(());
        }
        let task = tokio::spawn(dial_back(self.shared.clone(), self.pins.clone(), callback));
        state.dial_tasks.push(task);
        Ok(())
    }

    pub fn id(&self) -> String {
        endpoint::id_text(&self.shared.id)
    }

    /// 端点绑在哪些本机地址上（单测拿它拼本机回环的链接）
    #[cfg(test)]
    pub fn bound_sockets(&self) -> Vec<std::net::SocketAddr> {
        self.endpoint.bound_sockets()
    }

    /// 默认配置下一台中继都没连（设计 §5.2：代码里不出现 n0 的中继，测试守着）
    #[cfg(test)]
    pub fn relays_disabled(&self) -> bool {
        use iroh::Watcher;
        if !self.shared.relays.is_empty() {
            return false;
        }
        self.endpoint
            .addr()
            .addrs
            .iter()
            .all(|addr| !matches!(addr, iroh::TransportAddr::Relay(_)))
            && self.endpoint.home_relay_status().get().is_empty()
    }

    /// 单测：主持人那台崩了 —— 端点没了，谁都没告诉，落盘的记录留着。真崩的话进程一退端口就空出来了；
    /// 这里别的任务还拿着端点，等端口真的空出来再返回（重启的那个要绑回去）
    #[cfg(test)]
    pub async fn crash(self) {
        let ports = endpoint::ports(&self.endpoint);
        for task in self.tasks {
            task.abort();
        }
        let (slots, dial_tasks) = {
            let mut state = self.shared.state.lock().unwrap();
            state.ended = true;
            (
                std::mem::take(&mut state.members),
                std::mem::take(&mut state.dial_tasks),
            )
        };
        for task in dial_tasks {
            task.abort();
        }
        for (_, slot) in slots {
            slot.route.conn().close(VarInt::from_u32(9), b"crash");
        }
        self.endpoint.close().await;
        drop(self.endpoint);
        drop(self.shared);
        let free = |port: u16, v6: bool| {
            if v6 {
                std::net::UdpSocket::bind((std::net::Ipv6Addr::UNSPECIFIED, port)).is_ok()
            } else {
                std::net::UdpSocket::bind((std::net::Ipv4Addr::UNSPECIFIED, port)).is_ok()
            }
        };
        for _ in 0..50 {
            let v4 = ports.first().is_none_or(|port| free(*port, false));
            let v6 = ports.get(1).is_none_or(|port| free(*port, true));
            if v4 && v6 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// 单测：模拟网络断了一下（掐掉连接，不拉黑）
    #[cfg(test)]
    pub fn drop_connection(&self, member: u16) {
        if let Some(slot) = self.shared.state.lock().unwrap().members.get(&member) {
            slot.route.conn().close(VarInt::from_u32(9), b"network");
        }
    }

    pub fn members(&self) -> Vec<MemberInfo> {
        members_of(&self.shared, &self.shared.state.lock().unwrap())
    }

    /// 主持人对加入请求的回答。请求已经不在了（对方走了）返回 false
    pub fn answer(&self, request: u32, decision: Decision) -> bool {
        let sender = self.shared.state.lock().unwrap().pending.remove(&request);
        sender.is_some_and(|sender| sender.send(decision).is_ok())
    }

    /// 主持人改了名字：成员表里换掉、告诉每位访客，「附近」广播的昵称也换
    pub fn set_name(&self, name: &str) {
        if name.trim().is_empty() {
            return;
        }
        let name = clean_name(name);
        self.shared.state.lock().unwrap().name = name.clone();
        // 广播里只有昵称，超长的截掉（和 endpoint::bind 一样）
        let advertised: String = name.chars().take(40).collect();
        if let Ok(data) = iroh::address_lookup::UserData::try_from(advertised) {
            self.endpoint.set_user_data_for_address_lookup(Some(data));
        }
        broadcast_members(&self.shared);
    }

    pub fn set_title(&self, title: String) {
        self.shared.state.lock().unwrap().title = title;
        persist(&self.shared);
    }

    pub fn set_permission(&self, member: u16, permission: Permission) {
        {
            let mut state = self.shared.state.lock().unwrap();
            let Some(slot) = state.members.get_mut(&member) else {
                return;
            };
            slot.permission = permission;
            let id = slot.id;
            let _ = slot
                .control
                .send((kind::PERMISSION, protocol::encode(&permission)));
            if let Some(entry) = state.approved.get_mut(&id) {
                entry.1 = permission;
            }
        }
        persist(&self.shared);
        broadcast_members(&self.shared);
    }

    /// 记住一个人（下次不问，按这个权限进来）；会话里接着就按这个来。存进 config.json 在命令层
    pub fn trust(&self, id: [u8; 32], permission: Permission) {
        self.shared
            .state
            .lock()
            .unwrap()
            .trusted
            .insert(id, permission);
    }

    /// 不再记住：下次进来照样问 —— 这次会话里也是：「允许过、重连不问」一起清掉（不然他离开再回来，
    /// 主持人刚点了忘掉，却又没问就进来了）。人还在的不受影响
    pub fn forget(&self, id: &[u8; 32]) {
        {
            let mut state = self.shared.state.lock().unwrap();
            state.trusted.remove(id);
            state.approved.remove(id);
        }
        persist(&self.shared);
    }

    /// 移出：发 Kick、断开，这次会话里不让他再进；记住过的也忘掉。返回被移出的人的公钥
    ///
    /// 刚允许、Welcome 已经发出去但文档流还没接上的人也算（按公钥拉黑，接上时 serve 里再查一遍）
    pub fn kick(&self, member: u16) -> Option<[u8; 32]> {
        let (id, slot) = {
            let mut state = self.shared.state.lock().unwrap();
            let id = state.members.get(&member).map(|slot| slot.id).or_else(|| {
                state
                    .approved
                    .iter()
                    .find(|(_, (approved, _))| *approved == member)
                    .map(|(id, _)| *id)
            })?;
            state.banned.insert(id);
            state.approved.remove(&id);
            state.trusted.remove(&id);
            (id, state.members.remove(&member))
        };
        persist(&self.shared);
        if let Some(slot) = slot {
            broadcast_members(&self.shared);
            send_kick(slot.control.clone(), slot.route.clone());
        }
        Some(id)
    }

    /// 自己的文档更新：发给所有访客
    pub fn send_update(&self, bytes: Vec<u8>) {
        let state = self.shared.state.lock().unwrap();
        for slot in state.members.values() {
            slot.doc.push(kind::UPDATE, bytes.clone());
        }
    }

    /// 自己的光标：数据报，丢了不补
    pub fn send_cursor(&self, payload: &[u8]) {
        let datagram = Bytes::from(protocol::tag_cursor(HOST_MEMBER, payload));
        let state = self.shared.state.lock().unwrap();
        for (member, slot) in &state.members {
            slot.route.send_datagram(*member, &datagram);
        }
    }

    pub fn send_sync(&self, to: u16, kind: SyncKind, bytes: Vec<u8>) {
        let state = self.shared.state.lock().unwrap();
        if let Some(slot) = state.members.get(&to) {
            slot.doc.push(kind.frame(), bytes);
        }
    }

    /// 停止协作：告诉每个人（Bye），等他们收到，关端点
    pub async fn stop(self) {
        let (slots, pending, dial_tasks) = {
            let mut state = self.shared.state.lock().unwrap();
            state.ended = true;
            state.attach_pending.clear();
            (
                std::mem::take(&mut state.members),
                std::mem::take(&mut state.pending),
                std::mem::take(&mut state.dial_tasks),
            )
        };
        // 正常结束：落盘的那一套删掉（重启后不再问「继续上次的协作」）
        if let Some(dir) = &self.shared.record {
            record::remove(dir, Role::Host);
        }
        for task in dial_tasks {
            task.abort();
        }
        for sender in pending.into_values() {
            let _ = sender.send(Decision::Reject);
        }
        let mut writers = Vec::new();
        for (_, mut slot) in slots {
            let _ = slot.control.send((kind::BYE, Vec::new()));
            writers.append(&mut slot.writers);
            // slot 一丢：文档流的队列关掉、控制流的发送端没了，写手把排着的写完、把流收尾
        }
        let _ = tokio::time::timeout(Duration::from_secs(1), async {
            for writer in writers {
                let _ = writer.await;
            }
        })
        .await;
        for task in self.tasks {
            task.abort();
        }
        // 端口映射还给路由器
        if let Some(mapper) = self.mapper {
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

/// 一条连接怎么结束的：按回连链接拨的那边据此决定要不要再拨
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Served {
    /// 走了、被拒、被移出、协作停了、换成了另一条连接：不用再拨
    Gone,
    /// 网络断了
    Lost,
}

/// 一位访客从连进来到离开。dialed = 主持人按回连链接拨过去的（这样的必须带邀请证明：
/// 回连链接谁都能伪造，不能凭它让陌生人出现在加入请求里）
async fn serve(shared: Arc<Shared>, conn: Connection, dialed: bool) -> Result<Served, String> {
    let id = *conn.remote_id().as_bytes();
    let (mut control_send, mut control_recv) = tokio::time::timeout(HANDSHAKE, conn.accept_bi())
        .await
        .map_err(|_| "等 Hello 超时".to_string())?
        .map_err(|error| error.to_string())?;
    let hello = match tokio::time::timeout(HANDSHAKE, protocol::read_frame(&mut control_recv)).await
    {
        Ok(Ok(Some((kind::HELLO, payload)))) => {
            protocol::decode::<Hello>(&payload).map_err(|error| error.to_string())?
        }
        _ => {
            conn.close(VarInt::from_u32(2), b"no hello");
            return Err("对方没发 Hello".into());
        }
    };
    let mut keying = [0u8; 32];
    conn.export_keying_material(&mut keying, protocol::PROOF_LABEL, &shared.session)
        .map_err(|_| "导不出密钥材料".to_string())?;
    let invited = {
        let state = shared.state.lock().unwrap();
        hello
            .proof
            .map(|proof| protocol::verify_proof(&state.secret, &keying, &proof))
    };
    let knock = Knock {
        id,
        hello: &hello,
        invited,
        dialed,
        via: None,
    };
    let gone = async {
        conn.closed().await;
    };
    let (member, permission, welcome) = match admit(&shared, knock, gone).await {
        Ok(admitted) => admitted,
        Err(Some(reason)) => return reject(Some(&conn), control_send, reason).await,
        Err(None) => return Ok(Served::Gone),
    };
    protocol::write_frame(
        &mut control_send,
        kind::WELCOME,
        &protocol::encode(&welcome),
    )
    .await
    .map_err(|error| error.to_string())?;

    // 访客接着开文档流（先发一个 OPEN 帧）
    let (doc_send, doc_recv) = tokio::time::timeout(HANDSHAKE, conn.accept_bi())
        .await
        .map_err(|_| "等文档流超时".to_string())?
        .map_err(|error| error.to_string())?;
    let route = Route::Direct(conn.clone());
    let Some(generation) = install(
        &shared,
        member,
        id,
        clean_name(&hello.name),
        permission,
        route.clone(),
        doc_send,
        control_send,
    ) else {
        return Ok(Served::Gone);
    };

    let bye = Arc::new(AtomicBool::new(false));
    let readers = [
        tokio::spawn(read_doc(shared.clone(), member, doc_recv)),
        tokio::spawn(read_control(
            shared.clone(),
            member,
            route,
            control_recv,
            bye.clone(),
        )),
        tokio::spawn(read_datagrams(shared.clone(), member, conn.clone())),
        tokio::spawn(accept_streams(shared.clone(), member, conn.clone())),
    ];
    let closed = conn.closed().await;
    for reader in readers {
        reader.abort();
    }
    let removed = uninstall(&shared, member, generation);
    let gone = bye.load(Ordering::SeqCst)
        || !removed
        || matches!(
            closed,
            ConnectionError::ApplicationClosed(_) | ConnectionError::LocallyClosed
        );
    Ok(if gone { Served::Gone } else { Served::Lost })
}

/// 经访客 via 转发来的一位（设计 §20.9）：via 在自己的连接上替他开了控制流（第一帧是 Forward，
/// 带着他的 Hello），之后照样问主持人、发 Welcome；他的文档流、附件流、数据报都从 via 的连接上来
async fn serve_forwarded(
    shared: Arc<Shared>,
    via: u16,
    via_conn: Connection,
    forward: Forward,
    mut control_send: SendStream,
    mut control_recv: RecvStream,
) -> Result<(), String> {
    let Some(hello) = forward.hello else {
        return Err("转发的控制流没带 Hello".into());
    };
    // 转发的那位得是自己连上来的成员（不转第二层），他的权限是这一位的上限
    let forwarder = {
        let state = shared.state.lock().unwrap();
        state
            .members
            .get(&via)
            .filter(|slot| matches!(slot.route, Route::Direct(_)))
            .map(|slot| (slot.name.clone(), slot.permission))
    };
    let Some((via_name, via_permission)) = forwarder else {
        return Err("转发的那位不在了".into());
    };
    let id = forward.id;
    // 证明绑在他和转发那位的连接上，主持人自己核不了：转发的那位核过了才算拿着链接
    let invited = (hello.proof.is_some() && forward.proven).then_some(true);
    let knock = Knock {
        id,
        hello: &hello,
        invited,
        dialed: false,
        via: Some((via, via_name, via_permission)),
    };
    // 等确认的时候他走了：转发的那位的连接断了，或者他那条控制流到头了（Welcome 之前他不会再发东西）
    let gone = async {
        tokio::select! {
            _ = via_conn.closed() => {}
            _ = protocol::read_frame(&mut control_recv) => {}
        }
    };
    let (member, permission, welcome) = match admit(&shared, knock, gone).await {
        Ok(admitted) => admitted,
        Err(Some(reason)) => {
            reject(None, control_send, reason).await?;
            return Ok(());
        }
        Err(None) => return Ok(()),
    };
    // 先登记等他的文档流，再发 Welcome：转发的那位看到 Welcome 才会去开
    let (doc_sender, doc_receiver) = oneshot::channel();
    shared
        .state
        .lock()
        .unwrap()
        .forward_docs
        .insert((via, id), doc_sender);
    protocol::write_frame(
        &mut control_send,
        kind::WELCOME,
        &protocol::encode(&welcome),
    )
    .await
    .map_err(|error| error.to_string())?;
    let doc = tokio::time::timeout(HANDSHAKE, doc_receiver).await;
    shared.state.lock().unwrap().forward_docs.remove(&(via, id));
    let Ok(Ok((doc_send, doc_recv))) = doc else {
        return Err("等转发的文档流超时".into());
    };
    let route = Route::Via {
        member: via,
        conn: via_conn.clone(),
    };
    let Some(generation) = install(
        &shared,
        member,
        id,
        clean_name(&hello.name),
        permission,
        route.clone(),
        doc_send,
        control_send,
    ) else {
        return Ok(());
    };
    let bye = Arc::new(AtomicBool::new(false));
    let doc_reader = tokio::spawn(read_doc(shared.clone(), member, doc_recv));
    tokio::select! {
        _ = read_control(shared.clone(), member, route, control_recv, bye) => {}
        _ = via_conn.closed() => {}
    }
    doc_reader.abort();
    uninstall(&shared, member, generation);
    Ok(())
}

/// 要加入的人：自己连上来的，或者经访客转发来的
struct Knock<'a> {
    id: [u8; 32],
    hello: &'a Hello,
    /// 邀请证明对不对：None = 没带（「附近」点进来的），或者转发的那位核不了
    invited: Option<bool>,
    /// 主持人按回连链接拨过去的（必须带证明）
    dialed: bool,
    /// 转发他的那位：成员号、名字、权限（他的权限不超过这一位的）
    via: Option<(u16, String, Permission)>,
}

/// 查版本、会话、证明、拉黑、允许过没有；要问的问主持人；允许了就登记成员号。
/// 成了返回 (成员号, 权限, 给他的 Welcome)；Err(Some(原因)) 回 Reject，Err(None) 是等确认时他走了
async fn admit(
    shared: &Arc<Shared>,
    knock: Knock<'_>,
    gone: impl std::future::Future<Output = ()>,
) -> Result<(u16, Permission, Welcome), Option<RejectReason>> {
    let Knock {
        id,
        hello,
        invited,
        dialed,
        via,
    } = knock;
    if hello.version != protocol::PROTOCOL_VERSION
        || !protocol::FEATURES
            .iter()
            .all(|feature| hello.features.iter().any(|f| f == feature))
    {
        // 告诉主持人一声（不然对方说连不上、他这边什么都没看到）：对方版本低、或者缺了特性，是对方旧
        let _ = shared.events.send(Event::Control(Control::JoinOutdated {
            name: clean_name(&hello.name),
            guest_older: hello.version <= protocol::PROTOCOL_VERSION,
        }));
        return Err(Some(RejectReason::Version {
            theirs: protocol::PROTOCOL_VERSION,
        }));
    }
    // 从「附近」点进来的：没有链接，不知道会话 id（全 0），也没有证明。照样问主持人
    let nearby = !dialed && hello.proof.is_none() && hello.session == [0; 16];
    if hello.session != shared.session && !nearby {
        return Err(Some(RejectReason::BadInvite));
    }
    let cap = |permission: Permission| match &via {
        Some((_, _, Permission::Read)) => Permission::Read,
        _ => permission,
    };

    // 先看能不能直接放行（重连、记住的人），不能的话登记一个请求问主持人
    enum Next {
        Allow(Option<u16>, Permission),
        Ask(u32, oneshot::Receiver<Decision>, bool),
    }
    let name = clean_name(&hello.name);
    let next = {
        let mut state = shared.state.lock().unwrap();
        if state.ended {
            return Err(Some(RejectReason::Ended));
        } else if invited == Some(false) || (dialed && invited.is_none()) {
            // 带了证明却对不上：链接被重置过，或者不是这次的
            return Err(Some(RejectReason::BadInvite));
        } else if state.banned.contains(&id) {
            return Err(Some(RejectReason::Kicked));
        } else if let Some(&(member, permission)) = state.approved.get(&id) {
            Next::Allow(Some(member), permission)
        } else if let Some(&permission) = state.trusted.get(&id) {
            // 记住的人：不问，新的成员号
            Next::Allow(None, permission)
        } else {
            let request = state.next_request;
            state.next_request += 1;
            let (sender, receiver) = oneshot::channel();
            state.pending.insert(request, sender);
            Next::Ask(request, receiver, invited == Some(true))
        }
    };
    let (reuse, permission) = match next {
        Next::Allow(member, permission) => (member, cap(permission)),
        Next::Ask(request, receiver, invited) => {
            let _ = shared.events.send(Event::Control(Control::JoinRequest {
                request,
                id: endpoint::id_text(&id),
                name: name.clone(),
                invited,
                via: via.as_ref().map(|(_, name, _)| name.clone()),
            }));
            let decision = tokio::select! {
                decision = receiver => decision.unwrap_or(Decision::Reject),
                _ = gone => {
                    shared.state.lock().unwrap().pending.remove(&request);
                    let _ = shared.events.send(Event::Control(Control::JoinCancelled { request }));
                    return Err(None);
                }
            };
            match decision {
                Decision::Reject => {
                    let ended = shared.state.lock().unwrap().ended;
                    return Err(Some(if ended {
                        RejectReason::Ended
                    } else {
                        RejectReason::Declined
                    }));
                }
                Decision::Allow(permission) => (None, cap(permission)),
            }
        }
    };

    // 登记成员号，拼 Welcome
    let mut state = shared.state.lock().unwrap();
    if state.ended {
        return Err(Some(RejectReason::Ended));
    }
    let member = reuse.unwrap_or_else(|| {
        let member = state.next_member;
        state.next_member += 1;
        member
    });
    state.approved.insert(id, (member, permission));
    let mut members: Vec<Member> = wire_members(shared, &state)
        .into_iter()
        .filter(|item| item.member != member)
        .collect();
    members.push(Member {
        member,
        id,
        name,
        permission,
        via: via.as_ref().map(|(via, _, _)| *via),
    });
    members.sort_by_key(|item| item.member);
    let welcome = Welcome {
        member,
        permission,
        title: state.title.clone(),
        members,
    };
    Ok((member, permission, welcome))
}

/// 文档流、控制流都接上了：登记成一位成员（同一个人重连、旧的还没超时就换掉旧的），告诉大家，
/// 叫前端和他同步。协作已经停了、或者 Welcome 之后被踢了返回 None
#[allow(clippy::too_many_arguments)]
fn install(
    shared: &Arc<Shared>,
    member: u16,
    id: [u8; 32],
    name: String,
    permission: Permission,
    route: Route,
    doc_send: SendStream,
    control_send: SendStream,
) -> Option<u64> {
    let doc = Arc::new(DocQueue::default());
    let doc_writer = spawn_queue_writer(doc_send, doc.clone());
    let (control, control_writer) = spawn_writer(control_send);
    let generation = {
        let mut state = shared.state.lock().unwrap();
        if state.ended {
            return None;
        }
        // Welcome 发出去之后、接上之前被踢了
        if state.banned.contains(&id) {
            drop(state);
            send_kick(control, route);
            return None;
        }
        state.generation += 1;
        let generation = state.generation;
        if let Some(old) = state.members.insert(
            member,
            Slot {
                id,
                name,
                permission,
                route,
                doc,
                control,
                writers: vec![doc_writer, control_writer],
                generation,
            },
        ) {
            old.doc.close();
            old.route.close(3, b"replaced");
        }
        generation
    };
    persist(shared);
    broadcast_members(shared);
    let _ = shared.events.send(Event::SyncStart { with: member });
    Some(generation)
}

/// 他走了：还是这一次接上的那个（没被新的连接顶掉）就从成员里拿掉、告诉大家。返回拿掉了没有
fn uninstall(shared: &Shared, member: u16, generation: u64) -> bool {
    let removed = {
        let mut state = shared.state.lock().unwrap();
        let current = state
            .members
            .get(&member)
            .is_some_and(|slot| slot.generation == generation);
        if current {
            state.members.remove(&member);
        }
        current
    };
    if removed {
        broadcast_members(shared);
    }
    removed
}

/// 按回连链接往访客那边拨：拨通了照常 serve；断了（网络）接着往回拨，退避到 8 秒一次，
/// 一直拨不通 10 分钟就算了。第一次就拨不通直接告诉主持人
async fn dial_back(shared: Arc<Shared>, pins: Pins, callback: Callback) {
    // 访客自己的中继：这次会话里临时加进来（会话结束端点一关就没了）
    if let Some(relay) = &callback.relay {
        relays::add_pin(&pins, relay);
        if let (Ok(url), Some(config)) = (relay.relay_url(), relay.config()) {
            shared.endpoint.insert_relay(url, Arc::new(config)).await;
        }
    }
    let mut first = true;
    let mut backoff = Duration::from_secs(1);
    let mut failing_since: Option<Instant> = None;
    let done = |shared: &Shared| {
        shared.state.lock().unwrap().dialing.remove(&callback.guest);
    };
    loop {
        let (ended, banned) = {
            let state = shared.state.lock().unwrap();
            (state.ended, state.banned.contains(&callback.guest))
        };
        if ended || banned {
            return done(&shared);
        }
        let addr =
            match endpoint::dial_addr(&callback.guest, &callback.addrs, callback.relay.as_ref()) {
                Ok(addr) => addr,
                Err(detail) => {
                    let _ = shared.events.send(Event::Control(Control::DialBack {
                        ok: false,
                        detail: Some(detail),
                    }));
                    return done(&shared);
                }
            };
        let attempt =
            tokio::time::timeout(DIAL_BACK, shared.endpoint.connect(addr, protocol::ALPN)).await;
        match attempt {
            Ok(Ok(conn)) => {
                if first {
                    let _ = shared.events.send(Event::Control(Control::DialBack {
                        ok: true,
                        detail: None,
                    }));
                }
                first = false;
                failing_since = None;
                backoff = Duration::from_secs(1);
                match serve(shared.clone(), conn, true).await {
                    Ok(Served::Lost) => {}
                    Ok(Served::Gone) | Err(_) => return done(&shared),
                }
            }
            failed => {
                if first {
                    let detail = match failed {
                        Ok(Err(error)) => format!("拨不通：{error}"),
                        _ => format!("等了 {} 秒还拨不通", DIAL_BACK.as_secs()),
                    };
                    let _ = shared.events.send(Event::Control(Control::DialBack {
                        ok: false,
                        detail: Some(detail),
                    }));
                    return done(&shared);
                }
                let since = *failing_since.get_or_insert_with(Instant::now);
                if since.elapsed() > DIAL_BACK_GIVE_UP {
                    return done(&shared);
                }
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(DIAL_BACK_BACKOFF);
    }
}

/// 文档流：更新交给前端并转给其他访客；同步请求交给前端
async fn read_doc(shared: Arc<Shared>, member: u16, mut recv: RecvStream) {
    while let Ok(Some((frame, payload))) = protocol::read_frame(&mut recv).await {
        match frame {
            kind::UPDATE | kind::SYNC2 => {
                let allowed = shared
                    .state
                    .lock()
                    .unwrap()
                    .members
                    .get(&member)
                    .is_some_and(|slot| slot.permission == Permission::Edit);
                if !allowed {
                    continue;
                }
                forward(&shared, member, &payload);
                let _ = shared.events.send(Event::Update {
                    from: member,
                    bytes: payload,
                });
            }
            kind::SYNC1 => {
                // 不管是不是因为 Resync：之后要给他的更新照常排（这一份 Sync1 的回话里补齐）
                if let Some(slot) = shared.state.lock().unwrap().members.get(&member) {
                    slot.doc.resynced();
                }
                let _ = shared.events.send(Event::SyncRequest {
                    from: member,
                    vector: payload,
                });
            }
            _ => {}
        }
    }
}

/// 一位自己连上来的访客后来开的流：附件请求（一个请求一条），或者他替别人开的转发流（第一帧是
/// Forward，设计 §20.9）。附件转成事件交给命令层，等它回话
async fn accept_streams(shared: Arc<Shared>, member: u16, conn: Connection) {
    let open = Arc::new(std::sync::atomic::AtomicU32::new(0));
    while let Ok((send, mut recv)) = conn.accept_bi().await {
        let shared = shared.clone();
        let open = open.clone();
        let conn = conn.clone();
        tokio::spawn(async move {
            let frame = tokio::time::timeout(
                HANDSHAKE,
                protocol::read_frame_up_to(&mut recv, protocol::MAX_ATTACH_FRAME),
            )
            .await;
            let Ok(Ok(Some((frame_kind, payload)))) = frame else {
                return;
            };
            if frame_kind == kind::FORWARD {
                let Ok(forward) = protocol::decode::<Forward>(&payload) else {
                    return;
                };
                forwarded_stream(&shared, member, conn, forward, send, recv).await;
                return;
            }
            serve_attachment_counted(&shared, member, &open, frame_kind, payload, send).await;
        });
    }
}

/// 访客 via 替别人开的一条流
async fn forwarded_stream(
    shared: &Arc<Shared>,
    via: u16,
    conn: Connection,
    forward: Forward,
    send: SendStream,
    mut recv: RecvStream,
) {
    match forward.stream {
        ForwardStream::Control => {
            if let Err(error) =
                serve_forwarded(shared.clone(), via, conn, forward, send, recv).await
            {
                eprintln!("协作：转发进来的接入失败：{error}");
            }
        }
        ForwardStream::Doc => {
            let waiter = shared
                .state
                .lock()
                .unwrap()
                .forward_docs
                .remove(&(via, forward.id));
            if let Some(waiter) = waiter {
                let _ = waiter.send((send, recv));
            }
        }
        // 他要附件：按他自己的成员号、他自己的权限办（不是转发那位的）
        ForwardStream::Attach => {
            let member = shared
                .state
                .lock()
                .unwrap()
                .members
                .iter()
                .find(|(_, slot)| slot.id == forward.id && slot.route.via() == Some(via))
                .map(|(member, _)| *member);
            let Some(member) = member else { return };
            let frame = tokio::time::timeout(
                HANDSHAKE,
                protocol::read_frame_up_to(&mut recv, protocol::MAX_ATTACH_FRAME),
            )
            .await;
            if let Ok(Ok(Some((frame_kind, payload)))) = frame {
                let open = std::sync::atomic::AtomicU32::new(0);
                serve_attachment_counted(shared, member, &open, frame_kind, payload, send).await;
            }
        }
    }
}

/// 一个附件请求（第一帧已经读出来了）。一位访客同时最多 ATTACH_STREAMS 个
async fn serve_attachment_counted(
    shared: &Shared,
    member: u16,
    open: &std::sync::atomic::AtomicU32,
    frame_kind: u8,
    payload: Vec<u8>,
    mut send: SendStream,
) {
    if open.fetch_add(1, Ordering::SeqCst) >= ATTACH_STREAMS {
        open.fetch_sub(1, Ordering::SeqCst);
        let _ = protocol::write_frame(&mut send, kind::ATTACH_ERR, "同时要的文件太多了".as_bytes())
            .await;
        let _ = send.finish();
        return;
    }
    serve_attachment(shared, member, frame_kind, payload, send).await;
    open.fetch_sub(1, Ordering::SeqCst);
}

async fn serve_attachment(
    shared: &Shared,
    member: u16,
    frame_kind: u8,
    payload: Vec<u8>,
    mut send: SendStream,
) {
    let editable = shared
        .state
        .lock()
        .unwrap()
        .members
        .get(&member)
        .is_some_and(|slot| slot.permission == Permission::Edit);
    let (request, receiver) = {
        let mut state = shared.state.lock().unwrap();
        let request = state.next_attach;
        state.next_attach += 1;
        let (sender, receiver) = oneshot::channel();
        state.attach_pending.insert(request, sender);
        (request, receiver)
    };
    let event = match frame_kind {
        kind::ATTACH_GET => String::from_utf8(payload)
            .ok()
            .map(|path| Event::AttachGet {
                request,
                from: member,
                path,
            }),
        // 只读的人不能往主持人的仓库里放东西
        kind::ATTACH_PUT if editable => {
            protocol::decode::<AttachPut>(&payload)
                .ok()
                .map(|put| Event::AttachPut {
                    request,
                    from: member,
                    name: put.name,
                    bytes: put.bytes,
                })
        }
        kind::ATTACH_PUT => {
            shared.state.lock().unwrap().attach_pending.remove(&request);
            let _ = protocol::write_frame(
                &mut send,
                kind::ATTACH_ERR,
                "你现在是只读的，不能加附件".as_bytes(),
            )
            .await;
            let _ = send.finish();
            return;
        }
        _ => None,
    };
    let Some(event) = event else {
        shared.state.lock().unwrap().attach_pending.remove(&request);
        return;
    };
    let _ = shared.events.send(event);
    let reply = match tokio::time::timeout(ATTACH_ANSWER, receiver).await {
        Ok(Ok(reply)) => reply,
        _ => {
            shared.state.lock().unwrap().attach_pending.remove(&request);
            Err("主持人那边没回话".into())
        }
    };
    let (frame_kind, bytes) = match reply {
        Ok(AttachReply::Data(bytes)) => (kind::ATTACH_DATA, bytes),
        Ok(AttachReply::Link(link)) => (kind::ATTACH_LINK, link.into_bytes()),
        Err(message) => (kind::ATTACH_ERR, message.into_bytes()),
    };
    let _ = protocol::write_frame(&mut send, frame_kind, &bytes).await;
    let _ = send.finish();
    let _ = tokio::time::timeout(Duration::from_secs(5), send.stopped()).await;
}

/// 控制流：访客只会发 Bye、改名。读到头（转发的那一位走了）就返回
async fn read_control(
    shared: Arc<Shared>,
    member: u16,
    route: Route,
    mut recv: RecvStream,
    bye: Arc<AtomicBool>,
) {
    while let Ok(Some((frame, payload))) = protocol::read_frame(&mut recv).await {
        if frame == kind::BYE {
            bye.store(true, Ordering::SeqCst);
            route.close(0, b"bye");
            return;
        }
        // 访客改了名字：换掉成员表里的，告诉大家
        if frame == kind::NAME {
            let raw = String::from_utf8_lossy(&payload);
            let name = clean_name(&raw);
            let changed = {
                let mut state = shared.state.lock().unwrap();
                match state.members.get_mut(&member) {
                    Some(slot) if !raw.trim().is_empty() && slot.name != name => {
                        slot.name = name;
                        true
                    }
                    _ => false,
                }
            };
            if changed {
                broadcast_members(&shared);
            }
        }
    }
}

/// 光标：交给前端，带上成员号转给其他访客。这条连接上转发来的（FF FF 打头）是经他转发的那一位的
async fn read_datagrams(shared: Arc<Shared>, member: u16, conn: Connection) {
    while let Ok(datagram) = conn.read_datagram().await {
        let (from, payload) = match protocol::unwrap_forwarded(&datagram) {
            Some((forwarded, payload)) => {
                let ok = shared
                    .state
                    .lock()
                    .unwrap()
                    .members
                    .get(&forwarded)
                    .is_some_and(|slot| slot.route.via() == Some(member));
                if !ok {
                    continue;
                }
                (forwarded, payload)
            }
            None => (member, &datagram[..]),
        };
        let tagged = Bytes::from(protocol::tag_cursor(from, payload));
        {
            let state = shared.state.lock().unwrap();
            for (other, slot) in &state.members {
                if *other != from {
                    slot.route.send_datagram(*other, &tagged);
                }
            }
        }
        let _ = shared.events.send(Event::Cursor {
            from,
            bytes: payload.to_vec(),
        });
    }
}

/// 发 Kick，给它一点时间送到，再断（转发的那一位读到 Kick 自己走）
fn send_kick(control: mpsc::UnboundedSender<(u8, Vec<u8>)>, route: Route) {
    let _ = control.send((kind::KICK, Vec::new()));
    drop(control);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        route.close(1, b"kicked");
    });
}

fn forward(shared: &Shared, from: u16, payload: &[u8]) {
    let state = shared.state.lock().unwrap();
    for (member, slot) in &state.members {
        if *member != from {
            slot.doc.push(kind::UPDATE, payload.to_vec());
        }
    }
}

/// 落盘：会话 id、邀请密钥、允许过谁、拉黑了谁、端口。有变化就整份重写（几百字节）
fn persist(shared: &Shared) {
    let Some(dir) = &shared.record else { return };
    let record = {
        let state = shared.state.lock().unwrap();
        if state.ended {
            return;
        }
        let mut record =
            HostRecord::new(shared.note.clone(), state.title.clone(), shared.permission);
        record.session = data_encoding::HEXLOWER.encode(&shared.session);
        record.secret = data_encoding::HEXLOWER.encode(&state.secret);
        record.approved = state
            .approved
            .iter()
            .map(|(id, (member, permission))| ApprovedRecord {
                id: endpoint::id_text(id),
                member: *member,
                permission: *permission,
            })
            .collect();
        record.approved.sort_by_key(|item| item.member);
        record.banned = state.banned.iter().map(endpoint::id_text).collect();
        record.next_member = state.next_member;
        record.ports = endpoint::ports(&shared.endpoint);
        record
    };
    if let Err(error) = record::save_json(dir, record::HOST_FILE, &record) {
        eprintln!("协作：会话记录写不进去：{error}");
    }
}

fn members_of(shared: &Shared, state: &State) -> Vec<MemberInfo> {
    let mut members = vec![MemberInfo {
        member: HOST_MEMBER,
        id: endpoint::id_text(&shared.id),
        name: state.name.clone(),
        permission: Permission::Edit,
        host: true,
        via: None,
    }];
    members.extend(state.members.iter().map(|(member, slot)| MemberInfo {
        member: *member,
        id: endpoint::id_text(&slot.id),
        name: slot.name.clone(),
        permission: slot.permission,
        host: false,
        via: slot.route.via(),
    }));
    members
}

/// 发给访客的成员表（主持人在最前）
fn wire_members(shared: &Shared, state: &State) -> Vec<Member> {
    std::iter::once(Member {
        member: HOST_MEMBER,
        id: shared.id,
        name: state.name.clone(),
        permission: Permission::Edit,
        via: None,
    })
    .chain(state.members.iter().map(|(member, slot)| Member {
        member: *member,
        id: slot.id,
        name: slot.name.clone(),
        permission: slot.permission,
        via: slot.route.via(),
    }))
    .collect()
}

/// 成员变了：告诉前端，也告诉每位访客
fn broadcast_members(shared: &Shared) {
    let members = {
        let state = shared.state.lock().unwrap();
        let payload = protocol::encode(&wire_members(shared, &state));
        for slot in state.members.values() {
            let _ = slot.control.send((kind::MEMBERS, payload.clone()));
        }
        members_of(shared, &state)
    };
    let _ = shared
        .events
        .send(Event::Control(Control::Members { members }));
}

/// 现在的邀请链接：地址现取；中继是 iroh 选中的那台（延迟最低的），还没选出来就用配的第一台
fn invite_of(shared: &Shared) -> Invite {
    let addr = shared.endpoint.addr();
    let home: Vec<String> = addr
        .addrs
        .iter()
        .filter_map(|addr| match addr {
            TransportAddr::Relay(url) => Some(url.to_string()),
            _ => None,
        })
        .collect();
    let relay = shared
        .relays
        .iter()
        .find(|relay| {
            relay
                .relay_url()
                .is_ok_and(|url| home.contains(&url.to_string()))
        })
        .or_else(|| shared.relays.first())
        .cloned();
    let state = shared.state.lock().unwrap();
    Invite {
        host: shared.id,
        addrs: reach::endpoint_addrs(&shared.endpoint),
        session: shared.session,
        secret: state.secret,
        permission: shared.permission,
        relay,
    }
}

/// 回一个 Reject，等对方读到再断。转发来的（conn 是 None）只把流收尾，连接是转发那位的
async fn reject(
    conn: Option<&Connection>,
    mut send: SendStream,
    reason: RejectReason,
) -> Result<Served, String> {
    let _ = protocol::write_frame(
        &mut send,
        kind::REJECT,
        &protocol::encode(&Reject { reason }),
    )
    .await;
    let _ = send.finish();
    match conn {
        Some(conn) => {
            let _ = tokio::time::timeout(Duration::from_secs(2), conn.closed()).await;
            conn.close(VarInt::from_u32(4), b"rejected");
        }
        None => {
            let _ = tokio::time::timeout(Duration::from_secs(2), send.stopped()).await;
        }
    }
    Ok(Served::Gone)
}
