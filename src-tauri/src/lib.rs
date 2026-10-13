// 不带 Tauri 运行时的纯逻辑单测（cargo test --no-default-features --lib）里，
// 只给命令层用的函数和类型没人调用，别让它们刷一屏警告
#![cfg_attr(
    not(any(feature = "desktop-runtime", feature = "typegen")),
    allow(dead_code)
)]

mod boot;
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
mod commands;
mod db;
mod domain;
mod error;
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
mod state;
mod sync;
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
mod update;
mod vault;

#[cfg(feature = "desktop-runtime")]
use std::sync::{Arc, Mutex};
#[cfg(feature = "desktop-runtime")]
use tauri::{Manager, WebviewWindow};
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
use tauri_specta::{collect_commands, collect_events, Builder};

#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
use state::AppState;

/// 窗口就绪后再显示。
///
/// tauri.conf.json 里 `visible: false`，等前端首帧渲染完再 show() ——
/// 否则用户会先看到一个空窗口闪一下，这是桌面应用最常见的廉价感来源。
///
/// 这时前端也订阅好了事件：开着同步的话，第一轮从这里开始（技术方案 §5.9.6）；
/// 检查更新也从这里开始计时（update.rs，过一会儿才查第一次）。
#[cfg(feature = "desktop-runtime")]
#[tauri::command]
#[specta::specta]
fn ready(window: WebviewWindow) {
    #[cfg(windows)]
    use_app_icon_resource(&window);
    let _ = window.show();
    let _ = window.set_focus();
    if let Some(state) = window.try_state::<AppState>() {
        state.sync.sync_now();
    }
    update::start(window.app_handle());
}

/// Windows：窗口图标改用 exe 里嵌的那份多尺寸图标，按系统的图标尺寸挑一张。
///
/// Tauri 2.11 把 icons/icon.ico 的第一张解成一张位图当窗口图标，任务栏拿它按系统「大图标」的尺寸画
/// （96 DPI 时 32px，150% 缩放时 48px），尺寸对不上就硬拉 —— 第一张是 16px 的时候糊成一团。
/// tauri-build 把整个 icon.ico 以资源 32512 嵌进了 exe，LoadImageW 从里面挑正好的一张
/// （没有正好的就从大一档缩下来）。Tauri 2.12 起默认就这么做（`default_window_icon_from_app_icon_resource`），
/// 升级以后这段可以删掉。
#[cfg(all(windows, feature = "desktop-runtime"))]
fn use_app_icon_resource(window: &WebviewWindow) {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON, LR_DEFAULTCOLOR,
        SM_CXICON, SM_CXSMICON, SM_CYICON, SM_CYSMICON, WM_SETICON,
    };
    /// tauri-build 嵌图标用的资源号（tauri_utils::platform::WINDOWS_APP_ICON_RESOURCE_ID）
    const APP_ICON: u16 = 32512;

    let Ok(hwnd) = window.hwnd() else { return };
    let Ok(module) = (unsafe { GetModuleHandleW(PCWSTR::null()) }) else { return };
    for (kind, cx, cy) in [(ICON_BIG, SM_CXICON, SM_CYICON), (ICON_SMALL, SM_CXSMICON, SM_CYSMICON)] {
        let loaded = unsafe {
            LoadImageW(
                Some(module.into()),
                PCWSTR(APP_ICON as usize as *const u16),
                IMAGE_ICON,
                GetSystemMetrics(cx),
                GetSystemMetrics(cy),
                LR_DEFAULTCOLOR,
            )
        };
        // 拿不到就留着 Tauri 设的那张（.ico 第一张是 32px，不会太糊）
        if let Ok(icon) = loaded {
            unsafe {
                SendMessageW(hwnd, WM_SETICON, Some(WPARAM(kind as usize)), Some(LPARAM(icon.0 as isize)));
            }
        }
    }
}

