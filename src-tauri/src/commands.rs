use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
use tauri_specta::Event;

use crate::boot;
use crate::collab::record::{self as collab_record, GuestRecord, Role};
use crate::collab::{
    self, AttachReply, Callback, Decision, Guest, GuestOptions, Host, HostOptions, Invite, MemberInfo, Permission,
    Reach, Relay, RelayCheck, SyncKind, TrustedPeer,
};
use crate::domain::model::*;
use crate::domain::validate_date;
use crate::error::{AppError, Result};
use crate::share;
use crate::state::{AppState, Caller, Workspace, Ws};
use crate::sync::account::{self, PendingLogin};
use crate::sync::engine::{Hooks, SyncHub, LOGIN_KEY, PROVIDER_KEY};
use crate::sync::provider::{Http, Provider, RemoteRepo};
use crate::sync::proxy;
use crate::sync::repo::{Net, SyncError, SyncRepo, SyncResult};
use crate::sync::setup;
use crate::vault::{fsio, layout, watch, Announce, Backlog, Vault};

/* ============================================================
命令层：只做参数校验和调用，读写全在 vault/。

每个命令都在阻塞线程池里拿仓库的锁执行 —— 文件读写和 SQLite 都是同步的，
直接在 tokio 的 worker 上跑会拖住整个运行时。
============================================================ */

/// 仓库里别处发生的变化（外部程序改了文件、勾任务改了别的文档），前端据此刷新
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct VaultChanged(pub VaultChange);

/// 只发给这个仓库的窗口：别的窗口收到会去刷新根本不在它那里的笔记
pub fn announcer<R: Runtime>(app: AppHandle<R>, label: String) -> Announce {
    Arc::new(move |change| {
        if let Err(error) = VaultChanged(change).emit_to(&app, label.as_str()) {
            eprintln!("通知前端失败: {error}");
        }
    })
}

async fn blocking<T, F>(f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(format!("任务panic: {e}")))?
}

async fn with_vault<T, F>(ws: &Workspace, f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&mut Vault) -> Result<T> + Send + 'static,
{
    let vault = ws.vault.clone();
    blocking(move || {
        let mut vault = vault
            .lock()
            .map_err(|_| AppError::Internal("仓库锁坏了".into()))?;
        f(&mut vault)
    })
    .await
}

/* ---------------- 笔记 ---------------- */

/// 一个列表（笔记 / 归档）的全部笔记，不带正文：打开哪篇再 note_get 哪篇
#[tauri::command]
#[specta::specta]
pub async fn note_list(ws: Ws, archived: bool) -> Result<Vec<NoteSummary>> {
    with_vault(&ws, move |v| v.note_list(archived)).await
}

#[tauri::command]
#[specta::specta]
pub async fn note_get(ws: Ws, id: String) -> Result<Note> {
    with_vault(&ws, move |v| v.note_get(&id)).await
}

