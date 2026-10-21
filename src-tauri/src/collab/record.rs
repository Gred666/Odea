/* ============================================================
会话状态落盘（docs/协同编辑.md §3）：崩溃、强退以后接得上。

应用数据目录的 collab/ 下，同一时刻最多一套主持、一套做客：
- host.json：主持人的会话 id、邀请密钥、默认权限、标题、是哪篇笔记、允许过谁（成员号、权限）、
  拉黑了谁、端点绑的端口。Rust 的 Host 一有变化就重写（Host::persist）
- guest.json：访客的邀请链接（或者「附近」点进来的主持人地址）、只直连没有、标题、主持人的名字、
  开着哪几篇。命令层写
- host-docs/、guest-docs/：每篇一个 Loro 文档的快照（文件名是文档 id 的十六进制）。前端每隔几秒、
  每次存盘时交过来（collab_send 的 PIPE_SAVE），这里只存字节，不懂内容。一条连接里好几篇（设计 §22.5）
  以前只有一个 host.loro / guest.loro（版本 1），升上来以后那种记录不认

正常结束（停止协作、离开）就删掉。重启后还在 = 上次没正常结束：主持人那边出「继续上次的协作」，
用同一个会话 id、邀请密钥和端口重新起端点，允许过的人不再问，访客的断线重连自己就接上了；
双方的 CRDT 历史都在，合并不用退回文本 diff。
============================================================ */

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::protocol::{Permission, Scope};

pub const HOST_FILE: &str = "host.json";
pub const GUEST_FILE: &str = "guest.json";
const HOST_DOCS: &str = "host-docs";
const GUEST_DOCS: &str = "guest-docs";
/// 版本 1 只有一篇的那一份快照：删的时候顺手删掉
const OLD_STATES: [&str; 2] = ["host.loro", "guest.loro"];
const VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Host,
    Guest,
}

