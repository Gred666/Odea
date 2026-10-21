/* ============================================================
同步线程（技术方案 §5.9.5、§5.9.6）：什么时候同步、一轮怎么跑、锁怎么拿。

- 一个仓库一个线程，同一时间只有一轮。联网（fetch / push）不拿仓库锁 ——
  网络慢或者断网时，所有命令都会卡在锁上；提交、合并拿锁，几十毫秒。
- 两种轮次：
  - 本地轮：文件变了，安静 1 分钟（一直在写的话最多等 10 分钟）。先提交；
    没有新提交、也没有没推上去的，就到此为止，不联网 —— 合并写进工作区的文件
    也会被文件监听戳到这里，这样不会白白再连一次云端
  - 完整轮：启动、窗口获得焦点（距上一轮至少 1 分钟）、每 10 分钟、立即同步。
    提交 → 拉取 → 合并 → 推送，推送被拒就再来，最多 3 次
- 连不上：按 1、2、5、10 分钟退避重试
- 关窗口：提交 + 推送，调用方最多等 3 秒
- 换了仓库（Vault 被整个换掉）：线程发现根目录变了，自己退出
- 不依赖 tauri：状态、提示、令牌都从 Hooks 进出
============================================================ */

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::repo::{self, Author, Net, Oversized, Pushed, SyncError, SyncRepo, SyncResult};
use crate::domain::model::{SyncOversized, SyncState, SyncStatus};
use crate::vault::Vault;

const FIRST_ROUND_LATEST: Duration = Duration::from_secs(30);
const QUIET: Duration = Duration::from_secs(60);
const MAX_WAIT: Duration = Duration::from_secs(600);
const PULL_EVERY: Duration = Duration::from_secs(600);
const FOCUS_GAP: Duration = Duration::from_secs(60);
const BACKOFF_SECS: [u64; 4] = [60, 120, 300, 600];
/// 推送被拒（别的设备刚推过）后最多再来几次
const ATTEMPTS: usize = 3;
const REPACK_LOOSE: usize = 1000;
const REPACK_EVERY_MS: i64 = 24 * 3600 * 1000;
const AUTHOR_EMAIL: &str = "odea@localhost";
const MB: u64 = 1024 * 1024;

/// 仓库的 .git/config 里 `odea.autosync = true` 才同步（技术方案 §5.9.4）。
/// 改名前的 `ontheway.*` 打开仓库时换成新的（SyncRepo::open）
pub const AUTOSYNC_KEY: &str = "odea.autosync";

/// 这台设备叫什么：提交署名是「账号 (设备名)」（没登录的是「Odea (设备名)」），历史版本里据此说是哪台设备改的
pub fn this_device() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "本机".into())
}

/// 提交署名拆成（谁, 哪台设备）：「Gred666 (书房的电脑)」→ (Gred666, 书房的电脑)。
/// 「Odea (…)」（P10.4 以前、没登录时）和改名前的「OnTheWay (…)」只有设备；别的 git 工具提交的整个当设备。
/// 从第一个「 (」拆：账号里没有空格和括号，设备名里可能有
pub fn author_parts(author: &str) -> (Option<&str>, &str) {
    match author.strip_suffix(')').and_then(|rest| rest.split_once(" (")) {
        Some((who, device)) if !device.is_empty() && !who.is_empty() => {
            let app = who == APP_NAME || who == crate::old_name::NAME;
            ((!app).then_some(who), device)
        }
        _ => (None, author),
    }
}


/// 提交署名里的应用名
const APP_NAME: &str = "Odea";
pub const PROVIDER_KEY: &str = "odea.provider";
/// 这个仓库用哪个账号同步（login，令牌在钥匙串里）
pub const LOGIN_KEY: &str = "odea.login";

