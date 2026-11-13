/* ============================================================
属性块里用户自己的那些键（docs/提醒与属性.md §3）：`tags`、`status`、`截止`……

应用自己的键（id、title、created、pinned、archived、category、archived-from、trashed-from）由应用管，
属性面板里不出现，也不许从面板里写（frontmatter.rs 只认得这几个，别的行原样留在 extra 里）。
面板读写的是 extra 那几行的原文：改哪一项由前端只换那一项的几行（src/properties/yaml.ts），
这里只核对写回来的东西不会把属性块弄坏、也不会冒充应用的键。

另外两样：
- 整个仓库的属性一览（catalog）：每个键用了几次、常见的值、值多半是什么类型。面板加属性、填值时的提示，
  空着的 `截止:` 也能认出是日期（看别的笔记里的 `截止`）。从索引的 props 列现算
- 记着的类型（types）：用户在面板里改过「这个键是什么类型」。仓库里有 `.obsidian/` 就读写它的 types.json
  （同一个文件夹，Obsidian 和 Odea 打开一个样），没有就是 `.odea/types.json`，格式一样：
  `{"types": {"截止": "date"}}`。类型名照 Obsidian：text、multitext、number、checkbox、date、datetime、tags、aliases
============================================================ */

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use super::{fsio, Vault};
use crate::domain::model::{DocRef, VaultChange};
use crate::error::{AppError, Result};

/// 应用自己的键：面板里不出现、不许写
pub const MANAGED: [&str; 8] = ["id", "title", "created", "pinned", "archived", "category", "archived-from", "trashed-from"];
/// 认得的类型（和 Obsidian 的 types.json 一样）
pub const KINDS: [&str; 8] = ["text", "multitext", "number", "checkbox", "date", "datetime", "tags", "aliases"];

/// 一篇的属性：属性块里用户自己的那几行，原样
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DocProperties {
    pub text: String,
    /// 能不能改：文件不是 UTF-8 的、还没写过的插件文档（某一天）不能
    pub editable: bool,
}

/// 整个仓库里的一个键
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertyKey {
    pub key: String,
    /// 几篇里写了它
    pub count: u32,
    /// 值多半是什么类型（KINDS 里的一个；没填过值的是 text）
    pub kind: String,
    /// 常见的值，用得多的在前，最多 40 个
    pub values: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertyCatalog {
    /// 用得多的在前
    pub keys: Vec<PropertyKey>,
    /// 记着的类型：键 → 类型
    pub types: BTreeMap<String, String>,
}

/// 一条属性的值长什么样（统计用；前端编辑有自己的一份更细的，src/properties/yaml.ts）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub key: String,
    pub values: Vec<String>,
    pub list: bool,
    /// 嵌套、多行字符串：只记有这个键
    pub complex: bool,
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    let quoted = |q: char| value.len() >= 2 && value.starts_with(q) && value.ends_with(q);
    if quoted('"') {
        serde_json::from_str::<String>(value).unwrap_or_else(|_| value[1..value.len() - 1].to_string())
    } else if quoted('\'') {
        value[1..value.len() - 1].replace("''", "'")
    } else {
        value.to_string()
    }
}

/// `[a, "b, c", d]` 拆开（引号里的逗号不算）
fn flow_list(inner: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for c in inner.chars() {
        match (quote, c) {
            (None, '"' | '\'') => {
                quote = Some(c);
                current.push(c);
            }
            (Some(q), c) if c == q => {
                quote = None;
                current.push(c);
            }
            (None, ',') => items.push(std::mem::take(&mut current)),
            _ => current.push(c),
        }
    }
    items.push(current);
    items.into_iter().map(|item| unquote(&item)).filter(|item| !item.is_empty()).collect()
}

