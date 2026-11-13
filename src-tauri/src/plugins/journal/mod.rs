/* ============================================================
日程插件（odea.journal）的 Rust 那一半：今日TODO、目标、日历（docs/仓库与启动器.md §6，
docs/插件与跨端.md §6.1）。前端那一半在 src/plugins/journal/。

两种文档，路径规则就是以前 Layout::day_path / goal_path 里写死的那几条：

    日记/2026/2026-09-26.md     某一天（journal.day，key 是日期）。Obsidian 的库是平放的 日记/2026-09-26.md
    目标/2026/2026-W39.md        周目标（journal.goal，key 是 `week:2026-09-21`）
    目标/2026/2026-09.md         月目标（`month:2026-09-01`）
    目标/2026.md                 年目标（`year:2026-01-01`）

文件夹的名字从仓库标记 .odea/vault.json 的 folders 里取。

这些字符串落在盘上、跟着仓库同步，老版本还在读，一个都不能改（§6.1）：索引里的 id `day:2026-09-26`、
`goal:week:2026-09-21`（冲突副本的 conflictOf 认它），行为日志里的 entity `day`、`goal`。

此外还有：带日期的任务（tasks.rs，在索引里另存一张表）、到点提醒（reminders.rs）、「今天还没写过就延续最近的一天」、日历上的记号
（vault.rs），8 个专用命令里的 6 个（commands.rs；列出写过的日记和目标、开关日程成了核心的通用命令）。
============================================================ */

#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
pub mod commands;
mod legacy;
mod model;
pub mod reminders;
pub mod tasks;
mod vault;

#[cfg(test)]
mod tests;

pub use vault::JournalVault;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{Datelike, NaiveDate, Weekday};
use rusqlite::Connection;
use serde_json::Value;

use crate::domain::model::DocRef;
use crate::error::{AppError, Result};
use crate::plugins::{DocType, IndexPart, Plugin};
use crate::vault::layout::{self, join};

/// 插件 id：仓库标记 plugins 里的键
pub const ID: &str = "odea.journal";
/// 某一天
pub const DAY: &str = "journal.day";
/// 某个周期（某一周 / 某个月 / 某一年）的目标
pub const GOAL: &str = "journal.goal";

pub const DAYS_DIR: &str = "日记";
pub const GOALS_DIR: &str = "目标";

pub struct Journal;

pub static JOURNAL: Journal = Journal;

impl Plugin for Journal {
    fn id(&self) -> &'static str {
        ID
    }

    fn legacy_feature(&self) -> Option<&'static str> {
        Some("journal")
    }

    /// P11.2 以前所有仓库都有日程
    fn on_in_legacy_vaults(&self) -> bool {
        true
    }

    fn roots_tree_at_notes(&self) -> bool {
        true
    }

    fn new_folders(&self) -> &'static [(&'static str, &'static str)] {
        &[("days", DAYS_DIR), ("goals", GOALS_DIR)]
    }

    fn doc_types(&self, root: Option<&Path>, marker: Option<&Value>) -> Vec<Arc<dyn DocType>> {
        let folders = Folders::read(marker, || root.and_then(obsidian_days));
        vec![
            Arc::new(DayType { dir: folders.days, by_year: folders.days_by_year }),
            Arc::new(GoalType { dir: folders.goals }),
        ]
    }

    /// 某一天、目标在索引里的 id（以前的版本也这么用）：属性块里写着这样的 id 的文件不分给笔记
    fn reserves_id(&self, id: &str) -> bool {
        id.starts_with("day:") || id.starts_with("goal:")
    }

    fn index_part(&self) -> Option<&'static dyn IndexPart> {
        Some(&tasks::TASKS)
    }

    /// 0.7.0 及以前的 DocTarget：`{ kind: "day", id }`、`{ kind: "goal", horizon, periodStart }`
    fn legacy_ref(&self, value: &Value) -> Option<DocRef> {
        let text = |key: &str| value.get(key).and_then(Value::as_str);
        match text("kind")? {
            "day" => Some(DocRef::new(DAY, text("id")?)),
            "goal" => Some(DocRef::new(GOAL, goal_key(text("horizon")?, text("periodStart")?))),
            _ => None,
        }
    }

    /// 0.7.0 的 DocTarget 的写法：`{ kind: "day", id }`、`{ kind: "goal", horizon, periodStart }`
    fn legacy_value(&self, doc: &DocRef) -> Option<Value> {
        match doc.kind.as_str() {
            DAY => Some(serde_json::json!({ "kind": "day", "id": doc.key })),
            GOAL => {
                let (horizon, period_start) = split_goal_key(&doc.key).ok()?;
                Some(serde_json::json!({ "kind": "goal", "horizon": horizon, "periodStart": period_start }))
            }
            _ => None,
        }
    }

    fn import_legacy(
        &self,
        conn: &Connection,
        root: &Path,
        written: &mut Vec<PathBuf>,
    ) -> Result<Vec<(&'static str, usize)>> {
        legacy::import(conn, root, written)
    }
}

