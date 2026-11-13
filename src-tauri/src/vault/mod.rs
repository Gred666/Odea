/* ============================================================
仓库：文件是唯一的真相，索引只是缓存。

每篇文档就是仓库文件夹里的一个 .md 文件（位置约定见 layout.rs）；SQLite 索引
（index.rs）从文件派生，存在应用数据目录里，删了下次启动会从文件重建。

写入的顺序永远是：先写文件（原子替换），再更新索引。读写都在一把锁里
（AppState 里的 Mutex），命令和文件监听不会交错。

外部程序改了文件：
- 文件监听（watch.rs）触发一次增量扫描，按修改时间和大小找出变了的文件重新索引，
  再通过 VaultChange 事件通知前端刷新；
- 应用自己写的文件扫描时指纹对得上，不会被当成外部改动；
- 保存时发现磁盘上的版本比索引新（监听还没来得及处理），先把磁盘上那一版另存成
  「标题 (冲突 时间).md」，再写我们的 —— 两边的内容都留着。
============================================================ */

pub mod activity;
pub mod folders;
pub mod frontmatter;
pub mod fsio;
pub mod guide;
pub mod index;
pub mod layout;
pub mod legacy;
pub mod links;
mod export;
mod import;
mod logical;
pub mod properties;
pub mod query;
pub mod seed;
pub mod team;
pub mod tree;
pub mod watch;

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rusqlite::Connection;

use crate::db::now_ms;
use crate::domain::model::{
    Attachment, Backlink, BacklinkLine, DocRef, FindFile, FindMatch, FindOptions, FindResult,
    FolderDeletion, LegacyText, LinkRewrite, Note, NoteSummary, Relink, TextHit, TextSearch, TrashedNote, TreeFile,
    TypedDoc, VaultChange, VaultInfo, VaultLayout, WantedExtension, NOTE,
};
use crate::domain::search;
use crate::error::{AppError, Result};
use crate::plugins::{self, DocType, IndexPart};
use frontmatter::FrontMatter;
use index::DocRow;
use layout::Slot;

/// 回收站里的文件放多久（天）
const TRASH_KEEP_DAYS: i64 = 30;

/// 启动时最多当场读这么多个文件（约 0.2 秒）。再多就交给后台分批读，窗口不等它（见 open_quick）
const QUICK_SCAN_LIMIT: usize = 200;

/// 启动时没读完、交给后台分批读的文件（Vault::open_quick 给出，index_backlog 一点点读掉）
pub struct Backlog {
    /// 属于哪个仓库：中途换了仓库，剩下的就不读了
    root: PathBuf,
    files: VecDeque<String>,
    total: usize,
}

impl Backlog {
    pub fn total(&self) -> usize {
        self.total
    }

    pub fn done(&self) -> usize {
        self.total - self.files.len()
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }
}

/// 把「别处引起的变化」通知给前端（桌面端是一个 Tauri 事件）
pub type Announce = Arc<dyn Fn(VaultChange) + Send + Sync>;

pub struct Vault {
    root: PathBuf,
    db: Connection,
    log: activity::Log,
    announce: Option<Announce>,
    /// 这个仓库怎么摆：开着哪些插件（它们的文档类型）、文件树的根、归档在哪（.odea/vault.json）
    layout: layout::Layout,
    /// 磁盘上的仓库标记在别处改了、已经告诉过前端的那一种摆法（check_layout）：同一次变化只报一回
    layout_pending: Option<String>,
    /// 上次扫描时文件树上的文件夹：外部建了 / 删了文件夹，比一下就知道
    folders: Vec<String>,
    /// 上次扫描时树上列的图片、PDF（本地目录才有）：多了、少了、改了也要告诉前端
    files: Vec<TreeFile>,
    /// 上次扫描时整个仓库里的附件（图片和 ATTACHMENT_EXTENSIONS 那几种，相对仓库的路径，排好序）：
    /// Obsidian 的 `![[图.png]]`、`![[说明书.pdf]]` 只写文件名，前端按名字在这里面找（lib/wikiFiles.ts）。
    /// 和树上的 files 不同，逻辑目录、日程的文件夹里的也算
    attachments: Vec<String>,
    /// 逻辑目录的树（.odea/tree，见 tree.rs、logical.rs）；本地目录是 None
    tree: Option<tree::Tree>,
    /// 清单文件上次读到 / 写下的内容：和磁盘上的一比，就知道别处改没改过它
    tree_text: String,
    /// 打开时清单文件不在（新建的逻辑目录）：索引读全了以后按文件夹结构建一份
    tree_build: bool,
    /// 索引和磁盘对齐过一遍了（后台那批读完了）。没读完的时候，索引里找不到的笔记不一定是没了
    indexed_all: bool,
}

impl VaultChange {
    pub fn is_empty(&self) -> bool {
        self.notes.is_empty()
            && self.docs.is_empty()
            && self.plugins.is_empty()
            && self.conflicts.is_empty()
            && self.found_copies.is_empty()
            && !self.folders
            && !self.attachments
            && !self.layout
    }

    /// 这个插件在索引里另存的那一份变了（日程：带日期的任务）
    pub fn touch_plugin(&mut self, id: &str) {
        if !self.plugins.iter().any(|known| known == id) {
            self.plugins.push(id.to_string());
        }
    }

    fn record(&mut self, row: &DocRow) {
        if row.kind == NOTE {
            if !self.notes.contains(&row.id) {
                self.notes.push(row.id.clone());
            }
        } else {
            let doc = doc_ref(row);
            if !self.docs.contains(&doc) {
                self.docs.push(doc);
            }
        }
    }

    /// 把另一批变化并进来（去重）
    fn absorb(&mut self, other: VaultChange) {
        fn extend<T: PartialEq>(into: &mut Vec<T>, from: Vec<T>) {
            for item in from {
                if !into.contains(&item) {
                    into.push(item);
                }
            }
        }
        extend(&mut self.notes, other.notes);
        extend(&mut self.docs, other.docs);
        extend(&mut self.plugins, other.plugins);
        extend(&mut self.conflicts, other.conflicts);
        extend(&mut self.found_copies, other.found_copies);
        self.folders |= other.folders;
        self.layout |= other.layout;
    }

    /// 去掉前端自己发起的那篇：它刚拿到了结果，不用再刷一遍
    fn without(mut self, row: &DocRow) -> Self {
        if row.kind == NOTE {
            self.notes.retain(|id| *id != row.id);
        } else {
            let doc = doc_ref(row);
            self.docs.retain(|item| *item != doc);
        }
        self
    }
}

/// 这一行是哪一篇：笔记按 id，插件的文档按类型和 key
fn doc_ref(row: &DocRow) -> DocRef {
    match &row.key {
        Some(key) if row.kind != NOTE => DocRef::new(&row.kind, key),
        _ => DocRef::note(&row.id),
    }
}

/// 笔记的标题和文件名对不上时，才把标题写进属性块
fn title_meta(rel: &str, title: &str) -> Option<String> {
    (layout::stem_of(rel) != title).then(|| title.to_string())
}

impl Vault {
    /// 打开仓库并把索引和文件对齐（增量：只重读变过的文件）。应用里用 open_quick
    #[cfg(test)]
    pub fn open(root: &Path, index_path: &Path) -> Result<Self> {
        let db = index::open(index_path)?;
        Self::with_index(root, db)
    }

    /// 启动时打开仓库。要读的文件不多（平时启动，外面改了几篇）照旧当场读完；很多的话
    /// （第一次打开一个大文件夹、索引的结构升级了要整个重建）只做不读文件的那一半，
    /// 要读的交回去，调用方在后台分批读（index_backlog）—— 两千篇要读两秒，窗口不用等它。
    /// 读完之前列表、搜索、日历里暂时缺一部分；某一天 / 某个周期的文档取的时候会当场补读
    pub fn open_quick(root: &Path, index_path: &Path) -> Result<(Self, Backlog)> {
        let mut vault = Self::bare(root, index::open(index_path)?)?;
        let (_, stale) = vault.plan_rescan()?;
        let mut backlog = Backlog {
            root: root.to_path_buf(),
            total: stale.len(),
            files: stale.into_iter().map(|file| file.rel).collect(),
        };
        if backlog.total <= QUICK_SCAN_LIMIT {
            vault.index_backlog(&mut backlog, None);
        }
        vault.purge_trash(TRASH_KEEP_DAYS * 86_400_000);
        Ok((vault, backlog))
    }

    #[cfg(test)]
    pub fn open_in_memory(root: &Path) -> Self {
        Self::with_index(root, index::open_in_memory()).unwrap()
    }

    #[cfg(test)]
    fn with_index(root: &Path, db: Connection) -> Result<Self> {
        let mut vault = Self::bare(root, db)?;
        vault.rescan()?;
        vault.on_indexed();
        vault.purge_trash(TRASH_KEEP_DAYS * 86_400_000);
        Ok(vault)
    }

    /// 还没和磁盘对齐过的仓库。摆法和建索引时不一样了（别的设备开关了日程、同步过来）就清空索引重新认
    fn bare(root: &Path, db: Connection) -> Result<Self> {
        std::fs::create_dir_all(root)?;
        retire_share(root);
        let layout = layout::Layout::load(root);
        index::sync_layout(&db, &layout.fingerprint(), &layout::Layout::odea().fingerprint())?;
        let mut vault = Self {
            root: root.to_path_buf(),
            db,
            log: activity::Log::new(fsio::abs(root, layout::ACTIVITY_DIR)),
            announce: None,
            layout,
            layout_pending: None,
            folders: Vec::new(),
            files: Vec::new(),
            attachments: Vec::new(),
            tree: None,
            tree_text: String::new(),
            tree_build: false,
            indexed_all: false,
        };
        vault.load_tree();
        Ok(vault)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 开 / 关一个插件（docs/插件与跨端.md §6.2，日程见 docs/仓库与启动器.md §6）：改仓库标记，按新的摆法
    /// 把每个文件重新认一遍 —— 日记、目标从笔记变成某一天 / 目标，或者反过来。文件一个都不动。
    /// 要读的不多就当场读完；多的交回去，调用方在后台读（和 open_quick 一样）
    pub fn set_plugin(&mut self, id: &str, on: bool) -> Result<Backlog> {
        let plugin = plugins::find(id).ok_or_else(|| AppError::Invalid(format!("没有这个插件: {id}")))?;
        let path = fsio::abs(&self.root, layout::VAULT_MARKER);
        let marker = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok());
        let marker = layout::marker_with_switch(marker, id, on);
        fsio::write_atomic(&path, &serde_json::to_string_pretty(&marker)?)?;
        let backlog = self.relayout()?;
        // 行为日志跟着仓库同步：照老版本的名字记（开关日程记的是 journal）
        let name = plugin.legacy_feature().unwrap_or(id);
        self.log.record("vault", name, if on { "enabled" } else { "disabled" });
        Ok(backlog)
    }

