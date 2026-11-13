//! 导出一篇笔记、整个文件夹（docs/TODO.md P15「导出 PDF / HTML」）。
//!
//! 排版全在前端（src/export/）：正文排成一整页自带样式的 HTML（图片嵌成 data:，公式、图表画好），
//! 这里只管落到哪、怎么落：
//!
//! - 先弹「另存为」（export_pick），选好了前端再排版：点了命令马上就有对话框，不用等排版。
//!   写文件的两个命令只认刚在对话框里选的那个路径（PICKED），前端没法叫 Rust 往别处写
//! - HTML：原样写进去
//! - PDF：Windows 上在一个看不见的窗口里打开这一页，WebView2 的 PrintToPdf 直接写成 PDF —— 页边距、
//!   页眉页脚都是这一页自己的 `@page` 定的，纸张是页面设置里选的（前端一并给尺寸），背景色照印（代码块、callout 的底）。
//!   整个文件夹导出成 PDF 是前端排成一整页（每篇另起一页），走的是同一条路
//!   macOS 的 WKWebView、Linux 的 WebKitGTK 没有不弹框的「打印成 PDF」：开一个窗口显示这一页、
//!   弹系统的打印对话框，在那里存成 PDF（这两个平台没在真机上走过）
//! - 本机图片由前端问 export_image 要成 data:，嵌进页面
//! - 整个文件夹导出成网页：选一个放的地方，在里面新建一个文件夹（export_folder_pick），前端一页页交给
//!   export_folder_write 写进去 —— 也只认刚建的那个文件夹、里面的相对路径一段段都得是正常的名字
//!
//! 「另存为」从上次导出的文件夹开始（这次运行里记着），第一次是「文档」。

// 起名字的两个纯函数不带 Tauri，CI 的 --no-default-features 也测得到；别的都要 Tauri
use std::path::PathBuf;
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
use std::{path::Path, sync::Mutex};
#[cfg(feature = "desktop-runtime")]
use std::{
    sync::atomic::{AtomicU32, Ordering},
    time::Duration,
};

#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
use tauri::{AppHandle, Manager, Runtime};
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
use tauri_plugin_dialog::DialogExt;

#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
use crate::commands::blocking;
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
use crate::error::{AppError, Result};
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
use crate::vault::fsio;

/// 打印用的窗口的标签前缀：窗口位置不记（lib.rs 的 window-state）
pub const PREFIX: &str = "print-";

pub fn is_print(label: &str) -> bool {
    label.starts_with(PREFIX)
}

#[cfg(feature = "desktop-runtime")]
static NEXT: AtomicU32 = AtomicU32::new(1);
/// 上次导出到哪个文件夹：下次「另存为」从这里开始
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
static LAST_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
#[derive(Clone, Copy)]
enum Kind {
    Html,
    Pdf,
}

#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
impl Kind {
    fn ext(self) -> &'static str {
        match self {
            Kind::Html => "html",
            Kind::Pdf => "pdf",
        }
    }
}

/// 标题 → 文件名（不带扩展名）：Windows 不让用的字符换成空格，太长的截断，空的叫「导出」
pub fn file_stem(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| if c.is_control() || r#"\/:*?"<>|"#.contains(c) { ' ' } else { c })
        .collect();
    let squeezed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    // 结尾的点 Windows 会吞掉
    let trimmed = squeezed.trim_end_matches('.').trim();
    let short: String = trimmed.chars().take(100).collect();
    if short.is_empty() {
        "导出".into()
    } else {
        short
    }
}

/// 对话框里没写扩展名（或者写的是别的）就补上。`v1.2` 补成 `v1.2.pdf`，不是 `v1.pdf`
pub fn with_ext(path: PathBuf, ext: &str) -> PathBuf {
    if path.extension().is_some_and(|have| have.eq_ignore_ascii_case(ext)) {
        return path;
    }
    let mut name = path.into_os_string();
    name.push(format!(".{ext}"));
    PathBuf::from(name)
}

