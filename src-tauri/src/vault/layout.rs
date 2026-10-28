/* ============================================================
仓库文件夹的约定：什么路径是什么文档、文档该放在哪。

Odea 建的仓库（新建的、老用户的）：

    笔记/秋季项目复盘.md          笔记（笔记/ 下任意深度，以及仓库里其它不认识的位置）
    归档/第一版信息架构草稿.md      归档的笔记
    日记/2026/2026-09-26.md       某一天（今日TODO 就是今天这一篇）
    目标/2026/2026-W39.md          周目标；2026-09.md 月目标；2026.md 年目标
    附件/                          图片等，正文里用相对路径引用
    .odea/                         应用自己的东西（回收站、行为日志、仓库标记）

日记、目标是「日程」这组功能的（docs/仓库与启动器.md §6），归档单独一个开关（只写笔记的人也要
归档旧资料）。开关和文件夹名记在仓库标记 `.odea/vault.json` 里（Layout）。两样都没开的仓库里
什么都是笔记；没开日程的仓库文件树的根是整个仓库。

路径在程序里一律是正斜杠分隔的相对路径字符串，落到磁盘时再按组件拼。
============================================================ */

use std::path::Path;

use chrono::{Datelike, NaiveDate, Weekday};
use serde_json::Value;

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

/* ---------------- 这个仓库怎么摆（.odea/vault.json） ----------------
   {
     "kind": "logical",
     "features": { "journal": true, "archive": true },
     "folders": { "notes": "笔记", "days": "日记", "goals": "目标", "archive": "归档" }
   }
   - 没有 features 的（P11.2 以前写的标记、老用户的仓库）：日程开着、文件树的根是「笔记」，和以前一样
   - features 里没写 archive 的（0.4.2 以前写的）：归档跟着日程，和以前一样
   - 新建的、空文件夹：上面这一份。打开一个已经有笔记的文件夹：`journal: false`，不往别人的文件夹里建
     日记、目标（boot::prepare）
   - 日程关着时文件树的根一律是整个仓库：日记、目标这时候都只是普通文件夹；归档关着时「归档」也是
   - 日程开着、没写日记文件夹的：Obsidian 的日记设置（.obsidian/daily-notes.json）是 YYYY-MM-DD
     的话用它的文件夹，平放（Obsidian 就是这么建的），原来的日记直接进今日TODO 和日历
   - `kind: "logical"`（或者有 .odea/tree）是逻辑目录（docs/仓库与启动器.md §7）：树是清单里摆的那一棵，
     和文件在哪无关；新建的笔记平放在 notes（新建的逻辑目录是仓库根）。启动器「新建」建的就是它 */

/// 一个仓库的文件摆法。打开仓库时读一次（Vault::bare），开关日程时换一份（Vault::set_journal）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    /// 逻辑目录：文件树按 .odea/tree 摆（vault/tree.rs），不按文件夹
    pub logical: bool,
    /// 开没开日程（今日TODO、目标、日历）
    pub journal: bool,
    /// 开没开归档：「归档」文件夹里的是归档的笔记，不在树上
    pub archiving: bool,
    /// 文件树的根：「笔记」，或者整个仓库（空串）
    pub notes: String,
    pub days: String,
    /// 新的某一天按年分文件夹（日记/2026/2026-10-20.md）；Obsidian 的日记是平放的
    pub days_by_year: bool,
    pub goals: String,
    pub archive: String,
    /// 粘贴、拖进来的文件放哪（attachment_dir）
    pub attachments: AttachDir,
}

/// 附件放在哪。Odea 自己的仓库是固定的「附件」；Obsidian 的库照它的「新附件的默认位置」
/// （.obsidian/app.json 的 attachmentFolderPath）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttachDir {
    /// 仓库里一个固定的文件夹（空串是仓库根，Obsidian 的默认）
    Fixed(String),
    /// 和这篇文档同一个文件夹，或者它底下的子文件夹（Obsidian 的 `./`、`./附件`）
    BesideDoc(String),
}

impl Default for Layout {
    fn default() -> Self {
        Self::odea()
    }
}

