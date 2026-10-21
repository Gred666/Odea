/* ============================================================
文件树上的文件夹 = 树根下面的子目录。树根是「笔记」（Odea 建的仓库），或者整个仓库
（没开日程的，比如打开的 Obsidian 库），见 layout::Layout。

- 文件夹在磁盘上就是目录，资源管理器、网盘、别的编辑器看到的是同一套结构；
  前端用的路径相对树根（`工作/周报`），落盘时由 Layout::folder_dir 拼成
  `笔记/工作/周报`。
- 日程开着时日记、目标、归档不在树上（从窄栏进）
- 空的文件夹也是文件夹：挪走 / 删掉最后一篇时不清掉它（Vault::prune）。
- 笔记换了文件夹，正文里相对路径的图片、链接跟着改（relink），指向的还是同一个文件。
============================================================ */

use std::fs;
use std::path::Path;

use super::{fsio, layout};
use crate::domain::model::TreeFile;

/// 树根下面所有的子文件夹（相对树根的路径），跳过隐藏的和日程那几个。按路径排序。
pub fn list(root: &Path, tree: &layout::Layout) -> Vec<String> {
    scan(root, tree, false).0
}

/// 文件树上列出来的文件：图片、PDF（Obsidian 也列）。别的文件（压缩包、表格）不列
pub fn tree_file_kind(name: &str) -> Option<&'static str> {
    let ext = layout::stem_and_ext(name).1.to_ascii_lowercase();
    if super::IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        Some("image")
    } else if ext == "pdf" {
        Some("pdf")
    } else {
        None
    }
}

/// 一遍走完树根：文件夹（同 list），want_files 时连同树上要列的图片、PDF（按路径排序）
pub fn scan(root: &Path, tree: &layout::Layout, want_files: bool) -> (Vec<String>, Vec<TreeFile>) {
    let hidden = tree.hidden_dirs();
    let mut folders = Vec::new();
    let mut files = Vec::new();
    let mut stack = vec![(fsio::abs(root, &tree.notes), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else { continue };
            if fsio::is_hidden_name(&name) {
                continue;
            }
            let path = layout::join(&rel, &name);
            if kind.is_dir() {
                if hidden.contains(&layout::join(&tree.notes, &path).as_str()) {
                    continue;
                }
                stack.push((entry.path(), path.clone()));
                folders.push(path);
            } else if want_files && kind.is_file() {
                let Some(file_kind) = tree_file_kind(&name) else { continue };
                let meta = entry.metadata().ok();
                files.push(TreeFile {
                    rel_path: layout::join(&tree.notes, &path),
                    folder: rel.clone(),
                    name,
                    kind: file_kind.into(),
                    size: meta.as_ref().map_or(0.0, |meta| meta.len() as f64),
                    updated_at: meta.map_or(0, |meta| fsio::mtime_ms(&meta)) as f64,
                });
            }
        }
    }
    folders.sort();
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    (folders, files)
}

/// 在 parent_dir 下给文件夹找一个没被占用的名字：`工作`、`工作 2`、`工作 3`…
/// `keep` 是改名时它自己现在的目录（只改大小写时撞上自己不算占用）。
pub fn unique_dir(root: &Path, parent_dir: &str, name: &str, keep: Option<&str>) -> String {
    let keep = keep.map(str::to_lowercase);
    for n in 1.. {
        let candidate = if n == 1 {
            name.to_string()
        } else {
            format!("{name} {n}")
        };
        let rel = layout::join(parent_dir, &candidate);
        if keep.as_deref() == Some(rel.to_lowercase().as_str()) || !fsio::abs(root, &rel).exists() {
            return rel;
        }
    }
    unreachable!()
}

/// 自下而上删掉空目录。目录里还有别的文件（图片、PDF）就留着它和它的上层。
/// 返回 dir 本身是不是删掉了。
pub fn remove_empty_tree(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    let mut empty = true;
    for entry in entries.flatten() {
        let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
        if !(is_dir && remove_empty_tree(&entry.path())) {
            empty = false;
        }
    }
    empty && fs::remove_dir(dir).is_ok()
}

/* ---------------- 换文件夹时改写相对链接 ---------------- */

/// 正文里的相对路径以文档所在的文件夹为基准（和 Typora、Obsidian、VS Code 一样）。
/// 笔记从 from_dir 挪到 to_dir 之后，把 `](…)`、`[引用]: …`、`src="…"` 里的相对路径
/// 改成从新位置出发、指向同一个文件的写法。
///
/// 只改在仓库里真找得到目标的（`exists` 收仓库内的相对路径）：网址、锚点、绝对路径、
/// 找不到的一律原样；围栏代码块和行内代码里的不碰。
pub fn relink(body: &str, from_dir: &str, to_dir: &str, exists: impl Fn(&str) -> bool) -> String {
    if from_dir == to_dir {
        return body.to_string();
    }
    let mut out = String::with_capacity(body.len());
    let mut fence: Option<(char, usize)> = None;
    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let marker = trimmed.chars().next().filter(|c| *c == '`' || *c == '~');
        if let Some(c) = marker {
            let run = trimmed.chars().take_while(|x| *x == c).count();
            if run >= 3 {
                match fence {
                    None => fence = Some((c, run)),
                    Some((open, len))
                        if open == c && run >= len && trimmed[run..].trim().is_empty() =>
                    {
                        fence = None
                    }
                    _ => {}
                }
                out.push_str(line);
                continue;
            }
        }
        if fence.is_some() {
            out.push_str(line);
        } else {
            out.push_str(&relink_line(line, from_dir, to_dir, &exists));
        }
    }
    out
}

