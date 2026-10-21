//! 同步引擎的单测：临时目录里起一个裸仓库当云端，clone 几份当几台设备（技术方案 §5.9.10）。
//! 一轮同步的顺序和应用里一样：提交 → 拉取 → 合并 → 冲突副本 → 推送，被拒就再来。

use std::fs;
use std::path::{Path, PathBuf};

use super::repo::*;

const LIMIT: u64 = 1024 * 1024;

/// 云端：一个空的裸仓库，相当于在 GitHub / Gitee 上新建的私有仓库
struct Cloud {
    _dir: tempfile::TempDir,
    url: String,
}

fn cloud() -> Cloud {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("remote.git");
    let mut options = git2::RepositoryInitOptions::new();
    options.bare(true).initial_head(DEFAULT_BRANCH);
    git2::Repository::init_opts(&path, &options).unwrap();
    Cloud {
        url: path.to_string_lossy().replace('\\', "/"),
        _dir: dir,
    }
}

struct Device {
    _dir: tempfile::TempDir,
    root: PathBuf,
    repo: SyncRepo,
    name: &'static str,
}

#[derive(Default)]
struct Round {
    changed: Vec<String>,
    copies: Vec<String>,
    merged: bool,
    rejections: usize,
}

impl Device {
    /// 第一台设备：在仓库根上 init，接上云端
    fn first(cloud: &Cloud, name: &'static str) -> Device {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("仓库");
        fs::create_dir_all(&root).unwrap();
        let repo = SyncRepo::init(&root).unwrap();
        repo.set_remote_url(&cloud.url).unwrap();
        Device {
            _dir: dir,
            root,
            repo,
            name,
        }
    }

    /// 后来的设备：从云端 clone
    fn join(cloud: &Cloud, name: &'static str) -> Device {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("仓库");
        let repo = SyncRepo::clone(&cloud.url, &root, &Net::default()).unwrap();
        Device {
            _dir: dir,
            root,
            repo,
            name,
        }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    fn write(&self, rel: &str, content: impl AsRef<[u8]>) {
        let path = self.path(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn read(&self, rel: &str) -> Option<String> {
        fs::read_to_string(self.path(rel)).ok()
    }

    fn bytes(&self, rel: &str) -> Option<Vec<u8>> {
        fs::read(self.path(rel)).ok()
    }

    fn remove(&self, rel: &str) {
        fs::remove_file(self.path(rel)).unwrap();
    }

    fn author(&self) -> Author<'_> {
        Author {
            name: self.name,
            email: "test@localhost",
        }
    }

    fn commit(&self) -> Committed {
        self.repo
            .commit_all(&self.author(), LIMIT, describe)
            .unwrap()
    }

    /// 一轮同步。冲突副本照应用的样子放在原文件旁边（应用里是 Vault::write_conflict_copy）
    fn sync(&self) -> Round {
        let mut round = Round::default();
        for _ in 0..3 {
            self.commit();
            self.repo.fetch(&Net::default()).unwrap();
            let pulled = self.repo.merge_fetched(&self.author()).unwrap();
            round.changed.extend(pulled.changed);
            round.merged |= pulled.merged;
            for conflict in pulled.conflicts {
                let copy = copy_name(&conflict.rel);
                self.write(&copy, &conflict.theirs);
                round.copies.push(copy);
            }
            self.commit();
            match self.repo.push(&Net::default()).unwrap() {
                Pushed::Done => return round,
                Pushed::Rejected(_) => round.rejections += 1,
            }
        }
        panic!("{} 三轮都没推上去", self.name);
    }

    /// HEAD 里这个文件的内容
    fn committed(&self, rel: &str) -> Option<Vec<u8>> {
        let repo = git2::Repository::open(&self.root).unwrap();
        let tree = repo.head().ok()?.peel_to_tree().unwrap();
        let entry = tree.get_path(Path::new(rel)).ok()?;
        let blob = repo.find_blob(entry.id()).unwrap();
        Some(blob.content().to_vec())
    }

    fn committed_paths(&self) -> Vec<String> {
        let repo = git2::Repository::open(&self.root).unwrap();
        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        let mut paths = Vec::new();
        tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
            if entry.kind() == Some(git2::ObjectType::Blob) {
                paths.push(format!("{dir}{}", entry.name().unwrap()));
            }
            git2::TreeWalkResult::Ok
        })
        .unwrap();
        paths
    }
}

