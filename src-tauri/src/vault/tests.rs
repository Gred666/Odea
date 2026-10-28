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
    assert!(f.exists(&format!(".odea/trash/{id}.md")));

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
    let trashed = fsio::abs(&f.root, &format!(".odea/trash/{id}.md"));
    fsio::set_mtime(&trashed, now_ms() - 31 * 86_400_000).unwrap();
    f.vault.purge_trash(30 * 86_400_000);
    assert!(!trashed.exists());
}

#[test]
fn the_trash_lists_deleted_notes_newest_first() {
    let mut f = fixture();
    assert!(f.vault.trash_list().unwrap().is_empty(), "还没有回收站");
    let old = f.vault.note_create("旧的", "早就删了").unwrap();
    f.vault.folder_create("", "工作").unwrap();
    let new = f.vault.note_create_in("工作", "周报", "刚删的").unwrap();
    f.vault.note_delete(&old).unwrap();
    f.vault.note_delete(&new).unwrap();
    let day = 86_400_000;
    fsio::set_mtime(&fsio::abs(&f.root, &format!(".odea/trash/{old}.md")), now_ms() - 3 * day).unwrap();
    // 退役的共享仓库挪进来的文件夹不算
    std::fs::create_dir_all(fsio::abs(&f.root, ".odea/trash/share-1")).unwrap();

    let trash = f.vault.trash_list().unwrap();
    assert_eq!(trash.len(), 2);
    assert_eq!(trash[0].id, new, "最近删的在前");
    assert_eq!(trash[0].title, "周报");
    assert_eq!(trash[0].from, "笔记/工作/周报.md");
    assert_eq!(trash[0].excerpt, "刚删的");
    assert_eq!(trash[1].title, "旧的");
    assert_eq!(trash[1].purge_at - trash[1].deleted_at, TRASH_KEEP_DAYS * day);

    f.vault.note_undelete(&trash[1].id).unwrap();
    assert_eq!(f.vault.note_get(&old).unwrap().content_md, "早就删了");
    assert_eq!(f.vault.trash_list().unwrap().len(), 1);
}

fn find(f: &Fixture, query: &str, options: FindOptions) -> FindResult {
    find_text(&f.vault.db, query, options, || false).unwrap().unwrap()
}

fn note_id(target: &DocTarget) -> &str {
    match target {
        DocTarget::Note { id } => id,
        other => panic!("不是笔记: {other:?}"),
    }
}

#[test]
fn find_lists_every_match_with_its_line_and_utf16_column() {
    let mut f = fixture();
    let id = f
        .vault
        .note_create("周报", "第一行\n今天的进度还可以，进度不错\n🙂进度\n没有")
        .unwrap();
    f.vault.note_create("周末采购", "燕麦奶、灯泡、咖啡豆。").unwrap();
    // 双字词、跨了词的边界都照样找到（以前的分词搜不到「度还」）
    let found = find(&f, "进度", FindOptions::default());
    assert_eq!(found.total, 3);
    assert!(!found.truncated && found.error.is_none());
    assert_eq!(found.files.len(), 1);
    let file = &found.files[0];
    assert_eq!(note_id(&file.target), id);
    assert_eq!((file.title.as_str(), file.count), ("周报", 3));
    let at: Vec<_> = file.matches.iter().map(|m| (m.line, m.column, m.length)).collect();
    // 行号从 1 数；列按 UTF-16 数，🙂 占两个
    assert_eq!(at, vec![(2, 3, 2), (2, 9, 2), (3, 2, 2)]);
    let first = &file.matches[0];
    assert_eq!(
        (first.before.as_str(), first.text.as_str(), first.after.as_str()),
        ("今天的", "进度", "还可以，进度不错")
    );
    assert_eq!(find(&f, "度还", FindOptions::default()).total, 1);
    assert_eq!(find(&f, "", FindOptions::default()).files.len(), 0);
}

#[test]
fn find_orders_notes_then_archive_then_journal_and_skips_titles() {
    let mut f = fixture();
    let older = f.vault.note_create("较早", "进度").unwrap();
    let pinned = f.vault.note_create("置顶的", "进度").unwrap();
    f.vault.note_set_pinned(&pinned, true).unwrap();
    let newer = f.vault.note_create("较新", "进度").unwrap();
    let archived = f.vault.note_create("归档的", "进度").unwrap();
    f.vault.note_archive(&archived, None).unwrap();
    f.vault.note_create("进度", "标题里有，正文里没有").unwrap();
    f.vault.save_day("2026-09-04", "周报", "进度还可以").unwrap();
    f.vault.save_goal("week", "2026-08-31", "- [ ] 进度更快").unwrap();

    let found = find(&f, "进度", FindOptions::default());
    let notes: Vec<_> = found
        .files
        .iter()
        .filter(|file| matches!(file.target, DocTarget::Note { .. }))
        .map(|file| note_id(&file.target).to_string())
        .collect();
    assert_eq!(notes.len(), 4, "只有标题里有的不算：{notes:?}");
    assert_eq!(notes[0], pinned, "置顶的在前");
    assert_eq!(notes.last(), Some(&archived), "归档的在笔记后面");
    assert!(notes.contains(&older) && notes.contains(&newer));
    // 日记和目标在所有笔记后面
    let kinds: Vec<_> = found.files.iter().map(|file| matches!(file.target, DocTarget::Note { .. })).collect();
    assert_eq!(kinds, vec![true, true, true, true, false, false]);
    assert!(found.files.iter().any(|file| file.title == "9月4日 · 周报"));
}

#[test]
fn find_options_work_like_the_editor_search_panel() {
    let mut f = fixture();
    f.vault
        .note_create("英文", "Cat concat CAT cat_food\n日期 2026-10-16 和 2026-1-2")
        .unwrap();
    f.vault.note_create("中文", "写笔记本\n「笔记」\n笔记 很多").unwrap();
    let opts = |case_sensitive, whole_word, regex| FindOptions {
        case_sensitive,
        whole_word,
        regex,
    };
    let texts = |found: &FindResult| -> Vec<String> {
        found.files.iter().flat_map(|file| file.matches.iter().map(|m| m.text.clone())).collect()
    };
    assert_eq!(find(&f, "cat", opts(false, false, false)).total, 4);
    assert_eq!(texts(&find(&f, "cat", opts(true, false, false))), vec!["cat", "cat"]);
    // 全词：concat、cat_food 里的不算（下划线算词的一部分）
    assert_eq!(texts(&find(&f, "cat", opts(false, true, false))), vec!["Cat", "CAT"]);
    // 汉字也算词字符：「写笔记本」里的不是一个词，两边是标点、空格的才是
    let words = find(&f, "笔记", opts(false, true, false));
    let lines: Vec<_> = words.files[0].matches.iter().map(|m| m.line).collect();
    assert_eq!(lines, vec![2, 3]);
    // 正则
    assert_eq!(texts(&find(&f, r"\d{4}-\d{2}-\d{2}", opts(false, false, true))), vec!["2026-10-16"]);
    // 不是正则时，正则的符号就是字面上的字
    assert_eq!(find(&f, "2026-1.-16", opts(false, false, false)).total, 0);
    assert_eq!(find(&f, "2026-1.-16", opts(false, false, true)).total, 1);
    // 正则写错了：给出原因，不是报错
    let bad = find(&f, "(进度", opts(false, false, true));
    assert!(bad.files.is_empty());
    assert!(bad.error.as_deref().is_some_and(|reason| !reason.is_empty()), "{:?}", bad.error);
}

