/* ============================================================
索引：从仓库文件派生出来的缓存，随时可以删掉重建。

存在应用数据目录里（不在仓库里）：仓库可能放在网盘同步的文件夹下，
一个正在写的 SQLite 被同步程序来回拷，迟早出冲突副本。

表结构改了就升 VERSION：版本不对时整个索引清空，下次扫描从文件重建。
不需要迁移脚本 —— 这就是「文件是真相」换来的。

核心只认笔记。插件的文档（某一天、目标……）也在 doc 表里，kind 是它的类型 id、key 是它的 key；
插件自己另存的东西（日程的带日期的任务）在插件自己的表里（plugins::IndexPart），和文档同一个事务写、删。
============================================================ */

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::domain::model::NOTE;
use crate::error::Result;
use crate::plugins::{self, IndexPart};

/// 3：去掉了全文索引表 doc_fts（2026-10-16，jieba 分词不要了，技术方案 §6）
/// 4：日程变成插件（P14.1，2026-11-04）：day / horizon / period_start 三列换成通用的 key，kind 是文档类型 id
/// 5：加 not_utf8（2026-11-10，docs/REVIEWS/2026-11-10-审查与竞品调研.md §5.1）
/// 6：加 tags（2026-11-11，属性块里写的标签，智能文件夹的 #标签 认它们，TODO.md P15）
/// 7：日程的 task 表加 remind_at（任务后面的 ⏰）、doc 加 props（属性块里用户自己的键，属性面板的提示从这里算），
///    2026-11-12，docs/提醒与属性.md
/// 8：表结构没变，认属性块的规矩变了 —— 键是中文的（`标签: 旅行`）也认，以前读进来时当成了正文，要重新认一遍
///    （2026-11-14，docs/提醒与属性.md §3.3）。外来笔记的 id 不跟着换（kept_ids，技术方案 §5.3.1）
///    2026-11-17 键里带组合符号的也认了（同一节的放宽），没再升：8 还没发过版（0.8.0 发的时候是 6），
///    从 0.8.0 升上来本来就要按 8 重建一次
const VERSION: i64 = 8;

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
    // 记几个和表结构无关的值（这个索引按哪种摆法建的，见 sync_layout）。后加的，不升 VERSION。
    // kept_ids：清空 doc 之前笔记的 (路径, id)，重新认的时候按路径还给它们（keep_note_ids）。
    // 这两张都不跟着清，不进下面 DROP、sync_layout 里 DELETE 的名单
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS kept_ids (rel_path TEXT PRIMARY KEY, id TEXT NOT NULL);",
    )?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version == VERSION {
        return Ok(());
    }
    keep_note_ids(conn)?;
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

/* ---------------- 搜正文用的只读连接 ---------------- */

/// search_text、find_in_vault 用的只读连接（连同它连的是哪个索引文件），整个进程一份。不拿仓库的锁：
/// 几万篇的仓库里扫一遍要几百毫秒，这期间自动保存不该等着（索引是 WAL，读写互不挡）
static READER: Mutex<Option<(PathBuf, Connection)>> = Mutex::new(None);

/// 在只读连接上跑一次搜索。排队等到锁之后先看一眼 cancelled()：又来了新的就不扫了。
/// scan 返回 None 也是被顶掉了，都给空结果（前端只认最后一次的）
pub fn with_reader<T: Default>(
    path: PathBuf,
    cancelled: &dyn Fn() -> bool,
    scan: impl FnOnce(&Connection) -> Result<Option<T>>,
) -> Result<T> {
    let mut slot = READER.lock().map_err(|_| crate::error::AppError::Internal("搜索的连接坏了".into()))?;
    if cancelled() {
        return Ok(T::default());
    }
    if slot.as_ref().map(|(open, _)| open != &path).unwrap_or(true) {
        let conn = Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        // 每次搜都把全部正文读一遍：默认的 2 MB 页缓存装不下，每次都从系统缓存一页页拷进来。
        // 映射进来直接读，3000 篇（13 MB）一次 33 → 19 ms（REVIEWS/2026-11-15-桌面端验证.md §3.6）。
        // 映射的是文件页（系统缓存里本来就有），不算进程的专用内存；和应用数据库（db/pragma.rs）一样 256 MB 封顶
        conn.pragma_update(None, "mmap_size", 268_435_456i64)?;
        *slot = Some((path, conn));
    }
    let (_, conn) = slot.as_ref().expect("刚放进去");
    Ok(scan(conn)?.unwrap_or_default())
}