/// id 为 null 是新建（返回新 id）；否则改标题和正文，标题变了文件跟着改名
#[tauri::command]
#[specta::specta]
pub async fn note_upsert(ws: Ws, input: NoteInput) -> Result<String> {
    if input.title.trim().is_empty() && input.content_md.trim().is_empty() {
        return Err(AppError::Invalid("标题和正文不能同时为空".into()));
    }
    with_vault(&ws, move |v| match input.id {
        Some(id) => v.note_update(&id, &input.title, &input.content_md).map(|()| id),
        None => v.note_create(&input.title, &input.content_md),
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn note_set_pinned(ws: Ws, id: String, pinned: bool) -> Result<()> {
    with_vault(&ws, move |v| v.note_set_pinned(&id, pinned)).await
}

#[tauri::command]
#[specta::specta]
pub async fn note_archive(
    ws: Ws,
    id: String,
    category: Option<String>,
) -> Result<()> {
    with_vault(&ws, move |v| v.note_archive(&id, category)).await
}

#[tauri::command]
#[specta::specta]
pub async fn note_restore(ws: Ws, id: String) -> Result<()> {
    with_vault(&ws, move |v| v.note_restore(&id)).await
}

/// 删除 = 挪进仓库的回收站（.odea/trash/，30 天后清掉）
#[tauri::command]
#[specta::specta]
pub async fn note_delete(ws: Ws, id: String) -> Result<()> {
    with_vault(&ws, move |v| v.note_delete(&id)).await
}

// 删除后的「撤销」
#[tauri::command]
#[specta::specta]
pub async fn note_undelete(ws: Ws, id: String) -> Result<()> {
    with_vault(&ws, move |v| v.note_undelete(&id)).await
}

/// 在某个文件夹里新建一篇空笔记（folder 相对「笔记」，空串是「笔记」本身），返回新 id
#[tauri::command]
#[specta::specta]
pub async fn note_create(ws: Ws, folder: String, title: String) -> Result<String> {
    with_vault(&ws, move |v| v.note_create_in(&folder, &title, "")).await
}

/// 挪到另一个文件夹，返回挪完的笔记（relPath 变了，正文里的相对链接可能也改了）
#[tauri::command]
#[specta::specta]
pub async fn note_move(ws: Ws, id: String, folder: String) -> Result<Note> {
    with_vault(&ws, move |v| v.note_move(&id, &folder)).await
}

/* ---------------- 文件夹（「笔记」下面的子目录） ---------------- */

#[tauri::command]
#[specta::specta]
pub async fn folder_list(ws: Ws) -> Result<Vec<String>> {
    with_vault(&ws, |v| Ok(v.folders())).await
}

/// 返回新文件夹的路径（重名时加了序号）
#[tauri::command]
#[specta::specta]
pub async fn folder_create(ws: Ws, parent: String, name: String) -> Result<String> {
    with_vault(&ws, move |v| v.folder_create(&parent, &name)).await
}

/// 返回改名后的路径（重名时加了序号）
#[tauri::command]
#[specta::specta]
pub async fn folder_rename(ws: Ws, folder: String, name: String) -> Result<String> {
    with_vault(&ws, move |v| v.folder_rename(&folder, &name)).await
}

/// 里面的笔记进回收站；返回值原样交给 folder_undelete 就能撤销
#[tauri::command]
#[specta::specta]
pub async fn folder_delete(ws: Ws, folder: String) -> Result<FolderDeletion> {
    with_vault(&ws, move |v| v.folder_delete(&folder)).await
}

#[tauri::command]
#[specta::specta]
pub async fn folder_undelete(ws: Ws, deletion: FolderDeletion) -> Result<()> {
    with_vault(&ws, move |v| v.folder_undelete(&deletion)).await
}

/// 在系统的文件管理器里打开这个文件夹
#[tauri::command]
#[specta::specta]
pub async fn folder_reveal(ws: Ws, folder: String) -> Result<()> {
    let path = with_vault(&ws, move |v| v.locate_folder(&folder)).await?;
    blocking(move || {
        tauri_plugin_opener::open_path(&path, None::<&str>)
            .map_err(|error| AppError::Io(format!("打开文件夹失败: {error}")))
    })
    .await
}

/// 文件树上列的图片、PDF（本地目录；逻辑目录是空的）
#[tauri::command]
#[specta::specta]
pub async fn tree_files(ws: Ws) -> Result<Vec<TreeFile>> {
    with_vault(&ws, |v| Ok(v.tree_files())).await
}

/// 树上的一个文件：`reveal` 在文件管理器里定位它，否则用系统的默认程序打开（PDF 交给阅读器）
#[tauri::command]
#[specta::specta]
pub async fn tree_file_open(ws: Ws, rel_path: String, reveal: bool) -> Result<()> {
    let path = with_vault(&ws, move |v| v.tree_file_path(&rel_path)).await?;
    blocking(move || {
        let result = if reveal {
            tauri_plugin_opener::reveal_item_in_dir(&path)
        } else {
            tauri_plugin_opener::open_path(&path, None::<&str>)
        };
        result.map_err(|error| AppError::Io(format!("打开文件失败: {error}")))
    })
    .await
}

/* ---------------- 逻辑目录（docs/仓库与启动器.md §7） ---------------- */

/// 逻辑目录的树：文件夹、智能文件夹、放在树上的笔记各一个节点（不是逻辑目录报错）
#[tauri::command]
#[specta::specta]
pub async fn tree_view(ws: Ws) -> Result<Vec<TreeNode>> {
    with_vault(&ws, |v| v.tree_view()).await
}

/// 把一篇放进 folder（`/` 是「未整理」），排在 after 那一篇后面，null 是最前面。只改清单，文件不动
#[tauri::command]
#[specta::specta]
pub async fn tree_place(ws: Ws, id: String, folder: String, after: Option<String>) -> Result<()> {
    with_vault(&ws, move |v| v.tree_place(&id, &folder, after.as_deref())).await
}

/// 在文件夹 folder 里放一个快捷方式，指向笔记 id（一篇只在一个位置，快捷方式另算）。返回快捷方式的节点 id
#[tauri::command]
#[specta::specta]
pub async fn tree_add_shortcut(ws: Ws, id: String, folder: String) -> Result<String> {
    with_vault(&ws, move |v| v.tree_add_shortcut(&id, &folder)).await
}

/// 删一个快捷方式（节点 id）：只拿掉那一行，笔记不动
#[tauri::command]
#[specta::specta]
pub async fn tree_remove_shortcut(ws: Ws, node: String) -> Result<()> {
    with_vault(&ws, move |v| v.tree_remove_shortcut(&node)).await
}

/// 挪文件夹 / 智能文件夹：放进 parent，排在 after（同一层的路径）后面，null 是最前面。返回新路径
#[tauri::command]
#[specta::specta]
pub async fn tree_move_folder(ws: Ws, folder: String, parent: String, after: Option<String>) -> Result<String> {
    with_vault(&ws, move |v| v.tree_move_folder(&folder, &parent, after.as_deref())).await
}

/// 新建智能文件夹（条件的写法见 vault/query.rs），返回它的路径
#[tauri::command]
#[specta::specta]
pub async fn tree_add_query(ws: Ws, parent: String, name: String, query: String) -> Result<String> {
    with_vault(&ws, move |v| v.tree_add_query(&parent, &name, &query)).await
}

/// 改智能文件夹的名字和条件，返回新路径
#[tauri::command]
#[specta::specta]
pub async fn tree_set_query(ws: Ws, folder: String, name: String, query: String) -> Result<String> {
    with_vault(&ws, move |v| v.tree_set_query(&folder, &name, &query)).await
}

/// 按几个智能文件夹的条件各筛一遍，每个给出命中的笔记 id
#[tauri::command]
#[specta::specta]
pub async fn tree_queries(ws: Ws, queries: Vec<String>) -> Result<Vec<Vec<String>>> {
    with_vault(&ws, move |v| v.tree_queries(&queries)).await
}

/// 本地目录转成逻辑目录：先问一句，按现在的文件夹结构生成清单，一个文件都不动。
/// 取消了返回 null；转好了前端整页重载
#[tauri::command]
#[specta::specta]
pub async fn vault_make_logical<R: Runtime>(app: AppHandle<R>, ws: Ws) -> Result<Option<VaultInfo>> {
    let asker = app.clone();
    let confirmed = blocking(move || {
        Ok(asker
            .dialog()
            .message(
                "文件树改成自己摆的：手动排顺序、文件夹随便建随便挪，和文件在硬盘上放在哪无关。

                 现在的文件夹结构原样变成树的样子，一个文件都不动；以后在这里建的文件夹只在树上，                 不在硬盘上。想带着结构离开时用「导出成真实文件夹」。",
            )
            .title("转成逻辑目录")
            .buttons(MessageDialogButtons::OkCancelCustom(LOGICAL_LABEL.into(), "取消".into()))
            .blocking_show_with_result())
    })
    .await?;
    if !matches!(confirmed, MessageDialogResult::Custom(label) if label == LOGICAL_LABEL) {
        return Ok(None);
    }
    with_vault(&ws, |v| {
        v.make_logical()?;
        v.info()
    })
    .await
    .map(Some)
}

const LOGICAL_LABEL: &str = "转成逻辑目录";

/// 逻辑目录导出成真实文件夹（离开 Odea 时的退路，docs/仓库与启动器.md §7.5）：选一个位置，在下面建
/// 「仓库名（导出）」，按树的结构拷进去，拷完在文件管理器里打开。原来的仓库不动。取消了返回 null
#[tauri::command]
#[specta::specta]
pub async fn tree_export<R: Runtime>(app: AppHandle<R>, ws: Ws) -> Result<Option<String>> {
    let root = with_vault(&ws, |v| Ok(v.root().to_path_buf())).await?;
    let picker = app.clone();
    let start = root.parent().map(PathBuf::from).unwrap_or_else(|| root.clone());
    let picked = blocking(move || {
        Ok(picker
            .dialog()
            .file()
            .set_title("导出到哪个文件夹下面")
            .set_directory(start)
            .blocking_pick_folder())
    })
    .await?;
    let Some(parent) = picked.and_then(|picked| picked.into_path().ok()) else {
        return Ok(None);
    };
    let canonical = |p: &std::path::Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    if canonical(&parent).starts_with(canonical(&root)) {
        return Err(AppError::Invalid("导出到仓库外面的文件夹：放在里面的话，下次打开它们也成了笔记".into()));
    }
    let name = root.file_name().map_or_else(|| "Odea".into(), |name| name.to_string_lossy().into_owned());
    let dest = (1..)
        .map(|n| if n == 1 { parent.join(format!("{name}（导出）")) } else { parent.join(format!("{name}（导出 {n}）")) })
        .find(|candidate| !candidate.exists())
        .expect("总有一个名字没被占用");
    let target = dest.clone();
    let report = with_vault(&ws, move |v| v.export_tree(&target)).await?;
    eprintln!("导出到 {}：{report:?}", dest.display());
    let shown = dest.clone();
    blocking(move || {
        tauri_plugin_opener::open_path(&shown, None::<&str>)
            .map_err(|error| AppError::Io(format!("打开文件夹失败: {error}")))
    })
    .await?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

/// 导入（docs/仓库与启动器.md §7.6）：弹选文件夹的对话框，把仓库外的一个文件夹照原样复制进来，
/// 放在树上的 folder 里（逻辑目录在树上照原来的结构摆好）。原来的不动。取消了返回 null
#[tauri::command]
#[specta::specta]
pub async fn vault_import<R: Runtime>(app: AppHandle<R>, ws: Ws, folder: String) -> Result<Option<ImportReport>> {
    let root = with_vault(&ws, |v| Ok(v.root().to_path_buf())).await?;
    let picker = app.clone();
    let start = root.parent().map(PathBuf::from).unwrap_or_else(|| root.clone());
    let picked = blocking(move || {
        Ok(picker
            .dialog()
            .file()
            .set_title("导入哪个文件夹（复制进来，原来的不动）")
            .set_directory(start)
            .blocking_pick_folder())
    })
    .await?;
    let Some(source) = picked.and_then(|picked| picked.into_path().ok()) else {
        return Ok(None);
    };
    with_vault(&ws, move |v| v.import_folder(&source, &folder)).await.map(Some)
}

/// 反向链接：正文里写了 `[[这篇的标题]]` 的文档
#[tauri::command]
#[specta::specta]
pub async fn note_backlinks(ws: Ws, id: String) -> Result<Vec<Backlink>> {
    with_vault(&ws, move |v| v.backlinks(&id)).await
}

/// 笔记改了标题之后，别处的 `[[旧标题]]` 改成新标题（Vault::relink）
#[tauri::command]
#[specta::specta]
pub async fn note_relink(ws: Ws, id: String, old_title: String) -> Result<Relink> {
    with_vault(&ws, move |v| v.relink(&id, &old_title)).await
}

/// 撤销 note_relink：返回换回了几篇
#[tauri::command]
#[specta::specta]
pub async fn note_relink_undo(ws: Ws, rewrites: Vec<LinkRewrite>) -> Result<i64> {
    with_vault(&ws, move |v| v.relink_undo(&rewrites)).await
}

/* ---------------- 历史版本（技术方案 §5.9.11） ---------------- */

/// 最多列这么多个版本
const HISTORY_LIMIT: usize = 200;

/// 一篇文档的历史版本，新的在前。没开启同步（仓库根上没有 .git）时说一声
#[tauri::command]
#[specta::specta]
pub async fn doc_history(ws: Ws, target: DocTarget) -> Result<DocHistory> {
    // 只在找路径时持仓库锁；翻 git 历史另开一个 Repository，不持锁
    let (root, rel, id) = with_vault(&ws, move |v| v.history_source(&target)).await?;
    blocking(move || {
        if !root.join(".git").exists() {
            return Ok(DocHistory {
                unavailable: Some(
                    "这个笔记文件夹还没开启同步。开启后每次同步都会留下一版，以后就能在这里看、恢复".into(),
                ),
                ..DocHistory::default()
            });
        }
        let history = crate::sync::history::versions(&root, &rel, id.as_deref(), HISTORY_LIMIT)?;
        let me = crate::sync::engine::this_device();
        let versions = history
            .versions
            .into_iter()
            .map(|version| {
                let title = if id.is_some() {
                    crate::sync::history::text(&root, &version.blob.to_string())
                        .map(|text| crate::sync::history::title_of(&text, &version.path))
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                let device = crate::sync::engine::device_of(&version.author).to_string();
                DocVersion {
                    blob: version.blob.to_string(),
                    time: version.time,
                    mine: device == me,
                    device,
                    title,
                }
            })
            .collect();
        Ok(DocHistory {
            unavailable: None,
            versions,
            more: history.more,
        })
    })
    .await
}

/// 某一版的正文（不含属性块）
#[tauri::command]
#[specta::specta]
pub async fn doc_version_text(ws: Ws, blob: String) -> Result<String> {
    let root = with_vault(&ws, |v| Ok(v.root().to_path_buf())).await?;
    blocking(move || {
        let text = crate::sync::history::text(&root, &blob)?;
        Ok(crate::vault::frontmatter::split(&text).1)
    })
    .await
}

/* ---------------- 搜索 ---------------- */

/// 每次 search_text 加一（命令面板、归档的搜索框各一个，互不顶掉）。正在扫的那一次发现它变了
/// 就不扫了：打字时每个字都会来一次，只有最后那一次的结果有人要
static TEXT_SEARCH_GEN: [std::sync::atomic::AtomicU64; 2] =
    [std::sync::atomic::AtomicU64::new(0), std::sync::atomic::AtomicU64::new(0)];
/// 每次 find_in_vault 加一，意思同上
static FIND_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// search_text、find_in_vault 用的只读连接（连同它连的是哪个索引文件）。不拿仓库的锁：几万篇的
/// 仓库里扫一遍要几百毫秒，这期间自动保存不该等着（索引是 WAL，读写互不挡）
static TEXT_SEARCH_DB: Mutex<Option<(PathBuf, rusqlite::Connection)>> = Mutex::new(None);

/// 在 TEXT_SEARCH_DB 上跑一次搜索。排队等到锁之后先看一眼 cancelled()：又来了新的就不扫了。
/// scan 返回 None 也是被顶掉了，都给空结果（前端只认最后一次的）
fn with_search_db<T: Default>(
    path: PathBuf,
    cancelled: &dyn Fn() -> bool,
    scan: impl FnOnce(&rusqlite::Connection) -> Result<Option<T>>,
) -> Result<T> {
    let mut slot = TEXT_SEARCH_DB
        .lock()
        .map_err(|_| AppError::Internal("搜索的连接坏了".into()))?;
    if cancelled() {
        return Ok(T::default());
    }
    if slot.as_ref().map(|(open, _)| open != &path).unwrap_or(true) {
        let conn = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        *slot = Some((path, conn));
    }
    let (_, conn) = slot.as_ref().expect("刚放进去");
    Ok(scan(conn)?.unwrap_or_default())
}

/// 搜正文：大小写不敏感的子串，笔记（含归档）和日记、目标各自最多 limit 条；archived_only
/// 只搜归档里的笔记（归档的搜索框）。被同一处后来的搜索顶掉的这一次返回空结果（前端只认最后一次的）
#[tauri::command]
#[specta::specta]
pub async fn search_text(
    ws: Ws,
    state: State<'_, AppState>,
    query: String,
    limit: u32,
    archived_only: bool,
) -> Result<TextSearch> {
    use std::sync::atomic::Ordering;
    let counter = &TEXT_SEARCH_GEN[archived_only as usize];
    let generation = counter.fetch_add(1, Ordering::SeqCst) + 1;
    let limit = limit.clamp(1, 1000) as usize;
    let root = with_vault(&ws, |v| Ok(v.root().to_path_buf())).await?;
    let path = boot::index_path(&state.data_dir, &root);
    blocking(move || {
        let cancelled = || counter.load(Ordering::SeqCst) != generation;
        with_search_db(path, &cancelled, |conn| {
            crate::vault::search_text(conn, &query, limit, archived_only, cancelled)
        })
    })
    .await
}

/// 全局搜索（Ctrl+Shift+F，像 VS Code 的「在文件中查找」）：笔记（含归档）、日记、目标的正文里
/// 每一处命中，可以区分大小写、全词匹配、用正则。被后来的搜索顶掉的这一次返回空结果
#[tauri::command]
#[specta::specta]
pub async fn find_in_vault(
    ws: Ws,
    state: State<'_, AppState>,
    query: String,
    options: FindOptions,
) -> Result<FindResult> {
    use std::sync::atomic::Ordering;
    let generation = FIND_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let root = with_vault(&ws, |v| Ok(v.root().to_path_buf())).await?;
    let path = boot::index_path(&state.data_dir, &root);
    blocking(move || {
        let cancelled = || FIND_GEN.load(Ordering::SeqCst) != generation;
        with_search_db(path, &cancelled, |conn| {
            crate::vault::find_text(conn, &query, options, cancelled)
        })
    })
    .await
}

/* ---------------- 任务 ---------------- */

/// 勾选日历里的一条任务：改的是它所在文件里的那一行
#[tauri::command]
#[specta::specta]
pub async fn task_toggle(ws: Ws, id: String) -> Result<Task> {
    with_vault(&ws, move |v| v.toggle_task(&id)).await
}

/* ---------------- 目标 ---------------- */

/// 某个周期的目标。period_start 由前端按 horizon 算好（周一 / 1 号 / 1 月 1 日），
/// 这里校验它确实是周期起点。没写过的周期返回空文档。
#[tauri::command]
#[specta::specta]
pub async fn goal_get(
    ws: Ws,
    horizon: String,
    period_start: String,
) -> Result<Goal> {
    validate_date(&period_start)?;
    with_vault(&ws, move |v| v.goal(&horizon, &period_start)).await
}

#[tauri::command]
#[specta::specta]
pub async fn goal_save(
    ws: Ws,
    horizon: String,
    period_start: String,
    content_md: String,
) -> Result<Goal> {
    validate_date(&period_start)?;
    with_vault(&ws, move |v| v.save_goal(&horizon, &period_start, &content_md)).await
}

/* ---------------- 日历 ---------------- */

/// `carry_over` 只在请求「今天」时传 true：今天还没写过就延续之前最近的一天。
#[tauri::command]
#[specta::specta]
pub async fn calendar_day(
    ws: Ws,
    date: String,
    carry_over: bool,
) -> Result<DayDoc> {
    validate_date(&date)?;
    with_vault(&ws, move |v| v.day(&date, carry_over)).await
}

#[tauri::command]
#[specta::specta]
pub async fn calendar_day_save(
    ws: Ws,
    date: String,
    title: String,
    note_md: String,
) -> Result<DayDoc> {
    validate_date(&date)?;
    with_vault(&ws, move |v| v.save_day(&date, &title, &note_md)).await
}

/// 月网格上的记号：写过记录 / 做过事的日子，和还有待办的日子
#[tauri::command]
#[specta::specta]
pub async fn calendar_marks(
    ws: Ws,
    from: String,
    to: String,
) -> Result<CalendarMarks> {
    validate_date(&from)?;
    validate_date(&to)?;
    with_vault(&ws, move |v| v.calendar_marks(&from, &to)).await
}

/// 所有写过的某一天、某个周期的目标，连同正文（命令面板搜它们）
#[tauri::command]
#[specta::specta]
pub async fn journal_list(ws: Ws) -> Result<Vec<JournalDoc>> {
    with_vault(&ws, |v| v.journal_list()).await
}

/* ---------------- 使用指南（vault/guide.rs） ---------------- */

/// 用户改过、而这个版本带着新版的使用指南：前端在那一篇上问换不换
#[tauri::command]
#[specta::specta]
pub async fn guide_pending(ws: Ws) -> Result<Vec<GuideUpdate>> {
    with_vault(&ws, |v| v.guide_pending()).await
}

/// 用户看过新版了（换上了，或者留着自己的）：到下一次升级前不再问
#[tauri::command]
#[specta::specta]
pub async fn guide_settle(ws: Ws, id: String) -> Result<()> {
    with_vault(&ws, move |v| v.guide_settle(&id)).await
}

/// 命令面板「使用指南」：那一篇的 id，删掉了就重新放一篇
#[tauri::command]
#[specta::specta]
pub async fn guide_open(ws: Ws, name: String) -> Result<String> {
    with_vault(&ws, move |v| v.guide_open(&name)).await
}

/* ---------------- 仓库文件夹 ---------------- */

#[tauri::command]
#[specta::specta]
pub async fn vault_info(ws: Ws) -> Result<VaultInfo> {
    with_vault(&ws, |v| v.info()).await
}

/// 开 / 关日程（docs/仓库与启动器.md §6）：改仓库标记，每个文件按新的摆法重新认一遍（文件一个都不动）。
/// 文件多的话剩下的在后台读，和打开仓库时一样报进度。前端拿到结果后整页重载
#[tauri::command]
#[specta::specta]
pub async fn vault_set_journal<R: Runtime>(app: AppHandle<R>, ws: Ws, on: bool) -> Result<VaultInfo> {
    let backlog = with_vault(&ws, move |v| v.set_journal(on)).await?;
    spawn_backlog(app, ws.label.clone(), ws.vault.clone(), ws.indexing.clone(), backlog);
    with_vault(&ws, |v| v.info()).await
}

/// 别的设备开关了日程、转成了逻辑目录（同步过来，VaultChange.layout）：用户点了「切换过去」，
/// 按磁盘上的仓库标记重新摆。前端随后整页重载
#[tauri::command]
#[specta::specta]
pub async fn vault_relayout<R: Runtime>(app: AppHandle<R>, ws: Ws) -> Result<VaultInfo> {
    let backlog = with_vault(&ws, |v| v.relayout()).await?;
    spawn_backlog(app, ws.label.clone(), ws.vault.clone(), ws.indexing.clone(), backlog);
    with_vault(&ws, |v| v.info()).await
}

/* ---------------- 后台读文件进索引（Vault::open_quick） ---------------- */

/// 后台把文件读进索引的进度。读完的那一次 done == total，前端据此整个重新取一遍列表
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct IndexProgress {
    pub done: u32,
    pub total: u32,
}

/// 后台读到哪了。换仓库时代号加一：还在读旧仓库的那个线程自己停下，也不再报进度
#[derive(Default)]
pub struct Indexing {
    generation: u64,
    progress: Option<IndexProgress>,
}

impl Indexing {
    /// 开始新的一轮（或者换了仓库、没有要读的）：旧的那一轮作废
    fn restart(&mut self, progress: Option<IndexProgress>) -> u64 {
        self.generation += 1;
        self.progress = progress;
        self.generation
    }
}

/// 正在后台读文件的话，读到哪了；没在读是 null。前端启动时先订阅进度事件再来问这一次
#[tauri::command]
#[specta::specta]
pub async fn index_progress(ws: Ws) -> Result<Option<IndexProgress>> {
    Ok(ws
        .indexing
        .lock()
        .map_err(|_| AppError::Internal("索引进度锁坏了".into()))?
        .progress)
}

/// 在后台把 backlog 读完。每次拿着仓库的锁读 50ms 左右就放开、歇一下，前端的命令能插进来；
/// 每读一批报一次进度。读完以后按读全了的索引把使用指南升到这一版（打开时它们可能还没读到），
/// 最后报 done == total
pub fn spawn_backlog<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    vault: Arc<Mutex<Vault>>,
    indexing: Arc<Mutex<Indexing>>,
    mut backlog: Backlog,
) {
    let total = u32::try_from(backlog.total()).unwrap_or(u32::MAX);
    let start = (!backlog.is_empty()).then_some(IndexProgress { done: 0, total });
    let Ok(generation) = indexing.lock().map(|mut slot| slot.restart(start)) else {
        return;
    };
    if backlog.is_empty() {
        return;
    }
    let Ok(root) = vault.lock().map(|vault| vault.root().to_path_buf()) else {
        return;
    };
    std::thread::spawn(move || {
        // 还是这一轮的话记下进度；换了仓库 / 开了新的一轮就停
        let report = |progress: Option<IndexProgress>| {
            indexing.lock().is_ok_and(|mut slot| {
                let current = slot.generation == generation;
                if current {
                    slot.progress = progress;
                }
                current
            })
        };
        while !backlog.is_empty() {
            {
                let Ok(mut vault) = vault.lock() else { return };
                if vault.root() != root {
                    return;
                }
                vault.index_backlog(&mut backlog, Some(Duration::from_millis(50)));
            }
            let done = u32::try_from(backlog.done()).unwrap_or(total);
            if !report(Some(IndexProgress { done, total })) {
                return;
            }
            if !backlog.is_empty() {
                let _ = IndexProgress { done, total }.emit_to(&app, label.as_str());
                // 让等着锁的命令先拿到（标准库的锁不保证先来先得）
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        if let Ok(mut vault) = vault.lock() {
            if vault.root() != root {
                return;
            }
            if let Err(error) = vault.guide_refresh() {
                eprintln!("更新使用指南失败: {error}");
            }
        }
        if report(None) {
            if let Err(error) = (IndexProgress { done: total, total }).emit_to(&app, label.as_str()) {
                eprintln!("通知前端失败: {error}");
            }
        }
    });
}

/// 在系统的文件管理器里定位这篇文档的文件（选中它）。还没写过的某一天 /
/// 某个周期没有文件，打开它将来所在的文件夹。
#[tauri::command]
#[specta::specta]
pub async fn vault_reveal(ws: Ws, target: DocTarget) -> Result<()> {
    let (path, is_file) = with_vault(&ws, move |v| v.locate(&target)).await?;
    blocking(move || {
        let result = if is_file {
            tauri_plugin_opener::reveal_item_in_dir(&path)
        } else {
            tauri_plugin_opener::open_path(&path, None::<&str>)
        };
        result.map_err(|error| AppError::Io(format!("打开文件夹失败: {error}")))
    })
    .await
}

/// 打开整个笔记文件夹
#[tauri::command]
#[specta::specta]
pub async fn vault_open_folder(ws: Ws) -> Result<()> {
    let root = with_vault(&ws, |v| Ok(v.root().to_path_buf())).await?;
    blocking(move || {
        tauri_plugin_opener::open_path(&root, None::<&str>)
            .map_err(|error| AppError::Io(format!("打开文件夹失败: {error}")))
    })
    .await
}

/// 编辑器里有没存的改动时，磁盘上又来了外部改动：先把磁盘上那一版另存一份
/// 「(冲突 …)」，前端随后照常保存自己的。返回冲突副本的标题。
#[tauri::command]
#[specta::specta]
pub async fn vault_keep_conflict_copy(
    ws: Ws,
    target: DocTarget,
) -> Result<Option<String>> {
    with_vault(&ws, move |v| v.keep_conflict_copy(&target)).await
}

/// 粘贴进来的文件（剪贴板里的图片）存进「附件」文件夹。内容以 base64 传过来 ——
/// 一个字节一个数字的 JSON 数组，几 MB 的截图要序列化成几千万个字符。
#[tauri::command]
#[specta::specta]
pub async fn vault_attach(
    ws: Ws,
    target: DocTarget,
    name: String,
    data_base64: String,
) -> Result<Attachment> {
    use base64::Engine;
    let bytes = blocking(move || {
        base64::engine::general_purpose::STANDARD
            .decode(data_base64.trim())
            .map_err(|error| AppError::Invalid(format!("附件内容不是 base64: {error}")))
    })
    .await?;
    with_vault(&ws, move |v| v.attach(&target, &name, &bytes)).await
}

/// 拖进窗口的文件（桌面端拿到的是路径）存进「附件」文件夹
#[tauri::command]
#[specta::specta]
pub async fn vault_attach_path(
    ws: Ws,
    target: DocTarget,
    path: String,
) -> Result<Attachment> {
    with_vault(&ws, move |v| v.attach_path(&target, std::path::Path::new(&path))).await
}

/// 换位置的时候，现在的笔记怎么办
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum ChangeRootMode {
    /// 新文件夹里没有笔记就问：搬过去 / 复制过去 / 只换文件夹（命令面板「更换笔记文件夹…」）
    Ask,
    /// 不问，直接搬过去（新装第一次打开时的「换个位置…」）
    Move,
}

/// 换一个文件夹当仓库。弹系统的选择文件夹对话框；新文件夹里没有笔记的话，现在的笔记
/// 搬过去（原来的进回收站）、复制过去（原来的不动）还是不带（`mode` 决定问不问）。
/// 取消了返回 null。前端拿到结果后整页重载。
#[tauri::command]
#[specta::specta]
pub async fn vault_change_root<R: Runtime>(
    app: AppHandle<R>,
    ws: Ws,
    state: State<'_, AppState>,
    mode: ChangeRootMode,
) -> Result<Option<VaultInfo>> {
    let current = with_vault(&ws, |v| Ok(v.root().to_path_buf())).await?;

    let picker = app.clone();
    let start = current.parent().map(PathBuf::from).unwrap_or_else(|| current.clone());
    let picked = blocking(move || {
        Ok(picker
            .dialog()
            .file()
            .set_title("选择笔记文件夹")
            .set_directory(start)
            .blocking_pick_folder())
    })
    .await?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let new_root = picked
        .into_path()
        .map_err(|error| AppError::Invalid(format!("这个位置用不了: {error}")))?;

    let same = |a: &std::path::Path, b: &std::path::Path| {
        a.canonicalize().ok().zip(b.canonicalize().ok()).is_some_and(|(a, b)| a == b)
    };
    if same(&new_root, &current) {
        return with_vault(&ws, |v| v.info()).await.map(Some);
    }
    let canonical = |p: &std::path::Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let (new_canonical, current_canonical) = (canonical(&new_root), canonical(&current));
    if new_canonical.starts_with(&current_canonical) || current_canonical.starts_with(&new_canonical) {
        return Err(AppError::Invalid(
            "新文件夹不能在现在的笔记文件夹里面，也不能包着它".into(),
        ));
    }
    // 两个窗口开同一个文件夹 = 两份监听、两个写入方（docs/仓库与启动器.md §4.4）
    if state.window_of(&new_root).is_some_and(|label| label != ws.label) {
        return Err(AppError::Invalid("这个文件夹已经在另一个窗口里开着了".into()));
    }

    // 新文件夹里已经有笔记（别的仓库、Obsidian 的文件夹）：直接用它，现在的不动
    // 改名前的仓库标记在 .ontheway/ 里，打开时才搬过来（boot::prepare）
    let target_is_vault = fsio::has_markdown(&new_root)
        || fsio::abs(&new_root, layout::VAULT_MARKER).exists()
        || new_root.join(crate::old_name::VAULT_DIR).join("vault.json").exists();
    if target_is_vault {
        return switch_vault(&app, &state, &ws.0, new_root).await.map(Some);
    }
    let bring = match mode {
        ChangeRootMode::Move => Bring::Move,
        ChangeRootMode::Ask if !fsio::has_markdown(&current) => Bring::Nothing,
        ChangeRootMode::Ask => {
            let asker = app.clone();
            let picked = blocking(move || {
                Ok(asker
                    .dialog()
                    .message(
                        "新文件夹里还没有笔记。现在的笔记要怎么办？\n\n\
                         搬过去：笔记挪到新文件夹，原来的文件夹放进回收站。\n\
                         复制过去：两边各一份，原来的不动。\n\
                         只换文件夹：从一个空的笔记文件夹开始，现在的笔记留在原处。",
                    )
                    .title("更换笔记文件夹")
                    .buttons(MessageDialogButtons::YesNoCancelCustom(
                        MOVE_LABEL.into(),
                        COPY_LABEL.into(),
                        SWITCH_LABEL.into(),
                    ))
                    .blocking_show_with_result())
            })
            .await?;
            match picked {
                MessageDialogResult::Custom(label) if label == MOVE_LABEL => Bring::Move,
                MessageDialogResult::Custom(label) if label == COPY_LABEL => Bring::Copy,
                MessageDialogResult::Custom(label) if label == SWITCH_LABEL => Bring::Nothing,
                // 直接关掉对话框：不换了（以前关掉等于「只换文件夹」，看着像笔记全没了）
                _ => return Ok(None),
            }
        }
    };

    match bring {
        Bring::Move => move_vault_to(&app, &state, &ws.0, current, new_root).await.map(Some),
        Bring::Copy => {
            let (from, to) = (current.clone(), new_root.clone());
            blocking(move || boot::copy_vault(&from, &to).map(|_| ())).await?;
            switch_vault(&app, &state, &ws.0, new_root).await.map(Some)
        }
        Bring::Nothing => switch_vault(&app, &state, &ws.0, new_root).await.map(Some),
    }
}

const MOVE_LABEL: &str = "搬过去";
const COPY_LABEL: &str = "复制过去";
const SWITCH_LABEL: &str = "只换文件夹";

/// 换位置时现在的笔记怎么办（用户选的，或者 `ChangeRootMode::Move` 定好的）
enum Bring {
    Move,
    Copy,
    Nothing,
}

/// 「搬过去」（技术方案 §5.7，`boot::move_vault`）：停掉监听和同步、搬、记下新位置、换过去。
/// 原来的没能放进回收站的，换过去以后弹窗说一声
async fn move_vault_to<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    ws: &Arc<Workspace>,
    current: PathBuf,
    new_root: PathBuf,
) -> Result<VaultInfo> {
    // Windows 上还开着的句柄（文件监听、同步线程里的 git 仓库）会让改名失败：先停掉
    stop_services(ws)?;

    let (from, to) = (current.clone(), new_root.clone());
    let moved = blocking(move || {
        boot::move_vault(&from, &to, |path| trash::delete(path).map_err(|error| error.to_string()))
    })
    .await;
    let moved = match moved {
        Ok(moved) => moved,
        Err(error) => {
            // 原来的仓库没动：监听和同步照旧起来
            if let Err(restart) = switch_vault(app, state, ws, current).await {
                eprintln!("搬不过去之后恢复原来的仓库也失败了: {restart}");
            }
            return Err(error);
        }
    };

    // 仓库已经不在原处了：先记下新位置（列表里这一条换成新路径，窗口标签跟着走）。后面哪一步失败，
    // 下次启动也得去新位置找，不然会把原处当成找不到的仓库
    let (data_dir, from, to) = (state.data_dir.clone(), current.clone(), new_root.clone());
    blocking(move || {
        boot::edit_config(&data_dir, |config| {
            config.move_vault(&from, &to);
            Ok(())
        })
    })
    .await?;
    let info = switch_vault(app, state, ws, new_root.clone()).await?;

    if let boot::Moved::CopiedKeptOriginal(reason) = moved {
        let teller = app.clone();
        let text = format!(
            "笔记已经搬到「{}」了，但原来的文件夹没能放进回收站：{reason}

可以自己把它删掉：{}",
            new_root.display(),
            current.display()
        );
        blocking(move || {
            teller.dialog().message(text).title("更换笔记文件夹").blocking_show();
            Ok(())
        })
        .await?;
    }
    Ok(info)
}

/// 停掉这个仓库的文件监听和同步（换仓库、搬仓库之前；窗口关了以后）
pub fn stop_services(ws: &Workspace) -> Result<()> {
    *ws.watcher.lock().map_err(|_| AppError::Internal("监听锁坏了".into()))? = None;
    ws.sync.stop();
    stop_share(ws);
    Ok(())
}

/// 仓库换上了（新开的窗口、换了文件夹）：后台读索引、文件监听、同步都起来，通知都只发给这个窗口。
/// 同步线程第一轮要等前端 ready（技术方案 §5.9.6），这里只是起线程
pub fn start_services<R: Runtime>(app: &AppHandle<R>, data_dir: &std::path::Path, ws: &Arc<Workspace>, backlog: Backlog) {
    spawn_backlog(app.clone(), ws.label.clone(), ws.vault.clone(), ws.indexing.clone(), backlog);
    // 文件监听处理完一批：戳一下同步（停笔一会儿后提交）和共享仓库（附件可能变了）
    let poke_sync = sync_poke(&ws.sync);
    let workspace = Arc::downgrade(ws);
    let on_batch: watch::OnBatch = Arc::new(move || {
        poke_sync();
        if let Some(service) = workspace.upgrade().and_then(|ws| ws.share()) {
            service.poke();
        }
    });
    match watch::start(ws.vault.clone(), Some(on_batch)) {
        Ok(watcher) => {
            if let Ok(mut slot) = ws.watcher.lock() {
                *slot = Some(watcher);
            }
        }
        // 监听不上只是外部改动不能实时同步，重启时的扫描还会补上
        Err(error) => eprintln!("{error}"),
    }
    // 仓库开了同步就起同步线程（拷过来的、以前同步过的也接着同步）
    let hooks = sync_hooks(app.clone(), ws.label.clone(), data_dir.to_path_buf());
    if let Err(error) = ws.sync.start(ws.vault.clone(), hooks) {
        eprintln!("同步没能启动: {error}");
    }
    start_share(app, data_dir, ws);
}

/// 这个窗口换到另一个仓库文件夹：准备好、打开、停旧的监听和同步、换上新的、起新的、记进仓库列表。
/// 换仓库的命令和「第二台设备接入同步」（clone 到新文件夹）都走这里；之后前端整页重载
async fn switch_vault<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    ws: &Arc<Workspace>,
    new_root: PathBuf,
) -> Result<VaultInfo> {
    let data_dir = state.data_dir.clone();
    let (root, old) = (new_root.clone(), ws.root());
    // 换到一个装满笔记的文件夹（比如 Obsidian 的）：文件多的话后台慢慢读，前端整页重载后看到进度
    let (vault, backlog) = blocking(move || {
        boot::edit_config(&data_dir, |config| {
            boot::prepare(&root, &data_dir, config, false, false)?;
            let opened = Vault::open_quick(&root, &boot::index_path(&data_dir, &root))?;
            if !boot::same_vault(&old, &root) {
                config.set_vault_open(&old, false);
            }
            config.remember_vault(&root, crate::db::now_ms());
            Ok(opened)
        })
    })
    .await?;

    // 先停旧的监听和同步，再换仓库
    stop_services(ws)?;
    {
        let mut current = ws
            .vault
            .lock()
            .map_err(|_| AppError::Internal("仓库锁坏了".into()))?;
        *current = vault;
        current.set_announcer(announcer(app.clone(), ws.label.clone()));
    }
    *ws.root.lock().map_err(|_| AppError::Internal("仓库锁坏了".into()))? = new_root;
    let (app_handle, data_dir, workspace) = (app.clone(), state.data_dir.clone(), ws.clone());
    blocking(move || {
        start_services(&app_handle, &data_dir, &workspace, backlog);
        Ok(())
    })
    .await?;
    with_vault(ws, |v| v.info()).await
}

/* ---------------- 同步（技术方案 §5.9） ---------------- */

/// 同步状态变了
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct SyncStatusChanged(pub SyncStatus);

/// 同步要告诉用户的一句话：冲突副本、超限的文件没同步、仓库快满了
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct SyncNotice(pub String);

/// 同步线程往外发东西的口子：状态、提示（只发给这个仓库的窗口），和每轮要的令牌与代理
pub fn sync_hooks<R: Runtime>(app: AppHandle<R>, label: String, data_dir: PathBuf) -> Hooks {
    let (status_app, status_label) = (app.clone(), label.clone());
    Hooks {
        status: Arc::new(move |status| {
            if let Err(error) = SyncStatusChanged(status.clone()).emit_to(&status_app, status_label.as_str()) {
                eprintln!("通知前端失败: {error}");
            }
        }),
        notice: Arc::new(move |text| {
            if let Err(error) = SyncNotice(text).emit_to(&app, label.as_str()) {
                eprintln!("通知前端失败: {error}");
            }
        }),
        net: Arc::new(move |repo, rejected| net_for(&data_dir, repo, rejected)),
    }
}

/// 这个仓库连云端用的令牌和代理。`rejected` = 刚才被云端拒了，GitHub 的令牌先续一次
fn net_for(data_dir: &std::path::Path, repo: &SyncRepo, rejected: bool) -> SyncResult<Net> {
    let proxy = proxy::resolve(boot::Config::load(data_dir).sync_proxy.as_deref());
    let provider = repo
        .config_get(PROVIDER_KEY)
        .as_deref()
        .and_then(Provider::parse);
    let credentials = match (provider, repo.config_get(LOGIN_KEY)) {
        (Some(provider), Some(login)) => {
            let token = account::access_token(
                provider,
                &login,
                || Http::new(proxy.as_deref()),
                rejected,
            )?;
            Some((login, token))
        }
        // 没登录的远端（比如本机的一个裸仓库）
        _ => None,
    };
    Ok(Net { credentials, proxy })
}

/// 文件监听每处理完一批就戳一下同步线程
pub fn sync_poke(hub: &Arc<SyncHub>) -> watch::OnBatch {
    let hub = hub.clone();
    Arc::new(move || hub.poke())
}

pub(crate) fn sync_http(data_dir: &std::path::Path) -> SyncResult<Http> {
    Http::new(proxy::resolve(boot::Config::load(data_dir).sync_proxy.as_deref()).as_deref())
}

pub(crate) fn provider_of(key: &str) -> Result<Provider> {
    Provider::parse(key).ok_or_else(|| AppError::Invalid(format!("不认识的托管方: {key}")))
}

/// 这个托管方登录的是哪个账号
pub(crate) fn login_of(data_dir: &std::path::Path, provider: Provider) -> Result<String> {
    boot::Config::load(data_dir)
        .sync_accounts
        .get(provider.key())
        .cloned()
        .ok_or_else(|| AppError::Invalid("还没登录".into()))
}

/// 用这个托管方的账号调一次接口：令牌快过期先续；被拒了续一次再试
fn with_token<T>(
    data_dir: &std::path::Path,
    provider: Provider,
    call: impl Fn(&Http, &str) -> SyncResult<T>,
) -> Result<T> {
    let login = login_of(data_dir, provider)?;
    let http = sync_http(data_dir)?;
    let token = account::access_token(provider, &login, || sync_http(data_dir), false)?;
    match call(&http, &token) {
        Err(SyncError::Auth) => {
            let token = account::access_token(provider, &login, || sync_http(data_dir), true)?;
            Ok(call(&http, &token)?)
        }
        other => Ok(other?),
    }
}

fn remember_account(
    data_dir: &std::path::Path,
    provider: Provider,
    login: String,
) -> Result<SyncAccount> {
    let mut config = boot::Config::load(data_dir);
    config
        .sync_accounts
        .insert(provider.key().to_string(), login.clone());
    config.save(data_dir)?;
    Ok(SyncAccount { provider: provider.key().to_string(), login })
}

fn remote_info(repo: RemoteRepo) -> SyncRemoteRepo {
    SyncRemoteRepo {
        full_name: repo.full_name,
        clone_url: repo.clone_url,
        private: repo.private,
        updated_at: repo.updated_at,
    }
}

#[tauri::command]
#[specta::specta]
pub async fn sync_status(ws: Ws) -> Result<SyncStatus> {
    Ok(ws.sync.status())
}

/// 立即同步一轮。没开同步返回 false
#[tauri::command]
#[specta::specta]
pub async fn sync_now(ws: Ws) -> Result<bool> {
    Ok(ws.sync.sync_now())
}

/// 登录过、钥匙串里还有令牌的同步账号
#[tauri::command]
#[specta::specta]
pub async fn sync_accounts(state: State<'_, AppState>) -> Result<Vec<SyncAccount>> {
    let data_dir = state.data_dir.clone();
    blocking(move || {
        Ok(boot::Config::load(&data_dir)
            .sync_accounts
            .iter()
            .filter_map(|(key, login)| {
                let provider = Provider::parse(key)?;
                account::has_token(provider, login).then(|| SyncAccount {
                    provider: key.clone(),
                    login: login.clone(),
                })
            })
            .collect())
    })
    .await
}

/// GitHub 设备码登录第一步：领一个码给用户看。接着调 sync_github_login_wait 等用户确认
#[tauri::command]
#[specta::specta]
pub async fn sync_github_login_start(state: State<'_, AppState>) -> Result<SyncDeviceCode> {
    let data_dir = state.data_dir.clone();
    let pending = blocking(move || Ok(PendingLogin::start(&sync_http(&data_dir)?)?)).await?;
    let code = pending.code();
    let shown = SyncDeviceCode {
        user_code: code.user_code.clone(),
        verification_uri: code.verification_uri.clone(),
        expires_in: code.expires_in as u32,
    };
    state
        .sync_login
        .lock()
        .map_err(|_| AppError::Internal("登录状态锁坏了".into()))?
        .put(pending);
    Ok(shown)
}

/// 等用户在浏览器里确认（sync_login_cancel 能叫停）。成功后令牌进钥匙串，返回账号
#[tauri::command]
#[specta::specta]
pub async fn sync_github_login_wait(state: State<'_, AppState>) -> Result<SyncAccount> {
    let pending = state
        .sync_login
        .lock()
        .map_err(|_| AppError::Internal("登录状态锁坏了".into()))?
        .take()
        .ok_or_else(|| AppError::Invalid("没有正在进行的登录".into()))?;
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let login = pending.wait(&sync_http(&data_dir)?)?;
        remember_account(&data_dir, Provider::GitHub, login)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn sync_login_cancel(state: State<'_, AppState>) -> Result<()> {
    state
        .sync_login
        .lock()
        .map_err(|_| AppError::Internal("登录状态锁坏了".into()))?
        .cancel();
    Ok(())
}

/// Gitee：用私人令牌登录（先问一下令牌是谁的，顺便验证能用）
#[tauri::command]
#[specta::specta]
pub async fn sync_gitee_login(state: State<'_, AppState>, token: String) -> Result<SyncAccount> {
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let login = account::login_gitee(&sync_http(&data_dir)?, &token)?;
        remember_account(&data_dir, Provider::Gitee, login)
    })
    .await
}

/// 退出这个托管方的账号：删掉钥匙串里的令牌
#[tauri::command]
#[specta::specta]
pub async fn sync_logout(state: State<'_, AppState>, provider: String) -> Result<()> {
    let provider = provider_of(&provider)?;
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let mut config = boot::Config::load(&data_dir);
        if let Some(login) = config.sync_accounts.remove(provider.key()) {
            account::logout(provider, &login)?;
            config.save(&data_dir)?;
        }
        Ok(())
    })
    .await
}

/// 这个账号自己的仓库，最近更新的在前
#[tauri::command]
#[specta::specta]
pub async fn sync_repos(state: State<'_, AppState>, provider: String) -> Result<Vec<SyncRemoteRepo>> {
    let provider = provider_of(&provider)?;
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let repos = with_token(&data_dir, provider, |http, token| provider.repos(http, token))?;
        Ok(repos.into_iter().map(remote_info).collect())
    })
    .await
}

