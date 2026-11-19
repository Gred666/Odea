//! 渲染进程没了也不白屏（docs/技术方案.md §8.9）。
//!
//! WebView2 的渲染进程崩溃、被杀、内存不够被系统收掉时，窗口里只剩一片白：页面里的代码一行都跑不了，
//! 前端的错误边界也帮不上。在宿主这一层挂 ProcessFailed：渲染进程退出了就重新载入原来的地址，带上
//! `recovered`（前端启动时见到它说一句发生了什么，boot/vault.tsx 的 noticeRecovered）。这个窗口的弹出窗口
//! 是它的页面画的，跟着一起没了，关掉。
//!
//! 只是不响应（RENDER_PROCESS_UNRESPONSIVE）不动它：可能过一会儿就好了，重新载入会丢掉没存的字。
//! 浏览器进程没了救不回来（要重建整个 WebView2），iframe 的进程没了（插件的沙箱）页面自己还在：都只记日志。
//!
//! 在 ready 里挂（每种窗口画好第一帧都调它，这时 controller 一定建好了）。重新载入以后又会调 ready：
//! 同一个窗口只挂一次，窗口没了（Destroyed）忘掉，同一个标签以后再开的是新的 WebView，再挂

#[cfg(feature = "desktop-runtime")]
use std::collections::HashSet;
#[cfg(feature = "desktop-runtime")]
use std::sync::Mutex;

#[cfg(feature = "desktop-runtime")]
use tauri::{Runtime, WebviewWindow};

/// 已经挂上的窗口
#[cfg(feature = "desktop-runtime")]
static WATCHED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// 前端认的记号：这一次是渲染进程没了以后重新载入的
const RECOVERED: &str = "recovered";

/// 窗口画好第一帧（lib.rs 的 ready）：挂上，已经挂过就不再挂
#[cfg(feature = "desktop-runtime")]
pub fn watch<R: Runtime>(window: &WebviewWindow<R>) {
    let fresh = WATCHED
        .lock()
        .map(|mut watched| watched.get_or_insert_with(HashSet::new).insert(window.label().to_string()))
        .unwrap_or(false);
    if fresh {
        attach(window);
    }
}

/// 窗口没了：同一个标签以后再开是新的 WebView，要重新挂
#[cfg(feature = "desktop-runtime")]
pub fn forget(label: &str) {
    if let Ok(mut watched) = WATCHED.lock() {
        if let Some(watched) = watched.as_mut() {
            watched.remove(label);
        }
    }
}

/// 原来的地址带上 recovered（已经带着就不再加）
fn recovered_url(source: &str) -> Option<String> {
    let mut url = url::Url::parse(source).ok()?;
    if !url.query_pairs().any(|(key, _)| key == RECOVERED) {
        url.query_pairs_mut().append_key_only(RECOVERED);
    }
    Some(url.into())
}

#[cfg(all(feature = "desktop-runtime", windows))]
fn attach<R: Runtime>(window: &WebviewWindow<R>) {
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    };
    use webview2_com::{take_pwstr, CoTaskMemPWSTR, ProcessFailedEventHandler};
    use windows::core::PWSTR;

    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let _ = window.with_webview(move |platform| unsafe {
        let core = match platform.controller().CoreWebView2() {
            Ok(core) => core,
            Err(error) => {
                eprintln!("窗口 {label} 挂不上渲染进程的看护: {error}");
                return;
            }
        };
        let watched = label.clone();
        let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
            let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            args.ProcessFailedKind(&mut kind)?;
            if kind != COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                eprintln!("窗口 {watched} 的 WebView2 出了问题（ProcessFailedKind {}），不自动处理", kind.0);
                return Ok(());
            }
            let mut source = PWSTR::null();
            sender.Source(&mut source)?;
            let source = take_pwstr(source);
            let Some(url) = recovered_url(&source) else {
                eprintln!("窗口 {watched} 的渲染进程没了，地址 {source} 认不出来，没法重新载入");
                return Ok(());
            };
            eprintln!("窗口 {watched} 的渲染进程没了，重新载入 {url}");
            let url = CoTaskMemPWSTR::from(url.as_str());
            sender.Navigate(*url.as_ref().as_pcwstr())?;
            crate::popout::close_owned_by(&app, &watched);
            Ok(())
        }));
        let mut token = 0;
        if let Err(error) = core.add_ProcessFailed(&handler, &mut token) {
            eprintln!("窗口 {label} 挂不上渲染进程的看护: {error}");
        }
    });
}

/// WKWebView / WebKitGTK：没有对应的事件，渲染进程没了由系统处理
#[cfg(all(feature = "desktop-runtime", not(windows)))]
fn attach<R: Runtime>(_window: &WebviewWindow<R>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reload_keeps_the_window_kind_and_adds_the_mark_once() {
        assert_eq!(recovered_url("http://tauri.localhost/").as_deref(), Some("http://tauri.localhost/?recovered"));
        assert_eq!(
            recovered_url("http://tauri.localhost/index.html?quiet").as_deref(),
            Some("http://tauri.localhost/index.html?quiet&recovered")
        );
        assert_eq!(
            recovered_url("http://127.0.0.1:1420/index.html?launcher&recovered").as_deref(),
            Some("http://127.0.0.1:1420/index.html?launcher&recovered")
        );
        assert_eq!(recovered_url("不是地址"), None);
    }
}