/// 同步线程和外面打交道的口子
#[derive(Clone)]
pub struct Hooks {
    /// 状态变了
    pub status: Arc<dyn Fn(&SyncStatus) + Send + Sync>,
    /// 要告诉用户的一句话（提示条）
    pub notice: Arc<dyn Fn(String) + Send + Sync>,
    /// 连云端用的令牌和代理（技术方案 §5.9.4）。每轮问一次：令牌可能刚续过期。
    /// 第二个参数是「刚才用它被云端拒了」：GitHub 的令牌要先续一次
    pub net: Arc<dyn Fn(&SyncRepo, bool) -> SyncResult<Net> + Send + Sync>,
}

enum Signal {
    /// 仓库里有文件变了（文件监听戳的）
    Wrote,
    Focus,
    Now,
    /// 关窗口：提交 + 推送，做完回个话
    Close(Sender<()>),
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Local,
    Full,
    Closing,
}

/// 同步线程的遥控器，放在 AppState 里。没开同步时里面是空的，戳一下什么也不发生
#[derive(Default)]
pub struct SyncHub {
    running: Mutex<Option<Running>>,
}

struct Running {
    tx: Sender<Signal>,
    status: Arc<Mutex<SyncStatus>>,
    /// 停掉之后设成 false：线程可能正在一轮的半路上（停的信号排在后面），
    /// 这一轮剩下的状态、提示不能再发出去 —— 前端已经是「没开同步」了
    alive: Arc<AtomicBool>,
}

impl SyncHub {
    /// 仓库开了同步就起线程（先停掉旧的）。返回起没起
    pub fn start(&self, vault: Arc<Mutex<Vault>>, hooks: Hooks) -> SyncResult<bool> {
        self.stop();
        let root = lock(&vault, None)?.root().to_path_buf();
        let Some(repo) = SyncRepo::open(&root)? else {
            return Ok(false);
        };
        if repo.config_get(AUTOSYNC_KEY).as_deref() != Some("true") || repo.remote_url().is_none() {
            return Ok(false);
        }
        let status = Arc::new(Mutex::new(SyncStatus {
            state: SyncState::Idle,
            remote: repo.remote_url().as_deref().map(display_remote),
            unpushed: repo.unpushed() as u32,
            ..SyncStatus::default()
        }));
        let (tx, rx) = mpsc::channel();
        let alive = Arc::new(AtomicBool::new(true));
        let mut engine = Engine::new(vault, root, repo, hooks, status.clone());
        engine.alive = alive.clone();
        std::thread::Builder::new()
            .name("sync".into())
            .spawn(move || engine.run(rx))
            .map_err(|error| SyncError::Local(format!("起不来同步线程: {error}")))?;
        *self.running.lock().unwrap_or_else(|e| e.into_inner()) = Some(Running { tx, status, alive });
        Ok(true)
    }