/// 属性块里的几行认成一条条属性（顶格的 `键: 值`，下面缩进的是它的续行）。注释、认不出的行跳过
pub fn entries(text: &str) -> Vec<Entry> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        index += 1;
        if line.starts_with([' ', '\t', '#', '-']) || line.trim().is_empty() {
            continue;
        }
        let Some((key, rest)) = line.split_once(':') else { continue };
        let key = unquote(key);
        let rest = rest.trim();
        // 续行：缩进的、`- ` 开头的
        let mut more = Vec::new();
        while index < lines.len() && (lines[index].starts_with([' ', '\t']) || lines[index].starts_with("- ")) {
            more.push(lines[index].trim());
            index += 1;
        }
        let more: Vec<&str> = more.into_iter().filter(|line| !line.is_empty()).collect();
        let mut entry = Entry { key, values: Vec::new(), list: false, complex: false };
        if rest.is_empty() {
            if more.iter().all(|line| line.starts_with('-')) {
                entry.list = !more.is_empty();
                entry.values = more.iter().map(|line| unquote(line.trim_start_matches('-'))).filter(|v| !v.is_empty()).collect();
            } else {
                entry.complex = true;
            }
        } else if rest.starts_with('[') && rest.ends_with(']') && more.is_empty() {
            entry.list = true;
            entry.values = flow_list(&rest[1..rest.len() - 1]);
        } else if rest.starts_with(['|', '>', '{', '[', '&', '*', '!']) || !more.is_empty() {
            entry.complex = true;
        } else {
            let value = unquote(rest.split(" #").next().unwrap_or(rest));
            if !value.is_empty() {
                entry.values.push(value);
            }
        }
        out.push(entry);
    }
    out
}

/// 一个值像什么类型
fn kind_of_value(value: &str) -> &'static str {
    let date = |s: &str| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok();
    if value == "true" || value == "false" {
        "checkbox"
    } else if value.parse::<f64>().is_ok_and(f64::is_finite) && !value.starts_with('+') {
        "number"
    } else if value.len() == 10 && date(value) {
        "date"
    } else if value.len() >= 16
        && date(&value[..10])
        && matches!(value.as_bytes()[10], b'T' | b' ')
        && chrono::NaiveTime::parse_from_str(&value[11..16], "%H:%M").is_ok()
    {
        "datetime"
    } else {
        "text"
    }
}

/// 整个仓库的属性一览（每篇的 props 列）
pub fn catalog(props: impl Iterator<Item = String>) -> Vec<PropertyKey> {
    struct Tally {
        count: u32,
        kinds: HashMap<&'static str, u32>,
        values: HashMap<String, u32>,
    }
    let mut keys: HashMap<String, Tally> = HashMap::new();
    for text in props {
        let mut seen = std::collections::HashSet::new();
        for entry in entries(&text) {
            if MANAGED.contains(&entry.key.as_str()) || !seen.insert(entry.key.clone()) {
                continue;
            }
            let tally = keys
                .entry(entry.key.clone())
                .or_insert_with(|| Tally { count: 0, kinds: HashMap::new(), values: HashMap::new() });
            tally.count += 1;
            if entry.complex {
                continue;
            }
            let kind = if entry.list {
                match entry.key.as_str() {
                    "tags" | "tag" => "tags",
                    "aliases" | "alias" => "aliases",
                    _ => "multitext",
                }
            } else if let Some(value) = entry.values.first() {
                kind_of_value(value)
            } else {
                // 空着的不算：不知道是什么
                ""
            };
            if !kind.is_empty() {
                *tally.kinds.entry(kind).or_default() += 1;
            }
            for value in entry.values {
                *tally.values.entry(value).or_default() += 1;
            }
        }
    }
    let mut out: Vec<PropertyKey> = keys
        .into_iter()
        .map(|(key, tally)| {
            let mut values: Vec<(String, u32)> = tally.values.into_iter().collect();
            values.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            let kind = tally
                .kinds
                .into_iter()
                .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(a.0)))
                .map_or("text", |(kind, _)| kind);
            PropertyKey {
                key,
                count: tally.count,
                kind: kind.to_string(),
                values: values.into_iter().take(40).map(|(value, _)| value).collect(),
            }
        })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.key.cmp(&b.key)));
    out
}

