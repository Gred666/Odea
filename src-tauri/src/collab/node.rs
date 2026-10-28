/* ============================================================
协作端点（docs/协同编辑.md §25.1）：一个应用一个，上面挂好几个会话（主持的、做客的）。

为什么不是一个会话一个端点：同一把设备密钥起两个端点，中继那边会互相顶掉（§21.5）；mDNS 广播两份
同一个公钥；端口映射各做一套。一个会话换一把密钥的话，「记住的人」（按公钥）又认不出来了。

- 第一个会话开始时起，最后一个结束时关（命令层管），平时不占端口
- 端点、端口映射、防火墙、分享前自检、mDNS、中继都在这里，只做一份：
  - mDNS：只听的那一份一直在（访客按公钥找主持人、诊断里「同一个网络里看到了他」）；有在主持的会话时
    另加一份广播昵称的，主持的都停了就拿掉 —— 光做客的设备照旧不广播
  - 自检：第一个主持的会话开始时起，变了告诉每个主持的会话（各自的邀请链接跟着变）
  - 中继：自己配的起端点时带上，后来新配的当场接上；访客借链接里主持人的那台，走了还回去（按次数）
- 接进来的连接怎么分（Hello 里本来就带着会话 id，协议不用改）：
  1. 对方是我做客的某个会话的主持人、我又正连不上他：先等一秒看他开不开控制流 —— 开了是他来我这儿做客，
     没开是按回连链接拨过来的，交给那个访客（回连时是访客开控制流）
  2. 别的读 Hello：会话 id 是我主持的哪个就交给它；是我做客的哪个，就是来找我转发的（§20.9）
  3. 「附近」点进来的（会话 id 全 0、没证明）：在哪个会话里允许过他就进哪个；只主持着一个就进它；
     好几个就问主持人挑（NearbyKnock），挑了直接按给的权限进去，不再问第二遍
  4. 都对不上回 BadInvite
- 主持人按回连链接拨通了，也按对方 Hello 里的会话 id 分（serve_dialed）
============================================================ */

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use iroh::address_lookup::UserData;
use iroh::endpoint::{Connection, RecvStream, SendStream, VarInt};
use iroh::{Endpoint, SecretKey};
use iroh_mdns_address_lookup::MdnsAddressLookup;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;

use super::endpoint::{self, Bound, MDNS_SERVICE};
use super::host::{self, Served};
use super::protocol::{self, kind, Hello, Permission, RejectReason};
use super::reach::{self, Mapper, Portmap, Reach};
use super::relays::{self, Pins, Relay};
use super::{clean_name, guest, Control, Event, Events};

/// 握手每一步最多等多久（主持人确认不算）
const HANDSHAKE: Duration = Duration::from_secs(10);
/// 对方是我正在等回连的主持人：等这么久看他开不开控制流（开了是来做客的，没开是回连）
const KNOCK_WAIT: Duration = Duration::from_secs(1);

pub struct NodeOptions {
    pub secret_key: SecretKey,
    /// 我的名字（有在主持的会话时广播出去）
    pub name: String,
    /// 局域网发现（单测里关掉）
    pub mdns: bool,
    /// 自己配的中继（空的话一台都不连）
    pub relays: Vec<Relay>,
    /// 有在主持的会话时问路由器要公网端口（单测里关掉：不去碰本机的路由器）
    pub portmap: bool,
    /// 查 Windows 防火墙放不放行（单测里关掉）
    pub firewall: bool,
    /// 想绑回的端口（继续上次的协作：访客手里链接里的地址才不作废）。绑不上就换随机的
    pub ports: Vec<u16>,
}

/// 主持人挑的：进哪个会话（会话 id）、给什么权限；None 是拒绝
type Choice = Option<([u8; 16], Permission)>;

/// 端点的把手（克隆的是同一个）
#[derive(Clone)]
pub struct Node {
    inner: Arc<Inner>,
}