    /// 停掉同步线程。不等它：可能正卡在网络上，它看到信号或者通道断了自己会退
    pub fn stop(&self) {
        if let Some(running) = self.running.lock().unwrap_or_else(|e| e.into_inner()).take() {
            running.alive.store(false, Ordering::SeqCst);
            let _ = running.tx.send(Signal::Stop);
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }

    /// 仓库里有文件变了
    pub fn poke(&self) {
        self.send(Signal::Wrote);
    }

    /// 窗口获得焦点
    pub fn focus(&self) {
        self.send(Signal::Focus);
    }

    /// 立即同步。没开同步返回 false
    pub fn sync_now(&self) -> bool {
        self.send(Signal::Now)
    }

    /// 关窗口前：提交 + 推送，最多等 `wait`
    pub fn close(&self, wait: Duration) {
        let (reply, done) = mpsc::channel();
        if self.send(Signal::Close(reply)) {
            let _ = done.recv_timeout(wait);
        }
    }

    pub fn status(&self) -> SyncStatus {
        match &*self.running.lock().unwrap_or_else(|e| e.into_inner()) {
            Some(running) => running.status.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            None => SyncStatus::default(),
        }
    }

    fn send(&self, signal: Signal) -> bool {
        match &*self.running.lock().unwrap_or_else(|e| e.into_inner()) {
            Some(running) => running.tx.send(signal).is_ok(),
            None => false,
        }
    }
}

/// 一轮的结果
enum Outcome {
    /// 本地轮，没东西要推，没联网
    Quiet,
    Synced,
    Failed(SyncError),
    /// 仓库换了，这个线程该退了
    Gone,
}

/// 一轮中途停下的原因
enum Halt {
    Gone,
    Error(SyncError),
}

impl From<SyncError> for Halt {
    fn from(error: SyncError) -> Self {
        Halt::Error(error)
    }
}

/// 记在 .git/odea.json 里（不会被推上去）：提示过哪些超限文件、上次打包是什么时候
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Memo {
    #[serde(default)]
    warned: Vec<(String, u64)>,
    #[serde(default)]
    last_repack: i64,
}

/// 托管方的上限（技术方案 §5.9.3）
struct Limits {
    file: u64,
    warn_repo: u64,
    host: &'static str,
}

fn limits(provider: Option<&str>) -> Limits {
    match provider {
        // 免费版单文件 50 MB、单仓库 500 MB，超了推拉都被锁
        Some("gitee") => Limits { file: 50 * MB, warn_repo: 400 * MB, host: "Gitee" },
        Some("github") => Limits { file: 100 * MB, warn_repo: 1024 * MB, host: "GitHub" },
        _ => Limits { file: 100 * MB, warn_repo: 1024 * MB, host: "云端" },
    }
}

struct Engine {
    vault: Arc<Mutex<Vault>>,
    root: PathBuf,
    repo: SyncRepo,
    hooks: Hooks,
    status: Arc<Mutex<SyncStatus>>,
    device: String,
    memo: Memo,
    size_warned: bool,
    failures: usize,
    /// SyncHub 停掉它之后是 false：状态和提示不再往外发
    alive: Arc<AtomicBool>,
}

impl Engine {
    fn new(
        vault: Arc<Mutex<Vault>>,
        root: PathBuf,
        repo: SyncRepo,
        hooks: Hooks,
        status: Arc<Mutex<SyncStatus>>,
    ) -> Self {
        let memo = std::fs::read_to_string(memo_path(&root))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let device = this_device();
        Self {
            vault,
            root,
            repo,
            hooks,
            status,
            device,
            memo,
            size_warned: false,
            failures: 0,
            alive: Arc::new(AtomicBool::new(true)),
        }
    }

    fn run(mut self, rx: Receiver<Signal>) {
        clear_stale_lock(&self.root);
        // .gitignore / .gitattributes 里应用那一段每次启动都对一遍：新版本可能改了规则，
        // 仓库也可能是用别的方式建的
        if let Err(error) = self.repo.prepare() {
            eprintln!("准备同步仓库失败: {error}");
        }
        // 启动时先来一轮完整的 —— 等前端订阅好事件再开始（窗口 ready 时会触发立即同步），
        // 不然第一轮的提示（冲突副本、超限文件）没人收。前端一直没起来也最多等这么久
        let mut next_pull = Instant::now() + FIRST_ROUND_LATEST;
        let mut first_write: Option<Instant> = None;
        let mut last_write = Instant::now();
        let mut last_round: Option<Instant> = None;
        loop {
            let commit_due = first_write.map(|first| (first + MAX_WAIT).min(last_write + QUIET));
            let deadline = commit_due.map_or(next_pull, |due| due.min(next_pull));
            let kind = match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(Signal::Wrote) => {
                    last_write = Instant::now();
                    first_write.get_or_insert(last_write);
                    continue;
                }
                Ok(Signal::Focus) => {
                    // 第一轮之前的不算：窗口一建出来（还藏着、前端还没订阅事件）就会收到
                    // 一次获得焦点，第一轮要等 ready
                    if last_round.is_none_or(|at| at.elapsed() < FOCUS_GAP) {
                        continue;
                    }
                    Kind::Full
                }
                Ok(Signal::Now) => Kind::Full,
                Ok(Signal::Close(reply)) => {
                    let outcome = self.round(Kind::Closing);
                    let _ = reply.send(());
                    if matches!(outcome, Outcome::Gone) {
                        return;
                    }
                    continue;
                }
                Ok(Signal::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                Err(RecvTimeoutError::Timeout) if Instant::now() >= next_pull => Kind::Full,
                Err(RecvTimeoutError::Timeout) => Kind::Local,
            };
            first_write = None;
            let outcome = self.round(kind);
            last_round = Some(Instant::now());
            match outcome {
                Outcome::Gone => return,
                Outcome::Quiet => {}
                Outcome::Synced => {
                    self.failures = 0;
                    next_pull = Instant::now() + PULL_EVERY;
                }
                Outcome::Failed(SyncError::Network(_)) => {
                    let wait = BACKOFF_SECS[self.failures.min(BACKOFF_SECS.len() - 1)];
                    self.failures += 1;
                    next_pull = Instant::now() + Duration::from_secs(wait);
                }
                Outcome::Failed(_) => next_pull = Instant::now() + PULL_EVERY,
            }
        }
    }

