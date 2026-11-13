use super::*;

/* ---------------- 仓库文件夹 ---------------- */

#[tauri::command]
#[specta::specta]
pub async fn vault_info(ws: Ws) -> Result<VaultInfo> {
    with_vault(&ws, |v| v.info()).await
}

/// 开 / 关一个插件（docs/插件与跨端.md §6.2；日程是 `odea.journal`，docs/仓库与启动器.md §6）：改仓库标记，
/// 每个文件按新的摆法重新认一遍（文件一个都不动）。文件多的话剩下的在后台读，和打开仓库时一样报进度
#[tauri::command]
#[specta::specta]
pub async fn vault_set_plugin<R: Runtime>(app: AppHandle<R>, ws: Ws, plugin: String, on: bool) -> Result<VaultInfo> {
    let backlog = with_vault(&ws, move |v| v.set_plugin(&plugin, on)).await?;
    spawn_backlog(app, ws.label.clone(), ws.vault.clone(), ws.indexing.clone(), backlog);
    with_vault(&ws, |v| v.info()).await
}

/// 开 / 关一个第三方插件（L0 声明，docs/插件与跨端.md §6.3）：只改仓库标记里它那一项（version：仓库要的
/// 版本范围，`^0.1`；不给就留着原来的）。文件不用重新认，前端也不用重载
#[tauri::command]
#[specta::specta]
pub async fn vault_set_extension(ws: Ws, id: String, on: bool, version: Option<String>) -> Result<VaultInfo> {
    with_vault(&ws, move |v| {
        v.set_extension(&id, on, version.as_deref())?;
        v.info()
    })
    .await
}

/// 开 / 关归档：和开关日程一样，改标记、重新认文件，前端整页重载
#[tauri::command]
#[specta::specta]
pub async fn vault_set_archive<R: Runtime>(app: AppHandle<R>, ws: Ws, on: bool) -> Result<VaultInfo> {
    let backlog = with_vault(&ws, move |v| v.set_archive(on)).await?;
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

/* ---------------- 属性（docs/提醒与属性.md §3，vault/properties.rs） ---------------- */

/// 一篇的属性：属性块里用户自己的那几行（应用的 id、created 这些不在里面）
#[tauri::command]
#[specta::specta]
pub async fn doc_properties(ws: Ws, target: DocRef) -> Result<crate::vault::properties::DocProperties> {
    with_vault(&ws, move |v| v.doc_properties(&target)).await
}

/// 换掉一篇的属性：只动属性块里用户自己的那几行，正文、应用的键一个字不动
#[tauri::command]
#[specta::specta]
pub async fn doc_set_properties(
    ws: Ws,
    target: DocRef,
    text: String,
) -> Result<crate::vault::properties::DocProperties> {
    with_vault(&ws, move |v| v.set_doc_properties(&target, &text)).await
}

/// 整个仓库的属性一览（加属性、填值时的提示）和记着的类型
#[tauri::command]
#[specta::specta]
pub async fn vault_property_catalog(ws: Ws) -> Result<crate::vault::properties::PropertyCatalog> {
    with_vault(&ws, move |v| v.property_catalog()).await
}

/// 记下（kind 是 null 是忘掉）一个键是什么类型
#[tauri::command]
#[specta::specta]
pub async fn vault_set_property_type(
    ws: Ws,
    key: String,
    kind: Option<String>,
) -> Result<std::collections::BTreeMap<String, String>> {
    with_vault(&ws, move |v| v.set_property_type(&key, kind.as_deref())).await
}

/// 不是 UTF-8 的一篇按什么编码认出来、转过去是什么样（转之前给用户看，docs/1110审查与研究.md §5.1）
#[tauri::command]
#[specta::specta]
pub async fn doc_legacy_text(ws: Ws, target: DocRef) -> Result<LegacyText> {
    with_vault(&ws, move |v| v.legacy_text(&target)).await
}

/// 转成 UTF-8，原文按原字节另存在旁边。fingerprint 是 doc_legacy_text 给的那一版，文件之后被改过就不转
#[tauri::command]
#[specta::specta]
pub async fn doc_convert_utf8(ws: Ws, target: DocRef, fingerprint: String) -> Result<()> {
    with_vault(&ws, move |v| v.convert_to_utf8(&target, &fingerprint)).await
}

/// 在系统的文件管理器里定位这篇文档的文件（选中它）。还没写过的插件文档（某一天、
/// 某个周期）没有文件，打开它将来所在的文件夹。
#[tauri::command]
#[specta::specta]
pub async fn vault_reveal(ws: Ws, target: DocRef) -> Result<()> {
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

/// 粘贴进来的文件（剪贴板里的图片）存进「附件」文件夹。内容以 base64 传过来 ——
/// 一个字节一个数字的 JSON 数组，几 MB 的截图要序列化成几千万个字符。
#[tauri::command]
#[specta::specta]
pub async fn vault_attach(
    ws: Ws,
    target: DocRef,
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
    target: DocRef,
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
    Ok(())
}

/// 仓库换上了（新开的窗口、换了文件夹）：后台读索引、文件监听、同步都起来，通知都只发给这个窗口。
/// 同步线程第一轮要等前端 ready（技术方案 §5.9.6），这里只是起线程
pub fn start_services<R: Runtime>(app: &AppHandle<R>, data_dir: &std::path::Path, ws: &Arc<Workspace>, backlog: Backlog) {
    spawn_backlog(app.clone(), ws.label.clone(), ws.vault.clone(), ws.indexing.clone(), backlog);
    // 文件监听处理完一批：戳一下同步（停笔一会儿后提交）
    let on_batch: watch::OnBatch = sync_poke(&ws.sync);
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
    // 团队仓库：这台设备写进设备名单（docs/协同编辑.md §22.3）
    spawn_register_device(data_dir, ws);
}

/// 这个窗口换到另一个仓库文件夹：准备好、打开、停旧的监听和同步、换上新的、起新的、记进仓库列表。
/// 换仓库的命令和「第二台设备接入同步」（clone 到新文件夹）都走这里；之后前端整页重载
pub(in crate::commands) async fn switch_vault<R: Runtime>(
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
