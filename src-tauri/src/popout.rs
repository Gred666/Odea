//! 弹出窗口（docs/标签页与分屏.md §16）：仓库窗口里把一个标签拖出去，成了一个独立的窗口。
//!
//! 页面 `window.open('about:blank')` 时由这里建一个和仓库窗口同一个 WebView2 环境的窗口接住
//! （on_new_window → NewWindowResponse::Create），页面拿到的就是它的 window：同源、同一个 JS 环境。
//! 前端把一个窗格 portal 进去，store、编辑器缓存、IPC 都是仓库窗口那一份 —— 不是第二个开同一仓库的窗口。
//!
//! 所以弹出窗口里点的按钮，命令也是从仓库窗口的页面发出来的（调用方是仓库窗口）：最小化、关闭这些要指名
//! 是哪个弹出窗口（popout_window）。用户自己关它（Alt+F4、任务栏）先拦下来交给仓库窗口
//! （popout-close 事件）：前端把正文存掉、标签放回主窗口，再来真的关。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex};

use serde::Deserialize;
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const PREFIX: &str = "pop-";
/// 用户要关一个弹出窗口：发给开它的仓库窗口，载荷是弹出窗口的标签
pub const CLOSE_EVENT: &str = "popout-close";

static NEXT: AtomicU32 = AtomicU32::new(1);
/// 弹出窗口 → 开它的仓库窗口
static OWNERS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Mutex::default);

pub fn is_popout(label: &str) -> bool {
    label.starts_with(PREFIX)
}

fn owner_of(label: &str) -> Option<String> {
    OWNERS.lock().ok().and_then(|owners| owners.get(label).cloned())
}

/// 这个仓库窗口开着弹出窗口（它的页面也在画弹出窗口里的东西）
pub fn has_popouts(owner: &str) -> bool {
    OWNERS.lock().map(|owners| owners.values().any(|o| o == owner)).unwrap_or(false)
}

/// 仓库窗口的 on_new_window。只接前端自己开的空白页：别的（正文里的链接之类）一律不开，外链走 opener 插件。
/// 先藏着，前端画好第一帧再显示（popout_window 的 show），和仓库窗口一样不闪空窗口
pub fn create<R: Runtime>(
    app: &AppHandle<R>,
    owner: &str,
    url: &Url,
    features: NewWindowFeatures,
    background: Color,
) -> NewWindowResponse<R> {
    if url.as_str() != "about:blank" {
        return NewWindowResponse::Deny;
    }
    let label = format!("{PREFIX}{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url.clone()))
        .window_features(features)
        .title("Odea")
        .min_inner_size(480.0, 360.0)
        .decorations(false)
        .visible(false)
        .background_color(background)
        .build();
    match built {
        Ok(window) => {
            if let Ok(mut owners) = OWNERS.lock() {
                owners.insert(label, owner.to_string());
            }
            NewWindowResponse::Create { window }
        }
        Err(error) => {
            eprintln!("建弹出窗口失败: {error}");
            NewWindowResponse::Deny
        }
    }
}

/// lib.rs 的 CloseRequested：用户关弹出窗口，交给仓库窗口去存、去放回标签（它再调 close）。
/// 仓库窗口已经没了的话照常关
pub fn on_close_requested<R: Runtime>(window: &tauri::Window<R>, api: &tauri::CloseRequestApi) {
    let Some(owner) = owner_of(window.label()) else { return };
    if window.app_handle().get_webview_window(&owner).is_none() {
        return;
    }
    api.prevent_close();
    if let Err(error) = window.emit_to(owner.as_str(), CLOSE_EVENT, window.label()) {
        eprintln!("通知关弹出窗口失败: {error}");
    }
}

/// lib.rs 的 Destroyed：弹出窗口没了就忘掉；仓库窗口没了，它的弹出窗口跟着关（里面的东西是它的页面画的）
pub fn on_destroyed<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let orphans: Vec<String> = match OWNERS.lock() {
        Ok(mut owners) => {
            owners.remove(label);
            let orphans = owners.iter().filter(|(_, owner)| *owner == label).map(|(pop, _)| pop.clone()).collect();
            owners.retain(|_, owner| owner != label);
            orphans
        }
        Err(_) => return,
    };
    for pop in orphans {
        if let Some(window) = app.get_webview_window(&pop) {
            let _ = window.destroy();
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum PopoutOp {
    /// 前端画好第一帧：显示出来、拿到焦点
    Show,
    Focus,
    Minimize,
    /// 返回之后是不是最大化
    ToggleMaximize,
    IsMaximized,
    /// 在弹出窗口的拖动区里按下：拖窗口
    StartDragging,
    /// 真的关（前端存完、标签放回去以后）
    Close,
}

/// 弹出窗口的窗口操作。调用方是开它的仓库窗口（前端都跑在它的页面里），别的窗口指不动它
#[tauri::command]
#[specta::specta]
pub fn popout_window(window: WebviewWindow, label: String, op: PopoutOp) -> bool {
    if owner_of(&label).as_deref() != Some(window.label()) {
        return false;
    }
    let Some(target) = window.app_handle().get_webview_window(&label) else { return false };
    match op {
        PopoutOp::Show => {
            #[cfg(all(windows, feature = "desktop-runtime"))]
            crate::use_app_icon_resource(&target);
            target.show().is_ok() && target.set_focus().is_ok()
        }
        PopoutOp::Focus => target.unminimize().is_ok() && target.set_focus().is_ok(),
        PopoutOp::Minimize => target.minimize().is_ok(),
        PopoutOp::ToggleMaximize => {
            let maximized = target.is_maximized().unwrap_or(false);
            let _ = if maximized { target.unmaximize() } else { target.maximize() };
            !maximized
        }
        PopoutOp::IsMaximized => target.is_maximized().unwrap_or(false),
        PopoutOp::StartDragging => target.start_dragging().is_ok(),
        PopoutOp::Close => {
            if let Ok(mut owners) = OWNERS.lock() {
                owners.remove(&label);
            }
            target.destroy().is_ok()
        }
    }
}

/// 弹出窗口的标题（任务栏、Alt+Tab 里看到的）：跟着当前那一篇
#[tauri::command]
#[specta::specta]
pub fn popout_set_title(window: WebviewWindow, label: String, title: String) {
    if owner_of(&label).as_deref() != Some(window.label()) {
        return;
    }
    if let Some(target) = window.app_handle().get_webview_window(&label) {
        let _ = target.set_title(&title);
    }
}