/// 这个索引的主连接要关了（仓库窗口关掉、换了仓库、退出）：先关掉连着同一个文件的只读连接。
/// SQLite 只在最后一个连接关掉时把 WAL 合回主文件，只读连接自己又合不了 —— 以前它是个不关的 static，
/// 搜过正文以后关窗口、退出，WAL 就一直留着，下次打开先读一遍它（REVIEWS/2026-11-15-桌面端验证.md §4.8）
pub fn release_reader(main: &Connection) {
    let Some(file) = main.path().filter(|file| !file.is_empty()) else { return };
    let Ok(mut slot) = READER.lock() else { return };
    if slot.as_ref().is_some_and(|(_, reader)| reader.path() == Some(file)) {
        *slot = None;
    }
}

/// 仓库的摆法（layout::Layout::fingerprint）和建这份索引时不一样了（开关了日程、换了日记文件夹）：
/// 清空，下次扫描每个文件按新的摆法重新认。`assumed` = 还没记过时当它是哪一种（P11.2 以前的索引
/// 都是按 Odea 的老规矩建的，那样的仓库不用重读）。清空了返回 true
pub fn sync_layout(conn: &Connection, fingerprint: &str, assumed: &str) -> Result<bool> {
    let stored: Option<String> =
        conn.query_row("SELECT value FROM meta WHERE key = 'layout'", [], |r| r.get(0)).optional()?;
    let stale = stored.as_deref().unwrap_or(assumed) != fingerprint;
    if stale {
        keep_note_ids(conn)?;
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

/* ---------------- 清空索引时留住笔记的 id（技术方案 §5.3.1） ----------------
属性块里没写 id 的笔记（Obsidian 搬来的、别的工具建的），id 只在 doc 表里。清空 doc 之前（版本不对、摆法变了）
把笔记的 (路径, id) 抄进 kept_ids，重新认到这个路径时还给它（Vault::note_id_for），用掉的那一行删掉；
整个仓库重新认完一遍还剩的（文件不在了）清掉。只有删了索引文件才换 id。 */

/// 把 doc 里笔记的 (路径, id) 抄进 kept_ids。旧的不清：连着清两次（升了版本、紧接着摆法又变），
/// 第二次时 doc 是空的或者只认回来一部分，第一次抄的得留着；同一个路径 doc 里的是新认的，盖掉旧的。
/// 很老的索引 doc 表可能没有这几列（版本 4 以前没有 kind），没有就不抄
fn keep_note_ids(conn: &Connection) -> Result<()> {
    let columns = conn
        .prepare("SELECT name FROM pragma_table_info('doc')")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !["id", "kind", "rel_path"].iter().all(|wanted| columns.iter().any(|name| name == wanted)) {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO kept_ids (rel_path, id) SELECT rel_path, id FROM doc WHERE kind = 'note'
         ON CONFLICT(rel_path) DO UPDATE SET id = excluded.id",
        [],
    )?;
    Ok(())
}

/// 清空索引前这个路径上那篇笔记的 id（没有是 None）。重建时每个没写 id 的笔记查一次：缓存住语句
pub fn kept_id(conn: &Connection, rel: &str) -> Result<Option<String>> {
    Ok(conn
        .prepare_cached("SELECT id FROM kept_ids WHERE rel_path = ?1")?
        .query_row(params![rel], |r| r.get(0))
        .optional()?)
}

/// 留着的 id 里，索引里没有这个路径的文档的那几个路径。索引里有的（插件的文档：开着日程时日记留着的那几行，
/// 关掉日程时还给它们）刚认过、文件就在，不用再去磁盘上看 —— 日记有几百篇，每次打开都 stat 一遍要十几毫秒
pub fn unindexed_kept_paths(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT rel_path FROM kept_ids WHERE NOT EXISTS (SELECT 1 FROM doc WHERE doc.rel_path = kept_ids.rel_path)",
    )?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 这几个路径留着的 id 不要了（文件不在了）
pub fn drop_kept(conn: &Connection, rels: &[String]) -> Result<()> {
    if rels.is_empty() {
        return Ok(());
    }
    let tx = Atomic::begin(conn)?;
    for rel in rels {
        conn.execute("DELETE FROM kept_ids WHERE rel_path = ?1", params![rel])?;
    }
    tx.commit()
}

/* ---------------- 一批一个事务 ----------------
读文件进索引（后台那批、整扫）一篇一个事务的话，每篇都要提交一次：同一批里每篇都把 B 树上同几页再写一遍 WAL，
写库占了读一篇的一半多（REVIEWS/2026-11-15-桌面端验证.md §4.4）。所以那几条路一批开一个事务（begin_batch / end_batch），
每篇的写（put / remove）是里面的一个保存点：一篇写坏了只退这一篇，别的照常；没人开着事务时它自己就是一个事务 */

/// 一组要么全写进去、要么一点不留的写：外面开着事务时是其中的一个保存点，没开着时自己就是一个事务。
/// 没 commit 就丢掉（中途 `?` 出去了）的退回到开头
struct Atomic<'c> {
    conn: &'c Connection,
    open: bool,
}

impl<'c> Atomic<'c> {
    fn begin(conn: &'c Connection) -> Result<Self> {
        conn.execute_batch("SAVEPOINT doc_write")?;
        Ok(Self { conn, open: true })
    }

    fn commit(mut self) -> Result<()> {
        // 最外层的 RELEASE 就是提交：失败了照样退回去（drop 里），不把事务留着开着
        self.conn.execute_batch("RELEASE doc_write")?;
        self.open = false;
        Ok(())
    }
}

impl Drop for Atomic<'_> {
    fn drop(&mut self) {
        if self.open {
            let _ = self.conn.execute_batch("ROLLBACK TO doc_write; RELEASE doc_write");
        }
    }
}