/// 日记、目标放在哪（仓库标记的 folders.days、folders.goals）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Folders {
    pub days: String,
    /// 新的某一天按年分文件夹（日记/2026/2026-10-20.md）；Obsidian 的日记是平放的
    pub days_by_year: bool,
    pub goals: String,
}

impl Folders {
    /// 标记里写了的照写的。没写日记文件夹的：Obsidian 的日记设置是 YYYY-MM-DD 的话用它的文件夹，平放
    /// （Obsidian 就是这么建的），原来的日记直接进今日TODO 和日历；都没有是「日记」
    pub fn read(marker: Option<&Value>, obsidian: impl FnOnce() -> Option<String>) -> Self {
        let folder = |key: &str| marker.and_then(|marker| layout::marker_folder(marker, key));
        let (days, days_by_year) = match folder("days") {
            Some(days) => (days, true),
            None => match obsidian() {
                Some(days) => (days, false),
                None => (DAYS_DIR.into(), true),
            },
        };
        Self {
            days,
            days_by_year,
            goals: folder("goals").filter(|dir| !dir.is_empty()).unwrap_or_else(|| GOALS_DIR.into()),
        }
    }
}

/// 某一天：`日记/2026/2026-10-20.md`（Obsidian 的库平放）
struct DayType {
    dir: String,
    by_year: bool,
}

impl DocType for DayType {
    fn id(&self) -> &'static str {
        DAY
    }

    fn key_of(&self, rel: &str) -> Option<String> {
        let dir = layout::dir_of(rel);
        // 日记文件夹是仓库根（Obsidian 的默认）时只认根上的
        let inside = if self.dir.is_empty() { dir.is_empty() } else { layout::within(dir, &self.dir) };
        let stem = layout::stem_of(rel);
        (inside && parse_date(stem).is_some()).then(|| stem.to_string())
    }

    fn path_of(&self, key: &str) -> Result<String> {
        let date = parse_date(key)
            .ok_or_else(|| AppError::Invalid(format!("日期应为 YYYY-MM-DD，收到: {key}")))?;
        Ok(if self.by_year {
            join(&join(&self.dir, &date.year().to_string()), &format!("{key}.md"))
        } else {
            join(&self.dir, &format!("{key}.md"))
        })
    }

    fn index_id(&self, key: &str) -> String {
        format!("day:{key}")
    }

    /// 和笔记一样有可编辑的标题，写在属性块里；没写是空串（界面上显示占位）
    fn title(&self, _key: &str, written: Option<&str>) -> String {
        written.unwrap_or_default().to_string()
    }

    /// 「10月6日 · 周报」，没起标题的就是「10月6日」
    fn display_title(&self, key: &str, title: &str) -> String {
        if title.is_empty() {
            month_day(key)
        } else {
            format!("{} · {title}", month_day(key))
        }
    }

    fn log_entity(&self) -> &'static str {
        "day"
    }

    /// 存某一天记的是日期
    fn log_id(&self, key: &str) -> String {
        key.to_string()
    }

    fn dir(&self) -> &str {
        &self.dir
    }

    fn fingerprint(&self) -> String {
        format!("{DAY}={}|{}", self.dir, self.by_year)
    }
}

