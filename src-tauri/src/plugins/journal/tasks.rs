/* ============================================================
正文里带日期的任务 —— 日历「当日安排」的唯一来源。

任务只有一个来源：Markdown 的 `- [ ]`。写上日期，它就会出现在那一天的日历里：

    - [ ] 完成编辑器专注模式原型 @2026-09-04
    - [ ] 力量训练 @2026-08-29 18:30 #健康
    - [x] 回顾第 35 周目标 📅 2026-08-29 下午 #GOAL

- 日期：`@YYYY-MM-DD`，或 Obsidian Tasks 的写法 `📅 YYYY-MM-DD`
- 时间（可选，紧跟在日期后面）：`HH:MM`，或 上午 / 中午 / 下午 / 晚上 / 全天
- 分类（可选）：第一个 `#标签`（纯数字的 `#1` 不算）
- 围栏代码块里的不算

在日历里勾选，改的是原文件里的那一行。

这是日程插件的 Rust 那一半（docs/插件与跨端.md §5.1 的 L2）：扫正文、记进索引里另存的 task 表都在这里，
核心的索引只在写入、删除一篇时叫它一声（plugins::IndexPart）。
============================================================ */

use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::Result;
use crate::plugins::IndexPart;
use crate::vault::index::DocRow;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledTask {
    /// 正文里的第几行（从 0 开始，不含属性块）
    pub line: usize,
    /// 那一行的原文，勾选前用它核对行号还对不对
    pub raw: String,
    pub title: String,
    pub done: bool,
    pub due_date: String,
    pub time_label: Option<String>,
    pub category: Option<String>,
}

const TIME_WORDS: [&str; 5] = ["上午", "中午", "下午", "晚上", "全天"];

pub fn scan(body: &str) -> Vec<ScheduledTask> {
    let mut out = Vec::new();
    let mut fence: Option<char> = None;
    for (line, raw) in body.split('\n').enumerate() {
        let trimmed = raw.trim_start();
        let indent = raw.len() - trimmed.len();
        if indent <= 3 {
            let marker = trimmed.chars().next().filter(|c| *c == '`' || *c == '~');
            if let Some(c) = marker {
                if trimmed.starts_with(&c.to_string().repeat(3)) {
                    match fence {
                        None => fence = Some(c),
                        Some(open) if open == c => fence = None,
                        _ => {}
                    }
                    continue;
                }
            }
        }
        if fence.is_some() {
            continue;
        }
        if let Some(task) = parse_line(line, raw) {
            out.push(task);
        }
    }
    out
}

/// `- [ ] `、`* [x] `、`1. [ ] ` 之后的位置，以及勾选框里那个字符的字节位置
fn checkbox(raw: &str) -> Option<(usize, usize)> {
    let trimmed = raw.trim_start();
    let start = raw.len() - trimmed.len();
    let bytes = trimmed.as_bytes();
    let mut i = 0;
    if matches!(bytes.first(), Some(b'-' | b'*' | b'+')) {
        i = 1;
    } else {
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == 0 || i > 9 || !matches!(bytes.get(i), Some(b'.' | b')')) {
            return None;
        }
        i += 1;
    }
    if !matches!(bytes.get(i), Some(b' ' | b'\t')) {
        return None;
    }
    while matches!(bytes.get(i), Some(b' ' | b'\t')) {
        i += 1;
    }
    if bytes.get(i) != Some(&b'[')
        || !matches!(bytes.get(i + 1), Some(b' ' | b'x' | b'X'))
        || bytes.get(i + 2) != Some(&b']')
    {
        return None;
    }
    let after = i + 3;
    if !matches!(bytes.get(after), None | Some(b' ' | b'\t')) {
        return None;
    }
    Some((start + after, start + i + 1))
}