/* ---------------- 无边框窗口的窗口控制 ---------------- */

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
#[specta::specta]
fn win_minimize(window: WebviewWindow) {
    let _ = window.minimize();
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
#[specta::specta]
fn win_toggle_maximize(window: WebviewWindow) -> bool {
    let maximized = window.is_maximized().unwrap_or(false);
    let _ = if maximized {
        window.unmaximize()
    } else {
        window.maximize()
    };
    !maximized
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
#[specta::specta]
fn win_close(window: WebviewWindow) {
    // close() 而不是 destroy()，让前端 onCloseRequested
    // 有机会把编辑器里未保存的内容 flush 掉（P6 会用到）
    let _ = window.close();
}

/// 保存完成后真正销毁窗口。只由前端的 close guard 调用，避免再次触发
/// `onCloseRequested` 形成递归。开着同步时先提交、推送，最多等 3 秒（技术方案 §5.9.6）——
/// 窗口先藏起来，用户不用看着一个点不动的窗口等。
#[cfg(feature = "desktop-runtime")]
#[tauri::command]
#[specta::specta]
async fn win_force_close(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), error::AppError> {
    if state.sync.is_running() {
        let _ = window.hide();
        let hub = state.sync.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            hub.close(std::time::Duration::from_secs(3))
        })
        .await;
    }
    let _ = window.destroy();
    Ok(())
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
#[specta::specta]
fn win_is_maximized(window: WebviewWindow) -> bool {
    window.is_maximized().unwrap_or(false)
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
#[specta::specta]
fn win_start_dragging(window: WebviewWindow) -> bool {
    window.start_dragging().is_ok()
}

#[cfg(feature = "desktop-runtime")]
fn command_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![
        ready,
        win_minimize,
        win_toggle_maximize,
        win_close,
        win_force_close,
        win_is_maximized,
        win_start_dragging,
        commands::note_list_full,
        commands::note_get,
        commands::note_upsert,
        commands::note_set_pinned,
        commands::note_archive,
        commands::note_restore,
        commands::note_delete,
        commands::note_undelete,
        commands::note_create,
        commands::note_move,
        commands::folder_list,
        commands::folder_create,
        commands::folder_rename,
        commands::folder_delete,
        commands::folder_undelete,
        commands::folder_reveal,
        commands::search_notes,
        commands::task_toggle,
        commands::goal_get,
        commands::goal_save,
        commands::calendar_day,
        commands::calendar_day_save,
        commands::calendar_marks,
        commands::journal_list,
        commands::guide_pending,
        commands::guide_settle,
        commands::guide_open,
        commands::vault_info,
        commands::index_progress,
        commands::vault_reveal,
        commands::vault_open_folder,
        commands::vault_keep_conflict_copy,
        commands::note_backlinks,
        commands::note_relink,
        commands::note_relink_undo,
        commands::doc_history,
        commands::doc_version_text,
        commands::vault_attach,
        commands::vault_attach_path,
        commands::vault_change_root::<tauri::Wry>,
        commands::sync_status,
        commands::sync_now,
        commands::sync_accounts,
        commands::sync_github_login_start,
        commands::sync_github_login_wait,
        commands::sync_login_cancel,
        commands::sync_gitee_login,
        commands::sync_logout,
        commands::sync_repos,
        commands::sync_create_repo,
        commands::sync_proxy,
        commands::sync_set_proxy,
        commands::sync_inspect,
        commands::sync_enable::<tauri::Wry>,
        commands::sync_disable,
        update::update_status,
        update::update_check::<tauri::Wry>,
        update::update_install::<tauri::Wry>,
        update::app_upgrade,
    ])
    .events(collect_events![
        commands::IndexProgress,
        commands::VaultChanged,
        commands::SyncStatusChanged,
        commands::SyncNotice,
        update::UpdateReady
    ])
}

/// 独立导出命令与领域类型，供 `cargo run --example export_bindings` 和
/// debug 启动共用。生成文件是前端 IPC 的唯一类型来源。
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
pub fn export_typescript_bindings(path: impl AsRef<std::path::Path>) {
    #[cfg(feature = "desktop-runtime")]
    let builder = command_builder();
    #[cfg(all(feature = "typegen", not(feature = "desktop-runtime")))]
    let builder = Builder::<tauri::test::MockRuntime>::new().commands(collect_commands![
        commands::note_list_full,
        commands::note_get,
        commands::note_upsert,
        commands::note_set_pinned,
        commands::note_archive,
        commands::note_restore,
        commands::note_delete,
        commands::note_undelete,
        commands::note_create,
        commands::note_move,
        commands::folder_list,
        commands::folder_create,
        commands::folder_rename,
        commands::folder_delete,
        commands::folder_undelete,
        commands::folder_reveal,
        commands::search_notes,
        commands::task_toggle,
        commands::goal_get,
        commands::goal_save,
        commands::calendar_day,
        commands::calendar_day_save,
        commands::calendar_marks,
        commands::journal_list,
        commands::guide_pending,
        commands::guide_settle,
        commands::guide_open,
        commands::vault_info,
        commands::index_progress,
        commands::vault_reveal,
        commands::vault_open_folder,
        commands::vault_keep_conflict_copy,
        commands::note_backlinks,
        commands::note_relink,
        commands::note_relink_undo,
        commands::doc_history,
        commands::doc_version_text,
        commands::vault_attach,
        commands::vault_attach_path,
        commands::vault_change_root::<tauri::test::MockRuntime>,
        commands::sync_status,
        commands::sync_now,
        commands::sync_accounts,
        commands::sync_github_login_start,
        commands::sync_github_login_wait,
        commands::sync_login_cancel,
        commands::sync_gitee_login,
        commands::sync_logout,
        commands::sync_repos,
        commands::sync_create_repo,
        commands::sync_proxy,
        commands::sync_set_proxy,
        commands::sync_inspect,
        commands::sync_enable::<tauri::test::MockRuntime>,
        commands::sync_disable,
        update::update_status,
        update::update_check::<tauri::test::MockRuntime>,
        update::update_install::<tauri::test::MockRuntime>,
        update::app_upgrade,
    ])
    .events(collect_events![
        commands::IndexProgress,
        commands::VaultChanged,
        commands::SyncStatusChanged,
        commands::SyncNotice,
        update::UpdateReady
    ]);

    builder
        .export(
            specta_typescript::Typescript::default()
                // SQLite 时间戳是 UTC 毫秒，远低于 JS Number.MAX_SAFE_INTEGER；
                // 明确允许 i64 导出为 number，避免 debug 启动时导出器拒绝生成。
                .bigint(specta_typescript::BigIntExportBehavior::Number)
                // 无事件时 tauri-specta 仍会生成事件辅助代码，TS 的
                // noUnusedLocals 会误报；生成文件本身由 Rust 类型约束。
                .header("// 由 tauri-specta 自动生成，请勿手动编辑。\n// @ts-nocheck\n"),
            path,
        )
        .expect("导出 TS 绑定失败");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg(feature = "desktop-runtime")]
