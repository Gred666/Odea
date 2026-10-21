use serde::{Deserialize, Serialize};

/* ============================================================
跨 IPC 的领域类型。
全部 camelCase —— 和前端 src/data/types.ts 一一对应，
由 tauri-specta 生成 TS 定义，不需要手写两遍。
============================================================ */

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    pub content_md: String,
    pub excerpt: String,
    pub word_count: i64,
    pub is_pinned: bool,
    pub is_archived: bool,
    pub archive_category: Option<String>,
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    /// 在仓库里的相对路径（正斜杠）。正文里的相对图片路径以它所在的文件夹为基准
    pub rel_path: String,
    /// 这篇是另一篇的冲突副本（网盘同步撞车、或本应用另存的）：原文的 id
    pub conflict_of: Option<String>,
}

/// 列表里的一篇：Note 去掉正文。仓库里有多少篇列表就给多少篇，正文打开时再取（note_get）、
/// 搜正文走 search_text —— 前端不留每篇的全文，篇数再多常驻内存也只多一点摘要（技术方案 §13.2）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub excerpt: String,
    pub word_count: i64,
    pub is_pinned: bool,
    pub is_archived: bool,
    pub archive_category: Option<String>,
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub rel_path: String,
    pub conflict_of: Option<String>,
}

/// 日历「当日安排」里的一条：某篇文档正文里带日期的 `- [ ]`（见 vault/tasks.rs）
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
    pub source: Option<DocTarget>,
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

/// 写过的某一天 / 某个周期的目标（不带正文）：命令面板拿它按标题搜日记和目标，正文走 search_text
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JournalDoc {
    pub target: DocTarget,
    /// day | goal
    pub kind: String,
    /// 给人看的标题：「10月6日 · 完成专注模式原型」「第 41 周目标」
    pub title: String,
    pub updated_at: i64,
}

/// search_text 的一条：正文里出现了要找的字的文档
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TextHit {
    pub target: DocTarget,
    /// 笔记是它的标题；某一天 / 目标是给人看的标题（同 JournalDoc）
    pub title: String,
    pub updated_at: i64,
    /// 第一次出现的那一行（很长的话截一段，前后各留一大截）：前端在里面再截出要显示的一小段
    pub line: String,
}

/// 搜正文的结果：笔记（含归档，顺序同两个列表接起来）和日记、目标（最近改过的在前）各自最多 limit 条
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TextSearch {
    pub notes: Vec<TextHit>,
    pub journal: Vec<TextHit>,
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

/// 全局搜索（find_in_vault）的条件：和编辑器里查找面板的三个开关一样
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FindOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
}

/// 全局搜索里的一处命中
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FindMatch {
    /// 第几行，从 1 开始
    pub line: u32,
    /// 在这一行里从第几个 UTF-16 码元开始、占几个（编辑器里的位置按 UTF-16 算）：跳进文档后选中它
    pub column: u32,
    pub length: u32,
    /// 给人看的一段：命中处前面一小截（截掉了的话以「…」开头）、命中的字、后面一截
    pub before: String,
    pub text: String,
    pub after: String,
}

/// 全局搜索里命中了的一篇
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FindFile {
    pub target: DocTarget,
    /// 笔记是它的标题；某一天 / 目标是给人看的标题（同 JournalDoc）
    pub title: String,
    pub updated_at: i64,
    /// 这一篇里给出的命中（总数到了上限，后面的就不给了）
    pub matches: Vec<FindMatch>,
    /// 这一篇里一共几处
    pub count: u32,
}

/// 全局搜索的结果：笔记（含归档，顺序同两个列表接起来）在前，日记、目标（最近改过的在前）在后
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FindResult {
    pub files: Vec<FindFile>,
    /// 一共几处（没给出来的也数了）
    pub total: u32,
    /// 命中太多，只给了前面一部分（vault::FIND_MATCH_LIMIT）
    pub truncated: bool,
    /// 正则写错了：给人看的原因（这时 files 是空的）
    pub error: Option<String>,
}

/// 新建 / 更新笔记的入参。
/// id 为 None 表示新建。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteInput {
    pub id: Option<String>,
    pub title: String,
    pub content_md: String,
}

/// 指向一篇文档：和前端的 DocumentSaveTarget 同形
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DocTarget {
    Note {
        id: String,
    },
    /// id 是日期 YYYY-MM-DD
    Day {
        id: String,
    },
    Goal {
        horizon: String,
        #[serde(rename = "periodStart")]
        period_start: String,
    },
}

