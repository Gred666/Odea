/* ============================================================
改名：OnTheWay → Odea（0.3.0）。旧名留下的东西都在这里认、在这里搬。

装过旧版的机器上，旧名分散在这几处：
- 应用数据目录（config.json、索引）、WebView 的数据（主题、折叠状态之类的界面设置）、
  窗口位置：都按应用标识 dev.ontheway.app 放。启动时、Tauri 建窗口之前整个挪到新标识下
  （move_app_dirs）。只在发布构建里搬：调试时别把正在用的旧版的数据挪走
- 仓库里的 .ontheway/（回收站、行为日志、仓库标记）→ .odea/（move_vault_dir，打开仓库时）。
  行为日志和仓库标记跟着同步走：别的设备还没升级时会再写出一份 .ontheway/，下次打开时并进来
- .git/config 里的 ontheway.* 键、.git/ontheway.json：打开同步仓库时换成新的（sync/repo.rs）
- .gitignore / .gitattributes 里旧名那一段：换成新的（sync/repo.rs）
- 钥匙串里的服务名 OnTheWay：新的里没有就读旧的，读到了挪过来（sync/secret.rs）
- 同步提交署名「OnTheWay (设备名)」：历史里的旧提交照样认（sync/engine.rs）
- 使用指南属性块里的 `ontheway-guide:`：照样认，下次写的时候换成新的；欢迎那篇没改过的话
  标题也跟着换（vault/guide.rs）
- 笔记仓库默认在「文档/OnTheWay」：那是用户的文件夹，不动（配置里记着它在哪）
Windows 上旧的安装（快捷方式、程序文件夹、卸载项）由安装包清掉（src-tauri/windows/hooks.nsh）。

所有设备都升级上来以后，这个文件和各处引用它的地方可以一起删掉。
============================================================ */

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// 旧的应用标识
pub const IDENTIFIER: &str = "dev.ontheway.app";
/// 旧名：钥匙串的服务名、提交署名的前缀、.gitignore 那一段的记号
pub const NAME: &str = "OnTheWay";
/// 仓库里旧的应用文件夹
pub const VAULT_DIR: &str = ".ontheway";
/// .git/config 里旧键的小节（`ontheway.autosync` 之类），也是 .git 里旧的记事文件名
pub const CONFIG_SECTION: &str = "ontheway";
/// 使用指南属性块里旧的记号
pub const GUIDE_MARK: &str = "ontheway-guide:";

/* ---------------- 应用数据目录 ---------------- */

/// 启动时、Tauri 建窗口之前：旧标识下的目录挪到新标识下。
/// 挪不动的（旧版还没退干净、文件被占着）记一笔、跳过 —— 不能因为这个起不来
#[cfg(feature = "desktop-runtime")]
pub fn move_app_dirs(identifier: &str) {
    // 调试构建和正在用的旧版共用一台机器；换了数据目录（ODEA_DATA_DIR）的也不碰真实的
    if cfg!(debug_assertions) || std::env::var_os("ODEA_DATA_DIR").is_some() {
        return;
    }
    move_app_dirs_in(&app_dir_bases(), identifier);
}

/// Tauri 按标识放东西的几个上级目录（tauri::path 用的也是 dirs）：
/// - 数据目录：config.json、索引（Windows 的 Roaming、macOS 的 Application Support、Linux 的 ~/.local/share）
/// - 本地数据目录：Windows 上 WebView2 的数据（EBWebView）
/// - 配置目录：窗口位置（Linux 的 ~/.config；另外两个系统和数据目录是同一个）
/// - macOS 的 ~/Library/WebKit：WKWebView 按 bundle id 放的网页数据
#[cfg(feature = "desktop-runtime")]
fn app_dir_bases() -> Vec<PathBuf> {
    let mut bases = Vec::new();
    let candidates = [
        dirs::data_dir(),
        dirs::data_local_dir(),
        dirs::config_dir(),
        if cfg!(target_os = "macos") {
            dirs::home_dir().map(|home| home.join("Library").join("WebKit"))
        } else {
            None
        },
    ];
    for base in candidates.into_iter().flatten() {
        if !bases.contains(&base) {
            bases.push(base);
        }
    }
    bases
}

pub fn move_app_dirs_in(bases: &[PathBuf], identifier: &str) {
    for base in bases {
        let from = base.join(IDENTIFIER);
        if let Err(error) = merge_app_dir(&from, &base.join(identifier)) {
            eprintln!("搬旧版的 {} 失败: {error}", from.display());
        }
    }
}

/// from 整个改名成 to；to 已经有了（新版跑过一次），或者整个改名改不动（里面有文件被占着），
/// 就一项一项挪 to 里还没有的。挪完 from 空了就删掉
fn merge_app_dir(from: &Path, to: &Path) -> io::Result<()> {
    if !from.is_dir() {
        return Ok(());
    }
    if !to.exists() {
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        if retry(|| fs::rename(from, to)).is_ok() {
            return Ok(());
        }
        fs::create_dir_all(to)?;
    }
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if target.exists() {
            continue;
        }
        if let Err(error) = retry(|| fs::rename(entry.path(), &target)) {
            eprintln!("搬旧版的 {} 失败: {error}", entry.path().display());
        }
    }
    let _ = fs::remove_dir(from);
    Ok(())
}

/// 自动更新时旧版刚退出，WebView2 的子进程可能还要一小会儿才松开文件
fn retry(mut op: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    let mut result = op();
    for _ in 0..5 {
        if result.is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        result = op();
    }
    result
}