#[test]
fn find_caps_the_matches_it_returns_but_counts_them_all() {
    let mut f = fixture();
    f.vault.note_create("一", &"的\n".repeat(FIND_MATCH_LIMIT - 10)).unwrap();
    f.vault.note_create("二", &"的".repeat(30)).unwrap();
    // 归档的排在笔记后面：前两篇用完了名额，它不列出来
    let archived = f.vault.note_create("三", "的").unwrap();
    f.vault.note_archive(&archived, None).unwrap();
    let found = find(&f, "的", FindOptions::default());
    assert_eq!(found.total as usize, FIND_MATCH_LIMIT + 21);
    assert!(found.truncated);
    let given: usize = found.files.iter().map(|file| file.matches.len()).sum();
    assert_eq!(given, FIND_MATCH_LIMIT);
    assert_eq!(found.files.len(), 2);
    assert!(found.files.iter().all(|file| note_id(&file.target) != archived));
    // 每篇的数都是全的；给不全的只有最后列出的那篇（两篇谁新谁旧不一定，同一毫秒建的）
    let counts: Vec<_> = found.files.iter().map(|file| (file.matches.len(), file.count as usize)).collect();
    assert!(counts[0].0 == counts[0].1 && counts[1].0 < counts[1].1, "{counts:?}");
    // 又来了新的搜索：这一次作废
    assert!(find_text(&f.vault.db, "的", FindOptions::default(), || true).unwrap().is_none());
}

#[test]
fn find_counts_all_matches_of_one_huge_document() {
    let mut f = fixture();
    f.vault.note_create("大", &"的的的的的\n".repeat(FIND_MATCH_LIMIT)).unwrap();
    let found = find(&f, "的", FindOptions::default());
    assert_eq!(found.total as usize, FIND_MATCH_LIMIT * 5);
    assert!(found.truncated);
    let file = &found.files[0];
    assert_eq!((file.matches.len(), file.count as usize), (FIND_MATCH_LIMIT, FIND_MATCH_LIMIT * 5));
    assert_eq!(file.matches.last().map(|m| (m.line, m.column)), Some((200, 4)));
}

