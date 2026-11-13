//! 全局快捷键速记（docs/TODO.md P15）：应用开着（窗口在后台、最小化都行）时按一下快捷键，屏幕上方弹一个
//! 小窗，写一行、回车，记进今日TODO。
//!
//! - 快捷键由 tauri-plugin-global-shortcut 注册（系统级），默认 Ctrl+Alt+N，命令面板「速记快捷键…」里能改、能关。
//!   注册不上（被别的程序占了）不报错，设置里写着为什么
//! - 小窗（标签 capture，`index.html?capture`）第一次按时才建，之后藏着、再按再显示；在光标所在的那块屏幕上、
//!   靠上居中。系统的显示 / 隐藏过渡关掉（docs/PITFALLS/动效.md 第 9 条：Windows 的开关窗动画会掉帧）：一下出来、
//!   一下没了，和 Spotlight、PowerToys Run 一样。再按一次快捷键、Esc、点到别处都是收起来
//! - 记进哪个仓库：最近用过的、开着日程的那个仓库窗口（都没开日程就是最近用过的那个，它那边会说没开日程）。
//!   这一行由那个窗口的前端写（日程插件，src/plugins/journal/capture.ts）：今天还没写过时今日TODO 是延续来的、
//!   编辑器可能正开着今天那一篇 —— 这些只有前端清楚，和打字走同一条路才不会撞出冲突副本。
//!   Rust 只管转话：CaptureRequest 发给那个窗口，等它 capture_answer 回话（最多 8 秒）
//! - 一个仓库窗口都没开着（只开着启动器、访客窗口）：小窗照样出来，说先打开一个仓库

use serde::{Deserialize, Serialize};

use crate::boot::QuickCaptureConfig;

/// 小窗的窗口标签
pub const LABEL: &str = "capture";
/// 默认的快捷键。Ctrl+Alt+字母在中文 Windows 上一般没人占（QQ 是 A、Z），macOS 上是 ⌃⌥N
pub const DEFAULT_SHORTCUT: &str = "Ctrl+Alt+N";

/// 设置（配置文件里没有就是默认的：开着、Ctrl+Alt+N）
pub fn settings_of(config: Option<&QuickCaptureConfig>) -> QuickCaptureConfig {
    config.cloned().unwrap_or_else(|| QuickCaptureConfig { enabled: true, shortcut: DEFAULT_SHORTCUT.into() })
}

/// 给前端的设置和现在的状态
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSettings {
    pub enabled: bool,
    pub shortcut: String,
    /// 开着却没注册上：为什么（被别的程序占了、写法不认得）。注册上了、关着是 null
    pub error: Option<String>,
}

/// 小窗问：记到哪
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTarget {
    /// 仓库的名字（文件夹名）
    pub name: String,
    /// 开着日程（有今日TODO）
    pub journal: bool,
}

/// 发给仓库窗口：把这一行记进今日TODO，做完了调 capture_answer(id, 出错的话为什么)
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct CaptureRequest {
    pub id: u32,
    pub text: String,
}

/// 发给小窗：又显示出来了（清空输入框、重新问记到哪、把光标放进去）
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct CaptureShown;

#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
pub use runtime::*;

#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
mod runtime {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tauri::{AppHandle, Manager, Runtime, State};
    use tokio::sync::oneshot;

    use super::*;
    use crate::boot;
    use crate::error::{AppError, Result};
    use crate::state::{AppState, Workspace};

    /// 仓库窗口回的话：记下了，或者为什么没记下
    type Answer = oneshot::Sender<std::result::Result<(), String>>;
    /// 等仓库窗口回话的那几次：id → 回话
    static PENDING: Mutex<Option<HashMap<u32, Answer>>> = Mutex::new(None);
    static NEXT: AtomicU32 = AtomicU32::new(1);
    /// 现在注册着的快捷键（改设置时先注销它）、上次没注册上的原因
    static REGISTERED: Mutex<Option<String>> = Mutex::new(None);
    static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

    fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 记到哪：最近用过的、开着日程的仓库窗口；都没开日程就是最近用过的那个。一个都没有是 None
    fn target(state: &AppState) -> Option<(Arc<Workspace>, bool)> {
        let focused = state.focused.lock().ok().and_then(|focused| focused.clone());
        let mut all = state.all_workspaces();
        // 最近用过的排在最前，别的按标签排（稳定）
        all.sort_by(|a, b| {
            let recent = |workspace: &Workspace| Some(&workspace.label) != focused.as_ref();
            recent(a).cmp(&recent(b)).then_with(|| a.label.cmp(&b.label))
        });
        let journal = |workspace: &Workspace| {
            workspace
                .vault
                .lock()
                .map(|vault| vault.layout().has_plugin(crate::plugins::journal::ID))
                .unwrap_or(false)
        };
        let with_journal = all.iter().find(|workspace| journal(workspace)).cloned();
        match with_journal {
            Some(workspace) => Some((workspace, true)),
            None => all.first().cloned().map(|workspace| (workspace, false)),
        }
    }

