//! 跨 IPC 的类型（model）、全局搜索的匹配器和摘要、字数（search）、参数校验。
//! 文档的读写都在 vault/：文件是真相，这里不碰存储。

pub mod model;
pub mod search;

use crate::error::{AppError, Result};

/// 'YYYY-MM-DD'，而且得是真实存在的日期。日期都是参数绑定进 SQL 的，
/// 但格式错的日期（`2026-8-29`）或不存在的日期（`2026-02-30`）只会静默返回
/// 空结果，甚至被当成一天存下来 —— 不如在边界上就报错。
pub fn validate_date(s: &str) -> Result<()> {
    let well_formed = s.len() == 10
        && s.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
    if well_formed && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok() {
        Ok(())
    } else {
        Err(AppError::Invalid(format!("日期应为真实存在的 YYYY-MM-DD，收到: {s}")))
    }
}

#[cfg(test)]
mod tests {
    use super::validate_date;

    #[test]
    fn accepts_valid_dates() {
        for good in ["2026-08-29", "2026-01-01", "2028-02-29"] {
            assert!(validate_date(good).is_ok(), "「{good}」应该通过校验");
        }
    }

    #[test]
    fn rejects_malformed_or_impossible_dates() {
        for bad in [
            "2026-8-29",
            "26-08-29",
            "2026/08/29",
            "",
            "2026-08-29T00:00",
            "abcd-ef-gh",
            "2026-13-01",
            "2026-02-30",
            "2027-02-29",
            "2026-00-10",
        ] {
            assert!(validate_date(bad).is_err(), "「{bad}」不该通过校验");
        }
    }
}
