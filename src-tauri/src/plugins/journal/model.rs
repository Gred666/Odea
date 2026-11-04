use serde::{Deserialize, Serialize};

use crate::domain::model::DocRef;

/* 日程跨 IPC 的类型。和前端 src/plugins/journal/types.ts 对应，由 tauri-specta 生成 TS 定义 */

/// 日历「当日安排」里的一条：某篇文档正文里带日期的 `- [ ]`（见 tasks.rs）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    /// 所在文档的 id # 行号。只在勾选的那一下用，文档改过之后就不作数了
    pub id: String,
    pub title: String,
    /// todo | done
    pub status: String,
    /// 灰色小字：分类 · 时间 · 出处
    pub meta: Option<String>,
    pub due_date: Option<String>,
    pub time_label: Option<String>,
    pub category: Option<String>,
    /// 写着这条任务的那篇文档：日历里点「出处」跳过去
    pub source: Option<DocRef>,
    /// 在那篇正文里的行号（从 0 开始）
    pub line: Option<i64>,
}

/// 日历月网格上的两种记号
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarMarks {
    /// 留下过东西的日子：这一天的记录写过，或者有做完了的任务
    pub written: Vec<String>,
    /// 还有没做完的任务的日子
    pub open: Vec<String>,
}

/// 某个周期（某一周 / 某个月 / 某一年）的目标。
/// 一个周期一篇；还没写过的周期返回空文档（id 为空、updated_at 为 0），
/// 第一次保存时才落库。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    /// 还没落库时为空串
    pub id: String,
    /// week | month | year
    pub horizon: String,
    pub title: String,
    /// 周期起点：周一 / 1 号 / 1 月 1 日
    pub period_start: String,
    pub content_md: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// 在仓库里的相对路径；还没写过的周期是它将来的位置
    pub rel_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DayDoc {
    pub date: String,
    pub title: String,
    pub tasks: Vec<Task>,
    pub note_md: String,
    pub updated_at: i64,
    /// 这一天还没写过、内容是从之前最近一天延续来的：那一天的日期。
    /// 只有请求「今天」时才会延续；用户一编辑，就以这一天自己的身份落库。
    pub carried_from: Option<String>,
    /// 在仓库里的相对路径；还没写过的日子是它将来的位置
    pub rel_path: String,
}
