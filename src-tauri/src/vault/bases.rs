/* ============================================================
视图文件（docs/视图文件.md）：Obsidian 的 `.base`，按属性把笔记列成表格、看板。

Rust 这边只管两样：
- 每篇 Markdown 文档的属性原文、标签、（要的话）正文里的 `#标签` 和 `[[双链]]`，一次给齐（base_docs）。
  筛选、排序、分组、公式在前端算（§3.3：表达式一份、浏览器预览也能用、改了马上重算）
- `.base` 文件本身的读、写、新建。写的时候带着读的那一版的指纹，磁盘上已经不是那一版就不写
  （别处改了：Obsidian、同步、手改），前端重读以后把这一次的改动再做一遍
============================================================ */

use serde::{Deserialize, Serialize};

use super::{folders, fsio, layout, links, Vault};
use crate::domain::model::{DocRef, NOTE};
use crate::error::{AppError, Result};

/// 视图文件的扩展名
pub const EXT: &str = "base";

/// 一个视图文件最大多少（YAML 配置，正常几 KB）：再大多半不是视图文件，也不往回写
const MAX_BYTES: usize = 1 << 20;

/// 视图里的一行：一篇 Markdown 文档（笔记、归档的、插件的某一天 / 目标）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BaseDoc {
    pub target: DocRef,
    pub rel_path: String,
    /// 笔记的标题；插件的文档没有标题时是空串（前端拿文件名）
    pub title: String,
    pub created_at: f64,
    pub updated_at: f64,
    /// 文件大小（字节）
    pub size: f64,
    pub archived: bool,
    /// 不是 UTF-8：只能看，属性改不了
    pub not_utf8: bool,
    /// 属性块里用户自己的那几行（原文，同属性面板）
    pub props: String,
    /// 标签：属性块里写的；with_body 时加上正文里的 `#标签`。小写、不带 #、不重复
    pub tags: Vec<String>,
    /// 正文里 `[[双链]]` 的目标（标题，去掉了 `|别名`、`#小节`）。没要正文时是 None
    pub links: Option<Vec<String>>,
}

/// 一个视图文件的全文和指纹（写回时交回来核对）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BaseText {
    pub text: String,
    pub fingerprint: String,
}

/// 前端给的路径是不是一个视图文件：仓库里的相对路径，每一段都是普通的名字，以 `.base` 结尾
fn check_rel(rel: &str) -> Result<()> {
    let ok = rel.split('/').all(fsio::is_plain_name) && is_base_name(rel);
    if ok {
        Ok(())
    } else {
        Err(AppError::Invalid(format!("不是视图文件: {rel}")))
    }
}

pub fn is_base_name(name: &str) -> bool {
    layout::stem_and_ext(name).1.eq_ignore_ascii_case(EXT)
}

/// 正文里的 `#标签`（已经去掉了代码）：`#` 前面不是字母数字、后面是字母数字 `_ - /`，
/// 而且不全是数字（Obsidian 的规矩：`#2026` 不是标签）。小写
fn body_tags(prose: &str) -> Vec<String> {
    let word = |c: char| c.is_alphanumeric() || c == '_' || c == '-';
    let mut out = Vec::new();
    for (at, _) in prose.match_indices('#') {
        if prose[..at].chars().next_back().is_some_and(|c| word(c) || c == '#' || c == '/') {
            continue;
        }
        let rest = &prose[at + 1..];
        let len: usize = rest.chars().take_while(|&c| word(c) || c == '/').map(char::len_utf8).sum();
        let tag = rest[..len].trim_end_matches('/');
        if tag.is_empty() || tag.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        out.push(tag.to_lowercase());
    }
    out
}

