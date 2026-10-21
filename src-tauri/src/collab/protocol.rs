/* ============================================================
odea/collab/3 的帧和消息（docs/协同编辑.md §7；2 是换成 Loro 以后的，§20；3 是一条连接里好几篇，§22.5）。

一条 iroh 连接（ALPN `odea/collab/3`）上：
- 控制流（双向流，访客先开）：Hello → Welcome{…, 范围} / Reject；之后 Members / Permission / Kick / Bye，
  主持人发来范围里的树（Tree，前端给的 JSON，这里不解析）；访客要新建一篇（Create → Created）
- 文档流（双向流，访客要哪篇开哪篇，一篇一条）：第一帧 Open{文档 id}，主持人问过前端（这篇在不在范围里）
  才接着读，不给就回 DocErr 收尾。之后 Sync1 / Sync2 / Update。内容是 Loro 的二进制（版本向量、增量），
  这里不解析，原样交给前端。主持人发给某位访客的积压太多时丢掉排着的更新、发一个 Resync，
  访客收到就重新发一次 Sync1，主持人回一份 Sync2 补齐（queue.rs，设计 §5.4）。访客关掉那篇就把流收尾
- 附件（访客开的双向流，一个文件一条）：AttachGet{哪篇, 正文里写的路径} → AttachData{字节} / AttachErr；
  AttachPut{哪篇, 文件名, 字节} → AttachLink{从这篇引用它的路径} / AttachErr（设计 §7.2）
- 光标：QUIC 数据报，内容前面带上是哪篇（1 字节长度 + 文档 id）。主持人发给访客的再在最前面带 2 字节
  成员号（小端），访客发给主持人的不带（主持人从连接认出是谁）
- 转发（设计 §20.9）：访客 B 替连不上主持人的 C 转发。B 在自己和主持人的连接上为 C 另开流，
  每条先发一帧 Forward{C 的公钥, 哪种流}（控制流还带着 C 的 Hello），之后原样搬字节；主持人把这些流
  当成成员 C。C 的光标数据报 B 前面加上 FF FF + C 的成员号再转，主持人发给 C 的同样包一层

每条流上是长度前缀的帧：`varint 长度 + 1 字节类型 + 内容`，长度算上类型那 1 字节。
控制消息的内容用 postcard 编码（很小的结构，不用 JSON）。认不出的类型直接跳过。
不兼容的改动换 ALPN（odea/collab/3），兼容的在 Hello 的 features 里声明。
============================================================ */

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const ALPN: &[u8] = b"odea/collab/3";
pub const PROTOCOL_VERSION: u16 = 3;
/// 兼容的能力。CRDT 的大版本写在这里：双方不一致时直说，不硬连（设计 §7.4）。
/// loro1：Loro 1.x 的格式；resync：认得 Resync 帧（慢的访客补齐）；attach：附件流；
/// forward：认得访客替别人开的转发流（§20.9）；docs：一条连接里好几篇（§22.5）
pub const FEATURES: &[&str] = &["loro1", "resync", "attach", "forward", "docs"];
/// 文档 id 最长多少字节（数据报里用 1 字节记长度）
pub const MAX_DOC_ID: usize = 255;
/// 控制流、文档流的单帧上限。最大的是加入时的快照（几百 KB）；再大就当是坏数据
pub const MAX_FRAME: usize = 32 << 20;
/// 附件单个文件的上限（和仓库里粘贴附件的上限一样）
pub const MAX_ATTACHMENT: usize = 50 << 20;
/// 附件流的单帧上限：文件 + 文件名之类的零头
pub const MAX_ATTACH_FRAME: usize = MAX_ATTACHMENT + (64 << 10);
/// 握手证明绑在这一条 TLS 会话上的标签（export_keying_material 的 label）
pub const PROOF_LABEL: &[u8] = b"odea-collab-hello";

/// 帧类型
pub mod kind {
    /// 访客开文档流的第一帧：要的是哪篇（文档 id，UTF-8）
    pub const OPEN: u8 = 0;
    pub const HELLO: u8 = 1;
    pub const WELCOME: u8 = 2;
    pub const REJECT: u8 = 3;
    pub const MEMBERS: u8 = 4;
    pub const PERMISSION: u8 = 5;
    pub const KICK: u8 = 6;
    pub const BYE: u8 = 7;
    /// 访客 → 主持人（控制流）：我改名字了（UTF-8）。主持人换掉成员表里的、再广播。
    /// 旧版本认不出直接忽略，不用进特性列表
    pub const NAME: u8 = 8;
    /// 主持人 → 访客（控制流）：范围里的树（前端给的 JSON，UTF-8）。变了再发一次整棵
    pub const TREE: u8 = 9;
    /// 访客 → 主持人（控制流）：新建一篇（postcard 的 CreateDoc）
    pub const CREATE: u8 = 10;
    /// 主持人 → 访客（控制流）：建好了 / 建不了（postcard 的 CreatedDoc）
    pub const CREATED: u8 = 11;
    /// 状态向量：「我有这些，你把我缺的发过来」
    pub const SYNC1: u8 = 16;
    /// 回 SYNC1：对方缺的更新
    pub const SYNC2: u8 = 17;
    pub const UPDATE: u8 = 18;
    /// 主持人 → 访客：积压的更新丢掉了，重新发一次 Sync1
    pub const RESYNC: u8 = 19;
    /// 主持人 → 访客（文档流）：这篇不给（一句话，UTF-8），接着把流收尾
    pub const DOC_ERR: u8 = 20;
    /// 附件流：访客要一个文件（内容是正文里写的路径，UTF-8）
    pub const ATTACH_GET: u8 = 32;
    /// 附件流：文件的字节
    pub const ATTACH_DATA: u8 = 33;
    /// 附件流：访客粘贴的文件（postcard 的 AttachPut）
    pub const ATTACH_PUT: u8 = 34;
    /// 附件流：存好了，从这篇引用它的路径（UTF-8）
    pub const ATTACH_LINK: u8 = 35;
    /// 附件流：给不了（一句话，UTF-8）
    pub const ATTACH_ERR: u8 = 36;
    /// 访客替别人开的流的第一帧（postcard 的 Forward，设计 §20.9）
    pub const FORWARD: u8 = 40;
}

