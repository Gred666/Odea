/* ============================================================
协作做客时本机留的一份（docs/协同编辑.md §24）。

一篇在会话里时只有主持人写盘（§22.2 规矩 1），访客的编辑器不存。访客打的字在主持人收下之前
只在内存里：断线、切走、关窗口、崩溃都可能丢掉最后一份。所以访客这边一有主持人还没收下的改动，
前端就把整篇正文交过来存一份（防抖，src/collab/keep.ts），主持人收下了（他存盘后发来的版本向量
盖住了这边所有的改动）再删掉。

放在应用数据目录的 guest-copies/ 下，不在仓库里：不进 git、不同步，只是这台电脑上的一份留底。
一篇一个 JSON 文件，文件名是 key 的指纹；回收站对话框里列出来，能存成一篇笔记或者丢掉。

文件里的 target 照 0.7.0 的写法写（`{ kind: "note", id }`、`{ kind: "day", id }`、
`{ kind: "goal", horizon, periodStart }`，docs/插件与跨端.md §13.2）：0.7.0 遇到读不了的文件整个跳过，
降级回去这几份就从列表里没了。读的时候两种写法都认（DocRef 的 Deserialize）。交给前端的照旧是 `{ type, key }`
============================================================ */

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::domain::model::DocRef;
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
    /// 团队仓库里的哪一篇：那个仓库里它的正文和这份一样了（git 拉来了主持人存的那一版），这份就可以删了。
    /// 文件里照老格式写（`{ kind: "day", id }`，见 on_disk），DocRef 读的时候两种都认
    pub target: Option<DocRef>,
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
    fsio::write_atomic(&file_of(data_dir, &copy.key), &serde_json::to_string(&on_disk(copy)?)?)
}