/// 某个周期的目标：`目标/2026/2026-W39.md`、`2026-09.md`、`2026.md`
struct GoalType {
    dir: String,
}

impl DocType for GoalType {
    fn id(&self) -> &'static str {
        GOAL
    }

    fn key_of(&self, rel: &str) -> Option<String> {
        if !layout::within(layout::dir_of(rel), &self.dir) {
            return None;
        }
        let (horizon, start) = goal_from_stem(layout::stem_of(rel))?;
        Some(goal_key(horizon, &start))
    }

    /// 周目标按 ISO 周命名（2026-W39），放在 ISO 周所属年份的文件夹里
    fn path_of(&self, key: &str) -> Result<String> {
        let (horizon, period_start) = split_goal_key(key)?;
        let date = validate_period_start(horizon, period_start)?;
        let goals = &self.dir;
        Ok(match horizon {
            "week" => {
                let week = date.iso_week();
                format!("{goals}/{}/{}-W{:02}.md", week.year(), week.year(), week.week())
            }
            "month" => format!("{goals}/{}/{}-{:02}.md", date.year(), date.year(), date.month()),
            _ => format!("{goals}/{}/{}.md", date.year(), date.year()),
        })
    }

    fn index_id(&self, key: &str) -> String {
        format!("goal:{key}")
    }

    /// 标题由周期决定：「第 39 周目标」，属性块里写的不算
    fn title(&self, key: &str, _written: Option<&str>) -> String {
        split_goal_key(key).map_or_else(|_| String::new(), |(horizon, start)| goal_title(horizon, start))
    }

    fn display_title(&self, _key: &str, title: &str) -> String {
        title.to_string()
    }

    fn log_entity(&self) -> &'static str {
        "goal"
    }

    /// 存目标记的是索引里的 id
    fn log_id(&self, key: &str) -> String {
        self.index_id(key)
    }

    fn dir(&self) -> &str {
        &self.dir
    }

    fn fingerprint(&self) -> String {
        format!("{GOAL}={}", self.dir)
    }
}

/// 目标的 key：`week:2026-09-21`（和前端的 goalKey 一样）
pub fn goal_key(horizon: &str, period_start: &str) -> String {
    format!("{horizon}:{period_start}")
}

/// `week:2026-09-21` → (尺度, 周期起点)
pub fn split_goal_key(key: &str) -> Result<(&str, &str)> {
    key.split_once(':')
        .ok_or_else(|| AppError::Invalid(format!("目标应为「尺度:周期起点」，收到: {key}")))
}

