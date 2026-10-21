/* ============================================================
共享仓库在这台设备上的 CRDT（docs/协同编辑.md §20.3、§20.5）。不碰网络、不碰仓库：
net.rs 搬它导出的字节，bridge.rs 拿它和 .md 对账。

.odea/share/ 里：
- vault.loro：仓库文档。几张表，每一项整项后改的赢（值是一段 JSON / 一行字，不是嵌套的容器）：
  docs（每篇的元数据）、tree（逻辑目录的清单，节点 id → 那一行）、files（附件清单）、
  peers（Loro 的 peer → 设备公钥，历史版本按它认人）、settings（日程开没开）
- docs/<id>.loro：每篇一个，正文是 Text `body`（和编辑器里一样，不含属性块）
- state.json：每篇上次写盘 / 从磁盘读进来时是哪一版（frontiers）—— 外部改动按这一版分叉打进来

peer：每次打开随机一个（崩溃前没落盘的改动已经发出去了的话，重启后再用同一个 peer 会和别人手里的撞号），
前端打开一篇时也另给一个（new_peer），都记进 peers 表。
落盘：改过的文档停手一会儿（service.rs）整个导出快照写下去，不写每一包。
============================================================ */

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};

use loro::{ExportMode, Frontiers, LoroDoc, LoroMap, LoroValue, UpdateOptions, ValueOrContainer, VersionVector};
use serde::{Deserialize, Serialize};

use crate::vault::fsio;

/// 正文在文档里的名字（和前端 collab/session.ts 的 TEXT_NAME 一样）
pub const BODY: &str = "body";
const DOCS: &str = "docs";
const TREE: &str = "tree";
const FILES: &str = "files";
const PEERS: &str = "peers";
const SETTINGS: &str = "settings";
/// 本机连续的改动多久之内并成一个（秒）。历史版本按「停顿 5 分钟」分，这个粒度够细
pub const MERGE_INTERVAL: i64 = 60;
/// 历史版本：同一台设备、停顿不超过这么久（秒）的算一版
const VERSION_GAP: i64 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum DocKind {
    Note,
    Day,
    Goal,
}

/// 一篇的元数据（仓库文档 docs 表里的一项）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocMeta {
    pub kind: DocKind,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub pinned: bool,
    /// 归档时间（毫秒）
    #[serde(default)]
    pub archived: Option<i64>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub created: i64,
    #[serde(default)]
    pub deleted: bool,
}

/// 附件清单的一项
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEntry {
    /// SHA-256（十六进制）
    pub hash: String,
    pub size: u64,
    #[serde(default)]
    pub deleted: bool,
}

/// 一个更新落在哪个文档上
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Target {
    Vault,
    Doc(String),
}

impl Target {
    /// 线上的写法：仓库文档是空串
    pub fn wire(&self) -> &str {
        match self {
            Target::Vault => "",
            Target::Doc(id) => id,
        }
    }

    pub fn from_wire(text: &str) -> Option<Target> {
        if text.is_empty() {
            Some(Target::Vault)
        } else {
            valid_doc_id(text).then(|| Target::Doc(text.to_string()))
        }
    }
}

/// 文档 id 要能当文件名：笔记的 UUID、`day-2026-10-21`、`goal-week-2026-10-19`
pub fn valid_doc_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// 本机出的一包改动（发给连着的成员）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Update {
    pub target: Target,
    pub bytes: Vec<u8>,
}

/// 对账时发的：我手里每个文档到哪一版了
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Summary {
    pub vault: Vec<u8>,
    pub docs: Vec<(String, Vec<u8>)>,
}

/// 历史里的一版（P10.3.4）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    /// 这一版第一次和最后一次改动的时间（毫秒）
    pub from: i64,
    pub to: i64,
    /// 谁改的（设备公钥，十六进制）；认不出的 peer 是 None
    pub device: Option<String>,
    /// 这一版结束时的样子（Frontiers 的编码）
    pub frontiers: Vec<u8>,
}

#[derive(Default, Serialize, Deserialize)]
struct State {
    /// 文档 id → 上次和磁盘对齐时的 frontiers（base64）
    #[serde(default)]
    written: BTreeMap<String, String>,
}