/* ---------------- 仓库里的 .ontheway/ ---------------- */

/// 仓库里的 .ontheway/ 并进 .odea/（`app_dir`）。没有新的就整个改名；两边都有（别的设备上的
/// 旧版同步过来、又写了一份）就逐个挪：行为日志按行合并，两边的行都留下（和 .gitattributes 里
/// 的 merge=union 一个意思）；别的文件新的里已经有就不要旧的
pub fn move_vault_dir(root: &Path, app_dir: &str) -> io::Result<()> {
    let from = root.join(VAULT_DIR);
    if !from.is_dir() {
        return Ok(());
    }
    merge_tree(&from, &root.join(app_dir))
}

fn merge_tree(from: &Path, to: &Path) -> io::Result<()> {
    if !to.exists() {
        return fs::rename(from, to);
    }
    if from.is_dir() {
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            merge_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        return fs::remove_dir(from);
    }
    if from.extension().is_some_and(|ext| ext == "jsonl") {
        let theirs = fs::read_to_string(from)?;
        let mut ours = fs::read_to_string(to)?;
        let known: std::collections::HashSet<&str> = ours.lines().collect();
        let missing: Vec<&str> = theirs.lines().filter(|line| !line.is_empty() && !known.contains(line)).collect();
        if !missing.is_empty() {
            if !ours.is_empty() && !ours.ends_with('\n') {
                ours.push('\n');
            }
            for line in missing {
                ours.push_str(line);
                ours.push('\n');
            }
            crate::vault::fsio::write_atomic(to, &ours).map_err(|error| io::Error::other(error.to_string()))?;
        }
    }
    fs::remove_file(from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn the_old_app_dirs_move_under_the_new_identifier() {
        let dir = tempfile::tempdir().unwrap();
        let roaming = dir.path().join("Roaming");
        let local = dir.path().join("Local");
        write(&roaming.join(IDENTIFIER).join("config.json"), "{\"vaultRoot\":\"D:/笔记\"}");
        write(&local.join(IDENTIFIER).join("EBWebView").join("Local State"), "x");

        move_app_dirs_in(&[roaming.clone(), local.clone()], "dev.odea.editor");

        let config = fs::read_to_string(roaming.join("dev.odea.editor").join("config.json")).unwrap();
        assert!(config.contains("D:/笔记"));
        assert!(local.join("dev.odea.editor").join("EBWebView").join("Local State").exists());
        assert!(!roaming.join(IDENTIFIER).exists());
        assert!(!local.join(IDENTIFIER).exists());
    }

    #[test]
    fn a_new_dir_that_already_exists_keeps_its_own_files_and_gets_the_missing_ones() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_path_buf();
        write(&base.join(IDENTIFIER).join("config.json"), "旧");
        write(&base.join(IDENTIFIER).join("ontheway.db"), "旧库");
        write(&base.join("dev.odea.editor").join("config.json"), "新");

        move_app_dirs_in(&[base.clone()], "dev.odea.editor");

        let new = base.join("dev.odea.editor");
        assert_eq!(fs::read_to_string(new.join("config.json")).unwrap(), "新");
        assert_eq!(fs::read_to_string(new.join("ontheway.db")).unwrap(), "旧库");
        // 留下没挪的那一份：旧目录还在，不删用户的东西
        assert!(base.join(IDENTIFIER).join("config.json").exists());
    }

    #[test]
    fn nothing_to_move_is_fine() {
        let dir = tempfile::tempdir().unwrap();
        move_app_dirs_in(&[dir.path().to_path_buf()], "dev.odea.editor");
        assert!(!dir.path().join("dev.odea.editor").exists());
        move_vault_dir(dir.path(), ".odea").unwrap();
        assert!(!dir.path().join(".odea").exists());
    }

    #[test]
    fn the_vault_dir_is_renamed_when_there_is_no_new_one() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join(".ontheway/vault.json"), "{}");
        write(&dir.path().join(".ontheway/trash/a.md"), "回收站");

        move_vault_dir(dir.path(), ".odea").unwrap();

        assert!(dir.path().join(".odea/vault.json").exists());
        assert!(dir.path().join(".odea/trash/a.md").exists());
        assert!(!dir.path().join(".ontheway").exists());
    }

    #[test]
    fn an_old_vault_dir_synced_back_in_is_merged_and_keeps_both_sides_activity() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join(".odea/vault.json"), "{\"新\":1}");
        write(&root.join(".odea/activity/2026-10.jsonl"), "{\"n\":1}\n{\"n\":2}\n");
        write(&root.join(".ontheway/vault.json"), "{\"旧\":1}");
        write(&root.join(".ontheway/activity/2026-10.jsonl"), "{\"n\":2}\n{\"n\":3}\n");
        write(&root.join(".ontheway/activity/2026-11.jsonl"), "{\"n\":4}\n");
        write(&root.join(".ontheway/trash/b.md"), "回收站");

        move_vault_dir(root, ".odea").unwrap();

        assert_eq!(fs::read_to_string(root.join(".odea/vault.json")).unwrap(), "{\"新\":1}");
        assert_eq!(
            fs::read_to_string(root.join(".odea/activity/2026-10.jsonl")).unwrap(),
            "{\"n\":1}\n{\"n\":2}\n{\"n\":3}\n"
        );
        assert_eq!(fs::read_to_string(root.join(".odea/activity/2026-11.jsonl")).unwrap(), "{\"n\":4}\n");
        assert!(root.join(".odea/trash/b.md").exists());
        assert!(!root.join(".ontheway").exists());
    }
}
