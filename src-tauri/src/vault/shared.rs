/* ============================================================
共享仓库（docs/协同编辑.md §20.5）用的进出口：share/bridge.rs 拿这些和 CRDT 对账。

- 出：哪几篇进了 / 离开了索引（touched：本机编辑器存的、别的程序改的、应用自己改的都算），
  每篇现在的元数据和正文（索引里的，刚读过磁盘）
- 进：按 CRDT 里的样子写盘（新建、改名、置顶、归档、删进回收站、正文），写完照常进索引、通知前端
- 共享以后正文只由 Rust 写（§20.1「写盘」那一行）：编辑器存盘时交来的正文不用（note_update、
  save_day、save_goal 读磁盘上的），编辑器那份经前端的 Loro 副本交给 Rust

文档在共享里的 id：笔记就是笔记的 id；某一天 `day-2026-10-21`；目标 `goal-week-2026-10-19`
（索引里是 `day:…`、`goal:…:…`，冒号不能进文件名）。
============================================================ */

use std::sync::Arc;

use super::frontmatter::{self, FrontMatter};
use super::{fsio, index, layout, title_meta, trash_rel, Vault};
use crate::domain::model::{DayDoc, VaultChange};
use crate::error::Result;
use crate::share::replica::{valid_doc_id, DocKind, DocMeta};

/// 有文档进了 / 离开了索引：叫醒共享仓库的后台任务
pub type OnTouch = Arc<dyn Fn() + Send + Sync>;

/// 这一篇（共享里的 id）的正文现在是不是归前端的 Loro 副本
pub type BodyOwner = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// 本机这一篇现在的样子
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalDoc {
    pub id: String,
    pub meta: DocMeta,
    pub body: String,
}

/// 索引里的 id → 共享里的 id（不能共享的返回 None）
pub fn share_id(index_id: &str) -> Option<String> {
    let id = if let Some(date) = index_id.strip_prefix("day:") {
        format!("day-{date}")
    } else if let Some(rest) = index_id.strip_prefix("goal:") {
        format!("goal-{}", rest.replace(':', "-"))
    } else {
        index_id.to_string()
    };
    valid_doc_id(&id).then_some(id)
}

/// 共享里的 id → 索引里的 id
pub fn index_id(share_id: &str) -> String {
    if let Some(date) = share_id.strip_prefix("day-") {
        return format!("day:{date}");
    }
    if let Some(rest) = share_id.strip_prefix("goal-") {
        if let Some((horizon, start)) = rest.split_once('-') {
            return format!("goal:{horizon}:{start}");
        }
    }
    share_id.to_string()
}

impl Vault {
    /// 共享以后（share/service.rs 打开时）：编辑器存盘不再写正文
    pub fn set_shared(&mut self, on: bool) {
        self.shared = on;
        self.touched.clear();
        self.tree_touched = false;
    }

    pub fn set_on_touch(&mut self, on_touch: Option<OnTouch>) {
        self.on_touch = on_touch;
    }

    pub fn set_body_owner(&mut self, owner: Option<BodyOwner>) {
        self.body_owner = owner;
    }

    /// 编辑器存盘时交来的正文要不要用：共享仓库里、前端的 Loro 副本正开着这一篇时不用 ——
    /// 那份正文可能落后于 Rust 已经合进来的别人的改动，正文由 Rust 写。副本没开着（共享服务刚起来、
    /// 前端还不知道这是共享仓库）的照常写，之后当成磁盘上的改动进 CRDT，一个字不丢
    pub(super) fn body_owned(&self, index_id: &str) -> bool {
        self.shared
            && share_id(index_id).is_some_and(|id| self.body_owner.as_ref().is_some_and(|owner| owner(&id)))
    }

    /// 一篇进了 / 离开了索引（index_text、forget 调）
    pub(super) fn touch(&mut self, id: &str) {
        if !self.shared {
            return;
        }
        if !self.touched.iter().any(|known| known == id) {
            self.touched.push(id.to_string());
        }
        if let Some(on_touch) = &self.on_touch {
            on_touch();
        }
    }

    /// 清单变了（save_tree、reload_tree 调）
    pub(super) fn touch_tree(&mut self) {
        if !self.shared {
            return;
        }
        self.tree_touched = true;
        if let Some(on_touch) = &self.on_touch {
            on_touch();
        }
    }

    /// 取走上次以来变了的（索引里的 id）、清单变没变
    pub fn take_touched(&mut self) -> (Vec<String>, bool) {
        (std::mem::take(&mut self.touched), std::mem::take(&mut self.tree_touched))
    }

    /// 这一篇（索引里的 id）现在的样子；不在索引里是 None
    pub fn share_local(&self, index_id: &str) -> Result<Option<LocalDoc>> {
        let Some(row) = index::by_id(&self.db, index_id)? else { return Ok(None) };
        Ok(local_of(&row))
    }

    /// 所有能共享的（建共享时一篇篇读进 CRDT）
    pub fn share_all(&self) -> Result<Vec<LocalDoc>> {
        let mut rows = index::notes(&self.db, false)?;
        rows.extend(index::notes(&self.db, true)?);
        rows.extend(index::journal(&self.db)?);
        Ok(rows.iter().filter_map(local_of).collect())
    }

