//! 窗口最小化时让 WebView2 少占内存（技术方案 §13.2）。
//!
//! WebView2 有个「内存用量目标」（ICoreWebView2_19::MemoryUsageTargetLevel）：设成 Low，
//! 它把能扔的都扔掉 —— 合成层的瓦片、各种缓存、释放后还占着的堆页 —— 剩下的允许换出到
//! 页面文件；回到 Normal 后用到哪画到哪。微软的说明是应用不在前台时才设：看得见的时候设
//! Low 会卡。所以只在最小化时设，还原就撤。运行时太旧（< 114）时这个接口不存在，什么也不做。

use std::collections::HashSet;
use std::sync::Mutex;

use tauri::{Manager, Runtime, Window};

/// 哪些窗口现在设的是 Low（一个窗口一个仓库，各自最小化）。窗口事件来得很密（拖动改大小每一帧
/// 都是 Resized），只在变了时才去设
static LOW: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// 窗口事件里调：最小化了就 Low，还原了就 Normal
pub fn follow_window<R: Runtime>(window: &Window<R>) {
    let minimized = window.is_minimized().unwrap_or(false);
    let changed = {
        let Ok(mut low) = LOW.lock() else { return };
        let low = low.get_or_insert_with(HashSet::new);
        if minimized {
            low.insert(window.label().to_string())
        } else {
            low.remove(window.label())
        }
    };
    if !changed {
        return;
    }
    if let Some(webview) = window.get_webview_window(window.label()) {
        set_low(&webview, minimized);
    }
}

/// 窗口没了：忘掉它的状态（同一个标签以后再开，从 Normal 算起）
pub fn forget_window(label: &str) {
    if let Ok(mut low) = LOW.lock() {
        if let Some(low) = low.as_mut() {
            low.remove(label);
        }
    }
}

#[cfg(windows)]
fn set_low<R: Runtime>(webview: &tauri::WebviewWindow<R>, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows::core::Interface;

    let level = if low {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    };
    let _ = webview.with_webview(move |platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else { return };
        if let Ok(core) = core.cast::<ICoreWebView2_19>() {
            if let Err(error) = core.SetMemoryUsageTargetLevel(level) {
                eprintln!("设置 WebView2 内存用量目标失败: {error}");
            }
        }
    });
}

/// WKWebView / WebKitGTK 没有对应的接口
#[cfg(not(windows))]
fn set_low<R: Runtime>(_webview: &tauri::WebviewWindow<R>, _low: bool) {}
