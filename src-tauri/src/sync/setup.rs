/* ============================================================
开启同步（技术方案 §5.9.7）用到的几件事。不依赖 tauri。

- 第一台设备（云端仓库是空的）：在现在的仓库上接上云端（connect_here），
  同步线程第一轮把这里的都推上去
- 第二台设备（云端已经有东西）：不在现在的仓库上硬合 —— 新装的应用放过示例内容，
  合进去会被推到云端。clone 到旁边一个新文件夹（clone_target），再走换仓库的流程；
  用户要的话，把原来仓库里的东西也拷进去（bring_local），下一轮同步推上去
- 仓库在网盘同步的文件夹里不让开（cloud_drive_of）：网盘来回拷 .git/ 迟早把它弄坏
============================================================ */

use std::path::{Path, PathBuf};

use super::engine::{AUTOSYNC_KEY, LOGIN_KEY, PROVIDER_KEY};
use super::provider::Provider;
use super::repo::{SyncError, SyncRepo, SyncResult};
use crate::old_name;
use crate::vault::layout;

/// 这个文件夹在哪家网盘的同步目录里；不在返回 None
pub fn cloud_drive_of(path: &Path) -> Option<&'static str> {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    // OneDrive 的位置在环境变量里（个人版 / 商业版各一个）
    for key in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        if let Some(root) = std::env::var_os(key) {
            let root = PathBuf::from(root);
            let root = root.canonicalize().unwrap_or(root);
            if canonical.starts_with(&root) {
                return Some("OneDrive");
            }
        }
    }
    cloud_drive_by_name(&canonical)
}

/// 只看路径里的目录名（各家网盘默认的同步目录）
fn cloud_drive_by_name(path: &Path) -> Option<&'static str> {
    const KNOWN: [(&str, &str); 10] = [
        ("onedrive", "OneDrive"),
        ("dropbox", "Dropbox"),
        ("icloud drive", "iCloud Drive"),
        ("iclouddrive", "iCloud Drive"),
        ("mobile documents", "iCloud Drive"),
        ("google drive", "Google Drive"),
        ("nutstore", "坚果云"),
        ("我的坚果云", "坚果云"),
        ("baidunetdisk", "百度网盘"),
        ("百度网盘", "百度网盘"),
    ];
    path.components().find_map(|component| {
        let name = component.as_os_str().to_string_lossy().to_lowercase();
        KNOWN
            .iter()
            .find(|(prefix, _)| name.starts_with(prefix))
            .map(|(_, label)| *label)
    })
}

/// 第二台设备 clone 到哪：现在仓库旁边的「Odea (同步)」，有了就「Odea (同步) 2」……
pub fn clone_target(current_root: &Path) -> PathBuf {
    let parent = current_root.parent().unwrap_or(current_root);
    let name = current_root
        .file_name()
        .map_or_else(|| "Odea".to_string(), |name| name.to_string_lossy().into_owned());
    (1..)
        .map(|n| {
            if n == 1 {
                parent.join(format!("{name} (同步)"))
            } else {
                parent.join(format!("{name} (同步) {n}"))
            }
        })
        .find(|candidate| !candidate.exists())
        .expect("总有一个名字没被占用")
}

/// 在现在的仓库上接上云端（第一台设备，或者以前同步过、断开后重新连上）。
/// 已经连着别的云端时不动它，报错让用户先断开
pub fn connect_here(root: &Path, provider: Provider, login: &str, clone_url: &str) -> SyncResult<()> {
    let repo = match SyncRepo::open(root)? {
        Some(repo) => {
            if let Some(existing) = repo.remote_url().filter(|url| !same_remote(url, clone_url)) {
                return Err(SyncError::Local(format!(
                    "这个笔记文件夹已经是一个 git 仓库，连着另一个远端 {existing}。先在那边断开，或者换一个仓库"
                )));
            }
            repo.prepare()?;
            repo
        }
        None => SyncRepo::init(root)?,
    };
    repo.set_remote_url(clone_url)?;
    mark(&repo, provider, login)
}