    /// 开 / 关一个第三方插件（L0 声明，docs/插件与跨端.md §6.3）：只改仓库标记里它那一项。L0 不认文档类型，
    /// 文件怎么认不变，不用重新认、不用重载。插件的清单装在每台设备上，这台装没装由前端看
    pub fn set_extension(&mut self, id: &str, on: bool, version: Option<&str>) -> Result<()> {
        if !layout::extension_id_ok(id) || plugins::find(id).is_some() || id == layout::ARCHIVE_SWITCH {
            return Err(AppError::Invalid(format!("插件 id 不对: {id}")));
        }
        if version.is_some_and(|range| !layout::version_range_ok(range)) {
            return Err(AppError::Invalid(format!("版本范围不对: {}", version.unwrap_or_default())));
        }
        let path = fsio::abs(&self.root, layout::VAULT_MARKER);
        let marker = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok());
        let marker = layout::marker_with_extension(marker, id, on, version);
        fsio::write_atomic(&path, &serde_json::to_string_pretty(&marker)?)?;
        // 自己改的：换上新的这一份，文件监听再看到标记变了就不当成是别处改的（check_layout）
        self.layout.extensions = layout::Layout::load(&self.root).extensions;
        self.log.record("vault", id, if on { "enabled" } else { "disabled" });
        Ok(())
    }

    /// 开 / 关归档：和开关日程一样改标记、重新认一遍文件（「归档」文件夹里的是归档的笔记，还是普通笔记）。
    /// 文件一个都不动
    pub fn set_archive(&mut self, on: bool) -> Result<Backlog> {
        let path = fsio::abs(&self.root, layout::VAULT_MARKER);
        let marker = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok());
        let marker = layout::marker_with_switch(marker, layout::ARCHIVE_SWITCH, on);
        fsio::write_atomic(&path, &serde_json::to_string_pretty(&marker)?)?;
        let backlog = self.relayout()?;
        self.log.record("vault", "archive", if on { "enabled" } else { "disabled" });
        Ok(backlog)
    }

    /// 按磁盘上的仓库标记重新摆：开关日程之后；别的设备开关了日程、转成了逻辑目录，同步过来以后
    /// 用户点了「切换过去」（check_layout）。每个文件按新的摆法重新认一遍，文件一个都不动。
    /// 要读的不多就当场读完；多的交回去，调用方在后台读（和 open_quick 一样）
    pub fn relayout(&mut self) -> Result<Backlog> {
        let was_logical = self.layout.logical;
        self.layout = layout::Layout::load(&self.root);
        self.layout_pending = None;
        index::sync_layout(&self.db, &self.layout.fingerprint(), "")?;
        if self.layout.logical != was_logical {
            self.load_tree();
        }
        self.indexed_all = false;
        let (_, stale) = self.plan_rescan()?;
        let mut backlog = Backlog {
            root: self.root.clone(),
            total: stale.len(),
            files: stale.into_iter().map(|file| file.rel).collect(),
        };
        if backlog.total <= QUICK_SCAN_LIMIT {
            self.index_backlog(&mut backlog, None);
        }
        Ok(backlog)
    }

    /// 仓库标记（或 Obsidian 的设置）在别处改了（同步合并、网盘、别的工具）。只是附件放哪变了的
    /// 直接换上（已经认好的文件不受影响）；日程、文件夹、逻辑目录变了要重新认文件、前端整页重载 ——
    /// 用户可能正在打字，先告诉前端（VaultChange.layout），等用户点了再换（relayout）。同一次变化只报一回
    fn check_layout(&mut self) -> bool {
        let fresh = layout::Layout::load(&self.root);
        // 别的设备开关了第三方插件（L0）也算：前端要照新的那几个插件画
        let shape = |of: &layout::Layout| {
            let extensions: Vec<String> = of
                .extensions
                .iter()
                .map(|wanted| format!("{}@{}", wanted.id, wanted.version.as_deref().unwrap_or("")))
                .collect();
            format!("{}|{}|{}", of.fingerprint(), of.logical, extensions.join(","))
        };
        if shape(&fresh) == shape(&self.layout) {
            self.layout.attachments = fresh.attachments;
            self.layout_pending = None;
            return false;
        }
        let key = shape(&fresh);
        if self.layout_pending.as_deref() == Some(key.as_str()) {
            return false;
        }
        self.layout_pending = Some(key);
        true
    }

    pub fn set_announcer(&mut self, announce: Announce) {
        self.announce = Some(announce);
    }

    /// 告诉前端仓库里别处变了（空的不发）
    pub fn announce(&self, change: VaultChange) {
        if change.is_empty() {
            return;
        }
        if let Some(announce) = &self.announce {
            announce(change);
        }
    }

    /* ---------------- 扫描与索引 ---------------- */

    /// 把索引和磁盘对齐，返回变了的文档。启动时和文件监听触发时调用。
    pub fn rescan(&mut self) -> Result<VaultChange> {
        let (mut change, stale) = self.plan_rescan()?;
        for file in &stale {
            let Some(decoded) = self.read_lossy(&file.rel)? else {
                continue;
            };
            self.index_text(&file.rel, &decoded.text, decoded.utf8, file.mtime, file.size, &mut change)?;
        }
        Ok(change)
    }

    /// 扫描里不读文件的那一半：只 stat。消失了的从索引里去掉、文件夹列表更新，
    /// 返回修改时间或大小变了、要（重新）读进索引的文件，按该读的顺序
    fn plan_rescan(&mut self) -> Result<(VaultChange, Vec<fsio::FileEntry>)> {
        let mut change = VaultChange {
            layout: self.check_layout(),
            ..VaultChange::default()
        };
        let (mut files, attachments) = fsio::walk(&self.root, is_attachment_name);
        if attachments != self.attachments {
            self.attachments = attachments;
            change.attachments = true;
        }
        // 名字像冲突副本的放到最后：网盘拷出来的副本带着原文属性块里的 id，谁先被索引
        // 谁拿到这个 id。「周报 (1).md」按字节序排在「周报.md」前面，不挪的话原文反倒
        // 成了「另一份」、换了 id。（排序是稳定的，其余文件的顺序不变）
        files.sort_by_key(|file| !layout::conflict_originals(layout::stem_of(&file.rel)).is_empty());
        let present: HashSet<&str> = files.iter().map(|file| file.rel.as_str()).collect();
        let known = index::file_states(&self.db)?;
        let known_state: HashMap<&str, (i64, i64)> = known
            .iter()
            .map(|(rel, mtime, size)| (rel.as_str(), (*mtime, *size)))
            .collect();

        // 先删消失的：外部改名时新文件带着同一个 id，旧的那一行得先让位
        for (rel, _, _) in &known {
            if !present.contains(rel.as_str()) {
                if let Some(row) = index::by_path(&self.db, rel)? {
                    self.forget(&row, &mut change)?;
                }
            }
        }
        let stale = files
            .into_iter()
            .filter(|file| known_state.get(file.rel.as_str()) != Some(&(file.mtime, file.size)))
            .collect();
        if self.tree.is_some() {
            // 逻辑目录的文件夹在清单里：硬盘上建了、删了文件夹和树无关，清单被别处改了才算
            change.folders |= self.reload_tree();
        } else {
            let (folders, files) = folders::scan(&self.root, &self.layout, true);
            if folders != self.folders || files != self.files {
                self.folders = folders;
                self.files = files;
                change.folders = true;
            }
        }
        Ok((change, stale))
    }

    /// 文件树上列的图片、PDF（本地目录；逻辑目录的树上只有笔记，是空的）
    pub fn tree_files(&mut self) -> Vec<TreeFile> {
        if self.tree.is_some() {
            return Vec::new();
        }
        let (folders, files) = folders::scan(&self.root, &self.layout, true);
        self.folders = folders;
        self.files = files.clone();
        files
    }

    /// 整个仓库里的附件（相对仓库的路径），上次扫描时的。`![[图.png]]`、`![[说明书.pdf]]` 按名字在这里面找
    pub fn attachments(&self) -> Vec<String> {
        self.attachments.clone()
    }

    /// 附件清单里的一个文件在磁盘上的位置（`![[说明书.pdf]]` 的卡片上点「打开」）。只认清单里有的：
    /// 扫描时收的，不在隐藏目录里、扩展名在 IMAGE_EXTENSIONS / ATTACHMENT_EXTENSIONS 里 ——
    /// 前端不能叫 Rust 打开仓库外面的、或者能执行的文件（.exe、.bat、.lnk 这些不在清单里）
    pub fn attachment_path(&self, rel: &str) -> Result<PathBuf> {
        let path = fsio::abs(&self.root, rel);
        if !self.attachments.iter().any(|known| known == rel) || !path.is_file() {
            return Err(AppError::NotFound(format!("仓库里找不到这个文件: {rel}")));
        }
        Ok(path)
    }

    /// 树上列出来的一个文件在磁盘上的位置（前端给的路径要是树上真有的那种文件，以点开头的不认）
    pub fn tree_file_path(&self, rel: &str) -> Result<PathBuf> {
        let ok = !rel.is_empty()
            && rel.split('/').all(|part| !part.is_empty() && part != ".." && !fsio::is_hidden_name(part))
            && !rel.contains('\\')
            && folders::tree_file_kind(rel).is_some();
        let path = fsio::abs(&self.root, rel);
        if !ok || !path.is_file() {
            return Err(AppError::NotFound(format!("文件不在了: {rel}")));
        }
        Ok(path)
    }

    /// 接着读后台那批文件，读到 budget 用完为止（None = 全部读完）。一个文件读不了就跳过
    /// （以前整个仓库打不开），下次扫描还会再试。换了仓库的话剩下的直接丢掉
    pub fn index_backlog(&mut self, backlog: &mut Backlog, budget: Option<Duration>) -> VaultChange {
        let start = Instant::now();
        let mut change = VaultChange::default();
        if backlog.root != self.root {
            backlog.files.clear();
            return change;
        }
        while let Some(rel) = backlog.files.pop_front() {
            if let Err(error) = self.index_file(&rel, &mut change) {
                eprintln!("读 {rel} 进索引失败: {error}");
            }
            if budget.is_some_and(|budget| start.elapsed() >= budget) {
                break;
            }
        }
        if backlog.is_empty() && !self.indexed_all {
            change.folders |= self.on_indexed();
        }
        change
    }

    /// 按磁盘上的现状把一个文件读进索引：没了的去掉，修改时间和大小都和索引里一样的不读
    /// （后台那批是开头一起列的，轮到它时可能已经被保存、文件监听读过了，或者又改过、删了）
    fn index_file(&mut self, rel: &str, change: &mut VaultChange) -> Result<()> {
        let indexed = index::by_path(&self.db, rel)?;
        let Some((mtime, size)) = fsio::stat(&fsio::abs(&self.root, rel)) else {
            if let Some(row) = indexed {
                self.forget(&row, change)?;
            }
            return Ok(());
        };
        if indexed.is_some_and(|row| row.mtime == mtime && row.size == size) {
            return Ok(());
        }
        if let Some(decoded) = self.read_lossy(rel)? {
            self.index_text(rel, &decoded.text, decoded.utf8, mtime, size, change)?;
        }
        Ok(())
    }

    /// 插件的一篇（某一天、某个周期的目标）的文件在磁盘上，索引里还没有（后台还没读到它，见 open_quick）：
    /// 当场读进来。不然前端拿到的是一篇空文档，一编辑就把磁盘上那一篇盖掉了
    fn index_if_unseen(&mut self, rel: &str) -> Result<()> {
        if index::by_path(&self.db, rel)?.is_none() && fsio::abs(&self.root, rel).is_file() {
            self.index_file(rel, &mut VaultChange::default())?;
        }
        Ok(())
    }

    /// 文件监听用：扫描一遍，有变化就通知前端
    pub fn rescan_and_announce(&mut self) -> Result<()> {
        let change = self.rescan()?;
        self.announce(change);
        Ok(())
    }

    /// 文件监听用：只重读这几个文件（都是 .md）。没了的先处理，外部改名时新文件
    /// 带着同一个 id，旧的那一行得先让位。
    pub fn rescan_paths_and_announce(&mut self, rels: &[String]) -> Result<()> {
        let mut change = VaultChange::default();
        // 逻辑目录的清单、仓库标记（文件监听单独放行了 .odea/tree、.odea/vault.json，见 watch.rs）
        change.folders |= self.reload_tree();
        change.layout |= self.check_layout();
        for rel in rels {
            if !fsio::abs(&self.root, rel).is_file() {
                if let Some(row) = index::by_path(&self.db, rel)? {
                    self.forget(&row, &mut change)?;
                }
            }
        }
        for rel in rels {
            let Some((mtime, size)) = fsio::stat(&fsio::abs(&self.root, rel)) else {
                continue;
            };
            if index::by_path(&self.db, rel)?.is_some_and(|row| row.mtime == mtime && row.size == size) {
                continue;
            }
            let Some(decoded) = self.read_lossy(rel)? else {
                continue;
            };
            self.index_text(rel, &decoded.text, decoded.utf8, mtime, size, &mut change)?;
        }
        self.announce(change);
        Ok(())
    }

    fn forget(&mut self, row: &DocRow, change: &mut VaultChange) -> Result<()> {
        for plugin in index::remove(&self.db, &row.id, &self.parts())? {
            change.touch_plugin(plugin);
        }
        change.record(row);
        Ok(())
    }

    /// 开着的插件在索引里另存的那几份（日程：带日期的任务）
    fn parts(&self) -> Vec<&'static dyn IndexPart> {
        self.layout.plugins.iter().filter_map(|id| plugins::find(id)?.index_part()).collect()
    }

    /// 读仓库里的一个文件（不在了是 None），拿来改了再写回去的都用这个。
    /// 不是 UTF-8 的报错、不给字：解出来的已经不是原文，写回去原文就没了 ——
    /// 置顶、改名、保存、删除进回收站都是「读出来、改、写回」（docs/1110审查与研究.md §5.1）。
    /// 只看不写的（建索引、导出时判断要不要原样拷）用 read_lossy
    pub fn read(&self, rel: &str) -> Result<Option<String>> {
        match self.read_lossy(rel)? {
            Some(file) if file.utf8 => Ok(Some(file.text)),
            Some(_) => Err(not_utf8(rel)),
            None => Ok(None),
        }
    }

    /// 同 read，不是 UTF-8 的也给：认不出的字换成 U+FFFD，`utf8` 是 false。只能拿来看
    pub fn read_lossy(&self, rel: &str) -> Result<Option<fsio::Decoded>> {
        match std::fs::read(fsio::abs(&self.root, rel)) {
            Ok(bytes) => Ok(Some(fsio::decode(bytes))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// 按一个文件的内容更新索引。内容指纹没变时只更新文件状态。
    /// utf8 = false：文件不是 UTF-8，text 是换过字的（fsio::decode），这一篇只能看
    fn index_text(
        &mut self,
        rel: &str,
        text: &str,
        utf8: bool,
        mtime: i64,
        size: i64,
        change: &mut VaultChange,
    ) -> Result<DocRow> {
        let hash = fsio::fingerprint(text);
        let previous = index::by_path(&self.db, rel)?;
        if let Some(previous) = &previous {
            // 换过字的两份可能解出同样的字（不同的 GBK 字都成了 U+FFFD）：编码变了也得重新认
            if previous.hash == hash && previous.not_utf8 != utf8 {
                if previous.mtime != mtime || previous.size != size {
                    index::touch(&self.db, &previous.id, mtime, size)?;
                }
                return Ok(DocRow {
                    mtime,
                    size,
                    updated_at: mtime,
                    ..previous.clone()
                });
            }
        }

        let (meta, body) = frontmatter::split(text);
        let mut slot = self.layout.classify(rel);
        // 插件的同一篇（同一天、同一个周期）只能有一个文件；多出来的（比如手动拷了一份）当普通笔记
        if let Slot::Typed { kind, key } = &slot {
            if index::typed(&self.db, kind, key)?.is_some_and(|other| other.rel_path != rel) {
                slot = Slot::Note { archived: false };
            }
        }

        let stem = layout::stem_of(rel);
        let mut row = DocRow {
            id: String::new(),
            kind: NOTE.to_string(),
            rel_path: rel.to_string(),
            key: None,
            title: String::new(),
            excerpt: search::make_excerpt(&body, 60),
            word_count: search::count_words(&body),
            content_md: String::new(),
            pinned: false,
            archived: false,
            category: meta.category.clone(),
            archived_at: None,
            created_at: meta
                .created
                .or_else(|| previous.as_ref().map(|row| row.created_at))
                .unwrap_or(mtime),
            updated_at: mtime,
            mtime,
            size,
            hash,
            file_id: meta.id.clone(),
            not_utf8: !utf8,
            tags: meta.tags(),
            props: meta.extra.join("\n"),
        };
        match slot {
            Slot::Note { archived } => {
                row.id = self.note_id_for(rel, meta.id.as_deref(), previous.as_ref())?;
                row.title = meta.title.clone().unwrap_or_else(|| stem.to_string());
                row.pinned = meta.pinned && !archived;
                row.archived = archived;
                row.archived_at = archived.then(|| meta.archived.unwrap_or(mtime));
            }
            Slot::Typed { kind, key } => {
                let ty = self
                    .layout
                    .doc_type(kind)
                    .cloned()
                    .ok_or_else(|| AppError::Internal(format!("认出来的类型不在了: {kind}")))?;
                row.id = ty.index_id(&key);
                row.kind = kind.to_string();
                row.title = ty.title(&key, meta.title.as_deref());
                row.key = Some(key);
            }
        }

        row.content_md = body;
        for plugin in index::put(&self.db, &row, &self.parts())? {
            change.touch_plugin(plugin);
        }

        if let Some(previous) = &previous {
            if previous.id != row.id {
                change.record(previous);
            }
        }
        change.record(&row);
        // 新出现的冲突副本（网盘同步时两边都改过）：让前端提示一声
        if previous.is_none() && row.kind == NOTE && self.conflict_of(&row)?.is_some() {
            change.found_copies.push(row.title.clone());
        }
        Ok(row)
    }

    /// 这篇笔记是不是另一篇的冲突副本，是的话返回原文的 id。两条线索：
    /// 1. 属性块里的 id 被另一个文件占着 —— 网盘把整个文件拷了一份，id 也跟着拷了；
    /// 2. 文件名是冲突副本的样子（见 layout::conflict_originals），而且同一个文件夹里
    ///    真有那篇原文。原文也可以是插件的一篇（某一天、某个周期的目标）：「日记/2026/2026-10-07 (冲突 …).md」
    ///    的名字不是日期，扫描时当笔记，原文 id 是那一篇在索引里的 id（`day:2026-10-07`、`goal:week:2026-09-21`）
    ///    —— 两台设备都改了今日TODO，是同步里最常见的冲突。
    fn conflict_of(&self, row: &DocRow) -> Result<Option<String>> {
        if row.kind != NOTE {
            return Ok(None);
        }
        if let Some(file_id) = row.file_id.as_deref().filter(|id| *id != row.id) {
            if let Some(original) = index::by_id(&self.db, file_id)? {
                if original.kind == NOTE && original.rel_path != row.rel_path {
                    return Ok(Some(original.id));
                }
            }
        }
        let dir = layout::dir_of(&row.rel_path);
        for stem in layout::conflict_originals(layout::stem_of(&row.rel_path)) {
            let rel = layout::join(dir, &format!("{stem}.md"));
            if let Some(original) = index::by_path(&self.db, &rel)? {
                if original.id != row.id {
                    return Ok(Some(original.id));
                }
            }
        }
        Ok(None)
    }

    fn note_of(&self, row: &DocRow) -> Result<Note> {
        Ok(note_from_row(row, self.conflict_of(row)?))
    }

    /// 笔记的 id：属性块里的（没被别的文件占用的话）；否则沿用这个路径原来的；再否则新分配一个。
    /// 新分配的只在索引里，下次应用写这个文件时才写进属性块。
    /// 插件的文档在索引里用的 id（`day:…`、`goal:…`）不分给笔记，插件关着也一样
    fn note_id_for(&self, rel: &str, meta_id: Option<&str>, previous: Option<&DocRow>) -> Result<String> {
        let usable = |id: &str| !plugins::reserved_id(id);
        if let Some(id) = meta_id.filter(|id| usable(id)) {
            if !index::id_taken(&self.db, id, rel)? {
                return Ok(id.to_string());
            }
        }
        if let Some(previous) = previous.filter(|row| row.kind == NOTE) {
            if !index::id_taken(&self.db, &previous.id, rel)? {
                return Ok(previous.id.clone());
            }
        }
        Ok(crate::db::new_id())
    }

    /// 写一个文件（原子替换）再读进索引。写下去的总是 UTF-8
    pub fn write_and_index(&mut self, rel: &str, text: &str, change: &mut VaultChange) -> Result<DocRow> {
        let path = fsio::abs(&self.root, rel);
        fsio::write_atomic(&path, text)?;
        let (mtime, size) = fsio::stat(&path)
            .ok_or_else(|| AppError::Io(format!("写完读不到文件: {rel}")))?;
        self.index_text(rel, text, true, mtime, size, change)
    }

    fn remove_doc(&mut self, row: &DocRow, change: &mut VaultChange) -> Result<()> {
        match std::fs::remove_file(fsio::abs(&self.root, &row.rel_path)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        self.forget(row, change)?;
        self.prune(layout::dir_of(&row.rel_path));
        Ok(())
    }

    /// 挪走 / 删掉一篇之后，删掉空了的目录（`日记/2026/` 这种空壳）。
    /// 文件树上的除外：那是用户的文件夹，空着也留着。
    fn prune(&self, dir: &str) {
        if self.layout.folder_of_dir(dir).is_none() {
            fsio::prune_empty_dirs(&self.root, dir);
        }
    }

    /// 磁盘上的版本在索引之后被别的程序改过（文件监听还没来得及处理）：
    /// 先把那一版另存一份冲突副本，再写我们的。谁的内容都不丢。
    fn keep_external_edits(&mut self, row: &DocRow, change: &mut VaultChange) -> Result<()> {
        let path = fsio::abs(&self.root, &row.rel_path);
        let Some((mtime, size)) = fsio::stat(&path) else {
            return Ok(());
        };
        if mtime == row.mtime && size == row.size {
            return Ok(());
        }
        let Some(text) = self.read(&row.rel_path)? else {
            return Ok(());
        };
        if fsio::fingerprint(&text) != row.hash {
            self.write_conflict_copy(&row.rel_path, &text, change)?;
        }
        Ok(())
    }

    /// 编辑器照着 base 那一版正文改的（base 是那一版正文的指纹 fsio::fingerprint，前端 lib/fingerprint.ts
    /// 算的是同一个），磁盘上的正文已经不是那一版了
    /// （别的程序、同步刚改过，前端还没来得及刷新；或者前端看到了外部改动、编辑器里又有没存的修改）：
    /// 先把磁盘上那一版另存成冲突副本，再写编辑器的 —— 两边都不丢，提示条说一声（VaultChange.conflicts）。
    /// 磁盘上正好已经是要写的那些字就不用另存。没给 base（存失败的草稿，不知道当时照着哪一版）只比索引
    fn keep_unseen_edits(
        &mut self,
        row: &DocRow,
        base: Option<&str>,
        content: &str,
        change: &mut VaultChange,
    ) -> Result<()> {
        let Some(base) = base else {
            return self.keep_external_edits(row, change);
        };
        let Some(text) = self.read(&row.rel_path)? else {
            return Ok(());
        };
        let (_, body) = frontmatter::split(&text);
        if fsio::fingerprint(&body) != base && body != content {
            self.write_conflict_copy(&row.rel_path, &text, change)?;
        }
        Ok(())
    }

    /// 「标题 (冲突 2026-09-27 1030).md」，放在原文件旁边。它是一篇新的笔记：
    /// 去掉 id（不和原文件抢）、去掉写在属性块里的标题（否则两篇同名，分不清）。
    fn write_conflict_copy(&mut self, rel: &str, text: &str, change: &mut VaultChange) -> Result<DocRow> {
        let (mut meta, body) = frontmatter::split(text);
        meta.id = None;
        meta.title = None;
        meta.pinned = false;
        let stamp = chrono::Local::now().format("%Y-%m-%d %H%M");
        let stem = format!("{} (冲突 {stamp})", layout::stem_of(rel));
        let copy = fsio::unique_rel(&self.root, layout::dir_of(rel), &stem, None);
        let row = self.write_and_index(&copy, &frontmatter::render(&meta, &body), change)?;
        // 自己另存的这一份已经在 conflicts 里报了，不再当「新发现的副本」报一遍
        change.found_copies.retain(|title| *title != row.title);
        change.conflicts.push(row.title.clone());
        Ok(row)
    }

    /// 读磁盘上的当前内容，改属性块（可能连同位置），写回。正文用磁盘上的 ——
    /// 置顶、归档这类操作不该动正文，更不该拿索引里可能过时的那一版覆盖它。
    fn rewrite_note_meta(
        &mut self,
        row: &DocRow,
        new_rel: Option<String>,
        edit: impl FnOnce(&mut FrontMatter),
    ) -> Result<(DocRow, VaultChange)> {
        let text = self
            .read(&row.rel_path)?
            .ok_or_else(|| AppError::NotFound(format!("note {} 的文件不见了", row.id)))?;
        let external = fsio::fingerprint(&text) != row.hash;
        let (mut meta, body) = frontmatter::split(&text);

        let rel = match new_rel {
            Some(rel) if rel != row.rel_path => {
                fsio::move_file(&self.root, &row.rel_path, &rel)?;
                index::rename(&self.db, &row.id, &rel)?;
                self.tree_follow(&row.rel_path, &row.id);
                self.prune(layout::dir_of(&row.rel_path));
                rel
            }
            _ => row.rel_path.clone(),
        };
        // 换了文件夹：正文里相对路径的图片、链接改成从新位置出发，指向的还是同一个文件
        let relinked = folders::relink(
            &body,
            layout::dir_of(&row.rel_path),
            layout::dir_of(&rel),
            |target| fsio::abs(&self.root, target).exists(),
        );
        let body_changed = relinked != body;
        meta.id = Some(row.id.clone());
        meta.title = title_meta(&rel, &row.title);
        meta.created.get_or_insert(row.created_at);
        edit(&mut meta);

        let mut change = VaultChange::default();
        let saved = self.write_and_index(&rel, &frontmatter::render(&meta, &relinked), &mut change)?;
        // 磁盘上的正文和前端手里的不一样（外部刚改过，或者链接跟着位置改了）：
        // 让前端连这篇一起刷新，编辑器换上新正文
        let change = if external || body_changed {
            change
        } else {
            change.without(&saved)
        };
        Ok((saved, change))
    }

    /* ---------------- 笔记 ---------------- */

    fn note_row(&self, id: &str) -> Result<DocRow> {
        index::by_id(&self.db, id)?
            .filter(|row| row.kind == NOTE)
            .ok_or_else(|| AppError::NotFound(format!("note {id}")))
    }

    /// 一个列表（笔记 / 归档）的全部笔记，不带正文
    pub fn note_list(&self, archived: bool) -> Result<Vec<NoteSummary>> {
        index::note_summaries(&self.db, archived)?
            .iter()
            .map(|row| Ok(summary_from_row(row, self.conflict_of(row)?)))
            .collect()
    }

    /// 带正文的列表：只有测试还在用（前端早就不一次拿全文了，见 note_list）
    #[cfg(test)]
    pub fn note_list_full(&self, archived: bool) -> Result<Vec<Note>> {
        index::notes(&self.db, archived)?
            .iter()
            .map(|row| self.note_of(row))
            .collect()
    }

    pub fn note_get(&self, id: &str) -> Result<Note> {
        self.note_of(&self.note_row(id)?)
    }

    /// 测试搭场景用（应用里新建走 note_create_in，正文由编辑器的保存写）
    #[cfg(test)]
    pub fn note_create(&mut self, title: &str, content: &str) -> Result<String> {
        self.note_create_in("", title, content)
    }

    /// 在某个文件夹里新建（空串是「笔记」本身）。逻辑目录：文件平放，树上放在这个文件夹里
    pub fn note_create_in(&mut self, folder: &str, title: &str, content: &str) -> Result<String> {
        let dir = if self.tree.is_some() {
            self.tree_check_parent(folder)?;
            self.layout.notes.clone()
        } else {
            self.existing_folder_dir(folder)?
        };
        let id = crate::db::new_id();
        let stem = layout::file_stem_for_title(title);
        let rel = fsio::unique_rel(&self.root, &dir, &stem, None);
        let meta = FrontMatter {
            id: Some(id.clone()),
            title: title_meta(&rel, title),
            created: Some(now_ms()),
            ..FrontMatter::default()
        };
        let mut change = VaultChange::default();
        let row = self.write_and_index(&rel, &frontmatter::render(&meta, content), &mut change)?;
        self.tree_adopt(&row, folder)?;
        self.log.record("note", &row.id, "created");
        self.announce(change.without(&row));
        Ok(row.id)
    }

    /// 改正文（编辑器的保存）。标题、属性块里别的键都照磁盘上的留着。
    /// `base` 是编辑器照着改的那一版正文的指纹，磁盘上已经不是那一版了就先另存冲突副本
    /// （keep_unseen_edits）
    pub fn note_save(&mut self, id: &str, content: &str, base: Option<&str>) -> Result<Note> {
        let row = self.note_row(id)?;
        let mut change = VaultChange::default();
        self.keep_unseen_edits(&row, base, content, &mut change)?;
        let (mut meta, _) = frontmatter::split(&self.read(&row.rel_path)?.unwrap_or_default());
        meta.id = Some(row.id.clone());
        meta.created.get_or_insert(row.created_at);
        let saved = self.write_and_index(&row.rel_path, &frontmatter::render(&meta, content), &mut change)?;
        self.log.record("note", &saved.id, "updated");
        self.announce(change.without(&saved));
        self.note_of(&saved)
    }

    /// 改标题：文件跟着改名（同一个文件夹里），正文一个字都不动（照磁盘上的留着，见 rewrite_note_meta）。
    /// 和 note_save 互不覆盖：两样各写各的那一部分，谁先落库都一样
    pub fn note_rename(&mut self, id: &str, title: &str) -> Result<Note> {
        let title = title.trim();
        if title.is_empty() {
            return Err(AppError::Invalid("标题不能是空的".into()));
        }
        let row = self.note_row(id)?;
        if title == row.title {
            return self.note_of(&row);
        }
        let stem = layout::file_stem_for_title(title);
        let rel = fsio::unique_rel(
            &self.root,
            layout::dir_of(&row.rel_path),
            &stem,
            Some(&row.rel_path),
        );
        let (saved, change) = self.rewrite_note_meta(&row, Some(rel.clone()), |meta| {
            meta.title = title_meta(&rel, title);
        })?;
        self.log.record("note", &saved.id, "renamed");
        self.announce(change);
        self.note_of(&saved)
    }

    /// 改正文和标题。标题变了文件跟着改名（同一个文件夹里）。应用里的保存分成了 note_save / note_rename，
    /// 这个整篇写的留给测试和同步引擎的测试搭场景
    #[cfg(test)]
    pub fn note_update(&mut self, id: &str, title: &str, content: &str) -> Result<()> {
        let row = self.note_row(id)?;
        let mut change = VaultChange::default();
        self.keep_external_edits(&row, &mut change)?;

        let (mut meta, _) = frontmatter::split(&self.read(&row.rel_path)?.unwrap_or_default());
        let rel = if title != row.title {
            let stem = layout::file_stem_for_title(title);
            let rel = fsio::unique_rel(
                &self.root,
                layout::dir_of(&row.rel_path),
                &stem,
                Some(&row.rel_path),
            );
            if rel != row.rel_path {
                fsio::move_file(&self.root, &row.rel_path, &rel)?;
                index::rename(&self.db, &row.id, &rel)?;
                self.tree_follow(&row.rel_path, &row.id);
            }
            rel
        } else {
            row.rel_path.clone()
        };
        meta.id = Some(row.id.clone());
        meta.title = title_meta(&rel, title);
        meta.created.get_or_insert(row.created_at);

        let saved = self.write_and_index(&rel, &frontmatter::render(&meta, content), &mut change)?;
        self.log.record("note", &saved.id, "updated");
        self.announce(change.without(&saved));
        Ok(())
    }

    pub fn note_set_pinned(&mut self, id: &str, pinned: bool) -> Result<()> {
        let row = self.note_row(id)?;
        let (saved, change) = self.rewrite_note_meta(&row, None, |meta| meta.pinned = pinned)?;
        self.log
            .record("note", &saved.id, if pinned { "pinned" } else { "unpinned" });
        self.announce(change);
        Ok(())
    }

    /// 归档 = 挪进「归档」文件夹。置顶随之取消。原来在树上的哪个子文件夹里
    /// 记在属性块里，恢复时放回去。
    pub fn note_archive(&mut self, id: &str, category: Option<String>) -> Result<()> {
        self.layout.require_archive()?;
        let row = self.note_row(id)?;
        let rel = fsio::unique_rel(
            &self.root,
            &self.layout.archive,
            layout::stem_of(&row.rel_path),
            None,
        );
        let from = layout::dir_of(&row.rel_path);
        let archived_from = self
            .layout
            .folder_of_dir(from)
            .filter(|folder| !folder.is_empty())
            .map(|_| from.to_string());
        let (saved, change) = self.rewrite_note_meta(&row, Some(rel), |meta| {
            meta.pinned = false;
            meta.archived = Some(now_ms());
            meta.archived_from = archived_from;
            meta.category = category
                .or_else(|| meta.category.take())
                .or_else(|| Some("笔记".into()));
        })?;
        self.log.record("note", &saved.id, "archived");
        self.announce(change);
        Ok(())
    }

    /// 恢复 = 挪回树根 —— 归档前在哪个子文件夹就回哪个（文件夹没了就重新建上）
    pub fn note_restore(&mut self, id: &str) -> Result<()> {
        let row = self.note_row(id)?;
        let (meta, _) = frontmatter::split(&self.read(&row.rel_path)?.unwrap_or_default());
        let dir = meta
            .archived_from
            .filter(|dir| {
                self.layout
                    .folder_of_dir(dir)
                    .is_some_and(|folder| self.layout.folder_dir(folder).is_ok())
            })
            .unwrap_or_else(|| self.layout.notes.clone());
        let rel = fsio::unique_rel(&self.root, &dir, layout::stem_of(&row.rel_path), None);
        let (saved, change) = self.rewrite_note_meta(&row, Some(rel), |meta| {
            meta.archived = None;
            meta.archived_from = None;
        })?;
        self.folders = folders::list(&self.root, &self.layout);
        self.log.record("note", &saved.id, "restored");
        self.announce(change);
        Ok(())
    }

    /// 删除 = 挪进 `.odea/trash/<id>.md`，记下原来的位置，撤销时放回去。
    pub fn note_delete(&mut self, id: &str) -> Result<()> {
        let row = self.note_row(id)?;
        let mut change = VaultChange::default();
        self.trash(&row, &mut change)?;
        self.announce(change.without(&row));
        Ok(())
    }

    fn trash(&mut self, row: &DocRow, change: &mut VaultChange) -> Result<()> {
        let text = self.read(&row.rel_path)?.unwrap_or_default();
        let (mut meta, body) = frontmatter::split(&text);
        meta.id = Some(row.id.clone());
        meta.title = Some(row.title.clone());
        meta.created.get_or_insert(row.created_at);
        meta.trashed_from = Some(row.rel_path.clone());
        fsio::write_atomic(
            &fsio::abs(&self.root, &trash_rel(&row.id)),
            &frontmatter::render(&meta, &body),
        )?;
        self.remove_doc(row, change)?;
        self.log.record("note", &row.id, "deleted");
        Ok(())
    }

    pub fn note_undelete(&mut self, id: &str) -> Result<()> {
        let trash = trash_rel(id);
        let text = self
            .read(&trash)?
            .ok_or_else(|| AppError::NotFound(format!("deleted note {id}")))?;
        let (mut meta, body) = frontmatter::split(&text);
        let from = meta
            .trashed_from
            .take()
            .unwrap_or_else(|| layout::join(&self.layout.notes, &format!("{}.md", layout::UNTITLED)));
        let title = meta
            .title
            .clone()
            .unwrap_or_else(|| layout::stem_of(&from).to_string());
        let rel = fsio::unique_rel(
            &self.root,
            layout::dir_of(&from),
            layout::stem_of(&from),
            None,
        );
        meta.id = Some(id.to_string());
        meta.title = title_meta(&rel, &title);

        let mut change = VaultChange::default();
        let row = self.write_and_index(&rel, &frontmatter::render(&meta, &body), &mut change)?;
        std::fs::remove_file(fsio::abs(&self.root, &trash))?;
        // 原来的文件夹可能连同它一起删掉了，放回去时重新建上
        self.folders = folders::list(&self.root, &self.layout);
        self.log.record("note", &row.id, "undeleted");
        self.announce(change.without(&row));
        Ok(())
    }

    /// 挪到另一个文件夹（空串是树根）。文件名不变，重名时加序号；
    /// 正文里相对路径的图片、链接跟着改。
    pub fn note_move(&mut self, id: &str, folder: &str) -> Result<Note> {
        let row = self.note_row(id)?;
        if row.archived {
            return Err(AppError::Invalid("归档里的笔记先恢复再移动".into()));
        }
        if self.tree.is_some() {
            // 逻辑目录：只改清单，文件不动
            self.tree_place(id, folder, None)?;
            return self.note_of(&row);
        }
        let dir = self.existing_folder_dir(folder)?;
        if layout::dir_of(&row.rel_path) == dir {
            return self.note_of(&row);
        }
        let rel = fsio::unique_rel(&self.root, &dir, layout::stem_of(&row.rel_path), None);
        let (saved, change) = self.rewrite_note_meta(&row, Some(rel), |_| {})?;
        self.log.record_with("note", &saved.id, "moved", Some(folder));
        self.announce(change);
        self.note_of(&saved)
    }

    /* ---------------- 文件夹 ---------------- */

    /// 文件树上所有的文件夹（相对树根的路径）
    pub fn folders(&self) -> Vec<String> {
        match &self.tree {
            Some(tree) => tree.folder_paths(),
            None => folders::list(&self.root, &self.layout),
        }
    }

    /// 文件夹对应的目录，并且它得真的在（空串是树根，不在就建）
    fn existing_folder_dir(&self, folder: &str) -> Result<String> {
        let dir = self.layout.folder_dir(folder)?;
        if !folder.is_empty() && !fsio::abs(&self.root, &dir).is_dir() {
            return Err(AppError::NotFound(format!("文件夹「{folder}」不在了")));
        }
        Ok(dir)
    }

    /// 在 parent 里新建一个文件夹，重名时加序号。返回它的路径（相对「笔记」）。
    pub fn folder_create(&mut self, parent: &str, name: &str) -> Result<String> {
        if self.tree.is_some() {
            return self.tree_edit(|tree| tree.add_folder(parent, name), "created");
        }
        let parent_dir = self.existing_folder_dir(parent)?;
        let name = layout::folder_name(name)
            .ok_or_else(|| AppError::Invalid("文件夹名不能是空的".into()))?;
        let dir = folders::unique_dir(&self.root, &parent_dir, &name, None);
        std::fs::create_dir_all(fsio::abs(&self.root, &dir))?;
        self.folders = folders::list(&self.root, &self.layout);
        self.log.record("folder", &dir, "created");
        Ok(self.layout.folder_of_dir(&dir).unwrap_or_default().to_string())
    }

    /// 改名（同一个上层里），重名时加序号。底下的笔记路径跟着变，id 不变。
    /// 返回新路径（相对「笔记」）。
    pub fn folder_rename(&mut self, folder: &str, name: &str) -> Result<String> {
        if folder.is_empty() {
            return Err(AppError::Invalid("「笔记」本身不能改名".into()));
        }
        if self.tree.is_some() {
            return self.tree_edit(|tree| tree.rename(folder, name), "renamed");
        }
        let old_dir = self.existing_folder_dir(folder)?;
        let name = layout::folder_name(name)
            .ok_or_else(|| AppError::Invalid("文件夹名不能是空的".into()))?;
        let new_dir = folders::unique_dir(&self.root, layout::dir_of(&old_dir), &name, Some(&old_dir));
        if new_dir == old_dir {
            return Ok(folder.to_string());
        }
        std::fs::rename(fsio::abs(&self.root, &old_dir), fsio::abs(&self.root, &new_dir))?;
        index::rename_dir(&self.db, &old_dir, &new_dir)?;
        self.folders = folders::list(&self.root, &self.layout);
        self.log.record_with("folder", &old_dir, "renamed", Some(&new_dir));

        // 底下每篇的路径都变了：让前端刷新它们（正文里的图片以文件夹为基准）
        let mut change = VaultChange::default();
        for row in index::notes_under(&self.db, &new_dir)? {
            change.record(&row);
        }
        self.announce(change);
        Ok(self.layout.folder_of_dir(&new_dir).unwrap_or_default().to_string())
    }

    /// 删除文件夹：里面（任意深度）的笔记都进回收站，可以撤销（folder_undelete）。
    /// 空了的目录删掉；还有别的文件（图片、PDF）的目录留着，kept 为 true。
    pub fn folder_delete(&mut self, folder: &str) -> Result<FolderDeletion> {
        if folder.is_empty() {
            return Err(AppError::Invalid("「笔记」本身不能删".into()));
        }
        if self.tree.is_some() {
            return self.tree_delete(folder);
        }
        let dir = self.existing_folder_dir(folder)?;
        let removed: Vec<String> = folders::list(&self.root, &self.layout)
            .into_iter()
            .filter(|path| path == folder || path.starts_with(&format!("{folder}/")))
            .collect();
        let mut change = VaultChange::default();
        let mut notes = Vec::new();
        for row in index::notes_under(&self.db, &dir)? {
            self.trash(&row, &mut change)?;
            notes.push(row.id);
        }
        let kept = !folders::remove_empty_tree(&fsio::abs(&self.root, &dir));
        self.folders = folders::list(&self.root, &self.layout);
        self.log.record("folder", &dir, "deleted");
        // 删掉的笔记前端自己会拿掉；只把连带的变化（日历上的任务）告诉它
        change.notes.clear();
        self.announce(change);
        Ok(FolderDeletion {
            folder: folder.to_string(),
            notes,
            folders: removed,
            kept,
            nodes: None,
        })
    }

    /// 撤销删除文件夹：目录重新建上，笔记从回收站放回原处
    pub fn folder_undelete(&mut self, deletion: &FolderDeletion) -> Result<()> {
        if self.tree.is_some() {
            return self.tree_undelete(deletion);
        }
        for folder in &deletion.folders {
            std::fs::create_dir_all(fsio::abs(&self.root, &self.layout.folder_dir(folder)?))?;
        }
        for id in &deletion.notes {
            self.note_undelete(id)?;
        }
        self.folders = folders::list(&self.root, &self.layout);
        self.log.record("folder", &deletion.folder, "undeleted");
        Ok(())
    }

    /// 文件夹在磁盘上的位置（在文件管理器里打开它）
    pub fn locate_folder(&self, folder: &str) -> Result<PathBuf> {
        // 逻辑目录的文件夹不在硬盘上：打开仓库本身
        if self.tree.is_some() {
            return Ok(self.root.clone());
        }
        let dir = self.existing_folder_dir(folder)?;
        Ok(fsio::abs(&self.root, &dir))
    }

    /// 回收站里放了太久的文件真正删掉
    pub fn purge_trash(&self, older_than_ms: i64) {
        let Ok(entries) = std::fs::read_dir(fsio::abs(&self.root, layout::TRASH_DIR)) else {
            return;
        };
        let cutoff = now_ms() - older_than_ms;
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .is_ok_and(|meta| meta.is_file() && fsio::mtime_ms(&meta) < cutoff);
            if old {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    /// 回收站里的笔记，最近删的在前（回收站对话框）。`share-<时间>` 这类文件夹（退役的共享仓库）不算
    pub fn trash_list(&self) -> Result<Vec<TrashedNote>> {
        let Ok(entries) = std::fs::read_dir(fsio::abs(&self.root, layout::TRASH_DIR)) else {
            return Ok(Vec::new());
        };
        let keep = TRASH_KEEP_DAYS * 24 * 3600 * 1000;
        let mut notes = Vec::new();
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(stem) = name.strip_suffix(".md") else { continue };
            if !meta.is_file() {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
            let (front, body) = frontmatter::split(&text);
            let from = front.trashed_from.clone().unwrap_or_default();
            let deleted_at = fsio::mtime_ms(&meta);
            // 恢复按 id 找文件（trash_rel）：属性块里的 id 对得上这个文件就用它，对不上（手放进来的）用文件名
            let file = format!("{}/{name}", layout::TRASH_DIR);
            let id = front
                .id
                .clone()
                .filter(|id| trash_rel(id) == file)
                .unwrap_or_else(|| stem.to_string());
            notes.push(TrashedNote {
                id,
                title: front
                    .title
                    .clone()
                    .unwrap_or_else(|| layout::stem_of(&from).to_string()),
                from,
                excerpt: search::make_excerpt(&body, 80),
                deleted_at,
                purge_at: deleted_at + keep,
            });
        }
        notes.sort_by_key(|note| std::cmp::Reverse(note.deleted_at));
        Ok(notes)
    }

    /* ---------------- 插件的文档（某一天、某个周期的目标……） ----------------
       核心给插件开的那几样（docs/插件与跨端.md §5.1：L2 用得到的内部接口，不对外承诺）：
       按类型取一篇、按类型存一篇，加上上面的 read / write_and_index / announce，和行为日志、索引 */

    /// 这个仓库怎么摆（开着哪些插件、它们的文档类型）
    pub fn layout(&self) -> &layout::Layout {
        &self.layout
    }

    /// 索引：插件在上面查自己的文档和自己另存的那几张表
    pub fn db(&self) -> &Connection {
        &self.db
    }

    /// 行为日志：插件记自己的事（勾了一条任务）
    pub fn log_mut(&mut self) -> &mut activity::Log {
        &mut self.log
    }

    fn doc_type_of(&self, doc: &DocRef) -> Result<Arc<dyn DocType>> {
        self.layout
            .doc_type(&doc.kind)
            .cloned()
            .ok_or_else(|| AppError::Invalid(format!("这个仓库没开管「{}」的插件", doc.kind)))
    }

    /// 插件的这一篇放在哪（还没写过的是它将来的位置）
    pub fn typed_path(&self, doc: &DocRef) -> Result<String> {
        self.doc_type_of(doc)?.path_of(&doc.key)
    }

    /// 索引里插件的这一篇。磁盘上有、索引里还没有的（后台还没读到它）当场读进来
    pub fn typed_doc(&mut self, doc: &DocRef) -> Result<Option<DocRow>> {
        if let Some(row) = index::typed(&self.db, &doc.kind, &doc.key)? {
            return Ok(Some(row));
        }
        let rel = self.typed_path(doc)?;
        self.index_if_unseen(&rel)?;
        index::typed(&self.db, &doc.kind, &doc.key)
    }

    /// 写插件的一篇：位置照它的类型（写过的就在原处），edit 改属性块（某一天的标题）。
    /// 属性块和正文都空了就删掉这个文件 —— 空文件留在文件夹里只是杂物。base 同 note_save
    pub fn save_typed(
        &mut self,
        doc: &DocRef,
        body: &str,
        base: Option<&str>,
        edit: impl FnOnce(&mut FrontMatter),
    ) -> Result<()> {
        let ty = self.doc_type_of(doc)?;
        let existing = self.typed_doc(doc)?;
        let mut change = VaultChange::default();
        let rel = match &existing {
            Some(row) => {
                self.keep_unseen_edits(row, base, body, &mut change)?;
                row.rel_path.clone()
            }
            None => ty.path_of(&doc.key)?,
        };
        let (mut meta, _) = frontmatter::split(&self.read(&rel)?.unwrap_or_default());
        edit(&mut meta);

        if meta.is_empty() && body.trim().is_empty() {
            if let Some(row) = &existing {
                self.remove_doc(row, &mut change)?;
                change = change.without(row);
            }
        } else {
            let saved = self.write_and_index(&rel, &frontmatter::render(&meta, body), &mut change)?;
            self.log.record(ty.log_entity(), &ty.log_id(&doc.key), "updated");
            change = change.without(&saved);
        }
        self.announce(change);
        Ok(())
    }

    /// 所有写过东西的插件文档，最近改过的在前（命令面板按标题搜它们，正文走 search_text）
    pub fn doc_list(&self) -> Result<Vec<TypedDoc>> {
        Ok(index::typed_docs(&self.db)?
            .into_iter()
            .map(|row| {
                let (target, title) = target_and_title(&row, &self.layout.types);
                TypedDoc {
                    target,
                    title,
                    updated_at: row.updated_at,
                }
            })
            .collect())
    }

    /// 行为日志里这一篇记成什么：笔记是 note，插件的文档照插件说的（老版本记的什么就是什么）
    fn entity_of(&self, row: &DocRow) -> &'static str {
        self.layout.doc_type(&row.kind).map_or("note", |ty| ty.log_entity())
    }

    /* ---------------- 文件 ---------------- */

    /// 这篇文档的文件在哪。还没写过的插件文档（某一天、某个周期）没有文件，给它将来所在的、
    /// 已经存在的最近一层文件夹。第二个值表示是不是文件本身。
    pub fn locate(&self, target: &DocRef) -> Result<(PathBuf, bool)> {
        let rel = self.target_rel(target)?;
        let path = fsio::abs(&self.root, &rel);
        if path.is_file() {
            return Ok((path, true));
        }
        let mut dir = path.parent();
        while let Some(current) = dir {
            if current.is_dir() {
                return Ok((current.to_path_buf(), false));
            }
            if current == self.root {
                break;
            }
            dir = current.parent();
        }
        Ok((self.root.clone(), false))
    }

    fn target_rel(&self, target: &DocRef) -> Result<String> {
        if target.is_note() {
            return Ok(self.note_row(&target.key)?.rel_path);
        }
        Ok(match index::typed(&self.db, &target.kind, &target.key)? {
            Some(row) => row.rel_path,
            None => self.typed_path(target)?,
        })
    }

    /// 把磁盘上那一版另存一份冲突副本，返回它的标题。应用里的保存不再走这一步（版本对不上时
    /// keep_unseen_edits 自己另存），留给测试搭「已经有冲突副本」的场景
    #[cfg(test)]
    pub fn keep_conflict_copy(&mut self, target: &DocRef) -> Result<Option<String>> {
        let rel = self.target_rel(target)?;
        let Some(text) = self.read(&rel)? else {
            return Ok(None);
        };
        let mut change = VaultChange::default();
        let copy = self.write_conflict_copy(&rel, &text, &mut change)?;
        self.announce(change);
        Ok(Some(copy.title))
    }

    /// 同步合并完之后调（技术方案 §5.9.5）。`theirs` 是两边都改了的文件：原处已经是本机的
    /// 版本，把对方的版本另存在旁边 —— Markdown 走冲突副本（去掉 id 和属性块里的标题），
    /// 附件按原字节存成「名字 (冲突 时间).扩展名」，以点开头的路径（.odea、.gitignore）
    /// 不另存，留本机的就行。然后整个仓库增量扫一遍（合并改了哪些文件、多了哪些文件夹），
    /// 通知前端。返回另存的副本的名字（笔记是标题，附件是文件名），提示由同步那边发。
    pub fn absorb_merge(&mut self, theirs: &[(String, Vec<u8>)]) -> Result<Vec<String>> {
        let mut change = VaultChange::default();
        let mut copies = Vec::new();
        for (rel, bytes) in theirs {
            if rel.split('/').any(fsio::is_hidden_name) {
                continue;
            }
            let text = fsio::is_markdown(rel).then(|| std::str::from_utf8(bytes).ok()).flatten();
            if let Some(text) = text {
                copies.push(self.write_conflict_copy(rel, text, &mut change)?.title);
            } else if fsio::is_markdown(rel) {
                // 不是 UTF-8 的笔记改不了属性块（改了就是换过字的一份）：和附件一样按原字节另存
                let copy = self.conflict_copy_rel(rel);
                fsio::write_atomic_bytes(&fsio::abs(&self.root, &copy), bytes)?;
                copies.push(layout::stem_of(&copy).to_string());
            } else {
                let copy = self.conflict_copy_rel(rel);
                fsio::write_atomic_bytes(&fsio::abs(&self.root, &copy), bytes)?;
                copies.push(copy.rsplit('/').next().unwrap_or(&copy).to_string());
            }
        }
        // 冲突副本的提示是给「编辑器里有没存的修改时外部改动到了」的，这里由同步自己说
        change.conflicts.clear();
        let mut scanned = self.rescan()?;
        scanned.absorb(change);
        self.announce(scanned);
        Ok(copies)
    }

    /* ---------------- 不是 UTF-8 的文件（docs/1110审查与研究.md §5.1） ---------------- */

    /// 这一篇按什么编码认出来、转过去是什么样（转之前给用户看一眼）
    pub fn legacy_text(&self, target: &DocRef) -> Result<LegacyText> {
        let rel = self.target_rel(target)?;
        let bytes = self.legacy_bytes(&rel)?;
        let fingerprint = fsio::fingerprint_bytes(&bytes);
        Ok(match fsio::decode_legacy(&bytes) {
            Some((encoding, text)) => LegacyText {
                encoding: Some(encoding.to_string()),
                preview: legacy_preview(&text),
                backup: self.legacy_backup_rel(&rel, encoding).rsplit('/').next().unwrap_or_default().to_string(),
                fingerprint,
            },
            None => LegacyText {
                encoding: None,
                preview: String::new(),
                backup: String::new(),
                fingerprint,
            },
        })
    }

    /// 转成 UTF-8：原文按原字节另存在旁边（`周报 (GBK 原文).txt`，不是 .md、不进列表），再写转好的。
    /// fingerprint 是预览时那一版原文的（legacy_text），文件在这之间被改过就不转
    pub fn convert_to_utf8(&mut self, target: &DocRef, fingerprint: &str) -> Result<()> {
        let rel = self.target_rel(target)?;
        let bytes = self.legacy_bytes(&rel)?;
        if fsio::fingerprint_bytes(&bytes) != fingerprint {
            return Err(AppError::Invalid("这篇刚被改过，再看一眼认出来的样子".into()));
        }
        let (encoding, text) = fsio::decode_legacy(&bytes)
            .ok_or_else(|| AppError::Invalid("认不出这篇是什么编码（试过 GBK、UTF-16）".into()))?;
        // 先留原文，再写新的：中途出错原文也还在
        let backup = self.legacy_backup_rel(&rel, encoding);
        fsio::write_atomic_bytes(&fsio::abs(&self.root, &backup), &bytes)?;
        let mut change = VaultChange::default();
        let saved = self.write_and_index(&rel, &text, &mut change)?;
        self.log.record(self.entity_of(&saved), &saved.id, "updated");
        // 正开着的编辑器换上转好的正文、能编辑了：这一篇也要通知（不像保存那样 without）
        self.announce(change);
        Ok(())
    }

    /// 要转的那个文件原样的字节。已经是 UTF-8 的（别处刚转过、本来就是）不用转
    fn legacy_bytes(&self, rel: &str) -> Result<Vec<u8>> {
        let bytes = std::fs::read(fsio::abs(&self.root, rel)).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => AppError::NotFound(format!("文件不在了: {rel}")),
            _ => error.into(),
        })?;
        if std::str::from_utf8(&bytes).is_ok() {
            return Err(AppError::Invalid("这篇已经是 UTF-8 了".into()));
        }
        Ok(bytes)
    }

    /// 原文另存在哪：同一个文件夹里的「周报 (GBK 原文).txt」，重名加序号
    fn legacy_backup_rel(&self, rel: &str, encoding: &str) -> String {
        let dir = layout::dir_of(rel);
        let stem = layout::stem_of(rel);
        (1..)
            .map(|n| {
                let name = if n == 1 {
                    format!("{stem} ({encoding} 原文).txt")
                } else {
                    format!("{stem} ({encoding} 原文) {n}.txt")
                };
                layout::join(dir, &name)
            })
            .find(|candidate| !fsio::abs(&self.root, candidate).exists())
            .expect("总有一个没被占的")
    }

    /// 附件的冲突副本放在哪：「附件/图.png」→「附件/图 (冲突 2026-10-07 1030).png」，重名加序号
    fn conflict_copy_rel(&self, rel: &str) -> String {
        let dir = layout::dir_of(rel);
        let (stem, ext) = split_name(rel.rsplit('/').next().unwrap_or(rel));
        let stamp = chrono::Local::now().format("%Y-%m-%d %H%M");
        for n in 1.. {
            let name = if n == 1 {
                format!("{stem} (冲突 {stamp})")
            } else {
                format!("{stem} (冲突 {stamp}) {n}")
            };
            let file = if ext.is_empty() { name } else { format!("{name}.{ext}") };
            let copy = layout::join(dir, &file);
            if !fsio::abs(&self.root, &copy).exists() {
                return copy;
            }
        }
        unreachable!()
    }

    /* ---------------- 反向链接 ---------------- */

    /// 正文里写了 `[[这篇笔记的标题]]` 的文档（笔记、某一天、目标都算；归档的也算），
    /// 最近改过的在前。这篇自己链自己的不算。
    pub fn backlinks(&self, id: &str) -> Result<Vec<Backlink>> {
        let note = self.note_row(id)?;
        let mut out = Vec::new();
        for row in index::with_wikilinks(&self.db)? {
            if row.id == note.id {
                continue;
            }
            let hits: Vec<links::WikiLink> = links::wikilinks(&row.content_md)
                .into_iter()
                .filter(|link| links::same_title(&link.title, &note.title))
                .collect();
            if hits.is_empty() {
                continue;
            }
            let body_lines: Vec<&str> = row.content_md.split('\n').collect();
            let mut lines: Vec<BacklinkLine> = Vec::new();
            for hit in &hits {
                if lines.len() >= 3 {
                    break;
                }
                if lines.iter().any(|line| line.line == hit.line as i64) {
                    continue;
                }
                let text = body_lines.get(hit.line).copied().unwrap_or_default();
                lines.push(BacklinkLine {
                    line: hit.line as i64,
                    text: links::context_line(text, &note.title),
                });
            }
            let (target, title) = target_and_title(&row, &self.layout.types);
            out.push(Backlink {
                target,
                title,
                archived: row.archived,
                updated_at: row.updated_at,
                lines,
                count: hits.len() as i64,
            });
        }
        out.sort_by_key(|doc| std::cmp::Reverse(doc.updated_at));
        Ok(out)
    }

    /// 笔记改了标题之后（技术方案 §12.1）：别的文档里链到旧标题的 `[[…]]` 改成新标题，
    /// `|别名`、`#小节` 照留。三种情况不改，skipped 里说原因：新标题写不进双链（有 `[ ] | # ^`）；
    /// 还有别的笔记叫旧标题（那些链接本来就指着它）；新标题已经有别的笔记在用（改了就分不清链到哪篇）。
    /// 正文按磁盘上的改：外部刚改过、索引还没跟上的也不会被盖掉。改过的每篇连同前后全文交回去，
    /// relink_undo 能撤销
    pub fn relink(&mut self, id: &str, old_title: &str) -> Result<Relink> {
        let note = self.note_row(id)?;
        let old = old_title.trim();
        let new = note.title.trim().to_string();
        let mut result = Relink::default();
        if old.is_empty() || links::same_title(old, &new) {
            return Ok(result);
        }
        let sources: Vec<DocRow> = index::with_wikilinks(&self.db)?
            .into_iter()
            .filter(|row| row.id != note.id)
            .filter(|row| {
                links::wikilinks(&row.content_md)
                    .iter()
                    .any(|link| links::same_title(&link.title, old))
            })
            .collect();
        if sources.is_empty() {
            return Ok(result);
        }

        let titles = index::note_titles(&self.db)?;
        let taken = |title: &str| {
            titles
                .iter()
                .any(|(other, t)| *other != note.id && links::same_title(t, title))
        };
        result.skipped = if !links::linkable(&new) {
            Some(format!("新标题里有 [ ] | # ^，写不进双链：别处的 [[{old}]] 没有改"))
        } else if taken(old) {
            Some(format!("还有一篇也叫「{old}」，别处的 [[{old}]] 仍然指向它，没有改"))
        } else if taken(&new) {
            Some(format!("已经有一篇叫「{new}」了，别处的 [[{old}]] 没有改，免得分不清链到哪篇"))
        } else {
            None
        };
        if result.skipped.is_some() {
            result.links = sources
                .iter()
                .flat_map(|row| links::wikilinks(&row.content_md))
                .filter(|link| links::same_title(&link.title, old))
                .count() as i64;
            return Ok(result);
        }

        let mut change = VaultChange::default();
        for row in &sources {
            // 不是 UTF-8 的那篇不改：改了就把它整篇写坏了，那里的旧链接留着（它在 Odea 里本来就只能看）
            let Some(before) = self.read_lossy(&row.rel_path)?.filter(|file| file.utf8).map(|file| file.text) else {
                continue;
            };
            let (meta, body) = frontmatter::split(&before);
            let Some((body, count)) = links::retarget(&body, old, &new) else {
                continue;
            };
            let after = frontmatter::render(&meta, &body);
            let saved = self.write_and_index(&row.rel_path, &after, &mut change)?;
            self.log.record(self.entity_of(&saved), &saved.id, "updated");
            result.links += count as i64;
            result.docs.push(target_and_title(&saved, &self.layout.types).1);
            result.rewrites.push(LinkRewrite {
                rel_path: row.rel_path.clone(),
                before,
                after,
            });
        }
        self.announce(change);
        Ok(result)
    }

    /// 撤销 relink：每篇换回改之前的全文。改完之后又被改过的那篇不动 —— 撤销不能吃掉后来的修改。
    /// 返回换回了几篇
    pub fn relink_undo(&mut self, rewrites: &[LinkRewrite]) -> Result<i64> {
        let mut change = VaultChange::default();
        let mut restored = 0;
        for rewrite in rewrites {
            // 只认索引里有的文档：路径是前端交回来的
            if index::by_path(&self.db, &rewrite.rel_path)?.is_none() {
                continue;
            }
            // 后来被换成了别的编码的也算「又被改过」（after 总是 UTF-8 的，对不上）
            let now = self.read_lossy(&rewrite.rel_path)?;
            if !now.is_some_and(|file| file.utf8 && file.text == rewrite.after) {
                continue;
            }
            let saved = self.write_and_index(&rewrite.rel_path, &rewrite.before, &mut change)?;
            self.log.record(self.entity_of(&saved), &saved.id, "updated");
            restored += 1;
        }
        self.announce(change);
        Ok(restored)
    }

    /// 历史版本要找的文件：仓库根、相对路径，笔记再加上属性块里的 id（改名、挪文件夹之后靠它认）
    pub fn history_source(&self, target: &DocRef) -> Result<(PathBuf, String, Option<String>)> {
        let rel = self.target_rel(target)?;
        let id = target.is_note().then(|| target.key.clone());
        Ok((self.root.clone(), rel, id))
    }

    /* ---------------- 附件 ---------------- */

    /// 把一个文件（粘贴的图片、拖进来的文件）存进这篇文档的附件文件夹（Odea 的仓库是「附件」，
    /// Obsidian 的库照它的设置，Layout::attachment_dir），返回从这篇文档引用它的相对路径。
    /// 同名的文件已经在了：内容一样就直接用它，不一样就换个名字。
    pub fn attach(&mut self, target: &DocRef, name: &str, bytes: &[u8]) -> Result<Attachment> {
        if bytes.is_empty() {
            return Err(AppError::Invalid("文件是空的".into()));
        }
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(AppError::Invalid(format!(
                "文件太大了（{} MB），附件最多 {} MB",
                bytes.len() / 1_048_576,
                MAX_ATTACHMENT_BYTES / 1_048_576
            )));
        }
        let doc_rel = self.target_rel(target)?;
        let dir = self.layout.attachment_dir(&doc_rel);
        let (stem, ext) = split_name(name);
        let ext = ext.to_ascii_lowercase();
        // 剪贴板里的图片浏览器统一叫 image.png：换成「粘贴-时间」，免得附件里一堆 image-2、image-3
        let mut stem = layout::attachment_stem(stem);
        if stem.is_empty() || stem.eq_ignore_ascii_case("image") {
            stem = format!("粘贴-{}", chrono::Local::now().format("%Y%m%d-%H%M%S"));
        }
        let file_name = |n: usize| {
            let numbered = if n == 1 { stem.clone() } else { format!("{stem}-{n}") };
            if ext.is_empty() {
                numbered
            } else {
                format!("{numbered}.{ext}")
            }
        };
        for n in 1.. {
            let candidate = file_name(n);
            let rel = layout::join(&dir, &candidate);
            let path = fsio::abs(&self.root, &rel);
            match std::fs::read(&path) {
                Ok(existing) if existing == bytes => {}
                Ok(_) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    fsio::write_atomic_bytes(&path, bytes)?;
                }
                Err(error) => return Err(error.into()),
            }
            self.log.record("attachment", &candidate, "added");
            return Ok(Attachment {
                link: layout::relative_link(&doc_rel, &rel),
                is_image: IMAGE_EXTENSIONS.contains(&ext.as_str()),
                name: candidate,
            });
        }
        unreachable!()
    }

    /// 协作时访客要的文件（docs/协同编辑.md §7.2）：只给放在这篇附件位置上的（Layout::is_attachment_of，
    /// 不给别的笔记），规范化之后（符号链接解开）还在那个文件夹里。返回磁盘上的路径
    pub fn attachment_for_guest(&self, note: &str, file_rel: &str) -> Result<PathBuf> {
        let doc_rel = self.target_rel(&DocRef::note(note))?;
        let refuse = || AppError::Invalid("只给这篇笔记的附件".into());
        if !self.layout.is_attachment_of(&doc_rel, file_rel) {
            return Err(refuse());
        }
        let dir = fsio::abs(&self.root, &self.layout.attachment_dir(&doc_rel))
            .canonicalize()
            .map_err(|_| refuse())?;
        let file = fsio::abs(&self.root, file_rel)
            .canonicalize()
            .map_err(|_| AppError::Invalid("主持人那边找不到这个文件".into()))?;
        if file.parent() != Some(dir.as_path()) || !file.is_file() {
            return Err(refuse());
        }
        Ok(file)
    }

    /// 拖进来的是磁盘上的文件：读出来存进附件文件夹。本来就在这篇的附件文件夹里的，直接引用。
    pub fn attach_path(&mut self, target: &DocRef, source: &Path) -> Result<Attachment> {
        let name = source
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .ok_or_else(|| AppError::Invalid(format!("不是文件: {}", source.display())))?;
        let doc_rel = self.target_rel(target)?;
        let dir = self.layout.attachment_dir(&doc_rel);
        let attachments = fsio::abs(&self.root, &dir);
        let inside = source
            .parent()
            .zip(attachments.canonicalize().ok())
            .and_then(|(parent, dir)| parent.canonicalize().ok().map(|parent| parent == dir))
            .unwrap_or(false);
        if inside {
            let (_, ext) = split_name(&name);
            return Ok(Attachment {
                link: layout::relative_link(&doc_rel, &layout::join(&dir, &name)),
                is_image: IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()),
                name,
            });
        }
        let size = std::fs::metadata(source)?.len() as usize;
        if size > MAX_ATTACHMENT_BYTES {
            return Err(AppError::Invalid(format!(
                "「{name}」太大了（{} MB），附件最多 {} MB",
                size / 1_048_576,
                MAX_ATTACHMENT_BYTES / 1_048_576
            )));
        }
        let bytes = std::fs::read(source)?;
        self.attach(target, &name, &bytes)
    }

    pub fn info(&self) -> Result<VaultInfo> {
        let counts = index::counts(&self.db)?;
        Ok(VaultInfo {
            root: self.root.to_string_lossy().into_owned(),
            notes: counts.notes,
            archived: counts.archived,
            docs: counts.docs,
            layout: VaultLayout {
                logical: self.tree.is_some(),
                plugins: self.layout.plugins.iter().map(|id| id.to_string()).collect(),
                extensions: self
                    .layout
                    .extensions
                    .iter()
                    .map(|wanted| WantedExtension { id: wanted.id.clone(), version: wanted.version.clone() })
                    .collect(),
                archive: self.layout.archiving,
                notes_dir: self.layout.notes.clone(),
                archive_dir: self.layout.archive.clone(),
                hidden_dirs: self.layout.hidden_dirs().into_iter().map(String::from).collect(),
            },
            team: team::team_id(&self.root).is_some(),
        })
    }
}

