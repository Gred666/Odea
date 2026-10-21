// 不带 Tauri 运行时的纯逻辑单测（cargo test --no-default-features --lib）里，
// 只给命令层用的函数和类型没人调用，别让它们刷一屏警告
#![cfg_attr(
    not(any(feature = "desktop-runtime", feature = "typegen")),
    allow(dead_code)
)]

mod boot;
mod collab;
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
mod commands;
mod db;
mod domain;
mod error;
#[cfg(feature = "desktop-runtime")]
mod memory;
mod old_name;
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
mod state;
mod sync;
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
mod update;
mod vault;
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
mod workspace;

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
/// 这时前端也订阅好了事件：这个仓库开着同步的话，第一轮从这里开始（技术方案 §5.9.6）；
/// 检查更新也从这里开始计时（update.rs，过一会儿才查第一次）。启动器在等这个窗口的话，这时关掉
#[cfg(feature = "desktop-runtime")]
#[tauri::command]
#[specta::specta]
fn ready(window: WebviewWindow) {
    #[cfg(windows)]
    use_app_icon_resource(&window);
    workspace::place_pending(&window);
    let _ = window.show();
    let _ = window.set_focus();
    if let Some(workspace) = window.try_state::<AppState>().and_then(|state| state.workspace(window.label())) {
        workspace.sync.sync_now();
    }
    workspace::on_ready(window.app_handle(), window.label());
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
    // 这个窗口正在协作：告诉别人、删掉落盘的记录（关窗口算正常结束，重启后不再问「继续上次的协作」）
    let _ = window.hide();
    commands::end_collab(&state, window.label()).await;
    if let Some(workspace) = state.workspace(window.label()).filter(|workspace| workspace.sync.is_running()) {
        let hub = workspace.sync.clone();
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

/// 协作的 odea:// 链接（docs/协同编辑.md §8.1）。冷启动带进来的先存着，前端起来以后取
/// （collab_pending_link）；应用开着时点的直接发 CollabLink。Windows 的安装包注册了 scheme；
/// 开发构建在这里现注册（正式版不注册：会把关联改成当前这个 exe，跑一次 debug 版就抢走了
/// 已安装应用的链接）。Linux 的 AppImage 没有安装这一步，运行时注册
#[cfg(feature = "desktop-runtime")]
fn collab_hub(app: &tauri::App) -> Arc<commands::CollabHub> {
    use tauri_plugin_deep_link::DeepLinkExt;
    let hub = Arc::new(commands::CollabHub::default());
    #[cfg(any(all(windows, debug_assertions), target_os = "linux"))]
    if let Err(error) = app.deep_link().register_all() {
        eprintln!("注册 odea:// 链接失败: {error}");
    }
    let is_join = |url: &tauri::Url| url.scheme() == "odea";
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        if let Some(url) = urls.iter().find(|url| is_join(url)) {
            hub.set_pending_link(url.to_string());
        }
    }
    let handle = app.handle().clone();
    // 交给最近用过的仓库窗口（一次只有一个会话、属于一个窗口，docs/仓库与启动器.md §4.3）
    app.deep_link().on_open_url(move |event| {
        for url in event.urls().iter().filter(|url| is_join(url)) {
            workspace::deliver_link(&handle, url.to_string());
        }
    });
    hub
}

/// 协作收发字节的两个命令（不经 tauri-specta）。返回类型写明，生成的闭包才推得出参数类型
#[cfg(feature = "desktop-runtime")]
fn collab_raw_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        commands::collab_send,
        commands::collab_pipe,
        commands::collab_resume_state
    ]
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
        commands::note_list,
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
        commands::tree_files,
        commands::tree_file_open,
        commands::tree_view,
        commands::tree_place,
        commands::tree_add_shortcut,
        commands::tree_remove_shortcut,
        commands::tree_move_folder,
        commands::tree_add_query,
        commands::tree_set_query,
        commands::tree_queries,
        commands::vault_make_logical::<tauri::Wry>,
        commands::tree_export::<tauri::Wry>,
        commands::vault_import::<tauri::Wry>,
        commands::search_text,
        commands::find_in_vault,
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
        commands::vault_set_journal::<tauri::Wry>,
        commands::vault_relayout::<tauri::Wry>,
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
        workspace::launcher_vaults,
        workspace::launcher_open::<tauri::Wry>,
        workspace::launcher_open_folder::<tauri::Wry>,
        workspace::launcher_default_parent::<tauri::Wry>,
        workspace::launcher_pick_parent::<tauri::Wry>,
        workspace::launcher_create::<tauri::Wry>,
        workspace::launcher_clone::<tauri::Wry>,
        workspace::launcher_forget,
        workspace::launcher_reveal,
        workspace::launcher_join::<tauri::Wry>,
        workspace::launcher_show::<tauri::Wry>,
        workspace::launcher_take_link,
        workspace::launcher_open_link::<tauri::Wry>,
        workspace::journal_vaults,
        workspace::journal_switch::<tauri::Wry>,
        commands::team_info,
        commands::team_invite,
        commands::team_remove,
        commands::sync_invitations,
        commands::sync_accept_invitation,
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
        commands::collab_identity,
        commands::collab_set_name,
        commands::collab_host::<tauri::Wry>,
        commands::collab_reset_invite,
        commands::collab_check_link,
        commands::collab_join::<tauri::Wry>,
        commands::collab_answer,
        commands::collab_set_permission,
        commands::collab_kick,
        commands::collab_trusted,
        commands::collab_remember,
        commands::collab_forget,
        commands::collab_set_title,
        commands::collab_stop,
        commands::collab_pending_link,
        commands::collab_copy_to_vault::<tauri::Wry>,
        commands::collab_take_copy,
        commands::collab_callback,
        commands::collab_forward_link,
        commands::collab_dial_back,
        commands::collab_relays,
        commands::collab_relay_inspect,
        commands::collab_relay_add,
        commands::collab_relay_remove,
        commands::collab_relay_code,
        commands::collab_relay_test,
        commands::collab_nearby_start::<tauri::Wry>,
        commands::collab_nearby_stop,
        commands::collab_join_nearby::<tauri::Wry>,
        commands::collab_resume_info,
        commands::collab_rejoin::<tauri::Wry>,
        commands::collab_discard_resume,
        commands::collab_set_attachment_refs,
        commands::collab_resume_docs,
        commands::collab_doc_answer,
        commands::collab_set_tree,
        commands::collab_create_answer,
        commands::collab_open_doc,
        commands::collab_close_doc,
        commands::collab_create_doc,
        commands::collab_fetch_attachment,
        commands::collab_put_attachment,
        commands::collab_put_attachment_path,
    ])
    .events(collect_events![
        commands::IndexProgress,
        commands::VaultChanged,
        commands::SyncStatusChanged,
        commands::SyncNotice,
        commands::CollabEvent,
        commands::CollabLink,
        workspace::JournalGoto,
        workspace::LauncherLink,
        commands::CollabCopyReady,
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
        commands::note_list,
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
        commands::tree_files,
        commands::tree_file_open,
        commands::tree_view,
        commands::tree_place,
        commands::tree_add_shortcut,
        commands::tree_remove_shortcut,
        commands::tree_move_folder,
        commands::tree_add_query,
        commands::tree_set_query,
        commands::tree_queries,
        commands::vault_make_logical::<tauri::test::MockRuntime>,
        commands::tree_export::<tauri::test::MockRuntime>,
        commands::vault_import::<tauri::test::MockRuntime>,
        commands::search_text,
        commands::find_in_vault,
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
        commands::vault_set_journal::<tauri::test::MockRuntime>,
        commands::vault_relayout::<tauri::test::MockRuntime>,
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
        workspace::launcher_vaults,
        workspace::launcher_open::<tauri::test::MockRuntime>,
        workspace::launcher_open_folder::<tauri::test::MockRuntime>,
        workspace::launcher_default_parent::<tauri::test::MockRuntime>,
        workspace::launcher_pick_parent::<tauri::test::MockRuntime>,
        workspace::launcher_create::<tauri::test::MockRuntime>,
        workspace::launcher_clone::<tauri::test::MockRuntime>,
        workspace::launcher_forget,
        workspace::launcher_reveal,
        workspace::launcher_join::<tauri::test::MockRuntime>,
        workspace::launcher_show::<tauri::test::MockRuntime>,
        workspace::launcher_take_link,
        workspace::launcher_open_link::<tauri::test::MockRuntime>,
        workspace::journal_vaults,
        workspace::journal_switch::<tauri::test::MockRuntime>,
        commands::team_info,
        commands::team_invite,
        commands::team_remove,
        commands::sync_invitations,
        commands::sync_accept_invitation,
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
        commands::collab_identity,
        commands::collab_set_name,
        commands::collab_host::<tauri::test::MockRuntime>,
        commands::collab_reset_invite,
        commands::collab_check_link,
        commands::collab_join::<tauri::test::MockRuntime>,
        commands::collab_answer,
        commands::collab_set_permission,
        commands::collab_kick,
        commands::collab_trusted,
        commands::collab_remember,
        commands::collab_forget,
        commands::collab_set_title,
        commands::collab_stop,
        commands::collab_pending_link,
        commands::collab_copy_to_vault::<tauri::test::MockRuntime>,
        commands::collab_take_copy,
        commands::collab_callback,
        commands::collab_forward_link,
        commands::collab_dial_back,
        commands::collab_relays,
        commands::collab_relay_inspect,
        commands::collab_relay_add,
        commands::collab_relay_remove,
        commands::collab_relay_code,
        commands::collab_relay_test,
        commands::collab_nearby_start::<tauri::test::MockRuntime>,
        commands::collab_nearby_stop,
        commands::collab_join_nearby::<tauri::test::MockRuntime>,
        commands::collab_resume_info,
        commands::collab_rejoin::<tauri::test::MockRuntime>,
        commands::collab_discard_resume,
        commands::collab_set_attachment_refs,
        commands::collab_resume_docs,
        commands::collab_doc_answer,
        commands::collab_set_tree,
        commands::collab_create_answer,
        commands::collab_open_doc,
        commands::collab_close_doc,
        commands::collab_create_doc,
        commands::collab_fetch_attachment,
        commands::collab_put_attachment,
        commands::collab_put_attachment_path,
    ])
    .events(collect_events![
        commands::IndexProgress,
        commands::VaultChanged,
        commands::SyncStatusChanged,
        commands::SyncNotice,
        commands::CollabEvent,
        commands::CollabLink,
        workspace::JournalGoto,
        workspace::LauncherLink,
        commands::CollabCopyReady,
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

    // 改名前（OnTheWay）的数据目录挪到新标识下：要赶在插件读窗口位置、Tauri 建窗口之前
    let context = tauri::generate_context!();
    old_name::move_app_dirs(&context.config().identifier);

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // 已经在运行时再启动一次（双击图标、开始菜单）：弹启动器（docs/仓库与启动器.md §3.1）。
        // 带着 odea:// 链接来的不弹：deep-link 插件接住链接，交给仓库窗口（collab_hub 里的 on_open_url）
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if argv.iter().any(|arg| arg.starts_with("odea:")) {
                return;
            }
            let app = app.clone();
            // 回调在主线程上：建窗口挪到别处
            tauri::async_runtime::spawn(async move {
                if let Err(error) = workspace::show_launcher(&app) {
                    eprintln!("打开启动器失败: {error}");
                }
            });
        }));
    }

    let app = builder
        // single-instance 之后：应用开着时点 odea:// 链接，交给这个实例（见下面 on_open_url）
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 每个仓库窗口记着自己的位置（标签按仓库定）；启动器每次都在屏幕中间
        .plugin(tauri_plugin_window_state::Builder::default().with_denylist(&[workspace::LAUNCHER]).build())
        // 只在 Rust 里用（update.rs），前端没有它的权限
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler({
            // 协作的两个收发字节的命令不经 tauri-specta（原始请求体 / 二进制 Channel，见 commands.rs「协作」）
            let typed = specta_builder.invoke_handler();
            let raw = collab_raw_handler();
            move |invoke: tauri::ipc::Invoke<tauri::Wry>| match invoke.message.command() {
                "collab_send" | "collab_pipe" | "collab_resume_state" => raw(invoke),
                _ => typed(invoke),
            }
        })
        .on_window_event(|window, event| {
            // 窗口获得焦点：这个仓库可能刚在别的设备上写过，拉一次（距上一轮不到 1 分钟的不拉）；
            // 记下最近用的仓库窗口（odea:// 链接交给它）
            if let tauri::WindowEvent::Focused(true) = event {
                if let Some(workspace) = window.try_state::<AppState>().and_then(|state| state.workspace(window.label())) {
                    workspace.sync.focus();
                }
                workspace::on_focused(window.app_handle(), window.label());
            }
            // 最小化 / 还原：前者也会失焦，还原时会改大小
            if matches!(event, tauri::WindowEvent::Focused(_) | tauri::WindowEvent::Resized(_)) {
                memory::follow_window(window);
            }
            if let tauri::WindowEvent::Destroyed = event {
                memory::forget_window(window.label());
                workspace::on_destroyed(window.app_handle(), window.label());
            }
        })
        .setup(move |app| {
            specta_builder.mount_events(app);

            let data_dir = boot::data_dir(app.path().app_data_dir().expect("拿不到应用数据目录"));
            // 之前没有配置文件 = 这台机器上第一次打开：新装的不算升级
            let fresh = !data_dir.join("config.json").exists();
            // 升级后第一次打开：前端拿去提示一次更新说明（update.rs 的 app_upgrade）。
            // 旧配置只记着一个仓库：变成仓库列表的第一条（docs/仓库与启动器.md §5）
            let (upgrade, config) = boot::edit_config(&data_dir, |config| {
                let upgrade = boot::note_version(config, fresh, &app.package_info().version.to_string());
                config.migrate_vaults(db::now_ms());
                Ok((upgrade, config.clone()))
            })
            .unwrap_or_else(|error| {
                eprintln!("保存配置失败: {error}");
                (None, boot::Config::load(&data_dir))
            });
            // SQLite 时代的旧库里有东西、还没搬过：直接在「文档/Odea」建仓库搬进去，不弹启动器
            let legacy = !config.legacy_imported && vault::legacy::has_data(&data_dir.join("ontheway.db"));
            let plan = boot::startup(
                &config,
                boot::env_vault(),
                boot::default_root(app.path().document_dir().ok(), &data_dir),
                legacy,
            );

            app.manage(AppState {
                workspaces: Mutex::new(std::collections::HashMap::new()),
                focused: Mutex::new(None),
                launcher_waits_for: Mutex::new(None),
                launcher_link: Mutex::new(None),
                journal_jumps: Mutex::new(std::collections::HashMap::new()),
                data_dir,
                sync_login: Mutex::new(sync::account::LoginSlot::default()),
                update: Arc::new(update::UpdateHub::new(upgrade)),
                collab: collab_hub(app),
            });
            // 上次开着的仓库各开一个窗口；一个都打不开（新装、文件夹都找不到了）弹启动器
            workspace::startup(app.handle(), plan);
            Ok(())
        })
        .build(context)
        .expect("error while building Odea");

    app.run(|handle, event| {
        // macOS 点 Dock：一个窗口都没有时打开最近的仓库，没有就弹启动器（docs/仓库与启动器.md §3.1）
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = event {
            workspace::reopen(handle);
        }
        let _ = (handle, event);
    });
}
