use super::*;

/* ---------------- 协作（docs/协同编辑.md） ----------------
网络在 collab/（Host / Guest），这里只是接到前端：
- 控制消息（加入请求、成员、连接状态）走 tauri-specta 的事件 CollabEvent
- 文档更新、光标、同步请求是不透明的字节：不走 JSON（一字节一个数字），
  Rust → 前端走前端登记的二进制 Channel（collab_pipe），前端 → Rust 走原始请求体（collab_send）。
  这两个命令不经 tauri-specta（它不认原始请求体），lib.rs 里和 specta 的命令合在一个 handler 里。
  帧：1 字节类型 + 2 字节会话号 + 2 字节成员号（都是小端）+ 1 字节文档 id 长度 + 文档 id + 内容，类型见 PIPE_*
同时好几个会话（设计 §25）：主持的（一篇、一个文件夹、整个仓库，§22.5）、做客的随便搭。端点（collab::Node）
只有一个，第一个会话开始时起、最后一个结束时关；会话按（窗口，会话号）认，会话号是前端起的。
一条连接里好几篇：访客要开哪篇，主持人这边问前端（CollabEvent 的 docOpen），前端用 collab_doc_answer 回话。
中继（设计 §6.4）：地址、名字、指纹记在 config.json 的 collab_relays，令牌在钥匙串（collab-relay:<地址>）。
令牌不出 Rust：前端只看得到「带没带令牌」，中继码也在这边拆、这边存。
落盘（设计 §3，collab/record.rs）：应用数据目录的 collab/ 下。文档 的状态前端经 collab_send（PIPE_SAVE）
交过来，这里只存字节；一个会话一个文件夹（collab/host/<会话 id>/、collab/guest/<随机 id>/），
主持人的记录 Host 自己写，访客的在这里写。
附件（设计 §7.2）：主持人那边访客要文件、传文件都变成事件到这里（forward_collab），查过
「正文里引用了、落在仓库的「附件」里」再读、再存；访客那边要来的图片缓存在 collab/cache/。 */

pub(in crate::commands) const PIPE_UPDATE: u8 = 1;
pub(in crate::commands) const PIPE_CURSOR: u8 = 2;
/// Rust → 前端：别人发来了状态向量，回他缺的；前端 → Rust：回给某人的 Sync2
pub(in crate::commands) const PIPE_SYNC_REPLY: u8 = 3;
/// Rust → 前端：刚连上某人，把自己的状态向量发给他；前端 → Rust：发给某人的 Sync1
pub(in crate::commands) const PIPE_SYNC_VECTOR: u8 = 4;
/// 前端 → Rust：文档 的状态，落盘（崩溃后接得上）
const PIPE_SAVE: u8 = 5;

/// 设备密钥在钥匙串里的名字（ed25519，第一次协作时生成。设计 §8.6）
const DEVICE_KEY: &str = "collab-device-key";
const TEAM_KEY: &str = "team-device-key";
/// 中继令牌在钥匙串里的名字：这个前缀 + 中继地址
const RELAY_TOKEN: &str = "collab-relay:";

/// 加入请求、成员变了、连接状态
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct CollabEvent {
    /// 哪个会话（会话号）；不属于哪个会话的（「附近」的列表、「附近」进来要主持人挑）是空
    pub session: Option<u16>,
    pub control: collab::Control,
}

/// 点开了一个 odea:// 链接（应用已经开着时）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct CollabLink(pub String);

/// 访客窗口交过来一份要存进仓库的（collab_copy_to_vault）：收到的仓库窗口去取（collab_take_copy）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct CollabCopyReady;

