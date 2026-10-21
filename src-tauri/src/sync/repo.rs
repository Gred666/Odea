/* ============================================================
同步用的 git 操作（技术方案 §5.9.5）。只管 git：不碰 Vault，不依赖 tauri。

一轮同步由调用方拼起来：commit_all → fetch → merge_fetched → push；
推送被拒（别的设备刚推过）就从头再来。联网的只有 fetch / push / clone，
它们不碰工作区；改工作区的只有 merge_fetched，调用方在仓库锁里调它。

- 合并在内存里做（merge_commits），工作区里永远不会出现 `<<<<<<<`：
  冲突的文件原处留本机的版本，对方的版本连同路径交回去，由调用方另存成冲突副本；
  一边删、一边改，留改过的。
- 逻辑目录的清单（.odea/tree）两边都改了：不出冲突副本，按节点三方合并（vault::tree::merge3）——
  git 逐行合上了也照样重合一遍：两边各把同一篇放进了不同的文件夹、互相挪进了对方，逐行看不出来
- 超过上限的文件不进库；进过库、后来变大的，停在上一次的版本 ——
  从索引里删掉，等于在别的设备上把它删了。
- libgit2 不会自己 gc：零散对象有多少（loose_objects）、什么时候 repack，调用方定。
- 一下子要进库很多文件时（第一次开启同步之类），先用 stage_bulk 成批放进包里：
  逐个写零散对象在 Windows 上很慢（技术方案 §5.9.8）。
============================================================ */

use std::cell::Cell;
use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;

use git2::build::{CheckoutBuilder, RepoBuilder};
use git2::{
    Commit, ConfigLevel, Cred, Delta, ErrorClass, ErrorCode, FetchOptions, Index, IndexAddOption, IndexConflict,
    IndexEntry, ProxyOptions, PushOptions, RemoteCallbacks, Repository, RepositoryInitOptions,
    Signature, Status, StatusOptions, StatusShow, Tree,
};

use crate::old_name;
use crate::vault::{fsio, tree};

/// `.git/config` 里应用自己的小节（`odea.autosync` 之类）
const APP_SECTION: &str = "odea";

/// 新建仓库用的分支名。沿用用户自己的仓库时用它当前的分支
pub const DEFAULT_BRANCH: &str = "main";
const REMOTE: &str = "origin";

const BLOCK_BEGIN: &str = "# >>> Odea（这一段由应用维护）";
const BLOCK_END: &str = "# <<< Odea";
/// 改名前那一段的记号（old_name.rs）：见到了就换成新的
const LEGACY_BLOCK_BEGIN: &str = "# >>> OnTheWay（这一段由应用维护）";
const LEGACY_BLOCK_END: &str = "# <<< OnTheWay";

/// .gitignore 里应用维护的那一段（技术方案 §5.9.3）。
/// `.*.tmp` 是原子写入的临时文件（fsio::write_atomic），提交时正好撞上会被带进去。
/// `.ontheway/trash/`：还没升级的设备把回收站放在改名前的文件夹里（old_name.rs），别把它推上去
const IGNORE: &str = "\
.odea/trash/
.ontheway/trash/
.*.tmp
.DS_Store
Thumbs.db
desktop.ini
";