/// 新建一个空的私有仓库
#[tauri::command]
#[specta::specta]
pub async fn sync_create_repo(
    state: State<'_, AppState>,
    provider: String,
    name: String,
) -> Result<SyncRemoteRepo> {
    let provider = provider_of(&provider)?;
    let name = name.trim().to_string();
    let valid = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !valid {
        return Err(AppError::Invalid(
            "仓库名只能用英文字母、数字和 - _ .".into(),
        ));
    }
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let repo = with_token(&data_dir, provider, |http, token| {
            provider.create_repo(http, token, &name)
        })?;
        Ok(remote_info(repo))
    })
    .await
}

/// 同步用的代理：用户填的，和实际在用的
#[tauri::command]
#[specta::specta]
pub async fn sync_proxy(state: State<'_, AppState>) -> Result<SyncProxy> {
    let configured = boot::Config::load(&state.data_dir).sync_proxy;
    let effective = proxy::resolve(configured.as_deref());
    Ok(SyncProxy { configured, effective })
}

/// 填一个代理（空的 = 不填，按环境变量、系统代理找）
#[tauri::command]
#[specta::specta]
pub async fn sync_set_proxy(state: State<'_, AppState>, proxy: Option<String>) -> Result<SyncProxy> {
    let configured = proxy.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    let mut config = boot::Config::load(&state.data_dir);
    config.sync_proxy = configured.clone();
    config.save(&state.data_dir)?;
    let effective = proxy::resolve(configured.as_deref());
    Ok(SyncProxy { configured, effective })
}

