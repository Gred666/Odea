/* ============================================================
共享仓库（docs/协同编辑.md §20，P10.3.3）：整个仓库在几台设备、几个人之间持续同步，没有服务器。

照 vault/、sync/、collab/ 的规矩不依赖 tauri，命令在 commands.rs 的「共享仓库」一节。
- replica.rs：这台设备上的 CRDT（Loro），存在仓库的 .odea/share/ 里
- bridge.rs：.md 和 CRDT 对账（本机的改动进 CRDT，别人的改动写盘）
- members.rs：签名的成员表、角色
- wire.rs：odea/share/1 的消息、邀请链接 odea://share/
- service.rs：一个共享仓库在这台设备上跑起来（端点、网状连接、后台任务、给前端的副本）
============================================================ */

pub mod bridge;
pub mod members;
pub mod replica;
pub mod service;
#[cfg(test)]
mod tests;
pub mod wire;

use serde::{Deserialize, Serialize};

pub use members::Role;
// 命令层用（不带 Tauri 的单测里没人用）
#[allow(unused_imports)]
pub use service::{is_shared, prepare_join, share_dir, Share, ShareOptions};
pub use wire::{Refusal, ShareInvite};

/// 公钥、共享 id 给前端看的样子（小写十六进制）
pub fn hex(bytes: &[u8]) -> String {
    data_encoding::HEXLOWER.encode(bytes)
}

/// 共享仓库往前端推的东西（命令层实现：二进制 Channel、tauri-specta 的事件）
pub trait Sink: Send + Sync + 'static {
    /// 前端开着的那一篇来了改动（别人的、磁盘上的）
    fn doc_update(&self, doc: &str, bytes: &[u8]);
    /// 别人在这一篇里的光标
    fn cursor(&self, doc: &str, from: &str, payload: &[u8]);
    /// 成员、连接、加入请求、状态变了：前端重新取一次 ShareInfo
    fn changed(&self);
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum ShareState {
    /// 正在加入：waiting = 连上了邀请人，等他同意
    Joining { waiting: bool },
    Rejected { reason: Refusal },
    /// 被移出了
    Removed,
    Ready,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShareMember {
    pub id: String,
    pub name: String,
    pub role: Role,
    /// 现在连着（自己算连着）
    pub online: bool,
    pub me: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShareRequest {
    pub request: u32,
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    /// 共享 id
    pub id: String,
    /// 仓库名
    pub name: String,
    /// 我（这台设备在这个共享里的公钥）
    pub me: String,
    pub role: Option<Role>,
    pub state: ShareState,
    pub members: Vec<ShareMember>,
    /// 等管理员确认的加入请求
    pub requests: Vec<ShareRequest>,
    /// 我手里有邀请链接（管理员）
    pub can_invite: bool,
}
