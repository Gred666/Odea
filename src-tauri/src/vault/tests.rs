use std::sync::Mutex;

use super::*;

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    vault: Vault,
    announced: Arc<Mutex<Vec<VaultChange>>>,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    let mut vault = Vault::open_in_memory(&root);
    let announced = Arc::new(Mutex::new(Vec::new()));
    let sink = announced.clone();
    vault.set_announcer(Arc::new(move |change| sink.lock().unwrap().push(change)));
    Fixture {
        _dir: dir,
        root,
        vault,
        announced,
    }
}

impl Fixture {
    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(fsio::abs(&self.root, rel)).unwrap()
    }

    fn exists(&self, rel: &str) -> bool {
        fsio::abs(&self.root, rel).exists()
    }

    fn files(&self) -> Vec<String> {
        fsio::walk_markdown(&self.root)
            .into_iter()
            .map(|file| file.rel)
            .collect()
    }

    /// 模拟别的程序改文件：修改时间往后挪一秒，保证和索引里的不一样
    fn write_externally(&self, rel: &str, text: &str) {
        let path = fsio::abs(&self.root, rel);
        let before = fsio::stat(&path).map_or(0, |(mtime, _)| mtime);
        fsio::write_atomic(&path, text).unwrap();
        fsio::set_mtime(&path, before + 1000).unwrap();
    }

    fn take_announced(&self) -> Vec<VaultChange> {
        std::mem::take(&mut *self.announced.lock().unwrap())
    }
}

/* ---------------- 笔记 ---------------- */

#[test]
fn a_note_is_a_markdown_file_named_after_its_title() {
    let mut f = fixture();
    let id = f.vault.note_create("周末采购", "- 燕麦奶").unwrap();
    assert_eq!(f.files(), vec!["笔记/周末采购.md"]);
    let text = f.read("笔记/周末采购.md");
    assert!(text.starts_with(&format!("---\nid: {id}\ncreated: ")));
    assert!(text.ends_with("---\n\n- 燕麦奶"));
    assert!(!text.contains("title:"), "文件名就是标题时不用再写一遍");

    let note = f.vault.note_get(&id).unwrap();
    assert_eq!(note.title, "周末采购");
    assert_eq!(note.content_md, "- 燕麦奶");
    assert!(note.word_count > 0);
}

#[test]
fn same_titles_get_numbered_files_but_keep_their_titles() {
    let mut f = fixture();
    let first = f.vault.note_create("无标题笔记", "").unwrap();
    let second = f.vault.note_create("无标题笔记", "").unwrap();
    assert_eq!(f.files(), vec!["笔记/无标题笔记 2.md", "笔记/无标题笔记.md"]);
    assert_eq!(f.vault.note_get(&first).unwrap().title, "无标题笔记");
    assert_eq!(f.vault.note_get(&second).unwrap().title, "无标题笔记");
    assert!(f.read("笔记/无标题笔记 2.md").contains("title: \"无标题笔记\""));
}

#[test]
fn renaming_a_note_renames_its_file_and_keeps_the_id() {
    let mut f = fixture();
    let id = f.vault.note_create("初稿", "正文").unwrap();
    f.vault.note_update(&id, "周报: 第 3 期", "正文改了").unwrap();

    assert_eq!(f.files(), vec!["笔记/周报： 第 3 期.md"]);
    let note = f.vault.note_get(&id).unwrap();
    assert_eq!(note.title, "周报: 第 3 期");
    assert_eq!(note.content_md, "正文改了");
    assert!(f.read("笔记/周报： 第 3 期.md").contains(&format!("id: {id}\n")));

    // 只改大小写（Windows 上是同一个文件名）
    f.vault.note_update(&id, "Weekly", "x").unwrap();
    f.vault.note_update(&id, "weekly", "x").unwrap();
    assert_eq!(f.files(), vec!["笔记/weekly.md"]);
    assert_eq!(f.vault.note_get(&id).unwrap().title, "weekly");
}

#[test]
fn saving_keeps_front_matter_written_by_other_tools() {
    let mut f = fixture();
    f.write_externally(
        "笔记/京都.md",
        "---\ntags:\n  - 旅行\naliases: [Kyoto]\n---\n\n书店",
    );
    f.vault.rescan().unwrap();
    let note = &f.vault.note_list_full(false).unwrap()[0];
    assert_eq!(note.title, "京都");
    assert_eq!(note.content_md, "书店");

    f.vault.note_update(&note.id, "京都", "书店和咖啡").unwrap();
    let text = f.read("笔记/京都.md");
    assert!(text.contains(&format!("id: {}\n", note.id)), "没有 id 的文件第一次保存时写进去");
    assert!(text.contains("tags:\n  - 旅行\naliases: [Kyoto]\n"), "别的工具的属性丢了: {text}");
    assert!(text.ends_with("书店和咖啡"));
}

#[test]
fn pin_archive_restore_move_the_file() {
    let mut f = fixture();
    let id = f.vault.note_create("路线图", "内容").unwrap();

    f.vault.note_set_pinned(&id, true).unwrap();
    assert!(f.read("笔记/路线图.md").contains("pinned: true\n"));
    assert!(f.vault.note_get(&id).unwrap().is_pinned);

    f.vault.note_archive(&id, Some("工作笔记".into())).unwrap();
    assert_eq!(f.files(), vec!["归档/路线图.md"]);
    let archived = f.vault.note_get(&id).unwrap();
    assert!(archived.is_archived);
    assert!(!archived.is_pinned, "归档清掉置顶");
    assert_eq!(archived.archive_category.as_deref(), Some("工作笔记"));
    assert!(archived.archived_at.is_some());
    assert!(f.vault.note_list_full(false).unwrap().is_empty());
    assert_eq!(f.vault.note_list_full(true).unwrap().len(), 1);

    f.vault.note_restore(&id).unwrap();
    assert_eq!(f.files(), vec!["笔记/路线图.md"]);
    let restored = f.vault.note_get(&id).unwrap();
    assert!(!restored.is_archived);
    assert!(restored.archived_at.is_none());
    assert_eq!(restored.content_md, "内容");
}

#[test]
fn delete_goes_to_the_trash_and_undo_puts_it_back() {
    let mut f = fixture();
    std::fs::create_dir_all(fsio::abs(&f.root, "笔记/工作")).unwrap();
    f.write_externally("笔记/工作/周报.md", "内容");
    f.vault.rescan().unwrap();
    let id = f.vault.note_list_full(false).unwrap()[0].id.clone();

    f.vault.note_delete(&id).unwrap();
    assert!(f.files().is_empty());
    assert!(matches!(f.vault.note_get(&id), Err(AppError::NotFound(_))));
    assert!(f.exists("笔记/工作"), "「笔记」底下的文件夹是用户的，删空了也留着");
    assert!(f.exists(&format!(".ontheway/trash/{id}.md")));

    f.vault.note_undelete(&id).unwrap();
    assert_eq!(f.files(), vec!["笔记/工作/周报.md"], "放回原来的文件夹");
    assert_eq!(f.vault.note_get(&id).unwrap().content_md, "内容");
    assert!(!f.read("笔记/工作/周报.md").contains("trashed-from"));
    assert!(matches!(
        f.vault.note_undelete(&id),
        Err(AppError::NotFound(_))
    ));
}