/// 「笔记/周报.md」→「笔记/周报 (冲突).md」
fn copy_name(rel: &str) -> String {
    let (dir, file) = rel
        .rsplit_once('/')
        .map_or(("", rel), |(dir, file)| (dir, file));
    let (stem, ext) = file
        .rsplit_once('.')
        .map_or((file, ""), |(stem, ext)| (stem, ext));
    let name = if ext.is_empty() {
        format!("{stem} (冲突)")
    } else {
        format!("{stem} (冲突).{ext}")
    };
    if dir.is_empty() {
        name
    } else {
        format!("{dir}/{name}")
    }
}

const WEEKLY: &str = "笔记/工作/周报.md";

fn weekly(progress: &str) -> String {
    format!("---\nid: 0199-weekly\n---\n\n# 周报\n\n进度：{progress}\n\n其他内容\n")
}

#[test]
fn prepare_writes_its_own_block_and_keeps_the_users_lines() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join(".gitignore"), "node_modules/\r\n*.log\r\n").unwrap();

    let repo = SyncRepo::init(&root).unwrap();
    let ignore = fs::read_to_string(root.join(".gitignore")).unwrap();
    assert!(ignore.starts_with("# >>> Odea"));
    assert!(ignore.contains(".odea/trash/\n.ontheway/trash/\n.*.tmp\n"));
    assert!(ignore.ends_with("# <<< Odea\n\nnode_modules/\n*.log\n"));
    let attributes = fs::read_to_string(root.join(".gitattributes")).unwrap();
    assert!(attributes.contains("* -text\n*.md text eol=lf\n"));

    // 再来一次什么都不改
    assert!(!repo.prepare().unwrap());

    // 用户改了应用那一段：换回来，用户自己的行不动
    fs::write(
        root.join(".gitignore"),
        ignore.replace(".*.tmp\n", "") + "dist/\n",
    )
    .unwrap();
    assert!(repo.prepare().unwrap());
    let again = fs::read_to_string(root.join(".gitignore")).unwrap();
    assert!(again.contains(".*.tmp\n"));
    assert!(again.ends_with("*.log\ndist/\n"));
}

#[test]
fn the_block_written_before_the_rename_is_replaced_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join(".gitignore"),
        "dist/\n# >>> OnTheWay（这一段由应用维护）\n.ontheway/trash/\n.*.tmp\n# <<< OnTheWay\nnode_modules/\n",
    )
    .unwrap();

    SyncRepo::init(&root).unwrap();
    let ignore = fs::read_to_string(root.join(".gitignore")).unwrap();
    assert!(!ignore.contains("OnTheWay"), "旧的那一段换掉了：{ignore}");
    assert!(ignore.starts_with("dist/\n# >>> Odea"), "放在旧的那一段原来的位置：{ignore}");
    assert!(ignore.ends_with("# <<< Odea\nnode_modules/\n"));

    // 还没升级的设备又在最前面写回来一段：拿掉，新的那一段不动
    let repo = SyncRepo::open(&root).unwrap().unwrap();
    fs::write(
        root.join(".gitignore"),
        format!("# >>> OnTheWay（这一段由应用维护）\n.ontheway/trash/\n# <<< OnTheWay\n\n{ignore}"),
    )
    .unwrap();
    assert!(repo.prepare().unwrap());
    let again = fs::read_to_string(root.join(".gitignore")).unwrap();
    assert!(!again.contains("OnTheWay"));
    assert_eq!(again.trim_start(), ignore);
}

#[test]
fn settings_from_before_the_rename_move_to_the_new_keys() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("仓库");
    fs::create_dir_all(&root).unwrap();
    let repo = git2::Repository::init(&root).unwrap();
    let mut config = repo.config().unwrap();
    config.set_str("ontheway.autosync", "true").unwrap();
    config.set_str("ontheway.provider", "github").unwrap();
    config.set_str("ontheway.login", "旧账号").unwrap();
    // 新版已经写过的以新的为准
    config.set_str("odea.login", "新账号").unwrap();
    fs::write(root.join(".git/ontheway.json"), "{\"lastRepack\":1}").unwrap();

    let repo = SyncRepo::open(&root).unwrap().unwrap();
    assert_eq!(repo.config_get("odea.autosync").as_deref(), Some("true"));
    assert_eq!(repo.config_get("odea.provider").as_deref(), Some("github"));
    assert_eq!(repo.config_get("odea.login").as_deref(), Some("新账号"));
    assert_eq!(repo.config_get("ontheway.autosync"), None);
    assert_eq!(repo.config_get("ontheway.login"), None);
    assert!(root.join(".git/odea.json").exists());
    assert!(!root.join(".git/ontheway.json").exists());
}