/// 附件的大小上限
const MAX_ATTACHMENT_BYTES: usize = 50 * 1_048_576;

/// 当图片插进正文（`![](…)`）的扩展名；和 tauri.conf.json 里 asset 协议放行的一致
pub const IMAGE_EXTENSIONS: [&str; 9] = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico"];

/// 图片以外、`![[x]]` 嵌成附件卡片的扩展名（前端 lib/wikiFiles.ts 的 ATTACHMENT_FILE_RE 和它一致）。
/// 卡片上能「用系统的程序打开」，所以只收文档、表格、演示、音视频、压缩包这类：
/// 能执行的（exe、bat、cmd、ps1、lnk、url、js、html……）不在里面，点不开它们
pub const ATTACHMENT_EXTENSIONS: [&str; 39] = [
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "txt", "csv", "tsv", "epub",
    "pages", "numbers", "key", "mp3", "wav", "m4a", "ogg", "oga", "flac", "aac", "opus", "mp4", "m4v", "webm", "mov",
    "mkv", "avi", "zip", "7z", "rar", "psd", "xmind", "drawio", "heic",
];

/// 文件名是不是附件：图片或者 ATTACHMENT_EXTENSIONS 那几种（按扩展名，不分大小写）
pub fn is_attachment_name(name: &str) -> bool {
    let ext = split_name(name).1;
    !ext.is_empty()
        && IMAGE_EXTENSIONS
            .iter()
            .chain(ATTACHMENT_EXTENSIONS.iter())
            .any(|known| known.eq_ignore_ascii_case(ext))
}