/// 权限：能改，或者只读（主持人随时能改）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    Edit,
    Read,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub version: u16,
    pub features: Vec<String>,
    pub session: [u8; 16],
    /// HMAC(邀请密钥, 这条连接导出的密钥材料)：证明拿着邀请链接，截获了也没法在别的连接上重放。
    /// 从局域网「附近」点进来的没有（主持人照样要确认）
    pub proof: Option<[u8; 32]>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Member {
    /// 主持人是 0，访客按加入的顺序编号；断线重连还是原来的号
    pub member: u16,
    /// 设备公钥
    pub id: [u8; 32],
    pub name: String,
    pub permission: Permission,
    /// 经哪位访客转发进来的（他的成员号，设计 §20.9）
    pub via: Option<u16>,
}

/// 邀请的范围（设计 §22.5）：一篇、一个文件夹、整个仓库
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ScopeKind {
    Doc,
    Folder,
    Vault,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub kind: ScopeKind,
    /// 一篇的话是它的文档 id（访客进来就开它）；文件夹、整个仓库是空的
    pub doc: String,
    /// 给访客看的名字：那篇的标题、文件夹名、仓库名
    pub name: String,
}

impl Scope {
    #[cfg(test)]
    pub fn doc(doc: impl Into<String>, title: impl Into<String>) -> Self {
        Scope { kind: ScopeKind::Doc, doc: doc.into(), name: title.into() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Welcome {
    pub member: u16,
    pub permission: Permission,
    /// 文档标题（一篇的范围）：主持人允许之后才给（「附近」的广播里不带）
    pub title: String,
    pub members: Vec<Member>,
    pub scope: Scope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
// 不打内部标签：postcard 不支持（它不自描述）。给前端的 JSON 是 "declined" 或 { version: { theirs } }
#[serde(rename_all = "camelCase")]
pub enum RejectReason {
    /// 主持人拒绝了
    Declined,
    /// 被移出了这次协作
    Kicked,
    /// 链接不对：会话已经结束、链接被重置过
    BadInvite,
    /// 协议版本对不上
    Version { theirs: u16 },
    /// 主持人停止了协作
    Ended,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reject {
    pub reason: RejectReason,
}

/// 转发流是哪一种
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ForwardStream {
    Control,
    Doc,
    Attach,
}

/// 访客 B 替 C 开的流的第一帧：之后这条流上的字节都是 C 的（设计 §20.9）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Forward {
    /// C 的设备公钥（C 和 B 之间那条连接认证过的）
    pub id: [u8; 32],
    pub stream: ForwardStream,
    /// 控制流：C 发给 B 的 Hello，原样
    pub hello: Option<Hello>,
    /// B 拿邀请密钥核过 C 的证明（绑在 C 和 B 那条连接上，主持人自己核不了）
    pub proven: bool,
}

/// 访客要一个附件：哪篇正文里写的哪个路径
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachGet {
    pub doc: String,
    pub path: String,
}

/// 访客粘贴的文件：主持人存进仓库的「附件」（按这篇的附件位置），回从这篇引用它的路径
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachPut {
    pub doc: String,
    pub name: String,
    pub bytes: Vec<u8>,
}

/// 访客要在范围里新建一篇（只读的不行）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateDoc {
    /// 访客这边的请求号：回话里带回来
    pub request: u32,
    /// 放在范围里的哪个文件夹（树上的路径，空串是范围的根）
    pub folder: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatedDoc {
    pub request: u32,
    /// 建好了：它的文档 id；建不了：为什么
    pub result: Result<String, String>,
}

/* ---------------- 帧 ---------------- */

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("连接断了：{0}")]
    Io(#[from] std::io::Error),
    #[error("帧太大（{0} 字节）")]
    TooLarge(usize),
    #[error("消息认不出：{0}")]
    Decode(String),
}

pub async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    kind: u8,
    payload: &[u8],
) -> Result<(), FrameError> {
    let length = payload.len() + 1;
    if length > MAX_ATTACH_FRAME {
        return Err(FrameError::TooLarge(length));
    }
    let mut buffer = Vec::with_capacity(length + 5);
    write_varint(&mut buffer, length as u64);
    buffer.push(kind);
    buffer.extend_from_slice(payload);
    writer.write_all(&buffer).await?;
    Ok(())
}

/// 读一帧。流在两帧之间正常结束了是 None
pub async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<Option<(u8, Vec<u8>)>, FrameError> {
    read_frame_up_to(reader, MAX_FRAME).await
}

/// 读一帧，最多 max 字节（附件流用 MAX_ATTACH_FRAME）。超长的不分配内存，直接报错
pub async fn read_frame_up_to<R: AsyncRead + Unpin>(
    reader: &mut R,
    max: usize,
) -> Result<Option<(u8, Vec<u8>)>, FrameError> {
    let Some(length) = read_varint(reader).await? else {
        return Ok(None);
    };
    let length = usize::try_from(length).map_err(|_| FrameError::TooLarge(usize::MAX))?;
    if length == 0 {
        return Err(FrameError::Decode("空帧".into()));
    }
    if length > max {
        return Err(FrameError::TooLarge(length));
    }
    let kind = reader.read_u8().await?;
    let mut payload = vec![0; length - 1];
    reader.read_exact(&mut payload).await?;
    Ok(Some((kind, payload)))
}

fn write_varint(buffer: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            buffer.push(byte);
            return;
        }
        buffer.push(byte | 0x80);
    }
}

