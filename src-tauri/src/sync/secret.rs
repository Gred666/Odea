/* ============================================================
令牌放系统钥匙串（技术方案 §5.9.4）：Windows 凭据管理器 / macOS 钥匙串。

键是 `github:<login>` / `gitee:<login>`，值是一段 JSON（访问令牌、刷新令牌、到期时间）。
仓库地址和 .git/config 里都不放令牌。用 keyring-core 加各平台自己的存储
（keyring 4 的 v1 会顺带一个数据库存储，用不上）；单测里换成 keyring-core 自带的 mock。

改名前存在服务名 OnTheWay 下（old_name.rs）：新的里没有就去那儿找，找到了挪过来。
============================================================ */

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use super::repo::{SyncError, SyncResult};
use crate::old_name;

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
    if let Some(text) = read(&entry(SERVICE, account)?)? {
        return Ok(serde_json::from_str(&text).ok());
    }
    let legacy = entry(old_name::NAME, account)?;
    let Some(text) = read(&legacy)? else {
        return Ok(None);
    };
    // 挪不过去也照样用：下次再挪
    if entry(SERVICE, account)?.set_password(&text).is_ok() {
        let _ = legacy.delete_credential();
    }
    Ok(serde_json::from_str(&text).ok())
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

/// 退出登录：改名前那一份也删掉
pub fn remove(account: &str) -> SyncResult<()> {
    for service in [SERVICE, old_name::NAME] {
        match entry(service, account)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => {}
            Err(error) => return Err(failed(error)),
        }
    }
    Ok(())
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
        let token = Token {
            access: "ghu_test".into(),
            refresh: Some("ghr_test".into()),
            expires_at: Some(1_800_000_000_000),
        };
        assert_eq!(load("github:tester").unwrap(), None);
        save("github:tester", &token).unwrap();
        assert_eq!(load("github:tester").unwrap(), Some(token));
        remove("github:tester").unwrap();
        assert_eq!(load("github:tester").unwrap(), None);
        // 删一个本来就没有的不算错
        remove("github:tester").unwrap();
    }

    #[test]
    fn a_token_saved_before_the_rename_is_found_and_moved_over() {
        let token = Token {
            access: "ghu_old".into(),
            refresh: None,
            expires_at: None,
        };
        let text = serde_json::to_string(&token).unwrap();
        entry(old_name::NAME, "github:renamed").unwrap().set_password(&text).unwrap();

        assert_eq!(load("github:renamed").unwrap(), Some(token.clone()));
        assert_eq!(read(&entry(SERVICE, "github:renamed").unwrap()).unwrap(), Some(text));
        assert_eq!(read(&entry(old_name::NAME, "github:renamed").unwrap()).unwrap(), None);
        assert_eq!(load("github:renamed").unwrap(), Some(token));
    }
}