struct Inner {
    endpoint: Endpoint,
    /// 只听的那一份 mDNS
    listen: Option<MdnsAddressLookup>,
    /// 广播昵称的那一份：有在主持的会话时才有
    advertise: Mutex<Option<MdnsAddressLookup>>,
    mdns: bool,
    pins: Pins,
    /// 自己配的中继（后来新配的也加进来）
    relays: Mutex<Vec<Relay>>,
    /// 借来的中继（访客用链接里主持人的、主持人用回连链接里访客的）：地址 → 几处在用
    borrowed: Mutex<HashMap<String, usize>>,
    name: Mutex<String>,
    portmap: bool,
    firewall: bool,
    mapper: Mutex<Option<Mapper>>,
    /// 分享前自检、防火墙的任务（第一个主持的会话开始时起）
    watching: Mutex<Vec<JoinHandle<()>>>,
    /// 最近一次自检的结果：后来开始主持的会话先拿它
    reach: Mutex<Option<Reach>>,
    hosts: Mutex<Vec<Weak<host::Shared>>>,
    guests: Mutex<Vec<Weak<guest::Shared>>>,
    /// 不属于哪个会话的事件（「附近」进来要主持人挑）
    events: Events,
    knocks: Mutex<HashMap<u32, oneshot::Sender<Choice>>>,
    next_knock: AtomicU32,
    accept: Mutex<Option<JoinHandle<()>>>,
}

impl Node {
    /// 起端点（要两三秒，iroh 初始化网络监视）。要在 tokio 运行时里调
    pub async fn start(options: NodeOptions, events: Events) -> Result<Node, String> {
        let Bound {
            endpoint,
            mdns,
            pins,
        } = endpoint::bind(
            options.secret_key,
            None,
            options.mdns,
            &options.relays,
            &options.ports,
        )
        .await?;
        let inner = Arc::new(Inner {
            endpoint: endpoint.clone(),
            listen: mdns,
            advertise: Mutex::new(None),
            mdns: options.mdns,
            pins,
            relays: Mutex::new(options.relays),
            borrowed: Mutex::new(HashMap::new()),
            name: Mutex::new(clean_name(&options.name)),
            portmap: options.portmap,
            firewall: options.firewall,
            mapper: Mutex::new(None),
            watching: Mutex::new(Vec::new()),
            reach: Mutex::new(None),
            hosts: Mutex::new(Vec::new()),
            guests: Mutex::new(Vec::new()),
            events,
            knocks: Mutex::new(HashMap::new()),
            next_knock: AtomicU32::new(1),
            accept: Mutex::new(None),
        });
        let accept = tokio::spawn(accept_loop(endpoint, Arc::downgrade(&inner)));
        *inner.accept.lock().unwrap() = Some(accept);
        Ok(Node { inner })
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.inner.endpoint
    }

    pub fn id(&self) -> [u8; 32] {
        *self.inner.endpoint.id().as_bytes()
    }

    /// 自己配的中继
    pub fn relays(&self) -> Vec<Relay> {
        self.inner.relays.lock().unwrap().clone()
    }

    /// 起端口映射（有在主持的会话、或者访客要生成回连链接时）。不许碰路由器的话是 None
    pub(crate) fn mapper_state(&self) -> Option<watch::Receiver<Portmap>> {
        if !self.inner.portmap {
            return None;
        }
        let mut mapper = self.inner.mapper.lock().unwrap();
        Some(
            mapper
                .get_or_insert_with(|| Mapper::start(&self.inner.endpoint))
                .state(),
        )
    }

    /// 真环境（会查防火墙）；单测里是 false
    pub(crate) fn checks_firewall(&self) -> bool {
        self.inner.firewall
    }

    /// 自己新配了一台中继：当场接上（不用重开端点）
    pub async fn add_relay(&self, relay: Relay) {
        {
            let mut relays = self.inner.relays.lock().unwrap();
            relays.retain(|known| known.url != relay.url);
            relays.push(relay.clone());
        }
        self.insert_relay(&relay).await;
    }

    /// 借一台中继（访客用链接里主持人的、主持人用回连链接里访客的）。自己配了的不用借
    pub(crate) async fn borrow_relay(&self, relay: &Relay) {
        if self.is_own(relay) {
            return;
        }
        let first = {
            let mut borrowed = self.inner.borrowed.lock().unwrap();
            let count = borrowed.entry(relay.url.clone()).or_insert(0);
            *count += 1;
            *count == 1
        };
        if first {
            self.insert_relay(relay).await;
        }
    }

    /// 还回去：没人用了就从端点上拿掉
    pub(crate) async fn release_relay(&self, relay: &Relay) {
        if self.is_own(relay) {
            return;
        }
        let last = {
            let mut borrowed = self.inner.borrowed.lock().unwrap();
            match borrowed.get_mut(&relay.url) {
                Some(count) if *count > 1 => {
                    *count -= 1;
                    false
                }
                Some(_) => {
                    borrowed.remove(&relay.url);
                    true
                }
                None => false,
            }
        };
        if last {
            if let Ok(url) = relay.relay_url() {
                self.inner.endpoint.remove_relay(&url).await;
            }
        }
    }