/// 图片扩展名 → MIME（和 asset 协议放行的那几种一样，vault::IMAGE_EXTENSIONS）
pub fn image_mime(path: &std::path::Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

/// 嵌进导出页面的图片最大多大：再大的照样导出，只是那一张显示成找不到
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
const MAX_IMAGE_BYTES: u64 = 30 * 1_048_576;

/// 导出时把一张本机图片嵌进页面：读出来，返回 data: 地址。只认图片扩展名（和 asset 协议放行的一样，
/// 前端本来就能显示它们）；不是图片、太大（30 MB）、读不到返回 null
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
#[tauri::command]
#[specta::specta]
pub async fn export_image(path: String) -> Result<Option<String>> {
    use base64::Engine;
    blocking(move || {
        let path = PathBuf::from(path);
        let Some(mime) = image_mime(&path) else { return Ok(None) };
        let Ok(meta) = std::fs::metadata(&path) else { return Ok(None) };
        if !meta.is_file() || meta.len() > MAX_IMAGE_BYTES {
            return Ok(None);
        }
        let Ok(bytes) = std::fs::read(&path) else { return Ok(None) };
        Ok(Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))))
    })
    .await
}

/// 在「另存为」里选过、还没写的路径：export_html / export_pdf 只往这里面的路径写，用一次就划掉。
/// 前端不能叫 Rust 往随便哪个路径写文件，写哪儿一定是人在对话框里选的
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
static PICKED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// 选过的这个路径还没用掉：划掉它，返回 true
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
fn take_picked(path: &Path) -> bool {
    let Ok(mut picked) = PICKED.lock() else { return false };
    let Some(index) = picked.iter().position(|known| known == path) else { return false };
    picked.remove(index);
    true
}