/// 写进文件的样子：target 换成老写法（DocRef::legacy_value），没有老写法的（以后插件的类型）照 `{ type, key }`。
/// 只改文件：GuestCopy 自己的 Serialize 是给前端的（IPC），那边认的是 `{ type, key }`
fn on_disk(copy: &GuestCopy) -> Result<serde_json::Value> {
    let mut value = serde_json::to_value(copy)?;
    if let Some(legacy) = copy.target.as_ref().and_then(DocRef::legacy_value) {
        value["target"] = legacy;
    }
    Ok(value)
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
    copies.sort_by_key(|copy| std::cmp::Reverse(copy.saved_at));
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

    #[test]
    fn copies_kept_by_older_versions_are_still_listed() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        std::fs::create_dir_all(dir_of(data)).unwrap();
        // 0.7.0 存的：target 是老的 DocTarget
        let old = |key: &str, target: &str| {
            format!(
                r#"{{"key":"{key}","title":"周报","vault":"D:/仓库","target":{target},"host":"小王","text":"字","savedAt":1}}"#
            )
        };
        std::fs::write(dir_of(data).join("a.json"), old("a", r#"{"kind":"note","id":"n1"}"#)).unwrap();
        std::fs::write(dir_of(data).join("b.json"), old("b", r#"{"kind":"day","id":"2026-11-03"}"#)).unwrap();
        std::fs::write(
            dir_of(data).join("c.json"),
            old("c", r#"{"kind":"goal","horizon":"week","periodStart":"2026-11-02"}"#),
        )
        .unwrap();
        let mut kept = list(data);
        kept.sort_by(|a, b| a.key.cmp(&b.key));
        let targets: Vec<DocRef> = kept.into_iter().filter_map(|copy| copy.target).collect();
        assert_eq!(
            targets,
            vec![
                DocRef::note("n1"),
                DocRef::new("journal.day", "2026-11-03"),
                DocRef::new("journal.goal", "week:2026-11-02"),
            ]
        );
    }

    /// 0.7.0 的 DocTarget 和 GuestCopy（照 3481315 的 domain/model.rs、keep.rs 抄的）：
    /// 降级回 0.7.0，它要读得出新版写的留底
    mod v070 {
        use serde::Deserialize;

        #[derive(Debug, PartialEq, Deserialize)]
        #[serde(tag = "kind", rename_all = "lowercase")]
        pub enum DocTarget {
            Note {
                id: String,
            },
            Day {
                id: String,
            },
            Goal {
                horizon: String,
                #[serde(rename = "periodStart")]
                period_start: String,
            },
        }

        #[derive(Debug, Deserialize)]
        #[serde(rename_all = "camelCase")]
        #[allow(dead_code)]
        pub struct GuestCopy {
            pub key: String,
            pub title: String,
            pub vault: Option<String>,
            pub target: Option<DocTarget>,
            pub host: String,
            pub text: String,
            pub saved_at: i64,
        }
    }

    fn with_target(key: &str, target: Option<DocRef>) -> GuestCopy {
        GuestCopy { vault: Some("D:/仓库".into()), target, ..copy(key, "字", 1) }
    }

    fn file_json(data: &Path, key: &str) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(file_of(data, key)).unwrap()).unwrap()
    }

    #[test]
    fn copies_are_written_the_way_0_7_0_wrote_them() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let cases = [
            ("note", DocRef::note("n1"), serde_json::json!({ "kind": "note", "id": "n1" })),
            ("day", DocRef::new("journal.day", "2026-11-03"), serde_json::json!({ "kind": "day", "id": "2026-11-03" })),
            (
                "week",
                DocRef::new("journal.goal", "week:2026-11-02"),
                serde_json::json!({ "kind": "goal", "horizon": "week", "periodStart": "2026-11-02" }),
            ),
            (
                "year",
                DocRef::new("journal.goal", "year:2026-01-01"),
                serde_json::json!({ "kind": "goal", "horizon": "year", "periodStart": "2026-01-01" }),
            ),
        ];
        for (key, target, _) in &cases {
            put(data, &with_target(key, Some(target.clone()))).unwrap();
        }
        // 以后插件的类型没有老写法：照新格式写；没有 target 的（邀请做客）是 null
        put(data, &with_target("page", Some(DocRef::new("test.page", "7")))).unwrap();
        put(data, &with_target("none", None)).unwrap();

        for (key, _, legacy) in &cases {
            assert_eq!(file_json(data, key)["target"], *legacy, "{key}");
        }
        assert_eq!(file_json(data, "page")["target"], serde_json::json!({ "type": "test.page", "key": "7" }));
        assert_eq!(file_json(data, "none")["target"], serde_json::Value::Null);

        // 读回来和写进去的一样（内存里、给前端的都是 { type, key }）
        let mut kept = list(data);
        kept.sort_by(|a, b| a.key.cmp(&b.key));
        let read: Vec<(String, Option<DocRef>)> = kept.into_iter().map(|copy| (copy.key, copy.target)).collect();
        let mut wrote: Vec<(String, Option<DocRef>)> =
            cases.iter().map(|(key, target, _)| (key.to_string(), Some(target.clone()))).collect();
        wrote.push(("none".into(), None));
        wrote.push(("page".into(), Some(DocRef::new("test.page", "7"))));
        wrote.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(read, wrote);
        let ipc = serde_json::to_value(with_target("day", Some(DocRef::new("journal.day", "2026-11-03")))).unwrap();
        assert_eq!(ipc["target"], serde_json::json!({ "type": "journal.day", "key": "2026-11-03" }), "给前端的不变");
    }

    #[test]
    fn version_0_7_0_reads_the_copies_this_version_writes() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        put(data, &with_target("note", Some(DocRef::note("n1")))).unwrap();
        put(data, &with_target("day", Some(DocRef::new("journal.day", "2026-11-03")))).unwrap();
        put(data, &with_target("goal", Some(DocRef::new("journal.goal", "month:2026-11-01")))).unwrap();
        put(data, &with_target("none", None)).unwrap();
        let old = |key: &str| -> v070::GuestCopy {
            serde_json::from_str(&std::fs::read_to_string(file_of(data, key)).unwrap())
                .unwrap_or_else(|error| panic!("0.7.0 读不出 {key}: {error}"))
        };
        assert_eq!(old("note").target, Some(v070::DocTarget::Note { id: "n1".into() }));
        assert_eq!(old("day").target, Some(v070::DocTarget::Day { id: "2026-11-03".into() }));
        assert_eq!(
            old("goal").target,
            Some(v070::DocTarget::Goal { horizon: "month".into(), period_start: "2026-11-01".into() })
        );
        assert_eq!(old("none").target, None);
        assert_eq!(old("day").saved_at, 1);
    }
}