fn relink_line(line: &str, from_dir: &str, to_dir: &str, exists: &impl Fn(&str) -> bool) -> String {
    let code = code_spans(line);
    let in_code = |at: usize| code.iter().any(|(start, end)| at >= *start && at < *end);
    let mut targets: Vec<(usize, usize)> = Vec::new();

    // [文字](目标 "标题") 和 ![图](目标)
    let mut from = 0;
    while let Some(found) = line[from..].find("](") {
        let start = from + found;
        from = start + 2;
        if in_code(start) {
            continue;
        }
        if let Some(range) = target_after(line, start + 2, ')') {
            targets.push(range);
        }
    }
    // [引用]: 目标（行首最多三个空格；脚注 [^1]: 不是）
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent <= 3 && line[indent..].starts_with('[') && !line[indent..].starts_with("[^") {
        if let Some(close) = line[indent..].find("]:") {
            if let Some(range) = target_after(line, indent + close + 2, ' ') {
                targets.push(range);
            }
        }
    }
    // <img src="目标">
    for quote in ['"', '\''] {
        let needle = format!("src={quote}");
        let mut from = 0;
        while let Some(found) = line[from..].find(&needle) {
            let start = from + found + needle.len();
            from = start;
            if in_code(start) {
                continue;
            }
            if let Some(len) = line[start..].find(quote) {
                targets.push((start, start + len));
            }
        }
    }

    targets.sort_unstable();
    targets.dedup();
    let mut out = String::with_capacity(line.len());
    let mut copied = 0;
    for (start, end) in targets {
        if start < copied {
            continue;
        }
        if let Some(moved) = moved_target(&line[start..end], from_dir, to_dir, exists) {
            out.push_str(&line[copied..start]);
            out.push_str(&moved);
            copied = end;
        }
    }
    out.push_str(&line[copied..]);
    out
}

/// 从 at 开始的链接目标：跳过空白；`<…>` 包着的到 `>`，否则到空白或 stop 为止
fn target_after(line: &str, at: usize, stop: char) -> Option<(usize, usize)> {
    let rest = &line[at..];
    let start = at + (rest.len() - rest.trim_start().len());
    let rest = &line[start..];
    if let Some(inner) = rest.strip_prefix('<') {
        let len = inner.find('>')?;
        return Some((start + 1, start + 1 + len));
    }
    let len = rest
        .find(|c: char| c.is_whitespace() || c == stop)
        .unwrap_or(rest.len());
    (len > 0).then_some((start, start + len))
}

/// 行内代码的字节范围（反引号串配对，和 CommonMark 一样按长度配）
fn code_spans(line: &str) -> Vec<(usize, usize)> {
    let bytes = line.as_bytes();
    let mut spans = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'`' {
            i += 1;
            continue;
        }
        let open = i;
        while i < bytes.len() && bytes[i] == b'`' {
            i += 1;
        }
        let run = i - open;
        let mut j = i;
        let mut closed = None;
        while j < bytes.len() {
            if bytes[j] == b'`' {
                let start = j;
                while j < bytes.len() && bytes[j] == b'`' {
                    j += 1;
                }
                if j - start == run {
                    closed = Some(j);
                    break;
                }
            } else {
                j += 1;
            }
        }
        if let Some(end) = closed {
            spans.push((open, end));
            i = end;
        }
    }
    spans
}

/// 换个位置之后同一个目标该怎么写；不需要改（不是相对路径、仓库里找不到）时返回 None
fn moved_target(
    target: &str,
    from_dir: &str,
    to_dir: &str,
    exists: &impl Fn(&str) -> bool,
) -> Option<String> {
    let cut = target.find(['#', '?']).unwrap_or(target.len());
    let (path, suffix) = target.split_at(cut);
    let first = path.split('/').next().unwrap_or("");
    let not_relative =
        path.is_empty() || path.starts_with('/') || path.starts_with('\\') || first.contains(':');
    if not_relative {
        return None;
    }
    let resolved = resolve(from_dir, path)?;
    if !exists(&resolved) {
        return None;
    }
    let moved = relative(to_dir, &resolved);
    (moved != path).then(|| format!("{moved}{suffix}"))
}

