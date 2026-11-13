/* ============================================================
文件开头的属性块（YAML front matter）。

应用只认自己的几个键：id / title / created / pinned / archived / category /
archived-from / trashed-from。其余行（别的工具写的 tags、aliases…）一字不改地留着，写回时
放在应用的键后面 —— 用 Obsidian 之类打开同一个文件夹，谁也不吃掉谁的东西。

这不是完整的 YAML 解析器，也不打算是：应用自己写的值都是单行标量，
认不出来的行一律当「别人的」原样保留，最坏情况是某个键没被识别，而不是丢数据。

判定规则和编辑器（editor/frontMatter.ts）、摘要（domain/search.rs）一致：
第一行 `---`，60 行以内以 `---` 收尾，中间至少有一行 `key: value`。
============================================================ */

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FrontMatter {
    pub id: Option<String>,
    /// 只在文件名表达不了标题时写（有非法字符、太长、重名加了序号）
    pub title: Option<String>,
    /// UTC 毫秒
    pub created: Option<i64>,
    pub pinned: bool,
    /// 归档时间，UTC 毫秒
    pub archived: Option<i64>,
    pub category: Option<String>,
    /// 归档前在「笔记」的哪个子文件夹（仓库内相对路径，`笔记/工作`），恢复时放回去
    pub archived_from: Option<String>,
    /// 回收站里的文件原来在哪（仓库内相对路径）
    pub trashed_from: Option<String>,
    /// 不认识的行，原样
    pub extra: Vec<String>,
}

impl FrontMatter {
    pub fn is_empty(&self) -> bool {
        self.id.is_none()
            && self.title.is_none()
            && self.created.is_none()
            && !self.pinned
            && self.archived.is_none()
            && self.category.is_none()
            && self.archived_from.is_none()
            && self.trashed_from.is_none()
            && self.extra.is_empty()
    }

    /// 别的工具写的标签（Obsidian 的 `tags`，老写法 `tag`），认这几种写法：
    /// `tags: [旅行, 书店]`、`tags: 旅行, 书店`、`tags: 旅行 书店`、下面一行一条的 `  - 旅行`。
    /// 去掉引号和开头的 `#`，转小写，重复的只留一个；`工作/周报` 这种带层级的照原样（认 `#工作` 时也算它，
    /// vault/query.rs）。应用自己不写 tags，只从 extra 里读，一字不改
    pub fn tags(&self) -> Vec<String> {
        let mut out = Vec::new();
        let mut lines = self.extra.iter().peekable();
        while let Some(line) = lines.next() {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            if line.starts_with([' ', '\t']) || !matches!(key.trim().to_lowercase().as_str(), "tags" | "tag") {
                continue;
            }
            let value = value.trim();
            if value.is_empty() {
                // 下面一行一条：`  - 旅行`（YAML 也允许不缩进的 `- 旅行`）
                while let Some(item) = lines
                    .peek()
                    .copied()
                    .and_then(|next| next.trim_start().strip_prefix('-'))
                {
                    push_tags(&mut out, item);
                    lines.next();
                }
            } else {
                push_tags(&mut out, value.trim_start_matches('[').trim_end_matches(']'));
            }
        }
        out
    }
}

/// 一段里的几个标签：逗号、空白分开
fn push_tags(out: &mut Vec<String>, text: &str) {
    for word in text.split(|c: char| c == ',' || c.is_whitespace()) {
        let tag = word
            .trim_matches(|c| c == '"' || c == '\'')
            .trim_start_matches('#')
            .to_lowercase();
        if !tag.is_empty() && !out.contains(&tag) {
            out.push(tag);
        }
    }
}

/// 拆成属性块和正文。正文的换行统一成 `\n`（编辑器里就是 `\n`，不统一的话
/// 外部用 CRLF 存过的文件一打开就被当成改过了）。
pub fn split(text: &str) -> (FrontMatter, String) {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let normalized;
    let text = if text.contains('\r') {
        normalized = text.replace("\r\n", "\n");
        normalized.as_str()
    } else {
        text
    };

    let Some((block, rest)) = find_block(text) else {
        return (FrontMatter::default(), text.to_string());
    };
    // render() 在属性块和正文之间空一行；读的时候吃掉这一行，往返不变
    let body = rest.strip_prefix('\n').unwrap_or(rest);
    (parse_block(block), body.to_string())
}

