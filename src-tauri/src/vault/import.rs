/* ============================================================
导入（docs/仓库与启动器.md §7.6、§21）：把仓库外面的一个文件夹复制进来。挂载别处的文件夹第一期不做
（索引、监听要跨好几个根，仓库外的文件同步管不到），所以是复制，原来的一个字节都不动。

- 结构照原样：文件夹、笔记、图片按原来的相对位置拷进来，正文里的相对链接（`../图/a.png`）
  不用改就还指着同一个文件。以点开头的（.obsidian、.git、.odea）不拷，符号链接不跟
- 放在哪：本地目录放进树上当前的文件夹（树就是真的文件夹）；逻辑目录放在新建笔记平放的地方
  （layout.notes），树上在当前的文件夹里建一个同名文件夹，子文件夹、笔记照原来的结构摆好
- 名字撞了加序号（「读书笔记 2」），和新建文件夹一样
- 属性块里没写 id 的在清单里按路径引用（tree.rs），一个文件都不改

一个大文件夹要拷几十秒、读几十秒，不能一直拿着仓库的锁（以前就是，界面上什么都点不动，§21）：

1. begin（锁里，几毫秒）：校验、定下放在哪
2. 拷（不拿锁）：拷进仓库里的 .odea/import/<编号>。以点开头，文件监听、扫描都不看它；和仓库在同一个盘上，
   拷完改名一下就到位；同步的 .gitignore 里也有它，拷了一半的不会被提交。读不了的文件跳过、计数
3. settle（锁里）：改名到真正的位置（这时才去重名字：拷的时候用户可能建了同名的文件夹），记进 Vault::importing
4. 读进索引（每次拿锁 50ms 左右）：importing 里的文件夹扫描先不管，文件监听看到改名触发的整扫不会一口气读完它
5. finish（锁里）：逻辑目录按原来的结构摆到树上；只告诉前端文件夹变了，新进来的几千个笔记 id 不发过去
   （前端导入完整个重取一次列表，一篇篇取要几分钟）

取消（关了窗口、换了仓库也算）：拷的时候删掉暂存的；读的时候删掉拷进来的文件夹，扫一遍把读进去的从索引里去掉
============================================================ */

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use super::index::{self, DocRow};
use super::tree::{self, Item};
use super::{folders, fsio, layout, Vault, VaultChange};
use crate::domain::model::{ImportPhase, ImportReport};
use crate::error::{AppError, Result};

/// 读进索引时每次拿着锁读多久、读完歇多久（让排着的命令先拿到锁，标准库的锁不保证先来先得）。
/// 和打开大文件夹时后台读的一样（commands::spawn_backlog）
const INDEX_SLICE: Duration = Duration::from_millis(50);
const INDEX_PAUSE: Duration = Duration::from_millis(5);
/// 进度最多多久报一次（每一段的开头、结尾都报）
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// 一次导入：begin 定下的、拷的时候记下的、改名到位以后的
struct ImportJob {
    /// 哪个仓库：中途换了仓库就不往下做了
    root: PathBuf,
    source: PathBuf,
    /// 先拷到这里（仓库里的 .odea/import/<编号>），拷完改名到 dest
    staging: PathBuf,
    /// 树上放在哪个文件夹（逻辑目录是树上的路径，本地目录是真的文件夹）
    folder: String,
    /// 放进仓库里的哪个目录（相对仓库）
    base: String,
    /// 新文件夹的名字（还没去重）
    name: String,
    /// 改名到位以后在哪（相对仓库）。改名成功了才有：收回时只删自己建的
    dest: Option<String>,
    /// 拷了哪些子目录（相对新文件夹）
    dirs: Vec<String>,
    /// 拷了哪些笔记（相对新文件夹）
    notes: Vec<String>,
    /// 拷了几个别的文件（图片、PDF …）
    files: u32,
    /// 读不了、没拷的
    skipped: u32,
}