#[test]
fn commits_from_before_the_rename_still_name_their_device() {
    use super::engine::device_of;
    assert_eq!(device_of("Odea (书房的电脑)"), "书房的电脑");
    assert_eq!(device_of("OnTheWay (书房的电脑)"), "书房的电脑");
    assert_eq!(device_of("张三"), "张三");
    assert_eq!(device_of("Odea"), "Odea");
}

#[test]
fn commit_leaves_out_temp_files_and_the_trash() {
    let cloud = cloud();
    let a = Device::first(&cloud, "A");
    a.write(WEEKLY, weekly("初稿"));
    a.write("笔记/工作/.周报.md.123-4.tmp", "写到一半");
    a.write(".odea/trash/0199.md", "回收站");
    a.write(".odea/vault.json", "{}");

    let committed = a.commit();
    assert!(committed
        .changes
        .iter()
        .all(|change| change.kind == ChangeKind::Added));
    let mut paths = a.committed_paths();
    paths.sort();
    assert_eq!(
        paths,
        vec![
            ".gitattributes",
            ".gitignore",
            ".odea/vault.json",
            WEEKLY
        ]
    );
    // 没有新改动：不提交
    assert!(a.commit().changes.is_empty());
}

#[test]
fn markdown_is_stored_with_lf_and_attachments_byte_for_byte() {
    let cloud = cloud();
    let a = Device::first(&cloud, "A");
    a.write("笔记/外面写的.md", "第一行\r\n第二行\r\n");
    a.write("附件/表.csv", "a,b\r\n1,2\r\n");
    a.sync();

    assert_eq!(
        a.committed("笔记/外面写的.md").unwrap(),
        "第一行\n第二行\n".as_bytes()
    );
    assert_eq!(a.committed("附件/表.csv").unwrap(), b"a,b\r\n1,2\r\n");
    let b = Device::join(&cloud, "B");
    assert_eq!(b.read("笔记/外面写的.md").unwrap(), "第一行\n第二行\n");
    assert_eq!(b.bytes("附件/表.csv").unwrap(), b"a,b\r\n1,2\r\n");
}

#[test]
fn edits_on_two_devices_merge_and_real_conflicts_become_copies() {
    let cloud = cloud();
    let a = Device::first(&cloud, "A");
    a.write(WEEKLY, weekly("初稿"));
    a.write("日记/2026/2026-10-07.md", "- [ ] 买菜\n");
    a.write(".odea/activity/2026-10.jsonl", "{\"n\":1}\n");
    a.sync();
    let b = Device::join(&cloud, "B");
    assert_eq!(b.read(WEEKLY).unwrap(), weekly("初稿"));

    // 两边离线各改各的：同一行都改了，另外各有不冲突的改动
    a.write(WEEKLY, weekly("A 写的"));
    a.write("笔记/只在A.md", "A 新建的\n");
    a.write(
        ".odea/activity/2026-10.jsonl",
        "{\"n\":1}\n{\"from\":\"A\"}\n",
    );
    b.write(WEEKLY, weekly("B 写的"));
    b.write("日记/2026/2026-10-07.md", "- [x] 买菜\n- [ ] 跑步\n");
    b.write(
        ".odea/activity/2026-10.jsonl",
        "{\"n\":1}\n{\"from\":\"B\"}\n",
    );

    let first = a.sync();
    assert!(!first.merged && first.copies.is_empty());

    // 后同步的 B：原文是自己的，A 的版本在副本里；不冲突的都合进来
    let second = b.sync();
    assert!(second.merged);
    assert_eq!(second.copies, vec!["笔记/工作/周报 (冲突).md"]);
    assert_eq!(b.read(WEEKLY).unwrap(), weekly("B 写的"));
    assert_eq!(
        b.read("笔记/工作/周报 (冲突).md").unwrap(),
        weekly("A 写的")
    );
    assert_eq!(b.read("笔记/只在A.md").unwrap(), "A 新建的\n");
    assert!(second.changed.contains(&"笔记/只在A.md".to_string()));
    assert!(!second.changed.contains(&WEEKLY.to_string()));
    let log = b.read(".odea/activity/2026-10.jsonl").unwrap();
    assert!(log.contains("\"A\"") && log.contains("\"B\""), "{log}");
    assert!(!log.contains("<<<<<<<"));

    // A 再同步：快进，拿到 B 的一切
    let third = a.sync();
    assert!(!third.merged);
    assert_eq!(a.read(WEEKLY).unwrap(), weekly("B 写的"));
    assert_eq!(
        a.read("笔记/工作/周报 (冲突).md").unwrap(),
        weekly("A 写的")
    );
    assert!(a.read("日记/2026/2026-10-07.md").unwrap().contains("跑步"));
    for rel in [
        WEEKLY,
        "日记/2026/2026-10-07.md",
        "笔记/工作/周报 (冲突).md",
    ] {
        assert!(third.changed.contains(&rel.to_string()), "{rel}");
    }
}