    /// 属性块里没写 id 的笔记写上（共享时；树和别的设备都按 id 认）。返回写了几篇
    pub fn share_ensure_ids(&mut self) -> Result<usize> {
        let mut rows = index::notes(&self.db, false)?;
        rows.extend(index::notes(&self.db, true)?);
        let mut count = 0;
        for row in rows {
            if row.file_id.as_deref() == Some(row.id.as_str()) {
                continue;
            }
            let (_, change) = self.rewrite_note_meta(&row, None, |_| {})?;
            self.announce(change);
            count += 1;
        }
        Ok(count)
    }

    /// 索引和磁盘对齐过一遍了（后台那批读完了）：共享仓库的对账要等它，不然没读到的会当成删了
    pub fn indexed_all(&self) -> bool {
        self.indexed_all
    }

    /// 仓库标记里日程开没开（别的设备改了、还没切换过去的时候和 layout 不一样）
    pub fn marker_journal(&self) -> bool {
        layout::Layout::load(&self.root).journal
    }

    /// 别的成员开关了日程：只改仓库标记，前端照旧问一句「切换过去」（check_layout）
    pub fn share_set_journal_marker(&mut self, on: bool) -> Result<()> {
        let path = fsio::abs(&self.root, layout::VAULT_MARKER);
        let marker = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok());
        fsio::write_atomic(&path, &serde_json::to_string_pretty(&layout::marker_with_journal(marker, on))?)?;
        Ok(())
    }

    /// 回收站里有没有这一篇（删掉的笔记）
    pub fn share_trashed(&self, index_id: &str) -> bool {
        fsio::abs(&self.root, &trash_rel(index_id)).is_file()
    }

    /// 写盘之前：这一篇在磁盘上被改过、索引还没跟上（文件监听没来得及）的话先读进来 ——
    /// 改动随 touched 交给对账，免得写盘把它盖掉
    pub fn share_refresh(&mut self, share_id: &str) -> Result<()> {
        let id = index_id(share_id);
        if let Some(row) = index::by_id(&self.db, &id)? {
            let mut change = VaultChange::default();
            self.index_file(&row.rel_path, &mut change)?;
            self.announce(change);
        }
        Ok(())
    }

    /// 按 CRDT 里的样子写这一篇。和磁盘上一样的不写
    pub fn share_write(&mut self, share_id: &str, meta: &DocMeta, body: &str) -> Result<()> {
        match meta.kind {
            DocKind::Note => self.share_write_note(share_id, meta, body),
            DocKind::Day | DocKind::Goal => self.share_write_dated(share_id, meta, body),
        }
    }

    fn share_write_note(&mut self, id: &str, meta: &DocMeta, body: &str) -> Result<()> {
        let mut change = VaultChange::default();
        let row = index::by_id(&self.db, id)?.filter(|row| row.kind == "note");
        if meta.deleted {
            if let Some(row) = row {
                self.trash(&row, &mut change)?;
            }
            self.announce(change);
            return Ok(());
        }
        let row = match row {
            None if self.share_trashed(id) => {
                self.note_undelete(id)?;
                index::by_id(&self.db, id)?.filter(|row| row.kind == "note")
            }
            row => row,
        };
        // 这台设备没开日程（没有「归档」）：归档的照样放在笔记里
        let archived = meta.archived.filter(|_| self.layout.journal);
        let fill = |front: &mut FrontMatter, rel: &str| {
            front.id = Some(id.to_string());
            front.title = title_meta(rel, &meta.title);
            front.created = Some(meta.created);
            front.pinned = meta.pinned && archived.is_none();
            front.archived = archived;
            front.category = meta.category.clone();
            if archived.is_none() {
                front.archived_from = None;
            }
        };
        match row {
            None => {
                let dir = if archived.is_some() { &self.layout.archive } else { &self.layout.notes };
                let rel = fsio::unique_rel(&self.root, dir, &layout::file_stem_for_title(&meta.title), None);
                let mut front = FrontMatter::default();
                fill(&mut front, &rel);
                self.write_and_index(&rel, &frontmatter::render(&front, body), &mut change)?;
            }
            Some(row) => {
                let old = self.read(&row.rel_path)?.unwrap_or_default();
                let dir = if archived.is_some() == row.archived {
                    layout::dir_of(&row.rel_path).to_string()
                } else if archived.is_some() {
                    self.layout.archive.clone()
                } else {
                    self.layout.notes.clone()
                };
                let rel = if dir != layout::dir_of(&row.rel_path) || row.title != meta.title {
                    fsio::unique_rel(
                        &self.root,
                        &dir,
                        &layout::file_stem_for_title(&meta.title),
                        Some(&row.rel_path),
                    )
                } else {
                    row.rel_path.clone()
                };
                let (mut front, _) = frontmatter::split(&old);
                fill(&mut front, &rel);
                let text = frontmatter::render(&front, body);
                if rel != row.rel_path {
                    fsio::move_file(&self.root, &row.rel_path, &rel)?;
                    index::rename(&self.db, &row.id, &rel)?;
                    self.tree_follow(&row.rel_path, &row.id);
                    self.prune(layout::dir_of(&row.rel_path));
                }
                if text != old || rel != row.rel_path {
                    self.write_and_index(&rel, &text, &mut change)?;
                }
            }
        }
        self.announce(change);
        Ok(())
    }

    /// 某一天、某个周期的目标：位置按这台设备的摆法。没开日程的设备上不写（开了以后对账时补上）
    fn share_write_dated(&mut self, share_id: &str, meta: &DocMeta, body: &str) -> Result<()> {
        if !self.layout.journal {
            return Ok(());
        }
        let id = index_id(share_id);
        let (existing, rel) = if let Some(date) = id.strip_prefix("day:") {
            (index::day(&self.db, date)?, self.layout.day_path(date)?)
        } else if let Some((horizon, start)) = id.strip_prefix("goal:").and_then(|rest| rest.split_once(':')) {
            (index::goal(&self.db, horizon, start)?, self.layout.goal_path(horizon, start)?)
        } else {
            return Ok(());
        };
        let rel = existing.as_ref().map_or(rel, |row| row.rel_path.clone());
        let old = self.read(&rel)?.unwrap_or_default();
        let (mut front, _) = frontmatter::split(&old);
        if meta.kind == DocKind::Day {
            front.title = (!meta.title.is_empty()).then(|| meta.title.clone());
        }
        let mut change = VaultChange::default();
        if meta.deleted || (front.is_empty() && body.trim().is_empty()) {
            if let Some(row) = &existing {
                self.remove_doc(row, &mut change)?;
            }
        } else {
            let text = frontmatter::render(&front, body);
            if text != old {
                self.write_and_index(&rel, &text, &mut change)?;
            }
        }
        self.announce(change);
        Ok(())
    }

    /// 共享仓库里改某一天的标题（save_day 转过来）：正文用磁盘上的
    pub(super) fn save_day_title(&mut self, date: &str, title: &str) -> Result<DayDoc> {
        let existing = index::day(&self.db, date)?;
        let rel = match &existing {
            Some(row) => row.rel_path.clone(),
            None => self.layout.day_path(date)?,
        };
        let old = self.read(&rel)?.unwrap_or_default();
        let (mut front, body) = frontmatter::split(&old);
        front.title = (!title.is_empty()).then(|| title.to_string());
        let mut change = VaultChange::default();
        if front.is_empty() && body.trim().is_empty() {
            if let Some(row) = &existing {
                self.remove_doc(row, &mut change)?;
                change = change.without(row);
            }
        } else {
            let text = frontmatter::render(&front, &body);
            if text != old {
                let saved = self.write_and_index(&rel, &text, &mut change)?;
                change = change.without(&saved);
            }
        }
        self.announce(change);
        self.day(date, false)
    }

    /// 逻辑目录的清单（理顺过的，和 .odea/tree 一样）
    pub fn share_tree_text(&self) -> Option<String> {
        self.tree.as_ref().map(|tree| tree.render())
    }

    /// 别人改了清单：写下去、重读（照旧理顺），通知前端
    pub fn share_set_tree(&mut self, text: &str) -> Result<()> {
        if self.tree.is_none() {
            return Ok(());
        }
        fsio::write_atomic(&fsio::abs(&self.root, super::tree::TREE_FILE), text)?;
        let changed = self.reload_tree();
        // 自己写的不算本机改了清单（不然又发回去）
        self.tree_touched = false;
        if changed {
            self.announce(VaultChange {
                folders: true,
                ..VaultChange::default()
            });
        }
        Ok(())
    }
}