/// 开启同步前先看一眼云端：在这里接上，还是要 clone 到新文件夹（放在哪）
#[tauri::command]
#[specta::specta]
pub async fn sync_inspect(
    ws: Ws,
    state: State<'_, AppState>,
    provider: String,
    clone_url: String,
) -> Result<SyncPlan> {
    let provider = provider_of(&provider)?;
    let data_dir = state.data_dir.clone();
    let root = with_vault(&ws, |v| Ok(v.root().to_path_buf())).await?;
    blocking(move || {
        let login = login_of(&data_dir, provider)?;
        let token = account::access_token(provider, &login, || sync_http(&data_dir), false)?;
        let net = Net {
            credentials: Some((login, token)),
            proxy: proxy::resolve(boot::Config::load(&data_dir).sync_proxy.as_deref()),
        };
        let reconnect = SyncRepo::open(&root)?
            .and_then(|repo| repo.remote_url())
            .is_some_and(|url| setup::same_remote(&url, &clone_url));
        let connect_here = reconnect || SyncRepo::remote_is_empty(&clone_url, &net)?;
        Ok(SyncPlan {
            connect_here,
            clone_target: (!connect_here)
                .then(|| setup::clone_target(&root).to_string_lossy().into_owned()),
            local_notes: fsio::has_markdown(&root),
        })
    })
    .await
}

/// 开启同步（技术方案 §5.9.7）。云端仓库是空的（或者就是这个仓库以前连过的）：
/// 在现在的仓库上接上，同步线程第一轮把这里的推上去，返回 false。
/// 云端已经有东西：clone 到旁边的新文件夹、换过去（`bring_local` = 把现在仓库里的也拷过去），
/// 返回 true —— 前端整页重载
#[tauri::command]
#[specta::specta]
pub async fn sync_enable<R: Runtime>(
    app: AppHandle<R>,
    ws: Ws,
    state: State<'_, AppState>,
    provider: String,
    clone_url: String,
    bring_local: bool,
) -> Result<bool> {
    let provider = provider_of(&provider)?;
    let data_dir = state.data_dir.clone();
    let root = with_vault(&ws, |v| Ok(v.root().to_path_buf())).await?;
    if share::is_shared(&root) {
        return Err(AppError::Invalid(
            "这是一个共享仓库，改动已经在成员之间同步了。共享和同步二选一：自己的别的设备也加进共享里".into(),
        ));
    }
    if let Some(drive) = setup::cloud_drive_of(&root) {
        return Err(AppError::Invalid(format!(
            "笔记文件夹在{drive}的同步目录里。网盘和同步二选一：网盘会来回拷 .git，迟早把它弄坏。先把笔记文件夹换到网盘外面（命令面板「更换笔记文件夹…」）"
        )));
    }
    let login = login_of(&data_dir, provider)?;
    ws.sync.stop();
    let (here, data) = (root.clone(), data_dir.clone());
    let cloned = blocking(move || {
        let token = account::access_token(provider, &login, || sync_http(&data), false)?;
        let net = Net {
            credentials: Some((login.clone(), token)),
            proxy: proxy::resolve(boot::Config::load(&data).sync_proxy.as_deref()),
        };
        let reconnect = SyncRepo::open(&here)?
            .and_then(|repo| repo.remote_url())
            .is_some_and(|url| setup::same_remote(&url, &clone_url));
        if reconnect || SyncRepo::remote_is_empty(&clone_url, &net)? {
            setup::connect_here(&here, provider, &login, &clone_url)?;
            return Ok(None);
        }
        let target = setup::clone_target(&here);
        let repo = SyncRepo::clone(&clone_url, &target, &net)?;
        setup::mark(&repo, provider, &login)?;
        if bring_local {
            setup::bring_local(&here, &target)?;
        }
        Ok(Some(target))
    })
    .await?;

    match cloned {
        Some(target) => {
            switch_vault(&app, &state, &ws.0, target).await?;
            Ok(true)
        }
        None => {
            let (hub, vault, hooks) = (
                ws.sync.clone(),
                ws.vault.clone(),
                sync_hooks(app.clone(), ws.label.clone(), data_dir),
            );
            blocking(move || {
                hub.start(vault, hooks)?;
                // 前端早就 ready 了：第一轮现在就开始，不等那 30 秒
                hub.sync_now();
                Ok(())
            })
            .await?;
            Ok(false)
        }
    }
}

/// 断开同步：不再自动同步，忘掉这个仓库用哪个账号。.git 留着（历史都在，能再连上），账号不退出
#[tauri::command]
#[specta::specta]
pub async fn sync_disable(ws: Ws) -> Result<SyncStatus> {
    ws.sync.stop();
    let root = with_vault(&ws, |v| Ok(v.root().to_path_buf())).await?;
    blocking(move || Ok(setup::disconnect(&root)?)).await?;
    Ok(ws.sync.status())
}

/* ---------------- 协作（docs/协同编辑.md） ----------------
网络在 collab/（Host / Guest），这里只是接到前端：
- 控制消息（加入请求、成员、连接状态）走 tauri-specta 的事件 CollabEvent
- 文档更新、光标、同步请求是不透明的字节：不走 JSON（一字节一个数字），
  Rust → 前端走前端登记的二进制 Channel（collab_pipe），前端 → Rust 走原始请求体（collab_send）。
  这两个命令不经 tauri-specta（它不认原始请求体），lib.rs 里和 specta 的命令合在一个 handler 里。
  帧：1 字节类型 + 2 字节成员号（小端）+ 内容，类型见 PIPE_*
同一时刻只有一个会话：主持一篇，或者在别人那里做客。
中继（设计 §6.4）：地址、名字、指纹记在 config.json 的 collab_relays，令牌在钥匙串（collab-relay:<地址>）。
令牌不出 Rust：前端只看得到「带没带令牌」，中继码也在这边拆、这边存。
落盘（设计 §3，collab/record.rs）：应用数据目录的 collab/ 下。文档 的状态前端经 collab_send（PIPE_SAVE）
交过来，这里只存字节；主持人的记录 Host 自己写，访客的在这里写。
附件（设计 §7.2）：主持人那边访客要文件、传文件都变成事件到这里（forward_collab），查过
「正文里引用了、落在仓库的「附件」里」再读、再存；访客那边要来的图片缓存在 collab/cache/。 */

const PIPE_UPDATE: u8 = 1;
const PIPE_CURSOR: u8 = 2;
/// Rust → 前端：别人发来了状态向量，回他缺的；前端 → Rust：回给某人的 Sync2
const PIPE_SYNC_REPLY: u8 = 3;
/// Rust → 前端：刚连上某人，把自己的状态向量发给他；前端 → Rust：发给某人的 Sync1
const PIPE_SYNC_VECTOR: u8 = 4;
/// 前端 → Rust：文档 的状态，落盘（崩溃后接得上）
const PIPE_SAVE: u8 = 5;

/// 设备密钥在钥匙串里的名字（ed25519，第一次协作时生成。设计 §8.6）
const DEVICE_KEY: &str = "collab-device-key";
/// 中继令牌在钥匙串里的名字：这个前缀 + 中继地址
const RELAY_TOKEN: &str = "collab-relay:";

/// 加入请求、成员变了、连接状态
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct CollabEvent(pub collab::Control);

/// 点开了一个 odea:// 链接（应用已经开着时）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct CollabLink(pub String);

/// 访客窗口交过来一份要存进仓库的（collab_copy_to_vault）：收到的仓库窗口去取（collab_take_copy）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct CollabCopyReady;