#[test]
fn find_clips_long_lines_around_the_match() {
    let mut f = fixture();
    let line = format!("  {}目标{}\r", "前".repeat(100), "后".repeat(300));
    f.vault.note_create("长", &format!("{line}\n下一行")).unwrap();
    let found = find(&f, "目标", FindOptions::default());
    let hit = &found.files[0].matches[0];
    assert_eq!(hit.before, format!("…{}", "前".repeat(32)));
    assert_eq!(hit.text, "目标");
    assert_eq!(hit.after, format!("{}…", "后".repeat(160)));
    // 列算的是原样的整行（行首的空格也算），和编辑器里的位置对得上
    assert_eq!((hit.line, hit.column), (1, 102));
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
fn the_journal_lists_written_days_and_goals_by_title() {
    let mut f = fixture();
    f.vault.note_create("笔记不算", "正文").unwrap();
    f.vault.save_day("2026-09-04", "周报", "今天开会").unwrap();
    f.vault.save_goal("week", "2026-08-31", "本周重点").unwrap();
    f.vault.save_day("2026-09-05", "", "").unwrap();

    let journal = f.vault.journal_list().unwrap();
    let mut titles: Vec<(&str, &str)> = journal
        .iter()
        .map(|doc| (doc.kind.as_str(), doc.title.as_str()))
        .collect();
    titles.sort();
    assert_eq!(titles, vec![("day", "9月4日 · 周报"), ("goal", "第 36 周目标")]);
}

#[test]
fn note_lists_carry_everything_but_the_body() {
    let mut f = fixture();
    let a = f.vault.note_create("甲", "甲的正文").unwrap();
    let b = f.vault.note_create("乙", "乙的正文").unwrap();
    f.vault.note_set_pinned(&b, true).unwrap();
    let c = f.vault.note_create("丙", "丙的正文").unwrap();
    f.vault.note_archive(&c, None).unwrap();

    for archived in [false, true] {
        let full = f.vault.note_list_full(archived).unwrap();
        let light = f.vault.note_list(archived).unwrap();
        assert_eq!(
            light.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            full.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            "顺序和带正文的列表一样"
        );
        for (summary, note) in light.iter().zip(&full) {
            let mut json = serde_json::to_value(note).unwrap();
            json.as_object_mut().unwrap().remove("contentMd");
            assert_eq!(serde_json::to_value(summary).unwrap(), json);
        }
    }
    assert_eq!(f.vault.note_list(false).unwrap()[0].id, b, "置顶的在前");
    assert!(f.vault.note_list(false).unwrap().iter().any(|n| n.id == a));
}

fn text_search(f: &Fixture, query: &str, limit: usize) -> TextSearch {
    search_text(&f.vault.db, query, limit, false, || false).unwrap().unwrap()
}

#[test]
fn text_search_finds_substrings_like_the_palette_did() {
    let mut f = fixture();
    let older = f.vault.note_create("较早", "第一行\n今天的进度还可以，Hello World\n末行").unwrap();
    let newer = f.vault.note_create("较新", "进度还可以").unwrap();
    let only_title = f.vault.note_create("进度还可以", "正文里没有").unwrap();
    let archived = f.vault.note_create("归档的", "进度还可以吗").unwrap();
    f.vault.note_archive(&archived, None).unwrap();
    f.vault.save_day("2026-09-04", "周报", "进度还可以\n明天继续").unwrap();
    f.vault.save_goal("week", "2026-08-31", "- [ ] 进度还可以更快").unwrap();

    // 跨了分词的边界（「进度」「还」「可以」）也找得到；只有标题里有的不算
    let found = text_search(&f, "度还可", 10);
    let ids: Vec<_> = found
        .notes
        .iter()
        .map(|hit| match &hit.target {
            DocTarget::Note { id } => id.clone(),
            other => panic!("不是笔记: {other:?}"),
        })
        .collect();
    assert!(!ids.contains(&only_title));
    assert_eq!(ids.last(), Some(&archived), "归档的排在后面");
    assert!(ids.contains(&older) && ids.contains(&newer));
    // 返回命中的那一整行，原样
    let line_of = |id: &str| {
        found.notes.iter().find(|hit| matches!(&hit.target, DocTarget::Note { id: i } if i == id)).unwrap().line.clone()
    };
    assert_eq!(line_of(&older), "今天的进度还可以，Hello World");
    assert_eq!(found.journal.len(), 2, "某一天和目标的正文也搜");
    assert!(found.journal.iter().any(|hit| hit.title == "9月4日 · 周报" && hit.line == "进度还可以"));

    // 大小写不敏感
    let found = text_search(&f, "hello WORLD", 10);
    assert_eq!(found.notes.len(), 1);
    assert_eq!(found.notes[0].title, "较早");

    // limit 各管各的；空的什么也不找
    assert_eq!(text_search(&f, "进度", 1).notes.len(), 1);
    assert_eq!(text_search(&f, "进度", 1).journal.len(), 1);
    assert!(text_search(&f, "  ", 10).notes.is_empty());
    // 归档的搜索框只要归档里的
    let found = search_text(&f.vault.db, "度还可", 10, true, || false).unwrap().unwrap();
    assert_eq!(found.notes.len(), 1);
    assert!(matches!(&found.notes[0].target, DocTarget::Note { id } if *id == archived));
    assert!(found.journal.is_empty());
    // 又来了新的搜索：这一次作废
    assert!(search_text(&f.vault.db, "进度", 10, false, || true).unwrap().is_none());
}

#[test]
fn text_search_clips_very_long_lines_around_the_hit() {
    let mut f = fixture();
    let line = format!("{}目标在这里{}", "前".repeat(2000), "后".repeat(2000));
    f.vault.note_create("长", &line).unwrap();
    let hit = &text_search(&f, "目标在这里", 10).notes[0];
    assert!(hit.line.contains("目标在这里"));
    assert_eq!(hit.line.chars().count(), 600);
    assert!(hit.line.starts_with(&"前".repeat(200)));
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
fn renaming_and_saving_each_write_only_their_own_part() {
    let mut f = fixture();
    let id = f.vault.note_create("初稿", "正文").unwrap();

    // 改标题：文件改名，正文不动、版本不变
    let renamed = f.vault.note_rename(&id, "  周报: 第 3 期 ").unwrap();
    assert_eq!(f.files(), vec!["笔记/周报： 第 3 期.md"]);
    assert_eq!(renamed.title, "周报: 第 3 期");
    assert_eq!(renamed.content_md, "正文");
    assert!(f.vault.note_rename(&id, "  ").is_err(), "空标题不收");

    // 别的程序刚改了正文（还没扫到）：改标题用磁盘上的正文，不拿索引里旧的那一版覆盖它
    let theirs = f.read("笔记/周报： 第 3 期.md").replace("正文", "别处改的");
    f.write_externally("笔记/周报： 第 3 期.md", &theirs);
    let renamed = f.vault.note_rename(&id, "周报").unwrap();
    assert_eq!(renamed.content_md, "别处改的");
    assert_eq!(f.files(), vec!["笔记/周报.md"], "不出冲突副本：两样各写各的");

    // 存正文：标题照磁盘上的留着
    let base = fsio::fingerprint(&renamed.content_md);
    let saved = f.vault.note_save(&id, "我改的", Some(&base)).unwrap();
    assert_eq!(saved.title, "周报");
    assert_eq!(saved.content_md, "我改的");
    assert_eq!(f.files(), vec!["笔记/周报.md"]);
}

#[test]
fn saving_from_a_stale_version_keeps_the_newer_one_as_a_conflict_copy() {
    let mut f = fixture();
    let id = f.vault.note_create("周报", "原来的").unwrap();
    let base = fsio::fingerprint(&f.vault.note_get(&id).unwrap().content_md);

    // 别处改了、索引也已经扫到了（只比索引的 keep_external_edits 看不出来），前端还没刷新
    let theirs = f.read("笔记/周报.md").replace("原来的", "别处改的");
    f.write_externally("笔记/周报.md", &theirs);
    f.vault.rescan().unwrap();
    f.take_announced();

    let saved = f.vault.note_save(&id, "我改的", Some(&base)).unwrap();
    assert_eq!(saved.content_md, "我改的");
    let files = f.files();
    assert_eq!(files.len(), 2, "{files:?}");
    let copy = files.iter().find(|rel| rel.contains("冲突")).unwrap();
    assert!(f.read(copy).ends_with("别处改的"));
    let announced = f.take_announced();
    assert_eq!(announced.len(), 1);
    assert_eq!(announced[0].conflicts.len(), 1, "提示条说一声");

    // 照着最新的一版接着改：不再出副本
    f.vault.note_save(&id, "我又改了", Some(&fsio::fingerprint(&saved.content_md))).unwrap();
    // 磁盘上已经和要写的一样（两边改成了同样的字）：也不出
    let stale = fsio::fingerprint(&saved.content_md);
    let current = f.read("笔记/周报.md").replace("我又改了", "一样的");
    f.write_externally("笔记/周报.md", &current);
    f.vault.note_save(&id, "一样的", Some(&stale)).unwrap();
    assert_eq!(f.files().len(), 2);
}

#[test]
fn only_an_id_written_in_the_file_is_stable_across_devices() {
    let mut f = fixture();
    f.write_externally("笔记/外面的.md", "别的工具建的");
    f.vault.rescan().unwrap();
    let note = f.vault.note_list(false).unwrap().remove(0);
    assert!(!note.id_in_file, "索引临时给的 id，换台设备就不一样");
    let saved = f.vault.note_save(&note.id, "改了一下", None).unwrap();
    assert!(saved.id_in_file, "第一次保存时写进属性块");
    let id = f.vault.note_create("新的", "").unwrap();
    assert!(f.vault.note_get(&id).unwrap().id_in_file);
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
fn the_tree_lists_images_and_pdfs_of_a_plain_folder() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("库");
    fsio::write_atomic(&fsio::abs(&root, "工作/周报.md"), "周报").unwrap();
    fsio::write_atomic_bytes(&fsio::abs(&root, "工作/图.PNG"), b"png").unwrap();
    fsio::write_atomic_bytes(&fsio::abs(&root, "说明.pdf"), b"pdf").unwrap();
    fsio::write_atomic_bytes(&fsio::abs(&root, "数据.xlsx"), b"xlsx").unwrap();
    fsio::write_atomic_bytes(&fsio::abs(&root, ".obsidian/图.png"), b"png").unwrap();
    fsio::write_atomic(
        &fsio::abs(&root, layout::VAULT_MARKER),
        &serde_json::to_string(&layout::new_marker(false, false, 0)).unwrap(),
    )
    .unwrap();
    let mut vault = Vault::open_in_memory(&root);
    let files = vault.tree_files();
    let listed: Vec<_> = files.iter().map(|file| (file.rel_path.as_str(), file.folder.as_str(), file.kind.as_str())).collect();
    assert_eq!(listed, vec![("工作/图.PNG", "工作", "image"), ("说明.pdf", "", "pdf")]);
    assert!(vault.tree_file_path("说明.pdf").is_ok());
    assert!(vault.tree_file_path("数据.xlsx").is_err(), "树上没列的不打开");
    assert!(vault.tree_file_path("../外面.pdf").is_err());
    assert!(vault.tree_file_path(".obsidian/图.png").is_err());
    // 外面多了一张图：扫描时告诉前端
    fsio::write_atomic_bytes(&fsio::abs(&root, "新图.png"), b"png").unwrap();
    assert!(vault.rescan().unwrap().folders);
    assert!(!vault.rescan().unwrap().folders, "没再变就不报");
    // Odea 的仓库树根是「笔记」，「附件」不在树上
    let mut f = fixture();
    fsio::write_atomic_bytes(&fsio::abs(&f.root, "附件/图.png"), b"png").unwrap();
    assert!(f.vault.tree_files().is_empty());
}

#[test]
fn obsidian_vaults_put_attachments_where_obsidian_would() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("库");
    fsio::write_atomic(&fsio::abs(&root, ".obsidian/app.json"), r#"{"attachmentFolderPath":"./"}"#).unwrap();
    fsio::write_atomic(&fsio::abs(&root, "工作/周报.md"), "周报").unwrap();
    fsio::write_atomic(&fsio::abs(&root, "工作/私密.md"), "别给").unwrap();
    let mut vault = Vault::open_in_memory(&root);
    let id = vault.note_list_full(false).unwrap().into_iter().find(|note| note.title == "周报").unwrap().id;
    let note = DocTarget::Note { id: id.clone() };
    let pasted = vault.attach(&note, "截图.png", b"png").unwrap();
    assert_eq!(pasted.link, "截图.png", "和笔记放在一起，直接写名字");
    assert!(root.join("工作/截图.png").is_file());
    // 协作时访客只拿得到这篇的附件，拿不到旁边的笔记
    assert!(vault.attachment_for_guest(&id, "工作/截图.png").is_ok());
    assert!(vault.attachment_for_guest(&id, "工作/私密.md").is_err());
    assert!(vault.attachment_for_guest(&id, "工作/没有.png").is_err());
    // Obsidian 什么都没设：仓库根
    fsio::write_atomic(&fsio::abs(&root, ".obsidian/app.json"), "{}").unwrap();
    let mut vault = Vault::open_in_memory(&root);
    // 属性块里没写 id 的笔记，索引给的 id 只在这一次
    let id = vault.note_list_full(false).unwrap().into_iter().find(|note| note.title == "周报").unwrap().id;
    let pasted = vault.attach(&DocTarget::Note { id }, "图.png", b"png").unwrap();
    assert_eq!(pasted.link, "../图.png");
    assert!(root.join("图.png").is_file());
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
    let folders = ["", "工作", "工作/周报", "读书", "生活", "项目/Odea"];
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
    let notes = vault.note_list(false).unwrap();
    let list_ms = t.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    let json = serde_json::to_string(&notes).unwrap();
    eprintln!(
        "note_list {} 篇（不带正文）   {:>8.1} ms，序列化 {:.1} ms，{:.2} MB JSON",
        notes.len(),
        list_ms,
        t.elapsed().as_secs_f64() * 1000.0,
        json.len() as f64 / 1048576.0
    );
    for query in ["进度", "项目计划方案", "这个词哪儿都没有"] {
        let t = Instant::now();
        let found = search_text(&vault.db, query, 8, false, || false).unwrap().unwrap();
        eprintln!(
            "search_text「{query}」 {:>8.1} ms（{} + {} 条）",
            t.elapsed().as_secs_f64() * 1000.0,
            found.notes.len(),
            found.journal.len()
        );
    }

    let t = Instant::now();
    let journal = vault.journal_list().unwrap();
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    eprintln!("journal_list {} 篇            {ms:>8.1} ms", journal.len());
    let t = Instant::now();
    vault.calendar_marks("2025-01-01", "2027-12-31").unwrap();
    eprintln!("calendar_marks 三年         {:>8.1} ms", t.elapsed().as_secs_f64() * 1000.0);
    for (query, regex) in [("进度", false), ("项目计划方案", false), (r"第\d+周", true)] {
        let t = Instant::now();
        let options = FindOptions { regex, ..FindOptions::default() };
        let found = find_text(&vault.db, query, options, || false).unwrap().unwrap();
        eprintln!(
            "find_text「{query}」 {:>8.1} ms（{} 篇 {} 处）",
            t.elapsed().as_secs_f64() * 1000.0,
            found.files.len(),
            found.total
        );
    }
    let id = notes[NOTES / 2].id.clone();
    let t = Instant::now();
    let links = vault.backlinks(&id).unwrap();
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    eprintln!("backlinks（{} 条）           {ms:>8.1} ms", links.len());
    let t = Instant::now();
    vault.day("2026-03-01", true).unwrap();
    eprintln!("day（某一天 + 带日期的任务） {:>8.1} ms", t.elapsed().as_secs_f64() * 1000.0);

    let text = format!("{}\n\n再写一段。", vault.note_get(&notes[10].id).unwrap().content_md);
    let t = Instant::now();
    vault.note_update(&notes[10].id, &notes[10].title, &text).unwrap();
    eprintln!("note_update（自动保存一次）  {:>8.1} ms", t.elapsed().as_secs_f64() * 1000.0);
    let t = Instant::now();
    vault.rescan().unwrap();
    eprintln!("rescan（没有变化）           {:>8.1} ms", t.elapsed().as_secs_f64() * 1000.0);
}

/* ---------------- 日程开关、文件树的根（docs/仓库与启动器.md §6） ---------------- */

/// 一个别人的文件夹：根上一篇、子文件夹里一篇、日记文件夹里一天
fn plain_folder(root: &Path) {
    fsio::write_atomic(&fsio::abs(root, "随手记.md"), "根上的").unwrap();
    fsio::write_atomic(&fsio::abs(root, "工作/周报.md"), "---\nid: weekly\n---\n\n- [ ] 交周报 @2026-10-20\n").unwrap();
    fsio::write_atomic(&fsio::abs(root, "日记/2026/2026-10-20.md"), "今天").unwrap();
    fsio::write_atomic(
        &fsio::abs(root, layout::VAULT_MARKER),
        &serde_json::to_string(&layout::new_marker(false, false, 0)).unwrap(),
    )
    .unwrap();
}

#[test]
fn a_folder_without_journal_is_all_notes_with_the_whole_vault_as_the_tree() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    plain_folder(&root);
    let mut vault = Vault::open_in_memory(&root);

    let mut titles: Vec<_> = vault.note_list(false).unwrap().into_iter().map(|note| note.title).collect();
    titles.sort();
    assert_eq!(titles, vec!["2026-10-20", "周报", "随手记"], "日记文件夹里的也是笔记");
    assert!(vault.journal_list().unwrap().is_empty());
    assert_eq!(vault.folders(), vec!["工作", "日记", "日记/2026"]);

    // 新建放在树根（仓库根），文件夹也建在仓库根上
    let id = vault.note_create_in("", "新的一篇", "").unwrap();
    assert_eq!(vault.note_get(&id).unwrap().rel_path, "新的一篇.md");
    assert_eq!(vault.folder_create("", "读书").unwrap(), "读书");
    assert!(root.join("读书").is_dir());
    let moved = vault.note_move(&id, "工作").unwrap();
    assert_eq!(moved.rel_path, "工作/新的一篇.md");

    // 日记、目标、归档不往别人的文件夹里写
    assert!(vault.save_day("2026-10-21", "", "x").is_err());
    assert!(vault.save_goal("week", "2026-10-19", "x").is_err());
    assert!(vault.note_archive(&id, None).is_err());
    assert!(!root.join("目标").exists());
    let info = vault.info().unwrap();
    assert!(!info.layout.journal);
    assert_eq!(info.layout.notes_dir, "");
}

#[test]
fn archive_works_without_the_journal() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    plain_folder(&root);
    fsio::write_atomic(&fsio::abs(&root, "归档/早就有的.md"), "别人的归档文件夹").unwrap();
    let index = dir.path().join("index.db");
    let (mut vault, _) = Vault::open_quick(&root, &index).unwrap();
    let id = vault.note_create_in("", "旧资料", "x").unwrap();
    assert!(vault.note_archive(&id, None).is_err(), "打开的文件夹默认不开归档");
    assert_eq!(vault.note_list(true).unwrap().len(), 0, "别人的「归档」文件夹只是普通文件夹");

    vault.set_archive(true).unwrap();
    let info = vault.info().unwrap();
    assert!(info.layout.archive && !info.layout.journal, "只开归档，不开日程");
    assert_eq!(vault.note_list(true).unwrap().len(), 1, "开了以后「归档」里的是归档的笔记");
    vault.note_archive(&id, None).unwrap();
    assert!(root.join("归档/旧资料.md").is_file());
    assert_eq!(vault.note_list(true).unwrap().len(), 2);
    assert!(!vault.folders().contains(&"归档".to_string()), "归档不在树上");
    assert!(vault.save_day("2026-10-21", "", "x").is_err(), "日程照旧关着");
    vault.note_restore(&id).unwrap();
    assert!(root.join("旧资料.md").is_file());

    // 关日程不带走归档
    vault.set_journal(true).unwrap();
    vault.set_journal(false).unwrap();
    assert!(vault.info().unwrap().layout.archive);
}