fn local_of(row: &index::DocRow) -> Option<LocalDoc> {
    let id = share_id(&row.id)?;
    let kind = match row.kind {
        "day" => DocKind::Day,
        "goal" => DocKind::Goal,
        _ => DocKind::Note,
    };
    let meta = DocMeta {
        kind,
        title: if kind == DocKind::Goal { String::new() } else { row.title.clone() },
        pinned: row.pinned,
        archived: if row.archived { row.archived_at } else { None },
        category: if row.archived { row.category.clone() } else { None },
        // 某一天、目标没有「建的时间」（属性块里不写，按修改时间算的每台设备不一样）
        created: if kind == DocKind::Note { row.created_at } else { 0 },
        deleted: false,
    };
    Some(LocalDoc {
        id,
        meta,
        body: row.content_md.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_translate_between_the_index_and_the_share() {
        assert_eq!(share_id("day:2026-10-21").as_deref(), Some("day-2026-10-21"));
        assert_eq!(share_id("goal:week:2026-10-19").as_deref(), Some("goal-week-2026-10-19"));
        assert_eq!(index_id("goal-week-2026-10-19"), "goal:week:2026-10-19");
        assert_eq!(index_id("day-2026-10-21"), "day:2026-10-21");
        let note = "0199f3c2-1234-7abc-8def-001122334455";
        assert_eq!(share_id(note).as_deref(), Some(note));
        assert_eq!(index_id(note), note);
        assert_eq!(share_id("有 空格"), None);
    }
}