/// 开始一批（后台读进索引的一批、一次整扫）：之后的 put / remove 都是这个事务里的保存点，end_batch 时一起提交。
/// 已经在事务里（不该有）就不另开，返回 false，end_batch 也不提交
pub fn begin_batch(conn: &Connection) -> Result<bool> {
    if !conn.is_autocommit() {
        return Ok(false);
    }
    conn.execute_batch("BEGIN")?;
    Ok(true)
}

/// 提交 begin_batch 开的那一批（started 是它的返回值）。提交失败就整批退回：这一批的文件索引里还是旧的、或者没有，
/// 下次扫描按修改时间和大小还会再读（和一篇读不了时一样）
pub fn end_batch(conn: &Connection, started: bool) -> Result<()> {
    if !started || conn.is_autocommit() {
        return Ok(());
    }
    if let Err(error) = conn.execute_batch("COMMIT") {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(error.into());
    }
    Ok(())
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
        tags: r.get::<_, String>("tags")?.split('\n').filter(|tag| !tag.is_empty()).map(str::to_string).collect(),
        props: r.get("props")?,
    })
}

/// 按条件取一篇（插件拿它查自己的文档，plugins/journal）
pub fn one(conn: &Connection, filter: &str, args: impl rusqlite::Params) -> Result<Option<DocRow>> {
    Ok(conn.query_row(&format!("SELECT {COLUMNS} FROM doc WHERE {filter}"), args, row).optional()?)
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
/// 整张表顺着扫一遍，大小写不敏感照 Rust 的 to_lowercase 算 —— SQLite 的 lower() 只管 ASCII，
/// 和前端以前的 toLowerCase().indexOf 不一样（多数时候不用真的转，见 Needle）。
/// 正文借着读、不拷，命中了才建 DocRow（不带正文）：以前每篇都建一份带全文的 DocRow、整篇转一份小写，
/// 3000 篇 13 MB 一次 100 ms，真正找只要 1 ms（REVIEWS/2026-11-15-桌面端验证.md §4.3）。
/// cancelled() 返回 true 就不扫了，返回 None
pub fn scan_text(
    conn: &Connection,
    needle: &str,
    archived_only: bool,
    cancelled: impl Fn() -> bool,
) -> Result<Option<Vec<TextMatch>>> {
    let needle = Needle::new(needle);
    let columns = COLUMNS.replace("content_md", "'' AS content_md");
    let mut stmt =
        conn.prepare(&format!("SELECT {columns}, content_md AS body FROM doc WHERE {}", text_filter(archived_only)))?;
    let body_at = stmt.column_index("body")?;
    let mut rows = stmt.query([])?;
    let mut found = Vec::new();
    while let Some(r) = rows.next()? {
        if cancelled() {
            return Ok(None);
        }
        let body = r.get_ref(body_at)?.as_str().map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(body_at, rusqlite::types::Type::Text, Box::new(error))
        })?;
        if let Some(line) = needle.line_in(body) {
            found.push(TextMatch { doc: row(r)?, line });
        }
    }
    Ok(Some(found))
}