/// 访客窗口里共享的那一篇，存一份到仓库里
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SharedCopy {
    pub title: String,
    pub markdown: String,
    /// 正文里的图片：写的地址 → 从主持人那里要来的（本机缓存的文件，或者 base64）
    pub images: Vec<SharedImage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SharedImage {
    pub source: String,
    pub file: Option<String>,
    pub data: Option<String>,
}

enum Active {
    Host(Host),
    Guest(Guest),
}

/// 一个会话（docs/协同编辑.md §25.2）
struct Session {
    active: Active,
    /// 落盘的文件夹：collab/host/<会话 id>/ 或 collab/guest/<随机 id>/
    dir: PathBuf,
    /// 主持人：开始它的那个窗口的仓库（访客要附件、传附件读写它）
    vault: Option<Arc<Mutex<Vault>>>,
    /// 主持人：每篇正文里引用了哪些附件。文档 id → (正文里写的路径 → 仓库里的相对路径)。
    /// 前端按那篇所在的文件夹算好，正文一变就换一份。没在这里的那篇不给附件、不收粘贴
    refs: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
}

/// （窗口，会话号）
type SessionKey = (String, u16);

#[derive(Default)]
pub struct CollabHub {
    /// 端点（collab/node.rs）：第一个会话开始时起，最后一个结束时关。起会话、关端点都拿着这把锁，
    /// 「开始一个」和「最后一个结束」撞不上
    node: tokio::sync::Mutex<Option<Node>>,
    /// （窗口，会话号）→ 会话。会话号是前端起的，一个窗口里不重复；控制消息和字节只发给那个窗口
    /// （docs/仓库与启动器.md §4.3）
    sessions: Mutex<std::collections::HashMap<SessionKey, Session>>,
    /// 每个窗口登记的接收字节的 Channel（窗口标签 → Channel）
    pipes: Mutex<std::collections::HashMap<String, Channel<InvokeResponseBody>>>,
    /// 冷启动时带进来的链接：前端起来以后取走（collab_pending_link）
    pending_link: Mutex<Option<String>>,
    /// 访客窗口交过来、等着仓库窗口去存的那一份（collab_copy_to_vault）
    pending_copy: Mutex<Option<SharedCopy>>,
    /// 「附近」列表开着时（加入对话框里），和是哪个窗口开的
    nearby: Mutex<Option<collab::nearby::Nearby>>,
    nearby_owner: Mutex<Option<String>>,
    /// 上次没正常结束的做客已经给某个窗口看过了的（文件夹名）：同时开着几个仓库窗口时只问一次
    guest_resume_offered: Mutex<std::collections::HashSet<String>>,
}

impl CollabHub {
    pub fn set_pending_link(&self, link: String) {
        *self.pending_link.lock().unwrap() = Some(link);
    }

    /// 冷启动带进来的是一个邀请链接（还没被取走）：一个仓库都打不开的话开访客窗口去加入
    pub fn has_pending_invite(&self) -> bool {
        self.pending_link.lock().unwrap().as_deref().is_some_and(crate::workspace::is_invite)
    }

    /// 冷启动带进来的是团队仓库的链接（odea://vault/）：取走，交给启动器
    pub fn take_pending_vault_link(&self) -> Option<String> {
        let mut slot = self.pending_link.lock().unwrap();
        slot.take_if(|link| crate::workspace::is_vault_link(link))
    }

    /// 前端起的会话号在这个窗口里已经有了
    fn check_free(&self, label: &str, session: u16) -> Result<()> {
        if self.sessions.lock().unwrap().contains_key(&(label.to_string(), session)) {
            return Err(AppError::Invalid("这个会话号已经在用了".into()));
        }
        Ok(())
    }

    /// 借这个会话用一下（锁不跨 await：要等的拿把手出来在锁外等）
    fn with<T>(&self, label: &str, session: u16, use_it: impl FnOnce(&mut Session) -> T) -> Option<T> {
        self.sessions.lock().unwrap().get_mut(&(label.to_string(), session)).map(use_it)
    }

    fn host<T>(&self, label: &str, session: u16, use_it: impl FnOnce(&Host) -> T) -> Option<T> {
        self.with(label, session, |found| match &found.active {
            Active::Host(host) => Some(use_it(host)),
            Active::Guest(_) => None,
        })
        .flatten()
    }

    fn guest<T>(&self, label: &str, session: u16, use_it: impl FnOnce(&Guest) -> T) -> Option<T> {
        self.with(label, session, |found| match &found.active {
            Active::Guest(guest) => Some(use_it(guest)),
            Active::Host(_) => None,
        })
        .flatten()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollabIdentity {
    /// 设备公钥（十六进制）：别人那里按它给我挑颜色
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollabHosting {
    /// 会话 id（十六进制）：继续上次的协作按它认
    pub key: String,
    pub link: String,
    pub id: String,
    pub members: Vec<MemberInfo>,
}

/// 上次没正常结束的协作（崩溃、强退）：重启后问一句要不要接着来
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollabResume {
    pub hosts: Vec<HostResume>,
    pub guests: Vec<GuestResume>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostResume {
    /// 是哪一次（落盘文件夹的名字）
    pub key: String,
    /// 主持的那篇笔记的 id（文件夹、整个仓库的范围是空的）
    pub note: String,
    /// 邀请的范围
    pub scope: Option<collab::Scope>,
    pub title: String,
    /// 有几位访客（允许过的）
    pub guests: u32,
    /// 最后一次落盘（Unix 毫秒）
    pub saved_at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GuestResume {
    /// 是哪一次（落盘文件夹的名字）
    pub key: String,
    pub title: String,
    pub host_name: String,
    pub saved_at: f64,
}

/// 主持人这篇正文里引用的一个附件
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRef {
    /// 正文里写的（访客按它来要）
    pub path: String,
    /// 仓库里的相对路径（前端按这篇所在的文件夹算好）
    pub vault_path: String,
}

/// 加入之前看一眼链接：带没带中继（访客要知情，设计 §6.5）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InvitePreview {
    /// 主持人配的中继（名字或主机名）
    pub relay: Option<String>,
}

/// 访客的回连链接，和这时自己能不能被连进来
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollabCallback {
    pub link: String,
    pub reach: Reach,
}

/// 一台配好的中继（给界面看：令牌只说有没有）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RelayInfo {
    pub url: String,
    /// 主机名（不是默认端口的带端口）
    pub host: String,
    pub name: Option<String>,
    pub has_token: bool,
    /// 自签名证书、按指纹认的
    pub pinned: bool,
}

impl RelayInfo {
    fn of(relay: &Relay) -> Self {
        RelayInfo {
            url: relay.url.clone(),
            host: relay.host(),
            name: relay.name.clone(),
            has_token: relay.token.is_some(),
            pinned: relay.fingerprint.is_some(),
        }
    }
}

/// 配好的中继：config.json 里的地址 + 钥匙串里的令牌。读不出来的那台跳过
pub(in crate::commands) fn load_relays(data_dir: &std::path::Path) -> Vec<Relay> {
    use crate::sync::secret;
    boot::Config::load(data_dir)
        .collab_relays
        .into_iter()
        .filter_map(|saved| {
            let token = secret::load_text(&format!("{RELAY_TOKEN}{}", saved.url)).ok().flatten();
            Relay::new(&saved.url, token, saved.fingerprint.as_deref(), saved.name).ok()
        })
        .collect()
}

/// 存一台（同一个地址的换掉）。令牌进钥匙串，存不进去就整个不存（不然以后连不上又说不清为什么）
pub(in crate::commands) fn save_relay(data_dir: &std::path::Path, relay: &Relay) -> Result<()> {
    use crate::sync::secret;
    let account = format!("{RELAY_TOKEN}{}", relay.url);
    match &relay.token {
        Some(token) => secret::save_text(&account, token)
            .map_err(|error| AppError::Io(format!("令牌存不进系统钥匙串：{error}")))?,
        None => {
            let _ = secret::remove(&account);
        }
    }
    let mut config = boot::Config::load(data_dir);
    let saved = boot::SavedRelay {
        url: relay.url.clone(),
        name: relay.name.clone(),
        fingerprint: relay.fingerprint.map(|pin| data_encoding::HEXLOWER.encode(&pin)),
    };
    match config.collab_relays.iter_mut().find(|item| item.url == relay.url) {
        Some(item) => *item = saved,
        None => config.collab_relays.push(saved),
    }
    config.save(data_dir).map_err(|error| AppError::Io(error.to_string()))
}

fn relay_infos(data_dir: &std::path::Path) -> Vec<RelayInfo> {
    load_relays(data_dir).iter().map(RelayInfo::of).collect()
}

/// 落盘的目录：应用数据目录的 collab/
pub(in crate::commands) fn collab_dir(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("collab")
}

/// 访客要来的图片缓存在这里：一次做客一个文件夹（key 是落盘文件夹的名字），离开时清掉。
/// 不放在落盘的文件夹里：协作结束了（那个文件夹删了）还能「存一份到我的笔记」
fn attachment_cache(data_dir: &std::path::Path, key: &str) -> PathBuf {
    collab_dir(data_dir).join("cache").join(key)
}

/// 访客的落盘记录（dir 是这一次的文件夹）：改一处、写回去（没有就算了）
fn update_guest_record(dir: &std::path::Path, change: impl FnOnce(&mut GuestRecord)) {
    if let Some(mut record) = collab_record::load_json::<GuestRecord>(dir, collab_record::GUEST_FILE) {
        change(&mut record);
        record.saved_at = collab_record::now_ms();
        let _ = collab_record::save_json(dir, collab_record::GUEST_FILE, &record);
    }
}

/// 仓库里的相对路径规范化：反斜杠换成斜杠，`.` 消掉；有 `..`、绝对路径、盘符的一律不认
fn clean_vault_path(path: &str) -> Option<String> {
    let path = path.replace('\\', "/");
    if path.starts_with('/') || path.contains(':') {
        return None;
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => return None,
            part => parts.push(part),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// 主持人：访客要的附件。只给这篇正文里引用了的、规范化之后落在这篇的附件文件夹里的（设计 §7.2；
/// Odea 的仓库是「附件」，Obsidian 的库照它的设置）：不然写个 `../../` 就能读到主持人硬盘上的任意文件，
/// 写个 `其他笔记.md` 就能读到别的笔记
async fn read_attachment(hub: &CollabHub, label: &str, session: u16, doc: &str, path: &str) -> std::result::Result<Vec<u8>, String> {
    let note = doc.to_string();
    let (vault, vault_path) = hub
        .with(label, session, |found| (found.vault.clone(), found.refs.get(doc).and_then(|refs| refs.get(path)).cloned()))
        .ok_or_else(|| "协作已经停了".to_string())?;
    let vault = vault.ok_or_else(|| "这一边没开仓库".to_string())?;
    let vault_path = vault_path.ok_or_else(|| "这个文件不在这篇正文里".to_string())?;
    let clean = clean_vault_path(&vault_path).ok_or_else(|| "只给这篇笔记的附件".to_string())?;
    let vault = vault.clone();
    let read = tauri::async_runtime::spawn_blocking(move || -> std::result::Result<Vec<u8>, String> {
        let file = vault
            .lock()
            .map_err(|_| "仓库锁坏了".to_string())?
            .attachment_for_guest(&note, &clean)
            .map_err(|error| match error {
                AppError::Invalid(message) => message,
                other => other.to_string(),
            })?;
        let size = std::fs::metadata(&file).map_err(|error| error.to_string())?.len();
        if size > collab::protocol::MAX_ATTACHMENT as u64 {
            return Err("文件太大了，附件最多 50 MB".into());
        }
        std::fs::read(&file).map_err(|error| error.to_string())
    })
    .await;
    read.map_err(|error| error.to_string())?
}

/// 主持人：访客粘贴的文件存进这篇的附件文件夹，回从这篇引用它的路径
async fn store_attachment(
    hub: &CollabHub,
    label: &str,
    session: u16,
    doc: String,
    name: String,
    bytes: Vec<u8>,
) -> std::result::Result<String, String> {
    let (vault, hosted) = hub
        .with(label, session, |found| (found.vault.clone(), found.refs.contains_key(&doc)))
        .ok_or_else(|| "协作已经停了".to_string())?;
    if !hosted {
        return Err("这一篇不在协作里".into());
    }
    let vault = vault.ok_or_else(|| "这一边没开仓库".to_string())?;
    let note = doc;
    let stored = tauri::async_runtime::spawn_blocking(move || {
        let mut vault = vault.lock().map_err(|_| "仓库锁坏了".to_string())?;
        vault
            .attach(&DocRef::note(note), &name, &bytes)
            .map(|attachment| attachment.link)
            .map_err(|error| error.to_string())
    })
    .await;
    stored.map_err(|error| error.to_string())?
}

/// 设备密钥：钥匙串里有就用，没有就生成一把存进去。钥匙串用不了时用一把临时的
/// （这次能协作，只是下次别人认不出是同一台设备）
fn device_key(data_dir: &std::path::Path) -> iroh::SecretKey {
    stored_key(data_dir, DEVICE_KEY, "device-key")
}

/// 团队仓库用的设备密钥（docs/协同编辑.md §22.3）：一台设备一把，几个团队仓库共用；和会话式协作那把分开
/// （两个端点同时开着，同一把密钥在中继那边会互相顶掉）
pub(crate) fn team_key(data_dir: &std::path::Path) -> iroh::SecretKey {
    stored_key(data_dir, TEAM_KEY, "team-key")
}

/// 钥匙串里叫 keychain 的那把密钥；设了 ODEA_DATA_DIR 时是数据目录里叫 file 的文件
fn stored_key(data_dir: &std::path::Path, keychain: &str, file: &str) -> iroh::SecretKey {
    use crate::sync::secret;
    // 换了数据目录（开发、测试，boot.rs 的 ODEA_DATA_DIR）：密钥放在那个目录里，不碰系统钥匙串。
    // 同一台电脑上开两个实例互相连（docs/协同编辑.md §19.2）也靠这个：钥匙串里只有一把，两边就成了同一台
    if std::env::var_os("ODEA_DATA_DIR").is_some() {
        let file = collab_dir(data_dir).join(file);
        if let Ok(text) = std::fs::read_to_string(&file) {
            if let Ok(bytes) = data_encoding::HEXLOWER.decode(text.trim().as_bytes()) {
                if let Ok(bytes) = <[u8; 32]>::try_from(bytes.as_slice()) {
                    return iroh::SecretKey::from_bytes(&bytes);
                }
            }
        }
        let key = iroh::SecretKey::generate();
        let _ = collab_record::write_atomic(&file, data_encoding::HEXLOWER.encode(&key.to_bytes()).as_bytes());
        return key;
    }
    if let Ok(Some(text)) = secret::load_text(keychain) {
        if let Ok(bytes) = data_encoding::HEXLOWER.decode(text.trim().as_bytes()) {
            if let Ok(bytes) = <[u8; 32]>::try_from(bytes.as_slice()) {
                return iroh::SecretKey::from_bytes(&bytes);
            }
        }
    }
    let key = iroh::SecretKey::generate();
    if let Err(error) = secret::save_text(keychain, &data_encoding::HEXLOWER.encode(&key.to_bytes())) {
        eprintln!("协作：设备密钥存不进钥匙串，这次用临时的：{error}");
    }
    key
}

/// 我的名字：设过就用设的，没设过用系统的用户名
pub(in crate::commands) fn collab_name(data_dir: &std::path::Path) -> String {
    boot::Config::load(data_dir)
        .collab_name
        .filter(|name| !name.trim().is_empty())
        .or_else(|| std::env::var("USERNAME").ok().or_else(|| std::env::var("USER").ok()))
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "我".into())
}

/// 一个会话吐出来的事件：控制消息发事件（带上会话号），字节塞进二进制 Channel；附件请求在这里读仓库、存仓库
fn forward_collab<R: Runtime>(
    app: AppHandle<R>,
    state: &AppState,
    label: String,
    session: u16,
    dir: PathBuf,
    guest: bool,
    mut events: tokio::sync::mpsc::UnboundedReceiver<collab::Event>,
) {
    let hub = state.collab.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            let (kind, member, doc, bytes) = match event {
                collab::Event::Control(control) => {
                    if guest {
                        note_guest(&dir, &control);
                    }
                    if let Err(error) = (CollabEvent { session: Some(session), control }).emit_to(&app, label.as_str()) {
                        eprintln!("通知前端失败: {error}");
                    }
                    continue;
                }
                collab::Event::AttachGet { request, doc, path, .. } => {
                    let (hub, label) = (hub.clone(), label.clone());
                    tauri::async_runtime::spawn(async move {
                        let reply = read_attachment(&hub, &label, session, &doc, &path).await.map(AttachReply::Data);
                        hub.host(&label, session, |host| host.answer_attachment(request, reply));
                    });
                    continue;
                }
                collab::Event::AttachPut { request, doc, name, bytes, .. } => {
                    let (hub, label) = (hub.clone(), label.clone());
                    tauri::async_runtime::spawn(async move {
                        let reply = store_attachment(&hub, &label, session, doc, name, bytes).await.map(AttachReply::Link);
                        hub.host(&label, session, |host| host.answer_attachment(request, reply));
                    });
                    continue;
                }
                collab::Event::Update { from, doc, bytes } => (PIPE_UPDATE, from, doc, bytes),
                collab::Event::Cursor { from, doc, bytes } => (PIPE_CURSOR, from, doc, bytes),
                collab::Event::SyncRequest { from, doc, vector } => (PIPE_SYNC_REPLY, from, doc, vector),
                collab::Event::SyncStart { with, doc } => (PIPE_SYNC_VECTOR, with, doc, Vec::new()),
            };
            let frame = pipe_frame(kind, session, member, &doc, &bytes);
            if let Some(pipe) = hub.pipes.lock().unwrap().get(&label) {
                let _ = pipe.send(InvokeResponseBody::Raw(frame));
            }
        }
    });
}

/// 端点自己的事件（「附近」进来、我主持着好几个，要挑进哪一个）：发给每个在主持的窗口
fn forward_node<R: Runtime>(
    app: AppHandle<R>,
    hub: Arc<CollabHub>,
    mut events: tokio::sync::mpsc::UnboundedReceiver<collab::Event>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            let collab::Event::Control(control) = event else { continue };
            let labels: std::collections::BTreeSet<String> = hub
                .sessions
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, found)| matches!(found.active, Active::Host(_)))
                .map(|((label, _), _)| label.clone())
                .collect();
            for label in labels {
                let event = CollabEvent { session: None, control: control.clone() };
                if let Err(error) = event.emit_to(&app, label.as_str()) {
                    eprintln!("通知前端失败: {error}");
                }
            }
        }
    });
}