impl Layout {
    /// Odea 自己建的仓库：日程开着，根是「笔记」
    pub fn odea() -> Self {
        Self {
            logical: false,
            journal: true,
            archiving: true,
            notes: NOTES_DIR.into(),
            days: DAYS_DIR.into(),
            days_by_year: true,
            goals: GOALS_DIR.into(),
            archive: ARCHIVE_DIR.into(),
            attachments: AttachDir::Fixed(ATTACHMENTS_DIR.into()),
        }
    }

    /// 读仓库标记。没有标记、读不了的照 Odea 的老规矩
    pub fn load(root: &Path) -> Self {
        let marker = read_json(&root.join(APP_DIR).join("vault.json"));
        let mut layout = match &marker {
            Some(marker) => Self::from_marker(marker, || obsidian_days(root)),
            None => Self::odea(),
        };
        // 附件：标记里写了的照写的，没写的看 Obsidian 的设置，都没有是「附件」
        let own = marker
            .as_ref()
            .and_then(|marker| marker.get("folders"))
            .and_then(|folders| folders.get("attachments"))
            .and_then(Value::as_str)
            .and_then(clean_dir);
        if let Some(dir) = own {
            layout.attachments = AttachDir::Fixed(dir);
        } else if let Some(obsidian) = obsidian_attachments(root) {
            layout.attachments = obsidian;
        }
        // 清单在就是逻辑目录：别的设备转过来、同步过来的标记还没跟上时也认
        layout.logical = marker.as_ref().and_then(|marker| marker.get("kind")).and_then(Value::as_str)
            == Some("logical")
            || root.join(super::tree::TREE_FILE).is_file();
        layout
    }

    fn from_marker(marker: &Value, obsidian: impl FnOnce() -> Option<String>) -> Self {
        let Some(features) = marker.get("features") else {
            return Self::odea();
        };
        let journal = features.get("journal").and_then(Value::as_bool).unwrap_or(false);
        let archiving = features.get("archive").and_then(Value::as_bool).unwrap_or(journal);
        let folder = |key: &str| {
            marker
                .get("folders")
                .and_then(|folders| folders.get(key))
                .and_then(Value::as_str)
                .and_then(clean_dir)
        };
        let (days, days_by_year) = match folder("days") {
            Some(days) => (days, true),
            None => match obsidian() {
                Some(days) => (days, false),
                None => (DAYS_DIR.into(), true),
            },
        };
        Self {
            logical: false,
            journal,
            archiving,
            // 日程关着时日记、目标、归档都是普通文件夹，整个仓库都在树上
            notes: if journal { folder("notes").unwrap_or_default() } else { String::new() },
            days,
            days_by_year,
            goals: folder("goals").filter(|dir| !dir.is_empty()).unwrap_or_else(|| GOALS_DIR.into()),
            archive: folder("archive").filter(|dir| !dir.is_empty()).unwrap_or_else(|| ARCHIVE_DIR.into()),
            attachments: AttachDir::Fixed(ATTACHMENTS_DIR.into()),
        }
    }

    /// 给这篇文档（仓库里的相对路径）粘贴、拖进来的文件放在哪个文件夹（仓库里的相对路径，空串是根）
    pub fn attachment_dir(&self, doc_rel: &str) -> String {
        match &self.attachments {
            AttachDir::Fixed(dir) => dir.clone(),
            AttachDir::BesideDoc(sub) if sub.is_empty() => dir_of(doc_rel).to_string(),
            AttachDir::BesideDoc(sub) => join(dir_of(doc_rel), sub),
        }
    }

    /// 这个文件是不是放在这篇文档的附件位置上（协作时只把这里的文件给访客，docs/协同编辑.md §7.2）。
    /// 附件和笔记放在一起（Obsidian 的 `./`）时，同一个文件夹里的别的笔记不算
    pub fn is_attachment_of(&self, doc_rel: &str, file_rel: &str) -> bool {
        let dir = self.attachment_dir(doc_rel);
        let ext = stem_and_ext(file_rel).1;
        let note = ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown");
        let hidden = file_rel.split('/').any(|part| part.starts_with('.'));
        !note && !hidden && dir_of(file_rel) == dir
    }

