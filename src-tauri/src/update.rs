/* ============================================================
自动更新（技术方案 §14.4）。

发版时 CI 把安装包和 latest.json 放到 GitHub Releases。这里：
- 窗口出来以后等一会儿查一次，之后每 6 小时查一次。查到新版就在后台下载、验签，
  下好了才告诉前端（导航栏里出现「新版本」那一行），用户点了只等重启，不等下载。
  连不上就算了，半小时后再试 —— 本地优先的应用，离线是常态，不报错
- 「重启并更新」：前端先把编辑器里的内容写盘，这里把同步推上去（和关窗口一样最多等 3 秒）、
  记下窗口位置，再交给安装包。Windows 上安装包会结束这个进程、装完再把应用拉起来；
  macOS / Linux 换掉程序文件以后自己重启
- Linux 的 deb / rpm 要 root 才能装，不在应用里装：只提示，「去下载」打开下载页
- 请求走同步的那个代理（sync/proxy.rs）：开着 Clash 时同步连得上，检查更新也连得上
- 地址可以有好几个（tauri.conf.json 的 endpoints，现在只有 GitHub 一个）：一个地址从查到下载、验签
  哪一步不行就整条换下一个；一个地址说「已经是最新」也接着问下一个（见 check）

安装包用发版人的私钥签过名，公钥写在 tauri.conf.json 的 plugins.updater.pubkey，
下载完先验签，对不上的不装。公钥没填（还没生成密钥）就不查。

开发时（debug 构建）默认不查。两个环境变量用来在本机把整条路走一遍：
    ODEA_UPDATER_ENDPOINT  换成这几个 latest.json 的地址（逗号隔开，按顺序试；可以是 http://127.0.0.1）
    ODEA_UPDATER_PUBKEY    换一个公钥（配合自己生成的测试密钥）
============================================================ */

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};
use tauri_specta::Event;

use crate::boot::{self, AppUpgrade};
use crate::error::{AppError, Result};
use crate::state::AppState;
use crate::sync::proxy;

/// 在应用里装不了的（deb / rpm）点「去下载」打开这里
const DOWNLOAD_PAGE: &str = "https://github.com/Gred666/Odea/releases/latest";
/// 窗口出来以后等多久查第一次：别和启动、第一轮同步抢网
const FIRST_CHECK: Duration = Duration::from_secs(20);
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// 连不上时多久再试
const RETRY: Duration = Duration::from_secs(30 * 60);
/// 取 latest.json 每个地址最多等多久
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
/// 下载安装包最多等多久（十来 MB，慢网也够了；卡住的话下一轮再来）
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// 一个等着装的新版本
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    /// 现在这一版
    pub current: String,
    /// 更新说明（Markdown，发版时写的）
    pub notes: Option<String>,
    /// 发布日期 YYYY-MM-DD
    pub date: Option<String>,
    /// 在应用里装不了（Linux 的 deb / rpm）时是下载页的地址；能装的是空
    pub manual: Option<String>,
}

/// 新版本下好了、验过签（只能手动装的：查到了）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct UpdateReady(pub UpdateInfo);

struct Pending {
    info: UpdateInfo,
    update: Update,
    /// 下好、验过签的安装包；只能手动装的没有
    bytes: Option<Vec<u8>>,
}

/// 放在 AppState 里
#[derive(Default)]
pub struct UpdateHub {
    pending: Mutex<Option<Pending>>,
    /// 同一时间只查一次：后台那一轮和命令面板的「检查更新」撞上了，后来的等前一个查完再看
    checking: tauri::async_runtime::Mutex<()>,
    started: AtomicBool,
    /// 这一次启动是升级上来的：前端取一次（app_upgrade），给用户看这之间的更新说明
    upgrade: Mutex<Option<AppUpgrade>>,
}

impl UpdateHub {
    pub fn new(upgrade: Option<AppUpgrade>) -> Self {
        Self { upgrade: Mutex::new(upgrade), ..Self::default() }
    }

