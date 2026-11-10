/* ============================================================
日程在仓库上的操作：某一天、某个周期的目标、勾任务、日历上的记号。

用的是核心给插件开的那几样（Vault 的「插件的文档」一节）：按类型取一篇（磁盘上有、后台还没读到的当场
读进来）、按类型存一篇（位置照路径规则，标题和正文都空了就删掉文件），以及读写文件、记行为日志、通知前端。
============================================================ */

use crate::db::now_ms;
use crate::domain::model::{DocRef, VaultChange, NOTE};
use crate::error::{AppError, Result};
use crate::vault::index::{self, DocRow};
use crate::vault::{frontmatter, Vault};

use super::model::{CalendarMarks, DayDoc, Goal, Task};
use super::tasks::{self, TaskRow};
use super::{goal_key, goal_title, month_day, validate_period_start, DAY, GOAL, ID};

/// 日程在仓库上的操作。Vault 实现它；用之前 `use crate::plugins::journal::JournalVault`
pub trait JournalVault {
    /// 某一天的文档。`carry` 只在请求「今天」时为 true：今天还没写过，就延续之前最近写过的一天
    /// （不落库，用户一编辑才以今天的身份写文件）
    fn day(&mut self, date: &str, carry: bool) -> Result<DayDoc>;
    /// 写某一天。标题和正文都清空了就删掉这个文件 —— 空文件留在文件夹里只是杂物。
    /// base 同 note_save：编辑器照着改的那一版正文的指纹，磁盘上已经不是那一版了就先另存冲突副本
    fn save_day_on(&mut self, date: &str, title: &str, body: &str, base: Option<&str>) -> Result<DayDoc>;
    /// 不带 base 的这个是测试搭场景用的
    #[cfg(test)]
    fn save_day(&mut self, date: &str, title: &str, body: &str) -> Result<DayDoc> {
        self.save_day_on(date, title, body, None)
    }
    /// 某个周期的目标。没写过的周期返回空文档（id 为空、updated_at 为 0）
    fn goal(&mut self, horizon: &str, period_start: &str) -> Result<Goal>;
    /// 写某个周期的目标。base 同 note_save
    fn save_goal_on(&mut self, horizon: &str, period_start: &str, body: &str, base: Option<&str>) -> Result<Goal>;
    #[cfg(test)]
    fn save_goal(&mut self, horizon: &str, period_start: &str, body: &str) -> Result<Goal> {
        self.save_goal_on(horizon, period_start, body, None)
    }
    /// 勾选日历里的一条任务 = 改它所在文件里的那一行
    fn toggle_task(&mut self, id: &str) -> Result<Task>;
    /// 日历月网格上的记号：写过记录 / 做过事的日子，和还有待办的日子
    fn calendar_marks(&self, from: &str, to: &str) -> Result<CalendarMarks>;
    /// 日历上有记号的所有日子（不分哪一种）
    #[cfg(test)]
    fn marked_dates(&self, from: &str, to: &str) -> Result<Vec<String>> {
        let marks = self.calendar_marks(from, to)?;
        let mut all: Vec<String> = marks.written.into_iter().chain(marks.open).collect();
        all.sort();
        all.dedup();
        Ok(all)
    }
}

/// 日程关着时这些操作不做（不往别人的文件夹里建日记）
fn require(vault: &Vault) -> Result<()> {
    if vault.layout().has_plugin(ID) {
        Ok(())
    } else {
        Err(AppError::Invalid("这个仓库没开日程（命令面板「启用日程」）".into()))
    }
}

/// 之前最近一天写过东西的（今日TODO 的延续）。不是 UTF-8 的那天不算：延续过来的是换过字的乱码
fn latest_day_before(vault: &Vault, date: &str) -> Result<Option<DocRow>> {
    index::one(
        vault.db(),
        "kind = ?1 AND key < ?2 AND (title != '' OR content_md != '') AND not_utf8 = 0
         ORDER BY key DESC LIMIT 1",
        rusqlite::params![DAY, date],
    )
}

impl JournalVault for Vault {
    fn day(&mut self, date: &str, carry: bool) -> Result<DayDoc> {
        require(self)?;
        let doc = DocRef::new(DAY, date);
        let row = self.typed_doc(&doc)?;
        let tasks = tasks::tasks_due(self.db(), date)?.iter().map(task_from_row).collect();
        if let Some(row) = row {
            return Ok(DayDoc {
                date: date.to_string(),
                title: row.title,
                tasks,
                note_md: row.content_md,
                updated_at: row.updated_at,
                carried_from: None,
                rel_path: row.rel_path,
                not_utf8: row.not_utf8,
            });
        }
        // 还没写过：给它将来的位置（延续来的内容也是以今天的身份写到这里）
        let rel_path = self.typed_path(&doc)?;
        if carry {
            if let Some(previous) = latest_day_before(self, date)? {
                return Ok(DayDoc {
                    date: date.to_string(),
                    title: previous.title,
                    tasks,
                    note_md: previous.content_md,
                    updated_at: previous.updated_at,
                    carried_from: previous.key,
                    rel_path,
                    not_utf8: false,
                });
            }
        }
        Ok(DayDoc {
            date: date.to_string(),
            title: String::new(),
            tasks,
            note_md: String::new(),
            updated_at: now_ms(),
            carried_from: None,
            rel_path,
            not_utf8: false,
        })
    }

