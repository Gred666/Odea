/* ============================================================
团队端点的帧（docs/协同编辑.md §22.4）。和会话式协作（collab/protocol.rs）用同一种帧格式
（varint 长度 + 1 字节类型 + postcard），文档流上的 Sync1 / Sync2 / Update 也是同一套类型号 ——
前端那边的会话、链路（collab/link.ts）一行不用改。

- 控制流（拨号的一方开）：Hello 互换一次，之后 Presence（我开着哪几篇、主持着哪几篇，变了就发）、
  Places（我和我连着的人在哪）
- 文档流（访客开）：第一帧 Open{文档 id}，主持人不在主持这一篇就回 DocErr 收尾
- 光标走数据报：文档 id + 是谁的（32 字节公钥：主持人转给别人的光标要认得出是谁）+ 内容
============================================================ */

use std::net::SocketAddr;

use serde::{Deserialize, Serialize};

use crate::collab::protocol::MAX_DOC_ID;
use crate::collab::Relay;

pub const ALPN: &[u8] = b"odea/team/1";
pub const VERSION: u16 = 1;

pub mod kind {
    pub use crate::collab::protocol::kind::{DOC_ERR, OPEN, SYNC1, SYNC2, UPDATE};
    pub const HELLO: u8 = 1;
    pub const REJECT: u8 = 3;
    /// 控制流：我开着哪几篇（postcard 的 Presence）
    pub const PRESENCE: u8 = 12;
    /// 控制流：我和我连着的人在哪（postcard 的 Places）
    pub const PLACES: u8 = 13;
}

/// 握手：两边各发一次。拨号的一方先发，接的一方查过名单再回
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub version: u16,
    /// 团队 id（仓库标记里的，32 位十六进制）
    pub team: String,
    /// `github:login`（自报的，只用来显示）
    pub account: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Refusal {
    /// 两边的 Odea 版本对不上
    Version { theirs: u16 },
    /// 我这边没开着这个团队仓库
    UnknownTeam,
    /// 我手里的设备名单里没有你（可能是我还没同步到你写进去的那一行）
    NotMember,
}

/// 我开着的一篇
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PresenceDoc {
    /// 文档 id：笔记是属性块里的 id（`note-<id>`，没写 id 的是相对路径），某一天 `day-日期`，
    /// 目标 `goal-周期-开始日期`。这边不解释它
    pub doc: String,
    /// 这一篇由我主持（别人要开就连我）
    pub hosting: bool,
    /// 我在这一篇的哪一份会话里（主持人建会话时起的 id，访客跟着主持人的）；没在会话里是 None。
    /// 主持人走了，同一份会话里留下的人才能接着连新的主持人（CRDT 历史相同）；不是同一份的要重新加入
    pub session: Option<String>,
    /// 我连着谁看这一篇（他的设备公钥，十六进制）；主持人自己、不在会话里的是 None
    pub upstream: Option<String>,
    /// 这一份会话的主持人（写盘的那位）是谁；主持人写自己。主持人走了、还没接上新的是 None。
    /// 连不上主持人的人看它找一位连着主持人的成员经他转
    pub root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Presence {
    pub docs: Vec<PresenceDoc>,
}

/// 一台设备在哪
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Place {
    pub key: [u8; 32],
    pub addrs: Vec<SocketAddr>,
    pub relay: Option<Relay>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Places {
    pub entries: Vec<Place>,
}

/// 光标数据报：1 字节文档 id 长度 + 文档 id + 32 字节公钥 + 内容
pub fn tag_cursor(doc: &str, origin: &[u8; 32], payload: &[u8]) -> Option<Vec<u8>> {
    let id = doc.as_bytes();
    if id.is_empty() || id.len() > MAX_DOC_ID {
        return None;
    }
    let mut out = Vec::with_capacity(1 + id.len() + 32 + payload.len());
    out.push(id.len() as u8);
    out.extend_from_slice(id);
    out.extend_from_slice(origin);
    out.extend_from_slice(payload);
    Some(out)
}

pub fn untag_cursor(datagram: &[u8]) -> Option<(&str, [u8; 32], &[u8])> {
    let (&len, rest) = datagram.split_first()?;
    let (id, rest) = rest.split_at_checked(len as usize)?;
    let (origin, payload) = rest.split_at_checked(32)?;
    Some((std::str::from_utf8(id).ok()?, origin.try_into().ok()?, payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_datagrams_round_trip() {
        let origin = [7u8; 32];
        let datagram = tag_cursor("笔记/周报.md", &origin, b"xy").unwrap();
        assert_eq!(untag_cursor(&datagram), Some(("笔记/周报.md", origin, &b"xy"[..])));
        assert!(tag_cursor("", &origin, b"").is_none());
        assert!(untag_cursor(&datagram[..5]).is_none());
    }
}
