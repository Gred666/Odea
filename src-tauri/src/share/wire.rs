/* ============================================================
odea/share/1 的消息和邀请链接（docs/协同编辑.md §20.7、§20.8）。

一条 iroh 连接（ALPN `odea/share/1`）上，拨号的一方开一条双向流（主流），帧格式和 odea/collab/2
一样（varint 长度 + 1 字节类型 + 内容，collab/protocol.rs），内容是 postcard：
1. 握手：双方各发 Hello{共享 id, 成员表版本, 名字, 证明}。不是同一个共享、对面不在我的成员表里：
   拿着邀请链接的（证明对得上）等管理员确认（Wait），否则 Reject。成员表版本不一样：新的一方发 Roster
2. 对账：双方各发 Summary（每个文档的版本向量），收到的一方回对方缺的 Update
3. 实时：之后每有一包改动（本机的、别人转来的）发 Update；Where 告诉对方我现在在哪（下次直接拨）
附件：要的一方另开一条双向流，Want{哈希} → Blob{字节} / Nope（一个文件一条流）。
光标：QUIC 数据报，`1 字节文档 id 长度 + 文档 id + 光标`（和会话式的光标内容一样）

邀请链接 `odea://share/<票据>`：1 个版本字节 + postcard（共享 id、仓库名、邀请人的公钥和地址、中继、
邀请密钥、默认角色），整个 base32。
============================================================ */

use std::net::SocketAddr;

use serde::{Deserialize, Serialize};

use super::members::Role;
use crate::collab::ticket::{decode_link, encode_link, LinkError};
use crate::collab::Relay;

pub const ALPN: &[u8] = b"odea/share/1";
pub const VERSION: u16 = 1;
/// 握手证明绑在这一条 TLS 会话上的标签（和会话式的不一样，免得两边的证明能互相拿来用）
pub const PROOF_LABEL: &[u8] = b"odea-share-hello";

pub mod kind {
    pub const HELLO: u8 = 1;
    pub const ROSTER: u8 = 2;
    /// 拿着邀请链接来的：等管理员确认
    pub const WAIT: u8 = 3;
    pub const REJECT: u8 = 4;
    pub const SUMMARY: u8 = 5;
    pub const UPDATE: u8 = 6;
    pub const WHERE: u8 = 7;
    /// 附件流
    pub const WANT: u8 = 16;
    pub const BLOB: u8 = 17;
    pub const NOPE: u8 = 18;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub version: u16,
    pub share: [u8; 16],
    /// 我手里成员表的版本（还没加入的是 0）
    pub roster: u64,
    pub name: String,
    /// 拿着邀请链接来加入的：HMAC(邀请密钥, 这条连接导出的密钥材料)
    pub proof: Option<[u8; 32]>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Refusal {
    /// 不是成员、也没拿邀请链接（或者链接作废了）
    NotMember,
    /// 管理员拒绝了
    Declined,
    /// 被移出了
    Removed,
    /// 对面没有这个共享（开着的不是这个仓库）
    UnknownShare,
    /// 协议版本对不上
    Version { theirs: u16 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateMsg {
    /// 文档 id，仓库文档是空串
    pub target: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Where {
    pub addrs: Vec<SocketAddr>,
    pub relay: Option<Relay>,
}

/// 光标数据报：前面带上是哪一篇
pub fn tag_cursor(doc: &str, payload: &[u8]) -> Option<Vec<u8>> {
    let len = u8::try_from(doc.len()).ok()?;
    let mut out = Vec::with_capacity(1 + doc.len() + payload.len());
    out.push(len);
    out.extend_from_slice(doc.as_bytes());
    out.extend_from_slice(payload);
    Some(out)
}

pub fn untag_cursor(datagram: &[u8]) -> Option<(&str, &[u8])> {
    let (&len, rest) = datagram.split_first()?;
    let (doc, payload) = rest.split_at_checked(len as usize)?;
    Some((std::str::from_utf8(doc).ok()?, payload))
}

/* ---------------- 邀请链接 ---------------- */

const SHARE_PREFIX: &str = "odea://share/";
const SHARE_VERSION: u8 = 1;
/// 地址太多的话链接很长：只带前面这些
const MAX_ADDRS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareInvite {
    pub share: [u8; 16],
    /// 仓库名（加入时新建的文件夹默认叫这个）
    pub name: String,
    /// 邀请人（管理员）的设备公钥：第一次拿到的成员表要是他签的
    pub inviter: [u8; 32],
    pub addrs: Vec<SocketAddr>,
    pub relay: Option<Relay>,
    pub secret: [u8; 32],
    /// 进来以后默认的角色（管理员确认时还能改）
    pub role: Role,
    /// 加入的人新建仓库时照这个摆：日程开没开、各类文档放在哪（仓库标记里 folders 那一段的 JSON）。
    /// 笔记放在哪要一样：正文里图片的相对路径是从笔记所在的文件夹算的
    pub journal: bool,
    pub folders: String,
}

impl ShareInvite {
    pub fn to_link(&self) -> String {
        let mut invite = self.clone();
        invite.addrs.truncate(MAX_ADDRS);
        let mut bytes = vec![SHARE_VERSION];
        bytes.extend(postcard::to_allocvec(&invite).expect("邀请链接编码不会失败"));
        encode_link(SHARE_PREFIX, &bytes)
    }

    pub fn parse(text: &str) -> Result<Self, LinkError> {
        let bytes = decode_link(text, SHARE_PREFIX, &["odea:share/"])?;
        match bytes.split_first() {
            Some((&SHARE_VERSION, rest)) => postcard::from_bytes(rest).map_err(|_| LinkError::Malformed),
            Some((version, _)) if *version > SHARE_VERSION => Err(LinkError::TooNew),
            _ => Err(LinkError::Malformed),
        }
    }
}

#[cfg(test)]
pub fn is_share_link(text: &str) -> bool {
    text.trim().to_ascii_lowercase().starts_with("odea://share")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_links_round_trip_and_cursors_carry_the_doc() {
        let invite = ShareInvite {
            share: [3; 16],
            name: "团队笔记".into(),
            inviter: [9; 32],
            addrs: vec!["192.168.1.5:41000".parse().unwrap()],
            relay: None,
            secret: [5; 32],
            role: Role::Edit,
            journal: true,
            folders: r#"{"notes":""}"#.into(),
        };
        let link = invite.to_link();
        assert!(link.starts_with("odea://share/"));
        assert!(is_share_link(&link));
        assert_eq!(ShareInvite::parse(&format!("  <{link}> ")).unwrap(), invite);
        assert!(ShareInvite::parse("odea://join/abc").is_err());
        let tagged = tag_cursor("n1", &[1, 2, 3]).unwrap();
        assert_eq!(untag_cursor(&tagged), Some(("n1", &[1u8, 2, 3][..])));
    }
}