/// 「截图 1.PNG」→ ("截图 1", "PNG")；没有扩展名时第二个是空串
fn split_name(name: &str) -> (&str, &str) {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() && ext.len() <= 8 => (stem, ext),
        _ => (name, ""),
    }
}

/// 0.3.0 的共享仓库退役了（docs/协同编辑.md §22.7）：它留在仓库里的 `.odea/share/`（每篇的 CRDT、
/// 成员表）挪进回收站。正文本来就是 .md，什么都不丢。所有设备都升上来以后（0.5 前后）整段删掉
fn retire_share(root: &Path) {
    let dir = fsio::abs(root, ".odea/share");
    if !dir.is_dir() {
        return;
    }
    let target = fsio::abs(root, &format!("{}/share-{}", layout::TRASH_DIR, now_ms()));
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(error) = std::fs::rename(&dir, &target) {
        eprintln!("共享仓库留下的 .odea/share 没能挪进回收站: {error}");
    }
}

fn trash_rel(id: &str) -> String {
    // id 来自属性块，理论上可能是任何字符串；只留安全的字符
    let safe: String = id
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    format!("{}/{safe}.md", layout::TRASH_DIR)
}

/// 搜正文（命令面板；archived_only 是归档的搜索框）：大小写不敏感的子串，和以前前端在全文里
/// indexOf 的结果一样。
/// 不在 Vault 上 —— 调用方拿一个单独的只读连接来搜，不占仓库的锁，搜大仓库时保存不用等
/// （索引是 WAL）。types 是开着的插件的文档类型（给插件的文档起标题），从仓库那里拿一份。
/// cancelled() 返回 true 说明又来了新的搜索，这一次作废，返回 None
pub fn search_text(
    conn: &Connection,
    query: &str,
    limit: usize,
    archived_only: bool,
    types: &[Arc<dyn DocType>],
    cancelled: impl Fn() -> bool,
) -> Result<Option<TextSearch>> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Some(TextSearch::default()));
    }
    let Some(found) = index::scan_text(conn, &needle, archived_only, cancelled)? else {
        return Ok(None);
    };
    let (mut notes, mut docs): (Vec<_>, Vec<_>) = found.into_iter().partition(|hit| hit.doc.kind == NOTE);
    notes.sort_by(|a, b| list_order(&a.doc, &b.doc));
    docs.sort_by_key(|hit| std::cmp::Reverse(hit.doc.updated_at));
    let hits = |list: Vec<index::TextMatch>| -> Vec<TextHit> {
        list.into_iter()
            .take(limit)
            .map(|hit| {
                let (target, title) = target_and_title(&hit.doc, types);
                TextHit {
                    target,
                    title,
                    updated_at: hit.doc.updated_at,
                    line: hit.line,
                }
            })
            .collect()
    };
    Ok(Some(TextSearch {
        notes: hits(notes),
        docs: hits(docs),
    }))
}