#[test]
fn old_trash_is_purged() {
    let mut f = fixture();
    let id = f.vault.note_create("临时", "x").unwrap();
    f.vault.note_delete(&id).unwrap();
    let trashed = fsio::abs(&f.root, &format!(".ontheway/trash/{id}.md"));
    fsio::set_mtime(&trashed, now_ms() - 31 * 86_400_000).unwrap();
    f.vault.purge_trash(30 * 86_400_000);
    assert!(!trashed.exists());
}

#[test]
fn search_finds_two_character_chinese_words() {
    let mut f = fixture();
    f.vault
        .note_create("秋季项目复盘", "这一周把季度目标推进到可以交付的状态。")
        .unwrap();
    f.vault.note_create("周末采购", "燕麦奶、灯泡、咖啡豆。").unwrap();
    let result = f.vault.search("季度", 10).unwrap();
    assert_eq!(result.hits.len(), 1);
    assert_eq!(result.hits[0].title, "秋季项目复盘");
    assert!(f.vault.search("   ", 10).unwrap().hits.is_empty());
}

/* ---------------- 某一天 ---------------- */

#[test]
fn a_day_lives_in_the_diary_folder_and_empty_days_leave_no_file() {
    let mut f = fixture();
    let saved = f.vault.save_day("2026-09-26", "周六", "- [ ] 跑步").unwrap();
    assert_eq!(saved.title, "周六");
    assert_eq!(
        f.read("日记/2026/2026-09-26.md"),
        "---\ntitle: \"周六\"\n---\n\n- [ ] 跑步"
    );

    f.vault.save_day("2026-09-26", "", "只有正文").unwrap();
    assert_eq!(f.read("日记/2026/2026-09-26.md"), "只有正文");

    f.vault.save_day("2026-09-26", "", "").unwrap();
    assert!(f.files().is_empty());
    assert!(!f.exists("日记/2026"), "空了的年份文件夹也删掉");
    assert!(f.vault.marked_dates("2026-01-01", "2026-12-31").unwrap().is_empty());
}

#[test]
fn today_carries_over_from_the_latest_written_day_without_writing() {
    let mut f = fixture();
    f.vault.save_day("2026-08-27", "周四的 TODO", "- [ ] 跑步").unwrap();
    f.vault.save_day("2026-08-25", "更早的", "旧").unwrap();

    let today = f.vault.day("2026-08-29", true).unwrap();
    assert_eq!(today.title, "周四的 TODO");
    assert_eq!(today.note_md, "- [ ] 跑步");
    assert_eq!(today.carried_from.as_deref(), Some("2026-08-27"));
    assert!(!f.exists("日记/2026/2026-08-29.md"), "延续不等于写入");
    assert!(f.vault.day("2026-08-28", false).unwrap().carried_from.is_none());

    f.vault.save_day("2026-08-29", "今天", "新的").unwrap();
    let own = f.vault.day("2026-08-29", true).unwrap();
    assert_eq!(own.title, "今天");
    assert!(own.carried_from.is_none());
}

/* ---------------- 目标 ---------------- */

#[test]
fn goals_are_one_file_per_period() {
    let mut f = fixture();
    let empty = f.vault.goal("week", "2026-09-21").unwrap();
    assert_eq!(empty.id, "");
    assert_eq!(empty.updated_at, 0);

    let saved = f.vault.save_goal("week", "2026-09-21", "# 本周").unwrap();
    assert!(!saved.id.is_empty());
    assert_eq!(f.read("目标/2026/2026-W39.md"), "# 本周");
    let again = f.vault.save_goal("week", "2026-09-21", "# 本周\n\n改了").unwrap();
    assert_eq!(again.id, saved.id);
    assert_eq!(f.files(), vec!["目标/2026/2026-W39.md"]);

    assert!(matches!(
        f.vault.goal("week", "2026-09-22"),
        Err(AppError::Invalid(_))
    ));
    f.vault.save_goal("week", "2026-09-21", "  ").unwrap();
    assert!(f.files().is_empty());
}

/* ---------------- 任务 ---------------- */

#[test]
fn dated_tasks_anywhere_show_up_on_their_day() {
    let mut f = fixture();
    let note = f
        .vault
        .note_create("复盘", "## 行动\n\n- [ ] 交稿 @2026-09-04 16:00 #写作\n- [ ] 没日期的")
        .unwrap();
    f.vault
        .save_day("2026-09-04", "", "- [ ] 那天自己写的 @2026-09-04")
        .unwrap();

    let day = f.vault.day("2026-09-04", false).unwrap();
    assert_eq!(day.tasks.len(), 1, "那一天自己的任务就在正文里，不再列一遍");
    let task = &day.tasks[0];
    assert_eq!(task.title, "交稿");
    assert_eq!(task.meta.as_deref(), Some("写作 · 16:00 · 复盘"));
    assert_eq!(
        f.vault.marked_dates("2026-09-01", "2026-09-30").unwrap(),
        vec!["2026-09-04"]
    );

    // 归档笔记里的任务不进日历
    f.vault.note_archive(&note, None).unwrap();
    assert!(f.vault.day("2026-09-04", false).unwrap().tasks.is_empty());
}

#[test]
fn dated_tasks_know_where_they_came_from() {
    let mut f = fixture();
    let note = f
        .vault
        .note_create("复盘", "开头\n\n- [ ] 交稿 @2026-09-04")
        .unwrap();
    f.vault
        .save_goal("week", "2026-08-31", "- [ ] 周目标里的 @2026-09-04")
        .unwrap();

    let tasks = f.vault.day("2026-09-04", false).unwrap().tasks;
    let from_note = tasks.iter().find(|task| task.title == "交稿").unwrap();
    assert!(matches!(&from_note.source, Some(DocTarget::Note { id }) if *id == note));
    assert_eq!(from_note.line, Some(2), "行号从 0 开始，和反向链接一样");
    let from_goal = tasks.iter().find(|task| task.title == "周目标里的").unwrap();
    assert!(matches!(
        &from_goal.source,
        Some(DocTarget::Goal { horizon, period_start }) if horizon == "week" && period_start == "2026-08-31"
    ));
}

#[test]
fn the_calendar_tells_written_days_from_days_with_open_tasks() {
    let mut f = fixture();
    f.vault
        .note_create("清单", "- [ ] 还没做 @2026-09-04\n- [x] 做完了 @2026-09-05")
        .unwrap();
    f.vault.save_day("2026-09-06", "", "写了点东西").unwrap();

    let marks = f.vault.calendar_marks("2026-09-01", "2026-09-30").unwrap();
    assert_eq!(marks.open, vec!["2026-09-04"]);
    assert_eq!(marks.written, vec!["2026-09-05", "2026-09-06"], "做完的任务也算留下过东西");
    assert!(f
        .vault
        .calendar_marks("2026-10-01", "2026-10-31")
        .unwrap()
        .written
        .is_empty());
}

