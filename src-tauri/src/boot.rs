/* ============================================================
启动时的准备：数据放哪、仓库在哪、第一次怎么建。

应用数据目录（每台机器一份，不同步）：
    config.json      仓库在哪、旧库搬过没有、同步的代理和登录过的账号（令牌在系统钥匙串里）、
                     上一次启动的是哪一版
    index/<指纹>.db   每个仓库一份索引，删了能重建
    ontheway.db      旧版的数据库（文件名还是改名前的）。搬完留在原地当备份，不再读写

仓库（用户的文件夹，默认「文档/Odea」，可以放进网盘）：见 vault/layout.rs

两个环境变量用来开发和测试，不碰真实数据：
    ODEA_DATA_DIR  换一个应用数据目录
    ODEA_VAULT     换一个仓库文件夹

改名前（OnTheWay）留下的数据目录、仓库里的 .ontheway/ 怎么搬过来，见 old_name.rs
============================================================ */

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::vault::{fsio, guide, layout, legacy, seed};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// 仓库文件夹。没有就用默认位置
    #[serde(default)]
    pub vault_root: Option<PathBuf>,
    /// 旧库（ontheway.db）已经搬过了，或者已经有过一个仓库、不该再搬
    #[serde(default)]
    pub legacy_imported: bool,
    /// 同步用的代理，用户自己填的（技术方案 §5.9.4）。没填就按环境变量、系统代理找
    #[serde(default)]
    pub sync_proxy: Option<String>,
    /// 登录过的同步账号：托管方（github / gitee）→ login。令牌在钥匙串里，这里不放
    #[serde(default)]
    pub sync_accounts: std::collections::BTreeMap<String, String>,
    /// 上一次启动的是哪一版。升级后第一次打开时据此提示一次更新说明（note_version）
    #[serde(default)]
    pub last_version: Option<String>,
}

impl Config {
    pub fn load(data_dir: &Path) -> Self {
        std::fs::read_to_string(data_dir.join("config.json"))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, data_dir: &Path) -> Result<()> {
        fsio::write_atomic(
            &data_dir.join("config.json"),
            &serde_json::to_string_pretty(self)?,
        )
    }
}

/// 升级后第一次打开：从哪一版升上来的。前端照着它把这之间的更新说明给用户看一次
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct AppUpgrade {
    /// 升级前的版本；空 = 记版本号之前的老版本（0.1.0），不知道具体是哪一版
    pub from: Option<String>,
    /// 现在这一版
    pub to: String,
}

/// 记下这一次启动的版本，返回是不是刚升级上来。`fresh` = 这台机器上第一次打开（之前没有
/// 配置文件）：新装的不算升级。同一版、降级回去的也不算。调用方负责存配置
pub fn note_version(config: &mut Config, fresh: bool, current: &str) -> Option<AppUpgrade> {
    let last = config.last_version.replace(current.to_string());
    if fresh {
        return None;
    }
    let newer = match &last {
        None => true,
        Some(last) => matches!(
            (guide::parse_version(current), guide::parse_version(last)),
            (Some(now), Some(before)) if now > before
        ),
    };
    newer.then(|| AppUpgrade { from: last, to: current.to_string() })
}

pub fn data_dir(default: PathBuf) -> PathBuf {
    std::env::var_os("ODEA_DATA_DIR").map_or(default, PathBuf::from)
}

/// 环境变量 > 配置 > 「文档/Odea」（拿不到文档目录时放在应用数据目录下）。
/// 改名前装的，配置里记着「文档/OnTheWay」，照旧用它
pub fn vault_root(config: &Config, documents: Option<PathBuf>, data_dir: &Path) -> PathBuf {
    if let Some(root) = std::env::var_os("ODEA_VAULT") {
        return PathBuf::from(root);
    }
    if let Some(root) = &config.vault_root {
        return root.clone();
    }
    documents.map_or_else(|| data_dir.join("vault"), |dir| dir.join("Odea"))
}