    fn pending_info(&self) -> Option<UpdateInfo> {
        lock(&self.pending).as_ref().map(|pending| pending.info.clone())
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

enum Checked {
    /// 这一版没接自动更新（公钥没填）
    Unconfigured,
    /// 已经是最新的
    Latest,
    Ready(UpdateInfo),
}

/// 窗口出来了（lib.rs 的 ready）：开始定时查。只起一次 —— 开发时整页重载也会再调 ready
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<AppState>() else { return };
    if state.update.started.swap(true, Ordering::SeqCst) || !auto_check() {
        return;
    }
    let hub = state.update.clone();
    let data_dir = state.data_dir.clone();
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("update-check".into())
        .spawn(move || {
            std::thread::sleep(FIRST_CHECK);
            loop {
                let wait = match tauri::async_runtime::block_on(check(&app, &hub, &data_dir)) {
                    Ok(Checked::Unconfigured) => return,
                    Ok(_) => EVERY,
                    Err(error) => {
                        eprintln!("检查更新失败: {error}");
                        // 连不上的过一会儿再试；签名对不上这类的，过半小时也还是那个包，按平常的间隔来
                        if matches!(error, AppError::Io(_)) {
                            RETRY
                        } else {
                            EVERY
                        }
                    }
                };
                std::thread::sleep(wait);
            }
        });
    if let Err(error) = spawned {
        eprintln!("检查更新的线程没起来: {error}");
    }
}

/// 发布的版本自己定时查；开发时只有指定了测试地址才查（不然每次 tauri dev 都去问 GitHub）
fn auto_check() -> bool {
    !cfg!(debug_assertions) || std::env::var_os("ODEA_UPDATER_ENDPOINT").is_some()
}

/// 查一次。latest.json 的地址一个一个试（tauri.conf.json 里的顺序；现在只有 GitHub，
/// 测试时 ODEA_UPDATER_ENDPOINT 可以给好几个）。
/// 一个地址查到了新版、安装包却下不下来或者签名对不上，就换下一个地址整条再走一遍 ——
/// latest.json 拿得到不代表安装包也下得动。插件自己的多地址只管「latest.json 取不到就换」，管不到这一层。
///
/// 一个地址回答「已经是最新的」也接着问下一个：前面的地址可能是不再更新的镜像（以前的 Gitee 就是）。
/// 都问过了、没有一个查到新版：有一个说「最新」就是最新，不然报最后那个错
async fn check<R: Runtime>(app: &AppHandle<R>, hub: &UpdateHub, data_dir: &Path) -> Result<Checked> {
    let _one_at_a_time = hub.checking.lock().await;
    let Some(source) = source(app)? else {
        return Ok(Checked::Unconfigured);
    };
    let mut answered = false;
    let mut failure = None;
    for endpoint in &source.endpoints {
        let attempt = async {
            let updater = updater(app, data_dir, &source, endpoint.clone())?;
            check_at(app, hub, updater).await
        };
        match attempt.await {
            Ok(Checked::Latest) => answered = true,
            Ok(checked) => return Ok(checked),
            Err(error) => {
                eprintln!("检查更新失败（{endpoint}）: {error}");
                failure = Some(error);
            }
        }
    }
    match failure {
        _ if answered => Ok(Checked::Latest),
        Some(error) => Err(error),
        None => Err(AppError::Invalid("没有检查更新的地址".into())),
    }
}

/// 从一个地址查：有新版的话，能装的下载、验签，都好了记下来并通知前端
async fn check_at<R: Runtime>(app: &AppHandle<R>, hub: &UpdateHub, updater: Updater) -> Result<Checked> {
    let Some(mut update) = updater.check().await.map_err(update_error)? else {
        // 没有更新的了：之前下好的那一版还等着装
        return Ok(hub.pending_info().map_or(Checked::Latest, Checked::Ready));
    };
    if let Some(info) = hub.pending_info().filter(|info| info.version == update.version) {
        return Ok(Checked::Ready(info));
    }

    let manual = manual_install().then(|| DOWNLOAD_PAGE.to_string());
    let info = UpdateInfo {
        version: update.version.clone(),
        current: update.current_version.clone(),
        notes: update.body.clone().filter(|notes| !notes.trim().is_empty()),
        date: release_date(&update),
        manual,
    };
    let bytes = if info.manual.is_some() {
        None
    } else {
        update.timeout = Some(DOWNLOAD_TIMEOUT);
        // 下载完先验签（download 里做），对不上就是错误，不会记下来
        Some(update.download(|_, _| {}, || {}).await.map_err(update_error)?)
    };
    *lock(&hub.pending) = Some(Pending { info: info.clone(), update, bytes });
    if let Err(error) = UpdateReady(info.clone()).emit(app) {
        eprintln!("通知前端失败: {error}");
    }
    Ok(Checked::Ready(info))
}

/// 去哪查、用哪个公钥验签（tauri.conf.json 的 plugins.updater）
struct Source {
    endpoints: Vec<tauri::Url>,
    pubkey: String,
}

/// 公钥或地址没填 = 这一版没接自动更新，返回 None
fn source<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Source>> {
    let config = app.config().plugins.0.get("updater");
    #[cfg_attr(not(debug_assertions), allow(unused_mut))]
    let mut pubkey = config
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .unwrap_or_default()
        .to_string();
    #[cfg_attr(not(debug_assertions), allow(unused_mut))]
    let mut endpoints: Vec<tauri::Url> = config
        .and_then(|updater| updater.get("endpoints"))
        .and_then(|list| list.as_array())
        .map(|list| list.iter().filter_map(|url| url.as_str()?.parse().ok()).collect())
        .unwrap_or_default();
    #[cfg(debug_assertions)]
    {
        if let Ok(list) = std::env::var("ODEA_UPDATER_ENDPOINT") {
            endpoints = list
                .split(',')
                .map(|url| url.trim().parse())
                .collect::<std::result::Result<_, _>>()
                .map_err(|e| AppError::Invalid(format!("ODEA_UPDATER_ENDPOINT: {e}")))?;
        }
        if let Ok(key) = std::env::var("ODEA_UPDATER_PUBKEY") {
            pubkey = key;
        }
    }
    if pubkey.trim().is_empty() || endpoints.is_empty() {
        return Ok(None);
    }
    Ok(Some(Source { endpoints, pubkey }))
}

/// 只问这一个地址的 updater，请求走同步的代理
fn updater<R: Runtime>(
    app: &AppHandle<R>,
    data_dir: &Path,
    source: &Source,
    endpoint: tauri::Url,
) -> Result<Updater> {
    let mut builder = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .pubkey(source.pubkey.clone())
        .endpoints(vec![endpoint])
        .map_err(update_error)?;
    let proxy = proxy::resolve(boot::Config::load(data_dir).sync_proxy.as_deref());
    if let Some(proxy) = proxy.and_then(|p| p.parse::<tauri::Url>().ok()) {
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(update_error)
}

/// Linux 上只有 AppImage 能自己换掉自己；deb / rpm 要 root
fn manual_install() -> bool {
    cfg!(target_os = "linux")
        && tauri::utils::platform::bundle_type() != Some(tauri::utils::config::BundleType::AppImage)
}

/// latest.json 里的 pub_date（RFC 3339）取日期那一段
fn release_date(update: &Update) -> Option<String> {
    let date = update.raw_json.get("pub_date")?.as_str()?;
    date.get(..10).map(str::to_string)
}

fn update_error(error: tauri_plugin_updater::Error) -> AppError {
    use tauri_plugin_updater::Error as E;
    match error {
        E::Reqwest(_) | E::Network(_) => AppError::Io(format!("连不上更新服务器: {error}")),
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) => {
            AppError::Invalid(format!("新版本的签名对不上，没有安装: {error}"))
        }
        other => AppError::Internal(format!("更新出错了: {other}")),
    }
}

/* ---------------- 命令 ---------------- */

/// 下好了、等着装的新版本（前端启动时取一次，之后跟着 UpdateReady 事件走）
#[tauri::command]
#[specta::specta]
pub async fn update_status(state: State<'_, AppState>) -> Result<Option<UpdateInfo>> {
    Ok(state.update.pending_info())
}

/// 命令面板「检查更新」：现在就查，有新版的话下好再返回。已经是最新的返回 None
#[tauri::command]
#[specta::specta]
pub async fn update_check<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<Option<UpdateInfo>> {
    match check(&app, &state.update, &state.data_dir).await? {
        Checked::Unconfigured => Err(AppError::Invalid("这个版本没有接自动更新".into())),
        Checked::Latest => Ok(None),
        Checked::Ready(info) => Ok(Some(info)),
    }
}

/// 重启并更新。前端调之前已经把编辑器里的内容写盘了。
/// Windows 上安装包接手后这个进程就结束了，这个命令不会返回；装不上时窗口回来、同步重新开起来
#[tauri::command]
#[specta::specta]
pub async fn update_install<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, AppState>,
) -> Result<()> {
    let Some(pending) = lock(&state.update.pending).take() else {
        return Err(AppError::Invalid("没有等着安装的新版本".into()));
    };
    let Some(bytes) = pending.bytes.clone() else {
        *lock(&state.update.pending) = Some(pending);
        return Err(AppError::Invalid("这个版本要到下载页手动安装".into()));
    };

    // 窗口位置平时在退出时才存，安装包会直接结束这个进程
    {
        use tauri_plugin_window_state::{AppHandleExt, StateFlags};
        if let Err(error) = app.save_window_state(StateFlags::all()) {
            eprintln!("记窗口位置失败: {error}");
        }
    }
    // 和关窗口一样：窗口先藏起来，开着同步就把最后的改动推上去，最多等 3 秒
    let _ = window.hide();
    let synced = state.sync.is_running();
    if synced {
        let hub = state.sync.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || hub.close(Duration::from_secs(3))).await;
    }

    let update = pending.update.clone();
    let installed = tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|e| AppError::Internal(format!("任务panic: {e}")))?;
    match installed {
        // macOS / Linux：程序文件换好了，重启就是新版
        Ok(()) => app.restart(),
        Err(error) => {
            *lock(&state.update.pending) = Some(pending);
            let _ = window.show();
            if synced {
                restart_sync(&app, &state);
            }
            Err(update_error(error))
        }
    }
}

fn restart_sync<R: Runtime>(app: &AppHandle<R>, state: &AppState) {
    let hooks = crate::commands::sync_hooks(app.clone(), state.data_dir.clone());
    if let Err(error) = state.sync.start(state.vault.clone(), hooks) {
        eprintln!("同步没能重新开起来: {error}");
    }
}

/// 这一次启动是升级上来的话，从哪一版升到哪一版（只给一次：换仓库整页重载以后不再给）
#[tauri::command]
#[specta::specta]
pub async fn app_upgrade(state: State<'_, AppState>) -> Result<Option<AppUpgrade>> {
    Ok(lock(&state.update.upgrade).take())
}