fn parse_line(line: usize, raw: &str) -> Option<ScheduledTask> {
    let (text_start, mark) = checkbox(raw)?;
    let done = raw.as_bytes()[mark] != b' ';
    let text = &raw[text_start..];

    let mut due_date = None;
    let mut time_label = None;
    let mut category = None;
    let mut words: Vec<&str> = Vec::new();

    let tokens: Vec<&str> = text.split_whitespace().collect();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        index += 1;

        // 📅 和日期之间可以有空格
        let date = if let Some(rest) = token.strip_prefix('@') {
            Some(rest)
        } else if let Some(rest) = token.strip_prefix('📅') {
            if rest.is_empty() {
                let next = tokens.get(index).copied();
                if next.is_some() {
                    index += 1;
                }
                next
            } else {
                Some(rest)
            }
        } else {
            None
        };
        if let Some(date) = date.filter(|date| is_date(date)) {
            if due_date.is_none() {
                due_date = Some(date.to_string());
                if let Some(next) = tokens.get(index).filter(|next| is_time(next)) {
                    time_label = Some((*next).to_string());
                    index += 1;
                }
                continue;
            }
        }

        if let Some(tag) = token.strip_prefix('#') {
            // 和 Obsidian 一样，纯数字不算标签（`#1` 多半是编号）
            if !tag.contains('#') && tag.chars().any(|c| !c.is_ascii_digit()) {
                if category.is_none() {
                    category = Some(tag.to_string());
                }
                continue;
            }
        }
        words.push(token);
    }

    // 只有日期、没写事情的（模板里留给人填的 `- [ ] @2026-09-28 `）不进日历：
    // 日历上一条空白的安排什么也说明不了
    if words.is_empty() {
        return None;
    }

    Some(ScheduledTask {
        line,
        raw: raw.to_string(),
        title: words.join(" "),
        done,
        due_date: due_date?,
        time_label,
        category,
    })
}

fn is_date(s: &str) -> bool {
    s.len() == 10 && NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

pub fn is_time(s: &str) -> bool {
    if TIME_WORDS.contains(&s) {
        return true;
    }
    let Some((hour, minute)) = s.split_once(':') else {
        return false;
    };
    let hour_ok = (1..=2).contains(&hour.len())
        && hour.parse::<u32>().is_ok_and(|hour| hour < 24);
    let minute_ok = minute.len() == 2 && minute.parse::<u32>().is_ok_and(|minute| minute < 60);
    hour_ok && minute_ok
}

/// 勾上 / 取消勾选这一行。不是任务行返回 None。
pub fn toggle_line(raw: &str) -> Option<String> {
    let (_, mark) = checkbox(raw)?;
    let next = if raw.as_bytes()[mark] == b' ' { "x" } else { " " };
    let mut out = String::with_capacity(raw.len());
    out.push_str(&raw[..mark]);
    out.push_str(next);
    out.push_str(&raw[mark + 1..]);
    Some(out)
}

/* ---------------- 在索引里另存的那一张表（plugins::IndexPart） ----------------
   每篇文档（笔记、某一天、目标都算）读进索引时扫一遍正文，带日期的任务记进 task 表，和文档同一个事务。
   日历的当日安排、月网格上的记号都从这里查 */

const SCHEMA: &str = "
CREATE TABLE task (
  id         TEXT    PRIMARY KEY,           -- 文档 id # 行号
  doc_id     TEXT    NOT NULL,
  line       INTEGER NOT NULL,
  raw        TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  done       INTEGER NOT NULL,
  due_date   TEXT    NOT NULL,
  time_label TEXT,
  category   TEXT
);
CREATE INDEX task_doc ON task(doc_id);
CREATE INDEX task_due ON task(due_date);
";

pub struct Tasks;

pub static TASKS: Tasks = Tasks;

impl IndexPart for Tasks {
    fn plugin(&self) -> &'static str {
        super::ID
    }

    fn schema(&self) -> &'static str {
        SCHEMA
    }

    fn tables(&self) -> &'static [&'static str] {
        &["task"]
    }

    /// 按正文重新记这一篇的任务。和它上一次的那几条比：行号、原文都一样就算没变（日历不用刷新）
    fn put(&self, conn: &Connection, doc: &DocRow, replaced: &[String]) -> Result<bool> {
        let scheduled = scan(&doc.content_md);
        let mut previous = Vec::new();
        for id in replaced {
            previous.extend(doc_tasks(conn, id)?);
        }
        let same = previous.len() == scheduled.len()
            && previous
                .iter()
                .zip(&scheduled)
                .all(|(a, b)| a.line == b.line && a.raw == b.raw);
        for id in replaced {
            conn.execute("DELETE FROM task WHERE doc_id = ?1", params![id])?;
        }
        for task in &scheduled {
            conn.execute(
                "INSERT INTO task (id, doc_id, line, raw, title, done, due_date, time_label, category)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    task_id(&doc.id, task.line),
                    doc.id,
                    task.line as i64,
                    task.raw,
                    task.title,
                    task.done as i64,
                    task.due_date,
                    task.time_label,
                    task.category,
                ],
            )?;
        }
        Ok(!same)
    }

    fn remove(&self, conn: &Connection, id: &str) -> Result<bool> {
        Ok(conn.execute("DELETE FROM task WHERE doc_id = ?1", params![id])? > 0)
    }
}