impl ImportJob {
    /// 拷进来的都收回去：暂存的那一份、已经改名到位的那个文件夹
    fn discard(&self) {
        let placed = self.dest.as_deref().filter(|dest| !dest.is_empty()).map(|dest| fsio::abs(&self.root, dest));
        for dir in [Some(self.staging.clone()), placed].into_iter().flatten() {
            // 删的只能是这一次建的：仓库根、暂存目录本身都不行（路径算错了也不至于删掉整个仓库）
            if dir == self.root || dir == fsio::abs(&self.root, layout::IMPORT_DIR) || !dir.starts_with(&self.root) {
                continue;
            }
            if let Err(error) = std::fs::remove_dir_all(&dir) {
                if error.kind() != ErrorKind::NotFound {
                    eprintln!("收回导入了一半的 {} 失败: {error}", dir.display());
                }
            }
        }
        drop_empty_staging(&self.root);
    }
}

/// 进度报得太密前端也画不过来：每一段的开头、结尾都报，中间最多 PROGRESS_EVERY 一次
struct Throttled<'a> {
    send: &'a mut dyn FnMut(ImportPhase, u32, u32),
    last: Option<Instant>,
}

impl Throttled<'_> {
    fn report(&mut self, phase: ImportPhase, done: u32, total: u32) {
        if done == 0 || done >= total || self.last.is_none_or(|last| last.elapsed() >= PROGRESS_EVERY) {
            (self.send)(phase, done, total);
            self.last = Some(Instant::now());
        }
    }
}

fn lock(vault: &Mutex<Vault>) -> Result<MutexGuard<'_, Vault>> {
    vault.lock().map_err(|_| AppError::Internal("仓库锁坏了".into()))
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

impl Vault {
    /// 把 source 复制进来，放在树上的 folder 里（放法见上）。只在定位置、改名、读一小批、收尾时拿 vault 的锁，
    /// 拷文件时不拿。cancel 被置上就停下、拷进来的都收回去，返回 None。
    /// progress：(哪一段, 做完了几个, 一共几个)，最多 100ms 一次。返回树上新文件夹的路径和拷了多少
    pub fn import_folder(
        vault: &Mutex<Vault>,
        source: &Path,
        folder: &str,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(ImportPhase, u32, u32),
    ) -> Result<Option<ImportReport>> {
        let mut progress = Throttled { send: progress, last: None };
        let stopped = || cancel.load(Ordering::Relaxed);
        let mut job = lock(vault)?.import_begin(source, folder)?;

        let copied = copy_into(&mut job, &stopped, &mut |done, total| progress.report(ImportPhase::Copy, done, total));
        if let Err(error) = copied {
            job.discard();
            return Err(error);
        }
        let mut queue = {
            let mut guard = lock(vault)?;
            if stopped() || guard.root != job.root {
                job.discard();
                return Ok(None);
            }
            match guard.import_settle(&mut job) {
                Ok(queue) => queue,
                Err(error) => {
                    job.discard();
                    return Err(error);
                }
            }
        };

        let total = count(queue.len());
        let mut indexed = VaultChange::default();
        progress.report(ImportPhase::Index, 0, total);
        loop {
            let mut guard = lock(vault)?;
            // 换了仓库：锁里已经是别的仓库了，只把拷进旧仓库的那个文件夹删掉（它的索引下次打开时扫一遍就对上了）
            if guard.root != job.root {
                job.discard();
                return Ok(None);
            }
            if stopped() {
                guard.import_abort(&job);
                return Ok(None);
            }
            if queue.is_empty() {
                return match guard.import_finish(&job, indexed) {
                    Ok(report) => Ok(Some(report)),
                    Err(error) => {
                        guard.import_abort(&job);
                        Err(error)
                    }
                };
            }
            guard.import_index(&mut queue, &mut indexed);
            drop(guard);
            progress.report(ImportPhase::Index, total - count(queue.len()), total);
            if !queue.is_empty() {
                std::thread::sleep(INDEX_PAUSE);
            }
        }
    }

