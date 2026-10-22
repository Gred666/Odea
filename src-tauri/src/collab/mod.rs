/* ============================================================
多人协同的网络这一半（docs/协同编辑.md §5、§7、§8）。照 vault/、sync/ 的规矩不依赖 tauri，
命令在 commands.rs 的「协作」一节。

CRDT 在前端（collab/session.ts），这里只搬字节、管成员和权限：
- Host：主持人。起端点、发邀请链接、有人连进来先问主持人、星形转发（访客的更新转给其他人）
- Guest：访客。按邀请链接拨主持人、等确认、断线自动重连

两边都往一个 mpsc 里吐 Event：文档更新、光标、同步请求原样交给前端（命令层走二进制
Channel），成员、加入请求、连接状态这些控制消息走 tauri-specta 的事件。

互联网上（P10.2）：
- reach.rs：能不能被连进来（端口映射、公网 IPv6、中继），主持人分享前自检，变了就报
- diagnose.rs：访客连不上时 3 秒内给结论
- 回连链接（ticket.rs 的 Callback）：访客能被连进来、主持人不能时，主持人往访客那边拨
- relays.rs：用户自己配的中继、中继码、测试中继

P10.1 的遗留（2026-10-18 补上）：
- nearby.rs：局域网「附近」列表（mDNS 浏览正在分享的主持人），点一下不用链接就能请求加入
- record.rs：会话状态落盘，崩溃、强退以后「继续上次的协作」
- queue.rs：发给慢的访客的更新积压了，换成一次补齐
- 附件按需传：访客那边的图片向主持人要，粘贴的图片交给主持人存（host.rs / guest.rs 的附件流）
============================================================ */

pub mod diagnose;
mod endpoint;
pub mod firewall;
mod guest;
mod host;
pub mod nearby;
pub mod protocol;
mod queue;
pub mod reach;
pub mod record;
pub mod relays;
#[cfg(test)]
pub(crate) mod tests;
pub mod ticket;

use serde::{Deserialize, Serialize};

pub use diagnose::Diagnosis;
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
pub use endpoint::id_text;
pub use guest::{Guest, GuestOptions};
pub use host::{Decision, Host, HostOptions};
pub use protocol::{Permission, RejectReason, Scope};
pub use reach::Reach;
pub use relays::Relay;
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
pub use relays::RelayCheck;
#[cfg(test)]
pub use ticket::LinkError;
pub use ticket::{Callback, Invite};

/// 一个成员（给界面看）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MemberInfo {
    pub member: u16,
    /// 设备公钥（十六进制）：前端按它认人、挑颜色
    pub id: String,
    pub name: String,
    pub permission: Permission,
    pub host: bool,
    /// 经哪位访客转发进来的（成员号，设计 §20.9）；自己连上主持人的是 None
    pub via: Option<u16>,
    /// 他开着哪几篇（文档 id，设计 §22.5）。只有主持人这边知道，访客那边是空的
    pub docs: Vec<String>,
}

/// 主持人「记住」的一个人（设计 §8.2）：下次进来不问，权限照这个
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TrustedPeer {
    /// 设备公钥（十六进制）
    pub id: String,
    /// 上次见到的名字
    pub name: String,
    pub permission: Permission,
}