/// 拿着端点的锁：没有就起一个。ports 是想绑回的端口（继续上次的协作）
async fn node_for<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    slot: &mut Option<Node>,
    ports: Vec<u16>,
) -> Result<Node> {
    if let Some(node) = slot.as_ref() {
        return Ok(node.clone());
    }
    let data_dir = state.data_dir.clone();
    let (secret_key, name, relays) =
        blocking(move || Ok((device_key(&data_dir), collab_name(&data_dir), load_relays(&data_dir)))).await?;
    let (events, receiver) = tokio::sync::mpsc::unbounded_channel();
    let options = NodeOptions { secret_key, name, mdns: true, relays, portmap: true, firewall: true, ports };
    let node = Node::start(options, events).await.map_err(AppError::Io)?;
    forward_node(app.clone(), state.collab.clone(), receiver);
    *slot = Some(node.clone());
    Ok(node)
}

/// 一个会话都不剩了：关端点（拿着端点的锁调）
async fn close_if_idle(hub: &CollabHub, slot: &mut Option<Node>) {
    if !hub.sessions.lock().unwrap().is_empty() {
        return;
    }
    if let Some(node) = slot.take() {
        node.close().await;
    }
}

/// 管道上的一帧：1 字节类型 + 2 字节会话号 + 2 字节成员号 + 1 字节文档 id 长度 + 文档 id + 内容
pub(in crate::commands) fn pipe_frame(kind: u8, session: u16, member: u16, doc: &str, payload: &[u8]) -> Vec<u8> {
    let id = &doc.as_bytes()[..doc.len().min(collab::protocol::MAX_DOC_ID)];
    let mut frame = Vec::with_capacity(payload.len() + id.len() + 6);
    frame.push(kind);
    frame.extend_from_slice(&session.to_le_bytes());
    frame.extend_from_slice(&member.to_le_bytes());
    frame.push(id.len() as u8);
    frame.extend_from_slice(id);
    frame.extend_from_slice(payload);
    frame
}