/// 仓库里别处发生的变化：文件被外部程序改了，或者一次操作连带改了别的文档
/// （在日历里勾任务，改的是任务所在的那篇）。前端据此刷新缓存。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultChange {
    /// 变了（或没了）的笔记 id
    pub notes: Vec<String>,
    /// 变了的某一天（YYYY-MM-DD）
    pub days: Vec<String>,
    /// 变了的目标，`week:2026-09-21`，和前端 goalKey 一样
    pub goals: Vec<String>,
    /// 带日期的任务有变化：日历的当日安排和小圆点要刷新
    pub tasks: bool,
    /// 这次产生的冲突副本的标题（编辑器里有没存的修改时外部改动到了，另存的那一份）
    pub conflicts: Vec<String>,
    /// 新出现的冲突副本（网盘同步时两边都改过，网盘另存的那一份）的标题
    pub found_copies: Vec<String>,
    /// 「笔记」下面的文件夹变了（在资源管理器里建了、删了、改了名）
    pub folders: bool,
    /// 仓库的摆法在别处变了（另一台设备开关了日程、转成了逻辑目录，同步过来）：要按新的摆法重新认文件、
    /// 整页重载，前端问一句「切换过去」（vault_relayout）。没切换之前照旧按原来的摆法
    pub layout: bool,
}

/// 文件树上的一个不是笔记的文件：图片、PDF（docs/仓库与启动器.md §11：整个仓库当树根时和 Obsidian 一样列出来）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TreeFile {
    /// 仓库里的相对路径
    pub rel_path: String,
    /// 在树上哪个文件夹（相对树根，空串是根）
    pub folder: String,
    pub name: String,
    /// `image` / `pdf`
    pub kind: String,
    pub size: f64,
    /// 修改时间（Unix 毫秒）
    pub updated_at: f64,
}

/// 导入一个文件夹的结果（Vault::import_folder）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// 树上新文件夹的路径（相对树根）
    pub folder: String,
    pub notes: u32,
    /// 别的文件（图片、PDF …）
    pub files: u32,
}

/// 删掉一个文件夹的结果，原样交回 folder_undelete 就能撤销
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderDeletion {
    /// 删掉的文件夹（相对「笔记」的路径）
    pub folder: String,
    /// 进了回收站的笔记 id
    pub notes: Vec<String>,
    /// 删掉的文件夹和它底下的子文件夹
    pub folders: Vec<String>,
    /// 文件夹里还有别的文件（图片、PDF），目录留着没删
    pub kept: bool,
    /// 逻辑目录：从清单里拿掉的那些行（文件夹、智能文件夹、笔记的位置），撤销时放回去
    pub nodes: Option<String>,
}

/// 逻辑目录的树（vault/tree.rs）上的一个节点，给前端的样子。按路径引用的笔记已经换成了 id，
/// 引用的笔记不在了的不给
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub id: String,
    /// 父节点的 id，根是 `.`
    pub parent: String,
    /// 排序键：同一层按它排，一样时按 id（data/tree.ts）
    pub key: String,
    /// folder / query / note
    pub kind: String,
    /// 文件夹、智能文件夹的名字
    pub name: Option<String>,
    /// 笔记的 id
    pub note: Option<String>,
    /// 智能文件夹的条件（vault/query.rs）
    pub query: Option<String>,
}

/// 反向链接：一篇正文里写了 `[[这篇的标题]]` 的文档
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    /// 链过来的那篇，点一下跳过去
    pub target: DocTarget,
    /// note | day | goal
    pub kind: String,
    /// 给人看的标题：笔记标题、「9月26日」、「第 39 周目标」
    pub title: String,
    pub archived: bool,
    pub updated_at: i64,
    /// 写着链接的那几行（最多 3 行）
    pub lines: Vec<BacklinkLine>,
    /// 这篇里一共链了几次
    pub count: i64,
}

