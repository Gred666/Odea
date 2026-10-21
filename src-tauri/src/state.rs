use std::collections::HashMap;
use std::ops::Deref;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::ipc::{CommandArg, CommandItem, InvokeError};
use tauri::Runtime;

use crate::commands::{CollabHub, Indexing};
use crate::error::AppError;
use crate::sync::account::LoginSlot;
use crate::sync::engine::SyncHub;
use crate::update::UpdateHub;
use crate::vault::watch::VaultWatcher;
use crate::vault::Vault;

/// 一个仓库窗口的东西（docs/仓库与启动器.md §4.1）。一个窗口一个仓库，同一个仓库只开一个窗口
pub struct Workspace {
    /// 窗口标签：这个仓库的事件（变化、索引进度、同步状态）只发给它
    pub label: String,
    /// 仓库在哪。单独记一份：查「这个文件夹开着没有」不用去等仓库的锁（后台读索引时一拿 50ms）
    pub root: Mutex<PathBuf>,
    /// 这个窗口的仓库。换仓库时整个换掉里面的 Vault（文件监听线程发现根目录变了会自己退出）
    pub vault: Arc<Mutex<Vault>>,
    /// 持有它，监听才在
    pub watcher: Mutex<Option<VaultWatcher>>,
    /// 同步线程的遥控器（技术方案 §5.9）。仓库没开同步时里面是空的
    pub sync: Arc<SyncHub>,
    /// 后台读文件进索引读到哪了（第一次打开大文件夹、索引升级重建时，见 Vault::open_quick）
    pub indexing: Arc<Mutex<Indexing>>,
}

impl Workspace {
    pub fn root(&self) -> PathBuf {
        self.root.lock().map(|root| root.clone()).unwrap_or_default()
    }
}

pub struct AppState {
    /// 窗口标签 → 这个窗口开着的仓库。启动器不在里面
    pub workspaces: Mutex<HashMap<String, Arc<Workspace>>>,
    /// 最近获得过焦点的仓库窗口：应用开着时点的 odea:// 链接交给它
    pub focused: Mutex<Option<String>>,
    /// 启动器打开了一个仓库、在等它的窗口画出来再关自己（workspace::on_ready）
    pub launcher_waits_for: Mutex<Option<String>>,
    /// 团队仓库的链接（odea://vault/）等启动器起来取（workspace::show_launcher_link）
    pub launcher_link: Mutex<Option<String>>,
    /// 日程切换器刚打开的窗口：起来以后摆到哪、翻到哪一页（workspace::journal_switch）
    pub journal_jumps: Mutex<HashMap<String, crate::workspace::Jump>>,
    /// 应用数据目录：配置、索引、旧库
    pub data_dir: PathBuf,
    /// 正在进行的 GitHub 设备码登录（开始、等待、取消是三个命令）。账号是全应用的，不分仓库
    pub sync_login: Mutex<LoginSlot>,
    /// 下好了等着装的新版本、这一次是不是升级上来的（update.rs）
    pub update: Arc<UpdateHub>,
    /// 协作：正在主持 / 做客的会话（一次一个，记着属于哪个窗口）、给前端推字节的 Channel（docs/协同编辑.md）
    pub collab: Arc<CollabHub>,
}

impl AppState {
    pub fn workspace(&self, label: &str) -> Option<Arc<Workspace>> {
        self.workspaces.lock().ok()?.get(label).cloned()
    }

    pub fn all_workspaces(&self) -> Vec<Arc<Workspace>> {
        self.workspaces.lock().map(|map| map.values().cloned().collect()).unwrap_or_default()
    }

    /// 这个文件夹已经在哪个窗口里开着（按规范化的路径比，见 boot::same_vault）
    pub fn window_of(&self, root: &std::path::Path) -> Option<String> {
        self.all_workspaces()
            .into_iter()
            .find(|workspace| crate::boot::same_vault(&workspace.root(), root))
            .map(|workspace| workspace.label.clone())
    }
}

/// 命令的注入参数：调用它的那个窗口的仓库。前端调用时不用传（specta 生成类型时跳过它，
/// 和 `State` 一样）；不是仓库窗口（启动器）调的报错
pub struct Ws(pub Arc<Workspace>);

impl Deref for Ws {
    type Target = Workspace;
    fn deref(&self) -> &Workspace {
        &self.0
    }
}

impl<'de, R: Runtime> CommandArg<'de, R> for Ws {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        let label = command.message.webview_ref().label().to_string();
        command
            .message
            .state_ref()
            .try_get::<AppState>()
            .and_then(|state| state.workspace(&label))
            .map(Ws)
            .ok_or_else(|| InvokeError::from(AppError::Invalid(format!("窗口「{label}」没有打开仓库"))))
    }
}

impl specta::function::FunctionArg for Ws {
    fn to_datatype(_: &mut specta::TypeCollection) -> Option<specta::DataType> {
        None
    }
}

/// 命令的注入参数：调用它的窗口和它开着的仓库（协作的访客窗口、启动器没有仓库）。做客不需要仓库 ——
/// 访客那篇不落进仓库（docs/协同编辑.md §3），访客窗口里也调得了
pub struct Caller {
    pub label: String,
    pub workspace: Option<Arc<Workspace>>,
}

impl<'de, R: Runtime> CommandArg<'de, R> for Caller {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        let label = command.message.webview_ref().label().to_string();
        let workspace = command.message.state_ref().try_get::<AppState>().and_then(|state| state.workspace(&label));
        Ok(Caller { label, workspace })
    }
}

impl specta::function::FunctionArg for Caller {
    fn to_datatype(_: &mut specta::TypeCollection) -> Option<specta::DataType> {
        None
    }
}