    fn round(&mut self, kind: Kind) -> Outcome {
        match self.try_round(kind) {
            Ok(true) => Outcome::Synced,
            Ok(false) => Outcome::Quiet,
            Err(Halt::Gone) => Outcome::Gone,
            Err(Halt::Error(error)) => {
                eprintln!("同步失败: {error}");
                let state = match &error {
                    SyncError::Network(_) => SyncState::Offline,
                    SyncError::Auth => SyncState::Auth,
                    _ => SyncState::Error,
                };
                let unpushed = self.repo.unpushed() as u32;
                self.update(|status| {
                    status.state = state;
                    status.message = Some(error.to_string());
                    status.unpushed = unpushed;
                });
                Outcome::Failed(error)
            }
        }
    }

    /// 一轮。返回联没联网（本地轮没东西要推时不联网）
    fn try_round(&mut self, kind: Kind) -> Result<bool, Halt> {
        let limits = limits(self.repo.config_get(PROVIDER_KEY).as_deref());
        // 「账号 (设备名)」：团队仓库的历史里看得出是谁改的（docs/协同编辑.md §22.3）
        let name = match self.repo.config_get(LOGIN_KEY).filter(|login| !login.is_empty()) {
            Some(login) => format!("{login} ({})", self.device),
            None => format!("{APP_NAME} ({})", self.device),
        };
        let author = Author { name: &name, email: AUTHOR_EMAIL };

        // 一下子要进库很多文件（第一次开启同步之类）：先在锁外成批放进包里，
        // 不然提交要好几秒，这期间保存都在等锁。失败了也不要紧，下面的提交照常逐个写
        let staged = self.repo.stage_bulk(limits.file, || {
            self.update(|status| status.state = SyncState::Syncing)
        });
        if let Err(error) = staged {
            eprintln!("成批放进包里失败: {error}");
        }
        let committed = {
            let _vault = lock(&self.vault, Some(&self.root))?;
            self.repo.commit_all(&author, limits.file, repo::describe)?
        };
        self.note_oversized(&committed.oversized, &limits);
        let unpushed = self.repo.unpushed();
        if kind != Kind::Full && committed.changes.is_empty() && unpushed == 0 {
            return Ok(false);
        }

        self.update(|status| status.state = SyncState::Syncing);
        let mut net = (self.hooks.net)(&self.repo, false)?;
        if kind == Kind::Closing {
            // 关窗口时只推，被拒就算了：下次启动先拉再推
            self.online(&mut net, SyncRepo::push)?;
            self.finish(&limits);
            return Ok(true);
        }
        for _ in 0..ATTEMPTS {
            self.online(&mut net, SyncRepo::fetch)?;
            let copies = {
                let mut vault = lock(&self.vault, Some(&self.root))?;
                // 拉取的这会儿用户可能又存过：先提交，不然检出会拒绝覆盖
                self.repo.commit_all(&author, limits.file, repo::describe)?;
                let pulled = self.repo.merge_fetched(&author)?;
                let theirs: Vec<(String, Vec<u8>)> = pulled
                    .conflicts
                    .into_iter()
                    .map(|conflict| (conflict.rel, conflict.theirs))
                    .collect();
                if pulled.changed.is_empty() && theirs.is_empty() {
                    Vec::new()
                } else {
                    let copies = vault
                        .absorb_merge(&theirs)
                        .map_err(|error| SyncError::Local(error.to_string()))?;
                    if !copies.is_empty() {
                        self.repo
                            .commit_all(&author, limits.file, |_| "保存冲突副本".into())?;
                    }
                    copies
                }
            };
            if !copies.is_empty() {
                self.notice(format!(
                    "另一台设备也改了同一处，那一版另存为「{}」—— 打开它，选一版留下",
                    copies.join("」「")
                ));
            }
            if self.online(&mut net, SyncRepo::push)? == Pushed::Done {
                self.finish(&limits);
                return Ok(true);
            }
        }
        Err(SyncError::Remote("推送一直被拒：别的设备正在同时同步，稍后会再试".into()).into())
    }