/// 属性块 + 正文。属性全空时不写属性块。
pub fn render(meta: &FrontMatter, body: &str) -> String {
    if meta.is_empty() {
        return body.to_string();
    }
    let mut out = String::from("---\n");
    if let Some(id) = &meta.id {
        out.push_str(&format!("id: {id}\n"));
    }
    if let Some(title) = &meta.title {
        out.push_str(&format!("title: {}\n", quote(title)));
    }
    if let Some(created) = meta.created {
        out.push_str(&format!("created: {}\n", format_time(created)));
    }
    if meta.pinned {
        out.push_str("pinned: true\n");
    }
    if let Some(archived) = meta.archived {
        out.push_str(&format!("archived: {}\n", format_time(archived)));
    }
    if let Some(category) = &meta.category {
        out.push_str(&format!("category: {}\n", quote(category)));
    }
    if let Some(from) = &meta.archived_from {
        out.push_str(&format!("archived-from: {}\n", quote(from)));
    }
    if let Some(from) = &meta.trashed_from {
        out.push_str(&format!("trashed-from: {}\n", quote(from)));
    }
    for line in &meta.extra {
        out.push_str(line);
        out.push('\n');
    }
    out.push_str("---\n\n");
    out.push_str(body);
    out
}

/// 属性块的内容（不含两条 `---`）和它后面剩下的文本
fn find_block(text: &str) -> Option<(&str, &str)> {
    let first_end = text.find('\n')?;
    if text[..first_end].trim_end() != "---" {
        return None;
    }
    let mut offset = first_end + 1;
    let mut saw_key = false;
    for _ in 0..59 {
        if offset > text.len() {
            break;
        }
        let end = text[offset..]
            .find('\n')
            .map_or(text.len(), |index| offset + index);
        let line = &text[offset..end];
        if line.trim_end() == "---" {
            if !saw_key {
                return None;
            }
            let block = &text[first_end + 1..offset];
            let rest = if end < text.len() { &text[end + 1..] } else { "" };
            return Some((block, rest));
        }
        saw_key |= is_yaml_key(line);
        if end >= text.len() {
            break;
        }
        offset = end + 1;
    }
    None
}

fn is_yaml_key(line: &str) -> bool {
    let mut chars = line.chars();
    if !chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
    {
        return false;
    }
    chars
        .as_str()
        .trim_start_matches(|c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        .trim_start()
        .starts_with(':')
}

fn parse_block(block: &str) -> FrontMatter {
    let mut meta = FrontMatter::default();
    for line in block.lines() {
        if !parse_known(&mut meta, line) {
            meta.extra.push(line.to_string());
        }
    }
    meta
}

/// 认得出来就填进 meta 并返回 true；认不出来（或值解析不了）返回 false，交给 extra 原样保留。
fn parse_known(meta: &mut FrontMatter, line: &str) -> bool {
    // 缩进的行是上一个键的续行，不是新键
    if line.starts_with(char::is_whitespace) {
        return false;
    }
    let Some((key, value)) = line.split_once(':') else {
        return false;
    };
    let value = value.trim();
    // `key: |` / `key: >` 之类的块标量、空值：交给 extra
    if value.is_empty() || value.starts_with('|') || value.starts_with('>') {
        return false;
    }
    match key.trim() {
        "id" => match unquote(value) {
            Some(id) if !id.is_empty() && meta.id.is_none() => meta.id = Some(id),
            _ => return false,
        },
        "title" => match unquote(value) {
            Some(title) if meta.title.is_none() => meta.title = Some(title),
            _ => return false,
        },
        "created" => match unquote(value).as_deref().and_then(parse_time) {
            Some(ms) if meta.created.is_none() => meta.created = Some(ms),
            _ => return false,
        },
        "pinned" => match unquote(value).as_deref() {
            Some("true" | "yes" | "on") => meta.pinned = true,
            Some("false" | "no" | "off") => meta.pinned = false,
            _ => return false,
        },
        "archived" => match unquote(value).as_deref().and_then(parse_time) {
            Some(ms) if meta.archived.is_none() => meta.archived = Some(ms),
            _ => return false,
        },
        "category" => match unquote(value) {
            Some(category) if meta.category.is_none() => meta.category = Some(category),
            _ => return false,
        },
        "archived-from" => match unquote(value) {
            Some(from) if meta.archived_from.is_none() => meta.archived_from = Some(from),
            _ => return false,
        },
        "trashed-from" => match unquote(value) {
            Some(from) if meta.trashed_from.is_none() => meta.trashed_from = Some(from),
            _ => return false,
        },
        _ => return false,
    }
    true
}

/// 双引号字符串：反斜杠和双引号转义。标题里有冒号、井号、引号都不会破坏 YAML。
fn quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// 单行标量：双引号（带转义）、单引号（`''` 表示一个引号）、或者裸值（去掉行尾注释）。
fn unquote(value: &str) -> Option<String> {
    if let Some(inner) = value.strip_prefix('"') {
        let mut out = String::new();
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            match c {
                '"' => return chars.as_str().trim().is_empty().then_some(out),
                '\\' => match chars.next()? {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    other => out.push(other),
                },
                c => out.push(c),
            }
        }
        return None;
    }
    if let Some(inner) = value.strip_prefix('\'') {
        let inner = inner.strip_suffix('\'')?;
        return Some(inner.replace("''", "'"));
    }
    let plain = match value.find(" #") {
        Some(index) => &value[..index],
        None => value,
    };
    Some(plain.trim().to_string())
}

