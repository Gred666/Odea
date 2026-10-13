/* ============================================================
从旧版的 SQLite 库（ontheway.db）搬到仓库文件夹。

- 旧库只读：先把 db / wal / shm 三个文件拷到临时目录，在拷贝上迁移到最新
  结构、读出来，原文件一个字节都不碰。搬完之后旧库还留在原地，当备份。
- 搬什么：没删的笔记（归档的进「归档」）、写过东西的每一天、每个周期的目标、
  带日期的任务、行为日志。软删除的笔记不搬（旧库里还在）。
- 时间：创建时间写进属性块，更新时间设成文件的修改时间 —— 列表里的
  「上次更新」和排序都和搬之前一样。
- 带日期的任务没有文档可挂，写进它那一天的文档末尾的「## 当日安排」，
  变成普通的 `- [ ] 标题 @日期 时间 #分类`。
- 中途失败就把已经写出来的文件删掉，下次启动从头再来，不会出现半套重复的笔记。
============================================================ */

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};

use super::activity::{self, Entry};
use super::frontmatter::{self, FrontMatter};
use super::{fsio, layout, tasks};
use crate::error::Result;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub notes: usize,
    pub archived: usize,
    pub days: usize,
    pub goals: usize,
    pub tasks: usize,
    pub activities: usize,
}

/// 旧库里有没有值得搬的东西（新装的应用没有旧库；旧库存在但是空的也不搬）
pub fn has_data(db_path: &Path) -> bool {
    if !db_path.is_file() {
        return false;
    }
    let Ok(conn) = Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return false;
    };
    conn.query_row(
        "SELECT (SELECT count(*) FROM note) + (SELECT count(*) FROM day_doc) + (SELECT count(*) FROM goal)",
        [],
        |r| r.get::<_, i64>(0),
    )
    .is_ok_and(|n| n > 0)
}

pub fn import(db_path: &Path, root: &Path, scratch: &Path) -> Result<Report> {
    let copy = copy_database(db_path, scratch)?;
    let result = (|| {
        let mut conn = Connection::open(&copy)?;
        crate::db::migrate::run(&mut conn, &copy)?;
        let mut written = Vec::new();
        let result = write_all(&conn, root, &mut written);
        if result.is_err() {
            for path in written.iter().rev() {
                let _ = std::fs::remove_file(path);
            }
        }
        result
    })();
    let _ = std::fs::remove_dir_all(scratch);
    result
}

fn copy_database(db_path: &Path, scratch: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(scratch)?;
    let copy = scratch.join("legacy.db");
    std::fs::copy(db_path, &copy)?;
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{suffix}", db_path.display()));
        if side.is_file() {
            std::fs::copy(&side, format!("{}{suffix}", copy.display()))?;
        }
    }
    Ok(copy)
}

fn write_file(
    root: &Path,
    rel: &str,
    meta: &FrontMatter,
    body: &str,
    mtime: i64,
    written: &mut Vec<PathBuf>,
) -> Result<()> {
    let path = fsio::abs(root, rel);
    fsio::write_atomic(&path, &frontmatter::render(meta, body))?;
    written.push(path.clone());
    if mtime > 0 {
        fsio::set_mtime(&path, mtime)?;
    }
    Ok(())
}

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