#[test]
fn push_is_rejected_while_behind_and_the_next_round_gets_through() {
    let cloud = cloud();
    let a = Device::first(&cloud, "A");
    a.write("笔记/甲.md", "1\n");
    a.sync();
    let b = Device::join(&cloud, "B");

    a.write("笔记/甲.md", "2\n");
    a.sync();
    b.write("笔记/乙.md", "B\n");
    b.commit();
    assert_eq!(b.repo.unpushed(), 1);
    assert!(matches!(
        b.repo.push(&Net::default()).unwrap(),
        Pushed::Rejected(_)
    ));

    let round = b.sync();
    assert_eq!(round.rejections, 0);
    assert_eq!(b.repo.unpushed(), 0);
    assert_eq!(b.read("笔记/甲.md").unwrap(), "2\n");
}

#[test]
fn deleted_on_one_device_edited_on_the_other_keeps_the_edit() {
    let cloud = cloud();
    let a = Device::first(&cloud, "A");
    a.write("笔记/甲.md", "原文\n");
    a.write("笔记/乙.md", "原文\n");
    a.sync();
    let b = Device::join(&cloud, "B");

    a.remove("笔记/甲.md");
    b.write("笔记/甲.md", "B 改过\n");
    a.write("笔记/乙.md", "A 改过\n");
    b.remove("笔记/乙.md");
    a.sync();
    let round = b.sync();
    a.sync();

    assert!(round.copies.is_empty());
    for device in [&a, &b] {
        assert_eq!(
            device.read("笔记/甲.md").unwrap(),
            "B 改过\n",
            "{}",
            device.name
        );
        assert_eq!(
            device.read("笔记/乙.md").unwrap(),
            "A 改过\n",
            "{}",
            device.name
        );
    }
}

#[test]
fn same_new_file_or_attachment_on_both_devices_keeps_both() {
    let cloud = cloud();
    let a = Device::first(&cloud, "A");
    let png = |tail: u8| vec![0x89, b'P', b'N', b'G', 0, 1, 2, tail];
    a.write("附件/图.png", png(0));
    a.sync();
    let b = Device::join(&cloud, "B");

    a.write("附件/图.png", png(1));
    b.write("附件/图.png", png(2));
    a.write("笔记/新.md", "A 的\n");
    b.write("笔记/新.md", "B 的\n");
    a.sync();
    let mut copies = b.sync().copies;
    copies.sort();

    assert_eq!(copies, vec!["笔记/新 (冲突).md", "附件/图 (冲突).png"]);
    assert_eq!(b.bytes("附件/图.png").unwrap(), png(2));
    assert_eq!(b.bytes("附件/图 (冲突).png").unwrap(), png(1));
    assert_eq!(b.read("笔记/新.md").unwrap(), "B 的\n");
    assert_eq!(b.read("笔记/新 (冲突).md").unwrap(), "A 的\n");
}

