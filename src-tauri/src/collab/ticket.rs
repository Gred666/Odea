/* ============================================================
协作的几种链接（docs/协同编辑.md §6.4、§8.1、§8.4）：
- 邀请链接 `odea://join/<票据>`：主持人发给访客
- 回连链接 `odea://back/<票据>`：访客连不上主持人、自己能被连进来时发回给主持人，主持人往访客那边拨
- 中继码 `odea://relay/<票据>`（relays.rs）

票据都是：1 个版本字节 + postcard，整个 base32（小写、不补 =）。不直接序列化 iroh 的
EndpointAddr：iroh 哪天改了它的序列化，已经发出去的链接不能跟着作废。

邀请链接 v1（P10.1）：主持人的公钥、直连地址、会话 id、邀请密钥、默认权限。
v2（P10.2）在后面多一个中继（主持人配了的话，带地址、令牌、证书指纹）。现在只发 v2，v1 照样认。

链接里有主持人的 IP 地址（和中继令牌），只发给要邀请的人；会话结束、「重置邀请链接」后作废。
============================================================ */

use std::net::SocketAddr;

use serde::{Deserialize, Serialize};

use super::protocol::Permission;
use super::relays::Relay;

const JOIN_PREFIX: &str = "odea://join/";
const BACK_PREFIX: &str = "odea://back/";
const JOIN_VERSION: u8 = 2;
const BACK_VERSION: u8 = 1;
/// 地址太多的话链接很长：本机网卡多（虚拟网卡、VPN）时只带前面这些
const MAX_ADDRS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invite {
    /// 主持人的设备公钥
    pub host: [u8; 32],
    /// 直连候选地址（局域网地址、公网 IPv6、端口映射拿到的公网 IPv4）
    pub addrs: Vec<SocketAddr>,
    pub session: [u8; 16],
    pub secret: [u8; 32],
    /// 进来之后默认的权限（主持人确认时还能改）
    pub permission: Permission,
    /// 主持人配的中继：访客这次加入时临时用上，不写进访客自己的配置
    pub relay: Option<Relay>,
}

/// v1 的样子（P10.1）；v2 在它后面接一个 Option<Relay>
#[derive(Serialize, Deserialize)]
struct InviteV1 {
    host: [u8; 32],
    addrs: Vec<SocketAddr>,
    session: [u8; 16],
    secret: [u8; 32],
    permission: Permission,
}

#[derive(Serialize, Deserialize)]
struct InviteV2 {
    base: InviteV1,
    relay: Option<Relay>,
}

/// 回连链接：访客能被连进来，主持人往这边拨。连上以后角色不变（访客照样发 Hello、要主持人确认）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Callback {
    /// 访客的设备公钥：主持人按它拨，TLS 认的也是它
    pub guest: [u8; 32],
    pub addrs: Vec<SocketAddr>,
    /// 是哪一次协作的（主持人那边对不上就直说，不拨）
    pub session: [u8; 16],
    /// 访客自己配的中继：主持人这次临时用上
    pub relay: Option<Relay>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LinkError {
    #[error("这不是 Odea 的协作链接")]
    Malformed,
    #[error("这个链接来自更新版本的 Odea，先升级再打开")]
    TooNew,
}

/// 加上前缀、base32
pub fn encode_link(prefix: &str, bytes: &[u8]) -> String {
    format!(
        "{prefix}{}",
        data_encoding::BASE32_NOPAD.encode(bytes).to_lowercase()
    )
}

/// 认链接：前后的空白、聊天软件里加的尖括号和引号、大小写都不管；只粘了票据那一截也行
pub fn decode_link(text: &str, prefix: &str, aliases: &[&str]) -> Result<Vec<u8>, LinkError> {
    let text = text
        .trim()
        .trim_matches(|c| c == '<' || c == '>' || c == '"' || c == '\'');
    let lower = text.to_ascii_lowercase();
    let code = std::iter::once(prefix)
        .chain(aliases.iter().copied())
        .find_map(|prefix| lower.starts_with(prefix).then(|| &text[prefix.len()..]))
        .unwrap_or(text)
        .trim_end_matches('/');
    // 别的种类的链接（拿邀请链接当回连链接粘）：不当成票据硬解
    if code.contains("://") || code.contains(':') {
        return Err(LinkError::Malformed);
    }
    data_encoding::BASE32_NOPAD
        .decode(code.to_ascii_uppercase().as_bytes())
        .map_err(|_| LinkError::Malformed)
}

impl Invite {
    pub fn to_link(&self) -> String {
        let mut addrs = self.addrs.clone();
        addrs.truncate(MAX_ADDRS);
        let ticket = InviteV2 {
            base: InviteV1 {
                host: self.host,
                addrs,
                session: self.session,
                secret: self.secret,
                permission: self.permission,
            },
            relay: self.relay.clone(),
        };
        let mut bytes = vec![JOIN_VERSION];
        bytes.extend(super::protocol::encode(&ticket));
        encode_link(JOIN_PREFIX, &bytes)
    }

    pub fn parse(text: &str) -> Result<Self, LinkError> {
        let bytes = decode_link(text, JOIN_PREFIX, &["odea:join/"])?;
        let decode = |rest: &[u8], version: u8| -> Result<Invite, LinkError> {
            let (base, relay) = if version == 1 {
                let base: InviteV1 =
                    super::protocol::decode(rest).map_err(|_| LinkError::Malformed)?;
                (base, None)
            } else {
                let ticket: InviteV2 =
                    super::protocol::decode(rest).map_err(|_| LinkError::Malformed)?;
                (ticket.base, ticket.relay)
            };
            Ok(Invite {
                host: base.host,
                addrs: base.addrs,
                session: base.session,
                secret: base.secret,
                permission: base.permission,
                relay,
            })
        };
        match bytes.split_first() {
            Some((&version, rest)) if version == 1 || version == JOIN_VERSION => {
                decode(rest, version)
            }
            Some((version, _)) if *version > JOIN_VERSION => Err(LinkError::TooNew),
            _ => Err(LinkError::Malformed),
        }
    }
}

impl Callback {
    pub fn to_link(&self) -> String {
        let mut callback = self.clone();
        callback.addrs.truncate(MAX_ADDRS);
        let mut bytes = vec![BACK_VERSION];
        bytes.extend(super::protocol::encode(&callback));
        encode_link(BACK_PREFIX, &bytes)
    }

    pub fn parse(text: &str) -> Result<Self, LinkError> {
        let bytes = decode_link(text, BACK_PREFIX, &["odea:back/"])?;
        match bytes.split_first() {
            Some((&BACK_VERSION, rest)) => {
                super::protocol::decode(rest).map_err(|_| LinkError::Malformed)
            }
            Some((version, _)) if *version > BACK_VERSION => Err(LinkError::TooNew),
            _ => Err(LinkError::Malformed),
        }
    }
}