    fn is_own(&self, relay: &Relay) -> bool {
        self.inner
            .relays
            .lock()
            .unwrap()
            .iter()
            .any(|own| own.url == relay.url)
    }

    async fn insert_relay(&self, relay: &Relay) {
        relays::add_pin(&self.inner.pins, relay);
        if let (Ok(url), Some(config)) = (relay.relay_url(), relay.config()) {
            self.inner.endpoint.insert_relay(url, Arc::new(config)).await;
        }
    }

    /// 改了名字：在广播的话广播的昵称跟着换
    pub fn set_name(&self, name: &str) {
        *self.inner.name.lock().unwrap() = clean_name(name);
        if self.inner.advertise.lock().unwrap().is_some() {
            self.set_user_data();
        }
    }

    fn set_user_data(&self) {
        // 广播里只有昵称，超长的截掉
        let name: String = self.inner.name.lock().unwrap().chars().take(40).collect();
        if let Ok(data) = UserData::try_from(name) {
            self.inner
                .endpoint
                .set_user_data_for_address_lookup(Some(data));
        }
    }

    /// 一个主持的会话开始了：第一个的话开始广播、起自检；自检已经有结果的话先告诉它
    pub(crate) fn add_host(&self, shared: &Arc<host::Shared>) {
        let first = {
            let mut hosts = self.inner.hosts.lock().unwrap();
            hosts.retain(|host| host.strong_count() > 0);
            hosts.push(Arc::downgrade(shared));
            hosts.len() == 1
        };
        if first {
            self.start_advertising();
        }
        self.start_watching();
        let known = self.inner.reach.lock().unwrap().clone();
        if let Some(reach) = known {
            host::on_reach(shared, reach);
        }
    }

    /// 一个主持的会话停了：主持的都停了就不再广播（端口映射、自检留到端点关掉）
    pub(crate) fn remove_host(&self, shared: &Arc<host::Shared>) {
        let none = {
            let mut hosts = self.inner.hosts.lock().unwrap();
            hosts.retain(|host| {
                host.upgrade()
                    .is_some_and(|host| !Arc::ptr_eq(&host, shared))
            });
            hosts.is_empty()
        };
        if none {
            self.stop_advertising();
        }
    }

    pub(crate) fn add_guest(&self, shared: &Arc<guest::Shared>) {
        let mut guests = self.inner.guests.lock().unwrap();
        guests.retain(|guest| guest.strong_count() > 0);
        guests.push(Arc::downgrade(shared));
    }

    pub(crate) fn remove_guest(&self, shared: &Arc<guest::Shared>) {
        self.inner.guests.lock().unwrap().retain(|guest| {
            guest
                .upgrade()
                .is_some_and(|guest| !Arc::ptr_eq(&guest, shared))
        });
    }

    fn start_advertising(&self) {
        if !self.inner.mdns {
            return;
        }
        self.set_user_data();
        match MdnsAddressLookup::builder()
            .service_name(MDNS_SERVICE)
            .advertise(true)
            .build(self.inner.endpoint.id())
        {
            Ok(lookup) => {
                if let Ok(services) = self.inner.endpoint.address_lookup() {
                    services.add(lookup.clone());
                }
                *self.inner.advertise.lock().unwrap() = Some(lookup);
            }
            // 局域网发现起不来（网卡都没有组播）不影响按链接里的地址直连
            Err(error) => eprintln!("协作：mDNS 广播起不来：{error}"),
        }
    }

    /// 拿掉广播的那一份：查找服务只能整个清掉，清完把只听的那一份放回去
    fn stop_advertising(&self) {
        let Some(lookup) = self.inner.advertise.lock().unwrap().take() else {
            return;
        };
        self.inner.endpoint.set_user_data_for_address_lookup(None);
        if let Ok(services) = self.inner.endpoint.address_lookup() {
            services.clear();
            if let Some(listen) = &self.inner.listen {
                services.add(listen.clone());
            }
        }
        drop(lookup);
    }

