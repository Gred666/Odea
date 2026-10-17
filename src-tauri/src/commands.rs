use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
use tauri_specta::Event;

use crate::boot;
use crate::domain::model::*;
use crate::domain::validate_date;
use crate::error::{AppError, Result};
use crate::state::AppState;
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

pub fn announcer<R: Runtime>(app: AppHandle<R>) -> Announce {
    Arc::new(move |change| {
        if let Err(error) = VaultChanged(change).emit(&app) {
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

async fn with_vault<T, F>(state: &AppState, f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&mut Vault) -> Result<T> + Send + 'static,
{
    let vault = state.vault.clone();
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
pub async fn note_list(state: State<'_, AppState>, archived: bool) -> Result<Vec<NoteSummary>> {
    with_vault(&state, move |v| v.note_list(archived)).await
}

#[tauri::command]
#[specta::specta]
pub async fn note_get(state: State<'_, AppState>, id: String) -> Result<Note> {
    with_vault(&state, move |v| v.note_get(&id)).await
}

/// id 为 null 是新建（返回新 id）；否则改标题和正文，标题变了文件跟着改名
#[tauri::command]
#[specta::specta]
pub async fn note_upsert(state: State<'_, AppState>, input: NoteInput) -> Result<String> {
    if input.title.trim().is_empty() && input.content_md.trim().is_empty() {
        return Err(AppError::Invalid("标题和正文不能同时为空".into()));
    }
    with_vault(&state, move |v| match input.id {
        Some(id) => v.note_update(&id, &input.title, &input.content_md).map(|()| id),
        None => v.note_create(&input.title, &input.content_md),
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn note_set_pinned(state: State<'_, AppState>, id: String, pinned: bool) -> Result<()> {
    with_vault(&state, move |v| v.note_set_pinned(&id, pinned)).await
}

#[tauri::command]
#[specta::specta]
pub async fn note_archive(
    state: State<'_, AppState>,
    id: String,
    category: Option<String>,
) -> Result<()> {
    with_vault(&state, move |v| v.note_archive(&id, category)).await
}

#[tauri::command]
#[specta::specta]
pub async fn note_restore(state: State<'_, AppState>, id: String) -> Result<()> {
    with_vault(&state, move |v| v.note_restore(&id)).await
}

/// 删除 = 挪进仓库的回收站（.odea/trash/，30 天后清掉）
#[tauri::command]
#[specta::specta]
pub async fn note_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    with_vault(&state, move |v| v.note_delete(&id)).await
}

// 删除后的「撤销」
#[tauri::command]
#[specta::specta]
pub async fn note_undelete(state: State<'_, AppState>, id: String) -> Result<()> {
    with_vault(&state, move |v| v.note_undelete(&id)).await
}

/// 在某个文件夹里新建一篇空笔记（folder 相对「笔记」，空串是「笔记」本身），返回新 id
#[tauri::command]
#[specta::specta]
pub async fn note_create(state: State<'_, AppState>, folder: String, title: String) -> Result<String> {
    with_vault(&state, move |v| v.note_create_in(&folder, &title, "")).await
}

/// 挪到另一个文件夹，返回挪完的笔记（relPath 变了，正文里的相对链接可能也改了）
#[tauri::command]
#[specta::specta]
pub async fn note_move(state: State<'_, AppState>, id: String, folder: String) -> Result<Note> {
    with_vault(&state, move |v| v.note_move(&id, &folder)).await
}

/* ---------------- 文件夹（「笔记」下面的子目录） ---------------- */

#[tauri::command]
#[specta::specta]
pub async fn folder_list(state: State<'_, AppState>) -> Result<Vec<String>> {
    with_vault(&state, |v| Ok(v.folders())).await
}

/// 返回新文件夹的路径（重名时加了序号）
#[tauri::command]
#[specta::specta]
pub async fn folder_create(state: State<'_, AppState>, parent: String, name: String) -> Result<String> {
    with_vault(&state, move |v| v.folder_create(&parent, &name)).await
}

/// 返回改名后的路径（重名时加了序号）
#[tauri::command]
#[specta::specta]
pub async fn folder_rename(state: State<'_, AppState>, folder: String, name: String) -> Result<String> {
    with_vault(&state, move |v| v.folder_rename(&folder, &name)).await
}

/// 里面的笔记进回收站；返回值原样交给 folder_undelete 就能撤销
#[tauri::command]
#[specta::specta]
pub async fn folder_delete(state: State<'_, AppState>, folder: String) -> Result<FolderDeletion> {
    with_vault(&state, move |v| v.folder_delete(&folder)).await
}

#[tauri::command]
#[specta::specta]
pub async fn folder_undelete(state: State<'_, AppState>, deletion: FolderDeletion) -> Result<()> {
    with_vault(&state, move |v| v.folder_undelete(&deletion)).await
}

/// 在系统的文件管理器里打开这个文件夹
#[tauri::command]
#[specta::specta]
pub async fn folder_reveal(state: State<'_, AppState>, folder: String) -> Result<()> {
    let path = with_vault(&state, move |v| v.locate_folder(&folder)).await?;
    blocking(move || {
        tauri_plugin_opener::open_path(&path, None::<&str>)
            .map_err(|error| AppError::Io(format!("打开文件夹失败: {error}")))
    })
    .await
}

/// 反向链接：正文里写了 `[[这篇的标题]]` 的文档
#[tauri::command]
#[specta::specta]
pub async fn note_backlinks(state: State<'_, AppState>, id: String) -> Result<Vec<Backlink>> {
    with_vault(&state, move |v| v.backlinks(&id)).await
}

/// 笔记改了标题之后，别处的 `[[旧标题]]` 改成新标题（Vault::relink）
#[tauri::command]
#[specta::specta]
pub async fn note_relink(state: State<'_, AppState>, id: String, old_title: String) -> Result<Relink> {
    with_vault(&state, move |v| v.relink(&id, &old_title)).await
}

/// 撤销 note_relink：返回换回了几篇
#[tauri::command]
#[specta::specta]
pub async fn note_relink_undo(state: State<'_, AppState>, rewrites: Vec<LinkRewrite>) -> Result<i64> {
    with_vault(&state, move |v| v.relink_undo(&rewrites)).await
}

/* ---------------- 历史版本（技术方案 §5.9.11） ---------------- */

/// 最多列这么多个版本
const HISTORY_LIMIT: usize = 200;

/// 一篇文档的历史版本，新的在前。没开启同步（仓库根上没有 .git）时说一声
#[tauri::command]
#[specta::specta]
pub async fn doc_history(state: State<'_, AppState>, target: DocTarget) -> Result<DocHistory> {
    // 只在找路径时持仓库锁；翻 git 历史另开一个 Repository，不持锁
    let (root, rel, id) = with_vault(&state, move |v| v.history_source(&target)).await?;
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
pub async fn doc_version_text(state: State<'_, AppState>, blob: String) -> Result<String> {
    let root = with_vault(&state, |v| Ok(v.root().to_path_buf())).await?;
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
    state: State<'_, AppState>,
    query: String,
    limit: u32,
    archived_only: bool,
) -> Result<TextSearch> {
    use std::sync::atomic::Ordering;
    let counter = &TEXT_SEARCH_GEN[archived_only as usize];
    let generation = counter.fetch_add(1, Ordering::SeqCst) + 1;
    let limit = limit.clamp(1, 1000) as usize;
    let root = with_vault(&state, |v| Ok(v.root().to_path_buf())).await?;
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
    state: State<'_, AppState>,
    query: String,
    options: FindOptions,
) -> Result<FindResult> {
    use std::sync::atomic::Ordering;
    let generation = FIND_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let root = with_vault(&state, |v| Ok(v.root().to_path_buf())).await?;
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
pub async fn task_toggle(state: State<'_, AppState>, id: String) -> Result<Task> {
    with_vault(&state, move |v| v.toggle_task(&id)).await
}

/* ---------------- 目标 ---------------- */

/// 某个周期的目标。period_start 由前端按 horizon 算好（周一 / 1 号 / 1 月 1 日），
/// 这里校验它确实是周期起点。没写过的周期返回空文档。
#[tauri::command]
#[specta::specta]
pub async fn goal_get(
    state: State<'_, AppState>,
    horizon: String,
    period_start: String,
) -> Result<Goal> {
    validate_date(&period_start)?;
    with_vault(&state, move |v| v.goal(&horizon, &period_start)).await
}

#[tauri::command]
#[specta::specta]
pub async fn goal_save(
    state: State<'_, AppState>,
    horizon: String,
    period_start: String,
    content_md: String,
) -> Result<Goal> {
    validate_date(&period_start)?;
    with_vault(&state, move |v| v.save_goal(&horizon, &period_start, &content_md)).await
}

/* ---------------- 日历 ---------------- */

/// `carry_over` 只在请求「今天」时传 true：今天还没写过就延续之前最近的一天。
#[tauri::command]
#[specta::specta]
pub async fn calendar_day(
    state: State<'_, AppState>,
    date: String,
    carry_over: bool,
) -> Result<DayDoc> {
    validate_date(&date)?;
    with_vault(&state, move |v| v.day(&date, carry_over)).await
}

#[tauri::command]
#[specta::specta]
pub async fn calendar_day_save(
    state: State<'_, AppState>,
    date: String,
    title: String,
    note_md: String,
) -> Result<DayDoc> {
    validate_date(&date)?;
    with_vault(&state, move |v| v.save_day(&date, &title, &note_md)).await
}

/// 月网格上的记号：写过记录 / 做过事的日子，和还有待办的日子
#[tauri::command]
#[specta::specta]
pub async fn calendar_marks(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<CalendarMarks> {
    validate_date(&from)?;
    validate_date(&to)?;
    with_vault(&state, move |v| v.calendar_marks(&from, &to)).await
}

/// 所有写过的某一天、某个周期的目标，连同正文（命令面板搜它们）
#[tauri::command]
#[specta::specta]
pub async fn journal_list(state: State<'_, AppState>) -> Result<Vec<JournalDoc>> {
    with_vault(&state, |v| v.journal_list()).await
}

/* ---------------- 使用指南（vault/guide.rs） ---------------- */

/// 用户改过、而这个版本带着新版的使用指南：前端在那一篇上问换不换
#[tauri::command]
#[specta::specta]
pub async fn guide_pending(state: State<'_, AppState>) -> Result<Vec<GuideUpdate>> {
    with_vault(&state, |v| v.guide_pending()).await
}

/// 用户看过新版了（换上了，或者留着自己的）：到下一次升级前不再问
#[tauri::command]
#[specta::specta]
pub async fn guide_settle(state: State<'_, AppState>, id: String) -> Result<()> {
    with_vault(&state, move |v| v.guide_settle(&id)).await
}

/// 命令面板「使用指南」：那一篇的 id，删掉了就重新放一篇
#[tauri::command]
#[specta::specta]
pub async fn guide_open(state: State<'_, AppState>, name: String) -> Result<String> {
    with_vault(&state, move |v| v.guide_open(&name)).await
}

/* ---------------- 仓库文件夹 ---------------- */

#[tauri::command]
#[specta::specta]
pub async fn vault_info(state: State<'_, AppState>) -> Result<VaultInfo> {
    with_vault(&state, |v| v.info()).await
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
pub async fn index_progress(state: State<'_, AppState>) -> Result<Option<IndexProgress>> {
    Ok(state
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
                let _ = IndexProgress { done, total }.emit(&app);
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
            if let Err(error) = (IndexProgress { done: total, total }).emit(&app) {
                eprintln!("通知前端失败: {error}");
            }
        }
    });
}

/// 在系统的文件管理器里定位这篇文档的文件（选中它）。还没写过的某一天 /
/// 某个周期没有文件，打开它将来所在的文件夹。
#[tauri::command]
#[specta::specta]
pub async fn vault_reveal(state: State<'_, AppState>, target: DocTarget) -> Result<()> {
    let (path, is_file) = with_vault(&state, move |v| v.locate(&target)).await?;
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
pub async fn vault_open_folder(state: State<'_, AppState>) -> Result<()> {
    let root = with_vault(&state, |v| Ok(v.root().to_path_buf())).await?;
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
    state: State<'_, AppState>,
    target: DocTarget,
) -> Result<Option<String>> {
    with_vault(&state, move |v| v.keep_conflict_copy(&target)).await
}

/// 粘贴进来的文件（剪贴板里的图片）存进「附件」文件夹。内容以 base64 传过来 ——
/// 一个字节一个数字的 JSON 数组，几 MB 的截图要序列化成几千万个字符。
#[tauri::command]
#[specta::specta]
pub async fn vault_attach(
    state: State<'_, AppState>,
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
    with_vault(&state, move |v| v.attach(&target, &name, &bytes)).await
}

/// 拖进窗口的文件（桌面端拿到的是路径）存进「附件」文件夹
#[tauri::command]
#[specta::specta]
pub async fn vault_attach_path(
    state: State<'_, AppState>,
    target: DocTarget,
    path: String,
) -> Result<Attachment> {
    with_vault(&state, move |v| v.attach_path(&target, std::path::Path::new(&path))).await
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

/// 新装第一次打开（放了示例内容的那一次）：笔记文件夹在哪。只给一次 —— 前端拿去提示
/// 「笔记存在这里，要不要换个位置」，换完整页重载后不会再出（技术方案 §5.7）
#[tauri::command]
#[specta::specta]
pub async fn vault_first_run(state: State<'_, AppState>) -> Result<Option<String>> {
    Ok(state
        .first_run
        .lock()
        .map_err(|_| AppError::Internal("首次启动的标记锁坏了".into()))?
        .take())
}

/// 换一个文件夹当仓库。弹系统的选择文件夹对话框；新文件夹里没有笔记的话，现在的笔记
/// 搬过去（原来的进回收站）、复制过去（原来的不动）还是不带（`mode` 决定问不问）。
/// 取消了返回 null。前端拿到结果后整页重载。
#[tauri::command]
#[specta::specta]
pub async fn vault_change_root<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    mode: ChangeRootMode,
) -> Result<Option<VaultInfo>> {
    let current = with_vault(&state, |v| Ok(v.root().to_path_buf())).await?;

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
        return with_vault(&state, |v| v.info()).await.map(Some);
    }
    let canonical = |p: &std::path::Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let (new_canonical, current_canonical) = (canonical(&new_root), canonical(&current));
    if new_canonical.starts_with(&current_canonical) || current_canonical.starts_with(&new_canonical) {
        return Err(AppError::Invalid(
            "新文件夹不能在现在的笔记文件夹里面，也不能包着它".into(),
        ));
    }

    // 新文件夹里已经有笔记（别的仓库、Obsidian 的文件夹）：直接用它，现在的不动
    // 改名前的仓库标记在 .ontheway/ 里，打开时才搬过来（boot::prepare）
    let target_is_vault = fsio::has_markdown(&new_root)
        || fsio::abs(&new_root, layout::VAULT_MARKER).exists()
        || new_root.join(crate::old_name::VAULT_DIR).join("vault.json").exists();
    if target_is_vault {
        return switch_vault(&app, &state, new_root).await.map(Some);
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
        Bring::Move => move_vault_to(&app, &state, current, new_root).await.map(Some),
        Bring::Copy => {
            let (from, to) = (current.clone(), new_root.clone());
            blocking(move || boot::copy_vault(&from, &to).map(|_| ())).await?;
            switch_vault(&app, &state, new_root).await.map(Some)
        }
        Bring::Nothing => switch_vault(&app, &state, new_root).await.map(Some),
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
    current: PathBuf,
    new_root: PathBuf,
) -> Result<VaultInfo> {
    // Windows 上还开着的句柄（文件监听、同步线程里的 git 仓库）会让改名失败：先停掉
    *state
        .watcher
        .lock()
        .map_err(|_| AppError::Internal("监听锁坏了".into()))? = None;
    state.sync.stop();

    let (from, to) = (current.clone(), new_root.clone());
    let moved = blocking(move || {
        boot::move_vault(&from, &to, |path| trash::delete(path).map_err(|error| error.to_string()))
    })
    .await;
    let moved = match moved {
        Ok(moved) => moved,
        Err(error) => {
            // 原来的仓库没动：监听和同步照旧起来
            if let Err(restart) = switch_vault(app, state, current).await {
                eprintln!("搬不过去之后恢复原来的仓库也失败了: {restart}");
            }
            return Err(error);
        }
    };

    // 仓库已经不在原处了：先记下新位置。后面哪一步失败，下次启动也得去新位置找，
    // 不然会在原处新建一个空仓库，看着像笔记没了
    let (data_dir, root) = (state.data_dir.clone(), new_root.clone());
    blocking(move || {
        let mut config = boot::Config::load(&data_dir);
        config.vault_root = Some(root);
        config.save(&data_dir)
    })
    .await?;
    let info = switch_vault(app, state, new_root.clone()).await?;

    if let boot::Moved::CopiedKeptOriginal(reason) = moved {
        let teller = app.clone();
        let text = format!(
            "笔记已经搬到「{}」了，但原来的文件夹没能放进回收站：{reason}\n\n可以自己把它删掉：{}",
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

/// 换到另一个仓库文件夹：准备好、打开、停旧的监听和同步、换上新的、起新的监听和同步、存配置。
/// 换仓库的命令和「第二台设备接入同步」（clone 到新文件夹）都走这里；之后前端整页重载
async fn switch_vault<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    new_root: PathBuf,
) -> Result<VaultInfo> {
    let data_dir = state.data_dir.clone();
    let root = new_root.clone();
    // 换到一个装满笔记的文件夹（比如 Obsidian 的）：文件多的话后台慢慢读，前端整页重载后看到进度
    let (vault, backlog) = blocking(move || {
        let mut config = boot::Config::load(&data_dir);
        boot::prepare(&root, &data_dir, &mut config, false)?;
        let opened = Vault::open_quick(&root, &boot::index_path(&data_dir, &root))?;
        config.vault_root = Some(root);
        config.save(&data_dir)?;
        Ok(opened)
    })
    .await?;

    // 先停旧的监听和同步，再换仓库
    *state
        .watcher
        .lock()
        .map_err(|_| AppError::Internal("监听锁坏了".into()))? = None;
    state.sync.stop();
    {
        let mut current = state
            .vault
            .lock()
            .map_err(|_| AppError::Internal("仓库锁坏了".into()))?;
        *current = vault;
        current.set_announcer(announcer(app.clone()));
    }
    spawn_backlog(app.clone(), state.vault.clone(), state.indexing.clone(), backlog);
    match watch::start(state.vault.clone(), Some(sync_poke(&state.sync))) {
        Ok(watcher) => {
            *state
                .watcher
                .lock()
                .map_err(|_| AppError::Internal("监听锁坏了".into()))? = Some(watcher);
        }
        Err(error) => eprintln!("{error}"),
    }
    // 新仓库自己开了同步（拷过来的、或者以前同步过的）就接着同步
    let (hub, vault, hooks) = (state.sync.clone(), state.vault.clone(), sync_hooks(app.clone(), state.data_dir.clone()));
    blocking(move || {
        if let Err(error) = hub.start(vault, hooks) {
            eprintln!("同步没能启动: {error}");
        }
        Ok(())
    })
    .await?;
    with_vault(state, |v| v.info()).await
}

/* ---------------- 同步（技术方案 §5.9） ---------------- */

/// 同步状态变了
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct SyncStatusChanged(pub SyncStatus);

/// 同步要告诉用户的一句话：冲突副本、超限的文件没同步、仓库快满了
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct SyncNotice(pub String);

/// 同步线程往外发东西的口子：状态、提示，和每轮要的令牌与代理
pub fn sync_hooks<R: Runtime>(app: AppHandle<R>, data_dir: PathBuf) -> Hooks {
    let status_app = app.clone();
    Hooks {
        status: Arc::new(move |status| {
            if let Err(error) = SyncStatusChanged(status.clone()).emit(&status_app) {
                eprintln!("通知前端失败: {error}");
            }
        }),
        notice: Arc::new(move |text| {
            if let Err(error) = SyncNotice(text).emit(&app) {
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

fn sync_http(data_dir: &std::path::Path) -> SyncResult<Http> {
    Http::new(proxy::resolve(boot::Config::load(data_dir).sync_proxy.as_deref()).as_deref())
}

fn provider_of(key: &str) -> Result<Provider> {
    Provider::parse(key).ok_or_else(|| AppError::Invalid(format!("不认识的托管方: {key}")))
}

/// 这个托管方登录的是哪个账号
fn login_of(data_dir: &std::path::Path, provider: Provider) -> Result<String> {
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
pub async fn sync_status(state: State<'_, AppState>) -> Result<SyncStatus> {
    Ok(state.sync.status())
}

/// 立即同步一轮。没开同步返回 false
#[tauri::command]
#[specta::specta]
pub async fn sync_now(state: State<'_, AppState>) -> Result<bool> {
    Ok(state.sync.sync_now())
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
    state: State<'_, AppState>,
    provider: String,
    clone_url: String,
) -> Result<SyncPlan> {
    let provider = provider_of(&provider)?;
    let data_dir = state.data_dir.clone();
    let root = with_vault(&state, |v| Ok(v.root().to_path_buf())).await?;
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
    state: State<'_, AppState>,
    provider: String,
    clone_url: String,
    bring_local: bool,
) -> Result<bool> {
    let provider = provider_of(&provider)?;
    let data_dir = state.data_dir.clone();
    let root = with_vault(&state, |v| Ok(v.root().to_path_buf())).await?;
    if let Some(drive) = setup::cloud_drive_of(&root) {
        return Err(AppError::Invalid(format!(
            "笔记文件夹在{drive}的同步目录里。网盘和同步二选一：网盘会来回拷 .git，迟早把它弄坏。先把笔记文件夹换到网盘外面（命令面板「更换笔记文件夹…」）"
        )));
    }
    let login = login_of(&data_dir, provider)?;
    state.sync.stop();
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
            switch_vault(&app, &state, target).await?;
            Ok(true)
        }
        None => {
            let (hub, vault, hooks) = (
                state.sync.clone(),
                state.vault.clone(),
                sync_hooks(app.clone(), data_dir),
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
pub async fn sync_disable(state: State<'_, AppState>) -> Result<SyncStatus> {
    state.sync.stop();
    let root = with_vault(&state, |v| Ok(v.root().to_path_buf())).await?;
    blocking(move || Ok(setup::disconnect(&root)?)).await?;
    Ok(state.sync.status())
}