/// 访客窗口里共享的那一篇，存一份到仓库里
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SharedCopy {
    pub title: String,
    pub markdown: String,
    /// 正文里的图片：写的地址 → 从主持人那里要来的（本机缓存的文件，或者 base64）
    pub images: Vec<SharedImage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SharedImage {
    pub source: String,
    pub file: Option<String>,
    pub data: Option<String>,
}

enum Active {
    Host(Host),
    Guest(Guest),
}

#[derive(Default)]
pub struct CollabHub {
    active: Mutex<Option<Active>>,
    /// 会话属于哪个窗口（docs/仓库与启动器.md §4.3）：控制消息和字节只发给它，主持人的附件读写它的仓库
    owner: Mutex<Option<String>>,
    /// 每个窗口登记的接收字节的 Channel（窗口标签 → Channel）
    pipes: Mutex<std::collections::HashMap<String, Channel<InvokeResponseBody>>>,
    /// 冷启动时带进来的链接：前端起来以后取走（collab_pending_link）
    pending_link: Mutex<Option<String>>,
    /// 访客窗口交过来、等着仓库窗口去存的那一份（collab_copy_to_vault）
    pending_copy: Mutex<Option<SharedCopy>>,
    /// 「附近」列表开着时（加入对话框里），和是哪个窗口开的
    nearby: Mutex<Option<collab::nearby::Nearby>>,
    nearby_owner: Mutex<Option<String>>,
    /// 上次没正常结束的做客已经给某个窗口看过了：同时开着几个仓库窗口时只问一次
    guest_resume_offered: std::sync::atomic::AtomicBool,
    /// 主持人：主持的是哪篇、这篇正文里引用了哪些附件
    hosted: Mutex<Option<Hosted>>,
}

/// 主持人这边给访客附件时要查的
struct Hosted {
    note: String,
    /// 正文里写的路径 → 仓库里的相对路径（前端按这篇所在的文件夹算好，正文一变就换一份）
    refs: std::collections::HashMap<String, String>,
}

impl CollabHub {
    pub fn set_pending_link(&self, link: String) {
        *self.pending_link.lock().unwrap() = Some(link);
    }

    /// 冷启动带进来的是一个邀请链接（还没被取走）：一个仓库都打不开的话开访客窗口去加入
    pub fn has_pending_invite(&self) -> bool {
        self.pending_link.lock().unwrap().as_deref().is_some_and(crate::workspace::is_invite)
    }

    /// 要在这个窗口开始一次会话：另一个窗口正在协作就不行（一次只有一个会话）。
    /// 是这个窗口自己的就先收掉（和以前一样：开始新的之前收掉旧的）
    async fn take_over(&self, label: &str) -> Result<()> {
        let busy = self.active.lock().unwrap().is_some();
        let owner = self.owner.lock().unwrap().clone();
        if busy && owner.as_deref().is_some_and(|owner| owner != label) {
            return Err(AppError::Invalid(
                "另一个窗口正在协作。一次只能有一个协作：先在那个窗口里停止或者离开".into(),
            ));
        }
        end_active(self).await;
        *self.owner.lock().unwrap() = Some(label.to_string());
        Ok(())
    }

    /// 会话是不是这个窗口的（没有会话也算：没什么可抢的）
    fn owned_by(&self, label: &str) -> bool {
        self.owner.lock().unwrap().as_deref().is_none_or(|owner| owner == label)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollabIdentity {
    /// 设备公钥（十六进制）：别人那里按它给我挑颜色
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollabHosting {
    pub link: String,
    pub id: String,
    pub members: Vec<MemberInfo>,
}

/// 上次没正常结束的协作（崩溃、强退）：重启后问一句要不要接着来
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollabResume {
    pub host: Option<HostResume>,
    pub guest: Option<GuestResume>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostResume {
    /// 主持的那篇笔记的 id
    pub note: String,
    pub title: String,
    /// 有几位访客（允许过的）
    pub guests: u32,
    /// 最后一次落盘（Unix 毫秒）
    pub saved_at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GuestResume {
    pub title: String,
    pub host_name: String,
    pub saved_at: f64,
}

/// 主持人这篇正文里引用的一个附件
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRef {
    /// 正文里写的（访客按它来要）
    pub path: String,
    /// 仓库里的相对路径（前端按这篇所在的文件夹算好）
    pub vault_path: String,
}

/// 加入之前看一眼链接：带没带中继（访客要知情，设计 §6.5）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InvitePreview {
    /// 主持人配的中继（名字或主机名）
    pub relay: Option<String>,
}

/// 访客的回连链接，和这时自己能不能被连进来
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollabCallback {
    pub link: String,
    pub reach: Reach,
}

/// 一台配好的中继（给界面看：令牌只说有没有）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RelayInfo {
    pub url: String,
    /// 主机名（不是默认端口的带端口）
    pub host: String,
    pub name: Option<String>,
    pub has_token: bool,
    /// 自签名证书、按指纹认的
    pub pinned: bool,
}

impl RelayInfo {
    fn of(relay: &Relay) -> Self {
        RelayInfo {
            url: relay.url.clone(),
            host: relay.host(),
            name: relay.name.clone(),
            has_token: relay.token.is_some(),
            pinned: relay.fingerprint.is_some(),
        }
    }
}

/// 配好的中继：config.json 里的地址 + 钥匙串里的令牌。读不出来的那台跳过
fn load_relays(data_dir: &std::path::Path) -> Vec<Relay> {
    use crate::sync::secret;
    boot::Config::load(data_dir)
        .collab_relays
        .into_iter()
        .filter_map(|saved| {
            let token = secret::load_text(&format!("{RELAY_TOKEN}{}", saved.url)).ok().flatten();
            Relay::new(&saved.url, token, saved.fingerprint.as_deref(), saved.name).ok()
        })
        .collect()
}

/// 存一台（同一个地址的换掉）。令牌进钥匙串，存不进去就整个不存（不然以后连不上又说不清为什么）
fn save_relay(data_dir: &std::path::Path, relay: &Relay) -> Result<()> {
    use crate::sync::secret;
    let account = format!("{RELAY_TOKEN}{}", relay.url);
    match &relay.token {
        Some(token) => secret::save_text(&account, token)
            .map_err(|error| AppError::Io(format!("令牌存不进系统钥匙串：{error}")))?,
        None => {
            let _ = secret::remove(&account);
        }
    }
    let mut config = boot::Config::load(data_dir);
    let saved = boot::SavedRelay {
        url: relay.url.clone(),
        name: relay.name.clone(),
        fingerprint: relay.fingerprint.map(|pin| data_encoding::HEXLOWER.encode(&pin)),
    };
    match config.collab_relays.iter_mut().find(|item| item.url == relay.url) {
        Some(item) => *item = saved,
        None => config.collab_relays.push(saved),
    }
    config.save(data_dir).map_err(|error| AppError::Io(error.to_string()))
}

fn relay_infos(data_dir: &std::path::Path) -> Vec<RelayInfo> {
    load_relays(data_dir).iter().map(RelayInfo::of).collect()
}

/// 落盘的目录：应用数据目录的 collab/
fn collab_dir(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("collab")
}

/// 访客要来的图片缓存在这里（每次加入、离开都清掉）
fn attachment_cache(data_dir: &std::path::Path) -> PathBuf {
    collab_dir(data_dir).join("cache")
}

fn clear_attachment_cache(data_dir: &std::path::Path) {
    let _ = std::fs::remove_dir_all(attachment_cache(data_dir));
}

/// 访客的落盘记录：改一处、写回去（没有就算了）
fn update_guest_record(data_dir: &std::path::Path, change: impl FnOnce(&mut GuestRecord)) {
    let dir = collab_dir(data_dir);
    if let Some(mut record) = collab_record::load_json::<GuestRecord>(&dir, collab_record::GUEST_FILE) {
        change(&mut record);
        record.saved_at = collab_record::now_ms();
        let _ = collab_record::save_json(&dir, collab_record::GUEST_FILE, &record);
    }
}

/// 仓库里的相对路径规范化：反斜杠换成斜杠，`.` 消掉；有 `..`、绝对路径、盘符的一律不认
fn clean_vault_path(path: &str) -> Option<String> {
    let path = path.replace('\\', "/");
    if path.starts_with('/') || path.contains(':') {
        return None;
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => return None,
            part => parts.push(part),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// 主持人：访客要的附件。只给这篇正文里引用了的、规范化之后落在这篇的附件文件夹里的（设计 §7.2；
/// Odea 的仓库是「附件」，Obsidian 的库照它的设置）：不然写个 `../../` 就能读到主持人硬盘上的任意文件，
/// 写个 `其他笔记.md` 就能读到别的笔记
async fn read_attachment(hub: &CollabHub, vault: &Arc<Mutex<Vault>>, path: &str) -> std::result::Result<Vec<u8>, String> {
    let (note, vault_path) = hub
        .hosted
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|hosted| Some((hosted.note.clone(), hosted.refs.get(path).cloned()?)))
        .ok_or_else(|| "这个文件不在这篇正文里".to_string())?;
    let clean = clean_vault_path(&vault_path).ok_or_else(|| "只给这篇笔记的附件".to_string())?;
    let vault = vault.clone();
    let read = tauri::async_runtime::spawn_blocking(move || -> std::result::Result<Vec<u8>, String> {
        let file = vault
            .lock()
            .map_err(|_| "仓库锁坏了".to_string())?
            .attachment_for_guest(&note, &clean)
            .map_err(|error| match error {
                AppError::Invalid(message) => message,
                other => other.to_string(),
            })?;
        let size = std::fs::metadata(&file).map_err(|error| error.to_string())?.len();
        if size > collab::protocol::MAX_ATTACHMENT as u64 {
            return Err("文件太大了，附件最多 50 MB".into());
        }
        std::fs::read(&file).map_err(|error| error.to_string())
    })
    .await;
    read.map_err(|error| error.to_string())?
}

/// 主持人：访客粘贴的文件存进这篇的附件文件夹，回从这篇引用它的路径
async fn store_attachment(
    hub: &CollabHub,
    vault: &Arc<Mutex<Vault>>,
    name: String,
    bytes: Vec<u8>,
) -> std::result::Result<String, String> {
    let note = hub
        .hosted
        .lock()
        .unwrap()
        .as_ref()
        .map(|hosted| hosted.note.clone())
        .ok_or_else(|| "主持人那边不在协作了".to_string())?;
    let vault = vault.clone();
    let stored = tauri::async_runtime::spawn_blocking(move || {
        let mut vault = vault.lock().map_err(|_| "仓库锁坏了".to_string())?;
        vault
            .attach(&DocTarget::Note { id: note }, &name, &bytes)
            .map(|attachment| attachment.link)
            .map_err(|error| error.to_string())
    })
    .await;
    stored.map_err(|error| error.to_string())?
}

/// 设备密钥：钥匙串里有就用，没有就生成一把存进去。钥匙串用不了时用一把临时的
/// （这次能协作，只是下次别人认不出是同一台设备）
fn device_key(data_dir: &std::path::Path) -> iroh::SecretKey {
    use crate::sync::secret;
    // 换了数据目录（开发、测试，boot.rs 的 ODEA_DATA_DIR）：密钥放在那个目录里，不碰系统钥匙串。
    // 同一台电脑上开两个实例互相连（docs/协同编辑.md §19.2）也靠这个：钥匙串里只有一把，两边就成了同一台
    if std::env::var_os("ODEA_DATA_DIR").is_some() {
        let file = collab_dir(data_dir).join("device-key");
        if let Ok(text) = std::fs::read_to_string(&file) {
            if let Ok(bytes) = data_encoding::HEXLOWER.decode(text.trim().as_bytes()) {
                if let Ok(bytes) = <[u8; 32]>::try_from(bytes.as_slice()) {
                    return iroh::SecretKey::from_bytes(&bytes);
                }
            }
        }
        let key = iroh::SecretKey::generate();
        let _ = collab_record::write_atomic(&file, data_encoding::HEXLOWER.encode(&key.to_bytes()).as_bytes());
        return key;
    }
    if let Ok(Some(text)) = secret::load_text(DEVICE_KEY) {
        if let Ok(bytes) = data_encoding::HEXLOWER.decode(text.trim().as_bytes()) {
            if let Ok(bytes) = <[u8; 32]>::try_from(bytes.as_slice()) {
                return iroh::SecretKey::from_bytes(&bytes);
            }
        }
    }
    let key = iroh::SecretKey::generate();
    if let Err(error) = secret::save_text(DEVICE_KEY, &data_encoding::HEXLOWER.encode(&key.to_bytes())) {
        eprintln!("协作：设备密钥存不进钥匙串，这次用临时的：{error}");
    }
    key
}

/// 我的名字：设过就用设的，没设过用系统的用户名
fn collab_name(data_dir: &std::path::Path) -> String {
    boot::Config::load(data_dir)
        .collab_name
        .filter(|name| !name.trim().is_empty())
        .or_else(|| std::env::var("USERNAME").ok().or_else(|| std::env::var("USER").ok()))
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "我".into())
}

/// 会话吐出来的事件：控制消息发事件，字节塞进二进制 Channel；附件请求在这里读仓库、存仓库
fn forward_collab<R: Runtime>(
    app: AppHandle<R>,
    state: &AppState,
    label: String,
    vault: Option<Arc<Mutex<Vault>>>,
    mut events: tokio::sync::mpsc::UnboundedReceiver<collab::Event>,
) {
    let hub = state.collab.clone();
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            let (kind, member, bytes) = match event {
                collab::Event::Control(control) => {
                    note_guest(&hub, &data_dir, &control);
                    if let Err(error) = CollabEvent(control).emit_to(&app, label.as_str()) {
                        eprintln!("通知前端失败: {error}");
                    }
                    continue;
                }
                collab::Event::AttachGet { request, path, .. } => {
                    let (hub, vault) = (hub.clone(), vault.clone());
                    tauri::async_runtime::spawn(async move {
                        let reply = match &vault {
                            Some(vault) => read_attachment(&hub, vault, &path).await,
                            None => Err("这一边没开仓库".to_string()),
                        }
                        .map(AttachReply::Data);
                        if let Some(Active::Host(host)) = hub.active.lock().unwrap().as_ref() {
                            host.answer_attachment(request, reply);
                        }
                    });
                    continue;
                }
                collab::Event::AttachPut { request, name, bytes, .. } => {
                    let (hub, vault) = (hub.clone(), vault.clone());
                    tauri::async_runtime::spawn(async move {
                        let reply = match &vault {
                            Some(vault) => store_attachment(&hub, vault, name, bytes).await,
                            None => Err("这一边没开仓库".to_string()),
                        }
                        .map(AttachReply::Link);
                        if let Some(Active::Host(host)) = hub.active.lock().unwrap().as_ref() {
                            host.answer_attachment(request, reply);
                        }
                    });
                    continue;
                }
                collab::Event::Update { from, bytes } => (PIPE_UPDATE, from, bytes),
                collab::Event::Cursor { from, bytes } => (PIPE_CURSOR, from, bytes),
                collab::Event::SyncRequest { from, vector } => (PIPE_SYNC_REPLY, from, vector),
                collab::Event::SyncStart { with } => (PIPE_SYNC_VECTOR, with, Vec::new()),
            };
            let mut frame = Vec::with_capacity(bytes.len() + 3);
            frame.push(kind);
            frame.extend_from_slice(&member.to_le_bytes());
            frame.extend_from_slice(&bytes);
            if let Some(pipe) = hub.pipes.lock().unwrap().get(&label) {
                let _ = pipe.send(InvokeResponseBody::Raw(frame));
            }
        }
    });
}

/// 访客的落盘记录跟着状态走：进去了记下标题、主持人叫什么；结束了（被拒、被移出、主持人停了）
/// 就没什么可接着的了，删掉
fn note_guest(hub: &CollabHub, data_dir: &std::path::Path, control: &collab::Control) {
    if !matches!(hub.active.lock().unwrap().as_ref(), Some(Active::Guest(_))) {
        return;
    }
    match control {
        collab::Control::Status { status: collab::Status::Connected { title, .. } } => {
            let title = title.clone();
            update_guest_record(data_dir, move |record| record.title = title);
        }
        collab::Control::Members { members } => {
            if let Some(host) = members.iter().find(|member| member.host) {
                let name = host.name.clone();
                update_guest_record(data_dir, move |record| record.host_name = name);
            }
        }
        collab::Control::Status { status: collab::Status::Ended { .. } } => {
            collab_record::remove(&collab_dir(data_dir), Role::Guest);
        }
        _ => {}
    }
}

/// 先把正在进行的会话收掉（主持的停止、做客的离开）。正常结束：落盘的记录删掉
async fn end_active(hub: &CollabHub) {
    let active = hub.active.lock().unwrap().take();
    *hub.hosted.lock().unwrap() = None;
    match active {
        Some(Active::Host(host)) => host.stop().await,
        Some(Active::Guest(guest)) => guest.leave().await,
        None => {}
    }
}

/// 关窗口时：这个窗口的协作也算正常结束（告诉别人、删掉落盘的记录），重启后不再问「继续上次的协作」。
/// 别的窗口的会话不动
pub async fn end_collab(state: &AppState, label: &str) {
    let hub = &state.collab;
    if hub.owner.lock().unwrap().as_deref() == Some(label) {
        let was_guest = matches!(hub.active.lock().unwrap().as_ref(), Some(Active::Guest(_)));
        end_active(hub).await;
        if was_guest {
            collab_record::remove(&collab_dir(&state.data_dir), Role::Guest);
        }
        *hub.owner.lock().unwrap() = None;
    }
    hub.pipes.lock().unwrap().remove(label);
    if hub.nearby_owner.lock().unwrap().as_deref() == Some(label) {
        let nearby = hub.nearby.lock().unwrap().take();
        if let Some(nearby) = nearby {
            nearby.stop().await;
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn collab_identity(state: State<'_, AppState>) -> Result<CollabIdentity> {
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let key = device_key(&data_dir);
        Ok(CollabIdentity {
            id: collab::id_text(key.public().as_bytes()),
            name: collab_name(&data_dir),
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn collab_set_name(state: State<'_, AppState>, name: String) -> Result<()> {
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let mut config = boot::Config::load(&data_dir);
        let name = name.trim().chars().take(40).collect::<String>();
        config.collab_name = (!name.is_empty()).then_some(name);
        config.save(&data_dir).map_err(|error| AppError::Io(error.to_string()))
    })
    .await?;
    // 正在协作：别人那里的成员表跟着换（以前只存了配置，要等下一次协作才生效）
    let name = collab_name(&state.data_dir);
    match state.collab.active.lock().unwrap().as_ref() {
        Some(Active::Host(host)) => host.set_name(&name),
        Some(Active::Guest(guest)) => guest.set_name(&name),
        None => {}
    }
    // 共享仓库：下次握手带新名字；我是管理员的话成员表里的也改掉（设计 §20.6）
    for workspace in state.all_workspaces() {
        if let Some(service) = workspace.share() {
            service.set_name(&name);
        }
    }
    Ok(())
}

/// 开始协作（主持人）：起端点、返回邀请链接。第一次在网络上接受连接时 Windows 会弹防火墙
/// note 是主持的那篇笔记的 id（落盘、存访客粘贴的附件用）；resume = 继续上次没正常结束的那一次
/// （同一个会话 id、邀请密钥、端口，允许过的人不再问）
#[tauri::command]
#[specta::specta]
pub async fn collab_host<R: Runtime>(
    app: AppHandle<R>,
    ws: Ws,
    state: State<'_, AppState>,
    title: String,
    permission: Permission,
    note: String,
    resume: bool,
) -> Result<CollabHosting> {
    state.collab.take_over(&ws.label).await?;
    let data_dir = state.data_dir.clone();
    let (secret_key, name, relays, record) = blocking(move || {
        let dir = collab_dir(&data_dir);
        let record = if resume { collab_record::host_left(&dir) } else { None };
        if !resume {
            collab_record::remove(&dir, Role::Host);
        }
        Ok((device_key(&data_dir), collab_name(&data_dir), load_relays(&data_dir), record))
    })
    .await?;
    let trusted = load_trusted(&state.data_dir)
        .into_iter()
        .filter_map(|peer| Some((collab_record::hex_array(&peer.id)?, peer.permission)))
        .collect();
    let record = record.filter(|record| record.note == note);
    if resume && record.is_none() {
        return Err(AppError::NotFound("上次协作的记录已经没了".into()));
    }
    let (events, receiver) = tokio::sync::mpsc::unbounded_channel();
    let options = HostOptions {
        secret_key,
        name,
        title,
        permission,
        mdns: true,
        relays,
        portmap: true,
        firewall: true,
        note: note.clone(),
        record: Some(collab_dir(&state.data_dir)),
        resume: record,
        trusted,
    };
    let host = Host::start(options, events).await.map_err(AppError::Io)?;
    *state.collab.hosted.lock().unwrap() = Some(Hosted { note, refs: Default::default() });
    forward_collab(app, &state, ws.label.clone(), Some(ws.vault.clone()), receiver);
    let hosting = CollabHosting { link: host.invite().to_link(), id: host.id(), members: host.members() };
    *state.collab.active.lock().unwrap() = Some(Active::Host(host));
    Ok(hosting)
}

/// 换掉邀请链接：旧的作废，已经在里面的人不受影响
#[tauri::command]
#[specta::specta]
pub async fn collab_reset_invite(state: State<'_, AppState>) -> Result<String> {
    match state.collab.active.lock().unwrap().as_ref() {
        Some(Active::Host(host)) => Ok(host.reset_invite().to_link()),
        _ => Err(AppError::Invalid("现在没有在主持协作".into())),
    }
}

/// 链接认不认得出（加入之前先问一句：坏链接当场说清楚，不用等连接）；带没带中继
#[tauri::command]
#[specta::specta]
pub async fn collab_check_link(link: String) -> Result<InvitePreview> {
    let invite = Invite::parse(&link).map_err(|error| AppError::Invalid(error.to_string()))?;
    Ok(InvitePreview { relay: invite.relay.map(|relay| relay.label()) })
}

/// 加入（访客）：马上返回，进展从 CollabEvent 的 status 里出来。
/// direct_only：不经链接里主持人的中继（访客的 IP 不让那台机器看到，设计 §6.5）
#[tauri::command]
#[specta::specta]
pub async fn collab_join<R: Runtime>(
    app: AppHandle<R>,
    caller: Caller,
    state: State<'_, AppState>,
    link: String,
    direct_only: bool,
) -> Result<()> {
    let invite = Invite::parse(&link).map_err(|error| AppError::Invalid(error.to_string()))?;
    join_with(app, &state, &caller.label, invite, false, direct_only).await
}

/// 加入（链接的、附近的、继续上次的都走这里）：先记下怎么加入的（崩溃后接得上），再起访客
async fn join_with<R: Runtime>(
    app: AppHandle<R>,
    state: &AppState,
    label: &str,
    invite: Invite,
    nearby: bool,
    direct_only: bool,
) -> Result<()> {
    state.collab.take_over(label).await?;
    let data_dir = state.data_dir.clone();
    let link = invite.to_link();
    let (secret_key, name, relays) = blocking(move || {
        let dir = collab_dir(&data_dir);
        // 上一次做客的状态还留着的话（继续上次的）前端已经读走了：这里重新记一份
        collab_record::remove(&dir, Role::Guest);
        clear_attachment_cache(&data_dir);
        let record = GuestRecord::new(link, nearby, direct_only);
        let _ = collab_record::save_json(&dir, collab_record::GUEST_FILE, &record);
        Ok((device_key(&data_dir), collab_name(&data_dir), load_relays(&data_dir)))
    })
    .await?;
    let (events, receiver) = tokio::sync::mpsc::unbounded_channel();
    // 做客的这一边没有附件要读写（那是主持人的事），用不着仓库
    forward_collab(app, state, label.to_string(), None, receiver);
    let options = GuestOptions {
        secret_key,
        name,
        invite,
        mdns: true,
        use_host_relay: !direct_only,
        relays,
        portmap: true,
        nearby,
    };
    let guest = Guest::join(options, events).await.map_err(AppError::Io)?;
    *state.collab.active.lock().unwrap() = Some(Active::Guest(guest));
    Ok(())
}

/* ---------------- 附近（设计 §8.3） ---------------- */

/// 开始看同一个网络里谁在分享（加入对话框开着时）。列表从 CollabEvent 的 nearby 里出来
#[tauri::command]
#[specta::specta]
pub async fn collab_nearby_start<R: Runtime>(app: AppHandle<R>, caller: Caller, state: State<'_, AppState>) -> Result<()> {
    *state.collab.nearby_owner.lock().unwrap() = Some(caller.label.clone());
    if state.collab.nearby.lock().unwrap().is_some() {
        return Ok(());
    }
    let label = caller.label.clone();
    let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel::<collab::Event>();
    let nearby = collab::nearby::Nearby::start(events).await.map_err(AppError::Io)?;
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            if let collab::Event::Control(control) = event {
                let _ = CollabEvent(control).emit_to(&app, label.as_str());
            }
        }
    });
    let old = state.collab.nearby.lock().unwrap().replace(nearby);
    if let Some(old) = old {
        old.stop().await;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn collab_nearby_stop(state: State<'_, AppState>) -> Result<()> {
    let nearby = state.collab.nearby.lock().unwrap().take();
    if let Some(nearby) = nearby {
        nearby.stop().await;
    }
    Ok(())
}

/// 点了「附近」列表里的一位：不用链接，请求加入（主持人照样确认）
#[tauri::command]
#[specta::specta]
pub async fn collab_join_nearby<R: Runtime>(app: AppHandle<R>, caller: Caller, state: State<'_, AppState>, id: String) -> Result<()> {
    let nearby = state.collab.nearby.lock().unwrap().take();
    let Some(nearby) = nearby else {
        return Err(AppError::Invalid("「附近」列表已经关了，再打开一次".into()));
    };
    let invite = nearby.invite(&id);
    nearby.stop().await;
    let invite = invite.ok_or_else(|| AppError::NotFound("对方已经不在分享了".into()))?;
    join_with(app, &state, &caller.label, invite, true, false).await
}

/* ---------------- 落盘、继续上次的协作（设计 §3） ---------------- */

/// 上次没正常结束的协作（主持、做客各最多一份）
#[tauri::command]
#[specta::specta]
pub async fn collab_resume_info(caller: Caller, state: State<'_, AppState>) -> Result<CollabResume> {
    use std::sync::atomic::Ordering;
    let data_dir = state.data_dir.clone();
    let busy = state.collab.active.lock().unwrap().is_some();
    // 几个仓库窗口同时开着：主持的那一次只在那篇笔记所在的仓库里问（访客窗口没有仓库，不问）；
    // 做客的只问第一个来问的窗口
    let vault = caller.workspace.as_ref().map(|workspace| workspace.vault.clone());
    let hub = state.collab.clone();
    blocking(move || {
        if busy {
            return Ok(CollabResume { host: None, guest: None });
        }
        let dir = collab_dir(&data_dir);
        let here = |note: &str| vault.as_ref().is_some_and(|vault| vault.lock().is_ok_and(|vault| vault.note_get(note).is_ok()));
        let host = collab_record::host_left(&dir).filter(|record| here(&record.note)).map(|record| HostResume {
            note: record.note,
            title: record.title,
            guests: record.approved.len() as u32,
            saved_at: record.saved_at as f64,
        });
        let offered = hub.guest_resume_offered.load(Ordering::SeqCst);
        let guest = collab_record::guest_left(&dir).filter(|_| !offered).map(|record| GuestResume {
            title: record.title,
            host_name: record.host_name,
            saved_at: record.saved_at as f64,
        });
        if guest.is_some() {
            hub.guest_resume_offered.store(true, Ordering::SeqCst);
        }
        Ok(CollabResume { host, guest })
    })
    .await
}

/// 访客：继续上次没正常结束的做客（前端先读走了落盘的状态，用它建好了会话）
#[tauri::command]
#[specta::specta]
pub async fn collab_rejoin<R: Runtime>(app: AppHandle<R>, caller: Caller, state: State<'_, AppState>) -> Result<()> {
    let data_dir = state.data_dir.clone();
    let record = blocking(move || Ok(collab_record::guest_left(&collab_dir(&data_dir)))).await?;
    let record = record.ok_or_else(|| AppError::NotFound("上次做客的记录已经没了".into()))?;
    let invite = Invite::parse(&record.link).map_err(|error| AppError::Invalid(error.to_string()))?;
    join_with(app, &state, &caller.label, invite, record.nearby, record.direct_only).await
}

/// 不接着来了：落盘的那一份删掉
#[tauri::command]
#[specta::specta]
pub async fn collab_discard_resume(state: State<'_, AppState>, host: bool) -> Result<()> {
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let role = if host { Role::Host } else { Role::Guest };
        collab_record::remove(&collab_dir(&data_dir), role);
        Ok(())
    })
    .await
}

/// 落盘的 文档 状态（不经 tauri-specta：原始字节）。host = 主持的那一份，否则做客的
#[tauri::command]
pub fn collab_resume_state(state: State<'_, AppState>, host: bool) -> std::result::Result<tauri::ipc::Response, String> {
    let role = if host { Role::Host } else { Role::Guest };
    collab_record::load_state(&collab_dir(&state.data_dir), role)
        .map(tauri::ipc::Response::new)
        .ok_or_else(|| "上次协作的状态已经没了".to_string())
}

/* ---------------- 附件（设计 §7.2） ---------------- */

/// 主持人：这篇正文里引用的附件（正文一变前端就给一份新的）。只有在这里面的访客才要得到
#[tauri::command]
#[specta::specta]
pub async fn collab_set_attachment_refs(state: State<'_, AppState>, refs: Vec<AttachmentRef>) -> Result<()> {
    if let Some(hosted) = state.collab.hosted.lock().unwrap().as_mut() {
        hosted.refs = refs.into_iter().map(|item| (item.path, item.vault_path)).collect();
    }
    Ok(())
}

/// 访客：向主持人要正文里引用的一个附件，缓存下来，返回本机的路径（前端转成 asset 地址显示）
#[tauri::command]
#[specta::specta]
pub async fn collab_fetch_attachment(state: State<'_, AppState>, path: String) -> Result<String> {
    let attachments = match state.collab.active.lock().unwrap().as_ref() {
        Some(Active::Guest(guest)) => guest.attachments(),
        _ => return Err(AppError::Invalid("现在没有在别人那里做客".into())),
    };
    let bytes = attachments.fetch(&path).await.map_err(AppError::Io)?;
    let dir = attachment_cache(&state.data_dir);
    blocking(move || {
        // 一个路径一个文件夹（按路径算），里面的文件名跟着正文里写的走：「存一份到我的笔记」
        // 按路径存进自己的「附件」时，文件名还是原来那个。扩展名留着：asset 协议按扩展名放行图片
        let digest = ring::digest::digest(&ring::digest::SHA256, path.as_bytes());
        let folder = data_encoding::HEXLOWER.encode(&digest.as_ref()[..12]);
        let file = dir.join(folder).join(collab_record::cached_name(&path));
        collab_record::write_atomic(&file, &bytes).map_err(|error| AppError::Io(error.to_string()))?;
        Ok(file.to_string_lossy().replace('\\', "/"))
    })
    .await
}

/// 访客：粘贴的文件交给主持人存进他的「附件」，返回从那篇引用它的路径（编辑器插进正文）
#[tauri::command]
#[specta::specta]
pub async fn collab_put_attachment(state: State<'_, AppState>, name: String, data_base64: String) -> Result<Attachment> {
    use base64::Engine;
    let bytes = blocking(move || {
        base64::engine::general_purpose::STANDARD
            .decode(data_base64.trim())
            .map_err(|error| AppError::Invalid(format!("附件内容不是 base64: {error}")))
    })
    .await?;
    put_attachment(&state, name, bytes).await
}

/// 访客：从系统拖进来的文件（只有路径）
#[tauri::command]
#[specta::specta]
pub async fn collab_put_attachment_path(state: State<'_, AppState>, path: String) -> Result<Attachment> {
    let source = PathBuf::from(&path);
    let name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| AppError::Invalid(format!("不是文件: {path}")))?;
    let bytes = blocking(move || {
        let size = std::fs::metadata(&source)?.len();
        if size > collab::protocol::MAX_ATTACHMENT as u64 {
            return Err(AppError::Invalid(format!("「{}」太大了，附件最多 50 MB", source.display())));
        }
        Ok(std::fs::read(&source)?)
    })
    .await?;
    put_attachment(&state, name, bytes).await
}

async fn put_attachment(state: &AppState, name: String, bytes: Vec<u8>) -> Result<Attachment> {
    let attachments = match state.collab.active.lock().unwrap().as_ref() {
        Some(Active::Guest(guest)) => guest.attachments(),
        _ => return Err(AppError::Invalid("现在没有在别人那里做客".into())),
    };
    let link = attachments.put(&name, bytes).await.map_err(AppError::Io)?;
    let file = link.rsplit('/').next().unwrap_or(&link).to_string();
    let ext = std::path::Path::new(&file)
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    Ok(Attachment {
        is_image: crate::vault::IMAGE_EXTENSIONS.contains(&ext.as_str()),
        name: file,
        link,
    })
}

/// 访客连不上主持人时：生成回连链接发给主持人（设计 §8.4）。要等端口映射、中继有个结果，最多五秒
#[tauri::command]
#[specta::specta]
pub async fn collab_callback(state: State<'_, AppState>) -> Result<CollabCallback> {
    // 锁不跨 await：拿一个生成回连链接的把手出来，会话照常留在 active 里收发
    let maker = match state.collab.active.lock().unwrap().as_ref() {
        Some(Active::Guest(guest)) => guest.callbacks(),
        _ => return Err(AppError::Invalid("现在没有在加入协作".into())),
    };
    let callback = maker.make().await;
    Ok(CollabCallback { link: callback.link, reach: callback.reach })
}

/// 访客：转发链接（设计 §20.9）。发给连不上主持人、却连得上我的人，他经我加入（主持人照样确认）。
/// 和回连链接一样先看我能不能被连进来
#[tauri::command]
#[specta::specta]
pub async fn collab_forward_link(state: State<'_, AppState>) -> Result<CollabCallback> {
    let maker = match state.collab.active.lock().unwrap().as_ref() {
        Some(Active::Guest(guest)) => guest.callbacks(),
        _ => return Err(AppError::Invalid("现在没有在加入协作".into())),
    };
    let link = maker.forward_link().await;
    Ok(CollabCallback { link: link.link, reach: link.reach })
}

/// 主持人打开了回连链接：往访客那边拨。拨的结果从 CollabEvent 的 dialBack 里出来
#[tauri::command]
#[specta::specta]
pub async fn collab_dial_back(state: State<'_, AppState>, link: String) -> Result<()> {
    let callback = Callback::parse(&link).map_err(|error| AppError::Invalid(error.to_string()))?;
    match state.collab.active.lock().unwrap().as_ref() {
        Some(Active::Host(host)) => host.dial_back(callback).map_err(AppError::Invalid),
        _ => Err(AppError::Invalid("回连链接要在主持协作时打开：先在那篇笔记上「邀请协作」".into())),
    }
}

/* ---------------- 协作中继（设计 §6.4） ---------------- */

#[tauri::command]
#[specta::specta]
pub async fn collab_relays(state: State<'_, AppState>) -> Result<Vec<RelayInfo>> {
    let data_dir = state.data_dir.clone();
    blocking(move || Ok(relay_infos(&data_dir))).await
}

/// 中继码里是哪一台（添加之前给用户看一眼、确认）
#[tauri::command]
#[specta::specta]
pub async fn collab_relay_inspect(code: String) -> Result<RelayInfo> {
    let relay = Relay::parse_code(&code).map_err(|error| AppError::Invalid(error.to_string()))?;
    Ok(RelayInfo::of(&relay))
}

/// 添加中继：粘的中继码（code），或者手填的地址、令牌、指纹、名字
#[tauri::command]
#[specta::specta]
pub async fn collab_relay_add(
    state: State<'_, AppState>,
    code: Option<String>,
    url: Option<String>,
    token: Option<String>,
    fingerprint: Option<String>,
    name: Option<String>,
) -> Result<Vec<RelayInfo>> {
    let relay = match code {
        Some(code) => Relay::parse_code(&code).map_err(|error| AppError::Invalid(error.to_string()))?,
        None => Relay::new(url.as_deref().unwrap_or_default(), token, fingerprint.as_deref(), name)
            .map_err(|error| AppError::Invalid(error.to_string()))?,
    };
    let data_dir = state.data_dir.clone();
    blocking(move || {
        save_relay(&data_dir, &relay)?;
        Ok(relay_infos(&data_dir))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn collab_relay_remove(state: State<'_, AppState>, url: String) -> Result<Vec<RelayInfo>> {
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let mut config = boot::Config::load(&data_dir);
        config.collab_relays.retain(|item| item.url != url);
        config.save(&data_dir).map_err(|error| AppError::Io(error.to_string()))?;
        let _ = crate::sync::secret::remove(&format!("{RELAY_TOKEN}{url}"));
        Ok(relay_infos(&data_dir))
    })
    .await
}

/// 这台中继的中继码（带令牌）：发给团队里的其他人
#[tauri::command]
#[specta::specta]
pub async fn collab_relay_code(state: State<'_, AppState>, url: String) -> Result<String> {
    let data_dir = state.data_dir.clone();
    blocking(move || {
        load_relays(&data_dir)
            .into_iter()
            .find(|relay| relay.url == url)
            .map(|relay| relay.to_code())
            .ok_or_else(|| AppError::NotFound("这台中继已经删掉了".into()))
    })
    .await
}

/// 测试一台中继：连一下，报延迟、令牌对不对、UDP 7842 通不通（最多等八秒）
#[tauri::command]
#[specta::specta]
pub async fn collab_relay_test(state: State<'_, AppState>, url: String) -> Result<RelayCheck> {
    let data_dir = state.data_dir.clone();
    let relay = blocking(move || {
        load_relays(&data_dir)
            .into_iter()
            .find(|relay| relay.url == url)
            .ok_or_else(|| AppError::NotFound("这台中继已经删掉了".into()))
    })
    .await?;
    Ok(collab::relays::check(&relay, Duration::from_secs(8)).await)
}

/// 主持人回答加入请求：allow 是给的权限，None 是拒绝
#[tauri::command]
#[specta::specta]
pub async fn collab_answer(state: State<'_, AppState>, request: u32, allow: Option<Permission>) -> Result<bool> {
    let decision = allow.map_or(Decision::Reject, Decision::Allow);
    Ok(match state.collab.active.lock().unwrap().as_ref() {
        Some(Active::Host(host)) => host.answer(request, decision),
        _ => false,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn collab_set_permission(state: State<'_, AppState>, member: u16, permission: Permission) -> Result<()> {
    let changed = match state.collab.active.lock().unwrap().as_ref() {
        Some(Active::Host(host)) => {
            host.set_permission(member, permission);
            host.members().into_iter().find(|item| item.member == member)
        }
        _ => None,
    };
    // 记住过的人：以后进来也按改过的权限
    if let Some(changed) = changed {
        let data_dir = state.data_dir.clone();
        blocking(move || {
            update_trusted(&data_dir, |list| {
                if let Some(peer) = list.iter_mut().find(|peer| peer.id == changed.id) {
                    peer.edit = permission == Permission::Edit;
                }
            })
        })
        .await?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn collab_kick(state: State<'_, AppState>, member: u16) -> Result<()> {
    let kicked = match state.collab.active.lock().unwrap().as_ref() {
        Some(Active::Host(host)) => host.kick(member),
        _ => None,
    };
    // 移出了就不再记住（Host 那边已经忘了）
    if let Some(id) = kicked {
        let id = collab::id_text(&id);
        let data_dir = state.data_dir.clone();
        blocking(move || update_trusted(&data_dir, |list| list.retain(|peer| peer.id != id))).await?;
    }
    Ok(())
}

/* ---------------- 记住的人（设计 §8.2） ---------------- */

fn load_trusted(data_dir: &std::path::Path) -> Vec<TrustedPeer> {
    boot::Config::load(data_dir)
        .collab_trusted
        .into_iter()
        .filter(|saved| collab_record::hex_array::<32>(&saved.id).is_some())
        .map(|saved| TrustedPeer {
            id: saved.id,
            name: saved.name,
            permission: if saved.edit { Permission::Edit } else { Permission::Read },
        })
        .collect()
}

/// 改 config.json 里记住的人，返回改完的整张表
fn update_trusted(
    data_dir: &std::path::Path,
    change: impl FnOnce(&mut Vec<boot::SavedPeer>),
) -> Result<Vec<TrustedPeer>> {
    let mut config = boot::Config::load(data_dir);
    change(&mut config.collab_trusted);
    config.save(data_dir).map_err(|error| AppError::Io(error.to_string()))?;
    Ok(load_trusted(data_dir))
}

/// 主持人记住的人
#[tauri::command]
#[specta::specta]
pub async fn collab_trusted(state: State<'_, AppState>) -> Result<Vec<TrustedPeer>> {
    let data_dir = state.data_dir.clone();
    blocking(move || Ok(load_trusted(&data_dir))).await
}

/// 记住一个人：下次拿着链接或者从「附近」进来不问，按这个权限进来。返回整张表
#[tauri::command]
#[specta::specta]
pub async fn collab_remember(
    state: State<'_, AppState>,
    id: String,
    name: String,
    permission: Permission,
) -> Result<Vec<TrustedPeer>> {
    let key: [u8; 32] = collab_record::hex_array(&id).ok_or_else(|| AppError::Invalid("不是设备公钥".into()))?;
    if let Some(Active::Host(host)) = state.collab.active.lock().unwrap().as_ref() {
        host.trust(key, permission);
    }
    let data_dir = state.data_dir.clone();
    blocking(move || {
        update_trusted(&data_dir, |list| {
            list.retain(|peer| peer.id != id);
            list.push(boot::SavedPeer {
                id,
                name: collab::clean_name(&name),
                edit: permission == Permission::Edit,
            });
        })
    })
    .await
}

/// 不再记住：下次进来照样问。返回整张表
#[tauri::command]
#[specta::specta]
pub async fn collab_forget(state: State<'_, AppState>, id: String) -> Result<Vec<TrustedPeer>> {
    if let (Some(key), Some(Active::Host(host))) = (
        collab_record::hex_array::<32>(&id),
        state.collab.active.lock().unwrap().as_ref(),
    ) {
        host.forget(&key);
    }
    let data_dir = state.data_dir.clone();
    blocking(move || update_trusted(&data_dir, |list| list.retain(|peer| peer.id != id))).await
}

/// 主持人改了标题：之后进来的人看到新的
#[tauri::command]
#[specta::specta]
pub async fn collab_set_title(state: State<'_, AppState>, title: String) -> Result<()> {
    if let Some(Active::Host(host)) = state.collab.active.lock().unwrap().as_ref() {
        host.set_title(title);
    }
    Ok(())
}

/// 停止协作（主持人）/ 离开（访客）
#[tauri::command]
#[specta::specta]
pub async fn collab_stop(caller: Caller, state: State<'_, AppState>) -> Result<()> {
    // 别的窗口的会话不归这个窗口停
    if state.collab.owned_by(&caller.label) {
        end_active(&state.collab).await;
        *state.collab.owner.lock().unwrap() = None;
    }
    state.collab.pipes.lock().unwrap().remove(&caller.label);
    Ok(())
}

/// 访客窗口（没开仓库）里「存一份到我的笔记」：交给最近用过的仓库窗口去存 —— 一个都没开着就先打开
/// 最近的仓库。那个窗口收到 CollabCopyReady 以后来取（collab_take_copy），新建一篇、存图片、存正文
#[tauri::command]
#[specta::specta]
pub async fn collab_copy_to_vault<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, copy: SharedCopy) -> Result<()> {
    *state.collab.pending_copy.lock().unwrap() = Some(copy);
    let handle = app.clone();
    let label = blocking(move || crate::workspace::recent_vault_window(&handle)).await?;
    if let Err(error) = CollabCopyReady.emit_to(&app, label.as_str()) {
        eprintln!("通知前端失败: {error}");
    }
    Ok(())
}

/// 访客窗口交过来、等着存的那一份（取一次就清掉）
#[tauri::command]
#[specta::specta]
pub async fn collab_take_copy(state: State<'_, AppState>) -> Result<Option<SharedCopy>> {
    Ok(state.collab.pending_copy.lock().unwrap().take())
}

/// 冷启动时点进来的 odea:// 链接（取一次就清掉）
#[tauri::command]
#[specta::specta]
pub async fn collab_pending_link(state: State<'_, AppState>) -> Result<Option<String>> {
    Ok(state.collab.pending_link.lock().unwrap().take())
}

/// 前端登记接收字节的 Channel（不经 tauri-specta）
#[tauri::command]
pub fn collab_pipe(window: tauri::WebviewWindow, state: State<'_, AppState>, channel: Channel<InvokeResponseBody>) {
    state.collab.pipes.lock().unwrap().insert(window.label().to_string(), channel);
}

/// 前端发出来的字节（不经 tauri-specta：原始请求体，不是一字节一个数字的 JSON 数组）
#[tauri::command]
pub fn collab_send(state: State<'_, AppState>, request: Request<'_>) -> std::result::Result<(), String> {
    let InvokeBody::Raw(frame) = request.body() else {
        return Err("collab_send 要原始字节".into());
    };
    let (&kind, rest) = frame.split_first().ok_or("空帧")?;
    let (head, payload) = rest.split_at_checked(2).ok_or("帧太短")?;
    let member = u16::from_le_bytes([head[0], head[1]]);
    let active = state.collab.active.lock().unwrap();
    if kind == PIPE_SAVE {
        // 文档 的状态落盘：在阻塞线程里写，不卡 IPC
        let role = match active.as_ref() {
            Some(Active::Host(_)) => Role::Host,
            Some(Active::Guest(_)) => Role::Guest,
            None => return Ok(()),
        };
        let dir = collab_dir(&state.data_dir);
        let bytes = payload.to_vec();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = collab_record::save_state(&dir, role, &bytes) {
                eprintln!("协作：会话状态写不进去：{error}");
            }
        });
        return Ok(());
    }
    match (active.as_ref(), kind) {
        (Some(Active::Host(host)), PIPE_UPDATE) => host.send_update(payload.to_vec()),
        (Some(Active::Host(host)), PIPE_CURSOR) => host.send_cursor(payload),
        (Some(Active::Host(host)), PIPE_SYNC_VECTOR) => host.send_sync(member, SyncKind::Vector, payload.to_vec()),
        (Some(Active::Host(host)), PIPE_SYNC_REPLY) => host.send_sync(member, SyncKind::Reply, payload.to_vec()),
        (Some(Active::Guest(guest)), PIPE_UPDATE) => guest.send_update(payload.to_vec()),
        (Some(Active::Guest(guest)), PIPE_CURSOR) => guest.send_cursor(payload),
        (Some(Active::Guest(guest)), PIPE_SYNC_VECTOR) => guest.send_sync(SyncKind::Vector, payload.to_vec()),
        (Some(Active::Guest(guest)), PIPE_SYNC_REPLY) => guest.send_sync(SyncKind::Reply, payload.to_vec()),
        _ => {}
    }
    Ok(())
}

/* ---------------- 共享仓库（docs/协同编辑.md §20） ----------------
后台服务在 share/（Share），这里接到前端：
- 成员、加入请求、状态变了：事件 ShareChanged（没有内容），前端重新取 share_info
- 前端那份 Loro 副本的增量、光标：和协作一样不走 JSON —— Rust → 前端走前端登记的二进制 Channel
  （share_pipe），前端 → Rust 走原始请求体（share_send），打开一篇时的快照是原始字节（share_doc_open）。
  帧：1 字节类型 + 1 字节文档 id 长度 + 文档 id + 内容；光标帧的内容前面还有 64 字节对方的公钥（十六进制）
- 每个共享仓库在这台设备上一把自己的密钥，存在应用数据目录的 share/<共享 id>.key（不在仓库里：
  仓库可能被拷走、放进网盘）
- 共享仓库不开 git 同步（设计 §20.1）：开着同步不让共享，共享着不让开同步 */

const SHARE_PIPE_UPDATE: u8 = 1;
const SHARE_PIPE_CURSOR: u8 = 2;

/// 共享仓库的成员、连接、加入请求、状态变了
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct ShareChanged;

/// 共享仓库里一篇的一版（P10.3.4）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShareVersion {
    /// 这一版第一次、最后一次改动的时间（毫秒）
    pub from: i64,
    pub to: i64,
    /// 谁改的（成员表里的名字；认不出的是 None）
    pub name: Option<String>,
    pub device: Option<String>,
    /// 这一版的样子（base64），看全文、恢复时交回来
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SharePreview {
    /// 仓库名
    pub name: String,
    pub role: share::Role,
}

struct ShareSink<R: Runtime> {
    app: AppHandle<R>,
    label: String,
    pipe: Arc<Mutex<Option<Channel<InvokeResponseBody>>>>,
}

fn share_frame(kind: u8, doc: &str, head: &[u8], payload: &[u8]) -> Vec<u8> {
    let doc = &doc.as_bytes()[..doc.len().min(255)];
    let mut frame = Vec::with_capacity(2 + doc.len() + head.len() + payload.len());
    frame.push(kind);
    frame.push(doc.len() as u8);
    frame.extend_from_slice(doc);
    frame.extend_from_slice(head);
    frame.extend_from_slice(payload);
    frame
}

impl<R: Runtime> share::Sink for ShareSink<R> {
    fn doc_update(&self, doc: &str, bytes: &[u8]) {
        if let Some(pipe) = self.pipe.lock().unwrap().as_ref() {
            let _ = pipe.send(InvokeResponseBody::Raw(share_frame(SHARE_PIPE_UPDATE, doc, &[], bytes)));
        }
    }

    fn cursor(&self, doc: &str, from: &str, payload: &[u8]) {
        if let Some(pipe) = self.pipe.lock().unwrap().as_ref() {
            let _ = pipe.send(InvokeResponseBody::Raw(share_frame(SHARE_PIPE_CURSOR, doc, from.as_bytes(), payload)));
        }
    }

    fn changed(&self) {
        if let Err(error) = ShareChanged.emit_to(&self.app, self.label.as_str()) {
            eprintln!("通知前端失败: {error}");
        }
    }
}

fn share_key_file(data_dir: &std::path::Path, share_id: &str) -> PathBuf {
    data_dir.join("share").join(format!("{share_id}.key"))
}

/// 这个共享仓库在这台设备上的密钥：有就读，没有就生成一把存下
fn share_key(data_dir: &std::path::Path, share_id: &str) -> iroh::SecretKey {
    let file = share_key_file(data_dir, share_id);
    if let Ok(text) = std::fs::read_to_string(&file) {
        if let Ok(bytes) = data_encoding::HEXLOWER.decode(text.trim().as_bytes()) {
            if let Ok(bytes) = <[u8; 32]>::try_from(bytes.as_slice()) {
                return iroh::SecretKey::from_bytes(&bytes);
            }
        }
    }
    let key = iroh::SecretKey::generate();
    let _ = collab_record::write_atomic(&file, data_encoding::HEXLOWER.encode(&key.to_bytes()).as_bytes());
    key
}

fn share_sink<R: Runtime>(app: &AppHandle<R>, ws: &Workspace) -> Arc<dyn share::Sink> {
    Arc::new(ShareSink {
        app: app.clone(),
        label: ws.label.clone(),
        pipe: ws.share_pipe.clone(),
    })
}

/// 仓库窗口打开（换上）一个仓库：是共享仓库就把后台服务起来
pub fn start_share<R: Runtime>(app: &AppHandle<R>, data_dir: &std::path::Path, ws: &Arc<Workspace>) {
    let root = ws.root();
    let Some(share_id) = share::service::share_key_name(&root) else { return };
    let (app, data_dir, ws) = (app.clone(), data_dir.to_path_buf(), ws.clone());
    tauri::async_runtime::spawn(async move {
        let options = share::ShareOptions {
            key: share_key(&data_dir, &share_id),
            name: collab_name(&data_dir),
            relays: load_relays(&data_dir),
            mdns: true,
        };
        match share::Share::open(ws.vault.clone(), &root, options, share_sink(&app, &ws)).await {
            Ok(service) => {
                // 起来之前窗口已经换了仓库：不要了
                if ws.root() != root {
                    service.close().await;
                    return;
                }
                *ws.share.lock().unwrap() = Some(Arc::new(service));
                let _ = ShareChanged.emit_to(&app, ws.label.as_str());
            }
            Err(error) => eprintln!("共享仓库没能启动：{error}"),
        }
    });
}

/// 停掉这个窗口的共享仓库服务（落盘、断开）
pub fn stop_share(ws: &Workspace) {
    let service = ws.share.lock().ok().and_then(|mut slot| slot.take());
    if let Some(service) = service {
        tauri::async_runtime::spawn(async move { service.close().await });
    }
}

fn need_share(ws: &Workspace) -> Result<Arc<share::Share>> {
    ws.share().ok_or_else(|| AppError::Invalid("这个仓库没有共享".into()))
}

fn share_err(error: String) -> AppError {
    AppError::Invalid(error)
}

/// 这个仓库的共享状态（不是共享仓库是 null）
#[tauri::command]
#[specta::specta]
pub async fn share_info(ws: Ws) -> Result<Option<share::ShareInfo>> {
    Ok(ws.share().map(|service| service.info()))
}

/// 把这个仓库共享出去（设计 §20.8 最后一条）：逻辑目录、没开同步、不在网盘里
#[tauri::command]
#[specta::specta]
pub async fn share_create<R: Runtime>(app: AppHandle<R>, ws: Ws, state: State<'_, AppState>) -> Result<share::ShareInfo> {
    if ws.share().is_some() {
        return Err(AppError::Invalid("这个仓库已经共享了".into()));
    }
    let root = ws.root();
    if let Some(drive) = setup::cloud_drive_of(&root) {
        return Err(AppError::Invalid(format!(
            "仓库在{drive}的同步目录里。网盘和共享二选一：网盘会把 .odea/share 里的文件来回拷，两边对不上。先把仓库换到网盘外面"
        )));
    }
    if !matches!(ws.sync.status().state, SyncState::Off) {
        return Err(AppError::Invalid("这个仓库开着同步。共享和同步二选一：先在同步设置里断开同步".into()));
    }
    let name = root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "共享仓库".into());
    // 密钥按共享 id 存：共享 id 建的时候才有，先生成、建好以后存下来
    let key = iroh::SecretKey::generate();
    let options = share::ShareOptions {
        key: key.clone(),
        name: collab_name(&state.data_dir),
        relays: load_relays(&state.data_dir),
        mdns: true,
    };
    let service = share::Share::create(ws.vault.clone(), &root, &name, options, share_sink(&app, &ws))
        .await
        .map_err(share_err)?;
    let info = service.info();
    collab_record::write_atomic(
        &share_key_file(&state.data_dir, &info.id),
        data_encoding::HEXLOWER.encode(&key.to_bytes()).as_bytes(),
    )
    .map_err(|error| AppError::Io(error.to_string()))?;
    *ws.share.lock().unwrap() = Some(Arc::new(service));
    // 这个窗口里别处订阅着的（侧栏的小标记）跟着刷新
    let _ = ShareChanged.emit_to(&app, ws.label.as_str());
    Ok(info)
}

/// 邀请链接（管理员）
#[tauri::command]
#[specta::specta]
pub async fn share_invite_link(ws: Ws) -> Result<String> {
    need_share(&ws)?.invite_link().map_err(share_err)
}

/// 重置邀请链接（以前发出去的作废），顺便定进来以后默认的角色
#[tauri::command]
#[specta::specta]
pub async fn share_reset_invite(ws: Ws, role: share::Role) -> Result<String> {
    need_share(&ws)?.reset_invite(role).map_err(share_err)
}

/// 回答加入请求：role 是 null 就是拒绝
#[tauri::command]
#[specta::specta]
pub async fn share_answer(ws: Ws, request: u32, role: Option<share::Role>) -> Result<bool> {
    Ok(need_share(&ws)?.answer(request, role))
}

/// 改成员的角色；role 是 null 就是移出
#[tauri::command]
#[specta::specta]
pub async fn share_set_role(ws: Ws, member: String, role: Option<share::Role>) -> Result<()> {
    need_share(&ws)?.set_role(&member, role).map_err(share_err)
}

/// 看一眼邀请链接：是哪个仓库、进去以后是什么角色
#[tauri::command]
#[specta::specta]
pub async fn share_check_link(link: String) -> Result<SharePreview> {
    let invite = share::ShareInvite::parse(&link).map_err(|error| AppError::Invalid(error.to_string()))?;
    Ok(SharePreview {
        name: invite.name,
        role: invite.role,
    })
}

/// 加入一个共享仓库：选一个文件夹，在里面新建一个以仓库名命名的空文件夹，摆好、在新窗口里打开。
/// 之后那个窗口的后台服务拿着链接去拨邀请人、等他同意。取消选文件夹返回 null，否则返回窗口标签
#[tauri::command]
#[specta::specta]
pub async fn share_join<R: Runtime>(app: AppHandle<R>, link: String) -> Result<Option<String>> {
    let invite = share::ShareInvite::parse(&link).map_err(|error| AppError::Invalid(error.to_string()))?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("把共享仓库放在哪个文件夹里")
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });
    let Some(folder) = rx.await.ok().flatten() else { return Ok(None) };
    let parent = folder.into_path().map_err(|error| AppError::Invalid(error.to_string()))?;
    let name = layout::folder_name(&invite.name).unwrap_or_else(|| "共享仓库".into());
    let root = (1..)
        .map(|n| if n == 1 { parent.join(&name) } else { parent.join(format!("{name} {n}")) })
        .find(|path| !path.exists())
        .expect("总有一个没被占的名字");
    if let Some(drive) = setup::cloud_drive_of(&root) {
        return Err(AppError::Invalid(format!("{drive}的同步目录里不能放共享仓库，换一个文件夹")));
    }
    let app_handle = app.clone();
    blocking(move || {
        share::prepare_join(&root, &invite, &link)?;
        let (label, _) = crate::workspace::open_vault(
            &app_handle,
            &root,
            crate::workspace::Open {
                seed: false,
                remember: true,
                quiet: true,
                logical: true,
            },
        )?;
        Ok(Some(label))
    })
    .await
}

/// 这台设备不再共享：停掉服务、删掉 .odea/share。文件都留着，成了一个普通的逻辑目录。
/// 别人那里我还在成员表里（管理员可以把我移出）
#[tauri::command]
#[specta::specta]
pub async fn share_leave(ws: Ws) -> Result<()> {
    let service = ws.share.lock().unwrap().take();
    if let Some(service) = service {
        service.close().await;
    }
    let root = ws.root();
    blocking(move || {
        let dir = share::share_dir(&root);
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        Ok(())
    })
    .await
}

/// 共享仓库里一篇的历史（P10.3.4）：同一台设备、停顿不超过 5 分钟的改动并成一版，旧的在前
#[tauri::command]
#[specta::specta]
pub async fn share_history(ws: Ws, doc: String) -> Result<Vec<ShareVersion>> {
    use base64::Engine;
    let service = need_share(&ws)?;
    let names = service.member_names();
    Ok(service
        .history(&doc)
        .into_iter()
        .map(|version| ShareVersion {
            from: version.from,
            to: version.to,
            name: version.device.as_ref().and_then(|device| names.get(device).cloned()),
            device: version.device,
            version: base64::engine::general_purpose::STANDARD.encode(&version.frontiers),
        })
        .collect())
}

fn decode_version(version: &str) -> Result<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(version)
        .map_err(|_| AppError::Invalid("版本不对".into()))
}