impl Vault {
    /// 视图要的每一篇。with_body：再读正文，给正文里的标签和双链（筛选里用到 file.tags / hasTag /
    /// file.links / hasLink 才要；3000 篇的正文十几 MB，不要就不读）
    pub fn base_docs(&self, with_body: bool) -> Result<Vec<BaseDoc>> {
        let body = if with_body { "content_md" } else { "''" };
        let mut stmt = self.db.prepare(&format!(
            "SELECT id, kind, key, rel_path, title, created_at, updated_at, size, is_archived, not_utf8, tags, props,
                    {body} AS body
             FROM doc"
        ))?;
        let mut rows = stmt.query([])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            let kind: String = row.get("kind")?;
            let id: String = row.get("id")?;
            let key: Option<String> = row.get("key")?;
            let target = if kind == NOTE {
                DocRef::note(id)
            } else {
                DocRef::new(kind, key.unwrap_or(id))
            };
            let mut tags: Vec<String> = row
                .get::<_, String>("tags")?
                .split('\n')
                .filter(|tag| !tag.is_empty())
                .map(str::to_string)
                .collect();
            let links = if with_body {
                let text = row.get_ref("body")?.as_str().unwrap_or("");
                let prose = links::without_code(text);
                for tag in body_tags(&prose) {
                    if !tags.contains(&tag) {
                        tags.push(tag);
                    }
                }
                let mut targets: Vec<String> = Vec::new();
                for link in links::wikilinks(text) {
                    if !targets.iter().any(|known| links::same_title(known, &link.title)) {
                        targets.push(link.title);
                    }
                }
                Some(targets)
            } else {
                None
            };
            out.push(BaseDoc {
                target,
                rel_path: row.get("rel_path")?,
                title: row.get("title")?,
                created_at: row.get::<_, i64>("created_at")? as f64,
                updated_at: row.get::<_, i64>("updated_at")? as f64,
                size: row.get::<_, i64>("size")? as f64,
                archived: row.get::<_, i64>("is_archived")? != 0,
                not_utf8: row.get::<_, i64>("not_utf8")? != 0,
                props: row.get("props")?,
                tags,
                links,
            });
        }
        Ok(out)
    }

    /// 读一个视图文件
    pub fn base_read(&self, rel: &str) -> Result<BaseText> {
        check_rel(rel)?;
        let text = self
            .read(rel)?
            .ok_or_else(|| AppError::NotFound(format!("这个视图文件不在了: {rel}")))?;
        let fingerprint = fsio::fingerprint(&text);
        Ok(BaseText { text, fingerprint })
    }

    /// 写回一个视图文件。expected 是读的时候的指纹：磁盘上已经不是那一版（别处改过）就不写，
    /// 报 Invalid「别处改过」，前端重读、在新的那一版上再改一次
    pub fn base_write(&mut self, rel: &str, text: &str, expected: &str) -> Result<BaseText> {
        check_rel(rel)?;
        if text.len() > MAX_BYTES {
            return Err(AppError::Invalid("视图文件太大了".into()));
        }
        let current = self
            .read(rel)?
            .ok_or_else(|| AppError::NotFound(format!("这个视图文件不在了: {rel}")))?;
        if fsio::fingerprint(&current) != expected {
            return Err(AppError::Invalid(STALE.into()));
        }
        fsio::write_atomic(&fsio::abs(&self.root, rel), text)?;
        Ok(BaseText { text: text.to_string(), fingerprint: fsio::fingerprint(text) })
    }

    /// 在树上的这个文件夹里新建一个视图文件（名字重了加「 2」），返回它的相对路径
    pub fn base_create(&mut self, folder: &str, name: &str, text: &str) -> Result<String> {
        if self.tree.is_some() {
            return Err(AppError::Invalid("逻辑目录里还不能放视图文件".into()));
        }
        if text.len() > MAX_BYTES {
            return Err(AppError::Invalid("视图文件太大了".into()));
        }
        let dir = self.layout.folder_dir(folder)?;
        let stem = layout::file_stem_for_title(name);
        let stem = if stem.is_empty() { "未命名视图".to_string() } else { stem };
        let stem = fsio::fit_stem(&stem, super::NUMBER_TAIL + EXT.len() + 1).to_string();
        let rel = (1..)
            .map(|n| {
                let name = if n == 1 { format!("{stem}.{EXT}") } else { format!("{stem} {n}.{EXT}") };
                layout::join(&dir, &name)
            })
            .find(|rel| !fsio::abs(&self.root, rel).exists())
            .unwrap_or_default();
        if let Some(parent) = fsio::abs(&self.root, &rel).parent() {
            std::fs::create_dir_all(parent)?;
        }
        fsio::write_atomic(&fsio::abs(&self.root, &rel), text)?;
        // 树上的文件（列表栏）这次就带上它，不等文件监听
        let (folders, files) = folders::scan(&self.root, &self.layout, true);
        self.folders = folders;
        self.files = files;
        Ok(rel)
    }
}

/// 写回时磁盘上已经不是读的那一版（前端认这句话：重读、再改一次）
pub const STALE: &str = "这个视图文件在别处改过了";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_tags_follow_obsidian() {
        let prose = "#项目 写了 #复盘/周 和 C# 还有 #2026、#v2，网址 a.com/#frag 不算，## 标题不算 #Mixed";
        assert_eq!(body_tags(prose), ["项目", "复盘/周", "v2", "mixed"]);
    }

    #[test]
    fn only_base_paths_are_accepted() {
        assert!(check_rel("项目/看板.base").is_ok());
        assert!(check_rel("看板.BASE").is_ok());
        assert!(check_rel("项目/看板.md").is_err());
        assert!(check_rel("../外面.base").is_err());
        assert!(check_rel(".odea/x.base").is_err());
    }
}
