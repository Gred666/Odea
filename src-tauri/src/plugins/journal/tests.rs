use serde_json::{json, Value};

use super::*;
use crate::plugins::DocType;
use crate::vault::layout::{classify, Layout, Slot};

fn types_of(marker: Value, obsidian: Option<&str>) -> (Arc<dyn DocType>, Arc<dyn DocType>) {
    let folders = Folders::read(Some(&marker), || obsidian.map(String::from));
    (
        Arc::new(DayType { dir: folders.days, by_year: folders.days_by_year }),
        Arc::new(GoalType { dir: folders.goals }),
    )
}

#[test]
fn days_and_goals_are_recognized_by_their_paths() {
    let day = |key: &str| Slot::Typed { kind: DAY, key: key.into() };
    let goal = |key: &str| Slot::Typed { kind: GOAL, key: key.into() };
    assert_eq!(classify("日记/2026/2026-09-26.md"), day("2026-09-26"));
    // 日记文件夹里不是日期的文件就是普通笔记，不会消失
    assert_eq!(classify("日记/2026/杂记.md"), Slot::Note { archived: false });
    assert_eq!(classify("目标/2026/2026-W39.md"), goal("week:2026-09-21"));
    assert_eq!(classify("目标/2026/2026-09.md"), goal("month:2026-09-01"));
    assert_eq!(classify("目标/2026.md"), goal("year:2026-01-01"));
    assert_eq!(classify("目标/2026/2026-W60.md"), Slot::Note { archived: false });
    assert_eq!(classify("目标/2026-10-20.md"), Slot::Note { archived: false }, "目标文件夹里的日期不是某一天");
}

#[test]
fn goal_paths_round_trip_including_iso_week_years() {
    for (horizon, start) in [
        ("week", "2026-09-21"),
        ("week", "2026-12-28"),
        ("week", "2027-01-04"),
        ("week", "2024-12-30"),
        ("month", "2026-09-01"),
        ("year", "2026-01-01"),
    ] {
        let path = goal_path(horizon, start).unwrap();
        assert_eq!(
            classify(&path),
            Slot::Typed { kind: GOAL, key: goal_key(horizon, start) },
            "{path}"
        );
    }
    // 2024-12-30 是 2025 年第 1 周的周一
    assert_eq!(goal_path("week", "2024-12-30").unwrap(), "目标/2025/2025-W01.md");
    assert!(goal_path("week", "2026-09-22").is_err());
    assert_eq!(day_path("2026-10-06").unwrap(), "日记/2026/2026-10-06.md");
    assert!(day_path("2026-13-01").is_err());
}

#[test]
fn ids_titles_and_log_names_stay_what_older_versions_wrote() {
    // 索引里的 id 落在冲突副本的 conflictOf 里、行为日志跟着仓库同步：老版本还在读，一个字都不能变
    let (day, goal) = types_of(json!({}), None);
    assert_eq!(day.index_id("2026-11-03"), "day:2026-11-03");
    assert_eq!(goal.index_id("week:2026-11-02"), "goal:week:2026-11-02");
    assert_eq!((day.log_entity(), day.log_id("2026-11-03").as_str()), ("day", "2026-11-03"));
    assert_eq!((goal.log_entity(), goal.log_id("week:2026-11-02").as_str()), ("goal", "goal:week:2026-11-02"));
    assert!(JOURNAL.reserves_id("day:2026-11-03") && JOURNAL.reserves_id("goal:week:2026-11-02"));
    assert!(!JOURNAL.reserves_id("daily"));
    // 标题：某一天是属性块里写的，目标按周期算
    assert_eq!(day.title("2026-10-06", Some("周报")), "周报");
    assert_eq!(day.title("2026-10-06", None), "");
    assert_eq!(day.display_title("2026-10-06", "周报"), "10月6日 · 周报");
    assert_eq!(day.display_title("2026-10-06", ""), "10月6日");
    assert_eq!(goal.title("week:2026-09-21", Some("随便写的")), "第 39 周目标");
}