/// 搜正文要看哪些文档：笔记（含归档；archived_only 只要归档里的）和写过东西的插件文档
fn text_filter(archived_only: bool) -> &'static str {
    if archived_only {
        "kind = 'note' AND is_archived = 1"
    } else {
        "kind = 'note' OR title != '' OR content_md != ''"
    }
}

/// 搜正文要找的字（已经 to_lowercase）。找到的和「整篇 to_lowercase 再 find」一样，但多数时候不用转：
/// 只有 ASCII 和没有大小写的字（中文、数字、标点、表情……）时，直接在原文里按字节找，ASCII 字母不分大小写 ——
/// 原文里别的有大小写的字（É、Ω）转了小写也不是 ASCII、也不是没有大小写的字，碰不上要找的。
/// 例外是转小写以后成了 ASCII 的那两个：İ（→ i + U+0307）、开尔文符号 K（→ k），要找的里有 i 或 k、
/// 这一篇里又有它们时照老办法整篇转。要找的里有别的有大小写的字（é、ω）也照老办法
struct Needle<'a> {
    text: &'a str,
    /// 在原文里找就行（只有 ASCII 和没有大小写的字）
    direct: bool,
    /// 有 ASCII 字母，要不分大小写地比；没有就是普通的 str::find
    letters: bool,
    /// 有 i 或 k：原文里有 İ、K 时照老办法
    i_or_k: bool,
}

impl<'a> Needle<'a> {
    fn new(text: &'a str) -> Self {
        let caseless = |c: char| !c.is_lowercase() && !c.is_uppercase() && c != '\u{307}';
        Self {
            text,
            direct: text.chars().all(|c| c.is_ascii() || caseless(c)),
            letters: text.bytes().any(|b| b.is_ascii_alphabetic()),
            i_or_k: text.contains(['i', 'k']),
        }
    }

    /// 第一次出现的那一行（原样）；没有是 None
    fn line_in(&self, content: &str) -> Option<String> {
        // 一个字一个字地找（memchr），比 contains([..]) 逐字解码快得多
        if !self.direct || (self.i_or_k && (content.contains('\u{130}') || content.contains('\u{212A}'))) {
            return line_with(content, self.text);
        }
        let at = if self.letters { find_ignore_ascii_case(content, self.text)? } else { content.find(self.text)? };
        line_around(content, &content[..at])
    }
}