    /// 联网的一步（fetch / push）。被拒说「要登录」时让 hooks 续一次令牌，再试一次
    fn online<T>(
        &self,
        net: &mut Net,
        step: impl Fn(&SyncRepo, &Net) -> SyncResult<T>,
    ) -> SyncResult<T> {
        match step(&self.repo, net) {
            Err(SyncError::Auth) if net.credentials.is_some() => {
                *net = (self.hooks.net)(&self.repo, true)?;
                step(&self.repo, net)
            }
            other => other,
        }
    }

    /// 同步成功之后：更新状态，仓库太大提醒一次，零散对象多了就打包
    fn finish(&mut self, limits: &Limits) {
        let unpushed = self.repo.unpushed() as u32;
        let now = chrono::Utc::now().timestamp_millis();
        self.update(|status| {
            status.state = SyncState::Idle;
            status.message = None;
            status.unpushed = unpushed;
            status.last_synced_at = Some(now);
        });

        let size = self.repo.objects_size();
        if size >= limits.warn_repo && !self.size_warned {
            self.size_warned = true;
            let advice = match limits.host {
                "Gitee" => "Gitee 免费仓库最多 500 MB，超了就推不上去也拉不下来",
                "GitHub" => "GitHub 建议仓库不超过 1 GB",
                _ => "仓库越大同步越慢",
            };
            self.notice(format!(
                "同步的仓库已经有 {} MB 了：{advice}。删掉的附件仍留在历史里占地方",
                size / MB
            ));
        }

        if self.repo.loose_objects() > REPACK_LOOSE && now - self.memo.last_repack > REPACK_EVERY_MS {
            match self.repo.repack() {
                Ok(()) => {
                    self.memo.last_repack = now;
                    self.save_memo();
                }
                Err(error) => eprintln!("打包仓库失败: {error}"),
            }
        }
    }

    /// 太大没同步的文件：状态里一直列着；每个文件（按路径 + 大小）只提示一次
    fn note_oversized(&mut self, oversized: &[Oversized], limits: &Limits) {
        let list: Vec<SyncOversized> = oversized
            .iter()
            .map(|file| SyncOversized { rel: file.rel.clone(), bytes: file.size as f64 })
            .collect();
        self.update(|status| status.oversized = list);

        let fresh: Vec<&Oversized> = oversized
            .iter()
            .filter(|file| !self.memo.warned.contains(&(file.rel.clone(), file.size)))
            .collect();
        if !fresh.is_empty() {
            let names: Vec<String> = fresh
                .iter()
                .map(|file| format!("{}（{} MB）", file.rel, file.size.div_ceil(MB)))
                .collect();
            self.notice(format!(
                "「{}」超过 {} 单个文件 {} MB 的上限，没有同步",
                names.join("」「"),
                limits.host,
                limits.file / MB
            ));
        }
        let current: Vec<(String, u64)> = oversized
            .iter()
            .map(|file| (file.rel.clone(), file.size))
            .collect();
        if current != self.memo.warned {
            // 变回上限以内的就忘掉：以后又超了还会再提示
            self.memo.warned = current;
            self.save_memo();
        }
    }

