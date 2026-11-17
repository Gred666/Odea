//! 每种窗口许去哪些地址（docs/技术方案.md §14.1.1，审查 §6.3）。
//!
//! 每个建窗口的地方都挂 `on_navigation(guard(..))`：窗口的主框架（macOS / Linux 上连 iframe）每次要去一个地址先问这里，
//! 不许的就不去、记一行。这是第二层：正文、预览里的链接由各自的控件拦下交给浏览器（前端的 `openExternal`），
//! 哪个控件忘了拦，窗口也不会跳到别的网址去。这里不替用户开浏览器。

use url::Url;

/// 哪种窗口
#[derive(Debug, Clone)]
pub enum Window {
    /// 仓库窗口：应用自己的页面，加上插件沙箱页（macOS / Linux 上 iframe 的导航也问这里，Windows 上只问主框架）
    Vault,
    /// 启动器
    Launcher,
    /// 协作访客窗口
    Guest,
    /// 速记小窗
    Capture,
    /// 弹出窗口：只有 `window.open` 开的那个 `about:blank`（内容是仓库窗口 portal 过去的，popout.rs）
    Popout,
    /// 打印 / 导出 PDF 的窗口：只有它自己那一页 `file://`（print.rs）
    Print(Url),
}

/// 应用自己的地址：建窗口时从配置算一次
#[derive(Debug, Clone)]
pub struct Own {
    /// 应用页面：开发时是 devUrl，打包后是 tauri 自己的协议
    app: Url,
    /// 带脚本的插件的沙箱页（plugins/sandbox.rs）
    sandbox: Url,
}

impl Own {
    /// `app`：配置里给了网址就是它（tauri 的 `get_app_url`：开发时的 devUrl、`frontendDist` 是网址时的那个）；
    /// 没有就是 tauri 自己的协议。`windows`：Windows 上 wry 把自定义协议换成 `http://<协议>.localhost`，
    /// 别的平台是 `<协议>://localhost`（tauri 的 `tauri_protocol_url` 同一条）。
    /// 是 http 不是 https：哪个窗口都没设 `use_https_scheme`。这时 `https://tauri.localhost` 不是应用 ——
    /// WebView2 只截 http 那个，https 的会去连本机 443 端口上别的程序，所以协议要一模一样
    pub fn new(app: Option<Url>, windows: bool) -> Own {
        let protocol = |scheme: &str| {
            let base =
                if windows { format!("http://{scheme}.localhost/") } else { format!("{scheme}://localhost/") };
            Url::parse(&base).expect("写死的地址解析得了")
        };
        let sandbox = protocol(crate::plugins::sandbox::SCHEME)
            .join(crate::plugins::sandbox::PATH)
            .expect("写死的路径拼得上");
        Own { app: app.unwrap_or_else(|| protocol("tauri")), sandbox }
    }
}

/// 这个窗口能不能去 `url`
pub fn allowed(window: &Window, url: &Url, own: &Own) -> bool {
    match window {
        Window::Vault => same_origin(url, &own.app) || same_page(url, &own.sandbox),
        Window::Launcher | Window::Guest | Window::Capture => same_origin(url, &own.app),
        Window::Popout => url.scheme() == "about" && url.path() == "blank" && url.query().is_none(),
        Window::Print(page) => same_file(url, page),
    }
}

/// 协议、主机、端口三样都一样，地址里不带用户名密码。不用 `Url::origin()`：`tauri://` 这类非特殊协议的
/// origin 是 opaque 的，两个永远不相等
fn same_origin(url: &Url, own: &Url) -> bool {
    url.scheme() == own.scheme()
        && url.host() == own.host()
        && url.port_or_known_default() == own.port_or_known_default()
        && url.username().is_empty()
        && url.password().is_none()
}

/// 同一个源上的同一页（查询、锚点不管）
fn same_page(url: &Url, page: &Url) -> bool {
    same_origin(url, page) && url.path() == page.path()
}

/// 同一个本机文件（锚点不管）。按解码后的路径比：WebView2 交回来的地址和 `Url::from_file_path` 拼的，
/// 百分号编码不一定一字不差
fn same_file(url: &Url, page: &Url) -> bool {
    url.scheme() == "file"
        && url.host() == page.host()
        && matches!((url.to_file_path(), page.to_file_path()), (Ok(a), Ok(b)) if a == b)
}

