/* ============================================================
旧版数据库（ontheway.db）只剩一个用处：第一次启动新版时把它搬进仓库文件夹
（vault/legacy.rs）。迁移脚本留着，是为了不管旧库停在哪个版本，都能先迁到
最新结构再读。新版自己不再往任何 SQLite 里存「真相」—— 索引见 vault/index.rs。

另外几个到处要用的小工具：时间、id。
============================================================ */

pub mod migrate;
/// 旧库的连接设置。搬家时只读一份拷贝，用不上；迁移测试里还要它
#[cfg(test)]
pub mod pragma;

/// 当前 UTC 毫秒
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// UUIDv7：时间有序，为多设备同步预留了无冲突的 id
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// 当前本地日期 'YYYY-MM-DD'
pub fn today_local() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// UTC 毫秒 → 本地日期 'YYYY-MM-DD'
pub fn local_date_of(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
        .unwrap_or_else(today_local)
}

#[cfg(test)]
mod tests {
    #[test]
    fn local_dates_are_iso() {
        assert_eq!(super::local_date_of(i64::MAX), super::today_local());
        assert_eq!(super::today_local().len(), 10);
    }
}