/// needle（ASCII 字母都是小写）在 hay 里第一次出现的字节位置：ASCII 字母不分大小写，别的一样才算。
/// 先用 str::find（memchr、Two-Way）找一处肯定一字不差的，再整个比：needle 里最长的一段不带字母的（三个字节以上，
/// 一个汉字就够）；没有就找第一个字（是字母的话大写、小写各找各的）。在中文里比一个字节一个字节地比快得多。
/// 找到的总在字的边界上：needle 的第一个字节不是 UTF-8 的后续字节，对上了 hay 的那一个也不是
fn find_ignore_ascii_case(hay: &str, needle: &str) -> Option<usize> {
    let fits = |start: usize| {
        hay.as_bytes()
            .get(start..start + needle.len())
            .is_some_and(|bytes| bytes.eq_ignore_ascii_case(needle.as_bytes()))
    };
    // ASCII 字母都是一个字节：按字母切开，切口都在字的边界上，每一段后面跟着一个字母
    let (offset, run) = needle
        .split(|c: char| c.is_ascii_alphabetic())
        .scan(0, |at, part| {
            let start = *at;
            *at += part.len() + 1;
            Some((start, part))
        })
        .max_by_key(|(_, part)| part.len())?;
    if run.len() >= 3 {
        // 一处一处往后挪一个字（可能和上一处叠着：「１１１x」在「１１１１x」里）
        let step = run.chars().next().map_or(1, char::len_utf8);
        let mut from = 0;
        while let Some(found) = hay[from..].find(run) {
            let at = from + found;
            if at >= offset && fits(at - offset) {
                return Some(at - offset);
            }
            from = at + step;
        }
        return None;
    }
    let first = needle.chars().next()?;
    let upper = first.to_ascii_uppercase();
    let next = |from: usize, c: char| hay[from..].find(c).map(|i| from + i);
    let mut lower_at = next(0, first);
    let mut upper_at = if upper == first { None } else { next(0, upper) };
    loop {
        let at = match (lower_at, upper_at) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) | (None, Some(a)) => a,
            (None, None) => return None,
        };
        if fits(at) {
            return Some(at);
        }
        let from = at + first.len_utf8();
        if lower_at == Some(at) {
            lower_at = next(from, first);
        }
        if upper_at == Some(at) {
            upper_at = next(from, upper);
        }
    }
}

/// 搜正文要看的每一篇（连同正文）：笔记（含归档；archived_only 只要归档里的）和写过东西的插件文档。
/// visit 返回 false 就不往下看了（又来了新的搜索），这时返回 false
pub fn each_text_doc(conn: &Connection, archived_only: bool, mut visit: impl FnMut(DocRow) -> bool) -> Result<bool> {
    let filter = text_filter(archived_only);
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM doc WHERE {filter}"))?;
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        if !visit(row(r)?) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// 第一次出现 needle 的那一行（原样，不转小写）：整篇转一份小写再找（Needle 说不准的时候用）
fn line_with(content: &str, needle: &str) -> Option<String> {
    let lower = content.to_lowercase();
    let at = lower.find(needle)?;
    // 转小写不增减换行，第几行在两边是一样的
    line_around(content, &lower[..at])
}

/// 命中处所在的那一行（原样）。before 是命中处之前的全文（原文，或者转了小写的那一份：换行一样多）。
/// 超过 600 个字的行只留命中处前 200、后 400 个字
fn line_around(content: &str, before: &str) -> Option<String> {
    const LONG: usize = 600;
    let number = before.matches('\n').count();
    let line = content.split('\n').nth(number)?.trim_end_matches('\r');
    if line.len() <= LONG || line.chars().count() <= LONG {
        return Some(line.to_string());
    }
    // 命中处在这一行的第几个字（按小写数的：大小写换算后字数不变的绝大多数情况下是准的；不准也还在窗口里）
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    let column = before[line_start..].chars().count();
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
    Ok(conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0)).optional()?)
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
    let n: i64 =
        conn.query_row("SELECT count(*) FROM doc WHERE id = ?1 AND rel_path != ?2", params![id, except_path], |r| {
            r.get(0)
        })?;
    Ok(n > 0)
}