/// 搜出来的笔记怎么排：和两个列表接起来的顺序一样（index::notes）—— 笔记在归档前，置顶在前，
/// 再按时间倒序
fn list_order(a: &DocRow, b: &DocRow) -> std::cmp::Ordering {
    let when = |doc: &DocRow| {
        if doc.archived {
            doc.archived_at.unwrap_or(doc.updated_at)
        } else {
            doc.updated_at
        }
    };
    (a.archived, !a.pinned, std::cmp::Reverse(when(a)), &a.rel_path).cmp(&(
        b.archived,
        !b.pinned,
        std::cmp::Reverse(when(b)),
        &b.rel_path,
    ))
}

/// 全局搜索最多给出多少处命中：再多就该换个更准的词了（一共几处照样数完）
pub const FIND_MATCH_LIMIT: usize = 1000;
/// 命中处前面留几个字、后面留几个字、命中的字本身最多显示几个（一段 Markdown 常常整段一行）
const PREVIEW_BEFORE: usize = 32;
const PREVIEW_AFTER: usize = 160;
const PREVIEW_TEXT: usize = 200;

/// 全局搜索里的一篇：命中的位置 (第几行（从 0 数）, 这一行里的字节区间)，和一共几处
type FoundDoc = (DocRow, Vec<(usize, usize, usize)>, usize);