    /// 分享前自检（第一个主持的会话开始时起一次）：端口映射、防火墙、能被谁连进来
    fn start_watching(&self) {
        let mut watching = self.inner.watching.lock().unwrap();
        if !watching.is_empty() {
            return;
        }
        let portmap = self.mapper_state();
        let (firewall, firewall_task) = if self.inner.firewall {
            let (state, task) = super::firewall::watch();
            (Some(state), Some(task))
        } else {
            (None, None)
        };
        let weak = Arc::downgrade(&self.inner);
        let relays = self.relays();
        let watch = reach::watch_reach(
            self.inner.endpoint.clone(),
            portmap,
            firewall,
            relays,
            move |reach| {
                let Some(inner) = weak.upgrade() else { return };
                *inner.reach.lock().unwrap() = Some(reach.clone());
                for host in live(&inner.hosts) {
                    host::on_reach(&host, reach.clone());
                }
            },
        );
        watching.push(watch);
        watching.extend(firewall_task);
    }

    /// 主持人挑了「附近」进来的那位进哪个会话（None = 拒绝）。请求已经不在了返回 false
    pub fn answer_nearby(&self, request: u32, choice: Choice) -> bool {
        let sender = self.inner.knocks.lock().unwrap().remove(&request);
        sender.is_some_and(|sender| sender.send(choice).is_ok())
    }

    /// 主持人按回连链接拨通了：等对方开控制流、发 Hello，按里面的会话 id 交给那个主持的会话
    pub(crate) async fn serve_dialed(&self, conn: Connection) -> Result<Served, String> {
        let stream = tokio::time::timeout(HANDSHAKE, conn.accept_bi())
            .await
            .map_err(|_| "等 Hello 超时".to_string())?
            .map_err(|error| error.to_string())?;
        knock(&self.inner, conn, stream, true).await
    }

    /// 端点绑的端口（落盘时记下来，继续协作时绑回去）
    pub fn ports(&self) -> Vec<u16> {
        endpoint::ports(&self.inner.endpoint)
    }

    /// 端点绑在哪些本机地址上（单测拿它拼本机回环的链接）
    #[cfg(test)]
    pub fn bound_sockets(&self) -> Vec<std::net::SocketAddr> {
        self.inner.endpoint.bound_sockets()
    }

    /// 默认配置下一台中继都没连（设计 §5.2：代码里不出现 n0 的中继，测试守着）
    #[cfg(test)]
    pub fn relays_disabled(&self) -> bool {
        use iroh::Watcher;
        if !self.relays().is_empty() {
            return false;
        }
        self.inner
            .endpoint
            .addr()
            .addrs
            .iter()
            .all(|addr| !matches!(addr, iroh::TransportAddr::Relay(_)))
            && self.inner.endpoint.home_relay_status().get().is_empty()
    }

    /// 关端点：停掉接入、自检，端口映射还给路由器，拿掉广播
    pub async fn close(&self) {
        let accept = self.inner.accept.lock().unwrap().take();
        if let Some(task) = accept {
            task.abort();
        }
        let watching = std::mem::take(&mut *self.inner.watching.lock().unwrap());
        for task in watching {
            task.abort();
        }
        let mapper = self.inner.mapper.lock().unwrap().take();
        if let Some(mapper) = mapper {
            mapper.stop().await;
        }
        self.inner.advertise.lock().unwrap().take();
        for (_, sender) in self.inner.knocks.lock().unwrap().drain() {
            let _ = sender.send(None);
        }
        self.inner.endpoint.close().await;
    }