/// 写入（或替换）一篇文档，连同开着的插件在索引里另存的那几份（parts）。同一个 id 或同一个路径的旧行先删掉。
/// 返回那几份里变了的是哪几个插件的。全做或全不做（Atomic：外面开着一批时是其中的一个保存点）
pub fn put(conn: &Connection, doc: &DocRow, parts: &[&'static dyn IndexPart]) -> Result<Vec<&'static str>> {
    let tx = Atomic::begin(conn)?;
    let old = conn
        .prepare("SELECT id FROM doc WHERE id = ?1 OR rel_path = ?2")?
        .query_map(params![doc.id, doc.rel_path], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut changed = Vec::new();
    for part in parts {
        if part.put(conn, doc, &old)? {
            changed.push(part.plugin());
        }
    }
    for id in &old {
        conn.execute("DELETE FROM doc WHERE id = ?1", params![id])?;
    }
    conn.execute(
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
    // 这个路径上的笔记认回来了（用的是留着的 id，或者属性块里有、留着的被别的文件占了）：留着的那一行没用了。
    // 插件的文档不删：关掉插件它又是笔记，那时还要还给它
    if doc.kind == NOTE {
        conn.prepare_cached("DELETE FROM kept_ids WHERE rel_path = ?1")?.execute(params![doc.rel_path])?;
    }
    tx.commit()?;
    Ok(changed)
}

/// 只更新文件状态（内容没变，比如 mtime 被别的程序碰了一下）
pub fn touch(conn: &Connection, id: &str, mtime: i64, size: i64) -> Result<()> {
    conn.execute("UPDATE doc SET mtime = ?1, size = ?2, updated_at = ?1 WHERE id = ?3", params![mtime, size, id])?;
    Ok(())
}

/// 文件改名 / 挪位置之后，先让索引跟上，再写新内容 —— 否则按新路径写入时
/// 旧路径那一行还占着同一个 id，新文件会被当成一篇重复的笔记。
/// 指纹清掉：标题可能来自文件名、归档与否来自位置，内容一样也得重新解析。
pub fn rename(conn: &Connection, id: &str, rel: &str) -> Result<()> {
    conn.execute("UPDATE doc SET rel_path = ?1, hash = '' WHERE id = ?2", params![rel, id])?;
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

/// 去掉一篇，连同 parts 里它的那几份。返回那几份里变了的是哪几个插件的。全做或全不做（同 put）
pub fn remove(conn: &Connection, id: &str, parts: &[&'static dyn IndexPart]) -> Result<Vec<&'static str>> {
    let tx = Atomic::begin(conn)?;
    let mut changed = Vec::new();
    for part in parts {
        if part.remove(conn, id)? {
            changed.push(part.plugin());
        }
    }
    conn.execute("DELETE FROM doc WHERE id = ?1", params![id])?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn kept(conn: &Connection) -> Vec<(String, String)> {
        let mut stmt = conn.prepare("SELECT rel_path, id FROM kept_ids ORDER BY rel_path").unwrap();
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        rows.map(|row| row.unwrap()).collect()
    }

    #[test]
    fn an_old_index_hands_over_its_note_ids_before_it_is_dropped() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE doc (id TEXT PRIMARY KEY, kind TEXT, rel_path TEXT, title TEXT);
             INSERT INTO doc VALUES ('n1', 'note', '甲.md', '甲'), ('day:2026-11-14', 'journal.day', '日记/2026-11-14.md', '');
             PRAGMA user_version = 6;",
        )
        .unwrap();
        prepare(&conn).unwrap();
        assert_eq!(kept(&conn), [("甲.md".to_string(), "n1".to_string())], "插件的文档不抄");
        assert_eq!(conn.query_row("SELECT count(*) FROM doc", [], |r| r.get::<_, i64>(0)).unwrap(), 0);

        // 接着摆法变了：doc 是空的，第一次抄的还在
        assert!(sync_layout(&conn, "别的摆法", "原来的摆法").unwrap());
        assert_eq!(kept(&conn).len(), 1);
    }

    #[test]
    fn a_very_old_index_without_those_columns_is_just_dropped() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE doc (id TEXT PRIMARY KEY, rel_path TEXT, day TEXT);
             INSERT INTO doc VALUES ('n1', '甲.md', NULL);
             PRAGMA user_version = 3;",
        )
        .unwrap();
        prepare(&conn).unwrap();
        assert!(kept(&conn).is_empty());
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    }

    /// 搜正文不再每篇整篇转小写（Needle）：找到哪一篇、给出哪一行，都和「整篇 to_lowercase 再 find」一样
    #[test]
    fn searching_without_lowercasing_finds_the_same_lines() {
        let long_line = format!("{}Rust 在这里{}", "前".repeat(700), "后".repeat(700));
        let contents = [
            "第一行\n今天的进度还可以，Hello World\r\n末行".to_string(),
            "RUST 和 rust、Rust\n第二行 rUsT".to_string(),
            "全角的 ＲＵＳＴ 不是 rust 的大写\nÉcole 和 école、ΣΑΣ 和 σας".to_string(),
            "开尔文 \u{212A}elvin 写成 kelvin\nİstanbul 和 istanbul".to_string(),
            "只有开尔文 \u{212A}ELVIN\n只有 İSTANBUL".to_string(),
            "表情 😀 和 a😀b、数字 123，标点：「引号」".to_string(),
            "中英混排 Odea笔记 ODEA笔记\n\n空行之后 odea 笔记".to_string(),
            long_line,
            String::new(),
        ];
        let needles = [
            "rust",
            "hello world",
            "进度",
            "末行",
            "ｒｕｓｔ",
            "école",
            "σας",
            "σ",
            "kelvin",
            "k",
            "istanbul",
            "i",
            "i\u{307}",
            "😀",
            "a😀b",
            "123，",
            "「引号」",
            "odea笔记",
            "odea 笔",
            "\n",
            "在这里",
            "rust 在这里",
            "没有",
        ];
        for content in &contents {
            for needle in needles {
                assert_eq!(
                    Needle::new(needle).line_in(content),
                    line_with(content, needle),
                    "在 {content:?} 里找 {needle:?}"
                );
            }
        }
        // 开尔文符号、İ 转小写以后是 ASCII：照老办法也找得到
        assert!(Needle::new("kelvin").line_in("只有开尔文 \u{212A}ELVIN").is_some());
        assert!(Needle::new("istanbul").line_in("İSTANBUL").is_none(), "İ 转小写是 i + U+0307，不是 i");
        assert_eq!(Needle::new("rust").line_in("前\r\nRuSt 后\n末").as_deref(), Some("RuSt 后"));
    }

    #[test]
    fn ascii_case_is_ignored_byte_by_byte() {
        assert_eq!(find_ignore_ascii_case("abcABC", "bc"), Some(1));
        assert_eq!(find_ignore_ascii_case("xxABC", "abc"), Some(2));
        assert_eq!(find_ignore_ascii_case("ab", "abc"), None);
        assert_eq!(find_ignore_ascii_case("aab", "ab"), Some(1), "第一个字母对上、后面没对上就往后挪一个");
        assert_eq!(find_ignore_ascii_case("aAb", "ab"), Some(1), "大写、小写两种都找，取靠前的");
        assert_eq!(find_ignore_ascii_case("中a文", "a文"), Some(3));
        assert_eq!(find_ignore_ascii_case("", "a"), None);
        // 先找不带字母的那一段，再整个比
        assert_eq!(find_ignore_ascii_case("没有这个词Z 没有这个词ZQ", "没有这个词zq"), Some(17));
        assert_eq!(find_ignore_ascii_case("x没有这个词zq", "x没有这个词zq"), Some(0));
        assert_eq!(find_ignore_ascii_case("没有这个词zq", "x没有这个词zq"), None, "那一段前面不够");
        assert_eq!(find_ignore_ascii_case("１１１１X", "１１１x"), Some(3), "那一段叠着出现");
        assert_eq!(find_ignore_ascii_case("1 2 #Tag", "#tag"), Some(4), "第一个字不是字母");
    }

    fn note(id: &str, rel: &str) -> DocRow {
        DocRow {
            id: id.into(),
            kind: NOTE.into(),
            rel_path: rel.into(),
            key: None,
            title: id.into(),
            content_md: String::new(),
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
            not_utf8: false,
            tags: Vec::new(),
            props: String::new(),
        }
    }

    fn doc_ids(conn: &Connection) -> Vec<String> {
        let mut stmt = conn.prepare("SELECT id FROM doc ORDER BY id").unwrap();
        let rows = stmt.query_map([], |r| r.get(0)).unwrap();
        rows.map(|row| row.unwrap()).collect()
    }

    /// 一批一个事务（读文件进索引的那几条路）：每篇的写是里面的一个保存点，一篇写坏了只退它自己；
    /// 提交了才看得见；没开批的时候每篇自己提交（保存、改名这些单篇的写照旧）
    #[test]
    fn a_batch_commits_once_and_a_failed_write_only_undoes_itself() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("index.db");
        let conn = open(&path).unwrap();
        let other = Connection::open(&path).unwrap();
        let seen = |c: &Connection| c.query_row("SELECT count(*) FROM doc", [], |r| r.get::<_, i64>(0)).unwrap();

        let started = begin_batch(&conn).unwrap();
        assert!(started);
        put(&conn, &note("a", "甲.md"), &[]).unwrap();
        // 一篇写到一半出错（这里是 doc_key 唯一索引冲突：同一种插件文档、同一个 key 的两篇）
        let mut day = note("day:1", "日记/1.md");
        day.kind = "journal.day".into();
        day.key = Some("1".into());
        put(&conn, &day, &[]).unwrap();
        let mut clash = note("day:1-copy", "日记/1 副本.md");
        clash.kind = "journal.day".into();
        clash.key = Some("1".into());
        assert!(put(&conn, &clash, &[]).is_err());
        assert!(!conn.is_autocommit(), "一篇失败不把整批的事务退掉");
        put(&conn, &note("b", "乙.md"), &[]).unwrap();
        remove(&conn, "a", &[]).unwrap();
        assert_eq!(seen(&other), 0, "还没提交，别的连接看不见");
        end_batch(&conn, started).unwrap();
        assert!(conn.is_autocommit());
        assert_eq!(doc_ids(&other), ["b", "day:1"], "失败的那篇没留下半截，别的都在");

        // 没开批：每篇自己提交
        put(&conn, &note("c", "丙.md"), &[]).unwrap();
        assert_eq!(seen(&other), 3);
        assert!(put(&conn, &clash, &[]).is_err());
        assert!(conn.is_autocommit(), "失败了也不留着开着的事务");
        // 已经在事务里时不另开、也不替别人提交
        conn.execute_batch("BEGIN").unwrap();
        assert!(!begin_batch(&conn).unwrap());
        end_batch(&conn, false).unwrap();
        assert!(!conn.is_autocommit());
        conn.execute_batch("ROLLBACK").unwrap();
    }
}