pub fn task_id(doc_id: &str, line: usize) -> String {
    format!("{doc_id}#{line}")
}

/// 一篇文档当前索引里的任务，用来判断这次写入有没有改到日历
fn doc_tasks(conn: &Connection, doc_id: &str) -> Result<Vec<ScheduledTask>> {
    let mut stmt = conn.prepare(
        "SELECT line, raw, title, done, due_date, time_label, category
         FROM task WHERE doc_id = ?1 ORDER BY line",
    )?;
    let rows = stmt.query_map(params![doc_id], |r| {
        Ok(ScheduledTask {
            line: r.get::<_, i64>(0)? as usize,
            raw: r.get(1)?,
            title: r.get(2)?,
            done: r.get::<_, i64>(3)? != 0,
            due_date: r.get(4)?,
            time_label: r.get(5)?,
            category: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 日历上的一条任务，带着它所在的文档
#[derive(Debug, Clone)]
pub struct TaskRow {
    pub id: String,
    pub doc_id: String,
    pub line: usize,
    pub raw: String,
    pub title: String,
    pub done: bool,
    pub due_date: String,
    pub time_label: Option<String>,
    pub category: Option<String>,
    /// 所在文档的类型（note，或者插件的文档类型）、key、标题
    pub doc_kind: String,
    pub doc_key: Option<String>,
    pub doc_title: String,
}

const TASK_COLUMNS: &str = "t.id, t.doc_id, t.line, t.raw, t.title, t.done, t.due_date,
    t.time_label, t.category, d.kind, d.key, d.title AS doc_title";

fn task_row(r: &Row) -> rusqlite::Result<TaskRow> {
    Ok(TaskRow {
        id: r.get("id")?,
        doc_id: r.get("doc_id")?,
        line: r.get::<_, i64>("line")? as usize,
        raw: r.get("raw")?,
        title: r.get("title")?,
        done: r.get::<_, i64>("done")? != 0,
        due_date: r.get("due_date")?,
        time_label: r.get("time_label")?,
        category: r.get("category")?,
        doc_kind: r.get("kind")?,
        doc_key: r.get("key")?,
        doc_title: r.get("doc_title")?,
    })
}

/// 某一天的任务。那一天自己的文档里写的不算 —— 它们就在正文里，不用再列一遍。
/// 归档笔记里的也不算。先列没写时间的，再按一天里的先后（上午算 9 点、下午 14 点…）。
pub fn tasks_due(conn: &Connection, date: &str) -> Result<Vec<TaskRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TASK_COLUMNS} FROM task t JOIN doc d ON d.id = t.doc_id
         WHERE t.due_date = ?1 AND NOT (d.kind = ?2 AND d.key = ?1) AND d.is_archived = 0
         ORDER BY t.time_label IS NOT NULL,
           CASE t.time_label
             WHEN '全天' THEN '00:00' WHEN '上午' THEN '09:00' WHEN '中午' THEN '12:00'
             WHEN '下午' THEN '14:00' WHEN '晚上' THEN '19:00'
             ELSE substr('0' || t.time_label, -5)
           END,
           d.rel_path, t.line"
    ))?;
    let rows = stmt.query_map(params![date, super::DAY], task_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn task(conn: &Connection, id: &str) -> Result<Option<TaskRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {TASK_COLUMNS} FROM task t JOIN doc d ON d.id = t.doc_id WHERE t.id = ?1"),
            params![id],
            task_row,
        )
        .optional()?)
}