    /// 摆法变了，索引里每篇是什么文档就得重新认（Vault::bare 拿它和索引里记的比）
    pub fn fingerprint(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}|{}|{}",
            self.journal, self.notes, self.days, self.days_by_year, self.goals, self.archive, self.archiving
        )
    }

    /// 文件树上不出现的文件夹：日程开着时的日记、目标，归档开着时的归档（从窄栏进）。根是「笔记」的
    /// 仓库里它们本来就在树外面，这里也照样列出来，不碍事
    pub fn hidden_dirs(&self) -> Vec<&str> {
        let journal = [self.days.as_str(), self.goals.as_str()].into_iter().filter(|_| self.journal);
        let archive = [self.archive.as_str()].into_iter().filter(|_| self.archiving);
        journal.chain(archive).filter(|dir| !dir.is_empty()).collect()
    }

    pub fn classify(&self, rel: &str) -> Slot {
        let dir = dir_of(rel);
        if self.archiving && within(dir, &self.archive) {
            return Slot::Note { archived: true };
        }
        if !self.journal {
            return Slot::Note { archived: false };
        }
        let stem = stem_of(rel);
        // 日记文件夹是仓库根（Obsidian 的默认）时只认根上的
        let in_days = if self.days.is_empty() { dir.is_empty() } else { within(dir, &self.days) };
        if in_days && parse_date(stem).is_some() {
            return Slot::Day(stem.to_string());
        }
        if within(dir, &self.goals) {
            if let Some((horizon, period_start)) = goal_from_stem(stem) {
                return Slot::Goal { horizon, period_start };
            }
        }
        Slot::Note { archived: false }
    }

    pub fn day_path(&self, date: &str) -> Result<String> {
        let parsed = parse_date(date)
            .ok_or_else(|| AppError::Invalid(format!("日期应为 YYYY-MM-DD，收到: {date}")))?;
        Ok(if self.days_by_year {
            join(&join(&self.days, &parsed.year().to_string()), &format!("{date}.md"))
        } else {
            join(&self.days, &format!("{date}.md"))
        })
    }

    /// 周目标按 ISO 周命名（2026-W39），放在 ISO 周所属年份的文件夹里
    pub fn goal_path(&self, horizon: &str, period_start: &str) -> Result<String> {
        let date = validate_period_start(horizon, period_start)?;
        let goals = &self.goals;
        Ok(match horizon {
            "week" => {
                let week = date.iso_week();
                format!("{goals}/{}/{}-W{:02}.md", week.year(), week.year(), week.week())
            }
            "month" => format!("{goals}/{}/{}-{:02}.md", date.year(), date.year(), date.month()),
            _ => format!("{goals}/{}/{}.md", date.year(), date.year()),
        })
    }

    /// 文件树上的文件夹（相对树根的路径，`工作/周报`；空串是树根）→ 仓库里的目录。
    /// 路径是前端传来的，逐段检查：不能是空的、`.`、`..`，不能以点开头（会被当成隐藏目录跳过）。
    pub fn folder_dir(&self, folder: &str) -> Result<String> {
        if folder.is_empty() {
            return Ok(self.notes.clone());
        }
        let ok = folder.split('/').all(|part| {
            !part.is_empty() && !part.starts_with('.') && !part.contains('\\') && part.trim() == part
        });
        if !ok {
            return Err(AppError::Invalid(format!("文件夹路径不对: {folder}")));
        }
        Ok(join(&self.notes, folder))
    }

    /// 反过来：仓库里的目录 → 树上的文件夹。不在树根底下、或者在日程那几个文件夹里的返回 None
    pub fn folder_of_dir<'a>(&self, dir: &'a str) -> Option<&'a str> {
        if self.hidden_dirs().iter().any(|hidden| within(dir, hidden)) {
            return None;
        }
        if self.notes.is_empty() {
            return Some(dir);
        }
        if dir == self.notes {
            return Some("");
        }
        dir.strip_prefix(self.notes.as_str())?.strip_prefix('/')
    }

    /// 日程关着时，日记、目标这些操作不做（不往别人的文件夹里建日记）
    pub fn require_journal(&self) -> Result<()> {
        if self.journal {
            Ok(())
        } else {
            Err(AppError::Invalid("这个仓库没开日程（命令面板「启用日程」）".into()))
        }
    }

    /// 归档关着时不往「归档」里挪（打开的是别人的文件夹，那里的「归档」可能只是个普通文件夹）
    pub fn require_archive(&self) -> Result<()> {
        if self.archiving {
            Ok(())
        } else {
            Err(AppError::Invalid("这个仓库没开归档（命令面板「启用归档」）".into()))
        }
    }
}