#[test]
fn the_journal_lists_written_days_and_goals_with_their_text() {
    let mut f = fixture();
    f.vault.note_create("笔记不算", "正文").unwrap();
    f.vault.save_day("2026-09-04", "周报", "今天开会").unwrap();
    f.vault.save_goal("week", "2026-08-31", "本周重点").unwrap();
    f.vault.save_day("2026-09-05", "", "").unwrap();

    let journal = f.vault.journal_list().unwrap();
    let mut titles: Vec<(&str, &str, &str)> = journal
        .iter()
        .map(|doc| (doc.kind.as_str(), doc.title.as_str(), doc.content_md.as_str()))
        .collect();
    titles.sort();
    assert_eq!(
        titles,
        vec![
            ("day", "9月4日 · 周报", "今天开会"),
            ("goal", "第 36 周目标", "本周重点"),
        ]
    );
}

#[test]
fn toggling_a_task_edits_its_line_in_the_source_file() {
    let mut f = fixture();
    let note = f
        .vault
        .note_create("复盘", "开头\n\n- [ ] 交稿 @2026-09-04")
        .unwrap();
    let task_id = f.vault.day("2026-09-04", false).unwrap().tasks[0].id.clone();
    f.take_announced();

    let toggled = f.vault.toggle_task(&task_id).unwrap();
    assert_eq!(toggled.status, "done");
    assert!(f.read("笔记/复盘.md").ends_with("- [x] 交稿 @2026-09-04"));
    assert_eq!(
        f.vault.note_get(&note).unwrap().content_md,
        "开头\n\n- [x] 交稿 @2026-09-04"
    );
    // 前端手里这篇的正文过时了：通知里要有它，日历也要刷新
    let announced = f.take_announced();
    assert!(announced.iter().any(|change| change.notes.contains(&note) && change.tasks));

    let back = f.vault.toggle_task(&toggled.id).unwrap();
    assert_eq!(back.status, "todo");
}

#[test]
fn toggling_follows_the_line_when_the_file_changed_above_it() {
    let mut f = fixture();
    let note = f.vault.note_create("复盘", "- [ ] 交稿 @2026-09-04").unwrap();
    let task_id = f.vault.day("2026-09-04", false).unwrap().tasks[0].id.clone();
    // 外部在上面插了两行，监听还没来得及处理
    let text = f.read("笔记/复盘.md").replace("- [ ] 交稿", "新的一行\n\n- [ ] 交稿");
    f.write_externally("笔记/复盘.md", &text);

    f.vault.toggle_task(&task_id).unwrap();
    assert!(f.read("笔记/复盘.md").ends_with("新的一行\n\n- [x] 交稿 @2026-09-04"));
    assert_eq!(
        f.vault.note_get(&note).unwrap().content_md,
        "新的一行\n\n- [x] 交稿 @2026-09-04"
    );
}

#[test]
fn saving_a_document_that_changes_its_dated_tasks_tells_the_calendar() {
    let mut f = fixture();
    let id = f.vault.note_create("复盘", "正文").unwrap();
    f.take_announced();

    f.vault.note_update(&id, "复盘", "正文\n\n- [ ] 交稿 @2026-09-04").unwrap();
    let announced = f.take_announced();
    assert_eq!(announced.len(), 1);
    assert!(announced[0].tasks);
    assert!(announced[0].notes.is_empty(), "前端自己存的那篇不用再通知回去");

    // 没碰到带日期的任务：不打扰
    f.vault
        .note_update(&id, "复盘", "正文改了\n\n- [ ] 交稿 @2026-09-04")
        .unwrap();
    assert!(f.take_announced().is_empty());
}

/* ---------------- 外部改动与冲突 ---------------- */

#[test]
fn saving_over_an_unseen_external_edit_keeps_both_versions() {
    let mut f = fixture();
    let id = f.vault.note_create("周报", "原来的").unwrap();
    let theirs = f.read("笔记/周报.md").replace("原来的", "别处改的");
    f.write_externally("笔记/周报.md", &theirs);

    f.vault.note_update(&id, "周报", "我改的").unwrap();

    let files = f.files();
    assert_eq!(files.len(), 2, "{files:?}");
    assert_eq!(f.vault.note_get(&id).unwrap().content_md, "我改的");
    let copy = files.iter().find(|rel| rel.contains("冲突")).unwrap();
    assert!(f.read(copy).ends_with("别处改的"));
    assert!(!f.read(copy).contains(&id), "冲突副本是另一篇笔记，不能和原文抢 id");
    let announced = f.take_announced();
    assert_eq!(announced.len(), 1);
    assert_eq!(announced[0].conflicts.len(), 1);
    assert_eq!(announced[0].notes.len(), 1, "新出现的冲突副本要进列表");
}

#[test]
fn keeping_a_conflict_copy_on_request() {
    let mut f = fixture();
    f.vault.save_day("2026-09-26", "", "磁盘上的").unwrap();
    let title = f
        .vault
        .keep_conflict_copy(&DocTarget::Day {
            id: "2026-09-26".into(),
        })
        .unwrap()
        .unwrap();
    assert!(title.starts_with("2026-09-26 (冲突 "));
    // 冲突副本不是日期，是一篇普通笔记 —— 认得出它是那一天的副本
    let notes = f.vault.note_list_full(false).unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].content_md, "磁盘上的");
    assert_eq!(notes[0].conflict_of.as_deref(), Some("day:2026-09-26"));
    assert_eq!(f.vault.day("2026-09-26", false).unwrap().note_md, "磁盘上的");
}

#[test]
fn conflict_copies_of_goals_point_at_the_period() {
    let mut f = fixture();
    f.vault.save_goal("week", "2026-09-21", "这周的目标").unwrap();
    let title = f
        .vault
        .keep_conflict_copy(&DocTarget::Goal {
            horizon: "week".into(),
            period_start: "2026-09-21".into(),
        })
        .unwrap()
        .unwrap();
    let copy = f
        .vault
        .note_list_full(false)
        .unwrap()
        .into_iter()
        .find(|note| note.title == title)
        .unwrap();
    assert_eq!(copy.content_md, "这周的目标");
    assert_eq!(copy.conflict_of.as_deref(), Some("goal:week:2026-09-21"));
}

#[test]
fn rescan_picks_up_external_adds_edits_renames_and_deletes() {
    let mut f = fixture();
    f.write_externally("笔记/外面写的.md", "---\nid: ext1\n---\n\n你好");
    f.write_externally("日记/2026/2026-09-26.md", "今天");
    let change = f.vault.rescan().unwrap();
    assert_eq!(change.notes, vec!["ext1"]);
    assert_eq!(change.days, vec!["2026-09-26"]);

    // 没变的文件不再报
    assert!(f.vault.rescan().unwrap().is_empty());

    std::fs::rename(
        fsio::abs(&f.root, "笔记/外面写的.md"),
        fsio::abs(&f.root, "笔记/改了名.md"),
    )
    .unwrap();
    let change = f.vault.rescan().unwrap();
    assert_eq!(change.notes, vec!["ext1"], "改名是同一篇");
    assert_eq!(f.vault.note_get("ext1").unwrap().title, "改了名");

    std::fs::remove_file(fsio::abs(&f.root, "日记/2026/2026-09-26.md")).unwrap();
    let change = f.vault.rescan().unwrap();
    assert_eq!(change.days, vec!["2026-09-26"]);
    assert!(f.vault.day("2026-09-26", false).unwrap().note_md.is_empty());
}

