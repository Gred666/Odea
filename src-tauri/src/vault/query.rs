/* ============================================================
智能文件夹的条件（docs/仓库与启动器.md §7.2「智能文件夹」）：清单里存一行字，
打开它的时候按这一行把笔记筛一遍。空格分开的几个条件都得满足：

    交易 复盘          标题或正文里有这两个词（不分大小写）
    "两个 词"          带空格的词用引号括起来
    title:周报         只看标题
    #复盘              正文里的标签（`#复盘`、`#复盘/周`；后面紧跟着字的 `#复盘会` 不算，代码里的不算）
    in:交易/学习       在树上这个文件夹里（子文件夹里的也算）；in:未整理 是没被放进树里的
    updated:30d        30 天内改过（d 天、w 周、m 月、y 年）；created:7d 同理
    is:pinned          置顶的
    has:todo           有没勾的待办（`- [ ]`）
    -词、-#标签 …      前面加 - 是「不要」

归档的笔记不算：智能文件夹在树上，树上只有没归档的。属性块里的 tags 不认（索引里只有正文）。
============================================================ */

use super::index::DocRow;
use super::links::without_code;

const DAY_MS: i64 = 86_400_000;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Term {
    /// 标题或正文里有（已转小写）
    Text(String),
    Title(String),
    Tag(String),
    /// 树上的文件夹路径；None 是「未整理」
    In(Option<String>),
    /// 多少毫秒之内改过 / 建的
    Updated(i64),
    Created(i64),
    Pinned,
    Todo,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Cond {
    negate: bool,
    term: Term,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query {
    conds: Vec<Cond>,
}

/// 一篇笔记在树上的位置：所在文件夹的路径（根是空串），没被放进树里是 None
pub type Placement<'a> = Option<&'a str>;

/// 筛的时候要看的一篇：标题、正文先转好小写（一篇只转一次，几个智能文件夹一起筛）
pub struct Doc<'a> {
    row: &'a DocRow,
    title: String,
    body: String,
    /// 去掉代码的正文：认标签、待办只看这个（`#include`、代码块里举例的 `- [ ]` 都不算）
    prose: String,
}

impl<'a> Doc<'a> {
    pub fn new(row: &'a DocRow) -> Self {
        let body = row.content_md.to_lowercase();
        Self {
            row,
            title: row.title.to_lowercase(),
            prose: without_code(&body),
            body,
        }
    }
}

impl Query {
    pub fn parse(text: &str) -> Self {
        let conds = words(text)
            .into_iter()
            .filter_map(|(word, quoted)| {
                let (negate, word) = match word.strip_prefix('-') {
                    Some(rest) if !quoted && !rest.is_empty() => (true, rest.to_string()),
                    _ => (false, word),
                };
                let term = if quoted { Term::Text(word.to_lowercase()) } else { term_of(&word)? };
                Some(Cond { negate, term })
            })
            .collect();
        Self { conds }
    }

    /// now 是现在的 UTC 毫秒
    pub fn matches(&self, doc: &Doc, at: Placement, now: i64) -> bool {
        let Doc { row, title, body, prose } = doc;
        if row.kind != "note" || row.archived {
            return false;
        }
        self.conds.iter().all(|cond| {
            let hit = match &cond.term {
                Term::Text(word) => title.contains(word) || body.contains(word),
                Term::Title(word) => title.contains(word),
                Term::Tag(tag) => has_tag(prose, tag),
                Term::In(None) => at.is_none(),
                Term::In(Some(folder)) => at.is_some_and(|at| at == folder || at.starts_with(&format!("{folder}/"))),
                Term::Updated(span) => row.updated_at >= now - span,
                Term::Created(span) => row.created_at >= now - span,
                Term::Pinned => row.pinned,
                Term::Todo => has_open_task(prose),
            };
            hit != cond.negate
        })
    }
}

/// 按空白切开；双引号括起来的算一个（第二个值是不是括起来的）
fn words(text: &str) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    let mut rest = text.trim();
    while !rest.is_empty() {
        if let Some(inner) = rest.strip_prefix('"') {
            let end = inner.find('"').unwrap_or(inner.len());
            let word = inner[..end].trim();
            if !word.is_empty() {
                out.push((word.to_string(), true));
            }
            rest = inner.get(end + 1..).unwrap_or("").trim_start();
            continue;
        }
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        out.push((rest[..end].to_string(), false));
        rest = rest[end..].trim_start();
    }
    out
}

fn term_of(word: &str) -> Option<Term> {
    if let Some(tag) = word.strip_prefix('#').filter(|tag| !tag.is_empty()) {
        return Some(Term::Tag(tag.to_lowercase()));
    }
    let Some((key, value)) = word.split_once(':') else {
        return Some(Term::Text(word.to_lowercase()));
    };
    let value = value.trim();
    Some(match key.to_ascii_lowercase().as_str() {
        "title" if !value.is_empty() => Term::Title(value.to_lowercase()),
        "in" => match value.trim_matches('/') {
            "未整理" => Term::In(None),
            folder => Term::In(Some(folder.to_string())),
        },
        "updated" => Term::Updated(span(value)?),
        "created" => Term::Created(span(value)?),
        "is" if value.eq_ignore_ascii_case("pinned") => Term::Pinned,
        "has" if matches!(value.to_ascii_lowercase().as_str(), "todo" | "task") => Term::Todo,
        // 认不出来的（`http://…`、`10:30`）当普通的词
        _ => Term::Text(word.to_lowercase()),
    })
}