/// 某一版时的全文
#[tauri::command]
#[specta::specta]
pub async fn share_version_text(ws: Ws, doc: String, version: String) -> Result<String> {
    let frontiers = decode_version(&version)?;
    need_share(&ws)?.text_at(&doc, &frontiers).map_err(share_err)
}

/// 恢复到某一版（一次新的改动，别人那里也恢复）
#[tauri::command]
#[specta::specta]
pub async fn share_restore(ws: Ws, doc: String, version: String) -> Result<()> {
    let frontiers = decode_version(&version)?;
    need_share(&ws)?.restore(&doc, &frontiers).map_err(share_err)
}

/// 关掉一篇（前端那份扔了）
#[tauri::command]
#[specta::specta]
pub async fn share_doc_close(ws: Ws, doc: String) -> Result<()> {
    if let Some(service) = ws.share() {
        service.close_doc(&doc);
    }
    Ok(())
}

/// 打开共享仓库里的一篇（不经 tauri-specta：原始字节）：8 字节给前端用的 peer（小端）+ 快照
#[tauri::command]
pub async fn share_doc_open(ws: Ws, doc: String) -> std::result::Result<tauri::ipc::Response, String> {
    let service = ws.share().ok_or("这个仓库没有共享")?;
    let (snapshot, peer) = service.open_doc(&doc).await?;
    let mut out = Vec::with_capacity(8 + snapshot.len());
    out.extend_from_slice(&peer.to_le_bytes());
    out.extend_from_slice(&snapshot);
    Ok(tauri::ipc::Response::new(out))
}

/// 前端登记接收共享仓库字节的 Channel（不经 tauri-specta）
#[tauri::command]
pub fn share_pipe(ws: Ws, channel: Channel<InvokeResponseBody>) {
    *ws.share_pipe.lock().unwrap() = Some(channel);
}

/// 前端发出来的字节（不经 tauri-specta：原始请求体）。帧同 share_pipe
#[tauri::command]
pub fn share_send(ws: Ws, request: Request<'_>) -> std::result::Result<(), String> {
    let InvokeBody::Raw(frame) = request.body() else {
        return Err("share_send 要原始字节".into());
    };
    let (&kind, rest) = frame.split_first().ok_or("空帧")?;
    let (&len, rest) = rest.split_first().ok_or("帧太短")?;
    let (doc, payload) = rest.split_at_checked(len as usize).ok_or("帧太短")?;
    let doc = std::str::from_utf8(doc).map_err(|_| "文档 id 不对")?;
    let service = ws.share().ok_or("这个仓库没有共享")?;
    match kind {
        SHARE_PIPE_UPDATE => service.push(doc, payload),
        SHARE_PIPE_CURSOR => {
            service.send_cursor(doc, payload);
            Ok(())
        }
        _ => Ok(()),
    }
}