/// import 进来但缺着前面的改动、Loro 先挂着的包：对账时原样补给别人（导出里没有它们，
/// 和前端 session.ts 的 pendingBlobs 一个道理）
struct Pending {
    bytes: Vec<u8>,
    until: Vec<(u64, i32)>,
}

pub struct Replica {
    dir: PathBuf,
    device: String,
    peer: u64,
    vault: LoroDoc,
    docs: BTreeMap<String, LoroDoc>,
    written: HashMap<String, Frontiers>,
    unsaved: BTreeSet<Target>,
    state_dirty: bool,
    pending: HashMap<Target, Vec<Pending>>,
}

fn random_peer() -> u64 {
    // Loro 的 peer 不能是 u64::MAX（它留作别的用）
    u64::from_le_bytes(crate::collab::random_bytes::<8>()) >> 1
}

fn configure(doc: &LoroDoc, peer: u64) {
    let _ = doc.set_peer_id(peer);
    doc.set_record_timestamp(true);
    doc.set_change_merge_interval(MERGE_INTERVAL);
}

fn string_of(value: Option<ValueOrContainer>) -> Option<String> {
    match value? {
        ValueOrContainer::Value(LoroValue::String(text)) => Some(text.to_string()),
        _ => None,
    }
}

fn strings(map: &LoroMap) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    map.for_each(|key, value| {
        if let ValueOrContainer::Value(LoroValue::String(text)) = value {
            out.insert(key.to_string(), text.to_string());
        }
    });
    out
}