#[test]
fn a_copied_file_with_the_same_id_becomes_its_own_note() {
    let mut f = fixture();
    let id = f.vault.note_create("原件", "内容").unwrap();
    let text = f.read("笔记/原件.md");
    f.write_externally("笔记/原件 - 副本.md", &text);
    f.vault.rescan().unwrap();

    let notes = f.vault.note_list_full(false).unwrap();
    assert_eq!(notes.len(), 2);
    assert!(notes.iter().any(|note| note.id == id && note.title == "原件" && note.conflict_of.is_none()));
    // 带着同一个 id 的拷贝：认得出它是「原件」的一份副本
    assert!(notes
        .iter()
        .any(|note| note.id != id && note.title == "原件 - 副本" && note.conflict_of.as_deref() == Some(&id)));
}

/* ---------------- 网盘的冲突副本 ---------------- */

#[test]
fn cloud_conflict_copies_point_at_their_original() {
    let mut f = fixture();
    let id = f.vault.note_create("周报", "我这边的版本").unwrap();
    let text = f.read("笔记/周报.md");
    // Google Drive / 百度网盘：整个文件拷一份，属性块里的 id 也跟着
    f.write_externally("笔记/周报 (1).md", &text.replace("我这边的版本", "另一台机器的版本"));
    // Syncthing：没有属性块也认得出（靠名字，且原文在同一个文件夹里）
    f.write_externally("笔记/周报.sync-conflict-20261006-153012-ABCDEFG.md", "第三个版本");
    // 名字像、但没有原文的：只是一篇叫「方案 (1)」的笔记
    f.write_externally("笔记/方案 (1).md", "正经起名的笔记");
    f.take_announced();
    f.vault.rescan_and_announce().unwrap();

    let notes = f.vault.note_list_full(false).unwrap();
    let by_title = |title: &str| notes.iter().find(|note| note.title == title).unwrap();
    assert_eq!(by_title("周报").id, id, "原文留着自己的 id");
    assert_eq!(by_title("周报").conflict_of, None);
    assert_eq!(by_title("周报 (1)").conflict_of.as_deref(), Some(id.as_str()));
    assert_eq!(
        by_title("周报.sync-conflict-20261006-153012-ABCDEFG").conflict_of.as_deref(),
        Some(id.as_str())
    );
    assert_eq!(by_title("方案 (1)").conflict_of, None);

    let announced = f.take_announced();
    let found: Vec<&String> = announced.iter().flat_map(|change| &change.found_copies).collect();
    assert_eq!(found.len(), 2, "{found:?}");
}

#[test]
fn a_rebuilt_index_gives_the_id_to_the_original_not_the_copy() {
    let mut f = fixture();
    let id = f.vault.note_create("周报", "原文").unwrap();
    let text = f.read("笔记/周报.md");
    // 「周报 (1).md」按字节序排在「周报.md」前面
    f.write_externally("笔记/周报 (1).md", &text);

    let rebuilt = Vault::open_in_memory(&f.root);
    let original = rebuilt.note_get(&id).unwrap();
    assert_eq!(original.title, "周报");
    let copy = rebuilt
        .note_list_full(false)
        .unwrap()
        .into_iter()
        .find(|note| note.title == "周报 (1)")
        .unwrap();
    assert_eq!(copy.conflict_of.as_deref(), Some(id.as_str()));
}

#[test]
fn our_own_conflict_copies_are_recognized_too() {
    let mut f = fixture();
    let id = f.vault.note_create("计划", "旧").unwrap();
    let copy_title = f
        .vault
        .keep_conflict_copy(&DocTarget::Note { id: id.clone() })
        .unwrap()
        .unwrap();
    let copy = f
        .vault
        .note_list_full(false)
        .unwrap()
        .into_iter()
        .find(|note| note.title == copy_title)
        .unwrap();
    assert_eq!(copy.conflict_of.as_deref(), Some(id.as_str()));
    // 自己另存的只报在 conflicts 里，不重复当「新发现的副本」
    let announced = f.take_announced();
    assert!(announced.iter().all(|change| change.found_copies.is_empty()));
}

/* ---------------- 反向链接 ---------------- */

#[test]
fn backlinks_come_from_notes_days_and_goals() {
    let mut f = fixture();
    let target = f.vault.note_create("周报", "自己链自己 [[周报]] 不算").unwrap();
    f.vault
        .note_create("复盘", "- 回看 [[周报]] 的结论\n另一处 [[ 周报 |上周的]]\n```\n[[周报]]\n```")
        .unwrap();
    f.vault.note_create("无关", "[[别的笔记]]").unwrap();
    f.vault.save_day("2026-10-06", "周一", "- [ ] 整理 [[周报#结论]]").unwrap();
    f.vault.save_goal("week", "2026-10-05", "## 目标\n写完 [[周报]]").unwrap();

    let links = f.vault.backlinks(&target).unwrap();
    let titles: Vec<&str> = links.iter().map(|link| link.title.as_str()).collect();
    assert_eq!(links.len(), 3, "{titles:?}");
    let note = links.iter().find(|link| link.kind == "note").unwrap();
    assert_eq!(note.title, "复盘");
    assert_eq!(note.count, 2, "代码块里的不算");
    assert_eq!(note.lines[0].text, "回看 [[周报]] 的结论");
    assert_eq!(note.lines[1].line, 1);
    let day = links.iter().find(|link| link.kind == "day").unwrap();
    assert_eq!(day.title, "10月6日 · 周一");
    assert_eq!(day.lines[0].text, "整理 [[周报#结论]]");
    assert!(matches!(&day.target, DocTarget::Day { id } if id == "2026-10-06"));
    let goal = links.iter().find(|link| link.kind == "goal").unwrap();
    assert_eq!(goal.title, "第 41 周目标");
}

/* ---------------- 改标题时改别处的双链 ---------------- */

fn rename(f: &mut Fixture, id: &str, title: &str) -> Relink {
    let note = f.vault.note_get(id).unwrap();
    f.vault.note_update(id, title, &note.content_md).unwrap();
    f.vault.relink(id, &note.title).unwrap()
}