/// 记下这个仓库用哪个账号同步，并开启自动同步
pub fn mark(repo: &SyncRepo, provider: Provider, login: &str) -> SyncResult<()> {
    repo.config_set(PROVIDER_KEY, provider.key())?;
    repo.config_set(LOGIN_KEY, login)?;
    repo.config_set(AUTOSYNC_KEY, "true")
}

/// 断开同步：不再自动同步，忘掉用哪个账号。.git 留着，历史都在，能再连上
pub fn disconnect(root: &Path) -> SyncResult<()> {
    let Some(repo) = SyncRepo::open(root)? else {
        return Ok(());
    };
    for key in [AUTOSYNC_KEY, PROVIDER_KEY, LOGIN_KEY] {
        repo.config_remove(key)?;
    }
    Ok(())
}

/// 同一个远端吗：大小写、结尾的 `/` 和 `.git` 不算
pub fn same_remote(a: &str, b: &str) -> bool {
    let norm = |url: &str| {
        url.trim()
            .trim_end_matches('/')
            .trim_end_matches(".git")
            .to_lowercase()
    };
    norm(a) == norm(b)
}

/// 把原来仓库里的东西拷进 clone 下来的新仓库（用户选了「也合并进来」）。
/// 根上的 .git、.odea（仓库标记、回收站、行为日志；改名前叫 .ontheway）、.gitignore / .gitattributes 不拷 ——
/// 新仓库有自己的；写到一半的临时文件不拷。同一个位置已经有了：内容一样就跳过，
/// 不一样就起个新名字「名字 (本机).扩展名」。返回拷了几个文件
pub fn bring_local(from: &Path, to: &Path) -> std::io::Result<usize> {
    const ROOT_SKIP: [&str; 5] = [".git", layout::APP_DIR, old_name::VAULT_DIR, ".gitignore", ".gitattributes"];
    let mut copied = 0;
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        for entry in std::fs::read_dir(from.join(&rel))?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let child = rel.join(&name);
            let skip = (rel.as_os_str().is_empty() && ROOT_SKIP.contains(&name.as_str()))
                || (name.starts_with('.') && name.ends_with(".tmp"));
            if skip {
                continue;
            }
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                std::fs::create_dir_all(to.join(&child))?;
                stack.push(child);
            } else if file_type.is_file() {
                let bytes = std::fs::read(entry.path())?;
                let target = to.join(&child);
                match std::fs::read(&target) {
                    Ok(existing) if existing == bytes => continue,
                    Ok(_) => std::fs::write(local_name(&target), &bytes)?,
                    Err(_) => std::fs::write(&target, &bytes)?,
                }
                copied += 1;
            }
        }
    }
    Ok(copied)
}