fn parse_date(s: &str) -> Option<NaiveDate> {
    (s.len() == 10)
        .then(|| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
        .flatten()
}

/// period_start 必须真的是周期起点：周一 / 1 号 / 1 月 1 日
pub fn validate_period_start(horizon: &str, period_start: &str) -> Result<NaiveDate> {
    let date = parse_date(period_start).ok_or_else(|| {
        AppError::Invalid(format!("日期格式应为 YYYY-MM-DD，收到: {period_start}"))
    })?;
    let ok = match horizon {
        "week" => date.weekday() == Weekday::Mon,
        "month" => date.day() == 1,
        "year" => date.day() == 1 && date.month() == 1,
        _ => return Err(AppError::Invalid(format!("未知的时间尺度: {horizon}"))),
    };
    if ok {
        Ok(date)
    } else {
        Err(AppError::Invalid(format!(
            "{period_start} 不是 {horizon} 周期的起点"
        )))
    }
}

/// `2026-W39` / `2026-09` / `2026` → (尺度, 周期起点)
pub fn goal_from_stem(stem: &str) -> Option<(&'static str, String)> {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if stem.len() == 4 && digits(stem) {
        let year: i32 = stem.parse().ok()?;
        let date = NaiveDate::from_ymd_opt(year, 1, 1)?;
        return Some(("year", date.format("%Y-%m-%d").to_string()));
    }
    let (year, rest) = stem.split_once('-')?;
    if year.len() != 4 || !digits(year) {
        return None;
    }
    let year: i32 = year.parse().ok()?;
    if let Some(week) = rest.strip_prefix('W') {
        if week.len() != 2 || !digits(week) {
            return None;
        }
        let date = NaiveDate::from_isoywd_opt(year, week.parse().ok()?, Weekday::Mon)?;
        return Some(("week", date.format("%Y-%m-%d").to_string()));
    }
    if rest.len() == 2 && digits(rest) {
        let date = NaiveDate::from_ymd_opt(year, rest.parse().ok()?, 1)?;
        return Some(("month", date.format("%Y-%m-%d").to_string()));
    }
    None
}

const CN_MONTH: [&str; 12] = [
    "一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月",
    "十二月",
];

/// 和前端 plugins/journal 的 goalTitle 一样：「第 39 周目标」「九月目标」「2026 年目标」
pub fn goal_title(horizon: &str, period_start: &str) -> String {
    let Some(date) = parse_date(period_start) else {
        return String::new();
    };
    match horizon {
        "week" => format!("第 {} 周目标", date.iso_week().week()),
        "month" => format!("{}目标", CN_MONTH[date.month0() as usize]),
        _ => format!("{} 年目标", date.year()),
    }
}

/// 「9月26日」
pub fn month_day(date: &str) -> String {
    match parse_date(date) {
        Some(date) => format!("{}月{}日", date.month(), date.day()),
        None => date.to_string(),
    }
}

/// Odea 的老规矩下某一天放在哪（旧库搬家、测试用）
pub fn day_path(date: &str) -> Result<String> {
    DayType { dir: DAYS_DIR.into(), by_year: true }.path_of(date)
}

/// Odea 的老规矩下某个周期的目标放在哪（旧库搬家、测试用）
pub fn goal_path(horizon: &str, period_start: &str) -> Result<String> {
    GoalType { dir: GOALS_DIR.into() }.path_of(&goal_key(horizon, period_start))
}

/// Obsidian 的日记放在哪：开着日记核心插件、日期格式是 YYYY-MM-DD（不写就是这个）时用它的文件夹
/// （不写是仓库根）。不是 Obsidian 的库、格式对不上（按年月分了子文件夹、写了星期几）返回 None
fn obsidian_days(root: &Path) -> Option<String> {
    let config = root.join(".obsidian");
    if !config.is_dir() {
        return None;
    }
    // core-plugins.json：新版是 { "daily-notes": true, … }，旧版是开着的插件名列表；没有这个文件是默认（开着）
    let enabled = match layout::read_json(&config.join("core-plugins.json")) {
        Some(Value::Object(plugins)) => plugins.get("daily-notes").and_then(Value::as_bool).unwrap_or(false),
        Some(Value::Array(plugins)) => plugins.iter().any(|plugin| plugin.as_str() == Some("daily-notes")),
        _ => true,
    };
    if !enabled {
        return None;
    }
    let settings = layout::read_json(&config.join("daily-notes.json")).unwrap_or(Value::Null);
    let format = settings.get("format").and_then(Value::as_str).unwrap_or("").trim();
    if !format.is_empty() && format != "YYYY-MM-DD" {
        return None;
    }
    layout::clean_dir(settings.get("folder").and_then(Value::as_str).unwrap_or(""))
}