/// ours 里有没有 theirs 没有的改动
fn has_more(ours: &VersionVector, theirs: &VersionVector) -> bool {
    ours.iter()
        .any(|(peer, end)| theirs.get(peer).copied().unwrap_or(0) < *end)
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(text: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(text).ok()
}

/// 把 text 改成 new：先按字比（两篇都不长的时候很快），超时了按行
fn set_text(text: &loro::LoroText, new: &str) {
    if text.to_string() == new {
        return;
    }
    let quick = UpdateOptions {
        timeout_ms: Some(300.0),
        use_refined_diff: true,
    };
    if text.update(new, quick).is_err() {
        let _ = text.update_by_line(new, UpdateOptions::default());
    }
}

impl Replica {
    /// 打开（文件夹是空的就是一个空的副本）。哪个文档坏了读不进来就跳过（记日志），对账时从别人那里补
    pub fn open(dir: &Path, device: &str) -> Result<Self, String> {
        std::fs::create_dir_all(dir.join("docs")).map_err(|error| error.to_string())?;
        let peer = random_peer();
        let vault = LoroDoc::new();
        configure(&vault, peer);
        if let Ok(bytes) = std::fs::read(dir.join("vault.loro")) {
            if let Err(error) = vault.import(&bytes) {
                eprintln!("共享仓库：vault.loro 读不进来：{error}");
            }
        }
        let mut docs = BTreeMap::new();
        if let Ok(entries) = std::fs::read_dir(dir.join("docs")) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let Some(id) = name.strip_suffix(".loro").filter(|id| valid_doc_id(id)) else {
                    continue;
                };
                let doc = LoroDoc::new();
                configure(&doc, peer);
                match std::fs::read(entry.path()).map_err(|error| error.to_string()).and_then(|bytes| {
                    doc.import(&bytes).map(|_| ()).map_err(|error| error.to_string())
                }) {
                    Ok(()) => {
                        docs.insert(id.to_string(), doc);
                    }
                    Err(error) => eprintln!("共享仓库：{name} 读不进来：{error}"),
                }
            }
        }
        let state: State = std::fs::read_to_string(dir.join("state.json"))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let written = state
            .written
            .iter()
            .filter_map(|(id, text)| Some((id.clone(), Frontiers::decode(&unb64(text)?).ok()?)))
            .collect();
        let mut replica = Self {
            dir: dir.to_path_buf(),
            device: device.to_string(),
            peer,
            vault,
            docs,
            written,
            unsaved: BTreeSet::new(),
            state_dirty: false,
            pending: HashMap::new(),
        };
        replica.register_peer(peer);
        Ok(replica)
    }

    /// 前端打开一篇时给它的 peer（记进 peers 表）
    pub fn new_peer(&mut self) -> (u64, Option<Update>) {
        let peer = random_peer();
        (peer, self.register_peer(peer))
    }

    fn register_peer(&mut self, peer: u64) -> Option<Update> {
        let device = self.device.clone();
        self.edit_vault(|vault| {
            vault.get_map(PEERS).insert(&peer.to_string(), device.as_str()).is_ok()
        })
    }

    /// 改仓库文档：edit 返回有没有改，改了就导出这一包
    fn edit_vault(&mut self, edit: impl FnOnce(&LoroDoc) -> bool) -> Option<Update> {
        let before = self.vault.oplog_vv();
        if !edit(&self.vault) {
            return None;
        }
        self.vault.commit();
        if self.vault.oplog_vv() == before {
            return None;
        }
        self.unsaved.insert(Target::Vault);
        let bytes = self.vault.export(ExportMode::updates(&before)).ok()?;
        Some(Update {
            target: Target::Vault,
            bytes,
        })
    }

    /// 改过的写下去：整个快照（197KB 的文档 4ms），原子替换
    pub fn save(&mut self) -> Result<(), String> {
        for target in std::mem::take(&mut self.unsaved) {
            let (doc, path) = match &target {
                Target::Vault => (&self.vault, self.dir.join("vault.loro")),
                Target::Doc(id) => match self.docs.get(id) {
                    Some(doc) => (doc, self.dir.join("docs").join(format!("{id}.loro"))),
                    None => continue,
                },
            };
            let bytes = doc.export(ExportMode::Snapshot).map_err(|error| error.to_string())?;
            fsio::write_atomic_bytes(&path, &bytes).map_err(|error| error.to_string())?;
        }
        if self.state_dirty {
            let state = State {
                written: self
                    .written
                    .iter()
                    .map(|(id, frontiers)| (id.clone(), b64(&frontiers.encode())))
                    .collect(),
            };
            let text = serde_json::to_string(&state).map_err(|error| error.to_string())?;
            fsio::write_atomic(&self.dir.join("state.json"), &text).map_err(|error| error.to_string())?;
            self.state_dirty = false;
        }
        Ok(())
    }

    pub fn has_unsaved(&self) -> bool {
        !self.unsaved.is_empty() || self.state_dirty
    }

    /* ---------------- 每一篇 ---------------- */

    fn doc_entry(&mut self, id: &str) -> &LoroDoc {
        let peer = self.peer;
        self.docs.entry(id.to_string()).or_insert_with(|| {
            let doc = LoroDoc::new();
            configure(&doc, peer);
            doc
        })
    }

    /// 元数据表里有的所有篇（删了的也在，deleted 标着）
    pub fn all_meta(&self) -> BTreeMap<String, DocMeta> {
        strings(&self.vault.get_map(DOCS))
            .into_iter()
            .filter(|(id, _)| valid_doc_id(id))
            .filter_map(|(id, json)| Some((id, serde_json::from_str(&json).ok()?)))
            .collect()
    }

    pub fn meta(&self, id: &str) -> Option<DocMeta> {
        string_of(self.vault.get_map(DOCS).get(id)).and_then(|json| serde_json::from_str(&json).ok())
    }

    /// 元数据变了才写（整项后改的赢）
    pub fn set_meta(&mut self, id: &str, meta: &DocMeta) -> Option<Update> {
        if self.meta(id).as_ref() == Some(meta) {
            return None;
        }
        let json = serde_json::to_string(meta).ok()?;
        self.edit_vault(|vault| vault.get_map(DOCS).insert(id, json.as_str()).is_ok())
    }

    pub fn text(&self, id: &str) -> String {
        self.docs
            .get(id)
            .map(|doc| doc.get_text(BODY).to_string())
            .unwrap_or_default()
    }

    /// 给前端的：这一篇的整个状态（没有就先建一个空的）
    pub fn snapshot(&mut self, id: &str) -> Vec<u8> {
        self.doc_entry(id).export(ExportMode::Snapshot).unwrap_or_default()
    }

    /// 上次和磁盘对齐时的正文
    #[cfg(test)]
    pub fn written_text(&self, id: &str) -> Option<String> {
        let doc = self.docs.get(id)?;
        let frontiers = self.written.get(id)?;
        if *frontiers == doc.oplog_frontiers() {
            return Some(doc.get_text(BODY).to_string());
        }
        doc.fork_at(frontiers).ok().map(|fork| fork.get_text(BODY).to_string())
    }

    /// 磁盘上的和 CRDT 里的一致了（刚写完盘）
    pub fn mark_written(&mut self, id: &str) {
        if let Some(doc) = self.docs.get(id) {
            let frontiers = doc.oplog_frontiers();
            if self.written.get(id) != Some(&frontiers) {
                self.written.insert(id.to_string(), frontiers);
                self.state_dirty = true;
            }
        }
    }

    /// 这一篇在这台设备上写过盘 / 从磁盘读进来过
    pub fn was_written(&self, id: &str) -> bool {
        self.written.contains_key(id)
    }

    /// CRDT 里有磁盘上还没有的改动
    pub fn needs_write(&self, id: &str) -> bool {
        match (self.docs.get(id), self.written.get(id)) {
            (Some(doc), Some(frontiers)) => doc.oplog_frontiers() != *frontiers,
            (Some(doc), None) => !doc.get_text(BODY).is_empty(),
            _ => false,
        }
    }

    /// 磁盘上这一篇的正文（本机编辑器、别的程序、应用自己改的）打进 CRDT（设计 §20.5）。
    /// 和上次对齐时的正文比，一样就没事；不一样的话，从那一版分叉出去把差异打上、再合回来 ——
    /// 这期间别人的改动（还没写盘的）照常合并。返回要发出去的包（正文的、可能还有 peers 表的）
    pub fn ingest(&mut self, id: &str, body: &str) -> Vec<Update> {
        let written = self.written.get(id).cloned();
        let doc = self.doc_entry(id).clone();
        let text = doc.get_text(BODY);
        let current = doc.oplog_frontiers();
        let base = match &written {
            Some(frontiers) if *frontiers != current => match doc.fork_at(frontiers) {
                Ok(fork) => fork.get_text(BODY).to_string(),
                Err(_) => text.to_string(),
            },
            _ => text.to_string(),
        };
        if base == body {
            if written.is_none() {
                self.mark_written(id);
            }
            return Vec::new();
        }
        let before = doc.oplog_vv();
        let mut out = Vec::new();
        let on_disk = match written.filter(|frontiers| *frontiers != current) {
            // 磁盘上的就是最新的那一版改出来的：直接改
            None => {
                set_text(&text, body);
                doc.commit();
                doc.oplog_frontiers()
            }
            // CRDT 里有还没写盘的（别人的）：从磁盘上那一版分叉，另一个 peer 改，合回来
            Some(frontiers) => {
                let Ok(fork) = doc.fork_at(&frontiers) else {
                    set_text(&text, body);
                    doc.commit();
                    return self.finish_ingest(id, &doc, &before, doc.oplog_frontiers(), out);
                };
                fork.set_record_timestamp(true);
                out.extend(self.register_peer(fork.peer_id()));
                let fork_before = fork.oplog_vv();
                set_text(&fork.get_text(BODY), body);
                fork.commit();
                if let Ok(bytes) = fork.export(ExportMode::updates(&fork_before)) {
                    let _ = doc.import(&bytes);
                }
                fork.oplog_frontiers()
            }
        };
        self.finish_ingest(id, &doc, &before, on_disk, out)
    }

    fn finish_ingest(
        &mut self,
        id: &str,
        doc: &LoroDoc,
        before: &VersionVector,
        on_disk: Frontiers,
        mut out: Vec<Update>,
    ) -> Vec<Update> {
        self.written.insert(id.to_string(), on_disk);
        self.state_dirty = true;
        if doc.oplog_vv() != *before {
            self.unsaved.insert(Target::Doc(id.to_string()));
            if let Ok(bytes) = doc.export(ExportMode::updates(before)) {
                out.push(Update {
                    target: Target::Doc(id.to_string()),
                    bytes,
                });
            }
        }
        out
    }

    /* ---------------- 对账、收别人的 ---------------- */

    pub fn summary(&self) -> Summary {
        Summary {
            vault: self.vault.oplog_vv().encode(),
            docs: self
                .docs
                .iter()
                .map(|(id, doc)| (id.clone(), doc.oplog_vv().encode()))
                .collect(),
        }
    }

    /// 对方发来 Summary：回它缺的（还有手里挂着的包）
    pub fn answer(&self, theirs: &Summary) -> Vec<Update> {
        let mut out = Vec::new();
        let vault_vv = VersionVector::decode(&theirs.vault).unwrap_or_default();
        if has_more(&self.vault.oplog_vv(), &vault_vv) {
            if let Ok(bytes) = self.vault.export(ExportMode::updates(&vault_vv)) {
                out.push(Update {
                    target: Target::Vault,
                    bytes,
                });
            }
        }
        let their_docs: HashMap<&str, &Vec<u8>> =
            theirs.docs.iter().map(|(id, vv)| (id.as_str(), vv)).collect();
        for (id, doc) in &self.docs {
            let vv = their_docs
                .get(id.as_str())
                .and_then(|bytes| VersionVector::decode(bytes).ok())
                .unwrap_or_default();
            if has_more(&doc.oplog_vv(), &vv) {
                if let Ok(bytes) = doc.export(ExportMode::updates(&vv)) {
                    out.push(Update {
                        target: Target::Doc(id.clone()),
                        bytes,
                    });
                }
            }
        }
        for (target, blobs) in &self.pending {
            for blob in blobs {
                out.push(Update {
                    target: target.clone(),
                    bytes: blob.bytes.clone(),
                });
            }
        }
        out
    }

    /// 别人的改动。返回有没有带来新东西（有才转给别人、才写盘）
    pub fn import(&mut self, target: &Target, bytes: &[u8]) -> Result<bool, String> {
        let doc = match target {
            Target::Vault => self.vault.clone(),
            Target::Doc(id) => self.doc_entry(id).clone(),
        };
        let before = doc.oplog_vv();
        let status = doc.import(bytes).map_err(|error| error.to_string())?;
        if let Some(pending) = status.pending {
            let until = pending.iter().map(|(peer, (_, end))| (*peer, *end)).collect();
            self.pending.entry(target.clone()).or_default().push(Pending {
                bytes: bytes.to_vec(),
                until,
            });
        }
        if let Some(blobs) = self.pending.get_mut(target) {
            let version = doc.oplog_vv();
            blobs.retain(|blob| {
                blob.until
                    .iter()
                    .any(|(peer, end)| version.get(peer).copied().unwrap_or(0) < *end)
            });
        }
        let changed = doc.oplog_vv() != before;
        if changed {
            self.unsaved.insert(target.clone());
        }
        Ok(changed)
    }

    /* ---------------- 树、附件、设置 ---------------- */

    /// 清单：节点 id → 那一行（父节点、排序键、内容）
    pub fn tree(&self) -> BTreeMap<String, String> {
        strings(&self.vault.get_map(TREE))
    }

    /// 改清单的几行（None 是删掉那个节点）
    pub fn edit_tree(&mut self, lines: &[(String, Option<String>)]) -> Option<Update> {
        if lines.is_empty() {
            return None;
        }
        self.edit_vault(|vault| {
            let map = vault.get_map(TREE);
            for (id, line) in lines {
                let _ = match line {
                    Some(line) => map.insert(id, line.as_str()),
                    None => map.delete(id),
                };
            }
            true
        })
    }

    pub fn files(&self) -> BTreeMap<String, FileEntry> {
        strings(&self.vault.get_map(FILES))
            .into_iter()
            .filter_map(|(path, json)| Some((path, serde_json::from_str(&json).ok()?)))
            .collect()
    }

    pub fn set_file(&mut self, path: &str, entry: &FileEntry) -> Option<Update> {
        let current = string_of(self.vault.get_map(FILES).get(path))
            .and_then(|json| serde_json::from_str::<FileEntry>(&json).ok());
        if current.as_ref() == Some(entry) {
            return None;
        }
        let json = serde_json::to_string(entry).ok()?;
        self.edit_vault(|vault| vault.get_map(FILES).insert(path, json.as_str()).is_ok())
    }

    /// 日程开没开（建共享时记下，之后谁改了大家跟着改）
    pub fn journal(&self) -> Option<bool> {
        match self.vault.get_map(SETTINGS).get("journal")? {
            ValueOrContainer::Value(LoroValue::Bool(on)) => Some(on),
            _ => None,
        }
    }

    pub fn set_journal(&mut self, on: bool) -> Option<Update> {
        if self.journal() == Some(on) {
            return None;
        }
        self.edit_vault(|vault| vault.get_map(SETTINGS).insert("journal", on).is_ok())
    }

    /// 这个 peer 是哪台设备
    pub fn device_of(&self, peer: u64) -> Option<String> {
        string_of(self.vault.get_map(PEERS).get(&peer.to_string()))
    }

    /* ---------------- 历史版本（P10.3.4） ---------------- */

    /// 这一篇的历史，旧的在前：同一台设备、停顿不超过 5 分钟的改动并成一版
    pub fn history(&self, id: &str) -> Vec<Version> {
        let Some(doc) = self.docs.get(id) else { return Vec::new() };
        let heads: Vec<loro::ID> = doc.oplog_frontiers().iter().collect();
        let mut changes = Vec::new();
        let _ = doc.travel_change_ancestors(&heads, &mut |change| {
            changes.push(change);
            ControlFlow::Continue(())
        });
        changes.sort_by_key(|change| (change.timestamp, change.lamport));
        let peers: HashMap<u64, Option<String>> = changes
            .iter()
            .map(|change| (change.id.peer, self.device_of(change.id.peer)))
            .collect();
        let mut versions: Vec<Version> = Vec::new();
        let mut seen = VersionVector::new();
        for change in changes {
            let end = change.id.counter + change.len as i32;
            let entry = seen.entry(change.id.peer).or_insert(0);
            *entry = (*entry).max(end);
            let device = peers.get(&change.id.peer).cloned().flatten();
            let at = change.timestamp * 1000;
            let frontiers = doc.vv_to_frontiers(&seen).encode();
            match versions.last_mut() {
                Some(last) if last.device == device && at - last.to <= VERSION_GAP * 1000 => {
                    last.to = at;
                    last.frontiers = frontiers;
                }
                _ => versions.push(Version {
                    from: at,
                    to: at,
                    device,
                    frontiers,
                }),
            }
        }
        versions
    }

    /// 某一版时的正文
    pub fn text_at(&self, id: &str, frontiers: &[u8]) -> Result<String, String> {
        let doc = self.docs.get(id).ok_or("没有这一篇的历史")?;
        let frontiers = Frontiers::decode(frontiers).map_err(|error| error.to_string())?;
        let fork = doc.fork_at(&frontiers).map_err(|error| error.to_string())?;
        Ok(fork.get_text(BODY).to_string())
    }

    /// 恢复到某一版：一次新的改动（别人那里也恢复）
    pub fn restore(&mut self, id: &str, frontiers: &[u8]) -> Result<Option<Update>, String> {
        let doc = self.docs.get(id).ok_or("没有这一篇的历史")?.clone();
        let frontiers = Frontiers::decode(frontiers).map_err(|error| error.to_string())?;
        let before = doc.oplog_vv();
        doc.revert_to(&frontiers).map_err(|error| error.to_string())?;
        doc.commit();
        if doc.oplog_vv() == before {
            return Ok(None);
        }
        self.unsaved.insert(Target::Doc(id.to_string()));
        let bytes = doc.export(ExportMode::updates(&before)).map_err(|error| error.to_string())?;
        Ok(Some(Update {
            target: Target::Doc(id.to_string()),
            bytes,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (tempfile::TempDir, Replica, Replica) {
        let dir = tempfile::tempdir().unwrap();
        let a = Replica::open(&dir.path().join("a"), "aa").unwrap();
        let b = Replica::open(&dir.path().join("b"), "bb").unwrap();
        (dir, a, b)
    }

    fn deliver(updates: Vec<Update>, to: &mut Replica) {
        for update in updates {
            to.import(&update.target, &update.bytes).unwrap();
        }
    }

    #[test]
    fn edits_on_disk_merge_with_unwritten_remote_edits() {
        let (_dir, mut a, mut b) = pair();
        let first = a.ingest("n1", "第一行\n第二行\n");
        deliver(first, &mut b);
        b.mark_written("n1");
        assert_eq!(b.text("n1"), "第一行\n第二行\n");
        // A 在第二行后面加字，B 还没写盘的时候，有人在 B 的磁盘上改了第一行
        let from_a = {
            let doc = a.docs.get("n1").unwrap().clone();
            let before = doc.oplog_vv();
            doc.get_text(BODY).insert(7, "（甲）").unwrap();
            doc.commit();
            vec![Update {
                target: Target::Doc("n1".into()),
                bytes: doc.export(ExportMode::updates(&before)).unwrap(),
            }]
        };
        deliver(from_a.clone(), &mut b);
        assert!(b.needs_write("n1"));
        let back = b.ingest("n1", "第一行改了\n第二行\n");
        assert_eq!(b.text("n1"), "第一行改了\n第二行（甲）\n");
        // 磁盘上的那一版对应的是分叉出来的那一份：还要写盘
        assert_eq!(b.written_text("n1").unwrap(), "第一行改了\n第二行\n");
        assert!(b.needs_write("n1"));
        deliver(back, &mut a);
        assert_eq!(a.text("n1"), b.text("n1"));
        // 分叉用的 peer 也记成了 B 这台设备
        let peers = strings(&b.vault.get_map(PEERS));
        assert!(peers.values().filter(|device| *device == "bb").count() >= 2);
    }

    #[test]
    fn summaries_bring_both_sides_level_and_survive_reopening() {
        let (dir, mut a, mut b) = pair();
        a.ingest("n1", "甲写的");
        a.set_meta(
            "n1",
            &DocMeta {
                kind: DocKind::Note,
                title: "一".into(),
                pinned: false,
                archived: None,
                category: None,
                created: 1,
                deleted: false,
            },
        );
        b.ingest("n2", "乙写的");
        let to_b = a.answer(&b.summary());
        let to_a = b.answer(&a.summary());
        deliver(to_b, &mut b);
        deliver(to_a, &mut a);
        assert_eq!(a.text("n2"), "乙写的");
        assert_eq!(b.text("n1"), "甲写的");
        assert_eq!(b.meta("n1").unwrap().title, "一");
        assert!(a.answer(&b.summary()).is_empty());
        a.mark_written("n2");
        a.save().unwrap();
        let reopened = Replica::open(&dir.path().join("a"), "aa").unwrap();
        assert_eq!(reopened.text("n2"), "乙写的");
        assert_eq!(reopened.written_text("n2").unwrap(), "乙写的");
        assert_ne!(reopened.peer, a.peer, "每次打开换一个 peer");
    }

    #[test]
    fn history_groups_by_device_and_restore_is_a_new_edit() {
        let (_dir, mut a, mut b) = pair();
        deliver(a.ingest("n1", "一"), &mut b);
        b.mark_written("n1");
        deliver(b.ingest("n1", "一二"), &mut a);
        // peers 表（谁是哪台设备）在仓库文档里，对账带过来
        deliver(b.answer(&a.summary()), &mut a);
        let history = a.history("n1");
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].device.as_deref(), Some("aa"));
        assert_eq!(history[1].device.as_deref(), Some("bb"));
        assert_eq!(a.text_at("n1", &history[0].frontiers).unwrap(), "一");
        let restored = a.restore("n1", &history[0].frontiers).unwrap().unwrap();
        assert_eq!(a.text("n1"), "一");
        deliver(vec![restored], &mut b);
        assert_eq!(b.text("n1"), "一");
    }
}