async fn read_varint<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Option<u64>, FrameError> {
    let mut value = 0u64;
    for index in 0..10 {
        let byte = match reader.read_u8().await {
            Ok(byte) => byte,
            // 第一个字节就读不到：流正常结束
            Err(error) if index == 0 && error.kind() == std::io::ErrorKind::UnexpectedEof => {
                return Ok(None)
            }
            Err(error) => return Err(error.into()),
        };
        value |= u64::from(byte & 0x7f) << (7 * index);
        if byte & 0x80 == 0 {
            return Ok(Some(value));
        }
    }
    Err(FrameError::Decode("长度太长".into()))
}

pub fn encode<T: Serialize>(value: &T) -> Vec<u8> {
    postcard::to_allocvec(value).expect("控制消息编码不会失败")
}

pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, FrameError> {
    postcard::from_bytes(bytes).map_err(|error| FrameError::Decode(error.to_string()))
}

/* ---------------- 握手证明 ---------------- */

/// HMAC-SHA256(邀请密钥, 连接导出的 32 字节密钥材料)
pub fn proof(secret: &[u8; 32], keying: &[u8; 32]) -> [u8; 32] {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret);
    let tag = ring::hmac::sign(&key, keying);
    let mut out = [0; 32];
    out.copy_from_slice(tag.as_ref());
    out
}

/// 常数时间比对
pub fn verify_proof(secret: &[u8; 32], keying: &[u8; 32], proof: &[u8; 32]) -> bool {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret);
    ring::hmac::verify(&key, keying, proof).is_ok()
}

/* ---------------- 光标数据报 ---------------- */

/// 主持人转给访客的光标：前面带上是谁的
pub fn tag_cursor(member: u16, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 2);
    out.extend_from_slice(&member.to_le_bytes());
    out.extend_from_slice(payload);
    out
}

pub fn untag_cursor(datagram: &[u8]) -> Option<(u16, &[u8])> {
    let (head, payload) = datagram.split_at_checked(2)?;
    Some((u16::from_le_bytes([head[0], head[1]]), payload))
}

/// 数据报的内容前面带上是哪篇：1 字节长度 + 文档 id。长了的截不了，调用方先查 MAX_DOC_ID
pub fn tag_doc(doc: &str, payload: &[u8]) -> Vec<u8> {
    let id = &doc.as_bytes()[..doc.len().min(MAX_DOC_ID)];
    let mut out = Vec::with_capacity(payload.len() + id.len() + 1);
    out.push(id.len() as u8);
    out.extend_from_slice(id);
    out.extend_from_slice(payload);
    out
}

pub fn untag_doc(bytes: &[u8]) -> Option<(&str, &[u8])> {
    let (&len, rest) = bytes.split_first()?;
    let (id, payload) = rest.split_at_checked(len as usize)?;
    Some((std::str::from_utf8(id).ok()?, payload))
}

/// 转发的数据报打头的两个字节：成员号到不了 0xFFFF，后面是文档 id 的长度（不会接着是 0xFF 0xFF 的成员号）
const FORWARD_MARK: [u8; 2] = [0xff, 0xff];

/// 经访客 B 转的数据报：FF FF + C 的成员号 + 原来的内容
pub fn wrap_forwarded(member: u16, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 4);
    out.extend_from_slice(&FORWARD_MARK);
    out.extend_from_slice(&member.to_le_bytes());
    out.extend_from_slice(payload);
    out
}

/// 是转发的话拆出 C 的成员号和原来的内容
pub fn unwrap_forwarded(datagram: &[u8]) -> Option<(u16, &[u8])> {
    let rest = datagram.strip_prefix(&FORWARD_MARK[..])?;
    untag_cursor(rest)
}