    fn update(&self, change: impl FnOnce(&mut SyncStatus)) {
        let snapshot = {
            let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
            let before = status.clone();
            change(&mut *status);
            if *status == before {
                return;
            }
            status.clone()
        };
        if self.alive.load(Ordering::SeqCst) {
            (self.hooks.status)(&snapshot);
        }
    }

    /// 告诉用户一句话（停掉之后就不说了）
    fn notice(&self, text: String) {
        if self.alive.load(Ordering::SeqCst) {
            (self.hooks.notice)(text);
        }
    }

    fn save_memo(&self) {
        if let Ok(text) = serde_json::to_string(&self.memo) {
            let _ = std::fs::write(memo_path(&self.root), text);
        }
    }
}

/// 拿仓库锁。`root` 给了就核对一下：Vault 被整个换掉（换了仓库）时返回 Gone
fn lock<'a>(vault: &'a Mutex<Vault>, root: Option<&Path>) -> Result<MutexGuard<'a, Vault>, Halt> {
    let guard = vault
        .lock()
        .map_err(|_| Halt::Error(SyncError::Local("仓库锁坏了".into())))?;
    if root.is_some_and(|root| guard.root() != root) {
        return Err(Halt::Gone);
    }
    Ok(guard)
}

impl From<Halt> for SyncError {
    fn from(halt: Halt) -> Self {
        match halt {
            Halt::Gone => SyncError::Local("仓库换了".into()),
            Halt::Error(error) => error,
        }
    }
}

/// .git 里的记事文件。改名前叫 ontheway.json，打开仓库时换成这个名字（SyncRepo::open）
pub const MEMO_FILE: &str = "odea.json";

fn memo_path(root: &Path) -> PathBuf {
    root.join(".git").join(MEMO_FILE)
}

/// 上次提交到一半被打断（关窗口时进程没等完）留下的锁。一分钟以前的才删：
/// 用户自己在用 git 时锁不会挂这么久
fn clear_stale_lock(root: &Path) {
    let path = root.join(".git").join("index.lock");
    let stale = std::fs::metadata(&path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age > Duration::from_secs(60));
    if stale {
        let _ = std::fs::remove_file(path);
    }
}

