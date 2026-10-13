use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::commands::Indexing;
use crate::sync::account::LoginSlot;
use crate::sync::engine::SyncHub;
use crate::update::UpdateHub;
use crate::vault::watch::VaultWatcher;
use crate::vault::Vault;

pub struct AppState {
    /// 当前仓库。换仓库时整个换掉里面的 Vault（文件监听线程发现根目录变了会自己退出）
    pub vault: Arc<Mutex<Vault>>,
    /// 持有它，监听才在
    pub watcher: Mutex<Option<VaultWatcher>>,
    /// 应用数据目录：配置、索引、旧库
    pub data_dir: PathBuf,
    /// 同步线程的遥控器（技术方案 §5.9）。仓库没开同步时里面是空的
    pub sync: Arc<SyncHub>,
    /// 正在进行的 GitHub 设备码登录（开始、等待、取消是三个命令）
    pub sync_login: Mutex<LoginSlot>,
    /// 下好了等着装的新版本、这一次是不是升级上来的（update.rs）
    pub update: Arc<UpdateHub>,
    /// 后台读文件进索引读到哪了（第一次打开大文件夹、索引升级重建时，见 Vault::open_quick）
    pub indexing: Arc<Mutex<Indexing>>,
}