#[test]
fn oversized_files_are_skipped_and_tracked_ones_stay_at_the_old_version() {
    let cloud = cloud();
    let a = Device::first(&cloud, "A");
    // .gitignore / .gitattributes 先按正常上限提交，下面用 10 字节的上限只看附件
    a.commit();
    let commit = || a.repo.commit_all(&a.author(), 10, describe).unwrap();
    a.write("附件/小.bin", [1u8; 5]);
    a.write("附件/大.bin", [1u8; 50]);

    let committed = commit();
    assert_eq!(
        committed.oversized,
        vec![Oversized {
            rel: "附件/大.bin".into(),
            size: 50
        }]
    );
    assert!(a.committed("附件/大.bin").is_none());
    assert_eq!(a.committed("附件/小.bin").unwrap(), [1u8; 5]);

    // 进过库的文件变大了：停在旧版本，不能当成删除
    a.write("附件/小.bin", [2u8; 50]);
    let committed = commit();
    assert!(committed.changes.is_empty());
    assert_eq!(committed.oversized.len(), 2);
    assert_eq!(a.committed("附件/小.bin").unwrap(), [1u8; 5]);

    // 变回上限以内，照常提交
    a.write("附件/小.bin", [3u8; 6]);
    let committed = commit();
    assert_eq!(committed.changes.len(), 1);
    assert_eq!(a.committed("附件/小.bin").unwrap(), [3u8; 6]);
}

#[test]
fn case_only_rename_reaches_the_other_device() {
    let cloud = cloud();
    let a = Device::first(&cloud, "A");
    if a.repo.config_get("core.ignorecase").as_deref() != Some("true") {
        // 区分大小写的文件系统上，只改大小写就是普通的改名，没什么要特别处理的
        return;
    }
    a.write("笔记/Readme.md", "x\n");
    a.sync();
    let b = Device::join(&cloud, "B");

    fs::rename(a.path("笔记/Readme.md"), a.path("笔记/README.md")).unwrap();
    let committed = a.commit();
    let mut changes: Vec<_> = committed
        .changes
        .iter()
        .map(|change| (change.rel.as_str(), change.kind))
        .collect();
    changes.sort_by_key(|(rel, _)| *rel);
    assert_eq!(
        changes,
        vec![
            ("笔记/README.md", ChangeKind::Added),
            ("笔记/Readme.md", ChangeKind::Deleted)
        ]
    );
    a.sync();
    b.sync();

    let names: Vec<String> = fs::read_dir(b.path("笔记"))
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["README.md"]);
    assert_eq!(b.read("笔记/README.md").unwrap(), "x\n");
}

#[test]
fn repack_folds_loose_objects_into_one_pack() {
    let cloud = cloud();
    let mut a = Device::first(&cloud, "A");
    for i in 0..20 {
        a.write(&format!("笔记/第{i}篇.md"), format!("第 {i} 篇\n"));
        a.commit();
    }
    a.sync();
    assert!(a.repo.loose_objects() > 20);

    a.repo.repack().unwrap();
    assert_eq!(a.repo.loose_objects(), 0);
    assert_eq!(packs(&a.root), 1);

    // 历史一个不少：每个提交的每个文件都读得出来
    let repo = git2::Repository::open(&a.root).unwrap();
    let mut walk = repo.revwalk().unwrap();
    walk.push_head().unwrap();
    let mut commits = 0;
    for id in walk {
        let tree = repo.find_commit(id.unwrap()).unwrap().tree().unwrap();
        tree.walk(git2::TreeWalkMode::PreOrder, |_, entry| {
            entry.to_object(&repo).unwrap();
            git2::TreeWalkResult::Ok
        })
        .unwrap();
        commits += 1;
    }
    assert_eq!(commits, 20);

    // 打完包照常提交、推送，别的设备拉得到
    a.write("笔记/新的.md", "新\n");
    a.sync();
    let b = Device::join(&cloud, "B");
    assert_eq!(b.read("笔记/第19篇.md").unwrap(), "第 19 篇\n");
    assert_eq!(b.read("笔记/新的.md").unwrap(), "新\n");
}

fn packs(root: &Path) -> usize {
    fs::read_dir(root.join(".git/objects/pack"))
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".pack"))
                .count()
        })
        .unwrap_or(0)
}

