/* ============================================================
协作做客时本机留的一份（docs/协同编辑.md §24）。

一篇在会话里时只有主持人写盘（§22.2 规矩 1），访客的编辑器不存。访客打的字在主持人收下之前
只在内存里：断线、切走、关窗口、崩溃都可能丢掉最后一份。所以访客这边一有主持人还没收下的改动，
前端就把整篇正文交过来存一份（防抖，src/collab/keep.ts），主持人收下了（他存盘后发来的版本向量
盖住了这边所有的改动）再删掉。

放在应用数据目录的 guest-copies/ 下，不在仓库里：不进 git、不同步，只是这台电脑上的一份留底。
一篇一个 JSON 文件，文件名是 key 的指纹；回收站对话框里列出来，能存成一篇笔记或者丢掉。
============================================================ */

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::domain::model::DocTarget;
use crate::error::Result;
use crate::vault::fsio;

const DIR: &str = "guest-copies";

/// 做客时本机留的一份
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GuestCopy {
    /// 哪一篇（前端起的：团队仓库里是「仓库路径 + 团队文档 id」，邀请做客是「会话 + 文档 id」）
    pub key: String,
    pub title: String,
    /// 团队仓库里的一篇：那个仓库的路径（在那个仓库的窗口里列出来）。邀请做客的是 None，哪个窗口都列
    pub vault: Option<String>,
    /// 团队仓库里的哪一篇：那个仓库里它的正文和这份一样了（git 拉来了主持人存的那一版），这份就可以删了
    pub target: Option<DocTarget>,
    /// 主持人是谁（给人看）
    pub host: String,
    pub text: String,
    /// 最后一次写（Unix 毫秒）
    pub saved_at: i64,
}

fn dir_of(data_dir: &Path) -> PathBuf {
    data_dir.join(DIR)
}

fn file_of(data_dir: &Path, key: &str) -> PathBuf {
    dir_of(data_dir).join(format!("{}.json", fsio::fingerprint(key)))
}

pub fn put(data_dir: &Path, copy: &GuestCopy) -> Result<()> {
    std::fs::create_dir_all(dir_of(data_dir))?;
    fsio::write_atomic(&file_of(data_dir, &copy.key), &serde_json::to_string(copy)?)
}

pub fn drop_copy(data_dir: &Path, key: &str) -> Result<()> {
    match std::fs::remove_file(file_of(data_dir, key)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// 留着的几份，最近写的在前。读不了、不认得的文件跳过
pub fn list(data_dir: &Path) -> Vec<GuestCopy> {
    let Ok(entries) = std::fs::read_dir(dir_of(data_dir)) else {
        return Vec::new();
    };
    let mut copies: Vec<GuestCopy> = entries
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .filter_map(|text| serde_json::from_str(&text).ok())
        .collect();
    copies.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    copies
}

#[cfg(test)]
mod tests {
    use super::*;

    fn copy(key: &str, text: &str, saved_at: i64) -> GuestCopy {
        GuestCopy {
            key: key.into(),
            title: "周报".into(),
            vault: None,
            target: None,
            host: "小王".into(),
            text: text.into(),
            saved_at,
        }
    }

    #[test]
    fn keeps_the_latest_text_per_document_until_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        assert!(list(data).is_empty(), "还没有留过");
        put(data, &copy("a", "第一版", 1)).unwrap();
        put(data, &copy("a", "第二版", 2)).unwrap();
        put(data, &copy("b/斜杠:冒号", "另一篇", 3)).unwrap();
        let kept = list(data);
        assert_eq!(kept.len(), 2, "同一篇只留最新的一份");
        assert_eq!(kept[0].key, "b/斜杠:冒号", "最近写的在前");
        assert_eq!(kept[1].text, "第二版");
        drop_copy(data, "a").unwrap();
        drop_copy(data, "a").unwrap();
        assert_eq!(list(data).len(), 1, "删两次也不报错");
        std::fs::write(dir_of(data).join("坏的.json"), "{").unwrap();
        assert_eq!(list(data).len(), 1, "读不了的跳过");
    }
}
