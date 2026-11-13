/* ============================================================
索引：从仓库文件派生出来的缓存，随时可以删掉重建。

存在应用数据目录里（不在仓库里）：仓库可能放在网盘同步的文件夹下，
一个正在写的 SQLite 被同步程序来回拷，迟早出冲突副本。

表结构改了就升 VERSION：版本不对时整个索引清空，下次扫描从文件重建。
不需要迁移脚本 —— 这就是「文件是真相」换来的。

核心只认笔记。插件的文档（某一天、目标……）也在 doc 表里，kind 是它的类型 id、key 是它的 key；
插件自己另存的东西（日程的带日期的任务）在插件自己的表里（plugins::IndexPart），和文档同一个事务写、删。
============================================================ */

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::Result;
use crate::plugins::{self, IndexPart};

/// 3：去掉了全文索引表 doc_fts（2026-10-16，jieba 分词不要了，技术方案 §6）
/// 4：日程变成插件（P14.1，2026-11-04）：day / horizon / period_start 三列换成通用的 key，kind 是文档类型 id
/// 5：加 not_utf8（2026-11-10，docs/1110审查与研究.md §5.1）
/// 6：加 tags（2026-11-11，属性块里写的标签，智能文件夹的 #标签 认它们，TODO.md P15）
/// 7：日程的 task 表加 remind_at（任务后面的 ⏰）、doc 加 props（属性块里用户自己的键，属性面板的提示从这里算），
///    2026-11-12，docs/提醒与属性.md
const VERSION: i64 = 7;

const SCHEMA: &str = "
CREATE TABLE doc (
  id             TEXT    PRIMARY KEY,
  kind           TEXT    NOT NULL,          -- note，或者插件的文档类型（journal.day …）
  rel_path       TEXT    NOT NULL UNIQUE,   -- 仓库内相对路径，正斜杠
  key            TEXT,                      -- 插件的文档：它的 key（2026-11-03、week:2026-11-02）
  title          TEXT    NOT NULL,
  content_md     TEXT    NOT NULL,
  excerpt        TEXT    NOT NULL,
  word_count     INTEGER NOT NULL,
  is_pinned      INTEGER NOT NULL,
  is_archived    INTEGER NOT NULL,
  archive_category TEXT,
  archived_at    INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  mtime          INTEGER NOT NULL,
  size           INTEGER NOT NULL,
  hash           TEXT    NOT NULL,          -- 文件内容指纹：磁盘上的是不是索引里这一版
  file_id        TEXT,                      -- 文件属性块里写的 id。和 id 不一样 = 这是别的文件的拷贝（网盘冲突副本）
  not_utf8       INTEGER NOT NULL,          -- 文件不是 UTF-8：content_md 是换过字的，只能看、不能写回
  tags           TEXT    NOT NULL,          -- 属性块里写的标签（FrontMatter::tags），小写，一行一个
  props          TEXT    NOT NULL           -- 属性块里用户自己的那几行（FrontMatter::extra），原样
);
CREATE UNIQUE INDEX doc_key ON doc(kind, key) WHERE kind != 'note';
";

pub fn open(path: &Path) -> Result<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    prepare(&conn)?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_in_memory() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    prepare(&conn).unwrap();
    conn
}

fn prepare(conn: &Connection) -> Result<()> {
    // 记几个和表结构无关的值（这个索引按哪种摆法建的，见 sync_layout）。后加的，不升 VERSION
    conn.execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version == VERSION {
        return Ok(());
    }
    // doc_fts 是版本 3 以前的全文索引表，旧索引里还有；task 是日程插件的（版本 4 以前在这里建）
    let parts = plugins::index_parts();
    let mut drop = String::from("DROP TABLE IF EXISTS doc_fts; DROP TABLE IF EXISTS doc;");
    for table in parts.iter().flat_map(|part| part.tables()) {
        drop.push_str(&format!(" DROP TABLE IF EXISTS {table};"));
    }
    conn.execute_batch(&drop)?;
    conn.execute_batch(SCHEMA)?;
    for part in &parts {
        conn.execute_batch(part.schema())?;
    }
    conn.pragma_update(None, "user_version", VERSION)?;
    Ok(())
}