/// 拆开前端发来的一帧：(类型, 会话号, 成员号, 文档 id, 内容)
pub(in crate::commands) fn split_pipe_frame(frame: &[u8]) -> std::result::Result<(u8, u16, u16, &str, &[u8]), String> {
    let (&kind, rest) = frame.split_first().ok_or("空帧")?;
    let (head, rest) = rest.split_at_checked(4).ok_or("帧太短")?;
    let session = u16::from_le_bytes([head[0], head[1]]);
    let member = u16::from_le_bytes([head[2], head[3]]);
    let (&len, rest) = rest.split_first().ok_or("帧太短")?;
    let (doc, payload) = rest.split_at_checked(len as usize).ok_or("帧太短")?;
    let doc = std::str::from_utf8(doc).map_err(|_| "文档 id 不对")?;
    Ok((kind, session, member, doc, payload))
}

/// 访客的落盘记录跟着状态走：进去了记下标题、主持人叫什么；结束了（被拒、被移出、主持人停了）
/// 就没什么可接着的了，删掉
fn note_guest(dir: &std::path::Path, control: &collab::Control) {
    match control {
        collab::Control::Status { status: collab::Status::Connected { title, .. } } => {
            let title = title.clone();
            update_guest_record(dir, move |record| record.title = title);
        }
        collab::Control::Members { members } => {
            if let Some(host) = members.iter().find(|member| member.host) {
                let name = host.name.clone();
                update_guest_record(dir, move |record| record.host_name = name);
            }
        }
        collab::Control::Status { status: collab::Status::Ended { .. } } => {
            collab_record::remove_session(dir);
        }
        _ => {}
    }
}