    fn save_day_on(&mut self, date: &str, title: &str, body: &str, base: Option<&str>) -> Result<DayDoc> {
        require(self)?;
        self.save_typed(&DocRef::new(DAY, date), body, base, |meta| {
            meta.title = (!title.is_empty()).then(|| title.to_string());
        })?;
        self.day(date, false)
    }

    fn goal(&mut self, horizon: &str, period_start: &str) -> Result<Goal> {
        require(self)?;
        validate_period_start(horizon, period_start)?;
        let doc = DocRef::new(GOAL, goal_key(horizon, period_start));
        Ok(match self.typed_doc(&doc)? {
            Some(row) => Goal {
                id: row.id,
                horizon: horizon.to_string(),
                title: row.title,
                period_start: period_start.to_string(),
                content_md: row.content_md,
                created_at: row.created_at,
                updated_at: row.updated_at,
                rel_path: row.rel_path,
                not_utf8: row.not_utf8,
            },
            None => Goal {
                id: String::new(),
                horizon: horizon.to_string(),
                title: String::new(),
                period_start: period_start.to_string(),
                content_md: String::new(),
                created_at: 0,
                updated_at: 0,
                rel_path: self.typed_path(&doc)?,
                not_utf8: false,
            },
        })
    }

    fn save_goal_on(&mut self, horizon: &str, period_start: &str, body: &str, base: Option<&str>) -> Result<Goal> {
        require(self)?;
        validate_period_start(horizon, period_start)?;
        self.save_typed(&DocRef::new(GOAL, goal_key(horizon, period_start)), body, base, |_| {})?;
        self.goal(horizon, period_start)
    }

    fn toggle_task(&mut self, id: &str) -> Result<Task> {
        let task = tasks::task(self.db(), id)?.ok_or_else(|| AppError::NotFound(format!("task {id}")))?;
        let row = index::by_id(self.db(), &task.doc_id)?
            .ok_or_else(|| AppError::NotFound(format!("task {id} 所在的文档")))?;
        let text = self
            .read(&row.rel_path)?
            .ok_or_else(|| AppError::NotFound(format!("task {id} 所在的文件")))?;
        let (meta, body) = frontmatter::split(&text);
        let mut lines: Vec<String> = body.split('\n').map(str::to_string).collect();

        // 行号对得上就用它；对不上（文件在索引之后被改过）就找原文一样的那一行，
        // 只有唯一一行时才动 —— 宁可报错，也不勾错
        let line = if lines.get(task.line).is_some_and(|line| *line == task.raw) {
            task.line
        } else {
            let found: Vec<usize> = lines
                .iter()
                .enumerate()
                .filter(|(_, line)| **line == task.raw)
                .map(|(index, _)| index)
                .collect();
            match found.as_slice() {
                [only] => *only,
                _ => {
                    return Err(AppError::Invalid(
                        "这条任务所在的文档刚被改过，找不到它了，刷新后再试".into(),
                    ))
                }
            }
        };
        lines[line] = tasks::toggle_line(&lines[line])
            .ok_or_else(|| AppError::Invalid(format!("第 {} 行不是任务", line + 1)))?;

        let mut change = VaultChange::default();
        let saved = self.write_and_index(
            &row.rel_path,
            &frontmatter::render(&meta, &lines.join("\n")),
            &mut change,
        )?;
        let done = !task.done;
        self.log_mut().record_with(
            "task",
            &saved.id,
            if done { "completed" } else { "reopened" },
            Some(&task.title),
        );
        // 前端手里这篇文档的正文过时了：连同它一起通知
        change.touch_plugin(ID);
        self.announce(change);

        tasks::task(self.db(), &tasks::task_id(&saved.id, line))?
            .map(|row| task_from_row(&row))
            .ok_or_else(|| AppError::Internal(format!("task {id} 勾选后读不到")))
    }

    fn calendar_marks(&self, from: &str, to: &str) -> Result<CalendarMarks> {
        let (written, open) = tasks::calendar_marks(self.db(), from, to)?;
        Ok(CalendarMarks { written, open })
    }
}

/// 灰色小字：分类 · 时间 · 出处（某一天是「9月26日」，目标是「第 39 周目标」，笔记是它的标题）
fn task_from_row(row: &TaskRow) -> Task {
    let key = row.doc_key.clone().unwrap_or_default();
    let source = if row.doc_kind == NOTE {
        DocRef::note(&row.doc_id)
    } else {
        DocRef::new(&row.doc_kind, &key)
    };
    let label = match row.doc_kind.as_str() {
        DAY => month_day(&key),
        GOAL => key.split_once(':').map_or_else(String::new, |(horizon, start)| goal_title(horizon, start)),
        _ => row.doc_title.clone(),
    };
    let meta = [row.category.clone(), row.time_label.clone(), Some(label)]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    Task {
        id: row.id.clone(),
        title: row.title.clone(),
        status: (if row.done { "done" } else { "todo" }).to_string(),
        meta: (!meta.is_empty()).then_some(meta),
        due_date: Some(row.due_date.clone()),
        time_label: row.time_label.clone(),
        category: row.category.clone(),
        source: Some(source),
        line: Some(row.line as i64),
    }
}