impl Role {
    /// (说明的文件, 放每篇快照的文件夹)
    fn files(self) -> (&'static str, &'static str) {
        match self {
            Role::Host => (HOST_FILE, HOST_DOCS),
            Role::Guest => (GUEST_FILE, GUEST_DOCS),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedRecord {
    /// 设备公钥（十六进制）
    pub id: String,
    pub member: u16,
    pub permission: Permission,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRecord {
    pub version: u32,
    /// 会话 id（十六进制）
    pub session: String,
    /// 邀请密钥（十六进制）：继续协作时旧链接照样有效
    pub secret: String,
    pub permission: Permission,
    pub title: String,
    /// 主持的是哪篇笔记（前端的笔记 id；Rust 不解释它）。文件夹、整个仓库的范围是空的
    pub note: String,
    /// 邀请的范围（版本 2 起）
    #[serde(default)]
    pub scope: Option<Scope>,
    pub approved: Vec<ApprovedRecord>,
    pub banned: Vec<String>,
    pub next_member: u16,
    /// 端点绑的端口（IPv4、IPv6）：重新起来时还用它们，访客手里链接里的地址才不作废
    pub ports: Vec<u16>,
    /// 最后一次写（Unix 毫秒）
    pub saved_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestRecord {
    pub version: u32,
    /// 邀请链接（「附近」点进来的是用主持人的公钥和地址拼的、不带邀请密钥的那种）
    pub link: String,
    pub nearby: bool,
    pub direct_only: bool,
    pub title: String,
    pub host_name: String,
    /// 开着哪几篇（文档 id）：重新加入时照样开
    #[serde(default)]
    pub docs: Vec<String>,
    pub saved_at: i64,
}

impl HostRecord {
    pub fn new(note: String, title: String, permission: Permission) -> Self {
        HostRecord {
            version: VERSION,
            session: String::new(),
            secret: String::new(),
            permission,
            title,
            note,
            scope: None,
            approved: Vec::new(),
            banned: Vec::new(),
            next_member: 1,
            ports: Vec::new(),
            saved_at: now_ms(),
        }
    }

    pub fn session_bytes(&self) -> Option<[u8; 16]> {
        hex_array(&self.session)
    }

    pub fn secret_bytes(&self) -> Option<[u8; 32]> {
        hex_array(&self.secret)
    }
}

impl GuestRecord {
    pub fn new(link: String, nearby: bool, direct_only: bool) -> Self {
        GuestRecord {
            version: VERSION,
            link,
            nearby,
            direct_only,
            title: String::new(),
            host_name: String::new(),
            docs: Vec::new(),
            saved_at: now_ms(),
        }
    }
}

pub fn hex_array<const N: usize>(text: &str) -> Option<[u8; N]> {
    let bytes = data_encoding::HEXLOWER
        .decode(text.trim().to_ascii_lowercase().as_bytes())
        .ok()?;
    <[u8; N]>::try_from(bytes.as_slice()).ok()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// 访客要来的附件缓存成 collab/cache/<路径的哈希>/<这个名字>：正文里写的最后一段，解开 %xx、
/// 按附件的规矩清洗（`layout::attachment_stem`）。「存一份到我的笔记」按路径存进自己的「附件」时
/// 文件名还是原来那个
pub fn cached_name(path: &str) -> String {
    let last = path.rsplit(['/', '\\']).next().unwrap_or_default();
    let name = percent_decode(last);
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, ext),
        _ => (name.as_str(), ""),
    };
    let ext = ext.to_ascii_lowercase();
    let ext = if ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        ext
    } else {
        String::new()
    };
    let mut stem = crate::vault::layout::attachment_stem(stem);
    if stem.is_empty() {
        stem = "图片".into();
    }
    if ext.is_empty() {
        stem
    } else {
        format!("{stem}.{ext}")
    }
}

/// `%E5%9B%BE.png` → `图.png`；不成对的 % 原样留着
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        match (
            bytes[i],
            bytes.get(i + 1).copied().and_then(hex),
            bytes.get(i + 2).copied().and_then(hex),
        ) {
            (b'%', Some(high), Some(low)) => {
                out.push((high * 16 + low) as u8);
                i += 3;
            }
            (byte, ..) => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 先写临时文件再改名：写到一半崩了也不会留下半个 JSON
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    std::fs::write(&temp, bytes)?;
    std::fs::rename(&temp, path)
}

pub fn save_json<T: Serialize>(dir: &Path, file: &str, value: &T) -> std::io::Result<()> {
    let text = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
    write_atomic(&dir.join(file), &text)
}

pub fn load_json<T: for<'de> Deserialize<'de>>(dir: &Path, file: &str) -> Option<T> {
    let text = std::fs::read(dir.join(file)).ok()?;
    serde_json::from_slice(&text).ok()
}

/// 一篇的快照放在哪：文件名是文档 id 的十六进制（id 里可能有不能进文件名的字）
fn state_path(dir: &Path, role: Role, doc: &str) -> PathBuf {
    dir.join(role.files().1)
        .join(format!("{}.loro", data_encoding::HEXLOWER.encode(doc.as_bytes())))
}

pub fn save_state(dir: &Path, role: Role, doc: &str, bytes: &[u8]) -> std::io::Result<()> {
    write_atomic(&state_path(dir, role, doc), bytes)
}

pub fn load_state(dir: &Path, role: Role, doc: &str) -> Option<Vec<u8>> {
    std::fs::read(state_path(dir, role, doc))
        .ok()
        .filter(|bytes| !bytes.is_empty())
}

/// 存着快照的那几篇（文档 id）
pub fn saved_docs(dir: &Path, role: Role) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir.join(role.files().1)) else {
        return Vec::new();
    };
    let mut docs: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let hex = name.strip_suffix(".loro")?;
            let bytes = data_encoding::HEXLOWER.decode(hex.as_bytes()).ok()?;
            String::from_utf8(bytes).ok()
        })
        .collect();
    docs.sort();
    docs
}

/// 正常结束：这一套都删掉
pub fn remove(dir: &Path, role: Role) {
    let (meta, docs) = role.files();
    let _ = std::fs::remove_file(dir.join(meta));
    let _ = std::fs::remove_dir_all(dir.join(docs));
    for old in OLD_STATES {
        if old.starts_with(if role == Role::Host { "host" } else { "guest" }) {
            let _ = std::fs::remove_file(dir.join(old));
        }
    }
}

/// 上次没正常结束的主持（说明和至少一篇的快照都在才算）
pub fn host_left(dir: &Path) -> Option<HostRecord> {
    let record: HostRecord = load_json(dir, HOST_FILE)?;
    let usable = record.version == VERSION
        && record.session_bytes().is_some()
        && record.secret_bytes().is_some()
        && !saved_docs(dir, Role::Host).is_empty();
    usable.then_some(record)
}

pub fn guest_left(dir: &Path) -> Option<GuestRecord> {
    let record: GuestRecord = load_json(dir, GUEST_FILE)?;
    (record.version == VERSION && !saved_docs(dir, Role::Guest).is_empty()).then_some(record)
}
