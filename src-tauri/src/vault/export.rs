/* ============================================================
逻辑目录导出成真实文件夹（docs/仓库与启动器.md §7.5 第 7 条「退路」）：离开 Odea 时结构不丢。

- 树上的文件夹建成真的文件夹，树上的笔记拷进它所在的那一个；没放进树里的拷进「未整理」
- 别的东西（附件、图片、日记、目标、归档里的笔记）按原来的位置拷过去。正文里的相对链接改成从新
  位置出发、指向拷过去的同一个文件（folders::relink），别的编辑器打开照样看得到图
- 以点开头的（.odea、.git、.obsidian）不拷；智能文件夹是筛选，不导出
- 原来的仓库一个字不动
============================================================ */

use std::collections::{HashMap, HashSet};
use std::path::Path;

use super::tree::Tree;
use super::{folders, frontmatter, fsio, index, layout, Vault};
use crate::error::{AppError, Result};

/// 「未整理」导出成的文件夹名（和树根上的文件夹重名就加序号）
const UNSORTED_DIR: &str = "未整理";

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Exported {
    /// 按树摆好的笔记
    pub notes: usize,
    /// 按原位置拷过去的其它文件
    pub files: usize,
}

impl Vault {
    /// 按树的结构把整个仓库拷到 dest（一个新的空文件夹）
    pub fn export_tree(&self, dest: &Path) -> Result<Exported> {
        let tree: &Tree = self.tree.as_ref().ok_or_else(|| AppError::Invalid("这个仓库不是逻辑目录".into()))?;
        let mut folder_of: HashMap<String, String> = HashMap::new();
        for (node, note) in self.resolve_notes(tree)? {
            if let Some(entry) = tree.get(&node) {
                folder_of.insert(note, tree.path_of(&entry.parent));
            }
        }
        let folder_paths = tree.folder_paths();
        let taken: HashSet<String> =
            folder_paths.iter().filter(|path| !path.contains('/')).map(|path| path.to_lowercase()).collect();
        let unsorted = (1..)
            .map(|n| if n == 1 { UNSORTED_DIR.to_string() } else { format!("{UNSORTED_DIR} {n}") })
            .find(|name| !taken.contains(&name.to_lowercase()))
            .expect("总有一个没被占的");

        std::fs::create_dir_all(dest)?;
        for path in &folder_paths {
            std::fs::create_dir_all(fsio::abs(dest, path))?;
        }
        let mut report = Exported::default();
        let mut moved: HashSet<String> = HashSet::new();
        for row in index::note_summaries(&self.db, false)? {
            let folder = folder_of.get(&row.id).cloned().unwrap_or_else(|| unsorted.clone());
            let target = fsio::unique_rel(dest, &folder, layout::stem_of(&row.rel_path), None);
            let Some(text) = self.read(&row.rel_path)? else { continue };
            let (meta, body) = frontmatter::split(&text);
            let body = folders::relink(&body, layout::dir_of(&row.rel_path), layout::dir_of(&target), |rel| {
                fsio::abs(&self.root, rel).exists()
            });
            fsio::write_atomic(&fsio::abs(dest, &target), &frontmatter::render(&meta, &body))?;
            moved.insert(row.rel_path);
            report.notes += 1;
        }

        // 其余的照原来的位置拷：附件、图片、日记、目标、归档
        let mut stack = vec![String::new()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(fsio::abs(&self.root, &dir)) else { continue };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if fsio::is_hidden_name(&name) {
                    continue;
                }
                let rel = layout::join(&dir, &name);
                let Ok(kind) = entry.file_type() else { continue };
                if kind.is_dir() {
                    stack.push(rel);
                } else if kind.is_file() && !moved.contains(&rel) {
                    let target = free_file(dest, &rel);
                    if let Some(parent) = target.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::fs::copy(entry.path(), target)?;
                    report.files += 1;
                }
            }
        }
        Ok(report)
    }
}

/// dest 里给 rel 找一个没被占的位置：撞上了（树上的文件夹和原来的文件夹同名、里面又有同名的文件）
/// 加「 2」「 3」
fn free_file(dest: &Path, rel: &str) -> std::path::PathBuf {
    let first = fsio::abs(dest, rel);
    if !first.exists() {
        return first;
    }
    let dir = layout::dir_of(rel);
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (name, String::new()),
    };
    (2..)
        .map(|n| fsio::abs(dest, &layout::join(dir, &format!("{stem} {n}{ext}"))))
        .find(|candidate| !candidate.exists())
        .expect("总有一个没被占的")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_the_tree_as_real_folders_with_working_links() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("仓库");
        super::super::seed::write(&root, "").unwrap();
        fsio::write_atomic(
            &fsio::abs(&root, layout::VAULT_MARKER),
            &serde_json::to_string(&layout::new_marker(true, true, 0)).unwrap(),
        )
        .unwrap();
        std::fs::create_dir_all(root.join("附件")).unwrap();
        std::fs::write(root.join("附件/图.png"), b"png").unwrap();
        let mut vault = Vault::open_in_memory(&root);
        vault.folder_create("", "交易").unwrap();
        vault.folder_create("交易", "学习").unwrap();
        let id = vault.note_create_in("交易/学习", "流程", "![图](附件/图.png)").unwrap();
        vault.note_create_in(super::super::tree::UNSORTED, "随手", "没放进树里").unwrap();
        vault.save_day("2026-10-20", "", "今天").unwrap();
        let before = std::fs::read_to_string(root.join("流程.md")).unwrap();

        let out = dir.path().join("导出");
        let report = vault.export_tree(&out).unwrap();
        assert_eq!(report.notes, 4, "两篇指南、流程、随手");
        let exported = std::fs::read_to_string(out.join("交易/学习/流程.md")).unwrap();
        assert!(exported.contains("![图](../../附件/图.png)"), "{exported}");
        assert!(exported.contains(&id), "属性块原样带着");
        assert!(out.join("未整理/随手.md").is_file());
        assert!(out.join("欢迎使用 Odea.md").is_file());
        assert_eq!(std::fs::read(out.join("附件/图.png")).unwrap(), b"png");
        assert!(out.join("日记/2026/2026-10-20.md").is_file());
        assert!(!out.join(".odea").exists(), "应用自己的东西不拷");
        assert!(!out.join("流程.md").exists(), "树上的笔记不再按原位置拷一份");
        assert_eq!(std::fs::read_to_string(root.join("流程.md")).unwrap(), before, "原来的不动");
    }
}
