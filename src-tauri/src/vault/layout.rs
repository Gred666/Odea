/* ============================================================
仓库文件夹的约定：什么路径是什么文档、文档该放在哪。

    笔记/秋季项目复盘.md          笔记（笔记/ 下任意深度，以及仓库里其它不认识的位置）
    归档/第一版信息架构草稿.md      归档的笔记
    日记/2026/2026-09-26.md       某一天（今日TODO 就是今天这一篇）
    目标/2026/2026-W39.md          周目标；2026-09.md 月目标；2026.md 年目标
    附件/                          图片等，正文里用相对路径引用
    .odea/                         应用自己的东西（回收站、行为日志、仓库标记）

路径在程序里一律是正斜杠分隔的相对路径字符串，落到磁盘时再按组件拼。
============================================================ */

use chrono::{Datelike, NaiveDate, Weekday};

use crate::error::{AppError, Result};

pub const NOTES_DIR: &str = "笔记";
pub const ARCHIVE_DIR: &str = "归档";
pub const DAYS_DIR: &str = "日记";
pub const GOALS_DIR: &str = "目标";
/// 粘贴 / 拖进来的图片，正文里用相对路径引用（见 Vault::attach）
pub const ATTACHMENTS_DIR: &str = "附件";
/// 应用自己的文件夹。改名前叫 .ontheway，打开仓库时搬过来（old_name::move_vault_dir）
pub const APP_DIR: &str = ".odea";
pub const TRASH_DIR: &str = ".odea/trash";
pub const ACTIVITY_DIR: &str = ".odea/activity";
pub const VAULT_MARKER: &str = ".odea/vault.json";

/// 新笔记 / 空标题的占位，和前端 NEW_NOTE_TITLE 一致
pub const UNTITLED: &str = "无标题笔记";