    fn name_of(workspace: &Workspace) -> String {
        let root = workspace.root();
        root.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned())
    }

    /// 小窗：记到哪。一个仓库窗口都没开着是 null
    #[tauri::command]
    #[specta::specta]
    pub async fn capture_target(state: State<'_, AppState>) -> Result<Option<CaptureTarget>> {
        Ok(target(&state).map(|(workspace, journal)| CaptureTarget { name: name_of(&workspace), journal }))
    }

    /// 小窗：记下这一行。交给记到的那个仓库窗口去写，等它回话；返回仓库的名字
    #[tauri::command]
    #[specta::specta]
    pub async fn capture_submit<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, text: String) -> Result<String> {
        use tauri_specta::Event;
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err(AppError::Invalid("写点什么再回车".into()));
        }
        let (workspace, _) = target(&state).ok_or_else(|| AppError::Invalid("先打开一个仓库".into()))?;
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        lock(&PENDING).get_or_insert_with(HashMap::new).insert(id, tx);
        if let Err(error) = (CaptureRequest { id, text }).emit_to(&app, workspace.label.as_str()) {
            lock(&PENDING).as_mut().map(|pending| pending.remove(&id));
            return Err(AppError::Internal(format!("交给仓库窗口失败: {error}")));
        }
        let answer = tokio::time::timeout(Duration::from_secs(8), rx).await;
        lock(&PENDING).as_mut().map(|pending| pending.remove(&id));
        match answer {
            Ok(Ok(Ok(()))) => Ok(name_of(&workspace)),
            Ok(Ok(Err(message))) => Err(AppError::Invalid(message)),
            _ => Err(AppError::Internal("仓库窗口没回话（还在打开？）".into())),
        }
    }

    /// 仓库窗口：CaptureRequest 做完了。error 是没记上的原因
    #[tauri::command]
    #[specta::specta]
    pub async fn capture_answer(id: u32, error: Option<String>) -> Result<()> {
        if let Some(tx) = lock(&PENDING).as_mut().and_then(|pending| pending.remove(&id)) {
            let _ = tx.send(error.map_or(Ok(()), Err));
        }
        Ok(())
    }

    /// 小窗：收起来（Esc、点到别处、记好了）
    #[tauri::command]
    #[specta::specta]
    pub async fn capture_hide<R: Runtime>(app: AppHandle<R>) -> Result<()> {
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.hide();
        }
        Ok(())
    }

    /// 速记的设置、现在注册上没有
    #[tauri::command]
    #[specta::specta]
    pub async fn capture_settings(state: State<'_, AppState>) -> Result<CaptureSettings> {
        let config = boot::Config::load(&state.data_dir);
        Ok(current(&settings_of(config.quick_capture.as_ref())))
    }

    fn current(settings: &QuickCaptureConfig) -> CaptureSettings {
        CaptureSettings {
            enabled: settings.enabled,
            shortcut: settings.shortcut.clone(),
            error: if settings.enabled { lock(&LAST_ERROR).clone() } else { None },
        }
    }

    /// 改速记的设置：开关、换快捷键。新的注册不上也照样存下（设置里写着为什么），旧的已经注销了
    #[tauri::command]
    #[specta::specta]
    pub async fn capture_configure<R: Runtime>(
        app: AppHandle<R>,
        state: State<'_, AppState>,
        enabled: bool,
        shortcut: String,
    ) -> Result<CaptureSettings> {
        let shortcut = shortcut.trim().to_string();
        if shortcut.is_empty() {
            return Err(AppError::Invalid("快捷键是空的".into()));
        }
        let settings = QuickCaptureConfig { enabled, shortcut };
        let saved = settings.clone();
        boot::edit_config(&state.data_dir, move |config| {
            config.quick_capture = Some(saved);
            Ok(())
        })?;
        apply(&app, &settings);
        Ok(current(&settings))
    }

    /// 启动时（lib.rs 的 setup）：按配置注册快捷键
    #[cfg(feature = "desktop-runtime")]
    pub fn start<R: Runtime>(app: &AppHandle<R>) {
        let config = boot::Config::load(&app.state::<AppState>().data_dir);
        apply(app, &settings_of(config.quick_capture.as_ref()));
    }

    /// 注销旧的、按设置注册新的；注册不上的原因记在 LAST_ERROR
    #[cfg(feature = "desktop-runtime")]
    fn apply<R: Runtime>(app: &AppHandle<R>, settings: &QuickCaptureConfig) {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
        let shortcuts = app.global_shortcut();
        if let Some(old) = lock(&REGISTERED).take() {
            let _ = shortcuts.unregister(old.as_str());
        }
        *lock(&LAST_ERROR) = None;
        if !settings.enabled {
            return;
        }
        let parsed = match settings.shortcut.parse::<Shortcut>() {
            Ok(parsed) if !parsed.mods.is_empty() => parsed,
            Ok(_) => {
                *lock(&LAST_ERROR) = Some("要带上 Ctrl、Alt、Shift 或者 ⌘ 里的至少一个".into());
                return;
            }
            Err(error) => {
                *lock(&LAST_ERROR) = Some(format!("认不得这个按键：{error}"));
                return;
            }
        };
        let registered = shortcuts.on_shortcut(parsed, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle(app);
            }
        });
        match registered {
            Ok(()) => *lock(&REGISTERED) = Some(settings.shortcut.clone()),
            Err(error) => {
                *lock(&LAST_ERROR) = Some(format!("注册不上，可能被别的程序占了（{error}）"));
            }
        }
    }

    #[cfg(not(feature = "desktop-runtime"))]
    fn apply<R: Runtime>(app: &AppHandle<R>, settings: &QuickCaptureConfig) {
        let _ = (app, settings);
    }

    /// 按了快捷键：小窗开着、在前面就收起来，否则在光标那块屏幕上显示出来（第一次先建）
    #[cfg(feature = "desktop-runtime")]
    fn toggle<R: Runtime>(app: &AppHandle<R>) {
        use tauri_specta::Event;
        let app = app.clone();
        // 快捷键的回调在主线程的消息循环里：建窗口、摆位置挪出去
        tauri::async_runtime::spawn(async move {
            if let Some(window) = app.get_webview_window(LABEL) {
                if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
                    let _ = window.hide();
                    return;
                }
                place(&app, &window);
                let _ = window.show();
                let _ = window.set_focus();
                let _ = CaptureShown.emit_to(&app, LABEL);
                return;
            }
            if let Err(error) = build(&app) {
                eprintln!("开速记小窗失败: {error}");
            }
        });
    }

    /// 小窗的大小（逻辑像素）：一个输入框加一行小字
    #[cfg(feature = "desktop-runtime")]
    const SIZE: (f64, f64) = (600.0, 104.0);

    /// 建小窗：藏着建，前端画好第一帧调 ready 再显示（lib.rs 的 ready）
    #[cfg(feature = "desktop-runtime")]
    fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
        use tauri::{WebviewUrl, WebviewWindowBuilder};
        let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?capture".into()))
            .title("Odea 速记")
            .inner_size(SIZE.0, SIZE.1)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .shadow(true)
            .build()?;
        #[cfg(windows)]
        if let Ok(hwnd) = window.hwnd() {
            crate::workspace::set_transitions(hwnd, false);
        }
        place(app, &window);
        Ok(())
    }

    /// 摆到光标所在的那块屏幕上：水平居中，离顶上五分之一屏高
    #[cfg(feature = "desktop-runtime")]
    fn place<R: Runtime>(app: &AppHandle<R>, window: &tauri::WebviewWindow<R>) {
        let monitor = app
            .cursor_position()
            .ok()
            .and_then(|at| app.monitor_from_point(at.x, at.y).ok().flatten())
            .or_else(|| app.primary_monitor().ok().flatten());
        let Some(monitor) = monitor else { return };
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let width = (SIZE.0 * scale).round() as i32;
        let x = area.position.x + (area.size.width as i32 - width) / 2;
        let y = area.position.y + area.size.height as i32 / 5;
        let _ = window.set_size(tauri::PhysicalSize::new(width as u32, (SIZE.1 * scale).round() as u32));
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_is_on_with_the_default_shortcut_until_changed() {
        assert_eq!(settings_of(None), QuickCaptureConfig { enabled: true, shortcut: DEFAULT_SHORTCUT.into() });
        let mine = QuickCaptureConfig { enabled: false, shortcut: "Ctrl+Shift+Space".into() };
        assert_eq!(settings_of(Some(&mine)), mine);
        // 旧版的配置文件里没有这一项：照样读得出来
        let config: crate::boot::Config = serde_json::from_str("{}").unwrap();
        assert!(config.quick_capture.is_none());
    }
}