/// dir 是 base 本身或者在它底下
fn within(dir: &str, base: &str) -> bool {
    dir == base || dir.strip_prefix(base).is_some_and(|rest| rest.starts_with('/'))
}

/// 配置里写的文件夹：正斜杠、去掉两头的斜杠；有 `..`、以点开头的段不收
fn clean_dir(raw: &str) -> Option<String> {
    let dir = raw.replace('\\', "/");
    let dir = dir.trim().trim_matches('/');
    let ok = dir.is_empty()
        || dir.split('/').all(|part| !part.is_empty() && !part.starts_with('.') && part.trim() == part);
    ok.then(|| dir.to_string())
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Obsidian 的日记放在哪：开着日记核心插件、日期格式是 YYYY-MM-DD（不写就是这个）时用它的文件夹
/// （不写是仓库根）。不是 Obsidian 的库、格式对不上（按年月分了子文件夹、写了星期几）返回 None
fn obsidian_days(root: &Path) -> Option<String> {
    let config = root.join(".obsidian");
    if !config.is_dir() {
        return None;
    }
    // core-plugins.json：新版是 { "daily-notes": true, … }，旧版是开着的插件名列表；没有这个文件是默认（开着）
    let enabled = match read_json(&config.join("core-plugins.json")) {
        Some(Value::Object(plugins)) => plugins.get("daily-notes").and_then(Value::as_bool).unwrap_or(false),
        Some(Value::Array(plugins)) => plugins.iter().any(|plugin| plugin.as_str() == Some("daily-notes")),
        _ => true,
    };
    if !enabled {
        return None;
    }
    let settings = read_json(&config.join("daily-notes.json")).unwrap_or(Value::Null);
    let format = settings.get("format").and_then(Value::as_str).unwrap_or("").trim();
    if !format.is_empty() && format != "YYYY-MM-DD" {
        return None;
    }
    clean_dir(settings.get("folder").and_then(Value::as_str).unwrap_or(""))
}

/// Obsidian 的「新附件的默认位置」（.obsidian/app.json 的 attachmentFolderPath）：
/// `/` 仓库根（不写就是它），`./` 和笔记同一个文件夹，`./子文件夹` 笔记旁边的子文件夹，别的是仓库里那个文件夹。
/// 不是 Obsidian 的库返回 None
fn obsidian_attachments(root: &Path) -> Option<AttachDir> {
    let config = root.join(".obsidian");
    if !config.is_dir() {
        return None;
    }
    let settings = read_json(&config.join("app.json")).unwrap_or(Value::Null);
    let raw = settings.get("attachmentFolderPath").and_then(Value::as_str).unwrap_or("/").trim();
    let raw = raw.replace('\\', "/");
    if raw == "." || raw == "./" {
        return Some(AttachDir::BesideDoc(String::new()));
    }
    if let Some(sub) = raw.strip_prefix("./") {
        return clean_dir(sub).map(AttachDir::BesideDoc);
    }
    clean_dir(&raw).map(AttachDir::Fixed)
}

/// 新仓库的标记（boot::prepare）。`fresh` = 空文件夹（新建的、换到的空文件夹）：Odea 的摆法、日程开着；
/// 已经有笔记的文件夹不开日程，树就是它本来的样子。`logical`（启动器「新建」）：逻辑目录，
/// 笔记平放在仓库根上
pub fn new_marker(fresh: bool, logical: bool, created_at: i64) -> Value {
    let mut marker = serde_json::json!({ "app": "Odea", "version": 1, "createdAt": created_at });
    if logical {
        marker["kind"] = "logical".into();
    }
    marker["features"] = serde_json::json!({ "journal": fresh, "archive": fresh });
    if fresh {
        marker["folders"] = serde_json::json!({
            "notes": if logical { "" } else { NOTES_DIR }, "days": DAYS_DIR, "goals": GOALS_DIR, "archive": ARCHIVE_DIR,
        });
    }
    marker
}

/// 本地目录转成逻辑目录：只加 `kind`，别的键原样留着。老标记（没有 features）是 Odea 的摆法，
/// 和开关日程一样先补上 features，树根「笔记」照旧是新笔记平放的地方
pub fn marker_logical(marker: Option<Value>, journal: bool) -> Value {
    let mut marker = marker_with_journal(marker, journal);
    marker["kind"] = "logical".into();
    marker
}

/// 开 / 关日程：只改 features.journal，别的键（包括不认识的）原样留着。老标记（没有 features）
/// 是 Odea 的摆法，补上 folders.notes，关了再开树根还是「笔记」
pub fn marker_with_journal(marker: Option<Value>, journal: bool) -> Value {
    marker_with_feature(marker, "journal", journal)
}

/// 开 / 关归档：只改 features.archive，别的照 marker_with_journal 的规矩
pub fn marker_with_archive(marker: Option<Value>, archive: bool) -> Value {
    marker_with_feature(marker, "archive", archive)
}

/// 改一个开关。另一个没写的先按现在的意思写上：老标记里归档是跟着日程的，只改其中一个时
/// 另一个不能跟着变（关了日程，归档还开着）
fn marker_with_feature(marker: Option<Value>, key: &str, on: bool) -> Value {
    let mut marker = match marker {
        Some(Value::Object(map)) => Value::Object(map),
        _ => serde_json::json!({ "app": "Odea", "version": 1 }),
    };
    // 现在的日程开没开：没有 features 的老标记是 Odea 的摆法（开着），和 Layout::from_marker 一致
    let journal_now = marker
        .get("features")
        .map_or(true, |features| features.get("journal").and_then(Value::as_bool).unwrap_or(false));
    if marker.get("features").is_none() {
        let folders = marker
            .as_object_mut()
            .expect("上面保证了是对象")
            .entry("folders")
            .or_insert_with(|| serde_json::json!({}));
        if let Some(folders) = folders.as_object_mut() {
            folders.entry("notes").or_insert_with(|| NOTES_DIR.into());
        }
    }
    let features = marker
        .as_object_mut()
        .expect("上面保证了是对象")
        .entry("features")
        .or_insert_with(|| serde_json::json!({}));
    if !features.is_object() {
        *features = serde_json::json!({});
    }
    let features = features.as_object_mut().expect("上面保证了是对象");
    features.entry("journal").or_insert(Value::Bool(journal_now));
    features.entry("archive").or_insert(Value::Bool(journal_now));
    features.insert(key.to_string(), Value::Bool(on));
    marker
}

/// Odea 的老规矩下一个文件是什么（旧库搬家、测试用）
#[cfg(test)]
pub fn classify(rel: &str) -> Slot {
    Layout::odea().classify(rel)
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

/// 文件名（不含目录）拆成主名和扩展名（没有扩展名时是空串）
pub fn stem_and_ext(rel: &str) -> (&str, &str) {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, ext),
        _ => (name, ""),
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

/// Odea 的老规矩下某一天放在哪（旧库搬家、测试用；仓库里用 Layout::day_path）
pub fn day_path(date: &str) -> Result<String> {
    Layout::odea().day_path(date)
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

/// Odea 的老规矩下某个周期的目标放在哪（旧库搬家、测试用；仓库里用 Layout::goal_path）
pub fn goal_path(horizon: &str, period_start: &str) -> Result<String> {
    Layout::odea().goal_path(horizon, period_start)
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

/// 从一篇文档引用仓库里一个文件的相对路径：`笔记/周报.md` 引用 `附件/图.png` 写成 `../附件/图.png`，
/// 同一个文件夹里的直接写名字。和别的编辑器（Typora、Obsidian、VS Code）的解析方式一样，
/// 相对文档自己所在的文件夹
pub fn relative_link(doc_rel: &str, file_rel: &str) -> String {
    let from: Vec<&str> = dir_of(doc_rel).split('/').filter(|part| !part.is_empty()).collect();
    let to: Vec<&str> = file_rel.split('/').filter(|part| !part.is_empty()).collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    // 文件名本身不算共同前缀
    let common = common.min(to.len().saturating_sub(1));
    let mut out = "../".repeat(from.len() - common);
    out.push_str(&to[common..].join("/"));
    out
}

/// 附件文件夹里一个文件从这篇文档怎么引用（Odea 的老规矩：仓库根上的「附件」）
#[cfg(test)]
pub fn attachment_link(doc_rel: &str, file_name: &str) -> String {
    relative_link(doc_rel, &join(ATTACHMENTS_DIR, file_name))
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

    fn layout_of(marker: Value) -> Layout {
        Layout::from_marker(&marker, || None)
    }

    #[test]
    fn markers_decide_the_layout() {
        // P11.2 以前写的标记、新建的仓库：Odea 的摆法
        assert_eq!(layout_of(serde_json::json!({ "app": "Odea" })), Layout::odea());
        assert_eq!(layout_of(new_marker(true, false, 0)), Layout::odea());
        // 打开一个已经有笔记的文件夹：不开日程，树根是整个仓库
        let plain = layout_of(new_marker(false, false, 0));
        assert!(!plain.journal);
        assert_eq!(plain.notes, "");
        assert_eq!(plain.classify("日记/2026/2026-10-20.md"), Slot::Note { archived: false });
        assert_eq!(plain.classify("归档/旧.md"), Slot::Note { archived: false });
        assert!(plain.hidden_dirs().is_empty());
        assert_eq!(plain.folder_dir("").unwrap(), "");
        assert_eq!(plain.folder_dir("工作/周报").unwrap(), "工作/周报");
        assert_eq!(plain.folder_of_dir("工作"), Some("工作"));
        assert_eq!(plain.folder_of_dir(""), Some(""));
        assert!(plain.require_journal().is_err());
        // 配置里乱写的文件夹不收
        let odd = layout_of(serde_json::json!({
            "features": { "journal": true },
            "folders": { "notes": "../外面", "days": "/Daily/", "goals": ".hidden", "archive": "" },
        }));
        assert_eq!(odd.notes, "");
        assert_eq!(odd.days, "Daily");
        assert_eq!(odd.goals, GOALS_DIR);
        assert_eq!(odd.archive, ARCHIVE_DIR);
    }

    #[test]
    fn archive_has_its_own_switch() {
        // 0.4.2 以前的标记没写 archive：跟着日程
        let old = layout_of(serde_json::json!({ "features": { "journal": false } }));
        assert!(!old.archiving);
        // 只写笔记、归档旧资料：日程关着，归档开着
        let marker = marker_with_archive(Some(serde_json::json!({ "features": { "journal": false } })), true);
        assert_eq!(marker["features"], serde_json::json!({ "journal": false, "archive": true }));
        let notes_only = layout_of(marker);
        assert!(!notes_only.journal && notes_only.archiving);
        assert_eq!(notes_only.classify("归档/旧.md"), Slot::Note { archived: true });
        assert_eq!(notes_only.classify("日记/2026/2026-10-20.md"), Slot::Note { archived: false });
        assert_eq!(notes_only.hidden_dirs(), vec!["归档"]);
        assert_eq!(notes_only.folder_of_dir("归档"), None);
        assert!(notes_only.require_archive().is_ok());
        assert!(notes_only.require_journal().is_err());
        // 关日程不带走归档：老标记（没写 archive，归档跟着日程开着）关了日程，归档照旧开着
        let off = marker_with_journal(Some(serde_json::json!({ "features": { "journal": true } })), false);
        assert_eq!(off["features"], serde_json::json!({ "journal": false, "archive": true }));
        let off = marker_with_journal(Some(serde_json::json!({ "app": "Odea" })), false);
        assert_eq!(off["features"], serde_json::json!({ "journal": false, "archive": true }));
        assert!(layout_of(off).archiving);
        // 只开日程、不要归档
        let journal_only = layout_of(serde_json::json!({ "features": { "journal": true, "archive": false } }));
        assert_eq!(journal_only.classify("归档/旧.md"), Slot::Note { archived: false });
        assert_eq!(journal_only.hidden_dirs(), vec!["日记", "目标"]);
        assert!(journal_only.require_archive().is_err());
    }

    #[test]
    fn journal_on_a_whole_vault_hides_its_folders_from_the_tree() {
        let tree = layout_of(serde_json::json!({ "features": { "journal": true } }));
        assert_eq!(tree.notes, "");
        assert_eq!(tree.hidden_dirs(), vec!["日记", "目标", "归档"]);
        assert_eq!(tree.folder_of_dir("工作"), Some("工作"));
        assert_eq!(tree.folder_of_dir("日记/2026"), None);
        assert_eq!(tree.folder_of_dir("日记本"), Some("日记本"));
        assert_eq!(tree.classify("日记/2026/2026-10-20.md"), Slot::Day("2026-10-20".into()));
        assert_eq!(tree.classify("日记本/2026-10-20.md"), Slot::Note { archived: false });
    }

    #[test]
    fn obsidian_daily_notes_are_days() {
        let marker = serde_json::json!({ "features": { "journal": true } });
        let tree = Layout::from_marker(&marker, || Some("Daily".into()));
        assert_eq!(tree.days, "Daily");
        assert!(!tree.days_by_year);
        assert_eq!(tree.day_path("2026-10-20").unwrap(), "Daily/2026-10-20.md");
        assert_eq!(tree.classify("Daily/2026-10-20.md"), Slot::Day("2026-10-20".into()));
        // 日记在仓库根上（Obsidian 的默认）：只认根上的
        let root = Layout::from_marker(&marker, || Some(String::new()));
        assert_eq!(root.day_path("2026-10-20").unwrap(), "2026-10-20.md");
        assert_eq!(root.classify("2026-10-20.md"), Slot::Day("2026-10-20".into()));
        assert_eq!(root.classify("工作/2026-10-20.md"), Slot::Note { archived: false });
        assert_eq!(root.hidden_dirs(), vec!["目标", "归档"]);
        // 自己在标记里写了日记文件夹的，不看 Obsidian 的
        let own = serde_json::json!({ "features": { "journal": true }, "folders": { "days": "日志" } });
        let own = Layout::from_marker(&own, || Some("Daily".into()));
        assert_eq!(own.day_path("2026-10-20").unwrap(), "日志/2026/2026-10-20.md");
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

    #[test]
    fn attachments_follow_obsidian_settings() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert_eq!(Layout::load(root).attachment_dir("笔记/周报.md"), ATTACHMENTS_DIR, "Odea 的仓库");
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        let app = |json: &str| std::fs::write(root.join(".obsidian/app.json"), json).unwrap();
        assert_eq!(Layout::load(root).attachment_dir("工作/周报.md"), "", "Obsidian 什么都没设：仓库根");
        app(r#"{ "attachmentFolderPath": "./" }"#);
        assert_eq!(Layout::load(root).attachment_dir("工作/周报.md"), "工作");
        assert_eq!(Layout::load(root).attachment_dir("周报.md"), "");
        app(r#"{ "attachmentFolderPath": "./assets" }"#);
        assert_eq!(Layout::load(root).attachment_dir("工作/周报.md"), "工作/assets");
        app(r#"{ "attachmentFolderPath": "Files/Images" }"#);
        assert_eq!(Layout::load(root).attachment_dir("工作/周报.md"), "Files/Images");
        app(r#"{ "attachmentFolderPath": "../外面" }"#);
        assert_eq!(Layout::load(root).attachments, AttachDir::Fixed(ATTACHMENTS_DIR.into()), "乱写的不认");
        // 标记里自己写了的不看 Obsidian 的
        std::fs::create_dir_all(root.join(APP_DIR)).unwrap();
        std::fs::write(root.join(VAULT_MARKER), r#"{ "folders": { "attachments": "图" } }"#).unwrap();
        assert_eq!(Layout::load(root).attachment_dir("工作/周报.md"), "图");
    }

    #[test]
    fn attachment_files_of_a_note() {
        let beside = Layout { attachments: AttachDir::BesideDoc(String::new()), ..Layout::odea() };
        assert!(beside.is_attachment_of("工作/周报.md", "工作/图.png"));
        assert!(!beside.is_attachment_of("工作/周报.md", "工作/私密.md"), "旁边的别的笔记不给");
        assert!(!beside.is_attachment_of("工作/周报.md", "工作/子/图.png"));
        assert!(!beside.is_attachment_of("工作/周报.md", "别处/图.png"));
        let odea = Layout::odea();
        assert!(odea.is_attachment_of("笔记/周报.md", "附件/图.png"));
        assert!(!odea.is_attachment_of("笔记/周报.md", "附件/.git/config"));
        assert!(!odea.is_attachment_of("笔记/周报.md", "笔记/图.png"));
    }

    #[test]
    fn relative_links_between_vault_files() {
        assert_eq!(relative_link("笔记/周报.md", "附件/图.png"), "../附件/图.png");
        assert_eq!(relative_link("工作/周报.md", "工作/图.png"), "图.png");
        assert_eq!(relative_link("工作/周报.md", "工作/assets/图.png"), "assets/图.png");
        assert_eq!(relative_link("a/b/周报.md", "a/c/图.png"), "../c/图.png");
        assert_eq!(relative_link("周报.md", "图.png"), "图.png");
        assert_eq!(relative_link("a/周报.md", "图.png"), "../图.png");
        // 文件名和目录名一样时不能当成共同前缀
        assert_eq!(relative_link("图.png/周报.md", "图.png"), "../图.png");
    }

    #[test]
    fn toggling_journal_keeps_the_rest_of_the_marker() {
        let legacy = serde_json::json!({ "app": "Odea", "version": 1, "别的": 1 });
        let off = marker_with_journal(Some(legacy), false);
        assert_eq!(off["别的"], 1);
        assert_eq!(off["features"]["journal"], false);
        // 老仓库关了日程：整个仓库在树上；再开回来，树根还是「笔记」
        assert_eq!(layout_of(off.clone()).notes, "");
        let on = marker_with_journal(Some(off), true);
        assert_eq!(layout_of(on), Layout::odea());
        // 打开的文件夹开了日程：树根还是整个仓库
        let opened = marker_with_journal(Some(new_marker(false, false, 0)), true);
        let tree = layout_of(opened);
        assert!(tree.journal);
        assert_eq!(tree.notes, "");
    }

    #[test]
    fn logical_vaults_are_marked_or_have_a_tree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(APP_DIR)).unwrap();
        let write = |marker: &Value| std::fs::write(root.join(VAULT_MARKER), marker.to_string()).unwrap();
        // 启动器新建的：逻辑目录、日程开着、新笔记平放在仓库根上
        write(&new_marker(true, true, 0));
        let fresh = Layout::load(root);
        assert!(fresh.logical && fresh.journal);
        assert_eq!(fresh.notes, "");
        assert_eq!(fresh.days, DAYS_DIR);
        // 转过来的老仓库：照旧是 Odea 的摆法，只多了 kind
        write(&marker_logical(Some(serde_json::json!({ "app": "Odea" })), true));
        let converted = Layout::load(root);
        assert!(converted.logical);
        assert_eq!(Layout { logical: false, ..converted }, Layout::odea());
        // 标记还是本地目录，但清单在（别的设备转过来了、标记还没同步到）
        write(&new_marker(false, false, 0));
        assert!(!Layout::load(root).logical);
        std::fs::write(root.join(super::super::tree::TREE_FILE), "").unwrap();
        assert!(Layout::load(root).logical);
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