#[test]
fn turning_journal_on_and_off_reclassifies_files_without_touching_them() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    plain_folder(&root);
    let before = fsio::walk_markdown(&root);
    let index = dir.path().join("index.db");
    let (mut vault, _) = Vault::open_quick(&root, &index).unwrap();

    let backlog = vault.set_journal(true).unwrap();
    assert!(backlog.is_empty(), "文件不多，当场读完");
    assert_eq!(vault.day("2026-10-20", false).unwrap().note_md, "今天");
    assert_eq!(vault.folders(), vec!["工作"], "日记从窄栏进，不在树上");
    let mut titles: Vec<_> = vault.note_list(false).unwrap().into_iter().map(|note| note.title).collect();
    titles.sort();
    assert_eq!(titles, vec!["周报", "随手记"]);
    assert!(vault.note_get("weekly").is_ok(), "属性块里有 id 的笔记 id 不变");
    assert_eq!(vault.info().unwrap().layout.notes_dir, "", "树根还是整个仓库");
    // 新的一天按年分文件夹（不是 Obsidian 的库）
    vault.save_day("2026-10-21", "", "明天").unwrap();
    assert!(root.join("日记/2026/2026-10-21.md").is_file());

    // 重新打开：索引记着按哪种摆法建的，不用重读
    drop(vault);
    let (mut vault, backlog) = Vault::open_quick(&root, &index).unwrap();
    assert!(backlog.is_empty());
    assert_eq!(vault.day("2026-10-20", false).unwrap().note_md, "今天");

    vault.set_journal(false).unwrap();
    assert!(vault.journal_list().unwrap().is_empty(), "关了日程，日记又是笔记");
    assert_eq!(vault.note_list(false).unwrap().len(), 4);
    assert!(vault.folders().contains(&"日记".to_string()));
    // 文件一个都没动（除了上面自己写的那一天）
    let after: Vec<_> = fsio::walk_markdown(&root).into_iter().map(|file| file.rel).collect();
    for file in before {
        assert!(after.contains(&file.rel), "{} 不见了", file.rel);
    }
}