/// `https://github.com/xxx/notes.git` → `github.com/xxx/notes`
pub fn display_remote(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let rest = rest.split_once('@').map_or(rest, |(_, host)| host);
    rest.trim_end_matches('/').trim_end_matches(".git").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    use crate::domain::model::VaultChange;

    struct Cloud {
        _dir: tempfile::TempDir,
        url: String,
    }

    fn cloud() -> Cloud {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote.git");
        let mut options = git2::RepositoryInitOptions::new();
        options.bare(true).initial_head(repo::DEFAULT_BRANCH);
        git2::Repository::init_opts(&path, &options).unwrap();
        Cloud { url: path.to_string_lossy().replace('\\', "/"), _dir: dir }
    }

    /// 一台设备：一个仓库（Vault）+ 一个同步引擎，记下发出去的状态、提示、变化
    struct Device {
        _dir: tempfile::TempDir,
        root: PathBuf,
        vault: Arc<Mutex<Vault>>,
        engine: Engine,
        notices: Arc<StdMutex<Vec<String>>>,
        changes: Arc<StdMutex<Vec<VaultChange>>>,
        statuses: Arc<StdMutex<Vec<SyncStatus>>>,
    }

    impl Device {
        fn new(cloud: &Cloud, provider: Option<&str>) -> Device {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("仓库");
            // 云端还是空的：这是第一台设备，init；否则是后来的设备，clone
            let has_history = git2::Repository::open_bare(&cloud.url)
                .and_then(|remote| remote.head().map(|_| ()))
                .is_ok();
            let sync = if has_history {
                SyncRepo::clone(&cloud.url, &root, &Net::default()).unwrap()
            } else {
                std::fs::create_dir_all(&root).unwrap();
                let sync = SyncRepo::init(&root).unwrap();
                sync.set_remote_url(&cloud.url).unwrap();
                sync
            };
            sync.config_set(AUTOSYNC_KEY, "true").unwrap();
            if let Some(provider) = provider {
                sync.config_set(PROVIDER_KEY, provider).unwrap();
            }
            let mut vault = Vault::open_in_memory(&root);
            let changes = Arc::new(StdMutex::new(Vec::new()));
            let sink = changes.clone();
            vault.set_announcer(Arc::new(move |change| sink.lock().unwrap().push(change)));
            let vault = Arc::new(Mutex::new(vault));
            let notices = Arc::new(StdMutex::new(Vec::new()));
            let sink = notices.clone();
            let statuses = Arc::new(StdMutex::new(Vec::new()));
            let status_sink = statuses.clone();
            let hooks = Hooks {
                status: Arc::new(move |status: &SyncStatus| {
                    status_sink.lock().unwrap().push(status.clone())
                }),
                notice: Arc::new(move |text| sink.lock().unwrap().push(text)),
                net: Arc::new(|_, _| Ok(Net::default())),
            };
            let status = Arc::new(Mutex::new(SyncStatus::default()));
            let engine = Engine::new(vault.clone(), root.clone(), sync, hooks, status);
            Device { _dir: dir, root, vault, engine, notices, changes, statuses }
        }

        fn vault(&self) -> MutexGuard<'_, Vault> {
            self.vault.lock().unwrap()
        }

        fn sync(&mut self) {
            assert!(matches!(self.engine.round(Kind::Full), Outcome::Synced));
        }

        fn status(&self) -> SyncStatus {
            self.engine.status.lock().unwrap().clone()
        }
    }

    #[test]
    fn notes_written_on_one_device_show_up_in_the_others_index() {
        let cloud = cloud();
        let mut a = Device::new(&cloud, Some("github"));
        let id = a.vault().note_create("周报", "第一版").unwrap();
        a.sync();
        assert_eq!(a.status().state, SyncState::Idle);
        assert_eq!(a.status().unpushed, 0);
        assert!(a.status().last_synced_at.is_some());

        let mut b = Device::new(&cloud, Some("github"));
        assert_eq!(b.vault().note_get(&id).unwrap().content_md, "第一版");

        b.vault().note_update(&id, "周报", "第二版").unwrap();
        b.sync();
        a.changes.lock().unwrap().clear();
        a.sync();
        assert_eq!(a.vault().note_get(&id).unwrap().content_md, "第二版");
        // 前端被告知这篇变了
        assert!(a.changes.lock().unwrap().iter().any(|change| change.notes.contains(&id)));
    }

    #[test]
    fn a_real_conflict_leaves_a_copy_linked_to_the_original_and_a_notice() {
        let cloud = cloud();
        let mut a = Device::new(&cloud, None);
        let id = a.vault().note_create("周报", "进度：初稿").unwrap();
        a.sync();
        let mut b = Device::new(&cloud, None);

        a.vault().note_update(&id, "周报", "进度：A 写的").unwrap();
        b.vault().note_update(&id, "周报", "进度：B 写的").unwrap();
        a.sync();
        b.sync();

        let vault = b.vault();
        assert_eq!(vault.note_get(&id).unwrap().content_md, "进度：B 写的");
        let copy = vault
            .note_list_full(false)
            .unwrap()
            .into_iter()
            .find(|note| note.conflict_of.as_deref() == Some(id.as_str()))
            .expect("应该有一份冲突副本，认得出原文");
        assert_eq!(copy.content_md, "进度：A 写的");
        assert_ne!(copy.id, id);
        drop(vault);
        let notices = b.notices.lock().unwrap();
        assert_eq!(notices.len(), 1);
        assert!(notices[0].contains(&copy.title), "{}", notices[0]);
    }

    #[test]
    fn attachment_conflict_keeps_their_bytes_next_to_ours() {
        let cloud = cloud();
        let mut a = Device::new(&cloud, None);
        std::fs::create_dir_all(a.root.join("附件")).unwrap();
        std::fs::write(a.root.join("附件/图.png"), [0x89, b'P', 0, 1]).unwrap();
        a.sync();
        let mut b = Device::new(&cloud, None);

        std::fs::write(a.root.join("附件/图.png"), [0x89, b'P', 0, 2]).unwrap();
        std::fs::write(b.root.join("附件/图.png"), [0x89, b'P', 0, 3]).unwrap();
        a.sync();
        b.sync();

        assert_eq!(std::fs::read(b.root.join("附件/图.png")).unwrap(), [0x89, b'P', 0, 3]);
        let copy = std::fs::read_dir(b.root.join("附件"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .find(|name| name.starts_with("图 (冲突 ") && name.ends_with(".png"))
            .expect("应该有附件的冲突副本");
        assert_eq!(std::fs::read(b.root.join("附件").join(&copy)).unwrap(), [0x89, b'P', 0, 2]);
        // 副本也推上去了：A 那边拉得到
        a.sync();
        assert!(a.root.join("附件").join(&copy).exists());
    }

    #[test]
    fn local_round_without_changes_stays_offline_friendly() {
        let cloud = cloud();
        let mut a = Device::new(&cloud, None);
        a.vault().note_create("周报", "正文").unwrap();
        a.sync();
        // 云端换成连不上的地址：本地轮没东西要推，就不该去连
        a.engine.repo.set_remote_url("https://127.0.0.1:9/odea.git").unwrap();
        assert!(matches!(a.engine.round(Kind::Local), Outcome::Quiet));

        // 有了改动，本地轮要推，连不上 → 离线，改动都在本机
        a.vault().note_create("新的", "离线时写的").unwrap();
        assert!(matches!(a.engine.round(Kind::Local), Outcome::Failed(SyncError::Network(_))));
        let status = a.status();
        assert_eq!(status.state, SyncState::Offline);
        assert_eq!(status.unpushed, 1);
    }

    #[test]
    fn oversized_files_are_reported_once() {
        let cloud = cloud();
        let mut a = Device::new(&cloud, Some("gitee"));
        std::fs::create_dir_all(a.root.join("附件")).unwrap();
        let big = vec![7u8; (50 * MB + 1) as usize];
        std::fs::write(a.root.join("附件/录屏.mp4"), &big).unwrap();
        a.sync();
        a.sync();

        let notices = a.notices.lock().unwrap().clone();
        assert_eq!(notices.len(), 1, "{notices:?}");
        assert!(notices[0].contains("附件/录屏.mp4") && notices[0].contains("Gitee"), "{}", notices[0]);
        assert_eq!(a.status().oversized.len(), 1);

        // 变小了：照常同步，提示的记录也清掉
        std::fs::write(a.root.join("附件/录屏.mp4"), [1u8; 10]).unwrap();
        a.sync();
        assert!(a.status().oversized.is_empty());
        assert!(Device::new(&cloud, None).root.join("附件/录屏.mp4").exists());
    }

    #[test]
    fn a_stopped_engine_finishes_its_round_quietly() {
        let cloud = cloud();
        let mut a = Device::new(&cloud, None);
        a.vault().note_create("周报", "正文").unwrap();
        a.sync();
        assert!(!a.statuses.lock().unwrap().is_empty());
        // 断开同步时线程可能正在一轮的半路上：剩下的不该再把前端改回「已同步」
        a.statuses.lock().unwrap().clear();
        a.engine.alive.store(false, Ordering::SeqCst);
        a.vault().note_create("又一篇", "正文").unwrap();
        a.sync();
        assert!(a.statuses.lock().unwrap().is_empty());
    }

    #[test]
    fn a_replaced_vault_stops_the_engine() {
        let cloud = cloud();
        let mut a = Device::new(&cloud, None);
        let other = tempfile::tempdir().unwrap();
        *a.vault.lock().unwrap() = Vault::open_in_memory(other.path());
        assert!(matches!(a.engine.round(Kind::Full), Outcome::Gone));
    }

    #[test]
    fn remote_is_shown_without_scheme_credentials_or_suffix() {
        assert_eq!(display_remote("https://github.com/xxx/notes.git"), "github.com/xxx/notes");
        assert_eq!(display_remote("https://u:t@gitee.com/xxx/notes"), "gitee.com/xxx/notes");
    }
}
