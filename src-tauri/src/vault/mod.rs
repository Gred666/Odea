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
pub mod seed;
pub mod tasks;
pub mod watch;

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rusqlite::Connection;

use crate::db::now_ms;
use crate::domain::model::{
    Attachment, Backlink, BacklinkLine, CalendarMarks, DayDoc, DocTarget, FindFile, FindMatch,
    FindOptions, FindResult, FolderDeletion, Goal, JournalDoc, LinkRewrite, Note, NoteSummary,
    Relink, Task, TextHit, TextSearch, VaultChange, VaultInfo,
};
use crate::domain::search;
use crate::error::{AppError, Result};
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
    /// 上次扫描时「笔记」下面的文件夹：外部建了 / 删了文件夹，比一下就知道
    folders: Vec<String>,
}

impl VaultChange {
    pub fn is_empty(&self) -> bool {
        self.notes.is_empty()
            && self.days.is_empty()
            && self.goals.is_empty()
            && !self.tasks
            && self.conflicts.is_empty()
            && self.found_copies.is_empty()
            && !self.folders
    }

    fn record(&mut self, row: &DocRow) {
        let key = change_key(row);
        let list = match row.kind {
            "day" => &mut self.days,
            "goal" => &mut self.goals,
            _ => &mut self.notes,
        };
        if !list.contains(&key) {
            list.push(key);
        }
    }

    /// 把另一批变化并进来（去重）
    fn absorb(&mut self, other: VaultChange) {
        fn extend(into: &mut Vec<String>, from: Vec<String>) {
            for item in from {
                if !into.contains(&item) {
                    into.push(item);
                }
            }
        }
        extend(&mut self.notes, other.notes);
        extend(&mut self.days, other.days);
        extend(&mut self.goals, other.goals);
        extend(&mut self.conflicts, other.conflicts);
        extend(&mut self.found_copies, other.found_copies);
        self.tasks |= other.tasks;
        self.folders |= other.folders;
    }

    /// 去掉前端自己发起的那篇：它刚拿到了结果，不用再刷一遍
    fn without(mut self, row: &DocRow) -> Self {
        let key = change_key(row);
        match row.kind {
            "day" => self.days.retain(|item| *item != key),
            "goal" => self.goals.retain(|item| *item != key),
            _ => self.notes.retain(|item| *item != key),
        }
        self
    }
}