/// 一个 .md 文件按它的位置是哪种文档
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Slot {
    Note { archived: bool },
    Day(String),
    Goal { horizon: &'static str, period_start: String },
}

pub fn classify(rel: &str) -> Slot {
    let top = rel.split('/').next().unwrap_or("");
    let stem = stem_of(rel);
    match top {
        ARCHIVE_DIR => Slot::Note { archived: true },
        DAYS_DIR if rel.contains('/') => match parse_date(stem) {
            Some(_) => Slot::Day(stem.to_string()),
            None => Slot::Note { archived: false },
        },
        GOALS_DIR if rel.contains('/') => match goal_from_stem(stem) {
            Some((horizon, period_start)) => Slot::Goal {
                horizon,
                period_start,
            },
            None => Slot::Note { archived: false },
        },
        _ => Slot::Note { archived: false },
    }
}

/// 文件名去掉目录和 .md
pub fn stem_of(rel: &str) -> &str {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    match name.len().checked_sub(3) {
        Some(cut) if name.is_char_boundary(cut) && name[cut..].eq_ignore_ascii_case(".md") => {
            &name[..cut]
        }
        _ => name,
    }
}

/// 相对路径的目录部分（没有目录时是空串）
pub fn dir_of(rel: &str) -> &str {
    rel.rsplit_once('/').map_or("", |(dir, _)| dir)
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

/// 笔记的文件夹（相对「笔记」的路径，`工作/周报`；空串是「笔记」本身）→ 仓库里的目录。
/// 路径是前端传来的，逐段检查：不能是空的、`.`、`..`，不能以点开头（会被当成隐藏目录跳过）。
pub fn folder_dir(folder: &str) -> Result<String> {
    if folder.is_empty() {
        return Ok(NOTES_DIR.to_string());
    }
    let ok = folder.split('/').all(|part| {
        !part.is_empty() && !part.starts_with('.') && !part.contains('\\') && part.trim() == part
    });
    if !ok {
        return Err(AppError::Invalid(format!("文件夹路径不对: {folder}")));
    }
    Ok(format!("{NOTES_DIR}/{folder}"))
}

/// 反过来：仓库里的目录 → 笔记的文件夹。不在「笔记」底下的返回 None
pub fn folder_of_dir(dir: &str) -> Option<&str> {
    if dir == NOTES_DIR {
        return Some("");
    }
    dir.strip_prefix(NOTES_DIR)?.strip_prefix('/')
}

/// 用户起的文件夹名 → 磁盘上的目录名：和笔记文件名同一套规矩（非法字符换成相近的全角字符）。
/// 空的返回 None
pub fn folder_name(raw: &str) -> Option<String> {
    // file_stem_for_title 会把空名字换成「无标题笔记」；文件夹名空着就是没起名
    let blank = raw
        .trim()
        .trim_start_matches('.')
        .trim_end_matches(['.', ' '])
        .trim()
        .is_empty();
    // 开头的点去掉之后可能露出空格：目录名两头不留空白（folder_dir 不收）
    (!blank).then(|| file_stem_for_title(raw).trim().to_string())
}

fn parse_date(s: &str) -> Option<NaiveDate> {
    (s.len() == 10)
        .then(|| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
        .flatten()
}

pub fn day_path(date: &str) -> Result<String> {
    let parsed = parse_date(date)
        .ok_or_else(|| AppError::Invalid(format!("日期应为 YYYY-MM-DD，收到: {date}")))?;
    Ok(format!("{DAYS_DIR}/{}/{date}.md", parsed.year()))
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

/// 周目标按 ISO 周命名（2026-W39），放在 ISO 周所属年份的文件夹里
pub fn goal_path(horizon: &str, period_start: &str) -> Result<String> {
    let date = validate_period_start(horizon, period_start)?;
    Ok(match horizon {
        "week" => {
            let week = date.iso_week();
            format!(
                "{GOALS_DIR}/{}/{}-W{:02}.md",
                week.year(),
                week.year(),
                week.week()
            )
        }
        "month" => format!(
            "{GOALS_DIR}/{}/{}-{:02}.md",
            date.year(),
            date.year(),
            date.month()
        ),
        _ => format!("{GOALS_DIR}/{}/{}.md", date.year(), date.year()),
    })
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

/// 和前端 lib/date.ts 的 goalTitle 一样：「第 39 周目标」「九月目标」「2026 年目标」
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

/// 文件名最多这么多个字符。中文一个字 3 字节，80 个字 240 字节，
/// 在 macOS / Linux 255 字节的文件名上限以内；Windows 的整条路径也不容易超 260。
const MAX_STEM_CHARS: usize = 80;

/// 标题 → 文件名（不含 .md）。
///
/// 文件系统不允许的字符换成外观相近的全角字符（`:` → `：`），标题本身的样子
/// 还在；截断、去掉结尾的点和空格（Windows 会悄悄吃掉它们）、避开设备名。
/// 文件名和标题不一样时，完整标题记在属性块的 title 里。
pub fn file_stem_for_title(title: &str) -> String {
    let mut stem: String = title
        .trim()
        .chars()
        .map(|c| match c {
            '/' => '／',
            '\\' => '＼',
            ':' => '：',
            '*' => '＊',
            '?' => '？',
            '"' => '＂',
            '<' => '＜',
            '>' => '＞',
            '|' => '｜',
            c if c.is_control() => ' ',
            c => c,
        })
        .take(MAX_STEM_CHARS)
        .collect();
    // 开头的点会让文件变成「隐藏文件」，扫描时被跳过
    stem = stem.trim_start_matches('.').to_string();
    stem = stem.trim_end_matches(['.', ' ']).to_string();
    if stem.is_empty() {
        return UNTITLED.to_string();
    }
    let base = stem.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((base.starts_with("COM") || base.starts_with("LPT"))
            && base.len() == 4
            && base.as_bytes()[3].is_ascii_digit());
    if reserved {
        stem.push('_');
    }
    stem
}

/* ---------------- 网盘的冲突副本 ----------------
   两台机器都改了同一篇、同步时撞上，网盘不覆盖，而是把其中一版另存一份：
     Dropbox     「周报 (张三's conflicted copy 2026-10-06).md」「周报 (张三的冲突副本 …).md」
     Syncthing   「周报.sync-conflict-20261006-153012-ABCDEFG.md」
     OneDrive    「周报-DESKTOP-ABC1234.md」（机器名）
     Google Drive / 百度网盘「周报 (1).md」「周报(1).md」
     本应用自己  「周报 (冲突 2026-10-06 1530).md」
   iCloud 的「周报 2.md」和本应用给重名笔记起的名字一样，只能靠属性块里重复的 id 认。
   这里只看名字给出「原文可能叫什么」，原文在不在同一个文件夹里由调用方核对 ——
   光看名字，「方案 (1)」也可能就是一篇正经起名的笔记。 */

/// 这个文件名若是冲突副本，原文件可能叫什么（不含 .md），按可信程度排。
pub fn conflict_originals(stem: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |base: &str| {
        let base = base.trim_end();
        if !base.is_empty() && base != stem && !out.iter().any(|known: &String| known == base) {
            out.push(base.to_string());
        }
    };
    // 本应用起冲突副本时撞名会再加「 2」：先去掉这个序号再看
    let trimmed = strip_counter(stem);
    for name in [stem, trimmed] {
        if let Some(index) = name.find(".sync-conflict-") {
            push(&name[..index]);
        }
        if let Some((base, inner)) = trailing_group(name) {
            let lower = inner.to_lowercase();
            if inner.contains("冲突") || lower.contains("conflict") {
                push(base);
            } else if !inner.is_empty() && inner.chars().all(|c| c.is_ascii_digit()) {
                push(base);
            }
        }
        let lower = name.to_lowercase();
        for marker in ["_冲突", "-冲突", " 冲突", "_conflict", "-conflict", " conflict"] {
            if let Some(index) = lower.rfind(marker) {
                // 中文标记的字节位置在小写前后一样（只有 ASCII 会变）
                if name.is_char_boundary(index) {
                    push(&name[..index]);
                }
            }
        }
        // OneDrive：结尾是「-机器名」，机器名本身可能也带连字符，每个切点都试
        for (index, _) in name.match_indices('-').collect::<Vec<_>>().into_iter().rev() {
            let suffix = &name[index + 1..];
            let machine = (3..=24).contains(&suffix.len())
                && suffix
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-')
                && suffix.chars().any(|c| c.is_ascii_uppercase());
            if machine {
                push(&name[..index]);
            }
        }
    }
    out
}

/// 「周报 (冲突 …) 2」→「周报 (冲突 …)」；没有序号原样返回
fn strip_counter(stem: &str) -> &str {
    match stem.rsplit_once(' ') {
        Some((base, n)) if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => base,
        _ => stem,
    }
}

/// 结尾的「(…)」或「（…）」：返回 (前面的部分, 括号里的内容)
fn trailing_group(name: &str) -> Option<(&str, &str)> {
    for (open, close) in [('(', ')'), ('（', '）')] {
        if let Some(body) = name.strip_suffix(close) {
            if let Some(index) = body.rfind(open) {
                return Some((&name[..index], &body[index + open.len_utf8()..]));
            }
        }
    }
    None
}

/// 从一篇文档引用附件的相对路径：`笔记/周报.md` 引用 `附件/图.png` 写成 `../附件/图.png`。
/// 和别的编辑器（Typora、Obsidian、VS Code）的解析方式一样，相对文档自己所在的文件夹。
pub fn attachment_link(doc_rel: &str, file_name: &str) -> String {
    let depth = dir_of(doc_rel).split('/').filter(|part| !part.is_empty()).count();
    format!("{}{ATTACHMENTS_DIR}/{file_name}", "../".repeat(depth))
}

/// 附件的文件名（不含扩展名）：去掉文件系统和 Markdown 链接里有特殊含义的字符，
/// 空白换成连字符（`![](a b.png)` 里的空格会把链接截断）。
pub fn attachment_stem(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.trim().chars() {
        let bad = c.is_whitespace()
            || c.is_control()
            || matches!(
                c,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '%' | '[' | ']' | '(' | ')'
                    | '{' | '}' | '^' | '`' | '!'
            );
        let c = if bad { '-' } else { c };
        if c == '-' && out.ends_with('-') {
            continue;
        }
        out.push(c);
        if out.chars().count() >= 60 {
            break;
        }
    }
    out.trim_matches(['-', '.', ' ']).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_conflict_copy_names() {
        let first = |stem: &str| conflict_originals(stem).into_iter().next();
        assert_eq!(first("周报 (冲突 2026-10-06 1530)").as_deref(), Some("周报"));
        assert_eq!(first("周报 (冲突 2026-10-06 1530) 2").as_deref(), Some("周报"));
        assert_eq!(first("周报 (张三's conflicted copy 2026-10-06)").as_deref(), Some("周报"));
        assert_eq!(first("周报 (张三的冲突副本 2026-10-06)").as_deref(), Some("周报"));
        assert_eq!(
            first("周报.sync-conflict-20261006-153012-ABCDEFG").as_deref(),
            Some("周报")
        );
        assert_eq!(first("周报 (1)").as_deref(), Some("周报"));
        assert_eq!(first("周报(2)").as_deref(), Some("周报"));
        assert_eq!(first("周报（冲突副本）").as_deref(), Some("周报"));
        assert_eq!(first("周报_冲突_20261006").as_deref(), Some("周报"));
        assert!(conflict_originals("周报-DESKTOP-ABC1234").contains(&"周报".to_string()));
        // 普通的名字不算
        assert!(conflict_originals("周报").is_empty());
        assert!(conflict_originals("第 3 期周报").is_empty());
        assert!(conflict_originals("周报 (草稿)").is_empty());
        assert!(conflict_originals("api-v2").is_empty());
    }

    #[test]
    fn attachment_links_are_relative_to_the_document() {
        assert_eq!(attachment_link("笔记/周报.md", "图.png"), "../附件/图.png");
        assert_eq!(attachment_link("日记/2026/2026-10-06.md", "图.png"), "../../附件/图.png");
        assert_eq!(attachment_link("随手.md", "图.png"), "附件/图.png");
        assert_eq!(attachment_stem("屏幕 截图 (2)"), "屏幕-截图-2");
        assert_eq!(attachment_stem("  a  b  "), "a-b");
        assert_eq!(attachment_stem("周报#1 [草稿]"), "周报-1-草稿");
        assert_eq!(attachment_stem("..."), "");
    }

    #[test]
    fn classifies_by_location() {
        assert_eq!(classify("笔记/秋季项目复盘.md"), Slot::Note { archived: false });
        assert_eq!(classify("笔记/工作/周报.md"), Slot::Note { archived: false });
        assert_eq!(classify("随手记.md"), Slot::Note { archived: false });
        assert_eq!(classify("归档/旧版路线图.md"), Slot::Note { archived: true });
        assert_eq!(
            classify("日记/2026/2026-09-26.md"),
            Slot::Day("2026-09-26".into())
        );
        // 日记文件夹里不是日期的文件就是普通笔记，不会消失
        assert_eq!(classify("日记/2026/杂记.md"), Slot::Note { archived: false });
        assert_eq!(
            classify("目标/2026/2026-W39.md"),
            Slot::Goal {
                horizon: "week",
                period_start: "2026-09-21".into()
            }
        );
        assert_eq!(
            classify("目标/2026/2026-09.md"),
            Slot::Goal {
                horizon: "month",
                period_start: "2026-09-01".into()
            }
        );
        assert_eq!(
            classify("目标/2026.md"),
            Slot::Goal {
                horizon: "year",
                period_start: "2026-01-01".into()
            }
        );
        assert_eq!(classify("目标/2026/2026-W60.md"), Slot::Note { archived: false });
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
                Slot::Goal {
                    horizon,
                    period_start: start.into()
                },
                "{path}"
            );
        }
        // 2024-12-30 是 2025 年第 1 周的周一
        assert_eq!(goal_path("week", "2024-12-30").unwrap(), "目标/2025/2025-W01.md");
        assert!(goal_path("week", "2026-09-22").is_err());
    }

    #[test]
    fn goal_titles_match_the_frontend() {
        assert_eq!(goal_title("week", "2026-09-21"), "第 39 周目标");
        assert_eq!(goal_title("month", "2026-09-01"), "九月目标");
        assert_eq!(goal_title("year", "2026-01-01"), "2026 年目标");
    }

    #[test]
    fn file_names_are_safe_on_every_platform() {
        assert_eq!(file_stem_for_title("周报: 第 3 期?"), "周报： 第 3 期？");
        assert_eq!(file_stem_for_title("a/b\\c"), "a／b＼c");
        assert_eq!(file_stem_for_title("  ...隐藏. "), "隐藏");
        assert_eq!(file_stem_for_title("   "), UNTITLED);
        assert_eq!(file_stem_for_title("con"), "con_");
        assert_eq!(file_stem_for_title("LPT1.txt"), "LPT1.txt_");
        assert_eq!(file_stem_for_title("COMMENT"), "COMMENT");
        let long = "秋".repeat(200);
        assert_eq!(file_stem_for_title(&long).chars().count(), MAX_STEM_CHARS);
    }

    #[test]
    fn stems_and_dirs() {
        assert_eq!(stem_of("笔记/a.b.MD"), "a.b");
        assert_eq!(dir_of("笔记/工作/周报.md"), "笔记/工作");
        assert_eq!(dir_of("周报.md"), "");
        assert_eq!(join("", "a.md"), "a.md");
    }
}