/// 写回来的属性块内容：去掉末尾的空行；不能有 `---`（会把属性块提前收尾）、不能冒充应用自己的键
pub fn validate(text: &str) -> Result<Vec<String>> {
    let text = text.replace("\r\n", "\n");
    let mut lines: Vec<String> = text.split('\n').map(|line| line.trim_end().to_string()).collect();
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    while lines.first().is_some_and(|line| line.is_empty()) {
        lines.remove(0);
    }
    for line in &lines {
        if line.trim() == "---" || line.trim() == "..." {
            return Err(AppError::Invalid("属性里不能有单独一行 ---".into()));
        }
        if !line.starts_with([' ', '\t', '#', '-']) {
            if let Some((key, _)) = line.split_once(':') {
                let key = unquote(key);
                if MANAGED.contains(&key.as_str()) {
                    return Err(AppError::Invalid(format!("「{key}」由 Odea 自己管，换个名字吧")));
                }
            }
        }
    }
    Ok(lines)
}

fn types_rel(vault: &Vault) -> &'static str {
    if vault.root.join(".obsidian").is_dir() {
        ".obsidian/types.json"
    } else {
        ".odea/types.json"
    }
}

impl Vault {
    /// 一篇的属性（属性块里用户自己的那几行）
    pub fn doc_properties(&self, target: &DocRef) -> Result<DocProperties> {
        let rel = self.target_rel(target)?;
        Ok(match self.read_lossy(&rel)? {
            Some(file) => DocProperties {
                text: super::frontmatter::split(&file.text).0.extra.join("\n"),
                editable: file.utf8,
            },
            None => DocProperties { text: String::new(), editable: false },
        })
    }

    /// 换掉一篇的属性：只动属性块里用户自己的那几行，应用的键、正文一个字不动
    pub fn set_doc_properties(&mut self, target: &DocRef, text: &str) -> Result<DocProperties> {
        let lines = validate(text)?;
        let rel = self.target_rel(target)?;
        let file = self
            .read(&rel)?
            .ok_or_else(|| AppError::NotFound("这一篇还没写过，先写点什么再加属性".into()))?;
        let (mut meta, body) = super::frontmatter::split(&file);
        if meta.extra == lines {
            return self.doc_properties(target);
        }
        meta.extra = lines;
        if target.is_note() {
            // 和 note_save 一样：写过的笔记属性块里都有 id、created
            let row = self.note_row(&target.key)?;
            meta.id = Some(row.id.clone());
            meta.created.get_or_insert(row.created_at);
        }
        let mut change = VaultChange::default();
        let saved = self.write_and_index(&rel, &super::frontmatter::render(&meta, &body), &mut change)?;
        let entity = self.entity_of(&saved);
        self.log.record(entity, &saved.id, "updated");
        self.announce(change);
        self.doc_properties(target)
    }