/// 用户改过、而这个版本的应用带着新版的使用指南（vault/guide.rs）：前端在那一篇上问换不换
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GuideUpdate {
    /// 那一篇笔记的 id
    pub id: String,
    /// 哪一份指南：welcome / syntax
    pub name: String,
    /// 这个版本的应用带的正文
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkLine {
    /// 正文里的行号（从 0 开始）
    pub line: i64,
    /// 去掉列表符号之类、截过长度的那一行，双链原样保留（前端再画成小块）
    pub text: String,
}

/// 笔记改了标题之后，别处的 `[[旧标题]]` 改成了新标题（Vault::relink）
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Relink {
    /// 改了几处链接；没改（skipped）时是本来要改的处数
    pub links: i64,
    /// 改了的那几篇，给人看的标题
    pub docs: Vec<String>,
    /// 没改的原因（新标题写不进双链、和别的笔记重名……）。改了是 None
    pub skipped: Option<String>,
    /// 每篇改之前、之后的全文，原样交给 note_relink_undo 就能撤销
    pub rewrites: Vec<LinkRewrite>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkRewrite {
    pub rel_path: String,
    pub before: String,
    pub after: String,
}

/// 一篇文档的历史版本：同步用的 git 仓库里每次改过它的提交（技术方案 §5.9.11）
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DocHistory {
    /// 为什么没有历史（还没开启同步）。有历史时是 None
    pub unavailable: Option<String>,
    /// 新的在前
    pub versions: Vec<DocVersion>,
    /// 更早的还有，没列出来
    pub more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DocVersion {
    /// 这一版文件内容的 git 对象 id，交给 doc_version_text 取正文
    pub blob: String,
    /// 提交时间，UTC 毫秒
    pub time: i64,
    /// 哪台设备改的：同步提交署名「Odea (设备名)」（改名前是「OnTheWay (设备名)」）里的设备名；别的 git 工具提交的就是署名
    pub device: String,
    /// 这台设备自己改的
    pub mine: bool,
    /// 这一版时的标题（笔记改过标题才和现在不一样；某一天、目标是空串）
    pub title: String,
}

/// 存进「附件」文件夹的一个文件
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// 从文档引用它的相对路径，直接写进 `![](…)`
    pub link: String,
    /// 文件名
    pub name: String,
    pub is_image: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    /// 仓库文件夹的绝对路径
    pub root: String,
    pub notes: i64,
    pub archived: i64,
    pub days: i64,
    pub goals: i64,
    pub tasks: i64,
    pub layout: VaultLayout,
}

/// 这个仓库怎么摆（vault/layout.rs 的 Layout）：前端据此决定窄栏上有哪几项、一篇笔记在树上哪个文件夹
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultLayout {
    /// 逻辑目录（docs/仓库与启动器.md §7）：文件树是清单里摆的那一棵（tree_view），不按文件夹
    pub logical: bool,
    /// 开没开日程（今日TODO、目标、日历、归档）
    pub journal: bool,
    /// 文件树的根：「笔记」，或者整个仓库（空串）
    pub notes_dir: String,
    pub days_dir: String,
    pub goals_dir: String,
    pub archive_dir: String,
    /// 不在树上的文件夹（日程开着时的日记、目标、归档）：里面的笔记算在树根这一层
    pub hidden_dirs: Vec<String>,
}

/* ---------------- 同步（技术方案 §5.9） ---------------- */

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum SyncState {
    /// 这个仓库没开同步
    #[default]
    Off,
    /// 同步好了
    Idle,
    Syncing,
    /// 连不上云端：改动都在本机，过一会儿再试
    Offline,
    /// 登录失效，要重新登录
    Auth,
    /// 别的错（云端拒绝、本地仓库出错），原因在 message 里
    Error,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub state: SyncState,
    /// 给人看的云端仓库：`github.com/xxx/odea-notes`
    pub remote: Option<String>,
    /// 上一次同步成功的时间（UTC 毫秒）
    pub last_synced_at: Option<i64>,
    /// 本机还有几个提交没推上去
    pub unpushed: u32,
    /// 出错时的原因
    pub message: Option<String>,
    /// 太大、没有同步的文件
    pub oversized: Vec<SyncOversized>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncOversized {
    /// 仓库里的相对路径
    pub rel: String,
    pub bytes: f64,
}

/// 一个登录过的同步账号
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncAccount {
    /// github / gitee
    pub provider: String,
    pub login: String,
}

/// GitHub 设备码登录：给用户看的码，和去哪输入
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncDeviceCode {
    pub user_code: String,
    pub verification_uri: String,
    /// 码多久过期（秒）
    pub expires_in: u32,
}

/// 云端的一个仓库
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncRemoteRepo {
    /// `owner/name`
    pub full_name: String,
    pub clone_url: String,
    pub private: bool,
    /// 最近一次推送 / 更新（云端给的时间字符串）
    pub updated_at: Option<String>,
}

/// 同步用的代理：用户填的，和实际在用的（填的 > 环境变量 > 系统代理）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncProxy {
    pub configured: Option<String>,
    pub effective: Option<String>,
}

/// 开启同步前看一眼云端（技术方案 §5.9.7）：接下来会发生什么
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncPlan {
    /// true：云端是空的（或者就是这个仓库以前连过的），在现在的仓库上接上、把这里的推上去。
    /// false：云端已经有东西，clone 到 cloneTarget、换过去
    pub connect_here: bool,
    /// clone 到哪个文件夹（绝对路径）
    pub clone_target: Option<String>,
    /// 现在的仓库里有没有笔记：有的话问要不要「也合并进来」
    pub local_notes: bool,
}