#[test]
fn renaming_a_note_rewrites_links_to_it_everywhere() {
    let mut f = fixture();
    let target = f.vault.note_create("周报", "自己链自己 [[周报]]").unwrap();
    let review = f
        .vault
        .note_create("复盘", "回看 [[周报]] 和 [[ 周报 |上周的]]，结论在 [[周报#结论]]\n`[[周报]]` 是代码")
        .unwrap();
    f.vault.note_create("无关", "[[别的笔记]]").unwrap();
    f.vault.save_day("2026-10-06", "", "- [ ] 整理 [[周报]]").unwrap();
    f.take_announced();

    let result = rename(&mut f, &target, "月报");
    assert_eq!(result.skipped, None);
    assert_eq!(result.links, 4);
    assert_eq!(result.docs.len(), 2, "{:?}", result.docs);
    assert_eq!(
        f.vault.note_get(&review).unwrap().content_md,
        "回看 [[月报]] 和 [[ 月报 |上周的]]，结论在 [[月报#结论]]\n`[[周报]]` 是代码"
    );
    assert_eq!(f.vault.day("2026-10-06", false).unwrap().note_md, "- [ ] 整理 [[月报]]");
    assert_eq!(
        f.vault.note_get(&target).unwrap().content_md,
        "自己链自己 [[周报]]",
        "自己这篇不动：它正开在编辑器里"
    );
    let announced = f.take_announced();
    assert!(announced.iter().any(|change| change.notes.contains(&review)));
    assert!(announced.iter().any(|change| change.days.iter().any(|d| d == "2026-10-06")));
    // 反向链接跟着新标题走
    assert_eq!(f.vault.backlinks(&target).unwrap().len(), 2);

    // 撤销：换回原来的样子；撤销之前又改过的那篇不动
    let day = f.vault.day("2026-10-06", false).unwrap();
    f.vault
        .save_day("2026-10-06", "", &format!("{}\n后来加的一行", day.note_md))
        .unwrap();
    assert_eq!(f.vault.relink_undo(&result.rewrites).unwrap(), 1);
    assert!(f.vault.note_get(&review).unwrap().content_md.starts_with("回看 [[周报]]"));
    assert!(f.vault.day("2026-10-06", false).unwrap().note_md.contains("后来加的一行"));
}

#[test]
fn links_are_left_alone_when_the_rename_would_make_them_ambiguous() {
    let mut f = fixture();
    let target = f.vault.note_create("周报", "").unwrap();
    let review = f.vault.note_create("复盘", "看 [[周报]]").unwrap();

    // 新标题写不进双链
    let result = rename(&mut f, &target, "C# 周报");
    assert_eq!(result.links, 1);
    assert!(result.skipped.as_deref().unwrap().contains("写不进双链"));
    assert!(result.rewrites.is_empty());
    assert_eq!(f.vault.note_get(&review).unwrap().content_md, "看 [[周报]]");
    rename(&mut f, &target, "周报");

    // 新标题已经有别的笔记在用
    f.vault.note_create("月报", "").unwrap();
    let result = rename(&mut f, &target, "月报");
    assert!(result.skipped.as_deref().unwrap().contains("已经有一篇叫「月报」"));
    assert_eq!(f.vault.note_get(&review).unwrap().content_md, "看 [[周报]]");
    rename(&mut f, &target, "周报");

    // 还有一篇也叫旧标题：链接仍然指着它
    f.vault.note_create("周报", "同名的另一篇").unwrap();
    let result = rename(&mut f, &target, "季报");
    assert!(result.skipped.as_deref().unwrap().contains("还有一篇也叫「周报」"));
    assert_eq!(f.vault.note_get(&review).unwrap().content_md, "看 [[周报]]");

    // 只改了大小写、或者没人链它：什么都不做
    let other = f.vault.note_create("Weekly", "").unwrap();
    f.vault.note_create("引用", "[[weekly]]").unwrap();
    let result = rename(&mut f, &other, "WEEKLY");
    assert_eq!((result.links, result.skipped), (0, None));
    let lonely = f.vault.note_create("孤零零", "").unwrap();
    assert_eq!(rename(&mut f, &lonely, "还是孤零零").links, 0);
}

#[test]
fn relink_keeps_the_properties_block_and_external_edits() {
    let mut f = fixture();
    let target = f.vault.note_create("周报", "").unwrap();
    let review = f.vault.note_create("复盘", "看 [[周报]]").unwrap();
    let rel = f.vault.note_get(&review).unwrap().rel_path;
    // 别的程序刚改过（索引还没跟上），属性块里还有别的工具写的键
    let text = f.read(&rel).replace("看 [[周报]]", "看 [[周报]]，外部加了一句");
    let text = text.replacen("---\n", "---\ntags: [工作]\n", 1);
    f.write_externally(&rel, &text);

    rename(&mut f, &target, "月报");
    let after = f.read(&rel);
    assert!(after.contains("tags: [工作]"), "{after}");
    assert!(after.contains(&format!("id: {review}")));
    assert!(after.ends_with("看 [[月报]]，外部加了一句"), "{after}");
}

/* ---------------- 文件夹 ---------------- */

#[test]
fn folders_are_directories_under_notes() {
    let mut f = fixture();
    assert_eq!(f.vault.folder_create("", "工作").unwrap(), "工作");
    assert_eq!(f.vault.folder_create("", "工作").unwrap(), "工作 2", "重名加序号");
    assert_eq!(f.vault.folder_create("工作", "周报").unwrap(), "工作/周报");
    assert_eq!(f.vault.folder_create("", "a/b:c").unwrap(), "a／b：c", "非法字符换成全角");
    assert!(f.vault.folder_create("", "  ").is_err());
    assert!(f.vault.folder_create("不存在", "x").is_err());
    assert!(f.vault.folder_create("../外面", "x").is_err());
    assert_eq!(f.vault.folders(), vec!["a／b：c", "工作", "工作 2", "工作/周报"]);
    assert!(f.exists("笔记/工作/周报"));
}

#[test]
fn notes_are_created_in_and_moved_between_folders() {
    let mut f = fixture();
    f.vault.folder_create("", "工作").unwrap();
    f.vault.folder_create("工作", "周报").unwrap();
    let id = f.vault.note_create_in("工作", "第 40 周", "正文").unwrap();
    assert_eq!(f.vault.note_get(&id).unwrap().rel_path, "笔记/工作/第 40 周.md");

    let moved = f.vault.note_move(&id, "工作/周报").unwrap();
    assert_eq!(moved.rel_path, "笔记/工作/周报/第 40 周.md");
    assert_eq!(moved.id, id);
    assert_eq!(moved.content_md, "正文");
    assert!(f.exists("笔记/工作"), "挪空了的文件夹留着");

    // 目标文件夹里已经有同名的：加序号，标题不变
    f.vault.note_create_in("", "第 40 周", "另一篇").unwrap();
    let back = f.vault.note_move(&id, "").unwrap();
    assert_eq!(back.rel_path, "笔记/第 40 周 2.md");
    assert_eq!(back.title, "第 40 周");

    assert!(matches!(f.vault.note_move(&id, "不存在"), Err(AppError::NotFound(_))));
    f.vault.note_archive(&id, None).unwrap();
    assert!(f.vault.note_move(&id, "工作").is_err(), "归档里的先恢复再移动");
}