/// 第一次开启同步：一大批小文件先成批落成包，不留零散对象；超过成批上限的大文件、
/// 超限的文件、提交本身照常。推上去之后另一台设备拿得到，Markdown 照样是 LF
#[test]
fn many_new_files_are_packed_before_the_commit() {
    const MB: u64 = 1024 * 1024;
    let cloud = cloud();
    let a = Device::first(&cloud, "A");
    for i in 0..250 {
        let body = format!("# 第 {i} 篇\r\n\r\n{}\r\n", "正文".repeat(200));
        a.write(&format!("笔记/第{}组/第{i}篇.md", i % 5), body);
    }
    let picture: Vec<u8> = (0..1536 * 1024).map(|i| (i % 251) as u8).collect();
    a.write("附件/大图.png", &picture);
    a.write("附件/录像.mp4", vec![0u8; 3 * MB as usize]);

    let mut started = false;
    let staged = a
        .repo
        .stage_in_batches(2 * MB, 64 * 1024, || started = true)
        .unwrap();
    assert!(started);
    // 250 篇 + .gitignore + .gitattributes；大图和录像留给提交
    assert_eq!(staged, 252);
    assert_eq!(a.repo.loose_objects(), 0);
    // 单测里一批只攒 64 KB：分了好几个包
    assert!(packs(&a.root) > 1);

    let committed = a.repo.commit_all(&a.author(), 2 * MB, describe).unwrap();
    assert_eq!(committed.changes.len(), 253);
    assert_eq!(
        committed.oversized,
        vec![Oversized {
            rel: "附件/录像.mp4".into(),
            size: 3 * MB
        }]
    );
    // 零散的只剩大图、八棵树和提交
    assert!(a.repo.loose_objects() <= 10, "{}", a.repo.loose_objects());
    let again = a.repo.commit_all(&a.author(), 2 * MB, describe).unwrap();
    assert!(again.changes.is_empty());
    let expected = format!("# 第 7 篇\n\n{}\n", "正文".repeat(200));
    assert_eq!(
        a.committed("笔记/第2组/第7篇.md").unwrap(),
        expected.as_bytes()
    );

    assert_eq!(a.repo.push(&Net::default()).unwrap(), Pushed::Done);
    let b = Device::join(&cloud, "B");
    assert_eq!(b.read("笔记/第2组/第7篇.md").unwrap(), expected);
    assert_eq!(b.bytes("附件/大图.png").unwrap(), picture);
    assert_eq!(b.committed_paths().len(), 253);
}

/// 平常一轮只改几篇：不另开包，照常写零散对象
#[test]
fn a_few_files_are_left_to_the_commit() {
    let cloud = cloud();
    let a = Device::first(&cloud, "A");
    a.write("笔记/一.md", "一\n");
    a.write("笔记/二.md", "二\n");
    let mut started = false;
    assert_eq!(a.repo.stage_bulk(LIMIT, || started = true).unwrap(), 0);
    assert!(!started);
    assert_eq!(packs(&a.root), 0);
    assert_eq!(a.commit().changes.len(), 4);
}

/// 量一下 2000 篇笔记的第一次提交：逐个写零散对象 vs 先成批放进包。
/// `cargo test --release --no-default-features --lib bulk_staging_speed -- --ignored --nocapture`
#[test]
#[ignore]
fn bulk_staging_speed() {
    let make = || {
        let cloud = cloud();
        let device = Device::first(&cloud, "A");
        for i in 0..2000 {
            let body = format!("# 第 {i} 篇\n\n{}\n", "这是一段正文。".repeat(i % 50 + 10));
            device.write(&format!("笔记/第{}组/第{i}篇.md", i % 20), body);
        }
        // 刚写出来的文件第一次打开时杀毒软件要扫一遍，每个几毫秒；真实的笔记早扫过了
        for i in 0..2000 {
            device
                .read(&format!("笔记/第{}组/第{i}篇.md", i % 20))
                .unwrap();
        }
        (cloud, device)
    };

    let (_cloud, plain) = make();
    let started = std::time::Instant::now();
    plain.commit();
    let loose = started.elapsed();

    let (_cloud, bulk) = make();
    let started = std::time::Instant::now();
    bulk.repo.stage_bulk(LIMIT, || {}).unwrap();
    let staged = started.elapsed();
    bulk.commit();
    let packed = started.elapsed();
    assert_eq!(plain.committed_paths(), bulk.committed_paths());
    eprintln!("逐个写：{loose:?}；成批：{packed:?}（其中放进包 {staged:?}）");
}

#[test]
fn two_histories_that_never_met_still_merge() {
    let cloud = cloud();
    let a = Device::first(&cloud, "A");
    a.write("笔记/甲.md", "A\n");
    a.sync();
    // B 没有 clone，自己 init 的（比如用户在两台电脑上都先开了同步）
    let b = Device::first(&cloud, "B");
    b.write("笔记/乙.md", "B\n");
    b.sync();
    a.sync();

    for device in [&a, &b] {
        assert_eq!(device.read("笔记/甲.md").unwrap(), "A\n", "{}", device.name);
        assert_eq!(device.read("笔记/乙.md").unwrap(), "B\n", "{}", device.name);
    }
}

