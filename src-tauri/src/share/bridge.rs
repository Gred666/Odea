/* ============================================================
.md 和 CRDT 怎么对上（docs/协同编辑.md §20.5）：service.rs 的后台任务拿着仓库和副本的锁调这里。

出（本机 → CRDT）：仓库报来进了 / 离开了索引的那几篇（vault/shared.rs 的 touched）
- 还在：正文按「上次和磁盘对齐时」打进 CRDT（Replica::ingest），元数据整项比、不一样就写
- 不见了：笔记在回收站里就是删了；不在的先等两秒（外部改名是先删后建），还不在就算删了。
  某一天、目标的文件没了是清空了（正文变空）
- 清单变了：和上次对齐时比，哪几行变了写哪几行（tree_base）。理顺出来的变化（成环挪到根上、
  找不到的笔记去掉）不算：每台设备自己理顺，算出来的一样
进（CRDT → 本机）：
- 别人改了正文：停手 400ms 写那一篇（写之前先把磁盘上没读进来的改动并进去）
- 仓库文档变了：元数据和本机不一样的那几篇照着写；清单整个重写（先写篇、后写清单，免得理顺时
  把还没写下来的笔记当成找不到的去掉）；附件清单里本机没有的去要（service.rs）
- 日程开关、各类文档放在哪（settings）：加入时照着写进仓库标记
============================================================ */

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::replica::{DocKind, DocMeta, FileEntry, Replica, Update};
use crate::vault::shared::{index_id, share_id};
use crate::vault::{fsio, Vault};

/// 别人改了以后停手多久写盘
pub const WRITE_QUIET: Duration = Duration::from_millis(400);
/// 一直有人在改的话最多拖多久
const WRITE_MAX: Duration = Duration::from_secs(2);
/// 笔记不见了先等多久再算删了
const MISSING_GRACE: Duration = Duration::from_secs(2);
/// 附件的上限（和粘贴附件一样）
pub const MAX_FILE: u64 = 50 << 20;

pub struct Bridge {
    root: PathBuf,
    /// 上次对齐时本机的清单（节点 id → 那一行）
    tree_base: Option<BTreeMap<String, String>>,
    /// 上次照着写下来的 CRDT 里的清单
    tree_seen: Option<BTreeMap<String, String>>,
    /// 本机的附件：路径 → (修改时间, 大小, 哈希)
    files_local: HashMap<String, (i64, i64, String)>,
    /// 上次对齐时的附件清单
    files_base: Option<BTreeMap<String, FileEntry>>,
    missing: HashMap<String, Instant>,
    /// 要写盘的：文档 id → (最早什么时候写, 第一次排上的时间)
    to_write: BTreeMap<String, (Instant, Instant)>,
    /// 仓库文档变了：元数据、清单、附件要重新对一遍
    vault_dirty: Option<Instant>,
    /// 上次对齐时日程开没开（本机改了还是别人改了，按它分）
    journal_seen: Option<bool>,
}

/// 清单的文本 → 节点 id → 那一行（父节点、排序键、内容，空白规整成一个空格）
pub fn tree_lines(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // 节点 id、父节点、排序键各一个词，后面是「种类 内容」（内容里可能有空格，原样）
        let mut rest = line;
        let mut words = Vec::with_capacity(3);
        for _ in 0..3 {
            let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            words.push(&rest[..end]);
            rest = rest[end..].trim_start();
        }
        if words.iter().any(|word| word.is_empty()) || rest.is_empty() {
            continue;
        }
        out.insert(words[0].to_string(), format!("{} {} {}", words[1], words[2], rest.trim_end()));
    }
    out
}