/// 全局搜索（commands::find_in_vault）：每一篇里每一处命中，一行一行地找，和 VS Code 的
/// 「在文件中查找」一样只搜正文。不在 Vault 上，理由同 search_text（types 也是）。
/// 正则写错了放在结果的 error 里；cancelled() 返回 true 说明又来了新的搜索，这一次作废，返回 None
pub fn find_text(
    conn: &Connection,
    query: &str,
    options: FindOptions,
    types: &[Arc<dyn DocType>],
    cancelled: impl Fn() -> bool,
) -> Result<Option<FindResult>> {
    let finder = match search::Finder::new(query, options) {
        Ok(Some(finder)) => finder,
        Ok(None) => return Ok(Some(FindResult::default())),
        Err(error) => {
            return Ok(Some(FindResult {
                error: Some(error),
                ..FindResult::default()
            }))
        }
    };
    // 每一篇：命中的位置 (第几行（从 0 数）, 这一行里的字节区间)，和一共几处。位置一篇最多留
    // FIND_MATCH_LIMIT 个（再多也给不出去），一大篇里搜一个「的」不会攒下几十万个
    let mut found: Vec<FoundDoc> = Vec::new();
    let finished = index::each_text_doc(conn, false, |doc| {
        if cancelled() {
            return false;
        }
        if !finder.may_match(&doc.content_md) {
            return true;
        }
        let mut hits = Vec::new();
        let mut count = 0;
        for (number, line) in doc.content_md.split('\n').enumerate() {
            let line = line.strip_suffix('\r').unwrap_or(line);
            for (from, to) in finder.find_in_line(line, usize::MAX) {
                count += 1;
                if hits.len() < FIND_MATCH_LIMIT {
                    hits.push((number, from, to));
                }
            }
        }
        if count > 0 {
            found.push((doc, hits, count));
        }
        true
    })?;
    if !finished {
        return Ok(None);
    }

    let (mut notes, mut docs): (Vec<_>, Vec<_>) = found.into_iter().partition(|(doc, _, _)| doc.kind == NOTE);
    notes.sort_by(|a, b| list_order(&a.0, &b.0));
    docs.sort_by_key(|found| std::cmp::Reverse(found.0.updated_at));

    let total: usize = notes.iter().chain(&docs).map(|(_, _, count)| count).sum();
    let mut budget = FIND_MATCH_LIMIT;
    let mut files = Vec::new();
    for (doc, hits, count) in notes.into_iter().chain(docs) {
        if budget == 0 {
            break;
        }
        let lines: Vec<&str> = doc.content_md.split('\n').collect();
        let matches: Vec<FindMatch> = hits
            .iter()
            .take(budget)
            .map(|&(number, from, to)| {
                let line = lines[number];
                let line = line.strip_suffix('\r').unwrap_or(line);
                find_match(line, number, from, to)
            })
            .collect();
        budget -= matches.len();
        let (target, title) = target_and_title(&doc, types);
        files.push(FindFile {
            target,
            title,
            updated_at: doc.updated_at,
            matches,
            count: count as u32,
        });
    }
    Ok(Some(FindResult {
        files,
        total: total as u32,
        truncated: total > FIND_MATCH_LIMIT,
        error: None,
    }))
}