pub fn run() {
    let specta_builder = command_builder();

    // 开发时把 TS 绑定写到前端目录。手写 IPC 类型是这个架构里最容易
    // 出错的地方，交给生成器。
    #[cfg(debug_assertions)]
    export_typescript_bindings("../src/lib/bindings.ts");

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // 只在 Rust 里用（update.rs），前端没有它的权限
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(specta_builder.invoke_handler())
        // 窗口获得焦点：可能刚在别的设备上写过，拉一次（距上一轮不到 1 分钟的不拉）
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(true) = event {
                if let Some(state) = window.try_state::<AppState>() {
                    state.sync.focus();
                }
            }
        })
        .setup(move |app| {
            specta_builder.mount_events(app);

            let data_dir = boot::data_dir(app.path().app_data_dir().expect("拿不到应用数据目录"));
            // 之前没有配置文件 = 这台机器上第一次打开：新装的不算升级
            let fresh = !data_dir.join("config.json").exists();
            let mut config = boot::Config::load(&data_dir);
            // 升级后第一次打开：前端拿去提示一次更新说明（update.rs 的 app_upgrade）。下面存配置时一起记下这一版
            let upgrade = boot::note_version(&mut config, fresh, &app.package_info().version.to_string());
            let root = boot::vault_root(&config, app.path().document_dir().ok(), &data_dir);

            // 第一次启动：旧库有东西就搬进文件夹，否则放示例内容。搬家失败时不能带着
            // 一个空仓库启动 —— 用户会以为笔记全没了，还可能在空仓库里接着写。
            match boot::prepare(&root, &data_dir, &mut config, true) {
                Ok(boot::Prepared::Imported(report)) => eprintln!("旧数据已搬进 {}: {report:?}", root.display()),
                Ok(_) => {}
                Err(error) => panic!("准备笔记文件夹 {} 失败: {error}", root.display()),
            }
            if std::env::var_os("ONTHEWAY_VAULT").is_none() {
                config.vault_root = Some(root.clone());
            }
            if let Err(error) = config.save(&data_dir) {
                eprintln!("保存配置失败: {error}");
            }

            // 文件很多（第一次打开一个大文件夹、索引的结构升级了）的话剩下的在后台读，窗口不等它
            let (mut vault, backlog) = vault::Vault::open_quick(&root, &boot::index_path(&data_dir, &root))
                .expect("打开笔记文件夹失败");
            // 应用升级了：用户没改过的使用指南换成这一版带的（vault/guide.rs）。前端还没起来，不用通知
            if let Err(error) = vault.guide_refresh() {
                eprintln!("更新使用指南失败: {error}");
            }
            vault.set_announcer(commands::announcer(app.handle().clone()));
            let vault = Arc::new(Mutex::new(vault));
            let sync = Arc::new(sync::engine::SyncHub::default());
            let watcher = match vault::watch::start(vault.clone(), Some(commands::sync_poke(&sync))) {
                Ok(watcher) => Some(watcher),
                Err(error) => {
                    // 监听不上只是外部改动不能实时同步，重启时的扫描还会补上
                    eprintln!("{error}");
                    None
                }
            };
            // 仓库开了同步就起同步线程：先来一轮完整的（技术方案 §5.9.6）
            let hooks = commands::sync_hooks(app.handle().clone(), data_dir.clone());
            if let Err(error) = sync.start(vault.clone(), hooks) {
                eprintln!("同步没能启动: {error}");
            }
            let indexing = Arc::new(Mutex::new(commands::Indexing::default()));
            commands::spawn_backlog(app.handle().clone(), vault.clone(), indexing.clone(), backlog);
            app.manage(AppState {
                vault,
                watcher: Mutex::new(watcher),
                data_dir,
                sync,
                sync_login: Mutex::new(sync::account::LoginSlot::default()),
                update: Arc::new(update::UpdateHub::new(upgrade)),
                indexing,
            });

            // jieba 首次初始化约 50ms。仓库是空的时候打开仓库不会用到它，放后台预热
            std::thread::spawn(domain::search::warm_up);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running OnTheWay");
}
