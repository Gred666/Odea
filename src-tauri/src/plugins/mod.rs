/* ============================================================
内置插件（L2，docs/插件与跨端.md §5.1、§6）：跟着应用一起编译的功能，走和以后的第三方插件
同一套贡献点。这里是 Rust 的那一半（文档类型、索引里另存的东西、命令）；导航、命令面板、
文档槽位在前端 src/plugins/。

核心只认一种文档：笔记，也就是仓库里的一个 Markdown 文件。别的文档类型由插件声明（DocType）：
一套路径规则，把仓库里的路径和 key 对上（日程的某一天：`日记/2026/2026-11-03.md` ↔ `2026-11-03`），
标题、索引里的 id、行为日志里记成什么也由它定。插件还能在索引里另存一份自己的东西（IndexPart：
日程的带日期的任务），和文档在同一个事务里写、删。

开没开记在仓库标记 .odea/vault.json 的 plugins 里（老版本只认 features，两边都写，见 vault/layout.rs）。
关着的插件不声明文档类型：它的文件夹就是普通文件夹，文件都当笔记；再打开，原样回来。
============================================================ */

pub mod journal;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::Connection;
use serde_json::Value;

use crate::domain::model::DocRef;
use crate::error::Result;
use crate::vault::index::DocRow;

/// 插件声明的一种文档（贡献点 documentTypes，§5.3、§6.1）。每个仓库按它的标记各建一份（文件夹可以不一样）
pub trait DocType: Send + Sync {
    /// 类型 id，带命名空间：`journal.day`。也是索引里的 kind、DocRef 的 type
    fn id(&self) -> &'static str;
    /// 这个文件（仓库里的相对路径）是这一种的话，它的 key
    fn key_of(&self, rel: &str) -> Option<String>;
    /// 这一篇放在哪（还没写过的也有位置）。key 不对报错
    fn path_of(&self, key: &str) -> Result<String>;
    /// 索引里的 id：`day:2026-11-03`。冲突副本的 conflictOf、前端记住看到哪的键都是它，不能改
    fn index_id(&self, key: &str) -> String;
    /// 索引里的标题：属性块里写的（written），或者按 key 算的
    fn title(&self, key: &str, written: Option<&str>) -> String;
    /// 给人看的标题（搜索结果、反向链接、任务的出处）：「10月6日 · 周报」「第 41 周目标」
    fn display_title(&self, key: &str, title: &str) -> String;
    /// 行为日志（.odea/activity，跟着仓库同步）里的 entity：老版本记的是什么，这里就是什么
    fn log_entity(&self) -> &'static str;
    /// 存这一篇时行为日志里记的 id（同上，照老版本）
    fn log_id(&self, key: &str) -> String;
    /// 放这种文档的文件夹：不在文件树上（空串 = 仓库根，那就不藏）
    fn dir(&self) -> &str;
    /// 路径规则的指纹：变了，索引里每篇是什么就得重新认
    fn fingerprint(&self) -> String;
}

/// 插件在索引里另存的一份（日程：带日期的任务）。和文档在同一个事务里写、删
pub trait IndexPart: Send + Sync {
    /// 哪个插件的：这一份变了，VaultChange.plugins 里报它
    fn plugin(&self) -> &'static str;
    /// 建表的 SQL（索引升版本、整个重建时执行）
    fn schema(&self) -> &'static str;
    /// 自己的表：重建前删掉，摆法变了清空
    fn tables(&self) -> &'static [&'static str];
    /// 一篇写进索引了。`replaced`：被它顶掉的旧行的 id（一般就是它自己上一次的那一行）。返回这一份变了没有
    fn put(&self, conn: &Connection, doc: &DocRow, replaced: &[String]) -> Result<bool>;
    /// 一篇从索引里去掉了。返回这一份变了没有
    fn remove(&self, conn: &Connection, id: &str) -> Result<bool>;
}