/// 一处命中给前端的样子：位置按 UTF-16 算（编辑器里的位置），显示的那段前后各截一截
fn find_match(line: &str, number: usize, from: usize, to: usize) -> FindMatch {
    let utf16 = |text: &str| text.encode_utf16().count() as u32;
    let head = line[..from].trim_start();
    let before = if head.chars().count() > PREVIEW_BEFORE {
        let skip = head.chars().count() - PREVIEW_BEFORE;
        format!("…{}", head.chars().skip(skip).collect::<String>())
    } else {
        head.to_string()
    };
    let clip = |text: &str, max: usize| {
        if text.chars().count() > max {
            format!("{}…", text.chars().take(max).collect::<String>())
        } else {
            text.to_string()
        }
    };
    FindMatch {
        line: number as u32 + 1,
        column: utf16(&line[..from]),
        length: utf16(&line[from..to]),
        before,
        text: clip(&line[from..to], PREVIEW_TEXT),
        after: clip(line[to..].trim_end(), PREVIEW_AFTER),
    }
}

fn summary_from_row(row: &DocRow, conflict_of: Option<String>) -> NoteSummary {
    NoteSummary {
        id: row.id.clone(),
        title: row.title.clone(),
        excerpt: row.excerpt.clone(),
        word_count: row.word_count,
        is_pinned: row.pinned,
        is_archived: row.archived,
        archive_category: row.category.clone(),
        archived_at: row.archived_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        rel_path: row.rel_path.clone(),
        conflict_of,
        id_in_file: id_in_file(row),
        not_utf8: row.not_utf8,
    }
}