/// 日历上的记号。written：写过记录的日子，和有做完了的任务的日子；
/// open：还有没做完的任务的日子。归档里的文档不算
pub fn calendar_marks(
    conn: &Connection,
    from: &str,
    to: &str,
) -> Result<(Vec<String>, Vec<String>)> {
    let dates = |sql: &str, args: &[&dyn rusqlite::ToSql]| -> Result<Vec<String>> {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(args, |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    };
    let written = dates(
        "SELECT DISTINCT d FROM (
           SELECT key AS d FROM doc WHERE kind = ?3 AND (title != '' OR content_md != '')
           UNION
           SELECT t.due_date AS d FROM task t JOIN doc x ON x.id = t.doc_id
             WHERE x.is_archived = 0 AND t.done = 1
         )
         WHERE d BETWEEN ?1 AND ?2
         ORDER BY d",
        params![from, to, super::DAY],
    )?;
    let open = dates(
        "SELECT DISTINCT t.due_date FROM task t JOIN doc x ON x.id = t.doc_id
         WHERE x.is_archived = 0 AND t.done = 0 AND t.due_date BETWEEN ?1 AND ?2
         ORDER BY t.due_date",
        params![from, to],
    )?;
    Ok((written, open))
}


#[cfg(test)]
mod tests {
    use super::*;

    fn one(line: &str) -> Option<ScheduledTask> {
        scan(line).into_iter().next()
    }

    #[test]
    fn parses_date_time_and_tag() {
        let task = one("- [ ] 力量训练 @2026-08-29 18:30 #健康").unwrap();
        assert_eq!(task.title, "力量训练");
        assert!(!task.done);
        assert_eq!(task.due_date, "2026-08-29");
        assert_eq!(task.time_label.as_deref(), Some("18:30"));
        assert_eq!(task.category.as_deref(), Some("健康"));
    }

    #[test]
    fn accepts_obsidian_tasks_dates_and_word_times() {
        let task = one("  * [X] 回顾第 35 周目标 📅 2026-08-29 下午 #GOAL").unwrap();
        assert!(task.done);
        assert_eq!(task.title, "回顾第 35 周目标");
        assert_eq!(task.time_label.as_deref(), Some("下午"));
        assert_eq!(task.category.as_deref(), Some("GOAL"));

        let numbered = one("3. [ ] 交稿 📅2026-09-04").unwrap();
        assert_eq!(numbered.due_date, "2026-09-04");
        assert_eq!(numbered.title, "交稿");
    }

    #[test]
    fn tasks_without_a_real_date_are_not_scheduled() {
        assert!(one("- [ ] 没有日期的任务").is_none());
        assert!(one("- [ ] 邮件发到 a@2026-13-01").is_none());
        assert!(one("- 不是任务 @2026-09-01").is_none());
        assert!(one("- [ ]紧挨着 @2026-09-01").is_none());
        assert!(one("[ ] 没有列表符号 @2026-09-01").is_none());
    }

    #[test]
    fn tasks_with_only_a_date_are_not_scheduled() {
        assert!(one("  - [ ] @2026-09-28 ").is_none());
        assert!(one("- [ ] @2026-09-28 14:00 #工作").is_none());
        let filled = one("  - [ ] @2026-09-28 14:00 开会").unwrap();
        assert_eq!(filled.title, "开会");
        assert_eq!(filled.time_label.as_deref(), Some("14:00"));
    }

    #[test]
    fn keeps_words_that_only_look_like_tokens() {
        let task = one("- [ ] 讨论 C# 和 #1 问题 @2026-09-01 9:00").unwrap();
        assert_eq!(task.title, "讨论 C# 和 #1 问题");
        assert_eq!(task.category, None);
        assert_eq!(task.time_label.as_deref(), Some("9:00"));
    }

    #[test]
    fn skips_fenced_code_and_counts_lines() {
        let body = "开头\n\n```md\n- [ ] 示例 @2026-09-01\n```\n\n- [ ] 真的 @2026-09-02\n";
        let tasks = scan(body);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "真的");
        assert_eq!(tasks[0].line, 6);
    }

    #[test]
    fn toggles_only_the_checkbox() {
        assert_eq!(
            toggle_line("  - [ ] 事情 [x] @2026-09-01").as_deref(),
            Some("  - [x] 事情 [x] @2026-09-01")
        );
        assert_eq!(toggle_line("1) [X] 完成").as_deref(), Some("1) [ ] 完成"));
        assert!(toggle_line("- 普通列表").is_none());
    }
}