#[test]
fn journal_toggled_on_another_device_is_offered_then_applied() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    plain_folder(&root);
    let mut vault = Vault::open_in_memory(&root);
    assert!(vault.journal_list().unwrap().is_empty());
    // 另一台设备开了日程，标记同步过来：这台先不换，告诉前端一回
    let marker_path = fsio::abs(&root, layout::VAULT_MARKER);
    let marker = serde_json::from_str(&std::fs::read_to_string(&marker_path).unwrap()).ok();
    let marker = layout::marker_with_journal(marker, true);
    fsio::write_atomic(&marker_path, &serde_json::to_string_pretty(&marker).unwrap()).unwrap();
    let change = vault.rescan().unwrap();
    assert!(change.layout);
    assert!(!vault.layout.journal, "用户点之前照旧按原来的摆法");
    assert!(!vault.rescan().unwrap().layout, "同一次变化只报一回");
    // 点了「切换过去」
    vault.relayout().unwrap();
    assert!(vault.layout.journal);
    assert_eq!(vault.day("2026-10-20", false).unwrap().note_md, "今天");
    assert!(!vault.rescan().unwrap().layout);
    // 只改了附件放哪：直接换上，不打扰
    let mut marker: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&marker_path).unwrap()).unwrap();
    marker["folders"]["attachments"] = "图".into();
    fsio::write_atomic(&marker_path, &marker.to_string()).unwrap();
    assert!(!vault.rescan().unwrap().layout);
    assert_eq!(vault.layout.attachment_dir("工作/周报.md"), "图");
}

#[test]
fn an_old_vault_keeps_its_notes_folder_as_the_tree_root_across_a_toggle() {
    let mut f = fixture();
    let id = f.vault.note_create_in("", "一篇", "").unwrap();
    f.vault.save_day("2026-10-20", "", "今天").unwrap();
    assert_eq!(f.vault.info().unwrap().layout.notes_dir, "笔记");

    f.vault.set_journal(false).unwrap();
    let layout = f.vault.info().unwrap().layout;
    assert!(!layout.journal);
    assert_eq!(layout.notes_dir, "", "关了日程，整个仓库在树上");
    assert!(f.vault.folders().contains(&"笔记".to_string()));
    assert!(f.vault.note_get(&id).is_ok());

    f.vault.set_journal(true).unwrap();
    assert_eq!(f.vault.info().unwrap().layout.notes_dir, "笔记", "再开回来，树根还是「笔记」");
    assert_eq!(f.vault.day("2026-10-20", false).unwrap().note_md, "今天");
}