/// 转之前给人看的那一段：开头三十行、两千字以内
fn legacy_preview(text: &str) -> String {
    let head: String = text.split('\n').take(30).collect::<Vec<_>>().join("\n");
    head.chars().take(2000).collect()
}

/// 要改一个不是 UTF-8 的文件时报的错（Vault::read）。前端原样显示这句话
fn not_utf8(rel: &str) -> AppError {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    // 提示条一行只放得下三十来个字（ErrorToast），要紧的放前面
    AppError::Invalid(format!(
        "「{name}」不是 UTF-8 编码，Odea 只显示、不改它：改了会把原文写坏。在正文上方转成 UTF-8 以后就能改了"
    ))
}

/// 属性块里写着的 id 就是这一篇的（不是索引临时给的，也不是从别的文件拷过来的冲突副本）
fn id_in_file(row: &DocRow) -> bool {
    row.file_id.as_deref() == Some(row.id.as_str())
}

fn note_from_row(row: &DocRow, conflict_of: Option<String>) -> Note {
    Note {
        id: row.id.clone(),
        title: row.title.clone(),
        content_md: row.content_md.clone(),
        excerpt: row.excerpt.clone(),
        word_count: row.word_count,
        is_pinned: row.pinned,
        is_archived: row.archived,
        archive_category: row.category.clone(),
        archived_at: row.archived_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        rel_path: row.rel_path.clone(),
        conflict_of,
        id_in_file: id_in_file(row),
        not_utf8: row.not_utf8,
        properties: row.props.clone(),
    }
}

/// 指向这篇文档的 DocRef，和给人看的标题（笔记是标题；插件的文档照插件说的：「10月6日 · 周报」、「第 41 周目标」）
fn target_and_title(row: &DocRow, types: &[Arc<dyn DocType>]) -> (DocRef, String) {
    let title = match (&row.key, types.iter().find(|ty| ty.id() == row.kind)) {
        (Some(key), Some(ty)) => ty.display_title(key, &row.title),
        _ => row.title.clone(),
    };
    (doc_ref(row), title)
}

#[cfg(test)]
mod tests;
