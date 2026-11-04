/* ============================================================
日程的命令：以前在 commands.rs 里的那 8 个专用命令，6 个搬到这里；列出写过的日记和目标、
开关日程成了核心的通用命令（doc_list、vault_set_plugin）。名字没改，前端照旧调 commands.calendarDay 这些
============================================================ */

use crate::commands::with_vault;
use crate::domain::validate_date;
use crate::error::Result;
use crate::state::Ws;

use super::model::{CalendarMarks, DayDoc, Goal, Task};
use super::JournalVault;

/// 勾选日历里的一条任务：改的是它所在文件里的那一行
#[tauri::command]
#[specta::specta]
pub async fn task_toggle(ws: Ws, id: String) -> Result<Task> {
    with_vault(&ws, move |v| v.toggle_task(&id)).await
}

/// 某个周期的目标。period_start 由前端按 horizon 算好（周一 / 1 号 / 1 月 1 日），
/// 这里校验它确实是周期起点。没写过的周期返回空文档。
#[tauri::command]
#[specta::specta]
pub async fn goal_get(ws: Ws, horizon: String, period_start: String) -> Result<Goal> {
    validate_date(&period_start)?;
    with_vault(&ws, move |v| v.goal(&horizon, &period_start)).await
}

#[tauri::command]
#[specta::specta]
pub async fn goal_save(
    ws: Ws,
    horizon: String,
    period_start: String,
    content_md: String,
    base: Option<String>,
) -> Result<Goal> {
    validate_date(&period_start)?;
    with_vault(&ws, move |v| v.save_goal_on(&horizon, &period_start, &content_md, base.as_deref())).await
}

/// `carry_over` 只在请求「今天」时传 true：今天还没写过就延续之前最近的一天。
#[tauri::command]
#[specta::specta]
pub async fn calendar_day(ws: Ws, date: String, carry_over: bool) -> Result<DayDoc> {
    validate_date(&date)?;
    with_vault(&ws, move |v| v.day(&date, carry_over)).await
}

#[tauri::command]
#[specta::specta]
pub async fn calendar_day_save(
    ws: Ws,
    date: String,
    title: String,
    note_md: String,
    base: Option<String>,
) -> Result<DayDoc> {
    validate_date(&date)?;
    with_vault(&ws, move |v| v.save_day_on(&date, &title, &note_md, base.as_deref())).await
}

/// 月网格上的记号：写过记录 / 做过事的日子，和还有待办的日子
#[tauri::command]
#[specta::specta]
pub async fn calendar_marks(ws: Ws, from: String, to: String) -> Result<CalendarMarks> {
    validate_date(&from)?;
    validate_date(&to)?;
    with_vault(&ws, move |v| v.calendar_marks(&from, &to)).await
}
