/* ============================================================
导入（docs/仓库与启动器.md §7.6）：把仓库外面的一个文件夹复制进来。挂载别处的文件夹第一期不做
（索引、监听要跨好几个根，仓库外的文件同步管不到），所以是复制，原来的一个字节都不动。

- 结构照原样：文件夹、笔记、图片按原来的相对位置拷进来，正文里的相对链接（`../图/a.png`）
  不用改就还指着同一个文件。以点开头的（.obsidian、.git、.odea）不拷，符号链接不跟
- 放在哪：本地目录放进树上当前的文件夹（树就是真的文件夹）；逻辑目录放在新建笔记平放的地方
  （layout.notes），树上在当前的文件夹里建一个同名文件夹，子文件夹、笔记照原来的结构摆好
- 名字撞了加序号（「读书笔记 2」），和新建文件夹一样
- 拷完整个仓库增量扫一遍：新的笔记进索引，属性块里没写 id 的在清单里按路径引用（tree.rs），
  一个文件都不改
============================================================ */

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use super::index::{self, DocRow};
use super::tree::{self, Item};
use super::{folders, fsio, layout, Vault};
use crate::domain::model::ImportReport;
use crate::error::{AppError, Result};

/// 拷过来的一个目录：仓库里的路径、相对源文件夹的路径
struct Copied {
    dirs: Vec<String>,
    notes: u32,
    files: u32,
}

impl Vault {
    /// 把 source 复制进来，放在树上的 folder 里（逻辑目录、本地目录的放法见上）。返回树上新文件夹的路径和拷了多少
    pub fn import_folder(&mut self, source: &Path, folder: &str) -> Result<ImportReport> {
        // 未整理、智能文件夹里放不了文件夹：放在根上
        let folder = match &self.tree {
            Some(tree) if folder == tree::UNSORTED || tree.query_at(folder).is_some() => "",
            _ => folder,
        };
        let source = source
            .canonicalize()
            .map_err(|_| AppError::NotFound(format!("找不到文件夹 {}", source.display())))?;
        let root = self.root.canonicalize().unwrap_or_else(|_| self.root.clone());
        if source.starts_with(&root) {
            return Err(AppError::Invalid("这个文件夹已经在仓库里了".into()));
        }
        if root.starts_with(&source) {
            return Err(AppError::Invalid("不能导入包着这个仓库的文件夹".into()));
        }
        if !source.is_dir() {
            return Err(AppError::Invalid(format!("{} 不是文件夹", source.display())));
        }
        let name = source
            .file_name()
            .and_then(|name| layout::folder_name(&name.to_string_lossy()))
            .unwrap_or_else(|| "导入".into());
        // 逻辑目录：文件平放在新建笔记的地方，树上另摆；本地目录：就是树上那个文件夹
        let base = if self.tree.is_some() {
            self.tree_check_parent(folder)?;
            self.layout.notes.clone()
        } else {
            let dir = self.layout.folder_dir(folder)?;
            if !folder.is_empty() && !fsio::abs(&self.root, &dir).is_dir() {
                return Err(AppError::NotFound(format!("文件夹「{folder}」不在了")));
            }
            dir
        };
        let dest = folders::unique_dir(&self.root, &base, &name, None);
        let copied = copy_into(&source, &fsio::abs(&self.root, &dest))?;
        let mut change = self.rescan()?;
        change.folders = true;
        let tree_folder = if self.tree.is_some() {
            self.place_imported(&dest, &copied, folder)?
        } else {
            self.layout.folder_of_dir(&dest).unwrap_or_default().to_string()
        };
        self.log.record_with("folder", &dest, "imported", Some(&source.to_string_lossy()));
        self.announce(change);
        Ok(ImportReport {
            folder: tree_folder,
            notes: copied.notes,
            files: copied.files,
        })
    }

