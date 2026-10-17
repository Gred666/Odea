/* ============================================================
append-only 行为日志：`.odea/activity/2026-09.jsonl`，一行一条。

复盘统计的来源（「本周完成了几件、分别什么时候」）—— 任务被重开、改期、删掉之后
正文里的历史就没了，只能靠它。和以前的 activity 表一样：写入后不再修改。

是纯文本、按月分文件：跟着仓库一起同步、备份，出了问题也能直接打开看。

自动保存每 400ms 一次，每次都记一条「改过」就成了噪音（以前一个月六百多条），
同一篇文档的 updated 五分钟内只记一次；其它动作（新建、完成、归档…）每次都记。
============================================================ */

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;

const UPDATE_THROTTLE_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// UTC 毫秒
    pub at: i64,
    /// 本地日期，按天聚合直接用它
    pub date: String,
    pub entity: String,
    pub id: String,
    pub action: String,
    /// 补充说明：任务的标题（任务没有稳定的 id，只有它所在的文档）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub struct Log {
    dir: PathBuf,
    last_update: HashMap<String, i64>,
}

impl Log {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            last_update: HashMap::new(),
        }
    }

    pub fn record(&mut self, entity: &str, id: &str, action: &str) {
        self.record_with(entity, id, action, None);
    }

    pub fn record_with(&mut self, entity: &str, id: &str, action: &str, detail: Option<&str>) {
        let at = crate::db::now_ms();
        if action == "updated" {
            if let Some(last) = self.last_update.get(id) {
                if at - last < UPDATE_THROTTLE_MS {
                    return;
                }
            }
            self.last_update.insert(id.to_string(), at);
        }
        let entry = Entry {
            at,
            date: crate::db::local_date_of(at),
            entity: entity.to_string(),
            id: id.to_string(),
            action: action.to_string(),
            detail: detail.map(str::to_string),
        };
        // 日志写不进去不该让保存失败
        if let Err(error) = append(&self.dir, &[entry]) {
            eprintln!("写行为日志失败: {error}");
        }
    }
}

/// 按条目的本地日期追加到对应月份的文件
pub fn append(dir: &Path, entries: &[Entry]) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let mut by_month: HashMap<&str, String> = HashMap::new();
    for entry in entries {
        let month = entry.date.get(..7).unwrap_or("unknown");
        let line = by_month.entry(month).or_default();
        line.push_str(&serde_json::to_string(entry)?);
        line.push('\n');
    }
    for (month, text) in by_month {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(format!("{month}.jsonl")))?;
        file.write_all(text.as_bytes())?;
    }
    Ok(())
}

#[cfg(test)]
pub fn read_all(dir: &Path) -> Vec<Entry> {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
        .unwrap_or_default();
    files.sort();
    files
        .iter()
        .flat_map(|path| {
            std::fs::read_to_string(path)
                .unwrap_or_default()
                .lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect::<Vec<_>>()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_by_month_and_throttles_autosave_updates() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = Log::new(dir.path().to_path_buf());
        log.record("note", "n1", "created");
        log.record("note", "n1", "updated");
        log.record("note", "n1", "updated");
        log.record("note", "n2", "updated");
        log.record("task", "t1", "completed");
        log.record("task", "t1", "reopened");

        let actions: Vec<_> = read_all(dir.path())
            .into_iter()
            .map(|entry| format!("{}:{}", entry.id, entry.action))
            .collect();
        assert_eq!(
            actions,
            vec!["n1:created", "n1:updated", "n2:updated", "t1:completed", "t1:reopened"]
        );
    }

    #[test]
    fn old_entries_land_in_their_own_month() {
        let dir = tempfile::tempdir().unwrap();
        let entry = |date: &str| Entry {
            at: 0,
            date: date.into(),
            entity: "task".into(),
            id: "t".into(),
            action: "completed".into(),
            detail: None,
        };
        append(dir.path(), &[entry("2026-08-29"), entry("2026-09-01")]).unwrap();
        assert!(dir.path().join("2026-08.jsonl").exists());
        assert!(dir.path().join("2026-09.jsonl").exists());
    }
}