/// 前端认的键：笔记是 id，某一天是日期，目标是 `week:2026-09-21`（和前端 goalKey 一样）
fn change_key(row: &DocRow) -> String {
    match row.kind {
        "day" => row.day.clone().unwrap_or_default(),
        "goal" => format!(
            "{}:{}",
            row.horizon.as_deref().unwrap_or_default(),
            row.period_start.as_deref().unwrap_or_default()
        ),
        _ => row.id.clone(),
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
        vault.purge_trash(TRASH_KEEP_DAYS * 86_400_000);
        Ok(vault)
    }

    /// 还没和磁盘对齐过的仓库
    fn bare(root: &Path, db: Connection) -> Result<Self> {
        std::fs::create_dir_all(root)?;
        Ok(Self {
            root: root.to_path_buf(),
            db,
            log: activity::Log::new(fsio::abs(root, layout::ACTIVITY_DIR)),
            announce: None,
            folders: Vec::new(),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn set_announcer(&mut self, announce: Announce) {
        self.announce = Some(announce);
    }

    fn announce(&self, change: VaultChange) {
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
            let Some(text) = self.read(&file.rel)? else {
                continue;
            };
            self.index_text(&file.rel, &text, file.mtime, file.size, &mut change)?;
        }
        Ok(change)
    }

    /// 扫描里不读文件的那一半：只 stat。消失了的从索引里去掉、文件夹列表更新，
    /// 返回修改时间或大小变了、要（重新）读进索引的文件，按该读的顺序
    fn plan_rescan(&mut self) -> Result<(VaultChange, Vec<fsio::FileEntry>)> {
        let mut change = VaultChange::default();
        let mut files = fsio::walk_markdown(&self.root);
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
        let folders = folders::list(&self.root);
        if folders != self.folders {
            self.folders = folders;
            change.folders = true;
        }
        Ok((change, stale))
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
        if let Some(text) = self.read(rel)? {
            self.index_text(rel, &text, mtime, size, change)?;
        }
        Ok(())
    }

    /// 某一天 / 某个周期的文件在磁盘上，索引里还没有（后台还没读到它，见 open_quick）：
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
            let Some(text) = self.read(rel)? else {
                continue;
            };
            self.index_text(rel, &text, mtime, size, &mut change)?;
        }
        self.announce(change);
        Ok(())
    }

    fn forget(&mut self, row: &DocRow, change: &mut VaultChange) -> Result<()> {
        if !index::doc_tasks(&self.db, &row.id)?.is_empty() {
            change.tasks = true;
        }
        index::remove(&self.db, &row.id)?;
        change.record(row);
        Ok(())
    }

    fn read(&self, rel: &str) -> Result<Option<String>> {
        match std::fs::read(fsio::abs(&self.root, rel)) {
            Ok(bytes) => Ok(Some(match String::from_utf8(bytes) {
                Ok(text) => text,
                Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
            })),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// 按一个文件的内容更新索引。内容指纹没变时只更新文件状态。
    fn index_text(
        &mut self,
        rel: &str,
        text: &str,
        mtime: i64,
        size: i64,
        change: &mut VaultChange,
    ) -> Result<DocRow> {
        let hash = fsio::fingerprint(text);
        let previous = index::by_path(&self.db, rel)?;
        if let Some(previous) = &previous {
            if previous.hash == hash {
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
        let mut slot = layout::classify(rel);
        // 同一天、同一个周期只能有一篇；多出来的（比如手动拷了一份）当普通笔记
        match &slot {
            Slot::Day(date) => {
                if index::day(&self.db, date)?.is_some_and(|other| other.rel_path != rel) {
                    slot = Slot::Note { archived: false };
                }
            }
            Slot::Goal {
                horizon,
                period_start,
            } => {
                if index::goal(&self.db, horizon, period_start)?
                    .is_some_and(|other| other.rel_path != rel)
                {
                    slot = Slot::Note { archived: false };
                }
            }
            Slot::Note { .. } => {}
        }

        let stem = layout::stem_of(rel);
        let mut row = DocRow {
            id: String::new(),
            kind: "note",
            rel_path: rel.to_string(),
            day: None,
            horizon: None,
            period_start: None,
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
        };
        match slot {
            Slot::Note { archived } => {
                row.id = self.note_id_for(rel, meta.id.as_deref(), previous.as_ref())?;
                row.title = meta.title.clone().unwrap_or_else(|| stem.to_string());
                row.pinned = meta.pinned && !archived;
                row.archived = archived;
                row.archived_at = archived.then(|| meta.archived.unwrap_or(mtime));
            }
            Slot::Day(date) => {
                row.id = format!("day:{date}");
                row.kind = "day";
                row.title = meta.title.clone().unwrap_or_default();
                row.day = Some(date);
            }
            Slot::Goal {
                horizon,
                period_start,
            } => {
                row.id = format!("goal:{horizon}:{period_start}");
                row.kind = "goal";
                row.title = layout::goal_title(horizon, &period_start);
                row.horizon = Some(horizon.to_string());
                row.period_start = Some(period_start);
            }
        }

        let scheduled = tasks::scan(&body);
        let previous_tasks = match &previous {
            Some(previous) => index::doc_tasks(&self.db, &previous.id)?,
            None => Vec::new(),
        };
        let same_tasks = previous_tasks.len() == scheduled.len()
            && previous_tasks
                .iter()
                .zip(&scheduled)
                .all(|(a, b)| a.line == b.line && a.raw == b.raw);
        if !same_tasks {
            change.tasks = true;
        }

        row.content_md = body;
        index::put(&self.db, &row, &scheduled)?;

        if let Some(previous) = &previous {
            if previous.id != row.id {
                change.record(previous);
            }
        }
        change.record(&row);
        // 新出现的冲突副本（网盘同步时两边都改过）：让前端提示一声
        if previous.is_none() && row.kind == "note" && self.conflict_of(&row)?.is_some() {
            change.found_copies.push(row.title.clone());
        }
        Ok(row)
    }

    /// 这篇笔记是不是另一篇的冲突副本，是的话返回原文的 id。两条线索：
    /// 1. 属性块里的 id 被另一个文件占着 —— 网盘把整个文件拷了一份，id 也跟着拷了；
    /// 2. 文件名是冲突副本的样子（见 layout::conflict_originals），而且同一个文件夹里
    ///    真有那篇原文。原文也可以是某一天 / 某个周期的目标：「日记/2026/2026-10-07 (冲突 …).md」
    ///    的名字不是日期，扫描时当笔记，原文 id 是 `day:2026-10-07`（目标是 `goal:week:2026-09-21`）
    ///    —— 两台设备都改了今日TODO，是同步里最常见的冲突。
    fn conflict_of(&self, row: &DocRow) -> Result<Option<String>> {
        if row.kind != "note" {
            return Ok(None);
        }
        if let Some(file_id) = row.file_id.as_deref().filter(|id| *id != row.id) {
            if let Some(original) = index::by_id(&self.db, file_id)? {
                if original.kind == "note" && original.rel_path != row.rel_path {
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
    fn note_id_for(&self, rel: &str, meta_id: Option<&str>, previous: Option<&DocRow>) -> Result<String> {
        let usable = |id: &str| !id.starts_with("day:") && !id.starts_with("goal:");
        if let Some(id) = meta_id.filter(|id| usable(id)) {
            if !index::id_taken(&self.db, id, rel)? {
                return Ok(id.to_string());
            }
        }
        if let Some(previous) = previous.filter(|row| row.kind == "note") {
            if !index::id_taken(&self.db, &previous.id, rel)? {
                return Ok(previous.id.clone());
            }
        }
        Ok(crate::db::new_id())
    }

    fn write_and_index(&mut self, rel: &str, text: &str, change: &mut VaultChange) -> Result<DocRow> {
        let path = fsio::abs(&self.root, rel);
        fsio::write_atomic(&path, text)?;
        let (mtime, size) = fsio::stat(&path)
            .ok_or_else(|| AppError::Io(format!("写完读不到文件: {rel}")))?;
        self.index_text(rel, text, mtime, size, change)
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
    /// 「笔记」底下的除外：那是用户的文件夹，空着也留着。
    fn prune(&self, dir: &str) {
        if layout::folder_of_dir(dir).is_none() {
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
            .filter(|row| row.kind == "note")
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

    pub fn note_create(&mut self, title: &str, content: &str) -> Result<String> {
        self.note_create_in("", title, content)
    }

    /// 在某个文件夹里新建（空串是「笔记」本身）
    pub fn note_create_in(&mut self, folder: &str, title: &str, content: &str) -> Result<String> {
        let dir = self.existing_folder_dir(folder)?;
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
        self.log.record("note", &row.id, "created");
        self.announce(change.without(&row));
        Ok(row.id)
    }

    /// 改正文和标题。标题变了文件跟着改名（同一个文件夹里）。
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

    /// 归档 = 挪进「归档」文件夹。置顶随之取消。原来在「笔记」的哪个子文件夹里
    /// 记在属性块里，恢复时放回去。
    pub fn note_archive(&mut self, id: &str, category: Option<String>) -> Result<()> {
        let row = self.note_row(id)?;
        let rel = fsio::unique_rel(
            &self.root,
            layout::ARCHIVE_DIR,
            layout::stem_of(&row.rel_path),
            None,
        );
        let from = layout::dir_of(&row.rel_path);
        let archived_from = layout::folder_of_dir(from)
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

    /// 恢复 = 挪回「笔记」—— 归档前在哪个子文件夹就回哪个（文件夹没了就重新建上）
    pub fn note_restore(&mut self, id: &str) -> Result<()> {
        let row = self.note_row(id)?;
        let (meta, _) = frontmatter::split(&self.read(&row.rel_path)?.unwrap_or_default());
        let dir = meta
            .archived_from
            .filter(|dir| {
                layout::folder_of_dir(dir).is_some_and(|folder| layout::folder_dir(folder).is_ok())
            })
            .unwrap_or_else(|| layout::NOTES_DIR.to_string());
        let rel = fsio::unique_rel(&self.root, &dir, layout::stem_of(&row.rel_path), None);
        let (saved, change) = self.rewrite_note_meta(&row, Some(rel), |meta| {
            meta.archived = None;
            meta.archived_from = None;
        })?;
        self.folders = folders::list(&self.root);
        self.log.record("note", &saved.id, "restored");
        self.announce(change);
        Ok(())
    }

    /// 删除 = 挪进 `.ontheway/trash/<id>.md`，记下原来的位置，撤销时放回去。
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
            .unwrap_or_else(|| format!("{}/{}.md", layout::NOTES_DIR, layout::UNTITLED));
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
        self.folders = folders::list(&self.root);
        self.log.record("note", &row.id, "undeleted");
        self.announce(change.without(&row));
        Ok(())
    }

    /// 挪到另一个文件夹（空串是「笔记」本身）。文件名不变，重名时加序号；
    /// 正文里相对路径的图片、链接跟着改。
    pub fn note_move(&mut self, id: &str, folder: &str) -> Result<Note> {
        let row = self.note_row(id)?;
        if row.archived {
            return Err(AppError::Invalid("归档里的笔记先恢复再移动".into()));
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

    /// 「笔记」下面所有的子文件夹（相对「笔记」的路径）
    pub fn folders(&self) -> Vec<String> {
        folders::list(&self.root)
    }

    /// 文件夹对应的目录，并且它得真的在（空串是「笔记」本身，不在就建）
    fn existing_folder_dir(&self, folder: &str) -> Result<String> {
        let dir = layout::folder_dir(folder)?;
        if !folder.is_empty() && !fsio::abs(&self.root, &dir).is_dir() {
            return Err(AppError::NotFound(format!("文件夹「{folder}」不在了")));
        }
        Ok(dir)
    }

    /// 在 parent 里新建一个文件夹，重名时加序号。返回它的路径（相对「笔记」）。
    pub fn folder_create(&mut self, parent: &str, name: &str) -> Result<String> {
        let parent_dir = self.existing_folder_dir(parent)?;
        let name = layout::folder_name(name)
            .ok_or_else(|| AppError::Invalid("文件夹名不能是空的".into()))?;
        let dir = folders::unique_dir(&self.root, &parent_dir, &name, None);
        std::fs::create_dir_all(fsio::abs(&self.root, &dir))?;
        self.folders = folders::list(&self.root);
        self.log.record("folder", &dir, "created");
        Ok(layout::folder_of_dir(&dir).unwrap_or_default().to_string())
    }

    /// 改名（同一个上层里），重名时加序号。底下的笔记路径跟着变，id 不变。
    /// 返回新路径（相对「笔记」）。
    pub fn folder_rename(&mut self, folder: &str, name: &str) -> Result<String> {
        if folder.is_empty() {
            return Err(AppError::Invalid("「笔记」本身不能改名".into()));
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
        self.folders = folders::list(&self.root);
        self.log.record_with("folder", &old_dir, "renamed", Some(&new_dir));

        // 底下每篇的路径都变了：让前端刷新它们（正文里的图片以文件夹为基准）
        let mut change = VaultChange::default();
        for row in index::notes_under(&self.db, &new_dir)? {
            change.record(&row);
        }
        self.announce(change);
        Ok(layout::folder_of_dir(&new_dir).unwrap_or_default().to_string())
    }

    /// 删除文件夹：里面（任意深度）的笔记都进回收站，可以撤销（folder_undelete）。
    /// 空了的目录删掉；还有别的文件（图片、PDF）的目录留着，kept 为 true。
    pub fn folder_delete(&mut self, folder: &str) -> Result<FolderDeletion> {
        if folder.is_empty() {
            return Err(AppError::Invalid("「笔记」本身不能删".into()));
        }
        let dir = self.existing_folder_dir(folder)?;
        let removed: Vec<String> = folders::list(&self.root)
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
        self.folders = folders::list(&self.root);
        self.log.record("folder", &dir, "deleted");
        // 删掉的笔记前端自己会拿掉；只把连带的变化（日历上的任务）告诉它
        change.notes.clear();
        self.announce(change);
        Ok(FolderDeletion {
            folder: folder.to_string(),
            notes,
            folders: removed,
            kept,
        })
    }

    /// 撤销删除文件夹：目录重新建上，笔记从回收站放回原处
    pub fn folder_undelete(&mut self, deletion: &FolderDeletion) -> Result<()> {
        for folder in &deletion.folders {
            std::fs::create_dir_all(fsio::abs(&self.root, &layout::folder_dir(folder)?))?;
        }
        for id in &deletion.notes {
            self.note_undelete(id)?;
        }
        self.folders = folders::list(&self.root);
        self.log.record("folder", &deletion.folder, "undeleted");
        Ok(())
    }

    /// 文件夹在磁盘上的位置（在文件管理器里打开它）
    pub fn locate_folder(&self, folder: &str) -> Result<PathBuf> {
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

    /* ---------------- 某一天 ---------------- */

    fn tasks_due(&self, date: &str) -> Result<Vec<Task>> {
        Ok(index::tasks_due(&self.db, date)?
            .iter()
            .map(task_from_row)
            .collect())
    }

    /// `carry` 只在请求「今天」时为 true：今天还没写过，就延续之前最近写过的一天
    /// （不落库，用户一编辑才以今天的身份写文件）。
    pub fn day(&mut self, date: &str, carry: bool) -> Result<DayDoc> {
        if index::day(&self.db, date)?.is_none() {
            self.index_if_unseen(&layout::day_path(date)?)?;
        }
        let tasks = self.tasks_due(date)?;
        if let Some(row) = index::day(&self.db, date)? {
            return Ok(DayDoc {
                date: date.to_string(),
                title: row.title,
                tasks,
                note_md: row.content_md,
                updated_at: row.updated_at,
                carried_from: None,
                rel_path: row.rel_path,
            });
        }
        // 还没写过：给它将来的位置（延续来的内容也是以今天的身份写到这里）
        let rel_path = layout::day_path(date)?;
        if carry {
            if let Some(previous) = index::latest_day_before(&self.db, date)? {
                return Ok(DayDoc {
                    date: date.to_string(),
                    title: previous.title,
                    tasks,
                    note_md: previous.content_md,
                    updated_at: previous.updated_at,
                    carried_from: previous.day,
                    rel_path,
                });
            }
        }
        Ok(DayDoc {
            date: date.to_string(),
            title: String::new(),
            tasks,
            note_md: String::new(),
            updated_at: now_ms(),
            carried_from: None,
            rel_path,
        })
    }

    /// 写某一天。标题和正文都清空了就删掉这个文件 —— 空文件留在文件夹里只是杂物。
    pub fn save_day(&mut self, date: &str, title: &str, body: &str) -> Result<DayDoc> {
        if index::day(&self.db, date)?.is_none() {
            self.index_if_unseen(&layout::day_path(date)?)?;
        }
        let existing = index::day(&self.db, date)?;
        let mut change = VaultChange::default();
        let rel = match &existing {
            Some(row) => {
                self.keep_external_edits(row, &mut change)?;
                row.rel_path.clone()
            }
            None => layout::day_path(date)?,
        };
        let (mut meta, _) = frontmatter::split(&self.read(&rel)?.unwrap_or_default());
        meta.title = (!title.is_empty()).then(|| title.to_string());

        if meta.is_empty() && body.trim().is_empty() {
            if let Some(row) = &existing {
                self.remove_doc(row, &mut change)?;
                change = change.without(row);
            }
        } else {
            let saved = self.write_and_index(&rel, &frontmatter::render(&meta, body), &mut change)?;
            self.log.record("day", date, "updated");
            change = change.without(&saved);
        }
        self.announce(change);
        self.day(date, false)
    }

    pub fn calendar_marks(&self, from: &str, to: &str) -> Result<CalendarMarks> {
        let (written, open) = index::calendar_marks(&self.db, from, to)?;
        Ok(CalendarMarks { written, open })
    }

    /// 日历上有记号的所有日子（不分哪一种）
    #[cfg(test)]
    pub fn marked_dates(&self, from: &str, to: &str) -> Result<Vec<String>> {
        let marks = self.calendar_marks(from, to)?;
        let mut all: Vec<String> = marks.written.into_iter().chain(marks.open).collect();
        all.sort();
        all.dedup();
        Ok(all)
    }

    /// 所有写过的某一天、某个周期的目标，最近改过的在前（命令面板搜它们）
    pub fn journal_list(&self) -> Result<Vec<JournalDoc>> {
        Ok(index::journal(&self.db)?
            .into_iter()
            .map(|row| {
                let (target, title) = target_and_title(&row);
                JournalDoc {
                    target,
                    kind: row.kind.to_string(),
                    title,
                    updated_at: row.updated_at,
                }
            })
            .collect())
    }

    /* ---------------- 目标 ---------------- */

    pub fn goal(&mut self, horizon: &str, period_start: &str) -> Result<Goal> {
        layout::validate_period_start(horizon, period_start)?;
        if index::goal(&self.db, horizon, period_start)?.is_none() {
            self.index_if_unseen(&layout::goal_path(horizon, period_start)?)?;
        }
        Ok(match index::goal(&self.db, horizon, period_start)? {
            Some(row) => Goal {
                id: row.id,
                horizon: horizon.to_string(),
                title: row.title,
                period_start: period_start.to_string(),
                content_md: row.content_md,
                created_at: row.created_at,
                updated_at: row.updated_at,
                rel_path: row.rel_path,
            },
            None => Goal {
                id: String::new(),
                horizon: horizon.to_string(),
                title: String::new(),
                period_start: period_start.to_string(),
                content_md: String::new(),
                created_at: 0,
                updated_at: 0,
                rel_path: layout::goal_path(horizon, period_start)?,
            },
        })
    }

    pub fn save_goal(&mut self, horizon: &str, period_start: &str, body: &str) -> Result<Goal> {
        layout::validate_period_start(horizon, period_start)?;
        if index::goal(&self.db, horizon, period_start)?.is_none() {
            self.index_if_unseen(&layout::goal_path(horizon, period_start)?)?;
        }
        let existing = index::goal(&self.db, horizon, period_start)?;
        let mut change = VaultChange::default();
        let rel = match &existing {
            Some(row) => {
                self.keep_external_edits(row, &mut change)?;
                row.rel_path.clone()
            }
            None => layout::goal_path(horizon, period_start)?,
        };
        let (meta, _) = frontmatter::split(&self.read(&rel)?.unwrap_or_default());

        if meta.is_empty() && body.trim().is_empty() {
            if let Some(row) = &existing {
                self.remove_doc(row, &mut change)?;
                change = change.without(row);
            }
        } else {
            let saved = self.write_and_index(&rel, &frontmatter::render(&meta, body), &mut change)?;
            self.log.record("goal", &saved.id, "updated");
            change = change.without(&saved);
        }
        self.announce(change);
        self.goal(horizon, period_start)
    }

    /* ---------------- 任务 ---------------- */

    /// 勾选日历里的一条任务 = 改它所在文件里的那一行。
    pub fn toggle_task(&mut self, id: &str) -> Result<Task> {
        let task = index::task(&self.db, id)?
            .ok_or_else(|| AppError::NotFound(format!("task {id}")))?;
        let row = index::by_id(&self.db, &task.doc_id)?
            .ok_or_else(|| AppError::NotFound(format!("task {id} 所在的文档")))?;
        let text = self
            .read(&row.rel_path)?
            .ok_or_else(|| AppError::NotFound(format!("task {id} 所在的文件")))?;
        let (meta, body) = frontmatter::split(&text);
        let mut lines: Vec<String> = body.split('\n').map(str::to_string).collect();

        // 行号对得上就用它；对不上（文件在索引之后被改过）就找原文一样的那一行，
        // 只有唯一一行时才动 —— 宁可报错，也不勾错
        let line = if lines.get(task.line).is_some_and(|line| *line == task.raw) {
            task.line
        } else {
            let found: Vec<usize> = lines
                .iter()
                .enumerate()
                .filter(|(_, line)| **line == task.raw)
                .map(|(index, _)| index)
                .collect();
            match found.as_slice() {
                [only] => *only,
                _ => {
                    return Err(AppError::Invalid(
                        "这条任务所在的文档刚被改过，找不到它了，刷新后再试".into(),
                    ))
                }
            }
        };
        lines[line] = tasks::toggle_line(&lines[line])
            .ok_or_else(|| AppError::Invalid(format!("第 {} 行不是任务", line + 1)))?;

        let mut change = VaultChange::default();
        let saved = self.write_and_index(
            &row.rel_path,
            &frontmatter::render(&meta, &lines.join("\n")),
            &mut change,
        )?;
        let done = !task.done;
        self.log.record_with(
            "task",
            &saved.id,
            if done { "completed" } else { "reopened" },
            Some(&task.title),
        );
        // 前端手里这篇文档的正文过时了：连同它一起通知
        change.tasks = true;
        self.announce(change);

        index::task(&self.db, &index::task_id(&saved.id, line))?
            .map(|row| task_from_row(&row))
            .ok_or_else(|| AppError::Internal(format!("task {id} 勾选后读不到")))
    }

    /* ---------------- 文件 ---------------- */

    /// 这篇文档的文件在哪。还没写过的某一天 / 某个周期没有文件，给它将来所在的、
    /// 已经存在的最近一层文件夹。第二个值表示是不是文件本身。
    pub fn locate(&self, target: &DocTarget) -> Result<(PathBuf, bool)> {
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

    fn target_rel(&self, target: &DocTarget) -> Result<String> {
        Ok(match target {
            DocTarget::Note { id } => self.note_row(id)?.rel_path,
            DocTarget::Day { id } => match index::day(&self.db, id)? {
                Some(row) => row.rel_path,
                None => layout::day_path(id)?,
            },
            DocTarget::Goal {
                horizon,
                period_start,
            } => match index::goal(&self.db, horizon, period_start)? {
                Some(row) => row.rel_path,
                None => layout::goal_path(horizon, period_start)?,
            },
        })
    }

    /// 前端发现编辑器里有没存的改动、磁盘上又来了外部改动：先把磁盘上那一版另存一份，
    /// 前端随后照常保存自己的。返回冲突副本的标题。
    pub fn keep_conflict_copy(&mut self, target: &DocTarget) -> Result<Option<String>> {
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
    /// 附件按原字节存成「名字 (冲突 时间).扩展名」，以点开头的路径（.ontheway、.gitignore）
    /// 不另存，留本机的就行。然后整个仓库增量扫一遍（合并改了哪些文件、多了哪些文件夹），
    /// 通知前端。返回另存的副本的名字（笔记是标题，附件是文件名），提示由同步那边发。
    pub fn absorb_merge(&mut self, theirs: &[(String, Vec<u8>)]) -> Result<Vec<String>> {
        let mut change = VaultChange::default();
        let mut copies = Vec::new();
        for (rel, bytes) in theirs {
            if rel.split('/').any(fsio::is_hidden_name) {
                continue;
            }
            if fsio::is_markdown(rel) {
                let text = String::from_utf8_lossy(bytes);
                copies.push(self.write_conflict_copy(rel, &text, &mut change)?.title);
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
            let (target, title) = target_and_title(&row);
            out.push(Backlink {
                target,
                kind: row.kind.to_string(),
                title,
                archived: row.archived,
                updated_at: row.updated_at,
                lines,
                count: hits.len() as i64,
            });
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
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
            let Some(before) = self.read(&row.rel_path)? else {
                continue;
            };
            let (meta, body) = frontmatter::split(&before);
            let Some((body, count)) = links::retarget(&body, old, &new) else {
                continue;
            };
            let after = frontmatter::render(&meta, &body);
            let saved = self.write_and_index(&row.rel_path, &after, &mut change)?;
            self.log.record(saved.kind, &saved.id, "updated");
            result.links += count as i64;
            result.docs.push(target_and_title(&saved).1);
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
            if self.read(&rewrite.rel_path)?.as_deref() != Some(rewrite.after.as_str()) {
                continue;
            }
            let saved = self.write_and_index(&rewrite.rel_path, &rewrite.before, &mut change)?;
            self.log.record(saved.kind, &saved.id, "updated");
            restored += 1;
        }
        self.announce(change);
        Ok(restored)
    }

    /// 历史版本要找的文件：仓库根、相对路径，笔记再加上属性块里的 id（改名、挪文件夹之后靠它认）
    pub fn history_source(&self, target: &DocTarget) -> Result<(PathBuf, String, Option<String>)> {
        let rel = self.target_rel(target)?;
        let id = match target {
            DocTarget::Note { id } => Some(id.clone()),
            _ => None,
        };
        Ok((self.root.clone(), rel, id))
    }

    /* ---------------- 附件 ---------------- */

    /// 把一个文件（粘贴的图片、拖进来的文件）存进仓库的「附件」文件夹，返回从这篇文档
    /// 引用它的相对路径。同名的文件已经在了：内容一样就直接用它，不一样就换个名字。
    pub fn attach(&mut self, target: &DocTarget, name: &str, bytes: &[u8]) -> Result<Attachment> {
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
            let path = fsio::abs(&self.root, &layout::join(layout::ATTACHMENTS_DIR, &candidate));
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
                link: layout::attachment_link(&doc_rel, &candidate),
                is_image: IMAGE_EXTENSIONS.contains(&ext.as_str()),
                name: candidate,
            });
        }
        unreachable!()
    }

    /// 拖进来的是磁盘上的文件：读出来存进「附件」。本来就在仓库的「附件」里的，直接引用。
    pub fn attach_path(&mut self, target: &DocTarget, source: &Path) -> Result<Attachment> {
        let name = source
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .ok_or_else(|| AppError::Invalid(format!("不是文件: {}", source.display())))?;
        let attachments = fsio::abs(&self.root, layout::ATTACHMENTS_DIR);
        let inside = source
            .parent()
            .zip(attachments.canonicalize().ok())
            .and_then(|(parent, dir)| parent.canonicalize().ok().map(|parent| parent == dir))
            .unwrap_or(false);
        if inside {
            let doc_rel = self.target_rel(target)?;
            let (_, ext) = split_name(&name);
            return Ok(Attachment {
                link: layout::attachment_link(&doc_rel, &name),
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
            days: counts.days,
            goals: counts.goals,
            tasks: counts.tasks,
        })
    }
}

/// 附件的大小上限
const MAX_ATTACHMENT_BYTES: usize = 50 * 1_048_576;

/// 当图片插进正文（`![](…)`）的扩展名；和 tauri.conf.json 里 asset 协议放行的一致
const IMAGE_EXTENSIONS: [&str; 9] = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico"];

/// 「截图 1.PNG」→ ("截图 1", "PNG")；没有扩展名时第二个是空串
fn split_name(name: &str) -> (&str, &str) {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() && ext.len() <= 8 => (stem, ext),
        _ => (name, ""),
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
/// （索引是 WAL）。cancelled() 返回 true 说明又来了新的搜索，这一次作废，返回 None
pub fn search_text(
    conn: &Connection,
    query: &str,
    limit: usize,
    archived_only: bool,
    cancelled: impl Fn() -> bool,
) -> Result<Option<TextSearch>> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Some(TextSearch::default()));
    }
    let Some(found) = index::scan_text(conn, &needle, archived_only, cancelled)? else {
        return Ok(None);
    };
    let (mut notes, mut journal): (Vec<_>, Vec<_>) =
        found.into_iter().partition(|hit| hit.doc.kind == "note");
    notes.sort_by(|a, b| list_order(&a.doc, &b.doc));
    journal.sort_by(|a, b| b.doc.updated_at.cmp(&a.doc.updated_at));
    let hits = |list: Vec<index::TextMatch>| -> Vec<TextHit> {
        list.into_iter()
            .take(limit)
            .map(|hit| {
                let (target, title) = target_and_title(&hit.doc);
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
        journal: hits(journal),
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

/// 全局搜索（commands::find_in_vault）：每一篇里每一处命中，一行一行地找，和 VS Code 的
/// 「在文件中查找」一样只搜正文。不在 Vault 上，理由同 search_text。
/// 正则写错了放在结果的 error 里；cancelled() 返回 true 说明又来了新的搜索，这一次作废，返回 None
pub fn find_text(
    conn: &Connection,
    query: &str,
    options: FindOptions,
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
    let mut found: Vec<(DocRow, Vec<(usize, usize, usize)>, usize)> = Vec::new();
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

    let (mut notes, mut journal): (Vec<_>, Vec<_>) =
        found.into_iter().partition(|(doc, _, _)| doc.kind == "note");
    notes.sort_by(|a, b| list_order(&a.0, &b.0));
    journal.sort_by(|a, b| b.0.updated_at.cmp(&a.0.updated_at));

    let total: usize = notes.iter().chain(&journal).map(|(_, _, count)| count).sum();
    let mut budget = FIND_MATCH_LIMIT;
    let mut files = Vec::new();
    for (doc, hits, count) in notes.into_iter().chain(journal) {
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
        let (target, title) = target_and_title(&doc);
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
    }
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
    }
}

/// 「9月26日」
fn month_day(date: &str) -> String {
    match chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") {
        Ok(date) => {
            use chrono::Datelike;
            format!("{}月{}日", date.month(), date.day())
        }
        Err(_) => date.to_string(),
    }
}

/// 指向这篇文档的目标，和给人看的标题（笔记标题、「10月6日 · 周报」、「第 41 周目标」）
fn target_and_title(row: &DocRow) -> (DocTarget, String) {
    match row.kind {
        "day" => {
            let date = row.day.clone().unwrap_or_default();
            let title = if row.title.is_empty() {
                month_day(&date)
            } else {
                format!("{} · {}", month_day(&date), row.title)
            };
            (DocTarget::Day { id: date }, title)
        }
        "goal" => (
            DocTarget::Goal {
                horizon: row.horizon.clone().unwrap_or_default(),
                period_start: row.period_start.clone().unwrap_or_default(),
            },
            row.title.clone(),
        ),
        _ => (DocTarget::Note { id: row.id.clone() }, row.title.clone()),
    }
}

/// 灰色小字：分类 · 时间 · 出处
fn task_from_row(row: &index::TaskRow) -> Task {
    let target = match row.doc_kind {
        "day" => row.doc_day.clone().map(|id| DocTarget::Day { id }),
        "goal" => Some(DocTarget::Goal {
            horizon: row.doc_horizon.clone().unwrap_or_default(),
            period_start: row.doc_period_start.clone().unwrap_or_default(),
        }),
        _ => Some(DocTarget::Note {
            id: row.doc_id.clone(),
        }),
    };
    let source = match row.doc_kind {
        "day" => row.doc_day.as_deref().map(month_day),
        "goal" => Some(layout::goal_title(
            row.doc_horizon.as_deref().unwrap_or_default(),
            row.doc_period_start.as_deref().unwrap_or_default(),
        )),
        _ => Some(row.doc_title.clone()),
    };
    let meta = [row.category.clone(), row.time_label.clone(), source]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    Task {
        id: row.id.clone(),
        title: row.title.clone(),
        status: (if row.done { "done" } else { "todo" }).to_string(),
        meta: (!meta.is_empty()).then_some(meta),
        due_date: Some(row.due_date.clone()),
        time_label: row.time_label.clone(),
        category: row.category.clone(),
        source: target,
        line: Some(row.line as i64),
    }
}

#[cfg(test)]
mod tests;
