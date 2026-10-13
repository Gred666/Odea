/* ============================================================
启动时的准备：数据放哪、仓库在哪、第一次怎么建。

应用数据目录（每台机器一份，不同步）：
    config.json      仓库在哪、旧库搬过没有、同步的代理和登录过的账号（令牌在系统钥匙串里）、
                     上一次启动的是哪一版
    index/<指纹>.db   每个仓库一份索引，删了能重建
    ontheway.db      旧版的数据库。搬完留在原地当备份，不再读写

仓库（用户的文件夹，默认「文档/OnTheWay」，可以放进网盘）：见 vault/layout.rs

两个环境变量用来开发和测试，不碰真实数据：
    ONTHEWAY_DATA_DIR  换一个应用数据目录
    ONTHEWAY_VAULT     换一个仓库文件夹
============================================================ */

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;
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
    std::env::var_os("ONTHEWAY_DATA_DIR").map_or(default, PathBuf::from)
}

/// 环境变量 > 配置 > 「文档/OnTheWay」（拿不到文档目录时放在应用数据目录下）
pub fn vault_root(config: &Config, documents: Option<PathBuf>, data_dir: &Path) -> PathBuf {
    if let Some(root) = std::env::var_os("ONTHEWAY_VAULT") {
        return PathBuf::from(root);
    }
    if let Some(root) = &config.vault_root {
        return root.clone();
    }
    documents.map_or_else(|| data_dir.join("vault"), |dir| dir.join("OnTheWay"))
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
            "app": "OnTheWay",
            "version": 1,
            "createdAt": crate::db::now_ms(),
        }))?,
    )?;
    // 旧库只搬一次：以后换到别的文件夹也不再搬
    config.legacy_imported = true;
    Ok(prepared)
}

/// 把整个仓库拷到新文件夹（换位置时「一起搬过去」）。原来的留着不动。
pub fn copy_vault(from: &Path, to: &Path) -> Result<usize> {
    let mut copied = 0;
    let mut stack = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((src, dst)) = stack.pop() {
        std::fs::create_dir_all(&dst)?;
        for entry in std::fs::read_dir(&src)?.flatten() {
            let name = entry.file_name();
            let text = name.to_string_lossy();
            // 应用写到一半的临时文件不拷
            if text.starts_with('.') && text.ends_with(".tmp") {
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
        fsio::write_atomic(&fsio::abs(&from, ".ontheway/vault.json"), "{}").unwrap();
        fsio::write_atomic(&fsio::abs(&from, "笔记/.周报.md.1-2.tmp"), "半截").unwrap();
        assert_eq!(copy_vault(&from, &dir.path().join("b")).unwrap(), 2);
        assert!(dir.path().join("b").join(".ontheway").join("vault.json").exists());
        assert!(!dir.path().join("b").join("笔记").join(".周报.md.1-2.tmp").exists());
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