#[test]
fn obsidian_daily_notes_show_up_as_days() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("库");
    fsio::write_atomic(&fsio::abs(&root, ".obsidian/daily-notes.json"), r#"{"folder":"Daily"}"#).unwrap();
    fsio::write_atomic(&fsio::abs(&root, "Daily/2026-10-19.md"), "昨天的日记").unwrap();
    fsio::write_atomic(&fsio::abs(&root, "Daily/随便.md"), "不是日期").unwrap();
    fsio::write_atomic(
        &fsio::abs(&root, layout::VAULT_MARKER),
        &serde_json::to_string(&layout::marker_with_journal(Some(layout::new_marker(false, false, 0)), true)).unwrap(),
    )
    .unwrap();
    let mut vault = Vault::open_in_memory(&root);
    assert_eq!(vault.day("2026-10-19", false).unwrap().note_md, "昨天的日记");
    // 今天还没写：延续昨天的；写下去平放在 Daily 里（Obsidian 就是这么建的）
    assert_eq!(vault.day("2026-10-20", true).unwrap().carried_from.as_deref(), Some("2026-10-19"));
    vault.save_day("2026-10-20", "", "今天").unwrap();
    assert!(root.join("Daily/2026-10-20.md").is_file());
    // Daily 里不是日期的那篇是笔记，算在树根这一层（Daily 不在树上）
    assert!(vault.folders().is_empty());
    let note = vault.note_list(false).unwrap();
    assert_eq!(note.len(), 1);
    assert_eq!(note[0].title, "随便");
}

/* ---------------- 逻辑目录（docs/仓库与启动器.md §7） ---------------- */

/// 每个 .md 的 (路径, 修改时间, 大小)：只改清单的操作一个都不该动
fn file_states(root: &Path) -> Vec<(String, i64, i64)> {
    let mut files: Vec<_> = fsio::walk_markdown(root).into_iter().map(|file| (file.rel, file.mtime, file.size)).collect();
    files.sort();
    files
}

/// 启动器「新建」出来的逻辑目录
fn new_logical(root: &Path) {
    seed::write(root, "").unwrap();
    fsio::write_atomic(
        &fsio::abs(root, layout::VAULT_MARKER),
        &serde_json::to_string(&layout::new_marker(true, true, 0)).unwrap(),
    )
    .unwrap();
}

/// 树上每一篇所在的文件夹（根是空串）
fn placements(vault: &Vault) -> HashMap<String, String> {
    let nodes = vault.tree_view().unwrap();
    let path_of = |id: &str| {
        let mut parts = Vec::new();
        let mut id = id.to_string();
        while id != tree::ROOT {
            let node = nodes.iter().find(|node| node.id == id).unwrap();
            parts.push(node.name.clone().unwrap());
            id = node.parent.clone();
        }
        parts.reverse();
        parts.join("/")
    };
    nodes
        .iter()
        .filter(|node| node.kind == "note")
        .map(|node| (node.note.clone().unwrap(), path_of(&node.parent)))
        .collect()
}

#[test]
fn a_new_logical_vault_keeps_notes_flat_and_the_tree_in_the_manifest() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    new_logical(&root);
    let mut vault = Vault::open_in_memory(&root);
    let info = vault.info().unwrap();
    assert!(info.layout.logical && info.layout.journal);
    assert_eq!(info.layout.notes_dir, "");
    // 指南平放在仓库根上，树上放在根这一层
    assert!(root.join("欢迎使用 Odea.md").is_file());
    assert!(root.join(tree::TREE_FILE).is_file(), "第一次打开就把清单建好");
    let placed = placements(&vault);
    assert_eq!(placed.len(), 2);
    assert!(placed.values().all(|folder| folder.is_empty()));

    // 文件夹只在清单里；新建的笔记文件平放，树上放在文件夹里
    assert_eq!(vault.folder_create("", "交易").unwrap(), "交易");
    assert_eq!(vault.folder_create("交易", "学习").unwrap(), "交易/学习");
    assert!(!root.join("交易").exists(), "逻辑目录的文件夹不在硬盘上");
    let id = vault.note_create_in("交易/学习", "数学建模流程", "").unwrap();
    assert_eq!(vault.note_get(&id).unwrap().rel_path, "数学建模流程.md");
    assert_eq!(placements(&vault)[&id], "交易/学习");
    assert_eq!(vault.folders(), vec!["交易", "交易/学习"]);
    // 未整理里新建：不放进树
    let loose = vault.note_create_in(tree::UNSORTED, "随手", "").unwrap();
    assert!(!placements(&vault).contains_key(&loose));
    assert!(vault.note_create_in("没有这个", "x", "").is_err());

    // 日程照常：日记写在「日记」里，不在树上
    vault.save_day("2026-10-20", "", "今天").unwrap();
    assert!(root.join("日记/2026/2026-10-20.md").is_file());

    // 重新打开：树还是那棵
    let tree_before = std::fs::read_to_string(root.join(tree::TREE_FILE)).unwrap();
    drop(vault);
    let vault = Vault::open_in_memory(&root);
    assert_eq!(placements(&vault)[&id], "交易/学习");
    assert_eq!(std::fs::read_to_string(root.join(tree::TREE_FILE)).unwrap(), tree_before);
}

#[test]
fn moving_renaming_and_ordering_only_touch_the_manifest() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    new_logical(&root);
    let mut vault = Vault::open_in_memory(&root);
    vault.folder_create("", "交易").unwrap();
    vault.folder_create("", "读书").unwrap();
    let a = vault.note_create_in("交易", "甲", "正文").unwrap();
    let b = vault.note_create_in("交易", "乙", "正文").unwrap();
    let c = vault.note_create_in("交易", "丙", "正文").unwrap();
    let before = file_states(&root);

    // 改名、挪文件夹、挪笔记、排顺序、移到未整理
    assert_eq!(vault.folder_rename("交易", "交易学习").unwrap(), "交易学习");
    assert_eq!(vault.tree_move_folder("读书", "交易学习", None).unwrap(), "交易学习/读书");
    let moved = vault.note_move(&a, "交易学习/读书").unwrap();
    assert_eq!(moved.rel_path, "甲.md", "文件不挪");
    vault.tree_place(&c, "交易学习", Some(&b)).unwrap();
    vault.tree_place(&b, tree::UNSORTED, None).unwrap();
    let placed = placements(&vault);
    assert_eq!(placed[&a], "交易学习/读书");
    assert_eq!(placed[&c], "交易学习");
    assert!(!placed.contains_key(&b), "移到未整理只改清单");
    assert_eq!(file_states(&root), before, "一个 .md 都没动（修改时间、大小都一样）");
    assert!(vault.tree_move_folder("交易学习", "交易学习/读书", None).is_err(), "不能挪进自己底下");

    // 新建的排在最前面
    let d = vault.note_create_in("交易学习", "丁", "").unwrap();
    let nodes = vault.tree_view().unwrap();
    let parent = nodes.iter().find(|node| node.name.as_deref() == Some("交易学习")).unwrap().id.clone();
    let mut here: Vec<_> = nodes.iter().filter(|node| node.parent == parent && node.kind == "note").collect();
    here.sort_by(|x, y| (&x.key, &x.id).cmp(&(&y.key, &y.id)));
    let order: Vec<_> = here.iter().map(|node| node.note.clone().unwrap()).collect();
    assert_eq!(order, vec![d, c]);
}

