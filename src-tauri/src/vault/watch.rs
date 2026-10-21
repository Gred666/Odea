/* ============================================================
监听仓库文件夹：别的程序（编辑器、网盘同步、git）改了文件，索引跟上、前端刷新。

- 事件先攒 300ms，安静下来再处理一批：保存一个文件往往是好几个事件
  （建临时文件、改名覆盖），网盘同步更是一阵一阵的。
- 以点开头的路径不管：应用自己的临时文件、.odea/（改名前的 .ontheway/）、.git/、.obsidian/。
  只有逻辑目录的清单 .odea/tree（和网盘给它留的冲突副本）例外：别处改了它要重读，应用自己写了它
  同步也要被戳到（docs/仓库与启动器.md §7）；仓库标记 .odea/vault.json 也是：别的设备开关了日程、
  网盘同步过来，前端要问一句「切换过去」（Vault::check_layout）
- 一批里全是 .md 文件：只重读这几个；有目录或别的东西（整个文件夹被挪走、改名）：
  整个仓库增量扫一遍（按修改时间和大小，没变的不读）。
- 应用自己写的文件扫描时指纹对得上，不会被当成外部改动，也不会发通知。
- 每处理完一批就调一下 on_batch（不管是谁写的）：同步线程据此知道「有文件变了」，
  停笔一会儿后提交（技术方案 §5.9.6）。.git/ 以点开头，同步自己的 git 操作戳不到这里。
- 监听对象被丢掉（换了仓库）时通道断开，线程自己退出。
============================================================ */

use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use super::{fsio, Vault};
use crate::error::{AppError, Result};

const QUIET: Duration = Duration::from_millis(300);

/// 持有它监听才在；丢掉就停
pub struct VaultWatcher {
    _watcher: RecommendedWatcher,
}

/// 每处理完一批文件事件调一次
pub type OnBatch = Arc<dyn Fn() + Send + Sync>;

pub fn start(vault: Arc<Mutex<Vault>>, on_batch: Option<OnBatch>) -> Result<VaultWatcher> {
    let root = vault
        .lock()
        .map_err(|_| AppError::Internal("仓库锁坏了".into()))?
        .root()
        .to_path_buf();
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx)
        .map_err(|error| AppError::Io(format!("监听文件夹失败: {error}")))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| AppError::Io(format!("监听文件夹失败: {error}")))?;

    std::thread::Builder::new()
        .name("vault-watch".into())
        .spawn(move || {
            let mut batch = Batch::default();
            loop {
                match rx.recv() {
                    Ok(event) => batch.add(&root, event),
                    Err(_) => return,
                }
                loop {
                    match rx.recv_timeout(QUIET) {
                        Ok(event) => batch.add(&root, event),
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                let work = std::mem::take(&mut batch);
                if work.is_empty() {
                    continue;
                }
                let Ok(mut vault) = vault.lock() else {
                    return;
                };
                // 换过仓库：这个线程监听的是旧的那个，别去动新的
                if vault.root() != root {
                    return;
                }
                let result = if work.full {
                    vault.rescan_and_announce()
                } else {
                    vault.rescan_paths_and_announce(&work.files)
                };
                drop(vault);
                if let Err(error) = result {
                    eprintln!("同步外部改动失败: {error}");
                }
                if let Some(on_batch) = &on_batch {
                    on_batch();
                }
            }
        })
        .map_err(|error| AppError::Internal(format!("启动监听线程失败: {error}")))?;

    Ok(VaultWatcher { _watcher: watcher })
}

#[derive(Default)]
struct Batch {
    files: Vec<String>,
    full: bool,
    /// 逻辑目录的清单、仓库标记变了
    tree: bool,
}

impl Batch {
    fn is_empty(&self) -> bool {
        !self.full && !self.tree && self.files.is_empty()
    }

    fn add(&mut self, root: &Path, event: notify::Result<notify::Event>) {
        let Ok(event) = event else {
            // 监听本身出错（事件溢出之类）：说不清改了什么，整个扫一遍
            self.full = true;
            return;
        };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        for path in &event.paths {
            if is_tree_file(root, path) || is_marker_file(root, path) {
                self.tree = true;
                continue;
            }
            let Some(rel) = relative(root, path) else {
                continue;
            };
            if fsio::is_markdown(&rel) {
                if !self.files.contains(&rel) {
                    self.files.push(rel);
                }
            } else {
                // 目录被建、删、挪：里面有哪些文件说不清
                self.full = true;
            }
        }
    }
}

/// .odea/ 下面以 tree 开头的文件：清单本身（tree）和网盘的冲突副本（`tree (1)` 之类）
fn is_tree_file(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else { return false };
    let parts: Vec<_> = rel.components().collect();
    matches!(
        parts.as_slice(),
        [Component::Normal(dir), Component::Normal(name)]
            if dir.to_string_lossy() == super::layout::APP_DIR
                && name.to_string_lossy().starts_with(super::tree::TREE_NAME)
    )
}

/// 仓库标记 .odea/vault.json
fn is_marker_file(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root)
        .is_ok_and(|rel| rel == Path::new(super::layout::APP_DIR).join("vault.json"))
}