/// .gitattributes 里应用维护的那一段：附件一个字节都不改，Markdown 统一 LF，
/// 只追加的行为日志两台设备的行都留下（还没升级的设备写在改名前的 .ontheway/ 里）
const ATTRIBUTES: &str = "\
* -text
*.md text eol=lf
.odea/activity/*.jsonl text eol=lf merge=union
.ontheway/activity/*.jsonl text eol=lf merge=union
";

/// 要进库的小文件到这么多个，就先成批放进包里（stage_bulk）
const BULK_FILES: usize = 200;
/// 成批进库只收这么大以下的文件：大文件个数少，逐个写不慢，放进内存却占地方
const BULK_FILE_BYTES: u64 = 1024 * 1024;
/// 一批在内存里最多攒这么多字节，攒满就先落成一个包
const BULK_BATCH_BYTES: u64 = 64 * 1024 * 1024;
/// 成批进库时最多开几个线程：等的是文件系统，不是 CPU
const BULK_THREADS: usize = 8;

/// 凭据回调拒绝时用的消息；classify 靠「回调被调过 + 错误不是 libgit2 自己的」认出登录问题
const NEED_LOGIN: &str = "需要登录";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncError {
    /// 远端要登录，或者令牌不对 / 过期
    Auth,
    /// 连不上：断网、代理、DNS、超时
    Network(String),
    /// 连上了但远端不干：仓库不存在、没权限、超配额……
    Remote(String),
    /// 本地的 git 操作失败
    Local(String),
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SyncError::Auth => write!(f, "登录失效，需要重新登录"),
            SyncError::Network(message) => write!(f, "连不上云端: {message}"),
            SyncError::Remote(message) => write!(f, "云端拒绝了: {message}"),
            SyncError::Local(message) => write!(f, "本地仓库出错: {message}"),
        }
    }
}

impl std::error::Error for SyncError {}

impl From<git2::Error> for SyncError {
    fn from(error: git2::Error) -> Self {
        SyncError::Local(error.message().to_string())
    }
}

impl From<std::io::Error> for SyncError {
    fn from(error: std::io::Error) -> Self {
        SyncError::Local(error.to_string())
    }
}

pub type SyncResult<T> = std::result::Result<T, SyncError>;

/// 连远端用的：令牌和代理
#[derive(Debug, Clone, Default)]
pub struct Net {
    /// (用户名, 令牌)：用户名是账号的 login，令牌当密码（技术方案 §5.9.4）
    pub credentials: Option<(String, String)>,
    /// 形如 `http://127.0.0.1:7897`。None = 直连
    pub proxy: Option<String>,
}

/// 提交署名
pub struct Author<'a> {
    pub name: &'a str,
    pub email: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    pub rel: String,
    pub kind: ChangeKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Oversized {
    pub rel: String,
    pub size: u64,
}

#[derive(Debug, Default)]
pub struct Committed {
    /// 这次提交了什么；空 = 没有改动，没提交
    pub changes: Vec<Change>,
    /// 超过上限、没进库的文件（包括停在旧版本的）
    pub oversized: Vec<Oversized>,
}

/// 原处留着本机的版本，对方的版本要另存成冲突副本
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    pub rel: String,
    pub theirs: Vec<u8>,
}

#[derive(Debug, Default)]
pub struct Pulled {
    /// 工作区里被改到的文件（新增、修改、删除），相对路径、正斜杠
    pub changed: Vec<String>,
    pub conflicts: Vec<Conflict>,
    /// 做了三方合并（不是快进，也不是本来就是最新的）。同步线程用不上，单测靠它分两种情况
    #[cfg_attr(not(test), allow(dead_code))]
    pub merged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pushed {
    /// 推上去了，或者没有要推的
    Done,
    /// 远端比本地新（别的设备刚推过）：再拉一次、合并、重推
    Rejected(String),
}

pub struct SyncRepo {
    repo: Repository,
    root: PathBuf,
}

impl SyncRepo {
    /// 仓库根上有 .git 才算：仓库文件夹在别的 git 仓库的子目录里不算
    pub fn open(root: &Path) -> SyncResult<Option<Self>> {
        if !root.join(".git").exists() {
            return Ok(None);
        }
        let this = Self::wrap(Repository::open(root)?, root);
        if let Err(error) = this.forget_old_name() {
            eprintln!("换掉同步仓库里改名前的设置失败: {error}");
        }
        Ok(Some(this))
    }

    /// 改名前（old_name.rs）的 `.git/config` 键（`ontheway.autosync` 之类）换成新的小节，
    /// `.git/ontheway.json` 换成新的文件名。新的已经有了就以新的为准
    fn forget_old_name(&self) -> SyncResult<()> {
        let mut config = self.repo.config()?.open_level(ConfigLevel::Local)?;
        let section = old_name::CONFIG_SECTION;
        let mut old: Vec<(String, String)> = Vec::new();
        config.entries(Some(&format!("^{section}\\.")))?.for_each(|entry| {
            if let (Ok(name), Ok(value)) = (entry.name(), entry.value()) {
                old.push((name.to_string(), value.to_string()));
            }
        })?;
        for (name, value) in old {
            let key = format!("{APP_SECTION}{}", &name[section.len()..]);
            if config.get_string(&key).is_err() {
                config.set_str(&key, &value)?;
            }
            config.remove(&name)?;
        }
        let git = self.root.join(".git");
        let (from, to) = (git.join(format!("{section}.json")), git.join(super::engine::MEMO_FILE));
        if from.exists() && !to.exists() {
            fs::rename(from, to)?;
        }
        Ok(())
    }

    /// 第一台设备：仓库根上建一个新的 git 仓库（技术方案 §5.9.7）
    pub fn init(root: &Path) -> SyncResult<Self> {
        let mut options = RepositoryInitOptions::new();
        options.initial_head(DEFAULT_BRANCH);
        let this = Self::wrap(Repository::init_opts(root, &options)?, root);
        this.prepare()?;
        Ok(this)
    }

    /// 第二台设备：把云端仓库拉到一个空文件夹里（技术方案 §5.9.7）
    pub fn clone(url: &str, root: &Path, net: &Net) -> SyncResult<Self> {
        let asked = Cell::new(0);
        let mut fetch = FetchOptions::new();
        fetch.remote_callbacks(callbacks(net, &asked));
        fetch.proxy_options(proxy(net));
        let repo = RepoBuilder::new()
            .fetch_options(fetch)
            .clone(url, root)
            .map_err(|error| classify(error, &asked))?;
        let this = Self::wrap(repo, root);
        this.prepare()?;
        Ok(this)
    }

    /// 云端仓库是空的吗（一个分支都没有）。开启同步时据此分：空的 = 第一台设备，把这里的推上去；
    /// 不空 = 接入已有的，clone 下来（技术方案 §5.9.7）
    pub fn remote_is_empty(url: &str, net: &Net) -> SyncResult<bool> {
        let asked = Cell::new(0);
        let mut remote = git2::Remote::create_detached(url)?;
        let connection = remote
            .connect_auth(git2::Direction::Fetch, Some(callbacks(net, &asked)), Some(proxy(net)))
            .map_err(|error| classify(error, &asked))?;
        let empty = connection
            .list()?
            .iter()
            .all(|head| !head.name().starts_with("refs/heads/"));
        Ok(empty)
    }

    fn wrap(repo: Repository, root: &Path) -> Self {
        Self {
            repo,
            root: root.to_path_buf(),
        }
    }

    /// 开启同步时做一次：仓库自己的配置，加上 .gitignore / .gitattributes 里应用维护的那一段。
    /// 返回有没有改这两个文件
    pub fn prepare(&self) -> SyncResult<bool> {
        let mut config = self.repo.config()?;
        // 机器上装过 Git for Windows 的话，libgit2 也会读到它的 autocrlf=true；行尾只听 .gitattributes 的
        config.set_bool("core.autocrlf", false)?;
        config.set_bool("core.longpaths", true)?;
        let ignore = upsert_block(&self.root.join(".gitignore"), IGNORE)?;
        let attributes = upsert_block(&self.root.join(".gitattributes"), ATTRIBUTES)?;
        Ok(ignore || attributes)
    }

    /// 当前分支名；还没有提交时也拿得到
    pub fn branch(&self) -> String {
        self.repo
            .find_reference("HEAD")
            .ok()
            .and_then(|head| head.symbolic_target().ok().flatten().map(str::to_string))
            .and_then(|target| target.strip_prefix("refs/heads/").map(str::to_string))
            .unwrap_or_else(|| DEFAULT_BRANCH.to_string())
    }

    pub fn remote_url(&self) -> Option<String> {
        self.repo
            .find_remote(REMOTE)
            .ok()?
            .url()
            .ok()
            .map(str::to_string)
    }

    pub fn set_remote_url(&self, url: &str) -> SyncResult<()> {
        if self.repo.find_remote(REMOTE).is_ok() {
            self.repo.remote_set_url(REMOTE, url)?;
        } else {
            self.repo.remote(REMOTE, url)?;
        }
        Ok(())
    }

    /// `.git/config` 里应用自己的键（`odea.provider` 之类，技术方案 §5.9.4）
    pub fn config_get(&self, key: &str) -> Option<String> {
        self.repo.config().ok()?.get_string(key).ok()
    }

    pub fn config_set(&self, key: &str, value: &str) -> SyncResult<()> {
        self.repo.config()?.set_str(key, value)?;
        Ok(())
    }

    pub fn config_remove(&self, key: &str) -> SyncResult<()> {
        match self.repo.config()?.remove(key) {
            Err(error) if error.code() != ErrorCode::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }

    /// git add -A && git commit。超过 `max_file_bytes` 的文件跳过（技术方案 §5.9.3）；
    /// 没有改动就不提交，返回的 `changes` 是空的
    pub fn commit_all(
        &self,
        author: &Author,
        max_file_bytes: u64,
        message: impl FnOnce(&[Change]) -> String,
    ) -> SyncResult<Committed> {
        let mut index = self.repo.index()?;
        let mut oversized = BTreeMap::new();
        {
            let root = &self.root;
            // 返回正数 = 跳过：新文件不进库，进过库的停在索引里的旧版本
            let mut skip_big = |path: &Path, _: &[u8]| -> i32 {
                match fs::metadata(root.join(path)) {
                    Ok(meta) if meta.is_file() && meta.len() > max_file_bytes => {
                        oversized.insert(rel_of(path), meta.len());
                        1
                    }
                    _ => 0,
                }
            };
            index.add_all(["*"].iter(), IndexAddOption::DEFAULT, Some(&mut skip_big))?;
            index.update_all(["*"].iter(), Some(&mut skip_big))?;
        }
        self.fix_case_renames(&mut index)?;
        index.write()?;
        let tree = self.repo.find_tree(index.write_tree()?)?;
        let oversized = oversized
            .into_iter()
            .map(|(rel, size)| Oversized { rel, size })
            .collect();

        let head = self.head_commit()?;
        let old_tree = head.as_ref().map(Commit::tree).transpose()?;
        if old_tree.as_ref().is_some_and(|old| old.id() == tree.id()) {
            return Ok(Committed {
                changes: Vec::new(),
                oversized,
            });
        }
        let changes = self.changes(old_tree.as_ref(), &tree)?;
        if changes.is_empty() {
            return Ok(Committed { changes, oversized });
        }
        let signature = Signature::now(author.name, author.email)?;
        let parents: Vec<&Commit> = head.iter().collect();
        self.repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            &message(&changes),
            &tree,
            &parents,
        )?;
        Ok(Committed { changes, oversized })
    }

    /// 要进库的小文件很多时（第一次开启同步、把本机笔记合并进来、拖进来一大批附件），
    /// 先把它们成批放进索引，对象直接落成包（技术方案 §5.9.8）。逐个来在 Windows 上
    /// 很慢：每个文件要写一个零散对象，libgit2 还要为它把属性（.gitattributes）从头查一遍，
    /// 两样都是在等文件系统。这里几个线程一起算，对象先放内存（mempack），一批落成一个包。
    ///
    /// 只放进索引、不提交：大文件、删除、提交本身还是 commit_all 来做，那时这些文件
    /// 已经在索引里了，一下就过去。不碰工作区，调用方不用持仓库锁 —— 期间文件又被改了，
    /// commit_all 看得出来。文件不多时什么都不做；要做时先调 `starting`。
    /// 返回放进去了几个文件
    pub fn stage_bulk(&self, max_file_bytes: u64, starting: impl FnOnce()) -> SyncResult<usize> {
        self.stage_in_batches(max_file_bytes, BULK_BATCH_BYTES, starting)
    }

    /// stage_bulk 本体。单测把一批的字节数调小，好测分批
    pub(super) fn stage_in_batches(
        &self,
        max_file_bytes: u64,
        batch_bytes: u64,
        starting: impl FnOnce(),
    ) -> SyncResult<usize> {
        // 找要进库的文件用 status，不用 add_all：status 只比 stat（2000 个新文件 7 ms），
        // add_all 却给每个新文件生成一份 diff —— 打开、读完、判断是不是二进制，2000 个要 5 s
        let max = max_file_bytes.min(BULK_FILE_BYTES);
        let mut options = StatusOptions::new();
        options
            .show(StatusShow::Workdir)
            .include_untracked(true)
            .recurse_untracked_dirs(true)
            .exclude_submodules(true);
        let mut pending = Vec::new();
        for entry in self.repo.statuses(Some(&mut options))?.iter() {
            if !entry
                .status()
                .intersects(Status::WT_NEW | Status::WT_MODIFIED | Status::WT_TYPECHANGE)
            {
                continue;
            }
            let Ok(rel) = entry.path() else { continue };
            match fs::metadata(self.root.join(rel)) {
                Ok(meta) if meta.is_file() && meta.len() <= max => {
                    pending.push((PathBuf::from(rel), meta.len()));
                }
                _ => {}
            }
        }
        if pending.len() < BULK_FILES {
            return Ok(0);
        }
        starting();

        let root = &self.root;
        let pack_dir = self.repo.path().join("objects").join("pack");
        fs::create_dir_all(&pack_dir)?;
        let threads = thread::available_parallelism()
            .map_or(1, |n| n.get())
            .min(BULK_THREADS);
        let mut index = self.repo.index()?;
        let mut staged = 0;
        let mut rest = pending.as_slice();
        while !rest.is_empty() {
            // 攒到 batch_bytes 为止，至少一个
            let mut bytes = 0;
            let count = rest
                .iter()
                .take_while(|(_, size)| {
                    let fits = bytes < batch_bytes;
                    bytes += size;
                    fits
                })
                .count();
            let (batch, after) = rest.split_at(count);
            rest = after;
            let pack_dir = &pack_dir;
            let entries = thread::scope(|scope| {
                let workers: Vec<_> = batch
                    .chunks(batch.len().div_ceil(threads))
                    .map(|files| scope.spawn(move || pack_files(root, pack_dir, files)))
                    .collect();
                workers
                    .into_iter()
                    .map(|worker| {
                        worker
                            .join()
                            .unwrap_or_else(|_| Err(SyncError::Local("打包的线程崩了".into())))
                    })
                    .collect::<SyncResult<Vec<_>>>()
            })?;
            for entry in entries.iter().flatten() {
                index.add(entry)?;
                staged += 1;
            }
            // 包都落了盘才写索引：中途断电，索引也不会指着不存在的对象
            index.write()?;
        }
        Ok(staged)
    }

    /// Windows / macOS 上只改了大小写的改名：libgit2 按 core.ignorecase 当成同一个文件，
    /// 索引里一直是旧的写法。拿索引里的路径和磁盘上的真实写法比，不一样就换成新的
    fn fix_case_renames(&self, index: &mut Index) -> SyncResult<()> {
        let ignore_case = self
            .repo
            .config()?
            .get_bool("core.ignorecase")
            .unwrap_or(false);
        if !ignore_case {
            return Ok(());
        }
        let tracked: Vec<String> = index
            .iter()
            .filter_map(|entry| String::from_utf8(entry.path).ok())
            .collect();
        let mut listings = HashMap::new();
        let mut renames = Vec::new();
        for rel in tracked {
            if let Some(actual) = actual_case(&self.root, &rel, &mut listings) {
                if actual != rel {
                    renames.push((rel, actual));
                }
            }
        }
        for (old, new) in renames {
            index.remove_path(Path::new(&old))?;
            index.add_path(Path::new(&new))?;
        }
        Ok(())
    }

    /// 从远端取新的提交，放在 `refs/remotes/origin/<分支>`。不碰工作区
    pub fn fetch(&self, net: &Net) -> SyncResult<()> {
        let branch = self.branch();
        let mut remote = self.origin()?;
        let asked = Cell::new(0);
        let mut options = FetchOptions::new();
        options.remote_callbacks(callbacks(net, &asked));
        options.proxy_options(proxy(net));
        let refspec = format!("+refs/heads/{branch}:refs/remotes/{REMOTE}/{branch}");
        remote
            .fetch(&[refspec], Some(&mut options), None)
            .map_err(|error| classify(error, &asked))
    }

    /// 把 fetch 来的合进当前分支，写进工作区。调用前先 commit_all：
    /// 工作区里有没提交的改动时，safe 模式的检出会拒绝覆盖
    pub fn merge_fetched(&self, author: &Author) -> SyncResult<Pulled> {
        let branch = self.branch();
        let Ok(their_ref) = self
            .repo
            .find_reference(&format!("refs/remotes/{REMOTE}/{branch}"))
        else {
            // 远端还是空的（第一次推之前）
            return Ok(Pulled::default());
        };
        let theirs = their_ref.peel_to_commit()?;
        let annotated = self.repo.reference_to_annotated_commit(&their_ref)?;
        let (analysis, _) = self.repo.merge_analysis(&[&annotated])?;
        if analysis.is_up_to_date() {
            return Ok(Pulled::default());
        }
        let head = self.head_commit()?;
        let old_tree = head.as_ref().map(Commit::tree).transpose()?;

        if analysis.is_unborn() || analysis.is_fast_forward() {
            let new_tree = theirs.tree()?;
            self.repo
                .checkout_tree(theirs.as_object(), Some(CheckoutBuilder::new().safe()))?;
            let refname = format!("refs/heads/{branch}");
            self.repo
                .reference(&refname, theirs.id(), true, "同步：快进")?;
            self.repo.set_head(&refname)?;
            return Ok(Pulled {
                changed: self.changed_paths(old_tree.as_ref(), &new_tree)?,
                conflicts: Vec::new(),
                merged: false,
            });
        }

        let ours = head.ok_or_else(|| SyncError::Local("本地没有提交，却需要合并".into()))?;
        let mut index = self.repo.merge_commits(&ours, &theirs, None)?;
        self.merge_tree_file(&mut index, &ours, &theirs)?;
        let mut conflicts = Vec::new();
        if index.has_conflicts() {
            let list: Vec<IndexConflict> = index.conflicts()?.collect::<Result<_, _>>()?;
            for conflict in list {
                resolve(&self.repo, &mut index, conflict, &mut conflicts)?;
            }
        }
        let tree = self.repo.find_tree(index.write_tree_to(&self.repo)?)?;
        self.repo
            .checkout_tree(tree.as_object(), Some(CheckoutBuilder::new().safe()))?;
        let signature = Signature::now(author.name, author.email)?;
        self.repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "合并其他设备的改动",
            &tree,
            &[&ours, &theirs],
        )?;
        Ok(Pulled {
            changed: self.changed_paths(old_tree.as_ref(), &tree)?,
            conflicts,
            merged: true,
        })
    }

    /// 逻辑目录的清单两边都改过（docs/仓库与启动器.md §7.4）：按节点三方合并，结果放进合并的索引，
    /// 不管 git 自己合没合上。只有一边改了的 git 已经合对了，不动
    fn merge_tree_file(&self, index: &mut Index, ours: &Commit, theirs: &Commit) -> SyncResult<()> {
        let path = Path::new(tree::TREE_FILE);
        let read = |commit: &Commit| -> SyncResult<Option<Vec<u8>>> {
            let Ok(entry) = commit.tree()?.get_path(path) else { return Ok(None) };
            Ok(self.repo.find_blob(entry.id()).ok().map(|blob| blob.content().to_vec()))
        };
        let (mine, other) = (read(ours)?, read(theirs)?);
        if mine == other {
            return Ok(());
        }
        let base = match self.repo.merge_base(ours.id(), theirs.id()) {
            Ok(id) => read(&self.repo.find_commit(id)?)?,
            Err(_) => None,
        };
        if base == mine || base == other {
            return Ok(());
        }
        let text = |bytes: &Option<Vec<u8>>| String::from_utf8_lossy(bytes.as_deref().unwrap_or_default()).into_owned();
        let merged = tree::merge3(&text(&base), &text(&mine), &text(&other));
        // 合并的索引里这一项：合上了是第 0 方，冲突了是第 2 / 3 方。拿一项改成合并的结果放回去
        let Some(mut entry) = [0, 2, 3].into_iter().find_map(|stage| index.get_path(path, stage)) else {
            return Ok(());
        };
        if index.has_conflicts() {
            let _ = index.conflict_remove(path);
        }
        entry.flags &= !STAGE_MASK;
        entry.id = self.repo.blob(merged.as_bytes())?;
        entry.file_size = merged.len() as u32;
        index.add(&entry)?;
        Ok(())
    }

    /// 把当前分支推上去。远端比本地新时返回 Rejected，不算出错
    pub fn push(&self, net: &Net) -> SyncResult<Pushed> {
        if self.head_commit()?.is_none() {
            return Ok(Pushed::Done);
        }
        let branch = self.branch();
        let mut remote = self.origin()?;
        let asked = Cell::new(0);
        let mut rejected = None;
        let result = {
            let mut callbacks = callbacks(net, &asked);
            // 服务器那边拒绝（比如两台设备几乎同时推）报在这里
            callbacks.push_update_reference(|_refname, status| {
                if let Some(status) = status {
                    rejected = Some(status.to_string());
                }
                Ok(())
            });
            let mut options = PushOptions::new();
            options.remote_callbacks(callbacks);
            options.proxy_options(proxy(net));
            remote.push(
                &[format!("refs/heads/{branch}:refs/heads/{branch}")],
                Some(&mut options),
            )
        };
        match result {
            Ok(()) => Ok(rejected.map_or(Pushed::Done, Pushed::Rejected)),
            // 远端有本地没有的提交：libgit2 推之前自己就查出来了
            Err(error) if error.code() == ErrorCode::NotFastForward => {
                Ok(Pushed::Rejected(error.message().to_string()))
            }
            Err(error) => Err(classify(error, &asked)),
        }
    }

    /// 本地还有几个提交没推上去（按上一次 fetch 时远端的样子算）
    pub fn unpushed(&self) -> usize {
        let Ok(Some(head)) = self.head_commit() else {
            return 0;
        };
        let tracking = format!("refs/remotes/{REMOTE}/{}", self.branch());
        match self
            .repo
            .find_reference(&tracking)
            .and_then(|reference| reference.peel_to_commit())
        {
            Ok(remote) => self
                .repo
                .graph_ahead_behind(head.id(), remote.id())
                .map_or(0, |(ahead, _)| ahead),
            // 远端还是空的：本地所有提交都没推
            Err(_) => self
                .repo
                .revwalk()
                .and_then(|mut walk| walk.push(head.id()).map(|_| walk.count()))
                .unwrap_or(0),
        }
    }

    /// .git/objects 下零散对象文件的个数（技术方案 §5.9.8）
    pub fn loose_objects(&self) -> usize {
        loose_dirs(&self.repo.path().join("objects"))
            .iter()
            .filter_map(|dir| fs::read_dir(dir).ok())
            .map(|entries| entries.count())
            .sum()
    }

    /// .git/objects 一共多大：推上去之后远端的仓库差不多也是这么大（技术方案 §5.9.3）
    pub fn objects_size(&self) -> u64 {
        dir_size(&self.repo.path().join("objects"))
    }

    /// 把所有引用能走到的对象打成一个包，删掉零散对象和旧包（libgit2 不会自己 gc）。
    /// 要换掉内部的 Repository：Windows 上旧包被映射着时删不掉
    pub fn repack(&mut self) -> SyncResult<()> {
        let objects = self.repo.path().join("objects");
        let pack_dir = objects.join("pack");
        let new_pack = {
            let mut builder = self.repo.packbuilder()?;
            let mut walk = self.repo.revwalk()?;
            // 本地分支、远端跟踪分支，能走到的提交连同它们的树和文件
            walk.push_glob("*")?;
            builder.insert_walk(&mut walk)?;
            // 索引里的文件正常都在 HEAD 的树里，保险起见也放进去
            for entry in self.repo.index()?.iter() {
                builder.insert_object(entry.id, None)?;
            }
            if builder.object_count() == 0 {
                return Ok(());
            }
            fs::create_dir_all(&pack_dir)?;
            builder.write(&pack_dir, 0)?;
            builder
                .name()?
                .map(|name| format!("pack-{name}."))
                .ok_or_else(|| SyncError::Local("打包后拿不到包名".into()))?
        };
        if !fs::read_dir(&pack_dir)?
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().starts_with(&new_pack))
        {
            return Err(SyncError::Local("打包没有写出文件".into()));
        }

        // 换一个新开的 Repository（它要到读对象时才去映射包），旧的连同映射一起放掉
        let fresh = Repository::open(&self.root)?;
        drop(std::mem::replace(&mut self.repo, fresh));

        // 删不掉的（别的程序开着）就留着：多一份包、几个零散对象都不影响正确性
        for entry in fs::read_dir(&pack_dir)?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("pack-") && !name.starts_with(&new_pack) {
                let _ = fs::remove_file(entry.path());
            }
        }
        for dir in loose_dirs(&objects) {
            for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
                let _ = fs::remove_file(entry.path());
            }
            let _ = fs::remove_dir(&dir);
        }
        Ok(())
    }

    fn origin(&self) -> SyncResult<git2::Remote<'_>> {
        self.repo
            .find_remote(REMOTE)
            .map_err(|_| SyncError::Local("还没有设置云端仓库".into()))
    }

    fn head_commit(&self) -> SyncResult<Option<Commit<'_>>> {
        match self.repo.head() {
            Ok(head) => Ok(Some(head.peel_to_commit()?)),
            Err(error) if matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
                Ok(None)
            }
            Err(error) => Err(error.into()),
        }
    }

    fn changes(&self, old: Option<&Tree>, new: &Tree) -> SyncResult<Vec<Change>> {
        let diff = self.repo.diff_tree_to_tree(old, Some(new), None)?;
        Ok(diff
            .deltas()
            .filter_map(|delta| {
                let (kind, file) = match delta.status() {
                    Delta::Added => (ChangeKind::Added, delta.new_file()),
                    Delta::Deleted => (ChangeKind::Deleted, delta.old_file()),
                    Delta::Modified | Delta::Typechange => (ChangeKind::Modified, delta.new_file()),
                    _ => return None,
                };
                let rel = String::from_utf8_lossy(file.path_bytes()?).into_owned();
                Some(Change { rel, kind })
            })
            .collect())
    }

    fn changed_paths(&self, old: Option<&Tree>, new: &Tree) -> SyncResult<Vec<String>> {
        Ok(self
            .changes(old, new)?
            .into_iter()
            .map(|change| change.rel)
            .collect())
    }
}

/// stage_bulk 一个线程的活：自己开一个 Repository，挂一个空的内存索引，对象写进内存，
/// 算完落成一个包。返回的索引项是 libgit2 自己算的（对象 id、按 .gitattributes 转过的内容、
/// stat），主线程原样放进真正的索引
fn pack_files(
    root: &Path,
    pack_dir: &Path,
    files: &[(PathBuf, u64)],
) -> SyncResult<Vec<IndexEntry>> {
    let repo = Repository::open(root)?;
    let odb = repo.odb()?;
    let _mempack = odb.add_new_mempack_backend(1000)?;
    let mut index = Index::new()?;
    repo.set_index(&mut index)?;
    // 不用 mempack 自己的 dump：它只收提交和提交能走到的对象，这里还没有提交
    let mut builder = repo.packbuilder()?;
    let mut entries = Vec::new();
    for (rel, _) in files {
        // 这会儿被删掉、被占着的，留给 commit_all
        if index.add_path(rel).is_err() {
            continue;
        }
        if let Some(entry) = index.get_path(rel, 0) {
            builder.insert_object(entry.id, None)?;
            entries.push(entry);
        }
    }
    if !entries.is_empty() {
        builder.write(pack_dir, 0)?;
    }
    Ok(entries)
}

/// 默认的提交信息：「更新 周报、2026-10-07 等 5 个文件」。点开头的（.gitignore、
/// .odea/ 里的）也算数，但排在后面，名字先列文档
pub fn describe(changes: &[Change]) -> String {
    let hidden = |change: &&Change| change.rel.split('/').any(|part| part.starts_with('.'));
    let (dotted, plain): (Vec<&Change>, Vec<&Change>) = changes.iter().partition(hidden);
    let mut names: Vec<&str> = Vec::new();
    for change in plain.into_iter().chain(dotted) {
        let file = change.rel.rsplit('/').next().unwrap_or(&change.rel);
        let name = file.strip_suffix(".md").unwrap_or(file);
        if !names.contains(&name) {
            names.push(name);
        }
    }
    match names.len() {
        0 => "同步".to_string(),
        1..=3 => format!("更新 {}", names.join("、")),
        count => format!("更新 {} 等 {count} 个文件", names[..3].join("、")),
    }
}

/// 一处冲突怎么收场（技术方案 §5.9.5 的表）：有本机的版本就留本机的，对方的版本交回去另存；
/// 本机删了、对方改了，留对方改过的
fn resolve(
    repo: &Repository,
    index: &mut Index,
    conflict: IndexConflict,
    out: &mut Vec<Conflict>,
) -> SyncResult<()> {
    let Some(any) = conflict
        .our
        .as_ref()
        .or(conflict.their.as_ref())
        .or(conflict.ancestor.as_ref())
    else {
        return Ok(());
    };
    let rel = String::from_utf8(any.path.clone())
        .map_err(|_| SyncError::Local("路径不是 UTF-8".into()))?;
    index.conflict_remove(Path::new(&rel))?;
    match (conflict.our, conflict.their) {
        (Some(mut ours), theirs) => {
            ours.flags &= !STAGE_MASK;
            index.add(&ours)?;
            // 子模块之类不是文件的，读不出内容，就不另存了
            if let Some(blob) = theirs.and_then(|entry| repo.find_blob(entry.id).ok()) {
                out.push(Conflict {
                    rel,
                    theirs: blob.content().to_vec(),
                });
            }
        }
        (None, Some(mut theirs)) => {
            theirs.flags &= !STAGE_MASK;
            index.add(&theirs)?;
        }
        (None, None) => {}
    }
    Ok(())
}

/// 索引项 flags 里表示「冲突的第几方」的两位；清零 = 正常的项
const STAGE_MASK: u16 = 0x3000;

/// 凭据回调：第一次给令牌；再被要就说明令牌不对 —— libgit2 会一直要下去，所以第二次就报错
fn callbacks<'a>(net: &'a Net, asked: &'a Cell<u32>) -> RemoteCallbacks<'a> {
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |_url, _username, _allowed| {
        asked.set(asked.get() + 1);
        match &net.credentials {
            Some((username, token)) if asked.get() == 1 => {
                Cred::userpass_plaintext(username, token)
            }
            _ => Err(git2::Error::from_str(NEED_LOGIN)),
        }
    });
    callbacks
}

fn proxy(net: &Net) -> ProxyOptions<'_> {
    let mut options = ProxyOptions::new();
    if let Some(url) = &net.proxy {
        options.url(url);
    }
    options
}

/// 联网操作的错误分三类：要登录 / 连不上 / 远端拒绝。
/// Windows 上连不上报的是 Os 类（WinHTTP 的「无法与服务器建立连接」）
fn classify(error: git2::Error, asked: &Cell<u32>) -> SyncError {
    if asked.get() > 0 && error.message() == NEED_LOGIN {
        return SyncError::Auth;
    }
    let message = error.message().to_string();
    match error.class() {
        ErrorClass::Net | ErrorClass::Os | ErrorClass::Ssl => SyncError::Network(message),
        _ => SyncError::Remote(message),
    }
}

/// 把应用维护的那一段写进 .gitignore / .gitattributes：有就换掉，没有就放在最前面，
/// 用户自己写的行原样留着。返回有没有改文件
fn upsert_block(path: &Path, body: &str) -> SyncResult<bool> {
    let block = format!("{BLOCK_BEGIN}\n{body}{BLOCK_END}\n");
    let old = match fs::read_to_string(path) {
        Ok(text) => text.replace("\r\n", "\n"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    // 改名前的那一段拿掉（还没升级的设备可能又写回来一段），新的一段放在它原来的位置
    let mut rest = old.clone();
    let mut legacy_at = None;
    while let Some((cut, at)) = cut_block(&rest, LEGACY_BLOCK_BEGIN, LEGACY_BLOCK_END) {
        legacy_at.get_or_insert(at);
        rest = cut;
    }
    let new = if let Some((cut, at)) = cut_block(&rest, BLOCK_BEGIN, BLOCK_END) {
        format!("{}{block}{}", &cut[..at], &cut[at..])
    } else if let Some(at) = legacy_at {
        format!("{}{block}{}", &rest[..at], &rest[at..])
    } else if rest.trim().is_empty() {
        block
    } else {
        format!("{block}\n{rest}")
    };
    if new == old {
        return Ok(false);
    }
    fsio::write_atomic(path, &new).map_err(|error| SyncError::Local(error.to_string()))?;
    Ok(true)
}

/// 从 begin 到 end 那一段（连同后面的换行）拿掉，返回剩下的和那一段原来在哪
fn cut_block(text: &str, begin: &str, end: &str) -> Option<(String, usize)> {
    let start = text.find(begin)?;
    let stop = start + text[start..].find(end)? + end.len();
    let after = &text[stop..];
    Some((format!("{}{}", &text[..start], after.strip_prefix('\n').unwrap_or(after)), start))
}

/// 磁盘上这条路径真正的大小写写法；文件已经不在了返回 None。
/// 每个目录只读一次（`listings` 缓存）
fn actual_case(
    root: &Path,
    rel: &str,
    listings: &mut HashMap<PathBuf, Vec<String>>,
) -> Option<String> {
    let mut dir = root.to_path_buf();
    let mut parts = Vec::new();
    for part in rel.split('/') {
        let names = listings.entry(dir.clone()).or_insert_with(|| {
            fs::read_dir(&dir)
                .map(|entries| {
                    entries
                        .flatten()
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default()
        });
        let name = if names.iter().any(|name| name == part) {
            part.to_string()
        } else {
            let lower = part.to_lowercase();
            names
                .iter()
                .find(|name| name.to_lowercase() == lower)?
                .clone()
        };
        dir.push(&name);
        parts.push(name);
    }
    Some(parts.join("/"))
}

/// .git/objects 下放零散对象的那些两位十六进制的目录
fn loose_dirs(objects: &Path) -> Vec<PathBuf> {
    fs::read_dir(objects)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.len() == 2 && name.chars().all(|c| c.is_ascii_hexdigit())
        })
        .map(|entry| entry.path())
        .collect()
}

fn dir_size(dir: &Path) -> u64 {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| match entry.metadata() {
            Ok(meta) if meta.is_dir() => dir_size(&entry.path()),
            Ok(meta) => meta.len(),
            Err(_) => 0,
        })
        .sum()
}

fn rel_of(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