#[test]
fn converting_a_local_folder_builds_the_tree_without_touching_a_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    plain_folder(&root);
    let mut vault = Vault::open_in_memory(&root);
    let before = file_states(&root);
    let loose = vault.note_list(false).unwrap().into_iter().find(|note| note.title == "随手记").unwrap();

    vault.make_logical().unwrap();
    assert!(vault.info().unwrap().layout.logical);
    assert_eq!(file_states(&root), before, "转成逻辑目录一个文件都不动");
    assert_eq!(vault.folders(), vec!["工作", "日记", "日记/2026"]);
    let placed = placements(&vault);
    assert_eq!(placed["weekly"], "工作");
    assert_eq!(placed[&loose.id], "");
    // 属性块里没 id 的按路径引用；有 id 的按 id
    let manifest = std::fs::read_to_string(root.join(tree::TREE_FILE)).unwrap();
    assert!(manifest.contains("file 随手记.md") && manifest.contains("note weekly"), "{manifest}");

    // 在 Odea 里改了标题（文件跟着改名、属性块里写上 id）：那一行换成按 id，位置不丢
    vault.note_update(&loose.id, "改过名的随手记", "根上的").unwrap();
    let manifest = std::fs::read_to_string(root.join(tree::TREE_FILE)).unwrap();
    assert!(!manifest.contains("file 随手记.md") && manifest.contains(&format!("note {}", loose.id)), "{manifest}");
    assert_eq!(placements(&vault)[&loose.id], "");

    // 重新打开还是逻辑目录（标记里记着），树还在
    drop(vault);
    let vault = Vault::open_in_memory(&root);
    assert!(vault.info().unwrap().layout.logical);
    assert_eq!(placements(&vault)["weekly"], "工作");
}

#[test]
fn deleting_a_logical_folder_trashes_its_notes_and_undo_puts_everything_back() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    new_logical(&root);
    let mut vault = Vault::open_in_memory(&root);
    vault.folder_create("", "交易").unwrap();
    vault.folder_create("交易", "学习").unwrap();
    vault.tree_add_query("交易", "近期", "updated:7d").unwrap();
    let a = vault.note_create_in("交易/学习", "甲", "").unwrap();
    let b = vault.note_create_in("交易", "乙", "").unwrap();

    let deletion = vault.folder_delete("交易").unwrap();
    let mut gone = deletion.notes.clone();
    gone.sort();
    let mut expected = vec![a.clone(), b.clone()];
    expected.sort();
    assert_eq!(gone, expected);
    assert!(vault.note_get(&a).is_err(), "进了回收站");
    assert!(vault.folders().is_empty());

    vault.folder_undelete(&deletion).unwrap();
    let placed = placements(&vault);
    assert_eq!(placed[&a], "交易/学习");
    assert_eq!(placed[&b], "交易");
    let queries: Vec<_> = vault.tree_view().unwrap().into_iter().filter_map(|node| node.query).collect();
    assert_eq!(queries, vec!["updated:7d"], "智能文件夹也回来了");
}

#[test]
fn notes_dropped_in_from_outside_are_unsorted_and_missing_ones_go_on_the_second_open() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    new_logical(&root);
    let index = dir.path().join("index.db");
    let (mut vault, _) = Vault::open_quick(&root, &index).unwrap();
    vault.folder_create("", "交易").unwrap();
    let id = vault.note_create_in("交易", "要被删的", "").unwrap();
    // 资源管理器里扔进来一篇：不在树上（未整理）
    fsio::write_atomic(&root.join("外面来的.md"), "你好").unwrap();
    vault.rescan().unwrap();
    let outside = vault.note_list(false).unwrap().into_iter().find(|note| note.title == "外面来的").unwrap();
    assert!(!placements(&vault).contains_key(&outside.id));
    // 资源管理器里删了一篇：清单里那一行第一次打开还留着（网盘可能还没把文件拷过来），第二次才去掉
    std::fs::remove_file(root.join("要被删的.md")).unwrap();
    drop(vault);
    let (vault, _) = Vault::open_quick(&root, &index).unwrap();
    assert!(std::fs::read_to_string(root.join(tree::TREE_FILE)).unwrap().contains(&id));
    drop(vault);
    let (vault, _) = Vault::open_quick(&root, &index).unwrap();
    assert!(!std::fs::read_to_string(root.join(tree::TREE_FILE)).unwrap().contains(&id));
    assert_eq!(vault.folders(), vec!["交易"]);
}

#[test]
fn edits_to_the_manifest_from_elsewhere_and_cloud_drive_copies_are_picked_up() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    new_logical(&root);
    let mut vault = Vault::open_in_memory(&root);
    let announced = Arc::new(Mutex::new(Vec::new()));
    let sink = announced.clone();
    vault.set_announcer(Arc::new(move |change| sink.lock().unwrap().push(change)));
    vault.folder_create("", "交易").unwrap();
    let mine = std::fs::read_to_string(root.join(tree::TREE_FILE)).unwrap();
    // 网盘另存了一份（另一台设备建了「读书」）
    let mut other = tree::Tree::parse(&mine);
    other.add_folder("", "读书").unwrap();
    fsio::write_atomic(&root.join(".odea/tree (1)"), &other.render()).unwrap();
    vault.rescan_paths_and_announce(&[]).unwrap();
    let mut folders = vault.folders();
    folders.sort();
    assert_eq!(folders, vec!["交易", "读书"]);
    assert!(!root.join(".odea/tree (1)").exists(), "并进来以后副本删掉");
    assert!(announced.lock().unwrap().iter().any(|change| change.folders));
    // 别的工具直接改了清单
    let mut edited = tree::Tree::parse(&std::fs::read_to_string(root.join(tree::TREE_FILE)).unwrap());
    edited.rename("交易", "交易学习").unwrap();
    fsio::write_atomic(&root.join(tree::TREE_FILE), &edited.render()).unwrap();
    vault.rescan().unwrap();
    assert!(vault.folders().contains(&"交易学习".to_string()));
}

#[test]
fn smart_folders_filter_notes_by_their_condition() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    new_logical(&root);
    let mut vault = Vault::open_in_memory(&root);
    vault.folder_create("", "交易").unwrap();
    let a = vault.note_create_in("交易", "周复盘", "这周 #复盘 一下\n- [ ] 改进止损").unwrap();
    let b = vault.note_create_in("", "随手", "#复盘会 不算").unwrap();
    assert_eq!(vault.tree_add_query("", "复盘", "#复盘").unwrap(), "复盘");
    // 同一层不重名：和文件夹一样加序号
    assert_eq!(vault.tree_add_query("", "交易", "in:交易").unwrap(), "交易 2");
    vault.tree_place(&b, "复盘", None).unwrap();
    assert_eq!(placements(&vault)[&b], "", "智能文件夹里放不了东西：放到根上");
    let found = vault
        .tree_queries(&["#复盘".into(), "in:交易 has:todo".into(), "in:未整理".into(), "-#复盘".into()])
        .unwrap();
    assert_eq!(found[0], vec![a.clone()]);
    assert_eq!(found[1], vec![a.clone()]);
    assert!(found[2].iter().all(|id| *id != a && *id != b));
    assert!(found[3].contains(&b) && !found[3].contains(&a));
    assert_eq!(vault.tree_set_query("复盘", "复盘笔记", "#复盘 updated:7d").unwrap(), "复盘笔记");
    // 删掉智能文件夹只是拿掉那一行，笔记不动
    let deletion = vault.folder_delete("复盘笔记").unwrap();
    assert!(deletion.notes.is_empty());
    assert!(vault.note_get(&a).is_ok());
}