    /// 校验、定下放在哪，建好暂存目录
    fn import_begin(&mut self, source: &Path, folder: &str) -> Result<ImportJob> {
        // 未整理、智能文件夹里放不了文件夹：放在根上
        let folder = match &self.tree {
            Some(tree) if folder == tree::UNSORTED || tree.query_at(folder).is_some() => "",
            _ => folder,
        };
        let source =
            source.canonicalize().map_err(|_| AppError::NotFound(format!("找不到文件夹 {}", source.display())))?;
        let root = self.root.canonicalize().unwrap_or_else(|_| self.root.clone());
        if source.starts_with(&root) {
            return Err(AppError::Invalid("这个文件夹已经在仓库里了".into()));
        }
        if root.starts_with(&source) {
            return Err(AppError::Invalid("不能导入包着这个仓库的文件夹".into()));
        }
        if !source.is_dir() {
            return Err(AppError::Invalid(format!("{} 不是文件夹", source.display())));
        }
        let name = source
            .file_name()
            .and_then(|name| layout::folder_name(&name.to_string_lossy()))
            .unwrap_or_else(|| "导入".into());
        // 逻辑目录：文件平放在新建笔记的地方，树上另摆；本地目录：就是树上那个文件夹
        let base = if self.tree.is_some() { self.layout.notes.clone() } else { self.layout.folder_dir(folder)? };
        self.check_import_target(folder, &base)?;
        let staging =
            fsio::abs(&self.root, &layout::join(layout::IMPORT_DIR, &uuid::Uuid::now_v7().simple().to_string()));
        std::fs::create_dir_all(&staging)?;
        Ok(ImportJob {
            root: self.root.clone(),
            source,
            staging,
            folder: folder.to_string(),
            base,
            name,
            dest: None,
            dirs: Vec::new(),
            notes: Vec::new(),
            files: 0,
            skipped: 0,
        })
    }

    /// 要放进去的那个文件夹还在（开始时、拷完要放进去时各问一次：拷的时候用户可能把它删了）
    fn check_import_target(&mut self, folder: &str, base: &str) -> Result<()> {
        if self.tree.is_some() {
            return self.tree_check_parent(folder);
        }
        if !folder.is_empty() && !fsio::abs(&self.root, base).is_dir() {
            return Err(AppError::NotFound(format!("文件夹「{folder}」不在了")));
        }
        Ok(())
    }

    /// 拷好的改名到真正的位置，记进 importing。返回要读进索引的笔记（相对仓库），按该读的顺序
    fn import_settle(&mut self, job: &mut ImportJob) -> Result<VecDeque<String>> {
        self.check_import_target(&job.folder, &job.base)?;
        std::fs::create_dir_all(fsio::abs(&self.root, &job.base))?;
        let dest = folders::unique_dir(&self.root, &job.base, &job.name, None);
        std::fs::rename(&job.staging, fsio::abs(&self.root, &dest))
            .map_err(|error| AppError::Io(format!("把拷好的文件夹放进仓库失败: {error}")))?;
        drop_empty_staging(&self.root);
        let mut notes: Vec<String> = job.notes.iter().map(|rel| layout::join(&dest, rel)).collect();
        notes.sort();
        // 名字像冲突副本的放到最后（和整扫一样，plan_rescan）：副本带着原文属性块里的 id，原文要先拿到它
        notes.sort_by_key(|rel| !layout::conflict_originals(layout::stem_of(rel)).is_empty());
        self.importing = Some(dest.clone());
        job.dest = Some(dest);
        Ok(notes.into())
    }

    /// 读一小批进索引（INDEX_SLICE 左右）。读不了的记下，文件监听过一会儿再读
    fn import_index(&mut self, queue: &mut VecDeque<String>, change: &mut VaultChange) {
        let start = Instant::now();
        self.batched(|vault| {
            while let Some(rel) = queue.pop_front() {
                if let Err(error) = vault.index_file(&rel, change) {
                    eprintln!("读 {rel} 进索引失败: {error}");
                    vault.note_unread(&rel);
                }
                if start.elapsed() >= INDEX_SLICE {
                    break;
                }
            }
        });
    }