#[test]
fn goal_titles_match_the_frontend() {
    assert_eq!(goal_title("week", "2026-09-21"), "第 39 周目标");
    assert_eq!(goal_title("month", "2026-09-01"), "九月目标");
    assert_eq!(goal_title("year", "2026-01-01"), "2026 年目标");
}

#[test]
fn old_doc_targets_are_read_as_doc_refs() {
    // 0.7.0 的访客留底里存着的 DocTarget
    let read = |text: &str| serde_json::from_str::<DocRef>(text).unwrap();
    assert_eq!(read(r#"{"kind":"day","id":"2026-11-03"}"#), DocRef::new(DAY, "2026-11-03"));
    assert_eq!(
        read(r#"{"kind":"goal","horizon":"week","periodStart":"2026-11-02"}"#),
        DocRef::new(GOAL, "week:2026-11-02")
    );
    assert_eq!(read(r#"{"kind":"note","id":"n1"}"#), DocRef::note("n1"));
    assert_eq!(read(r#"{"type":"journal.day","key":"2026-11-03"}"#), DocRef::new(DAY, "2026-11-03"));
    assert!(serde_json::from_str::<DocRef>(r#"{"kind":"别的"}"#).is_err());
}

#[test]
fn folders_come_from_the_marker_then_obsidian() {
    // 配置里乱写的文件夹不收
    let folders = Folders::read(Some(&json!({ "folders": { "days": "/Daily/", "goals": ".hidden" } })), || None);
    assert_eq!((folders.days.as_str(), folders.goals.as_str()), ("Daily", GOALS_DIR));
    // 新建的仓库照 Odea 的摆法
    assert_eq!(Layout::from_marker(&crate::vault::layout::new_marker(true, false, 0), None), Layout::odea());
}

#[test]
fn obsidian_daily_notes_are_days() {
    let (day, _) = types_of(json!({}), Some("Daily"));
    assert_eq!(day.path_of("2026-10-20").unwrap(), "Daily/2026-10-20.md");
    assert_eq!(day.key_of("Daily/2026-10-20.md").as_deref(), Some("2026-10-20"));
    // 日记在仓库根上（Obsidian 的默认）：只认根上的
    let (root, _) = types_of(json!({}), Some(""));
    assert_eq!(root.path_of("2026-10-20").unwrap(), "2026-10-20.md");
    assert_eq!(root.key_of("2026-10-20.md").as_deref(), Some("2026-10-20"));
    assert_eq!(root.key_of("工作/2026-10-20.md"), None);
    let tree = Layout::from_marker(&json!({ "features": { "journal": true } }), None);
    assert_eq!(tree.hidden_dirs(), vec!["日记", "目标", "归档"]);
    // 自己在标记里写了日记文件夹的，不看 Obsidian 的
    let (own, _) = types_of(json!({ "folders": { "days": "日志" } }), Some("Daily"));
    assert_eq!(own.path_of("2026-10-20").unwrap(), "日志/2026/2026-10-20.md");
}

#[test]
fn reads_obsidian_settings_from_disk() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    assert_eq!(obsidian_days(root), None, "不是 Obsidian 的库");
    std::fs::create_dir_all(root.join(".obsidian")).unwrap();
    assert_eq!(obsidian_days(root).as_deref(), Some(""), "什么都没设：日记在仓库根上");
    let write = |name: &str, text: &str| std::fs::write(root.join(".obsidian").join(name), text).unwrap();
    write("daily-notes.json", r#"{ "folder": "Journal/Daily", "format": "YYYY-MM-DD" }"#);
    assert_eq!(obsidian_days(root).as_deref(), Some("Journal/Daily"));
    write("core-plugins.json", r#"{ "daily-notes": false }"#);
    assert_eq!(obsidian_days(root), None, "日记插件关了");
    write("core-plugins.json", r#"["file-explorer", "daily-notes"]"#);
    assert_eq!(obsidian_days(root).as_deref(), Some("Journal/Daily"), "旧版的插件列表");
    write("daily-notes.json", r#"{ "folder": "Daily", "format": "YYYY/MM/YYYY-MM-DD" }"#);
    assert_eq!(obsidian_days(root), None, "按年月分了子文件夹的认不了");
}