/// dir 下的相对路径 → 仓库里的相对路径（消掉 `.` 和 `..`；退到仓库外面返回 None）
fn resolve(dir: &str, path: &str) -> Option<String> {
    let mut parts: Vec<&str> = dir.split('/').filter(|part| !part.is_empty()).collect();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part => parts.push(part),
        }
    }
    Some(parts.join("/"))
}

/// 从 dir 出发指向仓库里 target 的相对路径
fn relative(dir: &str, target: &str) -> String {
    let from: Vec<&str> = dir.split('/').filter(|part| !part.is_empty()).collect();
    let to: Vec<&str> = target.split('/').filter(|part| !part.is_empty()).collect();
    let common = from
        .iter()
        .zip(to.iter().take(to.len().saturating_sub(1)))
        .take_while(|(a, b)| a == b)
        .count();
    let mut parts = vec![".."; from.len() - common];
    parts.extend(&to[common..]);
    parts.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn existing(rel: &str) -> bool {
        matches!(
            rel,
            "附件/图.png" | "附件/表 格.pdf" | "笔记/工作/另一篇.md"
        )
    }

    #[test]
    fn relinks_images_links_and_references_that_point_into_the_vault() {
        let body = "![图](../附件/图.png)\n\
                    [文件](<../附件/表 格.pdf> \"标题\")\n\
                    [另一篇](工作/另一篇.md#小节)\n\
                    [ref]: ../附件/图.png\n\
                    <img src=\"../附件/图.png\" width=\"300\">\n";
        let moved = relink(body, "笔记", "笔记/工作/周报", existing);
        assert_eq!(
            moved,
            "![图](../../../附件/图.png)\n\
             [文件](<../../../附件/表 格.pdf> \"标题\")\n\
             [另一篇](../另一篇.md#小节)\n\
             [ref]: ../../../附件/图.png\n\
             <img src=\"../../../附件/图.png\" width=\"300\">\n"
        );
        // 挪回去还是原样
        assert_eq!(relink(&moved, "笔记/工作/周报", "笔记", existing), body);
    }

    #[test]
    fn leaves_urls_missing_files_and_code_alone() {
        let body =
            "[网](https://example.com) ![绝对](C:/a.png) [锚](#小节) [没有](../附件/不存在.png)\n\
                    `![图](../附件/图.png)` 行内代码\n\
                    ```md\n\
                    ![图](../附件/图.png)\n\
                    ```\n\
                    [^1]: ../附件/图.png\n";
        assert_eq!(relink(body, "笔记", "笔记/工作", existing), body);
    }

    #[test]
    fn computes_relative_paths() {
        assert_eq!(relative("笔记/工作", "附件/a.png"), "../../附件/a.png");
        assert_eq!(relative("笔记", "笔记/工作/a.md"), "工作/a.md");
        assert_eq!(relative("笔记/工作/周报", "笔记/工作/a.md"), "../a.md");
        assert_eq!(resolve("笔记", "../../a.png"), None);
    }

    #[test]
    fn lists_folders_and_finds_free_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for rel in ["笔记/工作/周报", "笔记/读书", "笔记/.obsidian", "日记/2026"] {
            fs::create_dir_all(fsio::abs(root, rel)).unwrap();
        }
        fsio::write_atomic(&fsio::abs(root, "笔记/工作.md"), "一篇叫工作的笔记").unwrap();
        assert_eq!(list(root, &layout::Layout::odea()), vec!["工作", "工作/周报", "读书"]);
        // 整个仓库是树根（没开日程）：日记也是一个普通文件夹
        let plain = layout::Layout { journal: false, notes: String::new(), ..layout::Layout::odea() };
        assert_eq!(list(root, &plain), vec!["日记", "日记/2026", "笔记", "笔记/工作", "笔记/工作/周报", "笔记/读书"]);
        // 开了日程、树根是整个仓库：日记不在树上
        let journal = layout::Layout { notes: String::new(), ..layout::Layout::odea() };
        assert_eq!(list(root, &journal), vec!["笔记", "笔记/工作", "笔记/工作/周报", "笔记/读书"]);
        assert_eq!(unique_dir(root, "笔记", "工作", None), "笔记/工作 2");
        assert_eq!(
            unique_dir(root, "笔记", "工作", Some("笔记/工作")),
            "笔记/工作"
        );
        assert_eq!(unique_dir(root, "笔记", "生活", None), "笔记/生活");
    }

    #[test]
    fn removes_empty_trees_but_keeps_folders_with_other_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(fsio::abs(root, "笔记/工作/周报/空")).unwrap();
        fs::create_dir_all(fsio::abs(root, "笔记/读书/图")).unwrap();
        fs::write(fsio::abs(root, "笔记/读书/图/封面.png"), b"png").unwrap();
        assert!(remove_empty_tree(&fsio::abs(root, "笔记/工作")));
        assert!(!fsio::abs(root, "笔记/工作").exists());
        assert!(!remove_empty_tree(&fsio::abs(root, "笔记/读书")));
        assert!(fsio::abs(root, "笔记/读书/图/封面.png").exists());
    }
}
