/* ============================================================
逻辑目录（docs/仓库与启动器.md §7）：文件树按自己的意思摆，和文件在硬盘上放在哪无关。

清单在 .odea/tree（tree.rs），这里把它接到仓库上：
- 打开仓库时读一次；别处改了它（同步合并、网盘、别的工具）重读，网盘的冲突副本（`tree (1)`）
  并进来再删掉
- 新建的笔记平放在 layout.notes（新建的逻辑目录是仓库根），树上放在当前的文件夹里
- 文件夹的新建、改名、挪动，笔记挪进挪出、排顺序：只改清单，不碰任何 .md，修改时间不变
- 删除照旧进回收站（技术方案 §5.2），节点留着：撤销时回到原处。删文件夹 = 底下的笔记进回收站
- 应用给一篇改名、挪位置时属性块里写上了 id：按路径引用它的那一行换成按 id（tree_follow）
- 引用的笔记不在了：连着两次整理（打开仓库、后台读完索引）都找不到才去掉 ——
  网盘可能是清单先到、笔记还在路上
============================================================ */

use std::collections::{HashMap, HashSet};

use super::index::{self, DocRow};
use super::query::{self, Query};
use super::tree::{self, Item, Tree};
use super::{folders, frontmatter, fsio, layout, Vault, VaultChange};
use crate::db::now_ms;
use crate::domain::model::{FolderDeletion, TreeNode};
use crate::error::{AppError, Result};

/// 索引的 meta 表里记着上次整理时找不到笔记的那些节点（逗号分开）
const DANGLING_KEY: &str = "tree.dangling";

/// 这一篇在清单里怎么引用：属性块里写着自己的 id 就按 id，否则按路径
fn note_item(row: &DocRow) -> Item {
    if row.file_id.as_deref() == Some(row.id.as_str()) {
        Item::Note(row.id.clone())
    } else {
        Item::File(row.rel_path.clone())
    }
}

impl Vault {
    fn tree_ref(&self) -> Result<&Tree> {
        self.tree.as_ref().ok_or_else(|| AppError::Invalid("这个仓库不是逻辑目录".into()))
    }

    fn tree_mut(&mut self) -> Result<&mut Tree> {
        self.tree.as_mut().ok_or_else(|| AppError::Invalid("这个仓库不是逻辑目录".into()))
    }

    /* ---------------- 读、写清单 ---------------- */

    /// 打开仓库时（bare）：逻辑目录读清单。清单不在（新建的逻辑目录）先空着，索引读全了按文件夹结构建
    pub(super) fn load_tree(&mut self) {
        if !self.layout.logical {
            self.tree = None;
            return;
        }
        self.tree = Some(Tree::default());
        self.tree_text.clear();
        if fsio::abs(&self.root, tree::TREE_FILE).is_file() {
            self.reload_tree();
        } else {
            self.tree_build = true;
        }
    }

    /// 磁盘上的清单和上次读到 / 写下的不一样（同步合并、网盘、别的工具改了它）就重读；网盘的冲突副本
    /// 并进来、删掉。理顺过、并过副本的写回去。返回树变没变
    pub(super) fn reload_tree(&mut self) -> bool {
        if self.tree.is_none() {
            return false;
        }
        let path = fsio::abs(&self.root, tree::TREE_FILE);
        let on_disk = std::fs::read_to_string(&path).ok();
        let copies = self.tree_copies();
        if copies.is_empty() && on_disk.as_deref().is_none_or(|text| text == self.tree_text) {
            // 清单被删了（还没建过的除外）：手里这一份写回去
            if on_disk.is_none() && !self.tree_build {
                if let Err(error) = fsio::write_atomic(&path, &self.tree_text) {
                    eprintln!("写回逻辑目录的清单失败: {error}");
                }
            }
            return false;
        }
        let mut text = on_disk.clone().unwrap_or_else(|| self.tree_text.clone());
        for (_, copy) in &copies {
            text = tree::merge_copy(&text, copy);
        }
        let parsed = Tree::parse(&text);
        let rendered = parsed.render();
        if on_disk.as_deref() != Some(rendered.as_str()) {
            if let Err(error) = fsio::write_atomic(&path, &rendered) {
                eprintln!("写回逻辑目录的清单失败: {error}");
            }
        }
        for (copy, _) in copies {
            let _ = std::fs::remove_file(copy);
        }
        let changed = self.tree.as_ref() != Some(&parsed);
        self.tree = Some(parsed);
        self.tree_text = rendered;
        self.tree_build = false;
        changed
    }

