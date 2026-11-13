use super::*;

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

/// 改正文（编辑器的保存），返回存完的笔记。base 是编辑器照着改的那一版正文的指纹（fsio::fingerprint）：
/// 磁盘上已经不是那一版了，先把磁盘上的另存成冲突副本再写（Vault::note_save）
#[tauri::command]
#[specta::specta]
pub async fn note_save(ws: Ws, id: String, content_md: String, base: Option<String>) -> Result<Note> {
    with_vault(&ws, move |v| v.note_save(&id, &content_md, base.as_deref())).await
}

/// 改标题：文件跟着改名，正文不动。返回改完的笔记
#[tauri::command]
#[specta::specta]
pub async fn note_rename(ws: Ws, id: String, title: String) -> Result<Note> {
    with_vault(&ws, move |v| v.note_rename(&id, &title)).await
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

// 删除后的「撤销」，回收站里的「恢复」
#[tauri::command]
#[specta::specta]
pub async fn note_undelete(ws: Ws, id: String) -> Result<()> {
    with_vault(&ws, move |v| v.note_undelete(&id)).await
}

/// 回收站里的笔记，最近删的在前
#[tauri::command]
#[specta::specta]
pub async fn trash_list(ws: Ws) -> Result<Vec<TrashedNote>> {
    with_vault(&ws, |v| v.trash_list()).await
}

/* ---------------- 做客时本机留的一份（keep.rs，docs/协同编辑.md §24） ---------------- */

#[tauri::command]
#[specta::specta]
pub async fn guest_copy_put(state: State<'_, AppState>, copy: GuestCopy) -> Result<()> {
    let data_dir = state.data_dir.clone();
    blocking(move || keep::put(&data_dir, &copy)).await
}

#[tauri::command]
#[specta::specta]
pub async fn guest_copy_drop(state: State<'_, AppState>, key: String) -> Result<()> {
    let data_dir = state.data_dir.clone();
    blocking(move || keep::drop_copy(&data_dir, &key)).await
}

#[tauri::command]
#[specta::specta]
pub async fn guest_copy_list(state: State<'_, AppState>) -> Result<Vec<GuestCopy>> {
    let data_dir = state.data_dir.clone();
    blocking(move || Ok(keep::list(&data_dir))).await
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

/// 整个仓库里的附件（图片、PDF、文档、音视频……，相对仓库的路径）：Obsidian 的 `![[图.png]]`、
/// `![[说明书.pdf]]` 只写文件名，前端按名字在这里面找。扫描时顺带收集的，多了、少了发 vault-changed（attachments）
#[tauri::command]
#[specta::specta]
pub async fn vault_attachments(ws: Ws) -> Result<Vec<String>> {
    with_vault(&ws, |v| Ok(v.attachments())).await
}

/// 附件清单里的一个文件（`![[说明书.pdf]]` 的卡片、`[[说明书.pdf]]` 双链）：`reveal` 在文件管理器里定位它，
/// 否则用系统的默认程序打开。只认清单里有的（Vault::attachment_path）
#[tauri::command]
#[specta::specta]
pub async fn vault_attachment_open(ws: Ws, rel_path: String, reveal: bool) -> Result<()> {
    let path = with_vault(&ws, move |v| v.attachment_path(&rel_path)).await?;
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
pub async fn doc_history(ws: Ws, target: DocRef) -> Result<DocHistory> {
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
        let login = SyncRepo::open(&root).ok().flatten().and_then(|repo| repo.config_get(LOGIN_KEY));
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
                let (person, device) = crate::sync::engine::author_parts(&version.author);
                let person = person.filter(|person| Some(*person) != login.as_deref()).map(str::to_string);
                DocVersion {
                    blob: version.blob.to_string(),
                    time: version.time,
                    mine: device == me && person.is_none(),
                    device: device.to_string(),
                    person,
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

/// 搜正文：大小写不敏感的子串，笔记（含归档）和插件的文档（日记、目标）各自最多 limit 条；archived_only
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
    // 开着的插件的文档类型拿一份走（给插件的文档起标题），搜的时候不占仓库的锁
    let (root, types) = with_vault(&ws, |v| Ok((v.root().to_path_buf(), v.layout().types.clone()))).await?;
    let path = boot::index_path(&state.data_dir, &root);
    blocking(move || {
        let cancelled = || counter.load(Ordering::SeqCst) != generation;
        with_search_db(path, &cancelled, |conn| {
            crate::vault::search_text(conn, &query, limit, archived_only, &types, cancelled)
        })
    })
    .await
}

/// 全局搜索（Ctrl+Shift+F，像 VS Code 的「在文件中查找」）：笔记（含归档）、插件的文档（日记、目标）的正文里
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
    let (root, types) = with_vault(&ws, |v| Ok((v.root().to_path_buf(), v.layout().types.clone()))).await?;
    let path = boot::index_path(&state.data_dir, &root);
    blocking(move || {
        let cancelled = || FIND_GEN.load(Ordering::SeqCst) != generation;
        with_search_db(path, &cancelled, |conn| {
            crate::vault::find_text(conn, &query, options, &types, cancelled)
        })
    })
    .await
}

/* ---------------- 插件的文档（docs/插件与跨端.md §6.1） ---------------- */

/// 所有写过东西的插件文档（某一天、某个周期的目标……，不带正文），最近改过的在前：命令面板按标题搜它们
#[tauri::command]
#[specta::specta]
pub async fn doc_list(ws: Ws) -> Result<Vec<TypedDoc>> {
    with_vault(&ws, |v| v.doc_list()).await
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
