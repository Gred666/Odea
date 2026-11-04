/* ============================================================
从旧版的 SQLite 库（ontheway.db）搬日程的那部分（核心那部分和整个流程见 vault/legacy.rs）：
写过东西的每一天、每个周期的目标、带日期的任务。

带日期的任务没有文档可挂，写进它那一天的文档末尾的「## 当日安排」，变成普通的
`- [ ] 标题 @日期 时间 #分类`。
============================================================ */

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::error::Result;
use crate::vault::frontmatter::FrontMatter;
use crate::vault::legacy::write_file;

use super::{day_path, goal_path, tasks};

struct LegacyTask {
    title: String,
    done: bool,
    due_date: String,
    time_label: Option<String>,
    category: Option<String>,
}

/// `- [x] 回顾第 35 周目标 @2026-08-29 16:00 #GOAL`
fn task_line(task: &LegacyTask) -> String {
    let mut line = format!("- [{}] {}", if task.done { "x" } else { " " }, task.title.trim());
    let mut tail = format!(" @{}", task.due_date);
    if let Some(label) = task.time_label.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
        if tasks::is_time(label) {
            tail.push(' ');
            tail.push_str(label);
        } else {
            // 认不出来的时间写进标题，别丢
            line.push_str(&format!("（{label}）"));
        }
    }
    let tag: String = task
        .category
        .as_deref()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '/' && *c != '#')
        .collect();
    if tag.chars().any(|c| !c.is_ascii_digit()) {
        tail.push_str(&format!(" #{tag}"));
    }
    line.push_str(&tail);
    line
}

/// 返回搬了几天、几个目标、几条任务
pub fn import(conn: &Connection, root: &Path, written: &mut Vec<PathBuf>) -> Result<Vec<(&'static str, usize)>> {
    let mut days_written = 0;
    let mut goals_written = 0;
    let mut tasks_written = 0;

    /* ---------- 带日期的任务：按日期归到那一天 ---------- */
    let mut stmt = conn.prepare(
        "SELECT title, status, due_date, time_label, category FROM task
         WHERE deleted_at IS NULL AND due_date IS NOT NULL ORDER BY due_date, sort_key, created_at",
    )?;
    let mut tasks_by_day: BTreeMap<String, Vec<LegacyTask>> = BTreeMap::new();
    for task in stmt.query_map([], |r| {
        Ok(LegacyTask {
            title: r.get(0)?,
            done: r.get::<_, String>(1)? == "done",
            due_date: r.get(2)?,
            time_label: r.get(3)?,
            category: r.get(4)?,
        })
    })? {
        let task = task?;
        tasks_by_day.entry(task.due_date.clone()).or_default().push(task);
    }

    /* ---------- 每一天 ---------- */
    let mut stmt = conn.prepare("SELECT date, title, note_md, updated_at FROM day_doc ORDER BY date")?;
    let mut days: BTreeMap<String, (String, String, i64)> = BTreeMap::new();
    for row in stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
        ))
    })? {
        let (date, title, body, updated) = row?;
        days.insert(date, (title, body, updated));
    }
    let dates: Vec<String> = days
        .keys()
        .chain(tasks_by_day.keys())
        .cloned()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    for date in dates {
        let (title, mut body, updated) = days.remove(&date).unwrap_or_default();
        if let Some(list) = tasks_by_day.get(&date) {
            let section = list.iter().map(task_line).collect::<Vec<_>>().join("\n");
            let trimmed = body.trim_end().to_string();
            body = if trimmed.is_empty() {
                format!("## 当日安排\n\n{section}")
            } else {
                format!("{trimmed}\n\n## 当日安排\n\n{section}")
            };
            tasks_written += list.len();
        }
        if title.is_empty() && body.trim().is_empty() {
            continue;
        }
        let meta = FrontMatter {
            title: (!title.is_empty()).then_some(title),
            ..FrontMatter::default()
        };
        write_file(root, &day_path(&date)?, &meta, &body, updated, written)?;
        days_written += 1;
    }

    /* ---------- 目标 ---------- */
    let mut stmt = conn.prepare(
        "SELECT horizon, period_start, content_md, updated_at FROM goal
         WHERE deleted_at IS NULL AND content_md != '' ORDER BY period_start",
    )?;
    let goals = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (horizon, period_start, body, updated) in goals {
        // 旧库里周期起点不合法的（理论上不会有）跳过，不因为一条坏数据整个搬家失败
        let Ok(rel) = goal_path(&horizon, &period_start) else {
            continue;
        };
        write_file(root, &rel, &FrontMatter::default(), &body, updated, written)?;
        goals_written += 1;
    }

    Ok(vec![("days", days_written), ("goals", goals_written), ("tasks", tasks_written)])
}