    /// 单测：这台崩了 —— 端点没了。真崩的话进程一退端口就空出来了；这里等端口真的空出来再返回
    /// （重启的那个要绑回去）
    #[cfg(test)]
    pub async fn crash(self) {
        let ports = self.ports();
        self.close().await;
        drop(self);
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

    /// 只听的那一份 mDNS（访客订阅它：同一个网络里看到主持人了没有）
    pub(crate) fn listen(&self) -> Option<MdnsAddressLookup> {
        self.inner.listen.clone()
    }
}

/// 还活着的那几个（停了的、丢掉了的不算）
fn live<T>(list: &Mutex<Vec<Weak<T>>>) -> Vec<Arc<T>> {
    list.lock()
        .unwrap()
        .iter()
        .filter_map(Weak::upgrade)
        .collect()
}

async fn accept_loop(endpoint: Endpoint, weak: Weak<Inner>) {
    while let Some(incoming) = endpoint.accept().await {
        let Some(inner) = weak.upgrade() else { return };
        tokio::spawn(async move {
            let conn = match incoming.await {
                Ok(conn) => conn,
                Err(error) => {
                    eprintln!("协作：接入失败：{error}");
                    return;
                }
            };
            if let Err(error) = route(&inner, conn).await {
                eprintln!("协作：接入失败：{error}");
            }
        });
    }
}

/// 接进来的一条连接交给谁（见文件开头）
async fn route(inner: &Arc<Inner>, conn: Connection) -> Result<(), String> {
    let remote = *conn.remote_id().as_bytes();
    let waiting = live(&inner.guests)
        .into_iter()
        .find(|guest| guest::waiting_for(guest, &remote));
    let stream = match waiting {
        Some(guest) => match tokio::time::timeout(KNOCK_WAIT, conn.accept_bi()).await {
            Ok(Ok(stream)) => stream,
            Ok(Err(error)) => return Err(error.to_string()),
            // 他不开：是按回连链接拨过来的
            Err(_) => {
                guest::dialed_in(&guest, conn);
                return Ok(());
            }
        },
        None => tokio::time::timeout(HANDSHAKE, conn.accept_bi())
            .await
            .map_err(|_| "等 Hello 超时".to_string())?
            .map_err(|error| error.to_string())?,
    };
    knock(inner, conn, stream, false).await.map(|_| ())
}

/// 读 Hello，按会话 id 交给主持的会话、或者替人转发的访客。dialed = 主持人按回连链接拨过去的
async fn knock(
    inner: &Arc<Inner>,
    conn: Connection,
    (send, mut recv): (SendStream, RecvStream),
    dialed: bool,
) -> Result<Served, String> {
    let hello = match tokio::time::timeout(HANDSHAKE, protocol::read_frame(&mut recv)).await {
        Ok(Ok(Some((kind::HELLO, payload)))) => {
            protocol::decode::<Hello>(&payload).map_err(|error| error.to_string())?
        }
        _ => {
            conn.close(VarInt::from_u32(2), b"no hello");
            return Err("对方没发 Hello".into());
        }
    };
    let nearby = !dialed && hello.proof.is_none() && hello.session == [0; 16];
    if !nearby {
        let host = live(&inner.hosts)
            .into_iter()
            .find(|host| host::session_of(host) == hello.session);
        if let Some(host) = host {
            return host::serve_knock(host, conn, send, recv, hello, dialed, None).await;
        }
        if !dialed {
            let guest = live(&inner.guests)
                .into_iter()
                .find(|guest| guest::forwards(guest, &hello.session));
            if let Some(guest) = guest {
                guest::forward_for(guest, conn, send, recv, hello).await;
                return Ok(Served::Gone);
            }
        }
        return host::reject(Some(&conn), send, RejectReason::BadInvite).await;
    }

    // 「附近」点进来的
    let id = *conn.remote_id().as_bytes();
    let hosts: Vec<_> = live(&inner.hosts)
        .into_iter()
        .filter(|host| !host::ended(host))
        .collect();
    let target = if let Some(host) = hosts.iter().find(|host| host::approved(host, &id)) {
        // 断线重连：允许过他的那个
        Some((host.clone(), None))
    } else if hosts.len() <= 1 || !host::compatible(&hello) {
        // 只主持着一个；版本对不上的交给随便哪个去拒（它会告诉主持人一声）
        hosts.first().map(|host| (host.clone(), None))
    } else {
        match ask(inner, &conn, id, &hello).await {
            Some((session, permission)) => hosts
                .iter()
                .find(|host| host::session_of(host) == session)
                .map(|host| (host.clone(), Some(permission))),
            None => return host::reject(Some(&conn), send, RejectReason::Declined).await,
        }
    };
    match target {
        Some((host, preset)) => {
            host::serve_knock(host, conn, send, recv, hello, false, preset).await
        }
        None => host::reject(Some(&conn), send, RejectReason::Ended).await,
    }
}

/// 「附近」进来、我主持着好几个：问主持人进哪一个（不设时限，他走了就算了）
async fn ask(
    inner: &Arc<Inner>,
    conn: &Connection,
    id: [u8; 32],
    hello: &Hello,
) -> Choice {
    let request = inner.next_knock.fetch_add(1, Ordering::SeqCst);
    let (sender, receiver) = oneshot::channel();
    inner.knocks.lock().unwrap().insert(request, sender);
    let _ = inner.events.send(Event::Control(Control::NearbyKnock {
        request,
        id: endpoint::id_text(&id),
        name: clean_name(&hello.name),
    }));
    let answer = tokio::select! {
        answer = receiver => answer.ok().flatten(),
        _ = conn.closed() => None,
    };
    inner.knocks.lock().unwrap().remove(&request);
    let _ = inner
        .events
        .send(Event::Control(Control::NearbyKnockDone { request }));
    answer
}
