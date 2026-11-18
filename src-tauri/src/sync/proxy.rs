/* ============================================================
找代理（技术方案 §5.9.4）。

libgit2 在 Windows 上用的是 WinHTTP 的默认代理（`netsh winhttp`），读不到 Clash 这类工具
设的系统代理；国内连 GitHub 多半得走代理。所以自己按顺序找，再显式交给 libgit2 和
HTTP 客户端：

  应用里填的 > 环境变量 HTTPS_PROXY / ALL_PROXY > 系统代理 > 直连

- Windows 的系统代理在注册表 HKCU\…\Internet Settings：ProxyEnable = 1 时 ProxyServer
  是 `127.0.0.1:7897`，或者按协议分开写 `http=…;https=…;socks=…`
- macOS 读 `scutil --proxy`
- 只认 http(s) 代理：WinHTTP 不支持 socks。PAC（自动配置脚本）也不认
============================================================ */

/// 按顺序找一个代理，形如 `http://127.0.0.1:7897`；都没有就直连
pub fn resolve(configured: Option<&str>) -> Option<String> {
    configured.and_then(normalize).or_else(from_env).or_else(system)
}

fn from_env() -> Option<String> {
    ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
        .iter()
        .find_map(|key| std::env::var(key).ok().as_deref().and_then(normalize))
}

/// `127.0.0.1:7897` → `http://127.0.0.1:7897`；socks 的不要
fn normalize(raw: &str) -> Option<String> {
    let raw = raw.trim().trim_end_matches('/');
    if raw.is_empty() {
        return None;
    }
    match raw.split_once("://") {
        Some((scheme, _)) if scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https") => {
            Some(raw.to_string())
        }
        Some(_) => None,
        None => Some(format!("http://{raw}")),
    }
}

/// 注册表里的 ProxyServer：`127.0.0.1:7897`，或者 `http=a:1;https=b:2;socks=c:3`（取 https，没有就 http）
pub fn parse_windows_proxy_server(server: &str) -> Option<String> {
    if !server.contains('=') {
        return normalize(server);
    }
    let entry = |name: &str| {
        server.split(';').find_map(|part| {
            let (key, value) = part.split_once('=')?;
            key.trim().eq_ignore_ascii_case(name).then(|| value.trim().to_string())
        })
    };
    entry("https").or_else(|| entry("http")).as_deref().and_then(normalize)
}

/// `scutil --proxy` 的输出：HTTPSEnable / HTTPSProxy / HTTPSPort，没开就看 HTTP 的
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // 只有 macOS 用；解析在哪都测
pub fn parse_scutil(text: &str) -> Option<String> {
    let value = |key: &str| {
        text.lines().find_map(|line| {
            let (k, v) = line.split_once(':')?;
            (k.trim() == key).then(|| v.trim().to_string())
        })
    };
    ["HTTPS", "HTTP"].iter().find_map(|kind| {
        if value(&format!("{kind}Enable")).as_deref() != Some("1") {
            return None;
        }
        let host = value(&format!("{kind}Proxy"))?;
        let port = value(&format!("{kind}Port"))?;
        normalize(&format!("{host}:{port}"))
    })
}

#[cfg(windows)]
fn system() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    let settings = winreg::RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;
    let enabled: u32 = settings.get_value("ProxyEnable").ok()?;
    if enabled != 1 {
        return None;
    }
    let server: String = settings.get_value("ProxyServer").ok()?;
    parse_windows_proxy_server(&server)
}

#[cfg(target_os = "macos")]
fn system() -> Option<String> {
    let output = std::process::Command::new("scutil").arg("--proxy").output().ok()?;
    parse_scutil(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn system() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_windows_proxy_server_value() {
        assert_eq!(parse_windows_proxy_server("127.0.0.1:7897").as_deref(), Some("http://127.0.0.1:7897"));
        assert_eq!(
            parse_windows_proxy_server("http=127.0.0.1:8080;https=127.0.0.1:8443;socks=127.0.0.1:1080").as_deref(),
            Some("http://127.0.0.1:8443")
        );
        assert_eq!(parse_windows_proxy_server("http=proxy.corp:3128").as_deref(), Some("http://proxy.corp:3128"));
        assert_eq!(parse_windows_proxy_server("socks=127.0.0.1:1080"), None);
        assert_eq!(parse_windows_proxy_server(""), None);
    }

    #[test]
    fn reads_scutil_output() {
        let text = "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 7891\n  HTTPSProxy : 127.0.0.1\n}";
        assert_eq!(parse_scutil(text).as_deref(), Some("http://127.0.0.1:7891"));
        let http_only = "  HTTPEnable : 1\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 0\n";
        assert_eq!(parse_scutil(http_only).as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(parse_scutil("  HTTPEnable : 0\n"), None);
    }

    #[test]
    fn a_configured_proxy_wins_and_socks_is_skipped() {
        assert_eq!(resolve(Some("127.0.0.1:1234")).as_deref(), Some("http://127.0.0.1:1234"));
        assert_eq!(resolve(Some("https://p.example:443/")).as_deref(), Some("https://p.example:443"));
        assert_eq!(normalize("socks5://127.0.0.1:1080"), None);
        assert_eq!(normalize("  "), None);
    }
}