/// 仓库里的相对路径（正斜杠）；在仓库外或者路径里有隐藏的一层时返回 None
fn relative(root: &Path, path: &Path) -> Option<String> {
    let rel: PathBuf = path.strip_prefix(root).ok()?.to_path_buf();
    let mut parts = Vec::new();
    for component in rel.components() {
        let Component::Normal(part) = component else {
            return None;
        };
        let part = part.to_string_lossy();
        if fsio::is_hidden_name(&part) {
            return None;
        }
        parts.push(part.into_owned());
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::model::VaultChange;

    #[test]
    fn ignores_hidden_paths_and_sorts_out_what_to_rescan() {
        let root = Path::new("/vault");
        let mut batch = Batch::default();
        let event = |path: &str| {
            Ok(notify::Event::new(EventKind::Any).add_path(PathBuf::from(path)))
        };
        batch.add(root, event("/vault/.odea/trash/x.md"));
        batch.add(root, event("/vault/笔记/.周报.md.1-0.tmp"));
        batch.add(root, event("/elsewhere/a.md"));
        batch.add(root, event("/vault/.odea/.tree.12-0.tmp"));
        assert!(batch.is_empty());
        // 逻辑目录的清单和它的冲突副本
        batch.add(root, event("/vault/.odea/tree (1)"));
        assert!(batch.tree && batch.files.is_empty() && !batch.full);
        // 仓库标记
        let mut batch = Batch::default();
        batch.add(root, event("/vault/.odea/vault.json"));
        assert!(batch.tree && !batch.is_empty());
        let mut batch = Batch::default();

        batch.add(root, event("/vault/笔记/周报.md"));
        batch.add(root, event("/vault/笔记/周报.md"));
        assert_eq!(batch.files, vec!["笔记/周报.md"]);
        assert!(!batch.full);

        batch.add(root, event("/vault/笔记/新文件夹"));
        assert!(batch.full);
    }

    /// 真的起一个监听：外部写文件、改名、删除，索引跟上并发出通知
    #[test]
    fn picks_up_external_edits() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let vault = Arc::new(Mutex::new(Vault::open_in_memory(&root)));
        let (tx, rx) = mpsc::channel::<VaultChange>();
        let tx = Mutex::new(tx);
        vault
            .lock()
            .unwrap()
            .set_announcer(Arc::new(move |change| {
                let _ = tx.lock().unwrap().send(change);
            }));
        // 同步线程靠它知道「有文件变了」
        let batches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = batches.clone();
        let on_batch: OnBatch = Arc::new(move || {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        let _watcher = start(vault.clone(), Some(on_batch)).unwrap();

        let wait = || rx.recv_timeout(Duration::from_secs(10)).expect("没等到通知");

        std::fs::create_dir_all(root.join("笔记")).unwrap();
        std::fs::write(root.join("笔记").join("外面写的.md"), "---\nid: ext1\n---\n\n你好").unwrap();
        let mut change = wait();
        // 建目录和建文件可能分两批到
        while !change.notes.contains(&"ext1".to_string()) {
            change = wait();
        }
        assert_eq!(vault.lock().unwrap().note_get("ext1").unwrap().content_md, "你好");

        std::fs::rename(
            root.join("笔记").join("外面写的.md"),
            root.join("笔记").join("改了名.md"),
        )
        .unwrap();
        let mut renamed = false;
        for _ in 0..5 {
            let change = wait();
            if change.notes.contains(&"ext1".to_string())
                && vault.lock().unwrap().note_get("ext1").is_ok_and(|note| note.title == "改了名")
            {
                renamed = true;
                break;
            }
        }
        assert!(renamed, "改名后 id 应该不变、标题跟着文件名");
        // 改名可能分几批到，等它们都过去
        while rx.recv_timeout(Duration::from_millis(800)).is_ok() {}

        // 应用自己写的不算外部改动：写完之后不该再收到通知 —— 但同步线程照样要被戳到
        let before = batches.load(std::sync::atomic::Ordering::SeqCst);
        vault
            .lock()
            .unwrap()
            .note_update("ext1", "改了名", "应用写的")
            .unwrap();
        assert!(
            rx.recv_timeout(Duration::from_millis(1500)).is_err(),
            "自己写的文件被当成了外部改动"
        );
        assert!(batches.load(std::sync::atomic::Ordering::SeqCst) > before, "自己写的文件没戳到同步");

        std::fs::remove_file(root.join("笔记").join("改了名.md")).unwrap();
        let mut gone = false;
        for _ in 0..5 {
            wait();
            if vault.lock().unwrap().note_get("ext1").is_err() {
                gone = true;
                break;
            }
        }
        assert!(gone);
    }
}