/// 导出前先弹「另存为」（文件名是标题，从上次导出的文件夹开始）。format 是 `html` 或 `pdf`。
/// 返回选的路径，取消了返回 null。选好了再排版（前端），排好了交给 export_html / export_pdf 写
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
#[tauri::command]
#[specta::specta]
pub async fn export_pick<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::Window<R>,
    title: String,
    format: String,
) -> Result<Option<String>> {
    let kind = match format.as_str() {
        "html" => Kind::Html,
        "pdf" => Kind::Pdf,
        _ => return Err(AppError::Invalid(format!("不认识的导出格式: {format}"))),
    };
    let picker = app.clone();
    let start = LAST_DIR
        .lock()
        .ok()
        .and_then(|dir| dir.clone())
        .filter(|dir| dir.is_dir())
        .or_else(|| app.path().document_dir().ok());
    let ext = kind.ext();
    let file_name = format!("{}.{ext}", file_stem(&title));
    let picked = blocking(move || {
        let (label, heading) = match kind {
            Kind::Html => ("网页", "导出为 HTML"),
            Kind::Pdf => ("PDF", "导出为 PDF"),
        };
        // 挂在点它的那个窗口上：模态、一定在它前面（没有父窗口的对话框可能弹在主窗口后面）
        let mut dialog = picker
            .dialog()
            .file()
            .set_parent(&window)
            .set_title(heading)
            .set_file_name(file_name)
            .add_filter(label, &[ext]);
        if let Some(start) = start {
            dialog = dialog.set_directory(start);
        }
        Ok(dialog.blocking_save_file())
    })
    .await?;
    let Some(path) = picked.and_then(|picked| picked.into_path().ok()).map(|path| with_ext(path, ext)) else {
        return Ok(None);
    };
    if let Ok(mut known) = PICKED.lock() {
        // 选了又没写的（排版失败了）不会一直攒着
        if known.len() > 16 {
            known.remove(0);
        }
        known.push(path.clone());
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
fn remember_dir(path: &Path) {
    if let (Some(dir), Ok(mut last)) = (path.parent(), LAST_DIR.lock()) {
        *last = Some(dir.to_path_buf());
    }
}

/// 导出成 HTML：写进刚在「另存为」里选的那个路径（export_pick）
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
#[tauri::command]
#[specta::specta]
pub async fn export_html(path: String, html: String) -> Result<()> {
    let target = PathBuf::from(path);
    if !take_picked(&target) {
        return Err(AppError::Invalid("只能存到「另存为」里选的地方".into()));
    }
    let written = target.clone();
    blocking(move || fsio::write_atomic(&written, &html)).await?;
    remember_dir(&target);
    Ok(())
}

/// 纸张（毫米）→ 英寸。超出常见纸张范围的（50–1200 毫米以外）不认，按 A4
pub fn paper_inches(width_mm: f64, height_mm: f64) -> (f64, f64) {
    let ok = |mm: f64| mm.is_finite() && (50.0..=1200.0).contains(&mm);
    if ok(width_mm) && ok(height_mm) {
        (width_mm / 25.4, height_mm / 25.4)
    } else {
        (210.0 / 25.4, 297.0 / 25.4)
    }
}

/// 导出成 PDF。Windows：不弹打印框，直接写到刚在「另存为」里选的那个路径（export_pick），返回 true。
/// 别的平台（path 给 null）：开一个窗口显示这一页、弹系统的打印对话框，在那里存成 PDF，返回 false。
/// 纸张是页面设置里选的（毫米，横着放的已经换过来），和页面的 `@page size` 是同一个
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
#[tauri::command]
#[specta::specta]
pub async fn export_pdf<R: Runtime>(
    app: AppHandle<R>,
    path: Option<String>,
    title: String,
    html: String,
    width_mm: f64,
    height_mm: f64,
) -> Result<bool> {
    #[cfg(all(windows, feature = "desktop-runtime"))]
    {
        let _ = title;
        let target = PathBuf::from(path.unwrap_or_default());
        if !take_picked(&target) {
            return Err(AppError::Invalid("只能存到「另存为」里选的地方".into()));
        }
        let page = write_page(&html)?;
        let printed = webview2::print_to_pdf(&app, &page, &target, paper_inches(width_mm, height_mm)).await;
        let _ = std::fs::remove_file(&page);
        printed?;
        remember_dir(&target);
        Ok(true)
    }
    #[cfg(all(not(windows), feature = "desktop-runtime"))]
    {
        // 系统的打印对话框按页面的 @page 定纸张，用户在那里还能改
        let _ = (path, width_mm, height_mm);
        let page = write_page(&html)?;
        print_dialog(&app, &title, &page).await?;
        Ok(false)
    }
    #[cfg(not(feature = "desktop-runtime"))]
    {
        let _ = (app, path, title, html, width_mm, height_mm);
        Err(AppError::Invalid("只有桌面端能导出 PDF".into()))
    }
}

/* ---------------- 导出整个文件夹成网页（每篇一页，外加目录 index.html） ---------------- */

/// 正在往里写的导出文件夹：export_folder_write 只往这里面写，export_folder_done 划掉
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
static FOLDER_ROOTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// 前端给的、导出文件夹里的相对路径（`工作/周报.html`）：一段段都得是正常的名字 ——
/// 没有 `..`、`.`、盘符、反斜杠，不以点开头，最后是 .html。不认返回 None
pub fn export_rel_path(rel: &str) -> Option<PathBuf> {
    let parts: Vec<&str> = rel.split('/').collect();
    let ok = !rel.is_empty()
        && rel.len() <= 1024
        && parts.iter().all(|part| {
            !part.is_empty()
                && !part.starts_with('.')
                && !part.ends_with(' ')
                && !part.ends_with('.')
                && !part.chars().any(|c| c.is_control() || r#"\:*?"<>|"#.contains(c))
        })
        && parts.last().is_some_and(|last| last.to_ascii_lowercase().ends_with(".html"));
    ok.then(|| parts.iter().collect())
}

/// 导出整个文件夹：选一个放的地方，在里面新建一个以 title 命名的文件夹（重名的加「 2」「 3」），返回它。
/// 取消了返回 null。之后 export_folder_write 一篇篇往里写，写完调 export_folder_done
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
#[tauri::command]
#[specta::specta]
pub async fn export_folder_pick<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::Window<R>,
    title: String,
) -> Result<Option<String>> {
    let picker = app.clone();
    let start = LAST_DIR
        .lock()
        .ok()
        .and_then(|dir| dir.clone())
        .filter(|dir| dir.is_dir())
        .or_else(|| app.path().document_dir().ok());
    let picked = blocking(move || {
        let mut dialog = picker
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("导出到哪个文件夹里");
        if let Some(start) = start {
            dialog = dialog.set_directory(start);
        }
        Ok(dialog.blocking_pick_folder())
    })
    .await?;
    let Some(parent) = picked.and_then(|picked| picked.into_path().ok()) else {
        return Ok(None);
    };
    let stem = file_stem(&title);
    let root = blocking(move || {
        for n in 1..1000 {
            let name = if n == 1 { stem.clone() } else { format!("{stem} {n}") };
            let root = parent.join(name);
            // create_dir 不覆盖：已经有了就换下一个名字
            match std::fs::create_dir(&root) {
                Ok(()) => return Ok(root),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(AppError::Io(format!("建不了导出的文件夹: {error}"))),
            }
        }
        Err(AppError::Io("同名的文件夹太多了".into()))
    })
    .await?;
    if let Ok(mut roots) = FOLDER_ROOTS.lock() {
        if roots.len() > 8 {
            roots.remove(0);
        }
        roots.push(root.clone());
    }
    remember_dir(&root);
    Ok(Some(root.to_string_lossy().into_owned()))
}

/// 往刚建的导出文件夹（export_folder_pick）里写一页。rel 是里面的相对路径（export_rel_path 的规矩）
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
#[tauri::command]
#[specta::specta]
pub async fn export_folder_write(root: String, rel: String, html: String) -> Result<()> {
    let root = PathBuf::from(root);
    let known = FOLDER_ROOTS.lock().map(|roots| roots.contains(&root)).unwrap_or(false);
    if !known {
        return Err(AppError::Invalid("只能写进刚建的导出文件夹".into()));
    }
    let rel = export_rel_path(&rel).ok_or_else(|| AppError::Invalid(format!("文件名不对: {rel}")))?;
    blocking(move || fsio::write_atomic(&root.join(rel), &html)).await
}

/// 导出整个文件夹写完了（或者半路失败了）：这个文件夹不能再往里写
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
#[tauri::command]
#[specta::specta]
pub async fn export_folder_done(root: String) -> Result<()> {
    let root = PathBuf::from(root);
    if let Ok(mut roots) = FOLDER_ROOTS.lock() {
        roots.retain(|known| known != &root);
    }
    Ok(())
}

/// 打印用的那一页先落到临时文件夹（窗口从 file:// 打开它）。顺手清掉以前剩下的（超过一天的）
#[cfg(feature = "desktop-runtime")]
fn write_page(html: &str) -> Result<PathBuf> {
    let dir = std::env::temp_dir().join("odea-print");
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.elapsed().ok())
                .is_some_and(|age| age > Duration::from_secs(86_400));
            if old {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let path = dir.join(format!("{}.html", uuid::Uuid::now_v7()));
    fsio::write_atomic(&path, html)?;
    Ok(path)
}

/// 新窗口的标签
#[cfg(feature = "desktop-runtime")]
fn next_label() -> String {
    format!("{PREFIX}{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

/// 本地文件的地址（窗口从这里打开那一页）
#[cfg(feature = "desktop-runtime")]
fn page_url(page: &Path) -> Result<tauri::Url> {
    tauri::Url::from_file_path(page).map_err(|_| AppError::Internal(format!("临时文件的路径不对: {}", page.display())))
}

/// macOS / Linux：开一个窗口显示这一页，载入完弹系统的打印对话框。窗口留着，用户自己关
#[cfg(all(not(windows), feature = "desktop-runtime"))]
async fn print_dialog<R: Runtime>(app: &AppHandle<R>, title: &str, page: &Path) -> Result<()> {
    use tauri::webview::PageLoadEvent;
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let tx = Mutex::new(Some(tx));
    let window = WebviewWindowBuilder::new(app, next_label(), WebviewUrl::External(page_url(page)?))
        .title(format!("{title} — 打印"))
        .inner_size(820.0, 960.0)
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                if let Some(tx) = tx.lock().ok().and_then(|mut tx| tx.take()) {
                    let _ = tx.send(());
                }
            }
        })
        .build()
        .map_err(|error| AppError::Internal(format!("开打印窗口失败: {error}")))?;
    let _ = tokio::time::timeout(Duration::from_secs(20), rx).await;
    // macOS 上 window.print() 在 WKWebView 里不管用，要走 Tauri 的 print（NSPrintOperation）；
    // Linux 上两样都是 WebKitGTK 的打印对话框
    window.print().map_err(|error| AppError::Internal(format!("打开打印对话框失败: {error}")))
}

/// Windows：WebView2 的 PrintToPdf
#[cfg(all(windows, feature = "desktop-runtime"))]
mod webview2 {
    use std::path::Path;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use tauri::webview::PageLoadEvent;
    use tauri::{AppHandle, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
    use tokio::sync::oneshot;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_2, ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::{ExecuteScriptCompletedHandler, PrintToPdfCompletedHandler};
    use windows::core::{Interface, HSTRING};

    use super::{next_label, page_url};
    use crate::error::{AppError, Result};

    /// 页面载入完、字体和图片都到了：图片是 data:，网络图片要等一会儿
    const READY: &str = "document.readyState === 'complete' && document.fonts.status === 'loaded' \
                         && Array.from(document.images).every((image) => image.complete)";

    /// paper 是纸张（英寸，宽 × 高）。页边距、页眉页脚由页面的 @page 定（src/export/pageSetup.ts），这里不另加
    pub async fn print_to_pdf<R: Runtime>(
        app: &AppHandle<R>,
        page: &Path,
        out: &Path,
        paper: (f64, f64),
    ) -> Result<()> {
        let (tx, rx) = oneshot::channel::<()>();
        let tx = Mutex::new(Some(tx));
        let window = WebviewWindowBuilder::new(app, next_label(), WebviewUrl::External(page_url(page)?))
            .title("Odea 导出")
            .visible(false)
            .focused(false)
            .skip_taskbar(true)
            .inner_size(816.0, 1056.0)
            .on_page_load(move |_, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished) {
                    if let Some(tx) = tx.lock().ok().and_then(|mut tx| tx.take()) {
                        let _ = tx.send(());
                    }
                }
            })
            .build()
            .map_err(|error| AppError::Internal(format!("开导出窗口失败: {error}")))?;
        let printed = async {
            tokio::time::timeout(Duration::from_secs(30), rx)
                .await
                .map_err(|_| AppError::Internal("导出的页面 30 秒还没载入完".into()))?
                .map_err(|_| AppError::Internal("导出的页面没载入".into()))?;
            wait_ready(&window).await;
            write_pdf(&window, out, paper).await
        }
        .await;
        let _ = window.destroy();
        printed
    }

    /// 等字体、图片：每 50ms 问一次，最多 10 秒（网络图片加载不出来也照样印，缺一张图）
    async fn wait_ready<R: Runtime>(window: &WebviewWindow<R>) {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(10) {
            if eval(window, READY).await.as_deref() == Some("true") {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// 在那一页里跑一段脚本，拿回结果（JSON 文本）
    async fn eval<R: Runtime>(window: &WebviewWindow<R>, script: &'static str) -> Option<String> {
        let (tx, rx) = oneshot::channel::<String>();
        window
            .with_webview(move |platform| unsafe {
                let Ok(core) = platform.controller().CoreWebView2() else { return };
                let handler = ExecuteScriptCompletedHandler::create(Box::new(move |result, json| {
                    if result.is_ok() {
                        let _ = tx.send(json);
                    }
                    Ok(())
                }));
                let _ = core.ExecuteScript(&HSTRING::from(script), &handler);
            })
            .ok()?;
        tokio::time::timeout(Duration::from_secs(5), rx).await.ok()?.ok()
    }

    async fn write_pdf<R: Runtime>(window: &WebviewWindow<R>, out: &Path, paper: (f64, f64)) -> Result<()> {
        let (tx, rx) = oneshot::channel::<std::result::Result<(), String>>();
        let target = HSTRING::from(out.as_os_str());
        window
            .with_webview(move |platform| unsafe {
                let start = || -> windows::core::Result<()> {
                    let core = platform.controller().CoreWebView2()?;
                    let environment = core.cast::<ICoreWebView2_2>()?.Environment()?;
                    let settings = environment.cast::<ICoreWebView2Environment6>()?.CreatePrintSettings()?;
                    settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)?;
                    // 横着放的纸也按竖着打、宽高已经换过来了（和 @page size 一样）
                    settings.SetPageWidth(paper.0)?;
                    settings.SetPageHeight(paper.1)?;
                    settings.SetMarginTop(0.0)?;
                    settings.SetMarginBottom(0.0)?;
                    settings.SetMarginLeft(0.0)?;
                    settings.SetMarginRight(0.0)?;
                    settings.SetShouldPrintBackgrounds(true)?;
                    settings.SetShouldPrintHeaderAndFooter(false)?;
                    let tx = Mutex::new(Some(tx));
                    let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                        let outcome = match result {
                            Err(error) => Err(error.message()),
                            Ok(()) if !ok => Err("WebView2 没写出来（文件被别的程序占着？）".into()),
                            Ok(()) => Ok(()),
                        };
                        if let Some(tx) = tx.lock().ok().and_then(|mut tx| tx.take()) {
                            let _ = tx.send(outcome);
                        }
                        Ok(())
                    }));
                    core.cast::<ICoreWebView2_7>()?.PrintToPdf(&target, &settings, &handler)
                };
                if let Err(error) = start() {
                    eprintln!("打印成 PDF 没开始: {error}");
                }
            })
            .map_err(|error| AppError::Internal(format!("导出窗口不在了: {error}")))?;
        match tokio::time::timeout(Duration::from_secs(60), rx).await {
            Ok(Ok(Ok(()))) => Ok(()),
            Ok(Ok(Err(message))) => Err(AppError::Io(format!("写 PDF 失败: {message}"))),
            Ok(Err(_)) => Err(AppError::Internal("这个 WebView2 太旧，不能打印成 PDF（要 Edge 内核 103 以上）".into())),
            Err(_) => Err(AppError::Internal("写 PDF 超过一分钟还没完".into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_become_file_names_windows_accepts() {
        // 全角的「：」Windows 允许，半角的 `:` 不行
        assert_eq!(file_stem("周报：第 3 周 / 草稿: v2"), "周报：第 3 周 草稿 v2");
        assert_eq!(file_stem("a<b>c?\"d\"|e*"), "a b c d e");
        assert_eq!(file_stem("结尾的点..."), "结尾的点");
        assert_eq!(file_stem("   "), "导出");
        assert_eq!(file_stem("换\n行"), "换 行");
        assert_eq!(file_stem(&"长".repeat(300)).chars().count(), 100);
    }

    #[test]
    fn only_images_are_read_for_the_page() {
        use std::path::Path;
        assert_eq!(image_mime(Path::new("D:/库/附件/图.PNG")), Some("image/png"));
        assert_eq!(image_mime(Path::new("/a/b.jpeg")), Some("image/jpeg"));
        assert_eq!(image_mime(Path::new("/a/流程.svg")), Some("image/svg+xml"));
        assert_eq!(image_mime(Path::new("/a/密码.txt")), None);
        assert_eq!(image_mime(Path::new("/a/没有扩展名")), None);
    }

    #[test]
    fn pages_of_a_folder_export_stay_inside_it() {
        assert_eq!(export_rel_path("index.html"), Some(PathBuf::from("index.html")));
        assert_eq!(export_rel_path("工作/周报 (2).html"), Some(PathBuf::from("工作").join("周报 (2).html")));
        assert_eq!(export_rel_path("../外面.html"), None);
        assert_eq!(export_rel_path("工作/./周报.html"), None);
        assert_eq!(export_rel_path("/根.html"), None);
        assert_eq!(export_rel_path("C:/a.html"), None);
        assert_eq!(export_rel_path("a\\b.html"), None);
        assert_eq!(export_rel_path(".隐藏/a.html"), None);
        assert_eq!(export_rel_path("工作//周报.html"), None);
        assert_eq!(export_rel_path("脚本.js"), None, "只写网页");
        assert_eq!(export_rel_path(""), None);
    }

    #[test]
    fn paper_sizes_are_inches_and_odd_ones_fall_back_to_a4() {
        let (width, height) = paper_inches(297.0, 210.0);
        assert!((width - 11.69).abs() < 0.01 && (height - 8.27).abs() < 0.01, "横着的 A4");
        assert_eq!(paper_inches(0.0, 297.0), paper_inches(210.0, 297.0));
        assert_eq!(paper_inches(f64::NAN, 297.0), paper_inches(210.0, 297.0));
        assert_eq!(paper_inches(210.0, 99_999.0), paper_inches(210.0, 297.0));
    }

    #[test]
    fn the_extension_is_added_only_when_missing() {
        assert_eq!(with_ext(PathBuf::from("D:/a/报告"), "pdf"), PathBuf::from("D:/a/报告.pdf"));
        assert_eq!(with_ext(PathBuf::from("D:/a/报告.PDF"), "pdf"), PathBuf::from("D:/a/报告.PDF"));
        assert_eq!(with_ext(PathBuf::from("D:/a/v1.2"), "pdf"), PathBuf::from("D:/a/v1.2.pdf"));
        assert_eq!(with_ext(PathBuf::from("D:/a/页.html"), "pdf"), PathBuf::from("D:/a/页.html.pdf"));
    }
}