/// 挡下时日志里写的：只有协议和主机（路径、查询里可能有用户的东西）
fn where_to(url: &Url) -> String {
    match url.host_str() {
        Some(host) if !host.is_empty() => format!("{}://{host}", url.scheme()),
        _ => format!("{}:", url.scheme()),
    }
}

/// 建窗口时挂上：`builder.on_navigation(navigation::guard(app, &label, Window::Vault))`
#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
pub fn guard<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    window: Window,
) -> impl Fn(&Url) -> bool + Send + 'static {
    let build = &app.config().build;
    let configured = if tauri::is_dev() {
        build.dev_url.clone()
    } else {
        match &build.frontend_dist {
            Some(tauri::utils::config::FrontendDist::Url(url)) => Some(url.clone()),
            _ => None,
        }
    };
    let own = Own::new(configured, cfg!(windows));
    let label = label.to_owned();
    move |url| {
        let ok = allowed(&window, url, &own);
        if !ok {
            eprintln!("窗口 {label} 不去 {}：只许去应用自己的地址", where_to(url));
        }
        ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap_or_else(|error| panic!("{text}: {error}"))
    }

    /// 打包后的 Windows
    fn windows() -> Own {
        Own::new(None, true)
    }

    /// 打包后的 macOS / Linux
    fn unix() -> Own {
        Own::new(None, false)
    }

    /// 开发时（tauri dev）
    fn dev() -> Own {
        Own::new(Some(url("http://127.0.0.1:1420")), true)
    }

    const APP_WINDOWS: [Window; 4] = [Window::Vault, Window::Launcher, Window::Guest, Window::Capture];

    fn check(window: &Window, own: &Own, pass: &[&str], block: &[&str]) {
        for text in pass {
            assert!(allowed(window, &url(text), own), "{window:?} 应该许去 {text}");
        }
        for text in block {
            assert!(!allowed(window, &url(text), own), "{window:?} 不该许去 {text}");
        }
    }

    /// 别的网址、看着像应用的、别的协议：哪种窗口都不去
    const FOREIGN: [&str; 16] = [
        "https://example.com/",
        "http://127.0.0.1:1/",
        "https://tauri.localhost.evil.example/",
        "http://tauri.localhost.evil.example/",
        "http://evil.tauri.localhost/",
        "http://127.0.0.1:1420@evil.example/",
        "file:///C:/Windows/win.ini",
        "javascript:alert(1)",
        "data:text/html,<p>hi</p>",
        "blob:http://tauri.localhost/0b6a0b0e-3f9d-4c6e-9a51-2c0d2a1e6f00",
        "about:srcdoc",
        "odea://join/abc",
        "http://asset.localhost/C%3A%2Fa.png",
        "asset://localhost/%2Fhome%2Fa.png",
        "mailto:someone@example.com",
        "ws://127.0.0.1:1420/",
    ];

    #[test]
    fn app_windows_stay_on_the_app_in_a_windows_build() {
        let own = windows();
        for window in &APP_WINDOWS {
            check(
                window,
                &own,
                &[
                    "http://tauri.localhost/",
                    "http://tauri.localhost/index.html",
                    "http://tauri.localhost/index.html?launcher",
                    "http://tauri.localhost/index.html?quiet#top",
                    "http://TAURI.localhost:80/index.html",
                ],
                &[
                    // https 那个不是应用：WebView2 只截 http://tauri.localhost
                    "https://tauri.localhost/",
                    "http://tauri.localhost:8080/",
                    // 尾部带点：WebView2 不截它，*.localhost 解析到本机，去的是 80 端口上别的程序
                    "http://tauri.localhost./",
                    "http://user@tauri.localhost/",
                    "http://user:pass@tauri.localhost/",
                    "tauri://localhost/",
                    // 打包以后开发服务器不是应用
                    "http://127.0.0.1:1420/",
                    "about:blank",
                ],
            );
            check(window, &own, &[], &FOREIGN);
        }
    }

    #[test]
    fn app_windows_stay_on_the_app_on_macos_and_linux() {
        let own = unix();
        for window in &APP_WINDOWS {
            check(
                window,
                &own,
                &["tauri://localhost/", "tauri://localhost/index.html?guest", "tauri://localhost/index.html#x"],
                &[
                    "tauri://localhost.evil.example/",
                    "tauri://evil/",
                    "tauri://user@localhost/",
                    "tauri://localhost:1/",
                    // Windows 上的写法在这两个平台上不是应用
                    "http://tauri.localhost/",
                ],
            );
            check(window, &own, &[], &FOREIGN);
        }
    }

    #[test]
    fn dev_builds_stay_on_the_dev_server() {
        let own = dev();
        for window in &APP_WINDOWS {
            check(
                window,
                &own,
                &["http://127.0.0.1:1420/", "http://127.0.0.1:1420/index.html?quiet", "http://127.0.0.1:1420/src/main.tsx"],
                &[
                    "http://127.0.0.1:14200/",
                    "http://127.0.0.1:142/",
                    "http://127.0.0.1/",
                    "https://127.0.0.1:1420/",
                    "http://localhost:1420/",
                    "http://127.0.0.1:1420@evil.example/",
                    "http://evil.example@127.0.0.1:1420/",
                    // 开发时应用不在 tauri 自己的协议上
                    "http://tauri.localhost/",
                ],
            );
            check(window, &own, &[], &FOREIGN);
        }
        // devUrl 写成 IPv6 的：同一个地址的不同写法算一个，别的本机地址不算
        let own = Own::new(Some(url("http://[::1]:1420")), true);
        check(
            &Window::Vault,
            &own,
            &["http://[::1]:1420/", "http://[0:0:0:0:0:0:0:1]:1420/index.html"],
            &["http://127.0.0.1:1420/", "http://[::2]:1420/", "http://[::1]:1421/", "http://localhost:1420/"],
        );
    }

    /// 插件沙箱页：只在仓库窗口里起（boot/vault.tsx），macOS / Linux 上 iframe 的导航也问这里
    #[test]
    fn only_vault_windows_open_the_plugin_sandbox() {
        for (own, page, other) in [
            (windows(), "http://odea-plugin.localhost/sandbox.html", "http://odea-plugin.localhost/main.js"),
            (dev(), "http://odea-plugin.localhost/sandbox.html", "http://odea-plugin.localhost/"),
            (unix(), "odea-plugin://localhost/sandbox.html", "odea-plugin://localhost/index.html"),
        ] {
            check(&Window::Vault, &own, &[page], &[other, "https://odea-plugin.localhost/sandbox.html"]);
            for window in [Window::Launcher, Window::Guest, Window::Capture, Window::Popout] {
                check(&window, &own, &[], &[page]);
            }
        }
    }

    #[test]
    fn popouts_stay_blank() {
        for own in [windows(), unix(), dev()] {
            check(
                &Window::Popout,
                &own,
                &["about:blank", "about:blank#x"],
                &["about:blank?x", "about:srcdoc", "http://tauri.localhost/", "tauri://localhost/", "http://127.0.0.1:1420/"],
            );
            check(&Window::Popout, &own, &[], &FOREIGN);
        }
    }

    #[test]
    fn print_windows_stay_on_their_own_page() {
        let page = url("file:///C:/Users/me/AppData/Local/Temp/odea-print/0190a1b2.html");
        let window = Window::Print(page);
        for own in [windows(), unix(), dev()] {
            check(
                &window,
                &own,
                &[
                    "file:///C:/Users/me/AppData/Local/Temp/odea-print/0190a1b2.html",
                    "file:///C:/Users/me/AppData/Local/Temp/odea-print/0190a1b2.html#heading-2",
                    // 同一个文件，百分号编码不一样
                    "file:///C:/Users/me/AppData/Local/Temp/odea%2Dprint/0190a1b2.html",
                ],
                &[
                    "file:///C:/Users/me/AppData/Local/Temp/odea-print/0190a1b3.html",
                    "file:///C:/Users/me/AppData/Local/Temp/odea-print/",
                    // 别的机器上的（UNC）。`file://主机/C:/…` 不算：URL 标准规定路径以盘符开头时主机清空，解析出来就是本机这一页
                    "file://evil.example/odea-print/0190a1b2.html",
                    "http://tauri.localhost/",
                    "http://127.0.0.1:1420/",
                    "about:blank",
                ],
            );
            check(&window, &own, &[], &FOREIGN);
        }
    }

    #[test]
    fn the_log_line_keeps_only_scheme_and_host() {
        assert_eq!(where_to(&url("https://example.com/notes/日记.md?token=secret#x")), "https://example.com");
        assert_eq!(where_to(&url("http://127.0.0.1:1/private")), "http://127.0.0.1");
        assert_eq!(where_to(&url("file:///C:/Users/me/secret.txt")), "file:");
        assert_eq!(where_to(&url("javascript:alert(document.cookie)")), "javascript:");
        assert_eq!(where_to(&url("data:text/html,secret")), "data:");
    }
}