    /// 都读完了：树上摆好（逻辑目录）。前端导完会整个重取一次（列表、文件夹、插件的日历记号和任务，
    /// data/store.ts 的 importFolder）：读进来的这些不再一篇篇通知它 —— 几千个 id 它要一篇篇取，文件夹、日历
    /// 也会跟着重取的那一次再取一遍。只说那一次取不到的：附件清单变了（`![[图.png]]` 按它找），扫描时顺带看到的别处的改动
    fn import_finish(&mut self, job: &ImportJob, indexed: VaultChange) -> Result<ImportReport> {
        let dest = job.dest.clone().unwrap_or_default();
        self.importing = None;
        let mut change = self.rescan()?;
        let imported: HashSet<&String> = indexed.notes.iter().collect();
        change.notes.retain(|id| !imported.contains(&id));
        change.folders = false;
        change.plugins.clear();
        let folder = if self.tree.is_some() {
            self.place_imported(&dest, &job.dirs, &job.folder)?
        } else {
            self.layout.folder_of_dir(&dest).unwrap_or_default().to_string()
        };
        self.log.record_with("folder", &dest, "imported", Some(&job.source.to_string_lossy()));
        self.announce(change);
        Ok(ImportReport { folder, notes: count(job.notes.len()), files: job.files, skipped: job.skipped })
    }

    /// 读到一半取消了（或者收尾出错）：拷进来的删掉，扫一遍把读进去的从索引里去掉
    fn import_abort(&mut self, job: &ImportJob) {
        job.discard();
        self.importing = None;
        match self.rescan() {
            Ok(change) => self.announce(change),
            Err(error) => eprintln!("收回导入以后扫描失败: {error}"),
        }
    }

    /// 逻辑目录：拷进来的那些按原来的结构摆到树上 folder 底下。dirs 是拷了哪些子目录（相对 dest）。
    /// 返回树上新文件夹的路径
    fn place_imported(&mut self, dest: &str, dirs: &[String], folder: &str) -> Result<String> {
        let name = dest.rsplit('/').next().unwrap_or(dest).to_string();
        let rows: Vec<DocRow> = index::notes(&self.db, false)?
            .into_iter()
            .filter(|row| row.rel_path.starts_with(&format!("{dest}/")))
            .collect();
        let tree = self.tree.as_mut().ok_or_else(|| AppError::Invalid("这个仓库不是逻辑目录".into()))?;
        let top = tree.add_folder(folder, &name)?;
        // 树上只建放着笔记（多深都算）的文件夹：只有图片的「图」「附件」在逻辑目录的树上是空的
        let mut needed: HashSet<String> = HashSet::new();
        for row in &rows {
            let mut dir = layout::dir_of(&row.rel_path[dest.len() + 1..]);
            while !dir.is_empty() && needed.insert(dir.to_string()) {
                dir = layout::dir_of(dir);
            }
        }
        // 源文件夹里的子目录（相对 dest）→ 树上的路径。父在子前；新建的文件夹排在那一层最前面，
        // 所以同一层倒着建，建完正好按名字排
        let mut paths: HashMap<String, String> = HashMap::from([(String::new(), top.clone())]);
        let mut dirs: Vec<&String> = dirs.iter().filter(|dir| needed.contains(*dir)).collect();
        dirs.sort_by(|a, b| a.matches('/').count().cmp(&b.matches('/').count()).then_with(|| b.cmp(a)));
        for dir in dirs {
            let (parent, leaf) = dir.rsplit_once('/').unwrap_or(("", dir.as_str()));
            let Some(parent) = paths.get(parent).cloned() else { continue };
            let path = tree.add_folder(&parent, leaf)?;
            paths.insert(dir.clone(), path);
        }
        // 笔记按名字排好，同一个文件夹的一批放进去（Tree::place_many：一篇篇放是 O(篇数 × 节点数)，一万篇十几秒）
        let mut rows = rows;
        rows.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
        let mut batches: Vec<(String, Vec<Item>)> = Vec::new();
        let mut batch_of: HashMap<String, usize> = HashMap::new();
        for row in rows {
            let inner = layout::dir_of(&row.rel_path[dest.len() + 1..]);
            let Some(parent) = paths.get(inner) else { continue };
            let item = if row.file_id.as_deref() == Some(row.id.as_str()) {
                Item::Note(row.id)
            } else {
                Item::File(row.rel_path)
            };
            let at = *batch_of.entry(parent.clone()).or_insert_with(|| {
                batches.push((parent.clone(), Vec::new()));
                batches.len() - 1
            });
            batches[at].1.push(item);
        }
        for (folder, items) in batches {
            tree.place_many(&folder, items)?;
        }
        self.save_tree()?;
        Ok(top)
    }
}