/// 收掉一个会话（主持的停止、做客的离开）。正常结束：落盘的删掉、访客要来的图片缓存清掉
async fn end_session(state: &AppState, key: &SessionKey) {
    let removed = state.collab.sessions.lock().unwrap().remove(key);
    let Some(found) = removed else { return };
    match found.active {
        Active::Host(host) => host.stop().await,
        Active::Guest(guest) => {
            guest.leave().await;
            collab_record::remove_session(&found.dir);
            let _ = std::fs::remove_dir_all(attachment_cache(&state.data_dir, &collab_record::dir_key(&found.dir)));
        }
    }
}

/// 关窗口时：这个窗口的几个会话也算正常结束（告诉别人、删掉落盘的记录），重启后不再问「继续上次的协作」。
/// 别的窗口的会话不动；一个都不剩了关端点
pub async fn end_collab(state: &AppState, label: &str) {
    let hub = &state.collab;
    let mut slot = hub.node.lock().await;
    let keys: Vec<SessionKey> = hub.sessions.lock().unwrap().keys().filter(|(owner, _)| owner == label).cloned().collect();
    for key in keys {
        end_session(state, &key).await;
    }
    close_if_idle(hub, &mut slot).await;
    drop(slot);
    hub.pipes.lock().unwrap().remove(label);
    if hub.nearby_owner.lock().unwrap().as_deref() == Some(label) {
        let nearby = hub.nearby.lock().unwrap().take();
        if let Some(nearby) = nearby {
            nearby.stop().await;
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn collab_identity(state: State<'_, AppState>) -> Result<CollabIdentity> {
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let key = device_key(&data_dir);
        Ok(CollabIdentity {
            id: collab::id_text(key.public().as_bytes()),
            name: collab_name(&data_dir),
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn collab_set_name(state: State<'_, AppState>, name: String) -> Result<()> {
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let mut config = boot::Config::load(&data_dir);
        let name = name.trim().chars().take(40).collect::<String>();
        config.collab_name = (!name.is_empty()).then_some(name);
        config.save(&data_dir).map_err(|error| AppError::Io(error.to_string()))
    })
    .await?;
    // 正在协作：别人那里的成员表跟着换、「附近」广播的昵称也换
    let name = collab_name(&state.data_dir);
    for found in state.collab.sessions.lock().unwrap().values() {
        match &found.active {
            Active::Host(host) => host.set_name(&name),
            Active::Guest(guest) => guest.set_name(&name),
        }
    }
    let node = state.collab.node.lock().await.clone();
    if let Some(node) = node {
        node.set_name(&name);
    }
    if let Some(net) = state.team.net() {
        for team in state.team.windows.lock().unwrap().values() {
            net.set_name(team, &name);
        }
    }
    Ok(())
}

/// 开始协作（主持人）：挂到端点上（没有就起一个，第一次在网络上接受连接时 Windows 会弹防火墙）、返回邀请链接。
/// session 是前端起的会话号；note 是主持的那篇笔记的 id（一篇的范围；文件夹、整个仓库是空的，只记进落盘的记录里）；
/// scope 是邀请的范围（设计 §22.5）；resume 是上次没正常结束的那一次（同一个会话 id、邀请密钥、端口，允许过的人不再问）
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn collab_host<R: Runtime>(
    app: AppHandle<R>,
    ws: Ws,
    state: State<'_, AppState>,
    session: u16,
    title: String,
    permission: Permission,
    note: String,
    scope: collab::Scope,
    resume: Option<String>,
) -> Result<CollabHosting> {
    state.collab.check_free(&ws.label, session)?;
    let data_dir = state.data_dir.clone();
    let key = resume.clone();
    let (name, record) = blocking(move || {
        let base = collab_dir(&data_dir);
        let record = key.and_then(|key| collab_record::host_left(&base.join("host").join(key)));
        Ok((collab_name(&data_dir), record))
    })
    .await?;
    let record = record.filter(|record| record.note == note);
    if resume.is_some() && record.is_none() {
        return Err(AppError::NotFound("上次协作的记录已经没了".into()));
    }
    let trusted = load_trusted(&state.data_dir)
        .into_iter()
        .filter_map(|peer| Some((collab_record::hex_array(&peer.id)?, peer.permission)))
        .collect();
    let hub = &state.collab;
    let mut slot = hub.node.lock().await;
    let ports = record.as_ref().map(|record| record.ports.clone()).unwrap_or_default();
    let node = node_for(&app, &state, &mut slot, ports).await?;
    let (events, receiver) = tokio::sync::mpsc::unbounded_channel();
    let options = HostOptions {
        name,
        title,
        permission,
        note,
        scope,
        record: Some(collab_dir(&state.data_dir)),
        resume: record,
        trusted,
    };
    let host = match Host::start(&node, options, events).await {
        Ok(host) => host,
        Err(error) => {
            close_if_idle(hub, &mut slot).await;
            return Err(AppError::Io(error));
        }
    };
    let dir = collab_record::host_dir(&collab_dir(&state.data_dir), &host.session());
    forward_collab(app, &state, ws.label.clone(), session, dir.clone(), false, receiver);
    let hosting = CollabHosting {
        key: collab_record::dir_key(&dir),
        link: host.invite().to_link(),
        id: host.id(),
        members: host.members(),
    };
    let found = Session { active: Active::Host(host), dir, vault: Some(ws.vault.clone()), refs: Default::default() };
    hub.sessions.lock().unwrap().insert((ws.label.clone(), session), found);
    Ok(hosting)
}

/// 换掉邀请链接：旧的作废，已经在里面的人不受影响
#[tauri::command]
#[specta::specta]
pub async fn collab_reset_invite(caller: Caller, state: State<'_, AppState>, session: u16) -> Result<String> {
    state
        .collab
        .host(&caller.label, session, |host| host.reset_invite().to_link())
        .ok_or_else(|| AppError::Invalid("这次协作已经停了".into()))
}

/// 链接认不认得出（加入之前先问一句：坏链接当场说清楚，不用等连接）；带没带中继
#[tauri::command]
#[specta::specta]
pub async fn collab_check_link(link: String) -> Result<InvitePreview> {
    let invite = Invite::parse(&link).map_err(|error| AppError::Invalid(error.to_string()))?;
    Ok(InvitePreview { relay: invite.relay.map(|relay| relay.label()) })
}

/// 加入（访客）：马上返回，进展从 CollabEvent 的 status 里出来。session 是前端起的会话号。
/// direct_only：不经链接里主持人的中继（访客的 IP 不让那台机器看到，设计 §6.5）
#[tauri::command]
#[specta::specta]
pub async fn collab_join<R: Runtime>(
    app: AppHandle<R>,
    caller: Caller,
    state: State<'_, AppState>,
    session: u16,
    link: String,
    direct_only: bool,
) -> Result<()> {
    let invite = Invite::parse(&link).map_err(|error| AppError::Invalid(error.to_string()))?;
    join_with(app, &state, &caller.label, session, invite, false, direct_only, None).await
}

/// 加入（链接的、附近的、继续上次的都走这里）：先记下怎么加入的（崩溃后接得上），再起访客。
/// resume 是继续上次的那一次（落盘文件夹的名字）
#[allow(clippy::too_many_arguments)]
async fn join_with<R: Runtime>(
    app: AppHandle<R>,
    state: &AppState,
    label: &str,
    session: u16,
    invite: Invite,
    nearby: bool,
    direct_only: bool,
    resume: Option<String>,
) -> Result<()> {
    state.collab.check_free(label, session)?;
    let key = resume.unwrap_or_else(collab_record::new_guest_key);
    let dir = collab_record::guest_dir(&collab_dir(&state.data_dir), &key);
    let link = invite.to_link();
    let data_dir = state.data_dir.clone();
    let record_dir = dir.clone();
    let name = blocking(move || {
        // 继续上次的：落盘的状态前端已经读走了，这里重新记一份
        collab_record::remove(&record_dir, Role::Guest);
        let _ = std::fs::remove_dir_all(attachment_cache(&data_dir, &key));
        let record = GuestRecord::new(link, nearby, direct_only);
        let _ = collab_record::save_json(&record_dir, collab_record::GUEST_FILE, &record);
        Ok(collab_name(&data_dir))
    })
    .await?;
    let hub = &state.collab;
    let mut slot = hub.node.lock().await;
    let node = node_for(&app, state, &mut slot, Vec::new()).await?;
    let (events, receiver) = tokio::sync::mpsc::unbounded_channel();
    // 做客的这一边没有附件要读写（那是主持人的事），用不着仓库
    forward_collab(app, state, label.to_string(), session, dir.clone(), true, receiver);
    let options = GuestOptions { name, invite, use_host_relay: !direct_only, nearby };
    let guest = match Guest::join(&node, options, events).await {
        Ok(guest) => guest,
        Err(error) => {
            close_if_idle(hub, &mut slot).await;
            return Err(AppError::Io(error));
        }
    };
    let found = Session { active: Active::Guest(guest), dir, vault: None, refs: Default::default() };
    hub.sessions.lock().unwrap().insert((label.to_string(), session), found);
    Ok(())
}

/// 主持人改了标题：之后进来的人看到新的
#[tauri::command]
#[specta::specta]
pub async fn collab_set_title(caller: Caller, state: State<'_, AppState>, session: u16, title: String) -> Result<()> {
    state.collab.host(&caller.label, session, |host| host.set_title(title));
    Ok(())
}

/// 停止这一次协作（主持人）/ 离开（访客）。一个会话都不剩了关端点
#[tauri::command]
#[specta::specta]
pub async fn collab_stop(caller: Caller, state: State<'_, AppState>, session: u16) -> Result<()> {
    let hub = &state.collab;
    let mut slot = hub.node.lock().await;
    end_session(&state, &(caller.label.clone(), session)).await;
    close_if_idle(hub, &mut slot).await;
    Ok(())
}

/// 访客窗口（没开仓库）里「存一份到我的笔记」：交给最近用过的仓库窗口去存 —— 一个都没开着就先打开
/// 最近的仓库。那个窗口收到 CollabCopyReady 以后来取（collab_take_copy），新建一篇、存图片、存正文
#[tauri::command]
#[specta::specta]
pub async fn collab_copy_to_vault<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, copy: SharedCopy) -> Result<()> {
    *state.collab.pending_copy.lock().unwrap() = Some(copy);
    let handle = app.clone();
    let label = blocking(move || crate::workspace::recent_vault_window(&handle)).await?;
    if let Err(error) = CollabCopyReady.emit_to(&app, label.as_str()) {
        eprintln!("通知前端失败: {error}");
    }
    Ok(())
}

/// 访客窗口交过来、等着存的那一份（取一次就清掉）
#[tauri::command]
#[specta::specta]
pub async fn collab_take_copy(state: State<'_, AppState>) -> Result<Option<SharedCopy>> {
    Ok(state.collab.pending_copy.lock().unwrap().take())
}

/// 冷启动时点进来的 odea:// 链接（取一次就清掉）
#[tauri::command]
#[specta::specta]
pub async fn collab_pending_link(state: State<'_, AppState>) -> Result<Option<String>> {
    Ok(state.collab.pending_link.lock().unwrap().take())
}

/// 前端登记接收字节的 Channel（不经 tauri-specta）
#[tauri::command]
pub fn collab_pipe(window: tauri::WebviewWindow, state: State<'_, AppState>, channel: Channel<InvokeResponseBody>) {
    state.collab.pipes.lock().unwrap().insert(window.label().to_string(), channel);
}

/// 前端发出来的字节（不经 tauri-specta：原始请求体，不是一字节一个数字的 JSON 数组）
#[tauri::command]
pub fn collab_send(window: tauri::WebviewWindow, state: State<'_, AppState>, request: Request<'_>) -> std::result::Result<(), String> {
    let InvokeBody::Raw(frame) = request.body() else {
        return Err("collab_send 要原始字节".into());
    };
    let (kind, session, member, doc, payload) = split_pipe_frame(frame)?;
    let sessions = state.collab.sessions.lock().unwrap();
    let Some(found) = sessions.get(&(window.label().to_string(), session)) else {
        return Ok(());
    };
    if kind == PIPE_SAVE {
        // 文档的状态落盘：在阻塞线程里写，不卡 IPC
        let role = match found.active {
            Active::Host(_) => Role::Host,
            Active::Guest(_) => Role::Guest,
        };
        let (dir, doc, bytes) = (found.dir.clone(), doc.to_string(), payload.to_vec());
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = collab_record::save_state(&dir, role, &doc, &bytes) {
                eprintln!("协作：会话状态写不进去：{error}");
            }
        });
        return Ok(());
    }
    match (&found.active, kind) {
        (Active::Host(host), PIPE_UPDATE) => host.send_update(doc, payload.to_vec()),
        (Active::Host(host), PIPE_CURSOR) => host.send_cursor(doc, payload),
        (Active::Host(host), PIPE_SYNC_VECTOR) => host.send_sync(member, doc, SyncKind::Vector, payload.to_vec()),
        (Active::Host(host), PIPE_SYNC_REPLY) => host.send_sync(member, doc, SyncKind::Reply, payload.to_vec()),
        (Active::Guest(guest), PIPE_UPDATE) => guest.send_update(doc, payload.to_vec()),
        (Active::Guest(guest), PIPE_CURSOR) => guest.send_cursor(doc, payload),
        (Active::Guest(guest), PIPE_SYNC_VECTOR) => guest.send_sync(doc, SyncKind::Vector, payload.to_vec()),
        (Active::Guest(guest), PIPE_SYNC_REPLY) => guest.send_sync(doc, SyncKind::Reply, payload.to_vec()),
        _ => {}
    }
    Ok(())
}

mod attachments;
mod docs;
mod nearby;
mod relays;
mod resume;
mod trusted;

pub use attachments::*;
pub use docs::*;
pub use nearby::*;
pub use relays::*;
pub use resume::*;
pub use trusted::*;
