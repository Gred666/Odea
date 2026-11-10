/* ============================================================
带脚本的插件（L1，docs/插件与跨端.md §5.5）的沙箱页：odea-plugin://localhost/sandbox.html
（Windows 上是 http://odea-plugin.localhost/sandbox.html）。

前端在一个 <iframe sandbox="allow-scripts"> 里打开它（src/plugins/sandbox/host.ts）。不能用 srcdoc：
srcdoc 继承父页面的 CSP，应用的 script-src 里没有 'unsafe-inline'，沙箱里的中转一行都跑不了，
想放开就得放开整个应用。从这里单独发一份，它有自己的 CSP：
- default-src 'none'：网络全关（fetch、WebSocket、图片、样式都不行）
- script-src 'unsafe-inline' blob:：只跑页面里那段外壳和父页面交来的中转；插件的脚本从 blob 载进 Worker
- worker-src blob:：插件跑在 iframe 另起的 Worker 里
- sandbox allow-scripts：就算有人把这一页直接当顶层打开，origin 也是 opaque 的

IPC：Windows 上 wry 把 Tauri 的初始化脚本一律注入子框架，这一页的主线程上看得见 __TAURI_INTERNALS__，
但 ipc.localhost 被上面的 CSP 拦下、退回 postMessage 也没有回应，调不通（docs/插件与跨端.md §15.3）。
插件的代码不在这一页上跑，在它另起的 Worker 里。
页面内容就是 src/plugins/sandbox/sandbox.html，前端的浏览器预览拿同一个文件当 srcdoc。
============================================================ */

/// 自定义协议的名字（前端 host.ts 的 SANDBOX_SCHEME）
pub const SCHEME: &str = "odea-plugin";

const PAGE: &str = include_str!("../../../src/plugins/sandbox/sandbox.html");

const CSP: &str =
    "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; sandbox allow-scripts";

/// 回一个请求：只有 /sandbox.html，别的都是 404
pub fn respond(path: &str) -> (u16, Vec<(&'static str, &'static str)>, &'static [u8]) {
    if path != "/sandbox.html" {
        return (404, vec![("Content-Type", "text/plain; charset=utf-8")], b"not found");
    }
    (
        200,
        vec![
            ("Content-Type", "text/html; charset=utf-8"),
            ("Content-Security-Policy", CSP),
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
            ("Referrer-Policy", "no-referrer"),
        ],
        PAGE.as_bytes(),
    )
}

#[cfg(feature = "desktop-runtime")]
pub fn handler<R: tauri::Runtime>(
    _ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<std::borrow::Cow<'static, [u8]>> {
    let (status, headers, body) = respond(request.uri().path());
    let mut response = tauri::http::Response::builder().status(status);
    for (name, value) in headers {
        response = response.header(name, value);
    }
    response
        .body(std::borrow::Cow::Borrowed(body))
        .unwrap_or_else(|_| tauri::http::Response::new(std::borrow::Cow::Borrowed(&b""[..])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_only_the_sandbox_page_with_its_own_csp() {
        let (status, headers, body) = respond("/sandbox.html");
        assert_eq!(status, 200);
        let csp = headers.iter().find(|(name, _)| *name == "Content-Security-Policy").unwrap().1;
        assert!(csp.contains("default-src 'none'"));
        assert!(csp.contains("sandbox allow-scripts"));
        assert!(!csp.contains("allow-same-origin"));
        let page = std::str::from_utf8(body).unwrap();
        assert!(page.contains("odeaSandbox"));
        assert!(page.contains("Content-Security-Policy"));

        for other in ["/", "/main.js", "/../index.html", "/sandbox.html/x"] {
            assert_eq!(respond(other).0, 404, "{other}");
        }
    }
}