/// 把 job.source 整个拷进 job.staging：以点开头的、符号链接不拷。先走一遍数清有几个文件（进度的分母），
/// 再一个个拷，每拷完一个看一眼要不要停。读不了的文件跳过、计数；别的错（磁盘满了）整个停下
fn copy_into(job: &mut ImportJob, stopped: &dyn Fn() -> bool, progress: &mut dyn FnMut(u32, u32)) -> Result<()> {
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    let mut stack: Vec<(PathBuf, String)> = vec![(job.source.clone(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            // 源文件夹本身打不开：没什么可导的
            Err(error) if rel.is_empty() => return Err(error.into()),
            Err(error) => {
                eprintln!("导入时读不了 {}: {error}", dir.display());
                job.skipped += 1;
                continue;
            }
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if fsio::is_hidden_name(&name) {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            let inner = layout::join(&rel, &name);
            if kind.is_dir() {
                job.dirs.push(inner.clone());
                stack.push((entry.path(), inner));
            } else if kind.is_file() {
                files.push((entry.path(), inner));
            }
        }
    }
    let total = count(files.len());
    progress(0, total);
    for dir in &job.dirs {
        std::fs::create_dir_all(fsio::abs(&job.staging, dir))?;
    }
    for (done, (from, rel)) in files.iter().enumerate() {
        if stopped() {
            return Ok(());
        }
        let to = fsio::abs(&job.staging, rel);
        match std::fs::copy(from, &to) {
            Ok(_) if fsio::is_markdown(rel) => job.notes.push(rel.clone()),
            Ok(_) => job.files += 1,
            Err(error) if unreadable(&error) => {
                eprintln!("导入时跳过读不了的 {}: {error}", from.display());
                let _ = std::fs::remove_file(&to);
                job.skipped += 1;
            }
            Err(error) => return Err(AppError::Io(format!("拷「{rel}」失败: {error}"))),
        }
        progress(count(done + 1), total);
    }
    Ok(())
}

/// 这个文件读不了（别的程序独占着、没权限、拷的时候被删了）：跳过它，别的照常拷
fn unreadable(error: &std::io::Error) -> bool {
    // Windows 的 32、33：ERROR_SHARING_VIOLATION、ERROR_LOCK_VIOLATION（别的程序开着它、锁着一段）
    matches!(error.kind(), ErrorKind::PermissionDenied | ErrorKind::NotFound)
        || (cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33)))
}

/// 暂存目录空了就拿掉（.odea 里不留一个空的 import）
fn drop_empty_staging(root: &Path) {
    let _ = std::fs::remove_dir(fsio::abs(root, layout::IMPORT_DIR));
}

/// 打开仓库时：上次导入到一半应用没了（崩溃、断电），暂存的那一份没人要了
pub(super) fn purge_staging(root: &Path) {
    let dir = fsio::abs(root, layout::IMPORT_DIR);
    if dir.is_dir() {
        if let Err(error) = std::fs::remove_dir_all(&dir) {
            eprintln!("清掉上次没导完的暂存失败: {error}");
        }
    }
}