    /// 整个仓库的属性一览，加上记着的类型。归档的不算
    pub fn property_catalog(&self) -> Result<PropertyCatalog> {
        let mut stmt = self.db.prepare("SELECT props FROM doc WHERE is_archived = 0 AND props != ''")?;
        let props = stmt.query_map([], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(PropertyCatalog { keys: catalog(props.into_iter()), types: self.property_types() })
    }

    /// 记着的类型（.obsidian/types.json 或 .odea/types.json）。认不得的类型名不要
    pub fn property_types(&self) -> BTreeMap<String, String> {
        let read = |rel: &str| -> Option<BTreeMap<String, String>> {
            let text = std::fs::read_to_string(fsio::abs(&self.root, rel)).ok()?;
            let value: serde_json::Value = serde_json::from_str(&text).ok()?;
            Some(
                value
                    .get("types")?
                    .as_object()?
                    .iter()
                    .filter_map(|(key, kind)| {
                        let kind = kind.as_str()?;
                        KINDS.contains(&kind).then(|| (key.clone(), kind.to_string()))
                    })
                    .collect(),
            )
        };
        read(types_rel(self)).unwrap_or_default()
    }

    /// 记下（kind 为 None 是忘掉）这个键是什么类型。文件里别的东西原样留着
    pub fn set_property_type(&mut self, key: &str, kind: Option<&str>) -> Result<BTreeMap<String, String>> {
        if let Some(kind) = kind {
            if !KINDS.contains(&kind) {
                return Err(AppError::Invalid(format!("不认得的类型：{kind}")));
            }
        }
        let rel = types_rel(self);
        let path = fsio::abs(&self.root, rel);
        let mut value: serde_json::Value = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .filter(serde_json::Value::is_object)
            .unwrap_or_else(|| serde_json::json!({}));
        let types = value
            .as_object_mut()
            .map(|object| object.entry("types").or_insert_with(|| serde_json::json!({})))
            .and_then(serde_json::Value::as_object_mut)
            .ok_or_else(|| AppError::Invalid(format!("{rel} 的格式认不得")))?;
        match kind {
            Some(kind) => {
                types.insert(key.to_string(), serde_json::Value::String(kind.to_string()));
            }
            None => {
                types.remove(key);
            }
        }
        let text = serde_json::to_string_pretty(&value).map_err(|error| AppError::Internal(error.to_string()))?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        fsio::write_atomic(&path, &text)?;
        Ok(self.property_types())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_ways_people_write_properties() {
        let text = "status: 进行中\ntags: [项目, \"发版, 0.9\"]\naliases:\n  - 发版\n  - release\n截止: 2026-11-20\n# 注释\n摘要: |\n  第一行\n  第二行\n优先级: 1\n公开: false\n空的:";
        let got = entries(text);
        let find = |key: &str| got.iter().find(|entry| entry.key == key).unwrap();
        assert_eq!(find("status").values, vec!["进行中"]);
        assert_eq!(find("tags").values, vec!["项目", "发版, 0.9"]);
        assert!(find("tags").list);
        assert_eq!(find("aliases").values, vec!["发版", "release"]);
        assert!(find("摘要").complex);
        assert!(find("空的").values.is_empty());
        assert_eq!(got.len(), 8);
    }

    #[test]
    fn the_catalog_knows_what_a_key_usually_holds() {
        let notes = [
            "status: 进行中\n截止: 2026-11-20\n优先级: 1",
            "status: 已完成\n截止: 2026-11-08\ntags:\n  - 项目",
            "status: 进行中\n截止:\nid: 不算",
        ];
        let keys = catalog(notes.iter().map(|s| s.to_string()));
        let find = |key: &str| keys.iter().find(|entry| entry.key == key).unwrap();
        assert_eq!(keys[0].key, "status");
        assert_eq!(find("status").values, vec!["进行中", "已完成"]);
        // 空着的那篇不算，别的两篇都是日期
        assert_eq!(find("截止").kind, "date");
        assert_eq!(find("截止").count, 3);
        assert_eq!(find("优先级").kind, "number");
        assert_eq!(find("tags").kind, "tags");
        assert!(keys.iter().all(|entry| entry.key != "id"));
    }

    #[test]
    fn writing_back_cannot_break_the_block_or_pose_as_the_app() {
        assert_eq!(validate("\nstatus: 进行中\n\n").unwrap(), vec!["status: 进行中"]);
        assert!(validate("status: 进行中\n---\ntitle: x").is_err());
        assert!(validate("title: 换个标题").is_err());
        // 缩进的续行里出现同名的字不算
        assert_eq!(validate("备注:\n  id: 1").unwrap().len(), 2);
    }

    #[test]
    fn values_have_kinds() {
        assert_eq!(kind_of_value("true"), "checkbox");
        assert_eq!(kind_of_value("3.5"), "number");
        assert_eq!(kind_of_value("2026-11-20"), "date");
        assert_eq!(kind_of_value("2026-11-20T15:30"), "datetime");
        assert_eq!(kind_of_value("2026-11-20 15:30"), "datetime");
        assert_eq!(kind_of_value("进行中"), "text");
        assert_eq!(kind_of_value("+86"), "text");
    }
}