    /// 逻辑目录：拷进来的那些按原来的结构摆到树上 folder 底下。返回树上新文件夹的路径
    fn place_imported(&mut self, dest: &str, copied: &Copied, folder: &str) -> Result<String> {
        let name = dest.rsplit('/').next().unwrap_or(dest).to_string();
        let rows: Vec<DocRow> = index::notes(&self.db, false)?
            .into_iter()
            .filter(|row| row.rel_path.starts_with(&format!("{dest}/")))
            .collect();
        let tree = self.tree.as_mut().ok_or_else(|| AppError::Invalid("这个仓库不是逻辑目录".into()))?;
        let top = tree.add_folder(folder, &name)?;
        // 树上只建放着笔记（多深都算）的文件夹：只有图片的「图」「附件」在逻辑目录的树上是空的
        let mut needed: HashSet<String> = HashSet::new();
        for row in &rows {
            let mut dir = layout::dir_of(&row.rel_path[dest.len() + 1..]);
            while !dir.is_empty() && needed.insert(dir.to_string()) {
                dir = layout::dir_of(dir);
            }
        }
        // 源文件夹里的子目录（相对 dest）→ 树上的路径。父在子前；新建的文件夹排在那一层最前面，
        // 所以同一层倒着建，建完正好按名字排
        let mut paths: HashMap<String, String> = HashMap::from([(String::new(), top.clone())]);
        let mut dirs: Vec<&String> = copied.dirs.iter().filter(|dir| needed.contains(*dir)).collect();
        dirs.sort_by(|a, b| a.matches('/').count().cmp(&b.matches('/').count()).then_with(|| b.cmp(a)));
        for dir in dirs {
            let (parent, leaf) = dir.rsplit_once('/').unwrap_or(("", dir.as_str()));
            let Some(parent) = paths.get(parent).cloned() else { continue };
            let path = tree.add_folder(&parent, leaf)?;
            paths.insert(dir.clone(), path);
        }
        // 笔记按名字排好、一篇接一篇放（place 默认放在最前面：接在上一篇后面才是这个顺序）
        let mut rows = rows;
        rows.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
        let mut last: HashMap<String, String> = HashMap::new();
        for row in rows {
            let inner = layout::dir_of(&row.rel_path[dest.len() + 1..]).to_string();
            let Some(parent) = paths.get(&inner).cloned() else { continue };
            let item = if row.file_id.as_deref() == Some(row.id.as_str()) {
                Item::Note(row.id.clone())
            } else {
                Item::File(row.rel_path.clone())
            };
            let at = tree.find_note(&row.id, &row.rel_path);
            tree.place(at, item, Some(&parent), last.get(&parent).map(String::as_str))?;
            if let Some(node) = tree.find_note(&row.id, &row.rel_path) {
                last.insert(parent, node);
            }
        }
        self.save_tree()?;
        Ok(top)
    }
}

/// 把 from 整个拷到 to（to 还不在）：以点开头的、符号链接不拷。返回拷了哪些子目录（相对 to）、几篇笔记、几个别的文件
fn copy_into(from: &Path, to: &Path) -> Result<Copied> {
    let mut copied = Copied { dirs: Vec::new(), notes: 0, files: 0 };
    let mut stack: Vec<(PathBuf, PathBuf, String)> = vec![(from.to_path_buf(), to.to_path_buf(), String::new())];
    while let Some((src, dst, rel)) = stack.pop() {
        std::fs::create_dir_all(&dst)?;
        for entry in std::fs::read_dir(&src)?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if fsio::is_hidden_name(&name) {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                let inner = layout::join(&rel, &name);
                copied.dirs.push(inner.clone());
                stack.push((entry.path(), dst.join(&name), inner));
            } else if kind.is_file() {
                std::fs::copy(entry.path(), dst.join(&name))?;
                if fsio::is_markdown(&name) {
                    copied.notes += 1;
                } else {
                    copied.files += 1;
                }
            }
        }
    }
    Ok(copied)
}