#[test]
fn tells_an_empty_cloud_from_one_with_history() {
    let cloud = cloud();
    assert!(SyncRepo::remote_is_empty(&cloud.url, &Net::default()).unwrap());
    let a = Device::first(&cloud, "A");
    a.write("笔记/甲.md", "A\n");
    a.sync();
    assert!(!SyncRepo::remote_is_empty(&cloud.url, &Net::default()).unwrap());
}

#[test]
fn unreachable_remote_is_a_network_error() {
    let dir = tempfile::tempdir().unwrap();
    let repo = SyncRepo::init(dir.path()).unwrap();
    repo.set_remote_url("https://127.0.0.1:9/odea.git")
        .unwrap();
    match repo.fetch(&Net::default()) {
        Err(SyncError::Network(_)) => {}
        other => panic!("应该是连不上，实际是 {other:?}"),
    }
}

#[test]
fn describe_names_the_files() {
    let change = |rel: &str| Change {
        rel: rel.into(),
        kind: ChangeKind::Modified,
    };
    assert_eq!(describe(&[]), "同步");
    assert_eq!(
        describe(&[change(WEEKLY), change("日记/2026/2026-10-07.md")]),
        "更新 周报、2026-10-07"
    );
    let many: Vec<Change> = ["甲", "乙", "丙", "丁", "甲"]
        .iter()
        .map(|name| change(&format!("笔记/{name}.md")))
        .collect();
    assert_eq!(describe(&many), "更新 甲、乙、丙 等 4 个文件");
    // 点开头的排在后面
    assert_eq!(
        describe(&[change(".gitignore"), change(".odea/vault.json"), change(WEEKLY)]),
        "更新 周报、.gitignore、vault.json"
    );
}

/// 逻辑目录的清单两边都改了（docs/仓库与启动器.md §7.4）：按节点合并，不出冲突副本。
/// 两边动了同一个节点的，后合并的那台（本机）的说了算
#[test]
fn the_logical_tree_merges_by_node_instead_of_making_a_copy() {
    use crate::vault::tree::{Item, Tree, TREE_FILE};
    let note = |id: &str| Item::Note(id.into());
    let cloud = cloud();
    let a = Device::first(&cloud, "A");
    let mut base = Tree::default();
    base.add_folder("", "甲").unwrap();
    base.add_folder("", "乙").unwrap();
    for id in ["n1", "n2", "n3"] {
        base.place(None, note(id), Some("甲"), None).unwrap();
    }
    a.write(TREE_FILE, base.render());
    a.sync();
    let b = Device::join(&cloud, "B");

    // A：n1 挪进乙、甲改名；B：n2 挪进乙、n1 挪到根上、n3 挪到 n2 后面
    let at = |tree: &Tree, id: &str| tree.find_note(id, "");
    let mut on_a = base.clone();
    on_a.place(at(&on_a, "n1"), note("n1"), Some("乙"), None).unwrap();
    on_a.rename("甲", "甲甲").unwrap();
    a.write(TREE_FILE, on_a.render());
    let mut on_b = base.clone();
    on_b.place(at(&on_b, "n2"), note("n2"), Some("乙"), None).unwrap();
    on_b.place(at(&on_b, "n1"), note("n1"), Some(""), None).unwrap();
    let after = at(&on_b, "n2");
    on_b.place(at(&on_b, "n3"), note("n3"), Some("乙"), after.as_deref()).unwrap();
    b.write(TREE_FILE, on_b.render());

    a.sync();
    let round = b.sync();
    assert!(round.merged);
    assert!(round.copies.is_empty(), "清单不出冲突副本：{:?}", round.copies);
    let text = b.read(TREE_FILE).unwrap();
    assert!(!text.contains("<<<<<<<"));
    let merged = Tree::parse(&text);
    let folder_of = |id: &str| merged.path_of(&merged.get(&merged.find_note(id, "").unwrap()).unwrap().parent);
    assert_eq!(folder_of("n1"), "", "两边都挪了 n1：用 B（本机）的");
    assert_eq!(folder_of("n2"), "乙");
    assert_eq!(folder_of("n3"), "乙");
    assert!(merged.find_branch("甲甲").is_some(), "A 的改名合进来了");

    // A 再同步：快进，两边一样
    a.sync();
    assert_eq!(a.read(TREE_FILE), b.read(TREE_FILE));
}