/* ---------------- 快捷方式、导入（docs/仓库与启动器.md §7.5、§7.6） ---------------- */

#[test]
fn shortcuts_point_at_a_note_placed_elsewhere() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    new_logical(&root);
    let mut vault = Vault::open_in_memory(&root);
    vault.folder_create("", "交易").unwrap();
    vault.folder_create("", "复盘").unwrap();
    let id = vault.note_create_in("交易", "周复盘", "").unwrap();
    let node = vault.tree_add_shortcut(&id, "复盘").unwrap();
    assert_eq!(vault.tree_add_shortcut(&id, "复盘").unwrap(), node, "同一个文件夹里不放两个");
    let nodes = vault.tree_view().unwrap();
    let link = nodes.iter().find(|n| n.id == node).unwrap();
    assert_eq!(link.kind, "shortcut");
    assert_eq!(link.note.as_deref(), Some(id.as_str()));
    assert_eq!(placements(&vault)[&id], "交易", "笔记还在原来的位置");
    assert!(vault.tree_add_shortcut(&id, tree::UNSORTED).is_err());
    let text = std::fs::read_to_string(root.join(tree::TREE_FILE)).unwrap();
    assert!(text.contains(&format!("link note {id}")), "{text}");
    // 重新打开读回来一样
    let mut vault = Vault::open_in_memory(&root);
    assert!(vault.tree_view().unwrap().iter().any(|n| n.id == node && n.kind == "shortcut"));
    // 删快捷方式不删笔记
    vault.tree_remove_shortcut(&node).unwrap();
    assert!(vault.note_get(&id).is_ok());
    assert!(vault.tree_view().unwrap().iter().all(|n| n.kind != "shortcut"));
    assert!(vault.tree_remove_shortcut(&node).is_err());
}

#[test]
fn shortcuts_to_notes_without_an_id_follow_them_once_they_get_one() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    new_logical(&root);
    fsio::write_atomic(&fsio::abs(&root, "外面写的.md"), "正文").unwrap();
    let mut vault = Vault::open_in_memory(&root);
    vault.folder_create("", "收藏").unwrap();
    let id = vault.note_list_full(false).unwrap().into_iter().find(|n| n.title == "外面写的").unwrap().id;
    vault.tree_add_shortcut(&id, "收藏").unwrap();
    let text = std::fs::read_to_string(root.join(tree::TREE_FILE)).unwrap();
    assert!(text.contains("link file 外面写的.md"), "属性块里没有 id：按路径指着它");
    // 应用给它改名（属性块里写上 id）：快捷方式跟着换成按 id
    vault.note_update(&id, "改了名", "正文").unwrap();
    let text = std::fs::read_to_string(root.join(tree::TREE_FILE)).unwrap();
    assert!(text.contains(&format!("link note {id}")), "{text}");
    let link = vault.tree_view().unwrap().into_iter().find(|n| n.kind == "shortcut").unwrap();
    assert_eq!(link.note.as_deref(), Some(id.as_str()));
}

#[test]
fn importing_a_folder_copies_it_and_keeps_its_structure() {
    let dir = tempfile::tempdir().unwrap();
    let outside = dir.path().join("读书笔记");
    fsio::write_atomic(&fsio::abs(&outside, "三体.md"), "![](图/封面.png)").unwrap();
    fsio::write_atomic(&fsio::abs(&outside, "小说/活着.md"), "---\nid: alive\n---\n\n正文").unwrap();
    fsio::write_atomic(&fsio::abs(&outside, "小说/长篇/白鹿原.md"), "正文").unwrap();
    fsio::write_atomic_bytes(&fsio::abs(&outside, "图/封面.png"), b"png").unwrap();
    fsio::write_atomic(&fsio::abs(&outside, ".obsidian/app.json"), "{}").unwrap();

    // 逻辑目录：文件平放在仓库根下的「读书笔记」里，树上照原来的结构摆在当前文件夹底下
    let root = dir.path().join("仓库");
    new_logical(&root);
    let mut vault = Vault::open_in_memory(&root);
    vault.folder_create("", "书").unwrap();
    let report = vault.import_folder(&outside, "书").unwrap();
    assert_eq!(report.folder, "书/读书笔记");
    assert_eq!((report.notes, report.files), (3, 1));
    assert!(root.join("读书笔记/图/封面.png").is_file(), "正文里的相对路径照样指着它");
    assert!(!root.join("读书笔记/.obsidian").exists(), "以点开头的不拷");
    assert!(outside.join("三体.md").is_file(), "原来的不动");
    assert_eq!(
        vault.folders(),
        vec!["书", "书/读书笔记", "书/读书笔记/小说", "书/读书笔记/小说/长篇"],
        "只有图片的文件夹不上树"
    );
    let placed = placements(&vault);
    assert_eq!(placed["alive"], "书/读书笔记/小说");
    assert_eq!(placed.values().filter(|folder| *folder == "书/读书笔记").count(), 1);
    // 不能导入仓库自己、包着仓库的
    assert!(vault.import_folder(&root.join("读书笔记"), "").is_err());
    assert!(vault.import_folder(dir.path(), "").is_err());

    // 本地目录：拷进树上那个文件夹，树就是真的文件夹
    let local = dir.path().join("本地");
    plain_folder(&local);
    let mut vault = Vault::open_in_memory(&local);
    let report = vault.import_folder(&outside, "工作").unwrap();
    assert_eq!(report.folder, "工作/读书笔记");
    assert!(local.join("工作/读书笔记/小说/活着.md").is_file());
    assert!(vault.folders().contains(&"工作/读书笔记/小说".to_string()));
    assert!(vault.note_get("alive").is_ok());
    // 同名的加序号
    assert_eq!(vault.import_folder(&outside, "").unwrap().folder, "读书笔记");
    assert!(vault.import_folder(&outside, "工作").unwrap().folder.starts_with("工作/读书笔记 2"));
}

#[test]
fn a_retired_share_folder_goes_to_the_trash_and_the_notes_stay() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    std::fs::create_dir_all(root.join(".odea/share/docs")).unwrap();
    std::fs::write(root.join(".odea/share/share.json"), "{}").unwrap();
    std::fs::write(root.join("周报.md"), "照常在").unwrap();

    let vault = Vault::open_in_memory(&root);
    assert!(!root.join(".odea/share").exists());
    let trashed: Vec<_> = std::fs::read_dir(root.join(".odea/trash"))
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(trashed.iter().any(|name| name.starts_with("share-")), "{trashed:?}");
    assert!(root.join(".odea/trash").join(&trashed[0]).join("share.json").exists());
    assert_eq!(vault.note_list(false).unwrap().len(), 1);
}