/// 仓库的摆法（layout::Layout::fingerprint）和建这份索引时不一样了（开关了日程、换了日记文件夹）：
/// 清空，下次扫描每个文件按新的摆法重新认。`assumed` = 还没记过时当它是哪一种（P11.2 以前的索引
/// 都是按 Odea 的老规矩建的，那样的仓库不用重读）。清空了返回 true
pub fn sync_layout(conn: &Connection, fingerprint: &str, assumed: &str) -> Result<bool> {
    let stored: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = 'layout'", [], |r| r.get(0))
        .optional()?;
    let stale = stored.as_deref().unwrap_or(assumed) != fingerprint;
    if stale {
        let mut clear = String::from("DELETE FROM doc;");
        for table in plugins::index_parts().iter().flat_map(|part| part.tables()) {
            clear.push_str(&format!(" DELETE FROM {table};"));
        }
        conn.execute_batch(&clear)?;
    }
    if stale || stored.is_none() {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('layout', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![fingerprint],
        )?;
    }
    Ok(stale)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocRow {
    pub id: String,
    /// note，或者插件的文档类型（journal.day …）
    pub kind: String,
    pub rel_path: String,
    /// 插件的文档：它的 key（笔记是 None）
    pub key: Option<String>,
    pub title: String,
    pub content_md: String,
    pub excerpt: String,
    pub word_count: i64,
    pub pinned: bool,
    pub archived: bool,
    pub category: Option<String>,
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub mtime: i64,
    pub size: i64,
    pub hash: String,
    /// 文件属性块里写着的 id（没有就是 None）。和 `id` 不同说明这个 id 已经被
    /// 另一个文件占着，这一份多半是拷贝出来的（网盘的冲突副本）
    pub file_id: Option<String>,
    /// 文件不是 UTF-8（GBK、UTF-16 这些）：content_md 里认不出的字换成了 U+FFFD。
    /// 只能看，所有会写回这个文件的操作都拒绝（Vault::read），不然原文就没了
    pub not_utf8: bool,
    /// 属性块里写的标签（FrontMatter::tags）：小写、不带 #。正文里的 #标签 不在这里（智能文件夹现找）
    pub tags: Vec<String>,
    /// 属性块里用户自己的那几行（FrontMatter::extra），原样、换行连起来。属性面板的提示从这里算（vault/properties.rs）
    pub props: String,
}

const COLUMNS: &str = "id, kind, rel_path, key, title, content_md, excerpt,
    word_count, is_pinned, is_archived, archive_category, archived_at, created_at, updated_at,
    mtime, size, hash, file_id, not_utf8, tags, props";

fn row(r: &Row) -> rusqlite::Result<DocRow> {
    Ok(DocRow {
        id: r.get("id")?,
        kind: r.get("kind")?,
        rel_path: r.get("rel_path")?,
        key: r.get("key")?,
        title: r.get("title")?,
        content_md: r.get("content_md")?,
        excerpt: r.get("excerpt")?,
        word_count: r.get("word_count")?,
        pinned: r.get::<_, i64>("is_pinned")? != 0,
        archived: r.get::<_, i64>("is_archived")? != 0,
        category: r.get("archive_category")?,
        archived_at: r.get("archived_at")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        mtime: r.get("mtime")?,
        size: r.get("size")?,
        hash: r.get("hash")?,
        file_id: r.get("file_id")?,
        not_utf8: r.get::<_, i64>("not_utf8")? != 0,
        tags: r
            .get::<_, String>("tags")?
            .split('\n')
            .filter(|tag| !tag.is_empty())
            .map(str::to_string)
            .collect(),
        props: r.get("props")?,
    })
}

/// 按条件取一篇（插件拿它查自己的文档，plugins/journal）
pub fn one(conn: &Connection, filter: &str, args: impl rusqlite::Params) -> Result<Option<DocRow>> {
    Ok(conn
        .query_row(&format!("SELECT {COLUMNS} FROM doc WHERE {filter}"), args, row)
        .optional()?)
}

fn many(conn: &Connection, rest: &str, args: impl rusqlite::Params) -> Result<Vec<DocRow>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM doc {rest}"))?;
    let rows = stmt.query_map(args, row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn by_id(conn: &Connection, id: &str) -> Result<Option<DocRow>> {
    one(conn, "id = ?1", params![id])
}

pub fn by_path(conn: &Connection, rel: &str) -> Result<Option<DocRow>> {
    one(conn, "rel_path = ?1", params![rel])
}

/// 插件的一篇：类型 id 和 key
pub fn typed(conn: &Connection, kind: &str, key: &str) -> Result<Option<DocRow>> {
    one(conn, "kind = ?1 AND key = ?2", params![kind, key])
}

/// 笔记 / 归档列表：置顶在前，再按更新 / 归档时间倒序
pub fn notes(conn: &Connection, archived: bool) -> Result<Vec<DocRow>> {
    let order = if archived {
        "is_pinned DESC, COALESCE(archived_at, updated_at) DESC"
    } else {
        "is_pinned DESC, updated_at DESC"
    };
    many(
        conn,
        &format!("WHERE kind = 'note' AND is_archived = ?1 ORDER BY {order}, rel_path"),
        params![archived as i64],
    )
}

/// 同 notes，但不读正文（content_md 是空串）：列表只要摘要，几万篇也不该把全文都读一遍
pub fn note_summaries(conn: &Connection, archived: bool) -> Result<Vec<DocRow>> {
    let order = if archived {
        "is_pinned DESC, COALESCE(archived_at, updated_at) DESC"
    } else {
        "is_pinned DESC, updated_at DESC"
    };
    let columns = COLUMNS.replace("content_md", "'' AS content_md");
    let mut stmt = conn.prepare(&format!(
        "SELECT {columns} FROM doc WHERE kind = 'note' AND is_archived = ?1 ORDER BY {order}, rel_path"
    ))?;
    let rows = stmt.query_map(params![archived as i64], row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub struct TextMatch {
    /// content_md 已经清空了，只剩列表要的那些
    pub doc: DocRow,
    pub line: String,
}

/// 正文里有 needle 的文档（needle 已经 to_lowercase）：笔记（含归档）、写过东西的插件文档（某一天、目标）；
/// archived_only 只要归档里的笔记（归档的搜索框）。
/// 整张表顺着扫一遍，每篇在 Rust 里转小写再找 —— SQLite 的 lower() 只管 ASCII，
/// 和前端以前的 toLowerCase().indexOf 不一样。cancelled() 返回 true 就不扫了，返回 None
pub fn scan_text(
    conn: &Connection,
    needle: &str,
    archived_only: bool,
    cancelled: impl Fn() -> bool,
) -> Result<Option<Vec<TextMatch>>> {
    let mut found = Vec::new();
    let finished = each_text_doc(conn, archived_only, |mut doc| {
        if cancelled() {
            return false;
        }
        if let Some(line) = line_with(&doc.content_md, needle) {
            doc.content_md = String::new();
            found.push(TextMatch { doc, line });
        }
        true
    })?;
    Ok(finished.then_some(found))
}

/// 搜正文要看的每一篇（连同正文）：笔记（含归档；archived_only 只要归档里的）和写过东西的插件文档。
/// visit 返回 false 就不往下看了（又来了新的搜索），这时返回 false
pub fn each_text_doc(
    conn: &Connection,
    archived_only: bool,
    mut visit: impl FnMut(DocRow) -> bool,
) -> Result<bool> {
    let filter = if archived_only {
        "kind = 'note' AND is_archived = 1"
    } else {
        "kind = 'note' OR title != '' OR content_md != ''"
    };
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM doc WHERE {filter}"))?;
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        if !visit(row(r)?) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// 第一次出现 needle 的那一行（原样，不转小写）。超过 600 个字的行只留命中处前 200、后 400 个字
fn line_with(content: &str, needle: &str) -> Option<String> {
    const LONG: usize = 600;
    let lower = content.to_lowercase();
    let at = lower.find(needle)?;
    // 转小写不增减换行，第几行在两边是一样的
    let number = lower[..at].matches('\n').count();
    let line = content.split('\n').nth(number)?.trim_end_matches('\r');
    if line.len() <= LONG || line.chars().count() <= LONG {
        return Some(line.to_string());
    }
    // 命中处在这一行的第几个字（大小写换算后字数不变的绝大多数情况下是准的；不准也还在窗口里）
    let line_start = lower[..at].rfind('\n').map_or(0, |i| i + 1);
    let column = lower[line_start..at].chars().count();
    let from = column.saturating_sub(200);
    Some(line.chars().skip(from).take(LONG).collect())
}

/// 正文里写了 `[[` 的文档：反向链接只需要在它们里面找
pub fn with_wikilinks(conn: &Connection) -> Result<Vec<DocRow>> {
    many(conn, "WHERE instr(content_md, '[[') > 0", [])
}

/// 所有笔记（含归档）的 id 和标题：改标题时看新、旧标题有没有别的笔记在用
pub fn note_titles(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT id, title FROM doc WHERE kind = 'note'")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 所有笔记（含归档）的 (id, 路径, 属性块里写着的 id)：逻辑目录的清单按它找笔记（vault/logical.rs）
pub fn note_refs(conn: &Connection) -> Result<Vec<(String, String, Option<String>)>> {
    let mut stmt = conn.prepare("SELECT id, rel_path, file_id FROM doc WHERE kind = 'note'")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// meta 表里记着的一个值
pub fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0))
        .optional()?)
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// 扫描用：已索引的每个文件的 (路径, mtime, size)
pub fn file_states(conn: &Connection) -> Result<Vec<(String, i64, i64)>> {
    let mut stmt = conn.prepare("SELECT rel_path, mtime, size FROM doc")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn id_taken(conn: &Connection, id: &str, except_path: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM doc WHERE id = ?1 AND rel_path != ?2",
        params![id, except_path],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// 写入（或替换）一篇文档，连同开着的插件在索引里另存的那几份（parts）。同一个 id 或同一个路径的旧行先删掉。
/// 返回那几份里变了的是哪几个插件的
pub fn put(conn: &Connection, doc: &DocRow, parts: &[&'static dyn IndexPart]) -> Result<Vec<&'static str>> {
    let tx = conn.unchecked_transaction()?;
    let old = tx
        .prepare("SELECT id FROM doc WHERE id = ?1 OR rel_path = ?2")?
        .query_map(params![doc.id, doc.rel_path], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut changed = Vec::new();
    for part in parts {
        if part.put(&tx, doc, &old)? {
            changed.push(part.plugin());
        }
    }
    for id in &old {
        tx.execute("DELETE FROM doc WHERE id = ?1", params![id])?;
    }
    tx.execute(
        &format!("INSERT INTO doc ({COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)"),
        params![
            doc.id,
            doc.kind,
            doc.rel_path,
            doc.key,
            doc.title,
            doc.content_md,
            doc.excerpt,
            doc.word_count,
            doc.pinned as i64,
            doc.archived as i64,
            doc.category,
            doc.archived_at,
            doc.created_at,
            doc.updated_at,
            doc.mtime,
            doc.size,
            doc.hash,
            doc.file_id,
            doc.not_utf8 as i64,
            doc.tags.join("\n"),
            doc.props,
        ],
    )?;
    tx.commit()?;
    Ok(changed)
}

/// 只更新文件状态（内容没变，比如 mtime 被别的程序碰了一下）
pub fn touch(conn: &Connection, id: &str, mtime: i64, size: i64) -> Result<()> {
    conn.execute(
        "UPDATE doc SET mtime = ?1, size = ?2, updated_at = ?1 WHERE id = ?3",
        params![mtime, size, id],
    )?;
    Ok(())
}

/// 文件改名 / 挪位置之后，先让索引跟上，再写新内容 —— 否则按新路径写入时
/// 旧路径那一行还占着同一个 id，新文件会被当成一篇重复的笔记。
/// 指纹清掉：标题可能来自文件名、归档与否来自位置，内容一样也得重新解析。
pub fn rename(conn: &Connection, id: &str, rel: &str) -> Result<()> {
    conn.execute(
        "UPDATE doc SET rel_path = ?1, hash = '' WHERE id = ?2",
        params![rel, id],
    )?;
    Ok(())
}

/// 整个目录改了名：底下每篇的路径一起换掉前缀。文件内容和修改时间都没变，指纹留着
pub fn rename_dir(conn: &Connection, old_dir: &str, new_dir: &str) -> Result<()> {
    conn.execute(
        "UPDATE doc SET rel_path = ?2 || substr(rel_path, length(?1) + 1)
         WHERE substr(rel_path, 1, length(?1) + 1) = ?1 || '/'",
        params![old_dir, new_dir],
    )?;
    Ok(())
}

/// 目录底下（任意深度）的笔记
pub fn notes_under(conn: &Connection, dir: &str) -> Result<Vec<DocRow>> {
    many(
        conn,
        "WHERE kind = 'note' AND substr(rel_path, 1, length(?1) + 1) = ?1 || '/' ORDER BY rel_path",
        params![dir],
    )
}

/// 去掉一篇，连同 parts 里它的那几份。返回那几份里变了的是哪几个插件的
pub fn remove(conn: &Connection, id: &str, parts: &[&'static dyn IndexPart]) -> Result<Vec<&'static str>> {
    let tx = conn.unchecked_transaction()?;
    let mut changed = Vec::new();
    for part in parts {
        if part.remove(&tx, id)? {
            changed.push(part.plugin());
        }
    }
    tx.execute("DELETE FROM doc WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(changed)
}

/// 所有写过东西的插件文档（某一天、某个周期的目标……，命令面板按标题搜它们）。不读正文，content_md 是空串
pub fn typed_docs(conn: &Connection) -> Result<Vec<DocRow>> {
    let columns = COLUMNS.replace("content_md", "'' AS content_md");
    let mut stmt = conn.prepare(&format!(
        "SELECT {columns} FROM doc
         WHERE kind != 'note' AND (title != '' OR content_md != '')
         ORDER BY updated_at DESC"
    ))?;
    let rows = stmt.query_map([], row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub struct Counts {
    pub notes: i64,
    pub archived: i64,
    /// 插件的文档
    pub docs: i64,
}

pub fn counts(conn: &Connection) -> Result<Counts> {
    let one = |sql: &str| -> Result<i64> { Ok(conn.query_row(sql, [], |r| r.get(0))?) };
    Ok(Counts {
        notes: one("SELECT count(*) FROM doc WHERE kind = 'note' AND is_archived = 0")?,
        archived: one("SELECT count(*) FROM doc WHERE kind = 'note' AND is_archived = 1")?,
        docs: one("SELECT count(*) FROM doc WHERE kind != 'note'")?,
    })
}