/// `30d` `2w` `3m` `1y` → 毫秒。写错了的这个条件不算（返回 None，整条忽略）
fn span(value: &str) -> Option<i64> {
    let value = value.to_ascii_lowercase();
    let unit = value.chars().last()?;
    let days = match unit {
        'd' => 1,
        'w' => 7,
        'm' => 30,
        'y' => 365,
        _ => return None,
    };
    let count: i64 = value[..value.len() - 1].parse().ok()?;
    Some(count.max(0) * days * DAY_MS)
}

/// 正文里有没有这个标签：`#` 前面不是字母数字（不是网址里的锚点、`C#`），后面紧跟的不是字母数字
/// （`#复盘/周` 算 `#复盘`，`#复盘会` 不算）。body、tag 都已经转小写
fn has_tag(body: &str, tag: &str) -> bool {
    let needle = format!("#{tag}");
    body.match_indices(&needle).any(|(at, _)| {
        let before = body[..at].chars().next_back();
        let after = body[at + needle.len()..].chars().next();
        let word = |c: char| c.is_alphanumeric() || c == '_' || c == '-';
        !before.is_some_and(|c| word(c) || c == '#') && !after.is_some_and(word)
    })
}

/// 有没勾的待办：`- [ ]`、`* [ ]`、`+ [ ]`、`1. [ ]`
fn has_open_task(body: &str) -> bool {
    body.lines().any(|line| {
        let line = line.trim_start();
        let rest = match line.strip_prefix(['-', '*', '+']) {
            Some(rest) => rest,
            None => {
                let digits = line.chars().take_while(char::is_ascii_digit).count();
                match line[digits..].strip_prefix(['.', ')']) {
                    Some(rest) if digits > 0 => rest,
                    _ => return false,
                }
            }
        };
        rest.starts_with(" [ ]")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(title: &str, body: &str) -> DocRow {
        DocRow {
            id: "n".into(),
            kind: "note",
            rel_path: format!("{title}.md"),
            day: None,
            horizon: None,
            period_start: None,
            title: title.into(),
            content_md: body.into(),
            excerpt: String::new(),
            word_count: 0,
            pinned: false,
            archived: false,
            category: None,
            archived_at: None,
            created_at: 0,
            updated_at: 0,
            mtime: 0,
            size: 0,
            hash: String::new(),
            file_id: None,
        }
    }

    fn hit(query: &str, row: &DocRow, at: Placement) -> bool {
        Query::parse(query).matches(&Doc::new(row), at, 100 * DAY_MS)
    }

    #[test]
    fn words_titles_and_tags() {
        let note = row("交易复盘 第 3 周", "这周 #复盘/周 做得不错，#交易会 下周开\n看了 C#复盘 的书");
        assert!(hit("复盘", &note, None));
        assert!(hit("交易 复盘", &note, None));
        assert!(!hit("交易 期货", &note, None));
        assert!(hit("title:第 ", &note, None) && !hit("title:不错", &note, None));
        assert!(hit("\"第 3 周\"", &note, None));
        assert!(hit("#复盘", &note, None), "#复盘/周 算 #复盘");
        assert!(!hit("#交易", &note, None), "#交易会 不算 #交易");
        assert!(hit("-#交易", &note, None));
        assert!(!hit("-复盘", &note, None));
        assert!(hit("", &note, None), "空的条件什么都要");
        let code = row("指南", "比如 `#复盘 updated:30d`\n```c\n#include <复盘>\n- [ ] 举例\n```");
        assert!(!hit("#复盘", &code, None), "行内代码里的标签不算");
        assert!(!hit("#include", &code, None), "代码块里的不算");
        assert!(!hit("has:todo", &code, None), "代码块里举例的待办不算");
        assert!(hit("include", &code, None), "普通的词照样搜得到代码里的");
    }

    #[test]
    fn places_dates_and_flags() {
        let mut note = row("周报", "- [x] 写完\n  1. [ ] 还没做");
        note.updated_at = 95 * DAY_MS;
        note.created_at = 10 * DAY_MS;
        note.pinned = true;
        assert!(hit("in:交易", &note, Some("交易/学习")));
        assert!(!hit("in:交易", &note, Some("交易会")));
        assert!(!hit("in:交易", &note, None));
        assert!(hit("in:未整理", &note, None));
        assert!(hit("updated:7d", &note, None) && !hit("updated:3d", &note, None));
        assert!(hit("created:13w", &note, None) && !hit("created:2m", &note, None));
        assert!(hit("updated:坏了", &note, None), "写错了的条件不算");
        assert!(hit("is:pinned has:todo", &note, None));
        note.content_md = "- [x] 都做完了".into();
        assert!(!hit("has:todo", &note, None));
        note.archived = true;
        assert!(!hit("", &note, None), "归档的不算");
        assert!(hit("10:30", &row("会", "10:30 开会"), None), "认不出来的当普通的词");
    }
}