    /// .odea/ 里清单的冲突副本（`tree (1)`、`tree.sync-conflict-…`、`tree-DESKTOP-…`）和内容
    fn tree_copies(&self) -> Vec<(std::path::PathBuf, String)> {
        let Ok(entries) = std::fs::read_dir(fsio::abs(&self.root, layout::APP_DIR)) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                let copy = name != tree::TREE_NAME
                    && !fsio::is_hidden_name(&name)
                    && layout::conflict_originals(&name).iter().any(|original| original == tree::TREE_NAME);
                if !copy {
                    return None;
                }
                let text = std::fs::read_to_string(entry.path()).ok()?;
                Some((entry.path(), text))
            })
            .collect()
    }

    /// 改完树写下来（和上次写的一样就不写）。文件监听放行了这个文件，同步照样被戳到（watch.rs）
    pub(super) fn save_tree(&mut self) -> Result<()> {
        let Some(tree) = &self.tree else { return Ok(()) };
        let text = tree.render();
        if text != self.tree_text {
            fsio::write_atomic(&fsio::abs(&self.root, tree::TREE_FILE), &text)?;
            self.tree_text = text;
        }
        Ok(())
    }

    /// 索引和磁盘对齐完了（打开时当场读完，或者后台那批读完）：清单还没建过的按文件夹结构建；
    /// 按路径引用、其实已经写上了 id 的换成按 id；找不到笔记的节点按两次的规矩去掉。返回树变没变
    pub(super) fn on_indexed(&mut self) -> bool {
        self.indexed_all = true;
        if self.tree.is_none() {
            return false;
        }
        match self.settle_tree() {
            Ok(changed) => changed,
            Err(error) => {
                eprintln!("整理逻辑目录失败: {error}");
                false
            }
        }
    }

    fn settle_tree(&mut self) -> Result<bool> {
        let mut changed = false;
        if self.tree_build {
            self.tree_build = false;
            // 读索引的时候用户已经动过树（建了文件夹之类）就不建了：那些笔记在「未整理」里
            if self.tree.as_ref().is_some_and(Tree::is_empty) {
                self.tree = Some(self.structure()?);
                changed = true;
            }
        }
        changed |= self.tidy_tree()?;
        if changed || !fsio::abs(&self.root, tree::TREE_FILE).is_file() {
            self.save_tree()?;
        }
        Ok(changed)
    }

    fn tidy_tree(&mut self) -> Result<bool> {
        let refs = index::note_refs(&self.db)?;
        let ids: HashSet<&str> = refs.iter().map(|(id, _, _)| id.as_str()).collect();
        let by_rel: HashMap<&str, (&str, bool)> = refs
            .iter()
            .map(|(id, rel, file_id)| (rel.as_str(), (id.as_str(), file_id.as_deref() == Some(id.as_str()))))
            .collect();
        let trashed = self.trashed_ids();
        let previous: HashSet<String> = index::meta_get(&self.db, DANGLING_KEY)?
            .unwrap_or_default()
            .split(',')
            .filter(|id| !id.is_empty())
            .map(String::from)
            .collect();
        let Some(tree) = self.tree.as_mut() else { return Ok(false) };

        let mut upgrades = Vec::new();
        let mut dangling = Vec::new();
        for (node, entry) in tree.nodes() {
            // 快捷方式和笔记的引用一个规矩：找不到的按两次去掉，按路径的有了 id 换成按 id
            match &entry.item {
                Item::Note(id) | Item::LinkNote(id) if !ids.contains(id.as_str()) && !trashed.contains(id) => {
                    dangling.push(node.clone())
                }
                Item::File(rel) | Item::LinkFile(rel) => match by_rel.get(rel.as_str()) {
                    Some((id, true)) => upgrades.push((node.clone(), id.to_string(), entry.item.is_link())),
                    Some(_) => {}
                    None => dangling.push(node.clone()),
                },
                _ => {}
            }
        }
        let mut changed = false;
        // 按路径引用的、属性块里已经写上了 id（在 Odea 里改过、别的工具加了 id）：换成按 id，以后改名也找得到
        for (node, id, link) in upgrades {
            if link {
                tree.set_item(&node, Item::LinkNote(id));
            } else if tree.find_note_id(&id).is_some() {
                tree.remove_nodes(&[node]);
            } else {
                tree.set_item(&node, Item::Note(id));
            }
            changed = true;
        }
        let (gone, first_time): (Vec<String>, Vec<String>) =
            dangling.into_iter().partition(|node| previous.contains(node));
        if !gone.is_empty() {
            tree.remove_nodes(&gone);
            changed = true;
        }
        index::meta_set(&self.db, DANGLING_KEY, &first_time.join(","))?;
        Ok(changed)
    }

    /// 回收站里的笔记 id（文件名就是 id，见 trash_rel）
    fn trashed_ids(&self) -> HashSet<String> {
        let Ok(entries) = std::fs::read_dir(fsio::abs(&self.root, layout::TRASH_DIR)) else {
            return HashSet::new();
        };
        entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                fsio::is_markdown(&name).then(|| layout::stem_of(&name).to_string())
            })
            .collect()
    }

    /// 按现在的文件夹结构摆一棵树（转成逻辑目录、新建的逻辑目录第一次打开）。没归档的按列表的顺序
    /// （置顶在前、最近改过的在前）；归档的放在归档前所在的文件夹，恢复时回到那里
    fn structure(&self) -> Result<Tree> {
        let folders = folders::list(&self.root, &self.layout);
        let folder_of = |dir: &str| self.layout.folder_of_dir(dir).unwrap_or("").to_string();
        let mut notes = Vec::new();
        for row in index::note_summaries(&self.db, false)? {
            notes.push((folder_of(layout::dir_of(&row.rel_path)), note_item(&row)));
        }
        for row in index::note_summaries(&self.db, true)? {
            let from = self
                .read(&row.rel_path)?
                .and_then(|text| frontmatter::split(&text).0.archived_from)
                .unwrap_or_default();
            notes.push((folder_of(&from), note_item(&row)));
        }
        Ok(tree::from_structure(&folders, &notes))
    }

    /* ---------------- 给前端 ---------------- */

    /// 树上每个节点在前端的样子：按路径引用的换成笔记的 id，找不到笔记的、同一篇的第二处不给。
    /// 快捷方式是 `shortcut`，note 是它指向的那一篇
    pub fn tree_view(&self) -> Result<Vec<TreeNode>> {
        let tree = self.tree_ref()?;
        let resolved = self.resolve_notes(tree)?;
        let refs = index::note_refs(&self.db)?;
        let ids: HashSet<&str> = refs.iter().map(|(id, _, _)| id.as_str()).collect();
        let by_rel: HashMap<&str, &str> = refs.iter().map(|(id, rel, _)| (rel.as_str(), id.as_str())).collect();
        Ok(tree
            .nodes()
            .filter_map(|(id, node)| {
                let (kind, name, note, query) = match &node.item {
                    Item::Folder(name) => ("folder", Some(name.clone()), None, None),
                    Item::Query { name, query } => ("query", Some(name.clone()), None, Some(query.clone())),
                    Item::Note(_) | Item::File(_) => ("note", None, Some(resolved.get(id)?.clone()), None),
                    Item::LinkNote(note) => ("shortcut", None, Some(ids.get(note.as_str())?.to_string()), None),
                    Item::LinkFile(rel) => ("shortcut", None, Some(by_rel.get(rel.as_str())?.to_string()), None),
                };
                Some(TreeNode {
                    id: id.clone(),
                    parent: node.parent.clone(),
                    key: node.key.clone(),
                    kind: kind.into(),
                    name,
                    note,
                    query,
                })
            })
            .collect())
    }

    /// 笔记节点 → 笔记 id。找不到笔记的不在里面；同一篇被引用了两处（按 id 一处、按路径一处）只认前一处
    pub(super) fn resolve_notes(&self, tree: &Tree) -> Result<HashMap<String, String>> {
        let refs = index::note_refs(&self.db)?;
        let ids: HashSet<&str> = refs.iter().map(|(id, _, _)| id.as_str()).collect();
        let by_rel: HashMap<&str, &str> = refs.iter().map(|(id, rel, _)| (rel.as_str(), id.as_str())).collect();
        let mut seen = HashSet::new();
        let mut out = HashMap::new();
        for (node, entry) in tree.nodes() {
            let note = match &entry.item {
                Item::Note(id) => ids.contains(id.as_str()).then_some(id.as_str()),
                Item::File(rel) => by_rel.get(rel.as_str()).copied(),
                _ => None,
            };
            if let Some(note) = note.filter(|note| seen.insert(note.to_string())) {
                out.insert(node.clone(), note.to_string());
            }
        }
        Ok(out)
    }

    /* ---------------- 笔记放在哪 ---------------- */

    /// 前端说的文件夹 → 清单里的父节点路径。`/` 是「未整理」（None）；智能文件夹里放不了东西，当树根
    fn tree_parent(&self, folder: &str) -> Result<Option<String>> {
        if folder == tree::UNSORTED {
            return Ok(None);
        }
        let tree = self.tree_ref()?;
        if tree.query_at(folder).is_some() {
            return Ok(Some(String::new()));
        }
        if tree.find_branch(folder).is_none() {
            return Err(AppError::NotFound(format!("文件夹「{folder}」不在了")));
        }
        Ok(Some(folder.to_string()))
    }

    /// 新建之前先看文件夹在不在：不在的话文件都不该建
    pub(super) fn tree_check_parent(&self, folder: &str) -> Result<()> {
        self.tree_parent(folder).map(|_| ())
    }

    /// 新建的这篇放到树上（逻辑目录才放；本地目录什么都不做），排在这个文件夹最前面
    pub(super) fn tree_adopt(&mut self, row: &DocRow, folder: &str) -> Result<()> {
        if self.tree.is_none() {
            return Ok(());
        }
        let parent = self.tree_parent(folder)?;
        let tree = self.tree_mut()?;
        let at = tree.find_note(&row.id, &row.rel_path);
        tree.place(at, note_item(row), parent.as_deref(), None)?;
        self.save_tree()
    }

    /// 把一篇放进 folder（`/` 是「未整理」），排在 after 那一篇后面，None 是最前面。只改清单
    pub fn tree_place(&mut self, id: &str, folder: &str, after: Option<&str>) -> Result<()> {
        let row = self.note_row(id)?;
        let after = after.map(|after| self.note_row(after)).transpose()?;
        let parent = self.tree_parent(folder)?;
        let tree = self.tree_mut()?;
        let at = tree.find_note(&row.id, &row.rel_path);
        let after = after.and_then(|after| tree.find_note(&after.id, &after.rel_path));
        tree.place(at, note_item(&row), parent.as_deref(), after.as_deref())?;
        self.save_tree()?;
        self.log.record_with("note", &row.id, "placed", Some(folder));
        Ok(())
    }

    /// 应用给一篇改了名、挪了位置（属性块里同时写上了 id）：按旧路径引用它的那一行换成按 id，
    /// 指向它的快捷方式也一样
    pub(super) fn tree_follow(&mut self, old_rel: &str, id: &str) {
        let Some(tree) = self.tree.as_mut() else { return };
        let links: Vec<String> = tree
            .nodes()
            .filter(|(_, node)| matches!(&node.item, Item::LinkFile(rel) if rel == old_rel))
            .map(|(node, _)| node.clone())
            .collect();
        let placed = tree.find_file(old_rel);
        if placed.is_none() && links.is_empty() {
            return;
        }
        for link in links {
            tree.set_item(&link, Item::LinkNote(id.to_string()));
        }
        if let Some(node) = placed {
            if tree.find_note_id(id).is_some() {
                tree.remove_nodes(&[node]);
            } else {
                tree.set_item(&node, Item::Note(id.to_string()));
            }
        }
        if let Err(error) = self.save_tree() {
            eprintln!("写逻辑目录的清单失败: {error}");
        }
    }

    /// 在文件夹 folder 里放一个快捷方式，指向笔记 id（docs §7.5 第 1 条：一篇只在一个位置，快捷方式另算）。
    /// 这个文件夹里已经有指向它的就不再放。返回快捷方式的节点 id
    pub fn tree_add_shortcut(&mut self, id: &str, folder: &str) -> Result<String> {
        let row = self.note_row(id)?;
        if self.tree_ref()?.query_at(folder).is_some() {
            return Err(AppError::Invalid("智能文件夹里放不了快捷方式".into()));
        }
        let parent = self
            .tree_parent(folder)?
            .ok_or_else(|| AppError::Invalid("「未整理」里放不了快捷方式".into()))?;
        let node = self.tree_mut()?.add_link(&parent, &note_item(&row))?;
        self.save_tree()?;
        self.log.record_with("note", &row.id, "shortcut", Some(folder));
        Ok(node)
    }

    /// 删一个快捷方式：只拿掉那一行，笔记不动
    pub fn tree_remove_shortcut(&mut self, node: &str) -> Result<()> {
        self.tree_mut()?.remove_link(node)?;
        self.save_tree()
    }

    /* ---------------- 文件夹 ---------------- */

    /// 改一下树（新建、改名、挪动文件夹）、写下来，返回改完的路径
    pub(super) fn tree_edit(&mut self, edit: impl FnOnce(&mut Tree) -> Result<String>, action: &str) -> Result<String> {
        let path = edit(self.tree_mut()?)?;
        self.save_tree()?;
        self.log.record("folder", &path, action);
        Ok(path)
    }

    /// 挪文件夹（智能文件夹也是）：放进 parent，排在 after（同一层的路径）后面，None 是最前面
    pub fn tree_move_folder(&mut self, folder: &str, parent: &str, after: Option<&str>) -> Result<String> {
        self.tree_edit(|tree| tree.move_branch(folder, parent, after), "moved")
    }

    pub fn tree_add_query(&mut self, parent: &str, name: &str, query: &str) -> Result<String> {
        self.tree_edit(|tree| tree.add_query(parent, name, query), "created")
    }

    pub fn tree_set_query(&mut self, folder: &str, name: &str, query: &str) -> Result<String> {
        self.tree_edit(|tree| tree.set_query(folder, name, query), "updated")
    }

    /// 删文件夹：连同底下的文件夹、智能文件夹从清单里拿掉，放在里面的笔记进回收站（归档的不动）。
    /// 拿掉的那几行放在返回值里，撤销时原样放回去
    pub(super) fn tree_delete(&mut self, folder: &str) -> Result<FolderDeletion> {
        let tree = self.tree_mut()?;
        let folders: Vec<String> = tree
            .branches()
            .into_iter()
            .map(|branch| branch.path)
            .filter(|path| path == folder || path.starts_with(&format!("{folder}/")))
            .collect();
        let removed = tree.remove_branch(folder)?;
        let mut rows = Vec::new();
        for (_, node) in removed.nodes() {
            let row = match &node.item {
                Item::Note(id) => index::by_id(&self.db, id)?,
                Item::File(rel) => index::by_path(&self.db, rel)?,
                _ => None,
            };
            if let Some(row) = row.filter(|row| row.kind == "note" && !row.archived) {
                rows.push(row);
            }
        }
        let mut change = VaultChange::default();
        let mut notes = Vec::new();
        for row in rows {
            self.trash(&row, &mut change)?;
            notes.push(row.id);
        }
        self.save_tree()?;
        self.log.record("folder", folder, "deleted");
        // 删掉的笔记前端自己会拿掉；只把连带的变化（日历上的任务）告诉它
        change.notes.clear();
        self.announce(change);
        Ok(FolderDeletion {
            folder: folder.to_string(),
            notes,
            folders,
            kept: false,
            nodes: Some(removed.render()),
        })
    }

    pub(super) fn tree_undelete(&mut self, deletion: &FolderDeletion) -> Result<()> {
        for id in &deletion.notes {
            self.note_undelete(id)?;
        }
        if let Some(nodes) = &deletion.nodes {
            self.tree_mut()?.restore(&Tree::parse_fragment(nodes));
            self.save_tree()?;
        }
        self.log.record("folder", &deletion.folder, "undeleted");
        Ok(())
    }

    /* ---------------- 智能文件夹 ---------------- */

    /// 按几个条件各筛一遍（vault/query.rs），每个条件给出命中的笔记 id，置顶在前、最近改过的在前
    pub fn tree_queries(&self, queries: &[String]) -> Result<Vec<Vec<String>>> {
        let tree = self.tree_ref()?;
        let mut placed: HashMap<String, String> = HashMap::new();
        for (node, note) in self.resolve_notes(tree)? {
            if let Some(entry) = tree.get(&node) {
                placed.insert(note, tree.path_of(&entry.parent));
            }
        }
        let rows = index::notes(&self.db, false)?;
        let docs: Vec<query::Doc> = rows.iter().map(query::Doc::new).collect();
        let now = now_ms();
        Ok(queries
            .iter()
            .map(|text| {
                let query = Query::parse(text);
                rows.iter()
                    .zip(&docs)
                    .filter(|(row, doc)| query.matches(doc, placed.get(&row.id).map(String::as_str), now))
                    .map(|(row, _)| row.id.clone())
                    .collect()
            })
            .collect())
    }

    /* ---------------- 转成逻辑目录 ---------------- */

    /// 本地目录转成逻辑目录（docs §7.3）：按现在的文件夹结构生成清单，一个 .md 都不动。
    /// 之后新建的笔记平放在原来的树根（「笔记」，或者整个仓库），文件夹只在清单里
    pub fn make_logical(&mut self) -> Result<()> {
        if self.tree.is_some() {
            return Ok(());
        }
        if !self.indexed_all {
            return Err(AppError::Invalid("还在读取笔记，读完了再转".into()));
        }
        let built = self.structure()?;
        let marker_path = fsio::abs(&self.root, layout::VAULT_MARKER);
        let marker = std::fs::read_to_string(&marker_path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok());
        let marker = layout::marker_logical(marker, self.layout.journal);
        fsio::write_atomic(&fsio::abs(&self.root, tree::TREE_FILE), &built.render())?;
        fsio::write_atomic(&marker_path, &serde_json::to_string_pretty(&marker)?)?;
        self.layout = layout::Layout::load(&self.root);
        self.tree_text = built.render();
        self.tree = Some(built);
        self.tree_build = false;
        self.log.record("vault", "logical", "enabled");
        Ok(())
    }
}