fn write_all(conn: &Connection, root: &Path, written: &mut Vec<PathBuf>) -> Result<Report> {
    let mut report = Report::default();

    /* ---------- 笔记 ---------- */
    let mut stmt = conn.prepare(
        "SELECT id, title, content_md, is_pinned, is_archived, archive_category, archived_at,
                created_at, updated_at
         FROM note WHERE deleted_at IS NULL ORDER BY created_at",
    )?;
    let notes = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)? != 0,
                r.get::<_, i64>(4)? != 0,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<i64>>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, i64>(8)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, title, body, pinned, archived, category, archived_at, created, updated) in notes {
        let dir = if archived {
            layout::ARCHIVE_DIR
        } else {
            layout::NOTES_DIR
        };
        let rel = fsio::unique_rel(root, dir, &layout::file_stem_for_title(&title), None);
        let meta = FrontMatter {
            id: Some(id),
            title: (layout::stem_of(&rel) != title).then(|| title.clone()),
            created: Some(created),
            pinned: pinned && !archived,
            archived: archived.then(|| archived_at.unwrap_or(updated)),
            category: if archived { category } else { None },
            ..FrontMatter::default()
        };
        write_file(root, &rel, &meta, &body, updated, written)?;
        if archived {
            report.archived += 1;
        } else {
            report.notes += 1;
        }
    }

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
            report.tasks += list.len();
        }
        if title.is_empty() && body.trim().is_empty() {
            continue;
        }
        let meta = FrontMatter {
            title: (!title.is_empty()).then_some(title),
            ..FrontMatter::default()
        };
        write_file(root, &layout::day_path(&date)?, &meta, &body, updated, written)?;
        report.days += 1;
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
        let Ok(rel) = layout::goal_path(&horizon, &period_start) else {
            continue;
        };
        write_file(root, &rel, &FrontMatter::default(), &body, updated, written)?;
        report.goals += 1;
    }

    /* ---------- 行为日志 ---------- */
    let mut stmt = conn.prepare(
        "SELECT at, local_date, entity_type, entity_id, action FROM activity ORDER BY id",
    )?;
    let entries = stmt
        .query_map(params![], |r| {
            Ok(Entry {
                at: r.get(0)?,
                date: r.get(1)?,
                entity: r.get(2)?,
                id: r.get(3)?,
                action: r.get(4)?,
                detail: None,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !entries.is_empty() {
        let dir = fsio::abs(root, layout::ACTIVITY_DIR);
        let months: std::collections::BTreeSet<String> = entries
            .iter()
            .map(|entry| entry.date.get(..7).unwrap_or("unknown").to_string())
            .collect();
        activity::append(&dir, &entries)?;
        for month in months {
            written.push(dir.join(format!("{month}.jsonl")));
        }
        report.activities = entries.len();
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;

    /// 按旧版的结构建一个库：迁移到最新，塞几条典型数据
    fn legacy_db(dir: &Path) -> PathBuf {
        let path = dir.join("ontheway.db");
        let mut conn = Connection::open(&path).unwrap();
        crate::db::migrate::run(&mut conn, &path).unwrap();
        conn.execute_batch(
            "INSERT INTO note (id, title, content_md, is_pinned, created_at, updated_at)
               VALUES ('n1', '秋季项目复盘', '正文 [[京都书店清单]]', 1, 1000, 1788000000000);
             INSERT INTO note (id, title, content_md, created_at, updated_at)
               VALUES ('n2', '周报: 第 3 期?', '内容', 1000, 1787000000000);
             INSERT INTO note (id, title, content_md, created_at, updated_at, deleted_at)
               VALUES ('n3', '删掉的', 'x', 1000, 1000, 2000);
             INSERT INTO note (id, title, content_md, is_archived, archive_category, archived_at, created_at, updated_at)
               VALUES ('a1', '旧版路线图', '已替代', 1, '工作笔记', 1786000000000, 1000, 1785000000000);
             INSERT INTO day_doc (date, title, note_md, created_at, updated_at)
               VALUES ('2026-08-29', '完成专注模式原型', '## 检查项\n\n- [ ] 走查', 0, 1788000000000),
                      ('2026-08-30', '', '', 0, 0);
             INSERT INTO goal (id, title, horizon, period_start, content_md, created_at, updated_at)
               VALUES ('g1', '', 'week', '2026-08-24', '本周重点', 0, 1788000000000),
                      ('g2', '', 'month', '2026-09-01', '', 0, 0);
             INSERT INTO task (id, title, status, due_date, time_label, category, sort_key, created_at, updated_at)
               VALUES ('t1', '回顾第 35 周目标', 'done', '2026-08-29', '16:00', '/GOAL', 'a0', 0, 0),
                      ('t2', '力量训练', 'todo', '2026-08-31', '傍晚', '健康', 'a1', 0, 0);
             INSERT INTO activity (at, local_date, entity_type, entity_id, action)
               VALUES (1788000000000, '2026-08-29', 'task', 't1', 'completed');",
        )
        .unwrap();
        drop(conn);
        path
    }

    #[test]
    fn moves_everything_into_files_and_keeps_the_old_db() {
        let dir = tempfile::tempdir().unwrap();
        let db = legacy_db(dir.path());
        let before = std::fs::read(&db).unwrap();
        let root = dir.path().join("vault");

        assert!(has_data(&db));
        let report = import(&db, &root, &dir.path().join("scratch")).unwrap();
        assert_eq!(
            report,
            Report {
                notes: 2,
                archived: 1,
                days: 2,
                goals: 1,
                tasks: 2,
                activities: 1
            }
        );
        assert_eq!(std::fs::read(&db).unwrap(), before, "旧库不该被改动");
        assert!(!dir.path().join("scratch").exists(), "临时拷贝没清掉");

        let read = |rel: &str| std::fs::read_to_string(fsio::abs(&root, rel)).unwrap();
        assert!(read("笔记/秋季项目复盘.md").contains("id: n1\n"));
        assert!(read("笔记/秋季项目复盘.md").contains("pinned: true\n"));
        // 文件名换掉了非法字符，完整标题记在属性块里
        assert!(read("笔记/周报： 第 3 期？.md").contains("title: \"周报: 第 3 期?\""));
        assert!(read("归档/旧版路线图.md").contains("category: \"工作笔记\""));
        assert!(!fsio::abs(&root, "笔记/删掉的.md").exists());
        let day = read("日记/2026/2026-08-29.md");
        assert!(day.contains("title: \"完成专注模式原型\""));
        assert!(day.ends_with("- [ ] 走查\n\n## 当日安排\n\n- [x] 回顾第 35 周目标 @2026-08-29 16:00 #GOAL"));
        // 只有任务、没有文档的那一天也要有文件；认不出来的时间写进标题
        assert_eq!(
            read("日记/2026/2026-08-31.md"),
            "## 当日安排\n\n- [ ] 力量训练（傍晚） @2026-08-31 #健康"
        );
        assert!(!fsio::abs(&root, "日记/2026/2026-08-30.md").exists(), "空的那一天不该建文件");
        assert_eq!(read("目标/2026/2026-W35.md"), "本周重点");
        assert!(!fsio::abs(&root, "目标/2026/2026-09.md").exists());
        assert!(read(".ontheway/activity/2026-08.jsonl").contains("\"completed\""));

        // 修改时间 = 旧库里的更新时间
        let mtime = fsio::stat(&fsio::abs(&root, "笔记/秋季项目复盘.md")).unwrap().0;
        assert_eq!(mtime, 1_788_000_000_000);

        // 仓库打开后，笔记、某一天、目标、任务都在，id 不变
        let mut vault = Vault::open_in_memory(&root);
        let notes = vault.note_list_full(false).unwrap();
        assert_eq!(notes[0].id, "n1", "置顶的排在最前");
        assert!(notes[0].is_pinned);
        assert_eq!(notes[0].updated_at, 1_788_000_000_000);
        assert_eq!(notes[1].title, "周报: 第 3 期?");
        let archived = vault.note_list_full(true).unwrap();
        assert_eq!(archived[0].archive_category.as_deref(), Some("工作笔记"));
        assert_eq!(archived[0].archived_at, Some(1_786_000_000_000));
        assert_eq!(vault.day("2026-08-29", false).unwrap().title, "完成专注模式原型");
        assert_eq!(vault.goal("week", "2026-08-24").unwrap().content_md, "本周重点");
        assert_eq!(
            vault.marked_dates("2026-08-01", "2026-08-31").unwrap(),
            vec!["2026-08-29", "2026-08-31"]
        );
    }

    #[test]
    fn a_failed_import_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let db = legacy_db(dir.path());
        let root = dir.path().join("vault");
        // 让「目标」没法建目录：同名的位置先放一个文件
        fsio::write_atomic(&fsio::abs(&root, "目标"), "挡路").unwrap();

        assert!(import(&db, &root, &dir.path().join("scratch")).is_err());
        let left: Vec<_> = fsio::walk_markdown(&root).into_iter().map(|f| f.rel).collect();
        assert!(left.is_empty(), "失败后还留着: {left:?}");
    }

    #[test]
    fn empty_or_missing_databases_have_nothing_to_move() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!has_data(&dir.path().join("nope.db")));
        let path = dir.path().join("empty.db");
        let mut conn = Connection::open(&path).unwrap();
        crate::db::migrate::run(&mut conn, &path).unwrap();
        drop(conn);
        assert!(!has_data(&path));
    }
}
