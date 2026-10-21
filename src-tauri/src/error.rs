use serde::Serialize;

/// 跨 IPC 的错误类型。
///
/// 用 `#[serde(tag = "kind")]` 让前端能按类型分支处理，
/// 而不是去解析错误字符串。
#[derive(Debug, thiserror::Error, Serialize, specta::Type)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    #[error("数据库错误: {0}")]
    Db(String),

    #[error("未找到: {0}")]
    NotFound(String),

    #[error("参数无效: {0}")]
    Invalid(String),

    #[error("旧数据库的版本比本程序新（文件 v{found}，本程序支持到 v{supported}）")]
    DbTooNew { found: i64, supported: i64 },

    #[error("IO 错误: {0}")]
    Io(String),

    #[error("内部错误: {0}")]
    Internal(String),
}

pub type Result<T> = std::result::Result<T, AppError>;

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("查询无结果".into()),
            other => AppError::Db(other.to_string()),
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Internal(format!("JSON: {e}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

#[cfg(any(feature = "desktop-runtime", feature = "typegen"))]
impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

/// 同步（git / GitHub / Gitee）的错误到前端：要登录、连不上、云端拒绝分开说
impl From<crate::sync::repo::SyncError> for AppError {
    fn from(e: crate::sync::repo::SyncError) -> Self {
        use crate::sync::repo::SyncError;
        match e {
            SyncError::Auth => AppError::Invalid("登录失效了，重新登录一次".into()),
            SyncError::Network(message) => AppError::Io(format!("连不上云端: {message}")),
            SyncError::Remote(message) => AppError::Invalid(message),
            SyncError::Local(message) => AppError::Internal(message),
        }
    }
}