/// 本地时间带时区偏移，人读得懂、换台机器也不会错
pub fn format_time(ms: i64) -> String {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%S%:z").to_string())
        .unwrap_or_default()
}

/// RFC 3339；或者本地的 `YYYY-MM-DD HH:MM[:SS]` / `YYYY-MM-DD`（别的工具常这么写）
pub fn parse_time(value: &str) -> Option<i64> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(value) {
        return Some(dt.timestamp_millis());
    }
    let local = |naive: NaiveDateTime| {
        Local
            .from_local_datetime(&naive)
            .earliest()
            .map(|dt| dt.timestamp_millis())
    };
    for format in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(value, format) {
            return local(naive);
        }
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .and_then(local)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_markdown_has_no_front_matter() {
        let (meta, body) = split("# 标题\n\n正文");
        assert!(meta.is_empty());
        assert_eq!(body, "# 标题\n\n正文");
        assert_eq!(render(&meta, &body), "# 标题\n\n正文");
    }

    #[test]
    fn round_trips_app_keys_and_body() {
        let meta = FrontMatter {
            id: Some("0192-abc".into()),
            title: Some("周报: \"第 3 期\" #草稿".into()),
            created: Some(1_788_000_000_000),
            pinned: true,
            archived: Some(1_788_100_000_000),
            category: Some("工作笔记".into()),
            archived_from: Some("笔记/工作/周报".into()),
            trashed_from: None,
            extra: vec![],
        };
        let body = "\n开头空一行也要留住\n\n- [ ] 任务";
        let text = render(&meta, body);
        let (back, back_body) = split(&text);
        assert_eq!(back, meta);
        assert_eq!(back_body, body);
    }

    #[test]
    fn keeps_unknown_keys_verbatim() {
        let text = "---\nid: n1\ntags:\n  - 旅行\n  - 书店\naliases: [京都]\n---\n\n正文";
        let (meta, body) = split(text);
        assert_eq!(meta.id.as_deref(), Some("n1"));
        assert_eq!(
            meta.extra,
            vec!["tags:", "  - 旅行", "  - 书店", "aliases: [京都]"]
        );
        assert_eq!(body, "正文");
        assert_eq!(render(&meta, &body), text);
    }

    #[test]
    fn tags_are_read_in_every_way_obsidian_writes_them() {
        let tags = |block: &str| split(&format!("---\n{block}\n---\n\n正文")).0.tags();
        let travel = vec!["旅行".to_string(), "书店".to_string()];
        assert_eq!(tags("tags:\n  - 旅行\n  - 书店\naliases: [京都]"), travel);
        assert_eq!(tags("tags:\n- 旅行\n- \"#书店\""), travel, "不缩进的、带引号和 # 的");
        assert_eq!(tags("tags: [旅行, 书店]"), travel);
        assert_eq!(tags("tags: 旅行, 书店"), travel);
        assert_eq!(tags("tags: 旅行 书店 旅行"), travel, "重复的只留一个");
        assert_eq!(tags("tag: 旅行"), vec!["旅行".to_string()], "老写法");
        assert_eq!(tags("Tags: [Work/Weekly]"), vec!["work/weekly".to_string()], "转小写，层级照原样");
        // 别的键下面的列表、别的键里出现的 tags 字样都不算
        assert!(tags("aliases:\n  - 旅行\nmy-tags: 书店\nid: n1").is_empty());
        assert!(tags("tags:\nid: n1").is_empty(), "空的");
    }

    #[test]
    fn a_leading_rule_is_not_front_matter() {
        // 第一行是分隔线、后面没有 key: value：这是正文
        let text = "---\n\n一段话\n\n---\n\n另一段";
        let (meta, body) = split(text);
        assert!(meta.is_empty());
        assert_eq!(body, text);
    }

    #[test]
    fn accepts_crlf_bom_and_other_tools_formats() {
        let text = "\u{feff}---\r\ntitle: 'It''s here'\r\ncreated: 2026-08-28 11:59\r\npinned: yes\r\n---\r\n正文\r\n第二行";
        let (meta, body) = split(text);
        assert_eq!(meta.title.as_deref(), Some("It's here"));
        assert_eq!(format_time(meta.created.unwrap())[..16], *"2026-08-28T11:59");
        assert!(meta.pinned);
        assert_eq!(body, "正文\n第二行");
    }

    #[test]
    fn unparseable_known_keys_are_kept_not_dropped() {
        let (meta, _) = split("---\ncreated: 上周\npinned: maybe\ntitle: |\n  多行\n---\n");
        assert!(meta.created.is_none());
        assert_eq!(
            meta.extra,
            vec!["created: 上周", "pinned: maybe", "title: |", "  多行"]
        );
    }

    #[test]
    fn plain_values_drop_trailing_comments() {
        let (meta, _) = split("---\ncategory: 读书 # 以后再分\n---\n");
        assert_eq!(meta.category.as_deref(), Some("读书"));
    }
}