/// 一个内置插件
pub trait Plugin: Send + Sync {
    /// `odea.journal`：仓库标记 plugins 里的键
    fn id(&self) -> &'static str;
    /// 老版本（0.7.0 及以前）在仓库标记 features 里用的键（`journal`）。读写都照顾到它（vault/layout.rs），
    /// 开关它时行为日志里也记这个名字
    fn legacy_feature(&self) -> Option<&'static str> {
        None
    }
    /// 没写 features 的老标记（P11.2 以前建的、老用户的仓库，照 Odea 的摆法）里算不算开着
    fn on_in_legacy_vaults(&self) -> bool {
        false
    }
    /// 开着它时文件树的根是标记里的 folders.notes（Odea 自己建的仓库是「笔记」）；
    /// 这样的插件一个都没开，树根就是整个仓库：它们的文件夹这时都只是普通文件夹
    fn roots_tree_at_notes(&self) -> bool {
        false
    }
    /// 新建仓库时标记的 folders 里写哪几项（`("days", "日记")` ……）
    fn new_folders(&self) -> &'static [(&'static str, &'static str)] {
        &[]
    }
    /// 开着时，这个仓库里它的文档类型（路径规则按标记里写的文件夹）。root 是仓库（看别的工具的设置用），
    /// marker 是仓库标记；都是 None 是 Odea 自己的摆法
    fn doc_types(&self, root: Option<&Path>, marker: Option<&Value>) -> Vec<Arc<dyn DocType>>;
    /// 属性块里写着这样的 id 也不分给笔记：它是这个插件的文档在索引里的 id（插件关着也一样）
    fn reserves_id(&self, _id: &str) -> bool {
        false
    }
    /// 在索引里另存的那一份
    fn index_part(&self) -> Option<&'static dyn IndexPart> {
        None
    }
    /// 老格式的文档引用（0.7.0 及以前的 DocTarget，访客留底里存着）认成 DocRef
    fn legacy_ref(&self, _value: &Value) -> Option<DocRef> {
        None
    }
    /// 反过来：自己的一篇照老格式写成什么样。访客留底照它写，降级回老版本还读得出；
    /// 没有老格式的（以后插件的类型）返回 None，照新格式 `{ type, key }` 写
    fn legacy_value(&self, _doc: &DocRef) -> Option<Value> {
        None
    }
    /// 从旧版的 SQLite 库（ontheway.db，vault/legacy.rs）搬自己的那部分，写出来的文件记进 written。
    /// 返回搬了什么、各几条（给搬家报告）
    fn import_legacy(
        &self,
        _conn: &Connection,
        _root: &Path,
        _written: &mut Vec<PathBuf>,
    ) -> Result<Vec<(&'static str, usize)>> {
        Ok(Vec::new())
    }
}

/// 内置的插件
pub fn builtin() -> [&'static dyn Plugin; 1] {
    [&journal::JOURNAL as &'static dyn Plugin]
}

pub fn find(id: &str) -> Option<&'static dyn Plugin> {
    builtin().into_iter().find(|plugin| plugin.id() == id)
}

/// 这个 id 是不是哪个插件的文档在索引里用的（笔记不能用）
pub fn reserved_id(id: &str) -> bool {
    builtin().iter().any(|plugin| plugin.reserves_id(id))
}

/// 所有内置插件在索引里的那一份（建表、清空用）
pub fn index_parts() -> Vec<&'static dyn IndexPart> {
    builtin().iter().filter_map(|plugin| plugin.index_part()).collect()
}

/// 老格式的文档引用（访客留底里存着的）交给认得它的插件
pub fn legacy_ref(value: &Value) -> Option<DocRef> {
    builtin().iter().find_map(|plugin| plugin.legacy_ref(value))
}

/// 插件的一篇照老格式写成什么样（笔记的在 DocRef::legacy_value 里）；没有老格式是 None
pub fn legacy_value(doc: &DocRef) -> Option<Value> {
    builtin().iter().find_map(|plugin| plugin.legacy_value(doc))
}