/// 节点 id → 那一行 → 清单文本（vault/tree.rs 读得懂，读的时候会理顺）
pub fn render_tree(lines: &BTreeMap<String, String>) -> String {
    let mut out = String::from("# Odea 逻辑目录（共享仓库，从仓库文档写出来的）\n");
    for (id, line) in lines {
        out.push_str(id);
        out.push(' ');
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// 这一行是不是放笔记的（不是快捷方式）：是的话返回笔记 id
fn placed_note(line: &str) -> Option<&str> {
    let mut parts = line.split_whitespace();
    let (_, _, kind, id) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    (kind == "note").then_some(id)
}

/// 本机的元数据和 CRDT 里的合起来：这台设备表示不了的（没开日程就没有归档）照 CRDT 的
fn merged_meta(local: DocMeta, crdt: Option<&DocMeta>, journal: bool) -> DocMeta {
    let mut meta = local;
    if let Some(crdt) = crdt {
        if !journal && crdt.archived.is_some() {
            meta.archived = crdt.archived;
            meta.category = crdt.category.clone();
            meta.pinned = crdt.pinned;
        }
    }
    meta
}

impl Bridge {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            tree_base: None,
            tree_seen: None,
            files_local: HashMap::new(),
            files_base: None,
            missing: HashMap::new(),
            to_write: BTreeMap::new(),
            vault_dirty: None,
            journal_seen: None,
        }
    }

    /// 打开时（索引读全了以后）对一遍：应用关着的时候别的程序改过的进 CRDT，上次没来得及写盘的写下去。
    /// 以前写过盘、现在不见了的笔记算删了（某一天、目标算清空了）
    pub fn start(&mut self, vault: &mut Vault, replica: &mut Replica, now: Instant) -> Vec<Update> {
        let mut out = Vec::new();
        vault.take_touched();
        let journal = vault.layout().journal;
        let locals = vault.share_all().unwrap_or_else(|error| {
            eprintln!("共享仓库：读仓库失败：{error}");
            Vec::new()
        });
        let present: HashSet<String> = locals.iter().map(|local| local.id.clone()).collect();
        for local in locals {
            out.extend(replica.ingest(&local.id, &local.body));
            let meta = merged_meta(local.meta, replica.meta(&local.id).as_ref(), journal);
            out.extend(replica.set_meta(&local.id, &meta));
        }
        for (id, meta) in replica.all_meta() {
            if meta.deleted || present.contains(&id) || !replica.was_written(&id) {
                continue;
            }
            match meta.kind {
                DocKind::Note => out.extend(self.mark_deleted(replica, &id, meta)),
                _ if journal => out.extend(replica.ingest(&id, "")),
                _ => {}
            }
        }
        self.journal_seen = replica.journal();
        self.tree_base = vault.share_tree_text().map(|text| tree_lines(&text));
        self.tree_seen = None;
        self.vault_dirty = Some(now);
        out
    }

    /// 日程开关：本机改了（仓库标记变了）交出去；别人改了写进仓库标记，前端问一句「切换过去」
    pub fn sync_journal(&mut self, vault: &mut Vault, replica: &mut Replica) -> Option<Update> {
        let marker = vault.marker_journal();
        let Some(crdt) = replica.journal() else {
            self.journal_seen = Some(marker);
            return replica.set_journal(marker);
        };
        match self.journal_seen {
            Some(seen) if crdt != seen => {
                self.journal_seen = Some(crdt);
                if marker != crdt {
                    if let Err(error) = vault.share_set_journal_marker(crdt) {
                        eprintln!("共享仓库：改仓库标记失败：{error}");
                    }
                }
                None
            }
            Some(seen) if marker != seen => {
                self.journal_seen = Some(marker);
                replica.set_journal(marker)
            }
            Some(_) => None,
            None => {
                self.journal_seen = Some(crdt);
                if marker != crdt {
                    if let Err(error) = vault.share_set_journal_marker(crdt) {
                        eprintln!("共享仓库：改仓库标记失败：{error}");
                    }
                }
                None
            }
        }
    }

    /// 别人改了这一篇：停手一会儿写盘
    pub fn schedule_write(&mut self, id: &str, now: Instant) {
        let entry = self.to_write.entry(id.to_string()).or_insert((now, now));
        entry.0 = (now + WRITE_QUIET).min(entry.1 + WRITE_MAX);
    }

    /// 仓库文档变了（别人的元数据、清单、附件）
    pub fn schedule_vault(&mut self, now: Instant) {
        let first = self.vault_dirty.unwrap_or(now);
        self.vault_dirty = Some((now + WRITE_QUIET).min(first + WRITE_MAX));
    }

    /// 下一次要干活的时候（后台任务按它睡）
    pub fn next_due(&self) -> Option<Instant> {
        let writes = self.to_write.values().map(|(at, _)| *at).min();
        let missing = self.missing.values().map(|at| *at + MISSING_GRACE).min();
        [writes, missing, self.vault_dirty].into_iter().flatten().min()
    }

    /* ---------------- 本机 → CRDT ---------------- */

    /// 本机的变化进 CRDT。返回要发出去的包
    pub fn absorb(&mut self, vault: &mut Vault, replica: &mut Replica, now: Instant) -> Vec<Update> {
        let mut out = Vec::new();
        let journal = vault.layout().journal;
        let (touched, tree) = vault.take_touched();
        for index in touched {
            let Some(id) = share_id(&index) else { continue };
            match vault.share_local(&index) {
                Ok(Some(local)) => {
                    self.missing.remove(&id);
                    out.extend(replica.ingest(&id, &local.body));
                    let meta = merged_meta(local.meta, replica.meta(&id).as_ref(), journal);
                    out.extend(replica.set_meta(&id, &meta));
                    // 磁盘上的和别人的合起来以后比磁盘上的新：要写回去
                    if replica.needs_write(&id) {
                        self.schedule_write(&id, now);
                    }
                }
                Ok(None) => match replica.meta(&id) {
                    Some(meta) if meta.kind == DocKind::Note => {
                        if vault.share_trashed(&index) {
                            out.extend(self.mark_deleted(replica, &id, meta));
                        } else {
                            self.missing.entry(id).or_insert(now);
                        }
                    }
                    // 某一天、目标：文件没了是清空了
                    Some(meta) => {
                        out.extend(replica.ingest(&id, ""));
                        if !meta.title.is_empty() {
                            out.extend(replica.set_meta(
                                &id,
                                &DocMeta {
                                    title: String::new(),
                                    ..meta
                                },
                            ));
                        }
                    }
                    None => {}
                },
                Err(error) => eprintln!("共享仓库：读 {index} 失败：{error}"),
            }
        }
        // 不见了一阵子还没回来的：删了
        let gone: Vec<String> = self
            .missing
            .iter()
            .filter(|(_, at)| now.duration_since(**at) >= MISSING_GRACE)
            .map(|(id, _)| id.clone())
            .collect();
        for id in gone {
            self.missing.remove(&id);
            let back = vault.share_local(&index_id(&id)).ok().flatten().is_some();
            if let Some(meta) = replica.meta(&id).filter(|_| !back) {
                out.extend(self.mark_deleted(replica, &id, meta));
            }
        }
        if tree || self.tree_base.is_none() {
            out.extend(self.push_tree(vault, replica));
        }
        out
    }

    fn mark_deleted(&mut self, replica: &mut Replica, id: &str, meta: DocMeta) -> Option<Update> {
        if meta.deleted {
            return None;
        }
        replica.set_meta(id, &DocMeta { deleted: true, ..meta })
    }

    /// 本机改了清单的哪几行，写进 CRDT
    fn push_tree(&mut self, vault: &Vault, replica: &mut Replica) -> Option<Update> {
        let local = tree_lines(&vault.share_tree_text()?);
        let base = self.tree_base.get_or_insert_with(|| replica.tree());
        let mut edits = Vec::new();
        for id in local.keys().chain(base.keys()) {
            let (now, before) = (local.get(id), base.get(id));
            if now == before || edits.iter().any(|(seen, _): &(String, Option<String>)| seen == id) {
                continue;
            }
            // 放笔记的那一行没了、笔记却还在（别处还没写下来、理顺时当成找不到去掉的）：不算本机删的
            if now.is_none() {
                if let Some(note) = before.and_then(|line| placed_note(line)) {
                    if replica.meta(note).is_some_and(|meta| !meta.deleted) {
                        continue;
                    }
                }
            }
            edits.push((id.clone(), now.cloned()));
        }
        self.tree_base = Some(local);
        replica.edit_tree(&edits)
    }

    /* ---------------- CRDT → 本机 ---------------- */

    /// 到点了的写盘：别人改过的那几篇、仓库文档。返回写之前从磁盘读进来的改动（要发出去）
    pub fn materialize(&mut self, vault: &mut Vault, replica: &mut Replica, now: Instant) -> Vec<Update> {
        let mut out = Vec::new();
        let vault_due = self.vault_dirty.is_some_and(|at| at <= now);
        if vault_due {
            self.vault_dirty = None;
            let journal = vault.layout().journal;
            for (id, meta) in replica.all_meta() {
                let local = vault.share_local(&index_id(&id)).ok().flatten();
                let differs = match &local {
                    // 某一天、目标：没开日程的设备上不写
                    None => !meta.deleted && (meta.kind == DocKind::Note || journal),
                    Some(local) => {
                        meta.deleted
                            || merged_meta(local.meta.clone(), Some(&meta), journal) != meta
                            || replica.needs_write(&id)
                    }
                };
                if differs {
                    self.to_write.entry(id).or_insert((now, now));
                }
            }
        }
        let due: Vec<String> = self
            .to_write
            .iter()
            .filter(|(_, (at, _))| *at <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &due {
            self.to_write.remove(id);
        }
        for id in due {
            let Some(meta) = replica.meta(&id) else {
                // 正文先到、元数据还没到：等仓库文档
                continue;
            };
            // 写之前：磁盘上没读进来的改动先并进去
            if let Err(error) = vault.share_refresh(&id) {
                eprintln!("共享仓库：读 {id} 失败：{error}");
            }
            out.extend(self.absorb(vault, replica, now));
            let body = replica.text(&id);
            match vault.share_write(&id, &meta, &body) {
                Ok(()) => replica.mark_written(&id),
                Err(error) => eprintln!("共享仓库：写 {id} 失败：{error}"),
            }
            // 自己写的这一篇进了索引：再对一遍（正文、元数据都一样，什么也不发）
            out.extend(self.absorb(vault, replica, now));
        }
        if vault_due {
            out.extend(self.pull_tree(vault, replica));
        }
        out
    }

    /// CRDT 里的清单变了：先把本机没交出去的交出去，再整个写下来
    fn pull_tree(&mut self, vault: &mut Vault, replica: &mut Replica) -> Vec<Update> {
        let crdt = replica.tree();
        if self.tree_seen.as_ref() == Some(&crdt) || vault.share_tree_text().is_none() {
            return Vec::new();
        }
        let out: Vec<Update> = self.push_tree(vault, replica).into_iter().collect();
        let crdt = replica.tree();
        if let Err(error) = vault.share_set_tree(&render_tree(&crdt)) {
            eprintln!("共享仓库：写清单失败：{error}");
            return out;
        }
        self.tree_seen = Some(crdt);
        self.tree_base = vault.share_tree_text().map(|text| tree_lines(&text));
        out
    }

    /// 建共享时：把仓库里每一篇、清单、附件都读进 CRDT（都算这台设备写的）
    pub fn adopt(&mut self, vault: &mut Vault, replica: &mut Replica) -> crate::error::Result<()> {
        vault.share_ensure_ids()?;
        vault.take_touched();
        for local in vault.share_all()? {
            replica.ingest(&local.id, &local.body);
            replica.set_meta(&local.id, &local.meta);
        }
        replica.set_journal(vault.layout().journal);
        self.tree_base = Some(BTreeMap::new());
        self.push_tree(vault, replica);
        self.tree_seen = Some(replica.tree());
        self.files_base = Some(BTreeMap::new());
        self.scan_files(replica);
        Ok(())
    }

    /* ---------------- 附件 ---------------- */

    /// 本机的附件（不是 .md、不以点开头、不超过 50MB 的文件）和上次比，变了的写进清单
    pub fn scan_files(&mut self, replica: &mut Replica) -> Vec<Update> {
        let mut found = Vec::new();
        walk_files(&self.root, "", &mut found);
        let mut local: BTreeMap<String, FileEntry> = BTreeMap::new();
        let mut cache = HashMap::new();
        for (rel, mtime, size) in found {
            let hash = match self.files_local.get(&rel) {
                Some((m, s, hash)) if *m == mtime && *s == size => hash.clone(),
                _ => match std::fs::read(fsio::abs(&self.root, &rel)) {
                    Ok(bytes) => hash_of(&bytes),
                    Err(_) => continue,
                },
            };
            cache.insert(rel.clone(), (mtime, size, hash.clone()));
            local.insert(
                rel,
                FileEntry {
                    hash,
                    size: size as u64,
                    deleted: false,
                },
            );
        }
        self.files_local = cache;
        let base = self.files_base.get_or_insert_with(|| {
            replica
                .files()
                .into_iter()
                .filter(|(_, entry)| !entry.deleted)
                .collect()
        });
        let mut out = Vec::new();
        for (path, entry) in &local {
            if base.get(path) != Some(entry) {
                out.extend(replica.set_file(path, entry));
            }
        }
        for (path, entry) in base.iter() {
            if !local.contains_key(path) {
                out.extend(replica.set_file(
                    path,
                    &FileEntry {
                        deleted: true,
                        ..entry.clone()
                    },
                ));
            }
        }
        self.files_base = Some(local);
        out
    }

    /// 清单里有、本机没有（或者不是这一版）的附件：要去要的（路径、哈希）。
    /// 清单里删了的：本机的还是上次那一版就挪进回收站（本机改过的留着，下次扫描当新的交出去）
    pub fn wanted_files(&mut self, replica: &Replica) -> Vec<(String, String)> {
        let mut wanted = Vec::new();
        for (path, entry) in replica.files() {
            if !safe_rel(&path) {
                continue;
            }
            let local = self.files_local.get(&path).map(|(_, _, hash)| hash.as_str());
            if entry.deleted {
                if local.is_some() && local == Some(entry.hash.as_str()) {
                    let from = fsio::abs(&self.root, &path);
                    let to = fsio::abs(&self.root, ".odea/trash/files").join(path.replace('/', "／"));
                    let _ = std::fs::create_dir_all(to.parent().unwrap_or(&self.root));
                    if std::fs::rename(&from, &to).is_ok() {
                        self.files_local.remove(&path);
                        if let Some(base) = &mut self.files_base {
                            base.remove(&path);
                        }
                    }
                }
                continue;
            }
            if local != Some(entry.hash.as_str()) && entry.size <= MAX_FILE {
                wanted.push((path, entry.hash));
            }
        }
        wanted
    }

    /// 要来的附件：哈希对得上才写
    pub fn store_file(&mut self, path: &str, hash: &str, bytes: &[u8]) -> bool {
        if !safe_rel(path) || hash_of(bytes) != hash {
            return false;
        }
        let target = fsio::abs(&self.root, path);
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if fsio::write_atomic_bytes(&target, bytes).is_err() {
            return false;
        }
        if let Some((mtime, size)) = fsio::stat(&target) {
            self.files_local.insert(path.to_string(), (mtime, size, hash.to_string()));
            if let Some(base) = &mut self.files_base {
                base.insert(
                    path.to_string(),
                    FileEntry {
                        hash: hash.to_string(),
                        size: bytes.len() as u64,
                        deleted: false,
                    },
                );
            }
        }
        true
    }

    /// 别人来要这个哈希的文件：本机有就给路径
    pub fn file_with_hash(&self, hash: &str) -> Option<PathBuf> {
        self.files_local
            .iter()
            .find(|(_, (_, _, known))| known == hash)
            .map(|(rel, _)| fsio::abs(&self.root, rel))
    }
}

pub fn hash_of(bytes: &[u8]) -> String {
    data_encoding::HEXLOWER.encode(ring::digest::digest(&ring::digest::SHA256, bytes).as_ref())
}

/// 别人给的路径：相对、不往上走、不进以点开头的目录、不是 .md
pub fn safe_rel(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && !path.contains(':')
        && !path.starts_with('/')
        && path.split('/').all(|part| !part.is_empty() && part != ".." && !fsio::is_hidden_name(part))
        && !fsio::is_markdown(path)
}

fn walk_files(root: &Path, dir: &str, out: &mut Vec<(String, i64, i64)>) {
    let Ok(entries) = std::fs::read_dir(fsio::abs(root, dir)) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if fsio::is_hidden_name(&name) {
            continue;
        }
        let rel = crate::vault::layout::join(dir, &name);
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            walk_files(root, &rel, out);
        } else if kind.is_file() && !fsio::is_markdown(&name) {
            if let Ok(meta) = entry.metadata() {
                if meta.len() <= MAX_FILE {
                    out.push((rel, fsio::mtime_ms(&meta), meta.len() as i64));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_lines_round_trip_through_the_tree_format() {
        let text = "# 头\nd7k2a1  .       i     folder 交易 学习\nn9x1b2  d7k2a1  i     note 0199f3c2\n";
        let lines = tree_lines(text);
        assert_eq!(lines["d7k2a1"], ". i folder 交易 学习");
        assert_eq!(placed_note(&lines["n9x1b2"]), Some("0199f3c2"));
        let back = crate::vault::tree::Tree::parse(&render_tree(&lines));
        assert_eq!(tree_lines(&back.render()), lines);
    }

    #[test]
    fn only_safe_relative_paths_are_written() {
        assert!(safe_rel("附件/图 1.png"));
        assert!(!safe_rel("../外面.png"));
        assert!(!safe_rel(".odea/share/vault.loro"));
        assert!(!safe_rel("笔记.md"));
        assert!(!safe_rel("C:/x.png"));
        assert!(!safe_rel("/etc/passwd"));
    }
}