#[test]
fn moving_a_note_keeps_its_relative_images_working() {
    let mut f = fixture();
    let id = f.vault.note_create("周报", "").unwrap();
    let image = f
        .vault
        .attach(&DocTarget::Note { id: id.clone() }, "图.png", b"png")
        .unwrap();
    let body = format!("![图]({})\n[网](https://example.com)", image.link);
    f.vault.note_update(&id, "周报", &body).unwrap();
    f.vault.folder_create("", "工作").unwrap();
    f.vault.folder_create("工作", "周报").unwrap();
    f.take_announced();

    let moved = f.vault.note_move(&id, "工作/周报").unwrap();
    assert_eq!(moved.content_md, "![图](../../../附件/图.png)\n[网](https://example.com)");
    // 正文变了：告诉前端，编辑器换上新正文
    assert!(f.take_announced().iter().any(|change| change.notes.contains(&id)));

    f.vault.note_move(&id, "").unwrap();
    assert_eq!(f.vault.note_get(&id).unwrap().content_md, body);
}

#[test]
fn archived_notes_go_back_to_their_folder() {
    let mut f = fixture();
    f.vault.folder_create("", "工作").unwrap();
    let id = f.vault.note_create_in("工作", "复盘", "x").unwrap();
    f.vault.note_archive(&id, None).unwrap();
    assert_eq!(f.files(), vec!["归档/复盘.md"]);
    assert!(f.read("归档/复盘.md").contains("archived-from: \"笔记/工作\"\n"));

    // 文件夹在这期间被删了：恢复时重新建上
    f.vault.folder_delete("工作").unwrap();
    f.vault.note_restore(&id).unwrap();
    assert_eq!(f.files(), vec!["笔记/工作/复盘.md"]);
    assert!(!f.read("笔记/工作/复盘.md").contains("archived-from"));
    assert_eq!(f.vault.folders(), vec!["工作"]);
}

#[test]
fn renaming_a_folder_moves_its_notes_and_keeps_their_ids() {
    let mut f = fixture();
    f.vault.folder_create("", "工作").unwrap();
    f.vault.folder_create("工作", "周报").unwrap();
    let a = f.vault.note_create_in("工作", "复盘", "").unwrap();
    let b = f.vault.note_create_in("工作/周报", "第 40 周", "").unwrap();
    f.vault.folder_create("", "项目").unwrap();
    f.take_announced();

    assert_eq!(f.vault.folder_rename("工作", "项目").unwrap(), "项目 2", "撞上了加序号");
    assert_eq!(f.vault.note_get(&a).unwrap().rel_path, "笔记/项目 2/复盘.md");
    assert_eq!(f.vault.note_get(&b).unwrap().rel_path, "笔记/项目 2/周报/第 40 周.md");
    let announced = f.take_announced();
    assert!(announced.iter().any(|change| change.notes.contains(&a) && change.notes.contains(&b)));
    assert_eq!(f.vault.folders(), vec!["项目", "项目 2", "项目 2/周报"]);

    // 外部扫一遍：文件和索引对得上，什么都没变
    assert!(f.vault.rescan().unwrap().is_empty());
    assert_eq!(f.vault.folder_rename("项目 2", "项目 2").unwrap(), "项目 2");
    assert!(f.vault.folder_rename("", "x").is_err());
}

#[test]
fn deleting_a_folder_trashes_its_notes_and_can_be_undone() {
    let mut f = fixture();
    f.vault.folder_create("", "读书").unwrap();
    f.vault.folder_create("读书", "小说").unwrap();
    f.vault.folder_create("读书", "空的").unwrap();
    let a = f.vault.note_create_in("读书", "摘录", "a").unwrap();
    let b = f.vault.note_create_in("读书/小说", "长安的荔枝", "- [ ] 还书 @2026-10-08").unwrap();

    let deletion = f.vault.folder_delete("读书").unwrap();
    assert_eq!(deletion.notes, vec![b.clone(), a.clone()], "按路径：小说/ 排在 摘录 前面");
    assert_eq!(deletion.folders, vec!["读书", "读书/小说", "读书/空的"]);
    assert!(!deletion.kept);
    assert!(!f.exists("笔记/读书"));
    assert!(f.vault.note_list_full(false).unwrap().is_empty());
    assert!(f.vault.marked_dates("2026-10-01", "2026-10-31").unwrap().is_empty());

    f.vault.folder_undelete(&deletion).unwrap();
    assert_eq!(f.files(), vec!["笔记/读书/小说/长安的荔枝.md", "笔记/读书/摘录.md"]);
    assert!(f.exists("笔记/读书/空的"), "空的子文件夹也建回来");
    assert_eq!(f.vault.note_get(&b).unwrap().content_md, "- [ ] 还书 @2026-10-08");

    // 文件夹里还有别的文件：笔记照样进回收站，目录留着
    std::fs::write(fsio::abs(&f.root, "笔记/读书/封面.png"), b"png").unwrap();
    let deletion = f.vault.folder_delete("读书").unwrap();
    assert!(deletion.kept);
    assert!(f.exists("笔记/读书/封面.png"));
    assert_eq!(f.vault.folders(), vec!["读书"]);
}

#[test]
fn folders_made_outside_the_app_are_announced() {
    let mut f = fixture();
    assert!(!f.vault.rescan().unwrap().folders);
    std::fs::create_dir_all(fsio::abs(&f.root, "笔记/资源管理器里建的")).unwrap();
    assert!(f.vault.rescan().unwrap().folders);
    assert!(!f.vault.rescan().unwrap().folders, "没再变就不报");
    // 应用自己建的：缓存已经跟上了，扫描时不当成外部变化
    f.vault.folder_create("", "应用里建的").unwrap();
    assert!(!f.vault.rescan().unwrap().folders);
}

/* ---------------- 附件 ---------------- */

#[test]
fn attachments_go_into_the_attachment_folder_with_relative_links() {
    let mut f = fixture();
    let id = f.vault.note_create("周报", "").unwrap();
    let note = DocTarget::Note { id };

    let pasted = f.vault.attach(&note, "image.png", b"png-bytes").unwrap();
    assert!(pasted.name.starts_with("粘贴-") && pasted.name.ends_with(".png"), "{}", pasted.name);
    assert_eq!(pasted.link, format!("../附件/{}", pasted.name));
    assert!(pasted.is_image);
    assert!(f.exists(&format!("附件/{}", pasted.name)));

    let first = f.vault.attach(&note, "屏幕 截图.PNG", b"a").unwrap();
    assert_eq!(first.name, "屏幕-截图.png");
    // 同名同内容：直接用已有的那个
    let same = f.vault.attach(&note, "屏幕 截图.PNG", b"a").unwrap();
    assert_eq!(same.name, "屏幕-截图.png");
    // 同名不同内容：换个名字
    let other = f.vault.attach(&note, "屏幕 截图.PNG", b"b").unwrap();
    assert_eq!(other.name, "屏幕-截图-2.png");

    // 某一天在 日记/2026/ 下面，要往上两层
    let day = f
        .vault
        .attach(&DocTarget::Day { id: "2026-10-06".into() }, "a.pdf", b"pdf")
        .unwrap();
    assert_eq!(day.link, "../../附件/a.pdf");
    assert!(!day.is_image);
    assert!(f.vault.attach(&note, "空.png", b"").is_err());
    // 附件不是笔记：不进索引
    assert_eq!(f.vault.note_list_full(false).unwrap().len(), 1);
}

