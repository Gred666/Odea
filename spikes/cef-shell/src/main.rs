// CEF 试验的外壳（docs/插件与跨端.md §7、§10 P14.4）。同一个二进制里带着两个运行时，启动时选：
//   ODEA_RUNTIME   cef | wry（默认 cef）
//   ODEA_URL       打开哪个地址，比如 http://127.0.0.1:4173/?mock（量内存、跑逐帧时用开着的服务）。
//                  不给就开包里自带的前端 index.html?mock（tauri build 打的安装包装好以后单独能跑；
//                  cargo build 出来的开发版没带前端，落到 devUrl 上）。`?mock`：前端走浏览器预览的演示数据，
//                  外壳里没有 Odea 的后端，见 src/lib/tauri.ts 的 isTauri
//   ODEA_CDP_PORT  CEF 的 DevTools 协议端口；WebView2 的用环境变量
//                  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…
//   ODEA_DSF       设备缩放（CEF 加 --force-device-scale-factor；WebView2 同样走上面那个环境变量）
//   ODEA_CEF_ARGS  另加给 CEF 的命令行开关，逗号分开，`名字` 或 `名字=值`（比如 disable-extensions）
//   ODEA_CEF_CACHE CEF 的配置目录（默认是缓存目录下的 {identifier}/cef）：拿一个空目录验全新安装的样子
// 窗口 1280×800，两个运行时一样，量内存时只差引擎
#![windows_subsystem = "windows"]

use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri_runtime_cef::{Cef, RemoteDebugging};

#[tauri_runtime_cef::cef_entry_point]
fn main() {
    let runtime = std::env::var("ODEA_RUNTIME").unwrap_or_else(|_| "cef".into());
    let url = std::env::var("ODEA_URL").ok();
    let builder = tauri::Builder::default();
    let builder = if runtime == "wry" {
        builder.runtime(tauri_runtime_wry::Wry::default())
    } else {
        let mut cef = Cef::default();
        if let Some(port) = std::env::var("ODEA_CDP_PORT").ok().and_then(|p| p.parse().ok()) {
            cef = cef.remote_debugging(RemoteDebugging::Port {
                port,
                allowed_origins: Vec::new(),
            });
        }
        if let Ok(dsf) = std::env::var("ODEA_DSF") {
            cef = cef.command_line_arg("force-device-scale-factor", Some(dsf));
        }
        if let Ok(args) = std::env::var("ODEA_CEF_ARGS") {
            cef = cef.command_line_args(args.split(',').filter(|a| !a.is_empty()).map(|a| {
                match a.split_once('=') {
                    Some((k, v)) => (k.to_string(), Some(v.to_string())),
                    None => (a.to_string(), None),
                }
            }));
        }
        if let Ok(dir) = std::env::var("ODEA_CEF_CACHE") {
            cef = cef.root_cache_path(dir);
        }
        builder.runtime(cef)
    };
    let title = format!("odea-shell-{runtime}");
    builder
        .setup(move |app| {
            let url = match url {
                Some(url) => WebviewUrl::External(url.parse()?),
                None => WebviewUrl::App("index.html?mock".into()),
            };
            WebviewWindowBuilder::new(app, "main", url)
                .title(&title)
                .inner_size(1280.0, 800.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("外壳起不来");
}
