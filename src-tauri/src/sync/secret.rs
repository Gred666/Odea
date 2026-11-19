/* ============================================================
令牌放系统钥匙串（技术方案 §5.9.4）：Windows 凭据管理器 / macOS 钥匙串。

键是 `github:<login>` / `gitee:<login>`，值是一段 JSON（访问令牌、刷新令牌、到期时间）。
仓库地址和 .git/config 里都不放令牌。用 keyring-core 加各平台自己的存储
（keyring 4 的 v1 会顺带一个数据库存储，用不上）；单测里换成 keyring-core 自带的 mock。
============================================================ */

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use super::repo::{SyncError, SyncResult};

const SERVICE: &str = "Odea";

/// 钥匙串里存的一份令牌
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    pub access: String,
    /// GitHub 的令牌 8 小时过期，用它换新的；Gitee 的私人令牌没有
    #[serde(default)]
    pub refresh: Option<String>,
    /// 访问令牌什么时候过期（UTC 毫秒）；None = 不过期
    #[serde(default)]
    pub expires_at: Option<i64>,
}

pub fn load(account: &str) -> SyncResult<Option<Token>> {
    Ok(read(&entry(SERVICE, account)?)?.and_then(|text| serde_json::from_str(&text).ok()))
}

pub fn save(account: &str, token: &Token) -> SyncResult<()> {
    let text = serde_json::to_string(token).map_err(|error| SyncError::Local(error.to_string()))?;
    entry(SERVICE, account)?.set_password(&text).map_err(failed)
}

/// 钥匙串里的一段文字（协作的设备密钥用它，见 commands 的「协作」一节）
pub fn load_text(account: &str) -> SyncResult<Option<String>> {
    read(&entry(SERVICE, account)?)
}

pub fn save_text(account: &str, text: &str) -> SyncResult<()> {
    entry(SERVICE, account)?.set_password(text).map_err(failed)
}

/// 退出登录
pub fn remove(account: &str) -> SyncResult<()> {
    match entry(SERVICE, account)?.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(error) => Err(failed(error)),
    }
}

fn read(entry: &keyring_core::Entry) -> SyncResult<Option<String>> {
    match entry.get_password() {
        Ok(text) => Ok(Some(text)),
        Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(error) => Err(failed(error)),
    }
}

fn entry(service: &str, account: &str) -> SyncResult<keyring_core::Entry> {
    static STORE: OnceLock<Result<(), String>> = OnceLock::new();
    STORE.get_or_init(install).clone().map_err(SyncError::Local)?;
    keyring_core::Entry::new(service, account).map_err(failed)
}

fn failed(error: keyring_core::Error) -> SyncError {
    SyncError::Local(format!("系统钥匙串出错: {error}"))
}

#[cfg(test)]
fn install() -> Result<(), String> {
    let store = keyring_core::mock::Store::new().map_err(|error| error.to_string())?;
    keyring_core::set_default_store(store);
    Ok(())
}

#[cfg(all(not(test), windows))]
fn install() -> Result<(), String> {
    let store = windows_native_keyring_store::Store::new().map_err(|error| error.to_string())?;
    keyring_core::set_default_store(store);
    Ok(())
}

#[cfg(all(not(test), target_os = "macos"))]
fn install() -> Result<(), String> {
    let store = apple_native_keyring_store::keychain::Store::new().map_err(|error| error.to_string())?;
    keyring_core::set_default_store(store);
    Ok(())
}

#[cfg(all(not(test), not(any(windows, target_os = "macos"))))]
fn install() -> Result<(), String> {
    Err("这个系统上还没接钥匙串，暂时不能登录同步".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_round_trip_through_the_keyring() {
        let token =
            Token { access: "ghu_test".into(), refresh: Some("ghr_test".into()), expires_at: Some(1_800_000_000_000) };
        assert_eq!(load("github:tester").unwrap(), None);
        save("github:tester", &token).unwrap();
        assert_eq!(load("github:tester").unwrap(), Some(token));
        remove("github:tester").unwrap();
        assert_eq!(load("github:tester").unwrap(), None);
        // 删一个本来就没有的不算错
        remove("github:tester").unwrap();
    }
}