#[test]
fn dropped_files_are_copied_unless_already_attached() {
    let mut f = fixture();
    let id = f.vault.note_create("周报", "").unwrap();
    let note = DocTarget::Note { id };
    let outside = f._dir.path().join("桌面截图.jpg");
    std::fs::write(&outside, b"jpg").unwrap();

    let copied = f.vault.attach_path(&note, &outside).unwrap();
    assert_eq!(copied.link, "../附件/桌面截图.jpg");
    assert!(f.exists("附件/桌面截图.jpg"));
    assert!(outside.exists(), "原文件不动");

    let again = f
        .vault
        .attach_path(&note, &fsio::abs(&f.root, "附件/桌面截图.jpg"))
        .unwrap();
    assert_eq!(again.name, "桌面截图.jpg");
}

#[test]
fn the_index_can_be_thrown_away_and_rebuilt_from_files() {
    let mut f = fixture();
    let id = f.vault.note_create("周报: 第 3 期", "内容 @x").unwrap();
    f.vault.note_set_pinned(&id, true).unwrap();
    f.vault.save_day("2026-09-26", "周六", "- [ ] 跑步").unwrap();
    f.vault.save_goal("month", "2026-09-01", "九月").unwrap();
    let before = (
        f.vault.note_list_full(false).unwrap()[0].clone(),
        f.vault.day("2026-09-26", false).unwrap(),
        f.vault.goal("month", "2026-09-01").unwrap(),
    );

    let mut rebuilt = Vault::open_in_memory(&f.root);
    let note = rebuilt.note_get(&id).unwrap();
    assert_eq!(note.title, before.0.title);
    assert_eq!(note.is_pinned, before.0.is_pinned);
    assert_eq!(note.created_at, before.0.created_at);
    assert_eq!(note.updated_at, before.0.updated_at);
    assert_eq!(rebuilt.day("2026-09-26", false).unwrap().title, before.1.title);
    assert_eq!(rebuilt.goal("month", "2026-09-01").unwrap().id, before.2.id);
}

#[test]
fn locates_files_for_revealing_them() {
    let mut f = fixture();
    let id = f.vault.note_create("周报", "x").unwrap();
    let (path, is_file) = f.vault.locate(&DocTarget::Note { id }).unwrap();
    assert!(is_file);
    assert_eq!(path, fsio::abs(&f.root, "笔记/周报.md"));

    // 还没写过的某一天：给它将来所在的、已经存在的那一层
    let (path, is_file) = f
        .vault
        .locate(&DocTarget::Day {
            id: "2030-01-01".into(),
        })
        .unwrap();
    assert!(!is_file);
    assert_eq!(path, f.root);
}

#[test]
fn activity_is_logged_as_json_lines() {
    let mut f = fixture();
    let id = f.vault.note_create("复盘", "- [ ] 交稿 @2026-09-04").unwrap();
    let task = f.vault.day("2026-09-04", false).unwrap().tasks[0].id.clone();
    f.vault.toggle_task(&task).unwrap();
    f.vault.note_archive(&id, None).unwrap();

    let entries = activity::read_all(&fsio::abs(&f.root, layout::ACTIVITY_DIR));
    let actions: Vec<_> = entries.iter().map(|entry| entry.action.as_str()).collect();
    assert_eq!(actions, vec!["created", "completed", "archived"]);
    assert_eq!(entries[1].detail.as_deref(), Some("交稿"));
}

/* ---------------- 启动时文件很多：后台分批读（open_quick） ---------------- */

fn write_notes(root: &Path, count: usize) {
    for i in 0..count {
        let rel = format!("笔记/第{i}篇.md");
        fsio::write_atomic(&fsio::abs(root, &rel), &format!("第 {i} 篇的正文")).unwrap();
    }
}

/// 把后台那批读完，返回读了几批
fn drain(vault: &mut Vault, backlog: &mut Backlog) -> usize {
    let mut batches = 0;
    while !backlog.is_empty() {
        vault.index_backlog(backlog, Some(std::time::Duration::from_millis(2)));
        batches += 1;
    }
    batches
}

#[test]
fn a_few_changed_files_are_read_right_away() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    write_notes(&root, 20);
    let (vault, backlog) = Vault::open_quick(&root, &dir.path().join("index.db")).unwrap();
    assert!(backlog.is_empty());
    assert_eq!(vault.note_list_full(false).unwrap().len(), 20);
}

#[test]
fn a_big_folder_is_read_in_the_background_in_batches() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    let index = dir.path().join("index.db");
    write_notes(&root, 260);
    let (mut vault, mut backlog) = Vault::open_quick(&root, &index).unwrap();
    assert_eq!(backlog.total(), 260);
    assert!(vault.note_list_full(false).unwrap().is_empty(), "窗口出来之前一篇都不读");

    assert!(drain(&mut vault, &mut backlog) > 1, "分好几批读，中间放开锁");
    assert_eq!(backlog.done(), 260);
    let notes = vault.note_list_full(false).unwrap();
    assert_eq!(notes.len(), 260);
    assert!(notes.iter().any(|note| note.title == "第7篇" && note.content_md == "第 7 篇的正文"));

    // 下次启动都在索引里了
    drop(vault);
    let (_, backlog) = Vault::open_quick(&root, &index).unwrap();
    assert_eq!(backlog.total(), 0);
}

#[test]
fn files_changed_while_waiting_in_the_backlog_are_read_as_they_are_now() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    write_notes(&root, 260);
    let (mut vault, mut backlog) = Vault::open_quick(&root, &dir.path().join("index.db")).unwrap();

    // 轮到它们之前：一篇被别的程序改了，一篇删了，一篇应用自己存过（已经在索引里）
    fsio::write_atomic(&fsio::abs(&root, "笔记/第0篇.md"), "后来改过").unwrap();
    std::fs::remove_file(fsio::abs(&root, "笔记/第1篇.md")).unwrap();
    let id = vault.note_create("新写的", "应用里写的").unwrap();

    drain(&mut vault, &mut backlog);
    let notes = vault.note_list_full(false).unwrap();
    assert_eq!(notes.len(), 260, "259 篇原有的 + 1 篇新写的");
    assert!(notes.iter().any(|note| note.title == "第0篇" && note.content_md == "后来改过"));
    assert!(!notes.iter().any(|note| note.title == "第1篇"));
    assert_eq!(vault.note_get(&id).unwrap().content_md, "应用里写的");
}

#[test]
fn a_day_or_goal_not_read_yet_is_read_when_asked_for() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    write_notes(&root, 260);
    let day = layout::day_path("2026-10-13").unwrap();
    fsio::write_atomic(&fsio::abs(&root, &day), "今天的记录").unwrap();
    let goal = layout::goal_path("week", "2026-10-12").unwrap();
    fsio::write_atomic(&fsio::abs(&root, &goal), "本周重点").unwrap();
    let (mut vault, backlog) = Vault::open_quick(&root, &dir.path().join("index.db")).unwrap();
    assert!(!backlog.is_empty());

    // 后台还没读到它们。以前拿到的是空文档，用户一编辑就把磁盘上的盖掉了
    let today = vault.day("2026-10-13", true).unwrap();
    assert_eq!(today.note_md, "今天的记录");
    assert_eq!(today.carried_from, None);
    assert_eq!(vault.goal("week", "2026-10-12").unwrap().content_md, "本周重点");

    vault.save_day("2026-10-13", "", "今天的记录\n再加一行").unwrap();
    assert_eq!(
        std::fs::read_to_string(fsio::abs(&root, &day)).unwrap(),
        "今天的记录\n再加一行"
    );
}