/// 每个仓库一份索引，按仓库路径分开：换来换去的时候各自的缓存都还在
pub fn index_path(data_dir: &Path, root: &Path) -> PathBuf {
    let key = root.to_string_lossy().to_lowercase();
    data_dir
        .join("index")
        .join(format!("{}.db", fsio::fingerprint(&key)))
}

#[derive(Debug, PartialEq, Eq)]
pub enum Prepared {
    /// 仓库早就建好了
    Existing,
    /// 从旧库搬过来的
    Imported(legacy::Report),
    /// 新仓库，放了示例内容
    Seeded,
    /// 新仓库，什么都没放（选了一个已有文件的文件夹，或者换到一个空文件夹）
    Empty,
}

/// 第一次打开一个仓库：旧库有东西就搬过来，否则空文件夹里放示例内容；
/// 最后写下仓库标记，以后不再做这些。`first_run` 为 false（用户换到另一个文件夹）
/// 时不搬也不放示例 —— 那是用户自己挑的文件夹。
pub fn prepare(root: &Path, data_dir: &Path, config: &mut Config, first_run: bool) -> Result<Prepared> {
    // 改名前的 .ontheway/ 先并进来：仓库标记也在里面
    if let Err(error) = crate::old_name::move_vault_dir(root, layout::APP_DIR) {
        eprintln!("搬仓库里的 {} 失败: {error}", crate::old_name::VAULT_DIR);
    }
    let marker = fsio::abs(root, layout::VAULT_MARKER);
    if marker.exists() {
        return Ok(Prepared::Existing);
    }
    std::fs::create_dir_all(root)?;
    let empty = !fsio::has_markdown(root);
    let legacy_db = data_dir.join("ontheway.db");

    let prepared = if first_run && empty && !config.legacy_imported && legacy::has_data(&legacy_db) {
        Prepared::Imported(legacy::import(&legacy_db, root, &data_dir.join("import-tmp"))?)
    } else if first_run && empty {
        seed::write(root)?;
        Prepared::Seeded
    } else {
        Prepared::Empty
    };

    fsio::write_atomic(
        &marker,
        &serde_json::to_string_pretty(&serde_json::json!({
            "app": "Odea",
            "version": 1,
            "createdAt": crate::db::now_ms(),
        }))?,
    )?;
    // 旧库只搬一次：以后换到别的文件夹也不再搬
    config.legacy_imported = true;
    Ok(prepared)
}

/// 应用写到一半的临时文件（`fsio::write_atomic` 的 `.名字.tmp`）：拷、核对都不算它
fn transient(name: &std::ffi::OsStr) -> bool {
    let text = name.to_string_lossy();
    text.starts_with('.') && text.ends_with(".tmp")
}

/// 把整个仓库拷到新文件夹（换位置时「复制过去」，「搬过去」跨盘时也先拷）。原来的留着不动。
pub fn copy_vault(from: &Path, to: &Path) -> Result<usize> {
    let mut copied = 0;
    let mut stack = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((src, dst)) = stack.pop() {
        std::fs::create_dir_all(&dst)?;
        for entry in std::fs::read_dir(&src)?.flatten() {
            let name = entry.file_name();
            if transient(&name) {
                continue;
            }
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                stack.push((entry.path(), dst.join(&name)));
            } else if file_type.is_file() {
                std::fs::copy(entry.path(), dst.join(&name))?;
                copied += 1;
            }
        }
    }
    Ok(copied)
}

/// 复制过去以后逐个核对：原来那边的每个文件（临时文件除外），新位置上都得有、一样大。
/// 返回第一处对不上的地方，全对得上是 None
pub fn first_difference(from: &Path, to: &Path) -> Option<String> {
    let mut stack = vec![PathBuf::new()];
    while let Some(relative) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(from.join(&relative)) else {
            return Some(format!("读不了 {}", from.join(&relative).display()));
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if transient(&name) {
                continue;
            }
            let path = relative.join(&name);
            let Ok(file_type) = entry.file_type() else {
                return Some(format!("读不了 {}", from.join(&path).display()));
            };
            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file() {
                let size = entry.metadata().map(|meta| meta.len()).ok();
                match std::fs::metadata(to.join(&path)) {
                    Ok(meta) if meta.is_file() && Some(meta.len()) == size => {}
                    Ok(_) => return Some(format!("{} 大小不一样", path.display())),
                    Err(_) => return Some(format!("{} 没复制过去", path.display())),
                }
            }
        }
    }
    None
}