/// 访客这边的连接状态（主持人只有 Ended）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum Status {
    /// 正在拨主持人
    Connecting,
    /// 还没进去、连不上（3 秒内给结论）。不算结束：后台接着试（换了网络会自己连上），
    /// 也等着主持人按回连链接拨过来
    Unreachable {
        diagnosis: Diagnosis,
    },
    /// 连上了，等主持人确认
    Waiting,
    Connected {
        member: u16,
        permission: Permission,
        title: String,
        /// 邀请的范围：一篇、一个文件夹、整个仓库（设计 §22.5）
        scope: Scope,
    },
    /// 断了，正在重连（本地照常编辑）
    Reconnecting,
    Ended {
        reason: EndReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum EndReason {
    /// 主持人没让进（拒绝、链接作废……）
    Rejected { reason: RejectReason },
    /// 两边的 Odea 版本对不上（设计 §7.4）：host_older = 主持人的旧（该他升级），否则是我的旧
    #[serde(rename_all = "camelCase")]
    Outdated { host_older: bool },
    /// 被移出了
    Kicked,
    /// 主持人停止了协作
    HostStopped,
    /// 还没进去，主持人那边就断开了（他关了 Odea、停止了协作）
    Dropped,
    /// 自己走的
    Left,
}

/// 控制消息：命令层转成 tauri-specta 的事件
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum Control {
    /// 有人想加入（主持人）。invited = 拿着邀请链接（不是从「附近」点进来的）
    JoinRequest {
        request: u32,
        id: String,
        name: String,
        invited: bool,
        /// 经哪位访客转发来的（他的名字，设计 §20.9）
        via: Option<String>,
    },
    /// 有人想加入，可两边的 Odea 版本对不上，直接拒了（主持人）。guest_older = 对方的旧
    #[serde(rename_all = "camelCase")]
    JoinOutdated { name: String, guest_older: bool },
    /// 等确认的那位自己走了
    JoinCancelled {
        request: u32,
    },
    Members {
        members: Vec<MemberInfo>,
    },
    /// 主持人改了我的权限（访客）
    Permission {
        permission: Permission,
    },
    Status {
        status: Status,
    },
    /// 能不能被连进来变了（主持人：分享前自检、端口映射到了、换了网络）。
    /// link 是主持人这时的邀请链接（地址变了，链接跟着变）
    Reach {
        reach: Reach,
        link: Option<String>,
    },
    /// 访客：现在走的是直连还是中继（会变：先经中继、打洞成功后换成直连）
    Route {
        relayed: bool,
    },
    /// 主持人按回连链接往访客那边拨的结果（成功的话接着就是那位的加入请求）
    DialBack {
        ok: bool,
        detail: Option<String>,
    },
    /// 同一个网络里正在分享的人（「附近」列表开着时，变了就报一次整张表）
    Nearby {
        hosts: Vec<nearby::NearbyHost>,
    },
    /// 访客要开一篇（主持人）：前端看它在不在范围里，用 collab_doc_answer 回话
    #[serde(rename_all = "camelCase")]
    DocOpen {
        request: u32,
        member: u16,
        doc: String,
    },
    /// 访客关掉了一篇、或者走了（主持人）：没人开着的那篇前端可以收掉
    DocClosed {
        member: u16,
        doc: String,
    },
    /// 访客要在范围里新建一篇（主持人）：建好了用 collab_create_answer 回他文档 id
    CreateDoc {
        request: u32,
        member: u16,
        folder: String,
        title: String,
    },
    /// 范围里的树（访客）：主持人给的 JSON，原样交给前端
    Tree {
        tree: String,
    },
    /// 主持人不给这一篇（访客）：不在范围里、已经删了
    DocRefused {
        doc: String,
        reason: String,
    },
}

/// 命令层对附件请求的回话
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttachReply {
    /// 要的文件
    Data(Vec<u8>),
    /// 粘贴的文件存好了：从这篇引用它的路径
    Link(String),
}

/// 文档字节的事件都带着是哪篇（doc，文档 id）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// 别人的文档更新（Update 和 Sync2 都是它）
    Update {
        from: u16,
        doc: String,
        bytes: Vec<u8>,
    },
    Cursor {
        from: u16,
        doc: String,
        bytes: Vec<u8>,
    },
    /// 别人发来了状态向量：前端回它缺的（send_sync Reply）
    SyncRequest {
        from: u16,
        doc: String,
        vector: Vec<u8>,
    },
    /// 和这位接上了这一篇：前端把自己的状态向量发给他（send_sync Vector）
    SyncStart {
        with: u16,
        doc: String,
    },
    /// 访客要一个附件（主持人）：命令层查过「这篇正文里引用了、落在仓库的附件里」再给，
    /// 回话用 Host::answer_attachment
    AttachGet {
        request: u32,
        from: u16,
        doc: String,
        /// 正文里写的路径（相对这篇笔记）
        path: String,
    },
    /// 访客粘贴了一个文件（主持人）：存进这篇的附件位置，回从这篇引用它的路径
    AttachPut {
        request: u32,
        from: u16,
        doc: String,
        name: String,
        bytes: Vec<u8>,
    },
    Control(Control),
}

/// 前端发出去的同步消息
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncKind {
    /// Sync1：我的状态向量
    Vector,
    /// Sync2：回对方缺的更新
    Reply,
}

impl SyncKind {
    fn frame(self) -> u8 {
        match self {
            SyncKind::Vector => protocol::kind::SYNC1,
            SyncKind::Reply => protocol::kind::SYNC2,
        }
    }
}

pub type Events = tokio::sync::mpsc::UnboundedSender<Event>;

/// 昵称：去掉首尾空白，最长 40 个字，空的叫「访客」
pub(crate) fn clean_name(name: &str) -> String {
    let name: String = name
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect();
    if name.is_empty() {
        "访客".into()
    } else {
        name
    }
}

/// 帧写手：一条流一个任务，发的一方只往通道里塞，不会被慢的人卡住。
/// 通道关了就把流收尾（让对方读到正常结束），最多等半秒对方确认
pub(crate) fn spawn_writer(
    mut send: iroh::endpoint::SendStream,
) -> (
    tokio::sync::mpsc::UnboundedSender<(u8, Vec<u8>)>,
    tokio::task::JoinHandle<()>,
) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(u8, Vec<u8>)>();
    let handle = tokio::spawn(async move {
        while let Some((kind, bytes)) = rx.recv().await {
            if protocol::write_frame(&mut send, kind, &bytes)
                .await
                .is_err()
            {
                return;
            }
        }
        let _ = send.finish();
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), send.stopped()).await;
    });
    (tx, handle)
}