#[test]
fn a_backlog_from_another_vault_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("第一个");
    write_notes(&first, 260);
    let (_, mut backlog) = Vault::open_quick(&first, &dir.path().join("a.db")).unwrap();
    let (mut other, _) = Vault::open_quick(&dir.path().join("第二个"), &dir.path().join("b.db")).unwrap();
    other.index_backlog(&mut backlog, None);
    assert!(backlog.is_empty());
    assert!(other.note_list_full(false).unwrap().is_empty());
}

/* ---------------- 大仓库的耗时（不进 CI，手动跑） ---------------- */

/// 两千篇笔记 + 一年的日记：启动时的扫描、建索引、全量列表、搜索、反向链接各要多久。在 src-tauri 下：
/// cargo test --release --no-default-features --lib large_vault_timings -- --ignored --nocapture
#[test]
#[ignore]
fn large_vault_timings() {
    use std::time::Instant;

    const NOTES: usize = 2000;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    let words = [
        "今天", "项目", "进度", "设计", "方案", "用户", "反馈", "读书", "笔记", "会议", "结论", "计划",
        "目标", "习惯", "跑步", "复盘", "发布", "测试",
    ];
    let mut seed = 7u64;
    let mut pick = |n: usize| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) as usize % n
    };
    let titles: Vec<String> = (0..NOTES)
        .map(|i| format!("{}{} {i}", words[i % words.len()], words[(i * 7) % words.len()]))
        .collect();
    let folders = ["", "工作", "工作/周报", "读书", "生活", "项目/OnTheWay"];
    let mut bytes = 0usize;
    for (i, title) in titles.iter().enumerate() {
        let mut body = String::new();
        let paragraphs = if pick(10) == 0 { 40 } else { 6 + pick(10) };
        for p in 0..paragraphs {
            if p % 4 == 0 {
                body.push_str(&format!("## 第{p}部分\n\n"));
            }
            for _ in 0..(20 + pick(40)) {
                body.push_str(words[pick(words.len())]);
            }
            body.push_str("。\n\n");
            if pick(5) == 0 {
                body.push_str(&format!("相关：[[{}]]\n\n", titles[pick(NOTES)]));
            }
            if pick(6) == 0 {
                let (word, month, day) = (words[pick(words.len())], 1 + pick(12), 1 + pick(28));
                body.push_str(&format!("- [ ] {word} @2026-{month:02}-{day:02}\n\n"));
            }
        }
        let folder = folders[i % folders.len()];
        let rel = if folder.is_empty() {
            format!("笔记/{title}.md")
        } else {
            format!("笔记/{folder}/{title}.md")
        };
        bytes += body.len();
        fsio::write_atomic(&fsio::abs(&root, &rel), &body).unwrap();
    }
    for d in 0..365 {
        let date = chrono::NaiveDate::from_ymd_opt(2025, 10, 1).unwrap() + chrono::Duration::days(d);
        let date = date.format("%Y-%m-%d").to_string();
        let word = words[pick(words.len())];
        let body = format!("- [x] 跑步\n- [ ] {word} @{date}\n\n{}。\n", words.repeat(3).concat());
        bytes += body.len();
        let rel = format!("日记/{}/{date}.md", &date[..4]);
        fsio::write_atomic(&fsio::abs(&root, &rel), &body).unwrap();
    }
    let index = dir.path().join("index.db");
    let mb = bytes as f64 / 1048576.0;
    eprintln!("仓库：{NOTES} 篇笔记 + 365 篇日记，正文共 {mb:.1} MB");

    // 应用启动走的路：窗口只等 open_quick，剩下的后台每批 50ms 读
    let quick = dir.path().join("quick.db");
    let t = Instant::now();
    let (mut vault, mut backlog) = Vault::open_quick(&root, &quick).unwrap();
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    let queued = backlog.total();
    eprintln!("第一次打开 open_quick       {ms:>8.1} ms（窗口只等这么久，{queued} 个文件交给后台）");
    let t = Instant::now();
    let mut batches = 0;
    while !backlog.is_empty() {
        vault.index_backlog(&mut backlog, Some(std::time::Duration::from_millis(50)));
        batches += 1;
    }
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    eprintln!("后台读完                    {ms:>8.1} ms，{batches} 批");
    drop(vault);

    let t = Instant::now();
    let vault = Vault::open(&root, &index).unwrap();
    eprintln!("第一次打开（建索引）        {:>8.1} ms", t.elapsed().as_secs_f64() * 1000.0);
    drop(vault);

    let t = Instant::now();
    let mut vault = Vault::open(&root, &index).unwrap();
    eprintln!("再次打开（只比对文件状态）  {:>8.1} ms", t.elapsed().as_secs_f64() * 1000.0);

    let t = Instant::now();
    let notes = vault.note_list_full(false).unwrap();
    let list_ms = t.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    let json = serde_json::to_string(&notes).unwrap();
    eprintln!(
        "note_list_full {} 篇          {:>8.1} ms，序列化 {:.1} ms，{:.1} MB JSON",
        notes.len(),
        list_ms,
        t.elapsed().as_secs_f64() * 1000.0,
        json.len() as f64 / 1048576.0
    );

    let t = Instant::now();
    let journal = vault.journal_list().unwrap();
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    eprintln!("journal_list {} 篇            {ms:>8.1} ms", journal.len());
    let t = Instant::now();
    vault.calendar_marks("2025-01-01", "2027-12-31").unwrap();
    eprintln!("calendar_marks 三年         {:>8.1} ms", t.elapsed().as_secs_f64() * 1000.0);
    let t = Instant::now();
    let hits = vault.search("项目 计划", 50).unwrap();
    eprintln!("search「项目 计划」         {:>8.1} ms", t.elapsed().as_secs_f64() * 1000.0);
    drop(hits);
    let id = notes[NOTES / 2].id.clone();
    let t = Instant::now();
    let links = vault.backlinks(&id).unwrap();
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    eprintln!("backlinks（{} 条）           {ms:>8.1} ms", links.len());
    let t = Instant::now();
    vault.day("2026-03-01", true).unwrap();
    eprintln!("day（某一天 + 带日期的任务） {:>8.1} ms", t.elapsed().as_secs_f64() * 1000.0);

    let text = format!("{}\n\n再写一段。", notes[10].content_md);
    let t = Instant::now();
    vault.note_update(&notes[10].id, &notes[10].title, &text).unwrap();
    eprintln!("note_update（自动保存一次）  {:>8.1} ms", t.elapsed().as_secs_f64() * 1000.0);
    let t = Instant::now();
    vault.rescan().unwrap();
    eprintln!("rescan（没有变化）           {:>8.1} ms", t.elapsed().as_secs_f64() * 1000.0);
}