/// 「搬过去」的结果
#[derive(Debug, PartialEq, Eq)]
pub enum Moved {
    /// 同一个盘上整个改名过去
    Renamed,
    /// 复制过去、核对过，原来的放进了回收站
    Copied,
    /// 复制过去、核对过，原来的没能放进回收站（原因），还留在原处
    CopiedKeptOriginal(String),
}

/// 改名失败是不是因为跨了盘：这种不用重试，直接复制
fn crosses_devices(error: &std::io::Error) -> bool {
    // Windows：ERROR_NOT_SAME_DEVICE；Unix：EXDEV
    let code = if cfg!(windows) { 17 } else { 18 };
    error.raw_os_error() == Some(code)
}

/// 「搬过去」：把整个仓库搬到 `to`（用户挑的文件夹，里面没有笔记）。调用方先停掉文件监听和同步。
///
/// 同一个盘上：`to` 是空的就先删掉这个空文件夹，再把整个仓库改名过去 —— 一步完成，不成就原样不动。
/// 改名不成（跨盘、文件被别的程序占着、`to` 里有别的东西）：复制过去、逐个核对，再交给 `discard`
/// 把原来的放进回收站。核对不上就停下：原来的不动，返回错误；复制出去的那些留在 `to` 里。
/// 放不进回收站的，笔记已经完整地在新位置了，照样算搬成，原因带回去告诉用户
pub fn move_vault(
    from: &Path,
    to: &Path,
    discard: impl FnOnce(&Path) -> std::result::Result<(), String>,
) -> Result<Moved> {
    let free = match std::fs::read_dir(to) {
        Ok(mut entries) => entries.next().is_none() && std::fs::remove_dir(to).is_ok(),
        Err(_) => !to.exists(),
    };
    if free {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // 刚停掉的文件监听、同步线程可能还没把句柄放掉（Windows 上开着的句柄会让改名失败）：等一下再试
        for attempt in 0..4 {
            match std::fs::rename(from, to) {
                Ok(()) => return Ok(Moved::Renamed),
                Err(error) if attempt < 3 && !crosses_devices(&error) => {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
                Err(_) => break,
            }
        }
        // 删掉的空文件夹建回来，走复制
        std::fs::create_dir_all(to)?;
    }
    copy_vault(from, to)?;
    if let Some(difference) = first_difference(from, to) {
        return Err(AppError::Invalid(format!(
            "复制过去以后核对不上（{difference}），原来的笔记文件夹没动，照旧用它"
        )));
    }
    Ok(match discard(from) {
        Ok(()) => Moved::Copied,
        Err(reason) => Moved::CopiedKeptOriginal(reason),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_install_seeds_once() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let root = dir.path().join("vault");
        let mut config = Config::default();

        assert_eq!(prepare(&root, &data, &mut config, true).unwrap(), Prepared::Seeded);
        assert!(fsio::has_markdown(&root));
        assert!(config.legacy_imported);

        // 用户删光了也不会再塞回来
        std::fs::remove_dir_all(root.join(layout::NOTES_DIR)).unwrap();
        assert_eq!(prepare(&root, &data, &mut config, true).unwrap(), Prepared::Existing);
        assert!(!root.join(layout::NOTES_DIR).exists());
    }

    #[test]
    fn a_folder_with_notes_is_adopted_as_is() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("obsidian");
        fsio::write_atomic(&fsio::abs(&root, "随手记.md"), "别人的笔记").unwrap();
        let mut config = Config::default();
        assert_eq!(
            prepare(&root, &dir.path().join("data"), &mut config, true).unwrap(),
            Prepared::Empty
        );
        assert_eq!(fsio::walk_markdown(&root).len(), 1, "不往别人的文件夹里塞示例");
    }

    #[test]
    fn an_old_vault_from_before_the_rename_is_recognized_and_moved_over() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("文档/OnTheWay");
        fsio::write_atomic(&fsio::abs(&root, "笔记/周报.md"), "周报").unwrap();
        fsio::write_atomic(&fsio::abs(&root, ".ontheway/vault.json"), "{\"app\":\"OnTheWay\"}").unwrap();
        fsio::write_atomic(&fsio::abs(&root, ".ontheway/trash/a.md"), "回收站").unwrap();
        let mut config = Config::default();
        assert_eq!(
            prepare(&root, &dir.path().join("data"), &mut config, true).unwrap(),
            Prepared::Existing
        );
        assert!(root.join(layout::TRASH_DIR).join("a.md").exists());
        assert!(!root.join(".ontheway").exists());
    }

    #[test]
    fn switching_to_an_empty_folder_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        assert_eq!(
            prepare(&dir.path().join("新的"), &dir.path().join("data"), &mut config, false).unwrap(),
            Prepared::Empty
        );
    }

    #[test]
    fn config_round_trips_and_tolerates_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let config = Config {
            vault_root: Some(PathBuf::from("D:/笔记")),
            legacy_imported: true,
            ..Config::default()
        };
        config.save(dir.path()).unwrap();
        let back = Config::load(dir.path());
        assert_eq!(back.vault_root, config.vault_root);
        assert!(back.legacy_imported);

        std::fs::write(dir.path().join("config.json"), "{坏了").unwrap();
        assert!(Config::load(dir.path()).vault_root.is_none());
    }

    #[test]
    fn remembers_the_version_and_reports_upgrades_once() {
        // 新装的：记下版本，不算升级
        let mut config = Config::default();
        assert_eq!(note_version(&mut config, true, "0.2.0"), None);
        assert_eq!(config.last_version.as_deref(), Some("0.2.0"));
        // 同一版再打开
        assert_eq!(note_version(&mut config, false, "0.2.0"), None);
        // 升级：只有升上来之后的第一次
        assert_eq!(
            note_version(&mut config, false, "0.3.1"),
            Some(AppUpgrade { from: Some("0.2.0".into()), to: "0.3.1".into() })
        );
        assert_eq!(note_version(&mut config, false, "0.3.1"), None);
        // 降级回去不算，再升回来又算
        assert_eq!(note_version(&mut config, false, "0.3.0"), None);
        assert!(note_version(&mut config, false, "0.3.1").is_some());
        // 比较的是数，不是字符串
        let mut config = Config { last_version: Some("0.9.0".into()), ..Config::default() };
        assert!(note_version(&mut config, false, "0.10.0").is_some());
    }

    #[test]
    fn an_old_config_without_a_version_counts_as_an_upgrade() {
        // 0.1.0 的配置文件里没有 lastVersion
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), r#"{"legacyImported":true}"#).unwrap();
        let mut config = Config::load(dir.path());
        assert_eq!(
            note_version(&mut config, false, "0.2.0"),
            Some(AppUpgrade { from: None, to: "0.2.0".into() })
        );
        config.save(dir.path()).unwrap();
        assert_eq!(Config::load(dir.path()).last_version.as_deref(), Some("0.2.0"));
    }

    #[test]
    fn copies_a_vault_without_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("a");
        fsio::write_atomic(&fsio::abs(&from, "笔记/周报.md"), "x").unwrap();
        fsio::write_atomic(&fsio::abs(&from, ".odea/vault.json"), "{}").unwrap();
        fsio::write_atomic(&fsio::abs(&from, "笔记/.周报.md.1-2.tmp"), "半截").unwrap();
        assert_eq!(copy_vault(&from, &dir.path().join("b")).unwrap(), 2);
        assert!(dir.path().join("b").join(".odea").join("vault.json").exists());
        assert!(!dir.path().join("b").join("笔记").join(".周报.md.1-2.tmp").exists());
    }

    /// 一个有内容的仓库：两篇笔记、一张附件、仓库标记，外加一个写到一半的临时文件
    fn sample_vault(root: &Path) {
        fsio::write_atomic(&fsio::abs(root, "笔记/周报.md"), "周报").unwrap();
        fsio::write_atomic(&fsio::abs(root, "笔记/工作/计划.md"), "计划").unwrap();
        fsio::write_atomic(&fsio::abs(root, "附件/图.png"), "图").unwrap();
        fsio::write_atomic(&fsio::abs(root, ".odea/vault.json"), "{}").unwrap();
        fsio::write_atomic(&fsio::abs(root, "笔记/.周报.md.1-2.tmp"), "半截").unwrap();
    }

    #[test]
    fn moving_on_the_same_disk_renames_the_whole_folder() {
        let dir = tempfile::tempdir().unwrap();
        let (from, to) = (dir.path().join("文档/Odea"), dir.path().join("D盘/笔记"));
        sample_vault(&from);
        std::fs::create_dir_all(&to).unwrap();
        let moved = move_vault(&from, &to, |_| panic!("改名成了就不该再删")).unwrap();
        assert_eq!(moved, Moved::Renamed);
        assert!(!from.exists());
        assert!(to.join("笔记/工作/计划.md").exists());
        assert!(to.join(".odea/vault.json").exists());
    }

    #[test]
    fn moving_into_a_folder_with_other_files_copies_checks_and_discards() {
        let dir = tempfile::tempdir().unwrap();
        let (from, to) = (dir.path().join("a"), dir.path().join("b"));
        sample_vault(&from);
        // 新文件夹里本来有别的东西（不是笔记）：不能整个改名过去，复制
        fsio::write_atomic(&fsio::abs(&to, "说明.txt"), "原来就在").unwrap();
        let mut discarded = None;
        let moved = move_vault(&from, &to, |path| {
            discarded = Some(path.to_path_buf());
            Ok(())
        })
        .unwrap();
        assert_eq!(moved, Moved::Copied);
        assert_eq!(discarded.as_deref(), Some(from.as_path()));
        assert_eq!(first_difference(&from, &to), None);
        assert!(to.join("说明.txt").exists());
        assert!(!to.join("笔记/.周报.md.1-2.tmp").exists());
    }

    #[test]
    fn a_failed_discard_still_counts_as_moved() {
        let dir = tempfile::tempdir().unwrap();
        let (from, to) = (dir.path().join("a"), dir.path().join("b"));
        sample_vault(&from);
        fsio::write_atomic(&fsio::abs(&to, "说明.txt"), "x").unwrap();
        let moved = move_vault(&from, &to, |_| Err("文件被占着".into())).unwrap();
        assert_eq!(moved, Moved::CopiedKeptOriginal("文件被占着".into()));
        assert!(from.join("笔记/周报.md").exists(), "放不进回收站就留着");
        assert!(to.join("笔记/周报.md").exists());
    }

    #[test]
    fn spots_a_missing_or_different_file() {
        let dir = tempfile::tempdir().unwrap();
        let (from, to) = (dir.path().join("a"), dir.path().join("b"));
        sample_vault(&from);
        copy_vault(&from, &to).unwrap();
        assert_eq!(first_difference(&from, &to), None);
        std::fs::write(to.join("附件/图.png"), "大了一点").unwrap();
        assert!(first_difference(&from, &to).unwrap().contains("大小不一样"));
        std::fs::write(to.join("附件/图.png"), "图").unwrap();
        std::fs::remove_file(to.join("笔记/工作/计划.md")).unwrap();
        assert!(first_difference(&from, &to).unwrap().contains("没复制过去"));
    }

    #[test]
    fn index_files_are_per_vault() {
        let data = Path::new("/data");
        assert_ne!(
            index_path(data, Path::new("C:/a")),
            index_path(data, Path::new("C:/b"))
        );
        assert_eq!(
            index_path(data, Path::new("C:/A")),
            index_path(data, Path::new("c:/a"))
        );
    }
}