/// 「笔记/周报.md」被占了：「笔记/周报 (本机).md」，再占了「周报 (本机 2).md」
fn local_name(target: &Path) -> PathBuf {
    let dir = target.parent().unwrap_or(Path::new(""));
    let file = target.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let (stem, ext) = match file.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
        _ => (file.clone(), String::new()),
    };
    (1..)
        .map(|n| {
            let label = if n == 1 { "本机".to_string() } else { format!("本机 {n}") };
            dir.join(format!("{stem} ({label}){ext}"))
        })
        .find(|candidate| !candidate.exists())
        .expect("总有一个名字没被占用")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spots_cloud_drive_folders_by_name() {
        let drive = |path: &str| cloud_drive_by_name(Path::new(path));
        assert_eq!(drive(r"C:\Users\me\OneDrive\文档\Odea"), Some("OneDrive"));
        assert_eq!(drive(r"C:\Users\me\OneDrive - 公司\Odea"), Some("OneDrive"));
        assert_eq!(drive("/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Odea"), Some("iCloud Drive"));
        assert_eq!(drive(r"D:\Nutstore Files\Odea"), Some("坚果云"));
        assert_eq!(drive(r"D:\百度网盘同步\Odea"), Some("百度网盘"));
        assert_eq!(drive(r"C:\Users\me\Documents\Odea"), None);
    }

    #[test]
    fn clones_next_to_the_current_vault_without_clobbering() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Odea");
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(clone_target(&root), dir.path().join("Odea (同步)"));
        std::fs::create_dir_all(dir.path().join("Odea (同步)")).unwrap();
        assert_eq!(clone_target(&root), dir.path().join("Odea (同步) 2"));
    }

    #[test]
    fn remotes_compare_loosely() {
        assert!(same_remote("https://github.com/Me/Notes.git", "https://github.com/me/notes"));
        assert!(!same_remote("https://github.com/me/notes", "https://gitee.com/me/notes"));
    }

    #[test]
    fn connecting_marks_the_repo_and_refuses_a_foreign_remote() {
        let dir = tempfile::tempdir().unwrap();
        connect_here(dir.path(), Provider::GitHub, "me", "https://github.com/me/notes.git").unwrap();
        let repo = SyncRepo::open(dir.path()).unwrap().unwrap();
        assert_eq!(repo.config_get(AUTOSYNC_KEY).as_deref(), Some("true"));
        assert_eq!(repo.config_get(PROVIDER_KEY).as_deref(), Some("github"));
        assert_eq!(repo.config_get(LOGIN_KEY).as_deref(), Some("me"));
        assert!(dir.path().join(".gitignore").exists());
        // 再连同一个（断开后重新连上）：没问题
        disconnect(dir.path()).unwrap();
        assert_eq!(repo.config_get(AUTOSYNC_KEY), None);
        connect_here(dir.path(), Provider::GitHub, "me", "https://github.com/me/notes").unwrap();
        // 连着别的：不动它
        let error = connect_here(dir.path(), Provider::Gitee, "me", "https://gitee.com/me/other.git").unwrap_err();
        assert!(matches!(error, SyncError::Local(message) if message.contains("github.com/me/notes")));
    }

    #[test]
    fn bringing_local_notes_keeps_both_versions_and_skips_git_and_trash() {
        let dir = tempfile::tempdir().unwrap();
        let (from, to) = (dir.path().join("旧"), dir.path().join("新"));
        let write = |root: &Path, rel: &str, text: &str| {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write(&from, "笔记/只在本机.md", "本机的");
        write(&from, "笔记/两边都有.md", "本机的版本");
        write(&from, "笔记/一样的.md", "同样的内容");
        write(&from, ".git/config", "[core]");
        write(&from, ".odea/trash/x.md", "回收站");
        write(&from, ".odea/vault.json", "{\"本机\":1}");
        write(&from, ".ontheway/activity/2026-10.jsonl", "改名前的");
        write(&from, ".gitignore", "本机的");
        write(&from, "笔记/.写到一半.md.1-0.tmp", "临时");
        write(&to, ".odea/vault.json", "{\"云端\":1}");
        write(&to, "笔记/两边都有.md", "云端的版本");
        write(&to, "笔记/一样的.md", "同样的内容");

        assert_eq!(bring_local(&from, &to).unwrap(), 2);
        let read = |rel: &str| std::fs::read_to_string(to.join(rel)).ok();
        assert_eq!(read("笔记/只在本机.md").as_deref(), Some("本机的"));
        assert_eq!(read("笔记/两边都有.md").as_deref(), Some("云端的版本"));
        assert_eq!(read("笔记/两边都有 (本机).md").as_deref(), Some("本机的版本"));
        assert!(read(".git/config").is_none());
        assert!(read(".odea/trash/x.md").is_none());
        assert_eq!(read(".odea/vault.json").as_deref(), Some("{\"云端\":1}"));
        assert!(!to.join(".odea").read_dir().unwrap().any(|e| e.unwrap().file_name() != "vault.json"));
        assert!(!to.join(".ontheway").exists());
        assert!(read(".gitignore").is_none());
        assert!(read("笔记/.写到一半.md.1-0.tmp").is_none());
    }
}
